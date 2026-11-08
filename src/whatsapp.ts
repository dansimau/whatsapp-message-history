/**
 * The linked-device client. Owns the Baileys socket, the link/pair lifecycle
 * and the fan-out of every WhatsApp event into the archive.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  isJidGroup,
  isJidStatusBroadcast,
  isPnUser,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  proto,
  useMultiFileAuthState,
  type BaileysEventMap,
  type GroupMetadata,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { Archive, MessageRow } from './db.js';
import { describeMessage, fileExtensionFor, messageToJson, senderOf, toUnixSeconds } from './extract.js';

export type LinkState = 'unlinked' | 'connecting' | 'awaiting_scan' | 'connected' | 'reconnecting' | 'closed';

export interface LinkStatus {
  state: LinkState;
  account?: { jid: string; lid?: string; name?: string };
  qrAvailable: boolean;
  qrAgeSeconds?: number;
  pairingCode?: string;
  pairingPhone?: string;
  lastError?: string;
  connectedAt?: number;
  historySync: { chunks: number; messages: number; complete: boolean };
  liveMessages: number;
  lastMessageAt?: number;
}

const IGNORED_TYPES = new Set(['senderKeyDistribution', 'messageContextInfo', 'unknown']);

function statusCodeOf(err: unknown): number | undefined {
  return (err as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
}

export function normalizePhoneNumber(input: string): string {
  const digits = input.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) {
    throw new Error('phone_number must be the full international number including country code, digits only (e.g. 31612345678)');
  }
  return digits;
}

export class WhatsAppClient {
  private sock?: WASocket;
  private state: LinkState = 'unlinked';
  private qr?: string;
  private qrAt?: number;
  private pairingCode?: string;
  private pairingPhone?: string;
  private pairingRequested = false;
  private lastError?: string;
  private linking = false;
  private stopping = false;
  private reconnectAttempts = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private connectedAt?: number;
  private me?: { jid: string; lid?: string; name?: string };
  private readonly groupMeta = new Map<string, GroupMetadata>();
  private readonly groupNameRequested = new Set<string>();
  private readonly counters = { live: 0, historyChunks: 0, historyMessages: 0, historyComplete: false, lastMessageAt: undefined as number | undefined };
  private readonly baileysLogger: Logger;

  constructor(private readonly cfg: Config, private readonly db: Archive, private readonly log: Logger) {
    this.baileysLogger = log.child({ module: 'baileys' }, { level: process.env.WMH_BAILEYS_LOG_LEVEL ?? 'warn' });
  }

  // ------------------------------------------------------------ lifecycle
  async start(): Promise<void> {
    if (await this.hasCredentials()) {
      this.log.info('found linked-device credentials, connecting');
      await this.connect();
    } else {
      this.log.info('no linked device yet; call the whatsapp_link MCP tool to pair');
      this.state = 'unlinked';
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    const sock = this.sock;
    this.sock = undefined;
    if (sock) {
      try {
        sock.end(undefined);
      } catch {
        /* already closed */
      }
    }
    this.state = 'closed';
  }

  private async hasCredentials(): Promise<boolean> {
    try {
      const creds = JSON.parse(await fs.readFile(path.join(this.cfg.sessionDir, 'creds.json'), 'utf8')) as { registered?: boolean };
      return Boolean(creds.registered);
    } catch {
      return false;
    }
  }

  private async wipeSession(): Promise<void> {
    await fs.rm(this.cfg.sessionDir, { recursive: true, force: true });
  }

  status(): LinkStatus {
    return {
      state: this.state,
      account: this.me,
      qrAvailable: Boolean(this.qr) && this.state === 'awaiting_scan',
      qrAgeSeconds: this.qrAt ? Math.round((Date.now() - this.qrAt) / 1000) : undefined,
      pairingCode: this.state === 'awaiting_scan' ? this.pairingCode : undefined,
      pairingPhone: this.pairingPhone,
      lastError: this.lastError,
      connectedAt: this.connectedAt,
      historySync: { chunks: this.counters.historyChunks, messages: this.counters.historyMessages, complete: this.counters.historyComplete },
      liveMessages: this.counters.live,
      lastMessageAt: this.counters.lastMessageAt,
    };
  }

  // -------------------------------------------------------------- linking
  /**
   * Start a fresh link. With a phone number WhatsApp issues an 8-character
   * pairing code (no camera needed); without one a QR code is produced.
   * Resolves once either is available.
   */
  async link(opts: { phoneNumber?: string } = {}): Promise<{ pairingCode?: string; qr?: string }> {
    if (this.state === 'connected') {
      throw new Error(`Already linked as ${this.me?.jid ?? 'unknown account'}. Call whatsapp_unlink first to link a different account.`);
    }
    const phone = opts.phoneNumber ? normalizePhoneNumber(opts.phoneNumber) : undefined;
    const sameFlowInProgress = this.linking && this.state === 'awaiting_scan' && phone === this.pairingPhone;
    if (!sameFlowInProgress) {
      await this.teardownSocket();
      await this.wipeSession();
      this.qr = undefined;
      this.qrAt = undefined;
      this.pairingCode = undefined;
      this.pairingRequested = false;
      this.pairingPhone = phone;
      this.lastError = undefined;
      this.linking = true;
      this.reconnectAttempts = 0;
      this.state = 'connecting';
      await this.connect();
    }
    await this.waitFor(() => Boolean(this.pairingCode) || (!phone && Boolean(this.qr)) || this.state === 'connected' || Boolean(this.lastError), 60_000);
    if (this.lastError && !this.pairingCode && !this.qr) throw new Error(this.lastError);
    return { pairingCode: this.pairingCode, qr: this.qr };
  }

  async unlink(): Promise<void> {
    clearTimeout(this.reconnectTimer);
    const sock = this.sock;
    this.sock = undefined;
    this.linking = false;
    if (sock) {
      try {
        await sock.logout();
      } catch (err) {
        this.log.warn({ err }, 'logout request failed; wiping local session anyway');
        try {
          sock.end(undefined);
        } catch {
          /* ignore */
        }
      }
    }
    await this.wipeSession();
    this.me = undefined;
    this.qr = undefined;
    this.pairingCode = undefined;
    this.connectedAt = undefined;
    this.state = 'unlinked';
  }

  /** Current QR code as a PNG, or undefined when not waiting for a scan. */
  async qrPng(): Promise<{ png: Buffer; payload: string; ageSeconds: number } | undefined> {
    if (!this.qr || this.state !== 'awaiting_scan') return undefined;
    const png = await QRCode.toBuffer(this.qr, { type: 'png', scale: 6, margin: 2, errorCorrectionLevel: 'M' });
    return { png, payload: this.qr, ageSeconds: Math.round((Date.now() - (this.qrAt ?? Date.now())) / 1000) };
  }

  private async waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for WhatsApp to respond. Check network access and try again.');
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  private async teardownSocket(): Promise<void> {
    clearTimeout(this.reconnectTimer);
    const sock = this.sock;
    this.sock = undefined;
    if (sock) {
      try {
        sock.ev.removeAllListeners('connection.update');
        sock.end(undefined);
      } catch {
        /* ignore */
      }
    }
  }

  // ----------------------------------------------------------- connection
  private async connect(): Promise<void> {
    if (this.stopping) return;
    await fs.mkdir(this.cfg.sessionDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.cfg.sessionDir);
    let version: [number, number, number] | undefined;
    try {
      version = (await fetchLatestBaileysVersion()).version as [number, number, number];
    } catch (err) {
      this.log.warn({ err }, 'could not fetch latest WhatsApp Web version, using Baileys default');
    }
    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, this.baileysLogger) },
      logger: this.baileysLogger,
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: this.cfg.syncFullHistory,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      getMessage: async (key: WAMessageKey) => {
        const raw = this.db.getRawMessage(key.id ?? '', key.remoteJid ? jidNormalizedUser(key.remoteJid) : undefined);
        if (!raw) return undefined;
        try {
          const parsed = JSON.parse(raw) as { message?: proto.IMessage };
          return parsed.message ? proto.Message.fromObject(parsed.message) : undefined;
        } catch {
          return undefined;
        }
      },
      cachedGroupMetadata: async (jid: string) => this.groupMeta.get(jid),
    });
    this.sock = sock;
    if (this.state === 'unlinked' || this.state === 'closed') this.state = 'connecting';

    sock.ev.on('creds.update', saveCreds);
    sock.ev.process(async (events) => {
      if (sock !== this.sock && !events['connection.update']) return; // stale socket
      try {
        await this.handleEvents(sock, events);
      } catch (err) {
        this.log.error({ err }, 'event handler failed');
      }
    });
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.stopping) return;
    clearTimeout(this.reconnectTimer);
    this.state = 'reconnecting';
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        this.log.error({ err }, 'reconnect failed');
        this.reconnectAttempts += 1;
        this.scheduleReconnect(Math.min(60_000, 1000 * 2 ** this.reconnectAttempts));
      });
    }, delayMs);
  }

  private async onConnectionUpdate(sock: WASocket, u: Partial<BaileysEventMap['connection.update']>): Promise<void> {
    if (u.qr) {
      this.qr = u.qr;
      this.qrAt = Date.now();
      if (this.state !== 'connected') this.state = 'awaiting_scan';
      this.log.info('QR code available for linking');
      if (this.pairingPhone && !this.pairingRequested) {
        this.pairingRequested = true;
        try {
          const code = await sock.requestPairingCode(this.pairingPhone);
          this.pairingCode = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
          this.log.info('pairing code issued');
        } catch (err) {
          this.lastError = `pairing code request failed: ${(err as Error).message}`;
          this.log.error({ err }, 'pairing code request failed');
        }
      }
    }
    if (u.connection === 'open') {
      this.state = 'connected';
      this.connectedAt = Math.floor(Date.now() / 1000);
      this.reconnectAttempts = 0;
      this.linking = false;
      this.qr = undefined;
      this.pairingCode = undefined;
      this.lastError = undefined;
      this.me = {
        jid: jidNormalizedUser(sock.user?.id),
        lid: sock.user?.lid ? jidNormalizedUser(sock.user.lid) : undefined,
        name: sock.user?.name ?? undefined,
      };
      if (this.me.lid) this.db.upsertLidMapping(this.me.lid, this.me.jid);
      this.db.setMeta('me', JSON.stringify(this.me));
      this.log.info({ account: this.me }, 'connected to WhatsApp');
    }
    if (u.connection === 'close') {
      if (sock !== this.sock) return; // an old socket we already replaced
      this.sock = undefined;
      const code = statusCodeOf(u.lastDisconnect?.error);
      const message = u.lastDisconnect?.error?.message ?? 'connection closed';
      this.log.warn({ code, message }, 'connection closed');
      if (this.stopping) {
        this.state = 'closed';
        return;
      }
      if (code === DisconnectReason.loggedOut) {
        await this.wipeSession();
        this.me = undefined;
        this.qr = undefined;
        this.pairingCode = undefined;
        this.linking = false;
        this.state = 'unlinked';
        this.lastError = 'WhatsApp logged this device out. Link again with whatsapp_link.';
        return;
      }
      if (code === DisconnectReason.restartRequired) {
        this.scheduleReconnect(250); // normal right after pairing succeeds
        return;
      }
      if (this.linking) {
        // QR expired or the handshake failed before pairing completed: start a fresh attempt
        // so a new QR / code can be issued, but give up after a few rounds.
        this.reconnectAttempts += 1;
        if (this.reconnectAttempts > 5) {
          this.linking = false;
          this.state = 'unlinked';
          this.lastError = `linking did not complete (${message}); call whatsapp_link again`;
          return;
        }
        this.qr = undefined;
        this.pairingCode = undefined;
        this.pairingRequested = false;
        this.scheduleReconnect(500);
        return;
      }
      this.reconnectAttempts += 1;
      this.scheduleReconnect(Math.min(60_000, 1000 * 2 ** Math.min(this.reconnectAttempts, 6)));
    }
  }

  // --------------------------------------------------------------- events
  private async handleEvents(sock: WASocket, events: Partial<BaileysEventMap>): Promise<void> {
    if (events['connection.update']) await this.onConnectionUpdate(sock, events['connection.update']);
    if (sock !== this.sock) return;

    if (events['lid-mapping.update']) {
      const m = events['lid-mapping.update'];
      if (m.lid && m.pn) this.db.upsertLidMapping(jidNormalizedUser(m.lid), jidNormalizedUser(m.pn));
    }

    if (events['messaging-history.set']) {
      const h = events['messaging-history.set'];
      this.db.transaction(() => {
        for (const m of h.lidPnMappings ?? []) if (m.lid && m.pn) this.db.upsertLidMapping(jidNormalizedUser(m.lid), jidNormalizedUser(m.pn));
        for (const c of h.contacts ?? []) this.storeContact(c);
        for (const c of h.chats ?? []) {
          if (!c.id) continue;
          const jid = jidNormalizedUser(c.id);
          this.db.upsertChat({ jid, name: c.name ?? c.displayName ?? undefined, isGroup: Boolean(isJidGroup(jid)) });
        }
        let stored = 0;
        for (const m of h.messages ?? []) if (this.storeMessage(m, 'history')) stored += 1;
        this.counters.historyChunks += 1;
        this.counters.historyMessages += stored;
      });
      if (h.isLatest) this.counters.historyComplete = true;
      this.log.info({ chunk: h.chunkOrder, progress: h.progress, messages: h.messages?.length ?? 0, isLatest: h.isLatest }, 'history sync chunk stored');
    }

    if (events['contacts.upsert']) for (const c of events['contacts.upsert']) this.storeContact(c);
    if (events['contacts.update']) for (const c of events['contacts.update']) if (c.id) this.storeContact(c as BaileysEventMap['contacts.upsert'][number]);

    if (events['chats.upsert']) {
      for (const c of events['chats.upsert']) {
        if (!c.id) continue;
        const jid = jidNormalizedUser(c.id);
        this.db.upsertChat({ jid, name: c.name ?? c.displayName ?? undefined, isGroup: Boolean(isJidGroup(jid)) });
      }
    }
    if (events['chats.update']) {
      for (const c of events['chats.update']) {
        if (!c.id || !(c.name || c.displayName)) continue;
        const jid = jidNormalizedUser(c.id);
        this.db.upsertChat({ jid, name: c.name ?? c.displayName ?? undefined, isGroup: Boolean(isJidGroup(jid)) });
      }
    }
    for (const g of [...(events['groups.upsert'] ?? []), ...(events['groups.update'] ?? [])]) {
      if (!g.id) continue;
      const existing = this.groupMeta.get(g.id);
      if (existing) this.groupMeta.set(g.id, { ...existing, ...g });
      else if (events['groups.upsert']?.includes(g as GroupMetadata)) this.groupMeta.set(g.id, g as GroupMetadata);
      if (g.subject) this.db.upsertChat({ jid: g.id, name: g.subject, isGroup: true });
    }

    if (events['messages.upsert']) {
      const { messages, type } = events['messages.upsert'];
      for (const m of messages) {
        const stored = this.storeMessage(m, 'live');
        if (stored && type === 'notify') {
          this.counters.live += 1;
          this.counters.lastMessageAt = Math.floor(Date.now() / 1000);
          if (this.cfg.downloadMedia) void this.downloadMedia(sock, m, stored.chatJid, stored.mediaMime, stored.mediaFilename);
        }
      }
    }

    if (events['messages.update']) {
      for (const u of events['messages.update']) {
        if (!u.key?.id || !u.update.message) continue;
        const d = describeMessage({ key: u.key, message: u.update.message } as WAMessage);
        if (d.edit) this.db.applyEdit(d.edit.targetId, d.edit.text);
        else if (d.text) this.db.applyEdit(u.key.id, d.text);
      }
    }

    if (events['messages.reaction']) {
      for (const r of events['messages.reaction']) {
        if (!r.key.id) continue;
        const sender = r.key.fromMe ? this.me?.jid ?? 'me' : jidNormalizedUser(r.key.participant ?? r.key.remoteJid ?? '');
        this.db.upsertReaction({ messageId: r.key.id, senderJid: sender, emoji: r.reaction.text ?? '', timestamp: toUnixSeconds(r.reaction.senderTimestampMs ? Number(r.reaction.senderTimestampMs) / 1000 : undefined) });
      }
    }
  }

  private storeContact(c: { id: string; lid?: string; phoneNumber?: string; name?: string; notify?: string; verifiedName?: string }): void {
    if (!c.id) return;
    const jid = jidNormalizedUser(c.id);
    this.db.upsertContact({
      jid,
      lid: c.lid ? jidNormalizedUser(c.lid) : jid.endsWith('@lid') ? jid : undefined,
      phoneJid: c.phoneNumber ? jidNormalizedUser(c.phoneNumber) : isPnUser(jid) ? jid : undefined,
      name: c.name,
      notify: c.notify,
      verifiedName: c.verifiedName,
    });
  }

  /** DMs are keyed by the phone-number JID whenever we can learn it, so LID and phone forms of one chat collapse together. */
  private canonicalChatJid(key: WAMessageKey): string {
    const remote = jidNormalizedUser(key.remoteJid ?? '');
    if (isJidGroup(remote) || isJidStatusBroadcast(remote) || remote.endsWith('@broadcast') || remote.endsWith('@newsletter')) return remote;
    if (isPnUser(remote)) return remote;
    const alt = key.remoteJidAlt ? jidNormalizedUser(key.remoteJidAlt) : undefined;
    if (alt && isPnUser(alt)) {
      this.db.upsertLidMapping(remote, alt);
      return alt;
    }
    return this.db.lidToPn(remote) ?? remote;
  }

  private storeMessage(msg: WAMessage, source: 'live' | 'history'): { chatJid: string; mediaMime?: string; mediaFilename?: string } | undefined {
    const key = msg.key;
    if (!key?.id || !key.remoteJid) return undefined;
    const chatJid = this.canonicalChatJid(key);
    const sender = senderOf(msg, this.me);
    if (sender.lidJid && sender.phoneJid) this.db.upsertLidMapping(sender.lidJid, sender.phoneJid);
    const d = describeMessage(msg);
    const timestamp = toUnixSeconds(msg.messageTimestamp);

    if (d.reaction) {
      this.db.upsertReaction({ messageId: d.reaction.targetId, senderJid: sender.jid, emoji: d.reaction.emoji, timestamp });
      return undefined;
    }
    if (d.revoke) {
      this.db.markRevoked(d.revoke.targetId);
      return undefined;
    }
    if (d.edit) {
      this.db.applyEdit(d.edit.targetId, d.edit.text);
      return undefined;
    }
    if (IGNORED_TYPES.has(d.type) && !d.text && !d.media) return undefined;

    const row: MessageRow = {
      id: key.id,
      chatJid,
      chatIsGroup: Boolean(isJidGroup(chatJid)),
      senderJid: sender.jid,
      senderPhoneJid: sender.phoneJid,
      senderLidJid: sender.lidJid,
      fromMe: Boolean(key.fromMe),
      timestamp,
      type: d.type,
      text: d.text,
      mediaKind: d.media?.kind,
      mediaMime: d.media?.mime,
      mediaFilename: d.media?.filename,
      mediaSize: d.media?.size,
      quotedId: d.quotedId,
      pushName: msg.pushName ?? undefined,
      source,
      raw: messageToJson(msg),
    };
    const result = this.db.upsertMessage(row);
    if (result === 'inserted' && row.chatIsGroup && source === 'live') void this.ensureGroupName(chatJid);
    if (msg.pushName && !key.fromMe) this.db.upsertContact({ jid: sender.jid, lid: sender.lidJid, phoneJid: sender.phoneJid, notify: msg.pushName });
    return { chatJid, mediaMime: d.media?.mime, mediaFilename: d.media?.filename };
  }

  private async ensureGroupName(jid: string): Promise<void> {
    if (this.db.chatName(jid) || this.groupNameRequested.has(jid) || !this.sock) return;
    this.groupNameRequested.add(jid);
    try {
      const meta = await this.sock.groupMetadata(jid);
      this.groupMeta.set(jid, meta);
      this.db.upsertChat({ jid, name: meta.subject, isGroup: true });
    } catch (err) {
      this.log.debug({ err, jid }, 'could not fetch group metadata');
      this.groupNameRequested.delete(jid);
    }
  }

  private async downloadMedia(sock: WASocket, msg: WAMessage, chatJid: string, mime?: string, filename?: string): Promise<void> {
    if (!msg.key.id) return;
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: this.baileysLogger, reuploadRequest: sock.updateMediaMessage });
      const dir = path.join(this.cfg.mediaDir, chatJid.replace(/[^a-zA-Z0-9@._-]/g, '_'));
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${toUnixSeconds(msg.messageTimestamp)}-${msg.key.id}${fileExtensionFor(mime, filename)}`);
      await fs.writeFile(file, buffer);
      this.db.setMediaPath(chatJid, msg.key.id, file);
    } catch (err) {
      this.log.warn({ err, id: msg.key.id }, 'media download failed');
    }
  }
}

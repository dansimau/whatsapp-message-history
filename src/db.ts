/**
 * SQLite archive. One row per WhatsApp message plus chats, contacts, LID↔phone
 * mappings and reactions. Full-text search over message text via FTS5.
 */
import Database from 'better-sqlite3';
import { toFtsQuery } from './extract.js';

export interface MessageRow {
  id: string;
  chatJid: string;
  chatIsGroup: boolean;
  senderJid: string;
  senderPhoneJid?: string;
  senderLidJid?: string;
  fromMe: boolean;
  timestamp: number;
  type: string;
  text: string;
  mediaKind?: string;
  mediaMime?: string;
  mediaFilename?: string;
  mediaSize?: number;
  mediaPath?: string;
  quotedId?: string;
  pushName?: string;
  source: 'live' | 'history';
  raw: string;
}

export interface MessageView {
  id: string;
  chatJid: string;
  chatName: string;
  chatIsGroup: boolean;
  senderJid: string;
  senderName: string;
  senderPhone?: string;
  fromMe: boolean;
  timestamp: number;
  type: string;
  text: string;
  mediaKind?: string;
  mediaFilename?: string;
  mediaPath?: string;
  quotedId?: string;
  edited: boolean;
  revoked: boolean;
}

export interface ChatSummary {
  jid: string;
  name: string;
  isGroup: boolean;
  messageCount: number;
  lastMessageAt: number | null;
}

export interface ContactView {
  jid: string;
  name?: string;
  notify?: string;
  phone?: string;
  lid?: string;
}

export interface SearchParams {
  query?: string;
  chatJids?: string[];
  senderJids?: string[];
  fromMe?: boolean;
  since?: number;
  until?: number;
  limit: number;
}

export interface ArchiveStats {
  messages: number;
  chats: number;
  contacts: number;
  oldest: number | null;
  newest: number | null;
}

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  chat_is_group INTEGER NOT NULL DEFAULT 0,
  sender_jid TEXT NOT NULL,
  sender_phone_jid TEXT,
  sender_lid_jid TEXT,
  from_me INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  type TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  media_kind TEXT,
  media_mime TEXT,
  media_filename TEXT,
  media_size INTEGER,
  media_path TEXT,
  quoted_id TEXT,
  push_name TEXT,
  edited INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  raw TEXT NOT NULL,
  inserted_at INTEGER NOT NULL,
  PRIMARY KEY (chat_jid, id)
);
CREATE INDEX IF NOT EXISTS messages_timestamp ON messages (timestamp);
CREATE INDEX IF NOT EXISTS messages_chat_timestamp ON messages (chat_jid, timestamp);
CREATE INDEX IF NOT EXISTS messages_sender ON messages (sender_jid);
CREATE INDEX IF NOT EXISTS messages_id ON messages (id);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text,
  content='messages',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TABLE IF NOT EXISTS chats (
  jid TEXT PRIMARY KEY,
  name TEXT,
  is_group INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  jid TEXT PRIMARY KEY,
  lid TEXT,
  phone_jid TEXT,
  name TEXT,
  notify TEXT,
  verified_name TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS contacts_lid ON contacts (lid);
CREATE INDEX IF NOT EXISTS contacts_phone ON contacts (phone_jid);

CREATE TABLE IF NOT EXISTS lid_map (
  lid TEXT PRIMARY KEY,
  pn TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lid_map_pn ON lid_map (pn);

CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL,
  sender_jid TEXT NOT NULL,
  emoji TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  PRIMARY KEY (message_id, sender_jid)
);
`;

/** Best display name for a JID stored in `col`, looking the contact up by any of its identities. */
const contactName = (col: string) =>
  `(SELECT COALESCE(NULLIF(name,''), NULLIF(verified_name,''), NULLIF(notify,'')) FROM contacts
     WHERE jid = ${col} OR lid = ${col} OR phone_jid = ${col}
       OR phone_jid = (SELECT pn FROM lid_map WHERE lid = ${col})
     ORDER BY (name IS NULL OR name = '') LIMIT 1)`;

const VIEW_COLUMNS = `
  m.id, m.chat_jid, m.chat_is_group, m.sender_jid, m.from_me, m.timestamp, m.type, m.text,
  m.media_kind, m.media_filename, m.media_path, m.quoted_id, m.push_name, m.edited, m.revoked,
  COALESCE((SELECT NULLIF(name,'') FROM chats WHERE jid = m.chat_jid), ${contactName('m.chat_jid')}) AS chat_name,
  ${contactName('m.sender_jid')} AS sender_name,
  COALESCE(m.sender_phone_jid, (SELECT pn FROM lid_map WHERE lid = m.sender_jid)) AS sender_phone_jid`;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function phoneOf(jid: string | null | undefined): string | undefined {
  if (!jid || !jid.endsWith('@s.whatsapp.net')) return undefined;
  return '+' + jid.split('@')[0]!.split(':')[0];
}

export class Archive {
  readonly db: Database.Database;

  constructor(readonly path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
    const current = this.getMeta('schema_version');
    if (current == null) this.setMeta('schema_version', String(SCHEMA_VERSION));
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- meta
  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ------------------------------------------------------------ messages
  private readonly upsertMessageStmt = () =>
    this.db.prepare(`
      INSERT INTO messages (id, chat_jid, chat_is_group, sender_jid, sender_phone_jid, sender_lid_jid, from_me, timestamp, type, text,
        media_kind, media_mime, media_filename, media_size, media_path, quoted_id, push_name, source, raw, inserted_at)
      VALUES (@id, @chatJid, @chatIsGroup, @senderJid, @senderPhoneJid, @senderLidJid, @fromMe, @timestamp, @type, @text,
        @mediaKind, @mediaMime, @mediaFilename, @mediaSize, @mediaPath, @quotedId, @pushName, @source, @raw, @insertedAt)
      ON CONFLICT(chat_jid, id) DO UPDATE SET
        text = CASE WHEN messages.edited = 1 THEN messages.text ELSE excluded.text END,
        raw = excluded.raw,
        push_name = COALESCE(excluded.push_name, messages.push_name),
        sender_phone_jid = COALESCE(excluded.sender_phone_jid, messages.sender_phone_jid),
        sender_lid_jid = COALESCE(excluded.sender_lid_jid, messages.sender_lid_jid),
        media_path = COALESCE(excluded.media_path, messages.media_path)
    `);

  upsertMessage(row: MessageRow): 'inserted' | 'updated' {
    const existed = this.db.prepare('SELECT 1 FROM messages WHERE chat_jid = ? AND id = ?').get(row.chatJid, row.id);
    this.upsertMessageStmt().run({
      id: row.id,
      chatJid: row.chatJid,
      chatIsGroup: row.chatIsGroup ? 1 : 0,
      senderJid: row.senderJid,
      senderPhoneJid: row.senderPhoneJid ?? null,
      senderLidJid: row.senderLidJid ?? null,
      fromMe: row.fromMe ? 1 : 0,
      timestamp: row.timestamp,
      type: row.type,
      text: row.text,
      mediaKind: row.mediaKind ?? null,
      mediaMime: row.mediaMime ?? null,
      mediaFilename: row.mediaFilename ?? null,
      mediaSize: row.mediaSize ?? null,
      mediaPath: row.mediaPath ?? null,
      quotedId: row.quotedId ?? null,
      pushName: row.pushName ?? null,
      source: row.source,
      raw: row.raw,
      insertedAt: nowSeconds(),
    });
    return existed ? 'updated' : 'inserted';
  }

  /** Run many writes in one transaction (history sync chunks). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  applyEdit(messageId: string, text: string): boolean {
    return this.db.prepare('UPDATE messages SET text = ?, edited = 1 WHERE id = ?').run(text, messageId).changes > 0;
  }

  markRevoked(messageId: string): boolean {
    return this.db.prepare('UPDATE messages SET revoked = 1 WHERE id = ?').run(messageId).changes > 0;
  }

  setMediaPath(chatJid: string, messageId: string, mediaPath: string): void {
    this.db.prepare('UPDATE messages SET media_path = ? WHERE chat_jid = ? AND id = ?').run(mediaPath, chatJid, messageId);
  }

  getRawMessage(messageId: string, chatJid?: string): string | undefined {
    const row = (chatJid
      ? this.db.prepare('SELECT raw FROM messages WHERE id = ? AND chat_jid = ?').get(messageId, chatJid)
      : undefined) ?? this.db.prepare('SELECT raw FROM messages WHERE id = ? LIMIT 1').get(messageId);
    return (row as { raw: string } | undefined)?.raw;
  }

  upsertReaction(r: { messageId: string; senderJid: string; emoji: string; timestamp: number }): void {
    if (!r.emoji) {
      this.db.prepare('DELETE FROM reactions WHERE message_id = ? AND sender_jid = ?').run(r.messageId, r.senderJid);
      return;
    }
    this.db
      .prepare(`INSERT INTO reactions (message_id, sender_jid, emoji, timestamp) VALUES (?, ?, ?, ?)
                ON CONFLICT(message_id, sender_jid) DO UPDATE SET emoji = excluded.emoji, timestamp = excluded.timestamp`)
      .run(r.messageId, r.senderJid, r.emoji, r.timestamp);
  }

  reactionsFor(messageIds: string[]): Map<string, { senderJid: string; emoji: string }[]> {
    const out = new Map<string, { senderJid: string; emoji: string }[]>();
    if (messageIds.length === 0) return out;
    const placeholders = messageIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT message_id, sender_jid, emoji FROM reactions WHERE message_id IN (${placeholders})`)
      .all(...messageIds) as { message_id: string; sender_jid: string; emoji: string }[];
    for (const r of rows) {
      const list = out.get(r.message_id) ?? [];
      list.push({ senderJid: r.sender_jid, emoji: r.emoji });
      out.set(r.message_id, list);
    }
    return out;
  }

  // --------------------------------------------------- chats & contacts
  upsertChat(c: { jid: string; name?: string | null; isGroup: boolean }): void {
    this.db
      .prepare(`INSERT INTO chats (jid, name, is_group, updated_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(jid) DO UPDATE SET
                  name = COALESCE(NULLIF(excluded.name, ''), chats.name),
                  is_group = MAX(chats.is_group, excluded.is_group),
                  updated_at = excluded.updated_at`)
      .run(c.jid, c.name ?? null, c.isGroup ? 1 : 0, nowSeconds());
  }

  chatName(jid: string): string | undefined {
    const row = this.db.prepare('SELECT name FROM chats WHERE jid = ?').get(jid) as { name: string | null } | undefined;
    return row?.name ?? undefined;
  }

  upsertContact(c: { jid: string; lid?: string | null; phoneJid?: string | null; name?: string | null; notify?: string | null; verifiedName?: string | null }): void {
    this.db
      .prepare(`INSERT INTO contacts (jid, lid, phone_jid, name, notify, verified_name, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(jid) DO UPDATE SET
                  lid = COALESCE(excluded.lid, contacts.lid),
                  phone_jid = COALESCE(excluded.phone_jid, contacts.phone_jid),
                  name = COALESCE(NULLIF(excluded.name, ''), contacts.name),
                  notify = COALESCE(NULLIF(excluded.notify, ''), contacts.notify),
                  verified_name = COALESCE(NULLIF(excluded.verified_name, ''), contacts.verified_name),
                  updated_at = excluded.updated_at`)
      .run(c.jid, c.lid ?? null, c.phoneJid ?? null, c.name ?? null, c.notify ?? null, c.verifiedName ?? null, nowSeconds());
    if (c.lid && c.phoneJid) this.upsertLidMapping(c.lid, c.phoneJid);
  }

  upsertLidMapping(lid: string, pn: string): void {
    this.db.prepare('INSERT INTO lid_map (lid, pn) VALUES (?, ?) ON CONFLICT(lid) DO UPDATE SET pn = excluded.pn').run(lid, pn);
  }

  lidToPn(lid: string): string | undefined {
    const row = this.db.prepare('SELECT pn FROM lid_map WHERE lid = ?').get(lid) as { pn: string } | undefined;
    return row?.pn;
  }

  pnToLid(pn: string): string | undefined {
    const row = this.db.prepare('SELECT lid FROM lid_map WHERE pn = ? LIMIT 1').get(pn) as { lid: string } | undefined;
    return row?.lid;
  }

  // ---------------------------------------------------------- resolution
  /** All JIDs that denote the same identity as `jid` (itself plus LID/phone twins and contact aliases). */
  identityAliases(jid: string): string[] {
    const set = new Set<string>([jid]);
    const pn = this.lidToPn(jid);
    if (pn) set.add(pn);
    const lid = this.pnToLid(jid);
    if (lid) set.add(lid);
    const rows = this.db
      .prepare('SELECT jid, lid, phone_jid FROM contacts WHERE jid = ? OR lid = ? OR phone_jid = ?')
      .all(jid, jid, jid) as { jid: string; lid: string | null; phone_jid: string | null }[];
    for (const r of rows) for (const v of [r.jid, r.lid, r.phone_jid]) if (v) set.add(v);
    return [...set];
  }

  /**
   * Turn user input (JID, phone number, or a name fragment) into candidate chats.
   * Returns an empty list when nothing matches, more than one when ambiguous.
   */
  resolveChats(input: string): { jid: string; name: string }[] {
    const trimmed = input.trim();
    if (!trimmed) return [];
    const jids = new Set<string>();
    if (trimmed.includes('@')) {
      for (const j of this.identityAliases(trimmed)) jids.add(j);
    } else if (/^[+\d][\d\s().-]{5,}$/.test(trimmed)) {
      const pn = trimmed.replace(/\D/g, '') + '@s.whatsapp.net';
      for (const j of this.identityAliases(pn)) jids.add(j);
    } else {
      const like = `%${trimmed.replace(/[%_]/g, (c) => '\\' + c)}%`;
      const chatRows = this.db.prepare("SELECT jid FROM chats WHERE name LIKE ? ESCAPE '\\'").all(like) as { jid: string }[];
      for (const r of chatRows) jids.add(r.jid);
      const contactRows = this.db
        .prepare("SELECT jid, lid, phone_jid FROM contacts WHERE name LIKE ? ESCAPE '\\' OR notify LIKE ? ESCAPE '\\' OR verified_name LIKE ? ESCAPE '\\'")
        .all(like, like, like) as { jid: string; lid: string | null; phone_jid: string | null }[];
      for (const r of contactRows) for (const v of [r.jid, r.lid, r.phone_jid]) if (v) for (const a of this.identityAliases(v)) jids.add(a);
    }
    if (jids.size === 0) return [];
    // Keep only identities that actually appear as a chat; fall back to the raw input if none do.
    const placeholders = [...jids].map(() => '?').join(',');
    const present = this.db
      .prepare(`SELECT DISTINCT chat_jid AS jid FROM messages WHERE chat_jid IN (${placeholders})`)
      .all(...jids) as { jid: string }[];
    const chosen = present.length > 0 ? present.map((r) => r.jid) : trimmed.includes('@') || /^[+\d]/.test(trimmed) ? [[...jids][0]!] : [];
    return chosen.map((jid) => ({ jid, name: this.displayNameForChat(jid) }));
  }

  /** Candidate sender identities for a user-supplied sender filter. */
  resolveSenders(input: string): string[] {
    return this.resolveIdentities(input);
  }

  private resolveIdentities(input: string): string[] {
    const trimmed = input.trim();
    if (!trimmed) return [];
    if (trimmed.includes('@')) return this.identityAliases(trimmed);
    if (/^[+\d][\d\s().-]{5,}$/.test(trimmed)) return this.identityAliases(trimmed.replace(/\D/g, '') + '@s.whatsapp.net');
    const like = `%${trimmed.replace(/[%_]/g, (c) => '\\' + c)}%`;
    const rows = this.db
      .prepare("SELECT jid, lid, phone_jid FROM contacts WHERE name LIKE ? ESCAPE '\\' OR notify LIKE ? ESCAPE '\\' OR verified_name LIKE ? ESCAPE '\\'")
      .all(like, like, like) as { jid: string; lid: string | null; phone_jid: string | null }[];
    const set = new Set<string>();
    for (const r of rows) for (const v of [r.jid, r.lid, r.phone_jid]) if (v) for (const a of this.identityAliases(v)) set.add(a);
    const pushRows = this.db.prepare("SELECT DISTINCT sender_jid FROM messages WHERE push_name LIKE ? ESCAPE '\\'").all(like) as { sender_jid: string }[];
    for (const r of pushRows) for (const a of this.identityAliases(r.sender_jid)) set.add(a);
    return [...set];
  }

  displayNameForChat(jid: string): string {
    const row = this.db
      .prepare(`SELECT COALESCE((SELECT NULLIF(name,'') FROM chats WHERE jid = ?), ${contactName('?')}) AS name`)
      .get(jid, jid, jid, jid, jid) as { name: string | null };
    return row?.name ?? phoneOf(jid) ?? jid;
  }

  // -------------------------------------------------------------- reads
  private toView(r: Record<string, unknown>): MessageView {
    const senderJid = r.sender_jid as string;
    const phoneJid = (r.sender_phone_jid as string | null) ?? (senderJid.endsWith('@s.whatsapp.net') ? senderJid : null);
    const fromMe = Boolean(r.from_me);
    return {
      id: r.id as string,
      chatJid: r.chat_jid as string,
      chatName: (r.chat_name as string | null) ?? phoneOf(r.chat_jid as string) ?? (r.chat_jid as string),
      chatIsGroup: Boolean(r.chat_is_group),
      senderJid,
      senderName: fromMe ? 'me' : ((r.sender_name as string | null) ?? (r.push_name as string | null) ?? phoneOf(phoneJid) ?? senderJid),
      senderPhone: phoneOf(phoneJid),
      fromMe,
      timestamp: r.timestamp as number,
      type: r.type as string,
      text: r.text as string,
      mediaKind: (r.media_kind as string | null) ?? undefined,
      mediaFilename: (r.media_filename as string | null) ?? undefined,
      mediaPath: (r.media_path as string | null) ?? undefined,
      quotedId: (r.quoted_id as string | null) ?? undefined,
      edited: Boolean(r.edited),
      revoked: Boolean(r.revoked),
    };
  }

  search(p: SearchParams): MessageView[] {
    const where: string[] = [];
    const args: unknown[] = [];
    const fts = p.query ? toFtsQuery(p.query) : '';
    if (fts) {
      where.push('messages_fts MATCH ?');
      args.push(fts);
    }
    if (p.chatJids?.length) {
      where.push(`m.chat_jid IN (${p.chatJids.map(() => '?').join(',')})`);
      args.push(...p.chatJids);
    }
    if (p.senderJids?.length) {
      const ph = p.senderJids.map(() => '?').join(',');
      where.push(`(m.sender_jid IN (${ph}) OR m.sender_phone_jid IN (${ph}) OR m.sender_lid_jid IN (${ph}))`);
      args.push(...p.senderJids, ...p.senderJids, ...p.senderJids);
    }
    if (p.fromMe !== undefined) {
      where.push('m.from_me = ?');
      args.push(p.fromMe ? 1 : 0);
    }
    if (p.since !== undefined) {
      where.push('m.timestamp >= ?');
      args.push(p.since);
    }
    if (p.until !== undefined) {
      where.push('m.timestamp <= ?');
      args.push(p.until);
    }
    const from = fts ? 'FROM messages_fts f JOIN messages m ON m.rowid = f.rowid' : 'FROM messages m';
    const order = fts ? 'ORDER BY bm25(messages_fts), m.timestamp DESC' : 'ORDER BY m.timestamp DESC';
    const sql = `SELECT ${VIEW_COLUMNS} ${from} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ${order} LIMIT ?`;
    args.push(p.limit);
    return (this.db.prepare(sql).all(...args) as Record<string, unknown>[]).map((r) => this.toView(r));
  }

  getMessages(p: { chatJids: string[]; before?: number; after?: number; aroundId?: string; limit: number }): MessageView[] {
    const chatFilter = `m.chat_jid IN (${p.chatJids.map(() => '?').join(',')})`;
    if (p.aroundId) {
      const anchor = this.db.prepare(`SELECT timestamp FROM messages m WHERE id = ? AND ${chatFilter}`).get(p.aroundId, ...p.chatJids) as { timestamp: number } | undefined;
      if (!anchor) return [];
      const half = Math.max(1, Math.floor(p.limit / 2));
      const before = this.db
        .prepare(`SELECT ${VIEW_COLUMNS} FROM messages m WHERE ${chatFilter} AND m.timestamp <= ? ORDER BY m.timestamp DESC, m.rowid DESC LIMIT ?`)
        .all(...p.chatJids, anchor.timestamp, half + 1) as Record<string, unknown>[];
      const after = this.db
        .prepare(`SELECT ${VIEW_COLUMNS} FROM messages m WHERE ${chatFilter} AND m.timestamp > ? ORDER BY m.timestamp ASC, m.rowid ASC LIMIT ?`)
        .all(...p.chatJids, anchor.timestamp, half) as Record<string, unknown>[];
      return [...before.reverse(), ...after].map((r) => this.toView(r));
    }
    const where = [chatFilter];
    const args: unknown[] = [...p.chatJids];
    if (p.before !== undefined) {
      where.push('m.timestamp < ?');
      args.push(p.before);
    }
    if (p.after !== undefined) {
      where.push('m.timestamp > ?');
      args.push(p.after);
    }
    // Newest window unless the caller anchors on `after`, in which case walk forward.
    const forward = p.after !== undefined && p.before === undefined;
    const rows = this.db
      .prepare(`SELECT ${VIEW_COLUMNS} FROM messages m WHERE ${where.join(' AND ')} ORDER BY m.timestamp ${forward ? 'ASC' : 'DESC'}, m.rowid ${forward ? 'ASC' : 'DESC'} LIMIT ?`)
      .all(...args, p.limit) as Record<string, unknown>[];
    if (!forward) rows.reverse();
    return rows.map((r) => this.toView(r));
  }

  listChats(p: { query?: string; limit: number }): ChatSummary[] {
    const like = p.query ? `%${p.query.trim().replace(/[%_]/g, (c) => '\\' + c)}%` : undefined;
    const rows = this.db
      .prepare(`
        SELECT s.chat_jid AS jid, s.cnt, s.last_ts, s.is_group,
          COALESCE((SELECT NULLIF(name,'') FROM chats WHERE jid = s.chat_jid), ${contactName('s.chat_jid')}) AS name
        FROM (SELECT chat_jid, COUNT(*) AS cnt, MAX(timestamp) AS last_ts, MAX(chat_is_group) AS is_group FROM messages GROUP BY chat_jid) s
        ${like ? "WHERE name LIKE ? ESCAPE '\\' OR s.chat_jid LIKE ? ESCAPE '\\'" : ''}
        ORDER BY s.last_ts DESC LIMIT ?`)
      .all(...(like ? [like, like] : []), p.limit) as { jid: string; cnt: number; last_ts: number | null; is_group: number; name: string | null }[];
    return rows.map((r) => ({ jid: r.jid, name: r.name ?? phoneOf(r.jid) ?? r.jid, isGroup: Boolean(r.is_group), messageCount: r.cnt, lastMessageAt: r.last_ts }));
  }

  listContacts(p: { query: string; limit: number }): ContactView[] {
    const like = `%${p.query.trim().replace(/[%_]/g, (c) => '\\' + c)}%`;
    const rows = this.db
      .prepare(`SELECT jid, lid, phone_jid, name, notify FROM contacts
                WHERE name LIKE ? ESCAPE '\\' OR notify LIKE ? ESCAPE '\\' OR verified_name LIKE ? ESCAPE '\\' OR phone_jid LIKE ? ESCAPE '\\' OR jid LIKE ? ESCAPE '\\'
                ORDER BY (name IS NULL OR name = ''), name LIMIT ?`)
      .all(like, like, like, like, like, p.limit) as { jid: string; lid: string | null; phone_jid: string | null; name: string | null; notify: string | null }[];
    return rows.map((r) => ({
      jid: r.jid,
      name: r.name ?? undefined,
      notify: r.notify ?? undefined,
      phone: phoneOf(r.phone_jid ?? (r.jid.endsWith('@s.whatsapp.net') ? r.jid : this.lidToPn(r.jid))),
      lid: r.lid ?? (r.jid.endsWith('@lid') ? r.jid : undefined),
    }));
  }

  stats(): ArchiveStats {
    const m = this.db.prepare('SELECT COUNT(*) AS c, MIN(timestamp) AS oldest, MAX(timestamp) AS newest FROM messages').get() as { c: number; oldest: number | null; newest: number | null };
    const chats = (this.db.prepare('SELECT COUNT(DISTINCT chat_jid) AS c FROM messages').get() as { c: number }).c;
    const contacts = (this.db.prepare('SELECT COUNT(*) AS c FROM contacts').get() as { c: number }).c;
    return { messages: m.c, chats, contacts, oldest: m.oldest, newest: m.newest };
  }
}

/**
 * MCP tool surface. Everything an agent needs: link/pair the device, check
 * status, and query the archive.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Archive, MessageView } from './db.js';
import type { NoCowReport } from './nocow.js';
import type { WhatsAppClient } from './whatsapp.js';

export interface McpContext {
  client: WhatsAppClient;
  db: Archive;
  config: Config;
  nocow: NoCowReport;
  startedAt: number;
  version: string;
}

const TIME_FORMAT = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'medium' });
const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function formatTime(unixSeconds: number): string {
  return TIME_FORMAT.format(new Date(unixSeconds * 1000));
}

/** Accepts ISO 8601, unix seconds/milliseconds, or a relative window like `7d`, `24h`, `30m`. */
export function parseTime(input: string | undefined, now = Date.now()): number | undefined {
  if (input === undefined) return undefined;
  const s = input.trim();
  if (!s) return undefined;
  const rel = s.match(/^(\d+)\s*([smhdw])$/i);
  if (rel) {
    const unit = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[rel[2]!.toLowerCase() as 's' | 'm' | 'h' | 'd' | 'w'];
    return Math.floor(now / 1000) - Number(rel[1]) * unit;
  }
  if (/^\d{9,}$/.test(s)) {
    const n = Number(s);
    return n > 1e11 ? Math.floor(n / 1000) : n;
  }
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`Unrecognised time "${input}". Use ISO 8601 (2026-11-07 or 2026-11-07T10:00:00+01:00), unix seconds, or a window like 7d / 24h.`);
  return Math.floor(ms / 1000);
}

export function formatMessage(m: MessageView, opts: { showChat: boolean; reactions?: { senderJid: string; emoji: string }[] }): string {
  const who = m.fromMe ? 'me' : m.senderPhone && m.senderName !== m.senderPhone ? `${m.senderName} (${m.senderPhone})` : m.senderName;
  const where = opts.showChat ? `${m.chatName}${m.chatIsGroup ? ' [group]' : ''} › ` : '';
  const parts: string[] = [];
  if (m.mediaKind) parts.push(`[${m.mediaKind}${m.mediaFilename ? ': ' + m.mediaFilename : ''}${m.mediaPath ? ' @ ' + m.mediaPath : ''}]`);
  if (m.text) parts.push(m.text.replace(/\s*\n\s*/g, ' ⏎ '));
  if (!parts.length) parts.push(`[${m.type}]`);
  const flags = [m.edited ? 'edited' : '', m.revoked ? 'deleted by sender' : '', m.quotedId ? `reply to ${m.quotedId}` : ''].filter(Boolean);
  const reactions = opts.reactions?.length ? ' ' + opts.reactions.map((r) => r.emoji).join('') : '';
  return `[${formatTime(m.timestamp)}] ${where}${who}: ${parts.join(' ')}${flags.length ? ` (${flags.join(', ')})` : ''}${reactions}  ·id=${m.id}`;
}

function text(s: string): CallToolResult {
  return { content: [{ type: 'text', text: s }] };
}

function fail(s: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: s }] };
}

async function guarded(fn: () => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return fail((err as Error).message ?? String(err));
  }
}

type ChatResolution = { ok: true; jids: string[] } | { ok: false; result: CallToolResult };

function resolveChatOrFail(db: Archive, input: string): ChatResolution {
  const matches = db.resolveChats(input);
  if (matches.length === 0) return { ok: false, result: fail(`No chat matches "${input}". Try whatsapp_list_chats to find the right name, phone number or JID.`) };
  if (matches.length > 1 && !input.includes('@')) {
    const list = matches.map((m) => `- ${m.name} (${m.jid})`).join('\n');
    return { ok: false, result: fail(`"${input}" is ambiguous. Pick one of these JIDs:\n${list}`) };
  }
  return { ok: true, jids: matches.map((m) => m.jid) };
}

export function buildMcpServer(ctx: McpContext): McpServer {
  const { client, db } = ctx;
  const server = new McpServer({ name: 'whatsapp-message-history', version: ctx.version });

  server.registerTool(
    'whatsapp_status',
    {
      title: 'WhatsApp link and archive status',
      description:
        'Report whether a WhatsApp account is linked, whether pairing is in progress (QR or pairing code pending), history-sync progress, and archive statistics. Call this first.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      guarded(() => {
        const link = client.status();
        const stats = db.stats();
        const lines = [
          `Link state: ${link.state}${link.account ? ` (account ${link.account.jid}${link.account.name ? ', ' + link.account.name : ''})` : ''}`,
        ];
        if (link.lastError) lines.push(`Last error: ${link.lastError}`);
        if (link.state === 'awaiting_scan') {
          lines.push(link.pairingCode ? `Pairing code pending: ${link.pairingCode} (for +${link.pairingPhone})` : `QR code available (${link.qrAgeSeconds ?? 0}s old); call whatsapp_link_qr to fetch it.`);
        }
        if (link.state === 'unlinked') lines.push('No device linked. Call whatsapp_link (optionally with phone_number) to start pairing.');
        lines.push(
          `History sync: ${link.historySync.messages} messages in ${link.historySync.chunks} chunks${link.historySync.complete ? ' (complete)' : ''}`,
          `Live messages this run: ${link.liveMessages}${link.lastMessageAt ? ` (last at ${formatTime(link.lastMessageAt)})` : ''}`,
          `Archive: ${stats.messages} messages across ${stats.chats} chats, ${stats.contacts} contacts` +
            (stats.oldest && stats.newest ? `, from ${formatTime(stats.oldest)} to ${formatTime(stats.newest)}` : ''),
          `Database: ${ctx.config.dbPath} (filesystem ${ctx.nocow.filesystem ?? 'unknown'}; copy-on-write ${ctx.nocow.applicable ? (ctx.nocow.directoryNoCow ? 'disabled' : 'NOT disabled') : 'not applicable'})`,
          `Server time zone: ${TIMEZONE}. Uptime: ${Math.round((Date.now() - ctx.startedAt) / 1000)}s.`,
        );
        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: { link, archive: stats, database: { path: ctx.config.dbPath, nocow: ctx.nocow }, timeZone: TIMEZONE, uptimeSeconds: Math.round((Date.now() - ctx.startedAt) / 1000) },
        };
      }),
  );

  server.registerTool(
    'whatsapp_link',
    {
      title: 'Link a WhatsApp account (start pairing)',
      description:
        'Start linking this archiver as a WhatsApp linked device. With phone_number (international format, digits only, e.g. 31612345678) WhatsApp issues an 8-character pairing code the user types into their phone, no camera needed. Without it a QR code image is returned for the user to scan. Pairing codes and QR codes expire after a minute or so; call again to get a fresh one. After the user completes pairing, whatsapp_status reports state=connected and history sync begins.',
      inputSchema: {
        phone_number: z.string().optional().describe('The WhatsApp phone number to link, with country code, digits only. Omit to get a QR code instead.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ phone_number }) =>
      guarded(async () => {
        const result = await client.link({ phoneNumber: phone_number });
        if (client.status().state === 'connected') return text(`Already connected as ${client.status().account?.jid}.`);
        if (result.pairingCode) {
          return text(
            [
              `Pairing code: ${result.pairingCode}`,
              '',
              'On the phone that owns this number:',
              '1. Open WhatsApp → Settings → Linked devices → Link a device.',
              '2. Tap "Link with phone number instead".',
              `3. Enter the code ${result.pairingCode}.`,
              '',
              'The code expires in a few minutes; call whatsapp_link again for a new one. Check progress with whatsapp_status.',
            ].join('\n'),
          );
        }
        const qr = await client.qrPng();
        if (!qr) return fail('Linking started but no QR code is available yet. Call whatsapp_link_qr in a few seconds.');
        return {
          content: [
            {
              type: 'text',
              text: 'Scan this QR code on the phone: WhatsApp → Settings → Linked devices → Link a device. It refreshes roughly every 20 seconds; call whatsapp_link_qr for the latest one. Check progress with whatsapp_status.',
            },
            { type: 'image', data: qr.png.toString('base64'), mimeType: 'image/png' },
          ],
          structuredContent: { qrPayload: qr.payload, qrAgeSeconds: qr.ageSeconds },
        };
      }),
  );

  server.registerTool(
    'whatsapp_link_qr',
    {
      title: 'Fetch the current pairing QR code',
      description: 'Return the latest QR code image while linking is waiting for a scan. Also returns the raw QR payload so it can be rendered elsewhere.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      guarded(async () => {
        const qr = await client.qrPng();
        if (!qr) {
          const s = client.status();
          return fail(s.state === 'connected' ? `Already connected as ${s.account?.jid}; no QR needed.` : `No QR code pending (state: ${s.state}). Call whatsapp_link first.`);
        }
        return {
          content: [
            { type: 'text', text: `QR code (${qr.ageSeconds}s old). Scan it in WhatsApp → Settings → Linked devices → Link a device.` },
            { type: 'image', data: qr.png.toString('base64'), mimeType: 'image/png' },
          ],
          structuredContent: { qrPayload: qr.payload, qrAgeSeconds: qr.ageSeconds },
        };
      }),
  );

  server.registerTool(
    'whatsapp_unlink',
    {
      title: 'Unlink the WhatsApp account',
      description: 'Log this linked device out of WhatsApp and delete the local session credentials. The message archive is kept. Requires confirm=true.',
      inputSchema: { confirm: z.literal(true).describe('Must be true. This logs the device out of WhatsApp.') },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async () =>
      guarded(async () => {
        await client.unlink();
        return text('Unlinked. Session credentials removed; the archive is untouched. Call whatsapp_link to pair again.');
      }),
  );

  const limitSchema = (def: number, max: number) => z.number().int().min(1).max(max).optional().describe(`Maximum results (default ${def}, max ${max}).`);

  server.registerTool(
    'whatsapp_search_messages',
    {
      title: 'Search message history',
      description:
        'Full-text search over the archived WhatsApp messages, with optional filters. Results are newest-first when no query is given, otherwise ranked by relevance. Every result line ends with ·id=<message id>, which whatsapp_get_messages accepts as around_message_id to read the surrounding conversation.',
      inputSchema: {
        query: z.string().optional().describe('Words to search for (all must match; append * for prefix matching, e.g. "invoic*"). Omit to list messages matching only the filters.'),
        chat: z.string().optional().describe('Restrict to one chat: a contact/group name fragment, a phone number, or a JID.'),
        sender: z.string().optional().describe('Restrict to messages written by this person: name fragment, phone number, JID, or "me".'),
        from_me: z.boolean().optional().describe('true = only messages I sent, false = only messages I received.'),
        since: z.string().optional().describe('Only messages at or after this time: ISO 8601, unix seconds, or a window like 7d / 24h / 30m.'),
        until: z.string().optional().describe('Only messages at or before this time (same formats as since).'),
        limit: limitSchema(25, 200),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guarded(() => {
        let chatJids: string[] | undefined;
        if (args.chat) {
          const r = resolveChatOrFail(db, args.chat);
          if (!r.ok) return r.result;
          chatJids = r.jids;
        }
        let senderJids: string[] | undefined;
        let fromMe = args.from_me;
        if (args.sender) {
          if (args.sender.trim().toLowerCase() === 'me') fromMe = true;
          else {
            senderJids = db.resolveSenders(args.sender);
            if (senderJids.length === 0) return fail(`No contact matches sender "${args.sender}". Try whatsapp_list_contacts.`);
          }
        }
        const limit = args.limit ?? 25;
        const results = db.search({ query: args.query, chatJids, senderJids, fromMe, since: parseTime(args.since), until: parseTime(args.until), limit });
        if (results.length === 0) return text('No messages matched.');
        const reactions = db.reactionsFor(results.map((m) => m.id));
        const body = results.map((m) => formatMessage(m, { showChat: !chatJids || chatJids.length > 1, reactions: reactions.get(m.id) })).join('\n');
        return {
          content: [{ type: 'text', text: `${results.length} result(s)${results.length === limit ? ' (limit reached; narrow the search or raise limit)' : ''}, times in ${TIMEZONE}:\n${body}` }],
          structuredContent: { results, timeZone: TIMEZONE },
        };
      }),
  );

  server.registerTool(
    'whatsapp_get_messages',
    {
      title: 'Read a chat conversation',
      description:
        'Return messages from one chat in chronological order. By default the most recent ones; use before/after to page through time, or around_message_id to see the context of a search hit.',
      inputSchema: {
        chat: z.string().describe('Contact/group name fragment, phone number, or JID.'),
        before: z.string().optional().describe('Only messages before this time (ISO 8601, unix seconds, or 7d / 24h style window).'),
        after: z.string().optional().describe('Only messages after this time. With only `after` set, results walk forward from that time.'),
        around_message_id: z.string().optional().describe('Center the window on this message id (from a search result).'),
        limit: limitSchema(50, 500),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guarded(() => {
        const r = resolveChatOrFail(db, args.chat);
        if (!r.ok) return r.result;
        const limit = args.limit ?? 50;
        const results = db.getMessages({ chatJids: r.jids, before: parseTime(args.before), after: parseTime(args.after), aroundId: args.around_message_id, limit });
        if (results.length === 0) return text(args.around_message_id ? `Message ${args.around_message_id} not found in that chat.` : 'No messages in that range.');
        const reactions = db.reactionsFor(results.map((m) => m.id));
        const header = `${results[0]!.chatName}${results[0]!.chatIsGroup ? ' [group]' : ''} — ${results.length} message(s), ${formatTime(results[0]!.timestamp)} to ${formatTime(results[results.length - 1]!.timestamp)} (${TIMEZONE})`;
        const body = results.map((m) => formatMessage(m, { showChat: false, reactions: reactions.get(m.id) })).join('\n');
        return { content: [{ type: 'text', text: `${header}\n${body}` }], structuredContent: { results, timeZone: TIMEZONE } };
      }),
  );

  server.registerTool(
    'whatsapp_list_chats',
    {
      title: 'List chats',
      description: 'List archived chats (people and groups) with message counts, most recently active first. Optional name/JID filter.',
      inputSchema: { query: z.string().optional().describe('Filter by name or JID fragment.'), limit: limitSchema(50, 500) },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guarded(() => {
        const chats = db.listChats({ query: args.query, limit: args.limit ?? 50 });
        if (chats.length === 0) return text('No chats archived yet.');
        const body = chats.map((c) => `- ${c.name}${c.isGroup ? ' [group]' : ''} — ${c.messageCount} msgs, last ${c.lastMessageAt ? formatTime(c.lastMessageAt) : 'n/a'} (${c.jid})`).join('\n');
        return { content: [{ type: 'text', text: body }], structuredContent: { chats } };
      }),
  );

  server.registerTool(
    'whatsapp_list_contacts',
    {
      title: 'Find contacts',
      description: 'Look up contacts by name, phone number or JID to resolve who someone is before filtering searches.',
      inputSchema: { query: z.string().describe('Name, phone number or JID fragment.'), limit: limitSchema(25, 200) },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guarded(() => {
        const contacts = db.listContacts({ query: args.query, limit: args.limit ?? 25 });
        if (contacts.length === 0) return text('No contacts matched.');
        const body = contacts.map((c) => `- ${c.name ?? c.notify ?? '(no name)'}${c.notify && c.name && c.notify !== c.name ? ` "~${c.notify}"` : ''} ${c.phone ?? ''} (${c.jid}${c.lid && c.lid !== c.jid ? ', ' + c.lid : ''})`).join('\n');
        return { content: [{ type: 'text', text: body }], structuredContent: { contacts } };
      }),
  );

  return server;
}

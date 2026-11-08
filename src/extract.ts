/**
 * Pure helpers that turn a Baileys WAMessage into the flat shape we archive.
 * No I/O here so it is easy to unit test.
 */
import {
  getContentType,
  isJidGroup,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
  normalizeMessageContent,
  proto,
  type WAMessage,
} from '@whiskeysockets/baileys';

export interface MediaInfo {
  kind: 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker';
  mime?: string;
  filename?: string;
  size?: number;
}

export interface DescribedMessage {
  /** Short, stable type name: text, image, video, audio, voice, document, sticker, location, contact, poll, reaction, edit, revoke, system, unknown */
  type: string;
  text: string;
  media?: MediaInfo;
  quotedId?: string;
  mentions: string[];
  edit?: { targetId: string; text: string };
  revoke?: { targetId: string };
  reaction?: { targetId: string; targetChatJid?: string; targetFromMe: boolean; emoji: string };
}

type LongLike = { low: number; high: number; unsigned?: boolean; toNumber?: () => number };

/** Baileys timestamps arrive as number, Long, string or null. */
export function toUnixSeconds(value: unknown, fallback: number = Math.floor(Date.now() / 1000)): number {
  if (value == null) return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.floor(value) : fallback;
  if (typeof value === 'string') {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
  }
  if (typeof value === 'object') {
    const l = value as LongLike;
    if (typeof l.toNumber === 'function') return Math.floor(l.toNumber());
    if (typeof l.low === 'number' && typeof l.high === 'number') return l.high * 2 ** 32 + (l.low >>> 0);
  }
  return fallback;
}

function sizeOf(value: unknown): number | undefined {
  const n = toUnixSeconds(value, -1);
  return n >= 0 ? n : undefined;
}

export function describeMessage(msg: WAMessage): DescribedMessage {
  const out: DescribedMessage = { type: 'unknown', text: '', mentions: [] };
  const content = normalizeMessageContent(msg.message);
  if (!content) {
    if (msg.messageStubType != null) {
      out.type = 'system';
      out.text = `[${proto.WebMessageInfo.StubType[msg.messageStubType] ?? msg.messageStubType}${
        msg.messageStubParameters?.length ? ': ' + msg.messageStubParameters.join(', ') : ''
      }]`;
    }
    return out;
  }
  const kind = getContentType(content);
  const ctxInfo = (kind ? (content as Record<string, unknown>)[kind] : undefined) as { contextInfo?: proto.IContextInfo } | undefined;
  const contextInfo = ctxInfo && typeof ctxInfo === 'object' ? ctxInfo.contextInfo : undefined;
  if (contextInfo?.stanzaId) out.quotedId = contextInfo.stanzaId;
  if (contextInfo?.mentionedJid?.length) out.mentions = contextInfo.mentionedJid.map((j) => jidNormalizedUser(j));

  switch (kind) {
    case 'conversation':
      out.type = 'text';
      out.text = content.conversation ?? '';
      break;
    case 'extendedTextMessage':
      out.type = 'text';
      out.text = content.extendedTextMessage?.text ?? '';
      break;
    case 'imageMessage':
      out.type = 'image';
      out.text = content.imageMessage?.caption ?? '';
      out.media = { kind: 'image', mime: content.imageMessage?.mimetype ?? undefined, size: sizeOf(content.imageMessage?.fileLength) };
      break;
    case 'videoMessage':
      out.type = 'video';
      out.text = content.videoMessage?.caption ?? '';
      out.media = { kind: 'video', mime: content.videoMessage?.mimetype ?? undefined, size: sizeOf(content.videoMessage?.fileLength) };
      break;
    case 'audioMessage': {
      const voice = Boolean(content.audioMessage?.ptt);
      out.type = voice ? 'voice' : 'audio';
      out.media = { kind: voice ? 'voice' : 'audio', mime: content.audioMessage?.mimetype ?? undefined, size: sizeOf(content.audioMessage?.fileLength) };
      break;
    }
    case 'documentMessage':
      out.type = 'document';
      out.text = content.documentMessage?.caption ?? '';
      out.media = {
        kind: 'document',
        mime: content.documentMessage?.mimetype ?? undefined,
        filename: content.documentMessage?.fileName ?? undefined,
        size: sizeOf(content.documentMessage?.fileLength),
      };
      break;
    case 'stickerMessage':
      out.type = 'sticker';
      out.media = { kind: 'sticker', mime: content.stickerMessage?.mimetype ?? undefined, size: sizeOf(content.stickerMessage?.fileLength) };
      break;
    case 'locationMessage':
    case 'liveLocationMessage': {
      const loc = kind === 'locationMessage' ? content.locationMessage : content.liveLocationMessage;
      const place = kind === 'locationMessage' ? [content.locationMessage?.name, content.locationMessage?.address] : [content.liveLocationMessage?.caption];
      out.type = 'location';
      out.text = [...place, `${loc?.degreesLatitude},${loc?.degreesLongitude}`].filter(Boolean).join(' ');
      break;
    }
    case 'contactMessage':
      out.type = 'contact';
      out.text = [content.contactMessage?.displayName, content.contactMessage?.vcard].filter(Boolean).join('\n');
      break;
    case 'contactsArrayMessage':
      out.type = 'contact';
      out.text = (content.contactsArrayMessage?.contacts ?? []).map((c) => [c.displayName, c.vcard].filter(Boolean).join('\n')).join('\n\n');
      break;
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3': {
      const poll = (content as Record<string, proto.Message.IPollCreationMessage | null | undefined>)[kind];
      out.type = 'poll';
      out.text = [poll?.name, ...(poll?.options ?? []).map((o) => `- ${o.optionName}`)].filter(Boolean).join('\n');
      break;
    }
    case 'reactionMessage': {
      const r = content.reactionMessage;
      out.type = 'reaction';
      out.text = r?.text ?? '';
      if (r?.key?.id) {
        out.reaction = { targetId: r.key.id, targetChatJid: r.key.remoteJid ?? undefined, targetFromMe: Boolean(r.key.fromMe), emoji: r.text ?? '' };
      }
      break;
    }
    case 'protocolMessage': {
      const p = content.protocolMessage;
      const targetId = p?.key?.id ?? undefined;
      if (p?.type === proto.Message.ProtocolMessage.Type.REVOKE && targetId) {
        out.type = 'revoke';
        out.revoke = { targetId };
      } else if (p?.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT && targetId) {
        const edited = describeMessage({ key: msg.key, message: p.editedMessage ?? undefined } as WAMessage);
        out.type = 'edit';
        out.text = edited.text;
        out.edit = { targetId, text: edited.text };
      } else {
        out.type = 'system';
        out.text = `[protocol:${p?.type ?? 'unknown'}]`;
      }
      break;
    }
    case 'listResponseMessage':
      out.type = 'text';
      out.text = content.listResponseMessage?.title ?? content.listResponseMessage?.singleSelectReply?.selectedRowId ?? '';
      break;
    case 'buttonsResponseMessage':
      out.type = 'text';
      out.text = content.buttonsResponseMessage?.selectedDisplayText ?? content.buttonsResponseMessage?.selectedButtonId ?? '';
      break;
    case 'templateButtonReplyMessage':
      out.type = 'text';
      out.text = content.templateButtonReplyMessage?.selectedDisplayText ?? '';
      break;
    case 'eventMessage':
      out.type = 'event';
      out.text = [content.eventMessage?.name, content.eventMessage?.description].filter(Boolean).join('\n');
      break;
    default:
      out.type = kind ? kind.replace(/Message$/, '') : 'unknown';
      break;
  }
  return out;
}

export interface SenderInfo {
  /** Normalized JID of the author (phone or LID form, whatever WhatsApp sent). */
  jid: string;
  /** Normalized phone-number JID when it is known from either the key or its alt field. */
  phoneJid?: string;
  /** Normalized LID JID when known. */
  lidJid?: string;
}

export function senderOf(msg: WAMessage, me?: { jid?: string; lid?: string }): SenderInfo {
  const key = msg.key;
  if (key.fromMe) {
    return { jid: me?.jid ?? me?.lid ?? 'me', phoneJid: me?.jid, lidJid: me?.lid };
  }
  const group = isJidGroup(key.remoteJid ?? undefined);
  const primary = jidNormalizedUser((group ? key.participant : key.remoteJid) ?? key.remoteJid ?? '');
  const altRaw = group ? key.participantAlt : key.remoteJidAlt;
  const alt = altRaw ? jidNormalizedUser(altRaw) : undefined;
  const info: SenderInfo = { jid: primary };
  for (const candidate of [primary, alt]) {
    if (!candidate) continue;
    if (isPnUser(candidate)) info.phoneJid = candidate;
    else if (isLidUser(candidate)) info.lidJid = candidate;
  }
  return info;
}

/** JSON-safe serialization (bytes as base64, longs as strings) that round-trips through proto.*.fromObject. */
export function messageToJson(msg: WAMessage): string {
  try {
    return JSON.stringify(proto.WebMessageInfo.fromObject(msg as proto.IWebMessageInfo).toJSON());
  } catch {
    return JSON.stringify(msg, (_k, v) => {
      if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');
      if (v && typeof v === 'object' && typeof (v as LongLike).low === 'number' && typeof (v as LongLike).high === 'number') return String(toUnixSeconds(v));
      return v;
    });
  }
}

/** Build the FTS5 MATCH expression for a free-text query: every token quoted, implicit AND, trailing `*` kept as prefix search. */
export function toFtsQuery(query: string): string {
  const tokens = query.match(/\S+/g) ?? [];
  return tokens
    .map((t) => {
      const prefix = t.endsWith('*') && t.length > 1;
      const core = (prefix ? t.slice(0, -1) : t).replace(/"/g, '""');
      return `"${core}"${prefix ? '*' : ''}`;
    })
    .join(' ');
}

export function fileExtensionFor(mime: string | undefined, filename?: string): string {
  if (filename && path_ext(filename)) return path_ext(filename);
  const map: Record<string, string> = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
    'video/mp4': '.mp4', 'video/3gpp': '.3gp', 'audio/ogg; codecs=opus': '.ogg', 'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'application/pdf': '.pdf',
  };
  return (mime && map[mime]) ?? (mime && map[mime.split(';')[0]!.trim()]) ?? '.bin';
}

function path_ext(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 && name.length - i <= 8 ? name.slice(i).toLowerCase() : '';
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proto, type WAMessage } from '@whiskeysockets/baileys';
import { describeMessage, messageToJson, senderOf, toFtsQuery, toUnixSeconds } from '../src/extract.js';

const key = (over: Partial<WAMessage['key']> = {}) => ({ remoteJid: '31612345678@s.whatsapp.net', fromMe: false, id: 'ABC123', ...over });

test('toUnixSeconds handles numbers, strings, Long-like objects and null', () => {
  assert.equal(toUnixSeconds(1700000000), 1700000000);
  assert.equal(toUnixSeconds('1700000000'), 1700000000);
  assert.equal(toUnixSeconds({ low: 1700000000, high: 0 }), 1700000000);
  assert.equal(toUnixSeconds({ low: 0, high: 0, toNumber: () => 42 }), 42);
  assert.equal(toUnixSeconds(null, 7), 7);
});

test('describeMessage: plain text', () => {
  const d = describeMessage({ key: key(), message: { conversation: 'hello world' } } as WAMessage);
  assert.equal(d.type, 'text');
  assert.equal(d.text, 'hello world');
});

test('describeMessage: extended text with quote and mentions', () => {
  const d = describeMessage({
    key: key(),
    message: { extendedTextMessage: { text: 'hi @alice', contextInfo: { stanzaId: 'Q1', mentionedJid: ['31611111111@s.whatsapp.net'] } } },
  } as WAMessage);
  assert.equal(d.text, 'hi @alice');
  assert.equal(d.quotedId, 'Q1');
  assert.deepEqual(d.mentions, ['31611111111@s.whatsapp.net']);
});

test('describeMessage: image with caption, voice note, document', () => {
  const img = describeMessage({ key: key(), message: { imageMessage: { caption: 'look', mimetype: 'image/jpeg', fileLength: 1234 } } } as WAMessage);
  assert.equal(img.type, 'image');
  assert.equal(img.text, 'look');
  assert.deepEqual(img.media, { kind: 'image', mime: 'image/jpeg', size: 1234 });

  const voice = describeMessage({ key: key(), message: { audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus' } } } as WAMessage);
  assert.equal(voice.type, 'voice');

  const doc = describeMessage({ key: key(), message: { documentMessage: { fileName: 'invoice.pdf', mimetype: 'application/pdf' } } } as WAMessage);
  assert.equal(doc.type, 'document');
  assert.equal(doc.media?.filename, 'invoice.pdf');
});

test('describeMessage: ephemeral wrapper is unwrapped', () => {
  const d = describeMessage({ key: key(), message: { ephemeralMessage: { message: { conversation: 'secret' } } } } as WAMessage);
  assert.equal(d.type, 'text');
  assert.equal(d.text, 'secret');
});

test('describeMessage: reaction, revoke and edit protocol messages', () => {
  const reaction = describeMessage({ key: key(), message: { reactionMessage: { key: key({ id: 'T1' }), text: '👍' } } } as WAMessage);
  assert.equal(reaction.type, 'reaction');
  assert.equal(reaction.reaction?.targetId, 'T1');
  assert.equal(reaction.reaction?.emoji, '👍');

  const revoke = describeMessage({ key: key(), message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE, key: key({ id: 'T2' }) } } } as WAMessage);
  assert.equal(revoke.type, 'revoke');
  assert.equal(revoke.revoke?.targetId, 'T2');

  const edit = describeMessage({
    key: key(),
    message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT, key: key({ id: 'T3' }), editedMessage: { conversation: 'fixed typo' } } },
  } as WAMessage);
  assert.equal(edit.type, 'edit');
  assert.deepEqual(edit.edit, { targetId: 'T3', text: 'fixed typo' });
});

test('describeMessage: system stub without content', () => {
  const d = describeMessage({ key: key(), messageStubType: proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_ADD, messageStubParameters: ['31699999999@s.whatsapp.net'] } as WAMessage);
  assert.equal(d.type, 'system');
  assert.match(d.text, /GROUP_PARTICIPANT_ADD/);
});

test('senderOf: DM, group, fromMe, and LID/phone twins', () => {
  assert.deepEqual(senderOf({ key: key() } as WAMessage), { jid: '31612345678@s.whatsapp.net', phoneJid: '31612345678@s.whatsapp.net' });
  const group = senderOf({ key: key({ remoteJid: '123-456@g.us', participant: '999@lid', participantAlt: '31600000000:5@s.whatsapp.net' }) } as WAMessage);
  assert.equal(group.jid, '999@lid');
  assert.equal(group.lidJid, '999@lid');
  assert.equal(group.phoneJid, '31600000000@s.whatsapp.net');
  const mine = senderOf({ key: key({ fromMe: true }) } as WAMessage, { jid: '31600000001@s.whatsapp.net', lid: '42@lid' });
  assert.equal(mine.jid, '31600000001@s.whatsapp.net');
  assert.equal(mine.lidJid, '42@lid');
});

test('messageToJson round-trips through proto with bytes and longs', () => {
  const msg = { key: key(), messageTimestamp: 1700000000, message: { imageMessage: { caption: 'x', mediaKey: new Uint8Array([1, 2, 3]), fileLength: 5 } } } as unknown as WAMessage;
  const json = messageToJson(msg);
  const parsed = JSON.parse(json) as { message: proto.IMessage };
  const back = proto.Message.fromObject(parsed.message);
  assert.deepEqual(Array.from(back.imageMessage!.mediaKey!), [1, 2, 3]);
  assert.equal(back.imageMessage!.caption, 'x');
});

test('toFtsQuery quotes tokens, keeps prefix stars and escapes quotes', () => {
  assert.equal(toFtsQuery('hello world'), '"hello" "world"');
  assert.equal(toFtsQuery('invoic*'), '"invoic"*');
  assert.equal(toFtsQuery('say "hi"'), '"say" """hi"""');
  assert.equal(toFtsQuery('  '), '');
});

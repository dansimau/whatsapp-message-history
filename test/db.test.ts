import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Archive, type MessageRow } from '../src/db.js';

function tempArchive(): Archive {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmh-db-'));
  return new Archive(path.join(dir, 'messages.db'));
}

const ALICE = '31611111111@s.whatsapp.net';
const ALICE_LID = '1001@lid';
const BOB = '31622222222@s.whatsapp.net';
const GROUP = '120363000000000000@g.us';
const ME = '31600000000@s.whatsapp.net';

function row(over: Partial<MessageRow>): MessageRow {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    chatJid: ALICE,
    chatIsGroup: false,
    senderJid: ALICE,
    senderPhoneJid: ALICE,
    fromMe: false,
    timestamp: 1_700_000_000,
    type: 'text',
    text: '',
    source: 'live',
    raw: '{}',
    ...over,
  };
}

test('insert, upsert, edit and revoke', () => {
  const db = tempArchive();
  assert.equal(db.upsertMessage(row({ id: 'm1', text: 'first draft' })), 'inserted');
  assert.equal(db.upsertMessage(row({ id: 'm1', text: 'first draft' })), 'updated');
  assert.ok(db.applyEdit('m1', 'final text'));
  // a re-delivery of the original must not clobber the edit
  db.upsertMessage(row({ id: 'm1', text: 'first draft' }));
  const [m] = db.search({ query: 'final', limit: 10 });
  assert.equal(m?.text, 'final text');
  assert.equal(m?.edited, true);
  assert.equal(db.search({ query: 'draft', limit: 10 }).length, 0, 'FTS index follows the edit');
  assert.ok(db.markRevoked('m1'));
  assert.equal(db.search({ query: 'final', limit: 10 })[0]?.revoked, true);
  db.close();
});

test('full-text search with filters and name resolution', () => {
  const db = tempArchive();
  db.upsertContact({ jid: ALICE, lid: ALICE_LID, phoneJid: ALICE, name: 'Alice Example' });
  db.upsertContact({ jid: BOB, phoneJid: BOB, notify: 'bobby' });
  db.upsertChat({ jid: GROUP, name: 'Family', isGroup: true });
  db.upsertLidMapping(ALICE_LID, ALICE);

  db.upsertMessage(row({ id: 'a1', text: 'Dinner at 7 tonight?', timestamp: 1_700_000_000 }));
  db.upsertMessage(row({ id: 'a2', text: 'Sure, dinner works', fromMe: true, senderJid: ME, senderPhoneJid: ME, timestamp: 1_700_000_100 }));
  db.upsertMessage(row({ id: 'g1', chatJid: GROUP, chatIsGroup: true, senderJid: ALICE_LID, senderLidJid: ALICE_LID, senderPhoneJid: undefined, text: 'Dinner photos!', timestamp: 1_700_000_200 }));
  db.upsertMessage(row({ id: 'b1', chatJid: BOB, senderJid: BOB, senderPhoneJid: BOB, text: 'Invoice attached', type: 'document', mediaKind: 'document', mediaFilename: 'invoice.pdf', timestamp: 1_700_000_300 }));

  const dinner = db.search({ query: 'dinner', limit: 10 });
  assert.equal(dinner.length, 3);

  const fromAliceInGroup = db.search({ query: 'dinner', chatJids: [GROUP], limit: 10 });
  assert.equal(fromAliceInGroup.length, 1);
  assert.equal(fromAliceInGroup[0]?.chatName, 'Family');
  assert.equal(fromAliceInGroup[0]?.senderName, 'Alice Example', 'LID sender resolves to the contact name via lid_map');
  assert.equal(fromAliceInGroup[0]?.senderPhone, '+31611111111');

  const mine = db.search({ query: 'dinner', fromMe: true, limit: 10 });
  assert.equal(mine.length, 1);
  assert.equal(mine[0]?.senderName, 'me');

  const since = db.search({ since: 1_700_000_250, limit: 10 });
  assert.deepEqual(since.map((m) => m.id), ['b1']);

  const prefix = db.search({ query: 'invoi*', limit: 10 });
  assert.equal(prefix[0]?.id, 'b1');
  assert.equal(prefix[0]?.senderName, 'bobby');

  const bySender = db.search({ senderJids: db.resolveSenders('Alice'), limit: 10 });
  assert.deepEqual(bySender.map((m) => m.id).sort(), ['a1', 'g1']);
  db.close();
});

test('chat resolution by name, phone and JID', () => {
  const db = tempArchive();
  db.upsertContact({ jid: ALICE, lid: ALICE_LID, phoneJid: ALICE, name: 'Alice Example' });
  db.upsertChat({ jid: GROUP, name: 'Family', isGroup: true });
  db.upsertMessage(row({ id: 'a1', text: 'hi' }));
  db.upsertMessage(row({ id: 'g1', chatJid: GROUP, chatIsGroup: true, text: 'hi all' }));

  assert.deepEqual(db.resolveChats('alice').map((c) => c.jid), [ALICE]);
  assert.deepEqual(db.resolveChats('+31 6 1111 1111').map((c) => c.jid), [ALICE]);
  assert.deepEqual(db.resolveChats(ALICE_LID).map((c) => c.jid), [ALICE], 'LID input maps to the phone-keyed chat');
  assert.deepEqual(db.resolveChats('fam').map((c) => c.name), ['Family']);
  assert.deepEqual(db.resolveChats('nobody'), []);

  const chats = db.listChats({ limit: 10 });
  assert.deepEqual(chats.map((c) => c.name).sort(), ['Alice Example', 'Family']);
  assert.equal(db.listChats({ query: 'fam', limit: 10 }).length, 1);
  db.close();
});

test('getMessages pages chronologically and around an anchor', () => {
  const db = tempArchive();
  for (let i = 0; i < 10; i++) db.upsertMessage(row({ id: `m${i}`, text: `message ${i}`, timestamp: 1_700_000_000 + i * 60 }));
  const latest = db.getMessages({ chatJids: [ALICE], limit: 3 });
  assert.deepEqual(latest.map((m) => m.id), ['m7', 'm8', 'm9']);
  const before = db.getMessages({ chatJids: [ALICE], before: 1_700_000_000 + 7 * 60, limit: 2 });
  assert.deepEqual(before.map((m) => m.id), ['m5', 'm6']);
  const after = db.getMessages({ chatJids: [ALICE], after: 1_700_000_000 + 2 * 60, limit: 2 });
  assert.deepEqual(after.map((m) => m.id), ['m3', 'm4']);
  const around = db.getMessages({ chatJids: [ALICE], aroundId: 'm5', limit: 4 });
  assert.deepEqual(around.map((m) => m.id), ['m3', 'm4', 'm5', 'm6', 'm7']);
  db.close();
});

test('reactions and stats', () => {
  const db = tempArchive();
  db.upsertMessage(row({ id: 'm1', text: 'nice' }));
  db.upsertReaction({ messageId: 'm1', senderJid: BOB, emoji: '❤️', timestamp: 1 });
  db.upsertReaction({ messageId: 'm1', senderJid: ALICE, emoji: '😂', timestamp: 2 });
  assert.equal(db.reactionsFor(['m1']).get('m1')?.length, 2);
  db.upsertReaction({ messageId: 'm1', senderJid: ALICE, emoji: '', timestamp: 3 });
  assert.equal(db.reactionsFor(['m1']).get('m1')?.length, 1);
  const s = db.stats();
  assert.equal(s.messages, 1);
  assert.equal(s.chats, 1);
  db.close();
});

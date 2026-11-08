import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatMessage, parseTime } from '../src/mcp.js';
import type { MessageView } from '../src/db.js';

test('parseTime accepts ISO, unix seconds/millis and relative windows', () => {
  const now = Date.UTC(2026, 10, 7, 12, 0, 0);
  assert.equal(parseTime(undefined, now), undefined);
  assert.equal(parseTime('7d', now), Math.floor(now / 1000) - 7 * 86400);
  assert.equal(parseTime('90m', now), Math.floor(now / 1000) - 90 * 60);
  assert.equal(parseTime('1700000000', now), 1700000000);
  assert.equal(parseTime('1700000000000', now), 1700000000);
  assert.equal(parseTime('2026-11-07T10:00:00Z', now), Date.UTC(2026, 10, 7, 10) / 1000);
  assert.throws(() => parseTime('yesterday-ish', now), /Unrecognised time/);
});

test('formatMessage renders sender, media, flags and id', () => {
  const base: MessageView = {
    id: 'ID1', chatJid: 'g@g.us', chatName: 'Family', chatIsGroup: true, senderJid: 'a@s.whatsapp.net', senderName: 'Alice', senderPhone: '+31611111111',
    fromMe: false, timestamp: 1_700_000_000, type: 'image', text: 'look\nat this', mediaKind: 'image', edited: true, revoked: false,
  };
  const line = formatMessage(base, { showChat: true, reactions: [{ senderJid: 'b', emoji: '👍' }] });
  assert.match(line, /Family \[group\] › Alice \(\+31611111111\): \[image\] look ⏎ at this \(edited\) 👍  ·id=ID1$/);
  const mine = formatMessage({ ...base, fromMe: true, senderName: 'me', mediaKind: undefined, text: 'ok', edited: false }, { showChat: false });
  assert.match(mine, /\] me: ok  ·id=ID1$/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { innerMessage, messageWords, quotedOf } from '../quoted.js';

// 2026-11-15: a driver's "ת" on another dispatcher's post reached the server with no quote.

const POST = 'שמש מצפה יריחו 250\nרמת אברהם זמן';

test('quote: the usual reply — the words and the id of the answered post', () => {
  const m = { extendedTextMessage: { text: 'ת', contextInfo: { stanzaId: '3A82C2CD', participant: 'x@lid', quotedMessage: { conversation: POST } } } };
  assert.deepEqual(quotedOf(m), { text: POST, id: '3A82C2CD' });
  const ext = { extendedTextMessage: { text: 'ת', contextInfo: { stanzaId: 'A1', quotedMessage: { extendedTextMessage: { text: POST } } } } };
  assert.deepEqual(quotedOf(ext), { text: POST, id: 'A1' });
});

test('quote: the answered post inside a wrapper, the reply inside a wrapper, the quote under another kind', () => {
  const wrappedPost = { extendedTextMessage: { text: 'ת', contextInfo: { stanzaId: 'A2', quotedMessage: { ephemeralMessage: { message: { extendedTextMessage: { text: POST } } } } } } };
  assert.deepEqual(quotedOf(wrappedPost), { text: POST, id: 'A2' });
  const wrappedReply = { ephemeralMessage: { message: { extendedTextMessage: { text: 'ת', contextInfo: { stanzaId: 'A3', quotedMessage: { conversation: POST } } } } } };
  assert.deepEqual(quotedOf(wrappedReply), { text: POST, id: 'A3' });
  assert.equal(messageWords(wrappedReply), 'ת');
  const otherKind = { stickerMessage: { contextInfo: { stanzaId: 'A4', quotedMessage: { imageMessage: { caption: POST } } } } };
  assert.deepEqual(quotedOf(otherKind), { text: POST, id: 'A4' });
});

test('quote: words that cannot be read still hand on the id; no quote hands on nothing', () => {
  const noWords = { extendedTextMessage: { text: 'ת', contextInfo: { stanzaId: 'A5', quotedMessage: { stickerMessage: {} } } } };
  assert.deepEqual(quotedOf(noWords), { text: null, id: 'A5' });
  const idOnly = { extendedTextMessage: { text: 'ת', contextInfo: { stanzaId: 'A6' } } };
  assert.deepEqual(quotedOf(idOnly), { text: null, id: 'A6' });
  assert.deepEqual(quotedOf({ conversation: 'ת' }), { text: null, id: null });
  // contextInfo without a quote (mentions, a forward mark) is no quote
  assert.deepEqual(quotedOf({ extendedTextMessage: { text: 'ת', contextInfo: { mentionedJid: ['a@lid'] } } }), { text: null, id: null });
  assert.deepEqual(quotedOf(null), { text: null, id: null });
  assert.equal(innerMessage(undefined), null);
});

test('quote: both forwards — the group feed and the private line — read it this way', () => {
  const session = readFileSync(new URL('../session.js', import.meta.url), 'utf8');
  assert.ok(session.includes("import { quotedOf } from './quoted.js';"));
  assert.equal(session.split('quotedOf(').length - 1, 3);
  assert.ok(!session.includes('quotedMsg.extendedTextMessage?.text'));
});

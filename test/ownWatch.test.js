import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeOwnWatch } from '../retryMode.js';

// 2026-11-24: the number's own phone gets every post of ours - no receipt from it in
// 20 s, and the post goes once more to it alone.

test('a post his phone took is left alone; one it did not take goes again after 20 s, once', () => {
  let t = 0;
  const w = makeOwnWatch({ now: () => t });
  w.expect('A', 'g1@g.us');
  w.expect('B', 'g2@g.us');
  t = 5_000;
  w.delivered('A');
  assert.deepEqual(w.due(), [], 'nothing before 20 s');
  t = 21_000;
  assert.deepEqual(w.due(), [{ id: 'B', group: 'g2@g.us' }]);
  assert.deepEqual(w.due(), [], 'once only');
  w.done(true);
  w.delivered('B'); // it came after all
  const s = w.stats();
  assert.equal(s.posts, 2);
  assert.equal(s.delivered, 1);
  assert.equal(s.late_delivered, 1);
  assert.equal(s.resent, 1);
  assert.equal(s.resend_ok, 1);
  assert.equal(s.watching, 0);
});

test('never more than perMinute copies a minute; the rest wait for the next minute', () => {
  let t = 0;
  const w = makeOwnWatch({ now: () => t, perMinute: 3 });
  for (let i = 0; i < 5; i++) w.expect(`M${i}`, 'g@g.us');
  t = 25_000;
  assert.equal(w.due().length, 3);
  assert.equal(w.due().length, 0);
  assert.ok(w.stats().capped >= 1);
  t = 90_000;
  assert.equal(w.due().length, 2);
});

test('a post older than five minutes is let go, not sent', () => {
  let t = 0;
  const w = makeOwnWatch({ now: () => t });
  w.expect('OLD', 'g@g.us');
  t = 6 * 60_000;
  assert.deepEqual(w.due(), []);
  assert.equal(w.stats().resent, 0);
});

test('a receipt for a post we do not watch is only counted', () => {
  const w = makeOwnWatch();
  w.delivered('nope');
  assert.equal(w.stats().receipts, 1);
  assert.equal(w.stats().delivered, 0);
});

test('wired: every group post is watched, own receipts mark it, the timer sends it to his phone alone', () => {
  const session = readFileSync(new URL('../session.js', import.meta.url), 'utf8');
  assert.ok(session.includes('(s.ownWatch = s.ownWatch || makeOwnWatch()).expect(msgId, jid);'));
  assert.ok(session.includes('if (s.ownWatch && r?.key?.id && isOwnParticipant(recv?.userJid, sock.authState?.creds?.me)) s.ownWatch.delivered(r.key.id);'));
  assert.ok(session.includes('await sock.relayMessage(group, entry.content, { messageId: id, participant: { jid: own, count: 1 } });'));
  assert.ok(session.includes('void flushOwnWatch(s); }'));
  assert.ok(session.includes("const OWN_PHONE_WATCH = String(process.env.OWN_PHONE_WATCH || 'on').toLowerCase() !== 'off';"));
});

test('phonesToParticipant answers a member\'s phone alone - but never the number\'s own phone', () => {
  const patch = readFileSync(new URL('../baileysPatch.js', import.meta.url), 'utf8');
  assert.ok(patch.includes('globalThis.__bridgeRetry?.phonesToParticipant && !globalThis.__bridgeRetry?.isOwn?.(participant)'));
  const session = readFileSync(new URL('../session.js', import.meta.url), 'utf8');
  assert.ok(session.includes('isOwn: (participant) => { for (const s of sessions.values()) if (isOwnParticipant(participant, s.sock?.authState?.creds?.me)) return true; return false; },'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeUndecryptable } from '../retryMode.js';
import { EDITS, PATCH_MARK, patchSource } from '../baileysPatch.js';

// 2026-11-15, the feed's tail: two bots' posts that never decrypt went round every
// 0.6 s — 234 and 215 times in two minutes — inside the one lock of incoming messages.

test('a message is asked for five times, then stopped — for an hour', () => {
  let t = 1_000_000;
  const u = makeUndecryptable({ now: () => t });
  for (let i = 0; i < 5; i++) assert.equal(u.failed('3EB0AAA'), false);
  assert.equal(u.failed('3EB0AAA'), true);
  assert.equal(u.failed('3EB0AAA'), true);
  assert.equal(u.failed('3EB0BBB'), false); // another message has its own count
  assert.deepEqual(u.totals(), { messages: 1, stopped: 2 });
  t += 61 * 60_000; // the same id an hour later starts over
  assert.equal(u.failed('3EB0AAA'), false);
  assert.equal(u.failed(''), false);
  assert.equal(u.failed(undefined), false);
});

test('the count does not grow without end', () => {
  const u = makeUndecryptable({ cap: 3 });
  for (const id of ['a', 'b', 'c', 'd']) u.failed(id);
  for (let i = 0; i < 5; i++) u.failed('d');
  assert.equal(u.failed('d'), true); // the newest is kept
  for (let i = 0; i < 5; i++) assert.equal(u.failed('a'), false); // the oldest was dropped: counted anew
});

test('the patch: stopped before the request, acknowledged plainly, and nothing else is touched', () => {
  const stock = readFileSync(new URL('../node_modules/baileys/lib/Socket/messages-recv.js', import.meta.url), 'utf8');
  const r = patchSource(stock, EDITS['lib/Socket/messages-recv.js']);
  assert.equal(r.state, 'applied');
  const at = r.out.indexOf('globalThis.__bridgeRetry?.undecryptable?.(msg.key?.id)');
  const ask = r.out.indexOf('await sendRetryRequest(node, !encNode);');
  assert.ok(at > 0 && at < ask);
  const between = r.out.slice(at, ask);
  assert.ok(between.includes('acked = true;'));
  assert.ok(between.includes('await sendMessageAck(node);')); // no error code: it is not sent again
  assert.ok(between.includes('return;'));
  // the error answer of the first five times stays
  assert.ok(r.out.includes('await sendMessageAck(node, NACK_REASONS.UnhandledError);'));
  assert.equal(r.out.split(PATCH_MARK).length - 1, EDITS['lib/Socket/messages-recv.js'].length);
});

test('the switch and the shorter wait are wired', () => {
  const session = readFileSync(new URL('../session.js', import.meta.url), 'utf8');
  assert.ok(session.includes('undecryptable: (id) => (stopLoops ? undecryptable.failed(id) : false),'));
  assert.ok(session.includes('retryRequestDelayMs: RETRY_REQUEST_DELAY_MS,'));
  assert.ok(session.includes("Number(process.env.RETRY_REQUEST_DELAY_MS || 50)"));
  const worker = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  assert.ok(worker.includes("if (typeof m.stopLoops === 'boolean') setStopLoops(m.stopLoops);"));
});

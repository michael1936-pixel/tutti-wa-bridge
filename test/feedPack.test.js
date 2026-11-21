import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeFeedPacker } from '../feedPack.js';

// 2026-11-21: group messages leave in packs when the lanes are busy, alone when they are free.

const msg = (id) => ({ wa_message_id: id, text: 'ים בב 150', bridge_sent_ms: 1000 });
const tick = () => new Promise((r) => setImmediate(r));

/** A server whose answers are released by hand. */
function server({ packs = true } = {}) {
  const calls = [];
  const open = [];
  const post = (body) => new Promise((resolve) => {
    calls.push(body);
    open.push(() => {
      if (Array.isArray(body.batch)) {
        if (!packs) return resolve({ status: 400, text: '{"ok":false,"error":"bad_body"}' });
        return resolve({ status: 200, text: JSON.stringify({ ok: true, results: body.batch.map(() => ({ status: 200, ok: true })) }) });
      }
      resolve({ status: 200, text: '{"ok":true}' });
    });
  });
  const release = async () => { while (open.length) { open.shift()(); await tick(); await tick(); } };
  return { calls, post, release, open };
}

test('a free lane: the message leaves at once, alone, as before', async () => {
  const s = server();
  const results = [];
  const p = makeFeedPacker({ post: s.post, lanes: 2, onResult: (m, r) => results.push([m.wa_message_id, r.packed]) });
  const done = p.add(msg('a'));
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].wa_message_id, 'a');
  assert.equal(s.calls[0].batch, undefined);
  await s.release();
  await done;
  assert.deepEqual(results, [['a', 1]]);
});

test('busy lanes: what gathered leaves as one pack, every message answered', async () => {
  const s = server();
  const results = [];
  const p = makeFeedPacker({ post: s.post, lanes: 1, max: 40, onResult: (m, r) => results.push([m.wa_message_id, r.packed]) });
  const all = ['a', 'b', 'c', 'd'].map((id) => p.add(msg(id)));
  assert.equal(s.calls.length, 1, 'only the first left');
  s.open.shift()();
  await tick(); await tick();
  assert.equal(s.calls.length, 2);
  assert.deepEqual(s.calls[1].batch.map((m) => m.wa_message_id), ['b', 'c', 'd']);
  await s.release();
  await Promise.all(all);
  assert.deepEqual(results, [['a', 1], ['b', 3], ['c', 3], ['d', 3]]);
});

test('a pack is no bigger than max', async () => {
  const s = server();
  const p = makeFeedPacker({ post: s.post, lanes: 1, max: 2 });
  const all = ['a', 'b', 'c', 'd', 'e'].map((id) => p.add(msg(id)));
  await s.release();
  await Promise.all(all);
  assert.deepEqual(s.calls.map((c) => (c.batch ? c.batch.length : 1)), [1, 2, 2]);
});

test('a server that does not take packs: every message goes alone, and packs rest', async () => {
  const s = server({ packs: false });
  let t = 0;
  const errors = [];
  const p = makeFeedPacker({ post: s.post, lanes: 1, aloneLanes: 8, now: () => t, sleep: async () => {}, onError: (m, e) => errors.push(e.message) });
  const all = ['a', 'b', 'c'].map((id) => p.add(msg(id)));
  await s.release();
  await Promise.all(all);
  // a alone, [b,c] refused, then b and c alone
  assert.deepEqual(s.calls.map((c) => (c.batch ? 'pack' : c.wa_message_id)), ['a', 'pack', 'b', 'c']);
  assert.deepEqual(errors, ['pack_not_taken_400']);
  assert.equal(p.stats().packs, false);
  // while they rest, nothing is packed
  const more = ['d', 'e', 'f'].map((id) => p.add(msg(id)));
  assert.deepEqual(s.calls.slice(4).map((c) => c.wa_message_id), ['d', 'e', 'f']);
  await s.release();
  await Promise.all(more);
  t = 61_000;
  assert.equal(p.stats().packs, true);
});

test('a pack that fails on the way is sent again message by message', async () => {
  const calls = [];
  const post = async (body) => {
    calls.push(body);
    if (body.batch) throw new Error('network');
    return { status: 200, text: '{"ok":true}' };
  };
  let release;
  const first = new Promise((r) => { release = r; });
  let n = 0;
  const gated = async (body) => { if (n++ === 0) await first; return post(body); };
  const p = makeFeedPacker({ post: gated, lanes: 1, sleep: async () => {} });
  const all = ['a', 'b', 'c'].map((id) => p.add(msg(id)));
  release();
  await Promise.all(all);
  assert.deepEqual(calls.map((c) => (c.batch ? 'pack' : c.wa_message_id)), ['a', 'pack', 'b', 'c']);
});

test('a lone message that the server fails is tried once more', async () => {
  let n = 0;
  const post = async () => ({ status: n++ === 0 ? 503 : 200, text: '' });
  const seen = [];
  const p = makeFeedPacker({ post, sleep: async () => {}, onResult: (m, r) => seen.push([r.status, r.attempt]) });
  await p.add(msg('a'));
  assert.deepEqual(seen, [[503, 1], [200, 2]]);
});

test('the wait in the line is said apart, and the leaving time is stamped at leaving', async () => {
  const s = server();
  let t = 5_000;
  const p = makeFeedPacker({ post: s.post, lanes: 1, now: () => t });
  const a = p.add({ wa_message_id: 'a', bridge_sent_ms: 4_000 });
  const b = p.add({ wa_message_id: 'b', bridge_sent_ms: 4_500 });
  const c = p.add({ wa_message_id: 'c', bridge_sent_ms: 4_600 });
  t = 9_000;
  await s.release();
  await Promise.all([a, b, c]);
  assert.equal(s.calls[0].bridge_queue_ms, 1_000);
  assert.equal(s.calls[0].bridge_sent_ms, 5_000);
  assert.equal(s.calls[1].batch[0].bridge_queue_ms, 4_500);
  assert.equal(s.calls[1].batch[0].bridge_sent_ms, 9_000);
});

test('wired: a number hands its group messages to the one sender of all numbers', () => {
  const session = readFileSync(new URL('../session.js', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.ok(session.includes("process.send({ t: 'group_feed', payload })"));
  assert.ok(session.includes('await groupForwardSlot(async () => {'), 'the old way stays for GROUP_FEED_PACK=off');
  assert.ok(server.includes("} else if (m.t === 'group_feed') {"));
  assert.ok(server.includes('void feedPacker.add(m.payload);'));
});

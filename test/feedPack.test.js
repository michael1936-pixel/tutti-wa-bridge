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

test('a pack that fails on the way twice is sent again message by message', async () => {
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
  assert.deepEqual(calls.map((c) => (c.batch ? 'pack' : c.wa_message_id)), ['a', 'pack', 'pack', 'b', 'c']);
  assert.equal(p.stats().failed_packs, 2);
  assert.equal(p.stats().sent_alone_after, 2);
});

// 2026-11-24: no flood - a failed pack is tried once more as a pack, then its messages go a few at a time.
test('a pack the server fails (5xx) is sent once more as the same pack, and taken - nothing goes alone', async () => {
  const calls = [];
  let packTries = 0;
  const post = async (body) => {
    calls.push(body);
    if (body.batch) {
      packTries++;
      if (packTries === 1) return { status: 503, text: 'busy' };
      return { status: 200, text: JSON.stringify({ results: body.batch.map(() => ({ status: 200 })) }) };
    }
    return { status: 200, text: '{"ok":true}' };
  };
  let release;
  const first = new Promise((r) => { release = r; });
  let n = 0;
  const gated = async (body) => { if (n++ === 0) await first; return post(body); };
  const seen = [];
  const p = makeFeedPacker({ post: gated, lanes: 1, sleep: async () => {}, onResult: (m, r) => seen.push([m.wa_message_id, r.attempt, r.packed]) });
  const all = ['a', 'b', 'c', 'd'].map((id) => p.add(msg(id)));
  release();
  await Promise.all(all);
  assert.deepEqual(calls.map((c) => (c.batch ? `pack${c.batch.length}` : c.wa_message_id)), ['a', 'pack3', 'pack3']);
  assert.deepEqual(seen, [['a', 1, 1], ['b', 2, 3], ['c', 2, 3], ['d', 2, 3]]);
  assert.equal(p.stats().packs, true, 'a failure is not a refusal: packs go on');
  assert.equal(p.stats().sent_alone_after, 0);
});

test('a pack that fails twice: its 60 messages go alone a few at a time, never all at once', async () => {
  let inFlight = 0;
  let most = 0;
  const lone = [];
  const post = async (body) => {
    if (body.batch) throw new Error('timeout');
    inFlight++; most = Math.max(most, inFlight);
    lone.push(body.wa_message_id);
    await tick();
    inFlight--;
    return { status: 200, text: '{"ok":true}' };
  };
  let release;
  const first = new Promise((r) => { release = r; });
  let n = 0;
  const gated = async (body) => { if (n++ === 0) await first; return post(body); };
  const p = makeFeedPacker({ post: gated, lanes: 1, max: 60, aloneAtOnce: 4, sleep: async () => {} });
  const ids = Array.from({ length: 61 }, (_, i) => `m${i}`);
  const all = ids.map((id) => p.add(msg(id)));
  release();
  await Promise.all(all);
  assert.equal(lone.length, 61, 'every message answered - nothing dropped');
  assert.ok(most <= 4, `at most 4 alone at once, saw ${most}`);
});

test('many lanes failing together stay within lanes x aloneAtOnce requests at once', async () => {
  let inFlight = 0;
  let most = 0;
  let answered = 0;
  const post = async (body) => {
    inFlight++; most = Math.max(most, inFlight);
    await tick(); await tick();
    inFlight--;
    if (body.batch) return { status: 502, text: 'bad gateway' };
    answered++;
    return { status: 200, text: '{"ok":true}' };
  };
  const p = makeFeedPacker({ post, lanes: 12, max: 60, aloneAtOnce: 4, sleep: async () => {} });
  const all = Array.from({ length: 12 + 12 * 60 }, (_, i) => p.add(msg(`m${i}`)));
  await Promise.all(all);
  assert.equal(answered, 12 + 12 * 60);
  assert.ok(most <= 12 * 4, `at most 48 requests at once, saw ${most}`);
});

test('wired: the server shows the failed packs in /diag', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.ok(server.includes('group_feed_pack: { ...feedPacker.stats(),'));
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

// 2026-11-24: several copies of the server's function, each request to the next in turn.
import { feedPosters, feedUrls } from '../feedPack.js';

function fakeFetch() {
  const hits = [];
  const fetchImpl = async (url, init) => {
    hits.push({ url, body: JSON.parse(init.body), secret: init.headers['X-Webhook-Secret'], region: init.headers['x-region'] });
    return { status: 200, text: async () => JSON.stringify({ ok: true, url }) };
  };
  return { hits, fetchImpl };
}

test('one URL: the poster of before, every request to it', async () => {
  const { hits, fetchImpl } = fakeFetch();
  const post = feedPosters({ urls: ['https://x/fn'], secret: 's', fetchImpl });
  await post({ a: 1 }); await post({ batch: [{ a: 2 }] });
  assert.deepEqual(hits.map((h) => h.url), ['https://x/fn', 'https://x/fn']);
  assert.equal(hits[0].secret, 's');
  assert.equal(hits[0].region, 'eu-central-1');
});

test('three copies: each request to the next in turn, the same headers, the body untouched', async () => {
  const { hits, fetchImpl } = fakeFetch();
  const post = feedPosters({ urls: ['https://x/a', ' https://x/b ', '', 'https://x/c'], secret: 's', fetchImpl });
  const answers = [];
  for (let i = 0; i < 7; i++) answers.push(await post({ batch: [{ i }] }));
  assert.deepEqual(hits.map((h) => h.url), ['https://x/a', 'https://x/b', 'https://x/c', 'https://x/a', 'https://x/b', 'https://x/c', 'https://x/a']);
  assert.deepEqual(hits[4].body, { batch: [{ i: 4 }] });
  assert.ok(hits.every((h) => h.secret === 's' && h.region === 'eu-central-1'));
  assert.equal(answers[1].status, 200);
});

test('the URLs: GROUP_FEED_WEBHOOK_URLS when set, else the one of before', () => {
  assert.deepEqual(feedUrls({ GROUP_FEED_WEBHOOK_URL: 'https://x/a' }), ['https://x/a']);
  assert.deepEqual(feedUrls({ GROUP_FEED_WEBHOOK_URL: 'https://x/a', GROUP_FEED_WEBHOOK_URLS: 'https://x/a, https://x/b,https://x/c' }), ['https://x/a', 'https://x/b', 'https://x/c']);
  assert.deepEqual(feedUrls({ GROUP_FEED_WEBHOOK_URLS: ' , ' , GROUP_FEED_WEBHOOK_URL: 'https://x/a' }), ['https://x/a']);
});

test('a pack the copy does not take goes again message by message - each to the next copy', async () => {
  const hits = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    hits.push({ url, packed: Array.isArray(body.batch) });
    // copy b refuses packs (an older function), the others take them
    if (Array.isArray(body.batch) && url.endsWith('/b')) return { status: 400, text: async () => '{"ok":false}' };
    if (Array.isArray(body.batch)) return { status: 200, text: async () => JSON.stringify({ results: body.batch.map(() => ({ status: 200 })) }) };
    return { status: 200, text: async () => '{"ok":true}' };
  };
  const post = feedPosters({ urls: ['https://x/a', 'https://x/b', 'https://x/c'], secret: 's', fetchImpl });
  await post({ batch: [1, 2] });          // a takes it
  const r = await post({ batch: [3, 4] }); // b refuses it
  assert.equal(r.status, 400);
  // what the packer does then: each message alone - and they land on c, then a
  await post({ m: 3 }); await post({ m: 4 });
  assert.deepEqual(hits.map((h) => `${h.url.slice(-1)}:${h.packed ? 'pack' : 'alone'}`), ['a:pack', 'b:pack', 'c:alone', 'a:alone']);
});

test('the server builds its sender from the URLs, and every number keeps a URL of its own', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.ok(server.includes('post: feedPosters({ urls: feedUrls(), secret: GROUP_FEED_WEBHOOK_SECRET }),'));
  const session = readFileSync(new URL('../session.js', import.meta.url), 'utf8');
  assert.ok(session.includes("|| String(process.env.GROUP_FEED_WEBHOOK_URLS || '').split(',').map((s) => s.trim()).find(Boolean)"));
});

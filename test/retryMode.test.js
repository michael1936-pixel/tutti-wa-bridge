import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_MODE, parseMode, userOf, deviceOf, forgetAsker, makeRetryStats, guardLidLookup, makeBreather, breathingRepository, waitUntil,
} from '../retryMode.js';
import { makeRetryCounter } from '../retryGuard.js';

test('mode: the first day keeps the groups key memory and changes nothing a device is sent', () => {
  assert.deepEqual(DEFAULT_MODE, { keepGroupMemory: true, referenceStanza: false, phonesToParticipant: false });
  assert.deepEqual(parseMode(undefined), DEFAULT_MODE);
  assert.deepEqual(parseMode(''), DEFAULT_MODE);
  // a list of words is the whole mode
  assert.deepEqual(parseMode('keep,reference'), { keepGroupMemory: true, referenceStanza: true, phonesToParticipant: false });
  assert.deepEqual(parseMode('reference phones'), { keepGroupMemory: false, referenceStanza: true, phonesToParticipant: true });
  assert.deepEqual(parseMode('stock'), { keepGroupMemory: false, referenceStanza: false, phonesToParticipant: false });
  // an object switches what it names, the rest stays
  assert.deepEqual(parseMode({ reference: true }), { keepGroupMemory: true, referenceStanza: true, phonesToParticipant: false });
  assert.deepEqual(parseMode({ phonesToParticipant: true, junk: true, keep: 'yes' }), { keepGroupMemory: true, referenceStanza: false, phonesToParticipant: true });
  assert.deepEqual(parseMode({ keep: false }, { keepGroupMemory: true, referenceStanza: true, phonesToParticipant: false }),
    { keepGroupMemory: false, referenceStanza: true, phonesToParticipant: false });
});

test('jids: the user and the device', () => {
  assert.equal(userOf('972501234567:5@s.whatsapp.net'), '972501234567');
  assert.equal(userOf('972501234567@s.whatsapp.net'), '972501234567');
  assert.equal(userOf('123456789012345:12@lid'), '123456789012345');
  assert.equal(userOf('972501234567_1:3@hosted'), '972501234567');
  assert.equal(deviceOf('972501234567:5@s.whatsapp.net'), 5);
  assert.equal(deviceOf('972501234567@s.whatsapp.net'), 0);
  assert.equal(deviceOf('972501234567:0@s.whatsapp.net'), 0);
  assert.equal(deviceOf(undefined), 0);
});

function fakeKeys(memory) {
  const sets = [];
  return {
    sets,
    memory,
    get: async (type, ids) => (type === 'sender-key-memory' ? Object.fromEntries(ids.filter((id) => memory[id]).map((id) => [id, { ...memory[id] }])) : {}),
    set: async (data) => { sets.push(data); for (const [g, v] of Object.entries(data['sender-key-memory'] || {})) { if (v == null) delete memory[g]; else memory[g] = v; } },
  };
}

test('forgetAsker: all the devices of the one who asked — under his number and his LID — and nobody else', async () => {
  const keys = fakeKeys({
    'g@g.us': {
      '972501111111@s.whatsapp.net': true, '972501111111:4@s.whatsapp.net': true, '555000111:4@lid': true,
      '972502222222@s.whatsapp.net': true, '666000222@lid': true,
    },
  });
  const lidMapping = { getLIDForPN: async (pn) => (pn.startsWith('972501111111') ? '555000111@lid' : null), getPNForLID: async () => null };
  assert.equal(await forgetAsker({ keys, group: 'g@g.us', participant: '972501111111@s.whatsapp.net', lidMapping }), true);
  assert.deepEqual(keys.memory['g@g.us'], { '972502222222@s.whatsapp.net': true, '666000222@lid': true });
  assert.equal(keys.sets.length, 1);
  // asked under his LID: the phone number comes from the mapping
  const keys2 = fakeKeys({ 'g@g.us': { '972501111111@s.whatsapp.net': true, '555000111:2@lid': true, '972502222222@s.whatsapp.net': true } });
  await forgetAsker({ keys: keys2, group: 'g@g.us', participant: '555000111:2@lid', lidMapping: { getPNForLID: async () => '972501111111@s.whatsapp.net' } });
  assert.deepEqual(keys2.memory['g@g.us'], { '972502222222@s.whatsapp.net': true });
});

test('forgetAsker: nothing remembered, a member not in the memory, a mapping that fails or hangs', async () => {
  const empty = fakeKeys({});
  assert.equal(await forgetAsker({ keys: empty, group: 'g@g.us', participant: '972501111111@s.whatsapp.net' }), true);
  assert.equal(empty.sets.length, 0);
  const other = fakeKeys({ 'g@g.us': { '972502222222@s.whatsapp.net': true } });
  assert.equal(await forgetAsker({ keys: other, group: 'g@g.us', participant: '972501111111@s.whatsapp.net', lidMapping: { getLIDForPN: async () => { throw new Error('x'); } } }), true);
  assert.equal(other.sets.length, 0, 'nothing written when nothing changed');
  // a lookup that never answers does not hold the retry
  const hang = fakeKeys({ 'g@g.us': { '972501111111@s.whatsapp.net': true, '972502222222@s.whatsapp.net': true } });
  const t = Date.now();
  assert.equal(await forgetAsker({ keys: hang, group: 'g@g.us', participant: '972501111111@s.whatsapp.net', lidMapping: { getLIDForPN: () => new Promise(() => {}) } }), true);
  assert.ok(Date.now() - t < 3_000);
  assert.deepEqual(hang.memory['g@g.us'], { '972502222222@s.whatsapp.net': true });
  // not enough to act on: the patch falls back to stock
  assert.equal(await forgetAsker({ keys: null, group: 'g@g.us', participant: 'x@s.whatsapp.net' }), false);
  assert.equal(await forgetAsker({ keys: hang, group: 'g@g.us', participant: '' }), false);
});

test('retry stats: resends by who asked, a 479 counted to the latest resend of that message', () => {
  let t = 1_000;
  const st = makeRetryStats({ now: () => t });
  assert.equal(st.resend('M1:972501111111@s.whatsapp.net'), 'phone');
  assert.equal(st.resend('M1:972502222222:7@s.whatsapp.net'), 'linked');
  assert.equal(st.resend('M2:555000111:3@lid'), 'linked');
  assert.equal(st.rejected('M1'), 'linked');
  assert.equal(st.rejected('M1'), 'phone');
  assert.equal(st.rejected('M1'), null, 'a third 479 has no resend left');
  assert.equal(st.rejected('NOPE'), null);
  t += 5 * 60_000;
  assert.equal(st.rejected('M2'), null, 'too late to belong to that resend');
  assert.deepEqual(st.totals(), { phone: { resends: 1, rejected: 1 }, linked: { resends: 2, rejected: 1 }, unmatched: 3 });
  const was = st.reset();
  assert.equal(was.linked.resends, 2);
  assert.deepEqual(st.totals(), { phone: { resends: 0, rejected: 0 }, linked: { resends: 0, rejected: 0 }, unmatched: 0 });
});

test('the retry counter tells of every resend it lets through, once', () => {
  let t = 10_000_000;
  const allowed = [];
  const c = makeRetryCounter({ ourMessage: () => ({ ts: t - 1_000, group: true }), onAllow: (key, kind) => allowed.push([key, kind]), now: () => t });
  assert.equal(c.get('M1:a@s.whatsapp.net'), undefined);
  assert.equal(c.get('M1:a@s.whatsapp.net'), undefined, 'asked again within the same retry');
  c.get('M1:b:2@s.whatsapp.net');
  assert.deepEqual(allowed, [['M1:a@s.whatsapp.net', 'group'], ['M1:b:2@s.whatsapp.net', 'group']]);
});

test('LID questions: an empty or unanswered one is not asked again for a while', async () => {
  let t = 0;
  const asked = [];
  const lookup = async (jids) => { asked.push([...jids]); return jids.filter((j) => j.startsWith('1')).map((j) => ({ pn: j, lid: `L${j}` })); };
  const g = guardLidLookup(lookup, { now: () => t, emptyTtlMs: 1_000 });
  assert.deepEqual(await g(['1@s', '2@s']), [{ pn: '1@s', lid: 'L1@s' }]);
  assert.deepEqual(await g(['2@s']), [], 'spared');
  assert.deepEqual(await g(['2@s', '3@s']), []);
  assert.deepEqual(asked, [['1@s', '2@s'], ['3@s']]);
  t = 1_001;
  await g(['2@s']);
  assert.deepEqual(asked[2], ['2@s'], 'asked again after the time');
  assert.equal(g.stat.spared, 2);
  assert.equal(g.stat.empty, 3);
});

test('LID questions: nothing waits longer than the cap, and a failure is remembered for a short while', async () => {
  let t = 0;
  let timeouts = 0;
  const memory = new Map();
  const stat = { asked: 0, spared: 0, empty: 0, timedOut: 0, failed: 0 };
  const hang = guardLidLookup(() => new Promise(() => {}), { now: () => t, timeoutMs: 30, failTtlMs: 500, memory, stat, onTimeout: () => { timeouts += 1; } });
  const started = Date.now();
  assert.deepEqual(await hang(['9@s']), []);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(timeouts, 1);
  assert.equal(stat.timedOut, 1);
  // the number's memory is shared by its next socket's guard
  let calls = 0;
  const next = guardLidLookup(async () => { calls += 1; throw new Error('closed'); }, { now: () => t, failTtlMs: 500, memory, stat });
  assert.deepEqual(await next(['9@s']), [], 'still remembered');
  assert.equal(calls, 0);
  assert.deepEqual(await next(['8@s']), []);
  assert.equal(stat.failed, 1);
  t = 501;
  await next(['9@s']);
  assert.equal(calls, 2);
  assert.deepEqual(await next('not a list'), []);
});

test('breather: work keeps its order and its results, and the line steps aside between slices', async () => {
  let clock = 0;
  let paused = 0;
  const breathe = makeBreather({ sliceMs: 10, now: () => clock, pause: async () => { paused += 1; } });
  const order = [];
  const jobs = [];
  for (let i = 0; i < 6; i++) jobs.push(breathe(async () => { order.push(i); clock += 4; return i * 2; }));
  const failing = breathe(async () => { throw new Error('one bad job'); });
  const after = breathe(async () => 'still runs');
  assert.deepEqual(await Promise.all(jobs), [0, 2, 4, 6, 8, 10]);
  await assert.rejects(failing, /one bad job/);
  assert.equal(await after, 'still runs');
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5]);
  assert.equal(paused, 2, 'after 12 ms and after 24 ms of work');
  assert.equal(breathe.pauses(), 2);
});

test('breather: a real run lets a timer through in the middle of 400 jobs', async () => {
  const breathe = makeBreather({ sliceMs: 2 });
  let timerAt = -1;
  let done = 0;
  setTimeout(() => { timerAt = done; }, 0);
  const spin = () => { const end = performance.now() + 0.2; while (performance.now() < end); };
  await Promise.all([...Array(400)].map(() => breathe(async () => { spin(); done += 1; })));
  assert.ok(timerAt >= 0 && timerAt < 400, `the timer ran after ${timerAt} of 400 jobs`);
});

test('breathing repository: the pairwise work goes through the line, the rest is untouched', async () => {
  const seen = [];
  const repo = {
    name: 'r',
    async encryptMessage(o) { seen.push(['enc', this.name, o.jid]); return { type: 'msg' }; },
    async injectE2ESession(o) { seen.push(['inject', this.name, o.jid]); },
    async decryptMessage() { return 'plain'; },
  };
  const stockDecrypt = repo.decryptMessage;
  let through = 0;
  const out = breathingRepository(repo, (work) => { through += 1; return work(); });
  assert.equal(out, repo);
  assert.deepEqual(await repo.encryptMessage({ jid: 'a' }), { type: 'msg' });
  await repo.injectE2ESession({ jid: 'b' });
  assert.equal(through, 2);
  assert.equal(repo.decryptMessage, stockDecrypt);
  assert.deepEqual(seen, [['enc', 'r', 'a'], ['inject', 'r', 'b']]);
});

test('a send waits for the socket: at once when it is up, false after the wait', async () => {
  let t = 0;
  let up = false;
  const sleep = async (ms) => { t += ms; if (t >= 450) up = true; };
  assert.equal(await waitUntil(() => up, { waitMs: 1_000, stepMs: 150, now: () => t, sleep }), true);
  assert.equal(t, 450);
  assert.equal(await waitUntil(() => false, { waitMs: 300, stepMs: 100, now: () => t, sleep: async (ms) => { t += ms; } }), false);
  assert.equal(await waitUntil(() => true, { waitMs: 0, now: () => t, sleep: async () => { throw new Error('never sleeps'); } }), true);
});

// ---- session.js: a stuck socket is one that hears nothing --------------------------
test('stuck: two unanswered queries restart only a number that hears nothing', () => {
  const src = readFileSync(new URL('../session.js', import.meta.url), 'utf8');
  const i = src.indexOf('function stuckOf(');
  let depth = 0;
  let j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}' && --depth === 0) break; }
  const STUCK_SOCKET = { windowMs: 60_000, timeouts: 2, minGapMs: 5 * 60_000, quietMs: 45_000, floodTimeouts: 10 };
  const stuckOf = new Function('STUCK_SOCKET', `${src.slice(i, j + 1)}; return stuckOf;`)(STUCK_SOCKET);
  const now = 10_000_000;
  const h = { since: now - 3_600_000, timeouts: [now - 20_000, now - 1_000], stuckRestartAt: 0 };
  assert.equal(stuckOf(h, 'connected', now, now - 2_000), false, 'messages keep arriving: not stuck');
  assert.equal(stuckOf(h, 'connected', now, now - 50_000), true, 'nothing heard for 50 s and two timeouts');
  assert.equal(stuckOf(h, 'connected', now, 0), true, 'never heard anything on this socket');
  assert.equal(stuckOf({ ...h, since: now - 10_000 }, 'connected', now, 0), false, 'a socket 10 s old is given its time');
  assert.equal(stuckOf({ ...h, timeouts: [now - 1_000] }, 'connected', now, 0), false, 'one timeout');
  assert.equal(stuckOf({ ...h, stuckRestartAt: now - 60_000 }, 'connected', now, 0), false, 'restarted a minute ago');
  assert.equal(stuckOf(h, 'connecting', now, 0), false);
  // ten unanswered queries in a minute are a broken socket even when messages arrive
  const flood = { ...h, timeouts: [...Array(10)].map((_, i) => now - i * 1_000) };
  assert.equal(stuckOf(flood, 'connected', now, now - 1_000), true);
  assert.equal(stuckOf({ ...flood, timeouts: flood.timeouts.slice(0, 9) }, 'connected', now, now - 1_000), false);
  assert.ok(!src.includes('renewStuckNow') && !src.includes('stuckSignOf'), 'no restart from the send path');
});

test('forgetAsker: a member who keeps asking while nothing of his is found gets the stock wipe — once per group per window', async () => {
  let t = 0;
  const repeats = new Map();
  const keys = fakeKeys({ 'g@g.us': { '972502222222@s.whatsapp.net': true } });
  const ask = (participant = '972501111111@s.whatsapp.net') => forgetAsker({ keys, group: 'g@g.us', participant }, { repeats, now: () => t, repeatWindowMs: 1_000 });
  assert.equal(await ask(), true);
  assert.equal(await ask(), true);
  assert.equal(await ask(), false, 'the third time: let the stock wipe through');
  assert.equal(await ask(), true, 'not again for this group in the window');
  assert.equal(await ask('972503333333@s.whatsapp.net'), true);
  t = 2_000;
  assert.equal(await ask(), true, 'a new window starts the count anew');
  // one whose devices were found is never counted
  const found = fakeKeys({ 'g@g.us': { '972501111111@s.whatsapp.net': true } });
  const r2 = new Map();
  for (let i = 0; i < 5; i++) {
    found.memory['g@g.us'] = { '972501111111@s.whatsapp.net': true };
    assert.equal(await forgetAsker({ keys: found, group: 'g@g.us', participant: '972501111111@s.whatsapp.net' }, { repeats: r2, now: () => t }), true);
  }
  assert.equal(r2.size, 0);
});

test('breather: a job that waits on WhatsApp does not hold the ones behind it', async () => {
  const breathe = makeBreather({ lanes: 3 });
  let release;
  const stuck = breathe(() => new Promise((resolve) => { release = resolve; }));
  const others = await Promise.all([1, 2, 3, 4, 5].map((n) => breathe(async () => n)));
  assert.deepEqual(others, [1, 2, 3, 4, 5]);
  release('late');
  assert.equal(await stuck, 'late');
});

test('breather: every job runs in the context it was handed over in (Baileys transactions)', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const als = new AsyncLocalStorage();
  const breathe = makeBreather({ lanes: 1, sliceMs: 0 });
  let release;
  const seen = [];
  // the lane is held by a job of context A; the next ones wait in line and start from its lane
  const first = als.run('A', () => breathe(async () => { await new Promise((r) => { release = r; }); seen.push(als.getStore()); }));
  const second = als.run('B', () => breathe(async () => { seen.push(als.getStore()); await null; seen.push(als.getStore()); }));
  const third = breathe(async () => { seen.push(als.getStore()); });
  const fourth = als.run('A', () => breathe(async () => { seen.push(als.getStore()); }));
  await new Promise((r) => setTimeout(r, 5));
  release();
  await Promise.all([first, second, third, fourth]);
  assert.deepEqual(seen, ['A', 'B', 'B', undefined, 'A']);
});

test('key files: a big write goes in slices with a breath between, a small one as it is', async () => {
  const { setInSlices } = await import('../retryMode.js');
  const writes = [];
  const keys = { set: async (data) => { writes.push(JSON.parse(JSON.stringify(data))); } };
  let pauses = 0;
  const pause = async () => { pauses += 1; };
  const small = { session: { a: 1, b: 2 }, 'sender-key-memory': { g: { x: true } } };
  await setInSlices(keys, small, { slice: 5, pause });
  assert.deepEqual(writes, [small]);
  assert.equal(pauses, 0);
  writes.length = 0;
  const big = { session: Object.fromEntries([...Array(11)].map((_, i) => [`s${i}`, i])), 'pre-key': { p1: null } };
  await setInSlices(keys, big, { slice: 5, pause });
  assert.equal(writes.length, 3);
  assert.equal(pauses, 2);
  // every id written once, a removal (null) kept as a removal
  const merged = {};
  for (const w of writes) for (const [cat, items] of Object.entries(w)) Object.assign((merged[cat] = merged[cat] || {}), items);
  assert.deepEqual(merged, big);
});

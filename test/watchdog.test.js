// npm test (node --test test/*.test.js)  — the watchdog's and the router's rules, without WhatsApp.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUTES,
  routeDecision,
  makeLagTracker,
  makeRestartLimiter,
  respawnDelayMs,
  makeEventSeries,
  silenceVerdict,
  heartbeatStale,
  SILENCE_DEFAULTS,
} from '../watchdog.js';

const MIN = 60_000;
const route = (key) => ROUTES.find((r) => r.key === key);

test('lag: short spikes never exit, sustained lag does', () => {
  const t = makeLagTracker({ thresholdMs: 2_000, sustainMs: 60_000 });
  let now = 0;
  for (let i = 0; i < 100; i++) {
    now += 1_000;
    assert.equal(t.sample(now, i % 10 === 0 ? 3_000 : 5).exit, false);
  }
  // 3 s late every ~3 s, for a minute and more.
  let out;
  for (let i = 0; i < 25; i++) { now += 3_000; out = t.sample(now, 2_500); }
  assert.equal(out.exit, true);
  assert.ok(out.aboveForMs >= 60_000);
});

test('lag: one 70 s stall counts as 70 s above the threshold', () => {
  const t = makeLagTracker({ thresholdMs: 2_000, sustainMs: 60_000 });
  const out = t.sample(1_000_000, 70_000);
  assert.equal(out.exit, true);
  assert.equal(out.aboveForMs, 70_000);
});

test('lag: recovery resets the clock', () => {
  const t = makeLagTracker({ thresholdMs: 2_000, sustainMs: 60_000 });
  t.sample(10_000, 50_000);
  assert.equal(t.sample(11_000, 10).aboveForMs, 0);
  assert.equal(t.sample(12_000, 3_000).exit, false);
});

test('limiter: one restart per 5 min, doubling while it keeps failing, reset when healthy', () => {
  const l = makeRestartLimiter({ baseGapMs: 5 * MIN, maxGapMs: 60 * MIN });
  const p = '972500000001';
  assert.equal(l.canRestart(p, 0), true);
  l.noteRestart(p, 0);
  assert.equal(l.canRestart(p, 4 * MIN), false);
  assert.equal(l.canRestart(p, 5 * MIN), true);
  l.noteRestart(p, 5 * MIN); // streak 2 → 10 min
  assert.equal(l.canRestart(p, 14 * MIN), false);
  assert.equal(l.canRestart(p, 15 * MIN), true);
  for (let i = 0; i < 10; i++) l.noteRestart(p, 15 * MIN);
  assert.equal(l.waitMs(p, 15 * MIN), 60 * MIN); // capped
  l.healthy(p);
  l.noteRestart(p, 100 * MIN);
  assert.equal(l.waitMs(p, 100 * MIN), 5 * MIN);
  // Other numbers are not touched.
  assert.equal(l.canRestart('972500000002', 100 * MIN), true);
});

test('respawn delay grows and caps at 60 s', () => {
  assert.equal(respawnDelayMs(1), 2_000);
  assert.equal(respawnDelayMs(2), 4_000);
  assert.equal(respawnDelayMs(5), 32_000);
  assert.equal(respawnDelayMs(50), 60_000);
});

test('event series keeps a running total across process restarts', () => {
  const s = makeEventSeries();
  s.add(0, 0);
  s.add(1 * MIN, 50);
  s.add(2 * MIN, 120);
  s.restarted();
  s.add(3 * MIN, 10); // new process counted 10
  s.add(4 * MIN, 30);
  assert.equal(s.between(0, 4 * MIN), 150);
  assert.equal(s.between(2 * MIN, 4 * MIN), 30);
  // A process count that drops without restarted() is a new process too.
  s.add(5 * MIN, 5);
  assert.equal(s.between(4 * MIN, 5 * MIN), 5);
});

function num(phone, { status = 'connected', purpose = null, socketSince = 0, lastAt = 0, perMin = 0, minutes = 200, now }) {
  const series = makeEventSeries();
  let total = 0;
  for (let m = minutes; m >= 0; m--) {
    const t = now - m * MIN;
    if (t > lastAt && lastAt) { series.add(t, total); continue; }
    total += perMin;
    series.add(t, total);
  }
  return {
    phone,
    series,
    snap: { phone, status, purpose, socketSince, lastInboundEventAt: lastAt, inboundEvents: total },
  };
}

test('silence: a number that went deaf while others hear is restarted', () => {
  const now = 1_000 * MIN;
  const nums = [
    num('A', { now, socketSince: now - 120 * MIN, lastAt: now - 15 * MIN, perMin: 30 }),
    num('B', { now, socketSince: now - 120 * MIN, lastAt: now - 10_000, perMin: 40 }),
  ];
  const v = silenceVerdict('A', nums, now, SILENCE_DEFAULTS);
  assert.equal(v.restart, true, JSON.stringify(v));
  assert.equal(silenceVerdict('B', nums, now, SILENCE_DEFAULTS).restart, false);
});

test('silence: all quiet (night) restarts nobody', () => {
  const now = 1_000 * MIN;
  const nums = [
    num('A', { now, socketSince: now - 300 * MIN, lastAt: now - 15 * MIN, perMin: 30 }),
    num('B', { now, socketSince: now - 300 * MIN, lastAt: now - 14 * MIN, perMin: 30 }),
  ];
  assert.equal(silenceVerdict('A', nums, now, SILENCE_DEFAULTS).reason, 'all_quiet');
});

test('silence: a young socket, a payments number and a usually-quiet number are left alone', () => {
  const now = 1_000 * MIN;
  const busy = num('B', { now, socketSince: now - 120 * MIN, lastAt: now - 1_000, perMin: 40 });
  const young = num('A', { now, socketSince: now - 5 * MIN, lastAt: 0, perMin: 0 });
  assert.equal(silenceVerdict('A', [young, busy], now).reason, 'socket_young');
  const pay = num('P', { now, purpose: 'payments', socketSince: now - 120 * MIN, lastAt: now - 60 * MIN, perMin: 1 });
  assert.equal(silenceVerdict('P', [pay, busy], now).reason, 'not_watched');
  const small = num('S', { now, socketSince: now - 300 * MIN, lastAt: now - 30 * MIN, perMin: 0 });
  assert.equal(silenceVerdict('S', [small, busy], now).reason, 'quiet_number');
  const down = num('D', { now, status: 'connecting', socketSince: now - 120 * MIN, lastAt: now - 60 * MIN, perMin: 30 });
  assert.equal(silenceVerdict('D', [down, busy], now).reason, 'not_watched');
});

test('heartbeat staleness', () => {
  assert.equal(heartbeatStale(0, 1e9), false);
  assert.equal(heartbeatStale(1_000, 50_000, 60_000), false);
  assert.equal(heartbeatStale(1_000, 62_000, 60_000), true);
});

test('routing: the routes answer their own 400 first, then 409 for an unknown number', () => {
  const known = (p) => p === '972500000001';
  const send = route('POST /send');
  assert.deepEqual(routeDecision(send, { body: { jid: 'x', text: 'y' } }, known).reply,
    { code: 400, body: { error: 'jid, text, session required' } });
  assert.deepEqual(routeDecision(send, { body: { session: '972500000001', text: 'y' } }, known).reply,
    { code: 400, body: { error: 'jid, text, session required' } });
  assert.deepEqual(routeDecision(send, { body: { session: '972-500-000-009', jid: 'x', text: 'y' } }, known).reply,
    { code: 409, body: { error: 'session_missing', status: 'not_started' } });
  assert.deepEqual(routeDecision(send, { body: { session: '+972 500 000 001', jid: 'x', text: 'y' } }, known),
    { phone: '972500000001' });

  const groups = route('GET /groups');
  assert.deepEqual(routeDecision(groups, { query: { phone: '972500000001' } }, known), { phone: '972500000001' });
  assert.deepEqual(routeDecision(groups, { query: {} }, known).reply, { code: 400, body: { error: 'session required' } });

  const pic = route('POST /profile-pic');
  assert.deepEqual(routeDecision(pic, { body: { session: '972500000001', phone: 'abc' } }, known).reply,
    { code: 400, body: { error: 'session and phone required' } });

  // /pair starts a number that is not known yet; a logout goes through either way.
  assert.deepEqual(routeDecision(route('POST /pair'), { body: { phoneNumber: '972500000077' } }, known), { phone: '972500000077' });
  assert.deepEqual(routeDecision(route('POST /pair'), { body: {} }, known).reply, { code: 400, body: { error: 'phone required' } });
  assert.deepEqual(routeDecision(route('DELETE /session/:phone'), { params: { phone: '972500000077' }, query: {}, body: {} }, known),
    { phone: '972500000077' });
  assert.deepEqual(routeDecision(route('POST /logout'), { params: {}, query: { session: '972500000078' }, body: {} }, known),
    { phone: '972500000078' });
});

test('every route the bridge had is routed', () => {
  const keys = ROUTES.map((r) => r.key).sort();
  assert.deepEqual(keys, [
    'DELETE /session/:phone', 'GET /groups', 'POST /delete', 'POST /edit', 'POST /logout', 'POST /pair',
    'POST /profile-pic', 'POST /reset', 'POST /reset-peer', 'POST /send', 'POST /send-reply', 'POST /session/:phone/logout',
  ].sort());
});

test('silence: a number that usually hears little is given the time of its own pace', () => {
  const now = 1_000 * MIN;
  const busy = num('B', { now, socketSince: now - 300 * MIN, lastAt: now - 1_000, perMin: 40 });
  // ~3 messages in ten minutes (050-423-3449): ten or fifteen quiet minutes are ordinary for it
  const slow15 = num('S', { now, socketSince: now - 300 * MIN, lastAt: now - 15 * MIN, perMin: 0.3 });
  const v = silenceVerdict('S', [slow15, busy], now, SILENCE_DEFAULTS);
  assert.equal(v.restart, false, JSON.stringify(v));
  assert.equal(v.reason, 'quiet_for_its_pace');
  assert.ok(v.needMs > 40 * MIN && v.needMs <= 60 * MIN, `needs ~50 quiet minutes, said ${Math.round(v.needMs / MIN)}`);
  // …and an hour of nothing is silence for it too
  const slow65 = num('S', { now, socketSince: now - 300 * MIN, lastAt: now - 65 * MIN, perMin: 0.3 });
  assert.equal(silenceVerdict('S', [slow65, busy], now, SILENCE_DEFAULTS).restart, true);
  // a busy number is still caught after the ten minutes
  const deaf = num('A', { now, socketSince: now - 300 * MIN, lastAt: now - 11 * MIN, perMin: 30 });
  const d = silenceVerdict('A', [deaf, busy], now, SILENCE_DEFAULTS);
  assert.equal(d.restart, true, JSON.stringify(d));
  assert.equal(d.needMs, SILENCE_DEFAULTS.silenceMs);
});

// ---- Watchdog and routing rules (2026-11-10) ---------------------------------
// 2026-11-10 ~09:54 UTC: 972587115623 got stuck ("WhatsApp queries time out"),
// its restart re-synced and pinned the one Node process at ~1.2 vCPU for 8
// minutes — and every other number's messages waited behind it (group posts
// from ~50/min to ~2/min, hundreds arrived together at 10:02). Now every number
// runs in its own process (worker.js) and server.js watches them. The rules it
// acts on are here, as pure functions, so they can be tested without WhatsApp
// (test/watchdog.test.js).

const digits = (v) => String(v ?? '').replace(/\D/g, '');

// ---- Routing: which number a request is for --------------------------------
// Each route names the number it is for and what it needs; a request that
// lacks it gets exactly the 400 the route always gave (the route's own check,
// made before the number is even looked up).
const logoutPhone = (req) => digits(req.params?.phone || req.query?.session || req.body?.session || '');
const bodySession = (req) => digits(req.body?.session || '');

export const ROUTES = [
  {
    method: 'POST', path: '/pair', key: 'POST /pair', spawn: true, timeoutMs: 150_000,
    phoneOf: (req) => digits(req.body?.phone || req.body?.session || req.body?.phoneNumber || ''),
    missing: () => null,
    bad: { error: 'phone required' },
  },
  ...['/logout', '/session/:phone/logout', '/reset'].map((p) => ({
    method: 'POST', path: p, key: `POST ${p}`, logout: true, timeoutMs: 30_000,
    phoneOf: logoutPhone, missing: () => null, bad: { error: 'phone required' },
  })),
  {
    method: 'DELETE', path: '/session/:phone', key: 'DELETE /session/:phone', logout: true, timeoutMs: 30_000,
    phoneOf: logoutPhone, missing: () => null, bad: { error: 'phone required' },
  },
  {
    method: 'POST', path: '/send', key: 'POST /send', timeoutMs: 120_000, phoneOf: bodySession,
    missing: (req) => !req.body?.jid || !req.body?.text, bad: { error: 'jid, text, session required' },
  },
  {
    method: 'POST', path: '/delete', key: 'POST /delete', timeoutMs: 60_000, phoneOf: bodySession,
    missing: (req) => !req.body?.jid || !req.body?.id, bad: { error: 'jid, id, session required' },
  },
  {
    method: 'POST', path: '/edit', key: 'POST /edit', timeoutMs: 60_000, phoneOf: bodySession,
    missing: (req) => !req.body?.jid || !req.body?.id || !req.body?.text, bad: { error: 'jid, id, text, session required' },
  },
  {
    method: 'POST', path: '/send-reply', key: 'POST /send-reply', timeoutMs: 120_000, phoneOf: bodySession,
    missing: (req) => !req.body?.jid || !req.body?.text, bad: { error: 'jid, text, session required' },
  },
  {
    method: 'POST', path: '/profile-pic', key: 'POST /profile-pic', timeoutMs: 60_000, phoneOf: bodySession,
    missing: (req) => !digits(req.body?.phone || ''), bad: { error: 'session and phone required' },
  },
  {
    method: 'POST', path: '/reset-peer', key: 'POST /reset-peer', timeoutMs: 120_000, phoneOf: bodySession,
    missing: (req) => !req.body?.jid, bad: { error: 'session and jid required' },
  },
  {
    method: 'GET', path: '/groups', key: 'GET /groups', timeoutMs: 180_000,
    phoneOf: (req) => digits(req.query?.session || req.query?.phone || ''),
    missing: () => null, bad: { error: 'session required' },
  },
];

/**
 * What the HTTP server does with a request, before any number's process is
 * asked: { reply } to answer at once, or { phone } to hand it to that number.
 * `known(phone)` says whether the number has a session (a process).
 */
export function routeDecision(route, req, known) {
  const phone = route.phoneOf(req);
  // The routes' own order: the 400 comes before the session lookup.
  if (!phone || route.missing(req)) return { reply: { code: 400, body: route.bad } };
  if (route.spawn || route.logout) return { phone };
  if (!known(phone)) return { reply: { code: 409, body: { error: 'session_missing', status: 'not_started' } } };
  return { phone };
}

// ---- Event-loop lag ------------------------------------------------------
/**
 * Lag of the process's own event loop, sampled by a timer. "Above the
 * threshold for sustainMs" ends the process (Railway starts it again). A
 * single sample can stand for a long stall: a timer 70 s late means the loop
 * was blocked the whole 70 s.
 */
export function makeLagTracker({ thresholdMs = 2_000, sustainMs = 60_000 } = {}) {
  let aboveSince = 0;
  return {
    /** One sample: `lagMs` measured at `now`. Returns { aboveForMs, exit }. */
    sample(now, lagMs) {
      if (lagMs > thresholdMs) {
        const started = now - lagMs;
        aboveSince = aboveSince ? Math.min(aboveSince, started) : started;
      } else {
        aboveSince = 0;
      }
      const aboveForMs = aboveSince ? now - aboveSince : 0;
      return { aboveForMs, exit: aboveSince > 0 && aboveForMs >= sustainMs };
    },
    reset() { aboveSince = 0; },
  };
}

// ---- Restart backoff per number --------------------------------------------
/**
 * At most one watchdog restart per number per `baseGapMs`; a number restarted
 * again and again without getting better waits twice as long each time, up to
 * `maxGapMs` — no restart storms. `healthy()` (it hears again) starts it over.
 */
export function makeRestartLimiter({ baseGapMs = 5 * 60_000, maxGapMs = 60 * 60_000 } = {}) {
  const byPhone = new Map(); // phone -> { at, streak }
  const gapOf = (streak) => Math.min(maxGapMs, baseGapMs * 2 ** Math.max(0, streak - 1));
  return {
    canRestart(phone, now) {
      const e = byPhone.get(phone);
      if (!e) return true;
      return now - e.at >= gapOf(e.streak);
    },
    /** ms until the next restart is allowed (0 = now). */
    waitMs(phone, now) {
      const e = byPhone.get(phone);
      if (!e) return 0;
      return Math.max(0, gapOf(e.streak) - (now - e.at));
    },
    noteRestart(phone, now) {
      const e = byPhone.get(phone) || { at: 0, streak: 0 };
      byPhone.set(phone, { at: now, streak: e.streak + 1 });
    },
    healthy(phone) {
      const e = byPhone.get(phone);
      if (e) e.streak = 0;
    },
    lastAt(phone) { return byPhone.get(phone)?.at || 0; },
    streak(phone) { return byPhone.get(phone)?.streak || 0; },
    forget(phone) { byPhone.delete(phone); },
  };
}

// ---- Crash respawn delay ----------------------------------------------------
/** A number's process that ended by itself starts again after 2 s, 4 s, … up to 60 s. */
export function respawnDelayMs(recentCrashes) {
  const n = Math.max(1, recentCrashes);
  return Math.min(60_000, 2_000 * 2 ** Math.min(n - 1, 5));
}

// ---- Heard messages, counted over time ---------------------------------------
/**
 * A number's count of heard messages (snapshot.inboundEvents) as samples over
 * time. The count starts at 0 again when the number's process restarts; the
 * series keeps one running total across restarts.
 */
export function makeEventSeries({ keepMs = 3 * 60 * 60_000 } = {}) {
  let cum = 0;
  let lastRaw = null;
  const samples = []; // { t, cum }
  return {
    add(now, raw) {
      const v = Number(raw) || 0;
      if (lastRaw === null || v < lastRaw) cum += lastRaw === null ? 0 : v; // a new process counts from 0
      else cum += v - lastRaw;
      lastRaw = v;
      samples.push({ t: now, cum });
      while (samples.length && now - samples[0].t > keepMs) samples.shift();
    },
    /** The process started again: its next count starts from 0. */
    restarted() { lastRaw = 0; },
    /** Messages heard between `from` and `to`. */
    between(from, to) {
      let a = null;
      let b = null;
      for (const s of samples) {
        if (s.t <= from) a = s; // the last sample at or before `from`
        if (s.t <= to) b = s;
      }
      if (!b) return 0;
      if (!a) a = samples[0];
      return Math.max(0, b.cum - a.cum);
    },
    /** How far back the samples go (ms). */
    spanMs(now) { return samples.length ? now - samples[0].t : 0; },
  };
}

// ---- Silence: a number that hears nothing while others do ------------------------
export const SILENCE_DEFAULTS = {
  silenceMs: 10 * 60_000,
  /** Another number must have heard at least this many in the same minutes. */
  othersMin: 20,
  /** And this number must have heard this many in the hours before (a quiet number is no deaf number). */
  baselineMin: 30,
  baselineMs: 3 * 60 * 60_000,
};

/**
 * Should `phone` be restarted for silence? `nums` holds every number:
 * { phone, snap, series }. Only a station's number (no purpose) that is
 * connected, has had its socket for silenceMs, heard nothing for silenceMs
 * and used to hear (baseline), while another connected station number heard
 * at least othersMin in the same window.
 * Returns { restart: boolean, reason, quietMs, othersHeard }.
 */
export function silenceVerdict(phone, nums, now, cfg = SILENCE_DEFAULTS) {
  const me = nums.find((n) => n.phone === phone);
  const snap = me?.snap;
  if (!snap || snap.status !== 'connected' || snap.purpose) return { restart: false, reason: 'not_watched' };
  if (!(now - (snap.socketSince || now) >= cfg.silenceMs)) return { restart: false, reason: 'socket_young' };
  const quietMs = now - Math.max(snap.lastInboundEventAt || 0, snap.socketSince || 0);
  if (quietMs < cfg.silenceMs) return { restart: false, reason: 'hearing', quietMs };
  const baseline = me.series ? me.series.between(now - cfg.baselineMs, now - cfg.silenceMs) : 0;
  if (baseline < cfg.baselineMin) return { restart: false, reason: 'quiet_number', quietMs, baseline };
  let othersHeard = 0;
  for (const n of nums) {
    if (n.phone === phone || !n.snap || n.snap.status !== 'connected' || n.snap.purpose || !n.series) continue;
    othersHeard = Math.max(othersHeard, n.series.between(now - cfg.silenceMs, now));
  }
  if (othersHeard < cfg.othersMin) return { restart: false, reason: 'all_quiet', quietMs, othersHeard };
  return { restart: true, reason: 'inbound_silence', quietMs, othersHeard, baseline };
}

/** A number's process that has not reported for `timeoutMs` is wedged (its event loop does not run). */
export function heartbeatStale(lastHbAt, now, timeoutMs = 60_000) {
  return !!lastHbAt && now - lastHbAt > timeoutMs;
}

// =============================================================================
// WhatsApp Baileys bridge — Railway server.js (the HTTP server and supervisor)
//
// 2026-11-10 ~09:54 UTC: 972587115623 got stuck, its restart re-synced and
// held the single Node process at ~1.2 vCPU for 8 minutes — and every other
// number's group feed and private messages waited behind it. Since then:
//
//   * every number runs in its OWN process (worker.js → session.js, the
//     session logic as it was): one number's work can no longer starve the
//     others, and one number's crash ends only its own process;
//   * this process is the HTTP server — the same endpoints, request and
//     response shapes, X-Api-Key auth — and hands each request to the process
//     of the number it names (`session` / `phone`);
//   * a watchdog restarts ONE number when its process stops reporting
//     (heartbeat), or when it hears nothing while the other numbers do, with
//     a backoff (at most once per 5 minutes, longer when it keeps happening);
//   * this process ends itself when its own event loop lags (> 2 s for 60 s)
//     so Railway starts the container again.
//
// BRIDGE_ISOLATION=off runs every number inside this process, as before
// (the rollback switch — same endpoints, the watchdog's silence rule still on).
//
// Env vars (unchanged): API_KEY, AUTH_DIR, PORT, WEBHOOK_URL, WEBHOOK_SECRET,
// GROUP_FEED_WEBHOOK_URL, GROUP_FEED_WEBHOOK_SECRET, CHAT_SYNC_WEBHOOK_URL,
// PAYMENT_PROOF_WEBHOOK_URL, WA_ALLOW_LID_SEND, LOG_LEVEL, BAILEYS_LOG_LEVEL.
// New (all optional): BRIDGE_ISOLATION, WATCHDOG_WEBHOOK_URL,
// WATCHDOG_RESTART_GAP_MIN, WATCHDOG_SILENCE_MIN, WATCHDOG_SILENCE_OTHERS_MIN,
// WATCHDOG_HEARTBEAT_TIMEOUT_SEC, WATCHDOG_LAG_MS, WATCHDOG_LAG_SUSTAIN_SEC,
// WATCHDOG_SILENCE_OFF.
// =============================================================================

import express from 'express';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';
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
} from './watchdog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || '';
const AUTH_ROOT = process.env.AUTH_DIR || '/data';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const GROUP_FEED_WEBHOOK_URL = process.env.GROUP_FEED_WEBHOOK_URL || '';
const GROUP_FEED_WEBHOOK_SECRET = process.env.GROUP_FEED_WEBHOOK_SECRET || '';
const PAYMENT_PROOF_URL = process.env.PAYMENT_PROOF_WEBHOOK_URL
  || (WEBHOOK_URL.includes('whatsapp-private-reply-webhook')
    ? WEBHOOK_URL.replace('whatsapp-private-reply-webhook', 'whatsapp-payment-proof-inbound')
    : '');
const ISOLATED = String(process.env.BRIDGE_ISOLATION || 'on').toLowerCase() !== 'off';
// Where the watchdog's actions are reported to the app: the whatsapp-bridge-watchdog
// function (app logs + a push to the admins), found next to the private webhook as the
// payment-proof one is; WATCHDOG_WEBHOOK_URL overrides.
const WATCHDOG_WEBHOOK_URL = process.env.WATCHDOG_WEBHOOK_URL
  || (WEBHOOK_URL.includes('whatsapp-private-reply-webhook')
    ? WEBHOOK_URL.replace('whatsapp-private-reply-webhook', 'whatsapp-bridge-watchdog')
    : '');

const numEnv = (name, def) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
};
const WD = {
  restartGapMs: numEnv('WATCHDOG_RESTART_GAP_MIN', 5) * 60_000,
  heartbeatTimeoutMs: numEnv('WATCHDOG_HEARTBEAT_TIMEOUT_SEC', 60) * 1000,
  lagMs: numEnv('WATCHDOG_LAG_MS', 2_000),
  lagSustainMs: numEnv('WATCHDOG_LAG_SUSTAIN_SEC', 60) * 1000,
  silenceOff: String(process.env.WATCHDOG_SILENCE_OFF || '').toLowerCase() === 'true',
  silence: {
    ...SILENCE_DEFAULTS,
    silenceMs: numEnv('WATCHDOG_SILENCE_MIN', SILENCE_DEFAULTS.silenceMs / 60_000) * 60_000,
    othersMin: numEnv('WATCHDOG_SILENCE_OTHERS_MIN', SILENCE_DEFAULTS.othersMin),
  },
  tickMs: 15_000,
};

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// ---------------------------------------------------------------------------
// Reporting a watchdog action: a log line always, and the app when configured.
// ---------------------------------------------------------------------------
let BRIDGE_BUILD = 'unknown';
let BAILEYS_PKG_VERSION = 'unknown';

async function reportWatchdog(event, fields = {}, level = 'warn') {
  logger[level]({ ...fields }, event);
  if (!WATCHDOG_WEBHOOK_URL) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_000);
  try {
    const resp = await fetch(WATCHDOG_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-region': 'eu-central-1',
        ...(WEBHOOK_SECRET ? { 'x-bridge-secret': WEBHOOK_SECRET } : {}),
      },
      body: JSON.stringify({ source: 'whatsapp-bridge', event, at: new Date().toISOString(), build: BRIDGE_BUILD, ...fields }),
      signal: ctrl.signal,
    });
    if (!resp.ok) logger.warn({ event, status: resp.status }, 'watchdog_report_failed');
  } catch (err) {
    logger.warn({ event, err: err?.message }, 'watchdog_report_failed');
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// The numbers' processes
// ---------------------------------------------------------------------------
/**
 * phone -> {
 *   phone, child, pid, state: 'starting'|'up'|'stopping'|'down',
 *   snap, lastHbAt, lagMs, rss, series, pending: Map(id -> { resolve, timer }),
 *   ready: Promise, exited: Promise|null, crashes: [t], restarts, startedAt,
 *   stopReason, respawnTimer, removed
 * }
 */
const workers = new Map();
const limiter = makeRestartLimiter({ baseGapMs: WD.restartGapMs });
let rpcSeq = 0;

function workerOf(phone) {
  let w = workers.get(phone);
  if (!w) {
    w = {
      phone, child: null, pid: null, state: 'down', snap: null, lastHbAt: 0, lagMs: 0, rss: 0,
      series: makeEventSeries(), pending: new Map(), ready: null, exited: null, crashes: [],
      restarts: 0, startedAt: 0, stopReason: null, respawnTimer: null, removed: false,
    };
    workers.set(phone, w);
  }
  return w;
}

function failPending(w, why) {
  for (const [id, p] of w.pending) {
    clearTimeout(p.timer);
    p.resolve({ code: 500, body: { ok: false, error: why } });
    w.pending.delete(id);
  }
}

/** Starts the number's process (once); resolves when it listens. */
async function startWorker(phone) {
  const w = workerOf(phone);
  w.removed = false;
  if (w.respawnTimer) { clearTimeout(w.respawnTimer); w.respawnTimer = null; }
  if (w.child && w.ready && w.state !== 'stopping') return w.ready;
  // Never two processes on one number's files: the old one has ended first.
  if (w.exited) await w.exited;
  if (w.child && w.ready) return w.ready;

  const child = fork(path.join(__dirname, 'worker.js'), [], {
    env: { ...process.env, BRIDGE_WORKER_PHONE: phone },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  w.child = child;
  w.pid = child.pid;
  w.state = 'starting';
  w.startedAt = Date.now();
  w.lastHbAt = Date.now(); // the heartbeat clock starts with the process
  w.stopReason = null;
  w.series.restarted();
  let resolveExit;
  w.exited = new Promise((r) => { resolveExit = r; });
  let resolveReady;
  let rejectReady;
  w.ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
  w.ready.catch(() => {});
  const readyTimer = setTimeout(() => {
    rejectReady(new Error('worker_start_timeout'));
    logger.error({ phone, pid: child.pid }, 'worker_start_timeout');
    try { child.kill('SIGKILL'); } catch (_) { /* gone */ }
  }, 30_000);

  child.on('message', (m) => {
    if (!m || typeof m !== 'object' || w.child !== child) return;
    if (m.t === 'ready') {
      clearTimeout(readyTimer);
      w.state = 'up';
      w.lastHbAt = Date.now();
      logger.info({ phone, pid: m.pid }, 'worker_ready');
      resolveReady();
    } else if (m.t === 'hb') {
      w.lastHbAt = Date.now();
      w.lagMs = m.lagMs || 0;
      w.rss = m.mem || 0;
      if (m.snap !== undefined) takeSnap(w, m.snap);
      if (w.lagMs > 2_000) logger.warn({ phone, lagMs: w.lagMs }, 'worker_event_loop_lag');
    } else if (m.t === 'state') {
      if (m.snap !== undefined) takeSnap(w, m.snap);
    } else if (m.t === 'rpc_result') {
      if (m.snap !== undefined) takeSnap(w, m.snap);
      const p = w.pending.get(m.id);
      if (p) {
        clearTimeout(p.timer);
        w.pending.delete(m.id);
        p.resolve({ code: m.code, body: m.body });
      }
    } else if (m.t === 'event') {
      if (m.event === 'session_stuck_restart') {
        void reportWatchdog('watchdog_restart_number', { phone, reason: 'query_timeouts', action: 'socket', ...(m.fields || {}) });
      }
    }
  });

  child.on('exit', (code, signal) => {
    clearTimeout(readyTimer);
    rejectReady(new Error('worker_exit'));
    const wasStopping = w.state === 'stopping' || w.removed;
    const reason = w.stopReason;
    w.child = null;
    w.ready = null;
    w.state = 'down';
    failPending(w, reason ? 'worker_restarted' : 'worker_exit');
    resolveExit();
    w.exited = null;
    if (w.removed) { workers.delete(phone); return; }
    if (wasStopping && reason) {
      // A watchdog restart: started again at once.
      void startWorker(phone).catch((err) => logger.error({ phone, err: err?.message }, 'worker_restart_failed'));
      return;
    }
    if (wasStopping) return;
    // Ended by itself (a crash): started again after a pause that grows.
    const now = Date.now();
    w.crashes = w.crashes.filter((t) => now - t < 10 * 60_000);
    w.crashes.push(now);
    const delayMs = respawnDelayMs(w.crashes.length);
    logger.error({ phone, pid: child.pid, code, signal, crashes10m: w.crashes.length, respawnInMs: delayMs }, 'worker_exit');
    w.respawnTimer = setTimeout(() => {
      w.respawnTimer = null;
      if (w.removed || w.child) return;
      void startWorker(phone).catch((err) => logger.error({ phone, err: err?.message }, 'worker_restart_failed'));
    }, delayMs);
  });

  child.on('error', (err) => logger.error({ phone, err: err?.message }, 'worker_error'));
  return w.ready;
}

function takeSnap(w, snap) {
  w.snap = snap;
  if (snap) w.series.add(Date.now(), snap.inboundEvents || 0);
}

/** Ends the number's process (SIGTERM, then SIGKILL after `graceMs`) and waits for it. */
async function stopWorker(w, { reason = null, graceMs = 5_000, remove = false } = {}) {
  if (remove) w.removed = true;
  if (w.respawnTimer) { clearTimeout(w.respawnTimer); w.respawnTimer = null; }
  const child = w.child;
  if (!child) {
    if (remove) workers.delete(w.phone);
    return;
  }
  w.state = 'stopping';
  w.stopReason = reason;
  const exited = w.exited;
  try { child.kill(graceMs > 0 ? 'SIGTERM' : 'SIGKILL'); } catch (_) { /* gone */ }
  const killTimer = graceMs > 0
    ? setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* gone */ } }, graceMs)
    : null;
  await exited;
  if (killTimer) clearTimeout(killTimer);
}

function rpcWorker(w, key, req, timeoutMs) {
  if (!w.child || w.state !== 'up') {
    return Promise.resolve(null);
  }
  const id = ++rpcSeq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      w.pending.delete(id);
      logger.warn({ phone: w.phone, key, timeoutMs }, 'worker_rpc_timeout');
      resolve({ code: 500, body: { ok: false, error: 'worker_timeout' } });
    }, timeoutMs);
    w.pending.set(id, { resolve, timer });
    try {
      w.child.send({ t: 'rpc', id, key, req });
    } catch (err) {
      clearTimeout(timer);
      w.pending.delete(id);
      resolve({ code: 500, body: { ok: false, error: 'worker_unreachable' } });
    }
  });
}

function askRestartSocket(w, reason, timeoutMs = 10_000) {
  if (!w.child || w.state !== 'up') return Promise.resolve(false);
  const id = ++rpcSeq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { w.pending.delete(id); resolve(false); }, timeoutMs);
    w.pending.set(id, { resolve: (r) => resolve(!!r?.body?.ok), timer });
    try { w.child.send({ t: 'restart_socket', id, reason }); } catch (_) { clearTimeout(timer); w.pending.delete(id); resolve(false); }
  });
}

// ---------------------------------------------------------------------------
// The backend the routes talk to: a process per number, or (rollback) this one.
// ---------------------------------------------------------------------------
let local = null; // session.js, when BRIDGE_ISOLATION=off

const backend = {
  /** Has the number a session (a process) at all? */
  known(phone) {
    if (local) return local.sessionPhones().includes(phone);
    const w = workers.get(phone);
    return !!w && !w.removed;
  },
  phones() {
    if (local) return local.sessionPhones();
    return [...workers.values()].filter((w) => !w.removed).map((w) => w.phone);
  },
  /** What /status, /health and /diag say of the number. */
  snap(phone) {
    if (local) return local.snapshotOf(phone);
    const w = workers.get(phone);
    if (!w || w.removed) return null;
    // A process being started again: its number reconnects (as a reconnect did before).
    if (w.state !== 'up' && w.snap) return { ...w.snap, status: 'connecting' };
    return w.snap;
  },
  async call(route, phone, req) {
    const payload = { body: req.body || {}, query: req.query || {}, params: req.params || {} };
    if (local) return local.runRoute(route.key, payload);
    let w = workers.get(phone);
    if (route.spawn) {
      // /pair: the number's process is started (or waited for) first.
      try {
        await startWorker(phone);
      } catch (err) {
        return { code: 500, body: { ok: false, error: err?.message || 'worker_start_failed', stage: 'pair' } };
      }
      w = workers.get(phone);
    }
    if (route.logout) return logoutViaWorker(route, phone, payload);
    if (!w || w.removed) return { code: 409, body: { error: 'session_missing', status: 'not_started' } };
    if (w.state !== 'up') return { code: 409, body: { error: 'session_missing', status: 'connecting' } };
    const out = await rpcWorker(w, route.key, payload, route.timeoutMs);
    return out || { code: 409, body: { error: 'session_missing', status: 'connecting' } };
  },
};

/** The number's own logout runs in its process; then the process ends. */
async function logoutViaWorker(route, phone, payload) {
  const w = workers.get(phone);
  let out = null;
  if (w && w.state === 'up') out = await rpcWorker(w, route.key, payload, route.timeoutMs);
  if (w) await stopWorker(w, { remove: true });
  // Whatever the process managed: the number's files are gone (as before).
  await fs.promises.rm(path.join(AUTH_ROOT, 'auth', phone), { recursive: true, force: true }).catch(() => {});
  await fs.promises.rm(path.join(AUTH_ROOT, 'purpose', `${phone}.txt`), { force: true }).catch(() => {});
  limiter.forget(phone);
  if (out && out.code === 200) return out;
  return { code: 200, body: { ok: true, phone } };
}

// ---------------------------------------------------------------------------
// HTTP layer — the endpoints as they always were.
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '256kb' }));

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (!API_KEY) return next();
  const provided =
    req.header('x-api-key') ||
    req.header('x-api-token') ||
    (req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  if (provided !== API_KEY) return res.status(401).json({ error: 'bad api key' });
  next();
});

app.get('/health', (_req, res) => {
  const phones = backend.phones();
  res.json({
    ok: true,
    sessions: phones,
    // Numbers connected but hearing nothing (SESSION_HEALTH) — digits only.
    deaf: phones.filter((p) => backend.snap(p)?.health?.state === 'deaf'),
    uptimeSec: Math.round(process.uptime()),
  });
});

// Diagnostics — does NOT leak secrets, only reports what's configured.
app.get('/diag', (_req, res) => {
  const sessionsInfo = backend.phones().map((phone) => {
    const s = backend.snap(phone) || {};
    return {
      phone,
      status: s.status ?? 'not_started',
      lastError: s.lastError ?? null,
      lastUpdate: s.lastUpdate ?? null,
      lidMappingCount: s.lidMappingCount ?? 0,
      retrySkipped: s.retrySkipped || {},
    };
  });
  const now = Date.now();
  res.json({
    ok: true,
    bridge_build: BRIDGE_BUILD,
    baileys_pkg_version: BAILEYS_PKG_VERSION,
    webhook_url_configured: !!WEBHOOK_URL,
    webhook_secret_configured: !!WEBHOOK_SECRET,
    group_feed_webhook_url_configured: !!GROUP_FEED_WEBHOOK_URL,
    group_feed_webhook_secret_configured: !!GROUP_FEED_WEBHOOK_SECRET,
    api_key_configured: !!API_KEY,
    auth_root: AUTH_ROOT,
    sessions: sessionsInfo,
    uptimeSec: Math.round(process.uptime()),
    // Since 2026-11-10: a process per number, and the watchdog.
    isolation: ISOLATED ? 'process_per_number' : 'off',
    watchdog_webhook_configured: !!WATCHDOG_WEBHOOK_URL,
    event_loop_lag_ms: lastLagMs,
    workers: local ? [] : [...workers.values()].filter((w) => !w.removed).map((w) => ({
      phone: w.phone,
      pid: w.pid,
      state: w.state,
      upSec: w.startedAt ? Math.round((now - w.startedAt) / 1000) : 0,
      lastHeartbeatAgoSec: w.lastHbAt ? Math.round((now - w.lastHbAt) / 1000) : null,
      lagMs: w.lagMs,
      rssMb: w.rss ? Math.round(w.rss / 1048576) : null,
      watchdogRestarts: w.restarts,
      crashes10m: w.crashes.filter((t) => now - t < 10 * 60_000).length,
      heardLast10m: w.series.between(now - 10 * 60_000, now),
    })),
  });
});

app.get('/status/:phone', (req, res) => {
  const s = backend.snap(req.params.phone);
  if (!s) return res.json({ status: 'not_started', phone: req.params.phone });
  res.json({
    phone: s.phone,
    status: s.status,
    lastError: s.lastError,
    codeExpiresAt: s.codeExpiresAt,
    lastUpdate: s.lastUpdate,
    health: s.health,
  });
});

for (const route of ROUTES) {
  const method = route.method.toLowerCase();
  app[method](route.path, async (req, res) => {
    const d = routeDecision(route, req, (p) => backend.known(p));
    if (d.reply) return res.status(d.reply.code).json(d.reply.body);
    try {
      const out = await backend.call(route, d.phone, req);
      res.status(out.code).json(out.body);
    } catch (e) {
      logger.error({ phone: d.phone, route: route.key, err: e?.message }, 'route_failed');
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
}

// Debug-only: simulate a private inbound message hitting our webhook, without
// involving WhatsApp/Baileys at all. Lets us isolate "is the webhook path
// itself working" from "is Baileys decrypting the driver's message".
// Protected by API_KEY (the global middleware enforces this).
app.post('/debug-forward-inbound', async (req, res) => {
  if (!WEBHOOK_URL) return res.status(500).json({ error: 'WEBHOOK_URL not configured' });
  const stationPhone = String(req.body?.station_phone || '').replace(/\D/g, '');
  const driverPhone = String(req.body?.driver_phone || '').replace(/\D/g, '');
  const text = String(req.body?.text || '');
  if (!stationPhone || !driverPhone || !text) {
    return res.status(400).json({ error: 'station_phone, driver_phone, text required' });
  }
  const payload = {
    station_phone: stationPhone,
    driver_phone: driverPhone,
    text,
    wa_message_id: `debug-${Date.now()}`,
    direction: 'incoming',
  };
  try {
    logger.info({ stationPhone, driverPhone, text }, 'debug_forward_inbound_attempt');
    const resp = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-region': 'eu-central-1',
        ...(WEBHOOK_SECRET ? { 'x-bridge-secret': WEBHOOK_SECRET } : {}),
      },
      body: JSON.stringify(payload),
    });
    const body = await resp.text().catch(() => '');
    logger.info({ status: resp.status, body: body.slice(0, 500) }, 'debug_forward_inbound_result');
    res.json({ ok: resp.ok, status: resp.status, body });
  } catch (e) {
    logger.error({ err: e?.message }, 'debug_forward_inbound failed');
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ---------------------------------------------------------------------------
// Watchdog: one number at a time, never the others.
// ---------------------------------------------------------------------------
async function restartNumber(phone, reason, fields = {}) {
  const now = Date.now();
  if (!limiter.canRestart(phone, now)) return false;
  limiter.noteRestart(phone, now);
  const streak = limiter.streak(phone);
  if (local) {
    // One process: only the socket can be restarted.
    void reportWatchdog('watchdog_restart_number', { phone, reason, action: 'socket', streak, ...fields });
    local.restartSocket(phone, reason);
    return true;
  }
  const w = workers.get(phone);
  if (!w || w.removed) return false;
  w.restarts += 1;
  if (reason === 'inbound_silence') {
    // A socket that hears nothing: a new socket first (the usual reconnect);
    // a process that does not even answer that is started again.
    void reportWatchdog('watchdog_restart_number', { phone, reason, action: 'socket', streak, ...fields });
    const ok = await askRestartSocket(w, reason);
    if (ok) return true;
    reason = `${reason}_no_answer`;
  }
  void reportWatchdog('watchdog_restart_number', { phone, reason, action: 'process', pid: w.pid, streak, ...fields });
  // A process that does not run its event loop cannot end itself: SIGKILL
  // after a short grace (its SIGTERM handler saves what it can).
  await stopWorker(w, { reason, graceMs: 3_000 });
  return true;
}

function watchdogTick() {
  const now = Date.now();
  const nums = backend.phones().map((phone) => ({
    phone,
    snap: backend.snap(phone),
    series: local ? localSeries(phone) : workers.get(phone)?.series,
  }));
  for (const n of nums) {
    const w = local ? null : workers.get(n.phone);
    // 1. A process that stopped reporting: its event loop is wedged.
    if (w && w.state === 'up' && heartbeatStale(w.lastHbAt, now, WD.heartbeatTimeoutMs)) {
      void restartNumber(n.phone, 'no_heartbeat', { silentSec: Math.round((now - w.lastHbAt) / 1000) });
      continue;
    }
    if (w && w.state !== 'up') continue;
    // 2. Hears nothing while another number does.
    if (!WD.silenceOff) {
      const v = silenceVerdict(n.phone, nums, now, WD.silence);
      if (v.restart) {
        void restartNumber(n.phone, 'inbound_silence', {
          quietMin: Math.round(v.quietMs / 60_000), othersHeard: v.othersHeard, baseline: v.baseline,
        });
        continue;
      }
    }
    // Hearing again since the last restart: the backoff starts over.
    const last = limiter.lastAt(n.phone);
    if (last && limiter.streak(n.phone) && (n.snap?.lastInboundEventAt || 0) > last + 60_000) {
      logger.info({ phone: n.phone, streak: limiter.streak(n.phone) }, 'watchdog_number_recovered');
      limiter.healthy(n.phone);
    }
  }
}

// BRIDGE_ISOLATION=off: the heard-message series are kept here.
const localSeriesMap = new Map();
function localSeries(phone) {
  let s = localSeriesMap.get(phone);
  if (!s) { s = makeEventSeries(); localSeriesMap.set(phone, s); }
  return s;
}

// ---------------------------------------------------------------------------
// This process's own event loop: lagging > WATCHDOG_LAG_MS for
// WATCHDOG_LAG_SUSTAIN_SEC → exit, Railway starts the container again.
// ---------------------------------------------------------------------------
const lagTracker = makeLagTracker({ thresholdMs: WD.lagMs, sustainMs: WD.lagSustainMs });
let lastLagMs = 0;
let lagLoggedAt = 0;
let exiting = false;
{
  const everyMs = 1_000;
  let expected = Date.now() + everyMs;
  setInterval(() => {
    const now = Date.now();
    const lag = Math.max(0, now - expected);
    expected = now + everyMs;
    lastLagMs = lag;
    const { aboveForMs, exit } = lagTracker.sample(now, lag);
    if (aboveForMs > 0 && now - lagLoggedAt > 10_000) {
      lagLoggedAt = now;
      logger.warn({ lagMs: lag, aboveForSec: Math.round(aboveForMs / 1000) }, 'event_loop_lag');
    }
    if (exit && !exiting) {
      exiting = true;
      void (async () => {
        await reportWatchdog('watchdog_exit_lag', {
          lagMs: lag, aboveForSec: Math.round(aboveForMs / 1000), thresholdMs: WD.lagMs, sessions: backend.phones(),
        }, 'error');
        await shutdownAll(3_000);
        process.exit(1);
      })();
    }
  }, everyMs);
}

// ---------------------------------------------------------------------------
// Ending: every number's process ends with this one (Railway redeploy/stop).
// ---------------------------------------------------------------------------
async function shutdownAll(graceMs = 5_000) {
  if (local) {
    try { await local.shutdownSessions(); } catch (_) { /* exit anyway */ }
    return;
  }
  await Promise.all([...workers.values()].map((w) => stopWorker(w, { graceMs, remove: true }).catch(() => {})));
}
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (exiting) return;
    exiting = true;
    logger.info({ signal: sig }, 'bridge_shutdown');
    const hard = setTimeout(() => process.exit(0), 9_000);
    hard.unref?.();
    void shutdownAll(5_000).then(() => process.exit(0));
  });
}

// ---------------------------------------------------------------------------
// Boot: listen at once, then every paired number's process (or socket) back.
// ---------------------------------------------------------------------------
async function restoreOnBoot() {
  const baseDir = path.join(AUTH_ROOT, 'auth');
  let entries = [];
  try {
    entries = await fs.promises.readdir(baseDir, { withFileTypes: true });
  } catch (err) {
    logger.info({ baseDir, err: err?.message }, 'no auth dir to restore');
    return;
  }
  const phones = entries.filter((e) => e.isDirectory() && /^\d{6,}$/.test(e.name)).map((e) => e.name);
  logger.info({ count: phones.length, phones }, 'auto-restore start');
  for (const phone of phones) {
    try {
      const raw = await fs.promises.readFile(path.join(baseDir, phone, 'creds.json'), 'utf8').catch(() => null);
      if (!raw) continue;
      const creds = JSON.parse(raw);
      if (!creds?.registered) continue;
      await startWorker(phone);
      // One at a time with a short pause: each process loads Baileys and
      // reconnects — not all at once.
      await new Promise((r) => setTimeout(r, 2_000));
    } catch (err) {
      logger.error({ phone, err: err?.message }, 'auto-restore failed');
    }
  }
}

async function main() {
  if (!ISOLATED) {
    local = await import('./session.js');
    BRIDGE_BUILD = local.BRIDGE_BUILD;
    BAILEYS_PKG_VERSION = local.BAILEYS_PKG_VERSION;
  } else {
    // Read the build marker without loading Baileys into this process.
    try {
      const src = await fs.promises.readFile(path.join(__dirname, 'session.js'), 'utf8');
      BRIDGE_BUILD = /const BRIDGE_BUILD = '([^']+)'/.exec(src)?.[1] || 'unknown';
      const pkg = JSON.parse(await fs.promises.readFile(path.join(__dirname, 'node_modules', 'baileys', 'package.json'), 'utf8'));
      BAILEYS_PKG_VERSION = pkg.version || 'unknown';
    } catch (_) { /* unknown */ }
  }
  setInterval(() => {
    if (local) for (const p of local.sessionPhones()) localSeries(p).add(Date.now(), local.snapshotOf(p)?.inboundEvents || 0);
    try { watchdogTick(); } catch (err) { logger.error({ err: err?.message }, 'watchdog_tick_failed'); }
  }, WD.tickMs);

  app.listen(PORT, () => {
    logger.info(
      {
        port: PORT,
        authRoot: AUTH_ROOT,
        baileys_pkg_version: BAILEYS_PKG_VERSION,
        bridge_build: BRIDGE_BUILD,
        webhook_url_configured: !!WEBHOOK_URL,
        webhook_secret_configured: !!WEBHOOK_SECRET,
        group_feed_webhook_url_configured: !!GROUP_FEED_WEBHOOK_URL,
        group_feed_webhook_secret_configured: !!GROUP_FEED_WEBHOOK_SECRET,
        payment_proof_url_configured: !!PAYMENT_PROOF_URL,
        isolation: ISOLATED ? 'process_per_number' : 'off',
        watchdog_webhook_configured: !!WATCHDOG_WEBHOOK_URL,
      },
      'whatsapp bridge listening'
    );
    if (local) {
      local.loadPurposes()
        .catch((err) => logger.error({ err: err?.message }, 'purposes load failed'))
        .then(() => local.restoreSessionsOnBoot())
        .catch((err) => logger.error({ err: err?.message }, 'restore on boot crashed'));
    } else {
      restoreOnBoot().catch((err) => logger.error({ err: err?.message }, 'restore on boot crashed'));
    }
  });
}

main().catch((err) => {
  logger.error({ err: err?.message }, 'bridge_boot_failed');
  process.exit(1);
});

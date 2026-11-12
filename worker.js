// =============================================================================
// One WhatsApp number's process (2026-11-10).
//
// server.js starts one of these per number (child_process.fork) with
// BRIDGE_WORKER_PHONE set. It runs that number's Baileys socket and all its
// session logic (session.js) — webhooks are sent from here directly — and
// talks to server.js over the IPC channel only:
//
//   server → worker  { t: 'rpc', id, key, req }       one HTTP request
//                    { t: 'retry_mode', mode }         the retry patch's switches
//                    { t: 'restart_socket', reason }   the watchdog's restart
//   worker → server  { t: 'ready', pid }               listening for rpc
//                    { t: 'hb', at, lagMs, snap }      every 5 s (heartbeat)
//                    { t: 'state', snap }              at once, on a status change
//                    { t: 'rpc_result', id, code, body }
//                    { t: 'event', event, fields }     e.g. session_stuck_restart
//
// A number that wedges this process (no heartbeat) is killed and started
// again alone; the other numbers never wait for it.
// =============================================================================

import { monitorEventLoopDelay } from 'perf_hooks';
import {
  runRoute,
  snapshotOf,
  restartSocket,
  setRetryMode,
  restoreSession,
  loadPurposes,
  shutdownSessions,
  onStatusChange,
  onSessionEvent,
  logger,
} from './session.js';

const PHONE = String(process.env.BRIDGE_WORKER_PHONE || '').replace(/\D/g, '');
const HEARTBEAT_MS = 5_000;

if (!PHONE || typeof process.send !== 'function') {
  // Only ever started by server.js.
  console.error('worker.js: started without BRIDGE_WORKER_PHONE / IPC channel');
  process.exit(2);
}

const send = (msg) => {
  try {
    if (process.connected) process.send(msg);
  } catch (_) { /* the supervisor is gone — 'disconnect' ends us */ }
};

// ---- the event loop's own lag, reported with every heartbeat ---------------
const loopDelay = monitorEventLoopDelay({ resolution: 50 });
loopDelay.enable();

setInterval(() => {
  const lagMs = Math.round(loopDelay.max / 1e6);
  loopDelay.reset();
  send({ t: 'hb', at: Date.now(), lagMs, snap: snapshotOf(PHONE), mem: process.memoryUsage().rss });
}, HEARTBEAT_MS);

onStatusChange((phone) => {
  if (phone === PHONE) send({ t: 'state', snap: snapshotOf(PHONE) });
});
onSessionEvent((event, fields) => send({ t: 'event', event, fields }));

process.on('message', async (m) => {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'rpc') {
    let result;
    try {
      result = await runRoute(m.key, m.req || {});
    } catch (e) {
      result = { code: 500, body: { ok: false, error: e?.message || String(e) } };
    }
    send({ t: 'rpc_result', id: m.id, code: result.code, body: result.body, snap: snapshotOf(PHONE) });
    return;
  }
  // The retry patch's mode, switched while running (server.js POST /retry-mode).
  if (m.t === 'retry_mode') {
    setRetryMode(m.mode);
    send({ t: 'state', snap: snapshotOf(PHONE) });
    return;
  }
  if (m.t === 'restart_socket') {
    const done = restartSocket(PHONE, m.reason || 'watchdog');
    send({ t: 'rpc_result', id: m.id, code: 200, body: { ok: done } });
  }
});

// ---- ending: the supervisor said so, or it is gone -------------------------
let ending = false;
async function endProcess(why, code = 0) {
  if (ending) return;
  ending = true;
  logger.info({ phone: PHONE, why }, 'worker_ending');
  const hard = setTimeout(() => process.exit(code), 3_000);
  hard.unref?.();
  try { await shutdownSessions(); } catch (_) { /* exit anyway */ }
  process.exit(code);
}
process.on('SIGTERM', () => { void endProcess('sigterm'); });
process.on('SIGINT', () => { void endProcess('sigint'); });
// The supervisor ended (or crashed): never keep a number's socket without it —
// a new supervisor starts its own process for this number.
process.on('disconnect', () => { void endProcess('supervisor_gone'); });

// ---- boot: listen first, then the number's socket back (as the old boot did) ----
send({ t: 'ready', pid: process.pid });
(async () => {
  try {
    await loadPurposes();
  } catch (err) {
    logger.error({ phone: PHONE, err: err?.message }, 'purposes load failed');
  }
  try {
    await restoreSession(PHONE);
  } catch (err) {
    logger.error({ phone: PHONE, err: err?.message }, 'auto-restore failed');
  }
  send({ t: 'state', snap: snapshotOf(PHONE) });
})();

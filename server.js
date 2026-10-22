// =============================================================================
// WhatsApp Baileys bridge — Railway server.js
//
// Drop-in replacement for the Express/Baileys server that runs on Railway as
// `amusing-gentleness`. Solves the "the pairing code is invalid" problem on
// WhatsApp by:
//
//   1. Pinning a known-good Baileys version and WhatsApp Web protocol version.
//   2. Using a stock Chrome browser fingerprint (custom names like
//      "Lovable Bridge" make WhatsApp reject the device).
//   3. Waiting for the Baileys socket to become *pairing-ready* before calling
//      `requestPairingCode`, instead of calling it the moment the socket is
//      created.
//   4. Persisting auth via `useMultiFileAuthState` and never wiping it after
//      the code has been generated.
//   5. Exposing precise, monotonic statuses
//      (`not_started` → `connecting` → `pairing_code_ready` → `connected` /
//       `failed` / `logged_out`) and matching `/logout`, `/reset`, and
//      `DELETE /session/:id` endpoints.
//
// Required deps in `package.json`:
//   "@whiskeysockets/baileys": "^6.7.21",
//   "express": "^4.19.2",
//   "pino": "^8.20.0"
//
// Required env vars:
//   API_KEY            — value Lovable Cloud sends in `X-Api-Key`
//   AUTH_DIR           — absolute path to the persistent volume
//                        (defaults to "/data" — match Railway's volume mount).
//   PORT               — provided by Railway.
// =============================================================================

import express from 'express';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  generateMessageIDV2,
  downloadMediaMessage,
} from 'baileys';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Print the actually-installed Baileys version on startup so we can confirm
// after redeploy that Railway picked up the latest npm release.
let BAILEYS_PKG_VERSION = 'unknown';
try {
  BAILEYS_PKG_VERSION = require('baileys/package.json').version || 'unknown';
} catch (_) {
  try { BAILEYS_PKG_VERSION = require('@whiskeysockets/baileys/package.json').version || 'unknown'; } catch (_) {}
}

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || '';
const AUTH_ROOT = process.env.AUTH_DIR || '/data';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
// The app shows a driver's WhatsApp chat ("מי ביקש" → "צ'אט וואטסאפ") and
// is kept in step through this endpoint: every message of a private chat,
// in both directions, and the state of sent messages. By default it sits
// next to the private-reply webhook and takes the same secret.
const CHAT_SYNC_URL = process.env.CHAT_SYNC_WEBHOOK_URL
  || (WEBHOOK_URL.includes('whatsapp-private-reply-webhook')
    ? WEBHOOK_URL.replace('whatsapp-private-reply-webhook', 'whatsapp-chat-sync')
    : '');
// The payments number (Michael, 2026-10-11): the system's own number that
// drivers send payment screenshots to. A number paired with purpose
// 'payments' is not a station's: every private message to it — an image with
// its file — goes here, and nowhere else. By default it sits next to the
// private-reply webhook and takes the same secret.
const PAYMENT_PROOF_URL = process.env.PAYMENT_PROOF_WEBHOOK_URL
  || (WEBHOOK_URL.includes('whatsapp-private-reply-webhook')
    ? WEBHOOK_URL.replace('whatsapp-private-reply-webhook', 'whatsapp-payment-proof-inbound')
    : '');
// Separate webhook for incoming GROUP messages (user WhatsApp feed).
// When set, every text message received in a @g.us chat is forwarded so
// Lovable Cloud can parse it and surface rides in OpenRides.
const GROUP_FEED_WEBHOOK_URL = process.env.GROUP_FEED_WEBHOOK_URL || '';
const GROUP_FEED_WEBHOOK_SECRET = process.env.GROUP_FEED_WEBHOOK_SECRET || '';

// Lightweight in-memory cache for groupMetadata lookups so we don't hammer
// WhatsApp on every inbound group message. 5 min TTL is plenty — group
// renames are rare.
const groupMetaCache = new Map(); // jid -> { meta, ts }
const GROUP_META_TTL_MS = 5 * 60 * 1000;
async function getCachedGroupMetadata(sock, jid) {
  const e = groupMetaCache.get(jid);
  if (e && Date.now() - e.ts < GROUP_META_TTL_MS) return e.meta;
  try {
    const meta = await sock.groupMetadata(jid);
    groupMetaCache.set(jid, { meta, ts: Date.now() });
    return meta;
  } catch (_) {
    return null;
  }
}
// Build marker so we can confirm Railway picked up the latest server.js.
// Surfaced via /diag and printed once on startup. Bump this string when you
// redeploy a behavioral change so you can read the version straight from
// Railway logs.
const BRIDGE_BUILD = 'stuck-socket-30s-2026-10-22';

/** How old a held private message may be and still be passed on. */
const OFFLINE_PRIVATE_MAX_AGE_MS = 30 * 60_000;

/** A message's own time, in ms (Baileys gives a number or a protobuf Long). */
function messageTimeMs(m) {
  const t = m?.messageTimestamp;
  const sec = t && typeof t === 'object' && typeof t.toNumber === 'function' ? t.toNumber() : Number(t || 0);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0;
}

/** A driver's private message that WhatsApp held and delivered late — recent enough to answer. */
function recentOfflinePrivate(m, now = Date.now()) {
  if (!m || m.key?.fromMe) return false;
  const jid = m.key?.remoteJid || '';
  if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter') || jid.startsWith('status@')) return false;
  const at = messageTimeMs(m);
  return at > 0 && now - at <= OFFLINE_PRIVATE_MAX_AGE_MS;
}
// By default we never send to @lid — it's a known cause of "Waiting for this
// message" on Baileys 6.x. Set WA_ALLOW_LID_SEND=true to opt back in for
// experiments.
const ALLOW_LID_SEND = String(process.env.WA_ALLOW_LID_SEND || '').toLowerCase() === 'true';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
// Quieter logger for Baileys internals so Railway logs don't get flooded
// with raw Signal session payloads (pubKey/privKey/pendingPreKey dumps).
const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'warn' });

// ---------------------------------------------------------------------------
// Session manager
// ---------------------------------------------------------------------------

/**
 * Per-phone session state.
 *
 * status values:
 *   not_started        — no live socket
 *   connecting         — socket created, awaiting `pair-device` readiness
 *   pairing_code_ready — pairing code returned to the client, waiting for user
 *   connected          — successfully paired with WhatsApp
 *   logged_out         — WA forced us out (DisconnectReason.loggedOut / 401)
 *   failed             — terminal error before pairing succeeded
 */
const sessions = new Map();

function authDirFor(phone) {
  return path.join(AUTH_ROOT, 'auth', phone);
}

// What a number is for, when it is not a station's: 'payments' (see
// PAYMENT_PROOF_URL). Told by the app at /pair; forgotten at logout.
const PURPOSES = new Set(['payments']);
const purposes = new Map(); // phone -> purpose
const purposeFile = (phone) => path.join(AUTH_ROOT, 'purpose', `${phone}.txt`);
const purposeOf = (phone) => purposes.get(String(phone)) || null;

async function setPurpose(phone, purpose) {
  const key = String(phone);
  if (purpose && PURPOSES.has(purpose)) {
    purposes.set(key, purpose);
    await fs.promises.mkdir(path.dirname(purposeFile(key)), { recursive: true });
    await fs.promises.writeFile(purposeFile(key), purpose, 'utf8');
  } else {
    purposes.delete(key);
    await fs.promises.rm(purposeFile(key), { force: true }).catch(() => {});
  }
}

async function loadPurposes() {
  const dir = path.join(AUTH_ROOT, 'purpose');
  const files = await fs.promises.readdir(dir).catch(() => []);
  for (const f of files) {
    const m = /^(\d{6,})\.txt$/.exec(f);
    if (!m) continue;
    const purpose = (await fs.promises.readFile(path.join(dir, f), 'utf8').catch(() => '')).trim();
    if (PURPOSES.has(purpose)) purposes.set(m[1], purpose);
  }
  if (purposes.size) logger.info({ purposes: Object.fromEntries(purposes) }, 'number purposes loaded');
}

// ---------------------------------------------------------------------------
// Outgoing message cache (per-phone) — needed for Baileys `getMessage`.
//
// When a recipient (especially iPhone / @lid users) misses our pkmsg, WA sends
// us a "retry receipt". Baileys then calls `getMessage(key)` to re-encrypt and
// resend the original content. If we return undefined, the recipient is stuck
// on "Waiting for this message. This may take a while."
//
// We keep the last ~5000 outgoing messages per phone in memory, and persist
// them to disk so a Railway restart doesn't break in-flight retries.
// ---------------------------------------------------------------------------
const OUTGOING_CACHE_LIMIT = 5000;
const OUTGOING_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const outgoingCache = new Map(); // phone -> Map<msgId, { content, ts }>
const outgoingDirty = new Set(); // phones with unsaved cache changes

// Last-known JID per (phone, peer-phone). When a peer sends us a message via
// @lid, we want to reply via @lid too — replying via @s.whatsapp.net forks
// the Signal session and is a known cause of "Waiting for this message".
const lastInboundJid = new Map(); // `${stationPhone}:${peerPhone}` -> { jid, ts }
const LAST_JID_TTL_MS = 6 * 60 * 60 * 1000; // 6h

function rememberInboundJid(stationPhone, peerPhone, jid) {
  if (!stationPhone || !peerPhone || !jid) return;
  if (jid.endsWith('@g.us') || jid.endsWith('@broadcast')) return;
  lastInboundJid.set(`${stationPhone}:${peerPhone}`, { jid, ts: Date.now() });
}

// Persistent map from a peer's @lid to their real phone number, learned from
// senderPn fields on inbound messages. Lets us recover the real phone even
// when the very next inbound message from the same peer doesn't carry
// senderPn (which is the trigger for "skip inbound: could not resolve real
// phone from JID" we keep seeing in logs).
const lidToPhone = new Map(); // `${stationPhone}:${lid}` -> { phone, ts }
const LID_TO_PHONE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d

function rememberLidPhone(stationPhone, lidJid, phoneDigits) {
  if (!stationPhone || !lidJid || !phoneDigits) return;
  if (!lidJid.endsWith('@lid')) return;
  // Another person's LID is never the station's own number (2026-10-15: a
  // driver's "ת #37Y8" reached the app as sent by the station itself, and the
  // answer went to the station's own chat).
  if (String(phoneDigits).replace(/\D/g, '') === String(stationPhone).replace(/\D/g, '')) return;
  lidToPhone.set(`${stationPhone}:${lidJid}`, { phone: phoneDigits, ts: Date.now() });
}

function lookupLidPhone(stationPhone, lidJid) {
  const e = lidToPhone.get(`${stationPhone}:${lidJid}`);
  if (!e) return null;
  if (Date.now() - e.ts > LID_TO_PHONE_TTL_MS) {
    lidToPhone.delete(`${stationPhone}:${lidJid}`);
    return null;
  }
  return e.phone;
}

// Aggressive multi-field extractor: try EVERY known Baileys field that may
// carry the peer's real phone number (PN). Returns digits only, or '' if none.
// Critical for LID-only chats where m.key.senderPn is missing.
function extractRealPhoneDigits(stationPhone, m) {
  // The peer of a message we RECEIVED is never this number itself; a field
  // that carries our own number (seen 2026-10-15) is skipped, and logged.
  const self = String(stationPhone || '').replace(/\D/g, '');
  const candidates = [
    m?.key?.senderPn,
    m?.senderPn,
    m?.key?.participantPn,
    m?.participantPn,
    m?.key?.remoteJidAlt,
    m?.key?.participantAlt,
    m?.key?.remoteJid,
    m?.participant,
    m?.key?.participant,
  ];
  for (const c of candidates) {
    if (!c || typeof c !== 'string') continue;
    if (c.endsWith('@lid') || c.endsWith('@g.us') || c.endsWith('@broadcast')) continue;
    const head = c.split('@')[0].split(':')[0].replace(/\D/g, '');
    if (self && head === self) {
      logger.warn({ phone: self, field: c, key: m?.key ? Object.keys(m.key) : null, msgId: m?.key?.id }, 'peer_resolved_to_self_skipped');
      continue;
    }
    if (head.length >= 9 && head.length <= 13) return head;
  }
  // Try cached LID -> phone mapping learned from prior senderPn events.
  // A direct chat keys on remoteJid; a GROUP message keys on the participant
  // jid (remoteJid there is the @g.us), which used to be skipped entirely —
  // so a driver replying "ת" from a LID-addressed group never resolved.
  for (const cand of [m?.key?.remoteJid, m?.key?.participant, m?.participant]) {
    if (typeof cand === 'string' && cand.endsWith('@lid')) {
      const cached = lookupLidPhone(stationPhone, cand);
      if (cached && cached !== self) return cached;
    }
  }
  return '';
}

function preferredOutgoingJid(stationPhone, fallbackJid) {
  // fallbackJid may be a bare phone, a phone@s.whatsapp.net, or a group jid.
  if (!fallbackJid) return fallbackJid;
  let jid = String(fallbackJid);
  if (!jid.includes('@')) jid = `${jid.replace(/\D/g, '')}@s.whatsapp.net`;
  if (jid.endsWith('@g.us') || jid.endsWith('@broadcast')) return jid;
  // For private chats: default to @s.whatsapp.net using the real phone.
  // Sending to @lid is a known trigger for "Waiting for this message" on
  // Baileys 6.x, so we deliberately do NOT mirror inbound @lid unless the
  // operator explicitly opts in via WA_ALLOW_LID_SEND.
  const peerPhone = jid.split('@')[0].split(':')[0];
  if (ALLOW_LID_SEND) {
    const entry = lastInboundJid.get(`${stationPhone}:${peerPhone}`);
    if (entry && Date.now() - entry.ts < LAST_JID_TTL_MS) {
      return entry.jid;
    }
  }
  // Force PN form even if the caller passed an @lid by mistake.
  if (jid.endsWith('@lid')) return `${peerPhone}@s.whatsapp.net`;
  return jid;
}

function outgoingCacheFile(phone) {
  return path.join(authDirFor(phone), 'sent-cache.json');
}

function getOutgoingMap(phone) {
  let m = outgoingCache.get(phone);
  if (!m) {
    m = new Map();
    outgoingCache.set(phone, m);
  }
  return m;
}

async function loadOutgoingCache(phone) {
  try {
    const raw = await fs.promises.readFile(outgoingCacheFile(phone), 'utf8');
    const obj = JSON.parse(raw);
    const m = getOutgoingMap(phone);
    const now = Date.now();
    for (const [id, entry] of Object.entries(obj || {})) {
      if (entry?.content && entry?.ts && now - entry.ts < OUTGOING_CACHE_TTL_MS) {
        m.set(id, entry);
      }
    }
    logger.info({ phone, size: m.size }, 'outgoing cache loaded');
  } catch (_) { /* no file yet */ }
}

async function saveOutgoingCache(phone) {
  if (!outgoingDirty.has(phone)) return;
  outgoingDirty.delete(phone);
  const m = outgoingCache.get(phone);
  if (!m) return;
  const obj = {};
  for (const [id, entry] of m.entries()) obj[id] = entry;
  try {
    await fs.promises.mkdir(authDirFor(phone), { recursive: true });
    await fs.promises.writeFile(outgoingCacheFile(phone), JSON.stringify(obj));
  } catch (err) {
    logger.warn({ phone, err: err?.message }, 'outgoing cache save failed');
  }
}

function rememberOutgoing(phone, id, content) {
  if (!id || !content) return;
  const m = getOutgoingMap(phone);
  m.set(id, { content, ts: Date.now() });
  // Evict oldest entries past the limit (Map preserves insertion order).
  while (m.size > OUTGOING_CACHE_LIMIT) {
    const oldestKey = m.keys().next().value;
    m.delete(oldestKey);
  }
  outgoingDirty.add(phone);
  // Debounced persist — fire-and-forget.
  setTimeout(() => { saveOutgoingCache(phone).catch(() => {}); }, 1000);
}

/**
 * Send a text message and guarantee the cache is populated BEFORE the wire
 * call returns — this prevents a race where WhatsApp asks for a retry
 * (`getMessage`) before we had a chance to remember the message body.
 *
 * Generates the message id ourselves with generateMessageIDV2 so we can
 * pre-cache the content and pass the same id to Baileys.
 */
async function sendAndCache(phone, jid, content) {
  const session = sessions.get(phone);
  if (!session?.sock) throw new Error('socket not ready');
  const sock = session.sock;

  const targetJid = preferredOutgoingJid(phone, jid);

  // Build the proto.IMessage Baileys would generate so we can store it under
  // our pre-allocated id. For a plain text message this is a single-field
  // object; longer messages auto-promote to extendedTextMessage server-side
  // but the conversation form is still a valid getMessage return value for
  // text-only retries.
  const protoContent = typeof content?.text === 'string'
    ? (content.text.length > 0 ? { conversation: content.text } : { conversation: '' })
    : null;

  let messageId;
  try {
    messageId = generateMessageIDV2 ? generateMessageIDV2(sock.user?.id) : undefined;
  } catch (_) { messageId = undefined; }

  // Pre-cache so getMessage can find it even if WhatsApp issues a retry
  // before sendMessage resolves.
  if (messageId && protoContent) {
    rememberOutgoing(phone, messageId, protoContent);
  }

  const trySend = async (id) => {
    const sent = await sock.sendMessage(
      targetJid,
      content,
      id ? { messageId: id } : undefined
    );
    const finalId = sent?.key?.id || id || null;
    if (finalId && sent?.message) rememberOutgoing(phone, finalId, sent.message);
    return { sent, finalId };
  };

  try {
    const { finalId } = await trySend(messageId);
    logger.info({ phone, jid: targetJid, msgId: finalId }, 'send_cached');
    return { ok: true, id: finalId, jid: targetJid };
  } catch (err) {
    const msg = String(err?.message || '');
    const looksSessionCorruption =
      /no session|bad.?mac|invalid.?prekey|cipher|prekey|session/i.test(msg);
    logger.warn({ phone, jid: targetJid, msgId: messageId, err: msg, retry: looksSessionCorruption }, 'send_failed');
    if (!looksSessionCorruption) throw err;
    // One-shot session refresh + retry. assertSessions(true) forces a fresh
    // prekey bundle so the next encrypt uses a brand-new Signal session.
    try {
      logger.warn({ phone, jid: targetJid }, 'session_corruption_detected');
      await sock.assertSessions([targetJid], true);
    } catch (e2) {
      logger.error({ phone, jid: targetJid, err: e2?.message }, 'assertSessions failed (pre-retry)');
    }
    let retryId;
    try { retryId = generateMessageIDV2 ? generateMessageIDV2(sock.user?.id) : undefined; } catch (_) { retryId = undefined; }
    if (retryId && protoContent) rememberOutgoing(phone, retryId, protoContent);
    try {
      logger.warn({ phone, jid: targetJid, msgId: retryId }, 'send_retry_attempt');
      const { finalId } = await trySend(retryId);
      logger.info({ phone, jid: targetJid, msgId: finalId }, 'send_retry_success');
      return { ok: true, id: finalId, jid: targetJid, retried: true };
    } catch (err2) {
      logger.error({ phone, jid: targetJid, err: err2?.message }, 'send_retry_failed');
      throw err2;
    }
  }
}

function ensureSession(phone) {
  let s = sessions.get(phone);
  if (!s) {
    s = {
      phone,
      status: 'not_started',
      lastError: null,
      pairingCode: null,
      codeExpiresAt: null,
      sock: null,
      pairingReady: false,
      pairingPromise: null,
      lastUpdate: Date.now(),
    };
    sessions.set(phone, s);
  }
  return s;
}

function setStatus(s, status, extra = {}) {
  s.status = status;
  s.lastUpdate = Date.now();
  Object.assign(s, extra);
  logger.info({ phone: s.phone, status, ...extra }, 'session_status');
}

async function wipeAuth(phone) {
  const dir = authDirFor(phone);
  await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function destroySocket(s) {
  // Forget it FIRST: end() fires its own 'close' — that event must find the
  // socket already stale (ignored), not schedule a second reconnect.
  const old = s.sock;
  s.sock = null;
  s.liveToken = null;
  s.pairingReady = false;
  if (old) {
    try { old.end(undefined); } catch (_) { /* ignore */ }
    try { old.ws?.close?.(); } catch (_) { /* ignore */ }
  }
}

/**
 * The key store of one socket, closed to it once it is no longer the
 * number's socket. Two sockets of one number on the same files (a reconnect
 * while the old one still worked through its queue; a /pair during a
 * reconnect) wrote over each other's Signal keys — WhatsApp then logged the
 * number out ("conflict", 053-3753887 on 2026-10-14) or it stopped reading
 * anything. Reads go through; writes of a stale socket are dropped.
 */
function keysOf(keys, isLive, phone) {
  let dropped = 0;
  return {
    get: (type, ids) => keys.get(type, ids),
    set: async (data) => {
      if (!isLive()) {
        dropped += 1;
        if (dropped === 1 || dropped % 50 === 0) logger.warn({ phone, dropped }, 'stale_socket_key_write_dropped');
        return;
      }
      return keys.set(data);
    },
    ...(typeof keys.clear === 'function' ? { clear: () => (isLive() ? keys.clear() : undefined) } : {}),
  };
}

// ---- Session health (2026-10-15) --------------------------------------------
// A number can stay "connected" and hear nothing: every message fails inside
// Baileys ("transaction failed", "Key used already or never filled", "No
// session found"). Counted here from Baileys' own log lines; a decrypted
// message marks the number alive. /status and /health say 'deaf' when a
// connected number had many failures and no message for 10 minutes.
const SESSION_HEALTH = {
  windowMs: 10 * 60_000,
  deafFailures: 30,
  trouble: /transaction failed|failed to decrypt|Key used already|No session found|timed out waiting for message/,
};

function newHealth() {
  return { since: Date.now(), failures: [], timeouts: [], lastInboundAt: 0, lastPrivateInboundAt: 0, deafLoggedAt: 0, stuckRestartAt: 0 };
}

// ---- A stuck socket (2026-10-22) ---------------------------------------------
// 058-711-5623, 01:16–02:07 IL: a private message waited on a number lookup
// (USync) that WhatsApp never answered — "timed out waiting for message" +
// "USync fetch yielded no results for pending PNs", tried again every minute
// (the query timeout) — and was never acknowledged; WhatsApp held every
// private message behind it, while group posts and keep-alive pings still
// went through, until it ended the stream itself ("Stream Errored (ack)") 50
// minutes later. Then they arrived all at once, as offline ('append').
// Queries now time out after 15 s (was 60 s), and two timeouts within a
// minute end the socket; the usual reconnect builds a new one (same keys, no
// pairing) — about 30 seconds after the number got stuck (Michael: «אחרי 30
// שניות זה אמור לקרות … 30 שניות זה גם הרבה מאוד»). A healthy number has about
// 3 timeouts an hour, never two in a minute.
const QUERY_TIMEOUT_MS = 15_000;
const STUCK_SOCKET = { windowMs: 60_000, timeouts: 2, minGapMs: 60_000 };
const QUERY_TIMEOUT = /timed out waiting for message/;

function stuckOf(h, status, now = Date.now()) {
  if (!h || status !== 'connected') return false;
  const recent = (h.timeouts || []).filter((t) => now - t <= STUCK_SOCKET.windowMs).length;
  return recent >= STUCK_SOCKET.timeouts && now - (h.stuckRestartAt || 0) > STUCK_SOCKET.minGapMs;
}

function noteTrouble(s) {
  const h = s.health;
  if (!h) return;
  const now = Date.now();
  h.failures.push(now);
  while (h.failures.length && now - h.failures[0] > SESSION_HEALTH.windowMs) h.failures.shift();
  if (h.failures.length > 1000) h.failures.splice(0, h.failures.length - 1000);
}

function markInbound(s, isPrivate) {
  if (!s.health) return;
  s.health.lastInboundAt = Date.now();
  if (isPrivate) s.health.lastPrivateInboundAt = s.health.lastInboundAt;
}

function healthOf(s) {
  const h = s.health;
  if (!h) return null;
  const now = Date.now();
  const failures10m = h.failures.filter((t) => now - t <= SESSION_HEALTH.windowMs).length;
  const quietMs = now - Math.max(h.lastInboundAt, h.since);
  const deaf = s.status === 'connected' && failures10m >= SESSION_HEALTH.deafFailures && quietMs > SESSION_HEALTH.windowMs;
  return {
    state: deaf ? 'deaf' : 'ok',
    failures10m,
    lastInboundAt: h.lastInboundAt || null,
    lastPrivateInboundAt: h.lastPrivateInboundAt || null,
  };
}

/** Baileys' logger for one number, counting the lines that mean trouble. */
function healthLogger(base, s) {
  const wrap = (l) => new Proxy(l, {
    get(target, prop) {
      if (prop === 'child') return (...a) => wrap(target.child(...a));
      if (prop === 'info' || prop === 'warn' || prop === 'error' || prop === 'debug' || prop === 'trace') {
        return (...a) => {
          try {
            const msg = a.find((x) => typeof x === 'string') || '';
            if (SESSION_HEALTH.trouble.test(msg)) noteTrouble(s);
            if (QUERY_TIMEOUT.test(msg) && s.health) {
              const now = Date.now();
              s.health.timeouts = (s.health.timeouts || []).filter((t) => now - t <= STUCK_SOCKET.windowMs);
              s.health.timeouts.push(now);
              // Out of the logging call — Baileys is still in the middle of its own work.
              setTimeout(() => restartIfStuck(s), 0);
            }
          } catch (_) { /* never let counting break logging */ }
          return target[prop](...a);
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return wrap(base);
}

/** A stuck socket is ended at once — the usual reconnect builds a new one. */
function restartIfStuck(s) {
  if (!s?.sock || !stuckOf(s.health, s.status)) return;
  s.health.stuckRestartAt = Date.now();
  logger.warn({ phone: s.phone, timeouts: s.health.timeouts.length }, 'session_stuck_restart');
  s.health.timeouts = [];
  try { s.sock.end(new Error('stuck: WhatsApp queries time out')); } catch (err) {
    logger.error({ phone: s.phone, err: err?.message }, 'session_stuck_restart_failed');
  }
}

// Once a minute: a deaf number is said loudly in the log (once per 30 minutes).
setInterval(() => {
  for (const s of sessions.values()) {
    const h = healthOf(s);
    if (h?.state !== 'deaf' || !s.health) continue;
    if (Date.now() - s.health.deafLoggedAt < 30 * 60_000) continue;
    s.health.deafLoggedAt = Date.now();
    logger.error({ phone: s.phone, ...h }, 'session_deaf');
  }
}, 60_000).unref?.();

/**
 * Build a fresh Baileys socket for the phone. Does NOT request the pairing
 * code — that is done by `pair()` once the socket signals readiness.
 */
async function createSocket(phone, { forceReset } = {}) {
  const s = ensureSession(phone);
  // One build at a time per number: a /pair and a reconnect that meet share it.
  if (s.creating && !forceReset) return s.creating;
  const build = buildSocket(s, phone, { forceReset });
  s.creating = build;
  try {
    return await build;
  } finally {
    if (s.creating === build) s.creating = null;
  }
}

async function buildSocket(s, phone, { forceReset } = {}) {
  // A reconnect waiting on its timer is this build now.
  if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
  // Never two sockets on one number's keys.
  await destroySocket(s);
  if (forceReset) {
    await wipeAuth(phone);
    outgoingCache.delete(phone);
  }

  const dir = authDirFor(phone);
  await fs.promises.mkdir(dir, { recursive: true });

  // Lazy-load disk-persisted outgoing cache once per process per phone.
  if (!outgoingCache.has(phone)) {
    await loadOutgoingCache(phone);
  }

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  // Try to fetch the latest WhatsApp Web version with a 10s timeout. If the
  // remote endpoint is unreachable, fall back to a known-good version and log
  // it loudly so we know we're not running the freshest protocol.
  const FALLBACK_WA_VERSION = [2, 3000, 1033893291];
  let version = FALLBACK_WA_VERSION;
  let versionSource = 'fallback';
  let versionError = null;
  try {
    const result = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10_000)),
    ]);
    if (result?.version) {
      version = result.version;
      versionSource = result.isLatest === false ? 'remote-stale' : 'remote';
    }
  } catch (err) {
    versionError = err?.message || String(err);
  }
  logger.info(
    {
      phone,
      wa_web_version: version.join('.'),
      source: versionSource,
      baileys_pkg_version: BAILEYS_PKG_VERSION,
      ...(versionError ? { error: versionError } : {}),
    },
    'wa_version_selected'
  );

  // Is this still the number's socket? Everything this socket does after it
  // was replaced is ignored (keysOf, the event handlers below). The token is
  // set before the socket is built, so its first writes count as live.
  const token = {};
  s.liveToken = token;
  const isLive = () => s.liveToken === token;
  const sock = makeWASocket({
    version,
    logger: healthLogger(baileysLogger.child({ scope: 'baileys', phone }), s),
    printQRInTerminal: false,
    // Stock browser fingerprint — custom names get rejected by WA.
    browser: Browsers.macOS('Chrome'),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(keysOf(state.keys, isLive, phone), baileysLogger),
    },
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: QUERY_TIMEOUT_MS,
    keepAliveIntervalMs: 10_000,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    // Allow history sync so that signal sessions/prekeys arrive promptly after
    // connect — without this, the very first inbound pkmsg from a peer often
    // can't be decrypted and we never see the driver's ride code.
    shouldSyncHistoryMessage: () => true,
    generateHighQualityLinkPreview: false,
    // Critical: when WA asks us to resend (retry receipt), supply the
    // original message content. Without this the recipient sees
    // "Waiting for this message. This may take a while."
    getMessage: async (key) => {
      try {
        const m = outgoingCache.get(phone);
        const entry = m?.get(key?.id);
        if (entry?.content) {
          logger.info({ phone, msgId: key?.id, jid: key?.remoteJid }, 'getMessage_hit');
          return entry.content;
        }
        logger.warn({ phone, msgId: key?.id, jid: key?.remoteJid }, 'getMessage_miss');
      } catch (err) {
        logger.error({ phone, err: err?.message }, 'getMessage error');
      }
      return undefined;
    },
  });

  s.sock = sock;
  s.pairingReady = false;
  // A new socket starts its health anew — but remembers when a stuck one was
  // last ended, so a stuck number is restarted at most once a minute.
  s.health = { ...newHealth(), stuckRestartAt: s.health?.stuckRestartAt || 0 };
  setStatus(s, 'connecting', { lastError: null });

  // Events of a replaced socket are not this number's any more. off() finds
  // the wrapped listener, so Baileys' own waits still unregister.
  const evOn = sock.ev.on.bind(sock.ev);
  const evOff = sock.ev.off.bind(sock.ev);
  const wrappedOf = new WeakMap();
  sock.ev.on = (event, handler) => {
    const wrapped = (...args) => (isLive() ? handler(...args) : undefined);
    wrappedOf.set(handler, wrapped);
    return evOn(event, wrapped);
  };
  sock.ev.off = (event, handler) => evOff(event, wrappedOf.get(handler) || handler);

  sock.ev.on('creds.update', saveCreds);

  // -------------------------------------------------------------------------
  // Forward INCOMING 1:1 messages from drivers to the Lovable Cloud webhook.
  // -------------------------------------------------------------------------
  // Decryption-failure tracker (jid -> {count, ts}) for inbound peers.
  if (!s.inboundDecryptFails) s.inboundDecryptFails = new Map();
  // Debounce uploadPreKeys (max once per 5 minutes per session).
  if (!s.lastPreKeyUploadAt) s.lastPreKeyUploadAt = 0;
  // Track which peers we've already nudged ("we couldn't read your message")
  // so we don't spam them on every retry.
  if (!s.notifiedDecryptFail) s.notifiedDecryptFail = new Map();

  // -------------------------------------------------------------------------
  // Chat sync — reports every message of a PRIVATE chat (what the driver
  // wrote, what this bridge sent, what was typed on the phone itself) and
  // the state of sent messages to the app. It only reports: nothing here
  // answers anybody, and a failure never touches the forwarding below.
  // -------------------------------------------------------------------------
  let chatSyncLastErrorAt = 0;
  async function postChatSync(body, timeoutMs = 8000) {
    if (!CHAT_SYNC_URL) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(CHAT_SYNC_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(WEBHOOK_SECRET ? { 'x-bridge-secret': WEBHOOK_SECRET } : {}),
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    } catch (err) {
      // One line a minute at most — the endpoint may not be deployed yet.
      if (Date.now() - chatSyncLastErrorAt > 60_000) {
        chatSyncLastErrorAt = Date.now();
        logger.warn({ phone, err: err?.message }, 'chat_sync_failed');
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // The message inside its wrappers (disappearing, view-once, captioned document).
  function chatSyncInner(message) {
    return message?.ephemeralMessage?.message
      || message?.viewOnceMessage?.message
      || message?.viewOnceMessageV2?.message
      || message?.documentWithCaptionMessage?.message
      || message;
  }

  // What a message says, the way a chat list would show it.
  function chatSyncText(message) {
    const msg = chatSyncInner(message);
    if (!msg) return '';
    const text = msg.conversation
      || msg.extendedTextMessage?.text
      || msg.imageMessage?.caption
      || msg.videoMessage?.caption
      || msg.documentMessage?.caption
      || '';
    if (text && String(text).trim()) return String(text);
    if (msg.audioMessage) return '🎤 הודעה קולית';
    if (msg.imageMessage) return '📷 תמונה';
    if (msg.videoMessage) return '🎥 סרטון';
    if (msg.documentMessage) return '📄 מסמך';
    if (msg.stickerMessage) return 'סטיקר';
    if (msg.locationMessage || msg.liveLocationMessage) return '📍 מיקום';
    if (msg.contactMessage || msg.contactsArrayMessage) return '👤 איש קשר';
    return '';
  }

  function syncChatMessage(m) {
    if (!CHAT_SYNC_URL || !m?.key?.id || !m.message) return;
    if (purposeOf(phone)) return;
    const jid = m.key.remoteJid || '';
    if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter') || jid.startsWith('status@')) return;
    const text = chatSyncText(m.message);
    if (!text) return;
    const peer = extractRealPhoneDigits(phone, m);
    // No real number behind a LID, or a note to oneself: nothing to report.
    if (!peer || peer === String(phone)) return;
    const fromMe = !!m.key.fromMe;
    const body = {
      kind: 'message',
      station_phone: phone,
      peer_phone: peer,
      from_me: fromMe,
      text: text.slice(0, 4000),
      wa_message_id: m.key.id,
      // Sent through this bridge's API (the system), or typed on the phone.
      via_api: fromMe && !!outgoingCache.get(phone)?.has(m.key.id),
    };
    const audio = chatSyncInner(m.message)?.audioMessage;
    if (!audio) { void postChatSync(body); return; }
    // A voice note goes with its recording, so the app can play it
    // (Michael, 2026-10-08). Without it the words alone still go.
    void (async () => {
      const media = await chatSyncVoice(m, audio);
      await postChatSync(media ? { ...body, media } : body, media ? 30_000 : 8000);
    })();
  }

  // The recording of a voice note, as base64 — null when it cannot be had.
  const VOICE_MAX_BYTES = 8 * 1024 * 1024;
  async function chatSyncVoice(m, audio) {
    const declared = Number(audio?.fileLength || 0);
    if (declared > VOICE_MAX_BYTES) return null;
    try {
      const download = downloadMediaMessage(m, 'buffer', {}, { logger: baileysLogger, reuploadRequest: sock.updateMediaMessage });
      const buffer = await Promise.race([
        download,
        new Promise((_, reject) => setTimeout(() => reject(new Error('voice_download_timeout')), 20_000)),
      ]);
      if (!buffer || !buffer.length || buffer.length > VOICE_MAX_BYTES) return null;
      return {
        kind: 'audio',
        mime: String(audio.mimetype || 'audio/ogg; codecs=opus').slice(0, 100),
        ...(Number.isFinite(Number(audio.seconds)) ? { seconds: Number(audio.seconds) } : {}),
        data_base64: Buffer.from(buffer).toString('base64'),
      };
    } catch (err) {
      logger.warn({ phone, msgId: m?.key?.id, err: err?.message }, 'chat_sync_voice_failed');
      return null;
    }
  }

  // Delivered / read, for a message of ours in a private chat. Reported a
  // moment later, so the message itself is saved in the app by then.
  function syncChatStatus(u) {
    if (!CHAT_SYNC_URL || !u?.key?.fromMe || !u.key.id) return;
    if (purposeOf(phone)) return;
    const jid = u.key.remoteJid || '';
    if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast')) return;
    const ack = u.update?.status;
    const status = ack === 3 ? 'delivered' : (ack === 4 || ack === 5) ? 'read' : null;
    if (!status) return;
    setTimeout(() => {
      void postChatSync({ kind: 'status', station_phone: phone, wa_message_id: u.key.id, status });
    }, 1500);
  }

  // Shared forwarder used by both messages.upsert and messages.update
  // (because retried/re-delivered messages arrive on `update`).
  async function forwardInbound(m) {
    if (!WEBHOOK_URL) return;
    if (purposeOf(phone)) return;
    if (!m || m.key?.fromMe) return;
    const jid = m.key?.remoteJid || '';
    if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast')) return;
    // Status broadcasts come on a separate JID — never forward, never count
    // toward decryption-failure stats. They're a known noise source.
    if (jid === 'status@broadcast' || jid.startsWith('status@')) return;

    // Loud, unconditional log for every PRIVATE inbound message we see, so
    // we can tell the difference between "WhatsApp never delivered it" and
    // "we received it but couldn't decrypt/forward".
    logger.info(
      {
        phone,
        jid,
        msgId: m.key?.id,
        senderPn: m.key?.senderPn || null,
        addressingMode: m.key?.addressingMode || null,
        hasMessage: !!m.message,
        stub: m.messageStubType || null,
      },
      'private_inbound_raw_received'
    );

    // ---- Decryption-failure detection -----------------------------------
    // Baileys signals an undecryptable message via messageStubType=2
    // (CIPHERTEXT) or by setting message=null while key/messageTimestamp
    // exist. In both cases, no plaintext is available — auto-recover by
    // forcing a fresh Signal session for that peer.
    const stub = m.messageStubType;
    const isCiphertextFail = stub === 2 || (m && !m.message && m.key?.id);
    if (isCiphertextFail) {
      logger.warn(
        {
          phone,
          jid,
          msgId: m.key?.id,
          stub,
          addressingMode: m.key?.addressingMode || null,
          senderPn: m.key?.senderPn || null,
        },
        'decryption_failed'
      );
      const now = Date.now();
      const cur = s.inboundDecryptFails.get(jid) || { count: 0, ts: now };
      if (now - cur.ts > 60_000) { cur.count = 0; cur.ts = now; }
      cur.count += 1;
      s.inboundDecryptFails.set(jid, cur);
      if (cur.count >= 1) {
        // Try to rebuild BOTH the @lid jid and the matching @s.whatsapp.net
        // jid (if we know the real phone via senderPn). WhatsApp's LID
        // migration means the same logical peer can hold two distinct
        // Signal sessions, and rebuilding only one leaves the other
        // poisoned — which keeps decryption broken on retries.
        const targets = new Set([jid]);
        const senderPn = m.key?.senderPn || m.senderPn || '';
        if (typeof senderPn === 'string' && senderPn.includes('@')) {
          const pnDigits = senderPn.split('@')[0].split(':')[0].replace(/\D/g, '');
          if (pnDigits.length >= 9) {
            targets.add(`${pnDigits}@s.whatsapp.net`);
            // Remember this LID↔PN mapping so future inbound messages from
            // the same @lid that arrive without senderPn can still resolve.
            if (jid.endsWith('@lid')) rememberLidPhone(phone, jid, pnDigits);
          }
        }
        // No "repairs" of our own here (2026-10-15). Forcing new sessions,
        // uploading prekeys every few minutes and wiping sessions fought
        // Baileys' own recovery (it already sends the retry receipt with
        // fresh keys, counted per message): the prekeys WhatsApp handed out
        // drifted away from the ones kept on disk, and from then on every new
        // sender failed with "Key used already or never filled" — the
        // number stayed "connected" and heard nothing. See SESSION_HEALTH.
        // After N failures: send the driver a courtesy message so they know
        // to resend AND so our outbound encrypt resets the ratchet on their
        // side. Throttled to once per hour per peer.
        if (cur.count >= 2) {
          const senderPnRaw = m.key?.senderPn || m.senderPn || '';
          let pnDigits = '';
          if (typeof senderPnRaw === 'string' && senderPnRaw.includes('@')) {
            pnDigits = senderPnRaw.split('@')[0].split(':')[0].replace(/\D/g, '');
          } else if (jid.endsWith('@s.whatsapp.net')) {
            pnDigits = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
          } else {
            const cached = lookupLidPhone(phone, jid);
            if (cached) pnDigits = cached;
          }
          if (pnDigits && pnDigits.length >= 9) {
            const lastNotice = s.notifiedDecryptFail.get(pnDigits) || 0;
            if (now - lastNotice > 60 * 60_000) {
              s.notifiedDecryptFail.set(pnDigits, now);
              try {
                const targetForSend = jid.endsWith('@lid')
                  ? jid
                  : `${pnDigits}@s.whatsapp.net`;
                await sendAndCache(phone, targetForSend, {
                  text: '📵 לא הצלחנו לקרוא את ההודעה האחרונה שלך עקב תקלת הצפנה זמנית. אנא שלח שוב את קוד הנסיעה. תודה!',
                });
                logger.warn({ phone, driver_phone: pnDigits }, 'decryption_notice_sent_to_driver');
              } catch (err) {
                logger.error({ phone, driver_phone: pnDigits, err: err?.message }, 'decryption_notice_send_failed');
              }
            }
            // Notify the dispatcher app via webhook even though we have no
            // plaintext — at least they'll see "someone tried to reach you".
            try {
              await fetch(WEBHOOK_URL, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(WEBHOOK_SECRET ? { 'x-bridge-secret': WEBHOOK_SECRET } : {}),
                },
                body: JSON.stringify({
                  station_phone: phone,
                  driver_phone: pnDigits,
                  text: '[הודעה לא פוענחה]',
                  wa_message_id: m.key?.id || null,
                  direction: 'incoming',
                  decryption_failed: true,
                }),
              });
              logger.warn({ phone, driver_phone: pnDigits }, 'decryption_notice_forwarded_to_app');
            } catch (err) {
              logger.error({ phone, err: err?.message }, 'decryption_notice_forward_failed');
            }
          }
        }
        // The retry request is Baileys' own (one per message, counted) — a
        // second one from here, with keys forced in, spent prekeys twice.
        if (cur.count >= 3) s.inboundDecryptFails.delete(jid);
      }
      return;
    }

    if (!m.message) return;
    const msg = m.message;
    const text =
      msg.conversation ||
      msg.extendedTextMessage?.text ||
      msg.imageMessage?.caption ||
      msg.videoMessage?.caption ||
      '';
    if (!text || !String(text).trim()) return;

    // Successful decrypt — clear failure counter for this peer.
    s.inboundDecryptFails.delete(jid);
    markInbound(s, true);

    // The message the driver quoted, if any. A private "ת" on a swipe-reply
    // of the ride's post names the ride without a code — the webhook reads
    // quoted_text to find it.
    const quotedCtx =
      msg.extendedTextMessage?.contextInfo ||
      msg.imageMessage?.contextInfo ||
      msg.videoMessage?.contextInfo ||
      null;
    const quotedMsg = quotedCtx?.quotedMessage || null;
    const quotedText = quotedMsg
      ? (quotedMsg.conversation ||
         quotedMsg.extendedTextMessage?.text ||
         quotedMsg.imageMessage?.caption ||
         quotedMsg.videoMessage?.caption ||
         null)
      : null;
    const quoted = quotedText
      ? { quoted_text: String(quotedText).slice(0, 4000), quoted_wa_message_id: quotedCtx?.stanzaId || null }
      : {};

        // WhatsApp often returns @lid (linked-id) instead of @s.whatsapp.net.
        // Try EVERY known Baileys field for the real phone (PN).
        let digits = extractRealPhoneDigits(phone, m);
        // Nothing on the message itself: WhatsApp's own map of LIDs to
        // numbers (Baileys 7 LIDMappingStore) — never our own number.
        if (!digits && jid.endsWith('@lid')) {
          try {
            const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(jid);
            const pnDigits = String(pn || '').split('@')[0].split(':')[0].replace(/\D/g, '');
            if (pnDigits && pnDigits !== phone) {
              digits = pnDigits;
              logger.info({ phone, jid, driver_phone: digits }, 'lid_resolved_by_mapping');
            }
          } catch (err) {
            logger.warn({ phone, jid, err: err?.message }, 'lid_mapping_lookup_failed');
          }
        }
        const looksLikePhone =
          digits.length >= 9 && digits.length <= 13 &&
          (digits.startsWith('972') || digits.startsWith('0') || digits.length <= 11);

        // No phone resolvable from the JID — but we still have plaintext.
        // Forward to webhook as a LID-only request so the dispatcher at least
        // sees that a driver tried to take the ride.
        if (!looksLikePhone) {
          logger.warn(
            {
              phone,
              jid,
              senderPn: m.key?.senderPn || null,
              participantPn: m.key?.participantPn || null,
              remoteJidAlt: m.key?.remoteJidAlt || null,
              participantAlt: m.key?.participantAlt || null,
              keyFields: m.key ? Object.keys(m.key) : null,
              msgId: m.key?.id,
              text: String(text).slice(0, 200),
            },
            'lid_phone_resolution_failed'
          );
          if (WEBHOOK_URL) {
            try {
              const resp = await fetch(WEBHOOK_URL, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(WEBHOOK_SECRET ? { 'x-bridge-secret': WEBHOOK_SECRET } : {}),
                },
                body: JSON.stringify({
                  station_phone: phone,
                  driver_lid: jid,
                  text: String(text),
                  wa_message_id: m.key?.id || null,
                  direction: 'incoming',
                  ...quoted,
                }),
              });
              const respText = await resp.text().catch(() => '');
              logger.info(
                { phone, jid, msgId: m.key?.id, status: resp.status, body: respText.slice(0, 300) },
                'lid_only_forwarded'
              );
            } catch (err) {
              logger.error({ phone, err: err?.message }, 'lid_only_forward_failed');
            }
          }
          return;
        }
        // If we DID resolve a real phone alongside an @lid jid, persist the
        // mapping for future messages that may not carry senderPn.
        if (jid.endsWith('@lid') && digits) rememberLidPhone(phone, jid, digits);
        // Remember which JID flavor (@lid vs @s.whatsapp.net) this peer used,
        // so we can reply via the same JID and avoid forking the Signal session.
        rememberInboundJid(phone, digits, jid);
        const payload = {
          station_phone: phone,
          driver_phone: digits,
          text: String(text),
          wa_message_id: m.key?.id || null,
          direction: 'incoming',
          ...quoted,
        };
        try {
          logger.info({ phone, jid, driver_phone: digits, msgId: m.key?.id }, 'webhook_forward_attempt');
          const resp = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(WEBHOOK_SECRET ? { 'x-bridge-secret': WEBHOOK_SECRET } : {}),
            },
            body: JSON.stringify(payload),
          });
          const respText = await resp.text().catch(() => '');
          logger.info(
            { phone, jid, driver_phone: digits, status: resp.status, body: respText.slice(0, 300) },
            'webhook_forward_result'
          );
        } catch (err) {
          logger.error({ phone, err: err?.message }, 'webhook forward failed');
        }
  }

  // A private message to the payments number: its words, and an image with
  // its file (a payment screenshot), to PAYMENT_PROOF_URL.
  const PROOF_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
  async function forwardPaymentInbound(m) {
    if (!PAYMENT_PROOF_URL || !m?.key?.id || !m.message || m.key.fromMe) return;
    const jid = m.key.remoteJid || '';
    if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter') || jid.startsWith('status@')) return;
    const inner = chatSyncInner(m.message);
    const doc = inner?.documentMessage;
    const image = inner?.imageMessage || (doc && /^image\//.test(String(doc.mimetype || '')) ? doc : null);
    const text = inner?.conversation || inner?.extendedTextMessage?.text || image?.caption || '';
    if (!image && !String(text).trim()) return;
    const peer = extractRealPhoneDigits(phone, m);
    const body = {
      session_phone: phone,
      ...(peer ? { sender_phone: peer } : { sender_lid: jid }),
      wa_message_id: m.key.id,
      text: String(text || '').slice(0, 4000),
    };
    let media = null;
    if (image && !(Number(image.fileLength || 0) > PROOF_IMAGE_MAX_BYTES)) {
      try {
        const buffer = await Promise.race([
          downloadMediaMessage(m, 'buffer', {}, { logger: baileysLogger, reuploadRequest: sock.updateMediaMessage }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('image_download_timeout')), 20_000)),
        ]);
        if (buffer && buffer.length && buffer.length <= PROOF_IMAGE_MAX_BYTES) {
          media = {
            kind: 'image',
            mime: String(image.mimetype || 'image/jpeg').slice(0, 100),
            data_base64: Buffer.from(buffer).toString('base64'),
          };
        }
      } catch (err) {
        logger.warn({ phone, msgId: m.key.id, err: err?.message }, 'payment_image_download_failed');
      }
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), media ? 60_000 : 15_000);
    try {
      const resp = await fetch(PAYMENT_PROOF_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(WEBHOOK_SECRET ? { 'x-bridge-secret': WEBHOOK_SECRET } : {}),
        },
        body: JSON.stringify(media ? { ...body, media } : body),
        signal: ctrl.signal,
      });
      logger.info({ phone, msgId: m.key.id, status: resp.status, image: !!media }, 'payment_inbound_forwarded');
    } catch (err) {
      logger.error({ phone, msgId: m.key.id, err: err?.message }, 'payment_inbound_forward_failed');
    } finally {
      clearTimeout(timer);
    }
  }

  sock.ev.on('messages.upsert', async (ev) => {
    if (purposeOf(phone) === 'payments') {
      if (ev.type !== 'notify') return;
      for (const m of ev.messages || []) {
        try {
          await forwardPaymentInbound(m);
        } catch (err) {
          logger.error({ phone, err: err?.message }, 'payment_inbound handler error');
        }
      }
      return;
    }
    // The chat sync also sees 'append': what this bridge itself sent.
    if (ev.type === 'notify' || ev.type === 'append') {
      for (const m of ev.messages || []) {
        // A group post this number sent — from this bridge or from another
        // device or system linked to the same WhatsApp — logged, nothing else,
        // so a publishing pace can be measured (Michael, 2026-10-21).
        try {
          logOwnGroupPost(m, ev.type);
        } catch { /* a log line only */ }
        try {
          syncChatMessage(m);
        } catch (err) {
          logger.error({ phone, err: err?.message }, 'chat_sync handler error');
        }
      }
    }
    // What WhatsApp held while this number was not hearing comes as 'append'
    // (Baileys: node.attrs.offline). A private message of the last 30 minutes
    // is passed on like a live one: "ת #4SAZ" sent at 01:52 reached the number
    // at 02:08 and the bot never answered it (Michael, 2026-10-22). Older
    // ones, and the number's own messages, are not.
    if (ev.type === 'append') {
      for (const m of ev.messages || []) {
        if (!recentOfflinePrivate(m)) continue;
        logger.info({ phone, msgId: m.key?.id, ageSec: Math.round((Date.now() - messageTimeMs(m)) / 1000) }, 'offline_private_forwarded');
        try {
          await forwardInbound(m);
        } catch (err) {
          logger.error({ phone, err: err?.message }, 'offline private forward error');
        }
      }
      return;
    }
    if (ev.type !== 'notify') return;
    for (const m of ev.messages || []) {
      try {
        await forwardInbound(m);
      } catch (err) {
        logger.error({ phone, err: err?.message }, 'messages.upsert handler error');
      }
      try {
        await forwardGroupInbound(m);
      } catch (err) {
        logger.error({ phone, err: err?.message }, 'group_feed forward handler error');
      }
    }
  });

  // -------------------------------------------------------------------------
  // Group-feed forwarder — POSTs incoming @g.us text messages to Lovable
  // Cloud's whatsapp-group-feed-inbound webhook. The webhook parses the
  // text with Hebrew ride heuristics and inserts matches into
  // user_whatsapp_feed_posts (shown in OpenRides).
  // -------------------------------------------------------------------------
  function logOwnGroupPost(m, kind) {
    if (!m?.key?.fromMe) return;
    const jid = m.key.remoteJid || '';
    if (!jid.endsWith('@g.us')) return;
    const msg = m.message || {};
    const text = msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || '';
    logger.info(
      {
        phone,
        jid,
        msgId: m.key.id || null,
        sentAt: Number(m.messageTimestamp) || null,
        kind,
        viaThisBridge: !!(m.key.id && outgoingCache.get(phone)?.has(m.key.id)),
        text: String(text).replace(/\s+/g, ' ').slice(0, 60),
      },
      'group_own_sent',
    );
  }

  async function forwardGroupInbound(m) {
    if (!m || m.key?.fromMe) return;
    if (purposeOf(phone)) return;
    const jid = m.key?.remoteJid || '';
    if (!jid || !jid.endsWith('@g.us')) return;

    // Loud, unconditional log for every GROUP inbound we see, so we can tell
    // the difference between "WhatsApp never delivered it", "we received but
    // couldn't decrypt", and "we received but webhook URL is missing".
    logger.info(
      {
        phone,
        jid,
        msgId: m.key?.id,
        participant: m.key?.participant || m.participant || null,
        senderPn: m.key?.senderPn || null,
        addressingMode: m.key?.addressingMode || null,
        hasMessage: !!m.message,
        stub: m.messageStubType || null,
        group_feed_webhook_configured: !!GROUP_FEED_WEBHOOK_URL,
      },
      'group_feed_raw_received'
    );

    if (!GROUP_FEED_WEBHOOK_URL) return;

    // ---- Group decryption-failure detection -----------------------------
    const stub = m.messageStubType;
    const isCiphertextFail = stub === 2 || (m && !m.message && m.key?.id);
    if (isCiphertextFail) {
      const participant = m.key?.participant || m.participant || '';
      const senderPnRaw = m.key?.senderPn || m.senderPn || '';
      logger.warn(
        {
          phone, jid, msgId: m.key?.id, stub,
          participant: participant || null,
          senderPn: senderPnRaw || null,
          addressingMode: m.key?.addressingMode || null,
        },
        'group_feed_decryption_failed'
      );
      // A group message we could not read is normal in busy groups (a
      // sender key not received yet). Baileys asks the sender again by
      // itself. Forcing sessions with the sender and uploading 30 prekeys
      // every 5 minutes on these (as until 2026-10-15) is what broke the
      // number's keys — see the private path above.
      return;
    }

    if (!m.message) return;
    markInbound(s, false);

    // Extract plain text (conversation / extendedText / image caption).
    const text =
      m.message?.conversation ||
      m.message?.extendedTextMessage?.text ||
      m.message?.imageMessage?.caption ||
      m.message?.videoMessage?.caption ||
      '';
    if (!text || typeof text !== 'string' || !text.trim()) return;

    // Group subject (cached briefly to avoid spamming groupMetadata).
    let groupName = null;
    try {
      const meta = await getCachedGroupMetadata(sock, jid);
      groupName = meta?.subject || null;
    } catch (_) { /* non-fatal */ }

    const participant = m.key?.participant || m.participant || '';
    const realPhone = extractRealPhoneDigits(phone, m);
    // Learn the LID↔PN mapping whenever WhatsApp handed us both, so the next
    // message from the same participant that arrives LID-only still resolves
    // to a real number (group take replies depend on it).
    if (realPhone && participant.endsWith('@lid')) {
      rememberLidPhone(phone, participant, realPhone);
    }
    // Unchanged on purpose: sender_phone is the ride FEED's identity for this
    // poster, not just the take-reply's. Nulling it for @lid participants (an
    // @lid's digits really are an internal id, not a number) would disable the
    // feed's per-sender dedupe in whatsapp-group-feed-inbound and permanently
    // grey out "בקש בפרטי" in OpenRides — and it is not needed: the edge
    // function's take path already recognises LID digits and routes them down
    // the driver_lid path instead of treating them as a phone.
    const senderPhone = realPhone ||
      (participant.split('@')[0] || '').replace(/\D/g, '') || null;

    // Quoted message (driver tags a ride post in the group with "ת"/"ת5"/etc.).
    // The Lovable edge function uses these fields to link the reply to a ride
    // and open a private DM with the driver — same flow as a wa.me click.
    const ctx =
      m.message?.extendedTextMessage?.contextInfo ||
      m.message?.imageMessage?.contextInfo ||
      m.message?.videoMessage?.contextInfo ||
      null;
    const quotedMsg = ctx?.quotedMessage || null;
    const quoted_text = quotedMsg
      ? (quotedMsg.conversation ||
         quotedMsg.extendedTextMessage?.text ||
         quotedMsg.imageMessage?.caption ||
         quotedMsg.videoMessage?.caption ||
         null)
      : null;
    const quoted_wa_message_id = ctx?.stanzaId || null;

    const payload = {
      station_phone: phone, // session phone = end-user's phone
      wa_group_jid: jid,
      group_name: groupName,
      sender_jid: participant || null,
      sender_name: m.pushName || null,
      sender_phone: senderPhone,
      wa_message_id: m.key?.id || null,
      text,
      quoted_text,
      quoted_wa_message_id,
      timestamp: typeof m.messageTimestamp === 'number'
        ? m.messageTimestamp
        : Number(m.messageTimestamp || 0) || undefined,
    };

    try {
      const resp = await fetch(GROUP_FEED_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(GROUP_FEED_WEBHOOK_SECRET ? { 'X-Webhook-Secret': GROUP_FEED_WEBHOOK_SECRET } : {}),
        },
        body: JSON.stringify(payload),
      });
      const respText = await resp.text().catch(() => '');
      logger.info(
        { phone, jid, msgId: m.key?.id, status: resp.status, body: respText.slice(0, 200) },
        'group_feed_forward_result',
      );
    } catch (err) {
      logger.error({ phone, jid, err: err?.message }, 'group_feed forward failed');
    }
  }

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, isNewLogin, qr } = u;

    // The official Baileys docs say the correct moment to request a pairing
    // code is when the `qr` field is emitted on `connection.update` and
    // `creds.registered` is false. Calling it earlier (e.g. on `connecting`)
    // races the WA handshake and is the root cause of "428 Connection
    // Terminated" right after the code is issued.
    if (qr && !sock.authState?.creds?.registered) {
      s.pairingReady = true;
    }

    if (connection === 'open' || isNewLogin) {
      setStatus(s, 'connected', { lastError: null, pairingCode: null });
      // Reset reconnect attempt counter on every successful open.
      s.reconnectAttempts = 0;
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const msg = lastDisconnect?.error?.message || 'connection closed';

      if (code === DisconnectReason.loggedOut || code === 401) {
        // WA refused the device. Wipe auth so the next /pair starts clean.
        await wipeAuth(phone);
        setStatus(s, 'logged_out', { lastError: `${code}: ${msg}` });
      } else if (
        s.status === 'connected' ||
        s.status === 'connecting' ||
        // Auto-restored creds — keep retrying instead of bailing to "failed".
        sock.authState?.creds?.registered
      ) {
        // Lost an (already-paired) session — reconnect with bounded backoff
        // instead of a single setTimeout shot. Without this, one transient
        // network blip leaves the session stuck on `connecting` forever and
        // every /send returns 409 session_missing.
        const attempts = (s.reconnectAttempts || 0) + 1;
        s.reconnectAttempts = attempts;
        setStatus(s, 'connecting', { lastError: `${code ?? '?'}: ${msg}` });
        await destroySocket(s);
        if (attempts > 20) {
          // Give up after ~10 minutes of failed retries — surface clearly.
          setStatus(s, 'failed', {
            lastError: `reconnect gave up after ${attempts} attempts: ${msg}`,
          });
          s.reconnectAttempts = 0;
          return;
        }
        // Exponential-ish backoff: 2s, 4s, 8s, 16s, 30s cap.
        const delay = Math.min(30_000, 2_000 * Math.pow(2, Math.min(attempts - 1, 4)));
        logger.warn({ phone, attempts, delayMs: delay, code, msg }, 'reconnect_scheduled');
        s.reconnectTimer = setTimeout(() => {
          s.reconnectTimer = null;
          if (s.sock) return; // a /pair built it meanwhile
          createSocket(phone).catch((err) => {
            logger.error({ phone, err: err?.message }, 'reconnect_createSocket_failed');
          });
        }, delay);
      } else {
        // Half-pair drop (typical 428 Connection Terminated). Surface the
        // exact code/message so the client can show a useful explanation
        // instead of a generic "failed".
        setStatus(s, 'failed', { lastError: `${code ?? '?'}: ${msg}` });
        // Drop the dead socket so the next /pair builds a fresh one
        // instead of reusing a half-closed handle.
        await destroySocket(s);
      }

      s.pairingReady = false;
    }
  });


  // -------------------------------------------------------------------------
  // Self-heal "Waiting for this message" — when WA sends repeated retry
  // receipts for outgoing messages to the same JID, the Signal session is
  // out of sync. Force a fresh prekey fetch via assertSessions(force=true)
  // so the NEXT outgoing message rebuilds the session and unsticks the
  // recipient (existing stuck messages remain stuck — only future ones heal).
  // -------------------------------------------------------------------------
  if (!s.retryCounters) s.retryCounters = new Map(); // jid -> { count, ts }
  sock.ev.on('messages.update', async (updates) => {
    for (const u of updates || []) {
      try {
        syncChatStatus(u);
        // If WA re-delivered a previously failed inbound message after our
        // retry/assertSessions, the update carries a decrypted `message`.
        // Forward it to the webhook just like a fresh upsert.
        if (!u?.key?.fromMe && u?.update?.message) {
          const rebuilt = {
            key: u.key,
            message: u.update.message,
            messageTimestamp: u.update.messageTimestamp,
            pushName: u.update.pushName,
          };
          try {
            await forwardInbound(rebuilt);
          } catch (err) {
            logger.error({ phone, err: err?.message }, 'inbound_update_forward failed');
          }
          try {
            await forwardGroupInbound(rebuilt);
          } catch (err) {
            logger.error({ phone, err: err?.message }, 'group_feed_update_forward failed');
          }
        }

        const stub = u?.update?.messageStubType;
        const isRetry =
          stub === 2 /* CIPHERTEXT */ ||
          u?.update?.status === 0 /* ERROR */ ||
          (u?.update?.messageStubParameters || []).some?.((x) =>
            String(x || '').toLowerCase().includes('retry')
          );
        if (!isRetry) continue;
        const jid = u?.key?.remoteJid;
        if (!jid || jid.endsWith('@g.us')) continue;
        logger.warn({ phone, jid, msgId: u?.key?.id, stub, status: u?.update?.status }, 'retry_detected');
        const now = Date.now();
        const cur = s.retryCounters.get(jid) || { count: 0, ts: now };
        if (now - cur.ts > 60_000) { cur.count = 0; cur.ts = now; }
        cur.count += 1;
        s.retryCounters.set(jid, cur);
        if (cur.count >= 2) {
          logger.warn({ phone, jid, count: cur.count }, 'assertSessions_forced');
          try {
            await sock.assertSessions([jid], true);
          } catch (err) {
            logger.error({ phone, jid, err: err?.message }, 'assertSessions failed');
          }
          s.retryCounters.delete(jid);
        }
      } catch (err) {
        logger.error({ phone, err: err?.message }, 'messages.update handler error');
      }
    }
  });

  // Bad-acks / phash errors arrive as message-receipt.update too. These are
  // strong signals that the recipient could not decrypt — bump the same
  // retry counter so we converge to assertSessions.
  sock.ev.on('message-receipt.update', async (receipts) => {
    for (const r of receipts || []) {
      try {
        const recv = r?.receipt;
        const type = String(recv?.type || '').toLowerCase();
        const jid = r?.key?.remoteJid;
        if (!jid || jid.endsWith('@g.us')) continue;
        const isBad = type === 'retry' || type === 'error' || !!recv?.error || !!recv?.phash;
        if (!isBad) continue;
        logger.warn({ phone, jid, msgId: r?.key?.id, type }, 'bad_ack_detected');
        const now = Date.now();
        const cur = s.retryCounters.get(jid) || { count: 0, ts: now };
        if (now - cur.ts > 60_000) { cur.count = 0; cur.ts = now; }
        cur.count += 1;
        s.retryCounters.set(jid, cur);
        if (cur.count >= 2) {
          try { await sock.assertSessions([jid], true); } catch (_) { /* ignore */ }
          s.retryCounters.delete(jid);
        }
      } catch (err) {
        logger.error({ phone, err: err?.message }, 'message-receipt.update handler error');
      }
    }
  });

  return s;
}

/**
 * Wait until Baileys is ready to accept `requestPairingCode`, then ask for
 * the code. Concurrent callers for the same phone share the same promise.
 */
async function pair(phone, { forceReset } = {}) {
  const s = ensureSession(phone);

  if (s.pairingPromise) return s.pairingPromise;

  s.pairingPromise = (async () => {
    if (!s.sock || forceReset) {
      await createSocket(phone, { forceReset });
    }

    // Already authenticated — short-circuit. The status is the socket's own
    // ('connected' only once WhatsApp opened it).
    if (s.sock?.authState?.creds?.registered) {
      return { alreadyConnected: true, status: s.status === 'connected' ? 'connected' : 'connecting' };
    }

    // Wait up to 15s for the socket to become pairing-ready.
    const deadline = Date.now() + 15_000;
    while (!s.pairingReady && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      if (s.status === 'failed' || s.status === 'logged_out') {
        throw new Error(`socket failed before pairing ready: ${s.lastError}`);
      }
    }
    if (!s.pairingReady) throw new Error('socket never became pairing-ready');

    const code = await s.sock.requestPairingCode(phone);
    if (!code) throw new Error('Baileys returned empty pairing code');

    // WhatsApp pairing codes are valid for ~3 minutes.
    const expiresAt = new Date(Date.now() + 3 * 60_000).toISOString();
    setStatus(s, 'pairing_code_ready', {
      pairingCode: code,
      codeExpiresAt: expiresAt,
      lastError: null,
    });

    return {
      pairingCode: code,
      codeExpiresAt: expiresAt,
      status: 'pairing_code_ready',
    };
  })();

  try {
    return await s.pairingPromise;
  } finally {
    s.pairingPromise = null;
  }
}

// ---------------------------------------------------------------------------
// HTTP layer
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
  res.json({
    ok: true,
    sessions: Array.from(sessions.keys()),
    // Numbers connected but hearing nothing (SESSION_HEALTH) — digits only.
    deaf: Array.from(sessions.values()).filter((s) => healthOf(s)?.state === 'deaf').map((s) => s.phone),
    uptimeSec: Math.round(process.uptime()),
  });
});

// Diagnostics — does NOT leak secrets, only reports what's configured.
// Use this from a browser/curl to verify the bridge can talk to Lovable Cloud.
app.get('/diag', (_req, res) => {
  const sessionsInfo = Array.from(sessions.entries()).map(([phone, s]) => ({
    phone,
    status: s.status,
    lastError: s.lastError,
    lastUpdate: s.lastUpdate,
    lidMappingCount: Array.from(lidToPhone.keys()).filter((k) => k.startsWith(`${phone}:`)).length,
  }));
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
  });
});

app.get('/status/:phone', (req, res) => {
  const s = sessions.get(req.params.phone);
  if (!s) return res.json({ status: 'not_started', phone: req.params.phone });
  res.json({
    phone: s.phone,
    status: s.status,
    lastError: s.lastError,
    codeExpiresAt: s.codeExpiresAt,
    lastUpdate: s.lastUpdate,
    health: healthOf(s),
  });
});

app.post('/pair', async (req, res) => {
  const phone = String(req.body?.phone || req.body?.session || req.body?.phoneNumber || '').replace(/\D/g, '');
  const forceReset = !!req.body?.forceReset;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  // A station's pairing names no purpose — and clears one left from before.
  const purpose = PURPOSES.has(String(req.body?.purpose || '')) ? String(req.body.purpose) : null;
  try {
    await setPurpose(phone, purpose);
    const result = await pair(phone, { forceReset });
    res.json({ ok: true, phone, ...result });
  } catch (e) {
    logger.error({ phone, err: e?.message }, 'pair failed');
    res.status(500).json({ ok: false, error: e?.message || String(e), stage: 'pair' });
  }
});

async function logoutHandler(req, res) {
  const phone = String(req.params.phone || req.query.session || req.body?.session || '').replace(/\D/g, '');
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const s = sessions.get(phone);
  if (s) {
    try { await s.sock?.logout?.(); } catch (_) { /* ignore */ }
    await destroySocket(s);
  }
  await wipeAuth(phone);
  await setPurpose(phone, null);
  sessions.delete(phone);
  res.json({ ok: true, phone });
}

app.post('/logout', logoutHandler);
app.post('/session/:phone/logout', logoutHandler);
app.delete('/session/:phone', logoutHandler);
app.post('/reset', logoutHandler);

app.post('/send', async (req, res) => {
  const { jid, text, session } = req.body || {};
  const phone = String(session || '').replace(/\D/g, '');
  if (!phone || !jid || !text) return res.status(400).json({ error: 'jid, text, session required' });
  const s = sessions.get(phone);
  if (!s || s.status !== 'connected') {
    return res.status(409).json({ error: 'session_missing', status: s?.status ?? 'not_started' });
  }
  try {
    const out = await sendAndCache(phone, String(jid), { text: String(text) });
    res.json({ ok: true, id: out.id, jid: out.jid });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Delete, for everyone, a message this number sent (Michael, 2026-10-20: a ride passed
// on after "מעביר" goes back to the driver who answered late — the details sent to the
// next driver are deleted when he has not answered yet; the app's
// supabase/functions/_shared/lateReclaim.ts).
//
// Body: { session, jid, id }
app.post('/delete', async (req, res) => {
  const { jid, id, session } = req.body || {};
  const phone = String(session || '').replace(/\D/g, '');
  if (!phone || !jid || !id) return res.status(400).json({ error: 'jid, id, session required' });
  const s = sessions.get(phone);
  if (!s || s.status !== 'connected' || !s.sock) {
    return res.status(409).json({ error: 'session_missing', status: s?.status ?? 'not_started' });
  }
  const targetJid = String(jid);
  try {
    await s.sock.sendMessage(targetJid, { delete: { remoteJid: targetJid, fromMe: true, id: String(id) } });
    logger.info({ phone, jid: targetJid, msgId: String(id) }, 'delete_ok');
    res.json({ ok: true });
  } catch (e) {
    logger.error({ phone, jid: targetJid, err: e?.message }, 'delete_failed');
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Send a text message that QUOTES (tags) an existing message — used for
// replying inside a group to a specific feed post.
//
// Body: { session, jid, text, quoted: { id, participant, text } | null }
// When `quoted` is null the call degrades to a plain send.
app.post('/send-reply', async (req, res) => {
  const { jid, text, session, quoted } = req.body || {};
  const phone = String(session || '').replace(/\D/g, '');
  if (!phone || !jid || !text) return res.status(400).json({ error: 'jid, text, session required' });
  const s = sessions.get(phone);
  if (!s || s.status !== 'connected' || !s.sock) {
    return res.status(409).json({ error: 'session_missing', status: s?.status ?? 'not_started' });
  }
  const targetJid = String(jid);
  try {
    if (quoted && quoted.id) {
      const quotedMsg = {
        key: {
          id: String(quoted.id),
          fromMe: false,
          remoteJid: targetJid,
          ...(quoted.participant ? { participant: String(quoted.participant) } : {}),
        },
        message: { conversation: String(quoted.text || '') },
      };
      const sent = await s.sock.sendMessage(
        targetJid,
        { text: String(text) },
        { quoted: quotedMsg },
      );
      const finalId = sent?.key?.id || null;
      if (finalId && sent?.message) rememberOutgoing(phone, finalId, sent.message);
      logger.info({ phone, jid: targetJid, msgId: finalId, quotedId: quoted.id }, 'send_reply_ok');
      return res.json({ ok: true, id: finalId, jid: targetJid });
    }
    // No quote — plain send via cache path.
    const out = await sendAndCache(phone, targetJid, { text: String(text) });
    res.json({ ok: true, id: out.id, jid: out.jid });
  } catch (e) {
    logger.error({ phone, jid: targetJid, err: e?.message }, 'send_reply_failed');
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});


// Force-rebuild the Signal session for a specific peer JID. Use this when
// the recipient is stuck on "Waiting for this message" — assertSessions(true)
// fetches a fresh prekey bundle so the next sendMessage uses a new session.
app.post('/reset-peer', async (req, res) => {
  const { session, jid, text } = req.body || {};
  const phone = String(session || '').replace(/\D/g, '');
  if (!phone || !jid) return res.status(400).json({ error: 'session and jid required' });
  const s = sessions.get(phone);
  if (!s || s.status !== 'connected' || !s.sock) {
    return res.status(409).json({ error: 'session_missing', status: s?.status ?? 'not_started' });
  }
  // For a manual peer reset we deliberately ignore the LID/PN preference and
  // force @s.whatsapp.net — that's the JID flavor the user typed in the UI.
  let targetJid = String(jid);
  if (!targetJid.includes('@')) {
    targetJid = `${targetJid.replace(/\D/g, '')}@s.whatsapp.net`;
  }
  try {
    await s.sock.assertSessions([targetJid], true);
    let sentId = null;
    if (text && String(text).trim()) {
      const out = await sendAndCache(phone, targetJid, { text: String(text) });
      sentId = out.id;
    }
    res.json({ ok: true, jid: targetJid, sentId });
  } catch (e) {
    logger.error({ phone, jid: targetJid, err: e?.message }, 'reset-peer failed');
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// List all WhatsApp groups the connected session participates in.
// Read-only operation — does not mutate any session state.
app.get('/groups', async (req, res) => {
  const phone = String(req.query.session || req.query.phone || '').replace(/\D/g, '');
  if (!phone) return res.status(400).json({ error: 'session required' });
  const s = sessions.get(phone);
  if (!s || s.status !== 'connected' || !s.sock) {
    return res.status(409).json({ error: 'session_missing', status: s?.status ?? 'not_started' });
  }
  try {
    const all = await s.sock.groupFetchAllParticipating();
    const includeParticipants = String(req.query.include || '').includes('participants');
    let totalWithParticipants = 0;
    let sampleParticipantId = null;
    // Digits-only form of the session phone for admin matching below.
    const ownDigits = String(phone).replace(/\D/g, '');
    const groups = Object.values(all || {}).map((g) => {
      const out = {
        jid: g.id,
        name: g.subject || '',
        participants: Array.isArray(g.participants) ? g.participants.length : null,
        size: typeof g.size === 'number'
          ? g.size
          : Array.isArray(g.participants) ? g.participants.length : null,
        announce: !!g.announce,
        isSessionAdmin: false,
      };
      if (Array.isArray(g.participants)) {
        for (const p of g.participants) {
          if (!p || !p.admin) continue; // 'admin' | 'superadmin'
          const raw = [p.id, p.jid, p.phoneNumber, p.phone_number, p.pn, p.lid]
            .filter((x) => typeof x === 'string' && x.length > 0);
          for (const v of raw) {
            const head = v.split('@')[0].split(':')[0].replace(/\D/g, '');
            if (head && head === ownDigits) { out.isSessionAdmin = true; break; }
          }
          if (out.isSessionAdmin) break;
        }
      }
      if (includeParticipants && Array.isArray(g.participants)) {
        // Extract every plausible identifier per participant. Different
        // Baileys versions / LID rollouts populate different fields:
        //   p.id              — JID (phone@s.whatsapp.net or <lid>@lid)
        //   p.jid             — sometimes set instead of id
        //   p.phoneNumber     — explicit PN when LID is in use
        //   p.lid             — explicit LID alongside id=PN
        // We collect digits-only forms of all of them so the caller can match
        // by phone regardless of which field carries the real number.
        const ids = new Set();
        for (const p of g.participants) {
          if (!p) continue;
          const raw = [p.id, p.jid, p.phoneNumber, p.phone_number, p.pn, p.lid]
            .filter((x) => typeof x === 'string' && x.length > 0);
          for (const v of raw) {
            const head = v.split('@')[0].split(':')[0].replace(/\D/g, '');
            if (head) ids.add(head);
          }
        }
        out.participantIds = [...ids];
        if (out.participantIds.length > 0) {
          totalWithParticipants += 1;
          if (!sampleParticipantId) sampleParticipantId = out.participantIds[0];
        }
      }
      return out;
    });
    res.json({
      ok: true,
      build: BRIDGE_BUILD,
      participantsIncluded: includeParticipants,
      totalGroups: groups.length,
      totalWithParticipants,
      sampleParticipantId,
      groups,
    });
  } catch (e) {
    logger.error({ phone, err: e?.message }, 'groups fetch failed');
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

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

app.listen(PORT, () => {
  // (debug endpoint registered above)
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
    },
    'whatsapp bridge listening'
  );
  loadPurposes()
    .catch((err) => logger.error({ err: err?.message }, 'purposes load failed'))
    .then(() => restoreSessionsOnBoot())
    .catch((err) => logger.error({ err: err?.message }, 'restore on boot crashed'));
});

// ---------------------------------------------------------------------------
// Auto-restore: on boot, scan persistent auth dir and re-create sockets for
// any phone that has registered creds. This keeps sessions alive across
// Railway restarts/redeploys without requiring the user to re-pair.
// ---------------------------------------------------------------------------
async function restoreSessionsOnBoot() {
  const baseDir = path.join(AUTH_ROOT, 'auth');
  let entries = [];
  try {
    entries = await fs.promises.readdir(baseDir, { withFileTypes: true });
  } catch (err) {
    logger.info({ baseDir, err: err?.message }, 'no auth dir to restore');
    return;
  }
  const phones = entries
    .filter((e) => e.isDirectory() && /^\d{6,}$/.test(e.name))
    .map((e) => e.name);

  logger.info({ count: phones.length, phones }, 'auto-restore start');

  for (const phone of phones) {
    try {
      const credsPath = path.join(baseDir, phone, 'creds.json');
      const raw = await fs.promises.readFile(credsPath, 'utf8').catch(() => null);
      if (!raw) continue;
      const creds = JSON.parse(raw);
      if (!creds?.registered) continue;
      await createSocket(phone);
      logger.info({ phone }, 'auto-restored session');
    } catch (err) {
      logger.error({ phone, err: err?.message }, 'auto-restore failed');
    }
  }
} 

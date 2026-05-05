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
  if (s.sock) {
    try { s.sock.end(undefined); } catch (_) { /* ignore */ }
    try { s.sock.ws?.close?.(); } catch (_) { /* ignore */ }
  }
  s.sock = null;
  s.pairingReady = false;
}

/**
 * Build a fresh Baileys socket for the phone. Does NOT request the pairing
 * code — that is done by `pair()` once the socket signals readiness.
 */
async function createSocket(phone, { forceReset } = {}) {
  const s = ensureSession(phone);

  if (forceReset) {
    await destroySocket(s);
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

  const sock = makeWASocket({
    version,
    logger: baileysLogger.child({ scope: 'baileys', phone }),
    printQRInTerminal: false,
    // Stock browser fingerprint — custom names get rejected by WA.
    browser: Browsers.macOS('Chrome'),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
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
  setStatus(s, 'connecting', { lastError: null });

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

  // Shared forwarder used by both messages.upsert and messages.update
  // (because retried/re-delivered messages arrive on `update`).
  async function forwardInbound(m) {
    if (!WEBHOOK_URL) return;
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
        try {
          await sock.assertSessions(Array.from(targets), true);
          logger.warn({ phone, jid, targets: Array.from(targets), count: cur.count }, 'inbound_assertSessions_forced');
        } catch (err) {
          logger.error({ phone, jid, err: err?.message }, 'inbound_assertSessions failed');
        }
        // Try to upload a LARGE batch of fresh prekeys so a follow-up retry
        // from WA can build a new session (PreKeyError "Invalid PreKey ID"
        // recovery). Debounced to once per 5 min per session — calling this
        // on every failed message floods WhatsApp and triggers rate limits.
        try {
          if (typeof sock.uploadPreKeys === 'function' && (now - s.lastPreKeyUploadAt) > 5 * 60_000) {
            await sock.uploadPreKeys(30);
            s.lastPreKeyUploadAt = now;
            logger.warn({ phone, batch: 30 }, 'inbound_uploadPreKeys_done');
          }
        } catch (err) {
          logger.error({ phone, err: err?.message }, 'inbound_uploadPreKeys failed');
        }
        // After 2+ failures from same peer in the window: try to wipe the
        // poisoned Signal session entirely so the next inbound forces a
        // brand-new handshake (this is the only thing that fixes
        // "Invalid PreKey ID" when WA keeps re-using the same dead prekey).
        if (cur.count >= 2) {
          try {
            const wipeKeys = {};
            for (const t of targets) {
              const tDigits = String(t.split('@')[0] || '').replace(/\D/g, '');
              if (!tDigits) continue;
              // Wipe primary device session + a few common device ids.
              wipeKeys[`${tDigits}.0`] = null;
              wipeKeys[`${tDigits}.1`] = null;
              wipeKeys[`${tDigits}.2`] = null;
            }
            if (Object.keys(wipeKeys).length && sock.authState?.keys?.set) {
              await sock.authState.keys.set({ session: wipeKeys });
              logger.warn({ phone, jid, wiped: Object.keys(wipeKeys) }, 'signal_session_wiped');
            }
          } catch (err) {
            logger.error({ phone, jid, err: err?.message }, 'signal_session_wipe_failed');
          }
        }
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
        // Ask WhatsApp to retransmit this exact message. Without this we
        // depend on the driver to manually resend, which never happens —
        // they assume the message was delivered. Bounded to 1 attempt per
        // message id; sendRetryRequest only exists on Baileys 6.7+/7.x.
        try {
          if (typeof sock.sendRetryRequest === 'function') {
            const node = {
              tag: 'message',
              attrs: {
                from: jid,
                id: m.key?.id || '',
                ...(m.key?.participant ? { participant: m.key.participant } : {}),
              },
            };
            await sock.sendRetryRequest(node, true);
            logger.warn({ phone, jid, msgId: m.key?.id }, 'retry_request_sent');
          }
        } catch (err) {
          logger.error({ phone, jid, err: err?.message }, 'retry_request_failed');
        }
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

        // WhatsApp now often returns @lid (linked-id) instead of @s.whatsapp.net.
        // The LID is NOT a phone number — never forward it as driver_phone.
        // Try to recover the real phone number (PN) from Baileys 6.7+ fields.
        let driverPhone = '';
        if (jid.endsWith('@s.whatsapp.net')) {
          driverPhone = jid.split('@')[0].split(':')[0];
        } else if (jid.endsWith('@lid')) {
          const senderPn = m.key?.senderPn || m.senderPn || '';
          if (senderPn && typeof senderPn === 'string' && senderPn.includes('@')) {
            driverPhone = senderPn.split('@')[0].split(':')[0];
          } else {
            // Fallback: maybe we already learned this LID's real phone from
            // a previous decryption-failure event that DID carry senderPn.
            const cached = lookupLidPhone(phone, jid);
            if (cached) driverPhone = cached;
          }
        }
        // Validate: only forward plausible phone numbers (Israeli or international,
        // 9-13 digits, not the 15-digit WhatsApp LID).
        const digits = String(driverPhone || '').replace(/\D/g, '');
        const looksLikePhone =
          digits.length >= 9 && digits.length <= 13 &&
          (digits.startsWith('972') || digits.startsWith('0') || digits.length <= 11);
        if (!looksLikePhone) {
          logger.warn(
            { phone, jid, senderPn: m.key?.senderPn || null, msgId: m.key?.id },
            'skip inbound: could not resolve real phone from JID'
          );
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

  sock.ev.on('messages.upsert', async (ev) => {
    if (ev.type !== 'notify') return;
    for (const m of ev.messages || []) {
      try {
        await forwardInbound(m);
      } catch (err) {
        logger.error({ phone, err: err?.message }, 'messages.upsert handler error');
      }
    }
  });

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
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const msg = lastDisconnect?.error?.message || 'connection closed';

      if (code === DisconnectReason.loggedOut || code === 401) {
        // WA refused the device. Wipe auth so the next /pair starts clean.
        await wipeAuth(phone);
        setStatus(s, 'logged_out', { lastError: `${code}: ${msg}` });
      } else if (s.status === 'connected') {
        // Lost an established session — try to reconnect quietly.
        setStatus(s, 'connecting', { lastError: msg });
        setTimeout(() => createSocket(phone).catch(() => {}), 2000);
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
        // If WA re-delivered a previously failed inbound message after our
        // retry/assertSessions, the update carries a decrypted `message`.
        // Forward it to the webhook just like a fresh upsert.
        if (!u?.key?.fromMe && u?.update?.message) {
          try {
            await forwardInbound({
              key: u.key,
              message: u.update.message,
              messageTimestamp: u.update.messageTimestamp,
            });
          } catch (err) {
            logger.error({ phone, err: err?.message }, 'inbound_update_forward failed');
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

    // Already authenticated — short-circuit.
    if (s.sock?.authState?.creds?.registered) {
      setStatus(s, 'connected');
      return { alreadyConnected: true, status: 'connected' };
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
    baileys_pkg_version: BAILEYS_PKG_VERSION,
    webhook_url_configured: !!WEBHOOK_URL,
    webhook_secret_configured: !!WEBHOOK_SECRET,
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
  });
});

app.post('/pair', async (req, res) => {
  const phone = String(req.body?.phone || req.body?.session || req.body?.phoneNumber || '').replace(/\D/g, '');
  const forceReset = !!req.body?.forceReset;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
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
    const groups = Object.values(all || {}).map((g) => ({
      jid: g.id,
      name: g.subject || '',
      participants: Array.isArray(g.participants) ? g.participants.length : null,
      size: typeof g.size === 'number'
        ? g.size
        : Array.isArray(g.participants) ? g.participants.length : null,
      announce: !!g.announce,
    }));
    res.json({ ok: true, groups });
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
    { port: PORT, authRoot: AUTH_ROOT, baileys_pkg_version: BAILEYS_PKG_VERSION },
    'whatsapp bridge listening'
  );
  restoreSessionsOnBoot().catch((err) =>
    logger.error({ err: err?.message }, 'restore on boot crashed')
  );
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

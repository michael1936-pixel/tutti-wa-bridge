// =============================================================================
// WhatsApp Baileys bridge — Railway server.js
// Fixes "the pairing code is invalid" by:
//   1. Pinning a known-good Baileys version + WA Web protocol version.
//   2. Using a stock Chrome browser fingerprint (custom names get rejected).
//   3. Waiting for the socket to become pairing-ready before requestPairingCode.
//   4. Persisting auth in /data and never wiping it after generating the code.
//   5. Exposing precise statuses + /logout, /reset, DELETE /session/:id.
//
// Env vars:
//   API_KEY    — value Lovable Cloud sends in X-Api-Key (must match
//                WHATSAPP_VPS_API_KEY in Lovable Cloud secrets)
//   AUTH_DIR   — persistent dir, default "/data" (mount Railway Volume here)
//   PORT       — provided by Railway
// =============================================================================

const express = require('express');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || '';
const AUTH_ROOT = process.env.AUTH_DIR || '/data';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// ---------------------------------------------------------------------------
// Session manager
// ---------------------------------------------------------------------------
//
// status values:
//   not_started        — no live socket
//   connecting         — socket created, waiting for pair-device readiness
//   pairing_code_ready — code returned, waiting for user to enter it
//   connected          — paired with WhatsApp
//   logged_out         — WA forced us out (loggedOut / 401)
//   failed             — terminal error before pairing succeeded

const sessions = new Map();

function authDirFor(phone) {
  return path.join(AUTH_ROOT, 'auth', phone);
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
    try { s.sock.end(undefined); } catch (_) {}
    try { s.sock.ws?.close?.(); } catch (_) {}
  }
  s.sock = null;
  s.pairingReady = false;
}

async function createSocket(phone, { forceReset } = {}) {
  const s = ensureSession(phone);

  if (forceReset) {
    await destroySocket(s);
    await wipeAuth(phone);
  }

  const dir = authDirFor(phone);
  await fs.promises.mkdir(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({
    // Fallback to a known-good WA Web version. Bump if WA forces an upgrade.
    version: [2, 3000, 1033893291],
  }));

  const sock = makeWASocket({
    version,
    logger: logger.child({ scope: 'baileys', phone }),
    printQRInTerminal: false,
    // Stock browser fingerprint — custom names get rejected by WA.
    browser: Browsers.macOS('Chrome'),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    keepAliveIntervalMs: 10_000,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    generateHighQualityLinkPreview: false,
  });

  s.sock = sock;
  s.pairingReady = false;
  setStatus(s, 'connecting', { lastError: null });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, isNewLogin, qr } = u;

    if (connection === 'connecting') {
      s.pairingReady = true;
    }

    if (connection === 'open' || isNewLogin) {
      setStatus(s, 'connected', { lastError: null, pairingCode: null });
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const msg = lastDisconnect?.error?.message || 'connection closed';

      if (code === DisconnectReason.loggedOut || code === 401) {
        await wipeAuth(phone);
        setStatus(s, 'logged_out', { lastError: `${code}: ${msg}` });
      } else if (s.status === 'connected') {
        setStatus(s, 'connecting', { lastError: msg });
        setTimeout(() => createSocket(phone).catch(() => {}), 2000);
      } else {
        setStatus(s, 'failed', { lastError: `${code ?? '?'}: ${msg}` });
      }

      s.pairingReady = false;
    }

    if (qr) {
      logger.warn({ phone }, 'unexpected QR fallback during pair flow');
    }
  });

  return s;
}

async function pair(phone, { forceReset } = {}) {
  const s = ensureSession(phone);

  if (s.pairingPromise) return s.pairingPromise;

  s.pairingPromise = (async () => {
    if (!s.sock || forceReset) {
      await createSocket(phone, { forceReset });
    }

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
  const phone = String(
    req.body?.phone || req.body?.session || req.body?.phoneNumber || ''
  ).replace(/\D/g, '');
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
  const phone = String(
    req.params.phone || req.query.session || req.body?.session || ''
  ).replace(/\D/g, '');
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const s = sessions.get(phone);
  if (s) {
    try { await s.sock?.logout?.(); } catch (_) {}
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
  if (!phone || !jid || !text) {
    return res.status(400).json({ error: 'jid, text, session required' });
  }
  const s = sessions.get(phone);
  if (!s || s.status !== 'connected') {
    return res.status(409).json({
      error: 'session_missing',
      status: s?.status ?? 'not_started',
    });
  }
  try {
    await s.sock.sendMessage(jid, { text });
    res.json({ ok: true });
  } catch (e) {
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

app.listen(PORT, () => {
  logger.info({ port: PORT, authRoot: AUTH_ROOT }, 'whatsapp bridge listening');
});

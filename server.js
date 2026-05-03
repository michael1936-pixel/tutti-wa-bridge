// server.js — WhatsApp Bridge (Baileys) for Lovable
// Endpoints: GET /health, POST /pair, GET /status/:session,
//            POST /logout?session=, POST /reset?session=,
//            DELETE /session/:session
//
// Critical fixes vs previous version:
// 1. Once a pairing code is issued, we KEEP it for ~3 minutes and return the
//    SAME code on repeat /pair calls. We never call requestPairingCode again
//    while a code is alive — that was the root cause of "wrong code" in WA.
// 2. Transient "Connection Terminated" / code 428 during the pairing window
//    triggers a SILENT reconnect that REUSES the same auth folder and the
//    same pairing code. We do NOT wipe creds and we do NOT issue a new code.
// 3. forceReset only fires when the caller explicitly asks for it.
// 4. requestPairingCode is only called when state.creds.registered === false.

import express from 'express';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import {
  default as makeWASocketDefault,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} from '@whiskeysockets/baileys';

// Baileys is sometimes default-exported and sometimes named-exported depending
// on version. Handle both safely so the process never crashes with
// "makeWASocket is not a function".
const makeWASocket =
  typeof makeWASocketDefault === 'function'
    ? makeWASocketDefault
    : (makeWASocketDefault && typeof makeWASocketDefault.default === 'function'
        ? makeWASocketDefault.default
        : null);

if (!makeWASocket) {
  console.error('FATAL: could not resolve makeWASocket from @whiskeysockets/baileys');
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || '3000', 10);
const API_KEY = process.env.API_KEY || '';
const SESSIONS_DIR = process.env.SESSIONS_DIR || '/app/sessions';
const PAIRING_CODE_TTL_MS = 3 * 60 * 1000; // 3 minutes — matches WA's window

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const logger = pino({ level: 'info' });
const app = express();
app.use(express.json({ limit: '1mb' }));

// ---------- auth middleware ----------
app.use((req, res, next) => {
  if (req.path === '/health') return next(); // health is open
  if (!API_KEY) return next(); // not configured -> open (dev)
  const k =
    req.headers['x-api-key'] ||
    req.headers['x-api-token'] ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (k && k === API_KEY) return next();
  return res.status(401).json({ ok: false, error: 'unauthorized' });
});

// ---------- per-session state ----------
/**
 * sessions[phone] = {
 *   sock,                // current Baileys socket
 *   status,              // 'disconnected' | 'connecting' | 'pairing_code_ready' | 'connected' | 'logged_out' | 'failed'
 *   pairingCode,         // string|null  — the active code shown to the user
 *   pairingCodeIssuedAt, // number|null  — Date.now() when the code was issued
 *   pairingCodeExpiresAt,// number|null  — issuedAt + TTL
 *   lastError,           // string|null
 *   reconnecting,        // bool — silent reconnect in progress
 *   starting,            // bool — guard against concurrent startSession
 * }
 */
const sessions = Object.create(null);

const sessDir = (phone) => path.join(SESSIONS_DIR, phone);

function getOrInit(phone) {
  if (!sessions[phone]) {
    sessions[phone] = {
      sock: null,
      status: 'disconnected',
      pairingCode: null,
      pairingCodeIssuedAt: null,
      pairingCodeExpiresAt: null,
      lastError: null,
      reconnecting: false,
      starting: false,
    };
  }
  return sessions[phone];
}

function isCodeAlive(s) {
  return (
    !!s.pairingCode &&
    !!s.pairingCodeExpiresAt &&
    Date.now() < s.pairingCodeExpiresAt
  );
}

function clearCode(s) {
  s.pairingCode = null;
  s.pairingCodeIssuedAt = null;
  s.pairingCodeExpiresAt = null;
}

async function wipeAuth(phone) {
  try {
    fs.rmSync(sessDir(phone), { recursive: true, force: true });
  } catch (e) {
    logger.warn({ phone, err: String(e) }, 'wipeAuth failed');
  }
}

async function startSession(phone, { forceReset = false } = {}) {
  const s = getOrInit(phone);

  if (s.starting) return s;
  s.starting = true;

  try {
    if (forceReset) {
      // Explicit reset — kill socket, wipe creds, drop active code.
      try { s.sock?.end(undefined); } catch (_) {}
      await wipeAuth(phone);
      clearCode(s);
      s.status = 'disconnected';
      s.lastError = null;
    }

    if (!fs.existsSync(sessDir(phone))) fs.mkdirSync(sessDir(phone), { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(sessDir(phone));
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: Browsers.macOS('Desktop'),
      qrTimeout: 0,
      connectTimeoutMs: 60_000,
      keepAliveIntervalMs: 25_000,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });

    s.sock = sock;
    s.status = 'connecting';

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect } = u;
      if (connection === 'open') {
        s.status = 'connected';
        s.lastError = null;
        clearCode(s);
        logger.info({ phone }, 'connected');
        return;
      }
      if (connection === 'close') {
        const code =
          lastDisconnect?.error?.output?.statusCode ||
          lastDisconnect?.error?.statusCode ||
          0;
        const reason = lastDisconnect?.error?.message || String(lastDisconnect?.error || '');
        logger.warn({ phone, code, reason }, 'connection closed');

        if (code === DisconnectReason.loggedOut) {
          s.status = 'logged_out';
          s.lastError = 'logged out';
          clearCode(s);
          await wipeAuth(phone);
          return;
        }

        // Pairing window: silent reconnect, KEEP code & auth.
        const codeAlive = isCodeAlive(s);
        if (codeAlive || s.status === 'pairing_code_ready' || s.status === 'connecting') {
          if (!s.reconnecting) {
            s.reconnecting = true;
            logger.info({ phone }, 'silent reconnect within pairing window');
            setTimeout(async () => {
              s.reconnecting = false;
              try {
                await startSession(phone, { forceReset: false });
              } catch (e) {
                logger.error({ phone, err: String(e) }, 'silent reconnect failed');
              }
            }, 1500);
          }
          return;
        }

        s.status = 'disconnected';
        s.lastError = `closed (${code}): ${reason}`.slice(0, 300);
      }
    });

    return s;
  } finally {
    s.starting = false;
  }
}

// ---------- routes ----------

app.get('/health', (_req, res) => {
  const list = Object.entries(sessions).map(([phone, s]) => ({
    phone,
    status: s.status,
    hasCode: !!s.pairingCode,
  }));
  res.json({ ok: true, sessions: list });
});

app.post('/pair', async (req, res) => {
  try {
    const phone = String(req.body?.phone || req.body?.session || '').replace(/\D/g, '');
    if (!phone) return res.status(400).json({ ok: false, error: 'phone required' });

    const forceReset = req.body?.forceReset === true;
    const s = await startSession(phone, { forceReset });

    // If WhatsApp already linked this device, no code is needed.
    if (s.status === 'connected') {
      return res.json({ ok: true, alreadyConnected: true, status: 'connected' });
    }

    // Reuse alive code — DO NOT regenerate while it's still valid.
    if (isCodeAlive(s)) {
      return res.json({
        ok: true,
        pairingCode: s.pairingCode,
        code: s.pairingCode, // legacy
        codeExpiresAt: new Date(s.pairingCodeExpiresAt).toISOString(),
        reused: true,
        status: s.status,
      });
    }

    // Wait briefly for the socket to be ready to request a code.
    const waitUntil = Date.now() + 8000;
    while (Date.now() < waitUntil) {
      if (s.sock?.requestPairingCode && s.sock?.authState?.creds) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    const registered = !!s.sock?.authState?.creds?.registered;
    if (registered) {
      // Already paired in creds — just need to connect.
      return res.json({ ok: true, alreadyRegistered: true, status: s.status });
    }

    if (typeof s.sock?.requestPairingCode !== 'function') {
      return res.status(503).json({
        ok: false,
        error: 'socket not ready for pairing',
        stage: 'requestPairingCode',
      });
    }

    let code;
    try {
      code = await s.sock.requestPairingCode(phone);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error({ phone, err: msg }, 'requestPairingCode failed');
      s.lastError = msg.slice(0, 300);
      return res.status(502).json({
        ok: false,
        error: msg,
        stage: 'requestPairingCode',
      });
    }

    s.pairingCode = String(code).replace(/-/g, '').toUpperCase();
    s.pairingCodeIssuedAt = Date.now();
    s.pairingCodeExpiresAt = s.pairingCodeIssuedAt + PAIRING_CODE_TTL_MS;
    s.status = 'pairing_code_ready';
    s.lastError = null;

    return res.json({
      ok: true,
      pairingCode: s.pairingCode,
      code: s.pairingCode, // legacy
      codeExpiresAt: new Date(s.pairingCodeExpiresAt).toISOString(),
      reused: false,
      status: s.status,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error({ err: msg }, '/pair fatal');
    return res.status(500).json({ ok: false, error: msg });
  }
});

app.get('/status/:session', (req, res) => {
  const phone = String(req.params.session || '').replace(/\D/g, '');
  const s = sessions[phone];
  if (!s) return res.json({ ok: true, status: 'disconnected' });
  res.json({
    ok: true,
    status: s.status,
    hasCode: isCodeAlive(s),
    pairingCode: isCodeAlive(s) ? s.pairingCode : null,
    codeExpiresAt: isCodeAlive(s) ? new Date(s.pairingCodeExpiresAt).toISOString() : null,
    lastError: s.lastError,
  });
});

app.get('/status', (req, res) => {
  const phone = String(req.query.session || '').replace(/\D/g, '');
  if (!phone) {
    return res.json({ ok: true, sessions: Object.keys(sessions) });
  }
  const s = sessions[phone];
  if (!s) return res.json({ ok: true, status: 'disconnected' });
  res.json({
    ok: true,
    connected: s.status === 'connected',
    hasQR: false,
    status: s.status,
    hasCode: isCodeAlive(s),
    codeExpiresAt: isCodeAlive(s) ? new Date(s.pairingCodeExpiresAt).toISOString() : null,
    lastError: s.lastError,
  });
});

async function doLogout(phone) {
  const s = sessions[phone];
  if (s) {
    try { await s.sock?.logout(); } catch (_) {}
    try { s.sock?.end(undefined); } catch (_) {}
    s.sock = null;
    clearCode(s);
    s.status = 'disconnected';
    s.lastError = 'manual logout';
  }
  await wipeAuth(phone);
}

app.post('/logout', async (req, res) => {
  const phone = String(req.query.session || req.body?.session || '').replace(/\D/g, '');
  if (!phone) return res.status(400).json({ ok: false, error: 'session required' });
  await doLogout(phone);
  res.json({ ok: true });
});

app.post('/session/:session/logout', async (req, res) => {
  const phone = String(req.params.session || '').replace(/\D/g, '');
  await doLogout(phone);
  res.json({ ok: true });
});

app.delete('/session/:session', async (req, res) => {
  const phone = String(req.params.session || '').replace(/\D/g, '');
  await doLogout(phone);
  res.json({ ok: true });
});

app.post('/reset', async (req, res) => {
  const phone = String(req.query.session || req.body?.session || '').replace(/\D/g, '');
  if (!phone) return res.status(400).json({ ok: false, error: 'session required' });
  await doLogout(phone);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  logger.info({ port: PORT, sessionsDir: SESSIONS_DIR }, 'bridge up');
});

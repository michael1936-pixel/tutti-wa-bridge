// server.js — WhatsApp Bridge (Baileys) for Lovable
// Stable pairing-code build. Replace your repo's server.js with this and let Railway redeploy.
//
// Endpoints:
//   GET  /health
//   POST /pair      { phone, forceReset? }     -> { code, pairingCode, codeExpiresAt, status }
//   GET  /status/:phone                        -> { status, pairingCode?, codeExpiresAt?, lastError? }
//   POST /reset     { phone }
//   POST /logout    { phone }
//   POST /send      { to, text }

import express from 'express';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Boom } from '@hapi/boom';

// Safe Baileys import — works for both ESM and CJS builds.
const baileysModule = await import('@whiskeysockets/baileys');
const makeWASocket =
  baileysModule.default?.default ||
  baileysModule.default ||
  baileysModule.makeWASocket;
const {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = baileysModule.default && typeof baileysModule.default === 'object'
  ? baileysModule.default
  : baileysModule;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || process.env.WHATSAPP_VPS_API_KEY || '';
const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(__dirname, 'sessions');
const CODE_TTL_MS = 3 * 60 * 1000; // 3 minutes — keep the pairing code alive

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const app = express();
app.use(express.json({ limit: '1mb' }));

// ---- auth middleware ----
function checkAuth(req, res, next) {
  if (!API_KEY) return next();
  const hdr =
    req.get('X-Api-Key') ||
    req.get('X-Bridge-Api-Key') ||
    req.get('X-API-Token') ||
    (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (hdr === API_KEY) return next();
  return res.status(401).json({ ok: false, error: 'unauthorized' });
}

// ---- helpers ----
function normalizePhone(raw) {
  let p = String(raw || '').replace(/\D/g, '');
  if (p.startsWith('0')) p = '972' + p.slice(1);
  return p;
}

const sessions = new Map(); // phone -> { sock, status, pairingCode, codeIssuedAt, lastError, starting }

function getSessionDir(phone) {
  return path.join(SESSIONS_DIR, phone);
}

function pairingCodeAlive(entry) {
  if (!entry?.pairingCode || !entry?.codeIssuedAt) return false;
  return Date.now() - entry.codeIssuedAt < CODE_TTL_MS;
}

async function startSocket(phone, { wipe = false } = {}) {
  const dir = getSessionDir(phone);
  if (wipe && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();
  const sockLogger = logger.child({ phone });

  const sock = makeWASocket({
    version,
    printQRInTerminal: false,
    qrTimeout: 0,                // critical: don't kill socket on QR ref expiry
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 25_000,
    browser: Browsers.macOS('Desktop'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, sockLogger),
    },
    logger: sockLogger,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect } = u;
    const entry = sessions.get(phone) || {};

    if (connection === 'open') {
      entry.sock = sock;
      entry.status = 'connected';
      entry.pairingCode = null;
      entry.codeIssuedAt = null;
      entry.lastError = null;
      sessions.set(phone, entry);
      sockLogger.info('connected');
      return;
    }

    if (connection === 'close') {
      const code =
        lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output?.statusCode
          : lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.code;
      const reason = lastDisconnect?.error?.message || String(code || 'unknown');
      sockLogger.warn({ code, reason }, 'connection closed');

      // True logout — wipe and stop.
      if (code === DisconnectReason.loggedOut) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
        sessions.delete(phone);
        return;
      }

      // If we are inside the active pairing-code window, do a SILENT reconnect
      // without wiping creds and without changing the code shown to the user.
      if (pairingCodeAlive(entry)) {
        sockLogger.info('silent reconnect within pairing window');
        setTimeout(() => {
          startSocket(phone, { wipe: false }).catch((e) =>
            sockLogger.error({ err: e?.message }, 'silent reconnect failed'),
          );
        }, 1500);
        entry.status = 'pairing_code_ready';
        entry.lastError = `transient: ${reason}`;
        sessions.set(phone, entry);
        return;
      }

      // Restart-required (e.g. 515) right after pairing — reconnect once.
      if (code === DisconnectReason.restartRequired) {
        setTimeout(() => {
          startSocket(phone, { wipe: false }).catch(() => {});
        }, 1000);
        entry.status = 'restarting';
        sessions.set(phone, entry);
        return;
      }

      entry.status = 'disconnected';
      entry.lastError = reason;
      sessions.set(phone, entry);
    }
  });

  const entry = sessions.get(phone) || {};
  entry.sock = sock;
  entry.status = entry.status || 'starting';
  entry.starting = false;
  sessions.set(phone, entry);

  // Wait briefly for creds to be ready, then request a pairing code if needed.
  if (!state.creds.registered) {
    // Poll until socket is ready to accept requestPairingCode (max 8s).
    const started = Date.now();
    while (Date.now() - started < 8000) {
      if (typeof sock.requestPairingCode === 'function') break;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return sock;
}

// ---- routes ----
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    sessions: Array.from(sessions.entries()).map(([phone, e]) => ({
      phone,
      status: e.status,
      hasCode: !!e.pairingCode,
      codeIssuedAt: e.codeIssuedAt || null,
    })),
  });
});

app.post('/pair', checkAuth, async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    const forceReset = !!req.body?.forceReset;
    if (!phone || phone.length < 10) {
      return res.status(400).json({ ok: false, error: 'invalid phone' });
    }

    let entry = sessions.get(phone) || {};

    // Already connected?
    if (entry.sock?.user && entry.status === 'connected' && !forceReset) {
      return res.json({ ok: true, status: 'connected', alreadyConnected: true });
    }

    // If we still have a live pairing code and caller did not force a reset,
    // return the SAME code instead of issuing a new one.
    if (!forceReset && pairingCodeAlive(entry)) {
      return res.json({
        ok: true,
        status: 'pairing_code_ready',
        code: entry.pairingCode,
        pairingCode: entry.pairingCode,
        codeExpiresAt: entry.codeIssuedAt + CODE_TTL_MS,
      });
    }

    // Start (or restart) socket.
    if (forceReset) {
      try { entry.sock?.end?.(new Error('forceReset')); } catch {}
      sessions.delete(phone);
      entry = {};
    }

    if (!entry.sock || forceReset) {
      entry.starting = true;
      sessions.set(phone, entry);
      await startSocket(phone, { wipe: forceReset });
      entry = sessions.get(phone) || {};
    }

    const sock = entry.sock;
    if (!sock || typeof sock.requestPairingCode !== 'function') {
      return res.status(500).json({ ok: false, error: 'socket not ready' });
    }

    if (sock.authState?.creds?.registered) {
      return res.json({ ok: true, status: 'connected', alreadyConnected: true });
    }

    let code;
    try {
      code = await sock.requestPairingCode(phone);
    } catch (err) {
      const msg = err?.message || String(err);
      entry.lastError = msg;
      sessions.set(phone, entry);
      return res.status(500).json({ ok: false, error: msg, stage: 'requestPairingCode' });
    }

    entry.pairingCode = code;
    entry.codeIssuedAt = Date.now();
    entry.status = 'pairing_code_ready';
    entry.lastError = null;
    sessions.set(phone, entry);

    return res.json({
      ok: true,
      status: 'pairing_code_ready',
      code,
      pairingCode: code,
      codeExpiresAt: entry.codeIssuedAt + CODE_TTL_MS,
    });
  } catch (e) {
    logger.error({ err: e?.message }, 'pair fatal');
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get('/status/:phone', checkAuth, (req, res) => {
  const phone = normalizePhone(req.params.phone);
  const e = sessions.get(phone);
  if (!e) return res.json({ ok: true, status: 'disconnected' });
  res.json({
    ok: true,
    status: e.status || 'unknown',
    pairingCode: pairingCodeAlive(e) ? e.pairingCode : undefined,
    codeExpiresAt: pairingCodeAlive(e) ? e.codeIssuedAt + CODE_TTL_MS : undefined,
    lastError: e.lastError || undefined,
  });
});

app.get('/status', checkAuth, (req, res) => {
  const phone = normalizePhone(req.query.session);
  if (phone) {
    const e = sessions.get(phone);
    return res.json({
      ok: true,
      connected: e?.status === 'connected',
      hasQR: false,
      status: e?.status || 'disconnected',
      pairingCode: pairingCodeAlive(e) ? e.pairingCode : undefined,
    });
  }
  res.json({ ok: true, sessions: Array.from(sessions.keys()) });
});

async function doReset(phone) {
  const e = sessions.get(phone);
  try { e?.sock?.end?.(new Error('reset')); } catch {}
  sessions.delete(phone);
  const dir = getSessionDir(phone);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

app.post('/reset', checkAuth, async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'invalid phone' });
  await doReset(phone);
  res.json({ ok: true });
});

app.post('/logout', checkAuth, async (req, res) => {
  const phone = normalizePhone(req.body?.phone || req.query?.session);
  if (!phone) return res.status(400).json({ ok: false, error: 'invalid phone' });
  const e = sessions.get(phone);
  try { await e?.sock?.logout?.(); } catch {}
  await doReset(phone);
  res.json({ ok: true });
});

app.post('/session/:phone/logout', checkAuth, async (req, res) => {
  const phone = normalizePhone(req.params.phone);
  const e = sessions.get(phone);
  try { await e?.sock?.logout?.(); } catch {}
  await doReset(phone);
  res.json({ ok: true });
});

app.delete('/session/:phone', checkAuth, async (req, res) => {
  const phone = normalizePhone(req.params.phone);
  await doReset(phone);
  res.json({ ok: true });
});

app.post('/send', checkAuth, async (req, res) => {
  const phone = normalizePhone(req.body?.from || req.body?.session);
  const to = req.body?.to;
  const text = req.body?.text;
  if (!to || !text) return res.status(400).json({ ok: false, error: 'missing to/text' });
  const e = phone ? sessions.get(phone) : Array.from(sessions.values())[0];
  if (!e?.sock || e.status !== 'connected') {
    return res.status(409).json({ ok: false, error: 'not connected', status: e?.status || 'disconnected' });
  }
  try {
    const jid = String(to).includes('@') ? to : `${to}@s.whatsapp.net`;
    const r = await e.sock.sendMessage(jid, { text });
    res.json({ ok: true, id: r?.key?.id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.listen(PORT, () => logger.info({ port: PORT, sessionsDir: SESSIONS_DIR }, '🚀 bridge up'));

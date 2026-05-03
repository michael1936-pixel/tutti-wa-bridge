// WhatsApp Bridge for Lovable (Baileys) — pairing-code stable build
// Replace your repo's server.js with this file, commit, and let Railway redeploy.
//
// Endpoints (unchanged contract):
//   GET  /health
//   POST /pair      { phone, forceReset? }   -> { code, status }
//   GET  /status/:phone                      -> { status, pairingCode?, codeExpiresAt?, lastError? }
//   POST /reset     { phone }
//   POST /logout    { phone }
//   POST /send      { phone, to, text }
//
// Auth: X-Api-Key, x-api-key, X-API-Token, or Authorization: Bearer <KEY>
//       compared against env API_KEY / BRIDGE_API_KEY / WHATSAPP_VPS_API_KEY (any of them).

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;
const KEYS = [process.env.API_KEY, process.env.BRIDGE_API_KEY, process.env.WHATSAPP_VPS_API_KEY]
  .filter(Boolean);
const SESSIONS_DIR = process.env.SESSIONS_DIR || '/data/sessions';
const CODE_TTL_MS = 180_000; // keep socket alive 3 minutes after issuing a code
const logger = pino({ level: 'info' });

fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// In-memory session registry: phone -> { sock, status, code, codeIssuedAt, lastError, reconnecting }
const sessions = new Map();

function authOk(req) {
  if (KEYS.length === 0) return true; // dev mode
  const provided =
    req.get('X-Api-Key') ||
    req.get('x-api-key') ||
    req.get('X-API-Token') ||
    (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  return KEYS.includes(provided);
}

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (!authOk(req)) {
    logger.warn({ path: req.path }, 'auth rejected');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

function sessionDir(phone) {
  return path.join(SESSIONS_DIR, phone);
}

function ensureEntry(phone) {
  let e = sessions.get(phone);
  if (!e) {
    e = { sock: null, status: 'disconnected', code: null, codeIssuedAt: 0, lastError: null, reconnecting: false };
    sessions.set(phone, e);
  }
  return e;
}

async function startSocket(phone, { requestCode } = {}) {
  const entry = ensureEntry(phone);
  const dir = sessionDir(phone);
  fs.mkdirSync(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.macOS('Desktop'),
    logger: pino({ level: 'silent' }),
    qrTimeout: 0,            // CRITICAL: do NOT auto-close on QR refs (we use pairing code)
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    markOnlineOnConnect: false,
  });

  entry.sock = sock;
  entry.status = 'connecting';
  entry.lastError = null;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    logger.info({ phone, connection, hasQR: !!qr }, 'connection.update');

    if (connection === 'open') {
      entry.status = 'connected';
      entry.code = null;
      entry.codeIssuedAt = 0;
      entry.lastError = null;
      entry.reconnecting = false;
      return;
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || 'closed';
      logger.warn({ phone, code, reason }, '❌ Connection closed');
      entry.lastError = `${code ?? '?'}: ${reason}`;

      // Real logout → wipe and stop.
      if (code === DisconnectReason.loggedOut) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
        entry.status = 'logged_out';
        entry.code = null;
        entry.codeIssuedAt = 0;
        return;
      }

      // If a pairing code is still within its TTL → silent reconnect, keep code "alive".
      const codeStillFresh = entry.codeIssuedAt && Date.now() - entry.codeIssuedAt < CODE_TTL_MS;
      if (codeStillFresh && !entry.reconnecting) {
        entry.reconnecting = true;
        entry.status = 'pairing_code_ready'; // do NOT downgrade to disconnected
        logger.info({ phone, ageMs: Date.now() - entry.codeIssuedAt }, '↻ silent reconnect (code still fresh)');
        setTimeout(() => {
          entry.reconnecting = false;
          startSocket(phone, { requestCode: true }).catch((e) =>
            logger.error({ phone, err: e?.message }, 'reconnect failed'),
          );
        }, 1500);
        return;
      }

      // Otherwise mark disconnected (do NOT auto-delete files unless explicit logout).
      entry.status = 'disconnected';
      entry.code = null;
      entry.codeIssuedAt = 0;
    }
  });

  // Request the pairing code only after the socket is initialized and not yet registered.
  if (requestCode && !state.creds.registered) {
    try {
      // tiny delay so internal noise handshake has a chance
      await new Promise((r) => setTimeout(r, 1200));
      const code = await sock.requestPairingCode(phone);
      const formatted = code; // Baileys returns formatted XXXX-XXXX usually
      entry.code = formatted;
      entry.codeIssuedAt = Date.now();
      entry.status = 'pairing_code_ready';
      logger.info({ phone, code: formatted }, '🔑 Pairing code generated');
    } catch (e) {
      entry.lastError = e?.message || String(e);
      entry.status = 'error';
      logger.error({ phone, err: entry.lastError }, 'requestPairingCode failed');
    }
  }

  return entry;
}

app.post('/pair', async (req, res) => {
  const { phone, forceReset } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone required' });

  try {
    const existing = sessions.get(phone);
    if (forceReset && existing?.sock) {
      try { existing.sock.end(undefined); } catch {}
      sessions.delete(phone);
      try { fs.rmSync(sessionDir(phone), { recursive: true, force: true }); } catch {}
    }

    const entry = await startSocket(phone, { requestCode: true });

    // Wait briefly for code to materialize
    const deadline = Date.now() + 15_000;
    while (!entry.code && entry.status !== 'connected' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }

    if (entry.status === 'connected') {
      return res.json({ status: 'connected', alreadyConnected: true });
    }
    if (!entry.code) {
      return res.status(500).json({ error: entry.lastError || 'no code generated' });
    }
    return res.json({
      status: 'pairing_code_ready',
      code: entry.code,
      codeExpiresAt: entry.codeIssuedAt + CODE_TTL_MS,
    });
  } catch (e) {
    logger.error({ err: e?.message }, '/pair failed');
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get('/status/:phone', (req, res) => {
  const phone = req.params.phone;
  const e = sessions.get(phone);
  if (!e) return res.json({ status: 'disconnected' });
  res.json({
    status: e.status,
    pairingCode: e.code || undefined,
    codeExpiresAt: e.codeIssuedAt ? e.codeIssuedAt + CODE_TTL_MS : undefined,
    lastError: e.lastError || undefined,
  });
});

app.post('/reset', async (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const e = sessions.get(phone);
  try { e?.sock?.end(undefined); } catch {}
  sessions.delete(phone);
  try { fs.rmSync(sessionDir(phone), { recursive: true, force: true }); } catch {}
  res.json({ ok: true });
});

app.post('/logout', async (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const e = sessions.get(phone);
  try { await e?.sock?.logout(); } catch {}
  try { e?.sock?.end(undefined); } catch {}
  sessions.delete(phone);
  try { fs.rmSync(sessionDir(phone), { recursive: true, force: true }); } catch {}
  res.json({ ok: true });
});

app.post('/send', async (req, res) => {
  const { phone, to, text } = req.body || {};
  if (!phone || !to || !text) return res.status(400).json({ error: 'phone, to, text required' });
  const e = sessions.get(phone);
  if (!e?.sock || e.status !== 'connected') {
    return res.status(409).json({ error: 'not connected', status: e?.status || 'disconnected' });
  }
  try {
    const jid = String(to).includes('@') ? to : `${to}@s.whatsapp.net`;
    const r = await e.sock.sendMessage(jid, { text });
    res.json({ ok: true, id: r?.key?.id });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.listen(PORT, () => logger.info({ port: PORT, sessionsDir: SESSIONS_DIR }, '🚀 bridge up'));

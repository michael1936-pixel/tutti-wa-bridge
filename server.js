// server.js - WhatsApp Bridge for Baileys (Pairing Code Mode)
import express from 'express';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import P from 'pino';
import fs from 'fs';
import path from 'path';
import { Boom } from '@hapi/boom';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const AUTH_ROOT = process.env.AUTH_ROOT || './auth';
const API_TOKEN = process.env.API_TOKEN || '';

// In-memory state per phone number
const sessions = new Map();
// { sock, status, pairingCode, lastError, qr }

const logger = P({ level: 'info' });

// ---- Helpers ----
function authDir(phone) {
  return path.join(AUTH_ROOT, phone);
}

function ensureAuthRoot() {
  if (!fs.existsSync(AUTH_ROOT)) fs.mkdirSync(AUTH_ROOT, { recursive: true });
}

function deleteSessionFiles(phone) {
  const dir = authDir(phone);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    logger.info({ phone }, '🗑️ Deleted session files');
  }
}

function checkAuth(req, res) {
  if (!API_TOKEN) return true;
  const token = req.headers['x-api-token'] || req.headers['authorization']?.replace('Bearer ', '');
  if (token !== API_TOKEN) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// ---- Core: Start Socket ----
async function startSock(phone, { forceReset = false, mode = 'code' } = {}) {
  ensureAuthRoot();

  if (forceReset) {
    // Close existing socket if any
    const existing = sessions.get(phone);
    if (existing?.sock) {
      try { existing.sock.end(undefined); } catch {}
      try { existing.sock.ws?.close(); } catch {}
    }
    deleteSessionFiles(phone);
    sessions.delete(phone);
  }

  const dir = authDir(phone);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: ['Windows', 'Chrome', '114.0.5735.198'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  const session = {
    sock,
    status: 'connecting',
    pairingCode: null,
    lastError: null,
    qr: null,
    registered: !!state.creds?.registered,
  };
  sessions.set(phone, session);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    logger.info({ phone, connection, hasQR: !!qr }, 'connection.update');

    if (qr) session.qr = qr;

    if (connection === 'open') {
      session.status = 'connected';
      session.lastError = null;
      session.pairingCode = null;
      logger.info({ phone }, '✅ Connected');
    }

    if (connection === 'close') {
      const code = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode
        : 0;
      const reason = lastDisconnect?.error?.message || 'unknown';
      session.lastError = `${code}: ${reason}`;
      logger.warn({ phone, code, reason }, '❌ Connection closed');

      if (code === DisconnectReason.loggedOut) {
        session.status = 'logged_out';
        deleteSessionFiles(phone);
        sessions.delete(phone);
      } else {
        session.status = 'disconnected';
      }
    }
  });

  // Request pairing code if not registered
  if (mode === 'code' && !state.creds?.registered) {
    try {
      // Wait briefly for socket to initialize
      await new Promise(r => setTimeout(r, 1500));
      const code = await sock.requestPairingCode(phone);
      session.pairingCode = code;
      session.status = 'pairing_code_ready';
      logger.info({ phone, code }, '🔑 Pairing code generated');
    } catch (err) {
      session.lastError = err?.message || String(err);
      session.status = 'pair_failed';
      logger.error({ phone, err: session.lastError }, '⚠️ requestPairingCode failed');
      throw err;
    }
  }

  return session;
}

// ---- Routes ----
app.get('/health', (req, res) => {
  const list = [...sessions.entries()].map(([phone, s]) => ({
    phone,
    status: s.status,
    registered: s.registered,
    hasPairingCode: !!s.pairingCode,
    lastError: s.lastError,
  }));
  res.json({ ok: true, sessions: list, uptime: process.uptime() });
});

app.get('/status/:phone', (req, res) => {
  if (!checkAuth(req, res)) return;
  const s = sessions.get(req.params.phone);
  if (!s) return res.json({ status: 'none' });
  res.json({
    status: s.status,
    pairingCode: s.pairingCode,
    lastError: s.lastError,
    registered: s.registered,
  });
});

app.post('/pair', async (req, res) => {
  if (!checkAuth(req, res)) return;
  const { phone, mode = 'code', forceReset = false } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone required' });

  try {
    const s = await startSock(phone, { forceReset, mode });
    res.json({
      ok: true,
      status: s.status,
      pairingCode: s.pairingCode,
      registered: s.registered,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err?.message || String(err),
      stage: 'requestPairingCode',
    });
  }
});

app.post('/logout', async (req, res) => {
  if (!checkAuth(req, res)) return;
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone required' });

  const s = sessions.get(phone);
  if (s?.sock) {
    try { await s.sock.logout(); } catch {}
    try { s.sock.end(undefined); } catch {}
  }
  deleteSessionFiles(phone);
  sessions.delete(phone);
  res.json({ ok: true });
});

app.post('/reset', async (req, res) => {
  if (!checkAuth(req, res)) return;
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone required' });

  const s = sessions.get(phone);
  if (s?.sock) {
    try { s.sock.end(undefined); } catch {}
    try { s.sock.ws?.close(); } catch {}
  }
  deleteSessionFiles(phone);
  sessions.delete(phone);
  res.json({ ok: true, message: 'Session reset' });
});

app.delete('/session/:phone', async (req, res) => {
  if (!checkAuth(req, res)) return;
  const { phone } = req.params;
  const s = sessions.get(phone);
  if (s?.sock) {
    try { s.sock.end(undefined); } catch {}
  }
  deleteSessionFiles(phone);
  sessions.delete(phone);
  res.json({ ok: true });
});

app.post('/send', async (req, res) => {
  if (!checkAuth(req, res)) return;
  const { phone, to, message } = req.body || {};
  if (!phone || !to || !message) {
    return res.status(400).json({ error: 'phone, to, message required' });
  }
  const s = sessions.get(phone);
  if (!s?.sock || s.status !== 'connected') {
    return res.status(409).json({ error: 'Not connected', status: s?.status || 'none' });
  }
  try {
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    await s.sock.sendMessage(jid, { text: message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.listen(PORT, () => {
  logger.info(`🚀 Bridge listening on ${PORT}`);
  logger.info(`AUTH_ROOT: ${AUTH_ROOT}`);
});

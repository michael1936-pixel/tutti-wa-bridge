// tutti-wa-bridge/server.js
// WhatsApp pairing bridge using Baileys.
// Handles 515 (restartRequired) by recreating the socket — the typical
// post-pairing handshake. Persists auth/<phone>/ to a Railway Volume.

const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.WHATSAPP_VPS_API_KEY || process.env.API_KEY;
const AUTH_ROOT = process.env.AUTH_ROOT || path.join(__dirname, 'auth');

if (!fs.existsSync(AUTH_ROOT)) fs.mkdirSync(AUTH_ROOT, { recursive: true });

const log = pino({ level: 'info' });
const app = express();
app.use(express.json());

// In-memory session map: phone -> { sock, status, lastCode, lastError, startedAt }
const sessions = new Map();

function normalizePhone(input) {
  if (!input) return null;
  let p = String(input).replace(/\D/g, '');
  if (p.startsWith('0')) p = '972' + p.slice(1);
  if (p.length < 10 || p.length > 15) return null;
  return p;
}

function authDir(phone) {
  return path.join(AUTH_ROOT, phone);
}

function requireKey(req, res, next) {
  if (!API_KEY) return next();
  const k = req.header('X-Api-Key') || req.query.key;
  if (k !== API_KEY) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}

async function startSocket(phone, { freshPair = false } = {}) {
  const dir = authDir(phone);
  if (freshPair && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.macOS('Safari'),
    logger: pino({ level: 'silent' }),
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  const session = sessions.get(phone) || {
    status: 'starting',
    startedAt: Date.now(),
    lastCode: null,
    lastError: null,
  };
  session.sock = sock;
  session.status = session.status === 'connected' ? 'connected' : 'starting';
  sessions.set(phone, session);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, isNewLogin } = update;
    log.info({ phone, connection, isNewLogin }, 'connection.update');

    if (connection === 'connecting') {
      session.status = session.status === 'connected' ? 'connected' : 'connecting';
    }

    if (connection === 'open') {
      session.status = 'connected';
      session.lastError = null;
      log.info({ phone }, 'CONNECTED ✅');
    }

    if (connection === 'close') {
      const code =
        lastDisconnect?.error?.output?.statusCode ||
        lastDisconnect?.error?.output?.payload?.statusCode;
      const reasonName =
        Object.keys(DisconnectReason).find((k) => DisconnectReason[k] === code) || 'unknown';
      log.warn({ phone, code, reasonName }, 'connection close');

      // 515 = restartRequired. Standard after pairing — recreate socket.
      if (code === DisconnectReason.restartRequired || code === 515) {
        log.info({ phone }, 'restart required, recreating socket');
        setTimeout(() => startSocket(phone).catch((e) => log.error(e)), 500);
        return;
      }

      if (code === DisconnectReason.loggedOut) {
        session.status = 'failed';
        session.lastError = 'logged out';
        sessions.delete(phone);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
        return;
      }

      // Other close reasons → reconnect within pairing window
      const ageMs = Date.now() - session.startedAt;
      if (ageMs < 120_000) {
        setTimeout(() => startSocket(phone).catch((e) => log.error(e)), 3000);
      } else if (session.status !== 'connected') {
        session.status = 'failed';
        session.lastError = `closed (${code} ${reasonName})`;
      }
    }
  });

  return { sock, saveCreds, session };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, sessions: sessions.size, ts: Date.now() });
});

app.get('/status', requireKey, (_req, res) => {
  const list = [];
  for (const [phone, s] of sessions.entries()) {
    list.push({ phone, status: s.status, lastError: s.lastError });
  }
  res.json({ ok: true, sessions: list });
});

app.get('/session/:phone', requireKey, (req, res) => {
  const phone = normalizePhone(req.params.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });
  const s = sessions.get(phone);
  if (!s) {
    if (fs.existsSync(authDir(phone)) && fs.readdirSync(authDir(phone)).length > 0) {
      return res.json({ ok: true, status: 'disconnected', phone });
    }
    return res.json({ ok: true, status: 'unknown', phone });
  }
  res.json({ ok: true, status: s.status, phone, error: s.lastError, lastCode: s.lastCode });
});

app.post('/pair', requireKey, async (req, res) => {
  let stage = 'validate';
  try {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone', stage });

    const existing = sessions.get(phone);
    if (existing && existing.status === 'connected') {
      return res.json({ ok: true, alreadyConnected: true, phone });
    }

    stage = 'start_socket';
    const { sock, session } = await startSocket(phone, { freshPair: true });
    session.startedAt = Date.now();
    session.status = 'pairing';
    session.lastCode = null;
    session.lastError = null;

    await new Promise((r) => setTimeout(r, 1500));

    stage = 'request_code';
    if (sock.authState?.creds?.registered) {
      return res.json({ ok: true, alreadyConnected: true, phone });
    }

    let code;
    try {
      code = await sock.requestPairingCode(phone);
    } catch (err) {
      log.error({ phone, err: err?.message }, 'requestPairingCode failed');
      session.status = 'failed';
      session.lastError = err?.message || 'requestPairingCode failed';
      return res.status(500).json({
        ok: false,
        error: err?.message || 'requestPairingCode failed',
        stage,
      });
    }

    if (!code) {
      session.status = 'failed';
      session.lastError = 'no_code_returned';
      return res.status(500).json({ ok: false, error: 'no_code_returned', stage });
    }

    const formatted = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
    session.lastCode = formatted;
    log.info({ phone, code: formatted }, 'pair code issued');
    res.json({ ok: true, code: formatted, phone });
  } catch (err) {
    log.error({ err: err?.message, stack: err?.stack }, 'pair handler error');
    res.status(500).json({
      ok: false,
      error: err?.message || String(err),
      stage,
      stack: (err?.stack || '').slice(0, 500),
    });
  }
});

app.post('/disconnect', requireKey, async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });
  const s = sessions.get(phone);
  if (s?.sock) {
    try { await s.sock.logout(); } catch (_) {}
  }
  sessions.delete(phone);
  try { fs.rmSync(authDir(phone), { recursive: true, force: true }); } catch (_) {}
  res.json({ ok: true, disconnected: phone });
});

app.listen(PORT, () => {
  log.info({ port: PORT, authRoot: AUTH_ROOT }, 'WA bridge listening');
});

// server.js — WhatsApp Bridge (Pairing Code Mode, multi-session)
import express from 'express';
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import P from 'pino';
import fs from 'fs';
import path from 'path';
import { Boom } from '@hapi/boom';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const AUTH_ROOT = process.env.AUTH_ROOT || './auth';
const API_TOKEN =
  process.env.BRIDGE_API_KEY ||
  process.env.API_KEY ||
  process.env.API_TOKEN ||
  '';

const sessions = new Map(); // phone -> { sock, status, pairingCode, lastError, registered, pairing }
const logger = P({ level: 'info' });

// ---------- helpers ----------
const normPhone = (p = '') => String(p).replace(/\D/g, '');
const authDir = (phone) => path.join(AUTH_ROOT, phone);
const ensureRoot = () => { if (!fs.existsSync(AUTH_ROOT)) fs.mkdirSync(AUTH_ROOT, { recursive: true }); };

function deleteSessionFiles(phone) {
  const dir = authDir(phone);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    logger.info({ phone }, '🗑️ Deleted session files');
  }
}

function checkAuth(req, res) {
  if (!API_TOKEN) return true;
  const t =
    req.headers['x-api-key'] ||
    req.headers['x-api-token'] ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (t !== API_TOKEN) { res.status(401).json({ error: 'Unauthorized' }); return false; }
  return true;
}

async function tearDown(phone) {
  const s = sessions.get(phone);
  if (s?.sock) {
    try { s.sock.ev.removeAllListeners(); } catch {}
    try { s.sock.end(undefined); } catch {}
    try { s.sock.ws?.close(); } catch {}
  }
  sessions.delete(phone);
}

// ---------- core ----------
async function startSock(phone, { forceReset = false, mode = 'code' } = {}) {
  ensureRoot();
  phone = normPhone(phone);

  if (forceReset) {
    await tearDown(phone);
    deleteSessionFiles(phone);
  }

  // Reuse if already alive and not forcing reset.
  const existing = sessions.get(phone);
  if (existing && !forceReset && existing.status !== 'logged_out') return existing;

  const dir = authDir(phone);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: ['Windows', 'Chrome', 'Chrome 114.0.5735.198'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
  });

  const session = {
    sock,
    status: 'connecting',
    pairingCode: null,
    lastError: null,
    registered: !!state.creds?.registered,
    pairing: false,
    pairReadyResolve: null,
  };
  sessions.set(phone, session);

  // Promise that resolves the first time Baileys is ready for pairing.
  const pairingReady = new Promise((resolve) => { session.pairReadyResolve = resolve; });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    logger.info({ phone, connection, hasQR: !!qr }, 'connection.update');

    // `qr` here is just the readiness signal — we never display it.
    if (qr && session.pairReadyResolve) {
      session.pairReadyResolve();
      session.pairReadyResolve = null;
    }

    if (connection === 'open') {
      session.status = 'connected';
      session.lastError = null;
      session.pairingCode = null;
      session.registered = true;
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
        return;
      }
      // 401 right after pairing is fatal — code is dead.
      if (code === 401 && session.pairing) {
        session.status = 'pair_failed';
        return;
      }
      session.status = session.registered ? 'disconnected' : 'pair_failed';
    }
  });

  // Request the pairing code, but only after Baileys signals readiness.
  if (mode === 'code' && !state.creds?.registered) {
    if (session.pairing) return session;
    session.pairing = true;
    (async () => {
      try {
        // Wait for the readiness signal, but cap it so we don't hang forever.
        await Promise.race([
          pairingReady,
          new Promise((res) => setTimeout(res, 8000)),
        ]);
        const code = await sock.requestPairingCode(phone);
        session.pairingCode = code;
        session.status = 'pairing_code_ready';
        logger.info({ phone, code }, '🔑 Pairing code generated');
      } catch (err) {
        session.lastError = err?.message || String(err);
        session.status = 'pair_failed';
        logger.error({ phone, err: session.lastError }, '⚠️ requestPairingCode failed');
      } finally {
        session.pairing = false;
      }
    })();
  }

  return session;
}

// Wait until session has a pairing code OR a terminal status, max ~12s.
async function waitForPairing(phone, maxMs = 12_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const s = sessions.get(phone);
    if (!s) break;
    if (s.pairingCode) return s;
    if (['connected', 'pair_failed', 'logged_out'].includes(s.status)) return s;
    await new Promise((r) => setTimeout(r, 250));
  }
  return sessions.get(phone);
}

// ---------- routes ----------
app.get('/health', (_req, res) => {
  const list = [...sessions.entries()].map(([phone, s]) => ({
    phone, status: s.status, registered: s.registered,
    hasPairingCode: !!s.pairingCode, lastError: s.lastError,
  }));
  res.json({ ok: true, sessions: list, uptime: process.uptime() });
});

app.get('/status/:phone', (req, res) => {
  if (!checkAuth(req, res)) return;
  const phone = normPhone(req.params.phone);
  const s = sessions.get(phone);
  if (!s) return res.json({ status: 'none' });
  res.json({
    status: s.status, pairingCode: s.pairingCode,
    lastError: s.lastError, registered: s.registered,
  });
});

app.post('/pair', async (req, res) => {
  if (!checkAuth(req, res)) return;
  const phone = normPhone(req.body?.phone);
  const mode = req.body?.mode || 'code';
  const forceReset = !!req.body?.forceReset;
  if (!phone) return res.status(400).json({ error: 'phone required' });

  try {
    await startSock(phone, { forceReset, mode });
    const s = await waitForPairing(phone);
    if (!s) return res.status(500).json({ ok: false, error: 'session vanished' });
    if (s.status === 'pair_failed') {
      return res.status(500).json({
        ok: false, error: s.lastError || 'pair_failed',
        stage: 'requestPairingCode', status: s.status,
      });
    }
    res.json({
      ok: true,
      status: s.status,
      pairingCode: s.pairingCode,
      registered: s.registered,
    });
  } catch (err) {
    res.status(500).json({
      ok: false, error: err?.message || String(err),
      stage: 'requestPairingCode',
    });
  }
});

// Reset / logout — accept multiple shapes the Edge Function tries.
async function doReset(phone) {
  if (!phone) return;
  await tearDown(phone);
  deleteSessionFiles(phone);
}

app.post('/logout', async (req, res) => {
  if (!checkAuth(req, res)) return;
  const phone = normPhone(req.query.session || req.body?.session || req.body?.phone);
  if (!phone) return res.status(400).json({ error: 'phone/session required' });
  await doReset(phone);
  res.json({ ok: true });
});

app.post('/reset', async (req, res) => {
  if (!checkAuth(req, res)) return;
  const phone = normPhone(req.query.session || req.body?.session || req.body?.phone);
  if (!phone) return res.status(400).json({ error: 'phone/session required' });
  await doReset(phone);
  res.json({ ok: true });
});

app.post('/session/:phone/logout', async (req, res) => {
  if (!checkAuth(req, res)) return;
  await doReset(normPhone(req.params.phone));
  res.json({ ok: true });
});

app.delete('/session/:phone', async (req, res) => {
  if (!checkAuth(req, res)) return;
  await doReset(normPhone(req.params.phone));
  res.json({ ok: true });
});

app.post('/send', async (req, res) => {
  if (!checkAuth(req, res)) return;
  const phone = normPhone(req.body?.phone);
  const { to, message } = req.body || {};
  if (!phone || !to || !message) return res.status(400).json({ error: 'phone, to, message required' });
  const s = sessions.get(phone);
  if (!s?.sock || s.status !== 'connected') {
    return res.status(409).json({ error: 'Not connected', status: s?.status || 'none' });
  }
  try {
    const jid = String(to).includes('@') ? to : `${normPhone(to)}@s.whatsapp.net`;
    await s.sock.sendMessage(jid, { text: message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`🚀 Bridge listening on ${PORT}`);
  logger.info(`AUTH_ROOT: ${AUTH_ROOT}`);
});

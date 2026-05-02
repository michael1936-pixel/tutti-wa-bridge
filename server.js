// Tutti WhatsApp Bridge — Railway edition (pairing v3 — split QR / pair-code paths)
// GET  /status -> diagnostics
// GET  /qr     -> HTML auto-refresh QR (only when in QR mode)
// GET  /qr.png -> raw QR image
// GET  /groups -> list groups (X-Api-Key)
// POST /send   -> { jid, text } (X-Api-Key)
// POST /pair   -> { phone } -> { ok, code } (X-Api-Key)
// POST /reset  -> wipe + restart (X-Api-Key)

import express from 'express';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'fs/promises';
import {
  default as makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || '';
const AUTH_DIR = process.env.AUTH_DIR || './auth';

const logger = pino({ level: 'info' });
const app = express();
app.use(express.json({ limit: '1mb' }));

app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  next();
});

let sock = null;
let latestQR = null;
let connected = false;
let meUser = null;
let starting = false;

let mode = 'qr';                  // 'qr' | 'pair'
let pairingInProgress = false;
let connectionState = 'idle';     // 'idle' | 'connecting' | 'open' | 'close'
let credsRegistered = false;
let lastPairError = null;
let lastDisconnectCode = null;
let pairStartedAt = null;
let pairCodeIssuedAt = null;
let currentSockId = 0;            // monotonically increasing — used to ignore stale events

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function isWsOpen() {
  const ws = sock?.ws;
  if (!ws) return false;
  if (typeof ws.readyState === 'number') return ws.readyState === 1;
  if (typeof ws.socket?.readyState === 'number') return ws.socket.readyState === 1;
  return false;
}

async function killSocket() {
  try { sock?.ev?.removeAllListeners?.(); } catch {}
  try { sock?.end?.(undefined); } catch {}
  try { sock?.ws?.close?.(); } catch {}
  sock = null;
  latestQR = null;
  connected = false;
  meUser = null;
  connectionState = 'idle';
  credsRegistered = false;
}

async function start({ pairMode = false } = {}) {
  if (starting) { logger.warn('start() already running'); return; }
  starting = true;
  mode = pairMode ? 'pair' : 'qr';
  const myId = ++currentSockId;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    credsRegistered = !!state?.creds?.registered;

    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
      },
      browser: Browsers.macOS('Google Chrome'), // Baileys default that works for pairing
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
      emitOwnEvents: true,
      markOnlineOnConnect: true,
      syncFullHistory: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
      const WEBHOOK_URL = process.env.LOVABLE_WEBHOOK_URL;
      const WEBHOOK_SECRET = process.env.LOVABLE_WEBHOOK_SECRET;
      const STATION_ID = process.env.DEFAULT_STATION_ID;
      if (!WEBHOOK_URL || !WEBHOOK_SECRET || !STATION_ID) return;
      for (const msg of messages || []) {
        try {
          if (!msg?.key || msg.key.fromMe) continue;
          const jid = msg.key.remoteJid || '';
          if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast')) continue;
          const text =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption || '';
          if (!text) continue;
          const driverPhone = jid.split('@')[0].split(':')[0];
          await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-bridge-secret': WEBHOOK_SECRET },
            body: JSON.stringify({ station_id: STATION_ID, driver_phone: driverPhone, text, direction: 'incoming' }),
          });
        } catch (e) {
          logger.error({ err: String(e?.message || e) }, 'forward failed');
        }
      }
    });

    sock.ev.on('connection.update', async (update) => {
      if (myId !== currentSockId) return; // stale socket — ignore
      const { connection, lastDisconnect, qr } = update;
      if (connection) connectionState = connection;

      // In pair mode we MUST NOT serve a QR
      if (qr && mode !== 'pair') {
        latestQR = qr;
      }

      if (connection === 'open') {
        connected = true;
        latestQR = null;
        pairingInProgress = false;
        credsRegistered = true;
        meUser = sock?.user?.id || null;
        logger.info({ user: meUser }, 'WhatsApp connected');
      }
      if (connection === 'close') {
        connected = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        lastDisconnectCode = code ?? null;
        logger.warn({ code, mode, pairingInProgress }, 'connection closed');
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        // Don't auto-restart while user is typing a pairing code
        if (shouldReconnect && !pairingInProgress) {
          setTimeout(() => start({ pairMode: false }).catch(() => {}), 2000);
        }
      }
    });
  } finally {
    starting = false;
  }
}

start({ pairMode: false }).catch((e) => logger.error(e, 'failed to start Baileys'));

function requireKey(req, res, next) {
  if (!API_KEY) return res.status(500).json({ error: 'API_KEY not configured' });
  if (req.headers['x-api-key'] !== API_KEY) return res.status(401).json({ error: 'invalid api key' });
  next();
}

app.get('/status', (_req, res) => {
  res.json({
    connected,
    hasQR: !!latestQR,
    wsOpen: isWsOpen(),
    connectionState,
    mode,
    pairing: pairingInProgress,
    credsRegistered,
    lastPairError,
    lastDisconnectCode,
    pairStartedAt,
    pairCodeIssuedAt,
    user: meUser,
    uptime: process.uptime(),
  });
});

app.get('/qr.png', async (_req, res) => {
  if (!latestQR) return res.status(404).send('no QR');
  const buf = await QRCode.toBuffer(latestQR, { width: 320, margin: 1 });
  res.setHeader('Content-Type', 'image/png');
  res.send(buf);
});

app.get('/qr', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<title>חיבור WhatsApp</title><meta http-equiv="refresh" content="5">
<style>body{font-family:system-ui;text-align:center;padding:24px}</style></head>
<body><h2>חיבור WhatsApp ל-Tutti</h2>
<img src="/qr.png?t=${Date.now()}" alt="QR"/></body></html>`);
});

app.get('/groups', requireKey, async (_req, res) => {
  if (!connected || !sock) return res.status(503).json({ error: 'not connected' });
  try {
    const all = await sock.groupFetchAllParticipating();
    res.json({ groups: Object.values(all).map(g => ({ id: g.id, subject: g.subject, size: g.participants?.length ?? 0 })) });
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});

app.post('/send', requireKey, async (req, res) => {
  if (!connected || !sock) return res.status(503).json({ error: 'not connected' });
  const { jid, text } = req.body || {};
  if (!jid || !text) return res.status(400).json({ error: 'jid and text required' });
  try {
    const result = await sock.sendMessage(jid, { text });
    res.json({ ok: true, messageId: result?.key?.id || null });
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});

app.post('/pair', requireKey, async (req, res) => {
  try {
    const raw = String(req.body?.phone || '').replace(/\D/g, '');
    if (!raw || raw.length < 10) return res.status(400).json({ error: 'invalid phone (E.164 digits, no +)' });

    if (connected && isWsOpen()) {
      return res.json({ ok: true, alreadyConnected: true });
    }

    pairingInProgress = true;
    lastPairError = null;
    pairStartedAt = new Date().toISOString();
    pairCodeIssuedAt = null;

    // Hard reset: kill socket + wipe creds, then start FRESH in pair-mode
    await killSocket();
    try {
      await fs.rm(AUTH_DIR, { recursive: true, force: true });
      await fs.mkdir(AUTH_DIR, { recursive: true });
    } catch (e) {
      logger.warn({ err: String(e?.message || e) }, 'auth dir reset issue');
    }

    await start({ pairMode: true });

    // Wait for THIS socket to reach 'connecting' — per Baileys docs it must be called then.
    const myId = currentSockId;
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      if (myId === currentSockId &&
          sock &&
          typeof sock.requestPairingCode === 'function' &&
          !sock.authState?.creds?.registered &&
          (connectionState === 'connecting' || isWsOpen())) {
        break;
      }
      await sleep(150);
    }

    if (!sock || typeof sock.requestPairingCode !== 'function') {
      pairingInProgress = false;
      lastPairError = 'socket not ready';
      return res.status(503).json({ error: 'socket not ready for pairing' });
    }

    // Extra grace so the WS handshake fully completes
    await sleep(800);

    const code = await sock.requestPairingCode(raw);
    pairCodeIssuedAt = new Date().toISOString();
    logger.info({ phone: raw, code }, 'issued pairing code');
    // pairingInProgress stays true until 'open' fires — prevents auto-restart from killing the link.
    return res.json({ ok: true, code, codeFormatted: code?.length === 8 ? `${code.slice(0,4)}-${code.slice(4)}` : code });
  } catch (e) {
    pairingInProgress = false;
    lastPairError = String(e?.message || e);
    logger.error({ err: lastPairError }, 'pair failed');
    return res.status(500).json({ error: lastPairError || 'pair failed' });
  }
});

app.post('/reset', requireKey, async (_req, res) => {
  try {
    pairingInProgress = false;
    await killSocket();
    await fs.rm(AUTH_DIR, { recursive: true, force: true });
    await fs.mkdir(AUTH_DIR, { recursive: true });
    await start({ pairMode: false });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});

app.listen(PORT, () => logger.info(`Bridge listening on :${PORT}`));

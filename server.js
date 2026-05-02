// Tutti WhatsApp Bridge — Railway edition (pairing-fixed)
// Endpoints:
//   GET  /status   -> { connected, hasQR, wsOpen, connectionState, pairing, lastPairError, user }
//   GET  /qr       -> HTML page (auto-refresh QR)
//   GET  /qr.png   -> raw QR image
//   GET  /groups   -> [{ id, subject, size }]                (X-Api-Key)
//   POST /send     -> { jid, text }                          (X-Api-Key)
//   POST /pair     -> { phone } -> { ok, code | alreadyConnected } (X-Api-Key)
//   POST /reset    -> wipes auth dir, restarts socket        (X-Api-Key)

import express from 'express';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'fs/promises';
import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
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
let pairingInProgress = false;     // when true, suppress auto-restart
let connectionState = 'idle';       // 'idle' | 'connecting' | 'open' | 'close'
let lastPairError = null;

function isWsOpen() {
  const ws = sock?.ws;
  if (!ws) return false;
  if (typeof ws.readyState === 'number') return ws.readyState === 1;
  if (typeof ws.socket?.readyState === 'number') return ws.socket.readyState === 1;
  return false;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function start() {
  if (starting) { logger.warn('start() already running'); return; }
  starting = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['Tutti Bridge', 'Chrome', '1.0.0'],
      // Important for pairing-code flow: don't fire QR events
      // (Baileys will still emit 'connecting' which we wait for)
    });

    sock.ev.on('creds.update', saveCreds);

    // Forward incoming private messages to Lovable
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
          const r = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-bridge-secret': WEBHOOK_SECRET },
            body: JSON.stringify({ station_id: STATION_ID, driver_phone: driverPhone, text, direction: 'incoming' }),
          });
          logger.info({ status: r.status, driverPhone }, 'forwarded incoming msg');
        } catch (e) {
          logger.error({ err: String(e?.message || e) }, 'forward failed');
        }
      }
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (connection) connectionState = connection;
      if (qr) {
        latestQR = qr;
        logger.info('QR generated');
      }
      if (connection === 'open') {
        connected = true;
        latestQR = null;
        pairingInProgress = false;
        meUser = sock.user?.id || null;
        logger.info({ user: meUser }, 'WhatsApp connected');
      }
      if (connection === 'close') {
        connected = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        logger.warn({ code, pairingInProgress }, 'connection closed');
        // Don't fight a pairing flow with auto-restart
        if (shouldReconnect && !pairingInProgress) {
          setTimeout(() => start().catch(() => {}), 2000);
        }
      }
    });
  } finally {
    starting = false;
  }
}

start().catch((e) => logger.error(e, 'failed to start Baileys'));

function requireKey(req, res, next) {
  if (!API_KEY) return res.status(500).json({ error: 'API_KEY not configured' });
  if (req.headers['x-api-key'] !== API_KEY) return res.status(401).json({ error: 'invalid api key' });
  next();
}

app.get('/status', (_req, res) => {
  res.json({
    connected, hasQR: !!latestQR, wsOpen: isWsOpen(),
    connectionState, pairing: pairingInProgress,
    lastPairError, user: meUser, uptime: process.uptime(),
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

// --- Pairing code ---
app.post('/pair', requireKey, async (req, res) => {
  try {
    const raw = String(req.body?.phone || '').replace(/\D/g, '');
    if (!raw || raw.length < 10) return res.status(400).json({ error: 'invalid phone (E.164 digits, no +)' });

    if (connected && isWsOpen()) {
      return res.json({ ok: true, alreadyConnected: true });
    }

    pairingInProgress = true;
    lastPairError = null;

    // Always start fresh: close current socket, wipe auth, start new one
    try { sock?.end?.(undefined); } catch {}
    try { sock?.ws?.close?.(); } catch {}
    sock = null;
    connected = false;
    meUser = null;
    latestQR = null;
    connectionState = 'idle';

    try {
      await fs.rm(AUTH_DIR, { recursive: true, force: true });
      await fs.mkdir(AUTH_DIR, { recursive: true });
    } catch (e) {
      logger.warn({ err: String(e?.message || e) }, 'auth dir reset issue');
    }

    await start();

    // CRITICAL: wait until socket is in 'connecting' state (or QR fired) before requesting code.
    // Per Baileys docs, requestPairingCode must be called after the socket starts connecting.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (sock && (connectionState === 'connecting' || latestQR) &&
          typeof sock.requestPairingCode === 'function' &&
          !sock.authState?.creds?.registered) {
        break;
      }
      await sleep(150);
    }

    if (!sock || typeof sock.requestPairingCode !== 'function') {
      pairingInProgress = false;
      lastPairError = 'socket not ready';
      return res.status(503).json({ error: 'socket not ready for pairing' });
    }

    // Small extra grace so the WS handshake fully completes
    await sleep(500);

    const code = await sock.requestPairingCode(raw);
    const formatted = code && code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
    logger.info({ phone: raw, code: formatted }, 'issued pairing code');
    // Keep pairingInProgress=true so auto-restart doesn't kill the socket
    // before the user types the code. It's cleared on 'open'.
    return res.json({ ok: true, code: formatted });
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
    try { sock?.end?.(undefined); } catch {}
    try { sock?.ws?.close?.(); } catch {}
    sock = null; connected = false; meUser = null; latestQR = null; connectionState = 'idle';
    await fs.rm(AUTH_DIR, { recursive: true, force: true });
    await fs.mkdir(AUTH_DIR, { recursive: true });
    await start();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});

app.listen(PORT, () => logger.info(`Bridge listening on :${PORT}`));

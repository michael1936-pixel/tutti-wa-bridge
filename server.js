// Tutti WhatsApp Bridge — Railway edition
// Endpoints:
//   GET  /status         -> { connected, hasQR, user }
//   GET  /qr             -> HTML page that auto-refreshes the QR until paired
//   GET  /qr.png         -> raw QR image (when pairing)
//   GET  /groups         -> [{ id, subject, size }]    (X-Api-Key required)
//   POST /send           -> { jid, text }              (X-Api-Key required)
//   POST /pair           -> { phone } -> { ok, code }  (X-Api-Key required)
//
// Session is persisted to AUTH_DIR (mount a Railway Volume there).

import express from 'express';
import pino from 'pino';
import QRCode from 'qrcode';
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

// CORS — allow the Lovable app + browser QR scanning
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
let usePairingCode = false; // when true, suppress QR output for the next session

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Tutti Bridge', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  // === Forward incoming private messages to Lovable ===
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
          msg.message?.imageMessage?.caption ||
          '';
        if (!text) continue;

        const driverPhone = jid.split('@')[0].split(':')[0];

        const r = await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-bridge-secret': WEBHOOK_SECRET,
          },
          body: JSON.stringify({
            station_id: STATION_ID,
            driver_phone: driverPhone,
            text,
            direction: 'incoming',
          }),
        });
        logger.info({ status: r.status, driverPhone }, 'forwarded incoming msg');
      } catch (e) {
        logger.error({ err: String(e?.message || e) }, 'forward failed');
      }
    }
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      latestQR = qr;
      logger.info('QR generated — open /qr in browser');
    }
    if (connection === 'open') {
      connected = true;
      latestQR = null;
      usePairingCode = false;
      meUser = sock.user?.id || null;
      logger.info({ user: meUser }, 'WhatsApp connected');
    }
    if (connection === 'close') {
      connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      logger.warn({ code }, 'connection closed');
      if (shouldReconnect) setTimeout(start, 2000);
    }
  });
}

start().catch((e) => logger.error(e, 'failed to start Baileys'));

// --- Auth middleware for protected endpoints ---
function requireKey(req, res, next) {
  if (!API_KEY) return res.status(500).json({ error: 'API_KEY not configured' });
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'invalid api key' });
  }
  next();
}

// --- Endpoints ---
app.get('/status', (_req, res) => {
  res.json({
    connected,
    hasQR: !!latestQR,
    user: meUser,
    uptime: process.uptime(),
  });
});

app.get('/qr.png', async (_req, res) => {
  if (!latestQR) return res.status(404).send('no QR (already paired or not initialized)');
  const buf = await QRCode.toBuffer(latestQR, { width: 320, margin: 1 });
  res.setHeader('Content-Type', 'image/png');
  res.send(buf);
});

app.get('/qr', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"><title>WhatsApp QR</title>
<meta http-equiv="refresh" content="5"></head>
<body style="font-family:system-ui;text-align:center;padding:24px">
<h2>חיבור WhatsApp ל-Tutti</h2>
<p>פתח/י WhatsApp → מכשירים מקושרים → קישור מכשיר, וסרק/י את הקוד.</p>
<img src="/qr.png" alt="QR" style="max-width:320px"/>
<p>הדף מתרענן אוטומטית כל 5 שניות.</p>
</body></html>`);
});

app.get('/groups', requireKey, async (_req, res) => {
  if (!connected || !sock) return res.status(503).json({ error: 'not connected' });
  try {
    const all = await sock.groupFetchAllParticipating();
    const groups = Object.values(all).map((g) => ({
      id: g.id,
      subject: g.subject,
      size: g.participants?.length ?? 0,
    }));
    res.json({ groups });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post('/send', requireKey, async (req, res) => {
  if (!connected || !sock) return res.status(503).json({ error: 'not connected' });
  const { jid, text } = req.body || {};
  if (!jid || !text) return res.status(400).json({ error: 'jid and text required' });
  try {
    const result = await sock.sendMessage(jid, { text });
    res.json({ ok: true, messageId: result?.key?.id || null });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// --- Pairing code (link via phone number, not QR) ---
app.post('/pair', requireKey, async (req, res) => {
  try {
    if (!sock) return res.status(503).json({ error: 'socket not initialized' });
    if (connected || sock.user) {
      return res.json({ ok: true, alreadyConnected: true });
    }

    const raw = String(req.body?.phone || '').replace(/\D/g, '');
    if (!raw || raw.length < 10) {
      return res.status(400).json({ error: 'invalid phone (E.164 digits, no +)' });
    }

    if (typeof sock.requestPairingCode !== 'function') {
      return res.status(500).json({ error: 'pairing code not supported by this Baileys version' });
    }

    usePairingCode = true;
    const code = await sock.requestPairingCode(raw);
    const formatted = code && code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
    logger.info({ phone: raw }, 'issued pairing code');
    return res.json({ ok: true, code: formatted });
  } catch (e) {
    logger.error({ err: String(e?.message || e) }, 'pair failed');
    return res.status(500).json({ error: String(e?.message || e) || 'pair failed' });
  }
});

app.listen(PORT, () => logger.info(`Bridge listening on :${PORT}`));

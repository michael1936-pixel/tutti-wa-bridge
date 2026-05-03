import express from 'express';
import * as baileysPkg from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';

// ✅ תמיכה גם ב-default export וגם ב-named export של Baileys
const makeWASocket = baileysPkg.default ?? baileysPkg.makeWASocket;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileysPkg;

const logger = pino({ level: 'info' });
const app = express();
app.use(express.json({ limit: '10mb' }));

const API_KEY = process.env.BRIDGE_API_KEY || process.env.API_KEY;
const WEBHOOK_URL = process.env.LOVABLE_WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.LOVABLE_WEBHOOK_SECRET || process.env.WA_BRIDGE_WEBHOOK_SECRET;

const sessions = {};

// ─── Auth middleware ──────────────────────────────────────────
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!API_KEY || key !== API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ─── Start / restore a WhatsApp session ───────────────────────
async function startSession(sessionId) {
  if (sessions[sessionId]?.sock) {
    logger.info(`Session ${sessionId} already running`);
    return sessions[sessionId].sock;
  }

  const authDir = path.join('./auth', sessionId);
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    version,
    browser: ['LovableBridge', 'Chrome', '120.0.0'],
  });

  sessions[sessionId] = { sock, status: 'connecting', qr: null };

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      sessions[sessionId].qr = qr;
      qrcode.generate(qr, { small: true });
      logger.info(`QR for ${sessionId} ready`);
    }
    if (connection === 'open') {
      sessions[sessionId].status = 'connected';
      sessions[sessionId].qr = null;
      logger.info(`✅ Session ${sessionId} connected`);
    }
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      sessions[sessionId].status = 'disconnected';
      logger.warn(`Session ${sessionId} closed (code=${code}). reconnect=${shouldReconnect}`);
      delete sessions[sessionId].sock;
      if (shouldReconnect) setTimeout(() => startSession(sessionId), 3000);
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    if (!WEBHOOK_URL) return;
    try {
      await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-secret': WEBHOOK_SECRET || '',
        },
        body: JSON.stringify({ sessionId, payload: m }),
      });
    } catch (e) {
      logger.error({ e: e.message }, 'webhook failed');
    }
  });

  return sock;
}

// ─── Routes ───────────────────────────────────────────────────
app.post('/session/:id/start', requireApiKey, async (req, res) => {
  try {
    await startSession(req.params.id);
    res.json({ ok: true, status: sessions[req.params.id]?.status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/session/:id/qr', requireApiKey, (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'no session' });
  res.json({ status: s.status, qr: s.qr });
});

app.post('/send', requireApiKey, async (req, res) => {
  const { sessionId, jid, message } = req.body || {};
  if (!sessionId || !jid || !message) {
    return res.status(400).json({ error: 'missing sessionId/jid/message' });
  }
  try {
    if (!sessions[sessionId]?.sock) await startSession(sessionId);
    const sock = sessions[sessionId]?.sock;
    if (!sock) return res.status(503).json({ error: 'session not ready' });

    const payload = typeof message === 'string' ? { text: message } : message;
    const result = await sock.sendMessage(jid, payload);
    res.json({ ok: true, id: result?.key?.id });
  } catch (e) {
    logger.error({ e: e.message }, 'send failed');
    res.status(500).json({ error: e.message });
  }
});

// ─── Healthcheck endpoints (Railway בודק את /status) ─────────
app.get('/status', (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    sessions: Object.keys(sessions).map((id) => ({
      id,
      status: sessions[id]?.status,
    })),
    time: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/', (req, res) => res.json({ ok: true, service: 'wa-bridge' }));

// ─── Boot ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`🚀 Bridge listening on :${PORT}`);
  if (fs.existsSync('./auth')) {
    for (const dir of fs.readdirSync('./auth')) {
      logger.info(`Restoring session ${dir}`);
      startSession(dir).catch((e) =>
        logger.error({ e: e.message }, `restore ${dir} failed`)
      );
    }
  }
});

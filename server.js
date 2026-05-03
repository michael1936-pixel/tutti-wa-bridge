import express from 'express';
import * as baileysPkg from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';

// ✅ Fix: תמיכה גם ב-default export וגם ב-named export
const makeWASocket = baileysPkg.default ?? baileysPkg.makeWASocket;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = baileysPkg;

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.BRIDGE_API_KEY || process.env.API_KEY;
const WEBHOOK_SECRET = process.env.WA_BRIDGE_WEBHOOK_SECRET;
const LOVABLE_WEBHOOK_URL = process.env.LOVABLE_WEBHOOK_URL;

const logger = pino({ level: 'info' });
const sessions = new Map(); // sessionId -> sock

// ---------- Auth middleware ----------
function checkAuth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!API_KEY || key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ---------- Start / restore session ----------
async function startSession(sessionId) {
  if (sessions.has(sessionId)) return sessions.get(sessionId);

  const authDir = path.join('./auth', sessionId);
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      logger.info(`[${sessionId}] QR code:`);
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      logger.warn(`[${sessionId}] closed. reconnect=${shouldReconnect}`);
      sessions.delete(sessionId);
      if (shouldReconnect) setTimeout(() => startSession(sessionId), 3000);
    } else if (connection === 'open') {
      logger.info(`[${sessionId}] ✅ connected`);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    if (!LOVABLE_WEBHOOK_URL) return;
    try {
      await fetch(LOVABLE_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-secret': WEBHOOK_SECRET || '',
        },
        body: JSON.stringify({ sessionId, messages }),
      });
    } catch (e) {
      logger.error({ e: e.message }, 'webhook failed');
    }
  });

  sessions.set(sessionId, sock);
  return sock;
}

// ---------- Routes ----------
app.get('/health', (_req, res) => {
  res.json({ ok: true, sessions: [...sessions.keys()] });
});

app.post('/session/start', checkAuth, async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  try {
    await startSession(sessionId);
    res.json({ ok: true, sessionId });
  } catch (e) {
    logger.error({ e: e.message }, 'start failed');
    res.status(500).json({ error: e.message });
  }
});

app.post('/send', checkAuth, async (req, res) => {
  const { sessionId, jid, message } = req.body;
  if (!sessionId || !jid || !message) {
    return res.status(400).json({ error: 'sessionId, jid, message required' });
  }
  try {
    let sock = sessions.get(sessionId);
    if (!sock) sock = await startSession(sessionId);

    const payload =
      typeof message === 'string' ? { text: message } : message;

    const result = await sock.sendMessage(jid, payload);
    res.json({ ok: true, id: result?.key?.id });
  } catch (e) {
    logger.error({ e: e.message, stack: e.stack }, 'send failed');
    res.status(503).json({ error: e.message });
  }
});

// ---------- Boot ----------
app.listen(PORT, async () => {
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

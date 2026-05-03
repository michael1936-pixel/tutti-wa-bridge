import express from 'express';
import * as baileysPkg from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';

// ✅ זיהוי חכם של makeWASocket מכל וריאציות הייצוא של Baileys
const makeWASocket =
  (typeof baileysPkg.makeWASocket === 'function' && baileysPkg.makeWASocket) ||
  (typeof baileysPkg.default === 'function' && baileysPkg.default) ||
  (baileysPkg.default && typeof baileysPkg.default.makeWASocket === 'function' && baileysPkg.default.makeWASocket);

if (typeof makeWASocket !== 'function') {
  console.error('❌ makeWASocket not found. Available keys:', Object.keys(baileysPkg));
  if (baileysPkg.default) {
    console.error('   default keys:', Object.keys(baileysPkg.default));
  }
  throw new Error('makeWASocket is not a function — check @whiskeysockets/baileys version');
}

const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} =
  baileysPkg.default && typeof baileysPkg.default === 'object'
    ? { ...baileysPkg, ...baileysPkg.default }
    : baileysPkg;

// ─── Setup ────────────────────────────────────────────────────
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const API_KEY = process.env.API_KEY || '';
const app = express();
app.use(express.json({ limit: '2mb' }));

const sessions = new Map(); // sessionId -> { sock, status, qr }

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (key !== API_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ─── Session management ───────────────────────────────────────
async function startSession(sessionId) {
  const dir = path.join('./auth', sessionId);
  fs.mkdirSync(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Lovable Bridge', 'Chrome', '1.0'],
  });

  const entry = { sock, status: 'connecting', qr: null };
  sessions.set(sessionId, entry);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      entry.qr = qr;
      entry.status = 'qr';
      qrcode.generate(qr, { small: true });
      logger.info(`📱 QR ready for ${sessionId}`);
    }
    if (connection === 'open') {
      entry.status = 'connected';
      entry.qr = null;
      logger.info(`✅ Session ${sessionId} connected`);
    }
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      entry.status = 'disconnected';
      logger.warn({ code }, `⚠️ ${sessionId} closed`);
      if (shouldReconnect) {
        setTimeout(() => startSession(sessionId).catch(() => {}), 3000);
      } else {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
        sessions.delete(sessionId);
      }
    }
  });

  return entry;
}

// ─── Routes ───────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, sessions: [...sessions.keys()] }));

app.post('/session/start', requireApiKey, async (req, res) => {
  const sessionId = req.body?.sessionId || req.body?.session;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  try {
    const entry = sessions.get(sessionId) || (await startSession(sessionId));
    res.json({ sessionId, status: entry.status, qr: entry.qr });
  } catch (e) {
    logger.error({ e: e.message }, 'session/start failed');
    res.status(500).json({ error: e.message });
  }
});

app.get('/session/:id/status', requireApiKey, (req, res) => {
  const entry = sessions.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'not found' });
  res.json({ status: entry.status, qr: entry.qr });
});

app.post('/session/:id/logout', requireApiKey, async (req, res) => {
  const entry = sessions.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'not found' });
  try { await entry.sock.logout(); } catch {}
  sessions.delete(req.params.id);
  try { fs.rmSync(path.join('./auth', req.params.id), { recursive: true, force: true }); } catch {}
  res.json({ ok: true });
});

// ✅ /send — תאימות לשני פורמטים: { sessionId|session, jid|to, message|text }
app.post('/send', requireApiKey, async (req, res) => {
  const body = req.body || {};
  const sessionId = body.sessionId || body.session;
  const jid = body.jid || body.to;
  const message = body.message ?? body.text;

  if (!sessionId || !jid || message === undefined || message === null) {
    return res.status(400).json({
      error: 'sessionId, jid and message are required',
      received: { sessionId: !!sessionId, jid: !!jid, message: message !== undefined },
    });
  }

  const entry = sessions.get(sessionId);
  if (!entry || entry.status !== 'connected') {
    return res.status(409).json({ error: 'session not connected', status: entry?.status || 'missing' });
  }

  try {
    const target = String(jid).includes('@') ? jid : `${String(jid).replace(/\D/g, '')}@s.whatsapp.net`;
    const payload = typeof message === 'string' ? { text: message } : message;
    const result = await entry.sock.sendMessage(target, payload);
    res.json({ ok: true, id: result?.key?.id || null });
  } catch (e) {
    logger.error({ e: e.message }, 'send failed');
    res.status(500).json({ error: e.message });
  }
});

app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

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

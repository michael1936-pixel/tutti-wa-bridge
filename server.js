const express = require('express');
const fs = require('fs');
const QRCode = require('qrcode');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const AUTH_DIR = '/app/auth';

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

const logger = pino({ level: 'info' });

let sock = null;
let connected = false;
let lastQR = null;
let lastQRDataUrl = null;
let startingUp = false;

async function startSock() {
  if (startingUp) return;
  startingUp = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['WA-Bridge', 'Chrome', '1.0'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr) {
        lastQR = qr;
        try { lastQRDataUrl = await QRCode.toDataURL(qr); } catch { lastQRDataUrl = null; }
        logger.info('QR updated');
      }
      if (connection === 'open') {
        connected = true;
        lastQR = null;
        lastQRDataUrl = null;
        logger.info('WhatsApp connected');
      }
      if (connection === 'close') {
        connected = false;
        const code = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output.statusCode
          : 0;
        const loggedOut = code === DisconnectReason.loggedOut;
        logger.info({ code, loggedOut }, 'connection closed');
        if (loggedOut) {
          try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
          fs.mkdirSync(AUTH_DIR, { recursive: true });
        }
        startingUp = false;
        setTimeout(() => startSock().catch(e => logger.error(e)), 2000);
      }
    });
  } catch (e) {
    logger.error(e, 'startSock failed');
    startingUp = false;
    setTimeout(() => startSock().catch(err => logger.error(err)), 5000);
    return;
  }
  startingUp = false;
}

const app = express();
app.use(express.json({ limit: '1mb' }));

function requireKey(req, res, next) {
  if (!API_KEY) return next();
  const k = req.header('x-api-key') || req.header('X-Api-Key');
  if (k !== API_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// Public — Railway healthcheck
app.get('/status', (_req, res) => {
  res.json({ ok: true, connected, hasQR: !!lastQR });
});

app.get('/qr', requireKey, (_req, res) => {
  if (connected) return res.json({ connected: true });
  if (!lastQRDataUrl) return res.status(404).json({ error: 'no QR yet, try again in a few seconds' });
  res.json({ connected: false, qr: lastQR, dataUrl: lastQRDataUrl });
});

app.post('/send', requireKey, async (req, res) => {
  try {
    if (!connected || !sock) return res.status(503).json({ error: 'not connected' });
    const { jid, text } = req.body || {};
    if (!jid || typeof text !== 'string') {
      return res.status(400).json({ error: 'jid and text required' });
    }
    await sock.sendMessage(jid, { text });
    res.json({ ok: true });
  } catch (e) {
    logger.error(e, 'send failed');
    res.status(500).json({ error: e?.message || 'send failed' });
  }
});

app.get('/groups', requireKey, async (_req, res) => {
  try {
    if (!connected || !sock) return res.status(503).json({ error: 'not connected' });
    const groups = await sock.groupFetchAllParticipating();
    const list = Object.values(groups).map(g => ({ jid: g.id, name: g.subject }));
    res.json({ groups: list });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'groups failed' });
  }
});

app.listen(PORT, () => {
  logger.info(`HTTP listening on ${PORT}`);
  startSock().catch(e => logger.error(e));
});

// WhatsApp Multi-Session Bridge for Lovable
// Each "session" is a phone number (e.g. "972501234567") with its own auth folder.
//
// ENV:
//   PORT              (default 3000)
//   API_KEY           shared secret, must match WHATSAPP_VPS_API_KEY in Lovable
//   AUTH_DIR          base dir for auth folders (default ./auth)
//   DEFAULT_SESSION   optional fallback session id when request omits ?session=

import express from 'express';
import pino from 'pino';
import qrcode from 'qrcode';
import {
  default as makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import path from 'path';
import fs from 'fs';

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || '';
const AUTH_DIR = process.env.AUTH_DIR || path.resolve('./auth');
const DEFAULT_SESSION = process.env.DEFAULT_SESSION || '';
const logger = pino({ level: 'info' });

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// sessionId -> { sock, status, qr, lastError, startedAt }
const sessions = new Map();

function sanitizeSession(s) {
  const v = String(s || '').replace(/[^0-9a-zA-Z_-]/g, '');
  return v.slice(0, 32);
}

function pickSession(req) {
  const raw = req.query.session || req.body?.session || DEFAULT_SESSION;
  const id = sanitizeSession(raw);
  return id || null;
}

async function getOrCreateSession(sessionId) {
  if (sessions.has(sessionId)) return sessions.get(sessionId);

  const folder = path.join(AUTH_DIR, sessionId);
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(folder);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.macOS('Chrome'),
    logger: pino({ level: 'warn' }),
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  const entry = {
    sock,
    status: 'connecting',
    qr: null,
    qrDataUrl: null,
    lastError: null,
    startedAt: Date.now(),
    me: null,
  };
  sessions.set(sessionId, entry);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      entry.qr = qr;
      try { entry.qrDataUrl = await qrcode.toDataURL(qr); } catch (_) {}
      entry.status = 'qr';
    }
    if (connection === 'open') {
      entry.status = 'connected';
      entry.qr = null;
      entry.qrDataUrl = null;
      entry.me = sock.user || null;
      logger.info({ sessionId }, 'session connected');
    }
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      entry.status = 'disconnected';
      entry.lastError = lastDisconnect?.error?.message || String(code || 'closed');
      sessions.delete(sessionId);
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(() => {
          getOrCreateSession(sessionId).catch((e) =>
            logger.error({ err: e, sessionId }, 'reconnect failed'),
          );
        }, 2000);
      } else {
        try { fs.rmSync(folder, { recursive: true, force: true }); } catch (_) {}
      }
    }
  });

  return entry;
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  if (!API_KEY) return next();
  const k = req.header('X-Api-Key');
  if (k !== API_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, sessions: Array.from(sessions.keys()) });
});

// GET /status?session=972...
app.get('/status', async (req, res) => {
  const sessionId = pickSession(req);
  if (!sessionId) return res.status(400).json({ ok: false, error: 'session required' });
  try {
    const s = await getOrCreateSession(sessionId);
    res.json({
      ok: true,
      session: sessionId,
      status: s.status,
      reachable: true,
      me: s.me ? { id: s.me.id, name: s.me.name } : null,
      qr: s.qrDataUrl,
      lastError: s.lastError,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /pair  { phone, session }
app.post('/pair', async (req, res) => {
  const sessionId = pickSession(req);
  const phone = String(req.body?.phone || '').replace(/\D/g, '');
  if (!sessionId) return res.status(400).json({ ok: false, error: 'session required' });
  if (!phone) return res.status(400).json({ ok: false, error: 'phone required' });
  try {
    const s = await getOrCreateSession(sessionId);
    if (s.status === 'connected') {
      return res.json({ ok: true, alreadyConnected: true });
    }
    let tries = 0;
    while (!s.sock?.authState?.creds && tries < 20) {
      await new Promise((r) => setTimeout(r, 150));
      tries++;
    }
    const code = await s.sock.requestPairingCode(phone);
    res.json({ ok: true, code });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /send  { jid, text, session }
app.post('/send', async (req, res) => {
  const sessionId = pickSession(req);
  const jid = String(req.body?.jid || '');
  const text = String(req.body?.text || '');
  if (!sessionId) return res.status(400).json({ ok: false, error: 'session required' });
  if (!jid || !text) return res.status(400).json({ ok: false, error: 'jid+text required' });
  const s = sessions.get(sessionId);
  if (!s || s.status !== 'connected') {
    return res.status(409).json({ ok: false, error: `session ${sessionId} not connected (${s?.status || 'none'})` });
  }
  try {
    const r = await s.sock.sendMessage(jid, { text });
    res.json({ ok: true, id: r?.key?.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /groups?session=...
app.get('/groups', async (req, res) => {
  const sessionId = pickSession(req);
  if (!sessionId) return res.status(400).json({ ok: false, error: 'session required' });
  const s = sessions.get(sessionId);
  if (!s || s.status !== 'connected') {
    return res.status(409).json({ ok: false, error: 'session not connected' });
  }
  try {
    const all = await s.sock.groupFetchAllParticipating();
    const groups = Object.values(all).map((g) => ({
      jid: g.id,
      name: g.subject,
      participants: g.participants?.length ?? 0,
      announce: !!g.announce,
    }));
    res.json({ ok: true, groups });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE /session/:id  — logout & wipe
app.delete('/session/:id', async (req, res) => {
  const sessionId = sanitizeSession(req.params.id);
  const s = sessions.get(sessionId);
  try { if (s?.sock) await s.sock.logout().catch(() => {}); } catch (_) {}
  sessions.delete(sessionId);
  const folder = path.join(AUTH_DIR, sessionId);
  try { fs.rmSync(folder, { recursive: true, force: true }); } catch (_) {}
  res.json({ ok: true });
});

async function restoreAll() {
  const dirs = fs.readdirSync(AUTH_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  for (const d of dirs) {
    getOrCreateSession(d).catch((e) =>
      logger.error({ err: e, sessionId: d }, 'restore failed'),
    );
  }
  logger.info({ count: dirs.length }, 'sessions restoring');
}

app.listen(PORT, async () => {
  logger.info({ PORT, AUTH_DIR }, 'bridge listening');
  await restoreAll();
});

// =============================================================================
// WhatsApp Baileys bridge — Railway server.js
// =============================================================================

const express = require('express');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || '';
const AUTH_ROOT = process.env.AUTH_DIR || '/data';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const sessions = new Map();

function authDirFor(phone) {
  return path.join(AUTH_ROOT, 'auth', phone);
}

function ensureSession(phone) {
  let s = sessions.get(phone);
  if (!s) {
    s = {
      phone,
      status: 'not_started',
      lastError: null,
      pairingCode: null,
      codeExpiresAt: null,
      sock: null,
      pairingReady: false,
      pairingPromise: null,
      lastUpdate: Date.now(),
    };
    sessions.set(phone, s);
  }
  return s;
}

function setStatus(s, status, extra = {}) {
  s.status = status;
  s.lastUpdate = Date.now();
  Object.assign(s, extra);
  logger.info({ phone: s.phone, status, ...extra }, 'session_status');
}

async function wipeAuth(phone) {
  const dir = authDirFor(phone);
  await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function destroySocket(s) {
  if (s.sock) {
    try { s.sock.end(undefined); } catch (_) {}
    try { s.sock.ws?.close?.(); } catch (_) {}
  }
  s.sock = null;
  s.pairingReady = false;
}

async function createSocket(phone, { forceReset } = {}) {
  const s = ensureSession(phone);

  if (forceReset) {
    await destroySocket(s);
    await wipeAuth(phone);
  }

  const dir = authDirFor(phone);
  await fs.promises.mkdir(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({
    version: [2, 3000, 1033893291],
  }));

  const sock = makeWASocket({
    version,
    logger: logger.child({ scope: 'baileys', phone }),
    printQRInTerminal: false,
    browser: Browsers.macOS('Chrome'),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    keepAliveIntervalMs: 10_000,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    generateHighQualityLinkPreview: false,
  });

  s.sock = sock;
  s.pairingReady = false;
  setStatus(s, 'connecting', { lastError: null });

  sock.ev.on('creds.update', saveCreds);

  // ---------------------------------------------------------------------------
  // Forward INCOMING 1:1 messages from drivers to the Lovable Cloud webhook.
  // ---------------------------------------------------------------------------
  sock.ev.on('messages.upsert', async (ev) => {
    if (!WEBHOOK_URL) return;
    if (ev.type !== 'notify') return;
    for (const m of ev.messages || []) {
      try {
        if (!m?.message) continue;
        if (m.key?.fromMe) continue;
        const jid = m.key?.remoteJid || '';
        if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast')) continue;

        const msg = m.message;
        const text =
          msg.conversation ||
          msg.extendedTextMessage?.text ||
          msg.imageMessage?.caption ||
          msg.videoMessage?.caption ||
          '';
        if (!text || !String(text).trim()) continue;

        // WhatsApp now often returns @lid (linked-id) instead of @s.whatsapp.net.
        // The LID is NOT a phone number — never forward it as driver_phone.
        // Try to recover the real phone number (PN) from Baileys 6.7+ fields.
        let driverPhone = '';
        if (jid.endsWith('@s.whatsapp.net')) {
          driverPhone = jid.split('@')[0].split(':')[0];
        } else if (jid.endsWith('@lid')) {
          const senderPn = m.key?.senderPn || m.senderPn || '';
          if (senderPn && typeof senderPn === 'string' && senderPn.includes('@')) {
            driverPhone = senderPn.split('@')[0].split(':')[0];
          }
        }
        // Validate: only forward plausible phone numbers (Israeli or international,
        // 9-13 digits, not the 15-digit WhatsApp LID).
        const digits = String(driverPhone || '').replace(/\D/g, '');
        const looksLikePhone =
          digits.length >= 9 && digits.length <= 13 &&
          (digits.startsWith('972') || digits.startsWith('0') || digits.length <= 11);
        if (!looksLikePhone) {
          logger.warn(
            { phone, jid, senderPn: m.key?.senderPn || null, msgId: m.key?.id },
            'skip inbound: could not resolve real phone from JID'
          );
          continue;
        }
        const payload = {
          station_phone: phone,
          driver_phone: digits,
          text: String(text),
          wa_message_id: m.key?.id || null,
          direction: 'incoming',
        };
        try {
          await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(WEBHOOK_SECRET ? { 'x-bridge-secret': WEBHOOK_SECRET } : {}),
            },
            body: JSON.stringify(payload),
          });
        } catch (err) {
          logger.error({ phone, err: err?.message }, 'webhook forward failed');
        }
      } catch (err) {
        logger.error({ phone, err: err?.message }, 'messages.upsert handler error');
      }
    }
  });

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, isNewLogin, qr } = u;

    if (connection === 'connecting') {
      s.pairingReady = true;
    }

    if (connection === 'open' || isNewLogin) {
      setStatus(s, 'connected', { lastError: null, pairingCode: null });
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const msg = lastDisconnect?.error?.message || 'connection closed';

      if (code === DisconnectReason.loggedOut || code === 401) {
        await wipeAuth(phone);
        setStatus(s, 'logged_out', { lastError: `${code}: ${msg}` });
      } else if (s.status === 'connected') {
        setStatus(s, 'connecting', { lastError: msg });
        setTimeout(() => createSocket(phone).catch(() => {}), 2000);
      } else {
        setStatus(s, 'failed', { lastError: `${code ?? '?'}: ${msg}` });
      }

      s.pairingReady = false;
    }

    if (qr) {
      logger.warn({ phone }, 'unexpected QR fallback during pair flow');
    }
  });

  return s;
}

async function pair(phone, { forceReset } = {}) {
  const s = ensureSession(phone);

  if (s.pairingPromise) return s.pairingPromise;

  s.pairingPromise = (async () => {
    if (!s.sock || forceReset) {
      await createSocket(phone, { forceReset });
    }

    if (s.sock?.authState?.creds?.registered) {
      setStatus(s, 'connected');
      return { alreadyConnected: true, status: 'connected' };
    }

    const deadline = Date.now() + 15_000;
    while (!s.pairingReady && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      if (s.status === 'failed' || s.status === 'logged_out') {
        throw new Error(`socket failed before pairing ready: ${s.lastError}`);
      }
    }
    if (!s.pairingReady) throw new Error('socket never became pairing-ready');

    const code = await s.sock.requestPairingCode(phone);
    if (!code) throw new Error('Baileys returned empty pairing code');

    const expiresAt = new Date(Date.now() + 3 * 60_000).toISOString();
    setStatus(s, 'pairing_code_ready', {
      pairingCode: code,
      codeExpiresAt: expiresAt,
      lastError: null,
    });

    return {
      pairingCode: code,
      codeExpiresAt: expiresAt,
      status: 'pairing_code_ready',
    };
  })();

  try {
    return await s.pairingPromise;
  } finally {
    s.pairingPromise = null;
  }
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '256kb' }));

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (!API_KEY) return next();
  const provided =
    req.header('x-api-key') ||
    req.header('x-api-token') ||
    (req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  if (provided !== API_KEY) return res.status(401).json({ error: 'bad api key' });
  next();
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    sessions: Array.from(sessions.keys()),
    uptimeSec: Math.round(process.uptime()),
  });
});

app.get('/status/:phone', (req, res) => {
  const s = sessions.get(req.params.phone);
  if (!s) return res.json({ status: 'not_started', phone: req.params.phone });
  res.json({
    phone: s.phone,
    status: s.status,
    lastError: s.lastError,
    codeExpiresAt: s.codeExpiresAt,
    lastUpdate: s.lastUpdate,
  });
});

app.post('/pair', async (req, res) => {
  const phone = String(req.body?.phone || req.body?.session || req.body?.phoneNumber || '').replace(/\D/g, '');
  const forceReset = !!req.body?.forceReset;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const result = await pair(phone, { forceReset });
    res.json({ ok: true, phone, ...result });
  } catch (e) {
    logger.error({ phone, err: e?.message }, 'pair failed');
    res.status(500).json({ ok: false, error: e?.message || String(e), stage: 'pair' });
  }
});

async function logoutHandler(req, res) {
  const phone = String(req.params.phone || req.query.session || req.body?.session || '').replace(/\D/g, '');
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const s = sessions.get(phone);
  if (s) {
    try { await s.sock?.logout?.(); } catch (_) {}
    await destroySocket(s);
  }
  await wipeAuth(phone);
  sessions.delete(phone);
  res.json({ ok: true, phone });
}

app.post('/logout', logoutHandler);
app.post('/session/:phone/logout', logoutHandler);
app.delete('/session/:phone', logoutHandler);
app.post('/reset', logoutHandler);

app.post('/send', async (req, res) => {
  const { jid, text, session } = req.body || {};
  const phone = String(session || '').replace(/\D/g, '');
  if (!phone || !jid || !text) return res.status(400).json({ error: 'jid, text, session required' });
  const s = sessions.get(phone);
  if (!s || s.status !== 'connected') {
    return res.status(409).json({ error: 'session_missing', status: s?.status ?? 'not_started' });
  }
  try {
    await s.sock.sendMessage(jid, { text });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get('/groups', async (req, res) => {
  const phone = String(req.query.session || req.query.phone || '').replace(/\D/g, '');
  if (!phone) return res.status(400).json({ error: 'session required' });
  const s = sessions.get(phone);
  if (!s || s.status !== 'connected' || !s.sock) {
    return res.status(409).json({ error: 'session_missing', status: s?.status ?? 'not_started' });
  }
  try {
    const all = await s.sock.groupFetchAllParticipating();
    const groups = Object.values(all || {}).map((g) => ({
      jid: g.id,
      name: g.subject || '',
      participants: Array.isArray(g.participants) ? g.participants.length : null,
      size: typeof g.size === 'number'
        ? g.size
        : Array.isArray(g.participants) ? g.participants.length : null,
      announce: !!g.announce,
    }));
    res.json({ ok: true, groups });
  } catch (e) {
    logger.error({ phone, err: e?.message }, 'groups fetch failed');
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.listen(PORT, () => {
  logger.info({ port: PORT, authRoot: AUTH_ROOT }, 'whatsapp bridge listening');
  restoreSessionsOnBoot().catch((err) =>
    logger.error({ err: err?.message }, 'restore on boot crashed')
  );
});

// ---------------------------------------------------------------------------
// Auto-restore: re-create sockets for registered sessions on boot.
// ---------------------------------------------------------------------------
async function restoreSessionsOnBoot() {
  const baseDir = path.join(AUTH_ROOT, 'auth');
  let entries = [];
  try {
    entries = await fs.promises.readdir(baseDir, { withFileTypes: true });
  } catch (err) {
    logger.info({ baseDir, err: err?.message }, 'no auth dir to restore');
    return;
  }
  const phones = entries
    .filter((e) => e.isDirectory() && /^\d{6,}$/.test(e.name))
    .map((e) => e.name);

  logger.info({ count: phones.length, phones }, 'auto-restore start');

  for (const phone of phones) {
    try {
      const credsPath = path.join(baseDir, phone, 'creds.json');
      const raw = await fs.promises.readFile(credsPath, 'utf8').catch(() => null);
      if (!raw) continue;
      const creds = JSON.parse(raw);
      if (!creds?.registered) continue;
      await createSocket(phone);
      logger.info({ phone }, 'auto-restored session');
    } catch (err) {
      logger.error({ phone, err: err?.message }, 'auto-restore failed');
    }
  }
}

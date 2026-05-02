// server.js — Tutti WhatsApp Bridge (pair-mode hardened, Baileys 6.7.x)
import express from "express";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import pino from "pino";
import {
  default as makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";
const AUTH_DIR = process.env.AUTH_DIR || "./auth";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

const logger = pino({ level: "warn" });
const app = express();
app.use(bodyParser.json({ limit: "1mb" }));

// ---------- shared state ----------
let sock = null;
let currentSockId = 0;
let mode = "qr"; // 'qr' | 'pair'
let connectionState = "close"; // 'open' | 'connecting' | 'close'
let lastQR = null;
let lastQRAt = null;
let lastDisconnectCode = null;
let lastConnectionUpdate = null;
let pairing = false;
let pairCode = null;
let pairCodeFormatted = null;
let pairCodeIssuedAt = null;
let pairStartedAt = null;
let pairRequestedForSockId = -1;
let lastPairError = null;
let credsRegistered = false;
let connectedUser = null;
let startedAt = Date.now();

// ---------- auth helpers ----------
function wipeAuthDir() {
  try {
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  } catch (e) {
    console.error("wipeAuthDir failed:", e.message);
  }
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

async function killSocket() {
  if (!sock) return;
  try { sock.ev.removeAllListeners(); } catch {}
  try { sock.end(undefined); } catch {}
  try { sock.ws?.close?.(); } catch {}
  sock = null;
}

// ---------- start socket ----------
async function startSocket(nextMode /* 'qr' | 'pair' */) {
  await killSocket();
  mode = nextMode;
  connectionState = "close";
  lastQR = null;
  lastQRAt = null;
  lastDisconnectCode = null;
  lastConnectionUpdate = null;
  if (mode === "pair") {
    pairing = true;
    pairCode = null;
    pairCodeFormatted = null;
    pairStartedAt = new Date().toISOString();
    pairCodeIssuedAt = null;
    lastPairError = null;
  } else {
    pairing = false;
  }

  const sockId = ++currentSockId;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const s = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    emitOwnEvents: false,
    // IMPORTANT: do NOT set `browser`. Custom browser profiles are a known cause
    // of "invalid pairing code" with Baileys 6.7.x. Let Baileys use its default.
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
  });

  sock = s;
  credsRegistered = !!s.authState.creds.registered;

  s.ev.on("creds.update", async () => {
    await saveCreds();
    credsRegistered = !!s.authState.creds.registered;
  });

  s.ev.on("connection.update", async (update) => {
    if (sockId !== currentSockId) return; // stale event from killed socket
    lastConnectionUpdate = { ...update, at: new Date().toISOString() };
    const { connection, lastDisconnect, qr } = update;

    if (connection) connectionState = connection;

    if (qr) {
      if (mode === "qr") {
        lastQR = qr;
        lastQRAt = new Date().toISOString();
      } else {
        // suppress QR completely in pair mode
        lastQR = null;
      }
    }

    // Request pairing code as soon as the socket reaches "connecting"
    // and we haven't already requested one for this socket instance.
    if (
      mode === "pair" &&
      connection === "connecting" &&
      !s.authState.creds.registered &&
      pairRequestedForSockId !== sockId &&
      pendingPairPhone
    ) {
      pairRequestedForSockId = sockId;
      try {
        // small delay so handshake settles
        await new Promise((r) => setTimeout(r, 1500));
        const raw = pendingPairPhone;
        const code = await s.requestPairingCode(raw);
        pairCode = code.replace(/-/g, "");
        pairCodeFormatted = pairCode.length === 8
          ? `${pairCode.slice(0, 4)}-${pairCode.slice(4)}`
          : code;
        pairCodeIssuedAt = new Date().toISOString();
        if (pairResolver) {
          pairResolver({ ok: true, code: pairCode, codeFormatted: pairCodeFormatted });
          pairResolver = null;
        }
      } catch (e) {
        lastPairError = e?.message || String(e);
        if (pairResolver) {
          pairResolver({ ok: false, error: lastPairError });
          pairResolver = null;
        }
      }
    }

    if (connection === "open") {
      pairing = false;
      connectedUser = s.user || null;
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      lastDisconnectCode = code ?? null;

      // While we are mid-pairing, do NOT auto-reconnect — a second socket
      // would invalidate the just-issued pairing code.
      if (mode === "pair" && pairing) return;

      const loggedOut = code === DisconnectReason.loggedOut;
      if (!loggedOut) {
        // simple back-off reconnect in qr mode
        setTimeout(() => startSocket("qr").catch(console.error), 2000);
      }
    }
  });
}

// ---------- /pair flow ----------
let pendingPairPhone = null;
let pairResolver = null;

async function startPair(phone) {
  pendingPairPhone = phone;
  // fresh session — pairing requires unregistered creds
  await killSocket();
  wipeAuthDir();
  await startSocket("pair");

  return await new Promise((resolve) => {
    pairResolver = resolve;
    // safety timeout
    setTimeout(() => {
      if (pairResolver) {
        pairResolver({ ok: false, error: "pair timeout" });
        pairResolver = null;
      }
    }, 30_000);
  });
}

// ---------- middleware ----------
function auth(req, res, next) {
  if (!API_KEY) return next();
  if (req.header("X-Api-Key") === API_KEY) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
}

// ---------- routes ----------
app.get("/status", auth, (_req, res) => {
  res.json({
    ok: true,
    configured: true,
    mode,
    wsOpen: !!sock?.ws && sock.ws.readyState === 1,
    connectionState,
    connected: connectionState === "open",
    credsRegistered,
    hasQR: !!lastQR,
    pairing,
    pairCode,
    pairCodeFormatted,
    pairCodeIssuedAt,
    pairStartedAt,
    lastDisconnectCode,
    lastPairError,
    lastConnectionUpdate,
    sockId: currentSockId,
    user: connectedUser?.id || null,
    uptime: (Date.now() - startedAt) / 1000,
  });
});

app.post("/pair", auth, async (req, res) => {
  try {
    const phone = String(req.body?.phone || "").replace(/\D/g, "");
    if (!phone || phone.length < 10) {
      return res.status(400).json({ ok: false, error: "invalid phone" });
    }
    if (connectionState === "open" && credsRegistered) {
      return res.json({ ok: true, alreadyConnected: true });
    }
    const result = await startPair(phone);
    if (!result.ok) return res.status(500).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post("/reset", auth, async (_req, res) => {
  await killSocket();
  wipeAuthDir();
  await startSocket("qr");
  res.json({ ok: true });
});

app.get("/groups", auth, async (_req, res) => {
  if (!sock || connectionState !== "open") {
    return res.status(503).json({ ok: false, error: "not connected" });
  }
  try {
    const all = await sock.groupFetchAllParticipating();
    const groups = Object.values(all).map((g) => ({
      jid: g.id,
      name: g.subject,
      participants: g.participants?.length ?? null,
      announce: !!g.announce,
    }));
    res.json({ ok: true, groups });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post("/send", auth, async (req, res) => {
  if (!sock || connectionState !== "open") {
    return res.status(503).json({ ok: false, error: "not connected" });
  }
  try {
    const { jid, text } = req.body || {};
    if (!jid || !text) return res.status(400).json({ ok: false, error: "jid+text required" });
    const m = await sock.sendMessage(jid, { text });
    res.json({ ok: true, id: m?.key?.id || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ---------- boot ----------
fs.mkdirSync(AUTH_DIR, { recursive: true });
startSocket("qr").catch(console.error);

app.listen(PORT, () => {
  console.log(`Tutti WA bridge listening on :${PORT}`);
});

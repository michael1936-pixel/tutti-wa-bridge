// server.js — Tutti WhatsApp Bridge (pair-mode hardened + Railway healthcheck)
import express from "express";
import bodyParser from "body-parser";
import fs from "fs";
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

const logger = pino({ level: "warn" });
const app = express();
app.use(bodyParser.json({ limit: "1mb" }));

// ---------- PUBLIC HEALTH ENDPOINTS (no auth) — must come BEFORE the API-key middleware
app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

// ---------- API key guard for everything else
app.use((req, res, next) => {
  if (!API_KEY) return next();
  if (req.headers["x-api-key"] === API_KEY) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
});

// ---------- state
let sock = null;
let sockId = 0;
let connectionState = "idle";
let lastDisconnectCode = null;
let lastConnectionUpdate = null;
let mode = "qr";          // "qr" | "pair"
let qrDataUrl = null;
let pairCode = null;
let pairCodeFormatted = null;
let pairRequestedForSockId = null;
let pairAttemptId = 0;
let pairRequestedAt = null;
let pairPhone = null;

async function clearAuth() {
  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

async function startSocket(nextMode = "qr", phone = null) {
  if (sock) {
    try { sock.ev.removeAllListeners(); } catch {}
    try { sock.end(); } catch {}
    sock = null;
  }
  mode = nextMode;
  qrDataUrl = null;
  pairCode = null;
  pairCodeFormatted = null;
  pairPhone = phone;
  connectionState = "starting";
  lastDisconnectCode = null;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const id = ++sockId;
  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (u) => {
    lastConnectionUpdate = { ...u, at: new Date().toISOString() };
    if (u.connection) connectionState = u.connection;

    if (u.qr && mode === "qr") {
      try {
        const QRCode = (await import("qrcode")).default;
        qrDataUrl = await QRCode.toDataURL(u.qr);
      } catch {}
    }

    if (mode === "pair" && u.connection === "connecting" && pairRequestedForSockId !== id && pairPhone) {
      pairRequestedForSockId = id;
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(pairPhone);
          pairCode = code.replace(/[^A-Z0-9]/gi, "").toUpperCase();
          pairCodeFormatted = pairCode.match(/.{1,4}/g)?.join("-") || pairCode;
          pairAttemptId++;
          pairRequestedAt = new Date().toISOString();
        } catch (e) {
          console.error("requestPairingCode failed:", e?.message || e);
        }
      }, 1500);
    }

    if (u.connection === "close") {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      lastDisconnectCode = code || null;
      const loggedOut = code === DisconnectReason.loggedOut;
      if (mode === "pair") return; // do not auto-reconnect during pair
      if (!loggedOut) setTimeout(() => startSocket("qr").catch(console.error), 2000);
    }
  });
}

// ---------- routes
app.get("/status", (_req, res) => {
  res.json({
    ok: true,
    mode,
    connectionState,
    connected: connectionState === "open",
    pairing: mode === "pair" && connectionState !== "open",
    hasQR: !!qrDataUrl && mode === "qr",
    qrDataUrl: mode === "qr" ? qrDataUrl : null,
    pairCode,
    pairCodeFormatted,
    pairAttemptId,
    pairRequestedAt,
    sockId,
    lastDisconnectCode,
    lastConnectionUpdate,
  });
});

app.post("/pair", async (req, res) => {
  try {
    const phone = String(req.body?.phone || "").replace(/[^\d]/g, "");
    if (!phone) return res.status(400).json({ ok: false, error: "phone required" });
    await clearAuth();
    pairRequestedForSockId = null;
    await startSocket("pair", phone);
    res.json({ ok: true, message: "pairing started, poll /status for pairCode" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post("/qr", async (_req, res) => {
  try {
    await clearAuth();
    await startSocket("qr");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post("/send", async (req, res) => {
  try {
    if (!sock || connectionState !== "open") {
      return res.status(409).json({ ok: false, error: "not connected" });
    }
    const { jid, text } = req.body || {};
    if (!jid || !text) return res.status(400).json({ ok: false, error: "jid+text required" });
    const m = await sock.sendMessage(jid, { text });
    res.json({ ok: true, id: m?.key?.id || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ---------- boot
fs.mkdirSync(AUTH_DIR, { recursive: true });
startSocket("qr").catch(console.error);

app.listen(PORT, () => {
  console.log(`Tutti WA bridge listening on :${PORT}`);
});

// tutti-wa-bridge/server.js
import express from "express";
import bodyParser from "body-parser";
import pino from "pino";
import {
  default as makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} from "@whiskeysockets/baileys";

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.BRIDGE_API_KEY || "";
const AUTH_DIR = process.env.AUTH_DIR || "./auth";

const logger = pino({ level: "info" });
const app = express();
app.use(bodyParser.json({ limit: "2mb" }));

// ---- State ----
let sock = null;
let authState = null;
let saveCreds = null;
let connectionState = "close"; // "open" | "connecting" | "close"
let pairCode = null;
let pairAttemptId = null;
let pairRequestedAt = null;
let lastError = null;

// ---- PUBLIC endpoints (no auth) — for Railway healthcheck & debug ----
app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));
app.get("/status", (_req, res) => {
  res.status(200).json({
    ok: true,
    connectionState,
    pairing: !!pairCode,
    pairCode: pairCode || null,
    pairCodeFormatted: pairCode ? `${pairCode.slice(0, 4)}-${pairCode.slice(4)}` : null,
    pairAttemptId,
    pairRequestedAt,
    hasCreds: !!authState?.creds?.registered,
    lastError,
    uptime: process.uptime(),
  });
});

// ---- API key guard for everything below ----
app.use((req, res, next) => {
  const key = req.header("X-Api-Key");
  if (!API_KEY || key !== API_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
});

// ---- Socket lifecycle ----
async function startSock() {
  const { state, saveCreds: sc } = await useMultiFileAuthState(AUTH_DIR);
  authState = state;
  saveCreds = sc;

  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger,
    browser: Browsers.macOS("Safari"),
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (u) => {
    const { connection, lastDisconnect } = u;
    if (connection) connectionState = connection;
    if (connection === "open") {
      pairCode = null;
      pairAttemptId = null;
      pairRequestedAt = null;
      lastError = null;
      logger.info("WA connection OPEN");
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      lastError = lastDisconnect?.error?.message || null;
      logger.warn({ code, lastError }, "WA connection CLOSED");
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      if (shouldReconnect) setTimeout(() => startSock().catch(() => {}), 2000);
    }
  });
}

// ---- Routes (protected) ----
app.post("/pair", async (req, res) => {
  try {
    const phone = String(req.body?.phone || "").replace(/\D/g, "");
    if (!phone || phone.length < 10) {
      return res.status(400).json({ ok: false, error: "invalid phone" });
    }
    if (!sock || connectionState === "close") await startSock();
    if (authState?.creds?.registered) {
      return res.status(409).json({ ok: false, error: "already registered" });
    }

    pairAttemptId = Math.random().toString(36).slice(2, 10);
    pairRequestedAt = new Date().toISOString();

    // Wait briefly for socket to be ready
    await new Promise((r) => setTimeout(r, 1500));

    const code = await sock.requestPairingCode(phone);
    pairCode = String(code).replace(/\W/g, "");
    res.json({
      ok: true,
      pairCode,
      pairCodeFormatted: `${pairCode.slice(0, 4)}-${pairCode.slice(4)}`,
      pairAttemptId,
    });
  } catch (e) {
    lastError = e?.message || String(e);
    res.status(500).json({ ok: false, error: lastError });
  }
});

app.post("/logout", async (_req, res) => {
  try {
    await sock?.logout();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

app.post("/send", async (req, res) => {
  try {
    const { jid, text } = req.body || {};
    if (!jid || !text) return res.status(400).json({ ok: false, error: "jid+text required" });
    const msg = await sock.sendMessage(jid, { text: String(text) });
    res.json({ ok: true, id: msg?.key?.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

app.get("/groups", async (_req, res) => {
  try {
    const groups = await sock.groupFetchAllParticipating();
    res.json({
      ok: true,
      groups: Object.values(groups).map((g) => ({
        id: g.id,
        subject: g.subject,
        size: g.participants?.length || 0,
      })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

// ---- Boot ----
app.listen(PORT, () => {
  logger.info(`Bridge listening on :${PORT}`);
  startSock().catch((e) => {
    lastError = e?.message;
    logger.error(e, "startSock failed");
  });
});

// WhatsApp Bridge for Lovable
// Routes: /health, /status, /groups, /send, /pair, /session/:session
import express from "express";
import P from "pino";
import qrcode from "qrcode";
import fs from "fs";
import path from "path";

// --- Resilient Baileys import (handles default/named export drift) ---
import * as BaileysAll from "@whiskeysockets/baileys";
const Baileys = BaileysAll.default ?? BaileysAll;
const makeWASocket =
  Baileys.makeWASocket ??
  Baileys.default ??
  BaileysAll.makeWASocket ??
  BaileysAll.default;
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} = Baileys;

if (typeof makeWASocket !== "function") {
  console.error("FATAL: makeWASocket not found in baileys exports", Object.keys(BaileysAll));
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const API_KEY =
  process.env.WHATSAPP_VPS_API_KEY ||
  process.env.BRIDGE_API_KEY ||
  process.env.API_KEY ||
  "";
const AUTH_ROOT = process.env.AUTH_ROOT || "./auth";
fs.mkdirSync(AUTH_ROOT, { recursive: true });

const app = express();
app.use(express.json({ limit: "1mb" }));

// --- Auth middleware (skip /health and / for Railway healthcheck) ---
app.use((req, res, next) => {
  if (req.path === "/health" || req.path === "/") return next();
  if (!API_KEY) return next();
  const provided = req.header("x-api-key") || req.header("X-Api-Key");
  if (provided !== API_KEY) return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
});

// --- Session registry ---
const sessions = new Map(); // sessionId -> { sock, status, qr, pairingCode }

function normJid(input) {
  if (!input) return null;
  let s = String(input).trim();
  if (s.includes("@")) return s; // already a JID
  const digits = s.replace(/\D/g, "");
  if (!digits) return null;
  // Group JIDs are numeric+@g.us; default individual JIDs to s.whatsapp.net
  return `${digits}@s.whatsapp.net`;
}

async function startSession(sessionId) {
  if (sessions.has(sessionId) && sessions.get(sessionId).status === "connected") {
    return sessions.get(sessionId);
  }
  const dir = path.join(AUTH_ROOT, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: "warn" }),
    printQRInTerminal: false,
    browser: Browsers.appropriate("Lovable"),
  });

  const entry = { sock, status: "connecting", qr: null, pairingCode: null };
  sessions.set(sessionId, entry);

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      entry.qr = await qrcode.toDataURL(qr);
      entry.status = "qr_pending";
    }
    if (connection === "open") {
      entry.status = "connected";
      entry.qr = null;
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      entry.status = "disconnected";
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(() => startSession(sessionId).catch(() => {}), 2500);
      }
    }
  });

  return entry;
}

// Auto-resume any pre-existing session dirs on boot
for (const dir of fs.readdirSync(AUTH_ROOT)) {
  if (fs.existsSync(path.join(AUTH_ROOT, dir, "creds.json"))) {
    startSession(dir).catch((e) => console.error("resume", dir, e?.message));
  }
}

// --- Routes ---
app.get("/", (_req, res) => res.json({ ok: true, service: "wa-bridge" }));
app.get("/health", (_req, res) =>
  res.json({ ok: true, sessions: [...sessions.keys()] })
);

app.get("/status", async (req, res) => {
  const session = String(req.query.session || "");
  if (!session) return res.json({ ok: true, sessions: [...sessions.keys()] });
  const entry = sessions.get(session) || (await startSession(session));
  res.json({
    ok: true,
    connected: entry.status === "connected",
    hasQR: !!entry.qr,
    qr: entry.qr,
    status: entry.status,
  });
});

app.get("/session/:session", async (req, res) => {
  const session = req.params.session;
  const entry = sessions.get(session) || (await startSession(session));
  res.json({ status: entry.status, hasQR: !!entry.qr });
});

app.get("/groups", async (req, res) => {
  const session = String(req.query.session || "");
  if (!session) return res.status(400).json({ ok: false, error: "missing session" });
  const entry = sessions.get(session);
  if (!entry || entry.status !== "connected") {
    return res.status(409).json({ ok: false, error: "session not connected", status: entry?.status || "missing" });
  }
  try {
    const all = await entry.sock.groupFetchAllParticipating();
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

app.post("/send", async (req, res) => {
  const b = req.body || {};
  const session = b.session || b.sessionId;
  const jid = normJid(b.jid || b.to);
  const text = b.text || b.message;
  if (!session || !jid || !text) {
    return res.status(400).json({ ok: false, error: "missing session/jid/text" });
  }
  const entry = sessions.get(session);
  if (!entry || entry.status !== "connected") {
    return res.status(409).json({ ok: false, error: "session not connected", status: entry?.status || "missing" });
  }
  try {
    await entry.sock.sendMessage(jid, { text });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post("/pair", async (req, res) => {
  const { phone, session } = req.body || {};
  const sid = session || phone;
  if (!sid || !phone) return res.status(400).json({ ok: false, error: "missing phone/session" });
  const entry = await startSession(sid);
  if (entry.status === "connected") return res.json({ ok: true, alreadyConnected: true });
  try {
    // Wait briefly for socket to be ready
    for (let i = 0; i < 20 && !entry.sock?.requestPairingCode; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const code = await entry.sock.requestPairingCode(String(phone).replace(/\D/g, ""));
    entry.pairingCode = code;
    res.json({ ok: true, code });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e), stage: "requestPairingCode" });
  }
});

app.listen(PORT, () => console.log(`Bridge listening on :${PORT}`));

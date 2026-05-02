// tutti-wa-bridge/server.js
import express from "express";
import fs from "fs";
import path from "path";
import pino from "pino";
import {
  default as makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  DisconnectReason,
} from "@whiskeysockets/baileys";

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || process.env.BRIDGE_API_KEY || "";
const AUTH_DIR = process.env.AUTH_DIR || "./auth";

const app = express();
app.use(express.json({ limit: "2mb" }));

// In-memory map of phone -> { sock, state, lastCode, creds }
const sessions = new Map();

const log = pino({ level: "info" });

// ---------- Public endpoints (NO auth) ----------
app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));
app.get("/status", (req, res) => {
  const phone = (req.query.phone || "").toString();
  if (phone) {
    const s = sessions.get(normalizePhone(phone).phone);
    return res.status(200).json({
      ok: true,
      phone,
      hasSession: !!s,
      connectionState: s?.state ?? "none",
      lastCode: s?.lastCode ?? null,
    });
  }
  const list = [...sessions.entries()].map(([p, s]) => ({
    phone: p, state: s.state, hasCode: !!s.lastCode,
  }));
  return res.status(200).json({ ok: true, sessions: list });
});

// ---------- API key guard for everything below ----------
app.use((req, res, next) => {
  if (!API_KEY) {
    return res.status(500).json({ ok: false, error: "server_missing_api_key" });
  }
  const key = req.header("X-Api-Key");
  if (key !== API_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
});

// ---------- Helpers ----------
function normalizePhone(raw) {
  let p = (raw || "").toString().replace(/[^\d]/g, "");
  if (p.startsWith("00")) p = p.slice(2);
  if (p.startsWith("0")) p = "972" + p.slice(1); // Israeli local -> intl
  return { phone: p, valid: p.length >= 10 && p.length <= 15 };
}

function formatCode(code) {
  if (!code) return code;
  const c = code.toString().replace(/\s|-/g, "");
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

function authPathFor(phone) {
  return path.join(AUTH_DIR, phone);
}

async function startSocketForPairing(phone) {
  const dir = authPathFor(phone);

  // Wipe any old creds so Baileys generates a fresh pairing
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    log.warn({ err: e?.message }, "rm auth dir failed");
  }
  fs.mkdirSync(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.macOS("Safari"),
    logger: pino({ level: "warn" }),
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  const session = { sock, state: "connecting", lastCode: null };
  sessions.set(phone, session);

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", (u) => {
    log.info({ phone, u }, "connection.update");
    if (u.connection) session.state = u.connection;
    if (u.connection === "close") {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        sessions.delete(phone);
      }
    }
  });

  return sock;
}

// ---------- /pair ----------
app.post("/pair", async (req, res) => {
  let stage = "init";
  try {
    const { phone: rawPhone } = req.body || {};
    stage = "validate";
    const { phone, valid } = normalizePhone(rawPhone);
    if (!valid) {
      return res.status(400).json({ ok: false, stage, error: "invalid_phone", phone });
    }

    // Already connected?
    const existing = sessions.get(phone);
    if (existing && existing.state === "open") {
      return res.status(200).json({ ok: true, alreadyConnected: true, phone });
    }

    stage = "start_socket";
    const sock = await startSocketForPairing(phone);

    // Wait one tick so authState is fully wired
    await new Promise((r) => setTimeout(r, 500));

    // If by some reason already registered, requestPairingCode throws
    if (sock.authState?.creds?.registered) {
      return res.status(200).json({ ok: true, alreadyConnected: true, phone });
    }

    stage = "request_code";
    const rawCode = await sock.requestPairingCode(phone);
    if (!rawCode) {
      return res.status(500).json({ ok: false, stage, error: "no_code_returned", phone });
    }
    const code = formatCode(rawCode);
    sessions.get(phone).lastCode = code;

    log.info({ phone, code }, "pair code issued");
    return res.status(200).json({ ok: true, phone, code });
  } catch (err) {
    log.error({ stage, err: err?.message, stack: err?.stack }, "pair failed");
    return res.status(500).json({
      ok: false,
      stage,
      error: err?.message || "unknown",
      stack: (err?.stack || "").toString().slice(0, 500),
    });
  }
});

// ---------- /send ----------
app.post("/send", async (req, res) => {
  try {
    const { phone, to, text } = req.body || {};
    const { phone: from } = normalizePhone(phone);
    const s = sessions.get(from);
    if (!s || s.state !== "open") {
      return res.status(409).json({ ok: false, error: "not_connected", state: s?.state });
    }
    const jid = to.includes("@") ? to : `${normalizePhone(to).phone}@s.whatsapp.net`;
    const m = await s.sock.sendMessage(jid, { text });
    return res.status(200).json({ ok: true, id: m?.key?.id });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message });
  }
});

// ---------- /groups ----------
app.get("/groups", async (req, res) => {
  try {
    const { phone } = normalizePhone(req.query.phone || "");
    const s = sessions.get(phone);
    if (!s || s.state !== "open") {
      return res.status(409).json({ ok: false, error: "not_connected", state: s?.state });
    }
    const groups = await s.sock.groupFetchAllParticipating();
    return res.status(200).json({ ok: true, groups });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message });
  }
});

app.listen(PORT, () => log.info(`bridge listening on ${PORT}`));

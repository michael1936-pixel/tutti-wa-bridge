import express from "express";
import cors from "cors";
import pino from "pino";
import { Boom } from "@hapi/boom";
import * as baileys from "@whiskeysockets/baileys";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = baileys;

const makeWASocket =
  baileys.default?.default ||
  baileys.default ||
  baileys.makeWASocket;

if (typeof makeWASocket !== "function") {
  console.error("❌ makeWASocket was not found as a function.");
  console.error("Available Baileys exports:", Object.keys(baileys));
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.WHATSAPP_VPS_API_KEY || "";
const WEBHOOK_SECRET = process.env.WA_BRIDGE_WEBHOOK_SECRET || "";
const WEBHOOK_URL = process.env.WEBHOOK_URL || process.env.LOVABLE_WEBHOOK_URL || "";
const DEFAULT_STATION_ID = process.env.DEFAULT_STATION_ID || "";
const SESSION_ROOT =
  process.env.SESSION_ROOT ||
  process.env.WHATSAPP_SESSION_ROOT ||
  path.join(process.cwd(), "data", "sessions");

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const sessions = new Map();

await fs.mkdir(SESSION_ROOT, { recursive: true });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function normalizePhone(value) {
  const raw = String(value || "").trim();
  let digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("972")) return digits;
  if (digits.startsWith("0")) return `972${digits.slice(1)}`;
  if (digits.length === 9 && digits.startsWith("5")) return `972${digits}`;
  return digits;
}

function normalizeSession(value) {
  const phone = normalizePhone(value);
  if (phone) return phone;
  return String(value || "default").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

function sessionDir(session) { return path.join(SESSION_ROOT, normalizeSession(session)); }

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (aa.length !== bb.length) return false;
  if (aa.length === 0) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function getProvidedApiKey(req) {
  const headerKey = req.get("x-api-key") || req.get("X-Api-Key") || "";
  const auth = req.get("authorization") || "";
  const bearer = auth.replace(/^Bearer\s+/i, "");
  return headerKey || bearer || "";
}

function requireAuth(req, res, next) {
  if (!API_KEY) {
    return res.status(503).json({ ok: false, error: "api_key_not_configured" });
  }
  const provided = getProvidedApiKey(req);
  if (!safeEqual(provided, API_KEY)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

function jidToPhone(jid) {
  return String(jid || "").split("@")[0].split(":")[0].replace(/\D/g, "");
}

function phoneToJid(phoneOrJid) {
  const value = String(phoneOrJid || "").trim();
  if (value.includes("@")) return value;
  return `${normalizePhone(value)}@s.whatsapp.net`;
}

function getTextFromMessage(message) {
  const m = message?.message;
  if (!m) return "";
  const u =
    m.ephemeralMessage?.message ||
    m.viewOnceMessage?.message ||
    m.viewOnceMessageV2?.message ||
    m.documentWithCaptionMessage?.message ||
    m;
  return (
    u.conversation ||
    u.extendedTextMessage?.text ||
    u.imageMessage?.caption ||
    u.videoMessage?.caption ||
    u.documentMessage?.caption ||
    u.buttonsResponseMessage?.selectedDisplayText ||
    u.buttonsResponseMessage?.selectedButtonId ||
    u.listResponseMessage?.title ||
    u.templateButtonReplyMessage?.selectedDisplayText ||
    u.templateButtonReplyMessage?.selectedId ||
    ""
  ).toString().trim();
}

async function postWebhook(payload) {
  if (!WEBHOOK_URL || !DEFAULT_STATION_ID || !payload?.text) return;
  const headers = { "Content-Type": "application/json" };
  if (WEBHOOK_SECRET) headers["x-bridge-secret"] = WEBHOOK_SECRET;
  try {
    const r = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        station_id: DEFAULT_STATION_ID,
        driver_phone: payload.driver_phone,
        text: payload.text,
        wa_message_id: payload.wa_message_id || null,
        direction: payload.direction || "incoming"
      })
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      logger.warn({ status: r.status, body: text.slice(0, 300) }, "Webhook non-OK");
    }
  } catch (error) {
    logger.warn({ error: error?.message || String(error) }, "Webhook failed");
  }
}

function publicSessionStatus(record) {
  if (!record) return { ok: false, connected: false, status: "not_found", hasQR: false };
  return {
    ok: true,
    session: record.session,
    phone: record.phone,
    status: record.status,
    connected: record.status === "connected",
    hasQR: false,
    pairingCodeReady: record.status === "pairing_code_ready",
    lastError: record.lastError || null,
    connectedAt: record.connectedAt || null,
    lastSeenAt: record.lastSeenAt || null,
    codeExpiresAt: record.codeExpiresAt || null
  };
}

async function closeSocket(record) {
  if (!record?.sock) return;
  try { record.sock.ev?.removeAllListeners?.(); } catch (_) {}
  try { record.sock.end?.(new Error("closed by bridge")); } catch (_) {}
  try { record.sock.ws?.close?.(); } catch (_) {}
  record.sock = null;
}

async function resetSession(session, deleteFiles = true) {
  const id = normalizeSession(session);
  const record = sessions.get(id);
  if (record) {
    await closeSocket(record);
    sessions.delete(id);
  }
  if (deleteFiles) {
    await fs.rm(sessionDir(id), { recursive: true, force: true });
  }
  return { ok: true, session: id, deletedFiles: deleteFiles };
}

async function startSocket(sessionValue, phoneValue) {
  const session = normalizeSession(sessionValue);
  const phone = normalizePhone(phoneValue || session);
  const existing = sessions.get(session);

  if (existing?.starting) return existing.starting;
  if (existing?.sock && existing.status !== "disconnected") return existing;

  const record = existing || {
    session, phone, sock: null,
    status: "starting", lastError: null,
    connectedAt: null, lastSeenAt: null,
    codeExpiresAt: null, starting: null, registered: false
  };
  sessions.set(session, record);

  const starting = (async () => {
    const dir = sessionDir(session);
    await fs.mkdir(dir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(dir);

    let version;
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
    } catch (error) {
      logger.warn({ error: error?.message || String(error) }, "Baileys version fetch failed");
    }

    record.status = state.creds?.registered ? "connecting" : "pairing";
    record.registered = Boolean(state.creds?.registered);

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      browser: ["Windows", "Chrome", "114.0.5735.198"],
      getMessage: async () => undefined
    });

    record.sock = sock;
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === "open") {
        record.status = "connected";
        record.connectedAt = new Date().toISOString();
        record.lastSeenAt = new Date().toISOString();
        record.lastError = null;
        record.registered = true;
        logger.info({ session }, "WhatsApp connected");
      }
      if (connection === "connecting" && record.status !== "pairing_code_ready") {
        record.status = "connecting";
      }
      if (connection === "close") {
        const boom = new Boom(lastDisconnect?.error);
        const statusCode = boom?.output?.statusCode;
        const message = lastDisconnect?.error?.message || boom?.message || "connection closed";

        record.status = "disconnected";
        record.lastError = message;
        record.sock = null;
        logger.warn({ session, statusCode, message }, "WhatsApp connection closed");

        const shouldNotReconnect =
          statusCode === DisconnectReason.loggedOut ||
          statusCode === DisconnectReason.badSession ||
          statusCode === 401;

        if (!shouldNotReconnect && record.registered) {
          setTimeout(() => {
            startSocket(session, phone).catch((e) =>
              logger.error({ session, error: e?.message || String(e) }, "Reconnect failed")
            );
          }, 4000);
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
      for (const msg of messages || []) {
        try {
          const remoteJid = msg?.key?.remoteJid || "";
          if (!remoteJid || remoteJid === "status@broadcast" || remoteJid.endsWith("@g.us")) continue;
          const text = getTextFromMessage(msg);
          if (!text) continue;
          const fromMe = Boolean(msg?.key?.fromMe);
          const driverPhone = jidToPhone(remoteJid);
          if (!driverPhone) continue;
          await postWebhook({
            direction: fromMe ? "outgoing" : "incoming",
            driver_phone: driverPhone,
            text,
            wa_message_id: msg?.key?.id || null
          });
        } catch (error) {
          logger.warn({ error: error?.message || String(error) }, "Incoming msg failed");
        }
      }
    });

    return record;
  })();

  record.starting = starting;
  try { return await starting; }
  finally { record.starting = null; }
}

async function waitForSocketReady(record, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (record.sock && typeof record.sock.requestPairingCode === "function") return true;
    if (record.lastError && !record.sock) return false;
    await sleep(200);
  }
  return Boolean(record.sock);
}

async function waitForConnected(record, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (record.status === "connected" && record.sock) return true;
    await sleep(500);
  }
  return false;
}

async function createPairingCode({ phone, session, forceReset }) {
  if (forceReset) await resetSession(session, true);

  const record = await startSocket(session, phone);

  if (record.status === "connected" || (record.registered && record.sock)) {
    return { ok: true, alreadyConnected: true, status: "connected", session, phone };
  }

  const ready = await waitForSocketReady(record, 8000);
  if (!ready || !record.sock) {
    throw new Error(record.lastError || "socket_not_available");
  }

  if (typeof record.sock.requestPairingCode !== "function") {
    throw new Error("requestPairingCode is not available on this Baileys socket");
  }

  const pairingCode = await record.sock.requestPairingCode(phone);
  record.status = "pairing_code_ready";
  record.codeExpiresAt = new Date(Date.now() + 3 * 60 * 1000).toISOString();
  record.lastError = null;

  return {
    ok: true,
    alreadyConnected: false,
    status: "pairing_code_ready",
    session, phone,
    pairingCode, code: pairingCode,
    codeExpiresAt: record.codeExpiresAt
  };
}

// --- Routes ---

app.get("/", (_req, res) =>
  res.json({ ok: true, service: "wa-bridge", message: "WhatsApp bridge is running" })
);

app.get("/health", (_req, res) =>
  res.json({
    ok: true, service: "wa-bridge", status: "healthy",
    time: new Date().toISOString(),
    uptime: process.uptime(),
    sessions: Array.from(sessions.values()).map((s) => ({
      session: s.session, phone: s.phone, status: s.status,
      connected: s.status === "connected",
      lastSeenAt: s.lastSeenAt || null, lastError: s.lastError || null
    }))
  })
);

const STALE_ERROR_RE =
  /qr\s*refs|attempts\s*ended|connection\s*closed|socket|stream|timed?\s*out|408|restart\s*required/i;

app.post("/pair", requireAuth, async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const session = normalizeSession(req.body?.session || phone);
  const explicitForce = Boolean(req.body?.forceReset);

  if (!phone) return res.status(400).json({ ok: false, error: "phone_required" });

  // ⭐ AUTO-RESET if existing session is in a stale failed state
  const existing = sessions.get(session);
  let forceReset = explicitForce;
  if (
    !forceReset &&
    existing &&
    existing.status === "disconnected" &&
    existing.lastError &&
    STALE_ERROR_RE.test(existing.lastError)
  ) {
    logger.info(
      { session, lastError: existing.lastError },
      "Auto-resetting stale session before pair"
    );
    forceReset = true;
  }

  try {
    let result;
    try {
      result = await createPairingCode({ phone, session, forceReset });
    } catch (error) {
      const message = error?.message || String(error);
      if (!forceReset && STALE_ERROR_RE.test(message)) {
        logger.warn({ session, message }, "Pair failed, retrying with reset");
        await resetSession(session, true);
        await sleep(2500);
        result = await createPairingCode({ phone, session, forceReset: false });
      } else {
        throw error;
      }
    }
    return res.json(result);
  } catch (error) {
    const message = error?.message || String(error);
    logger.error({ session, phone, message }, "Pairing failed");
    return res.status(502).json({
      ok: false, error: "pair_failed", message, step: "requestPairingCode"
    });
  }
});

app.get("/status", requireAuth, async (req, res) => {
  const sessionQuery = req.query.session ? normalizeSession(req.query.session) : "";
  if (sessionQuery) return res.json(publicSessionStatus(sessions.get(sessionQuery)));
  return res.json({
    ok: true,
    sessions: Array.from(sessions.values()).map(publicSessionStatus)
  });
});

app.get("/status/:session", requireAuth, async (req, res) => {
  const session = normalizeSession(req.params.session);
  return res.json(publicSessionStatus(sessions.get(session)));
});

app.get("/groups", requireAuth, async (req, res) => {
  const session = normalizeSession(req.query.session || req.query.sessionId || "");
  if (!session) return res.status(400).json({ ok: false, error: "session_required" });

  const record = sessions.get(session) || (await startSocket(session, session));
  const connected = await waitForConnected(record, 8000);

  if (!connected || !record.sock) {
    return res.status(409).json({
      ok: false, error: "session_not_connected",
      status: record.status, lastError: record.lastError || null
    });
  }

  try {
    const groupsMap = await record.sock.groupFetchAllParticipating();
    const groups = Object.values(groupsMap || {}).map((g) => ({
      jid: g.id, id: g.id,
      name: g.subject || g.name || g.id,
      subject: g.subject || g.name || g.id,
      participants: Array.isArray(g.participants) ? g.participants.length : null,
      size: Array.isArray(g.participants) ? g.participants.length : null,
      announce: Boolean(g.announce)
    }));
    return res.json({ ok: true, groups });
  } catch (error) {
    return res.status(502).json({
      ok: false, error: "groups_failed", message: error?.message || String(error)
    });
  }
});

app.post("/send", requireAuth, async (req, res) => {
  const session = normalizeSession(
    req.body?.session || req.body?.sessionId || req.query?.session || ""
  );
  const jid = phoneToJid(req.body?.jid || req.body?.to || req.body?.phone || "");
  const text = String(req.body?.text || req.body?.message || "").trim();

  if (!session) return res.status(400).json({ ok: false, error: "session_required" });
  if (!jid || jid === "@s.whatsapp.net") return res.status(400).json({ ok: false, error: "jid_required" });
  if (!text) return res.status(400).json({ ok: false, error: "text_required" });

  const record = sessions.get(session) || (await startSocket(session, session));
  const connected = await waitForConnected(record, 10000);

  if (!connected || !record.sock) {
    return res.status(409).json({
      ok: false, error: "session_not_connected",
      status: record.status, lastError: record.lastError || null
    });
  }

  try {
    const sent = await record.sock.sendMessage(jid, { text });
    return res.json({ ok: true, session, jid, messageId: sent?.key?.id || null });
  } catch (error) {
    return res.status(502).json({
      ok: false, error: "send_failed", message: error?.message || String(error)
    });
  }
});

app.post("/logout", requireAuth, async (req, res) => {
  const session = normalizeSession(
    req.query.session || req.body?.session || req.body?.sessionId || ""
  );
  if (!session) return res.status(400).json({ ok: false, error: "session_required" });
  return res.json(await resetSession(session, true));
});

app.post("/reset", requireAuth, async (req, res) => {
  const session = normalizeSession(
    req.query.session || req.body?.session || req.body?.sessionId || ""
  );

  if (session) return res.json(await resetSession(session, true));

  for (const id of Array.from(sessions.keys())) {
    await resetSession(id, true);
  }
  try {
    await fs.rm(SESSION_ROOT, { recursive: true, force: true });
    await fs.mkdir(SESSION_ROOT, { recursive: true });
  } catch (_) {}
  return res.json({ ok: true, resetAll: true });
});

app.post("/session/:session/logout", requireAuth, async (req, res) => {
  return res.json(await resetSession(normalizeSession(req.params.session), true));
});

app.delete("/session/:session", requireAuth, async (req, res) => {
  return res.json(await resetSession(normalizeSession(req.params.session), true));
});

app.use((req, res) => res.status(404).json({ ok: false, error: "not_found", path: req.path }));

app.listen(PORT, () => {
  logger.info({
    port: PORT,
    sessionRoot: SESSION_ROOT,
    apiKeyConfigured: Boolean(API_KEY),
    webhookConfigured: Boolean(WEBHOOK_URL),
    defaultStationConfigured: Boolean(DEFAULT_STATION_ID)
  }, "WhatsApp bridge started");
});

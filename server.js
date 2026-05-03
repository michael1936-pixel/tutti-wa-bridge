import express from "express";
import cors from "cors";
import pino from "pino";
import { Boom } from "@hapi/boom";
import * as baileys from "@whiskeysockets/baileys";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const {
  default: makeWASocketDefault,
  makeWASocket: makeWASocketNamed,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = baileys;

const makeWASocket = makeWASocketNamed || makeWASocketDefault;

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// ============================================================
// 🛡️ שכבה 1: מאזיני שגיאות גלובליים — מונעים קריסת התהליך
// ============================================================
process.on("uncaughtException", (err) => {
  logger.error(
    { err: err?.message, stack: err?.stack },
    "uncaughtException — keeping process alive"
  );
});
process.on("unhandledRejection", (reason) => {
  logger.error(
    { reason: reason instanceof Error ? reason.message : String(reason) },
    "unhandledRejection — keeping process alive"
  );
});

const PORT = Number(process.env.PORT) || 3000;
const SESSION_ROOT = process.env.SESSION_ROOT || "/app/data/sessions";
const API_KEY = process.env.API_KEY || "";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const DEFAULT_STATION_ID = process.env.DEFAULT_STATION_ID || "";

await fs.mkdir(SESSION_ROOT, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// API key middleware
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (!API_KEY) return next();
  const provided = req.header("x-api-key") || req.query.api_key;
  if (provided !== API_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
});

// ============================================================
// State
// ============================================================
const sessions = new Map(); // sessionId -> { sock, status, lastError, qr, pairingCode, startedAt }

function sessionDir(sessionId) {
  return path.join(SESSION_ROOT, sessionId.replace(/[^0-9a-zA-Z_-]/g, "_"));
}

// ============================================================
// 🛡️ שכבה 3: עטיפות בטוחות
// ============================================================
async function safeCloseSocket(sessionId) {
  try {
    const entry = sessions.get(sessionId);
    if (!entry?.sock) return;
    try { entry.sock.ws?.removeAllListeners(); } catch {}
    try { entry.sock.ev?.removeAllListeners(); } catch {}
    try { await entry.sock.logout?.(); } catch {}
    try { entry.sock.end?.(undefined); } catch {}
  } catch (err) {
    logger.warn({ session: sessionId, err: err?.message }, "safeCloseSocket swallowed");
  }
}

async function resetSession(sessionId, { wipe = false } = {}) {
  try {
    await safeCloseSocket(sessionId);
    sessions.delete(sessionId);
    if (wipe) {
      try {
        await fs.rm(sessionDir(sessionId), { recursive: true, force: true });
      } catch (err) {
        logger.warn({ session: sessionId, err: err?.message }, "wipe failed");
      }
    }
  } catch (err) {
    logger.warn({ session: sessionId, err: err?.message }, "resetSession swallowed");
  }
}

// ============================================================
// Webhook
// ============================================================
async function postWebhook(payload) {
  if (!WEBHOOK_URL) return;
  try {
    const body = JSON.stringify(payload);
    const sig = WEBHOOK_SECRET
      ? crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")
      : "";
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(sig ? { "x-signature": sig } : {})
      },
      body
    });
  } catch (err) {
    logger.warn({ err: err?.message }, "webhook post failed");
  }
}

// ============================================================
// Create / restore socket
// ============================================================
async function startSocket(sessionId, { phoneNumber } = {}) {
  await resetSession(sessionId, { wipe: false });

  const dir = sessionDir(sessionId);
  await fs.mkdir(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: logger.child({ session: sessionId }),
    printQRInTerminal: false,
    browser: ["Lovable Bridge", "Chrome", "120.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false
  });

  const entry = {
    sock,
    status: "connecting",
    lastError: null,
    qr: null,
    pairingCode: null,
    startedAt: Date.now()
  };
  sessions.set(sessionId, entry);

  // ============================================================
  // 🛡️ שכבה 2: מאזיני error על ה-WebSocket וה-Baileys events
  // ============================================================
  try {
    sock.ws?.on?.("error", (err) => {
      logger.warn(
        { session: sessionId, err: err?.message },
        "WebSocket error swallowed"
      );
      const e = sessions.get(sessionId);
      if (e) e.lastError = err?.message || "ws_error";
    });
  } catch (err) {
    logger.warn({ err: err?.message }, "ws error listener attach failed");
  }

  try {
    sock.ev?.on?.("error", (err) => {
      logger.warn(
        { session: sessionId, err: err?.message },
        "Baileys ev error swallowed"
      );
    });
  } catch {}

  sock.ev.on("creds.update", saveCreds);

  // ============================================================
  // Pairing code (if requested and not registered)
  // ============================================================
  if (phoneNumber && !state.creds.registered) {
    try {
      // Wait briefly for the socket to be ready
      await new Promise((r) => setTimeout(r, 1500));
      const cleaned = String(phoneNumber).replace(/\D/g, "");
      const code = await sock.requestPairingCode(cleaned);
      entry.pairingCode = code;
      logger.info({ session: sessionId, code }, "pairing code generated");
    } catch (err) {
      logger.error(
        { session: sessionId, err: err?.message },
        "requestPairingCode failed"
      );
      entry.lastError = err?.message || "pairing_failed";
    }
  }

  // ============================================================
  // 🛡️ שכבה 4: connection.update — תיקון restart loop
  // ============================================================
  sock.ev.on("connection.update", async (update) => {
    try {
      const { connection, lastDisconnect, qr } = update;
      const e = sessions.get(sessionId);
      if (!e) return;

      if (qr) e.qr = qr;

      if (connection === "open") {
        e.status = "open";
        e.lastError = null;
        logger.info({ session: sessionId }, "WhatsApp connected");
        await postWebhook({
          type: "connection.open",
          sessionId,
          timestamp: Date.now()
        });
        return;
      }

      if (connection === "close") {
        const statusCode =
          new Boom(lastDisconnect?.error)?.output?.statusCode ||
          lastDisconnect?.error?.output?.statusCode;
        const reason =
          lastDisconnect?.error?.message || "connection_closed";
        e.status = "closed";
        e.lastError = reason;

        logger.warn(
          { session: sessionId, statusCode, reason },
          "Connection Closed"
        );

        await postWebhook({
          type: "connection.close",
          sessionId,
          statusCode,
          reason,
          timestamp: Date.now()
        });

        // 428 = session conflict during pairing — DO NOT wipe creds, retry
        if (statusCode === 428) {
          logger.info(
            { session: sessionId },
            "428 — keeping creds, reconnecting in 3s"
          );
          setTimeout(() => {
            startSocket(sessionId).catch((err) =>
              logger.error(
                { session: sessionId, err: err?.message },
                "reconnect after 428 failed"
              )
            );
          }, 3000);
          return;
        }

        // Logged out → wipe and stop
        if (statusCode === DisconnectReason.loggedOut) {
          logger.info({ session: sessionId }, "Logged out — wiping session");
          await resetSession(sessionId, { wipe: true });
          return;
        }

        // Other transient → reconnect without wipe
        const shouldReconnect =
          statusCode !== DisconnectReason.forbidden &&
          statusCode !== DisconnectReason.badSession;

        if (shouldReconnect) {
          setTimeout(() => {
            startSocket(sessionId).catch((err) =>
              logger.error(
                { session: sessionId, err: err?.message },
                "reconnect failed"
              )
            );
          }, 5000);
        } else {
          logger.warn(
            { session: sessionId, statusCode },
            "Not reconnecting — wiping"
          );
          await resetSession(sessionId, { wipe: true });
        }
      }
    } catch (err) {
      logger.error(
        { session: sessionId, err: err?.message },
        "connection.update handler swallowed"
      );
    }
  });

  // Forward incoming messages to webhook
  sock.ev.on("messages.upsert", async (m) => {
    try {
      await postWebhook({
        type: "messages.upsert",
        sessionId,
        data: m,
        timestamp: Date.now()
      });
    } catch (err) {
      logger.warn({ err: err?.message }, "messages.upsert webhook failed");
    }
  });

  return entry;
}

// ============================================================
// HTTP routes
// ============================================================
app.get("/health", (req, res) => {
  const list = [];
  for (const [id, s] of sessions.entries()) {
    list.push({
      sessionId: id,
      status: s.status,
      lastError: s.lastError,
      hasPairingCode: Boolean(s.pairingCode),
      uptimeMs: Date.now() - s.startedAt
    });
  }
  res.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    sessions: list
  });
});

app.post("/pair", async (req, res) => {
  try {
    const { sessionId, phoneNumber } = req.body || {};
    const sid = sessionId || phoneNumber;
    if (!sid || !phoneNumber) {
      return res
        .status(400)
        .json({ ok: false, error: "sessionId and phoneNumber required" });
    }
    await startSocket(sid, { phoneNumber });
    // give pairing code a moment to be generated
    await new Promise((r) => setTimeout(r, 2500));
    const entry = sessions.get(sid);
    return res.json({
      ok: true,
      sessionId: sid,
      pairingCode: entry?.pairingCode || null,
      status: entry?.status || "unknown",
      lastError: entry?.lastError || null
    });
  } catch (err) {
    logger.error({ err: err?.message }, "/pair failed");
    res.status(500).json({ ok: false, error: err?.message || "pair_failed" });
  }
});

app.get("/status/:sessionId", (req, res) => {
  const entry = sessions.get(req.params.sessionId);
  if (!entry) {
    return res.json({
      ok: true,
      status: "not_started",
      lastError: null,
      pairingCode: null
    });
  }
  res.json({
    ok: true,
    status: entry.status,
    lastError: entry.lastError,
    pairingCode: entry.pairingCode,
    hasQR: Boolean(entry.qr)
  });
});

app.post("/logout/:sessionId", async (req, res) => {
  await resetSession(req.params.sessionId, { wipe: true });
  res.json({ ok: true });
});

app.post("/send", async (req, res) => {
  try {
    const { sessionId, to, text } = req.body || {};
    if (!sessionId || !to || !text) {
      return res
        .status(400)
        .json({ ok: false, error: "sessionId, to, text required" });
    }
    const entry = sessions.get(sessionId);
    if (!entry || entry.status !== "open") {
      return res
        .status(409)
        .json({ ok: false, error: "session_not_open" });
    }
    const jid = to.includes("@") ? to : `${to.replace(/\D/g, "")}@s.whatsapp.net`;
    const result = await entry.sock.sendMessage(jid, { text });
    res.json({ ok: true, id: result?.key?.id || null });
  } catch (err) {
    logger.error({ err: err?.message }, "/send failed");
    res.status(500).json({ ok: false, error: err?.message || "send_failed" });
  }
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: "not_found", path: req.path });
});

app.listen(PORT, () => {
  logger.info(
    {
      port: PORT,
      sessionRoot: SESSION_ROOT,
      apiKeyConfigured: Boolean(API_KEY),
      webhookConfigured: Boolean(WEBHOOK_URL),
      defaultStationConfigured: Boolean(DEFAULT_STATION_ID)
    },
    "WhatsApp bridge started"
  );
});

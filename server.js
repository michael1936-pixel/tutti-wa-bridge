const express = require("express");
const qrcode = require("qrcode");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const { Boom } = require("@hapi/boom");

const baileys = require("@whiskeysockets/baileys");
const makeWASocket = baileys.default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = baileys;

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const AUTH_DIR = process.env.AUTH_DIR || "/app/auth";

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
});

let sock = null;
let startingPromise = null;

let connected = false;
let currentQR = null;
let currentQRDataUrl = null;
let latestPairCode = null;
let lastError = null;
let lastDisconnectReason = null;
let startedAt = new Date().toISOString();

function ensureAuthDir() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

function requireKey(req, res, next) {
  if (!API_KEY) {
    return res.status(500).json({
      ok: false,
      error: "API_KEY is not configured on Railway",
    });
  }

  const provided =
    req.headers["x-api-key"] ||
    req.headers["X-Api-Key"] ||
    req.query.key;

  if (provided !== API_KEY) {
    return res.status(401).json({
      ok: false,
      error: "unauthorized",
    });
  }

  next();
}

function normalizePairingPhone(phone) {
  if (!phone) return null;

  let p = String(phone).replace(/\D/g, "");

  if (p.startsWith("972")) return p;
  if (p.startsWith("0")) return "972" + p.slice(1);
  if (p.length === 9) return "972" + p;

  return p;
}

function normalizeJid(jid) {
  if (!jid) return null;

  const raw = String(jid).trim();

  if (raw.includes("@s.whatsapp.net") || raw.includes("@g.us")) {
    return raw;
  }

  const digits = raw.replace(/\D/g, "");

  if (!digits) return raw;

  let phone = digits;
  if (phone.startsWith("0")) phone = "972" + phone.slice(1);
  if (phone.length === 9) phone = "972" + phone;

  return `${phone}@s.whatsapp.net`;
}

async function removeAuthSession() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
  } catch (e) {
    logger.error({ err: e }, "failed to remove auth session");
  }

  ensureAuthDir();

  connected = false;
  currentQR = null;
  currentQRDataUrl = null;
  latestPairCode = null;
}

async function startSock() {
  if (startingPromise) return startingPromise;

  startingPromise = (async () => {
    ensureAuthDir();

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    logger.info({ version, AUTH_DIR }, "starting WhatsApp socket");

    sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: Browsers.ubuntu("Chrome"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = qr;
        latestPairCode = null;

        try {
          currentQRDataUrl = await qrcode.toDataURL(qr);
        } catch (e) {
          logger.error({ err: e }, "failed to generate QR data url");
          currentQRDataUrl = null;
        }

        logger.info("new QR received");
      }

      if (connection === "open") {
        connected = true;
        currentQR = null;
        currentQRDataUrl = null;
        latestPairCode = null;
        lastError = null;
        lastDisconnectReason = null;

        logger.info(
          {
            user: sock?.user,
          },
          "WhatsApp connected"
        );
      }

      if (connection === "close") {
        connected = false;

        const statusCode =
          new Boom(lastDisconnect?.error)?.output?.statusCode;

        lastDisconnectReason = statusCode || null;
        lastError =
          lastDisconnect?.error?.message ||
          lastDisconnect?.error?.toString() ||
          null;

        logger.warn(
          {
            statusCode,
            error: lastError,
          },
          "WhatsApp connection closed"
        );

        const loggedOut = statusCode === DisconnectReason.loggedOut;

        if (loggedOut) {
          logger.warn("WhatsApp logged out, wiping auth session");
          await removeAuthSession();
        }

        sock = null;
        startingPromise = null;

        if (!loggedOut) {
          setTimeout(() => {
            startSock().catch((e) => {
              logger.error({ err: e }, "reconnect failed");
            });
          }, 3000);
        }
      }
    });

    return sock;
  })();

  try {
    return await startingPromise;
  } finally {
    startingPromise = null;
  }
}

async function ensureSock() {
  if (sock) return sock;
  return await startSock();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Public healthcheck for Railway.
 * Do NOT put QR data here because this route is public.
 */
app.get("/status", (req, res) => {
  res.json({
    ok: true,
    connected,
    hasQR: Boolean(currentQRDataUrl),
    hasPairCode: Boolean(latestPairCode),
    startedAt,
    lastError,
    lastDisconnectReason,
    user: connected && sock?.user
      ? {
          id: sock.user.id,
          name: sock.user.name,
        }
      : null,
  });
});

/**
 * Protected QR endpoint.
 */
app.get("/qr", requireKey, async (req, res) => {
  if (connected) {
    return res.json({
      ok: true,
      connected: true,
      qr: null,
      message: "already connected",
    });
  }

  await ensureSock();

  if (!currentQRDataUrl) {
    return res.json({
      ok: true,
      connected: false,
      qr: null,
      hasQR: false,
      message: "QR not ready yet, refresh in a few seconds",
    });
  }

  res.json({
    ok: true,
    connected: false,
    hasQR: true,
    qr: currentQRDataUrl,
  });
});

/**
 * Protected pairing-code endpoint.
 *
 * Body:
 * {
 *   "phone": "0521234567"
 * }
 *
 * Then in WhatsApp:
 * Linked devices -> Link a device -> Link with phone number instead
 */
app.post("/pair-code", requireKey, async (req, res) => {
  if (connected) {
    return res.json({
      ok: true,
      connected: true,
      code: null,
      message: "already connected",
    });
  }

  const phone = normalizePairingPhone(req.body?.phone);

  if (!phone || phone.length < 10) {
    return res.status(400).json({
      ok: false,
      error: "missing or invalid phone. Example: 0521234567",
    });
  }

  try {
    const s = await ensureSock();

    if (s.authState?.creds?.registered) {
      return res.status(409).json({
        ok: false,
        error:
          "Existing WhatsApp session exists but is not connected. Call /reset-session first, then request a new pairing code.",
      });
    }

    /**
     * Small delay helps Baileys finish socket initialization before requesting code.
     */
    await wait(1200);

    const code = await s.requestPairingCode(phone);

    latestPairCode = code;
    currentQR = null;
    currentQRDataUrl = null;

    logger.info({ phone }, "pairing code generated");

    res.json({
      ok: true,
      connected: false,
      phone,
      code,
      instructions:
        "Open WhatsApp -> Linked devices -> Link a device -> Link with phone number instead -> enter this code",
    });
  } catch (e) {
    logger.error({ err: e }, "failed to request pairing code");

    res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

/**
 * Protected reset endpoint.
 * Use this if QR/code got stuck, or old session exists.
 */
app.post("/reset-session", requireKey, async (req, res) => {
  try {
    try {
      if (sock) {
        await sock.logout().catch(() => {});
      }
    } catch (_) {}

    sock = null;
    startingPromise = null;

    await removeAuthSession();
    await startSock();

    res.json({
      ok: true,
      message: "session reset. Now call /qr or /pair-code again.",
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

/**
 * Send WhatsApp message.
 *
 * Body:
 * {
 *   "jid": "120363xxxx@g.us",
 *   "text": "hello"
 * }
 *
 * Also accepts a phone number as jid for private messages.
 */
app.post("/send", requireKey, async (req, res) => {
  try {
    const jid = normalizeJid(req.body?.jid);
    const text = req.body?.text;

    if (!jid || !text) {
      return res.status(400).json({
        ok: false,
        error: "jid and text are required",
      });
    }

    if (!connected || !sock) {
      return res.status(503).json({
        ok: false,
        error: "not connected",
      });
    }

    const result = await sock.sendMessage(jid, {
      text: String(text),
    });

    res.json({
      ok: true,
      jid,
      messageId: result?.key?.id || null,
    });
  } catch (e) {
    logger.error({ err: e }, "send failed");

    res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

/**
 * List WhatsApp groups.
 * Use this to copy group JIDs into your app settings.
 */
app.get("/groups", requireKey, async (req, res) => {
  try {
    if (!connected || !sock) {
      return res.status(503).json({
        ok: false,
        error: "not connected",
      });
    }

    const groups = await sock.groupFetchAllParticipating();

    const list = Object.values(groups).map((g) => ({
      jid: g.id,
      name: g.subject,
      participants: g.participants?.length || 0,
    }));

    res.json({
      ok: true,
      groups: list,
    });
  } catch (e) {
    logger.error({ err: e }, "groups failed");

    res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "wa-bridge",
    status: "/status",
  });
});

app.listen(PORT, () => {
  logger.info(`HTTP listening on ${PORT}`);
  startSock().catch((e) => logger.error({ err: e }, "initial start failed"));
});

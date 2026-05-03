// server.js
// WhatsApp Bridge for Lovable / Railway
// Stable Baileys pairing-code build
//
// Endpoints:
//   GET  /health
//   POST /pair        { phone, forceReset? }
//   GET  /status/:phone
//   POST /reset       { phone }
//   POST /logout      { phone }
//   POST /send        { phone, to, text }
//
// Important:
// - This file intentionally uses dynamic import for Baileys.
// - This fixes: "makeWASocket is not a function"
// - Pairing code is kept alive by disabling Baileys QR timeout.
// - Temporary disconnects during pairing reconnect silently while the code is still valid.

import express from "express";
import pino from "pino";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import process from "node:process";

const baileysModule = await import("@whiskeysockets/baileys");

const baileysDefault = baileysModule.default;

const fromDefault = (key) => {
  if (baileysDefault && typeof baileysDefault === "object") {
    return baileysDefault[key];
  }
  return undefined;
};

const makeWASocket =
  (typeof baileysDefault === "function" ? baileysDefault : undefined) ||
  fromDefault("default") ||
  fromDefault("makeWASocket") ||
  baileysModule.makeWASocket;

const useMultiFileAuthState =
  baileysModule.useMultiFileAuthState || fromDefault("useMultiFileAuthState");

const DisconnectReason =
  baileysModule.DisconnectReason || fromDefault("DisconnectReason") || {};

const Browsers =
  baileysModule.Browsers ||
  fromDefault("Browsers") || {
    ubuntu: () => ["Ubuntu", "Chrome", "110.0.0"],
  };

const fetchLatestBaileysVersion =
  baileysModule.fetchLatestBaileysVersion ||
  fromDefault("fetchLatestBaileysVersion");

const makeCacheableSignalKeyStore =
  baileysModule.makeCacheableSignalKeyStore ||
  fromDefault("makeCacheableSignalKeyStore");

if (typeof makeWASocket !== "function") {
  throw new Error(
    "Baileys import failed: makeWASocket is not a function. Check @whiskeysockets/baileys version."
  );
}

if (typeof useMultiFileAuthState !== "function") {
  throw new Error(
    "Baileys import failed: useMultiFileAuthState is not a function."
  );
}

const app = express();

const PORT = Number(process.env.PORT || 3000);
const API_KEY =
  process.env.BRIDGE_API_KEY ||
  process.env.API_KEY ||
  process.env.WHATSAPP_BRIDGE_API_KEY ||
  "";

const SESSIONS_DIR =
  process.env.SESSIONS_DIR || path.join(process.cwd(), "sessions");

const LOG_LEVEL = process.env.LOG_LEVEL || "info";

const CODE_TTL_MS = Number(process.env.CODE_TTL_MS || 3 * 60 * 1000);
const PAIR_WAIT_MS = Number(process.env.PAIR_WAIT_MS || 45 * 1000);
const SEND_WAIT_MS = Number(process.env.SEND_WAIT_MS || 25 * 1000);

const logger = pino({
  level: LOG_LEVEL,
  transport:
    process.env.NODE_ENV === "development"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
          },
        }
      : undefined,
});

fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const sessions = new Map();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePhone(input) {
  let phone = String(input || "").trim();

  phone = phone.replace(/[^\d]/g, "");

  if (!phone) return "";

  if (phone.startsWith("00")) {
    phone = phone.slice(2);
  }

  // Israeli local number:
  // 0541234567 -> 972541234567
  if (phone.startsWith("0")) {
    phone = `972${phone.slice(1)}`;
  }

  // Bad format sometimes sent as 9720541234567
  // Convert to 972541234567
  if (phone.startsWith("9720")) {
    phone = `972${phone.slice(4)}`;
  }

  return phone;
}

function sessionDir(phone) {
  return path.join(SESSIONS_DIR, phone);
}

async function removeSessionFiles(phone) {
  await fsp.rm(sessionDir(phone), {
    recursive: true,
    force: true,
  });
}

function getHeaderValue(req, name) {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value || "";
}

function readRequestApiKey(req) {
  const xApiKey =
    getHeaderValue(req, "x-api-key") ||
    getHeaderValue(req, "x-bridge-api-key") ||
    getHeaderValue(req, "apikey") ||
    "";

  if (xApiKey) return String(xApiKey).trim();

  const auth = getHeaderValue(req, "authorization");

  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }

  return "";
}

function requireApiKey(req, res, next) {
  if (req.method === "OPTIONS") return next();

  if (req.path === "/health") return next();

  if (!API_KEY) {
    logger.warn(
      "BRIDGE_API_KEY/API_KEY is not set. API is currently unprotected."
    );
    return next();
  }

  const provided = readRequestApiKey(req);

  if (!provided || provided !== API_KEY) {
    return res.status(401).json({
      ok: false,
      error: "unauthorized",
    });
  }

  return next();
}

function safeSocketEnd(sock) {
  if (!sock) return;

  try {
    sock.ev?.removeAllListeners?.();
  } catch {
    // ignore
  }

  try {
    sock.end?.();
  } catch {
    // ignore
  }

  try {
    sock.ws?.close?.();
  } catch {
    // ignore
  }
}

function createSession(phone) {
  return {
    phone,
    sock: null,
    status: "disconnected",
    pairingCode: null,
    rawPairingCode: null,
    codeExpiresAt: null,
    lastError: null,
    hadPairingCode: false,
    credsRegistered: false,
    starting: null,
    reconnectTimer: null,
    expiryTimer: null,
    shouldStop: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function touchSession(session) {
  session.updatedAt = new Date().toISOString();
}

function isCodeStillValid(session) {
  return Boolean(
    session.pairingCode &&
      session.codeExpiresAt &&
      Date.now() < Number(session.codeExpiresAt)
  );
}

function expireCodeIfNeeded(session) {
  if (
    session.status !== "connected" &&
    session.codeExpiresAt &&
    Date.now() >= Number(session.codeExpiresAt)
  ) {
    session.pairingCode = null;
    session.rawPairingCode = null;
    session.codeExpiresAt = null;

    if (
      session.status === "pairing_code_ready" ||
      session.status === "pairing_requested"
    ) {
      session.status = "disconnected";
      session.lastError = session.lastError || "pairing_code_expired";
    }

    touchSession(session);
  }
}

function publicSession(session) {
  if (!session) {
    return {
      status: "disconnected",
    };
  }

  expireCodeIfNeeded(session);

  return {
    phone: session.phone,
    status: session.status,
    pairingCode: isCodeStillValid(session) ? session.pairingCode : undefined,
    codeExpiresAt: isCodeStillValid(session)
      ? new Date(session.codeExpiresAt).toISOString()
      : undefined,
    lastError: session.lastError || undefined,
    updatedAt: session.updatedAt,
  };
}

function formatPairingCode(code) {
  const raw = String(code || "").replace(/\s/g, "");

  // Keep existing dash format if Baileys already returns it.
  if (raw.includes("-")) return raw;

  // WhatsApp usually shows an 8-char code.
  // Format as XXXX-XXXX for readability.
  if (raw.length === 8) {
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  }

  return raw;
}

function getDisconnectStatusCode(lastDisconnect) {
  return (
    lastDisconnect?.error?.output?.statusCode ||
    lastDisconnect?.error?.data?.statusCode ||
    lastDisconnect?.error?.statusCode ||
    undefined
  );
}

function getDisconnectMessage(lastDisconnect) {
  return (
    lastDisconnect?.error?.message ||
    lastDisconnect?.error?.output?.payload?.message ||
    lastDisconnect?.error?.toString?.() ||
    ""
  );
}

function scheduleCodeExpiry(session) {
  if (session.expiryTimer) {
    clearTimeout(session.expiryTimer);
    session.expiryTimer = null;
  }

  if (!session.codeExpiresAt) return;

  const ms = Math.max(0, Number(session.codeExpiresAt) - Date.now());

  session.expiryTimer = setTimeout(() => {
    if (session.status !== "connected" && !session.shouldStop) {
      session.pairingCode = null;
      session.rawPairingCode = null;
      session.codeExpiresAt = null;
      session.status = "disconnected";
      session.lastError = "pairing_code_expired";
      session.shouldStop = true;

      safeSocketEnd(session.sock);

      logger.warn(
        {
          phone: session.phone,
        },
        "pairing code expired"
      );

      touchSession(session);
    }
  }, ms + 500);
}

function scheduleReconnect(session, delayMs = 1500) {
  if (session.shouldStop) return;

  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }

  session.reconnectTimer = setTimeout(() => {
    if (session.shouldStop) return;

    logger.info(
      {
        phone: session.phone,
      },
      "silent reconnect"
    );

    startSession(session.phone, {
      restart: true,
      silentReconnect: true,
    }).catch((error) => {
      session.status = "error";
      session.lastError = error?.message || String(error);
      touchSession(session);

      logger.error(
        {
          phone: session.phone,
          error: session.lastError,
        },
        "silent reconnect failed"
      );
    });
  }, delayMs);
}

async function requestPairingCodeWithRetries(session, sock, phone) {
  if (session.shouldStop) return;

  if (isCodeStillValid(session)) return;

  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (session.shouldStop) return;
    if (sock !== session.sock) return;
    if (isCodeStillValid(session)) return;

    try {
      session.status = "pairing_requested";
      session.lastError = null;
      touchSession(session);

      logger.info(
        {
          phone,
          attempt,
        },
        "requesting WhatsApp pairing code"
      );

      const code = await sock.requestPairingCode(phone);

      session.rawPairingCode = String(code || "");
      session.pairingCode = formatPairingCode(code);
      session.codeExpiresAt = Date.now() + CODE_TTL_MS;
      session.status = "pairing_code_ready";
      session.hadPairingCode = true;
      session.lastError = null;

      scheduleCodeExpiry(session);
      touchSession(session);

      logger.info(
        {
          phone,
          codeExpiresAt: new Date(session.codeExpiresAt).toISOString(),
        },
        "pairing code ready"
      );

      return;
    } catch (error) {
      session.lastError = error?.message || String(error);
      touchSession(session);

      logger.warn(
        {
          phone,
          attempt,
          error: session.lastError,
        },
        "request pairing code failed"
      );

      if (attempt < maxAttempts) {
        await delay(1800);
      }
    }
  }

  if (!isCodeStillValid(session) && session.status !== "connected") {
    session.status = "error";
    session.lastError = session.lastError || "pairing_code_request_failed";
    touchSession(session);
  }
}

async function launchSession(session, options = {}) {
  const phone = session.phone;

  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }

  session.shouldStop = false;

  if (!options.silentReconnect && !isCodeStillValid(session)) {
    session.pairingCode = null;
    session.rawPairingCode = null;
    session.codeExpiresAt = null;
  }

  if (session.status !== "pairing_code_ready") {
    session.status = "connecting";
  }

  session.lastError = null;
  touchSession(session);

  safeSocketEnd(session.sock);
  session.sock = null;

  fs.mkdirSync(sessionDir(phone), {
    recursive: true,
  });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir(phone));

  session.credsRegistered = Boolean(state?.creds?.registered);

  let version;

  if (typeof fetchLatestBaileysVersion === "function") {
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest?.version;
    } catch (error) {
      logger.warn(
        {
          phone,
          error: error?.message || String(error),
        },
        "failed fetching latest Baileys version, continuing without explicit version"
      );
    }
  }

  const socketLogger = logger.child({
    phone,
    component: "baileys",
  });

  const auth = {
    creds: state.creds,
    keys:
      typeof makeCacheableSignalKeyStore === "function"
        ? makeCacheableSignalKeyStore(state.keys, socketLogger)
        : state.keys,
  };

  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth,
    logger: socketLogger,
    browser:
      Browsers && typeof Browsers.ubuntu === "function"
        ? Browsers.ubuntu("Chrome")
        : ["Ubuntu", "Chrome", "110.0.0"],

    printQRInTerminal: false,

    // Critical:
    // Prevents Baileys from killing the pairing session after ~20 seconds.
    qrTimeout: 0,

    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 120_000,
    keepAliveIntervalMs: 30_000,
    emitOwnEvents: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  session.sock = sock;
  touchSession(session);

  sock.ev.on("creds.update", async () => {
    try {
      await saveCreds();
      session.credsRegistered = Boolean(state?.creds?.registered);
      touchSession(session);
    } catch (error) {
      session.lastError = error?.message || String(error);
      touchSession(session);

      logger.error(
        {
          phone,
          error: session.lastError,
        },
        "failed saving credentials"
      );
    }
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update || {};

    if (qr) {
      logger.info(
        {
          phone,
        },
        "QR event received but ignored because pairing-code flow is used"
      );
    }

    if (connection === "connecting") {
      if (!isCodeStillValid(session)) {
        session.status = "connecting";
      }

      touchSession(session);
      return;
    }

    if (connection === "open") {
      session.status = "connected";
      session.pairingCode = null;
      session.rawPairingCode = null;
      session.codeExpiresAt = null;
      session.lastError = null;
      session.credsRegistered = true;

      if (session.expiryTimer) {
        clearTimeout(session.expiryTimer);
        session.expiryTimer = null;
      }

      touchSession(session);

      logger.info(
        {
          phone,
        },
        "WhatsApp connected"
      );

      return;
    }

    if (connection === "close") {
      const statusCode = getDisconnectStatusCode(lastDisconnect);
      const message = getDisconnectMessage(lastDisconnect);

      const loggedOut =
        statusCode === DisconnectReason.loggedOut || statusCode === 401;

      const restartRequired =
        statusCode === DisconnectReason.restartRequired || statusCode === 515;

      session.lastError =
        message ||
        `connection_closed_${statusCode ? String(statusCode) : "unknown"}`;

      touchSession(session);

      logger.warn(
        {
          phone,
          statusCode,
          loggedOut,
          restartRequired,
          error: session.lastError,
        },
        "WhatsApp connection closed"
      );

      if (session.shouldStop) {
        session.status = "disconnected";
        touchSession(session);
        return;
      }

      if (loggedOut) {
        session.status = "logged_out";
        session.pairingCode = null;
        session.rawPairingCode = null;
        session.codeExpiresAt = null;
        touchSession(session);
        return;
      }

      // Main fix:
      // If Railway/Baileys closes the socket while the user still has a valid
      // pairing code, do NOT wipe auth and do NOT lose the code.
      // Reconnect silently and keep status as pairing_code_ready.
      if (isCodeStillValid(session)) {
        session.status = "pairing_code_ready";
        touchSession(session);
        scheduleReconnect(session, restartRequired ? 500 : 1500);
        return;
      }

      // If credentials are already registered, reconnect normally.
      if (session.credsRegistered) {
        session.status = "reconnecting";
        touchSession(session);
        scheduleReconnect(session, restartRequired ? 500 : 1500);
        return;
      }

      session.status = "disconnected";
      touchSession(session);
    }
  });

  if (!state?.creds?.registered) {
    setTimeout(() => {
      requestPairingCodeWithRetries(session, sock, phone).catch((error) => {
        session.status = "error";
        session.lastError = error?.message || String(error);
        touchSession(session);

        logger.error(
          {
            phone,
            error: session.lastError,
          },
          "pairing code flow failed"
        );
      });
    }, 1500);
  }

  return session;
}

async function startSession(phoneInput, options = {}) {
  const phone = normalizePhone(phoneInput);

  if (!phone) {
    throw new Error("phone is required");
  }

  if (options.forceReset) {
    await stopSession(phone, {
      removeFiles: true,
      logout: false,
    });
  }

  let session = sessions.get(phone);

  if (!session) {
    session = createSession(phone);
    sessions.set(phone, session);
  }

  expireCodeIfNeeded(session);

  if (session.starting) {
    await session.starting;
    return session;
  }

  const activeStatuses = new Set([
    "connecting",
    "pairing_requested",
    "pairing_code_ready",
    "connected",
    "reconnecting",
  ]);

  if (
    !options.restart &&
    session.sock &&
    activeStatuses.has(session.status)
  ) {
    if (session.status !== "pairing_code_ready" || isCodeStillValid(session)) {
      return session;
    }
  }

  session.starting = launchSession(session, options).finally(() => {
    session.starting = null;
  });

  await session.starting;

  return session;
}

async function stopSession(phoneInput, options = {}) {
  const phone = normalizePhone(phoneInput);

  if (!phone) {
    throw new Error("phone is required");
  }

  const session = sessions.get(phone);

  if (session) {
    session.shouldStop = true;

    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
    }

    if (session.expiryTimer) {
      clearTimeout(session.expiryTimer);
      session.expiryTimer = null;
    }

    if (options.logout && session.sock) {
      try {
        await session.sock.logout();
      } catch (error) {
        logger.warn(
          {
            phone,
            error: error?.message || String(error),
          },
          "logout failed or already logged out"
        );
      }
    }

    safeSocketEnd(session.sock);

    sessions.delete(phone);
  }

  if (options.removeFiles) {
    await removeSessionFiles(phone);
  }
}

async function waitForPairingResult(session, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    expireCodeIfNeeded(session);

    if (session.status === "connected") return session;
    if (isCodeStillValid(session)) return session;

    if (
      session.status === "error" ||
      session.status === "logged_out"
    ) {
      return session;
    }

    await delay(500);
  }

  return session;
}

async function waitForConnected(session, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (session.status === "connected") return true;

    if (
      session.status === "error" ||
      session.status === "logged_out" ||
      session.status === "disconnected"
    ) {
      return false;
    }

    await delay(500);
  }

  return session.status === "connected";
}

function jidForRecipient(to) {
  const raw = String(to || "").trim();

  if (!raw) return "";

  if (raw.includes("@")) return raw;

  return `${normalizePhone(raw)}@s.whatsapp.net`;
}

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Api-Key, X-Bridge-Api-Key, ApiKey"
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );

  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }

  return next();
});

app.use(
  express.json({
    limit: "2mb",
  })
);

app.use(requireApiKey);

app.get("/health", (req, res) => {
  const statusCounts = {};

  for (const session of sessions.values()) {
    expireCodeIfNeeded(session);
    statusCounts[session.status] = (statusCounts[session.status] || 0) + 1;
  }

  res.json({
    ok: true,
    service: "whatsapp-bridge",
    time: new Date().toISOString(),
    sessionsDir: SESSIONS_DIR,
    sessions: sessions.size,
    statusCounts,
    baileys: {
      makeWASocket: typeof makeWASocket,
      useMultiFileAuthState: typeof useMultiFileAuthState,
    },
  });
});

app.post("/pair", async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    const forceReset =
      req.body?.forceReset === true || req.body?.forceReset === "true";

    if (!phone) {
      return res.status(400).json({
        ok: false,
        error: "phone is required",
      });
    }

    const session = await startSession(phone, {
      forceReset,
    });

    await waitForPairingResult(session, PAIR_WAIT_MS);

    const data = publicSession(session);

    if (data.status === "connected") {
      return res.json({
        ok: true,
        phone,
        status: "connected",
      });
    }

    if (data.pairingCode) {
      return res.json({
        ok: true,
        phone,
        status: data.status,
        code: data.pairingCode,
        pairingCode: data.pairingCode,
        codeExpiresAt: data.codeExpiresAt,
      });
    }

    return res.status(500).json({
      ok: false,
      phone,
      status: data.status,
      error: data.lastError || "pairing_code_not_ready",
      lastError: data.lastError,
    });
  } catch (error) {
    logger.error(
      {
        error: error?.message || String(error),
      },
      "pair endpoint failed"
    );

    return res.status(500).json({
      ok: false,
      error: error?.message || String(error),
    });
  }
});

app.get("/status/:phone", (req, res) => {
  try {
    const phone = normalizePhone(req.params.phone);

    if (!phone) {
      return res.status(400).json({
        ok: false,
        error: "phone is required",
      });
    }

    const session = sessions.get(phone);
    const data = publicSession(session);

    return res.json({
      ok: true,
      phone,
      ...data,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error),
    });
  }
});

app.post("/reset", async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);

    if (!phone) {
      return res.status(400).json({
        ok: false,
        error: "phone is required",
      });
    }

    await stopSession(phone, {
      removeFiles: true,
      logout: false,
    });

    return res.json({
      ok: true,
      phone,
      status: "reset",
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error),
    });
  }
});

app.post("/logout", async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);

    if (!phone) {
      return res.status(400).json({
        ok: false,
        error: "phone is required",
      });
    }

    await stopSession(phone, {
      removeFiles: true,
      logout: true,
    });

    return res.json({
      ok: true,
      phone,
      status: "logged_out",
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error),
    });
  }
});

app.post("/send", async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone || req.body?.from);
    const to = req.body?.to;
    const text = String(req.body?.text || "");

    if (!phone) {
      return res.status(400).json({
        ok: false,
        error: "phone is required",
      });
    }

    if (!to) {
      return res.status(400).json({
        ok: false,
        error: "to is required",
      });
    }

    if (!text.trim()) {
      return res.status(400).json({
        ok: false,
        error: "text is required",
      });
    }

    const session = await startSession(phone);

    const connected = await waitForConnected(session, SEND_WAIT_MS);

    if (!connected || !session.sock) {
      const data = publicSession(session);

      return res.status(409).json({
        ok: false,
        phone,
        status: data.status,
        error: data.lastError || "whatsapp_not_connected",
        lastError: data.lastError,
      });
    }

    const jid = jidForRecipient(to);

    if (!jid) {
      return res.status(400).json({
        ok: false,
        error: "invalid recipient",
      });
    }

    const result = await session.sock.sendMessage(jid, {
      text,
    });

    return res.json({
      ok: true,
      phone,
      to: jid,
      id: result?.key?.id,
    });
  } catch (error) {
    logger.error(
      {
        error: error?.message || String(error),
      },
      "send endpoint failed"
    );

    return res.status(500).json({
      ok: false,
      error: error?.message || String(error),
    });
  }
});

process.on("SIGINT", async () => {
  logger.info("SIGINT received, closing sessions");

  for (const session of sessions.values()) {
    session.shouldStop = true;
    safeSocketEnd(session.sock);
  }

  process.exit(0);
});

process.on("SIGTERM", async () => {
  logger.info("SIGTERM received, closing sessions");

  for (const session of sessions.values()) {
    session.shouldStop = true;
    safeSocketEnd(session.sock);
  }

  process.exit(0);
});

app.listen(PORT, () => {
  logger.info(
    {
      port: PORT,
      sessionsDir: SESSIONS_DIR,
      apiKeyEnabled: Boolean(API_KEY),
      codeTtlMs: CODE_TTL_MS,
    },
    "WhatsApp bridge is up"
  );
});

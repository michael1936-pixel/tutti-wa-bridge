import express from "express";
import pino from "pino";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);

const API_KEY =
  process.env.API_KEY ||
  process.env.BRIDGE_API_KEY ||
  process.env.WHATSAPP_VPS_API_KEY ||
  process.env.WA_BRIDGE_API_KEY ||
  "";

const SESSIONS_DIR =
  process.env.SESSIONS_DIR || path.join(__dirname, "sessions");

const log = pino({
  level: process.env.LOG_LEVEL || "info"
});

const app = express();

app.use(
  express.json({
    limit: "1mb"
  })
);

const sessions = new Map();

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePhone(input) {
  const raw = String(input || "").trim();
  let digits = raw.replace(/\D/g, "");

  if (!digits) {
    return "";
  }

  if (digits.startsWith("00")) {
    digits = digits.slice(2);
  }

  if (digits.startsWith("0") && digits.length >= 9) {
    digits = `972${digits.slice(1)}`;
  }

  return digits;
}

function sanitizeSessionId(input) {
  const value = String(input || "").trim();

  if (!value) {
    return "default";
  }

  const phone = normalizePhone(value);
  const base = phone || value;

  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 80) || "default"
  );
}

function getRequestedSessionId(req) {
  const fromBody =
    req.body?.sessionId ||
    req.body?.session_id ||
    req.body?.phone ||
    req.body?.number;

  const fromQuery =
    req.query?.sessionId ||
    req.query?.session_id ||
    req.query?.phone ||
    req.query?.number;

  return sanitizeSessionId(fromBody || fromQuery || "default");
}

function getProvidedApiKey(req) {
  const auth = req.get("authorization") || "";

  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }

  return (
    req.get("x-api-key") ||
    req.get("x-bridge-api-key") ||
    req.get("apikey") ||
    req.query?.apiKey ||
    req.query?.api_key ||
    ""
  );
}

function requireApiKey(req, res, next) {
  if (!API_KEY) {
    return res.status(500).json({
      ok: false,
      error: "server_missing_api_key",
      message:
        "API key is not configured on Railway. Add API_KEY in Railway Variables."
    });
  }

  const provided = String(getProvidedApiKey(req) || "");

  if (provided !== API_KEY) {
    return res.status(401).json({
      ok: false,
      error: "unauthorized"
    });
  }

  return next();
}

function parseForceReset(req) {
  const value =
    req.body?.forceReset ??
    req.body?.force_reset ??
    req.query?.forceReset ??
    req.query?.force_reset ??
    false;

  return value === true || value === "true" || value === "1" || value === 1;
}

function authDirForSession(sessionId) {
  return path.join(SESSIONS_DIR, sessionId);
}

async function ensureSessionsDir() {
  await fs.mkdir(SESSIONS_DIR, {
    recursive: true
  });
}

async function wipeAuth(sessionId) {
  const safeId = sanitizeSessionId(sessionId);
  const dir = authDirForSession(safeId);

  const existing = sessions.get(safeId);

  if (existing?.sock) {
    try {
      existing.sock.ev.removeAllListeners("creds.update");
      existing.sock.ev.removeAllListeners("connection.update");
    } catch (_e) {
      // ignore listener cleanup errors
    }

    try {
      existing.sock.end?.();
    } catch (_e) {
      // ignore socket close errors
    }
  }

  sessions.delete(safeId);

  await fs.rm(dir, {
    recursive: true,
    force: true
  });

  log.info({ sessionId: safeId }, "auth folder wiped");
}

async function createOrGetSession(sessionId) {
  const safeId = sanitizeSessionId(sessionId);
  const existing = sessions.get(safeId);

  if (existing?.sock && existing?.state) {
    return existing;
  }

  if (existing?.connectingPromise) {
    return existing.connectingPromise;
  }

  const session = existing || {
    id: safeId,
    sock: null,
    state: null,
    saveCreds: null,
    status: "initializing",
    pairingCode: null,
    pairingCodeAt: 0,
    lastError: null,
    lastDisconnectReason: null,
    connectingPromise: null
  };

  sessions.set(safeId, session);

  session.connectingPromise = (async () => {
    await ensureSessionsDir();

    const authDir = authDirForSession(safeId);

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const childLogger = log.child({
      sessionId: safeId
    });

    const sock = makeWASocket({
      version,
      logger: childLogger,
      printQRInTerminal: false,
      browser: ["Windows", "Chrome", "114.0.5735.198"],
      markOnlineOnConnect: false,
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
      keepAliveIntervalMs: 20_000,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, childLogger)
      }
    });

    session.sock = sock;
    session.state = state;
    session.saveCreds = saveCreds;
    session.status = state.creds?.registered ? "registered" : "pairing_required";
    session.lastError = null;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        session.status = "qr_received";
      }

      if (connection === "connecting") {
        session.status = "connecting";
      }

      if (connection === "open") {
        session.status = "open";
        session.lastError = null;
        session.lastDisconnectReason = null;

        log.info(
          {
            sessionId: safeId,
            registered: Boolean(session.state?.creds?.registered)
          },
          "whatsapp connection open"
        );
      }

      if (connection === "close") {
        const statusCode =
          lastDisconnect?.error?.output?.statusCode ||
          lastDisconnect?.error?.status ||
          null;

        session.lastDisconnectReason = statusCode;
        session.status =
          statusCode === DisconnectReason.loggedOut
            ? "logged_out"
            : "disconnected";

        session.lastError =
          lastDisconnect?.error?.message ||
          lastDisconnect?.error?.toString?.() ||
          "connection closed";

        log.warn(
          {
            sessionId: safeId,
            statusCode,
            error: session.lastError
          },
          "whatsapp connection closed"
        );

        session.sock = null;

        if (statusCode === DisconnectReason.loggedOut) {
          session.status = "logged_out";
        }
      }
    });

    log.info(
      {
        sessionId: safeId,
        registered: Boolean(state.creds?.registered)
      },
      "session initialized"
    );

    return session;
  })();

  try {
    return await session.connectingPromise;
  } finally {
    session.connectingPromise = null;
  }
}

async function waitForSocketReady(session, timeoutMs = 5000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (!session.sock) {
      return false;
    }

    if (
      session.status === "open" ||
      session.status === "pairing_required" ||
      session.status === "connecting" ||
      session.status === "qr_received"
    ) {
      return true;
    }

    await sleep(150);
  }

  return Boolean(session.sock);
}

function jidFromInput({ jid, phone, number, groupJid }) {
  const direct = jid || groupJid;

  if (direct) {
    return String(direct).trim();
  }

  const digits = normalizePhone(phone || number);

  if (!digits) {
    return "";
  }

  return `${digits}@s.whatsapp.net`;
}

function publicSessionState(session) {
  return {
    id: session.id,
    status: session.status,
    registered: Boolean(session.state?.creds?.registered),
    hasSocket: Boolean(session.sock),
    lastError: session.lastError || null,
    lastDisconnectReason: session.lastDisconnectReason || null
  };
}

app.get("/", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "wa-bridge",
    time: nowIso()
  });
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    status: "healthy",
    service: "wa-bridge",
    uptime: process.uptime(),
    time: nowIso()
  });
});

app.head("/health", (_req, res) => {
  res.sendStatus(200);
});

app.get("/status", requireApiKey, async (req, res) => {
  const sessionId = getRequestedSessionId(req);
  const session = sessions.get(sessionId);

  res.status(200).json({
    ok: true,
    session: session
      ? publicSessionState(session)
      : {
          id: sessionId,
          status: "not_initialized",
          registered: false,
          hasSocket: false,
          lastError: null,
          lastDisconnectReason: null
        }
  });
});

app.all("/pair", requireApiKey, async (req, res) => {
  try {
    const phone =
      req.body?.phone ||
      req.body?.number ||
      req.query?.phone ||
      req.query?.number ||
      "";

    const normalizedPhone = normalizePhone(phone);

    if (!normalizedPhone) {
      return res.status(400).json({
        ok: false,
        error: "missing_phone",
        message: "Pass phone/number with country code, for example 9725..."
      });
    }

    const sessionId = getRequestedSessionId(req);
    const forceReset = parseForceReset(req);

    if (forceReset) {
      await wipeAuth(sessionId);
    }

    const session = await createOrGetSession(sessionId);
    await waitForSocketReady(session, 7000);

    const registered = Boolean(session.state?.creds?.registered);

    if (registered) {
      return res.status(200).json({
        ok: true,
        registered: true,
        session: publicSessionState(session),
        message: "WhatsApp session is already registered. Pairing code not requested."
      });
    }

    if (!session.sock) {
      return res.status(503).json({
        ok: false,
        error: "socket_not_ready",
        session: publicSessionState(session)
      });
    }

    const cachedCodeAgeMs = Date.now() - Number(session.pairingCodeAt || 0);

    if (session.pairingCode && cachedCodeAgeMs < 90_000) {
      return res.status(200).json({
        ok: true,
        registered: false,
        pairingCode: session.pairingCode,
        code: session.pairingCode,
        cached: true,
        session: publicSessionState(session)
      });
    }

    const code = await session.sock.requestPairingCode(normalizedPhone);

    session.pairingCode = code;
    session.pairingCodeAt = Date.now();
    session.status = "pairing_code_created";

    return res.status(200).json({
      ok: true,
      registered: false,
      pairingCode: code,
      code,
      cached: false,
      session: publicSessionState(session)
    });
  } catch (e) {
    log.error(
      {
        err: e?.stack || e?.message || String(e)
      },
      "pair failed"
    );

    return res.status(502).json({
      ok: false,
      error: "pair_failed",
      message: e?.message || String(e),
      step: "requestPairingCode"
    });
  }
});

app.post("/send", requireApiKey, async (req, res) => {
  try {
    const sessionId = getRequestedSessionId(req);

    const text = String(req.body?.text || req.body?.message || "").trim();

    if (!text) {
      return res.status(400).json({
        ok: false,
        error: "missing_text"
      });
    }

    const jid = jidFromInput({
      jid: req.body?.jid,
      groupJid: req.body?.groupJid || req.body?.group_jid,
      phone: req.body?.phone,
      number: req.body?.number
    });

    if (!jid) {
      return res.status(400).json({
        ok: false,
        error: "missing_recipient",
        message: "Pass jid/groupJid or phone/number."
      });
    }

    const session = await createOrGetSession(sessionId);

    if (!session.state?.creds?.registered) {
      return res.status(409).json({
        ok: false,
        error: "not_registered",
        message: "WhatsApp session is not paired yet.",
        session: publicSessionState(session)
      });
    }

    if (!session.sock) {
      return res.status(503).json({
        ok: false,
        error: "socket_not_ready",
        session: publicSessionState(session)
      });
    }

    const result = await session.sock.sendMessage(jid, {
      text
    });

    return res.status(200).json({
      ok: true,
      jid,
      result
    });
  } catch (e) {
    log.error(
      {
        err: e?.stack || e?.message || String(e)
      },
      "send failed"
    );

    return res.status(502).json({
      ok: false,
      error: "send_failed",
      message: e?.message || String(e)
    });
  }
});

app.get("/groups", requireApiKey, async (req, res) => {
  try {
    const sessionId = getRequestedSessionId(req);
    const session = await createOrGetSession(sessionId);

    if (!session.state?.creds?.registered) {
      return res.status(409).json({
        ok: false,
        error: "not_registered",
        message: "WhatsApp session is not paired yet.",
        session: publicSessionState(session)
      });
    }

    if (!session.sock) {
      return res.status(503).json({
        ok: false,
        error: "socket_not_ready",
        session: publicSessionState(session)
      });
    }

    const map = await session.sock.groupFetchAllParticipating();

    const groups = Object.values(map || {}).map((group) => ({
      jid: group.id,
      name: group.subject,
      subject: group.subject,
      participantsCount: Array.isArray(group.participants)
        ? group.participants.length
        : undefined
    }));

    return res.status(200).json({
      ok: true,
      groups
    });
  } catch (e) {
    log.error(
      {
        err: e?.stack || e?.message || String(e)
      },
      "groups failed"
    );

    return res.status(502).json({
      ok: false,
      error: "groups_failed",
      message: e?.message || String(e)
    });
  }
});

app.all("/logout", requireApiKey, async (req, res) => {
  try {
    const sessionId = getRequestedSessionId(req);
    const safeId = sanitizeSessionId(sessionId);
    const session = sessions.get(safeId);

    if (session?.sock) {
      try {
        await session.sock.logout();
      } catch (_e) {
        // Continue and wipe local auth even if WhatsApp logout fails
      }
    }

    await wipeAuth(safeId);

    return res.status(200).json({
      ok: true,
      sessionId: safeId,
      message: "Logged out and auth folder deleted."
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "logout_failed",
      message: e?.message || String(e)
    });
  }
});

app.all("/reset", requireApiKey, async (req, res) => {
  try {
    const sessionId = getRequestedSessionId(req);
    const safeId = sanitizeSessionId(sessionId);

    await wipeAuth(safeId);

    return res.status(200).json({
      ok: true,
      sessionId: safeId,
      message: "Auth folder deleted."
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "reset_failed",
      message: e?.message || String(e)
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "not_found",
    path: req.path
  });
});

app.use((err, _req, res, _next) => {
  log.error(
    {
      err: err?.stack || err?.message || String(err)
    },
    "unhandled express error"
  );

  res.status(500).json({
    ok: false,
    error: "internal_error",
    message: err?.message || String(err)
  });
});

process.on("unhandledRejection", (reason) => {
  log.error(
    {
      err: reason?.stack || reason?.message || String(reason)
    },
    "unhandled rejection"
  );
});

process.on("uncaughtException", (err) => {
  log.fatal(
    {
      err: err?.stack || err?.message || String(err)
    },
    "uncaught exception"
  );

  process.exit(1);
});

app.listen(PORT, "0.0.0.0", () => {
  log.info(
    {
      port: PORT,
      sessionsDir: SESSIONS_DIR,
      hasApiKey: Boolean(API_KEY)
    },
    "bridge up"
  );
});

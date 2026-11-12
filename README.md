# Tutti WhatsApp Bridge — Railway Edition

Connects the Tutti app (Lovable Cloud) to a real WhatsApp account via Baileys,
hosted on [Railway](https://railway.app/).

See `Railway-Setup-Guide-Hebrew.md` for the full step-by-step setup guide.

## Endpoints
| Method | Path       | Auth      | Purpose                               |
|--------|------------|-----------|---------------------------------------|
| GET    | /status    | public    | Health + connection state             |
| GET    | /qr        | public    | Browser page that shows the QR        |
| GET    | /qr.png    | public    | Raw QR image                          |
| GET    | /groups    | X-Api-Key | List of WhatsApp groups               |
| POST   | /send      | X-Api-Key | Send a text message to a JID/group    |

## Required env vars
- `API_KEY` — long random string (used by the Lovable backend)
- `AUTH_DIR` — defaults to `/app/auth` (must be a Railway Volume mount path)
- `PORT` — set automatically by Railway

## Group retries (2026-11-12)
Baileys 7.0.0-rc13 answers a member's "send again" of a group post by forgetting
who holds the group's key (the next post re-keys every device, ~2 s of the
number's one thread) and, for a phone, by sending the post again to the whole
group. `baileysPatch.js` patches the installed Baileys at boot (exact-match,
all or nothing, only for that version; `/diag` → `baileys_retry_patch`), and
`retryMode.js` holds its switches:

| switch | default | what it does |
|--------|---------|--------------|
| `keep` | on  | only the member who asked is forgotten; a resend to all keeps the device cache |
| `reference` | off | a resend to one device goes out as one `<enc count>` (no `<participants>`) |
| `phones` | off | a phone's retry of a group post is answered to that phone alone |

Switch while running (no deploy, no reconnect): `POST /retry-mode` with
`{ "mode": "keep,reference" }` (exactly these on; `stock` = all off) or
`{ "reference": true }`. The mode is kept in `$AUTH_DIR/retry-mode.json`;
`BRIDGE_RETRY_MODE` sets it when there is no file. Read the effect in the log
line `retry_stats` (resends and WhatsApp's 479 rejections by who asked — a
phone or a linked device) and in `/diag` → `sessions[].retry`.

Also there: a LID question WhatsApp did not answer is not asked again per
message; long runs of encryption and big key writes step aside for incoming
messages; a number is "stuck" only when it also hears nothing; a number is
"silent" by its own pace; a group post waits up to `SEND_READY_WAIT_MS` (8 s)
for a reconnecting number instead of being refused.

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

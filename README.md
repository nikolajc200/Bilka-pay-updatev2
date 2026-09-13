# Bilka Pay web app

A pay-period planner for shifts, earnings, bills, savings, ferie and fritvalg.

## Live app

- Official address: https://pay.skovlunden-23.uk
- Render backup address: https://bilka-pay.onrender.com

## Run locally

```powershell
npm install
npm start
```

Open `http://127.0.0.1:4173`.

Without `DATABASE_URL`, the app uses the existing `data` folder as a local
fallback. Browser data is also kept in `localStorage`, so temporary server
problems do not erase the current device's plan.

## Start with PostgreSQL

Copy `.env.example` to `.env`, choose a strong database password, then run:

```powershell
docker compose up -d --build
```

The app is available at `http://127.0.0.1:4173`. PostgreSQL data is kept in the
named `bilka-pay-postgres` volume and survives app/container updates.

The `plans` table is created automatically from `schema.sql` at startup. It
stores:

- A SHA-256 hash of the private sync code
- The complete plan as JSONB
- Client, creation and server update timestamps

The original sync code is never stored in the database.

## Self-hosting behind a proxy

`GET /healthz` returns `{"ok":true,"storage":"postgres"}` when the app can reach
its database, and `503` when it cannot. Use it for container health checks and
uptime monitoring instead of `/`, which only proves the web server answered.

Set `TRUST_PROXY=true` when the app runs behind a proxy you control (Cloudflare
Tunnel, nginx, Caddy). Rate limiting then keys on `CF-Connecting-IP` or the
first `X-Forwarded-For` entry rather than the proxy's own address, which would
otherwise put every visitor in one shared bucket. Leave it `false` when the app
is reachable directly — the headers are client-supplied and trivially spoofed.

To publish through a Cloudflare Tunnel, put `CLOUDFLARE_TUNNEL_TOKEN` in `.env`
and start the optional profile:

```bash
docker compose --profile tunnel up -d
```

## Existing PostgreSQL service

Set these environment variables before starting the app:

```text
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE
DATABASE_SSL=true
```

Use `DATABASE_SSL=false` for a trusted local Docker network. Most hosted
PostgreSQL providers require SSL.

## Move old file plans into PostgreSQL

When `data` contains plans from the earlier file-based version:

```powershell
$env:DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DATABASE"
$env:DATABASE_SSL="false"
npm run migrate:files
```

The migration uses the already-hashed JSON filenames, so the original codes are
not needed or exposed.

## Accounts

Everything except the login page requires a session. On first start with an
empty database the server creates a `root` administrator, prints its password
once to the log, and requires it to be changed at first login:

```bash
docker compose logs app | grep -A3 "administrator account"
```

Your plan belongs to your account — to use another device, log in there. There
is no sync code to copy; the account is the identity.

Administrators get `/admin`, where they can create accounts (the generated
password is shown once), reset passwords, promote or demote, disable, delete,
and sign a user out of every device. The last active administrator cannot be
deleted, demoted or disabled, so an instance can never lock itself out.

Security notes:

- Passwords are stored as salted scrypt hashes; sessions are random 32-byte
  tokens stored only as SHA-256 hashes, so a database leak grants no logins.
- The session cookie is `HttpOnly` + `SameSite=Lax`, and `Secure` whenever
  `TRUST_PROXY=true` (override with `COOKIE_SECURE`).
- Write endpoints require `Content-Type: application/json`, which a cross-site
  form cannot send — that plus `SameSite=Lax` is the CSRF defence.
- Login attempts are rate-limited per IP *and* per username.
- Changing a password, or an admin resetting one, invalidates every other
  session for that account.

The API rejects malformed payloads, limits request size, rate-limits repeated
plan requests and keeps the newest `updatedAt` version when devices conflict.

## Backups and tests

The app's export/import buttons create portable JSON backups.

```powershell
npm test
```

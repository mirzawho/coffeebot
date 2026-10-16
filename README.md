# coffeebot

A single-process Telegram cafe ordering system built with **Bun**, **TypeScript**, **SQLite**, **grammY**, and **Ollama Cloud**.

One process runs:

- a **Telegram bot** (long polling) for customers: browse menu, cart, natural-language ordering, checkout, payment receipt upload
- an **HTTP server** (`Bun.serve`) for health checks, admin API, and the **admin Mini App** (vanilla HTML/CSS/JS, Persian RTL)
- a **scheduler** for daily order reports with a persistent, idempotent notification queue

No frontend framework, no ORM, no Redis, no microservices.

## Features

- Menu management (categories, products, variants, prices, images, active flags) via the admin Mini App
- Cart with quantity edit, remove, clear — server-side pricing only
- Natural-language ordering via Ollama (`gemma4:cloud` by default) — the model is an untrusted intent parser; every action is validated against the real menu in application code
- Checkout: order summary → payment instructions (card number/name from settings) → receipt photo/document → optional delivery notes → explicit confirmation
- Target business date computed from configurable weekly hours (open inclusive, close exclusive, overnight rejected); Jalali date display
- Orders stored with item snapshots (`receipt_received_unverified` status — payments are never auto-verified)
- Scheduled daily reports (time + recipients configurable in the Mini App) with missed-run recovery, retries with exponential backoff, and immediate notifications for orders placed after the report
- Telegram Mini App auth via official `initData` HMAC validation + `ADMIN_IDS` allowlist; rate-limited admin API
- Docker image + GitHub Actions → GHCR publishing

## Requirements

- [Bun](https://bun.sh) ≥ 1.4 (local dev)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- An [Ollama Cloud](https://ollama.com) API key (optional — without it, button-based ordering still works)
- Docker (for production deployment)

## Configuration

Copy `.env.example` to `.env` and fill in values:

| Variable | Required | Description |
|---|---|---|
| `BOT_TOKEN` | yes | Telegram bot token from @BotFather |
| `ADMIN_IDS` | yes | Comma-separated numeric Telegram user IDs allowed to open the admin Mini App |
| `OLLAMA_API_KEY` | no* | Ollama Cloud API key; natural-language ordering disabled if empty |
| `OLLAMA_BASE_URL` | no | Default `https://ollama.com/v1` |
| `OLLAMA_MODEL` | no | Default `gemma4:cloud`; must be a model your endpoint accepts (no silent fallback) |
| `APP_BASE_URL` | no | Public HTTPS origin of this app (for the Mini App menu button) |
| `DATABASE_PATH` | no | Default `data/cafe.sqlite`; use `/data/cafe.sqlite` in Docker |
| `TIMEZONE` | no | Default `Asia/Tehran` (IANA name) |
| `LOG_LEVEL` | no | `debug` \| `info` \| `warn` \| `error` (default `info`) |
| `HTTP_PORT` | no | Default `3000` |

Never commit `.env`, database files, or receipts to Git.

## Local development

```bash
bun install
cp .env.example .env   # fill in BOT_TOKEN and ADMIN_IDS
bun run dev            # watch mode
bun run start          # plain run
bun test               # test suite
bun run typecheck      # tsc --noEmit
```

The HTTP server listens on `HTTP_PORT` (default `3000`). Health check: `GET /health`.

## Production (Docker)

Build:

```bash
docker build -t coffeebot .
```

Run with a persistent volume for SQLite + uploads:

```bash
docker run -d \
  --name coffeebot \
  -p 3000:3000 \
  -v cafe-data:/data \
  --env-file .env \
  --restart unless-stopped \
  coffeebot
```

Or with a published GHCR image (see below):

```bash
docker run -d \
  --name coffeebot \
  -p 3000:3000 \
  -v cafe-data:/data \
  --env-file .env \
  --restart unless-stopped \
  ghcr.io/<owner>/<repo>:latest
```

Or with Docker Compose (uses `docker-compose.yaml`; same volume/env semantics):

```bash
cp .env.example .env   # fill in values
docker compose up -d   # build + run; logs: docker compose logs -f
docker compose down    # stop (data kept in the cafe-data volume)
```

The image runs as a non-root user, stores all state under `/data`, exposes port `3000`, and has a `/health`-based Docker healthcheck. SIGTERM/SIGINT trigger a graceful shutdown.

Put a TLS-terminating reverse proxy (Caddy, nginx, Traefik) in front of it and set `APP_BASE_URL` to the public HTTPS origin.

### Telegram Mini App setup

1. Talk to @BotFather → `/newbot` → copy the token into `BOT_TOKEN`.
2. `/newapp` (or edit your bot) → set the Web App URL to `https://your-domain/` (the admin UI is served at `/`).
3. Optionally add a `menu_button` so the Mini App opens from the chat menu.
4. Only Telegram users whose numeric IDs are listed in `ADMIN_IDS` can use the Mini App; every request re-validates the signed `initData` server-side.

## CI/CD — GHCR image publishing

`.github/workflows/docker.yml` runs on pushes to `main`/`master`, on `v*` tags, and on manual dispatch:

1. Installs Bun, runs typecheck + tests (publish is blocked on failure).
2. Builds the image with Buildx (GHA cache).
3. Pushes to `ghcr.io/<owner>/<repo>` using the built-in `GITHUB_TOKEN` (no personal access token needed).
4. Tags: `latest` (default branch), branch name, `sha-<commit>`, and semver (`1.2.3`, `1.2`) for `v*` tags.

To enable: repository **Settings → Actions → General → Workflow permissions** → "Read and write permissions" (or rely on the workflow's explicit `packages: write`). Package visibility can be changed under **GitHub Packages → your image → Package settings**.

## Architecture notes

- **SQLite** (WAL, foreign keys, busy timeout) is the only datastore. This is intended for a **single host with a persistent volume** — not for multiple concurrent instances, though atomic claim transitions in the DB limit duplicate report/notification sends if a second instance is started accidentally.
- **Money** is stored as integer amounts; all totals are computed server-side.
- **Business dates**: orders submitted before opening on an active day belong to that day; at/after closing or on closed days they roll to the next active business date. Overnight hours are rejected.
- **AI safety**: the Ollama model can only propose validated `add`/`remove`/`clear` cart actions against real product/variant IDs; quantities are clamped; prices, settings, payment status, and business rules are never model-controlled. Prompt-injection attempts fall back to the button UI.
- **Reports**: one row per business date; deliveries go through a persistent queue with idempotency keys and bounded exponential backoff. Orders created after the report was generated trigger immediate per-order notifications with the receipt.

## Known limitations

- Payments are **not verified** — orders are `receipt_received_unverified`; admins check receipts manually.
- The bot uses long polling (single instance); use a webhook only if you adapt `src/bot/index.ts`.
- Product images are stored on disk under `DATABASE_PATH`'s directory (`/data/uploads` in Docker) and re-uploaded to Telegram from there — keep the volume.
- Admin Mini App recipient IDs must be members of `ADMIN_IDS`; the backend rejects anything else.
- Developed and tested against Bun 1.4.x; no lockfile is committed yet (Docker/CI fall back to resolving from `package.json` — commit a `bun.lock` for fully reproducible builds).

## Project layout

```
src/
  index.ts            # entry point: wires config → db → services → bot → server → scheduler
  config.ts           # env parsing + validation
  db/                 # bun:sqlite, migrations runner, SQL migrations
  services/           # menu, cart, orders, business-hours, settings, reports, notifications, ollama
  bot/                # grammY bot: keyboards, handlers, one-shot action tokens
  api/                # Bun.serve: initData auth, rate limit, admin CRUD routes
  admin/              # Mini App frontend (vanilla HTML/CSS/JS, Persian RTL)
  scheduler/          # report + notification delivery loop
  utils/              # dates (Jalali + timezone), money, ids, logger
tests/                # bun test suite
Dockerfile
.github/workflows/docker.yml
```

## License

Private / unlicensed unless otherwise stated by the repository owner.

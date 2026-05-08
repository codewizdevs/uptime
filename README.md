# Uptime

A self-hosted, open-source uptime monitor written in Node.js. Active HTTP/HTTPS checks, passive heartbeat URLs (Healthchecks.io style), incident tracking, response-time graphs, multi-channel alerts (Discord, email, generic webhook), and **one-click JSON import / export** for portable monitor + channel backups — in a single Express + EJS app with a SQLite or MySQL backend.

If you want a simple, fast, self-hostable alternative to Uptime Kuma, Healthchecks.io, Statping, or Gatus — without Docker required, without a heavy stack — this is for you.

---

## Screenshots

**Dashboard** — compact monitor cards, live polling, dark mode, filters by state / type / Cloudflare mode, and full-text search.

![Dashboard](docs/screenshots/dashboard.png)

**Monitor detail** — 24h / 7d / 30d uptime, downtime, P95 / min / max / avg response times, response-time chart (24h / 7d / 30d ranges), recent checks log, and full incident history.

![Monitor detail with response-time chart and incidents](docs/screenshots/monitor-detail.png)

**New monitor** — HTTP probe with status / body-string / JSON-path assertions, custom headers, failure threshold, and Cloudflare-aware mode.

![New monitor](docs/screenshots/monitor-form.png)

**Notification channels** — attach any combination of Discord, generic webhook, and email channels per monitor.

![Notification channels](docs/screenshots/channels.png)

**Customizable templates** — per-event (DOWN / RECOVERED / CHALLENGED / TEST) titles & bodies with `{{placeholders}}`, one click to insert at cursor, one click to reset to default.

![Channel templates with placeholders](docs/screenshots/channel-templates.png)

**Backup & restore (import / export)** — back up all (or a selected subset of) monitors, channels, and SMTP settings to a portable JSON file, and restore it on another instance with a configurable conflict strategy (skip / replace / rename).

![Backup and restore - JSON import / export](docs/screenshots/backup-restore.png)

---

## Features

### Monitors
- **Active HTTP / HTTPS checks** with configurable interval, timeout, method, and per-monitor request headers.
- **Three assertion types** per monitor:
  - **Status code** — single (`200`) or comma list (`200,204,301`).
  - **Body contains string** — case-sensitive substring match against the (auto-decompressed) response body.
  - **JSON path equals value** — dot-path lookup like `data.status` or `items[0].ok` on the parsed JSON body.
- **Passive heartbeat monitors** — the service pings a unique `GET /ping/<token>` URL on a schedule; if it goes silent past the grace period, the monitor flips DOWN. Same model as Healthchecks.io / dead-man's switch / cron monitoring.
- **Failure threshold (anti-flap)** — only fire DOWN after N consecutive failed checks. Default `1`, raise it to `2` or `3` to suppress one-off network blips.
- **Pause / resume** any monitor without losing history.
- **"Check now"** button for instant manual probes.

### Cloudflare-aware probing
- Rotated realistic browser User-Agents and headers (so probes don't look like a bot).
- Automatic Brotli / gzip / deflate response decompression — assertions actually see the decoded body.
- Cloudflare challenge detection (status, `cf-mitigated` header, body markers) → recorded as **inconclusive** (not counted against uptime, no false-positive alerts).
- Optional per-monitor "Cloudflare mode": HEAD-first probe (status checks only), 60s minimum interval, adaptive exponential backoff on consecutive challenges (cap 30 min), one-shot "being challenged" notice after 5 in a row.
- ±5% interval jitter on every monitor so checks don't pile up on the wall clock.

### Notifications
- **Multi-channel fan-out** — attach any number of channels per monitor. Each channel is independently configured.
- **Channel types**:
  - **Discord** webhook (rich embeds with state colors)
  - **Email** via SMTP (configured in-app; HTML + plain text)
  - **Generic webhook** with custom URL, method (POST/PUT/PATCH), headers JSON, and content-type
- **Custom message templates** per event (DOWN / RECOVERED / CHALLENGED / TEST) with `{{placeholders}}` like `{{site_name}}`, `{{site_url}}`, `{{error}}`, `{{status_code}}`, `{{duration_human}}`, `{{timestamp}}`. One-click "reset to default" per template.
- **Test send** button on every channel for instant verification.
- `APP_DEBUG=true` switches every channel into dry-run mode — the would-be payload is logged instead of sent. Useful when you're iterating on templates.

### Dashboard & UI
- Tabler-themed admin dashboard, dark mode by default with one-click light/dark toggle.
- Compact monitor cards with status stripe, animated dot, 24h uptime %, last response time, and last-checked relative time. **52 per page** with server-side pagination.
- **Filter & search bar**: by name/URL, by state (up/down/unknown/paused), by monitor type (active/heartbeat), by Cloudflare mode.
- **Live updating** — the dashboard polls only the visible monitors every 5s and updates state, response time, and last-checked in place.
- **Per-monitor detail page** with 24h / 7d / 30d uptime %, P95 / min / max response times, response-time chart (Chart.js, 24h / 7d / 30d ranges), recent checks log, and incident timeline.
- **Delete from listing** — hover any card to reveal an inline trash button with a confirm modal.
- Mobile-responsive — tested on small screens, action buttons stack, badges wrap.

### Incident tracking
- Each DOWN → UP transition records an incident with start/end timestamp, duration, and last error message.
- Per-monitor incident table on the detail page (last 25, "ongoing" badge for active incidents).

### Settings
- **SMTP settings panel** for email notifications, with built-in "Send test email" and "Verify connection" buttons. Password is never re-displayed; leave blank to keep the existing one.
- **Backup & restore (JSON import / export)** — export all or selected monitors, channels, and SMTP settings to a portable JSON file. Restore with conflict strategy (skip / replace / rename) and selective per-section import. Live preview shows what's in the file before you commit. Great for migrating between instances, version-controlling your monitor config, or seeding a fresh install.
- **Whitelabeling** via env vars: custom app name, tagline, logo, favicon, footer text/link, or hide the credit line entirely.

### Security
- Session-based admin login; failed-login + login-success entries in the structured log.
- `</script>`-safe JSON serialization for inline `<script>` flash payloads.
- All `:id` route params validated up front (non-numeric IDs return a clean 404 instead of a stack trace).
- Open-redirect-safe `returnTo` after login (only same-origin paths accepted).
- Reverse-proxy aware (`trust proxy`, real client IP from `CF-Connecting-IP` when used).

### Operations
- **SQLite by default** (zero setup, ships idempotent schema) — or **MySQL** by setting `DB_DRIVER=mysql`.
- Schema is applied on boot (`CREATE TABLE IF NOT EXISTS …`), no manual migration step.
- Structured logs via `pino`, console + daily-rolling file (`logs/app.log`, 14-day retention, configurable via `APP_DEBUG`).
- Built-in PM2 ecosystem file. Boots cleanly behind nginx / Caddy / Cloudflare.

---

## Quick start

```bash
git clone https://github.com/codewizdevs/uptime.git
cd uptime
npm install
cp .env.example .env
# edit .env (at minimum: SESSION_SECRET, ADMIN_USER, ADMIN_PASS)
npm start
```

Open http://localhost:3000 and sign in with the admin credentials you set in `.env`.

That's it — SQLite is the default, no database server required. The schema auto-applies on first boot.

---

## Configuration

All configuration lives in `.env`. The most important keys:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port the app listens on |
| `SESSION_SECRET` | _(unset)_ | **Required.** 32+ random characters used to sign session cookies. Generate with `openssl rand -hex 48`. |
| `ADMIN_USER` / `ADMIN_PASS` | `admin` / `admin` | Admin login. Change before exposing publicly. |
| `APP_DEBUG` | `false` | `true` enables trace logging **and** dry-runs all notification channels (payloads logged instead of sent). |
| `PUBLIC_BASE_URL` | `http://localhost:$PORT` | Public URL used to render heartbeat ping URLs in the UI. |
| `DB_DRIVER` | `sqlite` | `sqlite` or `mysql`. |
| `SQLITE_PATH` | `data/uptime.sqlite` | SQLite file path (relative to project root or absolute). |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | — | MySQL connection (only when `DB_DRIVER=mysql`). |

### Whitelabeling (optional)

| Variable | Effect |
|---|---|
| `APP_NAME` | App name in the navbar, page titles, login screen. |
| `APP_TAGLINE` | Small text under the app name in the footer. |
| `APP_LOGO_PATH` | Path to a PNG/SVG/WebP/JPG/GIF/ICO logo (relative or absolute). |
| `APP_FAVICON_PATH` | Path to a favicon. |
| `FOOTER_CREDITS_HIDE` | `true` hides the footer credits entirely. |
| `FOOTER_CREDITS_LEAD` / `FOOTER_CREDITS_TEXT` / `FOOTER_CREDITS_URL` | Override the credit line. |

A complete list with comments is in [`.env.example`](./.env.example).

---

## Heartbeat monitors (passive / cron monitoring)

Heartbeat monitors are useful for cron jobs, background workers, and internal services that aren't reachable from the outside. Create one in the dashboard, copy the unique ping URL, and have the service hit it on a schedule:

```bash
* * * * * curl -fsS https://your-monitor.example.com/ping/<token> > /dev/null
```

If we go more than `interval_seconds + heartbeat_grace_seconds` without a ping, the monitor flips DOWN and your channels fire.

---

## Production deployment (PM2 + nginx)

The app ships with a PM2 ecosystem file and was designed to run behind nginx (or any reverse proxy).

```bash
# 1. Install
git clone https://github.com/codewizdevs/uptime.git /opt/uptime
cd /opt/uptime
npm install --omit=dev
cp .env.example .env  # edit it

# 2. Run under PM2
npm install -g pm2
pm2 start src/server.js --name uptime
pm2 save
pm2 startup            # run the printed command to enable boot persistence

# 3. nginx vhost (proxy 443 → 127.0.0.1:3000) — example in docs/nginx.conf
```

A minimal nginx vhost looks like this:

```nginx
server {
    listen 443 ssl http2;
    server_name uptime.example.com;
    ssl_certificate     /etc/ssl/uptime/origin.crt;
    ssl_certificate_key /etc/ssl/uptime/origin.key;

    set_real_ip_from 0.0.0.0/0;
    real_ip_header CF-Connecting-IP;
    real_ip_recursive on;

    client_max_body_size 16m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

If your edge is Cloudflare, set SSL/TLS mode to **Full** (a self-signed origin cert is fine) — origin terminates TLS, Cloudflare handles the public certificate.

---

## Stack

- **Runtime**: Node.js 20+ (uses native `fetch`-grade libs, brotli/gzip support out of the box)
- **HTTP server**: Express 4 + `express-ejs-layouts`
- **HTTP client (probes)**: `undici` with a shared keep-alive agent
- **DB**: SQLite (`better-sqlite3`) or MySQL (`mysql2/promise`) via a thin abstraction
- **Sessions**: `express-session` (memory store; swap to a persistent store if you cluster)
- **Mail**: `nodemailer`
- **Templating**: EJS
- **Frontend**: Tabler CSS (CDN) + vanilla JS (no Bootstrap JS bundle), Chart.js (CDN), Notyf for toasts
- **Logs**: `pino` + `pino-pretty` + `pino-roll` (daily rotation, 14-day retention)
- **No Docker required** — `node`, `npm`, optional `pm2` is all you need.

---

## Project layout

```
src/
  server.js              entry point, middleware order, boot sequence
  config.js              env parsing + branding config
  db.js                  driver loader (sqlite | mysql)
  drivers/sqlite.js      better-sqlite3 + dialect helpers
  drivers/mysql.js       mysql2 pool + dialect helpers
  logger.js              pino + console + rolling file
  monitor.js             scheduler: per-site loops, heartbeat watchdog
  notifier.js            shim into channels lib
  auth.js                session middleware + login helpers
  routes/
    auth.js              /login, /logout
    sites.js             dashboard, CRUD, /api/sites, /theme
    channels.js          notification channel CRUD + test send
    settings.js          SMTP settings + test email
    backup.js            export / import JSON
    branding.js          /branding/logo, /branding/favicon
    ping.js              public GET / HEAD /ping/:token
  lib/
    checker.js           HTTP probe + brotli/gzip decode + assertions
    cloudflare.js        challenge detection, UA pool, jitter
    channels.js          channel data model, dispatch, templates
    templates.js         {{placeholder}} renderer
    email.js             SMTP wrapper, dry-run aware
    backup.js            export/import logic with conflict strategies
    stats.js             uptime % + response-time aggregates + timeseries
    ids.js               :id param validator (clean 404 instead of 500)
    format.js            humanize seconds → "1h 23m 4s"
views/                   EJS templates
public/                  static assets (CSS, JS, images)
sql/
  schema.sqlite.sql      idempotent CREATE TABLEs (auto-applied on boot)
  schema.mysql.sql       same, MySQL syntax
```

---

## Roadmap (welcoming PRs)

- [ ] Public status page (read-only, embeddable)
- [ ] Slack / Telegram / Pushover channels
- [ ] SSL certificate expiry checks
- [ ] Maintenance windows (silence alerts on a schedule)
- [ ] CSV export of incidents
- [ ] Multi-user support with roles

---

## License

[MIT](./LICENSE) — do whatever you want with this. Modify, redistribute, sell, fold into a closed-source product, embed it in a SaaS — no restrictions beyond keeping the copyright notice.

---

## Credits

Built by [codewizdevs](https://github.com/codewizdevs). Issues and pull requests welcome.

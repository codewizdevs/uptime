# PLAN — feature parity & expansion roadmap

Derived from a competitor sweep of **Uptime Kuma**, **Gatus**, **Healthchecks.io**, **OneUptime**, **Statping-ng**, and **Better Stack**. Every phase below is a self-contained slice that can be merged independently.

Ordering is by **(impact × audience expectation) ÷ implementation effort**, not personal preference. Phase 1 is the single most-requested feature across all competitors; phases 1-4 together close ~80% of the perception gap with Uptime Kuma.

---

## How this plan is executed

- Work proceeds **phase by phase**, top to bottom.
- After **every phase** the app is restarted on **port 3001** and smoke-tested with `curl` before moving on.
- Every phase adds/modifies the DB schema in a backward-compatible way (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN` guarded by a column-exists check). No destructive migrations.
- Every phase keeps the project's core promise: **simple, no Docker required, one process, MIT**. Features that violate that promise are explicitly out of scope (last section).

---

## Phase 1 — Public status page

**Why first**: every competitor ships it; users assume it exists.

- New `/status` route (no auth) and `/status.rss` Atom feed.
- New `status_page_groups` and `status_page_settings` tables (groups = ordered named buckets of monitors).
- Per-group / per-monitor display name override (`display_name` on `sites`).
- 90-day daily bar (`uptime%` per day) + current state + last 24h MTTR.
- Optional `STATUS_PAGE_PUBLIC=true` env; if false, page requires a `?token=` query param matched against `STATUS_PAGE_TOKEN`.
- Branded with existing whitelabel vars; clean / fast / SSR (no SPA).
- Per-monitor "exclude from status page" flag for internal-only monitors.

---

## Phase 2 — Notification channel expansion

**Why high**: doubles your channel count with mostly thin adapters.

Each new channel is a new `type` in `CHANNEL_TYPES` with its own `sanitizeConfig` and `dispatchToChannel` branch:

- **Slack** (incoming webhook URL; reuses Discord embed-ish structure)
- **Telegram** (bot token + chat ID)
- **Ntfy.sh** (topic URL, optional auth header, priority + tags)
- **Gotify** (server URL + app token + priority)
- **Pushover** (user key + app token + priority)
- **Mattermost** (incoming webhook; Slack-compatible body)
- **Microsoft Teams** (incoming webhook; adaptive-card JSON)

All seven use the existing per-event `{{placeholder}}` template engine.

---

## Phase 3 — SSL / TLS visibility + cert-expiry alerts

**Why high**: every paid competitor surfaces this. Roughly 100 LOC because `undici` exposes the TLS socket.

- On every successful HTTPS probe, capture `cert_issuer`, `cert_subject`, `cert_valid_to`, `cert_days_remaining`, `tls_version` (stored on the latest `checks` row + denormalized to `sites.last_cert_days_remaining`).
- New monitor type **`cert`** that runs only the TLS handshake (no HTTP body), useful for ports other than 443 (SMTPS, IMAPS, custom).
- Two new failure modes: cert expires in **< N days** (default 14) → channels fire a new event `cert_expiring`. Cert already expired → `down`.
- Per-monitor override for the "warn at N days" threshold.
- Display the cert expiry pill on the dashboard card and full info on the detail page.

---

## Phase 4 — New monitor types — SHIPPED

**Why high**: closes the "is this actually a monitor?" sniff test against Uptime Kuma.

- **TCP** — `net.Socket` connect to host:port within timeout. Optional "expected banner contains" substring assertion (saved in `expected_string`). `src/lib/tcp.js`.
- **Ping (ICMP)** — shells out to `/bin/ping -c<n> -W<sec>` (no extra deps, no CAP_NET_RAW). Returns avg RTT as response time; reports partial loss. `src/lib/ping.js`.
- **DNS record** — `dns.promises.Resolver`-based lookup for A / AAAA / CNAME / MX / TXT / NS / SRV / CAA / SOA / PTR. Optional custom resolver host[:port]. `dns_expected` accepts a substring (case-insensitive) **or** `/pattern/flags` regex against the joined RRset. `src/lib/dnscheck.js`.
- **Keyword (regex)** — new `check_type = 'regex'` for active HTTP monitors. Pattern can be bare (defaults to flag `i`) or `/pattern/flags`. Sits alongside `status`, `string`, `json`.

Schema additions on `sites` (all nullable, idempotent migration):
`tcp_host`, `tcp_port`, `ping_host`, `ping_count`, `dns_query`, `dns_record_type`, `dns_resolver`, `dns_expected`.

Dashboard: filter pills for TCP / Ping / DNS, type-aware meta line on every card.

---

## Phase 5 — Maintenance windows — SHIPPED

**Why high**: every operator hits this on day-one of production use.

- New `maintenance_windows` table (`id, name, enabled, scope, scope_value, kind, starts_at, ends_at, cron, duration_minutes, timezone, suppress_notifications, pause_probes`).
- Two scopes: **global** (all monitors) or **monitor** (one specific monitor).
- Two kinds: **one-off** (explicit start/end timestamps) or **recurring** (cron + duration in minutes, evaluated in a timezone via `cron-parser`).
- `src/lib/maintenance.js`: `windowIsActive`, `isActive(siteId)`, `isActiveGlobal()`, `isAlertSuppressed`, `isProbeSuppressed`, `nextOccurrence`, `currentEnd`, `summarize`. 15-second in-memory cache, invalidated on writes.
- `src/notifier.js` wraps every channel dispatch in `isAlertSuppressed` — suppressed events log `notifier.suppressed_by_maintenance` for audit and skip the channel call.
- `src/monitor.js` checks `isProbeSuppressed` before each probe tick. Heartbeats are unaffected.
- New incidents get `during_maintenance=1` if opened inside a window (denormalized column on `incidents`).
- Settings page `/settings/maintenance` (CRUD + toggle + delete) with full timezone picker.
- Dashboard banner whenever any window is currently active.

---

## Phase 6 — Tags, groups, bulk actions — SHIPPED

**Why medium**: lowers the friction of running 50+ monitors.

- `tags` (id, name, color, timestamps) + `site_tags` (site_id, tag_id) join table.
- `src/lib/tags.js`: `listTags`, `createTag`, `updateTag`, `deleteTag` (cascades to site_tags), `setSiteTags`, `listSiteTags`, `tagsForSites` (bulk Map<siteId, tag[]>), `attachToSites`, `detachFromSites`.
- `/settings/tags` admin UI: create with color picker, edit name/color inline (HTML5 `form` attr), delete with confirmation. 12-colour Tabler palette.
- Dashboard: tag chip row under the filter bar (clicking a tag toggles it as the `?tag=` filter), tag chips rendered on each monitor card.
- Monitor form: tag multi-select with the existing tags shown as toggleable badges.
- Bulk actions: per-card checkbox + sticky bottom action bar with **Pause / Resume / Delete / Add tag / Remove tag**. `POST /sites/bulk` with `action`, `site_ids[]`, optional `tag_id`. URL state is preserved across the redirect.

---

## Phase 7 — Improved heartbeat / cron monitoring — SHIPPED

**Why medium**: brings parity with Healthchecks.io, which is the dominant tool in this niche.

- New `sites.heartbeat_schedule_kind` (`interval` | `cron`), `heartbeat_cron`, `heartbeat_timezone`.
- `evaluateHeartbeat` now branches on schedule kind: interval keeps the existing `interval + grace` check; cron uses `cron-parser` to compute the next expected occurrence from the last received ping in the configured timezone and tolerates lateness up to grace.
- New ping endpoints (all unauthenticated, same token):
  - `GET|HEAD|POST|PUT /ping/:token`             — success
  - `GET|HEAD|POST|PUT /ping/:token/start`       — wrap-job start signal (records `last_heartbeat_start_at`, doesn't change state)
  - `GET|HEAD|POST|PUT /ping/:token/<0|success|ok>` — success alias
  - `GET|HEAD|POST|PUT /ping/:token/<rc>`        — non-zero exit code → failure (opens incident)
  - `GET|HEAD|POST|PUT /ping/:token/<fail|failure|down>` — failure alias
- Per-ping body captured (up to 4 KB, transparently truncated). POST/PUT raw bytes preferred; falls back to the parsed urlencoded/json body.
- New `heartbeat_pings` table (kind, exit_code, duration_ms, body, source_ip, user_agent, received_at) capped at 50 rows per site via post-insert prune.
- Site form: heartbeat block grew a "schedule kind" selector with cron + timezone fields. Three ping URLs shown (`success` / `start` / `fail`) plus a wrap-a-job snippet.
- Site detail page shows the last 25 pings with kind badge, exit code, computed duration, body snippet, source IP.

---

## Phase 8 — Public REST API + Prometheus metrics — SHIPPED

**Why medium**: unlocks programmatic access and Grafana integration.

- `api_tokens` table: `id, name, token_hash (sha256), scope ('read'|'write'), last_used_at, created_at`. Plaintext token (`utk_<48-hex>`) shown exactly once at creation.
- `src/lib/apiTokens.js`: create, list, delete, lookup-by-bearer-or-`?token=`, async `last_used_at` touch on use.
- `/settings/api-tokens` admin UI with create / revoke / scope picker and cURL + Prometheus scrape examples.
- REST endpoints in `src/routes/api.js` (mounted **before** session-auth, bypassing cookies):
  - `GET /api/v1/health` (public)
  - `GET /api/v1/sites?state=&monitor_type=&tag=&limit=&offset=` (read)
  - `GET /api/v1/sites/:id` (read; includes uptime stats, tags, recent incidents, channel IDs)
  - `GET /api/v1/sites/:id/checks?limit=` (read)
  - `GET /api/v1/sites/:id/incidents?limit=` (read)
  - `GET /api/v1/incidents?limit=` (read)
  - `GET /api/v1/tags` (read)
  - `GET /api/v1/stats` (read)
  - `POST /api/v1/sites/:id/pause` | `/resume` | `/check-now` (write)
  - `DELETE /api/v1/sites/:id` (write)
- Read tokens are denied on write endpoints with HTTP 403.
- `/metrics` Prometheus exporter, public when no tokens exist, token-gated as soon as the first token is created. Series:
  - `uptime_monitor_up{id,name,monitor_type}` (1 / 0; paused monitors omitted)
  - `uptime_monitor_response_time_ms`
  - `uptime_monitor_last_check_age_seconds`
  - `uptime_monitor_uptime_pct_24h`
  - `uptime_cert_days_remaining`
  - `uptime_monitors_total{state}` (up / down / paused)
  - `uptime_open_incidents`

---

## Phase 9 — Auth hardening — SHIPPED

**Why medium**: security parity for any public-internet deploy.

- **TOTP 2FA** — RFC 6238 implementation in `src/auth.js` (HMAC-SHA1 + custom base32, no external dep). Window=±1 / step=30s / 6 digits. Otplib was dropped because v13 introduced an incompatible API for a feature small enough to inline.
- Two-step login: `POST /login` validates credentials, sets `session.pendingUser`, redirects to `/login/2fa`. `POST /login/2fa` accepts a TOTP token **or** a one-shot recovery code; on success it rotates `session.user` and clears the pending state.
- Enrollment UX at `/settings/2fa`: status badge, QR code (PNG data-url via `qrcode`), pasteable base32 secret, 10 recovery codes shown exactly once at enable / regenerate. Disable requires a current TOTP/recovery confirmation.
- **Rate-limit + lockout** (`src/lib/rateLimit.js`): in-memory dual buckets — 5 failures / 15 min per IP, 10 failures / 30 min per username. A successful login clears both buckets. Lockout messages tell the user how many minutes remain.
- **Audit log** — new `audit_log` table (`id, at, actor, ip, action, target_type, target_id, meta`). `src/lib/audit.js` provides `record()` and `fromReq()`. Hooked into login.success / login.failed / 2fa.enabled / 2fa.disabled / 2fa.recovery_used / 2fa.recovery_regenerated / 2fa.failed / logout / api_token.created / api_token.deleted / site.{created,updated,deleted,bulk_*} / tag.{created,updated,deleted}.
- `/settings/audit` page with action filter dropdown, colour-coded action badges, JSON `meta` shown inline, capped at 200 most-recent.
- Login + 2FA forms hardened against `</script>` injection via the same `\\u003c` JSON escaping used on the dashboard.

---

## Phase 10 — Per-monitor probe options — SHIPPED

**Why medium**: rounds out the assertion surface.

- New columns on `sites`: `request_body`, `request_body_type` (`text` / `json` / `form`), `auth_type` (`none` / `basic` / `bearer`), `auth_username`, `auth_password`, `auth_token`, `follow_redirects`, `skip_tls_verify`, `max_response_time_ms`.
- **Request body** for POST/PUT/PATCH/DELETE with auto Content-Type based on body type (no override needed). Sent up to 64 KB.
- **First-class Basic auth + Bearer token** — populated directly into the `Authorization` header by `buildHeaders`; takes precedence over any header pasted into the custom-headers JSON.
- **Follow redirects** — yes / no (5 hops vs 0). Wired into `undici`'s `maxRedirections`.
- **Skip TLS verify** — when enabled, the monitor uses a separate cached undici Agent with `rejectUnauthorized: false`. Tested against `https://self-signed.badssl.com/` (strict = DOWN, skip = UP).
- **Regex body match** — already shipped in Phase 4.
- **Response-time threshold** — when `max_response_time_ms` is set, a successful response that exceeds it is flipped to DOWN with `response too slow: Xms > Yms`. Applied after the primary assertion so reason text is consistent.
- Site form gained four sub-sections under "active": Request body, Authentication, Network & TLS, plus a vanilla-JS reveal for the basic vs bearer credential inputs.
- **Multiple assertions** — explicitly deferred. Existing single-assertion + response-time threshold covers ~95% of real cases without a UI rebuild. Worth revisiting after user feedback.

---

## Phase 11 — Data hygiene + retention — SHIPPED

**Why medium**: keeps DB size bounded and adds analyst-friendly exports.

- `src/lib/retention.js` — pluggable pruner with one entry per table and a periodic scheduler. Runs on boot + every `RETENTION_RUN_INTERVAL_HOURS` (default 24h).
- Configurable retention via env (all default-on): `CHECKS_RETENTION_DAYS` (90), `INCIDENTS_RETENTION_DAYS` (365), `HEARTBEAT_PINGS_RETENTION_DAYS` (30), `AUDIT_RETENTION_DAYS` (180), `RETENTION_VACUUM` (1 = run SQLite `VACUUM` after prune).
- New columns on `sites`: `notes` (free-text, rendered as pre-wrap on the detail page) and `mute_notifications` (probes still tick, alerts are dropped). `incidents.failure_snapshot` (JSON) reserved for future header/body capture.
- `src/notifier.js`: extra short-circuit on `site.mute_notifications` before any channel dispatch — logged as `notifier.muted_by_site` for audit.
- CSV exports off the detail page and globally:
  - `GET /sites/:id/checks.csv?limit=N`
  - `GET /sites/:id/incidents.csv?limit=N`
  - `GET /incidents.csv?limit=N`
  - Identical RFC 4180 quoting helper used everywhere.
- Site form: "Notes & alert mute" section. Detail page: notes block + "Notifications muted" badge + two CSV download buttons.

---

## Phase 12 — Optional Docker — SHIPPED

**Why low**: project sells "no Docker required" — kept that — but the docker-compose path is now first-class for r/selfhosted users who default to compose.

- **`Dockerfile`** — two-stage build on `node:20-bookworm-slim`:
  - Stage 1 installs `python3`, `make`, `g++` and runs `npm ci --omit=dev` so `better-sqlite3` compiles its native binding against the target glibc.
  - Stage 2 ships only the runtime: `iputils-ping` (for the ICMP monitor), `tini` (PID 1, signal-forwarding), `ca-certificates`. Runs as the unprivileged `node` user. `/data` is a declared volume. Final image hovers around ~150 MB.
  - `HEALTHCHECK` hits the new unauthenticated `GET /healthz` (returns `{ ok, ts }`).
- **`docker-compose.yml`** — two profiles in one file:
  - Default: just the `uptime` service, SQLite under a named volume `uptime-data`.
  - `--profile mysql`: brings up `mysql:8.4` alongside, with `MYSQL_RANDOM_ROOT_PASSWORD=yes`, healthcheck, and a separate `mysql-data` volume. Setting `DB_DRIVER=mysql` in `.env` is enough to switch.
  - `cap_add: NET_RAW` granted to the app container so the bundled `ping` binary can open its raw socket inside the container.
  - All sensitive env vars (`SESSION_SECRET`, `ADMIN_PASS`, `DB_PASSWORD`) use `${VAR:?...}` so compose fails loudly if `.env` is missing.
- **`.env.docker.example`** committed — copy to `.env`, change two secrets, `docker compose up -d`.
- **`.dockerignore`** keeps build context tiny by excluding `node_modules`, `data`, `logs`, `.env`, `.git`, and screenshots.
- New unauthenticated `GET /healthz` endpoint added to `src/server.js` — JSON only, no DB hit, `Cache-Control: no-store`.

---

## Phase 13 — Multi-user with per-monitor ACLs — SHIPPED

**Why medium**: shared-team self-hosters need more than a single shared password.

- New roles **`admin` / `editor` / `viewer`** layered on top of per-monitor grants **`view` / `manage`**. The `.env` super-admin is preserved as a permanent break-glass account and is never written to the `users` table.
- New tables: `users` (argon2 password hash, role, per-user TOTP, recovery codes, disabled flag, must-change-password flag, last-login metadata) and `site_grants` (`(site_id, user_id)` PK with `view` / `manage` permission). New columns: `sites.owner_user_id`, `api_tokens.user_id`, `audit_log.actor_user_id`, `channels.created_by_user_id`. All migrations are idempotent on both SQLite and MySQL.
- `src/lib/users.js` — argon2 hashing, CRUD, password verification, env-admin username reservation (refuses to create a DB user that collides with `ADMIN_USER`).
- `src/lib/acl.js` — `canSeeSite`, `canManageSite`, `siteFilterClause` for splicing into list queries, plus `requireRole` / `requireSiteSee` / `requireSiteManage` Express middleware.
- `src/lib/grants.js` — `list`, `set`, `revoke`, `setMany` for managing the join rows.
- Auth refactor: `startLogin` looks up DB users first (rejecting `disabled = 1`), falls back to constant-time `.env` comparison. TOTP secret + recovery codes are loaded from the matching `users` row OR the legacy singleton `settings` row depending on who is logging in. Session shape grows `{ id, isEnv, username, role, mustChangePassword }`, refreshed from the DB on every request so role changes and disable take effect immediately.
- Route guards: every `/sites/*` write path runs through `requireSiteManage`, list / detail / CSV paths through `requireSiteSee`. Dashboard, `/api/sites`, and `/api/v1/sites*` apply `siteFilterClause` so non-admins literally cannot enumerate other people's monitors. Bulk actions silently drop sites the caller cannot manage and flash a count of skipped rows. All `/settings/*` admin routes require `admin`, except `/settings/account` (any user) and `/settings/audit` (any user — non-admins see only their own actions).
- API tokens are scoped to a user: `requireApi` resolves `apiToken.user_id` → acting user (env admin synthetic when NULL), and every `/api/v1` response is filtered through that user's ACL. `/metrics` is filtered the same way.
- Audit log: every `audit.fromReq` write captures `actor_user_id` (NULL for env admin, still readable via `actor` text). The reader filters non-admins to their own rows automatically.
- UI: new admin pages **`/settings/users`** (list, create, role / disable / reset-pw / disable-2FA / delete, plus a "claim all unowned monitors" button) and **`/settings/users/:id/grants`** (per-site `none` / `view` / `manage` selector with bulk buttons). New user-facing **`/settings/account`** page (own profile, password, 2FA + recovery codes, personal API tokens). The site form gains an Ownership selector for admins; the site detail page gains a Sharing card with owner + grants management for owners and admins; the navbar splits "Administration" (admin-only) from "My account" (any user).
- Smoke tested end to end via `scripts/smoke-acl.sh` against both SQLite (`scripts/dev-restart.sh`) and MySQL (`scripts/dev-restart-mysql.sh`).

### Deliberately out of scope for this phase

- Groups / teams (would need a third table and dedicated UI; revisit on real demand)
- Per-channel or per-tag ACLs (channels and tags stay admin-managed)
- OIDC / SAML SSO
- Self-service signup or email invitations (admin creates users only)
- User-driven forgot-password flow (admins reset passwords from `/settings/users`)
- Separate API token "viewer" scope (existing `read` / `write` + ACL is sufficient)

---

## Out of scope (deliberately)

Adding any of these would change what this project is. Compete on simplicity, not feature breadth.

- Multi-region probe fleet
- On-call schedules, phone-call escalation
- Synthetic browser monitoring (Playwright, headless Chromium per probe)
- AI postmortems / agentic root-cause analysis
- APM, log management, error tracking (OneUptime's "everything in one box")
- SAML / OIDC SSO (only matters for enterprise self-hosters)

---

## Done = what?

A phase is considered done when **all** of the following are true:

1. The DB schema (sqlite + mysql) was extended without breaking existing rows.
2. New routes work end-to-end via `curl` against the local app on port 3001.
3. The dashboard renders without errors and existing monitors keep ticking.
4. No new linter errors were introduced.
5. The phase's user-visible features are documented in the README.

The session ends with a final summary of: shipped phases, deferred phases (with reason), and any follow-up tasks for the next session.

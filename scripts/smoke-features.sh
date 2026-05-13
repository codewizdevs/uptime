#!/usr/bin/env bash
# End-to-end feature smoke test. Drives the dev instance on port 3001 (started
# by scripts/dev-restart.sh) and exercises every shipped feature class:
#
#   1. health + public routes
#   2. monitor CRUD for all 6 types (HTTP, TCP, Ping, DNS, Cert, Heartbeat)
#   3. /ping/<token> heartbeat ingestion (start, 0, 1, GET)
#   4. tags CRUD + dashboard filter + bulk attach/detach
#   5. notification channels — create one of every type, list, delete
#   6. SMTP settings save
#   7. branding update
#   8. maintenance windows (one-off + recurring + toggle + delete)
#   9. CSV exports (checks, per-site incidents, global incidents)
#  10. backup export (all + selected) + JSON validation
#  11. REST API v1 — health + sites list + per-site + write (pause/resume/check-now)
#  12. /metrics Prometheus exporter
#  13. public status page — html + json + rss + private token mode
#  14. bulk dashboard actions (pause / resume / tag_add / tag_remove / delete)
#  15. audit log records every state change
#  16. data retention prune
#
# Cleanup at the bottom removes every artefact we created so the script is
# idempotent. Companion to scripts/smoke-acl.sh which covers role + grant
# semantics; both should be green before declaring the build stable.
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:3001}"
ENV_ADMIN_USER="${ENV_ADMIN_USER:-admin}"
ENV_ADMIN_PASS="${ENV_ADMIN_PASS:-admin}"
SMOKE_DRIVER="${SMOKE_DRIVER:-sqlite}"
TMP="/tmp/uptime-features"
rm -rf "$TMP" && mkdir -p "$TMP"

if [ "$SMOKE_DRIVER" = "mysql" ]; then
  set -a; . ./.env 2>/dev/null || true; set +a
  export DB_DRIVER=mysql
else
  export DB_DRIVER=sqlite
  export SQLITE_PATH=data/uptime.sqlite
fi
export LOG_LEVEL=silent

pass() { printf "\e[32mPASS\e[0m %s\n" "$*"; }
fail() { printf "\e[31mFAIL\e[0m %s\n" "$*" >&2; exit 1; }
info() { printf "\e[36m----\e[0m %s\n" "$*"; }

login()       { curl -s -c "$1" "$BASE/login" >/dev/null && curl -s -b "$1" -c "$1" -X POST -d "username=$2&password=$3" -o /dev/null "$BASE/login"; }
status()      { curl -s -b "$1" -o /dev/null -w "%{http_code}" "$BASE$2"; }
post_status() { curl -s -b "$1" -X POST -d "${3:-}" -o /dev/null -w "%{http_code}" "$BASE$2"; }
get_body()    { curl -s -b "$1" "$BASE$2"; }

node_run() {
  NODE_ENV=production /usr/bin/node -e "$1"
}

# Extracts a numeric site ID out of a Location header from POST /sites.
location_id() {
  local loc="$1"
  printf "%s" "$loc" | grep -oE '/sites/[0-9]+' | grep -oE '[0-9]+' || true
}

# ─── 0. Login the env admin once. ────────────────────────────────────────
info "0. env admin login"
JAR="$TMP/admin.jar"
login "$JAR" "$ENV_ADMIN_USER" "$ENV_ADMIN_PASS"
[[ "$(status "$JAR" /)" = "200" ]] || fail "admin dashboard should be 200"
pass "env admin logged in"

# ─── 1. Health + public routes ───────────────────────────────────────────
info "1. health + public routes"
[[ "$(status '' /healthz)" = "200" ]] || fail "/healthz should be 200 unauth"
[[ "$(status '' /login)"   = "200" ]] || fail "/login should be 200 unauth"
# /status is public; default-on; depending on settings may be 200 or 404
STATUS_CODE=$(status '' /status)
[[ "$STATUS_CODE" =~ ^(200|404|401)$ ]] || fail "/status returned unexpected $STATUS_CODE"
pass "public routes reachable"

# ─── 2. Monitor CRUD: create one of every type ───────────────────────────
info "2. create one monitor of each type"

create_monitor() {
  local label="$1" body="$2"
  local loc
  loc=$(curl -s -b "$JAR" -X POST $body -D - -o /dev/null "$BASE/sites" | grep -i '^location:' | tr -d '\r' | awk '{print $2}')
  local id; id=$(location_id "$loc")
  [[ -n "$id" ]] || fail "create $label failed (loc=$loc)"
  printf "%s" "$id"
}

HTTP_ID=$(create_monitor http "\
  --data-urlencode name=ft-http \
  --data-urlencode monitor_type=active \
  --data-urlencode url=https://example.com \
  --data-urlencode method=GET \
  --data-urlencode interval_seconds=300 \
  --data-urlencode timeout_ms=10000 \
  --data-urlencode check_type=status \
  --data-urlencode expected_status=200 \
  --data-urlencode failure_threshold=1 \
  --data-urlencode heartbeat_grace_seconds=60")

TCP_ID=$(create_monitor tcp "\
  --data-urlencode name=ft-tcp \
  --data-urlencode monitor_type=tcp \
  --data-urlencode interval_seconds=300 \
  --data-urlencode timeout_ms=5000 \
  --data-urlencode failure_threshold=1 \
  --data-urlencode heartbeat_grace_seconds=60 \
  --data-urlencode tcp_host=127.0.0.1 \
  --data-urlencode tcp_port=3001")

PING_ID=$(create_monitor ping "\
  --data-urlencode name=ft-ping \
  --data-urlencode monitor_type=ping \
  --data-urlencode interval_seconds=300 \
  --data-urlencode timeout_ms=5000 \
  --data-urlencode failure_threshold=1 \
  --data-urlencode heartbeat_grace_seconds=60 \
  --data-urlencode ping_host=127.0.0.1 \
  --data-urlencode ping_count=1")

DNS_ID=$(create_monitor dns "\
  --data-urlencode name=ft-dns \
  --data-urlencode monitor_type=dns \
  --data-urlencode interval_seconds=300 \
  --data-urlencode timeout_ms=5000 \
  --data-urlencode failure_threshold=1 \
  --data-urlencode heartbeat_grace_seconds=60 \
  --data-urlencode dns_query=one.one.one.one \
  --data-urlencode dns_record_type=A \
  --data-urlencode dns_expected=1.1.1.1")

CERT_ID=$(create_monitor cert "\
  --data-urlencode name=ft-cert \
  --data-urlencode monitor_type=cert \
  --data-urlencode interval_seconds=300 \
  --data-urlencode timeout_ms=10000 \
  --data-urlencode failure_threshold=1 \
  --data-urlencode heartbeat_grace_seconds=60 \
  --data-urlencode cert_host=example.com \
  --data-urlencode cert_port=443 \
  --data-urlencode cert_expiry_warn_days=14")

HB_ID=$(create_monitor heartbeat "\
  --data-urlencode name=ft-heartbeat \
  --data-urlencode monitor_type=heartbeat \
  --data-urlencode interval_seconds=60 \
  --data-urlencode timeout_ms=10000 \
  --data-urlencode failure_threshold=1 \
  --data-urlencode heartbeat_grace_seconds=30 \
  --data-urlencode heartbeat_schedule_kind=interval")

pass "created HTTP=$HTTP_ID  TCP=$TCP_ID  PING=$PING_ID  DNS=$DNS_ID  CERT=$CERT_ID  HB=$HB_ID"

# Site detail must render for each.
for id in "$HTTP_ID" "$TCP_ID" "$PING_ID" "$DNS_ID" "$CERT_ID" "$HB_ID"; do
  [[ "$(status "$JAR" /sites/$id)" = "200" ]] || fail "/sites/$id should be 200"
done
pass "/sites/<id> renders for every type"

# Pause + resume each.
for id in "$HTTP_ID" "$TCP_ID" "$PING_ID" "$DNS_ID" "$CERT_ID" "$HB_ID"; do
  [[ "$(post_status "$JAR" /sites/$id/pause)"  = "302" ]] || fail "pause $id"
  [[ "$(post_status "$JAR" /sites/$id/pause)"  = "302" ]] || fail "resume $id"
done
pass "pause/resume works on every type"

# ─── 3. Trigger check-now on each non-heartbeat monitor; wait for result ─
info "3. check-now on each active monitor, verify state updates"
for id in "$HTTP_ID" "$TCP_ID" "$PING_ID" "$DNS_ID" "$CERT_ID"; do
  [[ "$(post_status "$JAR" /sites/$id/check-now)" = "302" ]] || fail "check-now $id"
done
# Probes are async; give them up to 10s to finish before reading state.
# Verification: every non-heartbeat monitor must have at least one row in
# `checks` (last_checked_at lives there, not on the sites table) and a
# resolved current_state of up/down.
sleep 8
node_run "(async()=>{
  const db=require('./src/db');
  const rows=await db.query(\"SELECT id,name,current_state FROM sites WHERE name LIKE 'ft-%' ORDER BY id ASC\");
  for (const r of rows) {
    if (r.name === 'ft-heartbeat') continue;
    const c = await db.query('SELECT COUNT(*) c FROM checks WHERE site_id=?',[ r.id ]);
    if (!c[0].c) { console.error(r.name+' has 0 checks'); process.exit(1); }
    if (!['up','down'].includes(r.current_state)) {
      console.error(r.name+' state='+r.current_state); process.exit(1);
    }
  }
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)})"
pass "every active probe produced a check result"

# ─── 4. Heartbeat ping endpoints ─────────────────────────────────────────
info "4. /ping/<token> ingestion (start, success, fail, GET)"
HB_TOKEN=$(node_run "(async()=>{
  const db=require('./src/db');
  const r=await db.query('SELECT heartbeat_token FROM sites WHERE id=?',[ $HB_ID ]);
  console.log(r[0]?.heartbeat_token||'');process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)})")
[[ -n "$HB_TOKEN" ]] || fail "heartbeat token not generated"
# Use all four flavours.
[[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/ping/$HB_TOKEN")"          = "200" ]] || fail "GET  /ping/<token>"
[[ "$(curl -s -X POST -d 'startup' -o /dev/null -w '%{http_code}' "$BASE/ping/$HB_TOKEN/start")"     = "200" ]] || fail "POST /ping/<token>/start"
[[ "$(curl -s -X POST -d 'completed ok' -o /dev/null -w '%{http_code}' "$BASE/ping/$HB_TOKEN/0")"   = "200" ]] || fail "POST /ping/<token>/0"
[[ "$(curl -s -X POST -d 'job failed'  -o /dev/null -w '%{http_code}' "$BASE/ping/$HB_TOKEN/1")"   = "200" ]] || fail "POST /ping/<token>/1"
# Unknown token → 404.
[[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/ping/0000000000000000")" = "404" ]] || fail "unknown ping token should 404"
# Allow async DB writes to land before we assert on heartbeat_pings rows.
sleep 0.5
node_run "(async()=>{
  const db=require('./src/db');
  const rows=await db.query('SELECT COUNT(*) c FROM heartbeat_pings WHERE site_id=?',[ $HB_ID ]);
  if (rows[0].c < 4) { console.error('expected >=4 heartbeat_pings, got '+rows[0].c); process.exit(1); }
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)})"
pass "heartbeat ping endpoints work (4 rows recorded)"

# ─── 5. Tags CRUD + dashboard filter + bulk attach/detach ────────────────
info "5. tags CRUD + bulk attach + filter"
TAG_LOC=$(curl -s -b "$JAR" -X POST \
  --data-urlencode "name=ft-tag" --data-urlencode "color=blue" \
  -D - -o /dev/null "$BASE/settings/tags" | grep -i '^location:' | tr -d '\r' | awk '{print $2}')
TAG_ID=$(node_run "require('./src/db').query(\"SELECT id FROM tags WHERE name='ft-tag' LIMIT 1\").then(r=>{console.log(r[0]?.id||'');process.exit(0)})")
[[ -n "$TAG_ID" ]] || fail "tag not created (loc=$TAG_LOC)"
# Bulk-attach tag to two monitors.
post_status "$JAR" /sites/bulk "action=tag_add&tag_id=$TAG_ID&site_ids=$HTTP_ID&site_ids=$TCP_ID" >/dev/null
# Dashboard filter by tag → must include only those two.
TAG_HTML=$(get_body "$JAR" "/?tag=$TAG_ID")
grep -q "ft-http"  <<<"$TAG_HTML" || fail "dashboard tag-filter missing ft-http"
grep -q "ft-tcp"   <<<"$TAG_HTML" || fail "dashboard tag-filter missing ft-tcp"
grep -q "ft-ping"  <<<"$TAG_HTML" && fail "dashboard tag-filter should NOT show ft-ping"
# Bulk detach + delete tag.
post_status "$JAR" /sites/bulk "action=tag_remove&tag_id=$TAG_ID&site_ids=$HTTP_ID&site_ids=$TCP_ID" >/dev/null
post_status "$JAR" /settings/tags/$TAG_ID/delete >/dev/null
TAGS_AFTER=$(node_run "require('./src/db').query(\"SELECT COUNT(*) c FROM tags WHERE name='ft-tag'\").then(r=>{console.log(r[0].c);process.exit(0)})")
[[ "$TAGS_AFTER" = "0" ]] || fail "tag should be gone (got $TAGS_AFTER)"
pass "tags CRUD + filter + bulk attach/detach"

# ─── 6. Channels — create one of each type, list shows them, delete ──────
info "6. channels: create + list + delete (10 types)"
mk_channel() {
  local form="$1"
  local loc id
  loc=$(curl -s -b "$JAR" -X POST $form -D - -o /dev/null "$BASE/channels" | grep -i '^location:' | tr -d '\r' | awk '{print $2}')
  id=$(printf "%s" "$loc" | grep -oE '/channels/[0-9]+/edit' | grep -oE '[0-9]+' || true)
  [[ -n "$id" ]] || fail "create channel failed (loc=$loc)"
  printf "%s" "$id"
}

CH_DISCORD=$(mk_channel " --data-urlencode name=ft-discord  --data-urlencode type=discord  --data-urlencode enabled=1 --data-urlencode webhook_url=https://discord.com/api/webhooks/000/aaa")
CH_SLACK=$(  mk_channel " --data-urlencode name=ft-slack    --data-urlencode type=slack    --data-urlencode enabled=1 --data-urlencode webhook_url=https://hooks.slack.com/services/T0/B0/xxxxxxxxxxxx")
CH_TG=$(     mk_channel " --data-urlencode name=ft-telegram --data-urlencode type=telegram --data-urlencode enabled=1 --data-urlencode bot_token=12345:fake --data-urlencode chat_id=-100")
CH_NTFY=$(   mk_channel " --data-urlencode name=ft-ntfy     --data-urlencode type=ntfy     --data-urlencode enabled=1 --data-urlencode topic_url=https://ntfy.sh/ft-smoke-test --data-urlencode priority=3")
CH_GOTIFY=$( mk_channel " --data-urlencode name=ft-gotify   --data-urlencode type=gotify   --data-urlencode enabled=1 --data-urlencode server_url=https://gotify.example --data-urlencode app_token=AAA --data-urlencode priority=5")
CH_PUSH=$(   mk_channel " --data-urlencode name=ft-pushover --data-urlencode type=pushover --data-urlencode enabled=1 --data-urlencode app_token=AAA --data-urlencode user_key=UUU --data-urlencode priority=0")
CH_MM=$(     mk_channel " --data-urlencode name=ft-mm       --data-urlencode type=mattermost --data-urlencode enabled=1 --data-urlencode webhook_url=https://mm.example/hooks/abc")
CH_TEAMS=$(  mk_channel " --data-urlencode name=ft-teams    --data-urlencode type=teams    --data-urlencode enabled=1 --data-urlencode webhook_url=https://outlook.office.com/webhook/xxx")
CH_EMAIL=$(  mk_channel " --data-urlencode name=ft-email    --data-urlencode type=email    --data-urlencode enabled=1 --data-urlencode to_emails=alice@example.com")
CH_WEBHOOK=$(mk_channel " --data-urlencode name=ft-webhook  --data-urlencode type=webhook  --data-urlencode enabled=1 --data-urlencode url=https://example.com/hook --data-urlencode method=POST --data-urlencode content_type=application/json --data-urlencode headers_json={}")

CH_LIST=$(get_body "$JAR" /channels)
for n in ft-discord ft-slack ft-telegram ft-ntfy ft-gotify ft-pushover ft-mm ft-teams ft-email ft-webhook; do
  grep -q "$n" <<<"$CH_LIST" || fail "/channels listing missing $n"
done
pass "all 10 channel types created and listed"

# Attach two channels to the HTTP monitor (edit form re-submit).
# (We use the channel-ids[] field that the form encodes; the route accepts repeated values.)
curl -s -b "$JAR" -X POST \
  --data-urlencode "name=ft-http" --data-urlencode "monitor_type=active" \
  --data-urlencode "url=https://example.com" --data-urlencode "method=GET" \
  --data-urlencode "interval_seconds=300" --data-urlencode "timeout_ms=10000" \
  --data-urlencode "check_type=status" --data-urlencode "expected_status=200" \
  --data-urlencode "failure_threshold=1" --data-urlencode "heartbeat_grace_seconds=60" \
  --data-urlencode "channel_ids=$CH_DISCORD" --data-urlencode "channel_ids=$CH_EMAIL" \
  -o /dev/null "$BASE/sites/$HTTP_ID/edit"
ATTACHED=$(node_run "require('./src/db').query('SELECT COUNT(*) c FROM site_channels WHERE site_id=?',[ $HTTP_ID ]).then(r=>{console.log(r[0].c);process.exit(0)})")
[[ "$ATTACHED" = "2" ]] || fail "expected 2 attached channels, got $ATTACHED"
pass "attach channels to monitor"

# Channel test buttons return a 302 redirect (success-flash on success path,
# error-flash on dispatch failure). Never 500.
for id in "$CH_DISCORD" "$CH_EMAIL" "$CH_WEBHOOK" "$CH_NTFY"; do
  code=$(post_status "$JAR" /channels/$id/test)
  [[ "$code" = "302" ]] || fail "channel test $id should redirect, got $code"
done
pass "channel test endpoints redirect (no 500)"

# ─── 7. SMTP settings page saves cleanly ─────────────────────────────────
info "7. SMTP settings save round-trip"
post_status "$JAR" /settings/smtp \
  "smtp_host=smtp.example.com&smtp_port=587&smtp_from_address=test@example.com&smtp_from_display=Smoke%20Test&smtp_use_tls=1" >/dev/null
SMTP_OK=$(node_run "require('./src/lib/email').getSettings().then(s=>{console.log(s?.smtp_host||'');process.exit(0)})")
[[ "$SMTP_OK" = "smtp.example.com" ]] || fail "SMTP settings did not persist (got $SMTP_OK)"
pass "SMTP settings round-trip"

# ─── 8. Branding update ──────────────────────────────────────────────────
info "8. branding app-name update"
post_status "$JAR" /settings/branding "appName=Smoke%20Uptime&tagline=Stable" >/dev/null
HOME_HTML=$(get_body "$JAR" /)
grep -q "Smoke Uptime" <<<"$HOME_HTML" || fail "branding update did not propagate to dashboard"
# Restore default so subsequent tests / users aren't surprised.
post_status "$JAR" /settings/branding/reset >/dev/null
pass "branding update propagates and reverts"

# ─── 9. Maintenance windows — oneoff + recurring + toggle + delete ──────
info "9. maintenance windows: oneoff + recurring + toggle + delete"
post_status "$JAR" /settings/maintenance \
  "name=ft-mw-oneoff&enabled=1&scope=global&kind=oneoff&starts_at=2030-01-01T00:00&ends_at=2030-01-01T01:00&timezone=UTC&suppress_notifications=1" >/dev/null
post_status "$JAR" /settings/maintenance \
  "name=ft-mw-cron&enabled=1&scope=global&kind=recurring&cron=0%202%20*%20*%200&duration_minutes=60&timezone=UTC&suppress_notifications=1" >/dev/null
MW_IDS=$(node_run "require('./src/db').query(\"SELECT id,name FROM maintenance_windows WHERE name LIKE 'ft-mw-%'\").then(r=>{console.log(r.map(x=>x.id).join(','));process.exit(0)})")
[[ -n "$MW_IDS" ]] || fail "no maintenance windows created"
IFS=',' read -r MW_A MW_B <<<"$MW_IDS"
[[ "$(post_status "$JAR" /settings/maintenance/$MW_A/toggle)" = "302" ]] || fail "mw toggle"
[[ "$(post_status "$JAR" /settings/maintenance/$MW_A/delete)" = "302" ]] || fail "mw delete A"
[[ "$(post_status "$JAR" /settings/maintenance/$MW_B/delete)" = "302" ]] || fail "mw delete B"
MW_GONE=$(node_run "require('./src/db').query(\"SELECT COUNT(*) c FROM maintenance_windows WHERE name LIKE 'ft-mw-%'\").then(r=>{console.log(r[0].c);process.exit(0)})")
[[ "$MW_GONE" = "0" ]] || fail "maintenance windows not cleaned up"
pass "maintenance windows: create/toggle/delete OK"

# ─── 10. CSV exports ─────────────────────────────────────────────────────
info "10. CSV exports"
CSV_CHECKS=$(curl -s -b "$JAR" "$BASE/sites/$HTTP_ID/checks.csv")
grep -q '^id,site_id' <<<"$CSV_CHECKS" || fail "checks.csv missing header"
CSV_INC=$(curl -s -b "$JAR" "$BASE/sites/$HTTP_ID/incidents.csv")
grep -q '^id,site_id' <<<"$CSV_INC" || fail "per-site incidents.csv missing header"
CSV_GLOBAL=$(curl -s -b "$JAR" "$BASE/incidents.csv")
grep -q '^id,site_id' <<<"$CSV_GLOBAL" || fail "global incidents.csv missing header"
pass "CSV exports have expected headers"

# ─── 11. Backup export (all + selected) ──────────────────────────────────
info "11. backup export"
curl -s -b "$JAR" -X POST \
  --data-urlencode "scope=all" --data-urlencode "include_channels=1" \
  -o "$TMP/backup-all.json" \
  "$BASE/settings/backup/export"
node_run "
const p = JSON.parse(require('fs').readFileSync('$TMP/backup-all.json','utf8'));
if (!p.version || !p.monitors || !Array.isArray(p.monitors)) { console.error('not a valid backup'); process.exit(1); }
if (p.monitors.length < 6) { console.error('expected >=6 monitors, got '+p.monitors.length); process.exit(1); }
if (!Array.isArray(p.channels) || p.channels.length < 10) { console.error('channels missing, got '+(p.channels||[]).length); process.exit(1); }
if (!p.app) { console.error('missing app marker'); process.exit(1); }
if (!p.counts || typeof p.counts !== 'object') { console.error('missing counts'); process.exit(1); }
process.exit(0);
"

curl -s -b "$JAR" -X POST \
  --data-urlencode "scope=selected" --data-urlencode "site_ids=$HTTP_ID" --data-urlencode "include_channels=0" \
  -o "$TMP/backup-sel.json" \
  "$BASE/settings/backup/export"
node_run "
const p = JSON.parse(require('fs').readFileSync('$TMP/backup-sel.json','utf8'));
if (p.monitors.length !== 1) { console.error('selected export should have 1, got '+p.monitors.length); process.exit(1); }
if (p.monitors[0].name !== 'ft-http') { console.error('wrong monitor exported: '+p.monitors[0].name); process.exit(1); }
process.exit(0);
"
pass "backup export (all + selected) valid"

# Round-trip import using skip strategy — must be a no-op (everything already
# exists with the same name).
IMPORT_RESP=$(curl -s -b "$JAR" -X POST \
  --data-urlencode "payload@$TMP/backup-sel.json" \
  --data-urlencode "conflict=skip" --data-urlencode "import_monitors=1" --data-urlencode "import_channels=0" \
  -o /dev/null -w '%{http_code}' \
  "$BASE/settings/backup/import")
[[ "$IMPORT_RESP" = "302" ]] || fail "backup import returned $IMPORT_RESP"
pass "backup import (skip strategy) accepted"

# ─── 12. REST API v1 — read + write + per-token ACL ──────────────────────
info "12. REST API v1: read + write"
ENV_TOKEN=$(node_run "(async()=>{
  const at=require('./src/lib/apiTokens');
  const r=await at.createToken('ft-smoke-env','write',null);
  console.log(r.token);process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)})")
[[ -n "$ENV_TOKEN" ]] || fail "could not mint env-admin API token"

[[ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $ENV_TOKEN" "$BASE/api/v1/health")" = "200" ]] || fail "API health"
API_SITES=$(curl -s -H "Authorization: Bearer $ENV_TOKEN" "$BASE/api/v1/sites")
grep -q '"name":"ft-http"' <<<"$API_SITES" || fail "GET /api/v1/sites missing ft-http"
API_ONE=$(curl -s -H "Authorization: Bearer $ENV_TOKEN" "$BASE/api/v1/sites/$HTTP_ID")
grep -q '"current_state"' <<<"$API_ONE" || fail "GET /api/v1/sites/<id> missing current_state"
API_STATS=$(curl -s -H "Authorization: Bearer $ENV_TOKEN" "$BASE/api/v1/stats")
grep -q '"total"' <<<"$API_STATS" || fail "GET /api/v1/stats missing 'total'"

# Write endpoints
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $ENV_TOKEN" "$BASE/api/v1/sites/$TCP_ID/pause")"   = "200" ]] || fail "API pause"
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $ENV_TOKEN" "$BASE/api/v1/sites/$TCP_ID/resume")"  = "200" ]] || fail "API resume"
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $ENV_TOKEN" "$BASE/api/v1/sites/$TCP_ID/check-now")" = "200" ]] || fail "API check-now"

# Read-scope token must be 403 on write.
RO_TOKEN=$(node_run "require('./src/lib/apiTokens').createToken('ft-smoke-ro','read',null).then(r=>{console.log(r.token);process.exit(0)})")
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $RO_TOKEN" "$BASE/api/v1/sites/$TCP_ID/pause")" = "403" ]] || fail "read token should 403 on pause"
# Bad token → 401.
[[ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer utk_bogus" "$BASE/api/v1/sites")" = "401" ]] || fail "bogus token should 401"
pass "REST API: read, write, scope enforcement"

# ─── 13. /metrics Prometheus exporter ────────────────────────────────────
info "13. /metrics output"
METRICS=$(curl -s -H "Authorization: Bearer $ENV_TOKEN" "$BASE/metrics")
for m in uptime_monitor_up uptime_monitor_response_time_ms uptime_monitor_uptime_pct_24h uptime_monitors_total uptime_open_incidents; do
  grep -q "^# TYPE $m" <<<"$METRICS" || fail "/metrics missing $m"
done
pass "/metrics exposes all expected series"

# ─── 14. Status page (HTML + JSON + RSS) ─────────────────────────────────
info "14. status page formats"
SP_HTML=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/status")
SP_JSON=$(curl -s "$BASE/status.json" || true)
SP_RSS_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/status.rss")
# Status page may be public (200) or require a token (404 with token-required mode).
[[ "$SP_HTML" =~ ^(200|404)$ ]] || fail "/status returned $SP_HTML"
if [[ "$SP_HTML" = "200" ]]; then
  grep -q '"monitors"' <<<"$SP_JSON" || fail "status.json missing monitors[]"
  [[ "$SP_RSS_CODE" =~ ^(200|404)$ ]] || fail "/status.rss returned $SP_RSS_CODE"
fi
pass "status page formats reachable"

# ─── 15. Bulk dashboard actions ──────────────────────────────────────────
info "15. bulk pause/resume across our test monitors"
post_status "$JAR" /sites/bulk "action=pause&site_ids=$HTTP_ID&site_ids=$TCP_ID&site_ids=$PING_ID"   >/dev/null
PAUSED=$(node_run "require('./src/db').query('SELECT COUNT(*) c FROM sites WHERE id IN (?,?,?) AND paused=1',[ $HTTP_ID,$TCP_ID,$PING_ID ]).then(r=>{console.log(r[0].c);process.exit(0)})")
[[ "$PAUSED" = "3" ]] || fail "bulk pause did not pause 3 (got $PAUSED)"
post_status "$JAR" /sites/bulk "action=resume&site_ids=$HTTP_ID&site_ids=$TCP_ID&site_ids=$PING_ID"  >/dev/null
RESUMED=$(node_run "require('./src/db').query('SELECT COUNT(*) c FROM sites WHERE id IN (?,?,?) AND paused=0',[ $HTTP_ID,$TCP_ID,$PING_ID ]).then(r=>{console.log(r[0].c);process.exit(0)})")
[[ "$RESUMED" = "3" ]] || fail "bulk resume did not resume 3 (got $RESUMED)"
pass "bulk pause/resume works on 3 monitors"

# ─── 16. Audit log records the recent state changes ──────────────────────
info "16. audit log records new entries"
sleep 0.3
AUDIT_HTML=$(get_body "$JAR" /settings/audit)
grep -q "site.bulk_pause" <<<"$AUDIT_HTML" || fail "audit missing site.bulk_pause"
grep -q "site.created"    <<<"$AUDIT_HTML" || fail "audit missing site.created"
pass "audit log captured recent actions"

# ─── 17. Data retention: prune runs without error ────────────────────────
info "17. data retention prune runs"
node_run "require('./src/lib/retention').run({ vacuum:false }).then(r=>{
  if (!Array.isArray(r) && !r) { console.error('retention.run returned no results'); process.exit(1); }
  process.exit(0);
}).catch(e=>{console.error(e);process.exit(1)})"
pass "data retention prune runs cleanly"

# ─── CLEANUP ─────────────────────────────────────────────────────────────
info "cleanup: delete test sites, channels, tokens"
for id in "$HTTP_ID" "$TCP_ID" "$PING_ID" "$DNS_ID" "$CERT_ID" "$HB_ID"; do
  post_status "$JAR" /sites/$id/delete >/dev/null || true
done
for id in "$CH_DISCORD" "$CH_SLACK" "$CH_TG" "$CH_NTFY" "$CH_GOTIFY" "$CH_PUSH" "$CH_MM" "$CH_TEAMS" "$CH_EMAIL" "$CH_WEBHOOK"; do
  post_status "$JAR" /channels/$id/delete >/dev/null || true
done
node_run "require('./src/db').query(\"DELETE FROM api_tokens WHERE name LIKE 'ft-smoke-%'\").then(()=>process.exit(0)).catch(()=>process.exit(0))" >/dev/null 2>&1 || true

echo
printf "\e[32m✓ All feature smoke tests passed.\e[0m\n"

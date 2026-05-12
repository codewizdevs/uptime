#!/usr/bin/env bash
# End-to-end ACL smoke test for Phase 14. Drives the running dev instance on
# 3001 (started by scripts/dev-restart.sh) with curl, creating and using
# alice (editor) and bob (viewer). Idempotent: cleans up at the end.
#
# Set BASE=http://127.0.0.1:3002 and SMOKE_DRIVER=mysql to point this at the
# MySQL dev instance instead (see scripts/dev-restart-mysql.sh).
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:3001}"
ENV_ADMIN_USER="${ENV_ADMIN_USER:-admin}"
ENV_ADMIN_PASS="${ENV_ADMIN_PASS:-admin}"
SMOKE_DRIVER="${SMOKE_DRIVER:-sqlite}"
TMP="/tmp/uptime-smoke"
rm -rf "$TMP" && mkdir -p "$TMP"

# Helper node scripts open their own DB connection — point them at the same
# driver the live app is using so they read/write the same data.
if [ "$SMOKE_DRIVER" = "mysql" ]; then
  # Inherit DB_HOST/USER/PASS/NAME from the surrounding shell or .env.
  set -a; . ./.env 2>/dev/null || true; set +a
  export DB_DRIVER=mysql
else
  export DB_DRIVER=sqlite
  export SQLITE_PATH=data/uptime.sqlite
fi
# Silence pino so node helper scripts can return clean stdout to the shell.
export LOG_LEVEL=silent

pass() { printf "\e[32mPASS\e[0m %s\n" "$*"; }
fail() { printf "\e[31mFAIL\e[0m %s\n" "$*" >&2; exit 1; }
info() { printf "\e[36m----\e[0m %s\n" "$*"; }

login() {
  curl -s -c "$1" "$BASE/login" >/dev/null
  curl -s -b "$1" -c "$1" -X POST -d "username=$2&password=$3" -o /dev/null "$BASE/login"
}
status()      { curl -s -b "$1" -o /dev/null -w "%{http_code}" "$BASE$2"; }
post_status() { curl -s -b "$1" -X POST -d "${3:-}" -o /dev/null -w "%{http_code}" "$BASE$2"; }

node_run() {
  # Run a script through the bare node binary so it inherits our env.
  # NODE_ENV=production keeps pino off of stdout (file-only transport), so
  # the helper's `console.log()` returns clean values to the shell.
  NODE_ENV=production /usr/bin/node -e "$1"
}

# ── 1. env admin login ─────────────────────────────────────────────────
info "1. env admin login + access to admin pages"
login "$TMP/env.jar" "$ENV_ADMIN_USER" "$ENV_ADMIN_PASS"
[[ "$(status "$TMP/env.jar" /)" = "200" ]] || fail "env admin / should be 200"
[[ "$(status "$TMP/env.jar" /settings/users)" = "200" ]] || fail "env admin /settings/users should be 200"
[[ "$(status "$TMP/env.jar" /settings/branding)" = "200" ]] || fail "env admin /settings/branding should be 200"
pass "env admin sees admin pages"

# ── 2. ensure clean slate then create alice + bob ──────────────────────
info "2. clean slate + create alice (editor) + bob (viewer)"
node_run "(async()=>{
  const u=require('./src/lib/users');
  for (const n of ['alice','bob']) {
    const r=await u.findByUsername(n);
    if (r) await u.deleteUser(r.id);
  }
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)})"

curl -s -b "$TMP/env.jar" -X POST \
  --data-urlencode "username=alice" --data-urlencode "role=editor" \
  --data-urlencode "email=alice@example.com" --data-urlencode "display_name=Alice" \
  -o /dev/null "$BASE/settings/users"
curl -s -b "$TMP/env.jar" -X POST \
  --data-urlencode "username=bob" --data-urlencode "role=viewer" \
  -o /dev/null "$BASE/settings/users"

# Replace random passwords with known ones AND clear must_change so we can use them.
ALICE_PW="alice-secret-12345"
BOB_PW="bob-secret-12345"
node_run "(async()=>{
  const u=require('./src/lib/users');
  const a=await u.findByUsername('alice');
  const b=await u.findByUsername('bob');
  await u.setPassword(a.id,'$ALICE_PW',{mustChange:false});
  await u.setPassword(b.id,'$BOB_PW',{mustChange:false});
  console.log('IDS alice='+a.id+' bob='+b.id);
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)})"

ALICE_ID=$(node_run "require('./src/lib/users').findByUsername('alice').then(u=>{console.log(u.id);process.exit(0)})")
BOB_ID=$(node_run   "require('./src/lib/users').findByUsername('bob').then(u=>{console.log(u.id);process.exit(0)})")
[[ -n "$ALICE_ID" && -n "$BOB_ID" ]] || fail "could not capture alice/bob ids"
pass "alice=#$ALICE_ID  bob=#$BOB_ID"

# ── 3. alice logs in → empty dashboard initially, creates a monitor ────
info "3. alice logs in → creates her own monitor"
login "$TMP/alice.jar" alice "$ALICE_PW"
[[ "$(status "$TMP/alice.jar" /)" = "200" ]] || fail "alice / should be 200"

ALICE_SITE_LOC=$(curl -s -b "$TMP/alice.jar" -X POST \
  --data-urlencode "name=alice-monitor" --data-urlencode "monitor_type=active" \
  --data-urlencode "url=https://example.com" --data-urlencode "method=GET" \
  --data-urlencode "interval_seconds=300" --data-urlencode "timeout_ms=10000" \
  --data-urlencode "check_type=status" --data-urlencode "expected_status=200" \
  --data-urlencode "failure_threshold=1" --data-urlencode "heartbeat_grace_seconds=60" \
  -D - -o /dev/null "$BASE/sites" | grep -i "^location:" | tr -d '\r' | awk '{print $2}')
ALICE_SITE_ID=$(printf "%s" "$ALICE_SITE_LOC" | grep -oE '/sites/[0-9]+' | grep -oE '[0-9]+' || true)
[[ -n "$ALICE_SITE_ID" ]] || fail "alice POST /sites failed (loc=$ALICE_SITE_LOC)"
pass "alice created monitor #$ALICE_SITE_ID"

# Alice is blocked from admin pages.
ALICE_BRANDING=$(status "$TMP/alice.jar" /settings/branding)
ALICE_USERS=$(status "$TMP/alice.jar" /settings/users)
[[ "$ALICE_BRANDING" = "403" ]] || fail "alice /settings/branding should be 403 (got $ALICE_BRANDING)"
[[ "$ALICE_USERS"    = "403" ]] || fail "alice /settings/users should be 403 (got $ALICE_USERS)"
pass "alice blocked from admin pages"

# /api/sites: alice may see her own, not others.
ALICE_API=$(curl -s -b "$TMP/alice.jar" -H "Accept: application/json" -H "X-Requested-With: XMLHttpRequest" "$BASE/api/sites?ids=$ALICE_SITE_ID,7,8")
echo "$ALICE_API" | grep -q "\"id\":$ALICE_SITE_ID" || fail "alice should see her own in /api/sites"
echo "$ALICE_API" | grep -q '"id":7' && fail "alice should NOT see site 7 before grant"
pass "alice /api/sites scoped to her own"

# ── 4. grants ──────────────────────────────────────────────────────────
info "4. env admin grants alice/manage on 7, bob/view on 8"
GRANT_A=$(post_status "$TMP/env.jar" "/sites/7/grants" "user_id=$ALICE_ID&permission=manage")
[[ "$GRANT_A" = "302" ]] || fail "grant alice on 7 → $GRANT_A"
GRANT_B=$(post_status "$TMP/env.jar" "/sites/8/grants" "user_id=$BOB_ID&permission=view")
[[ "$GRANT_B" = "302" ]] || fail "grant bob on 8 → $GRANT_B"
pass "grants set"

# ── 5. alice ACL ───────────────────────────────────────────────────────
info "5. alice sees own + 7, edits 7, cannot edit 8"
ALICE_API2=$(curl -s -b "$TMP/alice.jar" -H "Accept: application/json" -H "X-Requested-With: XMLHttpRequest" "$BASE/api/sites?ids=$ALICE_SITE_ID,7,8")
echo "$ALICE_API2" | grep -q '"id":7' || fail "alice should now see site 7"
echo "$ALICE_API2" | grep -q '"id":8' && fail "alice should still NOT see site 8"
[[ "$(status "$TMP/alice.jar" /sites/7)"      = "200" ]] || fail "alice /sites/7 → not 200"
[[ "$(status "$TMP/alice.jar" /sites/7/edit)" = "200" ]] || fail "alice /sites/7/edit → not 200"
[[ "$(status "$TMP/alice.jar" /sites/8)"      = "403" ]] || fail "alice /sites/8 should be 403"
pass "alice ACL works"

# ── 6. bob ─────────────────────────────────────────────────────────────
info "6. bob: view-only on 8, blocked everywhere else"
login "$TMP/bob.jar" bob "$BOB_PW"
[[ "$(status "$TMP/bob.jar" /sites/8)"        = "200" ]] || fail "bob /sites/8 → not 200"
[[ "$(status "$TMP/bob.jar" /sites/8/edit)"   = "403" ]] || fail "bob /sites/8/edit should be 403"
[[ "$(post_status "$TMP/bob.jar" /sites/8/pause)" = "403" ]] || fail "bob POST /sites/8/pause should be 403"
[[ "$(status "$TMP/bob.jar" /sites/7)"        = "403" ]] || fail "bob /sites/7 should be 403"
[[ "$(status "$TMP/bob.jar" /settings/users)" = "403" ]] || fail "bob /settings/users should be 403"
pass "bob is read-only on his site"

# ── 7. alice API token ─────────────────────────────────────────────────
info "7. alice API token respects ACL"
ALICE_TOKEN=$(node_run "(async()=>{
  const u=await require('./src/lib/users').findByUsername('alice');
  const t=await require('./src/lib/apiTokens').createToken('alice-smoke','read',u.id);
  console.log(t.token);
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)})")
ALICE_API_V1=$(curl -s -H "Authorization: Bearer $ALICE_TOKEN" "$BASE/api/v1/sites")
echo "$ALICE_API_V1" | grep -q "\"id\":$ALICE_SITE_ID" || fail "alice token should expose her own site"
echo "$ALICE_API_V1" | grep -q '"id":7' || fail "alice token should expose granted site 7"
echo "$ALICE_API_V1" | grep -q '"id":8' && fail "alice token should NOT expose site 8"
ALICE_403=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $ALICE_TOKEN" "$BASE/api/v1/sites/8")
[[ "$ALICE_403" = "403" ]] || fail "alice token GET /api/v1/sites/8 should be 403 (got $ALICE_403)"
pass "alice API token ACL works"

# ── 9. audit visibility ────────────────────────────────────────────────
info "9. audit scoped per user"
post_status "$TMP/alice.jar" "/sites/$ALICE_SITE_ID/delete" >/dev/null
# audit.fromReq is fire-and-forget; give the INSERT a beat to land.
sleep 0.3
ADMIN_AUDIT_HEAD=$(curl -s -b "$TMP/env.jar" -o /dev/null -w "%{http_code}" "$BASE/settings/audit")
[[ "$ADMIN_AUDIT_HEAD" = "200" ]] || fail "env admin /settings/audit → $ADMIN_AUDIT_HEAD (session lost?)"
curl -s -b "$TMP/env.jar" "$BASE/settings/audit" > "$TMP/admin-audit.html"
grep -q "alice" "$TMP/admin-audit.html" || fail "admin audit should mention alice"
curl -s -b "$TMP/bob.jar" "$BASE/settings/audit" > "$TMP/bob-audit.html"
if grep -E "alice|site\.deleted" "$TMP/bob-audit.html" >/dev/null; then
  fail "bob should not see alice's actions in audit"
fi
pass "audit visibility scoped"

# ── 11. disable bob → login refused ────────────────────────────────────
info "11. disable bob → cannot sign in"
post_status "$TMP/env.jar" "/settings/users/$BOB_ID/toggle-disabled" >/dev/null
rm -f "$TMP/bob2.jar"
curl -s -c "$TMP/bob2.jar" "$BASE/login" >/dev/null
curl -s -b "$TMP/bob2.jar" -c "$TMP/bob2.jar" -X POST -d "username=bob&password=$BOB_PW" -o /dev/null "$BASE/login"
BOB_HOME=$(status "$TMP/bob2.jar" /)
[[ "$BOB_HOME" = "302" ]] || fail "disabled bob → / should 302 to /login (got $BOB_HOME)"
pass "disabled bob locked out"

# ── 10. delete alice → grants cascade, monitor 7 unaffected ────────────
info "10. delete alice → grants cascade, monitor 7 stays"
post_status "$TMP/env.jar" "/settings/users/$ALICE_ID/delete" >/dev/null
node_run "(async()=>{
  const db=require('./src/db');
  const u=await require('./src/lib/users').findByUsername('alice');
  if (u) { console.error('alice still exists'); process.exit(1); }
  const g=await db.query('SELECT COUNT(*) c FROM site_grants WHERE site_id=7');
  if (g[0].c !== 0) { console.error('grants on 7 not cleaned ('+g[0].c+')'); process.exit(1); }
  const s=await db.query('SELECT COUNT(*) c FROM sites WHERE id=7');
  if (s[0].c !== 1) { console.error('site 7 vanished'); process.exit(1); }
  console.log('OK');
  process.exit(0);
})()"
pass "alice cascade clean"

# ── 12. env admin still works ──────────────────────────────────────────
info "12. env admin break-glass"
rm -f "$TMP/env2.jar"
login "$TMP/env2.jar" "$ENV_ADMIN_USER" "$ENV_ADMIN_PASS"
[[ "$(status "$TMP/env2.jar" /)" = "200" ]] || fail "env admin / should remain 200"
pass "env admin works"

# ── cleanup ────────────────────────────────────────────────────────────
post_status "$TMP/env2.jar" "/settings/users/$BOB_ID/delete" >/dev/null 2>&1 || true
node_run "(async()=>{
  const db=require('./src/db');
  await db.query(\"DELETE FROM api_tokens WHERE name LIKE 'alice-%' OR name LIKE 'bob-%'\");
  process.exit(0);
})()" >/dev/null 2>&1 || true

echo
printf "\e[32m✓ All ACL smoke tests passed.\e[0m\n"

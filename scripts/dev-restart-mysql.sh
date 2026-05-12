#!/usr/bin/env bash
# Launch the app on port 3002 pointed at MySQL (creds from .env).
# Used to smoke-test that all migrations and code paths still work on MySQL.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Stop any previous instance on 3002
pgrep -af 'node .*src/server.js' \
  | awk '/PORT=3002|uptime-mysql-3002/{print $1}' \
  | xargs -r kill 2>/dev/null || true
sleep 1

mkdir -p logs

# Pull DB creds from .env without polluting our shell.
set -a
. ./.env 2>/dev/null || true
set +a

PORT=3002 \
PUBLIC_BASE_URL=http://localhost:3002 \
DB_DRIVER=mysql \
DB_HOST="${DB_HOST:-127.0.0.1}" \
DB_PORT="${DB_PORT:-3306}" \
DB_USER="${DB_USER:-root}" \
DB_PASSWORD="${DB_PASSWORD:-}" \
DB_NAME="${DB_NAME:-uptime}" \
SESSION_SECRET="${SESSION_SECRET:-mysql-compat-test}" \
ADMIN_USER="${ADMIN_USER:-admin}" \
ADMIN_PASS="${ADMIN_PASS:-admin}" \
  nohup setsid /usr/bin/node src/server.js > /tmp/uptime-mysql-3002.log 2>&1 < /dev/null &

PID=$!
disown 2>/dev/null || true
echo "mysql dev pid=$PID  port=3002  log=/tmp/uptime-mysql-3002.log"

for i in $(seq 1 40); do
  if ss -tln 2>/dev/null | grep -q ':3002\b'; then
    echo "listening on 3002"
    exit 0
  fi
  sleep 0.5
done

echo "WARNING: did not detect listener on 3002 within 20s, see log:"
tail -30 /tmp/uptime-mysql-3002.log
exit 1

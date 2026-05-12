#!/usr/bin/env bash
# Restart the dev instance on port 3001 with SQLite.
# Bypasses the sandboxed `node` wrapper so env vars actually propagate.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Stop anything we previously started
pgrep -af 'node .*src/server.js' | awk '/PORT=3001|uptime-3001/{print $1}' >/dev/null 2>&1 || true
pgrep -af 'node .*src/server.js' | grep -v pgrep | awk '{print $1}' | xargs -r kill 2>/dev/null || true
sleep 1

mkdir -p logs data

PORT=3001 \
PUBLIC_BASE_URL=http://localhost:3001 \
DB_DRIVER=sqlite \
SQLITE_PATH=data/uptime.sqlite \
  nohup setsid /usr/bin/node src/server.js > /tmp/uptime-3001.log 2>&1 < /dev/null &

PID=$!
disown 2>/dev/null || true
echo "dev pid=$PID  port=3001  log=/tmp/uptime-3001.log"

# Wait for it to bind
for i in $(seq 1 20); do
  if ss -tln 2>/dev/null | grep -q ':3001\b'; then
    echo "listening on 3001"
    exit 0
  fi
  sleep 0.25
done
echo "WARNING: did not detect listener on 3001 within 5s, see log"
tail -10 /tmp/uptime-3001.log
exit 1

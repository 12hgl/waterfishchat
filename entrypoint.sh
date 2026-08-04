#!/bin/sh
set -e

mkdir -p /var/log/nginx /var/lib/nginx/tmp /run/nginx /data
touch /var/log/nginx/access.log /var/log/nginx/error.log
echo "${IDLE_TIMEOUT_MIN:-15}" > /tmp/idle_timeout_min

echo "[entry] Starting server.py..."
python3 /usr/local/bin/server.py > /var/log/server.log 2>&1 &
SERVER_PID=$!

# Wait up to 10s for server to be ready
for i in $(seq 1 20); do
  if python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:9000/api/status')" 2>/dev/null; then
    echo "[entry] Server ready (PID $SERVER_PID)"
    break
  fi
  if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo "[entry] FATAL: server.py crashed. Log:"
    cat /var/log/server.log
    exit 1
  fi
  sleep 0.5
done

/usr/local/bin/idle-monitor.sh &
exec nginx -g "daemon off;"

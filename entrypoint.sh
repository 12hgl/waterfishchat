#!/bin/sh
set -e

mkdir -p /var/log/nginx /var/lib/nginx/tmp /run/nginx
touch /var/log/nginx/access.log /var/log/nginx/error.log
echo "${IDLE_TIMEOUT_MIN:-15}" > /tmp/idle_timeout_min

python3 /usr/local/bin/server.py &
/usr/local/bin/idle-monitor.sh &

exec nginx -g "daemon off;"

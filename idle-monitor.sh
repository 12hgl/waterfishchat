# 空闲休眠监控：通过 /api/idle-ping 检测活跃度
IDLE_TIMEOUT_MIN=${IDLE_TIMEOUT_MIN:-15}
CHECK_INTERVAL=30
LOG_FILE="/var/log/nginx/access.log"

while true; do
  sleep $CHECK_INTERVAL

  TIMEOUT=$(cat /tmp/idle_timeout_min 2>/dev/null || echo "$IDLE_TIMEOUT_MIN")

  if [ ! -f "$LOG_FILE" ]; then
    continue
  fi

  NOW=$(date +%s)
  LAST_MOD=$(stat -c %Y "$LOG_FILE" 2>/dev/null)

  if [ -n "$LAST_MOD" ]; then
    ELAPSED=$(( (NOW - LAST_MOD) / 60 ))
    if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
      echo "$(date): idle ${ELAPSED}min >= ${TIMEOUT}min, stopping..."
      nginx -s quit
      kill $(pgrep -f "server.py") 2>/dev/null
      exit 0
    fi
  fi
done

FROM python:3.11-alpine

RUN apk add --no-cache nginx procps

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY nginx.conf /etc/nginx/nginx.conf
COPY web/ /usr/share/nginx/html/
COPY server.py /usr/local/bin/server.py
COPY idle-monitor.sh /usr/local/bin/idle-monitor.sh
COPY entrypoint.sh /entrypoint.sh

RUN chmod +x /usr/local/bin/idle-monitor.sh /entrypoint.sh

ENV IDLE_TIMEOUT_MIN=15

VOLUME ["/data"]
EXPOSE 80

ENTRYPOINT ["/entrypoint.sh"]

#!/usr/bin/env bash
# Start a Cloudflare quick tunnel to the local backend and print ONLY the URL.
# Ctrl-C stops the tunnel (cloudflared exits and the container is removed).
set -euo pipefail

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

docker run --rm cloudflare/cloudflared tunnel \
  --url http://host.docker.internal:5000 >"$LOG" 2>&1 &

PID=$!

URL=""
for _ in $(seq 1 30); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"
  if [ -n "$URL" ]; then
    break
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "cloudflared exited before publishing a URL:" >&2
    tail -5 "$LOG" >&2
    exit 1
  fi
  sleep 1
done

if [ -z "$URL" ]; then
  echo "Timed out waiting for the tunnel URL." >&2
  kill "$PID" 2>/dev/null || true
  exit 1
fi

echo "$URL"

# Keep running in the foreground so Ctrl-C stops the tunnel too.
wait "$PID"

#!/usr/bin/env bash
# Bring up the tour's servers + Chrome and leave them running, for diagnosis.
#
# `record_tour.sh` owns the same three processes but tears them down on exit, which is
# right for a recording and useless for asking why a pane was black. Ctrl-C to stop.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${TOUR_PORT:-8807}"; API_PORT="${TOUR_API_PORT:-8808}"
DEBUG_PORT="${TOUR_DEBUG_PORT:-9333}"; WORK="${TOUR_WORK:-/tmp/dentistry-tour}"
mkdir -p "$WORK"
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

set -a; . ./.worker.env; set +a
DENT_REQUIRE_AUTH=false ./venv/bin/python -m uvicorn api.main:app \
  --host 127.0.0.1 --port "$API_PORT" --log-level warning >"$WORK/api.log" 2>&1 &
PIDS+=($!)
node scripts/tour_server.mjs "$PORT" "$API_PORT" >"$WORK/web.log" 2>&1 &
PIDS+=($!)
for i in $(seq 1 90); do
  curl -fsS "http://127.0.0.1:$PORT/v1/structures" >/dev/null 2>&1 && break
  sleep 1
done
rm -rf "$WORK/profile-probe"
google-chrome --headless=new --ozone-platform=headless --use-angle=gl-egl \
  --user-data-dir="$WORK/profile-probe" --no-first-run --no-default-browser-check \
  --no-sandbox --disable-dev-shm-usage --remote-debugging-port="$DEBUG_PORT" \
  --window-size=2560,1440 --hide-scrollbars about:blank >"$WORK/chrome-probe.log" 2>&1 &
PIDS+=($!)
sleep 6
echo "stack up: web :$PORT  api :$API_PORT  cdp :$DEBUG_PORT"
"$@"

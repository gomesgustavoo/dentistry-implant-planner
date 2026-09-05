#!/usr/bin/env bash
# Record the product tour to docs/tour.mp4.
#
# Three processes, all cleaned up:
#   uvicorn         the REAL FastAPI app, DENT_REQUIRE_AUTH=false
#   google-chrome   --headless=new on the RTX 3080 (--use-angle=gl-egl, NOT --disable-gpu)
#   node            drives the tour over CDP and collects screencast frames
#
# NO Xvfb and NO x11grab. That rig was built first and does not work on this box: Chrome
# on the X11 backend goes through DRI3, which a virtual display does not provide, and
# Chrome responds by blocklisting WebGL outright. Frames come from the page compositor
# via CDP instead -- which also means no window chrome, no sandbox infobar and no cursor.
#
# No credentials anywhere. The tour drives an EXAMPLE case, which `api/deps.load_owned`
# makes readable without a tenant, and the browser-side OIDC object is stubbed exactly as
# `web-auth/check-rail.mjs` stubs it. The API, the web bundle, the case and the GPU are
# all real; only the sign-in is bypassed, on a loopback port, against sample data.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${TOUR_PORT:-8807}"
API_PORT="${TOUR_API_PORT:-8808}"
DEBUG_PORT="${TOUR_DEBUG_PORT:-9333}"
WORK="${TOUR_WORK:-/tmp/dentistry-tour}"
FRAMES="$WORK/frames"
OUT="${TOUR_OUT:-$ROOT/docs/tour-raw.mp4}"

mkdir -p "$WORK" "$(dirname "$OUT")"
PIDS=()
cleanup() {
  # Only ever this script's own PIDs. A pattern-based pkill from the host also matches
  # the production API pods, whose command line is likewise `uvicorn api.main:app`.
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  sleep 1
  for p in "${PIDS[@]:-}"; do kill -9 "$p" 2>/dev/null || true; done
}
trap cleanup EXIT

echo "== the real API on :$API_PORT (DENT_REQUIRE_AUTH=false)"
set -a; . ./.worker.env; set +a
DENT_REQUIRE_AUTH=false ./venv/bin/python -m uvicorn api.main:app \
  --host 127.0.0.1 --port "$API_PORT" --log-level warning >"$WORK/api.log" 2>&1 &
PIDS+=($!)

echo "== static web/ + /v1 proxy on :$PORT"
node scripts/tour_server.mjs "$PORT" "$API_PORT" >"$WORK/web.log" 2>&1 &
PIDS+=($!)

for i in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$PORT/index.html" >/dev/null 2>&1 \
     && curl -fsS "http://127.0.0.1:$PORT/v1/structures" >/dev/null 2>&1; then
    echo "   up after ${i}s"; break
  fi
  sleep 1
  if [ "$i" = 90 ]; then echo "servers did not come up:"; tail -20 "$WORK/api.log"; exit 1; fi
done

echo "== chrome, headless-new, on the GPU"
rm -rf "$WORK/profile"
google-chrome \
  --headless=new --ozone-platform=headless \
  --use-angle=gl-egl \
  --user-data-dir="$WORK/profile" \
  --no-first-run --no-default-browser-check --no-sandbox --disable-dev-shm-usage \
  --remote-debugging-port="$DEBUG_PORT" \
  --window-size=1920,1080 \
  --hide-scrollbars --force-device-scale-factor=1 \
  about:blank >"$WORK/chrome.log" 2>&1 &
PIDS+=($!)
sleep 6

echo "== driving the tour and collecting frames"
set +e
TOUR_PORT="$PORT" TOUR_DEBUG_PORT="$DEBUG_PORT" TOUR_FRAMES="$FRAMES" TOUR_FPS="${TOUR_FPS:-10}" \
  node scripts/record_tour.mjs | tee "$WORK/beats.log"
RC=${PIPESTATUS[0]}
set -e
if [ "$RC" != 0 ]; then echo "tour script failed ($RC)"; exit "$RC"; fi
tail -1 "$WORK/beats.log" > "$WORK/beats.json"

echo "== assembling $(ls "$FRAMES" | grep -c '^f.*jpg') frames -> $OUT"
node scripts/tour_assemble.mjs "$FRAMES" "$OUT"
ls -lh "$OUT"
echo "beats -> $WORK/beats.json"

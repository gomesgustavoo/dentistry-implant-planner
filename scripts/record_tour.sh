#!/usr/bin/env bash
# Record the product tour to docs/tour.mp4.
#
# Owns the four processes the recording needs and cleans all of them up:
#   Xvfb :99          a 2560x1440 display, because this box has no monitor
#   uvicorn           the REAL FastAPI app, DENT_REQUIRE_AUTH=false
#   google-chrome     headed on the RTX 3080 via --use-angle=gl-egl, no --disable-gpu
#   ffmpeg            x11grab of :99 at 30 fps
#
# No credentials anywhere. The tour drives an EXAMPLE case, which `api/deps.load_owned`
# makes readable without a tenant, and the browser-side OIDC object is stubbed exactly as
# `web-auth/check-rail.mjs` stubs it. The API, the web bundle, the case and the GPU are
# all real; only the sign-in is bypassed, on a loopback port, against sample data.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DISPLAY_NUM="${TOUR_DISPLAY:-:99}"
W=2560; H=1440
PORT="${TOUR_PORT:-8807}"
API_PORT="${TOUR_API_PORT:-8808}"
DEBUG_PORT="${TOUR_DEBUG_PORT:-9333}"
WORK="${TOUR_WORK:-/tmp/dentistry-tour}"
OUT="${TOUR_OUT:-$ROOT/docs/tour-raw.mp4}"

mkdir -p "$WORK" "$(dirname "$OUT")"
PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  sleep 1
  for p in "${PIDS[@]:-}"; do kill -9 "$p" 2>/dev/null || true; done
}
trap cleanup EXIT

echo "== Xvfb $DISPLAY_NUM at ${W}x${H}"
# Bracket the first character so the pattern cannot match this script's own command
# line. `pkill -f "Xvfb :99"` from a shell whose argv contains that string kills the
# shell, which exits 144 with no output and looks like the recorder failing to start.
pkill -f "[X]vfb ${DISPLAY_NUM}" 2>/dev/null || true
sleep 1
Xvfb "$DISPLAY_NUM" -screen 0 "${W}x${H}x24" -nolisten tcp >"$WORK/xvfb.log" 2>&1 &
PIDS+=($!)
sleep 2

echo "== the real API on :$API_PORT (DENT_REQUIRE_AUTH=false)"
set -a; . ./.worker.env; set +a
DENT_REQUIRE_AUTH=false ./venv/bin/python -m uvicorn api.main:app \
  --host 127.0.0.1 --port "$API_PORT" --log-level warning >"$WORK/api.log" 2>&1 &
PIDS+=($!)

echo "== static web/ + /v1 proxy on :$PORT"
node scripts/tour_server.mjs "$PORT" "$API_PORT" >"$WORK/web.log" 2>&1 &
PIDS+=($!)

# Wait for both, rather than sleeping a guess.
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/index.html" >/dev/null 2>&1 \
     && curl -fsS "http://127.0.0.1:$PORT/v1/structures" >/dev/null 2>&1; then
    echo "   up after ${i}s"; break
  fi
  sleep 1
  if [ "$i" = 60 ]; then echo "servers did not come up:"; tail -20 "$WORK/api.log"; exit 1; fi
done

echo "== chrome on the GPU"
rm -rf "$WORK/profile"
DISPLAY="$DISPLAY_NUM" google-chrome \
  --user-data-dir="$WORK/profile" \
  --no-first-run --no-default-browser-check --no-sandbox \
  --disable-features=TranslateUI,MediaRouter \
  --use-angle=gl-egl \
  --remote-debugging-port="$DEBUG_PORT" \
  --window-position=0,0 --window-size="$W,$H" --start-fullscreen \
  --hide-scrollbars --autoplay-policy=no-user-gesture-required \
  --app="http://127.0.0.1:$PORT/index.html#/cases" >"$WORK/chrome.log" 2>&1 &
PIDS+=($!)
sleep 8

echo "== ffmpeg -> $OUT"
DISPLAY="$DISPLAY_NUM" ffmpeg -y -loglevel error \
  -f x11grab -framerate 30 -video_size "${W}x${H}" -i "$DISPLAY_NUM" \
  -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p "$OUT" &
FFMPEG_PID=$!
PIDS+=($FFMPEG_PID)
sleep 2

echo "== driving the tour"
set +e
TOUR_PORT="$PORT" TOUR_DEBUG_PORT="$DEBUG_PORT" node scripts/record_tour.mjs | tee "$WORK/beats.log"
RC=${PIPESTATUS[0]}
set -e

sleep 2
kill -INT "$FFMPEG_PID" 2>/dev/null || true
wait "$FFMPEG_PID" 2>/dev/null || true

if [ "$RC" != 0 ]; then echo "tour script failed ($RC)"; exit "$RC"; fi
ls -lh "$OUT"
tail -1 "$WORK/beats.log" > "$WORK/beats.json"
echo "beats -> $WORK/beats.json"

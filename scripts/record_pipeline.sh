#!/usr/bin/env bash
# Bring up the stack, drive the PIPELINE storyboard, assemble the raw body.
#
# Film two: upload, the model catalogue, the segmentation and the report. Sibling of
# record_trailer.sh, same three processes and the same guards.
#
# The same three processes `record_tour.sh` owns, torn down the same way, for the same
# reason: NO Xvfb and NO x11grab. Chrome on the X11 backend goes through DRI3, which a
# virtual display does not provide, and Chrome answers by blocklisting WebGL outright.
# Frames come from the page compositor via CDP instead.
#
#   scripts/record_pipeline.sh    raw body + pipeline-beats.json
#   scripts/trailer_overlays.py   the plates and cards (--variant pipeline)
#   scripts/build_trailer.sh      composites them (TRAILER_WORK=/tmp/dentistry-pipeline)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${TOUR_PORT:-8807}"
API_PORT="${TOUR_API_PORT:-8808}"
DEBUG_PORT="${TOUR_DEBUG_PORT:-9333}"
WORK="${PIPELINE_WORK:-/tmp/dentistry-pipeline}"
FRAMES="$WORK/frames"
OUT="${PIPELINE_RAW:-$WORK/body-raw.mp4}"

mkdir -p "$WORK" "$(dirname "$OUT")"
PIDS=()
# Only ever this script's own PIDs. A pattern-based pkill from the host also matches the
# production API pods, whose command line is likewise `uvicorn api.main:app`.
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

echo "== api on :$API_PORT"
set -a; . ./.worker.env; set +a
DENT_REQUIRE_AUTH=false ./venv/bin/python -m uvicorn api.main:app \
  --host 127.0.0.1 --port "$API_PORT" --log-level warning >"$WORK/api.log" 2>&1 &
PIDS+=($!)

echo "== web on :$PORT"
node scripts/tour_server.mjs "$PORT" "$API_PORT" >"$WORK/web.log" 2>&1 &
PIDS+=($!)

for i in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$PORT/index.html" >/dev/null 2>&1 \
     && curl -fsS "http://127.0.0.1:$PORT/v1/structures" >/dev/null 2>&1; then break; fi
  sleep 1
done

# REFUSE a port someone else is holding, rather than filming through their browser.
# A previous run killed by `timeout` leaves its Chrome behind (the EXIT trap never fires
# on SIGKILL, and fires too late on SIGTERM to matter). The next run's Chrome then loses
# the bind -- "bind() failed: Address already in use" goes to a log nobody reads -- and
# the recorder attaches to the ORPHAN instead. That is not a hypothetical: it is how a
# take ended silently at 40 s of 90, against a browser that was already dying.
if ss -ltn 2>/dev/null | grep -q ":$DEBUG_PORT "; then
  echo "port $DEBUG_PORT is already in use -- a previous run's Chrome is probably still up."
  echo "the recorder would attach to THAT browser, not the one this script starts."
  echo "  pgrep -af 'user-data-dir=$WORK' && pkill -f 'user-data-dir=$WORK'"
  exit 1
fi

echo "== chrome on :$DEBUG_PORT"
rm -rf "$WORK/profile"
# `--use-angle=gl-egl` and NOT `--disable-gpu` is the configuration that reaches the
# RTX 3080; the recorder refuses to run on anything else.
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

echo "== driving the storyboard"
set +e
TOUR_PORT="$PORT" TOUR_DEBUG_PORT="$DEBUG_PORT" TOUR_FRAMES="$FRAMES" \
TOUR_FPS="${TOUR_FPS:-10}" TOUR_CASE="${TOUR_CASE:-}" \
  node scripts/record_pipeline.mjs | tee "$WORK/beats.log"
RC=${PIPESTATUS[0]}
set -e
[ "$RC" = 0 ] || { echo "the recorder failed ($RC)"; exit "$RC"; }

# `frames.json` is written by the LAST line of the recorder, so its absence means the run
# did not finish however cleanly node exited. Checked because the exit code was 0 on a
# take that stopped at 40 s, and the assembler then ran on a partial frame directory and
# produced a video that looked fine.
[ -f "$FRAMES/frames.json" ] || {
  echo "no $FRAMES/frames.json -- the recorder did not reach the end of the storyboard."
  echo "refusing to assemble a partial take."
  exit 1
}
tail -1 "$WORK/beats.log" > "$WORK/pipeline-beats.json"
# The last line has to BE the summary. If the recorder died mid-print, or printed a beat
# last, this is a caption line and every downstream step would read it as JSON.
./venv/bin/python -c "
import json,sys
d=json.load(open('$WORK/pipeline-beats.json'))
assert d.get('frames') and d.get('beats'), 'summary JSON is missing frames/beats'
print('   beats:', len(d['beats']), ' grades:', [g['level'] for g in d.get('grades',[])])
" || { echo "the last log line is not the summary JSON -- the recorder did not finish"; exit 1; }

echo "== assembling $(ls "$FRAMES" | grep -c '^f.*jpg') frames -> $OUT"
# `tour_assemble.mjs` reads the per-frame timestamps and holds each one for its measured
# duration, so the video's clock is the wall clock the storyboard ran on. That is what
# lets the plates be placed by `at` seconds rather than by counting frames.
TOUR_OUT_FPS="${TOUR_OUT_FPS:-30}" node scripts/tour_assemble.mjs "$FRAMES" "$OUT"
ls -lh "$OUT"
echo "beats -> $WORK/pipeline-beats.json"

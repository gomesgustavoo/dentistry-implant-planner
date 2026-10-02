#!/usr/bin/env bash
# Container smoke test for the landing image, run under the pod's own limits.
#
#   scripts/check_landing_image.sh <tag>        # tests dentistry/landing:<tag>
#   IMAGE=some/image:tag scripts/check_landing_image.sh x
#
# Why a container and not the dev server: the headers that matter here are nginx's
# (docker/landing-nginx.conf), and the failure this guards against is the one that already
# happened in production -- both replicas OOMKilled 14 and 15 times against 96Mi when
# nginx spawned a worker per host core and each gzipping connection held a zlib context.
# So the container gets the k8s limits (96 MiB, no swap, 0.2 CPU) and real load.
#
# Checks, each printed PASS or FAIL; exits 1 on any FAIL:
#   - an mp4 under /assets/media: exactly ONE Cache-Control, immutable, video/mp4, and 206
#     with 1024 bytes for Range: bytes=0-1023 (iOS will not play a video without ranges)
#   - hero3d.js and arch.assets.json still revalidate (the regex location still wins)
#   - /film/chapters.vtt is text/vtt (and the ES/PT ones, when they exist)
#   - /download and /download/ 302 to /vr/; /vr 301s to a RELATIVE /vr/
#   - with an APK in the image: its type, attachment + filename, one immutable header,
#     nosniff, no gzip, Content-Length equal to the file; without one, /vr/ shows no download
#   - load: 300 HTML requests 20 at a time (gzip on), plus 3 full APK downloads when one
#     exists, whose SHA-256 must equal the /vr/ page's data-sha256; afterwards the container
#     is still running, was not OOMKilled, and its sampled memory peak stayed under 96 MiB
set -uo pipefail

TAG=${1:?usage: scripts/check_landing_image.sh <tag>}
IMAGE=${IMAGE:-dentistry/landing:$TAG}
PORT=${PORT:-8099}
LIMIT_MIB=96
BASE="http://127.0.0.1:$PORT"
NAME="landing-smoke-$$"
ROOT=/usr/share/nginx/html

# The dev box needs sudo for the docker socket; a CI runner usually does not.
if docker info >/dev/null 2>&1; then DOCKER=(docker); else DOCKER=(sudo -n docker); fi

failures=0
pass() { printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; failures=$((failures + 1)); }
info() { printf 'INFO %s\n' "$*"; }

TMP=$(mktemp -d)
cleanup() {
  [[ -n "${SAMPLER:-}" ]] && kill "$SAMPLER" 2>/dev/null
  "${DOCKER[@]}" rm -f "$NAME" >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT

# Response headers of a HEAD request, CR stripped. Extra curl args pass through.
headers() { curl -sI --max-time 20 "$@" | tr -d '\r'; }
header() { awk -v k="$1" 'BEGIN{IGNORECASE=1} index(tolower($0), tolower(k) ":")==1 {sub(/^[^:]*:[ \t]*/, ""); print}'; }
status() { awk 'NR==1{print $2}'; }

# ------------------------------------------------------------------ start
# --memory-swap equal to --memory: a pod has no swap, so neither may the test.
if ! "${DOCKER[@]}" run --rm -d --name "$NAME" --memory 96m --memory-swap 96m --cpus 0.2 \
     -p "127.0.0.1:$PORT:8080" "$IMAGE" >/dev/null; then
  fail "docker run $IMAGE (is port $PORT free? is the image built?)"
  exit 1
fi
for _ in $(seq 1 50); do
  [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$BASE/")" == 200 ]] && break
  sleep 0.2
done
if [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/")" != 200 ]]; then
  fail "the container never answered 200 on /"
  "${DOCKER[@]}" logs "$NAME" 2>&1 | tail -20
  exit 1
fi
pass "$IMAGE answers on $BASE (96 MiB, no swap, 0.2 CPU)"

in_image() { "${DOCKER[@]}" exec "$NAME" sh -c "$1" 2>/dev/null; }

# ------------------------------------------------------------------ media tier
MP4=$(in_image "find $ROOT/assets/media -name '*.mp4' -type f | head -n 1")
if [[ -z "$MP4" ]]; then
  fail "no .mp4 under /assets/media in the image (the media pipeline has not run?)"
else
  url="${MP4#$ROOT}"
  h=$(headers "$BASE$url")
  cc_count=$(printf '%s\n' "$h" | header cache-control | wc -l)
  cc=$(printf '%s\n' "$h" | header cache-control)
  type=$(printf '%s\n' "$h" | header content-type)
  if [[ "$cc_count" == 1 && "$cc" == *max-age=31536000* && "$cc" == *immutable* ]]; then pass "$url: one Cache-Control ($cc)"
  else fail "$url: expected one immutable Cache-Control, got $cc_count: $(printf '%s' "$cc" | tr '\n' '|')"; fi
  [[ "$type" == video/mp4 ]] && pass "$url: video/mp4" || fail "$url: Content-Type '$type'"
  read -r code size < <(curl -s -o /dev/null -w '%{http_code} %{size_download}\n' --max-time 20 -H 'Range: bytes=0-1023' "$BASE$url")
  [[ "$code" == 206 && "$size" == 1024 ]] && pass "$url: 206 with 1024 bytes for bytes=0-1023" || fail "$url: Range answered $code with $size bytes"
fi

for url in /assets/hero3d.js /assets/arch.assets.json; do
  cc=$(headers "$BASE$url" | header cache-control)
  [[ "$cc" == no-cache ]] && pass "$url: revalidates (no-cache)" || fail "$url: Cache-Control '$cc', expected no-cache (the regex location must win)"
done

cc=$(headers "$BASE/" | header cache-control)
[[ "$cc" == no-cache ]] && pass "/: HTML revalidates" || fail "/: Cache-Control '$cc'"

# ------------------------------------------------------------------ film track
type=$(headers "$BASE/film/chapters.vtt" | header content-type)
[[ "$type" == text/vtt* ]] && pass "/film/chapters.vtt: $type" || fail "/film/chapters.vtt: Content-Type '$type'"
for prefix in /es /pt-br; do
  h=$(headers "$BASE$prefix/film/chapters.vtt")
  if [[ "$(printf '%s\n' "$h" | status)" == 404 ]]; then info "$prefix/film/chapters.vtt not in the image"; continue; fi
  type=$(printf '%s\n' "$h" | header content-type)
  [[ "$type" == text/vtt* ]] && pass "$prefix/film/chapters.vtt: $type" || fail "$prefix/film/chapters.vtt: Content-Type '$type'"
done

# ------------------------------------------------------------------ redirects
for url in /download /download/; do
  h=$(headers "$BASE$url")
  code=$(printf '%s\n' "$h" | status); loc=$(printf '%s\n' "$h" | header location)
  [[ "$code" == 302 && "$loc" == /vr/ ]] && pass "$url: 302 to /vr/" || fail "$url: $code to '$loc'"
done
h=$(headers "$BASE/vr")
code=$(printf '%s\n' "$h" | status); loc=$(printf '%s\n' "$h" | header location)
# Relative: TLS ends at Cloudflare, so an absolute Location would point at http://...:8080.
[[ "$code" == 301 && "$loc" == /vr/ ]] && pass "/vr: relative 301 to /vr/" || fail "/vr: $code to '$loc'"
VR_HTML=$(curl -s --max-time 10 "$BASE/vr/")
[[ -n "$VR_HTML" ]] && pass "/vr/: 200" || fail "/vr/: no page"
PAGE_SHA=$(printf '%s' "$VR_HTML" | grep -o 'data-sha256="[0-9a-f]\{64\}"' | head -n 1 | cut -d'"' -f2)

# ------------------------------------------------------------------ the APK
APK=$(in_image "find $ROOT/download -name '*.apk' -type f 2>/dev/null | head -n 1")
APK_URL=""
if [[ -z "$APK" ]]; then
  info "no APK in the image: /vr/ should be in its coming-soon state"
  if [[ -z "$PAGE_SHA" ]] && ! printf '%s' "$VR_HTML" | grep -q 'href="/download/'; then pass "/vr/: no download link and no data-sha256"
  else fail "/vr/ offers a download although the image has no APK"; fi
else
  APK_URL="${APK#$ROOT}"
  bytes=$(in_image "wc -c < '$APK'" | tr -d ' ')
  h=$(headers -H 'Accept-Encoding: gzip, br' "$BASE$APK_URL")
  type=$(printf '%s\n' "$h" | header content-type)
  disp=$(printf '%s\n' "$h" | header content-disposition)
  cc_count=$(printf '%s\n' "$h" | header cache-control | wc -l)
  cc=$(printf '%s\n' "$h" | header cache-control)
  len=$(printf '%s\n' "$h" | header content-length)
  enc=$(printf '%s\n' "$h" | header content-encoding)
  nosniff=$(printf '%s\n' "$h" | header x-content-type-options)
  saved=$(basename "$APK_URL" | sed -E 's/-[0-9a-f]{8}\.apk$/.apk/')
  [[ "$type" == application/vnd.android.package-archive ]] && pass "$APK_URL: $type" || fail "$APK_URL: Content-Type '$type'"
  [[ "$disp" == "attachment; filename=\"$saved\"" ]] && pass "$APK_URL: $disp" || fail "$APK_URL: Content-Disposition '$disp', expected attachment; filename=\"$saved\""
  [[ "$cc_count" == 1 && "$cc" == *immutable* ]] && pass "$APK_URL: one immutable Cache-Control" || fail "$APK_URL: Cache-Control x$cc_count '$cc'"
  [[ "$nosniff" == nosniff ]] && pass "$APK_URL: nosniff" || fail "$APK_URL: X-Content-Type-Options '$nosniff'"
  [[ -z "$enc" ]] && pass "$APK_URL: not compressed" || fail "$APK_URL: Content-Encoding '$enc'"
  [[ "$len" == "$bytes" ]] && pass "$APK_URL: Content-Length $len = the file" || fail "$APK_URL: Content-Length '$len', the file is $bytes"
  [[ -n "$PAGE_SHA" ]] && pass "/vr/: data-sha256 $PAGE_SHA" || fail "/vr/ carries no data-sha256 although the image has an APK"
  printf '%s' "$VR_HTML" | grep -q "href=\"$APK_URL\"" && pass "/vr/ links $APK_URL" || fail "/vr/ does not link $APK_URL"
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/download/ImplantPlanVR-0.0.0-00000000.apk")
  disp=$(headers "$BASE/download/ImplantPlanVR-0.0.0-00000000.apk" | header content-disposition)
  [[ "$code" == 404 && -z "$disp" ]] && pass "a missing APK is a plain 404 (no attachment, nothing to cache)" || fail "missing APK answered $code with Content-Disposition '$disp'"
fi

# ------------------------------------------------------------------ 404s are never cached
# A hashed URL that does not exist yet (or any more) during a rollout must say no-store, or
# Cloudflare and browsers keep the 404 (docker/landing-nginx.conf, map $immutable_cc).
for miss in /_astro/missing.00000000.css /assets/media/missing.00000000.avif /download/ImplantPlanVR-0.0.0-00000000.apk; do
  h=$(headers "$BASE$miss")
  code=$(printf '%s\n' "$h" | status)
  cc=$(printf '%s\n' "$h" | header cache-control)
  [[ "$code" == 404 && "$cc" == no-store ]] && pass "$miss: 404 with Cache-Control no-store" || fail "$miss: $code with Cache-Control '$cc'"
done

# ------------------------------------------------------------------ load
# Sample memory throughout, not once afterwards: the peak is what an OOM kill sees.
: > "$TMP/mem"
( while true; do "${DOCKER[@]}" stats --no-stream --format '{{.MemUsage}}' "$NAME" 2>/dev/null | cut -d/ -f1 >> "$TMP/mem"; sleep 0.5; done ) &
SAMPLER=$!

DL_PIDS=()
if [[ -n "$APK_URL" ]]; then
  for i in 1 2 3; do
    # Hashed straight off the socket: three copies of a large file must not hit / (the dev
    # box writes to / at ~7 MB/s and a bulk write can starve the k3s node).
    ( curl -s --max-time 600 "$BASE$APK_URL" | sha256sum | cut -d' ' -f1 > "$TMP/apk.$i" ) &
    DL_PIDS+=($!)
  done
fi
# --compressed: gzip contexts per connection are what blew the limit before.
seq 300 | xargs -P20 -I{} curl -s -o /dev/null --compressed --max-time 30 -w '%{http_code}\n' "$BASE/" > "$TMP/codes"
for pid in "${DL_PIDS[@]}"; do wait "$pid"; done
kill "$SAMPLER" 2>/dev/null; wait "$SAMPLER" 2>/dev/null; SAMPLER=""

ok=$(grep -c '^200$' "$TMP/codes")
[[ "$ok" == 300 ]] && pass "load: 300/300 HTML requests answered 200 (20 parallel, gzip)" || fail "load: only $ok/300 HTML requests answered 200"
if [[ -n "$APK_URL" ]]; then
  for i in 1 2 3; do
    got=$(cat "$TMP/apk.$i" 2>/dev/null)
    [[ -n "$PAGE_SHA" && "$got" == "$PAGE_SHA" ]] && pass "load: APK download $i hashes to the page's SHA-256" || fail "load: APK download $i hashed to '$got', the page says '$PAGE_SHA'"
  done
fi

running=$("${DOCKER[@]}" inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)
oom=$("${DOCKER[@]}" inspect -f '{{.State.OOMKilled}}' "$NAME" 2>/dev/null)
if [[ "$running" == true && "$oom" == false ]]; then pass "after load: still running, OOMKilled=false"
else fail "after load: running='$running' OOMKilled='$oom' (with --rm a dead container is already gone)"; fi
"${DOCKER[@]}" stats --no-stream --format '{{.MemUsage}}' "$NAME" 2>/dev/null | cut -d/ -f1 >> "$TMP/mem"

# MemUsage reads like "12.3MiB " or "1.02GiB"; convert to MiB and keep the largest.
peak=$(awk '
  { v=$1; n=v+0; u=v; sub(/^[0-9.]+/, "", u)
    if (u ~ /^GiB/) n*=1024; else if (u ~ /^KiB/) n/=1024; else if (u ~ /^B/) n/=1048576
    if (n>m) m=n }
  END { printf "%.1f", m+0 }' "$TMP/mem")
samples=$(grep -c . "$TMP/mem")
if [[ "$samples" -gt 0 ]] && awk -v p="$peak" -v l="$LIMIT_MIB" 'BEGIN{exit !(p < l)}'; then pass "memory: peak ${peak} MiB over $samples samples, under ${LIMIT_MIB} MiB"
else fail "memory: peak ${peak} MiB over $samples samples (limit ${LIMIT_MIB} MiB)"; fi

echo
if (( failures )); then echo "check_landing_image: $failures check(s) FAILED for $IMAGE"; exit 1; fi
echo "check_landing_image: all checks passed for $IMAGE"

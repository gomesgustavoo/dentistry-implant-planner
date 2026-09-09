#!/usr/bin/env bash
# Composite the raw body, the caption plates and the cards into the deliverables.
#
# ONE filter graph and ONE encode per output. The obvious alternative -- encode the
# title, the body and the end card separately and concat the files -- needs their codec
# parameters to match exactly, and when they silently do not, the concat demuxer produces
# a file that plays for some players and stalls at the join for others. `finish_tour.sh`
# records the same finding.
#
# Plates are placed by the recorder's own `at` seconds, which is the same clock the
# frames were stamped with, so a plate cannot drift off the thing it names. This is why
# `tour_assemble.mjs` must keep holding frames for their measured duration: cap the holds
# and every plate slides.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WORK="${TRAILER_WORK:-/tmp/dentistry-trailer}"
BODY="${1:-$WORK/body-raw.mp4}"
# `marketing/video/`, not `docs/`: these are the committed deliverables the README
# embeds, so a rebuild has to land on the files that are actually published rather than
# beside them. Point TRAILER_OUT somewhere else to try a cut without overwriting one.
OUTDIR="${TRAILER_OUT:-$ROOT/marketing/video}"
# Both films use this script; the beats file and the output stem name which one.
BEATS="${TRAILER_BEATS:-$WORK/trailer-beats.json}"
STEM="${TRAILER_STEM:-implantplan-plan}"

TITLE_S="${TRAILER_TITLE_S:-3.5}"
# 7s, not 5.5: the card now carries two asks, an address and an email, and 5.5 was
# already tight for a wordmark and a host.
END_S="${TRAILER_END_S:-7.0}"
FADE="${TRAILER_FADE:-0.5}"
PLATE_FADE="${TRAILER_PLATE_FADE:-0.35}"
FPS="${TOUR_OUT_FPS:-30}"
W=1920; H=1080

mkdir -p "$OUTDIR"
[ -f "$BODY" ] || { echo "no body at $BODY -- run scripts/record_trailer.sh first"; exit 1; }
[ -f "$BEATS" ] || { echo "no beats at $BEATS"; exit 1; }
[ -f "$WORK/title.png" ] || { echo "no cards -- run scripts/trailer_overlays.py first"; exit 1; }

BODY_S=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$BODY")
echo "body ${BODY_S}s + title ${TITLE_S}s + end ${END_S}s"

# --------------------------------------------------------------- 1. plates onto body
# Each plate is a full-frame transparent PNG shown between its own beat and the next.
# `enable=` gates it and an alpha fade takes the edges off, so nothing pops.
mapfile -t PLATE_ARGS < <(./venv/bin/python - "$BEATS" "$WORK" "$BODY_S" "$PLATE_FADE" <<'PY'
import json, sys, pathlib
beats = json.loads(pathlib.Path(sys.argv[1]).read_text())["beats"]
work, dur, fade = pathlib.Path(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4])
shown = [(i, b) for i, b in enumerate(beats) if b.get("headline")]
inputs, filters, last = [], [], "0:v"
for n, (i, b) in enumerate(shown):
    png = work / f"plate{i:02d}.png"
    if not png.exists():
        continue
    start = float(b["at"])
    # A plate runs until the next beat, minus a breath. The last one runs to the end of
    # the body rather than to a guessed duration.
    end = float(beats[i + 1]["at"]) - 0.2 if i + 1 < len(beats) else dur
    if end - start < 1.2:
        continue
    idx = len(inputs) + 1
    # The plate input is FINITE. `-loop 1 -i png` with no `-t` is an endless stream, and
    # an overlay chain whose second inputs never end does not stop when the body does --
    # it kept generating frames for seventeen hours and 1.3 GB before anyone looked.
    # Each plate now lasts exactly as long as it is shown.
    inputs.append(f"{end - start + 0.1:.2f};{png}")
    filters.append(
        f"[{idx}:v]format=rgba,fade=t=in:st=0:d={fade}:alpha=1,"
        f"fade=t=out:st={max(0.0, end - start - fade):.2f}:d={fade}:alpha=1,"
        f"setpts=PTS-STARTPTS+{start:.2f}/TB[p{n}];"
        f"[{last}][p{n}]overlay=0:0:enable='between(t,{start:.2f},{end:.2f})'[o{n}]"
    )
    last = f"o{n}"
print("\n".join(inputs))
print("---")
print(";".join(filters) if filters else "")
print("---")
print(last)
PY
)

SPLIT=0
IN_ARGS=(); FILTER=""; LASTLABEL="0:v"
# COUNTED, not inferred from the array length. `IN_ARGS+=(-loop 1 -i path)` appends FOUR
# elements per plate, so dividing the array by 3 named an ffmpeg input that does not
# exist -- at twelve plates it asked for input 17 of 13. Keeping a plain counter removes
# the arithmetic that was wrong rather than correcting it.
NPLATES=0
for line in "${PLATE_ARGS[@]}"; do
  if [ "$line" = "---" ]; then SPLIT=$((SPLIT + 1)); continue; fi
  case $SPLIT in
    0) if [ -n "$line" ]; then
         # "<seconds>;<path>" -- `-t` makes the looped still finite, `-framerate` makes
         # it arrive at the timeline's rate instead of the image default of 25.
         IN_ARGS+=(-loop 1 -framerate "$FPS" -t "${line%%;*}" -i "${line#*;}")
         NPLATES=$((NPLATES + 1))
       fi ;;
    1) FILTER="$line" ;;
    2) LASTLABEL="$line" ;;
  esac
done

echo "== plates: $NPLATES"
# The corner bug rides over everything for the whole body -- one persistent mark rather
# than a plate that comes and goes. Input 0 is the body, 1..N are the plates, so the bug
# is N+1.
BUGIDX=$(( NPLATES + 1 ))
IN_ARGS+=(-loop 1 -framerate "$FPS" -t "$BODY_S" -i "$WORK/bug.png")
[ -n "$FILTER" ] && FILTER="$FILTER;"
FILTER="${FILTER}[${LASTLABEL}][${BUGIDX}:v]overlay=0:0:format=auto[withbug]"

# `-t "$BODY_S"` on the OUTPUT is a hard ceiling, and it is here because the soft one
# failed: this pass has no business producing a frame past the end of the body, and when
# an endless input made it try, nothing stopped it. A wrong filter graph should now cost
# a wrong 101-second file, not an unbounded one.
# `medium`/CRF 16 rather than `slow`/19 because this file is an INTERMEDIATE -- step 2
# re-encodes it, so the cheap thing to spend here is bitrate and the expensive thing is
# time, and twelve full-frame alpha overlays are already the slow part.
ffmpeg -y -loglevel error -i "$BODY" "${IN_ARGS[@]}" \
  -filter_complex "$FILTER" -map "[withbug]" \
  -t "$BODY_S" \
  -c:v libx264 -preset medium -crf 16 -pix_fmt yuv420p -movflags +faststart \
  -an "$WORK/body-plated.mp4"
echo "   -> body-plated.mp4 ($(du -h "$WORK/body-plated.mp4" | cut -f1))"

# ------------------------------------------------------- 2. cards, one graph, one encode
# NO FADE-IN ON THE TITLE. Frame 0 is the poster frame every player and every embed shows
# before anyone presses play, and a half-second fade from black makes that frame black.
# The card is the README's banner, so the film's thumbnail is now the same image the page
# leads with. The fade OUT stays; it is the cut into the body.
OUT_ST=$(./venv/bin/python -c "print(max(0.0, $BODY_S - $FADE))")
ffmpeg -y -loglevel error \
  -loop 1 -t "$TITLE_S" -i "$WORK/title.png" \
  -i "$WORK/body-plated.mp4" \
  -loop 1 -t "$END_S"   -i "$WORK/end.png" \
  -filter_complex "
    [0:v]scale=${W}:${H},fps=${FPS},format=yuv420p,
         fade=t=out:st=$(./venv/bin/python -c "print($TITLE_S-$FADE)"):d=${FADE}[t];
    [1:v]scale=${W}:${H},fps=${FPS},format=yuv420p,
         fade=t=in:st=0:d=${FADE},fade=t=out:st=${OUT_ST}:d=${FADE}[b];
    [2:v]scale=${W}:${H},fps=${FPS},format=yuv420p,
         fade=t=in:st=0:d=${FADE},fade=t=out:st=$(./venv/bin/python -c "print($END_S-$FADE)"):d=${FADE}[e];
    [t][b][e]concat=n=3:v=1:a=0[v]
  " -map "[v]" \
  -c:v libx264 -preset slow -crf 19 -pix_fmt yuv420p -movflags +faststart \
  -an "$OUTDIR/$STEM.mp4"
echo "   -> $OUTDIR/$STEM.mp4"

# ----------------------------------------------------------------- 3. social versions
# PLACED, not cropped. Cropping 1920x1080 to 9:16 gives 608x1080 upscaled 1.78x, which is
# visibly soft on readouts that were already small. Here the master is scaled once to
# 1080 wide -- its native aspect -- and dropped into a branded frame.
social() {  # social <frame.png> <W> <H> <slot-y> <out>
  local frame="$1" w="$2" h="$3" y="$4" out="$5"
  ffmpeg -y -loglevel error \
    -loop 1 -i "$frame" -i "$OUTDIR/$STEM.mp4" \
    -filter_complex "
      [1:v]scale=${w}:-2,fps=${FPS}[v];
      [0:v]scale=${w}:${h},format=yuv420p[bg];
      [bg][v]overlay=0:${y}:shortest=1,format=yuv420p[o]
    " -map "[o]" \
    -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart \
    -an "$out"
  echo "   -> $out"
}
social "$WORK/frame_9x16.png" 1080 1920 656 "$OUTDIR/$STEM-9x16.mp4"
social "$WORK/frame_4x5.png"  1080 1350 371 "$OUTDIR/$STEM-4x5.mp4"

echo
for f in "$OUTDIR"/"$STEM"*.mp4; do
  printf '%-46s %s  %ss\n' "$(basename "$f")" \
    "$(ffprobe -v error -select_streams v -show_entries stream=width,height -of csv=p=0 "$f")" \
    "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f" | cut -c1-5)"
done

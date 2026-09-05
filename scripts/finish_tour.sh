#!/usr/bin/env bash
# The finished cut: title card + captioned tour + end card -> docs/tour.mp4
#
#   scripts/record_tour.sh    raw capture + beats.json     (drives the real app)
#   scripts/caption_tour.sh   burns the captions           (via an ASS subtitle file)
#   scripts/finish_tour.sh    this: cards, fades, one encode
#
# Everything is normalised through ONE filter graph and encoded once. The obvious
# alternative -- encode three clips and concat the files -- needs their codec parameters
# to match exactly, and when they silently do not, the concat demuxer produces a file that
# plays for some players and stalls at the join for others.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BODY="${1:-$ROOT/docs/tour-body.mp4}"      # the captioned tour
WORK="${TOUR_WORK:-/tmp/dentistry-tour}"
OUT="${2:-$ROOT/docs/tour.mp4}"
TITLE_S="${TOUR_TITLE_S:-3.0}"
END_S="${TOUR_END_S:-4.0}"
FADE="${TOUR_FADE:-0.5}"

[ -f "$BODY" ] || { echo "no captioned body at $BODY"; exit 1; }

W="$(ffprobe -v error -select_streams v:0 -show_entries stream=width  -of csv=p=0 "$BODY")"
H="$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$BODY")"
DUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$BODY")"
FPS="${TOUR_OUT_FPS:-30}"

./venv/bin/python scripts/tour_cards.py --out "$WORK" --width "$W" --height "$H" >/dev/null
echo "cards at ${W}x${H}; body ${DUR}s"

# The body fades in from the title and out to the end card, so the joins are transitions
# rather than cuts. `fade=out:st=` needs an absolute time, hence the arithmetic.
OUT_ST="$(python3 -c "print(max(0, $DUR - $FADE))")"

ffmpeg -y -loglevel error \
  -loop 1 -t "$TITLE_S" -i "$WORK/title.png" \
  -i "$BODY" \
  -loop 1 -t "$END_S"   -i "$WORK/end.png" \
  -filter_complex "
    [0:v]scale=${W}:${H},fps=${FPS},format=yuv420p,
         fade=t=in:st=0:d=${FADE},fade=t=out:st=$(python3 -c "print($TITLE_S-$FADE)"):d=${FADE}[t];
    [1:v]scale=${W}:${H},fps=${FPS},format=yuv420p,
         fade=t=in:st=0:d=${FADE},fade=t=out:st=${OUT_ST}:d=${FADE}[b];
    [2:v]scale=${W}:${H},fps=${FPS},format=yuv420p,
         fade=t=in:st=0:d=${FADE},fade=t=out:st=$(python3 -c "print($END_S-$FADE)"):d=${FADE}[e];
    [t][b][e]concat=n=3:v=1:a=0[v]
  " -map "[v]" \
  -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart \
  -an "$OUT"

ls -lh "$OUT"
ffprobe -v error -show_entries format=duration:stream=width,height,r_frame_rate \
  -of default=nw=1 "$OUT"

#!/usr/bin/env bash
# Assemble the LinkedIn cut: frame, then the body INSET into it, then plates on top.
#
# WHY THIS IS NOT A FLAG ON build_trailer.sh. That script composites plates onto a
# 1920-wide body and scales the result into the social frame afterwards, so a 56 px
# headline arrives as 31 px and the app's own 11 px readouts arrive as 6. On a phone that
# is not small type, it is no type. Here the order inverts -- frame first, footage placed
# into its slot at native size, captions typeset at the FINAL canvas scale and never
# resampled. Nothing is scaled after it is set.
#
# ONE FILTER GRAPH AND ONE ENCODE PER OUTPUT, which is build_trailer.sh's rule and its
# reasoning carries over: encoding the title, the body and the end card separately and
# concatenating the files needs their codec parameters to match exactly, and when they
# silently do not the concat demuxer produces something that plays for some players and
# stalls at the join for others.
#
# The FOOTAGE IS NEVER RE-TINTED. Not with eq, not with colorbalance, not with an overlay
# across the slot. The verdict chips inside it are what make_landing_loop.sh and
# verify_social.sh read back by hue, so a grade applied here would break every downstream
# assertion -- and it would also be restyling the app for a film, which marketing/README.md
# forbids outright.
#
#   scripts/build_social.sh [body-raw.mp4]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WORK="${SOCIAL_WORK:-/tmp/dentistry-social}"
BODY="${1:-/tmp/dentistry-trailer/body-raw.mp4}"
BEATS="${SOCIAL_BEATS:-/tmp/dentistry-trailer/trailer-beats.json}"
PLATES="${SOCIAL_PLATES:-$WORK/plates}"
OUTDIR="${SOCIAL_OUT:-$ROOT/marketing/video}"
STEM="${SOCIAL_STEM:-implantplan-linkedin}"
ASPECTS="${SOCIAL_ASPECTS:-4x5 9x16}"

TITLE_S="${SOCIAL_TITLE_S:-1.2}"     # 1.2, not build_trailer's 3.5: on a muted autoplay
                                     # feed a static card is the whole attention budget.
END_S="${SOCIAL_END_S:-6.0}"
FADE="${SOCIAL_FADE:-0.4}"
PLATE_FADE="${SOCIAL_PLATE_FADE:-0.3}"
FPS=30
SLOT_H=608

[ -f "$BODY" ]  || { echo "no body at $BODY"; exit 1; }
[ -f "$BEATS" ] || { echo "no beats at $BEATS"; exit 1; }
mkdir -p "$OUTDIR" "$WORK"

# --------------------------------------------------------------- 1. plan the cut
# The 92 s master is paced for a README. This selects from it and re-times the beats onto
# the new timeline; `cut_social.py` owns both, so the plates and the footage cannot
# disagree about when a caption is due.
./venv/bin/python scripts/cut_social.py --beats "$BEATS" --out "$WORK/social-beats.json" \
  --title-s "$TITLE_S" > "$WORK/cut.txt"
cat "$WORK/cut.txt"

# Plates are typeset from the CUT's beats, so a plate exists for exactly the beats that
# survived and carries the index build_social.sh will look it up by.
if [ "${SOCIAL_SKIP_PLATES:-0}" != "1" ]; then
  ./venv/bin/python scripts/social_overlays.py --beats "$WORK/social-beats.json" \
    --out "$PLATES" --aspects "$(echo "$ASPECTS" | tr ' ' ',')"
fi

mapfile -t SEGMENTS < <(./venv/bin/python -c "
import json,sys
d=json.load(open('$WORK/social-beats.json'))
for s in d['segments']: print(f\"{s['start']:.3f};{s['duration']:.3f}\")
")
BODY_S=$(./venv/bin/python -c "
import json; print(f\"{json.load(open('$WORK/social-beats.json'))['body_seconds']:.3f}\")")
TOTAL_S=$(./venv/bin/python -c "print(f\"{$BODY_S + $TITLE_S + $END_S:.2f}\")")
echo "body ${BODY_S}s + title ${TITLE_S}s + end ${END_S}s = ${TOTAL_S}s"

# --------------------------------------------------------------- 2. one graph per aspect
for ASPECT in $ASPECTS; do
  P="$PLATES/$ASPECT"
  [ -d "$P" ] || { echo "no plates at $P -- run scripts/social_overlays.py first"; exit 1; }
  case "$ASPECT" in
    4x5)  W=1080; H=1350; SLOT_Y=190 ;;
    9x16) W=1080; H=1920; SLOT_Y=560 ;;
    *) echo "unknown aspect $ASPECT"; exit 2 ;;
  esac

  IN=(); FILT=""; CAT=""; I=0
  for seg in "${SEGMENTS[@]}"; do
    IFS=';' read -r ss dd <<<"$seg"
    IN+=(-ss "$ss" -t "$dd" -i "$BODY")
    FILT+="[${I}:v]scale=${W}:-2,setsar=1,fps=${FPS}[b${I}];"
    CAT+="[b${I}]"
    I=$((I + 1))
  done
  NSEG=$I
  FILT+="${CAT}concat=n=${NSEG}:v=1:a=0[body];"

  # The frame is a FINITE input. `-loop 1 -i png` with no `-t` is an endless stream, and
  # an overlay chain whose second input never ends does not stop when the first does --
  # build_trailer.sh's header records seventeen hours and 1.3 GB of exactly that.
  IN+=(-loop 1 -framerate "$FPS" -t "$BODY_S" -i "$P/frame.png"); FRAME=$I; I=$((I + 1))
  FILT+="[${FRAME}:v]fps=${FPS}[bg];[bg][body]overlay=0:${SLOT_Y}:format=auto[stage0];"

  LAST="stage0"; N=0
  while IFS=';' read -r idx start end; do
    [ -z "$idx" ] && continue
    png="$P/plate$(printf '%02d' "$idx").png"
    [ -f "$png" ] || continue
    dur=$(./venv/bin/python -c "print(f'{$end - $start + 0.1:.2f}')")
    # `-framerate` so the still arrives at the timeline's rate rather than image2's 25.
    IN+=(-loop 1 -framerate "$FPS" -t "$dur" -i "$png")
    # `setpts=PTS-STARTPTS+start/TB` is load-bearing and it is the bug this cost once:
    # without it the plate's own clock starts at 0, its fade-out has already run to alpha
    # zero long before `enable` opens, and overlay's eof_action=repeat then repeats that
    # TRANSPARENT last frame forever. The caption simply never appears, and nothing in the
    # graph errors. Delaying the stream to its start time puts the fades where the enable
    # window is. Same line build_trailer.sh carries, for the same reason.
    FILT+="[${I}:v]format=rgba,fade=t=in:st=0:d=${PLATE_FADE}:alpha=1,"
    FILT+="fade=t=out:st=$(./venv/bin/python -c "print(f'{max(0.0, $end - $start - $PLATE_FADE):.2f}')"):d=${PLATE_FADE}:alpha=1,"
    FILT+="setpts=PTS-STARTPTS+${start}/TB[pl${N}];"
    FILT+="[${LAST}][pl${N}]overlay=0:0:enable='between(t,${start},${end})'[st${N}];"
    LAST="st${N}"
    N=$((N + 1)); I=$((I + 1))
  done < <(./venv/bin/python -c "
import json
d=json.load(open('$WORK/social-beats.json'))
for b in d['beats']:
    if b.get('headline'): print(f\"{b['index']};{b['plate_start']:.3f};{b['plate_end']:.3f}\")
")

  # Title and end. NO FADE-IN ON THE TITLE: frame 0 is the poster every player shows
  # before anyone presses play, and a half-second fade from black makes that frame black.
  IN+=(-loop 1 -framerate "$FPS" -t "$TITLE_S" -i "$P/title.png"); TI=$I; I=$((I + 1))
  IN+=(-loop 1 -framerate "$FPS" -t "$END_S" -i "$P/end.png");     EI=$I; I=$((I + 1))
  FILT+="[${TI}:v]fps=${FPS},fade=t=out:st=$(./venv/bin/python -c "print(f'{$TITLE_S - $FADE:.2f}')"):d=${FADE}[title];"
  FILT+="[${EI}:v]fps=${FPS},fade=t=in:st=0:d=${FADE}[endc];"
  FILT+="[${LAST}]fade=t=in:st=0:d=${FADE},fade=t=out:st=$(./venv/bin/python -c "print(f'{$BODY_S - $FADE:.2f}')"):d=${FADE}[bodyf];"
  FILT+="[title][bodyf][endc]concat=n=3:v=1:a=0[out]"

  OUT="$OUTDIR/${STEM}-${ASPECT}.mp4"
  echo "== $ASPECT -> $(basename "$OUT")  (${NSEG} segments, ${N} plates)"
  ffmpeg -v error -y "${IN[@]}" \
    -f lavfi -t "$TOTAL_S" -i anullsrc=r=48000:cl=stereo \
    -filter_complex "$FILT" -map "[out]" -map "${I}:a" \
    -c:v libx264 -profile:v high -level 4.0 -pix_fmt yuv420p \
    -crf 18 -maxrate 8M -bufsize 16M -preset slow \
    -g 60 -keyint_min 60 -sc_threshold 0 \
    -color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv \
    -c:a aac -b:a 64k -shortest \
    -t "$TOTAL_S" -movflags +faststart "$OUT"

  ffprobe -v error -show_entries format=duration,size -show_entries stream=width,height,r_frame_rate,codec_name \
    -of default=nw=1 "$OUT" | tr '\n' ' '; echo
done

# The thumbnail LinkedIn lets you upload by hand. Frame 0 is already the title card, so
# this is the same image rather than a second design.
ffmpeg -v error -y -i "$OUTDIR/${STEM}-4x5.mp4" -frames:v 1 -q:v 2 "$OUTDIR/${STEM}-thumb.jpg"
echo "wrote $(basename "$OUTDIR")/${STEM}-thumb.jpg"

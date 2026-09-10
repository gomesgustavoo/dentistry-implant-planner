#!/usr/bin/env bash
# Prove the delivered LinkedIn cut shows what its captions claim.
#
# A file listing cannot see that a window slid onto the wrong beat, and `grep -c` cannot
# see that a numeral was typed rather than scraped. Both have happened here: a still called
# `verdict-breach.jpg` once shipped showing a CLEAR verdict at 4.43 mm, and a hand-typed
# 0.8887 reached a delivered film while the app said 0.8965. So every claim is read back
# out of the rendered file or out of the beats JSON the recorder wrote.
#
#   scripts/verify_social.sh [stem]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STEM="${1:-implantplan-linkedin}"
WORK="${SOCIAL_WORK:-/tmp/dentistry-social}"
BEATS="$WORK/social-beats.json"
SRC_BEATS="${SOCIAL_BEATS:-/tmp/dentistry-trailer/trailer-beats.json}"
VIDEO_DIR="${SOCIAL_OUT:-$ROOT/marketing/video}"

[ -f "$BEATS" ] || { echo "no cut plan at $BEATS -- run scripts/build_social.sh"; exit 1; }

FAIL=0
say() { if [ "$1" = 1 ]; then echo "ok   $2"; else echo "FAIL $2"; FAIL=$((FAIL+1)); fi; }

# ------------------------------------------------------------------ 1. the container
for ASPECT in 4x5 9x16; do
  F="$VIDEO_DIR/${STEM}-${ASPECT}.mp4"
  if [ ! -f "$F" ]; then say 0 "$ASPECT: missing"; continue; fi
  # One field per call. A combined `-show_entries stream=width,height,...,profile` does
  # NOT return them in the order asked -- profile came back first and the whole report
  # then compared the wrong things while looking like it worked.
  pv() { ffprobe -v error -select_streams v:0 -show_entries "stream=$1" -of csv=p=0 "$F"; }
  pf() { ffprobe -v error -show_entries "format=$1" -of csv=p=0 "$F"; }
  W=$(pv width); H=$(pv height); FPS=$(pv r_frame_rate); PIX=$(pv pix_fmt)
  PROF=$(pv profile); DUR=$(pf duration); SIZE=$(pf size)
  case "$ASPECT" in 4x5) WANT="1080 1350";; 9x16) WANT="1080 1920";; esac
  say "$([ "$W $H" = "$WANT" ] && echo 1 || echo 0)" "$ASPECT geometry ${W}x${H} (want ${WANT// /x})"
  say "$([ "$FPS" = "30/1" ] && echo 1 || echo 0)" "$ASPECT is ${FPS} fps"
  say "$([ "$PIX" = "yuv420p" ] && echo 1 || echo 0)" "$ASPECT pixel format $PIX, profile $PROF"
  IN_RANGE=$(./venv/bin/python -c "print(1 if 60 <= $DUR <= 75 else 0)")
  say "$IN_RANGE" "$ASPECT duration $(printf '%.1f' "$DUR")s is inside 60-75s"
  MB=$(./venv/bin/python -c "print(f'{$SIZE/1048576:.1f}')")
  say 1 "$ASPECT size ${MB} MB"
  # A stream with no audio track at all is the input that historically makes social
  # players report a processing failure and drop the mute control. Silence is insurance.
  NA=$(ffprobe -v error -select_streams a -show_entries stream=codec_name -of csv=p=0 "$F" | head -1)
  say "$([ -n "$NA" ] && echo 1 || echo 0)" "$ASPECT carries a (silent) $NA track"
  # faststart: the moov atom has to precede mdat or the first frame waits for the file.
  MOOV=$(./venv/bin/python - "$F" <<'PY'
import struct, sys
f = open(sys.argv[1], 'rb'); order = []
while True:
    hdr = f.read(8)
    if len(hdr) < 8: break
    size, typ = struct.unpack('>I4s', hdr)
    order.append(typ.decode('latin1'))
    if size == 1: size = struct.unpack('>Q', f.read(8))[0] - 8
    elif size < 8: break
    else: size -= 8
    f.seek(size, 1)
print('yes' if 'moov' in order and order.index('moov') < order.index('mdat') else 'no')
PY
)
  say "$([ "$MOOV" = yes ] && echo 1 || echo 0)" "$ASPECT moov atom precedes mdat (faststart)"
done

# ------------------------------------------- 2. frame 0 is the poster, and it is not black
for ASPECT in 4x5 9x16; do
  F="$VIDEO_DIR/${STEM}-${ASPECT}.mp4"
  [ -f "$F" ] || continue
  L=$(./venv/bin/python - "$F" <<'PY'
import subprocess, sys, tempfile, pathlib
from PIL import Image
with tempfile.TemporaryDirectory() as td:
    p = pathlib.Path(td) / "f0.png"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", sys.argv[1], "-frames:v", "1", str(p)], check=True)
    im = Image.open(p).convert("L")
    print(int(sum(im.getdata()) / (im.width * im.height)))
PY
)
  # build_social.sh gives the title card no fade-in precisely so this holds. A player
  # shows frame 0 before anyone presses play, and `poster` is not always honoured.
  say "$([ "$L" -gt 180 ] && echo 1 || echo 0)" "$ASPECT frame 0 mean luminance $L (a light card, not black)"
done

# ------------------------------------------------ 3. the verdicts, read back by hue
./venv/bin/python - "$VIDEO_DIR/${STEM}-4x5.mp4" "$BEATS" <<'PY' || FAIL=$((FAIL+1))
import colorsys, json, subprocess, sys, tempfile, pathlib
from PIL import Image

video, beats_path = sys.argv[1], sys.argv[2]
plan = json.loads(pathlib.Path(beats_path).read_text())
windows = plan.get("verdict_windows") or []

# The app inset is placed at (0, SLOT_Y) at 1080x608 in the 4:5 frame, and the nerve-canal
# chip sits at these fractions of the app's own frame -- the same box make_stills.sh uses.
SLOT_Y, SLOT_W, SLOT_H = 190, 1080, 608
BOX = (0.762, 0.222, 0.815, 0.246)
# Measured off the 1920x1080 master. Matched NEAREST rather than by an absolute band: the
# chip is 57 px wide here and 4:2:0 bleeds its chroma, so breach reads ~339 deg on the
# master and single digits after the re-encode. What discriminates a slid window is which
# verdict the hue is closest to, and the three nominals are 60-160 deg apart.
NOMINAL = {"TIGHT": 41.5, "BREACH": 339.2, "CLEAR": 163.6}


def circ(a, b):
    d = abs(a - b) % 360
    return min(d, 360 - d)


def hue(img):
    x0, x1 = int(BOX[0] * SLOT_W), int(BOX[2] * SLOT_W)
    y0, y1 = SLOT_Y + int(BOX[1] * SLOT_H), SLOT_Y + int(BOX[3] * SLOT_H)
    px = img.crop((x0, y0, x1, y1)).convert("RGB")
    data = px.get_flattened_data() if hasattr(px, "get_flattened_data") else px.getdata()
    hs = []
    for r, g, b in data:
        h, l, sat = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
        if sat > 0.35 and 0.2 < l < 0.85:
            hs.append(h * 360)
    hs.sort()
    return hs[len(hs) // 2] if hs else None


if len(windows) < 3:
    print("FAIL the cut plan carries no verdict windows to check")
    sys.exit(1)

fail = 0
with tempfile.TemporaryDirectory() as td:
    for w in windows:
        f = pathlib.Path(td) / (w["verdict"] + ".png")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(w["sample"]), "-i", video,
                        "-frames:v", "1", str(f)], check=True)
        g = hue(Image.open(f))
        if g is None:
            print("FAIL %s: no saturated pixels in the chip box at %ss"
                  % (w["verdict"], w["sample"]))
            fail += 1
            continue
        d = sorted(((k, circ(g, v)) for k, v in NOMINAL.items()), key=lambda x: x[1])
        ok = d[0][0] == w["verdict"] and (d[1][1] - d[0][1]) >= 5
        print("%s%-6s at %5.1fs reads %5.1f deg -> %s by %.0f deg over %s (plate %s says %s)"
              % ("ok   " if ok else "FAIL ", w["verdict"], w["sample"], g, d[0][0],
                 d[1][1] - d[0][1], d[1][0], w["plate"], w["numeral"]))
        fail += 0 if ok else 1
sys.exit(1 if fail else 0)
PY

# ------------------------------------ 4. no numeral on a plate that was not scraped
./venv/bin/python - "$BEATS" "$SRC_BEATS" <<'PY' || FAIL=$((FAIL+1))
import json, pathlib, re, sys
cut = json.loads(pathlib.Path(sys.argv[1]).read_text())
src = json.loads(pathlib.Path(sys.argv[2]).read_text())
scraped = {(b.get("numeral") or "").strip() for b in src["beats"]} - {""}
bad = []
for b in cut["beats"]:
    n = (b.get("numeral") or "").strip()
    if not n:
        continue
    if n not in scraped:
        bad.append((b["index"], n))
    if not re.fullmatch(r"\d+\.\d{2} mm", n):
        bad.append((b["index"], n + " (malformed)"))
    # A figure inside the HEADLINE would bypass the scrape entirely.
    if re.search(r"\d+\.\d+", b["headline"]):
        bad.append((b["index"], "a bare figure in the headline: " + b["headline"][:40]))
for i, n in bad:
    print(f"FAIL plate {i}: {n}")
print(f"ok   every numeral on a plate was scraped from the app "
      f"({len([b for b in cut['beats'] if b.get('numeral')])} of them)" if not bad else "")
sys.exit(1 if bad else 0)
PY

# ----------------------------------------------- 5. the type is big enough to read
./venv/bin/python - "$WORK/plates/4x5" <<'PY' || FAIL=$((FAIL+1))
import pathlib, sys
from PIL import Image
d = pathlib.Path(sys.argv[1])
worst = (None, 1e9)
for p in sorted(d.glob("plate*.png")):
    a = Image.open(p).split()[-1]
    rows = [y for y in range(a.height)
            if any(a.getpixel((x, y)) > 40 for x in range(0, a.width, 6))]
    if not rows:
        print(f"FAIL {p.name} is empty")
        sys.exit(1)
    # The headline band: everything below the eyebrow, above the numeral. Crudely, the
    # tallest run of consecutive inked rows.
    runs, cur = [], [rows[0]]
    for y in rows[1:]:
        (cur.append(y) if y - cur[-1] <= 3 else (runs.append(cur), cur := [y]))
    runs.append(cur)
    tallest = max(len(r) for r in runs)
    if tallest < worst[1]:
        worst = (p.name, tallest)
ok = worst[1] >= 40
print(f"{'ok   ' if ok else 'FAIL '}smallest inked band across the plates is {worst[1]} px "
      f"({worst[0]}); want >= 40 px in a 1080-wide canvas")
sys.exit(0 if ok else 1)
PY

echo
if [ "$FAIL" -gt 0 ]; then echo "$FAIL failing check(s)"; exit 1; fi
echo "the delivered cut shows what it claims"

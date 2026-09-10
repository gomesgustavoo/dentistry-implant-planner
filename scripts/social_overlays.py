#!/usr/bin/env python3
"""Light-frame overlays for the social cut: frame, caption plates, title and end cards.

## Why a sibling and not a --theme flag on trailer_overlays.py

`trailer_overlays.py` builds a 16:9 film whose captions sit ON the footage, in the bottom
third, over a scrim -- because there is nowhere else for them to be. This cut is a
different composition, not a different colour scheme: the footage is PLACED in a slot and
the caption block lives on paper beneath it, where it never touches a frame of CBCT. A
theme flag would leave two disjoint layout paths in one file pretending to be one.

What IS shared is imported: the @font-face declarations, the token loading (platform.css
plus exactly one band file, in that order), the Chrome rasteriser, and every line of copy
on the end card. So the two films cannot disagree about the terms of the trial or about
what the licence requires on screen.

## Why the frame is light

The app is dark and `marketing/README.md` forbids restyling it for a film -- "nothing here
is a mock-up... or a frame anyone touched up by hand". So the film contains a dark slab
either way, and the only question is what surrounds it. A light surround makes that slab
the only dark thing on screen, which puts the eye on the product for free; a dark surround
camouflages it. LinkedIn's feed is off-white, so the card bleeds into the column and the
inset becomes the figure. It matches the landing page's decision for the same reason.

It also deletes the scrim. `trailer_overlays.py` needs one because a caption sitting on a
greyscale CBCT has black air and white enamel inside the same frame. Here the caption is
on paper, so the type runs at full contrast with no compromise.

## The contrast trap, measured

`--ds-accent` #8b5cf6 sits at luminance 0.199 and measures 4.22:1 on white: it FAILS AA
for normal text. So on this frame it is the rule and the fills, the 88px numeral takes it
as large text (>= 3:1), and the 22px mono eyebrow takes #6d28d9 (~6:1). Same trap
band-implantplan.css documents for the dark ground, biting harder on paper.

Run it on the CUT's beats file, not the recorder's: `cut_social.py` re-times the beats
onto the delivered timeline, drops the ones whose footage was cut, and adds the cold open.

    ./venv/bin/python scripts/cut_social.py --beats /tmp/dentistry-trailer/trailer-beats.json \\
                                            --out /tmp/dentistry-social/social-beats.json
    ./venv/bin/python scripts/social_overlays.py --beats /tmp/dentistry-social/social-beats.json \\
                                                 --out /tmp/dentistry-social/plates
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from trailer_overlays import (  # noqa: E402
    BRAND, CONTACT, CUSTOM_ASK, LEGAL, TRIAL_HEAD, TRIAL_TERMS, head, shoot,
)

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORDMARK = BRAND / "raster/implantplan/wordmark-light.png"
HOST = "dentistry.dicomsegvr.com"

# ---------------------------------------------------------------- the light palette
# Only the tokens this cut uses are overridden; the accent band is left alone so the
# single-accent rule still holds. Every value here is measured against #ffffff.
LIGHT = """
:root{
  --ds-ground:#ffffff; --ds-bg-elev:#f7f8fa; --ds-surface:#f1f3f6;
  --ds-border:#e2e6ec; --ds-hairline:rgba(10,14,19,.07);
  --ds-ink:#0a0e13;        /* 18.4:1 */
  --ds-ink-dim:#2b3442;
  --ds-muted:#4b5768;      /* 7.6:1  */
  --ds-faint:#7b8798;
  --ds-accent-text:#6d28d9;/* 6.0:1 — the AA-safe violet on paper */
}
"""

# Two geometries, one layout. The 16:9 master is PLACED at full width in both -- never
# cropped and never upscaled -- and everything else is measured from the slot.
GEOM = {
    "4x5":  dict(w=1080, h=1350, slot_y=190, mark_y=64, mark_h=34,
                 cap_y=846, head_px=56, num_px=76, eyebrow_px=22),
    "9x16": dict(w=1080, h=1920, slot_y=560, mark_y=120, mark_h=38,
                 cap_y=1252, head_px=62, num_px=84, eyebrow_px=24),
}
SLOT_H = 608          # 1080 x 608 is 1920x1080 placed at full width
MARGIN = 72


def geom(aspect: str) -> dict:
    g = dict(GEOM[aspect])
    g["slot_h"] = SLOT_H
    return g


# ------------------------------------------------------------------ caption plates
def plate_css(g: dict) -> str:
    return f"""
{LIGHT}
.cap{{position:absolute;left:{MARGIN}px;right:{MARGIN}px;top:{g['cap_y']}px;
  display:flex;flex-direction:column;align-items:flex-start;gap:16px}}
/* LEFT ALIGNED, not centred. A centred caption re-centres itself on every
   line-length change, so a twelve-beat sequence shimmers horizontally. A fixed
   left margin holds still and lets the eye stay where the last one ended. */
.rule{{width:64px;height:3px;background:var(--ds-accent);border-radius:2px}}
.eyebrow{{font-family:'Archivo';font-stretch:var(--ds-narrow,78%);
  font-size:{g['eyebrow_px']}px;font-weight:600;letter-spacing:.18em;
  text-transform:uppercase;color:var(--ds-accent-text)}}
.head{{font-family:'Archivo';font-stretch:var(--ds-wide,116%);font-weight:700;
  font-size:{g['head_px']}px;line-height:1.1;letter-spacing:-.02em;
  color:var(--ds-ink);text-wrap:balance}}
.head em{{font-style:normal;color:var(--ds-accent-text)}}
.num{{font-family:'Geist Mono';font-weight:600;font-size:{g['num_px']}px;
  line-height:1;letter-spacing:-.02em;font-variant-numeric:tabular-nums;
  color:var(--ds-ink)}}
.num small{{font-size:.42em;font-weight:500;color:var(--ds-muted);
  margin-left:.12em;letter-spacing:.04em}}
"""


def plate_html(aspect: str, eyebrow: str, headline: str, numeral: str = "") -> str:
    g = geom(aspect)
    # STRIP THE AUTHORED LINE BREAKS. The <br>s in the beats file were placed for a
    # 1920-wide 16:9 frame; at 936 px of measure they break a phrase in the middle and
    # then the browser re-wraps what is left, which is how "Not an impression. A" ends up
    # alone on a line. Natural wrapping plus `text-wrap: balance` sets the same words
    # evenly, and the copy was never about where the break falls.
    headline = headline.replace("<br>", " ").replace("<br/>", " ")
    num = ""
    if numeral:
        # "3.51 mm" -> the unit is set small and muted, so the figure carries the line.
        parts = numeral.split(" ", 1)
        unit = f"<small>{parts[1]}</small>" if len(parts) > 1 else ""
        num = f'<p class="num">{parts[0]}{unit}</p>'
    return head(plate_css(g)) + f"""
<div class="cap">
  <div class="rule"></div>
  {f'<p class="eyebrow">{eyebrow}</p>' if eyebrow else ''}
  <h2 class="head">{headline}</h2>
  {num}
</div>"""


# -------------------------------------------------------------------------- frame
def frame_html(aspect: str) -> str:
    """The opaque background: paper, the wordmark, and the slot's own furniture.

    The slot is drawn one pixel LARGER than the footage on every side, so what survives
    once the video is composited over it is a hairline ring and a soft shadow -- the same
    treatment the landing page gives an app screenshot. Without it the dark rectangle
    just starts, and a hard edge against paper reads as a crop rather than as a frame.
    """
    g = geom(aspect)
    return head(f"""
{LIGHT}
body{{background:var(--ds-ground)}}
.mark{{position:absolute;left:{MARGIN}px;top:{g['mark_y']}px;height:{g['mark_h']}px}}
.slot{{position:absolute;left:-1px;top:{g['slot_y'] - 1}px;
  width:{g['w'] + 2}px;height:{g['slot_h'] + 2}px;
  background:#0a0e13;border-top:1px solid var(--ds-border);
  border-bottom:1px solid var(--ds-border);
  box-shadow:0 24px 60px -28px rgba(16,24,40,.45)}}
.foot{{position:absolute;left:{MARGIN}px;right:{MARGIN}px;bottom:{MARGIN - 24}px;
  font-family:'Geist Mono';font-size:19px;letter-spacing:.06em;color:var(--ds-faint)}}
""") + f"""
<img class="mark" src="file://{WORDMARK}" alt="">
<div class="slot"></div>
<p class="foot">{HOST}</p>"""


# ------------------------------------------------------------------- title card
# 1.2 s, and it is also the thumbnail. build_social.sh gives it no fade-in for the same
# reason build_trailer.sh does: a half-second fade from black makes frame 0 black, and
# frame 0 is the poster every player shows before anyone presses play.
def title_html(aspect: str) -> str:
    g = geom(aspect)
    hero = BRAND / "raster/implantplan/hero-implant.png"
    return head(f"""
{LIGHT}
body{{background:var(--ds-ground)}}
.art{{position:absolute;left:0;right:0;top:{g['slot_y'] - 120}px;height:{g['slot_h'] + 120}px;
  display:flex;align-items:center;justify-content:center}}
.art img{{max-width:96%;max-height:100%;object-fit:contain}}
.copy{{position:absolute;left:{MARGIN}px;right:{MARGIN}px;top:{g['cap_y'] - 40}px}}
.rule{{width:64px;height:3px;background:var(--ds-accent);border-radius:2px;margin-bottom:22px}}
.thesis{{font-family:'Archivo';font-stretch:var(--ds-wide,116%);font-weight:700;
  font-size:{g['head_px'] + 8}px;line-height:1.06;letter-spacing:-.025em;color:var(--ds-ink)}}
.thesis em{{font-style:normal;color:var(--ds-accent-text)}}
.mark{{position:absolute;left:{MARGIN}px;top:{g['mark_y']}px;height:{g['mark_h']}px}}
""") + f"""
<img class="mark" src="file://{BRAND / 'raster/implantplan/wordmark-light.png'}" alt="">
<div class="art"><img src="file://{BRAND / 'raster/implantplan/hero-implant.png'}" alt=""></div>
<div class="copy">
  <div class="rule"></div>
  <p class="thesis">Every planner draws the nerve.<br><em>None of them tells you how wrong it is.</em></p>
</div>"""


# --------------------------------------------------------------------- end card
def end_html(aspect: str) -> str:
    """The only frame that asks for anything, so it asks twice.

    Structure preserved exactly from `trailer_overlays.end_html` -- the trial with the
    terms the signup page actually honours, then the custom-model ask with an address --
    re-themed and re-typeset for a vertical canvas. One line of the old legal block
    survives and it is the one that has to: CC BY-NC-SA is BY as well as NC, and that
    attribution is why this footage can be published at all.
    """
    g = geom(aspect)
    return head(f"""
{LIGHT}
body{{background:var(--ds-ground);display:flex;align-items:center;justify-content:center}}
.card{{width:{g['w'] - 2 * MARGIN}px;display:flex;flex-direction:column;gap:26px}}
.mark{{height:{g['mark_h'] + 16}px;align-self:flex-start}}
h3{{font-family:'Archivo';font-stretch:var(--ds-wide,116%);font-weight:700;
  font-size:{g['head_px'] + 4}px;line-height:1.06;letter-spacing:-.025em;color:var(--ds-ink)}}
.terms{{font-family:'Geist Mono';font-size:26px;letter-spacing:.04em;color:var(--ds-muted)}}
.host{{font-family:'Geist Mono';font-size:30px;letter-spacing:.04em;color:var(--ds-accent-text)}}
.split{{width:100%;height:3px;background:var(--ds-accent);border-radius:2px;opacity:.9}}
.ask{{font-family:'Archivo';font-stretch:var(--ds-wide,116%);font-weight:600;
  font-size:{g['head_px'] - 18}px;line-height:1.15;color:var(--ds-ink-dim)}}
.contact{{font-family:'Geist Mono';font-size:24px;letter-spacing:.02em;color:var(--ds-muted)}}
.legal{{font-family:'Geist';font-size:17px;line-height:1.5;color:var(--ds-faint);
  border-top:1px solid var(--ds-border);padding-top:18px}}
""") + f"""
<div class="card">
  <img class="mark" src="file://{WORDMARK}" alt="">
  <h3>{TRIAL_HEAD}</h3>
  <p class="terms">{TRIAL_TERMS}</p>
  <p class="host">{HOST}</p>
  <div class="split"></div>
  <p class="ask">{CUSTOM_ASK}</p>
  <p class="contact">{CONTACT}</p>
  <p class="legal">{LEGAL}</p>
</div>"""


# ------------------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--beats", required=True, type=pathlib.Path)
    ap.add_argument("--out", required=True, type=pathlib.Path)
    ap.add_argument("--aspects", default="4x5,9x16")
    args = ap.parse_args()

    beats = json.loads(args.beats.read_text(encoding="utf-8"))["beats"]
    args.out.mkdir(parents=True, exist_ok=True)

    made = 0
    for aspect in args.aspects.split(","):
        g = geom(aspect)
        d = args.out / aspect
        d.mkdir(exist_ok=True)
        # Plates are rendered NATIVELY per aspect rather than stretched from one canvas.
        # That is the whole point of the rebuild: the old pipeline composited 56px type
        # onto a 1920-wide body and then scaled the result to 1080, delivering 31px
        # headlines and 6px app readouts. Nothing here is scaled after it is typeset.
        for b in beats:
            if not b.get("headline"):
                continue
            # Named by the beat's own index in the file it came from, so build_social.sh
            # can look a plate up by index rather than by position. The cut drops beats
            # whose footage was cut, so position and index are not the same thing.
            idx = b.get("index", beats.index(b))
            shoot(plate_html(aspect, b.get("eyebrow", ""), b["headline"], b.get("numeral", "")),
                  d / f"plate{idx:02d}.png", g["w"], g["h"], transparent=True)
            made += 1
        shoot(frame_html(aspect), d / "frame.png", g["w"], g["h"], transparent=False)
        shoot(title_html(aspect), d / "title.png", g["w"], g["h"], transparent=False)
        shoot(end_html(aspect), d / "end.png", g["w"], g["h"], transparent=False)
        made += 3
        print(f"{aspect}: {g['w']}x{g['h']}, slot at y={g['slot_y']} "
              f"({g['w']}x{g['slot_h']}), caption from y={g['cap_y']}")

    print(f"wrote {made} PNGs to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

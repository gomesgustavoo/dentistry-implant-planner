#!/usr/bin/env python3
"""Plan the LinkedIn cut: pick segments out of the 92 s master and re-time the beats.

The delivered implant film is paced for a README, where a viewer has already decided to
watch. A feed film has to earn its first three seconds and then hold for about a minute,
so this selects from the same footage rather than re-recording it -- the body is the real
app on the real GPU either way, and every number in it was scraped from the page at
capture time.

TWO RULES THIS FILE EXISTS TO KEEP.

1. **A caption may only be shown over the footage it was scraped from.** Each beat's plate
   is re-timed onto the new timeline by mapping its source instant through the segment
   that contains it. A beat whose segment was cut is DROPPED, never slid onto neighbouring
   footage -- that is precisely how a caption ends up naming a verdict that is not on
   screen, which is the defect `make_preview_gif.sh`'s hue check was written for.

2. **The cold open reuses a real beat's scraped numeral, and only inside that beat's own
   window.** The opening three seconds are lifted from the middle of the CLEAR beat, so
   the figure on screen there IS that beat's figure. The script asserts the window falls
   inside the beat it borrows from; if the master is ever re-cut, that assertion fails
   rather than the caption quietly becoming wrong.

    ./venv/bin/python scripts/cut_social.py --beats <trailer-beats.json> --out <social-beats.json>
"""
from __future__ import annotations

import argparse
import json
import pathlib

# (source_start, source_end, why). Chronological apart from the cold open, so the app's
# on-screen state never jumps backwards mid-film.
SEGMENTS = [
    (30.50, 33.50, "cold open: the clearance already on screen, with its verdict"),
    (6.40, 12.40, "the chart, and a real gap to plan into"),
    (20.50, 39.70, "seeded from the restoration, settled by measurement, then the number "
                   "and the error budget behind it"),
    (50.70, 77.40, "the spine: seat it deeper -> TIGHT -> BREACH -> back to the crest"),
    (82.50, 91.90, "the envelope it is graded against, and the refusal"),
]

# Verdict windows in BODY time, where the app's state and the caption naming it AGREE.
#
# These are not new: they are `make_preview_gif.sh`'s three windows, which are already
# proven against the rendered GIF by hue, converted from master time to body time by
# subtracting that film's 3.5 s title card. They exist because the film's state changes a
# beat BEFORE the plate that names it -- the recorder scrubs depth continuously and the
# caption lands after the move settles -- so a sample taken at a plate's midpoint can
# legitimately show the NEXT verdict. Anything checking this film has to sample here.
PROVEN_VERDICT_WINDOWS = [
    ("TIGHT", 51.5, 55.1, "2.55 mm"),
    ("BREACH", 61.1, 64.7, "2.07 mm"),
    ("CLEAR", 70.8, 73.8, "3.51 mm"),
]

# The cold open borrows this beat's scraped numeral. Asserted below to be the beat whose
# window actually contains the borrowed footage.
COLD_OPEN_FROM = 5
COLD_OPEN = {
    "eyebrow": "A planned implant, on a held-out scan",
    "headline": "How far is this from the nerve?",
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--beats", required=True, type=pathlib.Path)
    ap.add_argument("--out", required=True, type=pathlib.Path)
    ap.add_argument("--title-s", type=float, default=1.2)
    args = ap.parse_args()

    src = json.loads(args.beats.read_text(encoding="utf-8"))
    beats = src["beats"]

    segs, t = [], 0.0
    for start, end, why in SEGMENTS:
        d = end - start
        segs.append({"start": start, "end": end, "duration": d, "at": t, "why": why})
        t += d
    body = t

    def remap(src_t: float):
        """Source instant -> new timeline, or None if its footage was cut."""
        for s in segs[1:]:                      # segment 0 is the cold open, not in order
            if s["start"] <= src_t < s["end"]:
                return s["at"] + (src_t - s["start"])
        return None

    # The cold open has to sit inside the window of the beat whose numeral it borrows, or
    # the figure on screen is not the figure in the caption.
    lender = beats[COLD_OPEN_FROM]
    nxt = beats[COLD_OPEN_FROM + 1]["at"] if COLD_OPEN_FROM + 1 < len(beats) else 1e9
    co_start, co_end = SEGMENTS[0][0], SEGMENTS[0][1]
    if not (lender["at"] <= co_start and co_end <= nxt):
        raise SystemExit(
            f"the cold open ({co_start}-{co_end}s) is not inside beat {COLD_OPEN_FROM}'s "
            f"window ({lender['at']}-{nxt}s) -- it would show one verdict and name another")
    if not lender.get("numeral"):
        raise SystemExit(f"beat {COLD_OPEN_FROM} has no scraped numeral to borrow")

    out = [{
        "index": 0, "at": 0.0,
        "eyebrow": COLD_OPEN["eyebrow"], "headline": COLD_OPEN["headline"],
        # SCRAPED, not typed: this is the value the app rendered in this very footage.
        "numeral": lender["numeral"],
        "borrowed_from": COLD_OPEN_FROM,
    }]
    dropped = []
    for i, b in enumerate(beats):
        if not b.get("headline"):
            continue
        at = remap(b["at"])
        if at is None:
            dropped.append(i)
            continue
        out.append({"index": i + 1, "at": at, "eyebrow": b.get("eyebrow", ""),
                    "headline": b["headline"], "numeral": b.get("numeral", "")})

    # A plate runs until the next one is due, minus a breath; the last runs to the end of
    # the body. Same contract build_trailer.sh uses, so a plate cannot drift off the thing
    # it names.
    shown = sorted(out, key=lambda b: b["at"])
    for n, b in enumerate(shown):
        b["plate_start"] = round(b["at"] + args.title_s, 3)
        nxt_at = shown[n + 1]["at"] - 0.2 if n + 1 < len(shown) else body
        b["plate_end"] = round(nxt_at + args.title_s, 3)
    shown = [b for b in shown if b["plate_end"] - b["plate_start"] >= 1.2]

    # Map the proven windows onto the delivered timeline, and refuse to emit one that the
    # cut has broken: a window that straddles a segment boundary is two different moments
    # of footage spliced together, and sampling it proves nothing.
    windows = []
    for name, w0, w1, numeral in PROVEN_VERDICT_WINDOWS:
        a, b = remap(w0), remap(w1)
        if a is None or b is None or abs((b - a) - (w1 - w0)) > 1e-6:
            raise SystemExit(
                f"the {name} verdict window ({w0}-{w1}s) does not survive this cut intact. "
                "Either keep it whole or drop the beat that names it -- do not ship a film "
                "whose verdicts cannot be checked.")
        # ...and the plate on screen there must be the one that names this verdict.
        at = (a + b) / 2 + args.title_s
        active = [x for x in shown if x["plate_start"] <= at <= x["plate_end"]]
        if not active:
            raise SystemExit(f"no caption is on screen during the {name} window")
        if (active[0].get("numeral") or "").strip() != numeral:
            raise SystemExit(
                f"during the {name} window the caption on screen is plate "
                f"{active[0]['index']} reading {active[0].get('numeral')!r}, not {numeral!r}")
        windows.append({"verdict": name, "numeral": numeral,
                        "start": round(a + args.title_s, 3), "end": round(b + args.title_s, 3),
                        "sample": round(at, 3), "plate": active[0]["index"]})

    args.out.write_text(json.dumps({
        "source": str(args.beats), "case": src.get("case"), "renderer": src.get("renderer"),
        "body_seconds": round(body, 3), "segments": segs, "beats": shown,
        "verdict_windows": windows, "dropped_source_beats": dropped,
    }, indent=2), encoding="utf-8")

    print(f"# {len(SEGMENTS)} segments, {body:.2f}s of body, {len(shown)} plates"
          f"{f', {len(dropped)} source beats dropped with their footage' if dropped else ''}")
    for s in segs:
        print(f"  {s['start']:6.2f}-{s['end']:6.2f}  ->  {s['at']:6.2f}  {s['why']}")
    for w in windows:
        print(f"  {w['verdict']:6} verifiable at {w['sample']:6.2f}s under plate {w['plate']} "
              f"({w['numeral']})")
    for b in shown:
        num = f"  [{b['numeral']}]" if b.get("numeral") else ""
        print(f"  plate {b['index']:2}  {b['plate_start']:6.2f}-{b['plate_end']:6.2f}  "
              f"{b['headline'][:52]}{num}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

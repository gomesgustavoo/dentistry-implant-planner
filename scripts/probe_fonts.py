#!/usr/bin/env python3
"""Prove the overlay CSS loads Archivo AND actually moves its width axis.

Two silent failure modes, both of which render something plausible:

  1. **The face never loads.** ~/brand/README.md records that headless Chrome will not
     load a webfont over `file://` -- not with `--allow-file-access-from-files`, not with
     `font-display:block`, not with a long virtual-time budget -- and every string then
     renders in the default sans and *looks plausible enough to ship*. Chrome 151 does in
     fact honour the flag here, but "does in fact" is a measurement, not a guarantee, and
     it is the kind of thing that changes under you at the next update.
  2. **The face loads and the axis does not move.** A non-variable fallback, a subset that
     dropped `wdth`, or a rule that never reaches the element all render legible type at
     one width, and "legible" is the bar a human eye applies to a caption plate.

     MEASURED, and it corrects an assumption worth writing down: `trailer_overlays.py`
     omitted `font-stretch: 62% 125%` from its @font-face while ~/brand/make-raster.py
     declares it, and the obvious conclusion -- that the two delivered films are therefore
     set at 100% -- is WRONG. Chrome 151 applies `font-stretch` to a variable face's `wdth`
     axis whether or not the descriptor is present: measured 43.2% apart between 116% and
     78% both with and without it. The descriptor is declared now because it is what the
     spec asks for and it matches the brand kit, not because it fixed a defect. The films
     were always set correctly.

The test is a width measurement, not `document.fonts.check()`: that returns false for a
face that has not been USED yet, so a probe that measures immediately races the load and
reports a false negative.

    ./venv/bin/python scripts/probe_fonts.py
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from trailer_overlays import head  # noqa: E402  (same CSS the plates are built with)

SAMPLE = "Clearance to the inferior alveolar canal"
BODY_CSS = """
body{background:#fff}
span{position:absolute;left:0;white-space:nowrap;font-size:64px;font-weight:700}
#wide{top:0;font-family:'Archivo';font-stretch:116%}
#narrow{top:100px;font-family:'Archivo';font-stretch:78%}
#normal{top:200px;font-family:'Archivo';font-stretch:100%}
#bogus{top:300px;font-family:'NoSuchFaceAnywhere';font-stretch:116%}
"""
MARKUP = f"""
<span id="wide">{SAMPLE}</span>
<span id="narrow">{SAMPLE}</span>
<span id="normal">{SAMPLE}</span>
<span id="bogus">{SAMPLE}</span>
<script>
(async () => {{
  // Load explicitly first. fonts.check() lies about a face that has not been used.
  await document.fonts.load("700 64px Archivo");
  await document.fonts.ready;
  const w = (id) => document.getElementById(id).getBoundingClientRect().width;
  document.title = JSON.stringify({{
    wide: w('wide'), narrow: w('narrow'), normal: w('normal'), bogus: w('bogus'),
  }});
}})();
</script>
"""


def measure(page_html: str) -> dict:
    with tempfile.TemporaryDirectory() as td:
        page = pathlib.Path(td) / "probe.html"
        page.write_text(page_html, encoding="utf-8")
        out = pathlib.Path(td) / "probe.json"
        # --dump-dom after a virtual time budget is the simplest way to read the title
        # back out of headless Chrome without a debugger session.
        r = subprocess.run([
            "google-chrome", "--headless", "--disable-gpu", "--no-sandbox",
            "--allow-file-access-from-files", "--virtual-time-budget=4000",
            "--dump-dom", f"file://{page}",
        ], capture_output=True, text=True)
        dom = r.stdout
    start = dom.find("<title>")
    end = dom.find("</title>")
    if start < 0 or end < 0:
        raise SystemExit("the probe page produced no title -- Chrome did not run the script")
    return json.loads(dom[start + 7:end])


def main() -> int:
    m = measure(head(BODY_CSS) + MARKUP)

    print(f"# '{SAMPLE}' at 64px/700")
    for k in ("wide", "normal", "narrow", "bogus"):
        print(f"  {k:7} {m[k]:8.2f} px")

    fail = 0
    # (1) The face loaded: a real face measures differently from a family that does not
    #     exist. Identical widths means the default sans drew all four.
    loaded = abs(m["normal"] - m["bogus"]) / max(m["bogus"], 1) > 0.05
    print(f"{'ok  ' if loaded else 'FAIL'} Archivo actually loaded "
          f"({abs(m['normal'] - m['bogus']) / m['bogus'] * 100:.1f}% from the bogus family)")
    fail += 0 if loaded else 1

    # (2) The axis moves: 116% has to be meaningfully wider than 78%.
    spread = (m["wide"] - m["narrow"]) / max(m["narrow"], 1)
    moved = spread > 0.20
    print(f"{'ok  ' if moved else 'FAIL'} the wdth axis moves "
          f"(116% is {spread * 100:.1f}% wider than 78%; want > 20%)")
    fail += 0 if moved else 1

    # (3) ...and in the right direction, either side of the default.
    ordered = m["narrow"] < m["normal"] < m["wide"]
    print(f"{'ok  ' if ordered else 'FAIL'} narrow < normal < wide")
    fail += 0 if ordered else 1

    # --prove: pin every span to one width and show the measurement notices. Removing the
    # @font-face descriptor does NOT do this -- see the header; that was measured and it
    # changes nothing in Chrome 151. What the check actually defends against is type that
    # is not being varied at all, so that is what gets simulated.
    if "--prove" in sys.argv:
        flat_css = BODY_CSS.replace("font-stretch:116%", "font-stretch:100%") \
                           .replace("font-stretch:78%", "font-stretch:100%")
        b = measure(head(flat_css) + MARKUP)
        flat = abs(b["wide"] - b["narrow"]) / max(b["narrow"], 1)
        caught = flat < 0.02
        print("\n# --prove: the same page with every span pinned to one width")
        print(f"  wide {b['wide']:.2f} px, narrow {b['narrow']:.2f} px -> "
              f"{flat * 100:.2f}% apart")
        print(f"{'ok  ' if caught else 'FAIL'} the axis check notices when nothing varies")
        fail += 0 if caught else 1

    print()
    if fail:
        print(f"{fail} failing check(s) -- the plates are not set the way the CSS says")
        return 1
    print("the width axis is real")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

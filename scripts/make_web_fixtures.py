#!/usr/bin/env python3
"""Regenerate `web-auth/fixtures/assets/` from a real processed case.

Why this exists. The harness's arch fixture was hand-written and every site in it
carried `crest_z_mm`, `height_mm` and `width_mm` as **null**, so every assertion about
the per-site bone readouts was vacuous. There were also no pictures at all, which meant
`check-rail.mjs` had never rendered a cross-section, never called `planCtx` and never
placed an implant -- the three things the plan tab is made of.

A generator rather than a hand-edit, because `tests/implant_vectors.json` is a 130 KB
golden file with no way to rebuild it and that is a latent defect this repo already has
once. Run:

    ./venv/bin/python scripts/make_web_fixtures.py <results-dir>

Keeps: the real points/tangents/normals/curvature (so the implant frame is the real
frame), the real sites (so `siteBlock` renders real millimetres), the real canal
presence array, and the real `cross_sections` metadata. Subsamples the section LIST to
`N_SECTIONS`, chosen to span the arch and to include a molar site that publishes a
height, because that is the readout the fixture was blind to.
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
ASSETS = ROOT / "web-auth" / "fixtures" / "assets"
sys.path.insert(0, str(ROOT))

N_SECTIONS = 8
# The molar that publishes both a height and a width on the reference case. The fixture
# must contain the section nearest it or `siteBlock`'s measured branch never renders.
ANCHOR_FDI = "46"


def build(results: Path) -> None:
    arch = json.loads((results / "planning" / "arch.json").read_text())
    man = arch["jaws"]["mandible"]
    cs = man["cross_sections"]
    s_mm = cs["s_mm"]
    src = cs["source_indices"]

    anchor_s = man["sites"][ANCHOR_FDI]["s_mm"]
    anchor = min(range(len(s_mm)), key=lambda i: abs(s_mm[i] - anchor_s))

    # Spread the rest evenly, then force the anchor in. Sorted and de-duplicated so the
    # slider's index order still matches the arc order.
    step = max(1, (len(s_mm) - 1) // (N_SECTIONS - 1))
    pick = sorted({*range(0, len(s_mm), step), anchor})[:N_SECTIONS]
    if anchor not in pick:
        pick = sorted({*pick[:-1], anchor})

    out = dict(arch)
    out["jaws"] = {
        "mandible": {
            **{k: v for k, v in man.items() if k != "cross_sections"},
            "cross_sections": {
                **cs,
                "count": len(pick),
                "source_indices": [src[i] for i in pick],
                "s_mm": [s_mm[i] for i in pick],
            },
        },
        # A refused jaw is load-bearing: `check-rail` asserts exactly one disabled jaw
        # tab, and `api/planning_cache.Pack.sampler` used to hand back a sampler for a
        # refused jaw whose `bounds()` raised.
        "maxilla": {
            "ok": False,
            "reason": "the fitted curve misses the teeth by 6.8 mm at the 95th percentile",
        },
    }

    dst = ASSETS / "arch-mandible.json"
    dst.write_text(json.dumps(out, separators=(",", ":")))

    # One real picture of each kind. The harness tests layout and the coordinate map,
    # not anatomy, so every section is served the same bitmap -- but it must be the real
    # SIZE, because `planCtx` sizes the backing store from `naturalWidth`/`naturalHeight`
    # and the panoramic's anisotropy correction is read from `pixel_mm`.
    shutil.copyfile(results / "planning" / "xs" / "mandible" / f"{src[anchor]:04d}.jpg",
                    ASSETS / "xs-mandible.jpg")
    shutil.copyfile(results / "planning" / "pan" / "mandible.jpg",
                    ASSETS / "pan-mandible.jpg")

    # The structure outlines, RE-KEYED to the fixture's own section list. The artifact
    # is keyed by position in the full list; the fixture keeps 8 of those, so section i
    # of the fixture is section pick[i] of the case. Getting this wrong would draw one
    # section's anatomy over another's picture -- which is exactly the class of defect
    # the overlay exists to expose, so it must not be introduced by the fixture.
    src_c = results / "planning" / "xs" / "mandible" / "contours.json"
    if src_c.is_file():
        full = json.loads(src_c.read_text())
        (ASSETS / "contours-mandible.json").write_text(json.dumps(
            {str(i): full.get(str(k), {}) for i, k in enumerate(pick)},
            separators=(",", ":")))
        print(f"contours-mandible.json  "
              f"{(ASSETS / 'contours-mandible.json').stat().st_size} bytes, "
              f"{len(pick)} sections re-keyed")

    _measure(results, out, pick)

    sites = out["jaws"]["mandible"]["sites"]
    measured = [k for k, v in sites.items() if v.get("height_mm") is not None]
    print(f"arch-mandible.json  {dst.stat().st_size} bytes")
    print(f"  sections {len(pick)} at s_mm {[round(s_mm[i], 1) for i in pick]}")
    print(f"  sites with a published height: {sorted(measured)}")
    print(f"  anchor FDI {ANCHOR_FDI} at s={anchor_s} -> section {anchor}, file {src[anchor]:04d}.jpg")




# --------------------------------------------------------------------------- measure
# The `/measure` stub used to be `{implants: [], priors: {}}`, so the probe never
# reached a clearance block, a headroom bar, a verdict chip or a leader line -- and
# `priors.by_structure` being undefined would have thrown on the first paint of
# anything that reads it. Generated from the REAL measurement code against the REAL
# pack so the headline wording, the `numbers` keys and the `because` lists cannot
# drift from what the server actually sends.
MEASURE_IMPLANTS = [
    # On the FDI 46 section, roughly where a first molar goes: 4.1 x 10 mm, upright.
    {"id": "i1", "jaw": "mandible", "site_fdi": 46, "s_mm": -36.5, "t_mm": 0.0,
     "z_mm": 44.8, "tilt_deg": 0.0, "yaw_deg": 0.0, "length_mm": 10.0,
     "diameter_mm": 4.1},
    # A second one 6 mm mesial, so the pairwise block and the shared bar scale render.
    {"id": "i2", "jaw": "mandible", "site_fdi": 45, "s_mm": -30.5, "t_mm": 0.0,
     "z_mm": 42.7, "tilt_deg": 8.0, "yaw_deg": 0.0, "length_mm": 10.0,
     "diameter_mm": 4.1},
]


#: A synthetic hand correction, for the SECOND measure fixture.
#:
#: The pack on disk has no edits -- these three examples were never corrected -- so a
#: fixture generated from it can never exercise the widened error budget, the "corrected
#: by hand" sentence or the per-field penalty table. Injected into a COPY of the pack
#: header rather than written to disk, and shaped exactly as
#: `worker/planning_pack.rebuild_label_fields` writes it: 0.60 mm is the display voxel
#: on a 0.30 mm case at a downsample factor of 2, which is the real number on all three.
EDIT_STUB = [{
    "id": "fixture-edit",
    "at": "2026-09-04T10:00:00Z",
    "voxels": 1840,
    "full_voxels": 14720,
    "quantisation_mm": 0.6,
    "fields": ["canal"],
    "structures": {"3": {"added": 1200, "removed": 640}},
}]


def _measure(results: Path, arch: dict, pick: list) -> None:
    from api import planning_cache
    from api.routes import plans as R

    pack = planning_cache.Pack(results / "planning" / "pack")
    quality = {}
    report = results / "report.json"
    if report.exists():
        quality = (json.loads(report.read_text()).get("quality") or {})

    body = [R.ImplantIn(**i) for i in MEASURE_IMPLANTS]

    def reply(edits):
        out = {
            "implants": [R._measure_one(pack, i, arch, quality, edits) for i in body],
            "pairs": [],
            "pack": {"version": pack.header.get("version"),
                     "step_mm": pack.header.get("step_mm")},
            "priors": {
                "inward_p95_mm": R.PS.MODEL_INWARD_P95_MM,
                "worst_measured_inward_mm": R.PS.MODEL_INWARD_WORST_MM,
                "margin_mm": R.PS.SAFETY_MARGIN_MM,
                "adjacent_margin_mm": R.PS.ADJACENT_MARGIN_MM,
                "inter_implant_margin_mm": R.PS.INTER_IMPLANT_MARGIN_MM,
                "by_structure": R.PS.STRUCTURE_PRIORS,
                "source": "20 held-out annotated cases; not a measurement of YOUR scan"},
            "edits": [{"id": e.get("id"), "at": e.get("at"), "voxels": e.get("voxels"),
                       "fields": e.get("fields") or [],
                       "quantisation_mm": e.get("quantisation_mm"),
                       "structures": e.get("structures") or {}} for e in (edits or [])],
            "edit_penalty": {f: R.PS.edit_penalty(f, edits)
                             for f in ("canal", "accessory_canal", "tooth")
                             if R.PS.edit_penalty(f, edits)},
            "notice": R.PS.NO_GUIDE_NOTICE,
        }
        d = R.PM.inter_implant_distance(MEASURE_IMPLANTS[0], MEASURE_IMPLANTS[1],
                                        arch.get("jaws") or {})
        out["pairs"] = [{"a": "i1", "b": "i2", "distance": d.as_dict(),
                         "verdict": R.PS.inter_implant_verdict(d, "i1", "i2").as_dict()}]
        return out

    out = reply(None)
    edited = reply(EDIT_STUB)
    pack.close()

    (ASSETS / "measure-mandible.json").write_text(json.dumps(out, separators=(",", ":")))
    (ASSETS / "measure-mandible-edited.json").write_text(
        json.dumps(edited, separators=(",", ":")))
    lv = [i["verdict"]["level"] for i in out["implants"]]
    print(f"measure-mandible.json  {(ASSETS / 'measure-mandible.json').stat().st_size} bytes")
    print(f"  implants {len(out['implants'])}, verdicts {lv}, pairs {len(out['pairs'])}")
    p95 = ((edited["implants"][0].get("verdict") or {}).get("numbers") or {})
    print(f"measure-mandible-edited.json  "
          f"{(ASSETS / 'measure-mandible-edited.json').stat().st_size} bytes")
    print(f"  canal budget {p95.get('model_p95_mm')} + edit -> "
          f"{p95.get('inward_p95_mm')} mm deducted")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    build(Path(sys.argv[1]))

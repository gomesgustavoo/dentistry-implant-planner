#!/usr/bin/env python3
"""Regenerate `tests/implant_vectors.json`.

Why this exists. That file is 130 KB of golden geometry -- eight poses, the LPS frame
for each, and 40 sampled triangles per pose -- and it had **no generator**. Nothing in
`scripts/`, `eval/` or `tests/` could rebuild it, so a contract change would have meant
hand-editing a file whose whole purpose is to be the thing nobody hand-edits. That is a
latent defect independent of any feature, and it is why `viewer/check-equivalence.mjs`
could not be re-pointed without writing this first.

    ./venv/bin/python scripts/gen_implant_vectors.py <results-dir> [--check]

`--check` regenerates in memory and diffs against the committed file, so CI can assert
the file still matches the code that claims to produce it.

FRAME COMPONENTS ARE WRITTEN AT FULL PRECISION. They were rounded to nine decimals while
`check-equivalence.mjs` asserts the frame to 1e-9 -- a quantisation floor of 5e-10
against a 1e-9 tolerance, i.e. exactly 2x of headroom, which is a flake waiting for an
unlucky rounding. Coordinates stay at six decimals: the replay tolerance there is 1e-4
and their floor is 5e-7.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

CONTRACT_VERSION = 1
N_SAMPLED = 40

# Thirteen poses spanning both jaws, the tilt clamp in both directions, and -- since
# 2026-09-04 -- yaw and roll, which the frame has always implemented and no vector ever
# exercised. The previous comment claimed the set "spans both jaws" and every pose in it
# was mandibular, and claimed it pinned "the yaw branch" while every `yaw_deg` was 0.0.
#
# Yaw is the one that needed pinning most: it is the only branch that reads `tangents`,
# and the browser ignored it entirely until this file gained a pose that would have
# caught that. Roll changes no measurement -- the solid is a body of revolution -- but it
# rotates `(e1, e2)`, so the capsule's own ring vertices move, and that IS comparable
# across the two languages.
POSES = [
    {"jaw": "mandible", "s_mm": -36.5, "t_mm": 0.0, "z_mm": 44.8,
     "tilt_deg": 0.0, "yaw_deg": 0.0, "length_mm": 10.0, "diameter_mm": 4.1},
    {"jaw": "mandible", "s_mm": -36.5, "t_mm": 1.5, "z_mm": 44.8,
     "tilt_deg": 20.0, "yaw_deg": 0.0, "length_mm": 13.0, "diameter_mm": 4.8},
    {"jaw": "mandible", "s_mm": -20.0, "t_mm": -1.0, "z_mm": 40.0,
     "tilt_deg": -35.0, "yaw_deg": 0.0, "length_mm": 16.0, "diameter_mm": 3.0},
    {"jaw": "mandible", "s_mm": 8.0, "t_mm": 0.0, "z_mm": 37.0,
     "tilt_deg": 35.0, "yaw_deg": 0.0, "length_mm": 6.0, "diameter_mm": 6.0},
    {"jaw": "mandible", "s_mm": 35.5, "t_mm": 0.5, "z_mm": 44.5,
     "tilt_deg": 10.0, "yaw_deg": 0.0, "length_mm": 11.5, "diameter_mm": 3.75},
    {"jaw": "mandible", "s_mm": 45.0, "t_mm": -2.0, "z_mm": 47.8,
     "tilt_deg": -15.0, "yaw_deg": 0.0, "length_mm": 8.0, "diameter_mm": 3.3},
    {"jaw": "mandible", "s_mm": -46.0, "t_mm": 0.0, "z_mm": 47.7,
     "tilt_deg": 5.0, "yaw_deg": 0.0, "length_mm": 14.0, "diameter_mm": 5.0},
    {"jaw": "mandible", "s_mm": -57.0, "t_mm": 1.0, "z_mm": 47.8,
     "tilt_deg": -25.0, "yaw_deg": 0.0, "length_mm": 10.0, "diameter_mm": 4.3},
    # --- yaw: the branch that reads `tangents` -------------------------------------
    {"jaw": "mandible", "s_mm": -30.0, "t_mm": 0.0, "z_mm": 44.0,
     "tilt_deg": 0.0, "yaw_deg": 12.0, "length_mm": 10.0, "diameter_mm": 4.1},
    {"jaw": "mandible", "s_mm": 22.0, "t_mm": -1.5, "z_mm": 42.0,
     "tilt_deg": 10.0, "yaw_deg": -18.0, "length_mm": 13.0, "diameter_mm": 4.8},
    # --- roll: no measurement moves, the ring vertices do ---------------------------
    {"jaw": "mandible", "s_mm": -36.5, "t_mm": 0.0, "z_mm": 44.8,
     "tilt_deg": 0.0, "yaw_deg": 0.0, "roll_deg": 37.0,
     "length_mm": 10.0, "diameter_mm": 4.1},
    # --- the maxilla, which had NO pose at all, and all three angles at once ---------
    {"jaw": "maxilla", "s_mm": -30.0, "t_mm": 0.0, "z_mm": 24.0,
     "tilt_deg": 0.0, "yaw_deg": 0.0, "length_mm": 10.0, "diameter_mm": 4.1},
    {"jaw": "maxilla", "s_mm": 18.0, "t_mm": 1.0, "z_mm": 22.0,
     "tilt_deg": -12.0, "yaw_deg": 8.0, "roll_deg": -120.0,
     "length_mm": 11.5, "diameter_mm": 3.75},
]


def build(results: Path) -> dict:
    from dentistry import plan_geometry as G

    arch = json.loads((results / "planning" / "arch.json").read_text())
    jaws = {k: v for k, v in arch["jaws"].items() if v.get("ok")}
    out_poses = []
    for i, imp in enumerate(POSES):
        info = jaws[imp["jaw"]]
        origin, e1, e2, ax = G.implant_frame(imp, info)
        frame = {"origin": origin, "e1": e1, "e2": e2, "ax": ax}
        tris = G.implant_triangles_lps(imp, info)
        n = len(tris)
        step = max(1, n // N_SAMPLED)
        sampled = [[t, [[round(float(c), 6) for c in v] for v in tris[t]]]
                   for t in range(0, n, step)][:N_SAMPLED]
        lo = [min(v[k] for t in tris for v in t) for k in range(3)]
        hi = [max(v[k] for t in tris for v in t) for k in range(3)]
        out_poses.append({
            "implant": imp,
            # FULL precision -- see the module docstring.
            "frame": {k: [float(c) for c in frame[k]] for k in ("origin", "e1", "e2", "ax")},
            "n_triangles": n,
            "triangle_stride": step,
            "sampled_triangles": sampled,
            "bounds": [round(x, 6) for x in (lo + hi)],
        })
    return {
        "_": ("Golden implant geometry. Regenerate with "
              "scripts/gen_implant_vectors.py; never hand-edit."),
        "contract_version": CONTRACT_VERSION,
        "source_case": results.name,
        "manifest": {k: v for k, v in jaws.items()},
        "poses": out_poses,
    }


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    check = "--check" in sys.argv
    if len(args) != 1:
        raise SystemExit(__doc__)
    data = build(Path(args[0]))
    dst = ROOT / "tests" / "implant_vectors.json"
    text = json.dumps(data, separators=(",", ":"))
    if check:
        same = dst.exists() and dst.read_text() == text
        print("MATCHES the committed file" if same
              else "DIFFERS from the committed file")
        raise SystemExit(0 if same else 1)
    dst.write_text(text)
    print(f"{dst} {dst.stat().st_size} bytes, {len(data['poses'])} poses, "
          f"{data['poses'][0]['n_triangles']} triangles each")

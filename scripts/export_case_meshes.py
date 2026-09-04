#!/usr/bin/env python3
"""Bake one finished case's surfaces into the static bundle the model picker draws.

The picker used to draw a SCHEMATIC dentition -- an arch swept from a spline with
ellipsoid teeth on it -- and the caption had to admit it was "not a segmentation, and
not your scan". The argument for that was real and is written down in
`viewer/src/preview.js`: the picker sits on the upload page, where there is no scan and
no case, so drawing somebody else's anatomy risks a reader taking those shapes for what
the model will draw on theirs.

What changed is not the argument, it is the answer to it. This product's entire claim is
the segmentation; a picker that illustrates it with a drawing is arguing its own case
with a prop. The honest version shows a REAL segmentation and says whose it is -- and the
case it shows is already published in the app as an example, from a public research
dataset, held out of training. The caption names it. That is a stronger guarantee than a
disclaimer on a diagram, because a reader can go and open the case.

WHAT THIS WRITES
    web/assets/preview/<group>.msh      one merged DSVM mesh per PICKER group
    web/assets/preview/manifest.json    bounds, camera, colours, provenance

Six groups, not forty-seven structures, because the picker's question is "which
structures is this model authoritative for" and its answer is per group. Merging also
collapses 42 draw calls into 6 and lets the decimator spend its budget where the
triangles are.

The groups are the ones `dentistry/models.py` declares (`ModelEntry.groups`), NOT
`labels.GROUP_ORDER` -- the label taxonomy splits teeth into upper and lower and gives
pulp its own group, which are distinctions the picker does not make. `GROUP_MAP` below is
the one place the two vocabularies meet.

USAGE
    ./venv/bin/python scripts/export_case_meshes.py <results-dir> [--out web/assets/preview]
    ./venv/bin/python scripts/export_case_meshes.py --job <job-id>
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dentistry import labels as L  # noqa: E402
from worker.meshes import MESH_MAGIC, MESH_VERSION, write_web_mesh  # noqa: E402

# The label taxonomy's seven groups, folded into the picker's six. Upper and lower teeth
# are one group here and pulp goes in with them: a reader choosing a tooth model is
# choosing it for the dentition, not for one arch.
GROUP_MAP = {
    L.GROUP_JAWS: "jaws",
    L.GROUP_CANAL: "canals",
    L.GROUP_SINUS: "sinuses",      # split below: the pharynx is airway, the sinuses are not
    L.GROUP_WORK: "restorations",
    L.GROUP_UPPER: "teeth",
    L.GROUP_LOWER: "teeth",
    L.GROUP_PULP: "teeth",
}
# `labels.GROUP_SINUS` is "Airway & sinuses" -- one group carrying two things the picker
# names separately, because a model that draws the pharynx is not thereby a sinus model.
AIRWAY_IDS = {"pharynx"}

# Triangles per group in the finished bundle. The whole point is that this is a THUMBNAIL
# on an upload page: it is ~320-560 px wide, it spins slowly, and it is never zoomed. The
# case's own browser meshes are 1.95 M triangles across 42 surfaces; at these budgets the
# six groups come to ~46 k, which is more than enough for a silhouette at that size and
# small enough to ship to every visitor before sign-in.
GROUP_BUDGET = {
    # The teeth carry the most: 33 structures share this budget, so 18 000 gave ~545
    # triangles a tooth and the molars visibly faceted at the pane's own size. 42 000 is
    # ~1 270 each, which is where the cusps stop reading as polygons.
    "teeth": 42_000,
    "jaws": 20_000,
    "canals": 6_000,
    "sinuses": 6_000,
    "airway": 3_000,
    "restorations": 3_000,
}
DEFAULT_BUDGET = 4_000

# Every group the picker can highlight, in the order `dentistry/models.py` declares them.
# A case that contains none of a group's structures is a real fact about the case, not a
# hole in the bundle: this dentition has no bridge, crown or implant, so `restorations`
# ships as `present: false` with no file. The alternative -- borrowing that group from a
# second patient -- would put two people's anatomy in one picture, which is exactly the
# thing the caption then could not honestly say.
PICKER_GROUPS = ("jaws", "teeth", "canals", "sinuses", "airway", "restorations")
# A hard ceiling on the whole bundle, asserted rather than hoped for. Every visitor to
# the upload page pays this, signed in or not.
TOTAL_BYTES_CEILING = 1_400_000


def read_web_mesh(path: Path):
    """Inverse of `meshes.write_web_mesh`. Returns `(verts (n,3) f32, faces (m,3) i64)`."""
    blob = path.read_bytes()
    if blob[:4] != MESH_MAGIC:
        raise SystemExit(f"{path}: not a DSVM mesh")
    version, n_pts, n_tri = struct.unpack_from("<III", blob, 4)
    if version != MESH_VERSION:
        raise SystemExit(f"{path}: mesh version {version}, this script writes {MESH_VERSION}")
    off = 16
    verts = np.frombuffer(blob, dtype="<f4", count=n_pts * 3, offset=off).reshape(-1, 3)
    off += n_pts * 3 * 4
    faces = np.frombuffer(blob, dtype="<u4", count=n_tri * 3, offset=off).reshape(-1, 3)
    return np.asarray(verts, dtype=np.float32), np.asarray(faces, dtype=np.int64)


def merge(parts):
    """Concatenate meshes, re-basing each one's indices. Returns `(verts, faces)`."""
    verts, faces, base = [], [], 0
    for v, f in parts:
        verts.append(v)
        faces.append(f + base)
        base += len(v)
    if not verts:
        return np.zeros((0, 3), np.float32), np.zeros((0, 3), np.int64)
    return np.vstack(verts).astype(np.float32), np.vstack(faces).astype(np.int64)


def decimate(verts, faces, budget):
    """Same decimator `worker/meshes.py` uses, and the same tolerance for its absence."""
    if len(faces) <= budget:
        return verts, faces
    try:
        import fast_simplification
    except ImportError:
        print(f"  ! fast_simplification not installed — shipping {len(faces)} triangles")
        return verts, faces
    v, f = fast_simplification.simplify(
        verts.astype(np.float32), faces.astype(np.int32), 1.0 - budget / len(faces))
    return np.asarray(v, dtype=np.float32), np.asarray(f, dtype=np.int64)


def group_of(structure) -> str | None:
    if structure.id in AIRWAY_IDS:
        return "airway"
    return GROUP_MAP.get(structure.group)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("results", nargs="?", help="a finished job's results directory")
    ap.add_argument("--job", help="job id; searched for under data/tenants/*/results/")
    ap.add_argument("--out", default="web/assets/preview")
    ap.add_argument("--title", default="", help="how the caption names this case")
    ap.add_argument("--attribution", default="", help="dataset and licence")
    args = ap.parse_args()

    root = Path(__file__).resolve().parents[1]
    if args.job:
        hits = sorted((root / "data" / "tenants").glob(f"*/results/{args.job}"))
        if not hits:
            raise SystemExit(f"no results directory for job {args.job}")
        results = hits[0]
    elif args.results:
        results = Path(args.results)
    else:
        raise SystemExit("give a results directory or --job")

    mesh_dir = results / "mesh"
    if not mesh_dir.is_dir():
        raise SystemExit(f"{mesh_dir} does not exist")
    report = json.loads((results / "report.json").read_text())

    out = root / args.out if not Path(args.out).is_absolute() else Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    by_group: dict[str, list] = {}
    colours: dict[str, list] = {}
    counted: dict[str, int] = {}
    for st in L.STRUCTURES:
        key = group_of(st)
        if key is None:
            continue
        f = mesh_dir / f"{st.id}.msh"
        if not f.exists():
            continue
        by_group.setdefault(key, []).append(read_web_mesh(f))
        counted[key] = counted.get(key, 0) + 1
        # The FIRST structure in a group donates the group's colour, in catalogue order,
        # so the picker's families match the case viewer's palette instead of being a
        # second set of colours for the same anatomy.
        colours.setdefault(key, st.color)

    if not by_group:
        raise SystemExit(f"{mesh_dir} contains no meshes for any known structure")

    manifest = {
        "source_job": results.name,
        "title": args.title or (report.get("input") or {}).get("filename") or results.name,
        "attribution": args.attribution,
        "groups": {},
    }
    lo = np.full(3, np.inf)
    hi = np.full(3, -np.inf)
    total_bytes = 0
    for key, parts in by_group.items():
        verts, faces = merge(parts)
        before = len(faces)
        verts, faces = decimate(verts, faces, GROUP_BUDGET.get(key, DEFAULT_BUDGET))
        n = write_web_mesh(verts, faces, out / f"{key}.msh")
        total_bytes += n
        lo = np.minimum(lo, verts.min(axis=0))
        hi = np.maximum(hi, verts.max(axis=0))
        manifest["groups"][key] = {
            "file": f"{key}.msh",
            "color": colours[key],
            "structures": counted[key],
            "points": int(len(verts)),
            "triangles": int(len(faces)),
            "triangles_before": int(before),
            "bytes": n,
        }
        print(f"  {key:14s} {counted[key]:2d} structures  "
              f"{before:7d} -> {len(faces):6d} tri  {n/1024:7.1f} KB")

    # Vertices are in patient LPS millimetres, so the centre is a real anatomical point
    # and the viewer can frame the scene without guessing. Published rather than
    # recomputed in the browser because a bounds pass over six meshes at load is work the
    # baker has already done.
    # Groups this case simply does not contain. Declared, so the picker can say so when
    # a reader hovers a model that owns one, instead of ghosting the whole scene and
    # highlighting nothing -- which reads as a broken hover.
    for key in PICKER_GROUPS:
        manifest["groups"].setdefault(key, {"present": False, "structures": 0})
    for key, g in manifest["groups"].items():
        g.setdefault("present", True)
    manifest["absent_groups"] = [k for k in PICKER_GROUPS
                                 if not manifest["groups"][k]["present"]]

    manifest["bounds"] = {"min": [round(float(x), 3) for x in lo],
                          "max": [round(float(x), 3) for x in hi]}
    manifest["bytes"] = total_bytes
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")

    absent = manifest["absent_groups"]
    print(f"\n  {len(by_group)} of {len(PICKER_GROUPS)} groups, "
          f"{total_bytes/1024:.1f} KB total -> {out}")
    if absent:
        print(f"  absent from this case (declared, not hidden): {', '.join(absent)}")
    if total_bytes > TOTAL_BYTES_CEILING:
        raise SystemExit(
            f"the bundle is {total_bytes/1024:.0f} KB, over the "
            f"{TOTAL_BYTES_CEILING/1024:.0f} KB ceiling. Every visitor to the upload page "
            f"pays this before they sign in — lower GROUP_BUDGET rather than raising the "
            f"ceiling without a reason.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

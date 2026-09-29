"""The headset's FULL-RESOLUTION copy of the scan: `results/<job>/volume-hr/`.

`volume/` is the browser's display object - windowed to 8 bits and strided down to at
most 256 voxels a side (0.6 mm on these scans). A specialist reading a CBCT in the
headset needs the exam itself, so this packs the full-resolution grid, int16 and
unwindowed, into one file the Quest can stream into a 3D texture:

    volume-hr/meta.json       dimensions / spacing / origin / direction exactly as
                              volume/meta.json writes them, plus dtype, window,
                              intensity percentiles and what was verified
    volume-hr/image.raw       int16 little-endian, C order (z, y, x): x fastest -
                              the same layout as volume/image.raw
    volume-hr/image.raw.gz    the same bytes, gzip (served as-is by the files route)

THE SOURCE is `rtstruct/derived/NNNN.dcm`, the int16 secondary-capture series the
worker writes from the canonical grid (worker/rtstruct.py::_derived_series). The
original upload is purged after a job succeeds, so for an existing case that series is
the only full-resolution copy left.

NOTHING IS WRITTEN UNLESS IT IS PROVEN TO BE THE SAME SCAN IN THE SAME FRAME:
  1. the series geometry (IPP / IOP / PixelSpacing, slice order) equals volume/meta.json
     and report.meshes.frame to 1e-3 mm;
  2. downsampling it and windowing it exactly as worker/volume_pack.py does reproduces
     volume/image.raw - the web's own display volume - to within ONE 8-bit level, with
     the voxel-exact alignment proven by the same comparison shifted one voxel along each
     axis being far worse. (Not bit for bit: the canonical grid the worker windowed was
     float, and the derived series stored it as int16, so a value a fraction of a unit
     from an 8-bit level boundary can land one level over. Measured on e9d0c06b: 97.9 %
     exact, every other voxel +-1; shifted by one voxel, 54 % differ.)
  3. the canal mesh sits on its lumen: darker inside than outside, and clearly more so
     than the same surface moved 1.2 mm along any patient axis - which catches a flipped
     or swapped axis or a millimetre shift. (1 and 2 are the proof; 3 is the guard.) The
     mandible's figures and each surface's offset from the steepest CT edge are recorded
     as information.

Run inside the API pod (numpy, /data mounted), reading this file from stdin:
    sudo k3s kubectl -n dentistry exec -i deploy/dentistry-api -- python - [--write] [job ...]
Without --write it only verifies and reports.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import os
import struct
import sys
import time
from pathlib import Path

import numpy as np

DATA = Path(os.environ.get("DENT_DATA", "/data"))
FORMAT = "ipvr-volume-hr/1"


# ---- a minimal DICOM reader for the worker's own explicit-VR little-endian files ----

_LONG_VR = {b"OB", b"OW", b"OF", b"SQ", b"UT", b"UN", b"OD", b"OL", b"OV", b"UC", b"UR"}
_WANT = {
    (0x0020, 0x0013): "InstanceNumber",
    (0x0020, 0x0032): "ImagePositionPatient",
    (0x0020, 0x0037): "ImageOrientationPatient",
    (0x0028, 0x0010): "Rows",
    (0x0028, 0x0011): "Columns",
    (0x0028, 0x0030): "PixelSpacing",
    (0x0028, 0x0100): "BitsAllocated",
    (0x0028, 0x0103): "PixelRepresentation",
    (0x0028, 0x1050): "WindowCenter",
    (0x0028, 0x1051): "WindowWidth",
    (0x0028, 0x1052): "RescaleIntercept",
    (0x0028, 0x1053): "RescaleSlope",
    (0x0002, 0x0010): "TransferSyntaxUID",
}


def read_dicom(path: Path) -> dict:
    b = path.read_bytes()
    if b[128:132] != b"DICM":
        raise ValueError(f"{path}: no DICM preamble")
    pos, out = 132, {}
    while pos + 8 <= len(b):
        group, elem = struct.unpack_from("<HH", b, pos)
        vr = b[pos + 4:pos + 6]
        if vr in _LONG_VR:
            (length,) = struct.unpack_from("<I", b, pos + 8)
            head = 12
        else:
            (length,) = struct.unpack_from("<H", b, pos + 6)
            head = 8
        start = pos + head
        if (group, elem) == (0x7FE0, 0x0010):
            out["PixelData"] = b[start:start + length]
            break
        if length == 0xFFFFFFFF:
            raise ValueError(f"{path}: undefined-length element {group:04x},{elem:04x}")
        name = _WANT.get((group, elem))
        if name:
            raw = b[start:start + length]
            if vr == b"US":
                out[name] = struct.unpack_from("<H", raw)[0]
            elif vr in (b"DS", b"IS", b"UI", b"CS", b"LO", b"SH"):
                txt = raw.decode("ascii").strip("\x00 ")
                if vr in (b"DS", b"IS"):
                    vals = [float(v) for v in txt.split("\\") if v.strip()]
                    out[name] = vals if len(vals) > 1 else vals[0]
                else:
                    out[name] = txt
        pos = start + length
    if out.get("TransferSyntaxUID") != "1.2.840.10008.1.2.1":
        raise ValueError(f"{path}: transfer syntax {out.get('TransferSyntaxUID')} is not explicit VR LE")
    return out


def read_series(folder: Path):
    files = sorted(folder.glob("*.dcm"))
    if not files:
        raise FileNotFoundError(f"{folder}: no slices")
    heads = [read_dicom(f) for f in files]
    h0 = heads[0]
    rows, cols = int(h0["Rows"]), int(h0["Columns"])
    for i, h in enumerate(heads):
        if int(h["InstanceNumber"]) != i + 1:
            raise ValueError(f"slice {files[i].name}: InstanceNumber {h['InstanceNumber']} != {i + 1}")
        if (int(h["Rows"]), int(h["Columns"])) != (rows, cols):
            raise ValueError("slices differ in size")
        if int(h["BitsAllocated"]) != 16 or int(h["PixelRepresentation"]) != 1:
            raise ValueError("expected signed 16-bit pixels")
        if float(h.get("RescaleSlope", 1.0)) != 1.0 or float(h.get("RescaleIntercept", 0.0)) != 0.0:
            raise ValueError("expected identity rescale")
        if h["ImageOrientationPatient"] != h0["ImageOrientationPatient"]:
            raise ValueError("slices differ in orientation")
        if h["PixelSpacing"] != h0["PixelSpacing"]:
            raise ValueError("slices differ in pixel spacing")

    iop = np.asarray(h0["ImageOrientationPatient"], dtype=np.float64)
    row_dir, col_dir = iop[:3], iop[3:]          # direction of increasing column (x), of increasing row (y)
    ipp = np.asarray([h["ImagePositionPatient"] for h in heads], dtype=np.float64)
    steps = np.diff(ipp, axis=0)
    step = steps.mean(axis=0) if len(steps) else np.cross(row_dir, col_dir)
    dz = float(np.linalg.norm(step))
    if len(steps) and np.abs(steps - step).max() > 1e-3:
        raise ValueError(f"non-uniform slice steps (max deviation {np.abs(steps - step).max():.4f} mm)")
    slice_dir = step / dz
    ps = h0["PixelSpacing"]                      # [row spacing (y), column spacing (x)]
    spacing = np.array([float(ps[1]), float(ps[0]), dz])
    direction = np.stack([row_dir, col_dir, slice_dir], axis=1)   # column j = axis j
    grid = np.empty((len(heads), rows, cols), dtype="<i2")
    for k, h in enumerate(heads):
        px = np.frombuffer(h["PixelData"], dtype="<i2")
        if px.size != rows * cols:
            raise ValueError(f"slice {k}: {px.size} pixels, expected {rows * cols}")
        grid[k] = px.reshape(rows, cols)
    window = (float(h0.get("WindowWidth", 0.0)), float(h0.get("WindowCenter", 0.0)))
    return grid, ipp[0], direction, spacing, window, len(heads)


# ---- the three proofs ----------------------------------------------------------------

def check_frame(origin, direction, spacing, disp_meta, mesh_frame):
    """The series' frame against the display volume's and the meshes'. Returns max errors."""
    f = int(disp_meta["downsample_factor"])
    d_origin = np.asarray(disp_meta["origin"], dtype=np.float64)
    d_dir = np.asarray(disp_meta["direction"], dtype=np.float64).reshape(3, 3)
    d_spacing = np.asarray(disp_meta["spacing"], dtype=np.float64)
    err = {
        "origin_vs_display_mm": float(np.abs(origin - d_origin).max()),
        "direction_vs_display": float(np.abs(direction - d_dir).max()),
        "spacing_vs_display_mm": float(np.abs(spacing * f - d_spacing).max()),
    }
    if mesh_frame:
        m = np.asarray(mesh_frame["direction"], dtype=np.float64).reshape(3, 3)   # index -> LPS, row-major
        err["origin_vs_mesh_frame_mm"] = float(np.abs(origin - np.asarray(mesh_frame["origin"])).max())
        err["index_matrix_vs_mesh_frame_mm"] = float(np.abs(direction @ np.diag(spacing) - m).max())
    return err


def check_display(grid, disp_meta, disp_raw: bytes) -> dict:
    """Re-derive volume/image.raw from this grid exactly as volume_pack.export does, and
    again shifted one voxel along each axis."""
    f = int(disp_meta["downsample_factor"])
    width = float(disp_meta["image"]["window"]["width"])
    level = float(disp_meta["image"]["window"]["level"])
    lo = level - width / 2
    nx, ny, nz = disp_meta["dimensions"]
    disp = np.frombuffer(disp_raw, dtype=np.uint8)
    if disp.size != nx * ny * nz:
        return {"error": "display volume size"}
    disp = disp.reshape(nz, ny, nx).astype(np.int16)

    def eight_bit(g):
        return (np.clip((g.astype(np.float32) - lo) / max(width, 1e-6), 0, 1) * 255).astype(np.uint8)

    g8 = eight_bit(grid[::f, ::f, ::f])
    if g8.shape != disp.shape:
        return {"error": f"shape {g8.shape} vs display {disp.shape}"}
    d = g8.astype(np.int16) - disp
    out = {"exact_fraction": round(float(np.mean(d == 0)), 5), "max_level_difference": int(np.abs(d).max())}
    shifted = []
    for sh in ((1, 0, 0), (0, 1, 0), (0, 0, 1)):
        # On an axis with an odd voxel count the shifted copy is one plane shorter:
        # compare the overlap.
        g = eight_bit(grid[sh[0]::f, sh[1]::f, sh[2]::f][:nz, :ny, :nx])
        z, y, x = g.shape
        shifted.append(round(float(np.mean(g.astype(np.int16) != disp[:z, :y, :x])), 4))
    out["mismatch_shifted_one_voxel_zyx"] = shifted
    return out


def read_dsvm(path: Path):
    b = path.read_bytes()
    if b[:2] == b"\x1f\x8b":
        b = gzip.decompress(b)
    if b[:4] != b"DSVM":
        raise ValueError(f"{path}: not DSVM")
    ver, n_pts, n_tri = struct.unpack_from("<III", b, 4)
    off = 16
    pts = np.frombuffer(b, dtype="<f4", count=n_pts * 3, offset=off).reshape(-1, 3).astype(np.float64)
    off += n_pts * 12
    tri = np.frombuffer(b, dtype="<u4", count=n_tri * 3, offset=off).reshape(-1, 3).astype(np.int64)
    return pts, tri


def vertex_normals(pts, tri):
    """Area-weighted, turned OUTWARD whatever the file's winding: the signed volume of a
    (nearly) closed surface is positive when its triangles wind outward."""
    a, b, c = pts[tri[:, 0]], pts[tri[:, 1]], pts[tri[:, 2]]
    fn = np.cross(b - a, c - a)
    signed_volume = float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum()) / 6.0
    if signed_volume < 0:
        fn = -fn
    vn = np.zeros_like(pts)
    for k in range(3):
        np.add.at(vn, tri[:, k], fn)
    n = np.linalg.norm(vn, axis=1, keepdims=True)
    return vn / np.maximum(n, 1e-12)


def trilinear(grid, origin, direction, spacing, lps):
    """Sample the grid at LPS points; voxel centre (i,j,k) sits at origin + D diag(s) (i,j,k)."""
    ijk = (lps - origin) @ direction / spacing          # D is orthonormal: D^-1 = D^T
    nz, ny, nx = grid.shape
    x, y, z = ijk[:, 0], ijk[:, 1], ijk[:, 2]
    ok = (x >= 0) & (y >= 0) & (z >= 0) & (x <= nx - 1) & (y <= ny - 1) & (z <= nz - 1)
    x, y, z = np.clip(x, 0, nx - 1.001), np.clip(y, 0, ny - 1.001), np.clip(z, 0, nz - 1.001)
    x0, y0, z0 = x.astype(int), y.astype(int), z.astype(int)
    fx, fy, fz = x - x0, y - y0, z - z0
    v = 0.0
    for dz_ in (0, 1):
        for dy_ in (0, 1):
            for dx_ in (0, 1):
                w = (fx if dx_ else 1 - fx) * (fy if dy_ else 1 - fy) * (fz if dz_ else 1 - fz)
                v = v + w * grid[z0 + dz_, y0 + dy_, x0 + dx_].astype(np.float64)
    return v, ok


def check_registration(grid, origin, direction, spacing, results: Path, mesh_map: dict):
    """Inside vs outside each surface, 0.6 mm along the vertex normal (outward: DSVM winding
    is outward in LPS). The mandible is brighter inside; the canal lumen darker inside."""
    out = {}
    for sid, want in (("mandible", "brighter_inside"), ("canal", "darker_inside")):
        rel = mesh_map.get(sid)
        if not rel:
            continue
        pts, tri = read_dsvm(results / rel)
        n = vertex_normals(pts, tri)
        rng = np.random.default_rng(7)
        pick = rng.choice(len(pts), size=min(20000, len(pts)), replace=False)
        p, nn = pts[pick], n[pick]

        def agreement(shift):
            q = p + shift
            vin, ok1 = trilinear(grid, origin, direction, spacing, q - 0.6 * nn)
            vout, ok2 = trilinear(grid, origin, direction, spacing, q + 0.6 * nn)
            ok = ok1 & ok2
            diff = (vin - vout)[ok]
            frac = float(np.mean(diff > 0)) if want == "brighter_inside" else float(np.mean(diff < 0))
            return frac, diff, int(ok.sum())

        frac, diff, n_ok = agreement(np.zeros(3))

        # Where the steepest intensity edge lies along each vertex normal, -2..+2 mm: how far
        # the segmentation's surface sits from the scan's own edge (information, not a gate -
        # it is a property of the segmentation, which the headset shows as it is).
        steps = np.arange(-2.0, 2.0001, 0.1)
        sub = p[:4000], nn[:4000]
        prof = np.stack([trilinear(grid, origin, direction, spacing, sub[0] + t * sub[1])[0] for t in steps], axis=1)
        grad = np.abs(np.diff(prof, axis=1))
        edge_at = (steps[:-1] + 0.05)[np.argmax(grad, axis=1)]
        # The same surface moved 1.2 mm along each patient axis: a registered surface must
        # agree with the scan clearly better than any of these.
        shifted = [round(agreement(np.eye(3)[a] * sgn * 1.2)[0], 4) for a in range(3) for sgn in (-1, 1)]
        out[sid] = {"expect": want, "fraction_agreeing": round(frac, 4),
                    "shifted_1p2mm": shifted,
                    "edge_offset_mm": {"median": round(float(np.median(edge_at)), 2),
                                       "p25": round(float(np.percentile(edge_at, 25)), 2),
                                       "p75": round(float(np.percentile(edge_at, 75)), 2)},
                    "median_inside_minus_outside": round(float(np.median(diff)), 1), "vertices": n_ok}
    return out


def bake(results: Path, write: bool) -> dict:
    t0 = time.time()
    disp_meta = json.loads((results / "volume" / "meta.json").read_text())
    report = json.loads((results / "report.json").read_text())
    mesh_frame = (report.get("meshes") or {}).get("frame")
    grid, origin, direction, spacing, window, n = read_series(results / "rtstruct" / "derived")
    info = {"job": results.name, "dimensions": [int(grid.shape[2]), int(grid.shape[1]), int(grid.shape[0])],
            "spacing": [round(float(s), 6) for s in spacing]}

    err = check_frame(origin, direction, spacing, disp_meta, mesh_frame)
    info["frame_errors"] = err
    frame_ok = (err["origin_vs_display_mm"] < 1e-3 and err["direction_vs_display"] < 1e-6 and
                err["spacing_vs_display_mm"] < 1e-4 and
                err.get("origin_vs_mesh_frame_mm", 0) < 1e-3 and err.get("index_matrix_vs_mesh_frame_mm", 0) < 1e-3)
    disp = check_display(grid, disp_meta, (results / "volume" / "image.raw").read_bytes())
    info["display"] = disp
    miss = 1.0 - disp.get("exact_fraction", 0.0)
    disp_ok = ("error" not in disp and disp["max_level_difference"] <= 1 and disp["exact_fraction"] >= 0.95 and
               len(disp["mismatch_shifted_one_voxel_zyx"]) == 3 and
               min(disp["mismatch_shifted_one_voxel_zyx"]) >= 10 * max(miss, 1e-3))
    mesh_map = ((report.get("outputs") or {}).get("mesh")) or {}
    reg = check_registration(grid, origin, direction, spacing, results, mesh_map)
    info["registration"] = reg
    # A gross error (a flipped or swapped axis, a millimetre shift) is caught by the canal:
    # a thin tube, so only the registered surface has its lumen darker all the way round.
    # The mandible cannot discriminate - a thick bone stays "brighter inside" under a shift.
    canal, mand = reg.get("canal"), reg.get("mandible")
    reg_ok = (canal["fraction_agreeing"] >= 0.7 and canal["fraction_agreeing"] >= max(canal["shifted_1p2mm"]) + 0.03
              if canal else bool(mand) and mand["fraction_agreeing"] >= 0.6)

    ok = frame_ok and disp_ok and reg_ok
    info["verified"] = ok
    if not ok or not write:
        info["written"] = False
        info["seconds"] = round(time.time() - t0, 1)
        return info

    out = results / "volume-hr"
    out.mkdir(exist_ok=True)
    raw = np.ascontiguousarray(grid, dtype="<i2").tobytes()
    sample = grid[::2, ::2, ::2].ravel()
    pct = {str(p): float(np.percentile(sample, p)) for p in (0.5, 1, 5, 25, 50, 75, 95, 99, 99.5, 99.9)}
    meta = {
        "format": FORMAT,
        "dimensions": info["dimensions"],                       # (x, y, z)
        "spacing": [float(s) for s in spacing],                 # (x, y, z) mm
        "origin": [float(v) for v in origin],                   # LPS mm of voxel (0,0,0)'s centre
        "direction": [float(v) for v in direction.ravel()],     # row-major, column j = axis j (volume/meta.json's convention)
        "downsample_factor": 1,
        "image": {"file": "image.raw", "dtype": "int16", "byte_order": "little",
                  "layout": "C order (z, y, x), x fastest", "bytes": len(raw),
                  "sha256": hashlib.sha256(raw).hexdigest(),
                  "rescale": {"slope": 1.0, "intercept": 0.0},
                  "window": {"width": window[0], "level": window[1]},
                  "min": int(grid.min()), "max": int(grid.max()), "percentiles": pct},
        "source": {"series": "rtstruct/derived", "slices": n},
        "verified": {"frame": err, "display": disp, "registration": reg},
        "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    (out / "image.raw").write_bytes(raw)
    with gzip.open(out / "image.raw.gz.tmp", "wb", compresslevel=6) as fh:
        fh.write(raw)
    os.replace(out / "image.raw.gz.tmp", out / "image.raw.gz")   # after the raw: the route serves the .gz only while it is newer
    (out / "meta.json").write_text(json.dumps(meta, indent=1))
    info["written"] = True
    info["gz_bytes"] = (out / "image.raw.gz").stat().st_size
    info["seconds"] = round(time.time() - t0, 1)
    return info


def main(argv):
    write = "--write" in argv
    jobs = [a for a in argv if not a.startswith("--")]
    roots = sorted(DATA.glob("tenants/*/results/*")) + sorted(DATA.glob("results/*"))
    failed = 0
    for r in roots:
        if not r.is_dir() or (jobs and r.name not in jobs):
            continue
        if not (r / "rtstruct" / "derived").is_dir() or not (r / "volume" / "meta.json").is_file():
            print(json.dumps({"job": r.name, "skipped": "no derived series or display volume"}), flush=True)
            continue
        try:
            info = bake(r, write)
        except Exception as e:     # one bad case must not stop the others
            info = {"job": r.name, "error": f"{type(e).__name__}: {e}"}
        failed += 0 if info.get("verified") else 1
        print(json.dumps(info), flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

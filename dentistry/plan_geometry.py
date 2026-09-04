"""The implant-planning coordinate maps, and the implant solid.

**Numpy-free on purpose.** The API image has neither numpy nor scipy -- see
`requirements-api.txt`, which is a recovery of exactly what the deployed container had
installed -- so anything the `/measure` endpoint executes has to be standard library.
The same functions run under the worker and the phantom suite, which is what stops the
server and the checks drifting into computing different millimetres.

There are two pictures and they are not equally trustworthy, which is the single most
important fact in this module:

**The cross-section is exact.** `worker/panoramic.py` builds each column as
`P0 + t*n` and each row at a fixed height, with `n` having no z-component and
`up = (0, 0, 1)`. So `{n, up}` is an ORTHONORMAL basis and the picture is a genuine
isometric plane section: pixel distance times pitch is true millimetres in any
direction, diagonals included.

**The panoramic is not, and cannot be made to be.** Its horizontal axis is arc length
along the mid-line, swept through a 12 mm curved trough. A straight line between two
points at the same height reads long by roughly `1 + t/R` for a structure at
buccolingual offset `t` on an arch of radius `R` -- up to about 5% at the trough edge on
a tight anterior arch. Only its vertical axis is metric, and `arch.json` says so in
`metric_axes`.

Everything here reads `arch.json` v2 and recomputes nothing that the manifest already
publishes -- `normals` in particular, because `ArchFit.normals()` chooses its sign from
the arch centroid and any reimplementation of that rule is a silent mirror waiting to
happen.
"""

from __future__ import annotations

import math
import struct

# Matches web/app.js. A change here is a change to a published coordinate contract and
# has to move `tests/plan_vectors.json` with it.
#
# `roll_deg` was added to `implant_frame` on 2026-09-04 and this stayed at 1 on purpose:
# the branch is `if rl:`, so a pose that carries no roll -- which is every pose ever
# stored -- produces a bit-identical frame. An additive field whose identity element is
# the old behaviour is not a contract change, and bumping the version would have forced
# a regeneration of vectors about the pixel maps, which this did not touch.
CONTRACT_VERSION = 1


def frame(info: dict) -> dict:
    """The (row, col) -> (t, z) millimetre frame of one jaw's cross-sections."""
    xs = info["cross_sections"]
    t_range = xs.get("t_range_mm") or [-xs["half_width_mm"], xs["half_width_mm"]]
    return {"row_pitch": float(xs["pixel_mm"][0]),
            "col_pitch": float(xs["pixel_mm"][1]),
            "z_top": float(xs["z_top_mm"]),
            "t_min": float(t_range[0])}


def xs_pixel_to_tz(info: dict, row: float, col: float) -> tuple[float, float]:
    """Cross-section pixel -> the arch-frame `(t, z)` pair, in millimetres."""
    f = frame(info)
    return (f["t_min"] + col * f["col_pitch"], f["z_top"] - row * f["row_pitch"])


def xs_pixel_to_lps(info: dict, index: int, row: float, col: float) -> tuple[float, float, float]:
    """Cross-section pixel -> patient LPS millimetres. Exact; see the module docstring."""
    k = info["cross_sections"]["source_indices"][index]
    p0 = info["points"][k]
    n = info["normals"][k]
    t, z = xs_pixel_to_tz(info, row, col)
    return (p0[0] + t * n[0], p0[1] + t * n[1], z)


def xs_distance_mm(info: dict, a: tuple[float, float], b: tuple[float, float]) -> float:
    """Millimetres between two cross-section pixels `(row, col)`.

    True in any direction because the basis is orthonormal. This is the number a ruler
    on that canvas shows, and `web/app.js::rulerLabel` computes it the same way.
    """
    f = frame(info)
    return math.hypot((b[1] - a[1]) * f["col_pitch"], (b[0] - a[0]) * f["row_pitch"])


def pan_pixel_to_lps(info: dict, row: float, col: float) -> tuple[float, float, float]:
    """Panoramic pixel -> LPS. The column IS a polyline index; only the row is metric."""
    pts = info["points"]
    k = max(0, min(int(round(col)), len(pts) - 1))
    p0 = pts[k]
    return (p0[0], p0[1], float(info["panoramic"]["z_top_mm"]) - row * float(info["panoramic"]["pixel_mm"][0]))


def pan_vertical_mm(info: dict, row_a: float, row_b: float) -> float:
    """The only metric measurement the panoramic supports. See the module docstring."""
    return abs(row_b - row_a) * float(info["panoramic"]["pixel_mm"][0])


# --------------------------------------------------------------------------- STL
def write_stl_bytes(triangles) -> bytes:
    """Binary STL from an iterable of 3x3 vertex tuples, in patient LPS millimetres.

    Pure Python because the API cannot import `worker.meshes` (numpy). The phantom suite
    asserts this and `worker.meshes.write_stl` produce byte-identical output for the same
    triangle list, so the two writers cannot drift.
    """
    tris = [tuple(t) for t in triangles]
    out = bytearray(b"\0" * 80)
    out += struct.pack("<I", len(tris))
    for (a, b, c) in tris:
        ux, uy, uz = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
        vx, vy, vz = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
        nx, ny, nz = (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
        ln = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
        out += struct.pack("<3f", nx / ln, ny / ln, nz / ln)
        for v in (a, b, c):
            out += struct.pack("<3f", float(v[0]), float(v[1]), float(v[2]))
        out += struct.pack("<H", 0)
    return bytes(out)


# --------------------------------------------------------------------- implant solid
def implant_mesh(length_mm: float, diameter_mm: float, n_az: int = 48) -> list:
    """A cylinder with an apical hemisphere, as a list of 3x3 vertex tuples.

    Built in the implant's OWN frame -- `+u` runs from the platform toward the apex --
    and transformed to patient LPS by `implant_triangles_lps`. Pure Python because the
    API cannot import `worker.meshes`; a phantom check asserts this and
    `worker.meshes.write_stl` produce byte-identical output for the same triangles, so
    the two writers cannot drift.
    """
    r = diameter_mm / 2.0
    shoulder = max(0.0, length_mm - r)
    ring = lambda u, rad: [(rad * math.cos(2 * math.pi * i / n_az),
                            rad * math.sin(2 * math.pi * i / n_az), u)
                           for i in range(n_az)]
    tris = []
    top, bot = ring(0.0, r), ring(shoulder, r)
    centre_top = (0.0, 0.0, 0.0)
    for i in range(n_az):
        j = (i + 1) % n_az
        tris.append((centre_top, top[j], top[i]))                 # the platform disc
        tris.append((top[i], top[j], bot[j]))                     # the barrel
        tris.append((top[i], bot[j], bot[i]))
    # apical hemisphere
    rings = [bot]
    steps = max(2, n_az // 8)
    for k in range(1, steps + 1):
        th = (k / steps) * (math.pi / 2)
        rings.append(ring(shoulder + r * math.sin(th), r * math.cos(th)))
    for a, b in zip(rings, rings[1:]):
        for i in range(n_az):
            j = (i + 1) % n_az
            tris.append((a[i], a[j], b[j]))
            tris.append((a[i], b[j], b[i]))
    return tris


def _v_unit(v):
    n = math.sqrt(sum(c * c for c in v))
    return tuple(c / n for c in v) if n else v


def _v_cross(u, v):
    return (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0])


def implant_frame(imp: dict, info: dict) -> tuple:
    """`(origin, e1, e2, ax)` in patient LPS: an ORTHONORMAL frame for the pose.

    Derived from `arch.json`'s own `points`, `normals` and (for yaw only) `tangents`
    -- never recomputed -- so the solid lands exactly where the cross-section drew it.
    `ArchFit.normals()` picks its sign by moving away from the arch centroid, and
    reimplementing that rule is a silent mirror waiting to happen.

    **It has to be orthonormal, and it was not.** The previous version used
    `e1 = (n[0], n[1], 0)`, which is the buccal normal itself. Because the published
    normals are in-plane (`arch.py` forces the tangent's z to zero, so `n_z == 0`
    exactly on real data), the axis and that `e1` satisfy

        ax . e1 = sin(tilt) * (n[0]^2 + n[1]^2) = sin(tilt)

    so the two were only perpendicular at zero tilt and the map was a SHEAR. Measured
    on a real arch at 35 degrees, a 10 x 4.1 mm implant: `ax . e1 = +0.5736`, the
    platform disc -- which is one flat face perpendicular to the axis -- spread over
    +-1.17 mm ALONG the axis, and the apex sat at 9.81 mm instead of 10.00. Meanwhile
    `plan_metrics.surface_ring` builds a genuinely orthonormal pair (projection 3e-15,
    radius exact), so the solid that was MEASURED and the solid that was EXPORTED were
    two different solids for any nonzero tilt. Nothing caught it: the STL loads, looks
    like an implant, and is wrong.

    The perpendicular used here is the in-section one that `web/app.js::implantOutline`
    already draws, `p0 = -down*cos(tilt) * n + sin(tilt) * up`. It is exactly
    perpendicular to the axis **even under yaw**, because yaw rotates the axis in the
    plane spanned by the un-yawed axis and the tangent, and `p0` is orthogonal to both:

        p0 . ax = cos(yaw) * [ (-down cos t)(sin t) + (sin t)(down cos t) ] = 0

    which is why the tilt-only case needs no tangent at all.
    """
    pts, nrm = info["points"], info["normals"]
    step = float(info["step_mm"])
    s0 = int(info["s0_index"])
    idx = max(0, min(int(round(imp["s_mm"] / step + s0)), len(pts) - 1))
    p0v, n = pts[idx], _v_unit(nrm[idx])
    up = (0.0, 0.0, 1.0)
    down = 1.0 if imp["jaw"] == "maxilla" else -1.0
    tl = math.radians(imp.get("tilt_deg", 0.0) or 0.0)
    yw = math.radians(imp.get("yaw_deg", 0.0) or 0.0)
    st, ct, sy, cy = math.sin(tl), math.cos(tl), math.sin(yw), math.cos(yw)

    # The apical direction, component-for-component the same pose as
    # `plan_metrics.Implant.axis()` reads in the (s, t, z) frame: s -> tangent,
    # t -> buccal normal, z -> up. A disagreement here would place the exported solid
    # somewhere the measurement never looked.
    ax = tuple(st * cy * n[k] + down * ct * cy * up[k] for k in range(3))
    if sy:
        tan = info.get("tangents")
        if not tan:
            # Refuse rather than guess. The tangent could be had as `up x n` up to a
            # sign, but that sign is not reliable: measured across five real cases, the
            # handedness of the published normals relative to the published tangents
            # FLIPS at the extreme ends of the arch on 2 of 10 jaw fits (15 of 274
            # indices, s = +-59..65 mm, out past the third molar). Deriving it would
            # mirror the yaw exactly there.
            raise ValueError(
                "this arch manifest publishes no tangents, so a yawed implant cannot "
                "be placed: yaw rotates toward +s and +s is what the tangent defines")
        t_hat = _v_unit(tan[idx])
        ax = tuple(sy * t_hat[k] + ax[k] for k in range(3))
    ax = _v_unit(ax)

    e1 = _v_unit(tuple(-down * ct * n[k] + st * up[k] for k in range(3)))
    e2 = _v_unit(_v_cross(ax, e1))

    # CLOCKING. `roll_deg` spins the frame about its own axis, which leaves `ax`
    # untouched and therefore leaves every measured distance untouched -- the solid is
    # a body of revolution about `ax`. It is applied here and nowhere else because the
    # only thing that can see it is a renderer with a non-symmetric mesh: the drawn
    # screw's connection hex, and one day an indexed abutment. Applying it to `(e1, e2)`
    # keeps the pair orthonormal by construction, so the frame contract is unchanged.
    rl = math.radians(imp.get("roll_deg", 0.0) or 0.0)
    if rl:
        cr, sr = math.cos(rl), math.sin(rl)
        e1, e2 = (tuple(cr * e1[k] + sr * e2[k] for k in range(3)),
                  tuple(-sr * e1[k] + cr * e2[k] for k in range(3)))
    origin = (p0v[0] + imp["t_mm"] * n[0], p0v[1] + imp["t_mm"] * n[1], imp["z_mm"])
    return origin, e1, e2, ax


def implant_axis_lps(imp: dict, info: dict) -> tuple:
    """The CAPSULE's axis segment endpoints in patient LPS millimetres.

    Exact only for zero yaw, which is why `implant_frame` refuses a yawed implant with
    no published tangent: a yawed axis is straight in `(s, t, z)` and CURVED in LPS.
    """
    origin, _, _, ax = implant_frame(imp, info)
    span = max(0.0, float(imp["length_mm"]) - float(imp["diameter_mm"]) / 2.0)
    return origin, tuple(origin[k] + ax[k] * span for k in range(3))


def segment_segment_distance(p0, p1, q0, q1) -> tuple:
    """Closest approach between two segments: `(distance, s_star, t_star)`.

    The standard clamped parametric solve (Ericson, *Real-Time Collision Detection*
    5.1.9): solve the unclamped 2x2 system, clamp each parameter to [0, 1], then
    re-solve the other against its clamp, with the parallel case caught by the
    denominator test. Closed form, no iteration, pure stdlib.
    """
    d1 = [p1[k] - p0[k] for k in range(3)]
    d2 = [q1[k] - q0[k] for k in range(3)]
    r = [p0[k] - q0[k] for k in range(3)]
    dot = lambda a, b: sum(x * y for x, y in zip(a, b))
    a, e, f = dot(d1, d1), dot(d2, d2), dot(d2, r)
    EPS = 1e-12

    if a <= EPS and e <= EPS:                       # both degenerate to points
        return math.sqrt(dot(r, r)), 0.0, 0.0
    if a <= EPS:
        s_st, t_st = 0.0, min(1.0, max(0.0, f / e))
    else:
        c = dot(d1, r)
        if e <= EPS:
            t_st, s_st = 0.0, min(1.0, max(0.0, -c / a))
        else:
            b = dot(d1, d2)
            denom = a * e - b * b
            s_st = min(1.0, max(0.0, (b * f - c * e) / denom)) if denom > EPS else 0.0
            t_st = (b * s_st + f) / e
            if t_st < 0.0:
                t_st, s_st = 0.0, min(1.0, max(0.0, -c / a))
            elif t_st > 1.0:
                t_st, s_st = 1.0, min(1.0, max(0.0, (b - c) / a))
    c1 = [p0[k] + d1[k] * s_st for k in range(3)]
    c2 = [q0[k] + d2[k] * t_st for k in range(3)]
    diff = [c1[k] - c2[k] for k in range(3)]
    return math.sqrt(dot(diff, diff)), s_st, t_st


def implant_triangles_lps(imp: dict, info: dict) -> list:
    """Place an arch-frame implant into patient LPS, using the PUBLISHED polyline."""
    origin, e1, e2, ax = implant_frame(imp, info)

    def to_lps(v):
        return tuple(origin[k] + v[0] * e1[k] + v[1] * e2[k] + v[2] * ax[k]
                     for k in range(3))

    return [tuple(to_lps(v) for v in tri)
            for tri in implant_mesh(imp["length_mm"], imp["diameter_mm"])]

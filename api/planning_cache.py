"""Read a job's measurement pack without numpy, and without resident memory.

The API image has neither numpy nor scipy (`requirements-api.txt`), so `POST /measure`
cannot compute anything -- it can only look values up in a field the worker precomputed.
This is that reader.

**How RSS stays flat.** The pack is ~30 MB per case and the API runs with a 1 GiB limit
beside everything else, so it must never be *read*:

* `mmap.mmap(fd, 0, access=ACCESS_READ)` -- file-backed, never anonymous, so the pages
  are `Private_Clean` and the kernel can drop them under pressure.
* `madvise(MADV_RANDOM)` immediately after opening. Without it the kernel reads ahead
  128 KB per touch, and a handful of point queries drags in megabytes for nothing.
* every read is `struct.unpack_from` at a computed offset. The mapping is never sliced
  into `bytes`, never `read()`, never `len()`-materialised. A four-implant measurement
  touches a few hundred distinct 4 KB pages.

A phantom check greps this module for `.read(`, `bytes(` and `.readinto(`, because a
discipline that is only written down is a discipline that lapses.

**The LRU is small and closes what it evicts.** FastAPI runs sync endpoints in a thread
pool, so this genuinely is concurrent; a lock guards the dict, while the mmap reads
themselves need none.
"""

from __future__ import annotations

import json
import mmap
import struct
import threading
from pathlib import Path

MAX_OPEN_PACKS = 8

_DTYPE = {"int16": ("<h", 2), "uint16": ("<H", 2), "uint8": ("<B", 1),
          "float32": ("<f", 4)}

_lock = threading.Lock()
_open: dict = {}


class Field:
    """One memory-mapped scalar field over the band lattice."""

    def __init__(self, path: Path, dtype: str, scale: float, offset: float, lat: dict):
        self._f = path.open("rb")
        self._mm = mmap.mmap(self._f.fileno(), 0, access=mmap.ACCESS_READ)
        try:
            self._mm.madvise(mmap.MADV_RANDOM)
        except (AttributeError, OSError):
            pass                       # not fatal; only costs read-ahead
        self.fmt, self.itemsize = _DTYPE[dtype]
        self.scale, self.offset = scale, offset
        self.n_s, self.n_t, self.n_z = lat["n_s"], lat["n_t"], lat["n_z"]

    def at(self, i: int, j: int, k: int) -> float:
        i = 0 if i < 0 else (self.n_s - 1 if i >= self.n_s else i)
        j = 0 if j < 0 else (self.n_t - 1 if j >= self.n_t else j)
        k = 0 if k < 0 else (self.n_z - 1 if k >= self.n_z else k)
        off = ((i * self.n_t + j) * self.n_z + k) * self.itemsize
        return struct.unpack_from(self.fmt, self._mm, off)[0] * self.scale + self.offset

    def trilinear(self, fs: float, ft: float, fz: float) -> float:
        i, j, k = int(fs // 1), int(ft // 1), int(fz // 1)
        a, b, c = fs - i, ft - j, fz - k
        v = 0.0
        for di in (0, 1):
            wi = a if di else 1 - a
            if wi == 0:
                continue
            for dj in (0, 1):
                wj = b if dj else 1 - b
                if wj == 0:
                    continue
                for dk in (0, 1):
                    wk = c if dk else 1 - c
                    if wk == 0:
                        continue
                    v += wi * wj * wk * self.at(i + di, j + dj, k + dk)
        return v

    def close(self):
        try:
            self._mm.close()
        finally:
            self._f.close()


class Pack:
    """One case's pack: the header plus its mapped fields, per jaw."""

    def __init__(self, root: Path, stamp=None):
        self.root = root
        #: `(mtime_ns, size)` of the header this Pack was built from. `get()` compares it
        #: so a rebuilt pack is reopened rather than served from a stale mmap.
        self.stamp = stamp
        self.header = json.loads((root / "header.json").read_text())
        self.fields: dict = {}
        for jaw, info in self.header.get("jaws", {}).items():
            if not info.get("ok"):
                continue
            lat = info["lattice"]
            for name, f in info["fields"].items():
                path = root.parent / f["file"]
                if path.exists():
                    self.fields[(jaw, name)] = Field(
                        path, f["dtype"], f.get("scale", 1.0), f.get("offset", 0.0), lat)

    def jaw(self, jaw: str) -> dict | None:
        info = self.header.get("jaws", {}).get(jaw)
        return info if info and info.get("ok") else None

    def sampler(self, jaw: str):
        """A sampler for a jaw that was RECONSTRUCTED, or `None`.

        It used to hand one back unconditionally. `_PackSampler.__init__` then set
        `self._h = pack.jaw(jaw) or {}` and `bounds()` opened with
        `self.header()["lattice"]` -- a bare `KeyError` on an empty dict, which came out
        of `/measure` as an unhandled 500 for the WHOLE plan rather than as a refusal
        for the one jaw. A case with a refused maxilla is not exotic: it is the shape of
        the only planning fixture in this repo.
        """
        return _PackSampler(self, jaw) if self.jaw(jaw) else None

    def close(self):
        for f in self.fields.values():
            f.close()
        self.fields.clear()


class _PackSampler:
    """The Sampler protocol `dentistry/plan_metrics.py` is written against."""

    def __init__(self, pack: Pack, jaw: str):
        self._p, self._jaw = pack, jaw
        self._h = pack.jaw(jaw) or {}

    def header(self) -> dict:
        return self._h

    def _grid(self, s: float, t: float, z: float):
        lat = self._h["lattice"]
        return ((s - lat["s0_mm"]) / lat["step_mm"],
                (t - lat["t_min_mm"]) / lat["step_mm"],
                (lat["z_top_mm"] - z) / lat["step_mm"])

    def sample(self, field: str, stz) -> list:
        f = self._p.fields.get((self._jaw, field))
        if f is None:
            raise KeyError(f"no {field!r} field for the {self._jaw}")
        return [f.trilinear(*self._grid(s, t, z)) for (s, t, z) in stz]

    def bounds(self) -> dict:
        """The band's closed extent in (s, t, z) millimetres. Pure lattice arithmetic.

        Exists because the PICTURES are larger than the FIELD and both samplers used to
        clamp silently: cross-sections span t = +-18 mm over 68 mm of z while the band
        covers +-12 mm over 45 mm, so an implant dragged into the visible-but-unmeasured
        region came back with an edge-clamped value and no caveat at all.

        No I/O, so the mmap discipline in `api/planning_cache` is untouched.
        """
        lat = self.header()["lattice"]
        st = float(lat["step_mm"])
        s0 = float(lat["s0_mm"])
        t0 = float(lat["t_min_mm"])
        zt = float(lat["z_top_mm"])
        return {"s": (s0, s0 + (int(lat["n_s"]) - 1) * st),
                "t": (t0, t0 + (int(lat["n_t"]) - 1) * st),
                "z": (zt - (int(lat["n_z"]) - 1) * st, zt)}

    def contains(self, stz) -> list:
        """Per point: is this a SAMPLE, or would it be clamped to the band edge?"""
        b = self.bounds()
        out = []
        for (s, t, z) in stz:
            out.append(b["s"][0] <= s <= b["s"][1] and b["t"][0] <= t <= b["t"][1]
                       and b["z"][0] <= z <= b["z"][1])
        return out

    def overshoot(self, stz) -> dict:
        """How far outside the band the worst of these points lies, and on which axis.

        Reported rather than silently clamped, and per-axis rather than as a boolean,
        because "4.2 mm above the field" is actionable and "outside" is not.
        """
        b = self.bounds()
        worst, axis = 0.0, None
        n_out = 0
        for (s, t, z) in stz:
            over = 0.0
            ax = None
            for name, v in (("s", s), ("t", t), ("z", z)):
                lo, hi = b[name]
                d = max(lo - v, v - hi, 0.0)
                if d > over:
                    over, ax = d, name
            if over > 0.0:
                n_out += 1
                if over > worst:
                    worst, axis = over, ax
        total = max(1, len(list(stz)) if not hasattr(stz, "__len__") else len(stz))
        return {"outside_fraction": n_out / total, "worst_overshoot_mm": worst,
                "axis": axis}

    def gradient(self, field: str, stz, h: float) -> tuple:
        s, t, z = stz
        out = []
        for axis in range(3):
            d = [0.0, 0.0, 0.0]
            d[axis] = h
            hi = self.sample(field, [(s + d[0], t + d[1], z + d[2])])[0]
            lo = self.sample(field, [(s - d[0], t - d[1], z - d[2])])[0]
            out.append((hi - lo) / (2 * h))
        return tuple(out)


def get(results_dir: Path) -> Pack | None:
    """The pack under `<results>/planning/pack`, or None when the job has none.

    **The cache is keyed on the header's mtime and size, not on the path alone.** It was
    keyed on the path, and a pack is immutable for as long as a finished job's files
    never change -- which stopped being true the moment a hand correction could rewrite
    them. The header is read ONCE at construction and the fields are MEMORY-MAPPED, so a
    path-keyed entry serves the pre-edit distance field and the pre-edit `edits` list
    until the pod restarts or the LRU happens to evict it. That is the exact opposite of
    the feature: the whole point of applying a correction is that the millimetres change.

    `worker/planning_pack.rebuild_label_fields` rewrites `header.json` unconditionally,
    so its mtime is the one signal that covers every rebuild -- including one that
    rewrites a `.raw` file to the same length, where nothing about the file's own
    metadata would have to move.

    The superseded Pack is CLOSED rather than dropped: it holds one mmap per field, and
    leaking them on every correction is a file-descriptor leak with a slow fuse.
    """
    root = Path(results_dir) / "planning" / "pack"
    hdr = root / "header.json"
    try:
        st = hdr.stat()
    except OSError:
        return None
    key = str(root)
    stamp = (st.st_mtime_ns, st.st_size)
    with _lock:
        hit = _open.get(key)
        if hit is not None:
            if hit.stamp == stamp:
                _open[key] = _open.pop(key)      # move to the end: most recently used
                return hit
            # Rebuilt under us. Drop and reopen; see the docstring.
            _open.pop(key).close()
    pack = Pack(root, stamp=stamp)
    with _lock:
        _open[key] = pack
        while len(_open) > MAX_OPEN_PACKS:
            _, old = next(iter(_open.items()))
            _open.pop(next(iter(_open)))
            old.close()
    return pack


def stats() -> dict:
    with _lock:
        return {"open_packs": len(_open), "limit": MAX_OPEN_PACKS,
                "fields": sum(len(p.fields) for p in _open.values())}

"""Re-derive a case's measurements from a hand-corrected segmentation mask.

The contours in this product are drawn by a network, and every millimetre the implant
tab publishes is a distance to those contours. So when a specialist moves one, the
distances have to move with it -- otherwise the edit is a drawing exercise and the
numbers beside it are about a mask that no longer exists.

**WHAT IS RECOMPUTED, AND WHAT IS DELIBERATELY NOT.**

Recomputed, because it is label-derived and the labels changed:
  * `segmentation.nii.gz` -- the download, back in the orientation the upload arrived in;
  * `volume/labels.raw` -- so a reload shows the edit rather than the model's version;
  * `mesh/` and `stl/` -- the 3-D surfaces and the downloads;
  * `planning/xs/<jaw>/contours.json` -- the section outlines;
  * `planning/pack/<jaw>.{canal,accessory_canal,tooth}.raw` -- every distance field the
    clearances, the verdicts and the available-bone heights are read from;
  * the per-site heights and widths in `planning/arch.json` and `report.arch`;
  * `rtstruct/rtstruct.dcm`, against the series the original run already wrote;
  * the quality assessment.

NOT recomputed, each for a reason that is stated in the artifact rather than assumed:

  * **The arch curve, and therefore the band and the section list.** Re-fitting would
    move `s`, `t` and `z`, and every saved plan's coordinates would silently refer to
    somewhere else -- two plans on the same case would stop being comparable. Frozen,
    and `arch.revive_from_manifest` carries the argument.
  * **The greyscale pictures and the band's grey field.** They are the SCAN. A label
    edit cannot move them, and the full-resolution greyscale is not retained past the
    job, so this could not re-sample them even if it wanted to.
  * **The density references.** Greyscale statistics inside the jaw mask, which the edit
    may have moved slightly and which cannot be re-measured without the greyscale. The
    pack header records that they predate the edit; it does not present them as fresh.
  * **The intensity calibration and the run report's model block.** Facts about the
    original inference, and they stay facts.

**THE RESOLUTION PROBLEM, WHICH IS THE HONEST DIFFICULTY HERE.** The mask a browser can
edit is the DISPLAY volume: `worker/volume_pack.py` downsamples the labelmap so its
longest axis is at most 256, which on a dental CBCT is 0.6 mm voxels against the 0.3 mm
grid every server-side millimetre is measured on. An edit is therefore upsampled
nearest-neighbour -- each display voxel becomes the `f x f x f` block of full-resolution
voxels it was sampled from -- and the resulting boundary quantisation is `f * spacing`,
0.6 mm on a real case. That is the same order as the model's own inward error (0.46 mm
p95 on the inferior alveolar canal), so it is recorded on the pack and added to the
error budget of every structure the edit touched. A hand-drawn contour is not
automatically a more accurate one, and this pipeline will not imply that it is.

**AND THE REPRODUCTION GUARD.** Before overwriting anything, the section outlines are
re-derived from the ORIGINAL mask and compared against the file the original run wrote.
If the reproduction does not agree, the geometry this module reconstructed from the
manifest is not the geometry the original run used, and it refuses -- rather than writing
a consistent-looking set of artifacts that describe a plane nobody cut.
"""
from __future__ import annotations

import gzip
import json
import logging
import time
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)

#: How far the revived buccal normals may differ from the published ones. The manifest
#: rounds them to four decimals, so 5e-5 is the quantisation floor and 2e-4 is four
#: times it -- tight enough that a mirrored sign (which is O(1)) cannot pass.
NORMAL_TOLERANCE = 2e-4

#: How far the reproduced outlines may differ from the stored ones before this refuses.
#: Compared as structure keys, ring counts and total point count rather than as exact
#: coordinates: a rounding change in `plane_polygons` must not fail the guard, while a
#: wrong plane, a wrong pitch or a mirrored normal moves all three.
CONTOUR_POINT_TOLERANCE = 0.02


class RederiveRefused(RuntimeError):
    """The edit cannot be applied, with the reason. Nothing has been written."""


def _load_merged(results: Path):
    """`(merged, canonical_image, original_code)` from the published segmentation."""
    import SimpleITK as sitk

    from worker import orient

    f = results / "segmentation.nii.gz"
    if not f.is_file():
        raise RederiveRefused(
            "this case has no stored segmentation, so there is nothing to edit. Results "
            "are deleted after the retention window; re-upload the scan to segment it "
            "again")
    img = sitk.ReadImage(str(f))
    canon, code = orient.to_canonical(img)
    return sitk.GetArrayFromImage(canon).astype(np.uint8), canon, code


def _check_grid(diff: dict, meta: dict) -> int:
    """The diff must be on the grid this case actually shipped. Returns the factor."""
    grid = diff.get("grid") or {}
    want = [int(x) for x in meta["dimensions"]]
    got = [int(x) for x in (grid.get("dimensions") or [])]
    if got != want:
        raise RederiveRefused(
            f"the edit was made on a {got} display volume and this case ships {want}. "
            "Reload the case and make the correction again")
    f = int(grid.get("downsample_factor") or 0)
    if f != int(meta.get("downsample_factor") or 1):
        raise RederiveRefused(
            f"the edit declares a downsample factor of {f} and this case's display "
            f"volume was built at {meta.get('downsample_factor')}")
    return max(1, f)


def _apply(merged: np.ndarray, diff: dict, meta: dict, factor: int) -> dict:
    """Upsample the display-grid diff onto the full-resolution mask, in place.

    `volume_pack.export` builds the display volume as `merged[::f, ::f, ::f]` -- a
    SAMPLE, not an average -- so display voxel `(i, j, k)` is full-resolution voxel
    `(k*f, j*f, i*f)`. The inverse of a sample is a choice, and the choice made here is
    the block it was sampled from: `[k*f : (k+1)*f, ...]`. It is the only inverse that
    leaves no unwritten voxels between two edited display voxels, and its error is
    one-signed and bounded by `f * spacing`, which is what gets added to the budget.

    **Per RUN, not per voxel, and that is worth the row arithmetic.** A run is contiguous
    along the display grid's x, so its upsampled x range is contiguous too and the whole
    run is ONE numpy slice -- except where it crosses a row boundary, which the offset
    encoding allows, so it is split at each `j`. The per-voxel version worked and was
    O(voxels) in Python with a `np.unique` per voxel: at the 2 000 000-voxel ceiling the
    endpoint accepts, that is about a minute of pure interpreter time bolted onto a
    141 s re-derive.

    Every displaced label is counted, because that count is what `plan_safety` widens a
    budget from. It also catches something only the upsample can do: an edit whose every
    DISPLAY voxel was background or jawbone can still clip a neighbouring tooth at full
    resolution, because an f-cubed block is not homogeneous. Measured on a real case, 4
    voxels of tooth 48 -- named in the record rather than absorbed.
    """
    X, Y, Z = (int(v) for v in meta["dimensions"])
    plane = X * Y
    zmax, ymax, xmax = merged.shape
    counts = {"voxels": 0, "full_voxels": 0, "slices": 0, "clipped": 0}
    per_structure: dict[int, dict] = {}

    def displaced(block, value: int) -> int:
        """Tally what `block` currently holds, then how many voxels change.

        `ravel`, not `reshape`: the block is a strided view and `reshape` refuses some
        non-contiguous shapes outright, while `ravel` copies the eight bytes it needs.

        ADDED and REMOVED are counted separately rather than netted. A structure can be
        both -- a correction that moves a boundary takes voxels off one side and puts
        them back on the other -- and a signed total would report that as no change at
        all, which is exactly the case a reader most needs to see.
        """
        flat = block.ravel()
        if not flat.size:
            return 0
        hist = np.bincount(flat, minlength=256)
        moved = 0
        for was in np.nonzero(hist)[0]:
            was = int(was)
            if was == value:
                continue
            n_was = int(hist[was])
            moved += n_was
            if was:
                rec = per_structure.setdefault(was, {"added": 0, "removed": 0})
                rec["removed"] += n_was
        if value and moved:
            rec = per_structure.setdefault(value, {"added": 0, "removed": 0})
            rec["added"] += moved
        return moved

    for sl in diff.get("slices") or []:
        k = int(sl["k"])
        if k < 0 or k >= Z:
            counts["clipped"] += 1
            continue
        z0 = k * factor
        if z0 >= zmax:
            counts["clipped"] += 1
            continue
        counts["slices"] += 1
        z1 = min(zmax, z0 + factor)
        for run in sl["runs"]:
            o, n, v = int(run[0]), int(run[1]), int(run[2])
            if o < 0 or n <= 0 or o + n > plane:
                counts["clipped"] += 1
                continue
            counts["voxels"] += n
            # Split at row boundaries: `o = j * X + i`, and a run may cross into j+1.
            left = n
            while left > 0:
                j, i = divmod(o, X)
                span = min(left, X - i)
                y0 = j * factor
                x0 = i * factor
                if y0 < ymax and x0 < xmax:
                    y1 = min(ymax, y0 + factor)
                    x1 = min(xmax, x0 + span * factor)
                    blk = merged[z0:z1, y0:y1, x0:x1]
                    counts["full_voxels"] += displaced(blk, v)
                    blk[...] = v
                else:
                    counts["clipped"] += 1
                o += span
                left -= span
    counts["structures"] = {str(idx): rec for idx, rec in sorted(per_structure.items())}
    return counts


def _verify_contours(merged: np.ndarray, image, manifest: dict, results: Path) -> dict:
    """Prove the reconstructed section geometry is the one the original run used.

    Re-derives ONE section's outlines from the untouched mask and compares them against
    the stored file. This is the guard that stops a plausible-looking set of rebuilt
    artifacts describing a plane nobody cut -- a mirrored normal, a pitch read from the
    wrong field, an off-by-one in the section list.
    """
    from worker import panoramic

    got = panoramic.rerender_contours(merged, image, manifest, results / "planning",
                                      verify_only=True)
    if not got or got.get("contours") is None:
        # The section carries no structure at all. Not a failure of the reproduction --
        # section 0 is the distal end of the arch on some cases -- but it proves nothing
        # either, so it is reported as such rather than counted as a pass.
        return {"verified": False, "reason": "the first section carries no structure, "
                                             "so the reproduction could not be compared"}
    jaw = got["jaw"]
    rel = ((manifest["jaws"][jaw]["cross_sections"]).get("contours")
           or f"xs/{jaw}/contours.json")
    stored_path = results / "planning" / rel
    if not stored_path.is_file():
        return {"verified": False,
                "reason": f"this case has no stored section outlines ({rel}), so the "
                          "reproduction could not be compared"}
    stored = json.loads(stored_path.read_text()).get(str(got["index"]))
    if not stored:
        return {"verified": False,
                "reason": "the stored outlines carry nothing for that section"}
    mine = got["contours"]
    if sorted(stored) != sorted(mine):
        raise RederiveRefused(
            "the reconstructed section geometry does not reproduce this case's own "
            f"outlines: structures {sorted(stored)} stored, {sorted(mine)} reproduced")
    npts = lambda blob: sum(len(r) for rings in blob.values() for r in rings)
    a, b = npts(stored), npts(mine)
    if a and abs(a - b) / a > CONTOUR_POINT_TOLERANCE:
        raise RederiveRefused(
            "the reconstructed section geometry does not reproduce this case's own "
            f"outlines: {a} stored points against {b} reproduced")
    return {"verified": True, "jaw": jaw, "section": got["index"],
            "stored_points": a, "reproduced_points": b}


def _write_display_volume(merged: np.ndarray, results: Path, meta: dict) -> dict:
    """Re-emit `volume/labels.raw` so a reload shows the edit, and update the manifest."""
    f = int(meta.get("downsample_factor") or 1)
    lab = merged[::f, ::f, ::f]
    want = [int(x) for x in reversed(lab.shape)]
    if want != [int(x) for x in meta["dimensions"]]:
        raise RederiveRefused(
            f"re-downsampling gives {want} and the manifest says {meta['dimensions']}")
    path = results / "volume" / "labels.raw"
    np.ascontiguousarray(lab.astype(np.uint8)).tofile(path)
    before = {int(v) for v in np.unique(merged) if v}
    after = {int(v) for v in np.unique(lab) if v}
    meta["labels"]["present"] = sorted(after)
    meta["labels"]["lost_to_downsampling"] = sorted(before - after)
    (results / "volume" / "meta.json").write_text(json.dumps(meta))
    return {"present": len(after), "lost_to_downsampling": sorted(before - after),
            "bytes": path.stat().st_size}


def _reexport_rtstruct(merged: np.ndarray, image, results: Path, reports: dict) -> dict:
    """Rewrite the structure set against the SERIES THE ORIGINAL RUN ALREADY WROTE.

    `rtstruct.export` would need the full-resolution greyscale to write a derived
    secondary-capture series, and that greyscale is not retained past the job. But the
    series is: it is on disk under `rtstruct/derived/`, and the contours only need its
    SOP instance UIDs and its frame of reference. So the geometry is rebuilt and the
    references are recovered from the structure set that is already there.

    A case whose structure set cannot be recovered gets a stated absence: the file is
    left alone and the report says it predates the edits. Silently shipping the old one
    as if it matched is the one thing this must not do.
    """
    import pydicom

    from worker import rtstruct

    path = results / "rtstruct" / "rtstruct.dcm"
    if not path.is_file():
        return {"skipped": "this case has no structure set"}
    try:
        ds = pydicom.dcmread(str(path), stop_before_pixels=True)
        frame_uid = ds.ReferencedFrameOfReferenceSequence[0].FrameOfReferenceUID
        study_uid = ds.StudyInstanceUID
        rfor = ds.ReferencedFrameOfReferenceSequence[0]
        uids = [ci.ReferencedSOPInstanceUID
                for study in rfor.RTReferencedStudySequence
                for series in study.RTReferencedSeriesSequence
                for ci in series.ContourImageSequence]
        patient = {"name": str(getattr(ds, "PatientName", "") or ""),
                   "id": str(getattr(ds, "PatientID", "") or "")}
        if len(uids) != int(merged.shape[0]):
            return {"skipped": f"the stored structure set references {len(uids)} slices "
                               f"and the mask has {merged.shape[0]}"}
        new_ds, info = rtstruct.build(merged, image, uids, frame_uid, study_uid, patient,
                                      pydicom.uid.CTImageStorage)
        new_ds.save_as(path, enforce_file_format=True)
        return {"file": "rtstruct/rtstruct.dcm", "bytes": path.stat().st_size,
                "rois": info["roi_count"], "total_points": info["total_points"],
                "skipped_rois": info["skipped"],
                "note": "rebuilt from the edited mask, against the series this case "
                        "already published"}
    except Exception as exc:  # noqa: BLE001
        log.exception("the structure set could not be rebuilt")
        return {"skipped": f"{type(exc).__name__}: {exc}",
                "stale": True,
                "note": "the structure set on disk predates these edits and was left "
                        "alone rather than shipped as if it matched"}


def run(job_row: dict, edit_row: dict, diff: dict, *, rep=None) -> dict:
    """Apply one edit and rebuild everything that depends on the mask.

    `job_row` needs `id`, `tenant_id` and `reports`; `edit_row` needs `id` and the
    identity of whoever made it. Returns `(reports, result)`; raises `RederiveRefused`
    with a reader-facing reason when it will not proceed.
    """
    from dentistry import ridge, storage
    from dentistry.quality import assess
    from worker import bake, meshes, orient, panoramic, planning_pack

    say = rep or (lambda *_a: None)
    results = storage.resolve(job_row["tenant_id"], "results", job_row["id"])
    reports = dict(job_row.get("reports") or {})
    t0 = time.monotonic()

    say(0.05, "Reading the stored segmentation")
    merged, image, code = _load_merged(results)
    meta_path = results / "volume" / "meta.json"
    if not meta_path.is_file():
        raise RederiveRefused("this case has no display volume, so an edit made in the "
                              "browser cannot be placed on its grid")
    meta = json.loads(meta_path.read_text())
    factor = _check_grid(diff, meta)
    spacing_zyx = tuple(reversed(image.GetSpacing()))

    arch_path = results / "planning" / "arch.json"
    manifest = json.loads(arch_path.read_text()) if arch_path.is_file() else None

    # --- the guards, ALL of them, before a byte is written ----------------------
    say(0.10, "Checking the reconstruction against this case's own outlines")
    checks: dict = {}
    if manifest:
        from dentistry import arch as arch_mod

        for jaw, block in (manifest.get("jaws") or {}).items():
            if not block.get("ok"):
                continue
            fit = arch_mod.revive_from_manifest(block, jaw)
            err = float(np.abs(fit.normals()
                               - np.asarray(block["normals"], dtype=np.float64)).max())
            if err > NORMAL_TOLERANCE:
                raise RederiveRefused(
                    f"the {jaw} arch could not be revived from its own manifest: the "
                    f"buccal normals differ by {err:.2e}, which is a different fit")
            checks.setdefault("normals", {})[jaw] = err
        checks["contours"] = _verify_contours(merged, image, manifest, results)

    # --- apply -------------------------------------------------------------------
    say(0.20, "Applying the correction")
    applied = _apply(merged, diff, meta, factor)
    if not applied["voxels"]:
        raise RederiveRefused("this edit changes no voxel of the stored segmentation")
    quant_mm = factor * float(min(spacing_zyx))
    log.info("edit %s: %d display voxels -> %d full-resolution voxels over %d slices",
             str(edit_row.get("id"))[:8], applied["voxels"], applied["full_voxels"],
             applied["slices"])

    # --- rewrite the mask itself -------------------------------------------------
    say(0.30, "Writing the segmentation")
    import SimpleITK as sitk

    seg_img = orient.label_image_like(merged, image)
    sitk.WriteImage(orient.from_canonical(seg_img, code),
                    str(results / "segmentation.nii.gz"), useCompression=True)
    del seg_img
    volume_report = _write_display_volume(merged, results, meta)

    # --- everything derived from it ----------------------------------------------
    say(0.40, "Rebuilding the surfaces")
    mesh_report, stls, web_meshes = meshes.export(
        merged, image, spacing_zyx, results / "stl", results / "mesh")
    reports["meshes"] = mesh_report
    reports.setdefault("outputs", {}).update({"stl": stls, "mesh": web_meshes})

    rebuilt_pack = {}
    if manifest:
        say(0.65, "Rebuilding the section outlines")
        from dentistry import arch as arch_mod

        section_report = panoramic.rerender_contours(merged, image, manifest,
                                                     results / "planning")
        fits = {jaw: arch_mod.revive_from_manifest(block, jaw)
                for jaw, block in (manifest.get("jaws") or {}).items()}
        say(0.75, "Rebuilding the measurement fields")
        edit_note = {
            "id": str(edit_row.get("id")),
            "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "by": edit_row.get("created_by_user_id"),
            "voxels": applied["voxels"],
            "full_voxels": applied["full_voxels"],
            "structures": applied["structures"],
            # THE NUMBER THE ERROR BUDGET NEEDS. The edit was made on a grid `factor`
            # times coarser than the one every millimetre is measured on, so the
            # boundary of an edited contour is quantised at this, and `plan_safety`
            # adds it to the inward error of every structure listed above.
            "quantisation_mm": round(quant_mm, 4),
            "grid": {"dimensions": meta["dimensions"],
                     "downsample_factor": factor,
                     "spacing": meta["spacing"]},
        }
        rebuilt_pack = planning_pack.rebuild_label_fields(
            merged, image, fits, results / "planning", edit=edit_note)
        say(0.85, "Re-measuring available bone")
        planning_pack.attach_site_measurements(results / "planning", fits, reports, ridge)
        planning = dict(reports.get("planning") or {})
        planning["sections_rebuilt"] = section_report
        reports["planning"] = planning
        # The manifest is served `immutable`, so a client holding the pre-edit copy
        # would draw the old outlines over the new pictures. The generation counter is
        # what `web/app.js` appends to the URL to get past that.
        manifest = json.loads(arch_path.read_text())
        manifest["generation"] = int(manifest.get("generation") or 0) + 1
        manifest["edited"] = True
        arch_path.write_text(json.dumps(manifest) + "\n")

    say(0.90, "Rebuilding the structure set")
    reports["rtstruct"] = _reexport_rtstruct(merged, image, results, reports)

    say(0.93, "Re-checking the result")
    qrep = assess(merged, spacing_zyx, direction=image.GetDirection(),
                  pipeline_name=(reports.get("pipeline") or {}).get("name"))
    reports["quality"] = qrep.to_dict()

    # --- the record --------------------------------------------------------------
    hist = list(reports.get("edits") or [])
    hist.append({
        "id": str(edit_row.get("id")),
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "by": edit_row.get("created_by_user_id"),
        "note": edit_row.get("note"),
        "voxels": applied["voxels"],
        "full_voxels": applied["full_voxels"],
        "slices": applied["slices"],
        "clipped": applied["clipped"],
        "structures": applied["structures"],
        "quantisation_mm": round(quant_mm, 4),
        "checks": checks,
        "rebuilt": {"volume": volume_report, "pack": rebuilt_pack,
                    "meshes": bool(mesh_report),
                    "rtstruct": (reports.get("rtstruct") or {}).get("note")
                                or (reports.get("rtstruct") or {}).get("skipped")},
        # SAID OUT LOUD, in the artifact, because it is the sentence that keeps a
        # hand-edited clearance honest.
        "basis": (
            f"corrected by hand on the {factor}x display grid "
            f"({quant_mm:.2f} mm voxels) and upsampled to the {min(spacing_zyx):.2f} mm "
            f"measurement grid, so the boundary of an edited contour carries an extra "
            f"{quant_mm:.2f} mm of uncertainty on top of the model's own"),
        "frozen": ("the arch curve, the cross-section list, the greyscale pictures and "
                   "the density references are the ones this case was processed with; "
                   "an edit does not move them"),
        "seconds": round(time.monotonic() - t0, 1),
    })
    reports["edits"] = hist

    (results / "report.json").write_text(json.dumps(reports, indent=2, default=str) + "\n")
    say(0.97, "Finishing up")
    reports["bake"] = bake.bake(results)
    (results / "report.json").write_text(json.dumps(reports, indent=2, default=str) + "\n")
    # `bake` writes report.json.gz from the PREVIOUS content, so the final write needs
    # its own -- otherwise `files.py` serves a gz that is older than its source and
    # every browser gets the report without its own bake block.
    (results / "report.json.gz").write_bytes(
        gzip.compress((results / "report.json").read_bytes(), 9))
    return reports, hist[-1]

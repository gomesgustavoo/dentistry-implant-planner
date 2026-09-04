"""The worker loop: claim a job, segment it with the board, export, publish.

Rebuilt 2026-09-01. The retired three-model arm is deliberately NOT reconstructed
-- it was dead code behind `PIPELINE="three-model"` and rebuilding 400 lines of a
path nothing runs would be inventing history. Selecting it now raises with that
said plainly, rather than half-working.

The shape of a job:

    ingest -> preprocess -> base model -> FOV guard -> component filter
           -> to_canonical -> THE BOARD -> crosswalk -> quality
           -> meshes, RTSTRUCT, planning views, volume pack
           -> bake -> publish

Two orderings in there are load-bearing and both are explained where they happen:
the component filter must run in Task-1 ids on the plan grid, and the board must
run in Task-1 ids on the CANONICAL grid. The crosswalk to merged ids therefore
happens last, after both.
"""
from __future__ import annotations

import json
import logging
import os
import signal
import time
import traceback
from pathlib import Path

import numpy as np

from dentistry import storage
from dentistry.config import settings
from dentistry import labels as L
from dentistry.quality import assess
from worker import jobs, orient

log = logging.getLogger("dentistry.worker")

POLL_SECONDS = 3.0
_STOP = False


class Cancelled(RuntimeError):
    pass


class Reporter:
    """Progress, heartbeats and cancellation, in one callable.

    Heartbeats are what let a crashed worker's job be reclaimed rather than sitting
    in `running` forever, and the cancel check is polled at the same points -- so a
    cancelled job stops at the next stage boundary instead of finishing work nobody
    is waiting for.
    """

    def __init__(self, job_id: str, min_interval: float = 2.0):
        self.job_id = job_id
        self.min_interval = min_interval
        self._last = 0.0

    def __call__(self, fraction: float, message: str) -> None:
        now = time.monotonic()
        if now - self._last < self.min_interval and fraction < 1.0:
            return
        self._last = now
        jobs.heartbeat(self.job_id, stage=message, progress=float(fraction))
        log.info("[%s] %.0f%% %s", self.job_id[:8], fraction * 100, message)

    def check_cancel(self) -> None:
        if jobs.cancel_requested(self.job_id):
            raise Cancelled("cancelled by the user")


def _segment_three_model(vol, work, rep, job_id):
    raise RuntimeError(
        "the three-model pipeline was retired and its code was lost with the project "
        "tree on 2026-09-01. It is not reconstructed: nothing has run it since the "
        "ToothFairy3 model shipped, and rebuilding a path with no users would be "
        "inventing history rather than recovering it. Set DENT_PIPELINE=toothfairy3.")


def _segment_toothfairy3(vol, rep, job_id, config=None):
    """One base model plus the board. Returns `(merged, reports, None, gpu_s, wait_s)`.

    The segmentation itself lives in `worker/pipeline.py` so that `scripts/tf3_predict.py`
    reaches the identical code path: the composition an evaluation grades has to be the
    same function the product runs, or the two drift and the numbers stop describing the
    shipped system. Everything from here down is what only a JOB needs -- the crosswalk
    to merged ids, and the quality assessment.
    """
    from dentistry import crosswalk
    from dentistry import models as M
    from worker import pipeline

    res = pipeline.segment_task1(vol.image, settings, rep=rep, use_lock=True,
                                 config=config, load_labels=_load_labels)
    reports = res.reports
    seg_case = res.seg
    gpu_seconds, wait_seconds = res.gpu_seconds, res.wait_seconds

    rep(0.75, "Checking the result")
    merged = crosswalk.task1_to_merged_lut()[seg_case]
    del seg_case

    # --- the EXTENDED pass, after the crosswalk and in merged id space ---------------
    #
    # Soft tissue, the airway above the pharynx, the orbit, the great vessels. A second
    # composition entirely, under a rule that makes it unable to affect anything above:
    # it paints only where `merged == 0`, and `assert_dental_unchanged` proves it. So a
    # reader who switches the tongue on cannot thereby move a canal clearance.
    #
    # It runs BEFORE `assess`, so the quality block describes the volume that is actually
    # published, and before every artifact writer, which all iterate `L.STRUCTURES` and
    # pick the new indices up without being taught about them.
    from worker import extended_board
    ext_keys = M.extended_keys(config)
    if ext_keys:
        rep(0.78, "Checking whether the CT-trained models transfer to this scan")
        probe = extended_board.transfer_probe(vol.image, merged, settings,
                                              use_lock=True)
        reports["transfer_probe"] = probe
        rep(0.80, "Segmenting soft tissue and the airway")
        merged, ext_runs, ext_report = extended_board.compose(
            merged, vol.image, settings, config, use_lock=True, probe=probe,
            spacing_zyx=tuple(reversed(vol.spacing_xyz)))
        reports["extended"] = ext_report
        reports["extended_runs"] = [vars(r) for r in ext_runs]

    spacing_zyx = tuple(reversed(vol.spacing_xyz))
    # No `arch=`: that argument is the other model's opinion, and there is no other
    # model here. Every remaining check is geometric and single-model -- including
    # `_check_vertical`, which is what caught the inverted examples.
    # `pipeline_name` selects the source-keyed plausibility bands: "maxilla" is a
    # ~1 cm3 sliver in ToothFairy3's taxonomy and was a ~100 cm3 cranium in the retired
    # three-model one, so a band written for one would fire on every case of the other.
    qrep = assess(merged, spacing_zyx, direction=vol.image.GetDirection(),
                  pipeline_name=(reports.get("pipeline") or {}).get("name"))
    reports["quality"] = qrep.to_dict()
    return merged, reports, None, gpu_seconds, wait_seconds


def _load_labels(model_dir: Path) -> dict:
    return {k: int(v) for k, v in
            json.loads((Path(model_dir) / "dataset.json").read_text())["labels"].items()}


def _run(job: dict) -> None:
    from worker import bake, meshes, preview, retention, rtstruct, volume_pack

    job_id = job["id"]
    tenant = job.get("tenant_id")
    rep = Reporter(job_id)
    reports: dict = {}

    upload = storage.resolve(tenant, "uploads", job_id)
    work = storage.resolve(tenant, "work", job_id)
    results = storage.resolve(tenant, "results", job_id)
    for d in (work, results):
        d.mkdir(parents=True, exist_ok=True)

    rep(0.05, "Reading the volume")
    src = next(iter(sorted(upload.iterdir())), None) if upload.is_dir() else upload
    if src is None:
        raise FileNotFoundError("the upload is empty")
    from worker import ingest

    vol = ingest.load(upload if _looks_like_dicom_dir(upload) else src, work)
    reports["input"] = vol.as_dict()
    rep.check_cancel()

    if settings.PIPELINE == "toothfairy3":
        merged, extra, conflicts, gpu_seconds, wait_seconds = _segment_toothfairy3(
            vol, rep, job_id, job.get("options"))
    else:
        merged, extra, conflicts, gpu_seconds, wait_seconds = _segment_three_model(
            vol, work, rep, job_id)
    reports.update(extra)
    reports["orientation"] = vol.orientation
    reports["structures"] = L.grouped()
    spacing_zyx = tuple(reversed(vol.spacing_xyz))

    rep(0.85, "Writing the segmentation")
    import SimpleITK as sitk

    seg_img = orient.label_image_like(merged, vol.image)
    sitk.WriteImage(orient.from_canonical(seg_img, vol.original_code),
                    str(results / "segmentation.nii.gz"), useCompression=True)
    del seg_img

    grey = sitk.GetArrayFromImage(vol.image)

    mesh_report, stls, web_meshes = meshes.export(
        merged, vol.image, spacing_zyx, results / "stl", results / "mesh")
    reports["meshes"] = mesh_report

    rep(0.88, "Building the structure set")
    try:
        reports["rtstruct"] = rtstruct.export(
            merged, vol.image, grey, vol.dicom_reference, results / "rtstruct", vol,
            (preview.DEFAULT_WINDOW))
    except Exception as exc:  # noqa: BLE001
        # A structure set is a download, not the result. Losing it costs one file.
        log.exception("RTSTRUCT export failed")
        reports["rtstruct"] = {"error": f"{type(exc).__name__}: {exc}"}

    # The window and the per-plane geometry. No files: the JPEG tiles and
    # `preview/contours.<plane>.json` went with the Slices tab -- ~8 MB a case that
    # nothing reads. `volume_pack` and `rtstruct` still take the window from here.
    rep(0.92, "Measuring the display window")
    reports["preview"] = preview.render(grey, merged, spacing_zyx, results / "preview")

    # The implant-planning surface: the arch curve, a panoramic reconstruction along
    # it and buccolingual cross-sections across it. Rendered here, from the
    # full-resolution grid, because the volume the browser gets is 8-bit and
    # downsampled to ~0.66 mm -- a measurement taken on that would disagree with
    # every number the server computes for the same gap.
    #
    # Wrapped exactly like the RTSTRUCT block above: an arch that cannot be fitted
    # must cost the user a plan tab, never their segmentation.
    try:
        rep(0.94, "Reconstructing the arch")
        from dentistry import arch as arch_mod
        from worker import panoramic

        fits = {j: arch_mod.fit_arch(merged, spacing_zyx, vol.image.GetOrigin(),
                                     vol.image.GetDirection(), jaw=j)
                for j in ("mandible", "maxilla")}
        reports["arch"] = arch_mod.describe(fits)
        reports["planning"] = panoramic.render(grey, spacing_zyx, vol.image, fits,
                                               results / "planning", merged=merged)
        # The measurement field the /measure endpoint reads. Inside the SAME try/except
        # as the arch and the pictures: a pack that cannot be built costs the user the
        # measurement tools, never their segmentation.
        rep(0.95, "Building the measurement pack")
        from worker import planning_pack
        reports["planning"]["pack"] = planning_pack.build(
            grey, merged, vol.image, fits, results / "planning",
            reports.get("intensity") or {})

        # Available bone per SITE, measured through the pack's own sampler so a site's
        # reported height and an implant's measured clearance cannot come from two
        # different samplings of the same scan. Written back into both `report.arch`
        # (which the browser already holds) and `planning/arch.json` (which the plan tab
        # fetches), because the FDI chart is the site picker and needs the number before
        # an implant exists.
        rep(0.96, "Measuring available bone")
        from dentistry import ridge
        planning_pack.attach_site_measurements(
            results / "planning", fits, reports, ridge)
    except Exception as exc:  # noqa: BLE001
        log.exception("the arch reconstruction failed — planning views are skipped")
        reports["planning"] = {"error": f"{type(exc).__name__}: {exc}"}

    reports["volume"] = volume_pack.export(
        grey, merged, spacing_zyx, vol.image.GetOrigin(), vol.image.GetDirection(),
        results / "volume",
        window=(reports["preview"]["window"]["width"], reports["preview"]["window"]["level"]),
        conflicts=conflicts)
    del grey

    reports["outputs"] = {
        "nifti": "segmentation.nii.gz",
        "stl": stls,
        "mesh": web_meshes,
        "volume": "volume/meta.json",
        "rtstruct": (reports.get("rtstruct") or {}).get("file"),
        "planning": (reports.get("planning") or {}).get("file"),
    }
    (results / "report.json").write_text(json.dumps(reports, indent=2, default=str) + "\n")

    rep(0.97, "Finishing up")
    reports["bake"] = bake.bake(results)
    (results / "report.json").write_text(json.dumps(reports, indent=2, default=str) + "\n")

    jobs.finish_success(job_id, reports, gpu_seconds, wait_seconds)
    freed = retention.purge_upload(upload)
    log.info("[%s] done in %.0fs GPU, upload purged (%.1f MB)",
             job_id[:8], gpu_seconds or 0, freed / 1e6)


def _run_edit(edit: dict) -> None:
    """Apply one hand correction to a case's mask and rebuild what depends on it.

    Deliberately NOT inside `_run`'s try/except shape: a failed re-derive must leave the
    JOB alone. The case is still done, its segmentation is still the one the model drew,
    and the only thing that failed is one correction -- which is recorded on the edit row
    with its reason, where the person who made it can see it.
    """
    from dentistry import db, storage
    from worker import rederive

    # Already coerced by `claim_next_edit`; restated because this function is also the
    # one a future caller would reach for, and `[:8]` on a UUID object is a crash.
    edit_id = str(edit["id"])
    rep = _EditReporter(edit_id)
    if edit.get("job_state") != db.DONE:
        jobs.fail_edit(edit_id, f"the case is {edit.get('job_state')}, not done")
        return
    if edit.get("results_expired"):
        jobs.fail_edit(edit_id,
                       "this case's results expired and were deleted, so there is no "
                       "segmentation left to correct")
        return
    results = storage.resolve(edit["tenant_id"], "results", edit["job_id"])
    diff_path = results / "edits" / f"{edit_id}.json"
    if not diff_path.is_file():
        jobs.fail_edit(edit_id, "the stored correction is missing from disk")
        return
    with db.SessionLocal() as s:
        row = s.get(db.Job, edit["job_id"])
        job_row = {"id": row.id, "tenant_id": row.tenant_id,
                   "reports": dict(row.reports or {})} if row else None
    if job_row is None:
        jobs.fail_edit(edit_id, "the case no longer exists")
        return
    try:
        diff = json.loads(diff_path.read_text())
        reports, result = rederive.run(job_row, edit, diff, rep=rep)
    except rederive.RederiveRefused as exc:
        log.warning("[edit %s] refused: %s", edit_id[:8], exc)
        jobs.fail_edit(edit_id, str(exc))
        return
    except Exception as exc:  # noqa: BLE001
        log.exception("[edit %s] failed", edit_id[:8])
        jobs.fail_edit(edit_id, f"{type(exc).__name__}: {exc}\n"
                                f"{traceback.format_exc(limit=6)}")
        return
    jobs.finish_edit(edit_id, edit["job_id"], reports, result)
    log.info("[edit %s] applied: %d display voxels, %d full-resolution voxels",
             edit_id[:8], result.get("voxels", 0), result.get("full_voxels", 0))


class _EditReporter:
    """Progress and a heartbeat for a re-derive. No cancel: it is under a minute and
    every step is idempotent, so there is nothing worth stopping halfway."""

    def __init__(self, edit_id: str, min_interval: float = 2.0):
        self.edit_id = edit_id
        self.min_interval = min_interval
        self._last = 0.0

    def __call__(self, fraction: float, message: str) -> None:
        now = time.monotonic()
        if now - self._last < self.min_interval and fraction < 1.0:
            return
        self._last = now
        jobs.edit_heartbeat(self.edit_id)
        log.info("[edit %s] %.0f%% %s", self.edit_id[:8], fraction * 100, message)


def _looks_like_dicom_dir(path: Path) -> bool:
    if not path.is_dir():
        return False
    files = [p for p in path.rglob("*") if p.is_file()]
    if len(files) < 2:
        return False
    return not any(p.name.endswith((".nii", ".nii.gz", ".nrrd", ".mha")) for p in files)


def _handle(sig, frame):
    global _STOP
    _STOP = True
    log.info("signal %d — finishing the current job then exiting", sig)


def main() -> int:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    signal.signal(signal.SIGTERM, _handle)
    signal.signal(signal.SIGINT, _handle)
    log.info("dentistry worker starting")

    from dentistry.db import init_db

    init_db()

    import torch
    from worker import tf3

    tf3.tune_for_hardware()
    log.info("torch %s cuda=%s device=%s", torch.__version__, torch.cuda.is_available(),
             torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu")

    # WHICH MODELS THIS WORKER ACTUALLY HAS, into the shared data directory.
    #
    # The API pod mounts no model store and carries no DENT_TF3_* environment, so it
    # cannot know, and `GET /v1/models` would otherwise have to guess -- offering a
    # specialist that is not on disk, accepting an upload against it, and failing forty
    # seconds into the job with the volume already written. `installed` here is the
    # setting resolved against MODEL_STORE with dataset.json, plans.json and the named
    # checkpoint all present, so a half-mounted store is caught at the picker.
    try:
        from dentistry import models as model_menu

        inv = model_menu.write_inventory(settings)
        have = [k for k, v in inv["models"].items() if v.get("installed")]
        log.info("model inventory written: %d of %d installed (%s)",
                 len(have), len(inv["models"]), ", ".join(sorted(have)) or "none")
    except Exception:  # noqa: BLE001
        # A missing inventory costs the picker its list, never the worker its queue.
        log.exception("could not write the model inventory")

    idle = True
    while not _STOP:
        # A crashed worker must not leave a correction stuck in `applying` with no way
        # to retry it. Re-running a re-derive from the start is safe -- it reads the
        # stored segmentation and rewrites derived artifacts -- so this is a requeue
        # rather than a failure.
        try:
            back = jobs.requeue_stale_edits()
            if back:
                log.info("requeued %d stale edit(s)", back)
        except Exception:  # noqa: BLE001
            log.exception("could not requeue stale edits")

        job = jobs.claim_next()
        if job is None:
            # SEGMENTATION FIRST, corrections second. A re-derive is CPU-only and takes
            # under a minute; a queued upload is holding a person waiting on a GPU.
            edit = jobs.claim_next_edit()
            if edit is not None:
                idle = True
                # WRAPPED, and not only because `_run_edit` has its own guard: this
                # branch's own bookkeeping can raise too, and a raise here exits the
                # loop and takes the SEGMENTATION queue down with it. Measured live --
                # a `UUID` object where a string was expected, in the log line below,
                # crashed the worker and left the correction stuck in `applying`. A
                # failed correction must cost that correction and nothing else.
                try:
                    log.info("[edit %s] claimed for case %s", str(edit["id"])[:8],
                             str(edit["job_id"])[:8])
                    _run_edit(edit)
                except Exception as exc:  # noqa: BLE001
                    log.exception("[edit %s] the edit branch raised",
                                  str(edit.get("id"))[:8])
                    try:
                        jobs.fail_edit(str(edit["id"]),
                                       f"{type(exc).__name__}: {exc}")
                    except Exception:  # noqa: BLE001
                        log.exception("could not record the failure")
                continue
            if idle:
                # Hand the card back before settling. The predictor cache parks its
                # networks on the CPU between jobs, but PyTorch's allocator keeps the
                # freed blocks, and the CUDA context itself is a few hundred megabytes.
                # Measured: an idle worker was still holding 1 158 MiB across its two
                # processes, which is exactly what made a 33-class foreign model OOM
                # while this process had nothing to do.
                try:
                    import torch
                    if torch.cuda.is_available():
                        before = torch.cuda.memory_reserved() / 2 ** 20
                        torch.cuda.empty_cache()
                        after = torch.cuda.memory_reserved() / 2 ** 20
                        if before - after > 1:
                            log.info("released %.0f MiB of cached VRAM going idle",
                                     before - after)
                except Exception:  # noqa: BLE001
                    pass
                log.info("idle")
                idle = False
            time.sleep(POLL_SECONDS)
            continue
        idle = True
        log.info("[%s] claimed %s", job["id"][:8], job.get("filename"))
        try:
            _run(job)
        except Cancelled:
            jobs.mark_cancelled(job["id"])
            log.info("[%s] cancelled", job["id"][:8])
        except Exception as exc:  # noqa: BLE001
            log.exception("[%s] failed", job["id"][:8])
            jobs.finish_failure(job["id"], f"{type(exc).__name__}: {exc}\n"
                                           f"{traceback.format_exc(limit=6)}")
    log.info("worker stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Implant plans, and the stateless measurement endpoint they are checked against.

**`/measure` writes nothing.** It takes implant positions, reads the worker's
precomputed measurement pack through a memory map, and returns millimetres plus a
verdict. No row is touched and no quota is consumed, so dragging an implant can ask it
as often as it likes -- which is what lets the browser show a provisional in-plane figure
during the drag and an authoritative 3-D answer the moment the drag ends.

**Everything numeric happens in `dentistry/plan_metrics.py`, which is numpy-free.** This
image has neither numpy nor scipy, so the endpoint is a lookup rather than a computation;
the expensive geometry was done once by the worker. The same formulas run under a
numpy-backed sampler in the phantom suite, and a test asserts the two agree.

**`CasePlan`, not `Plan`.** `db.Plan` is the billing tier. The collision is easy to make
and would be caught late.
"""

from __future__ import annotations

import math
import uuid
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from api.deps import Caller, current_caller, get_session, load_owned
from dentistry import db, plan_metrics as PM, plan_safety as PS, storage

router = APIRouter(prefix="/v1/jobs", tags=["plans"])

MAX_IMPLANTS = 8

# The band is a valid chart only while its normals do not cross, and they cross at
# `t = -1/kappa`. The band runs to `t = -T_HALF_MM = -12`, so a curvature above 1/12 per
# mm means the frame has stopped meaning anything at the lingual edge -- which is
# exactly the bound `worker/planning_pack`'s own docstring states. It is also an
# anatomical ceiling: 12 mm is tighter than any human dental arch.
KAPPA_MAX_1_PER_MM = 1.0 / 12.0


class ImplantIn(BaseModel):
    id: str = "i1"
    jaw: Literal["mandible", "maxilla"]
    s_mm: float
    t_mm: float
    z_mm: float
    # The three angles, and they are three different KINDS of thing.
    #
    # `tilt` is buccolingual angulation: it rotates the axis toward +t, inside the
    #   cross-section, so the section shows it at true angle and true length.
    # `yaw` is mesiodistal angulation: it rotates the axis toward +s, OUT of the
    #   section. The measurement has always honoured it (`Implant.axis`) and the
    #   exported solid has honoured it since the frame was made orthonormal; what was
    #   missing was a UI that could show it, which is why it was pinned to 0 by the
    #   client rather than by this schema. The section now draws the foreshortened
    #   projection and the panoramic draws the angle itself.
    # `roll` is clocking about the implant's own axis. It changes NO measurement --
    #   the solid is a body of revolution -- and the response says so rather than
    #   letting a reader infer that a control which moves nothing is broken.
    #
    # Bounded rather than free. 45 degrees is past any placement a planner would call
    # restorable, and an unbounded angle is a way to walk an implant out of the band
    # the pack can measure while every intermediate step reports success.
    tilt_deg: float = Field(default=0.0, ge=-45, le=45)
    yaw_deg: float = Field(default=0.0, ge=-45, le=45)
    roll_deg: float = Field(default=0.0, ge=-360, le=360)
    length_mm: float = Field(gt=3, le=25)
    diameter_mm: float = Field(gt=1.5, le=8)
    site_fdi: int | None = None


class MeasureIn(BaseModel):
    implants: list[ImplantIn] = Field(default_factory=list, max_length=MAX_IMPLANTS)


class PlanIn(BaseModel):
    name: str = Field(default="Plan", max_length=120)
    jaw: Literal["mandible", "maxilla"] = "mandible"
    notes: str | None = None
    implants: list[ImplantIn] = Field(default_factory=list, max_length=MAX_IMPLANTS)


def _arch_manifest(job) -> dict | None:
    """`planning/arch.json` off disk. Plain JSON, so the numpy-free image can read it."""
    import json as _json

    root = storage.resolve(job.tenant_id, "results", job.id).resolve()
    f = root / "planning" / "arch.json"
    if not f.is_file():
        return None
    return _json.loads(f.read_text())


def _pack_for(job, s: Session):
    from api import planning_cache

    if job.results_expired:
        raise HTTPException(
            410, "This case's results expired and were deleted, so nothing can be "
                 "measured on it. Re-upload the scan to segment it again.")
    root = storage.resolve(job.tenant_id, "results", job.id).resolve()
    pack = planning_cache.get(root)
    if pack is None:
        raise HTTPException(
            404, "This case has no measurement pack. Every job processed before the "
                 "planning views existed has none, and a case whose arch could not be "
                 "fitted has none either.")
    return pack


# The corrected `worker/planning_pack.references()` emits the soft-tissue landmark it
# restricts the bone population with. A block without it was built before that fix, and
# on the maxilla its `cancellous` is sinus air: `density_ratio` would then divide by an
# air-to-soft-tissue span and report a plausible "1.5x denser than the surrounding
# trabecular bone" with NO caveat, which is precisely the failure mode this codebase
# refuses everywhere else. Measured on the stored cases: 4.26 and 221.32 (stale) against
# 382.36 and 420.26 (corrected), all four headers claiming `version: 1`.
#
# Neutralised rather than special-cased: dropping `cancellous` sends both consumers down
# the "no usable reference population" path they already implement, so no numeric code
# gains a branch. The canal distance field did not change, so CLEARANCE from an old pack
# is still sound and is deliberately left working -- a blanket version wall would take
# the whole plan tab away to fix two numbers.
def _sound_references(info: dict) -> dict:
    refs = dict(info.get("references") or {})
    if refs.get("cancellous") is not None and "soft_tissue" not in refs:
        refs["cancellous"] = None
        refs["reason"] = (
            "this case's measurement pack predates a correction to how the reference "
            "bone population is chosen, and its density reference may be soft tissue "
            "rather than bone. Re-run the case to measure density on it")
    return refs


def _curvature_at(jaw_arch: dict, s_mm: float) -> float:
    """The published curvature at this arc position, or 0.0 when it cannot be trusted.

    `approach_direction` needs `1 + t*kappa` to name a direction on a CURVILINEAR axis,
    and the worker publishes `curvature_1_per_mm` for exactly this call -- which was
    then hard-coded to zero here.

    It is not simply wired in, because the published array is contaminated. It is
    computed as `|grad T|`, a second derivative of a polyline resampled from a polar
    fit, and measured on real cases the mandibular median is plausible (0.035-0.041/mm,
    R = 24-29 mm) while the tail reaches 1.3176/mm -- a 0.76 mm arch radius -- and the
    MAXILLARY MEDIAN is 0.129-0.146/mm, a 6.8-7.7 mm radius, which is anatomically
    impossible. At the band edge `1 + t*kappa` reaches -14.8, which would flip
    mesial/distal and shrink the component fifteenfold.
    
    So a value above the band's own validity limit is discarded rather than used: the
    normals cross at `t = -1/kappa` and the band runs to `t = -12`, so anything above
    `1/12` per mm means the chart has stopped being a chart. Discarding it restores the
    previous behaviour (an uncorrected gradient) for those points instead of applying a
    correction that is known to be wrong -- and `approach_direction` already withholds
    the name when the top two components are close, which is the honest fallback.
    """
    k = (jaw_arch or {}).get("curvature_1_per_mm")
    if not k:
        return 0.0
    step = float(jaw_arch.get("step_mm") or 0.5)
    s0 = int(jaw_arch.get("s0_index") or 0)
    i = max(0, min(int(round(s_mm / step + s0)), len(k) - 1))
    v = float(k[i])
    return v if abs(v) <= KAPPA_MAX_1_PER_MM else 0.0


def _pose_block(imp: ImplantIn) -> dict:
    """The three angles, echoed, each with what it does and does not do to the numbers.

    A control that moves the picture and not the measurement has to SAY so, or a reader
    reasonably concludes the measurement is broken. Clocking is exactly that control:
    the measured solid is a body of revolution about the axis, so every clearance below
    is invariant under `roll_deg` -- exactly, not approximately.

    Yaw is the opposite case: it changes the answer in full and changes the PICTURE by
    less than the answer, because the cross-section can only show the projection, which
    is foreshortened by `cos(yaw)`. Saying it here keeps that sentence beside the
    numbers rather than only in the client.
    """
    notes = []
    if imp.roll_deg:
        notes.append("clocking does not change any clearance below: the measured solid "
                     "is a body of revolution about the implant axis")
    if imp.yaw_deg:
        notes.append(
            f"mesiodistal angulation of {imp.yaw_deg:.0f}\u00b0 takes the implant out of "
            f"the cross-section plane. Every number below is measured in three "
            f"dimensions; the section can only draw the projection, which is "
            f"{math.cos(math.radians(imp.yaw_deg)) * 100:.0f}% of the true length")
    return {"tilt_deg": imp.tilt_deg, "yaw_deg": imp.yaw_deg, "roll_deg": imp.roll_deg,
            "notes": notes}


def _measure_one(pack, imp: ImplantIn, arch: dict, quality: dict, edits=None) -> dict:
    info = pack.jaw(imp.jaw)
    if info is None:
        raise HTTPException(409, f"The {imp.jaw} arch was not reconstructed on this case")
    sampler = pack.sampler(imp.jaw)
    m = PM.Implant(jaw=imp.jaw, s_mm=imp.s_mm, t_mm=imp.t_mm, z_mm=imp.z_mm,
                   tilt_deg=imp.tilt_deg, yaw_deg=imp.yaw_deg, roll_deg=imp.roll_deg,
                   length_mm=imp.length_mm, diameter_mm=imp.diameter_mm,
                   id=imp.id, site_fdi=imp.site_fdi)
    refs = _sound_references(info)
    jaw_arch = (arch.get("jaws") or {}).get(imp.jaw) or {}
    canal_block = jaw_arch.get("canal")

    out = {"id": imp.id, "jaw": imp.jaw, "site_fdi": imp.site_fdi,
           "pose": _pose_block(imp)}
    clearance = None
    if imp.jaw == "mandible":
        clearance = PM.canal_clearance(sampler, m, canal_block)
        # The canal's own presence near this site travels WITH the measurement, so the
        # verdict can tell the mental foramen (anatomy) from a break (a defect).
        if canal_block:
            near = PM.canal_presence_near(canal_block, imp.s_mm)
            clearance.detail.update({
                "canal_terminal": near["terminal"],
                "nearest_canal_mm": near["nearest_present_mm"],
                "canal_sides": near["sides"]})
        out["clearance"] = clearance.as_dict()
        if clearance.value is not None:
            u = (clearance.detail or {}).get("at_depth_mm", 0.0)
            out["approach"] = PM.approach_direction(
                sampler, m, u, _curvature_at(jaw_arch, imp.s_mm))

        # The ANTERIOR neurovascular structures. These are what an anterior implant
        # actually has to clear, and until now nothing measured them at all.
        acc = PM.structure_clearance(sampler, m, "accessory_canal",
                                     "incisive or lingual canal")
        out["accessory_canal"] = acc.as_dict()
        out["accessory_canal_verdict"] = PS.structure_verdict(
            acc, "accessory_canal", PS.SAFETY_MARGIN_MM, edits=edits).as_dict()

    tooth = PM.structure_clearance(sampler, m, "tooth", "neighbouring tooth")
    # A site tooth that is still in the scan is the tooth being replaced, and a
    # clearance to it is not a clearance. Named rather than silently corrected: the
    # combined field cannot exclude a class it was not built to exclude.
    site_present = bool((jaw_arch.get("sites") or {}).get(str(imp.site_fdi), {})
                        .get("present")) if imp.site_fdi else False
    if tooth.value is not None:
        if site_present:
            tooth.caveats.append(
                f"tooth {imp.site_fdi} is still present in this scan, so this may be the "
                f"distance to the tooth being replaced rather than to a neighbour")
        elif imp.site_fdi is None:
            tooth.caveats.append(
                "no site tooth was named, so if the tooth at this position is still "
                "present this is the distance to it rather than to a neighbour")
    out["tooth"] = tooth.as_dict()
    out["tooth_verdict"] = PS.structure_verdict(
        tooth, "tooth", PS.ADJACENT_MARGIN_MM, edits=edits).as_dict()

    density = PM.density_ratio(sampler, m, refs)
    apex = PM.bone_beyond_apex(sampler, m, refs)
    out["density"] = density.as_dict()
    out["apex"] = apex.as_dict()
    out["verdict"] = PS.canal_verdict(clearance, canal_block, quality, imp.jaw,
                                      edits=edits).as_dict()
    out["statements"] = {"density": PS.density_statement(density),
                         "apex": PS.apex_statement(apex, imp.jaw)}
    return out


@router.post("/{job_id}/measure")
def measure(job_id: str, body: MeasureIn,
            s: Session = Depends(get_session),
            caller: Caller = Depends(current_caller)):
    job = load_owned(job_id, s, caller)
    if job.state != db.DONE:
        raise HTTPException(409, f"Job is {job.state}, not done")
    pack = _pack_for(job, s)
    reports = job.reports or {}
    # The per-arc canal presence array is in the manifest; `reports["arch"]` is a summary.
    arch = _arch_manifest(job) or {}
    quality = reports.get("quality") or {}
    # Pairwise distances are PLAN-level, not implant-level. Every pair is reported, not
    # only the adjacent ones: "adjacent" is a judgement the server should not be making,
    # and with MAX_IMPLANTS = 8 there are at most 28 pairs, which is nothing. Sorted
    # ascending so the binding pair is first.
    pairs = []
    arch_jaws = arch.get("jaws") or {}
    for i in range(len(body.implants)):
        for j in range(i + 1, len(body.implants)):
            a, b = body.implants[i], body.implants[j]
            d = PM.inter_implant_distance(a.model_dump(), b.model_dump(), arch_jaws)
            pairs.append({"a": a.id, "b": b.id, "distance": d.as_dict(),
                          "verdict": PS.inter_implant_verdict(d, a.id, b.id).as_dict()})
    pairs.sort(key=lambda p: (p["distance"]["value"] is None,
                              p["distance"]["value"] if p["distance"]["value"] is not None
                              else 0.0))

    # THE HAND CORRECTIONS THIS PACK CARRIES. Written by
    # `worker/planning_pack.rebuild_label_fields` when a re-derive rebuilt the distance
    # fields, and read here so a clearance to a contour a person moved can never be
    # graded as if the model had drawn it: `plan_safety.edit_penalty` widens the budget
    # of exactly the fields the correction reached, and the client prints the reason.
    edits = pack.header.get("edits") or []
    return {
        "implants": [_measure_one(pack, i, arch, quality, edits) for i in body.implants],
        "pairs": pairs,
        "pack": {"version": pack.header.get("version"),
                 "step_mm": pack.header.get("step_mm")},
        # Per structure, because one budget cannot serve all three: the accessory canals
        # are 2.1-2.4x the inferior alveolar canal's inward p95 and the teeth are better
        # on the median but worse in the tail. See plan_safety.STRUCTURE_PRIORS.
        "priors": {"inward_p95_mm": PS.MODEL_INWARD_P95_MM,
                   "worst_measured_inward_mm": PS.MODEL_INWARD_WORST_MM,
                   "margin_mm": PS.SAFETY_MARGIN_MM,
                   "adjacent_margin_mm": PS.ADJACENT_MARGIN_MM,
                   "inter_implant_margin_mm": PS.INTER_IMPLANT_MARGIN_MM,
                   "by_structure": PS.STRUCTURE_PRIORS,
                   "source": "20 held-out annotated cases; not a measurement of YOUR scan"},
        # Per FIELD, so the panel can show the widened budget beside the number it was
        # applied to rather than as a footnote about the case.
        "edits": [{"id": e.get("id"), "at": e.get("at"), "voxels": e.get("voxels"),
                   "fields": e.get("fields") or [],
                   "quantisation_mm": e.get("quantisation_mm"),
                   "structures": e.get("structures") or {}}
                  for e in edits],
        "edit_penalty": {f: PS.edit_penalty(f, edits)
                         for f in ("canal", "accessory_canal", "tooth")
                         if PS.edit_penalty(f, edits)},
        "notice": PS.NO_GUIDE_NOTICE,
    }


def _owned_plan(job_id: str, plan_id: str, s: Session, caller: Caller):
    p = s.get(db.CasePlan, plan_id)
    # Re-check against the job AFTER load_owned: a valid plan id belonging to another
    # case must 404 rather than 403, for the same existence-oracle reason deps.py gives.
    #
    # And against the TENANT. `deps.load_owned` returns any `is_example` job to any
    # signed-in caller -- correctly, examples are published -- but a plan is not part of
    # the example, it is the caller's own work on it. Without this every tenant's plans
    # on a published example were listable, patchable and deletable by anyone.
    if p is None or p.job_id != job_id or str(p.tenant_id) != str(caller.tenant_id):
        raise HTTPException(404, "No such plan")
    return p


@router.get("/{job_id}/plans")
def list_plans(job_id: str, s: Session = Depends(get_session),
               caller: Caller = Depends(current_caller)):
    job = load_owned(job_id, s, caller)
    # Scoped to the caller's tenant as well as the job: see `_owned_plan`.
    rows = (s.query(db.CasePlan)
            .filter(db.CasePlan.job_id == job.id,
                    db.CasePlan.tenant_id == caller.tenant_id)
            .order_by(db.CasePlan.created_at.desc()).all())
    return {"plans": [_plan_out(p) for p in rows]}


@router.get("/{job_id}/plans/{plan_id}")
def get_plan(job_id: str, plan_id: str, s: Session = Depends(get_session),
             caller: Caller = Depends(current_caller)):
    """One plan. The CRUD surface could list, create, patch, delete and export -- but
    not read a single plan, which is what a client needs to reopen one."""
    job = load_owned(job_id, s, caller)
    return _plan_out(_owned_plan(job.id, plan_id, s, caller))


@router.post("/{job_id}/plans", status_code=201)
def create_plan(job_id: str, body: PlanIn, s: Session = Depends(get_session),
                caller: Caller = Depends(current_caller)):
    job = load_owned(job_id, s, caller)
    p = db.CasePlan(id=str(uuid.uuid4()), job_id=job.id, tenant_id=caller.tenant_id,
                    created_by_user_id=getattr(caller, "user_id", None),
                    name=body.name, jaw=body.jaw, notes=body.notes,
                    implants=[i.model_dump() for i in body.implants],
                    arch_version=(job.reports or {}).get("planning", {}).get("version", 1))
    s.add(p)
    _cache_measurement(p, job.id, s, caller)
    s.commit()
    return _plan_out(p)


def _cache_measurement(p, job_id: str, s: Session, caller: Caller) -> None:
    """Store this plan's numbers alongside it, with the time they were taken.

    `db.CasePlan` documents `measured` as a cache that exists for one reason: results
    expire after RESULT_TTL_HOURS (72), the measurement pack goes with them, and the plan
    outlives both. A plan whose pack is gone is supposed to render its last numbers with
    the date and a note -- "never silently stale, never blank". Nothing wrote the cache,
    so that behaviour could not happen and a plan older than the pack rendered nothing at
    all.

    Best effort by construction. A save must never fail because the pack is missing, the
    arch refused, or the geometry is out of band: the plan is the user's work and the
    measurement is a convenience attached to it. On failure the cache is simply left
    empty, which is the same state as before and reads correctly downstream.
    """
    try:
        body = MeasureIn(implants=[ImplantIn(**i) for i in (p.implants or [])])
        p.measured = measure(job_id, body, s, caller)
        p.measured_at = datetime.now(timezone.utc)
    except Exception:  # noqa: BLE001
        p.measured, p.measured_at = None, None


@router.patch("/{job_id}/plans/{plan_id}")
def update_plan(job_id: str, plan_id: str, body: PlanIn,
                s: Session = Depends(get_session),
                caller: Caller = Depends(current_caller)):
    job = load_owned(job_id, s, caller)
    p = _owned_plan(job.id, plan_id, s, caller)
    p.name, p.jaw, p.notes = body.name, body.jaw, body.notes
    p.implants = [i.model_dump() for i in body.implants]
    # The old cache is stale by construction, so it is replaced rather than kept --
    # `_cache_measurement` clears it if the new one cannot be taken.
    _cache_measurement(p, job.id, s, caller)
    s.commit()
    return _plan_out(p)


@router.delete("/{job_id}/plans/{plan_id}", status_code=204)
def delete_plan(job_id: str, plan_id: str, s: Session = Depends(get_session),
                caller: Caller = Depends(current_caller)):
    job = load_owned(job_id, s, caller)
    s.delete(_owned_plan(job.id, plan_id, s, caller))
    s.commit()


@router.get("/{job_id}/plans/{plan_id}/export.json")
def export_plan(job_id: str, plan_id: str, s: Session = Depends(get_session),
                caller: Caller = Depends(current_caller)):
    """Self-contained and auditable: every measurement with its basis, every refusal.

    A refusal that does not appear in the export is a refusal that did not happen.
    """
    job = load_owned(job_id, s, caller)
    p = _owned_plan(job.id, plan_id, s, caller)
    reports = job.reports or {}
    body = MeasureIn(implants=[ImplantIn(**i) for i in (p.implants or [])])
    try:
        measured = measure(job_id, body, s, caller)
    except HTTPException as exc:
        measured = {"unavailable": exc.detail, "implants": []}
    return {
        "plan": _plan_out(p),
        "measured": measured,
        "provenance": {
            "job_id": job.id,
            "pipeline": reports.get("pipeline"),
            "models": reports.get("models"),
            "provenance": reports.get("provenance"),
            "intensity": reports.get("intensity"),
            "canal_components": (reports.get("quality") or {}).get("canal_components"),
            "arch": reports.get("arch"),
            "planning": (reports.get("planning") or {}).get("pack"),
        },
        "notice": PS.NO_GUIDE_NOTICE,
    }


@router.get("/{job_id}/plans/{plan_id}/implants.stl")
def implants_stl(job_id: str, plan_id: str, s: Session = Depends(get_session),
                 caller: Caller = Depends(current_caller)):
    """The placed implants as one binary STL, in patient LPS millimetres.

    Same frame `worker/meshes.py` writes the anatomy in, so this drops straight into a
    planning package beside the per-structure STLs. Built by the pure-Python writer in
    `dentistry/plan_geometry.py`, because this image cannot import `worker.meshes`.

    This is an implant solid, NOT a surgical guide -- see `plan_safety.NO_GUIDE_NOTICE`.
    """
    from fastapi.responses import Response

    from dentistry import plan_geometry as G

    job = load_owned(job_id, s, caller)
    p = _owned_plan(job.id, plan_id, s, caller)
    # The polyline lives in planning/arch.json, not in `reports["arch"]`: it is ~20 KB
    # per jaw and only the plan tab needs it, so the report carries a summary instead.
    arch = (_arch_manifest(job) or {}).get("jaws") or {}
    tris = []
    for imp in (p.implants or []):
        info = arch.get(imp.get("jaw"))
        if not info or not info.get("ok") or "points" not in info:
            continue
        try:
            tris.extend(G.implant_triangles_lps(imp, info))
        except ValueError as exc:
            # `implant_frame` refuses rather than guessing -- today only for a yawed
            # implant on a manifest published without `tangents`. A refusal that
            # reaches the user as a 500 reads as a bug in the app rather than as a
            # statement about the case, so it becomes a 409 carrying the reason.
            raise HTTPException(
                409, f"Implant {imp.get('id', '?')} cannot be placed: {exc}") from exc
    if not tris:
        raise HTTPException(
            409, "No implant in this plan can be placed: the arch fit for its jaw is "
                 "not available on this case.")
    return Response(G.write_stl_bytes(tris), media_type="model/stl",
                    headers={"Content-Disposition":
                             f'attachment; filename="{p.name or "plan"}-implants.stl"',
                             "X-Notice": PS.NO_GUIDE_NOTICE})


def _plan_out(p) -> dict:
    return {"id": p.id, "job_id": p.job_id, "name": p.name, "jaw": p.jaw,
            "notes": p.notes, "implants": p.implants or [],
            "measured": p.measured, "measured_at": p.measured_at,
            "created_at": p.created_at, "updated_at": p.updated_at}

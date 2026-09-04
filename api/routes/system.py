"""Unauthenticated surface: liveness, the structure catalogue, queue depth.

None of these touch a tenant's data. `/v1/health` in particular must never require
a token -- it is what both kubernetes probes call, and a probe carrying a bearer
token is a probe that fails when Keycloak does.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from sqlalchemy import text
from sqlalchemy.orm import Session

from api.deps import get_session
from dentistry import labels as L
from dentistry.config import settings

router = APIRouter(prefix="/v1", tags=["system"])


@router.get("/health")
def health(request: Request) -> dict:
    return {"ok": True, "version": request.app.version}


@router.get("/structures")
def structures() -> dict:
    """The structure catalogue the viewer colours and groups by. Public: it is the
    same list the landing page publishes, and it describes the product rather than
    anybody's data. `count` is whatever `labels.py` currently defines -- do not
    hardcode it anywhere, it has already changed once (37 -> 47)."""
    return {"count": L.N_STRUCTURES, "groups": L.grouped()}


@router.get("/implants")
def implants() -> dict:
    """The implant size catalogue. Public: it is a menu of generic size classes."""
    from dentistry import implants as I

    return I.catalog()


@router.get("/model-accuracy")
def model_accuracy() -> dict:
    """The holdout error budget: a PRIOR about the model, never a measurement of a scan.

    Served without a job id on purpose. It says what the model does on 20 held-out
    annotated cases, which is a fact about the model and is the same for every caller --
    and keeping it away from a job id is what stops it being read as this scan's score.
    `web/app.js` renders it beside, and visually separate from, the things that ARE
    measurable on a scan with no ground truth (canal component count, field-of-view
    clipping, intensity calibration, arch fit residual).

    The wording of `source` is deliberately the same sentence `POST /measure` already
    returns in its `priors` block, because it is the same claim and a second phrasing
    would eventually drift from the first.
    """
    from dentistry import plan_safety as PS

    return {
        "source": "20 held-out annotated cases; not a measurement of YOUR scan",
        "protocol": {
            "strict": {
                "mean_dice": 0.8292, "mean_hd95_mm": 1.235, "mean_nsd": 0.9736,
                "tolerance_mm": 1.0,
                "note": "Every annotated class scored, misses and spurious classes "
                        "included at Dice 0. Absent from both masks is excluded, never "
                        "scored 1.0."},
            "challenge": {
                "mean_dice": 0.8965,
                "note": "Comparable to the ToothFairy3 leaderboard and to nothing else: "
                        "about 13 classes per case score 1.0 for being absent from both "
                        "masks. The winners' final figure is 0.908."},
        },
        # Only the structures an implant plan actually depends on, with the number that
        # matters for each: inward p95, the direction that costs clearance.
        "structures": PS.STRUCTURE_PRIORS,
        "worst_tooth_classes": {
            "note": "22 of 32 tooth classes have a worst inward p95 of exactly one "
                    "voxel, but these do not, and they are mandibular posteriors -- the "
                    "likeliest implant neighbours.",
            "inward_max_mm": {"tooth_44": 10.26, "tooth_37": 7.62, "tooth_36": 7.30,
                              "tooth_46": 6.86, "tooth_31": 4.75},
        },
        "not_claimed": [
            "None of this is a measurement of the scan in front of you.",
            "CBCT grey values are not calibrated attenuation, so no absolute density "
            "figure is given anywhere in this product.",
            PS.NO_GUIDE_NOTICE,
        ],
    }


@router.get("/system")
def system(s: Session = Depends(get_session)) -> dict:
    """Queue depth and worker liveness, for the header strip in the UI.

    Deliberately global rather than per tenant: there is one GPU, so "3 queued"
    is the honest answer to "when will mine start" even when none of the three are
    yours. It exposes counts, never ids.
    """
    row = s.execute(text(
        """
        SELECT
          count(*) FILTER (WHERE state = 'queued')  AS queued,
          count(*) FILTER (WHERE state = 'running') AS running,
          max(heartbeat_at) FILTER (WHERE state = 'running') AS last_beat
        FROM jobs
        """
    )).first()
    return {
        "queued": row[0], "running": row[1], "worker_last_seen": row[2],
        # So the UI can say "expires in 9 h" without a second copy of the number.
        # It is a deployment setting, and a client that guesses it will be wrong
        # the first time it changes.
        "resultTtlHours": settings.RESULT_TTL_HOURS,
    }

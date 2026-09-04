"""Interpretation, kept apart from measurement so a change of policy is one file.

`plan_metrics` says what was measured. This says what it means, and every threshold and
every prior lives here with its provenance, so the accuracy numbers the product reasons
from exist in exactly one place.

**No surgical guide is produced by this product, and that is a position rather than a
gap.** A drill guide is a patient-contacting physical device. The canal outline this app
draws is known to sit up to 5.10 mm inside the truth at its worst measured point (20-case
holdout, `dentistry/metrics.directed_error`; this docstring said 2.96 mm, which is the
largest per-case *p95*, while `NO_GUIDE_NOTICE` below correctly said 5.10 -- the module
contradicted itself), and CBCT grey values are not calibrated
attenuation. A guide manufactured to a boundary with that error is a guide that is
confidently wrong in the one direction that injures somebody.

Numpy-free, like `plan_metrics`, because the API executes it.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict

# The conventional margin above the inferior alveolar canal.
SAFETY_MARGIN_MM = 2.00

# Our own measured segmentation error, on the 20-case holdout, in the direction that
# costs clearance: the drawn wall sitting INSIDE the true one.
MODEL_INWARD_P95_MM = 0.46          # left IAC, 95th percentile
MODEL_INWARD_WORST_MM = 5.10        # ToothFairy3P_411 -- quoted, NEVER subtracted
MODEL_INWARD_MEDIAN_MM = 0.82       # median worst-inward across the holdout

# A canal drawn in pieces cannot support a clearance: the distance is then measured to
# wherever the drawing happens to stop. This applies to an INTERIOR break only -- an
# absence past the end of a canal is the mental foramen, not a fragment. See
# `plan_metrics.canal_presence_near`, and note that conflating the two refused every
# anterior site on every real case.
GAP_DISQUALIFIES_MM = 3.00
TIGHT_BAND_MM = 0.50

# Conventional minima, per structure. Thresholds, not verdicts.
ADJACENT_MARGIN_MM = 1.50       # implant surface to an adjacent tooth
INTER_IMPLANT_MARGIN_MM = 3.00  # implant surface to implant surface

# ---------------------------------------------------------------- per-structure priors
# One error budget cannot serve every structure, and using the inferior alveolar canal's
# for everything would be the difference between a useful number and a false one.
# Measured on the 20-case holdout (`eval/board_p2/metrics.json`, `per_case[*].classes`):
# `p95` is mean(inward_p95) -- the typical under-draw, and what gets deducted -- and
# `worst` is max(inward_max), a single point, quoted and never subtracted.
#
#   structure                        Dice.GT   mean p95   worst point
#   left inferior alveolar canal      0.9008     0.464        5.100
#   right inferior alveolar canal     0.9009     0.366        1.921
#   left mandibular incisive canal    0.6864     0.987       63.038
#   right mandibular incisive canal   0.6417     1.062        4.069
#   lingual canal                     0.6972     1.109        6.997
#   teeth (32 classes, mean)          ~0.93      0.339       10.257
#
# The accessory canals are 2.1-2.4x the left IAC and are the model's WEAKEST structures.
# Grading an anterior clearance against 0.46 mm would understate its own uncertainty by
# a factor of two to three -- which would turn the anterior fix from a missing feature
# into a false-confidence generator, and that is worse than the refusal it replaces.
#
# Teeth are the other direction and need care for the opposite reason: they beat the
# canal on the typical case (0.339 mm, and 22 of 32 classes have a worst p95 of exactly
# one voxel) but `tooth_44` reaches 10.257 mm and teeth 31/36/37/46 exceed 4.7 mm -- and
# those are mandibular posteriors, the likeliest implant neighbours. So the tooth entry
# carries the population's worst point, not its median.
STRUCTURE_PRIORS = {
    "canal": {"p95_mm": 0.46, "worst_mm": 5.10, "median_worst_mm": 0.82,
              "dice_gt": 0.901,
              "label": "inferior alveolar canal",
              "source": "20 held-out annotated cases, left/right IAC"},
    "accessory_canal": {"p95_mm": 1.11, "worst_mm": 63.04, "median_worst_mm": 1.39,
                        "dice_gt": 0.642,
                        "label": "incisive and lingual canals",
                        "source": "20 held-out annotated cases; the worst of the three "
                                  "accessory canals is used for all three"},
    "tooth": {"p95_mm": 0.34, "worst_mm": 10.26, "median_worst_mm": 0.30,
              "dice_gt": 0.930,
              "label": "teeth",
              "source": "20 held-out annotated cases, 32 per-FDI classes"},
}


def edit_penalty(field: str, edits) -> dict | None:
    """The extra boundary uncertainty a HAND EDIT puts on one measurement field.

    A specialist correcting a contour is the point of the editing tools, and it does not
    make the contour exact. The mask a browser can edit is the DISPLAY volume, which
    `worker/volume_pack.py` downsamples so its longest axis is at most 256 -- 0.6 mm
    voxels on a real dental CBCT, against the 0.3 mm grid every millimetre here is
    measured on. So the boundary of an edited contour is quantised at the display
    voxel, and the one-sided term that belongs in an INWARD budget is half of it.

    THREE THINGS THIS DOES NOT DO, each because doing it would overstate the result:

    * It does not replace the model's prior. Only part of a structure is edited, and the
      nearest point to an implant may be in a region nobody touched, so the model's own
      under-draw still applies there. The two terms ADD.
    * It does not claim the observer is exact. Where a person believes a cortical wall
      sits carries its own error and this codebase has not measured it -- so it is
      STATED as unquantified rather than assigned a number, which is the same rule the
      density metric follows about Hounsfield units.
    * It does not suppress the verdict. Refusing to grade an edited contour would make
      the editing tools useless, which is worse than grading it with a wider budget and
      saying so.

    `edits` is `planning/pack/header.json`'s own `edits` list, written by
    `worker/planning_pack.rebuild_label_fields`, which records WHICH fields each
    correction actually reached. A correction to a tooth does not widen the canal's
    budget.
    """
    hits = [e for e in (edits or []) if field in (e.get("fields") or [])]
    if not hits:
        return None
    q = max(float(e.get("quantisation_mm") or 0.0) for e in hits)
    if q <= 0:
        return None
    return {"add_p95_mm": round(q / 2.0, 3),
            "quantisation_mm": round(q, 3),
            "edits": len(hits),
            "note": (f"this contour was corrected by hand on a {q:.2f} mm display grid, "
                     f"so its boundary carries {q / 2.0:.2f} mm of quantisation on top "
                     f"of the model's own error. How accurately a person can place a "
                     f"cortical boundary is not something we have measured, so it is "
                     f"not in this budget at all.")}


def prior(field: str, edits=None) -> dict:
    """The error budget for one measurement field. Falls back to the WORST known.

    Falling back to the worst rather than to the canal's is deliberate: an unknown
    structure is not a well-characterised one, and the conservative direction for a
    clearance is to assume more under-draw, not less.
    """
    p = STRUCTURE_PRIORS.get(field)
    if p is None:
        worst = max(STRUCTURE_PRIORS.values(), key=lambda v: v["p95_mm"])
        p = {**worst, "label": f"{field} (no measured prior; the worst known is used)"}
    pen = edit_penalty(field, edits)
    if pen:
        p = {**p,
             "p95_mm": round(p["p95_mm"] + pen["add_p95_mm"], 3),
             "model_p95_mm": p["p95_mm"],
             "edit": pen,
             "source": p["source"] + "; widened for a hand correction, see `edit`"}
    return p


@dataclass
class Verdict:
    level: str                      # clear | tight | breach | no_verdict
    headline: str
    because: list = field(default_factory=list)
    numbers: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return asdict(self)


def budget_for(clearance_mm: float | None, field: str, margin_mm: float,
               edits=None) -> dict:
    """`budget()` generalised over the structure being cleared and its own margin.

    Every term is named, and the model's error comes from `STRUCTURE_PRIORS[field]` --
    not from the canal's -- because the accessory canals are 2.1-2.4x worse and the
    teeth are better on the median and worse in the tail. A budget that deducts the
    wrong structure's error is arithmetic dressed as safety.
    """
    if clearance_mm is None:
        return {"clearance_mm": None, "field": field, "margin_mm": margin_mm}
    pr = prior(field, edits)
    informed = clearance_mm - pr["p95_mm"]
    out = {"clearance_mm": round(clearance_mm, 2),
           "field": field,
           "measured_against": pr["label"],
           "inward_p95_mm": pr["p95_mm"],
           "informed_mm": round(informed, 2),
           "margin_mm": margin_mm,
           "headroom_mm": round(informed - margin_mm, 2),
           "worst_measured_inward_mm": pr["worst_mm"],
           "prior_source": pr["source"]}
    if pr.get("edit"):
        # Both terms, separately. "0.76 mm was deducted" is not an answer a reader can
        # check; "0.46 the model may under-draw plus 0.30 of edit quantisation" is.
        out["model_p95_mm"] = pr["model_p95_mm"]
        out["edit"] = pr["edit"]
    return out


def structure_verdict(m, field: str, margin_mm: float, *,
                      headline_noun: str | None = None, edits=None) -> Verdict:
    """Grade one clearance against one margin, with that structure's own error budget.

    Shares `canal_verdict`'s bands and its refusal discipline: a non-empty `caveats` on
    the measurement suppresses the grade, and the millimetres are shown in every branch
    because hiding a measurement because it could not be graded leaves the reader with
    nothing at all.
    """
    noun = headline_noun or prior(field)["label"]
    b = budget_for(m.value if m else None, field, margin_mm, edits)

    # A SATURATED field is a bound, not a gap in the measurement. If even the bound,
    # less this structure's own inward error, clears the margin, the answer is known --
    # and withholding it would refuse a verdict precisely to the safest implants.
    det = (m.detail if m else None) or {}
    if m is not None and m.value is None and det.get("saturated"):
        at_least = float(det.get("at_least_mm") or 0.0)
        pr = prior(field, edits)
        informed = at_least - pr["p95_mm"]
        nums = {**b, "at_least_mm": round(at_least, 2), "saturated": True,
                "inward_p95_mm": pr["p95_mm"],
                "informed_mm": round(informed, 2),
                "headroom_mm": round(informed - margin_mm, 2),
                "measured_against": pr["label"]}
        if not m.caveats and informed >= margin_mm:
            return Verdict("clear",
                           f"More than {at_least:.1f} mm to the nearest {noun} — beyond "
                           f"what this measurement reaches, and well beyond the "
                           f"{margin_mm:.1f} mm margin.",
                           ["The distance field stops at this range, so this is a lower "
                            "bound rather than a figure; at this distance the margin is "
                            "not in question either way.", m.basis], nums)
        return Verdict("no_verdict",
                       f"More than {at_least:.1f} mm to the nearest {noun} — not graded.",
                       list(m.caveats) + [m.basis], nums)

    if m is None or m.value is None:
        return Verdict("no_verdict",
                       f"No clearance to the {noun} could be measured.",
                       list((m.caveats if m else None) or [m.basis if m else "not measured"]),
                       b)
    if m.caveats:
        return Verdict("no_verdict",
                       f"{b['clearance_mm']:.2f} mm to the drawn {noun} — not graded.",
                       list(m.caveats) + [m.basis], b)
    pr = prior(field, edits)
    head = b["headroom_mm"]
    if head < 0:
        level, headline = "breach", (
            f"{b['clearance_mm']:.2f} mm to the {noun} — inside the "
            f"{margin_mm:.1f} mm margin once the segmentation's own error is allowed for.")
    elif head < TIGHT_BAND_MM:
        level, headline = "tight", (
            f"{b['clearance_mm']:.2f} mm to the {noun} — clear on the typical case, with "
            f"only {head:.2f} mm to spare against our measured error.")
    else:
        level, headline = "clear", (
            f"{b['clearance_mm']:.2f} mm to the {noun} — {head:.2f} mm of headroom "
            f"beyond the {margin_mm:.1f} mm margin.")
    because = [
        f"The drawn wall may sit up to {pr['p95_mm']:.2f} mm inside the true one at the "
        f"95th percentile; the worst single point we have measured is "
        f"{pr['worst_mm']:.2f} mm ({pr['source']}).",
        m.basis]
    if pr.get("edit"):
        because.insert(1, pr["edit"]["note"])
    return Verdict(level, headline, because, b)


def budget(clearance_mm: float | None, edits=None) -> dict:
    """The arithmetic the clearance bar draws, with every term named.

        measured clearance                                  3.10 mm
        the segmentation may under-draw the canal by       -0.46 mm   (inward p95)
        worst-case-informed clearance                       2.64 mm
        required margin                                    -2.00 mm
        headroom                                            0.64 mm

    `MODEL_INWARD_WORST_MM` is quoted in the text and never subtracted here: deducting a
    single worst point from every case would be theatre, not conservatism.
    """
    if clearance_mm is None:
        return {"clearance_mm": None}
    # Through `budget_for` so the CANAL's budget and every other structure's are the
    # same arithmetic, and so a hand correction widens this one too. It used to deduct
    # `MODEL_INWARD_P95_MM` directly, which meant an edited canal was graded against the
    # model's error alone -- the one field where getting it wrong matters most.
    return budget_for(clearance_mm, "canal", SAFETY_MARGIN_MM, edits)


def canal_verdict(clearance, canal_block: dict | None, quality: dict | None,
                  jaw: str, edits=None) -> Verdict:
    """A level, or an explicit refusal with the raw millimetres still shown.

    Refusing is not the same as having nothing to say: `numbers` is populated in every
    branch, because hiding a measurement because it could not be graded is how a user
    ends up with no information at all.
    """
    b = budget(clearance.value if clearance else None, edits)
    because = []

    if jaw == "maxilla":
        return Verdict("no_verdict",
                       "There is no inferior alveolar canal in the upper jaw.",
                       ["The maxillary question is the sinus floor, and it is read from "
                        "the greyscale rather than from a label: both maxillary sinuses "
                        "are annotated to the edge of the scan rather than to anatomy."],
                       b)

    # ORDER MATTERS HERE. At an anterior site the canal field is BOTH saturated (the
    # nearest canal is far away) and terminal (there is no canal at this site at all).
    # Both statements are true and only one is useful: "there is no inferior alveolar
    # canal here, read the incisive and lingual canals instead" tells the reader what to
    # do, while "more than 63 mm — clear" invites them to conclude the anterior mandible
    # is a safe place to drill without looking at the structures that are actually there.
    # So terminal is checked first, below, and saturation only after it.
    if clearance is not None and clearance.value is None \
            and (clearance.detail or {}).get("canal_terminal"):
        pass                       # fall through to the terminal branch below
    elif clearance is not None and clearance.value is None \
            and (clearance.detail or {}).get("saturated"):
        # See `structure_verdict`: a bound beyond the margin is an answer.
        return structure_verdict(clearance, "canal", SAFETY_MARGIN_MM,
                                 headline_noun="inferior alveolar canal", edits=edits)

    if clearance is not None and (clearance.detail or {}).get("canal_terminal"):
        detail = clearance.detail or {}
        near = detail.get("nearest_canal_mm")
        return Verdict(
            "no_verdict",
            "There is no inferior alveolar canal at this site.",
            ["The canal ends at the mental foramen; this site is beyond it"
             + (f", and the nearest drawn canal is {near:.0f} mm away along the arch"
                if near is not None else "") + ".",
             "The anterior structures are the incisive and lingual canals, which are "
             "measured separately — read those, not this."], b)

    if clearance is None or clearance.value is None:
        return Verdict("no_verdict",
                       "No clearance could be measured.",
                       (clearance.caveats if clearance else
                        ["no canal measurement was produced"]), b)

    detail = clearance.detail or {}

    # A component count is a fact about the whole volume, not about this site. It used
    # to VETO the verdict outright, which lost the grade on 2 of 5 real cases for a
    # fragment that could be 40 mm away. The local test below is the one that bears on
    # this clearance; the count is worth saying, not worth refusing over.
    comps = (quality or {}).get("canal_components")
    if comps is not None and comps != 2:
        because_note = (
            f"The drawn canal is in {comps} piece(s) rather than 2 somewhere in this "
            f"scan. That is not necessarily near this implant -- the test that bears on "
            f"this measurement is whether the canal is broken WITHIN {GAP_DISQUALIFIES_MM:.0f} mm "
            f"of it, and it is not.")
    else:
        because_note = None

    gap = detail.get("gap_near_site_mm")
    if gap is not None and gap > GAP_DISQUALIFIES_MM:
        because.append(
            f"The canal is drawn in pieces {gap:.1f} mm apart WITHIN its own course near "
            f"this site, so the nearest drawn voxel may not be the nearest nerve.")
    because.extend(clearance.caveats or [])

    if because:
        return Verdict("no_verdict",
                       f"{b['clearance_mm']:.2f} mm to the drawn wall — not graded.",
                       because, b)

    head = b["headroom_mm"]
    if head < 0:
        level, headline = "breach", (
            f"{b['clearance_mm']:.2f} mm — inside the {SAFETY_MARGIN_MM:.1f} mm margin "
            f"once the segmentation's own error is allowed for.")
    elif head < TIGHT_BAND_MM:
        level, headline = "tight", (
            f"{b['clearance_mm']:.2f} mm — clear on the typical case, with only "
            f"{head:.2f} mm to spare against our measured error.")
    else:
        level, headline = "clear", (
            f"{b['clearance_mm']:.2f} mm — {head:.2f} mm of headroom beyond the "
            f"{SAFETY_MARGIN_MM:.1f} mm margin.")
    # From the BUDGET, not from the module constant: on an edited canal the deduction
    # is the model's p95 plus the edit quantisation, and quoting the constant here
    # would have printed 0.46 beside a bar drawn at 0.76.
    because.append(
        f"The drawn wall may sit up to {b['inward_p95_mm']:.2f} mm inside the true one "
        f"at the 95th percentile; the worst single point we have measured is "
        f"{MODEL_INWARD_WORST_MM:.2f} mm, on one case out of twenty.")
    pen = edit_penalty("canal", edits)
    if pen:
        because.append(pen["note"])
    if because_note:
        because.append(because_note)
    because.append(clearance.basis)
    return Verdict(level, headline, because, b)


def inter_implant_verdict(m, a_id: str, b_id: str) -> Verdict:
    """Grade an implant-to-implant distance. NO inward-error term, and that is the point.

    Every other budget in this module deducts the model's own error before grading,
    because every other measurement is taken against something a network drew. This one
    is not: both solids were placed by the user, so the number is exact and the headroom
    is measured against the 3.00 mm convention alone. Saying so is more useful than
    quietly applying a deduction that does not apply.
    """
    v = m.value if m else None
    nums = {"distance_mm": None if v is None else round(v, 2),
            "margin_mm": INTER_IMPLANT_MARGIN_MM,
            "headroom_mm": None if v is None else round(v - INTER_IMPLANT_MARGIN_MM, 2),
            "exact": True}
    pair = f"{a_id} and {b_id}"
    if v is None:
        return Verdict("no_verdict", f"No distance between {pair} could be measured.",
                       list((m.caveats if m else None) or ["not measured"]), nums)
    if v < 0:
        return Verdict("breach", f"{pair} overlap by {abs(v):.2f} mm.",
                       ["The two solids interpenetrate; this is a placement error, not "
                        "a tight clearance.", m.basis], nums)
    head = nums["headroom_mm"]
    if head < 0:
        level, headline = "breach", (
            f"{v:.2f} mm between {pair} — inside the "
            f"{INTER_IMPLANT_MARGIN_MM:.1f} mm minimum.")
    elif head < TIGHT_BAND_MM:
        level, headline = "tight", (
            f"{v:.2f} mm between {pair} — only {head:.2f} mm beyond the "
            f"{INTER_IMPLANT_MARGIN_MM:.1f} mm minimum.")
    else:
        level, headline = "clear", (
            f"{v:.2f} mm between {pair} — {head:.2f} mm of headroom beyond the "
            f"{INTER_IMPLANT_MARGIN_MM:.1f} mm minimum.")
    return Verdict(level, headline,
                   ["Exact: both solids were placed by you, so no segmentation error "
                    "enters this figure and none is deducted from it.", m.basis], nums)


def density_statement(m) -> str:
    """Prose for a density ratio. Never a class, never an absolute number."""
    if m is None or m.value is None:
        return ("No density figure: " + (m.basis if m else "not measured") +
                ". CBCT grey values are not calibrated attenuation, so a number without "
                "a reference population inside the same scan would mean nothing.")
    r = m.value
    where = ("denser than" if r > 1.15 else
             "about as dense as" if r > 0.85 else "less dense than")
    return (f"About {r:.2f}x the cancellous bone elsewhere in this jaw — {where} the "
            f"surrounding trabecular bone. A ratio measured inside this scan, which is "
            f"why it survives the scanner's own grey-scale calibration.")


def apex_statement(m, jaw: str) -> str:
    if m is None or m.value is None:
        return "Bone beyond the apex could not be read: " + (m.basis if m else "not measured")
    s = f"About {m.value:.1f} mm of bone continues past the apex."
    if m.caveats:
        s += " " + " ".join(m.caveats) + "."
    if jaw == "maxilla":
        s += (" Read from the greyscale alone: the sinus outline in this app is annotated "
              "to the edge of the scan rather than to anatomy and must not be measured from.")
    return s


NO_GUIDE_NOTICE = (
    "No surgical guide is produced. A drill guide is a patient-contacting device, and "
    "this canal outline is known to sit up to "
    f"{MODEL_INWARD_WORST_MM:.2f} mm inside the truth at its worst measured point."
)

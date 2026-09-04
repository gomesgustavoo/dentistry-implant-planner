"""The implant catalogue, and the accuracy priors the planning surface reasons from.

**Why a catalogue at all.** `web/app.js` carried the sizes as a JS literal
(`IMPLANT_SIZES`, 4 diameters x 5 lengths) with no server-side counterpart, so nothing
validated a stored implant against a real product and the plan export could not say what
was planned. A specialist plans a *system*, not a pair of numbers.

**These are generic size classes, not a manufacturer's catalogue.** Every entry here is
a diameter/length grid of the kind published across the industry -- narrow, regular and
wide platforms at the standard lengths -- with no manufacturer named, no part number and
no thread geometry. That is deliberate on two counts:

* naming a system would imply this app knows that system's drilling protocol, sleeve
  offsets and prosthetic components, and it knows none of them;
* the geometry this app measures is a capsule of a given diameter and length
  (`plan_geometry.implant_mesh`), which is a faithful envelope for clearance purposes
  and is emphatically NOT the shape of any real implant's threads.

So a plan says "4.1 x 10 mm, regular platform" and means the envelope it measured. A
clinician maps that onto their own system, which is the only party that can.

Ranges are the ones in common clinical use: diameters 3.0-6.0 mm and lengths 6-16 mm.
`api/routes/plans.ImplantIn` independently bounds diameter to (1.5, 8] and length to
(3, 25] -- wider than the catalogue on purpose, so a custom size can still be measured;
the catalogue is a menu, not a gate.
"""
from __future__ import annotations

# Platform classes. The boundaries are the conventional ones and the notes say what each
# class is FOR, because "which diameter" is a clinical question and a bare number is not
# an answer.
PLATFORMS = (
    {"id": "narrow", "label": "Narrow platform", "diameter_mm": [3.0, 3.3, 3.5],
     "note": "Narrow ridges and small gaps -- lower incisors, upper laterals."},
    {"id": "regular", "label": "Regular platform", "diameter_mm": [3.75, 4.1, 4.3],
     "note": "The default for most sites; the longest clinical track record."},
    {"id": "wide", "label": "Wide platform", "diameter_mm": [4.8, 5.0, 6.0],
     "note": "Molar sites with the bone width to take one; also immediate-molar cases."},
)

# Lengths, with what each band is chosen against. The short end exists precisely because
# of the structures this app measures.
LENGTHS = (
    {"length_mm": 6.0, "band": "short",
     "note": "Limited bone height -- above the canal, or below the sinus floor."},
    {"length_mm": 8.0, "band": "short", "note": "Limited height with a little more room."},
    {"length_mm": 10.0, "band": "standard", "note": "The commonest length."},
    {"length_mm": 11.5, "band": "standard", "note": None},
    {"length_mm": 13.0, "band": "standard", "note": None},
    {"length_mm": 14.0, "band": "long",
     "note": "Needs the height to be measured, not assumed."},
    {"length_mm": 16.0, "band": "long",
     "note": "Rarely indicated; check the apical clearance carefully."},
)

DEFAULT_DIAMETER_MM = 4.1
DEFAULT_LENGTH_MM = 10.0


def catalog() -> dict:
    """The menu a client offers, plus the envelope caveat it must show alongside it."""
    return {
        "platforms": [dict(p) for p in PLATFORMS],
        "lengths": [dict(le) for le in LENGTHS],
        "default": {"diameter_mm": DEFAULT_DIAMETER_MM, "length_mm": DEFAULT_LENGTH_MM},
        "diameter_mm": sorted({d for p in PLATFORMS for d in p["diameter_mm"]}),
        "length_mm": [le["length_mm"] for le in LENGTHS],
        "geometry": "capsule",
        "notice": (
            "Generic size classes, not a manufacturer's catalogue. The solid measured "
            "and exported is a cylinder with a rounded apex of the stated diameter and "
            "length -- a faithful envelope for clearance, and not the thread form of "
            "any real implant. No drilling protocol, sleeve offset or prosthetic "
            "component is implied."),
    }


def known_size(diameter_mm: float, length_mm: float) -> bool:
    """Is this size in the catalogue? Informational -- nothing is refused for being off it."""
    return (any(abs(diameter_mm - d) < 1e-6
                for p in PLATFORMS for d in p["diameter_mm"])
            and any(abs(length_mm - le["length_mm"]) < 1e-6 for le in LENGTHS))


def platform_for(diameter_mm: float) -> str | None:
    """Which platform class a diameter falls in, or None when it is off the catalogue."""
    for p in PLATFORMS:
        if any(abs(diameter_mm - d) < 1e-6 for d in p["diameter_mm"]):
            return p["id"]
    return None

"""Available bone at each implant site, independent of any placement.

**Why this belongs in the worker and lands in `sites`.** The FDI dental chart is the
site picker -- `web/app.js::syncPlanToIsolate` already reads
`report.arch.jaws[jaw].sites[fdi].s_mm` to seed an implant -- so a number that only
`POST /measure` can produce cannot colour it. A site has to know how much bone it has
BEFORE an implant exists there. And `ArchFit.sites` flows into both `report.arch` (which
the browser already holds) and `planning/arch.json`, so writing it once here reaches
both consumers with no duplication.

**Everything is read in RATIO units**, `(value - air) / (cancellous - air)`, by the
falling-half-maximum method `plan_metrics.bone_beyond_apex` establishes. So every figure
here is affine-invariant and survives the scanner's own grey-scale calibration -- which
matters more than it sounds: measured gains across real scans run 0.47x to 2.60x, so an
absolute threshold would mean a different thing on every machine.

**Nothing is read from a `FOV_LIMITED` label.** The maxillary sinus floor comes from the
greyscale, never from `sinus_max_left/right`: the largest sinus ever annotated in the
training data is 3.85 cm3 against an anatomical 10-20, because the annotation stops at
the edge of the scan. `labels.py` forbids measuring from those, and a sinus floor taken
from one would be the edge of the field of view wearing an anatomical name.

**It refuses per site rather than interpolating.** A site with no readable crest, or no
canal drawn near it, or whose section leaves the measured band, gets `None` and a
reason. There is no defensible way to guess the height of a ridge you could not find.
"""
from __future__ import annotations

# Reused from `plan_metrics` deliberately: the crest, the sinus floor and the bone past
# an implant apex must all mean the same thing by "cortical", or the numbers cannot be
# compared with each other.
CORTICAL_RATIO = 1.35

# The crest itself is a knife edge on a resorbed ridge and its width is ~0 by
# construction. 1 mm down is where an implant platform actually sits, and it is more
# than three times the 0.3 mm plan grid, so it is resolvable rather than noise.
WIDTH_BELOW_CREST_MM = 1.0

# A maxillary alveolus taller than this is not a maxillary alveolus -- the search has
# left the anatomy. Fits inside the 40 mm superior band `planning_pack.BAND_Z` gives the
# maxilla with 15 mm to spare.
MAX_SINUS_SEARCH_MM = 25.0

# How far INTO the band from the crown side to hunt for the crest -- down from the top
# for the mandible, up from the bottom for the maxilla. See `_crest_z`.
CREST_SEARCH_MM = 20.0
PROFILE_STEP_MM = 0.1

# Half the band's buccolingual half-width: far enough to cross either cortical plate on
# any real ridge, near enough that the search cannot wander into the next tooth.
WIDTH_SEARCH_MM = 10.0

# How far either side of the crest midline the canal roof is looked for.
#
# The height used to be measured down a SINGLE ray at `t = 0` and required that ray to
# enter the canal. Measured on a real full-dentition case, that refused 6 of 16
# mandibular sites -- FDI 36, 37, 38, 46, 47, 48, which is every molar, the most common
# implant sites there are -- with "no drawn canal within 45 mm below the crest at this
# site". The canal was directly below all six: nearest approach to the midline column
# **0.33 to 1.90 mm**, offset buccally by only 1.0 to 2.5 mm. A ray misses a 2 mm-wide
# tube by a hair and the site reads as having no canal under it at all.
#
# 3.0 mm is the radius of the widest platform in `dentistry/implants.catalog()`, so this
# is the footprint of the largest implant that could be placed at the site rather than
# an arbitrary window. Anything the canal does outside it is not under the implant.
CANAL_OFFSET_SEARCH_MM = 3.0
CANAL_OFFSET_STEP_MM = 0.5


def _ratio_profile(sampler, s_mm, t_mm, z_from, z_to, refs):
    """`(zs, ratios)` sampled vertically, or `(None, None)` with no usable reference."""
    air, ref = refs.get("air"), refs.get("cancellous")
    if air is None or ref is None or abs(ref - air) < 1e-6:
        return None, None
    n = max(2, int(round(abs(z_to - z_from) / PROFILE_STEP_MM)) + 1)
    step = (z_to - z_from) / (n - 1)
    zs = [z_from + i * step for i in range(n)]
    vals = sampler.sample("grey", [(s_mm, t_mm, z) for z in zs])
    return zs, [(v - air) / (ref - air) for v in vals]


def _falling_half_max(xs, ratios, peak_i):
    """Where the profile falls to half-way between its peak and 1.0, interpolated.

    The half-maximum edge, not the peak and not where the value reaches air. That edge
    is the boundary that repeats across scans -- the same argument
    `plan_metrics.bone_beyond_apex` makes, and the same one that puts the exported
    iso-surface 0.11 mm inside the image's own half-max crossing.
    """
    half = (ratios[peak_i] + 1.0) / 2.0
    for i in range(peak_i + 1, len(ratios)):
        if ratios[i] <= half:
            a, b = ratios[i - 1], ratios[i]
            frac = 0.0 if a == b else (a - half) / (a - b)
            return xs[i - 1] + frac * (xs[i] - xs[i - 1])
    return None


def _crest_z(sampler, s_mm, refs, jaw, z_top, z_bottom):
    """The most coronal cortical crossing at the mid-crest, or None.

    **The search runs from the CROWN side inward, and the crown side differs by jaw.**
    Mandibular crowns point up, so the crest is at the TOP of the band and the search
    walks down from it. Maxillary crowns hang DOWN, so the maxillary crest is at the
    BOTTOM of the band and the search walks up.

    Getting that backwards is not a subtle failure but it is a silent one: measured on a
    real full-dentition case, searching downward from the top of the maxillary band
    reported "no cortical crest found" for all 16 maxillary sites, because the top of
    that band is 40 mm above the occlusal plane -- up in the orbit, not in the alveolus.
    Every maxillary height and width came back None with a plausible-sounding reason.

    The first RISING crossing of `CORTICAL_RATIO` is the cortical plate of the ridge --
    not the first non-air voxel, which is mucosa, and not a label boundary, which for
    the maxilla would be the edge of the scan.
    """
    up = jaw == "maxilla"
    z_from = z_bottom if up else z_top
    z_to = (z_bottom + CREST_SEARCH_MM) if up else (z_top - CREST_SEARCH_MM)
    zs, ratios = _ratio_profile(sampler, s_mm, 0.0, z_from, z_to, refs)
    if zs is None:
        return None, "this scan has no usable cancellous reference population"
    for i, r in enumerate(ratios):
        if r >= CORTICAL_RATIO:
            return zs[i], None
    return None, (f"no cortical crest was found within {CREST_SEARCH_MM:.0f} mm of the "
                  f"{'bottom' if up else 'top'} of the measured band, where a "
                  f"{jaw} crest would be")


def _canal_roof_z(sampler, s_mm, crest_z):
    """`(z, t)` of the shallowest drawn canal below this site, or `(None, None)`.

    A distance field, sampled down a vertical column and asked where it reaches zero.
    The column is swept across `CANAL_OFFSET_SEARCH_MM` because insisting on `t = 0`
    made this refuse every molar on a real case -- see that constant. The SHALLOWEST
    crossing over the sweep wins, not the nearest: available bone height is how far you
    can go down before meeting the canal, so the first thing the implant would reach is
    the answer, wherever across its own footprint that is.

    `0.15` is half the 0.3 mm plan grid: a sample that close to the zero level set is
    inside the canal to within the field's own resolution, and demanding a strictly
    negative sample would miss a tube thinner than one voxel.
    """
    n = max(2, int(round(45.0 / PROFILE_STEP_MM)) + 1)
    zs = [crest_z - i * (45.0 / (n - 1)) for i in range(n)]
    steps = int(round(CANAL_OFFSET_SEARCH_MM / CANAL_OFFSET_STEP_MM))
    # `t = 0` first, so a canal genuinely under the midline reports no offset at all.
    offsets = [0.0] + [sign * k * CANAL_OFFSET_STEP_MM
                       for k in range(1, steps + 1) for sign in (1.0, -1.0)]
    best_z, best_t = None, None
    for t in offsets:
        ds = sampler.sample("canal", [(s_mm, t, z) for z in zs])
        hit = next((zs[i] for i, d in enumerate(ds) if d <= 0.15), None)
        if hit is not None and (best_z is None or hit > best_z):
            best_z, best_t = hit, t
    return best_z, best_t


def measure_sites(sampler, fit_info: dict, jaw: str, refs: dict,
                  canal_block: dict | None = None) -> dict:
    """`{fdi: {...}}` -- available bone height and crestal width per published site.

    `sampler` is a Sampler over the measurement pack for this jaw, so these figures are
    read from exactly the field `POST /measure` reads. That is the point: a site's
    reported height and an implant's measured clearance must not come from two different
    samplings of the same scan.

    Each entry carries a `basis` for anything it reports and a `reason` for anything it
    refuses, so a site's height is never a bare float in the manifest.
    """
    from dentistry import plan_metrics as PM

    out: dict = {}
    sites = fit_info.get("sites") or {}
    lat = (sampler.header().get("lattice") or {})
    z_top = float(lat.get("z_top_mm", 0.0))
    z_bottom = z_top - (int(lat.get("n_z", 1)) - 1) * float(lat.get("step_mm", 0.3))
    bounds = sampler.bounds() if hasattr(sampler, "bounds") else None
    has_canal = "canal" in (sampler.header().get("fields") or {})

    for fdi, site in sites.items():
        s_mm = site.get("s_mm")
        # EVERY key, every time. `attach_site_measurements` merges this into the
        # published `sites` entry with `.update()`, so a key left out survives from a
        # previous run -- and measured on a real case that meant a site which now
        # carries a height still displayed "no cortical crest was found", because the
        # earlier refusal's `reason` was never cleared. A complete record cannot do that.
        entry = {"height_mm": None, "width_mm": None, "crest_z_mm": None,
                 "reason": None, "height_reason": None, "width_reason": None,
                 "basis_height": None, "basis_width": None,
                 "position_interpolated": bool(site.get("interpolated"))}
        if s_mm is None:
            entry["reason"] = "this site has no arc position"
            out[str(fdi)] = entry
            continue
        if bounds and not (bounds["s"][0] <= s_mm <= bounds["s"][1]):
            entry["reason"] = ("this site lies outside the measured band, so its section "
                               "is read off the band edge rather than measured")
            out[str(fdi)] = entry
            continue

        crest, why = _crest_z(sampler, s_mm, refs, jaw, z_top, z_bottom)
        if crest is None:
            entry["reason"] = why
            out[str(fdi)] = entry
            continue
        entry["crest_z_mm"] = round(crest, 2)

        # ---- height ---------------------------------------------------------
        if jaw == "mandible":
            if not has_canal:
                entry["height_reason"] = ("no inferior alveolar canal is drawn on this "
                                          "case, so there is no roof to measure to")
            else:
                # The canal ROOF, from the same distance field the implant clearance
                # uses, so the two cannot disagree about where the canal is.
                pres = (PM.canal_presence_near(canal_block, s_mm)
                        if canal_block else {"terminal": False, "nearest_present_mm": None})
                if pres.get("terminal"):
                    entry["height_reason"] = (
                        "the inferior alveolar canal has ended by this site (the mental "
                        "foramen), so height to the canal is not the limit here"
                        + (f"; the nearest drawn canal is "
                           f"{pres['nearest_present_mm']:.0f} mm away along the arch"
                           if pres.get("nearest_present_mm") is not None else ""))
                else:
                    roof, t_at = _canal_roof_z(sampler, s_mm, crest)
                    if roof is None:
                        entry["height_reason"] = (
                            "no drawn canal within 45 mm below the crest at this site, "
                            f"anywhere within {CANAL_OFFSET_SEARCH_MM:.0f} mm either "
                            "side of the crest midline")
                    else:
                        entry["height_mm"] = round(crest - roof, 2)
                        entry["basis_height"] = (
                            "cortical crest to the roof of the drawn inferior alveolar "
                            "canal, read from the same distance field the implant "
                            "clearance is measured against"
                            + (f"; the canal sits {abs(t_at):.1f} mm "
                               f"{'buccal' if t_at > 0 else 'lingual'} of the crest "
                               "midline here, so the roof is taken there"
                               if abs(t_at) > 1e-9 else " down the crest midline"))
        else:
            # Maxilla: the sinus FLOOR, from the greyscale only. Never from the sinus
            # label -- see the module docstring.
            zs, ratios = _ratio_profile(sampler, s_mm, 0.0, crest,
                                        crest + MAX_SINUS_SEARCH_MM, refs)
            floor = None
            if zs is not None:
                peak = next((i for i, r in enumerate(ratios) if r >= CORTICAL_RATIO), None)
                if peak is not None:
                    floor = _falling_half_max(zs, ratios, peak)
            if floor is None:
                entry["height_reason"] = (
                    f"no sinus floor found within {MAX_SINUS_SEARCH_MM:.0f} mm above the "
                    f"crest; read from the greyscale, because both maxillary sinus labels "
                    f"are annotated to the edge of the scan rather than to anatomy")
            else:
                entry["height_mm"] = round(abs(floor - crest), 2)
                entry["basis_height"] = (
                    "cortical crest to the falling half-maximum of the next cortical "
                    "peak superiorly -- the sinus floor read from the greyscale, in "
                    "ratio units, never from the FOV-limited sinus label")

        # ---- width ----------------------------------------------------------
        z_w = crest - WIDTH_BELOW_CREST_MM if jaw != "maxilla" \
            else crest + WIDTH_BELOW_CREST_MM
        edges = {}
        for side, sign in (("buccal", 1.0), ("lingual", -1.0)):
            n = max(2, int(round(WIDTH_SEARCH_MM / PROFILE_STEP_MM)) + 1)
            ts = [sign * i * (WIDTH_SEARCH_MM / (n - 1)) for i in range(n)]
            vals = sampler.sample("grey", [(s_mm, t, z_w) for t in ts])
            air, ref = refs.get("air"), refs.get("cancellous")
            if air is None or ref is None or abs(ref - air) < 1e-6:
                break
            ratios = [(v - air) / (ref - air) for v in vals]
            peak = next((i for i, r in enumerate(ratios) if r >= CORTICAL_RATIO), None)
            edges[side] = (None if peak is None
                           else _falling_half_max([abs(t) for t in ts], ratios, peak))
        if edges.get("buccal") is not None and edges.get("lingual") is not None:
            entry["width_mm"] = round(edges["buccal"] + edges["lingual"], 2)
            entry["basis_width"] = (
                f"outer falling half-maximum of the buccal and lingual cortical plates, "
                f"measured {WIDTH_BELOW_CREST_MM:.0f} mm below the crest where an implant "
                f"platform sits, in ratio units so it survives recalibration")
        else:
            missing = [k for k in ("buccal", "lingual") if not edges.get(k)]
            entry["width_reason"] = (
                f"no cortical plate found on the {' or '.join(missing) or 'either'} side "
                f"within {WIDTH_SEARCH_MM:.0f} mm -- a knife-edge or resorbed ridge "
                f"genuinely has none, and that is the finding")
        out[str(fdi)] = entry
    return out

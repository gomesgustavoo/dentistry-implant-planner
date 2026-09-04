/* Implants in the 3D pane: place, drag, re-angulate, remove.
 *
 * NEW in bundle revision 6 (2026-09-02). Everything else in `src/index.js` is a
 * transcription of the shipped artifact; this is the feature that artifact could not
 * have, because its only way to add geometry was `addSurface`, which is memoised, has
 * no remove and no update, and takes its colour from the anatomy palette. Anatomy is
 * immutable and streams once; an implant is mutable, dragged, and coloured by a
 * verdict. Hence a separate registry.
 *
 * ## The pose, and why the geometry is rebuilt rather than transformed
 *
 * An implant's pose lives in the ARCH frame `(s_mm, t_mm, z_mm, tilt_deg, yaw_deg)` and
 * has to become patient LPS. `vtkProp3D.setUserMatrix` exists and would work, but the
 * points are rebuilt each frame instead, for one decisive reason and two cheap ones:
 *
 *  - **Provability.** Rebuilding applies the SAME `origin + v0*e1 + v1*e2 + v2*ax` map
 *    to the SAME local vertices as `dentistry/plan_geometry.py::implant_triangles_lps`,
 *    so a golden-vector file can assert the two agree to 1e-9. A 4x4 matrix is a second,
 *    independent representation of the pose, and this codebase's whole discipline is
 *    one map with one place to be wrong. That mattered: the Python side was found on
 *    2026-09-02 to be applying a SHEAR -- it used the buccal normal itself as a frame
 *    axis, so `ax . e1 = sin(tilt)` and the platform face was not perpendicular to the
 *    axis at any nonzero tilt.
 *  - Cost. The drawn screw is ~9k vertices at 96 azimuths and the safety envelope ~3.7k
 *    at 160 azimuths by 20 dome rings; that many 9-multiply-add transforms and a
 *    ~150 KB VBO upload is nothing against a frame, and only the SELECTED implant moves.
 *  - `setUserMatrix` also perturbs `getBounds()`, which Cornerstone's `resetCamera`
 *    consumes -- an extra coupling for no gain.
 *
 * The frame is built from the PUBLISHED `points` and `normals` of `planning/arch.json`
 * and never re-derived. `ArchFit.normals()` picks its sign by moving away from the
 * arch's own centroid, and any reimplementation of that rule is a silent mirror waiting
 * to happen. Measured on real cases, that sign even FLIPS at the extreme arch ends on
 * some fits, which is why nothing here tries to reconstruct it from geometry.
 *
 * ## Yaw is accepted and asserted zero
 *
 * A yawed implant leaves the drawn cross-section, so the 2-D view would be lying about
 * a pose the 3-D view shows. The Python STL writer implements yaw now; the UI does not
 * offer it yet, and until it does, showing it in 3-D alone would be worse than not
 * having it.
 */
import vtkCellArray from '@kitware/vtk.js/Common/Core/CellArray';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';

const N_AZIMUTH = 48;
const DOME_RINGS = 6;

/** Tessellation of the SAFETY ENVELOPE, independent of `N_AZIMUTH`.
 *
 *  Same reasoning as `SCREW_AZIMUTH`: `N_AZIMUTH`/`DOME_RINGS` stay 48/6 because
 *  `capsuleLocal` at those values is diffed triangle-for-triangle against
 *  `dentistry/plan_geometry.implant_mesh`. But the cross-language check builds its OWN
 *  capsule (see `implantGeometryForTest`) and never looks at the shell, so the shell is
 *  free to be as fine as it is worth being.
 *
 *  At 48 azimuths the silhouette is a 48-gon -- 7.5 degrees per facet -- and 6 dome
 *  rings put 15 degrees between apical rings. On an envelope that is DRAWN TRANSLUCENT,
 *  every one of those facet boundaries is an alpha step, so the faceting reads far
 *  harder than it does on the opaque body. 160 azimuths take the silhouette to 2.25
 *  degrees and 20 rings take the dome to 4.5, at ~3.4k vertices -- still a rounding
 *  error next to the 42 anatomy surfaces sharing the pane.
 */
const SHELL_AZIMUTH = 160;
const SHELL_DOME_RINGS = 20;

/** Half-height of the 3-D frame, in implant lengths, when one is selected. See
 *  `framedScale`: the pane's job is the implant's neighbourhood, not the implant. */
const CONTEXT_FRAME = 2.2;

/* ------------------------------------------------------- the drawn screw
 * The measured solid is a CAPSULE -- a cylinder of the stated diameter closed by an
 * apical hemisphere. `dentistry/implants.py` already says so to the user: "the solid
 * measured and exported is a cylinder with a rounded apex of the stated diameter and
 * length -- a faithful envelope for clearance, and not the thread form of any real
 * implant".
 *
 * What was drawn was that capsule, literally, and it read as a coloured pill. So the
 * DRAWING becomes a generic threaded screw and the CLAIM stays the capsule:
 *
 *     the thread crest lies exactly ON the capsule, the valleys strictly INSIDE it.
 *
 * That makes the display error one-signed and in the safe direction -- a drawn screw
 * can only occupy less space than the solid the clearance was computed against, never
 * more -- and it is asserted, not asserted-by-comment: `check-equivalence.mjs` now
 * checks every drawn vertex against a closed-form capsule SDF built from the same two
 * numbers the server measures and the STL writer receives.
 *
 * The parameters are the FEA literature's central values (pitch ~0.8 mm, depth ~0.4 mm,
 * a 60-degree included V, an unthreaded machined collar of roughly 1-2 mm). They are
 * generic on purpose: naming a system would imply this app knows that system's drilling
 * protocol, and it knows none of them.
 */
/** Azimuthal resolution of the DRAWN screw, independent of `N_AZIMUTH`.
 *
 *  `N_AZIMUTH` stays 48 because `capsuleLocal` has to tessellate exactly the way
 *  `dentistry/plan_geometry.implant_mesh` does -- that is what the cross-language check
 *  compares. The screw is a picture and can be as fine as it is worth being. At 48 the
 *  silhouette is a visible 48-gon at implant zoom and the helix stair-steps; 96 halves
 *  the facet angle to 3.75 degrees and costs ~8k extra vertices, which is 0.05 ms in
 *  the per-frame transform.
 */
const SCREW_AZIMUTH = 96;

const THREAD_PITCH_MM = 0.80;
const THREAD_HALF_ANGLE_DEG = 30;        // 60 degrees included, the ISO-metric V
const THREAD_CREST_FLAT_MM = 0.08;       // the bright helical highlight; the screw cue
const THREAD_DEPTH_FRAC = 0.10;          // of the OUTER diameter -> core/outer ~0.80
const THREAD_DEPTH_MIN_MM = 0.30;
const THREAD_DEPTH_MAX_MM = 0.45;
const COLLAR_FRAC = 0.12;                // of the length
const COLLAR_MIN_MM = 0.90;
const COLLAR_MAX_MM = 1.60;
const PLATFORM_CHAMFER_MM = 0.20;
const THREAD_LEADIN_MM = 0.80;           // one turn of run-in and run-out

/* The three things that make it a DENTAL implant rather than a machine screw. */
const TAPER_FRAC = 0.10;                 // of the diameter, in RADIUS, over the body
const BUTTRESS_STEEP_FRAC = 0.16;        // axial run of the load flank, in depths
const BUTTRESS_SHALLOW_FRAC = 1.15;      // ...and of the trailing flank
const MICRO_PITCH_MM = 0.28;             // circumferential grooves at the collar
const MICRO_DEPTH_MM = 0.07;

/* The apex. A real implant closes on a small rounded tip, roughly a fifth of its own
 * radius; the measured capsule closes on a hemisphere of the FULL radius, which on a
 * 6 mm implant is a 3 mm ball. The drawn tip stays inside that hemisphere and touches
 * it only at the apex point, so the one dimension the canal verdict depends on -- how
 * deep the implant goes -- is drawn at full length while the bulb is gone. */
const APEX_TIP_FRAC = 0.22;
const APEX_CONE_RINGS = 5;

/** Machined titanium. VERDICT-INDEPENDENT, and that is the point of the change.
 *
 *  The body's hue used to BE the verdict, which cost two things at once: the reader
 *  could not tell metal from a warning, and `breach` salmon collided with the coral the
 *  inferior alveolar canal surface is drawn in -- the alarm and the structure it was
 *  about were the same colour. The verdict now lives on the safety envelope, on the 2-D
 *  collar band and on the side panel's chip.
 *
 *  NEVER set `specularColor` separately. `vtkProperty.setColor` writes all three colour
 *  components and `getColor()` recomputes a normalised blend of them, so a white
 *  specular would make the colour read back as something nobody set -- which two checks
 *  compare against the palette. It is also the physically right constraint: metals tint
 *  their specular reflection with their own base colour. A white one is what a
 *  dielectric does. */
const BODY_RGB = [150, 155, 163];

/* The four colours `web/app.js` already uses for the 2-D outline. Shared verbatim so
 * the section and the 3-D actor can never disagree about a verdict. NEUTRAL is not a
 * fourth verdict -- it is the absence of one, and it is what shows while a measurement
 * is in flight. A colour a reader interprets as "safe" must never come from anything
 * but a completed measurement. */
const VERDICT_RGB = {
  breach: [248, 113, 113],
  tight: [251, 191, 36],
  clear: [52, 211, 153],
};
const NEUTRAL_RGB = [148, 163, 184];

let host = null;          // { engine, viewportId, isMounted }
let arch = null;          // planning/arch.json, by reference
const registry = new Map();
let rafHandle = 0;

export function attach(h) {
  host = h;
  // A pose published before mount has to survive it: the plan tab and the MPR panes are
  // independent, and `setImplants` can legitimately arrive first.
  if (pending.length) {
    const list = pending.splice(0, pending.length).pop();
    if (list) setImplants(list);
  }
}

const pending = [];

export function teardown() {
  const viewport = host && host.engine && host.engine.getViewport(host.viewportId);
  registry.forEach((entry, id) => {
    try {
      if (viewport) viewport.removeActors([actorUid(id)]);
    } catch { /* the viewport went first */ }
    try {
      entry.mapper.delete();
      entry.actor.delete();
    } catch { /* already deleted */ }
  });
  registry.clear();
  if (rafHandle) {
    cancelAnimationFrame(rafHandle);
    rafHandle = 0;
  }
}

const actorUid = (id) => `dent-implant-${id}`;
const shellUid = (id) => `dent-implant-shell-${id}`;

/** The radius the safety envelope is drawn at, per jaw.
 *
 *  NOT the bare `SAFETY_MARGIN_MM` of 2.00. `plan_safety.budget_for` grades a breach
 *  when `clearance < margin + inward_p95`, so the surface the verdict is computed
 *  against is 2.00 + 0.46 = 2.46 mm for the inferior alveolar canal. Drawing 2.00 would
 *  put the shell INSIDE the line it exists to mark. The maxilla has no canal, so its
 *  shell is drawn at the adjacent-tooth boundary, 1.50 + 0.34.
 *
 *  Duplicated from `plan_safety.py` as a DRAWING constant only -- no number here is ever
 *  used to grade anything; every verdict on screen comes from the server. */
const SHELL_MARGIN_MM = { mandible: 2.46, maxilla: 1.84 };

/** Publish the arch manifest. Must precede `setImplants`. Stored by reference. */
export function setImplantArch(manifest) {
  arch = manifest || null;
}

/* ------------------------------------------------------------------ local mesh */

/** An indexed capsule in the implant's own frame: `+z` apical, platform disc at z = 0.
 *
 *  Emits triangles in exactly the order `dentistry/plan_geometry.py::implant_mesh`
 *  does -- platform disc, then the two barrel triangles per azimuth, then the dome
 *  rings -- so the expanded index buffer can be diffed against the Python triangle
 *  list rather than merely resembling it.
 *
 *  Normals are ANALYTIC. The anatomy meshes are dense enough that vtk.js's
 *  shader-derived face normals look smooth, but a 48-facet barrel visibly facets, and
 *  a faceted implant reads as a rendering artifact rather than as metal.
 */
function capsuleLocal(lengthMm, diameterMm, nAz = N_AZIMUTH, nRings = DOME_RINGS) {
  const r = diameterMm / 2;
  const shoulder = Math.max(0, lengthMm - r);
  const verts = [];
  const norms = [];
  const cells = [];

  const push = (x, y, z, nx, ny, nz) => {
    verts.push(x, y, z);
    norms.push(nx, ny, nz);
    return verts.length / 3 - 1;
  };

  const centre = push(0, 0, 0, 0, 0, -1);            // the platform face
  const top = [];
  const topFace = [];
  const bot = [];
  for (let i = 0; i < nAz; i++) {
    const th = (2 * Math.PI * i) / nAz;
    const cx = Math.cos(th);
    const cy = Math.sin(th);
    // The platform rim needs TWO vertices per azimuth with different normals: one
    // facing along -z for the flat face, one facing radially for the barrel. Sharing
    // them would average the two and round off the platform edge.
    topFace.push(push(r * cx, r * cy, 0, 0, 0, -1));
    top.push(push(r * cx, r * cy, 0, cx, cy, 0));
    bot.push(push(r * cx, r * cy, shoulder, cx, cy, 0));
  }
  for (let i = 0; i < nAz; i++) {
    const j = (i + 1) % nAz;
    cells.push(3, centre, topFace[j], topFace[i]);
    cells.push(3, top[i], top[j], bot[j]);
    cells.push(3, top[i], bot[j], bot[i]);
  }

  let prev = bot;
  for (let k = 1; k <= nRings; k++) {
    const th = (k / nRings) * (Math.PI / 2);
    const ringR = r * Math.cos(th);
    const ringZ = shoulder + r * Math.sin(th);
    const ring = [];
    for (let i = 0; i < nAz; i++) {
      const a = (2 * Math.PI * i) / nAz;
      const cx = Math.cos(a);
      const cy = Math.sin(a);
      // Radial from the dome's CENTRE, which sits at z = shoulder.
      ring.push(push(ringR * cx, ringR * cy, ringZ,
                     cx * Math.cos(th), cy * Math.cos(th), Math.sin(th)));
    }
    for (let i = 0; i < nAz; i++) {
      const j = (i + 1) % nAz;
      cells.push(3, prev[i], prev[j], ring[j]);
      cells.push(3, prev[i], ring[j], ring[i]);
    }
    prev = ring;
  }

  return {
    verts: new Float32Array(verts),
    normals: new Float32Array(norms),
    cells: new Uint32Array(cells),
    nTris: cells.length / 4,
  };
}

/** The measured envelope's radius at depth `z`: `r` on the barrel, the hemisphere below.
 *  This is the capsule `plan_metrics.capsule_radius_at` walks, in the same frame. */
function envelopeRadius(z, r, shoulder) {
  if (z <= shoulder) return r;
  const d = z - shoulder;
  return d >= r ? 0 : Math.sqrt(Math.max(0, r * r - d * d));
}

/** A generic threaded screw, strictly inside `capsuleLocal(lengthMm, diameterMm)`.
 *
 *  Built as a continuous helical STRIP indexed by (column, profile station), not as
 *  stacked z-rings. The ring form is the obvious one and it is wrong: closing each ring
 *  from the last azimuth back to the first jumps BACKWARD by a whole pitch, which
 *  produces one full-turn sliver triangle per ring. Along a strip the helix is
 *  continuous by construction and the profile breakpoints land exactly on the sampling
 *  grid, so the crest edges do not jitter.
 *
 *  Four stations per turn -- root, rising flank, crest, falling flank -- each DOUBLED,
 *  because a shared vertex at a crest averages two flank normals 30 degrees apart and
 *  produces a radial normal, i.e. a smooth barrel. The creases have to stay creases or
 *  it does not read as a thread.
 *
 *  The collar and the apical dome are NOT threaded: they lie exactly on the envelope,
 *  identical to what the 2-D outline and the exported STL show. The apex is where the
 *  canal verdict is decided and is the one place a reader scrutinises, so it is drawn
 *  as the thing that was measured and nothing else.
 */
function screwLocal(lengthMm, diameterMm, nAz = SCREW_AZIMUTH) {
  const r = diameterMm / 2;
  const shoulder = Math.max(0, lengthMm - r);
  const depth = Math.min(THREAD_DEPTH_MAX_MM,
                         Math.max(THREAD_DEPTH_MIN_MM, THREAD_DEPTH_FRAC * diameterMm));
  const collar = Math.min(COLLAR_MAX_MM,
                          Math.max(COLLAR_MIN_MM, COLLAR_FRAC * lengthMm));
  const chamfer = Math.min(PLATFORM_CHAMFER_MM, 0.25 * r, 0.4 * collar);
  const zStart = collar;
  const zEnd = shoulder;
  // Too short to carry a thread at all (a 6 x 6.0 implant has 3 mm of barrel): fall
  // back to the envelope rather than draw a thread that is all run-in and run-out.
  if (!(zEnd - zStart > 2 * THREAD_PITCH_MM)) {
    return capsuleLocal(lengthMm, diameterMm, nAz);
  }
  const taper = Math.min(TAPER_FRAC * diameterMm, 0.45 * (zEnd - zStart));

  const verts = []; const norms = []; const cells = [];
  const push = (x, y, z, nx, ny, nz) => {
    verts.push(x, y, z); norms.push(nx, ny, nz);
    return verts.length / 3 - 1;
  };
  /** A ring of nAz vertices at one radius and depth, with one (r, z) normal. */
  const ring = (rho, z, nr, nz) => {
    const out = [];
    const L = Math.hypot(nr, nz) || 1;
    for (let i = 0; i < nAz; i++) {
      const th = (2 * Math.PI * i) / nAz;
      const cx = Math.cos(th); const cy = Math.sin(th);
      out.push(push(rho * cx, rho * cy, z, (nr / L) * cx, (nr / L) * cy, nz / L));
    }
    return out;
  };
  /** Skin between two rings, outward-facing. */
  const skin = (a, b) => {
    for (let i = 0; i < nAz; i++) {
      const j = (i + 1) % nAz;
      cells.push(3, a[i], a[j], b[j]);
      cells.push(3, a[i], b[j], b[i]);
    }
  };

  // --- the platform: an ANNULUS, not a disc -------------------------------------
  // A dental implant is not a bolt: its coronal face is a ring around an internal
  // connection, and that recess is the single most recognisable thing about the form.
  // Drawn as a conical lead-in into a hex socket, which is what a driver engages.
  const socketR = Math.max(0.20, 0.42 * r);
  const hexR = socketR * 0.78;
  const socketZ = Math.min(1.9, 0.55 * collar + 1.0);
  const rimIn = ring(socketR, 0, 0, -1);
  const rimOut = ring(Math.max(socketR + 0.05, r - chamfer), 0, 0, -1);
  skin(rimIn, rimOut);
  const cham = ring(r, chamfer, 0.7071, -0.7071);
  skin(rimOut, cham);

  // The connection, pointing INWARD: a cone down to a hexagon, then a floor.
  {
    const coneEnd = 0.45 * socketZ;
    const lead = ring(socketR, 0, -0.55, -0.84);
    const hexTop = [];
    const hexBot = [];
    for (let i = 0; i < nAz; i++) {
      const th = (2 * Math.PI * i) / nAz;
      // Six flats. The inscribed radius of a hexagon at angle th is
      // R / cos(th mod 60deg - 30deg), which is what makes it read as a hex socket and
      // not as a second cone.
      const seg = ((th % (Math.PI / 3)) - Math.PI / 6);
      const rho = hexR / Math.cos(seg);
      const cx = Math.cos(th); const cy = Math.sin(th);
      hexTop.push(push(rho * cx, rho * cy, coneEnd, -cx, -cy, 0));
      hexBot.push(push(rho * cx, rho * cy, socketZ, -cx, -cy, 0));
    }
    skin(hexTop, lead);            // reversed, so the cone faces inward
    skin(hexBot, hexTop);
    const floor = push(0, 0, socketZ, 0, 0, -1);
    for (let i = 0; i < nAz; i++) {
      const j = (i + 1) % nAz;
      cells.push(3, floor, hexBot[i], hexBot[j]);
    }
  }

  // --- the MICROTHREADED collar --------------------------------------------------
  // Fine circumferential grooves rather than a polished cylinder. Microthreads at the
  // collar are a standard feature -- they are there to spread occlusal load and spare
  // the marginal bone -- and they are what stops the coronal third reading as a bolt
  // shank. Circumferential rather than helical: at implant zoom the two are
  // indistinguishable, one costs a lathe and the other a second helical strip, and
  // externally micro-GROOVED collars are themselves a real design.
  let prev = cham;
  {
    const n = Math.max(2, Math.round((zStart - chamfer) / MICRO_PITCH_MM));
    for (let k = 1; k <= n; k++) {
      const z0 = chamfer + ((zStart - chamfer) * (k - 1)) / n;
      const z1 = chamfer + ((zStart - chamfer) * k) / n;
      const mid = (z0 + z1) / 2;
      const root = ring(r - MICRO_DEPTH_MM, mid, 0.55, 0.83);
      const crest = ring(r, z1, 0.55, -0.83);
      skin(prev, root);
      skin(root, crest);
      prev = crest;
    }
  }

  // --- the TAPERED, BUTTRESS-THREADED body ---------------------------------------
  // Two things a symmetric V thread on a parallel shank does not have, and both are
  // what a reader recognises:
  //
  //  - a TAPER. Most modern implants are conical; it is what gives them their primary
  //    stability, and a parallel-sided body reads as a machine screw. The crest walks
  //    inward from `r` at the collar to `r - taper` at the shoulder, so the solid stays
  //    inside the measured cylinder everywhere and touches it only at the top -- an
  //    error in the safe direction, and the direction the clearance is quoted in.
  //
  //  - a BUTTRESS profile. One flank near-perpendicular to the axis to resist pull-out,
  //    the other long and shallow. Symmetric V is the early form; buttress and its
  //    reverse are what modern implants use, and the asymmetry is visible at a glance.
  const crestAt = (z) => {
    const u = Math.max(0, Math.min(1, (z - zStart) / (zEnd - zStart)));
    return Math.min(envelopeRadius(z, r, shoulder), r - taper * u);
  };
  const P = THREAD_PITCH_MM;
  const steep = Math.max(0.04, BUTTRESS_STEEP_FRAC * depth);
  const shallow = Math.max(0.10, BUTTRESS_SHALLOW_FRAC * depth);
  const crestFlat = THREAD_CREST_FLAT_MM;
  const rootFlat = P - crestFlat - steep - shallow;
  if (rootFlat <= 0.04) return capsuleLocal(lengthMm, diameterMm, nAz);
  const STEEP = [steep, depth];        // (r, z) outward normal of the steep flank
  const SHALLOW = [shallow, -depth];
  const FLAT = [1, 0];
  const stations = [
    [0, 0, FLAT],                                   // crest, leading edge
    [crestFlat, 0, FLAT],                           // crest, trailing edge
    [crestFlat, 0, STEEP],                          // crease into the steep flank
    [crestFlat + steep, depth, STEEP],              // root, leading edge
    [crestFlat + steep, depth, FLAT],               // crease into the root
    [crestFlat + steep + rootFlat, depth, FLAT],    // root, trailing edge
    [crestFlat + steep + rootFlat, depth, SHALLOW], // crease into the shallow flank
    [P, 0, SHALLOW],                                // next crest, leading edge
    [P, 0, FLAT],                                   // crease; station 0 one pitch on
  ];
  const turns = (zEnd - zStart) / P;
  const cols = Math.max(2, Math.round(turns * nAz));
  const grid = [];
  for (let g = 0; g <= cols; g++) {
    const th = (2 * Math.PI * g) / nAz;
    const cx = Math.cos(th); const cy = Math.sin(th);
    const zBase = zStart + (P * g) / nAz;
    const row = [];
    for (let m = 0; m < stations.length; m++) {
      const [off, drop, face] = stations[m];
      const z = Math.min(zEnd, Math.max(zStart, zBase + off));
      // Lead-in and run-out, so the strip meets the collar and the dome flush.
      const lead = Math.min(THREAD_LEADIN_MM, 0.3 * (zEnd - zStart));
      const amp = Math.max(0, Math.min(1, Math.min((z - zStart) / lead,
                                                   (zEnd - z) / lead)));
      const rho = Math.max(0.02, crestAt(z) - drop * amp);
      let nr = face[0]; let nz = face[1];
      const nt = -(P / (2 * Math.PI * Math.max(rho, 0.05))) * nz;
      const len = Math.hypot(nr, nz, nt) || 1;
      nr /= len; nz /= len;
      const ntn = nt / len;
      row.push(push(rho * cx, rho * cy, z,
                    nr * cx - ntn * cy, nr * cy + ntn * cx, nz));
    }
    grid.push(row);
  }
  for (let g = 0; g < cols; g++) {
    for (let m = 0; m + 1 < stations.length; m++) {
      const a = grid[g][m]; const b = grid[g][m + 1];
      const c = grid[g + 1][m + 1]; const d = grid[g + 1][m];
      cells.push(3, a, b, c);
      cells.push(3, a, c, d);
    }
  }

  // --- the core, under the thread -------------------------------------------------
  // The helical strip is a surface, not a solid: at its lead-in seam there is nothing
  // behind it and you look straight into the implant's own inside. Subdivided one
  // segment per turn rather than skinned top to bottom, so the taper shades and so no
  // single face spans the whole body -- a face that does would trip the sliver check
  // that exists to catch a thread wrapped back on itself.
  {
    const segs = Math.max(2, Math.round(turns));
    let last = null;
    for (let k = 0; k <= segs; k++) {
      const z = zStart + ((zEnd - zStart) * k) / segs;
      const cur = ring(Math.max(0.05, crestAt(z) - depth), z, 1, 0);
      if (last) skin(last, cur);
      last = cur;
    }
  }

  // --- the apex: a TAPERED TIP, not a hemisphere ---------------------------------
  //
  // The measured capsule ends in a hemisphere of the implant's own radius, and the mesh
  // used to draw exactly that. On a 6 mm implant that is a 3 mm ball on the end -- a
  // bullet nose. No implant is shaped like that: the body tapers and closes on a small
  // rounded tip, and the big smooth dome was the single most unrealistic thing left in
  // the model.
  //
  // So the apex is drawn as the body's taper continuing to a tip of `APEX_TIP_FRAC` of
  // the radius, closed by a small dome of that radius. Two properties make it safe:
  //
  //   - every point of it is INSIDE the measured hemisphere. The cone is a chord of a
  //     circle between two interior endpoints, and the tip dome satisfies
  //     |P - centre|^2 = tipR^2 + a^2 + 2a*tipR*sin(theta) with a = r - tipR, whose
  //     maximum over theta is exactly (a + tipR)^2 = r^2;
  //   - that maximum is attained only at the apex point itself, so the drawn tip
  //     REACHES the measured apical depth and is internally tangent there. Apical depth
  //     is what the canal clearance is about, and it is the one dimension that must not
  //     be drawn short.
  const tipR = Math.max(0.18, APEX_TIP_FRAC * r);
  const bodyEnd = crestAt(zEnd);
  const domeStart = shoulder + r - tipR;
  const coneRun = Math.max(1e-4, domeStart - shoulder);
  const slope = (bodyEnd - tipR) / coneRun;      // radius lost per mm of depth
  prev = ring(bodyEnd, shoulder, 1, slope);
  for (let k = 1; k <= APEX_CONE_RINGS; k++) {
    const f = k / APEX_CONE_RINGS;
    prev = (() => {
      const cur = ring(bodyEnd + (tipR - bodyEnd) * f, shoulder + coneRun * f, 1, slope);
      skin(prev, cur);
      return cur;
    })();
  }
  for (let k = 1; k <= DOME_RINGS; k++) {
    const th = (k / DOME_RINGS) * (Math.PI / 2);
    const cur = ring(tipR * Math.cos(th), domeStart + tipR * Math.sin(th),
                     Math.cos(th), Math.sin(th));
    skin(prev, cur);
    prev = cur;
  }
  // Close on the apex point, which sits exactly at the measured capsule's own apex.
  {
    const tip = push(0, 0, shoulder + r, 0, 0, 1);
    for (let i = 0; i < nAz; i++) {
      const j = (i + 1) % nAz;
      cells.push(3, prev[i], prev[j], tip);
    }
  }

  orientByNormals(verts, norms, cells);
  return {
    verts: new Float32Array(verts),
    normals: new Float32Array(norms),
    cells: new Uint32Array(cells),
    nTris: cells.length / 4,
  };
}

/** Make every triangle's WINDING agree with the analytic normals it already carries.
 *
 *  This is not tidiness. vtk.js's WebGL shader does two-sided lighting: for a
 *  back-facing fragment it NEGATES the supplied normal. So a triangle wound the wrong
 *  way lights as though its surface faced away from the light -- ambient only, which at
 *  0.08 is black. Measured on the first tapered build: 5,944 of 13,353 body triangles
 *  were wound inward and the whole threaded body rendered black between the fins, with
 *  correct normals the entire time.
 *
 *  Winding is easy to get wrong once and impossible to get wrong here: a surface of
 *  revolution skinned from ring A to ring B is outward when B is above A and inward when
 *  it is below, an annulus at one z is decided by radius order, and a helical strip
 *  indexed (axial, azimuth) is the opposite of one indexed (azimuth, axial). Rather than
 *  reason about six such cases, the normals -- which ARE derived analytically and are the
 *  thing the shader actually shades with -- decide.
 *
 *  Deliberately mutates in place: this runs once per mesh build, not per frame.
 */
function orientByNormals(verts, norms, cells) {
  let flipped = 0;
  for (let c = 0; c < cells.length; c += 4) {
    const a = cells[c + 1] * 3; const b = cells[c + 2] * 3; const d = cells[c + 3] * 3;
    const ux = verts[b] - verts[a];
    const uy = verts[b + 1] - verts[a + 1];
    const uz = verts[b + 2] - verts[a + 2];
    const vx = verts[d] - verts[a];
    const vy = verts[d + 1] - verts[a + 1];
    const vz = verts[d + 2] - verts[a + 2];
    // Face normal from the winding...
    const fx = uy * vz - uz * vy;
    const fy = uz * vx - ux * vz;
    const fz = ux * vy - uy * vx;
    // ...against the mean of the three analytic vertex normals.
    const nx = norms[a] + norms[b] + norms[d];
    const ny = norms[a + 1] + norms[b + 1] + norms[d + 1];
    const nz = norms[a + 2] + norms[b + 2] + norms[d + 2];
    if (fx * nx + fy * ny + fz * nz < 0) {
      const t = cells[c + 2]; cells[c + 2] = cells[c + 3]; cells[c + 3] = t;
      flipped += 1;
    }
  }
  return flipped;
}

/* ------------------------------------------------------------------- arch frame */

const unit = (v) => {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n ? [v[0] / n, v[1] / n, v[2] / n] : v;
};
const cross = (u, v) => [
  u[1] * v[2] - u[2] * v[1],
  u[2] * v[0] - u[0] * v[2],
  u[0] * v[1] - u[1] * v[0],
];

/** `{origin, e1, e2, ax}` in patient LPS -- an ORTHONORMAL frame for one pose.
 *
 *  Mirrors `dentistry/plan_geometry.py::implant_frame` term for term, including the
 *  choice of perpendicular: `-down*cos(tilt)*n + sin(tilt)*up`, which is what
 *  `web/app.js::implantOutline` already draws in the section and which is exactly
 *  orthogonal to the axis. The Python side used the buccal normal itself here until
 *  2026-09-02, making the map a shear at any nonzero tilt.
 *
 *  ALL THREE ANGLES, since 2026-09-04. This function honoured `tilt_deg` alone, so a
 *  mesiodistally angulated implant -- which the measurement and the STL export have
 *  both honoured all along -- was drawn UPRIGHT in 3-D. The pane would have shown a
 *  pose the server was not measuring, which is the one failure this whole registry
 *  exists to prevent, and it was one field away the whole time.
 *
 *  `e1` deliberately does NOT depend on yaw. Yaw rotates the axis in the plane spanned
 *  by the un-yawed axis and the tangent, and `e1` is orthogonal to both, so the same
 *  perpendicular stays exactly perpendicular -- the argument is written out in the
 *  Python docstring and the cross-language check now covers yawed poses.
 *
 *  A yawed pose with no published tangents returns null rather than a guess. The
 *  tangent could be had as `up x n` up to a sign, and that sign FLIPS relative to the
 *  published normals at the far ends of 2 of 10 real jaw fits -- so deriving it would
 *  mirror the yaw exactly where a third molar sits.
 */
function poseFrame(pose) {
  const jaw = arch && arch.jaws && arch.jaws[pose.jaw];
  if (!jaw || !jaw.ok || !jaw.points || !jaw.normals) return null;
  const step = Number(jaw.step_mm) || 0.5;
  const s0 = Number(jaw.s0_index) || 0;
  const i = Math.max(0, Math.min(
    Math.round(Number(pose.s_mm) / step + s0), jaw.points.length - 1));
  const p0 = jaw.points[i];
  const n = unit(jaw.normals[i]);
  const down = pose.jaw === 'maxilla' ? 1 : -1;
  const tl = ((Number(pose.tilt_deg) || 0) * Math.PI) / 180;
  const yw = ((Number(pose.yaw_deg) || 0) * Math.PI) / 180;
  const st = Math.sin(tl);
  const ct = Math.cos(tl);
  const sy = Math.sin(yw);
  const cy = Math.cos(yw);

  let ax = [n[0] * st * cy, n[1] * st * cy, down * ct * cy];
  if (sy) {
    const tan = jaw.tangents && jaw.tangents[i];
    if (!tan) return null;
    const th = unit(tan);
    ax = [ax[0] + sy * th[0], ax[1] + sy * th[1], ax[2] + sy * th[2]];
  }
  ax = unit(ax);
  let e1 = unit([-down * ct * n[0], -down * ct * n[1], st]);
  let e2 = unit(cross(ax, e1));

  // Clocking. Spins the frame about its own axis; `ax` is untouched, so no measured
  // distance can move. It exists for the connection hex, which is the one part of the
  // drawn screw that is not a body of revolution.
  const rl = ((Number(pose.roll_deg) || 0) * Math.PI) / 180;
  if (rl) {
    const cr = Math.cos(rl);
    const sr = Math.sin(rl);
    const a = e1;
    const b = e2;
    e1 = [cr * a[0] + sr * b[0], cr * a[1] + sr * b[1], cr * a[2] + sr * b[2]];
    e2 = [-sr * a[0] + cr * b[0], -sr * a[1] + cr * b[1], -sr * a[2] + cr * b[2]];
  }
  const origin = [
    p0[0] + Number(pose.t_mm) * n[0],
    p0[1] + Number(pose.t_mm) * n[1],
    Number(pose.z_mm),
  ];
  return { origin, e1, e2, ax };
}

function writePoints(entry, pose) {
  const f = poseFrame(pose);
  if (!f) return false;
  const local = entry.local.verts;
  const ln = entry.local.normals;
  const out = entry.points;
  const outN = entry.normals;
  for (let k = 0, m = 0; k < local.length; k += 3, m += 3) {
    const a = local[k];
    const b = local[k + 1];
    const c = local[k + 2];
    out[m] = f.origin[0] + a * f.e1[0] + b * f.e2[0] + c * f.ax[0];
    out[m + 1] = f.origin[1] + a * f.e1[1] + b * f.e2[1] + c * f.ax[1];
    out[m + 2] = f.origin[2] + a * f.e1[2] + b * f.e2[2] + c * f.ax[2];
    // Normals rotate but do not translate.
    const na = ln[k];
    const nb = ln[k + 1];
    const nc = ln[k + 2];
    outN[m] = na * f.e1[0] + nb * f.e2[0] + nc * f.ax[0];
    outN[m + 1] = na * f.e1[1] + nb * f.e2[1] + nc * f.ax[1];
    outN[m + 2] = na * f.e1[2] + nb * f.e2[2] + nc * f.ax[2];
  }
  // The shell rides the same frame. Transformed in the same pass, from the same map, so
  // the envelope cannot drift away from the implant it belongs to.
  if (entry.shell) {
    const sv = entry.shell.verts; const sn = entry.shell.normals;
    const so = entry.shellPoints; const son = entry.shellNormals;
    for (let k = 0; k < sv.length; k += 3) {
      const a = sv[k]; const b = sv[k + 1]; const c = sv[k + 2];
      so[k] = f.origin[0] + a * f.e1[0] + b * f.e2[0] + c * f.ax[0];
      so[k + 1] = f.origin[1] + a * f.e1[1] + b * f.e2[1] + c * f.ax[1];
      so[k + 2] = f.origin[2] + a * f.e1[2] + b * f.e2[2] + c * f.ax[2];
      const na = sn[k]; const nb = sn[k + 1]; const nc = sn[k + 2];
      son[k] = na * f.e1[0] + nb * f.e2[0] + nc * f.ax[0];
      son[k + 1] = na * f.e1[1] + nb * f.e2[1] + nc * f.ax[1];
      son[k + 2] = na * f.e1[2] + nb * f.e2[2] + nc * f.ax[2];
    }
    entry.shellPoly.getPoints().setData(so, 3);
    if (!entry.shellNormalArray) {
      entry.shellNormalArray = vtkDataArray.newInstance(
        { name: 'Normals', numberOfComponents: 3, values: son });
      entry.shellPoly.getPointData().setNormals(entry.shellNormalArray);
    } else {
      entry.shellNormalArray.dataChange();
    }
    entry.shellPoly.modified();
  }
  entry.frame = f;
  entry.poly.getPoints().setData(out, 3);
  // The normals array is allocated ONCE and mutated in place. It used to be a fresh
  // `vtkDataArray.newInstance` on every frame -- 5 KB of garbage per implant per frame
  // at the old 433-vertex capsule, and ~75 KB at the threaded mesh, which is real GC
  // pressure during a drag. `dataChange()` is vtk.js's own in-place entry point: it
  // drops the cached range and calls `modified()`.
  if (!entry.normalArray) {
    entry.normalArray = vtkDataArray.newInstance(
      { name: 'Normals', numberOfComponents: 3, values: outN });
    entry.poly.getPointData().setNormals(entry.normalArray);
  } else {
    entry.normalArray.dataChange();
  }
  entry.poly.modified();
  return true;
}

/** Machined titanium, distinct from bone's matte 0.22/0.82/0.22/28.
 *
 *  PBR is not available: `@kitware/vtk.js` 36.4.1 exposes `setMetallic`/`setRoughness`
 *  but nothing in the OpenGL path reads them -- they are a WebGPU feature, and
 *  Cornerstone3D renders through WebGL's classic Blinn-Phong. Metal has to come from
 *  GEOMETRY and specular RESPONSE, which is what the thread and these numbers are for.
 *  (`setInterpolationToPhong()` is likewise a no-op here: lighting is already
 *  per-fragment and the flag is only consulted to test for FLAT.)
 *
 *  Ambient+diffuse rises from 0.50 to 0.76 against the old verdict body: a saturated
 *  red pill reads at 0.50, a neutral grey at 0.50 reads as charcoal. Specular drops
 *  0.92 -> 0.85 so the crest highlight blows to white without swamping the flanks.
 *  These are an informed starting point, not a measurement -- they have to be looked at
 *  on a real GPU against real bone.
 */
function applyMaterial(actor) {
  const p = actor.getProperty();
  p.setColor(BODY_RGB[0] / 255, BODY_RGB[1] / 255, BODY_RGB[2] / 255);
  // AMBIENT IS THE ENEMY OF METAL. It is light with no direction, so it fills the
  // shadowed side of every thread flank equally and flattens the whole form -- the
  // first pass ran 0.34 and read as light grey plastic. Metal needs the flanks to go
  // dark so the crests can be bright.
  // 0.08 was right in principle and a touch too dark in practice: the shadow side of
  // the thread crushed to black against bone. 0.13 lifts the floor without filling the
  // flanks back in -- the crest-to-flank contrast that makes it read as metal survives.
  p.setAmbient(0.13);
  p.setDiffuse(0.58);
  // Specular over 1 is deliberate: a metal's highlight is brighter than its diffuse
  // response, which is exactly what separates it from a dielectric of the same colour.
  p.setSpecular(1.15);
  // And BROAD, not sharp. 55 gave a pinpoint highlight that hit one thread crest and
  // missed the rest; a machined titanium implant has a satin finish whose highlight
  // runs ALONG the helix. Lower power, wider lobe, the whole thread lights up.
  p.setSpecularPower(28);
  p.setOpacity(1);
}

/** The safety envelope, and the ONLY thing in the 3-D pane that carries the verdict.
 *
 *  Drawn at the surface the verdict is actually computed against, which is NOT the bare
 *  2.00 mm margin: `plan_safety.budget_for` grades `breach` iff
 *  `clearance < margin + inward_p95`, so the boundary is 2.46 mm for the canal. Drawing
 *  2.00 would put the shell inside the line it is meant to mark.
 *
 *  ALWAYS A SURFACE, never a wireframe. It used to draw `no_verdict` as wireframe on the
 *  reasoning that at low alpha a paler green and a paler grey are the same thing. The
 *  reasoning was sound and the execution was not: `no_verdict` is not a rare state -- it
 *  is what EVERY maxillary implant gets, because the level fed to 3-D was the canal
 *  verdict alone and `plan_safety.canal_verdict` correctly refuses to grade a canal that
 *  is not there. So the common case was 720 triangles of grey-white edges around the
 *  upper arch: a wire cage, which reads as a rendering artifact rather than as an
 *  absence of information.
 *
 *  Two things replace it. The level reaching this function is now the WORST of every
 *  graded clearance rather than the canal's alone (see `web/app.js::worstVerdict`), so a
 *  maxillary implant with a gradeable neighbour gets a real colour. And when nothing at
 *  all could be graded, the shell is a NEUTRAL SURFACE that is deliberately dimmer than
 *  any verdict -- separated by lightness and saturation rather than by fill-vs-line.
 */
function applyShellMaterial(actor, level, selected) {
  const graded = !!level && level !== 'no_verdict';
  const rgb = graded ? VERDICT_RGB[level] : NEUTRAL_RGB;
  const p = actor.getProperty();
  p.setColor(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
  // AMBIENT WAS 0.9 -- effectively unlit, so the only thing that read was the silhouette
  // and every facet boundary along it was a hard alpha step. A translucent surface needs
  // a shading gradient across the barrel for the eye to accept it as curved; that
  // gradient is also what hides the tessellation. A little specular gives it the wet
  // highlight that separates "a volume of glass" from "a coloured film".
  p.setAmbient(0.32);
  p.setDiffuse(0.62);
  p.setSpecular(0.25);
  p.setSpecularPower(18);
  // BOTH WALLS DRAWN. The old code culled front faces on the stated grounds that "WebGL
  // has no order-independent transparency here". That is no longer true: vtk.js 36.4.1
  // instantiates `vtkOpenGLOrderIndependentTranslucentPass` unconditionally whenever a
  // renderer has translucent actors, and runs an `opaqueZBufferPass` so the opaque screw
  // still occludes the envelope correctly. Culling the near wall was a large part of why
  // the envelope read as a thin faceted rind: with one wall there is no near-surface
  // shading at all, so the silhouette carried the whole shape and every facet along it
  // was a hard edge.
  //
  // THE COMPOSITING ARITHMETIC, because it decides the numbers below. The shell is
  // convex, so every ray crosses exactly TWO of its surfaces -- near wall and far wall,
  // everywhere, not more at the silhouette. Two layers at per-wall alpha `a` composite
  // to `1 - (1 - a)^2`. So the old single-wall 0.26 is matched by a per-wall 0.14, and
  // anything above that is MORE opaque than what shipped, not less. The ask was for a
  // more transparent envelope, so: selected 0.11 composites to 0.21, unselected 0.06 to
  // 0.12 -- both below the old values, with the second wall spending the difference on
  // shape rather than on density.
  p.setFrontfaceCulling(false);
  p.setBackfaceCulling(false);
  p.setRepresentation(2);                                  // surface, in every state
  if (graded) {
    p.setOpacity(selected ? 0.11 : 0.06);
  } else {
    // Dimmer than any verdict. "We could not grade this" must never be able to read as
    // "clear", and at these alphas lightness is the only channel that reliably separates
    // them -- which is why the gap is asserted rather than eyeballed.
    p.setOpacity(selected ? 0.075 : 0.042);
  }
}

function scheduleRender() {
  if (rafHandle || !host || !host.engine) return;
  rafHandle = requestAnimationFrame(() => {
    rafHandle = 0;
    try {
      // ONLY the 3D viewport. Re-rendering the MPR panes re-renders their labelmap
      // representations, measured at over 800 ms, which at drag rate would make the
      // drag unusable and look like a bug in this file.
      host.engine.renderViewports([host.viewportId]);
    } catch { /* unmounted mid-drag */ }
  });
}

/* ------------------------------------------------------------------- public API */

/** Declare the full set of implants. Adds, updates and removes to match. */
export function setImplants(list) {
  const want = Array.isArray(list) ? list : [];
  if (!host || !host.isMounted()) {
    // Stash, do not throw: the plan tab may be open before the volume has mounted.
    pending.length = 0;
    pending.push(want);
    return 0;
  }
  const viewport = host.engine && host.engine.getViewport(host.viewportId);
  if (!viewport) return 0;

  const keep = new Set(want.map((i) => i.id));
  [...registry.keys()].forEach((id) => {
    if (!keep.has(id)) removeImplant(id);
  });

  want.forEach((pose) => {
    // Yaw used to be CLAMPED TO 0 here, on the argument that the cross-section could
    // not show it. The section now draws the foreshortened projection and the
    // panoramic draws the angle itself, so the clamp had become the lie it was there
    // to prevent: the server measured the yawed pose and this pane drew an upright one.
    const flat = { ...pose };
    const key = `${Number(flat.length_mm).toFixed(3)}:${Number(flat.diameter_mm).toFixed(3)}`;
    let entry = registry.get(flat.id);

    if (entry && entry.key !== key) {
      // Length or diameter changed: the local mesh is a different mesh.
      removeImplant(flat.id);
      entry = undefined;
    }
    if (!entry) {
      // The DRAWN solid: a generic thread, strictly inside the measured capsule.
      const local = screwLocal(Number(flat.length_mm), Number(flat.diameter_mm));
      const poly = vtkPolyData.newInstance();
      poly.setPolys(vtkCellArray.newInstance({ values: local.cells }));
      const mapper = vtkMapper.newInstance();
      mapper.setInputData(poly);
      const actor = vtkActor.newInstance();
      actor.setMapper(mapper);
      // The SAFETY ENVELOPE: the same capsule, grown by the margin the verdict is
      // actually graded at. A second actor rather than a tint on the first, so the
      // metal stays metal and the warning stays a warning.
      const shellR = SHELL_MARGIN_MM[flat.jaw === 'maxilla' ? 'maxilla' : 'mandible'];
      const shell = capsuleLocal(Number(flat.length_mm) + shellR,
                                 Number(flat.diameter_mm) + 2 * shellR,
                                 SHELL_AZIMUTH, SHELL_DOME_RINGS);
      const shellPoly = vtkPolyData.newInstance();
      shellPoly.setPolys(vtkCellArray.newInstance({ values: shell.cells }));
      const shellMapper = vtkMapper.newInstance();
      shellMapper.setInputData(shellPoly);
      const shellActor = vtkActor.newInstance();
      shellActor.setMapper(shellMapper);
      entry = {
        key, local, poly, mapper, actor,
        shell, shellPoly, shellMapper, shellActor,
        shellPoints: new Float32Array(shell.verts.length),
        shellNormals: new Float32Array(shell.normals.length),
        points: new Float32Array(local.verts.length),
        normals: new Float32Array(local.normals.length),
        pose: flat, verdict: flat.verdict || null, frame: null,
      };
      registry.set(flat.id, entry);
      if (!writePoints(entry, flat)) {
        // No arch for this jaw -- or a yawed pose on a manifest that publishes no
        // tangents, where the direction of +s is exactly what is missing. Drop it
        // rather than draw it somewhere arbitrary, and SAY which, because an implant
        // that quietly fails to appear reads as a rendering bug.
        console.warn('dentistry: implant ' + flat.id + ' is not drawn in 3-D: '
          + (Number(flat.yaw_deg)
            ? 'this arch manifest publishes no tangents, so the direction mesiodistal '
              + 'angulation rotates toward is unknown'
            : 'the ' + flat.jaw + ' arch was not reconstructed on this case'));
        registry.delete(flat.id);
        try {
          mapper.delete(); actor.delete();
          shellMapper.delete(); shellActor.delete();
        } catch { /* nothing allocated */ }
        return;
      }
      applyMaterial(actor);
      applyShellMaterial(shellActor, entry.verdict, !!flat.selected);
      viewport.addActor({ uid: actorUid(flat.id), actor });
      viewport.addActor({ uid: shellUid(flat.id), actor: shellActor });
    } else {
      entry.pose = flat;
      if (!writePoints(entry, flat)) { removeImplant(flat.id); return; }
      if (flat.verdict !== undefined && flat.verdict !== entry.verdict) {
        entry.verdict = flat.verdict || null;
      }
      applyShellMaterial(entry.shellActor, entry.verdict, !!flat.selected);
    }
  });

  scheduleRender();
  return registry.size;
}

/** Drag-rate pose update. Partial: unspecified fields keep their value. */
export function updateImplant(id, pose) {
  const entry = registry.get(id);
  if (!entry) return false;
  const next = { ...entry.pose, ...(pose || {}), yaw_deg: 0 };
  const key = `${Number(next.length_mm).toFixed(3)}:${Number(next.diameter_mm).toFixed(3)}`;
  if (key !== entry.key) {
    // A size change goes through setImplants, which rebuilds the local mesh.
    return setImplants([...registry.values()].map((e) => (e.pose.id === id ? next : e.pose))) > 0;
  }
  entry.pose = next;
  const ok = writePoints(entry, next);
  scheduleRender();
  return ok;
}

/** `'breach' | 'tight' | 'clear' | null`. Null (and `'no_verdict'`) is NEUTRAL. */
export function setImplantVerdict(id, level) {
  const entry = registry.get(id);
  if (!entry) return false;
  // `no_verdict` is KEPT, not flattened to null. Null is "still measuring"; no_verdict
  // is "measured, and refused" -- and the shell draws them differently on purpose.
  entry.verdict = (VERDICT_RGB[level] || level === 'no_verdict') ? level : null;
  applyShellMaterial(entry.shellActor, entry.verdict, !!(entry.pose || {}).selected);
  scheduleRender();
  return true;
}

export function removeImplant(id) {
  const entry = registry.get(id);
  if (!entry) return false;
  const viewport = host && host.engine && host.engine.getViewport(host.viewportId);
  try {
    if (viewport) viewport.removeActors([actorUid(id)]);
  } catch { /* already gone */ }
  try {
    if (viewport) viewport.removeActors([shellUid(id)]);
  } catch { /* already gone */ }
  try {
    entry.mapper.delete();
    entry.actor.delete();
    if (entry.shellMapper) entry.shellMapper.delete();
    if (entry.shellActor) entry.shellActor.delete();
  } catch { /* already deleted */ }
  registry.delete(id);
  scheduleRender();
  return true;
}

/** Frame the 3D pane on one implant, looking ALONG the arch.
 *
 *  The view direction is `e2` -- the section's own out-of-plane axis -- so the 3-D pane
 *  reproduces the picture the cross-section shows: the implant's buccolingual tilt in
 *  the plane of the screen. Two views that agree is the entire point of showing both.
 *
 *  `e2`'s sign is arbitrary from the cross product, so the one whose dot product with
 *  the current view normal is positive is chosen, or repeated calls flip the camera
 *  180 degrees for no reason.
 */
/** How far the camera swings buccally off the section's own out-of-plane axis.
 *  Named, so setting it to 0 restores the exact pre-2026-09-04 behaviour. */
const OBLIQUE_DEG = 35;

/** How far back the parallel camera sits. Outside any skull, for every pose. */
const CAMERA_STANDOFF_MM = 250;

/** Half-height needed to hold the implant AND its safety envelope in view. */
function framedScale(entry, len) {
  const b = entry && entry.shellPoints;
  if (!b || !b.length) return 0.95 * len;
  const o = entry.frame.origin; const ax = entry.frame.ax; const e1 = entry.frame.e1;
  let hi = 0;
  for (let i = 0; i < b.length; i += 3) {
    const d = [b[i] - o[0], b[i + 1] - o[1], b[i + 2] - o[2]];
    const along = d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2];
    const side = d[0] * e1[0] + d[1] * e1[1] + d[2] * e1[2];
    hi = Math.max(hi, Math.abs(along - len / 2), Math.abs(side));
  }
  // ENOUGH ANATOMY TO JUDGE THE PLAN BY, not a portrait of the implant.
  //
  // This framed to `0.95 * len` -- half a pane-height per implant length -- so a 10 mm
  // implant filled the pane and nothing else was in it. That is a picture the 2-D
  // section already gives, better and to scale. What only the 3-D pane can show is the
  // implant IN ITS NEIGHBOURHOOD: the canal running under it, the roots either side, the
  // ridge it is seated in. At 2.2 a 10 mm implant frames ~44 mm of anatomy, which on a
  // mandible reaches the canal below and a tooth on each side.
  return Math.max(CONTEXT_FRAME * len, hi * 1.15);
}

export function focusImplant(id, opts) {
  const entry = registry.get(id);
  if (!entry || !entry.frame || !host || !host.engine) return false;
  const viewport = host.engine.getViewport(host.viewportId);
  if (!viewport) return false;
  const { origin, e1, e2, ax } = entry.frame;
  const len = Number(entry.pose.length_mm) || 10;
  const focal = [0, 1, 2].map((k) => origin[k] + 0.5 * len * ax[k]);
  // Along the section's out-of-plane axis, so the 3-D pane reproduces the cross-section
  // -- but SWUNG BUCCALLY. Looking exactly down `e2` is looking along the arch, which
  // means looking straight through the neighbouring teeth: measured on a real molar
  // site, the pane showed a solid neighbour and no implant at all. The oblique keeps
  // cos(35 deg) = 0.82 of the true tilt reading and buys the parallax that makes the
  // helix read as a helix. `e1` points buccal (it is `-down*cos(tilt)*n + sin(tilt)*up`
  // and `down` is -1 in the mandible), so a positive component moves the camera out
  // through the cheek rather than in through the tongue.
  const c = Math.cos(OBLIQUE_DEG * Math.PI / 180);
  const sn = Math.sin(OBLIQUE_DEG * Math.PI / 180);
  let dir = [0, 1, 2].map((k) => c * e2[k] + sn * e1[k]);
  try {
    const normal = viewport.getCamera().viewPlaneNormal;
    if (normal && (normal[0] * e2[0] + normal[1] * e2[1] + normal[2] * e2[2]) < 0) {
      dir = [0, 1, 2].map((k) => -c * e2[k] + sn * e1[k]);
    }
  } catch { /* no camera yet */ }
  dir = unit(dir);
  // OUTSIDE the head, not 24 mm from the implant.
  //
  // The camera is PARALLEL, so distance costs nothing visually -- `parallelScale` is the
  // only knob that zooms. But it decides what is in FRONT of the camera, and 2.4 x a
  // 10 mm implant put the eye 24 mm away, i.e. inside the mandible: the pane rendered
  // the inside of a tooth with the implant behind the near clip plane. A skull is under
  // 250 mm across in any direction, so this is outside it for every pose.
  const distance = (opts && opts.distance) || CAMERA_STANDOFF_MM;
  try {
    viewport.setCamera({
      focalPoint: focal,
      position: [0, 1, 2].map((k) => focal[k] + dir[k] * distance),
      viewUp: [0, 0, 1],
      parallelScale: framedScale(entry, len),
    });
    if (viewport.resetCameraClippingRange) viewport.resetCameraClippingRange();
    viewport.render();
  } catch (e) {
    console.warn('dentistry: implant focus failed: ' + e.message);
    return false;
  }
  return true;
}

/** The transformed geometry of one implant, for cross-language verification.
 *
 *  Named `...ForTest` to match `parseWebMeshForTest`: it exists so
 *  `viewer/check-equivalence.mjs` can compare the browser's placed vertices against
 *  `tests/implant_vectors.json`, which is generated from
 *  `dentistry/plan_geometry.implant_triangles_lps` -- the writer for the STL a user
 *  downloads. Nothing in the app calls it.
 *
 *  This comparison is not academic. Until 2026-09-02 the Python side used the buccal
 *  normal itself as a frame axis, so `ax . e1 = sin(tilt)` and the exported solid was a
 *  SHEARED cylinder at any nonzero tilt -- the platform face not perpendicular to the
 *  axis, the apex 0.19 mm short. It loaded, it looked like an implant, and it was not
 *  the solid the server had measured.
 */
export function implantGeometryForTest(id) {
  const entry = registry.get(id);
  if (!entry) return null;
  const p = entry.points;
  const bounds = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      bounds[k * 2] = Math.min(bounds[k * 2], p[i + k]);
      bounds[k * 2 + 1] = Math.max(bounds[k * 2 + 1], p[i + k]);
    }
  }
  // The ENVELOPE, transformed by the same map, on demand. This is what the cross-language
  // check compares against Python: the drawn mesh is now a thread and Python has no
  // thread, but the CLAIM -- the capsule of the stated diameter and length, placed by
  // this frame -- is still identical on both sides, and it is the claim the STL exports
  // and the clearance is computed against. Test-only, so it costs nothing per frame.
  const env = entry.shell
    ? capsuleLocal(Number(entry.pose.length_mm), Number(entry.pose.diameter_mm))
    : null;
  const envPts = [];
  if (env && entry.frame) {
    const f = entry.frame;
    for (let k = 0; k < env.verts.length; k += 3) {
      const a = env.verts[k]; const b = env.verts[k + 1]; const c = env.verts[k + 2];
      envPts.push(f.origin[0] + a * f.e1[0] + b * f.e2[0] + c * f.ax[0],
                  f.origin[1] + a * f.e1[1] + b * f.e2[1] + c * f.ax[1],
                  f.origin[2] + a * f.e1[2] + b * f.e2[2] + c * f.ax[2]);
    }
  }
  return {
    frame: entry.frame,
    points: Array.from(p),
    // The cell array too, so a caller can expand the index buffer into per-triangle
    // vertices and diff it against Python's triangle list in emission order.
    cells: Array.from(entry.local.cells),
    nTris: entry.local.nTris,
    bounds,
    // The TRANSFORMED normals, to match `points`. The local ones would be in a
    // different frame from the vertices they belong to and every winding test against
    // them would be noise.
    normals: Array.from(entry.normals),
    pose: entry.pose,
    // The measured solid, same frame, same map, Python's exact tessellation.
    envelope: env ? { points: envPts, cells: Array.from(env.cells), nTris: env.nTris }
                  : null,
    // The invariant that makes a threaded DISPLAY honest against a capsule CLAIM.
    profile: { pitchMm: THREAD_PITCH_MM, depthFrac: THREAD_DEPTH_FRAC,
               depthMinMm: THREAD_DEPTH_MIN_MM, depthMaxMm: THREAD_DEPTH_MAX_MM,
               crestFlatMm: THREAD_CREST_FLAT_MM, bodyRgb: BODY_RGB.slice() },
  };
}

/** Read-BACK state for the differential test, matching `debugState`'s discipline. */
export function debug() {
  const ids = [...registry.keys()];
  return {
    count: ids.length,
    ids,
    arch: !!arch,
    verdicts: Object.fromEntries(ids.map((id) => [id, registry.get(id).verdict])),
    triangles: ids.reduce((sum, id) => sum + registry.get(id).local.nTris, 0),
    // Reads the SHELL, because that is where the verdict lives now. The body is
    // titanium in every state, and `bodyIsNeutral` below is what asserts that it stayed
    // that way -- without it, moving the verdict off the body would have deleted the
    // only check that stops an unmeasured implant reading as safe in 3-D.
    bodyIsNeutral: ids.every((id) => {
      const got = registry.get(id).actor.getProperty().getColor()
        .map((v) => Math.round(v * 255));
      return BODY_RGB.every((v, k) => Math.abs(v - got[k]) <= 1);
    }),
    colorsMatchVerdicts: ids.every((id) => {
      const entry = registry.get(id);
      const want = VERDICT_RGB[entry.verdict] || NEUTRAL_RGB;
      const got = entry.shellActor.getProperty().getColor().map((v) => Math.round(v * 255));
      return want.every((v, k) => Math.abs(v - got[k]) <= 1);
    }),
    // The regression guard for the WIRE CAGE. `no_verdict` used to be drawn as
    // `setRepresentation(1)`, and because the level reaching 3-D was the canal verdict
    // alone, every maxillary implant hit that branch -- so the shipped upper arch was a
    // grey-white wireframe of 720 triangles. Read back per shell, in whatever verdict
    // state the caller has put it in, so restoring the branch fails here rather than in
    // a screenshot. 2 = SURFACE.
    shellsAreSurfaces: ids.every(
      (id) => registry.get(id).shellActor.getProperty().getRepresentation() === 2),
    // ...and that it is genuinely translucent. A shell at opacity 1 would occlude the
    // implant it exists to frame; one at 0 is invisible and would pass every colour
    // check above while showing the user nothing.
    shellOpacities: Object.fromEntries(ids.map(
      (id) => [id, registry.get(id).shellActor.getProperty().getOpacity()])),
    // BODIES, not actors. Each implant is two actors now -- the titanium solid and the
    // translucent safety envelope -- and counting both would make "two implants became
    // two actors" read four, which is a true statement about actors and a confusing one
    // about implants. Shells are counted separately so a missing envelope is still
    // visible here rather than hidden inside one number.
    onViewport: (() => {
      try {
        const viewport = host && host.engine && host.engine.getViewport(host.viewportId);
        if (!viewport) return 'no viewport';
        const uids = (viewport.getActors() || []).map((a) => String(a.uid || ''));
        return uids.filter((u) => u.startsWith('dent-implant-')
                                  && !u.startsWith('dent-implant-shell-')).length;
      } catch (e) {
        return 'error: ' + e.message;
      }
    })(),
    shellsOnViewport: (() => {
      try {
        const viewport = host && host.engine && host.engine.getViewport(host.viewportId);
        if (!viewport) return 'no viewport';
        return (viewport.getActors() || []).filter(
          (a) => String(a.uid || '').startsWith('dent-implant-shell-')).length;
      } catch (e) {
        return 'error: ' + e.message;
      }
    })(),
  };
}

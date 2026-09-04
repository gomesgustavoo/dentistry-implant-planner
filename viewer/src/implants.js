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
 *  - Cost. A capsule at 48 azimuths is ~380 shared vertices; 380 x 9 multiply-adds and
 *    a ~4.5 KB VBO upload is nothing against a frame.
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
const BODY_RGB = [199, 204, 212];

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
function capsuleLocal(lengthMm, diameterMm, nAz = N_AZIMUTH) {
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
  for (let k = 1; k <= DOME_RINGS; k++) {
    const th = (k / DOME_RINGS) * (Math.PI / 2);
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
function screwLocal(lengthMm, diameterMm, nAz = N_AZIMUTH) {
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

  const verts = []; const norms = []; const cells = [];
  const push = (x, y, z, nx, ny, nz) => {
    verts.push(x, y, z); norms.push(nx, ny, nz);
    return verts.length / 3 - 1;
  };

  // --- the platform: a flat disc, a chamfer, then the smooth collar ---------------
  const centre = push(0, 0, 0, 0, 0, -1);
  const discR = Math.max(0, r - chamfer);
  const discRim = []; const chamRim = []; const collarEnd = [];
  for (let i = 0; i < nAz; i++) {
    const th = (2 * Math.PI * i) / nAz;
    const cx = Math.cos(th); const cy = Math.sin(th);
    discRim.push(push(discR * cx, discR * cy, 0, 0, 0, -1));
    // A real machined bevel. It catches a specular ring at the platform, which is the
    // strongest "this is metal" cue in the whole mesh, and it stays inside the envelope
    // because the widest point moves DOWN to z = chamfer.
    chamRim.push(push(r * cx, r * cy, chamfer, cx * 0.7071, cy * 0.7071, -0.7071));
    collarEnd.push(push(r * cx, r * cy, zStart, cx, cy, 0));
  }
  for (let i = 0; i < nAz; i++) {
    const j = (i + 1) % nAz;
    cells.push(3, centre, discRim[j], discRim[i]);
    cells.push(3, discRim[i], discRim[j], chamRim[j]);
    cells.push(3, discRim[i], chamRim[j], chamRim[i]);
    cells.push(3, chamRim[i], chamRim[j], collarEnd[j]);
    cells.push(3, chamRim[i], collarEnd[j], collarEnd[i]);
  }

  // --- the threaded barrel --------------------------------------------------------
  const flankRise = depth * Math.tan(THREAD_HALF_ANGLE_DEG * Math.PI / 180);
  const half = THREAD_CREST_FLAT_MM / 2;
  const rootFlat = THREAD_PITCH_MM - 2 * flankRise - THREAD_CREST_FLAT_MM;
  // Positive by construction across the whole catalogue (0.200 to 0.374 mm). A negative
  // one would invert the profile silently, so fall back to the envelope instead.
  if (rootFlat <= 0) return capsuleLocal(lengthMm, diameterMm, nAz);
  // ONE PITCH of profile, in strictly increasing axial offset, ending exactly where it
  // began so the last row of a turn IS the first row of the next.
  //
  // Each entry is [axial offset, radial drop, face]. Stations are DOUBLED at every
  // crease -- the same point twice with two different normals -- because a shared
  // vertex at a crest averages two flank normals 60 degrees apart and produces a
  // radial one, i.e. a smooth barrel where a thread should be.
  //
  // `face` picks the normal in the (r, z) plane. A cone whose radius falls by `depth`
  // over an axial run of `flankRise` has outward normal (flankRise, depth); the rising
  // flank is its mirror. This list previously ended with three consecutive root
  // stations and no rising flank at all, and then wrapped from the last back to the
  // first -- a jump of nearly a whole pitch BACKWARDS, which rendered as a stack of
  // flat plates with no core between them.
  const FLAT = [1, 0];
  const FALL = [flankRise, depth];
  const RISE = [flankRise, -depth];
  const P = THREAD_PITCH_MM;
  const stations = [
    [-half, 0, FLAT],                       // crest, leading edge
    [half, 0, FLAT],                        // crest, trailing edge
    [half, 0, FALL],                        // ...crease into the falling flank
    [half + flankRise, depth, FALL],        // root, leading edge
    [half + flankRise, depth, FLAT],        // ...crease into the root
    [P - half - flankRise, depth, FLAT],    // root, trailing edge
    [P - half - flankRise, depth, RISE],    // ...crease into the rising flank
    [P - half, 0, RISE],                    // next crest, leading edge
    [P - half, 0, FLAT],                    // ...crease; identical to station 0 + one pitch
  ];
  const turns = (zEnd - zStart) / THREAD_PITCH_MM;
  const cols = Math.max(2, Math.round(turns * nAz));
  const grid = [];
  for (let g = 0; g <= cols; g++) {
    const th = (2 * Math.PI * g) / nAz;
    const cx = Math.cos(th); const cy = Math.sin(th);
    const zBase = zStart + (THREAD_PITCH_MM * g) / nAz;
    const rowIdx = [];
    for (let m = 0; m < stations.length; m++) {
      const [off, drop, face] = stations[m];
      const z = Math.min(zEnd, Math.max(zStart, zBase + off));
      // LEAD-IN and RUN-OUT. The thread's amplitude ramps from zero at both ends, so at
      // `zStart` and `zEnd` the strip lies exactly ON the envelope cylinder and meets
      // the collar and the dome flush. Without it the strip had to be sealed with a fan
      // of 48 triangles to a single vertex, which spanned most of a pitch in z and was
      // the second source of the flat-plate look.
      const lead = Math.min(THREAD_LEADIN_MM, 0.3 * (zEnd - zStart));
      const amp = Math.max(0, Math.min(1, Math.min((z - zStart) / lead,
                                                   (zEnd - z) / lead)));
      // The envelope at THIS depth, so the crest tracks the apical dome's taper too.
      const rho = Math.max(0.02, envelopeRadius(z, r, shoulder) - drop * amp);
      // Analytic, from the face's own (r, z) direction. The azimuthal term is the helix
      // tilt: without it the specular forms stacked rings instead of running along the
      // thread, which is the difference between a screw and a fluted cylinder.
      let nr = face[0]; let nz = face[1];
      const nt = -(THREAD_PITCH_MM / (2 * Math.PI * Math.max(rho, 0.05))) * nz;
      const len = Math.hypot(nr, nz, nt) || 1;
      nr /= len; nz /= len;
      const ntn = nt / len;
      rowIdx.push(push(rho * cx, rho * cy, z,
                       nr * cx - ntn * cy, nr * cy + ntn * cx, nz));
    }
    grid.push(rowIdx);
  }
  // NO wrap in m. The profile already spans exactly one pitch and closes on the next
  // turn through the g axis; wrapping the last station back to the first inside one
  // column is the backward jump that produced the plates.
  for (let g = 0; g < cols; g++) {
    for (let m = 0; m + 1 < stations.length; m++) {
      const a = grid[g][m]; const b = grid[g][m + 1];
      const c = grid[g + 1][m + 1]; const d = grid[g + 1][m];
      cells.push(3, a, b, c);
      cells.push(3, a, c, d);
    }
  }
  // --- the core, under the thread --------------------------------------------------
  // A plain cylinder at the root radius, from the collar to the shoulder. The helical
  // strip is a surface, not a solid, and at its lead-in seam there is nothing behind
  // it; without the core you look straight through the implant into its own inside.
  // 96 triangles, and it can never poke outside the envelope because the root radius is
  // `r - depth`.
  {
    const coreR = Math.max(0.05, r - depth);
    const top = []; const bot = [];
    for (let i = 0; i < nAz; i++) {
      const th = (2 * Math.PI * i) / nAz;
      const cx = Math.cos(th); const cy = Math.sin(th);
      top.push(push(coreR * cx, coreR * cy, zStart, cx, cy, 0));
      bot.push(push(coreR * cx, coreR * cy, zEnd, cx, cy, 0));
    }
    for (let i = 0; i < nAz; i++) {
      const j = (i + 1) % nAz;
      cells.push(3, top[i], top[j], bot[j]);
      cells.push(3, top[i], bot[j], bot[i]);
    }
  }

  // --- the apical dome, exactly the envelope's ------------------------------------
  let prev = [];
  for (let i = 0; i < nAz; i++) {
    const th = (2 * Math.PI * i) / nAz;
    prev.push(push(r * Math.cos(th), r * Math.sin(th), shoulder,
                   Math.cos(th), Math.sin(th), 0));
  }
  for (let k = 1; k <= DOME_RINGS; k++) {
    const th = (k / DOME_RINGS) * (Math.PI / 2);
    const ringR = r * Math.cos(th);
    const ringZ = shoulder + r * Math.sin(th);
    const ring = [];
    for (let i = 0; i < nAz; i++) {
      const a = (2 * Math.PI * i) / nAz;
      const cx = Math.cos(a); const cy = Math.sin(a);
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
  const st = Math.sin(tl);
  const ct = Math.cos(tl);

  const ax = unit([n[0] * st, n[1] * st, down * ct]);
  const e1 = unit([-down * ct * n[0], -down * ct * n[1], st]);
  const e2 = unit(cross(ax, e1));
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
  p.setAmbient(0.34);
  p.setDiffuse(0.42);
  p.setSpecular(0.85);
  p.setSpecularPower(55);
  p.setOpacity(1);
}

/** The safety envelope, and the ONLY thing in the 3-D pane that carries the verdict.
 *
 *  Drawn at the surface the verdict is actually computed against, which is NOT the bare
 *  2.00 mm margin: `plan_safety.budget_for` grades `breach` iff
 *  `clearance < margin + inward_p95`, so the boundary is 2.46 mm for the canal. Drawing
 *  2.00 would put the shell inside the line it is meant to mark.
 *
 *  `no_verdict` is drawn as a WIREFRAME, not as a fainter fill. At low alpha a paler
 *  green and a paler grey are the same thing, and "we could not grade this" must not be
 *  able to read as "clear".
 */
function applyShellMaterial(actor, level, selected) {
  const rgb = VERDICT_RGB[level] || NEUTRAL_RGB;
  const p = actor.getProperty();
  p.setColor(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
  p.setAmbient(0.9);
  p.setDiffuse(0.1);
  p.setSpecular(0);
  p.setOpacity(level && level !== 'no_verdict' ? (selected ? 0.20 : 0.10) : 0.0);
  p.setRepresentation(level === 'no_verdict' ? 1 : 2);   // 1 = wireframe, 2 = surface
  if (level === 'no_verdict') { p.setOpacity(selected ? 0.55 : 0.3); p.setLineWidth(1); }
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
    if (Number(pose.yaw_deg)) {
      console.warn('dentistry: out-of-plane angulation is not drawn -- the cross-section '
        + 'cannot show it, so a 3-D-only yaw would be a pose the 2-D view is lying '
        + 'about. Clamped to 0.');
    }
    const flat = { ...pose, yaw_deg: 0 };
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
                                 Number(flat.diameter_mm) + 2 * shellR);
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
        // No arch for this jaw: drop it rather than draw it somewhere arbitrary.
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
      writePoints(entry, flat);
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
  // A little air, so the envelope is not flush against the pane edge.
  return Math.max(0.95 * len, hi * 1.15);
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

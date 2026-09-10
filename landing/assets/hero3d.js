// hero3d.js — ImplantPlan landing hero: a titanium fixture seating toward a nerve.
//
// WHAT THIS SHOWS, AND WHY IT IS NOT A TURNTABLE.
// The product's claim is a number: the clearance from an implant to the inferior alveolar
// canal, with the model's own measured error already taken out of it. So the hero animates
// the one variable that number depends on — how deep the fixture is seated — and reports
// the clearance it actually measures, live, from the geometry on screen. The verdict goes
// CLEAR -> TIGHT -> BREACH because the distance really closes, not because a timeline says
// so at 62%.
//
// NOTHING HERE IS DRAWN TWICE.
//   * The fixture is `screwLocal` out of `viewer/src/implants.js`, sliced by
//     `scripts/bake_landing_geometry.mjs` and checked against its source. It is the same
//     threaded body the app draws, verified in-tree against Python.
//   * The envelope is `capsuleLocal(length + shellR, diameter + 2*shellR)`, the exact call
//     `implants.js` makes, at the exact radius it uses in the mandible.
//   * 2.46 is not a literal. It is `SAFETY_MARGIN_MM + MODEL_INWARD_P95_MM`, both read out
//     of `dentistry/plan_safety.py` at bake time.
//   * The bone, the teeth and the canal are the real 34-structure segmentation already in
//     `arch.<hash>.glb`. FDI 46 is genuinely absent in that scan — a real posterior
//     mandibular gap with two standing neighbours, not a drawn one.
//
// THE FRAME IS BAKED; ONLY THE CANAL IS MEASURED LIVE. This is the load-bearing decision.
// Re-deriving the crest per mesh puts it 4.3 mm apart between the desktop and mobile LODs
// and moves the clearance by 0.79–0.87 mm — nearly twice the 0.46 mm the whole honesty
// argument rests on, and enough to say CLEAR on a laptop and BREACH on a phone at the same
// scroll position. So `scripts/measure_hero_site.mjs` derives the seat and the axis ONCE
// from the desktop mesh by a stated rule and writes them into `arch.assets.json`; the page
// measures the canal that is actually on screen against that fixed frame. With the frame
// fixed the two LODs agree to hundredths.
//
// THE FIXTURE IS NEVER THE VERDICT'S COLOUR. It is machined titanium in every state; the
// grade lives on the envelope and on a word. That rule is the app's and breaking it here
// would teach a reader the wrong thing to look at.
//
// WHAT THE NUMBER IS AND IS NOT. It is measured off a decimated, quantised web mesh — an
// illustration of the method, not the app's answer, which is computed on the voxel grid.
// The page says so beside it. `window.__hero3d` exposes every input so the check harness
// can recompute it against its own oracle rather than trust it.
//
// WebGL/asset failure degrades to the static poster via `filmstage--static`, and the page
// then shows the app's own numbers, attributed — never a blank where a millimetre was.
// Vendored Three.js r169 (assets/vendor/three) via the import map in index.html.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

// Bump BUILD together with the `?v=` on this module's script tag in index.html.
// `/assets/` is served immutable for a year, so a stale query strands the page.
// The generated geometry and constants are NOT imported statically for the same reason —
// a static specifier does not inherit the query string. They carry a content hash and are
// reached through the pointer file, which is the one URL fetched `cache: "no-cache"`.
const BUILD = "4";
const ASSETS_URL = "/assets/arch.assets.json?v=" + BUILD;

let G = null;   // screw-geometry.<hash>.js
let S = null;   // safety-constants.<hash>.js

// --- the site -----------------------------------------------------------------
export const SITE_FDI = 46;
const SITE_NEIGHBOURS = ["tooth_45", "tooth_47"];
export const CAST = ["mandible", "canal", "tooth_45", "tooth_47"];

// Catalogue sizes from `dentistry/implants.py`. A first molar is a wide-platform site, so
// 4.8 mm.
//
// 16.0 mm IS A DELIBERATE CHOICE AND THE PAGE SAYS SO. This site has 16.6 mm of bone above
// the canal — measured, not assumed — so the lengths a planner actually reaches for all sit
// comfortably clear here: 10 mm measures 9.00 mm off the canal, 13 mm measures 6.20. The
// app's own fit loop would take the shortest length that clears and stop.
//
// Manufacturing a breach by seating a 13 mm fixture four millimetres subcrestal would be
// theatre, and this repository has a rule about that: the first cut of the implant film was
// reshot because it planned into sockets that still had teeth in them. So the hero uses the
// catalogue's longest length instead — whose own note reads "Rarely indicated; check the
// apical clearance carefully" — and demonstrates exactly that warning. At 16 mm the fixture
// starts CLEAR at the crest, is TIGHT under a millimetre of subcrestal seating and BREACHes
// before a millimetre and a half. Every one of those is a real catalogue value at a real
// gap, and the whole sweep stays inside a seating range a surgeon would recognise.
export const DIAMETER_MM = 4.8;
export const LENGTH_MM = 16.0;

// The scrub, in millimetres of platform depth below the crest. Two millimetres, because
// that is where the verdicts are: CLEAR at the crest, TIGHT at 0.54 mm, BREACH at 1.07 mm,
// and 1.56 mm of clearance left at the end of the travel. A longer sweep would spend most
// of its length already breached, which reads as one state rather than three.
export const DEPTH_MAX_MM = 2.0;

// Only the canal near the site can hold the minimum, and pruning is what makes a
// per-frame surface measurement affordable at all.
export const PRUNE_MM = 30;
// Subdivide until no canal edge exceeds this. The delivered mesh has a mean edge of
// 0.755 mm and a maximum of 4.3 mm, so sampling its VERTICES alone can only ever
// over-report clearance — an error that is small here but one-signed in the unsafe
// direction, which is not a thing this codebase ships. Splitting to 0.4 mm bounds it.
export const CANAL_EDGE_MM = 0.4;

// --- framing ------------------------------------------------------------------
const FOV = 34;
// Wide enough that the fixture is IN a mandible rather than in front of one. At 21 mm the
// screw filled the frame and the bone behind it was out of shot, which read as a product
// render of an implant rather than as a plan on a scan — and the whole argument of the
// page is the relationship between the two.
const FRAME_RADIUS_MM = 41;
const ORBIT_START = -0.16;
const ORBIT_SWEEP = 0.22;       // ~13 degrees over the whole scroll. The arch turning was
                                // the old story; this one is about a distance closing.
const SMOOTH_LAMBDA = 7.5;
const REVEAL_FROM = 0.06, REVEAL_TO = 0.30;
const SEAT_FROM = 0.34, SEAT_TO = 0.90;
const CLIMAX_AT = 0.78;

// --- palette ------------------------------------------------------------------
// The data voice from `dentistry/labels.py`, re-graded for a light ground: on white a
// dark-tuned translucent value disappears, so the bone is lifted. The canal keeps its
// hue — it is allowed to be alarming, and it reads as a hazard on purpose. (The violet
// canal in the brand's stylised hero is a post-hoc recolour of a render, not the
// product's colour.)
const BONE = 0xd6c49f;
const CANAL = 0xff3b30;
// Pulled down from near-white. Enamel next to translucent bone on a white page goes to
// paper unless it keeps some warmth, and two blank white shapes read as plastic.
const TOOTH = 0xe8dfcd;
const KEY = 0xfff6ea;
const ACCENT = 0x8b5cf6;

const HOVER_MIN_PROGRESS = 0.10;

// Looked up in init(), and the auto-run at the bottom is guarded, so this module can be
// IMPORTED without a DOM. `scripts/check_hero.mjs` and `scripts/measure_hero_site.mjs`
// both do exactly that, which is a far tighter loop than driving a browser for every
// change to a distance function.
const BROWSER = typeof document !== "undefined" && typeof window !== "undefined";
let stage = null;
let canvas = null;

const mq = (q) => (BROWSER && window.matchMedia ? window.matchMedia(q).matches : false);
const reducedMotion = mq("(prefers-reduced-motion: reduce)");
const coarse = mq("(pointer: coarse)");
const finePointer = !coarse && mq("(pointer: fine)");

let renderer, scene, camera, model, envRT;
let root_ = null;
let bone = [];                  // [{ mesh, target }] — the translucent reveal
let canalMeshes = [];
let canalPts = null;            // subdivided canal surface samples, root-local mm
let implantGroup = null, screwMesh = null, shellMesh = null, shellMat = null;
let site = null;                // { origin, axis }
let camTarget = new THREE.Vector3();
let baseDist = 60, camDir = new THREE.Vector3(0, 0, 1);
let targetP = 0, smoothP = 0;
let raf = null, running = false, lastT = 0;
let visible = true, initialized = false;
let readout = null, liveEl = null;
let lastLevel = null;

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let meshList = [];
let hovered = null;
let pointerInside = false, pointerMoved = false;
let ptrX = 0, ptrY = 0;
let tipEl = null, tipDot = null, tipLabel = null, tipMeta = null;
let structures = {};

// ---------------------------------------------------------------------------
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const remap = (x, a, b) => clamp01((x - a) / (b - a));
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const fmt = (x) => (x == null || !isFinite(x) ? "—" : x.toFixed(2));

function progress() {
  const rect = stage.getBoundingClientRect();
  const total = stage.offsetHeight - window.innerHeight;
  if (total <= 0) return 0;
  return clamp01(-rect.top / total);
}

function failToPoster() {
  if (stage) { stage.classList.remove("filmstage--live"); stage.classList.add("filmstage--static"); }
  cancel();
}

function hasWebGL() {
  try {
    const c = document.createElement("canvas");
    return !!(window.WebGLRenderingContext &&
      (c.getContext("webgl2") || c.getContext("webgl")));
  } catch (_) {
    return false;
  }
}

/** Resolve the two generated modules through the pointer file. Exported so the Node
 *  harnesses load exactly what the page loads, by the same names. */
export async function loadModules(assets, base = "/assets/") {
  G = await import(base + assets.screw);
  S = await import(base + assets.safety);
  return { G, S };
}

// gltfpack keeps the structure id on a parent NODE and strips the mesh name, so
// GLTFLoader labels the leaf "mesh_N" — walk up to the real name.
function structureId(o) {
  for (let n = o; n; n = n.parent) {
    if (n.name && n.name !== "world" && n.name !== "upper" && n.name !== "lower" &&
        !/^mesh_\d+$/.test(n.name)) return n.name;
  }
  return "";
}

function prettyLabel(id) {
  const s = structures[id];
  if (!s) return id || "Structure";
  return s.fdi ? s.fdi + " · " + s.name.toLowerCase() : s.name;
}

// ---------------------------------------------------------------- geometry helpers

/** vtk.js cell arrays are [3,a,b,c, ...]; three.js wants a flat index. */
function toBufferGeometry(m) {
  const idx = new Uint32Array(m.nTris * 3);
  for (let t = 0, c = 0; t < m.nTris; t++, c += 4) {
    idx[t * 3] = m.cells[c + 1];
    idx[t * 3 + 1] = m.cells[c + 2];
    idx[t * 3 + 2] = m.cells[c + 3];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(m.verts, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

/** Every world-space vertex under `node`, flat xyz. */
export function collectPoints(node) {
  const out = [];
  const v = new THREE.Vector3();
  node.traverse((o) => {
    if (!o.isMesh) return;
    o.updateWorldMatrix(true, false);
    const pos = o.geometry.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      out.push(v.x, v.y, v.z);
    }
  });
  return new Float32Array(out);
}

/** Every world-space triangle under `node`, flat as 9 floats per triangle. */
export function collectTriangles(node) {
  const out = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  node.traverse((o) => {
    if (!o.isMesh) return;
    o.updateWorldMatrix(true, false);
    const pos = o.geometry.getAttribute("position");
    const idx = o.geometry.getIndex();
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i += 3) {
      const ia = idx ? idx.getX(i) : i, ib = idx ? idx.getX(i + 1) : i + 1,
            ic = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, ia).applyMatrix4(o.matrixWorld);
      b.fromBufferAttribute(pos, ib).applyMatrix4(o.matrixWorld);
      c.fromBufferAttribute(pos, ic).applyMatrix4(o.matrixWorld);
      out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    }
  });
  return new Float32Array(out);
}

export function centroid(pts) {
  const c = new THREE.Vector3();
  for (let i = 0; i < pts.length; i += 3) c.x += pts[i], c.y += pts[i + 1], c.z += pts[i + 2];
  return c.multiplyScalar(3 / pts.length);
}

/** Dominant eigenvector of the covariance, by power iteration — a tooth's long axis,
 *  signed occlusal (+y in this GLB's baked frame). */
export function longAxis(pts, c) {
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i] - c.x, y = pts[i + 1] - c.y, z = pts[i + 2] - c.z;
    cov[0] += x * x; cov[1] += x * y; cov[2] += x * z;
    cov[4] += y * y; cov[5] += y * z; cov[8] += z * z;
  }
  cov[3] = cov[1]; cov[6] = cov[2]; cov[7] = cov[5];
  const v = new THREE.Vector3(0, 1, 0.15).normalize();
  for (let k = 0; k < 64; k++) {
    const nx = cov[0] * v.x + cov[1] * v.y + cov[2] * v.z;
    const ny = cov[3] * v.x + cov[4] * v.y + cov[5] * v.z;
    const nz = cov[6] * v.x + cov[7] * v.y + cov[8] * v.z;
    const n = Math.hypot(nx, ny, nz);
    if (!n) break;
    v.set(nx / n, ny / n, nz / n);
  }
  if (v.y < 0) v.negate();
  return v;
}

const _ab = new THREE.Vector3(), _q = new THREE.Vector3();
/** Distance from (px,py,pz) to the segment [a,b]. */
export function distToSegment(px, py, pz, a, b) {
  _ab.subVectors(b, a);
  const len2 = _ab.lengthSq();
  let t = len2 > 0 ? ((px - a.x) * _ab.x + (py - a.y) * _ab.y + (pz - a.z) * _ab.z) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  _q.copy(_ab).multiplyScalar(t).add(a);
  return Math.hypot(px - _q.x, py - _q.y, pz - _q.z);
}

// ------------------------------------------------------------------- the site rule

/** THE RULE, stated once and run offline.
 *
 *  Axis: the mean of the two standing neighbours' own long axes — the direction a
 *  restoration at this position would be loaded along. Seat: the mandible vertex furthest
 *  along that axis within 3.5 mm of the site line — the alveolar crest that is actually
 *  there. Both are properties of this segmentation.
 *
 *  `scripts/measure_hero_site.mjs` runs this once and bakes the result into
 *  `arch.assets.json`; `scripts/check_hero.mjs` re-runs it and asserts the baked values
 *  still match. The PAGE never calls it — see the header on why re-deriving per LOD is a
 *  correctness bug, not an optimisation.
 */
export function solveSite(root, radiusMm = 3.5) {
  const axes = [], centres = [];
  for (const name of SITE_NEIGHBOURS) {
    const node = root.getObjectByName(name);
    if (!node) continue;
    const pts = collectPoints(node);
    if (!pts.length) continue;
    const c = centroid(pts);
    centres.push(c);
    axes.push(longAxis(pts, c));
  }
  if (centres.length < 2) return null;

  const axis = axes[0].clone().add(axes[1]).normalize();
  const mid = centres[0].clone().add(centres[1]).multiplyScalar(0.5);

  const mandible = root.getObjectByName("mandible");
  let crest = null, best = -Infinity;
  if (mandible) {
    const pts = collectPoints(mandible);
    const p = new THREE.Vector3(), d = new THREE.Vector3();
    for (let i = 0; i < pts.length; i += 3) {
      p.set(pts[i], pts[i + 1], pts[i + 2]);
      d.subVectors(p, mid);
      const along = d.dot(axis);
      // Perpendicular distance to the site LINE, not to the midpoint: a cylinder, so the
      // filter does not care how high up the ridge a candidate sits.
      if (d.lengthSq() - along * along > radiusMm * radiusMm) continue;
      if (along > best) { best = along; crest = p.clone(); }
    }
  }
  if (!crest) return null;
  return { origin: crest, axis, mid, neighbourAxes: axes, neighbourCentres: centres };
}

// ------------------------------------------------------------- the measurement

/** Canal surface samples near the site: pruned, then split until no edge exceeds
 *  CANAL_EDGE_MM. Vertices alone can only ever OVER-report clearance, because the nearest
 *  point of a triangle can lie inside a face; splitting bounds that error to well under a
 *  hundredth of a millimetre where it matters, and the harness measures what is left. */
export function canalSamples(tris, origin, pruneMm = PRUNE_MM, edgeMm = CANAL_EDGE_MM) {
  const out = [];
  const push = (x, y, z) => out.push(x, y, z);
  const near = (x, y, z) =>
    (x - origin.x) ** 2 + (y - origin.y) ** 2 + (z - origin.z) ** 2 < pruneMm * pruneMm;

  const split = (ax, ay, az, bx, by, bz, cx, cy, cz, depth) => {
    const eab = Math.hypot(bx - ax, by - ay, bz - az);
    const ebc = Math.hypot(cx - bx, cy - by, cz - bz);
    const eca = Math.hypot(ax - cx, ay - cy, az - cz);
    const longest = Math.max(eab, ebc, eca);
    if (longest <= edgeMm || depth >= 6) {
      push(ax, ay, az); push(bx, by, bz); push(cx, cy, cz);
      // The centroid too: on a near-equilateral triangle at the cut-off it is the point
      // furthest from all three corners.
      push((ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3);
      return;
    }
    // Split the longest edge, which keeps the triangles from degenerating into slivers.
    if (longest === eab) {
      const mx = (ax + bx) / 2, my = (ay + by) / 2, mz = (az + bz) / 2;
      split(ax, ay, az, mx, my, mz, cx, cy, cz, depth + 1);
      split(mx, my, mz, bx, by, bz, cx, cy, cz, depth + 1);
    } else if (longest === ebc) {
      const mx = (bx + cx) / 2, my = (by + cy) / 2, mz = (bz + cz) / 2;
      split(ax, ay, az, bx, by, bz, mx, my, mz, depth + 1);
      split(ax, ay, az, mx, my, mz, cx, cy, cz, depth + 1);
    } else {
      const mx = (ax + cx) / 2, my = (ay + cy) / 2, mz = (az + cz) / 2;
      split(ax, ay, az, bx, by, bz, mx, my, mz, depth + 1);
      split(mx, my, mz, bx, by, bz, cx, cy, cz, depth + 1);
    }
  };

  for (let i = 0; i < tris.length; i += 9) {
    if (!near(tris[i], tris[i + 1], tris[i + 2]) &&
        !near(tris[i + 3], tris[i + 4], tris[i + 5]) &&
        !near(tris[i + 6], tris[i + 7], tris[i + 8])) continue;
    split(tris[i], tris[i + 1], tris[i + 2], tris[i + 3], tris[i + 4], tris[i + 5],
          tris[i + 6], tris[i + 7], tris[i + 8], 0);
  }
  return new Float32Array(out);
}

/** The fixture's axis segment at a given seating depth, in root-local millimetres.
 *  The span is `length - radius`, NOT `length`: the measured solid is a capsule, so the
 *  apical hemisphere's centre is one radius short of the tip. Walking a full-length
 *  cylinder instead costs up to `r` of false conservatism — 2.4 mm here, larger than the
 *  whole safety margin — and that is `plan_metrics.axis_span_mm`'s own recorded reason. */
export function axisSegment(origin, axis, depthMm, lengthMm, radiusMm) {
  const a = origin.clone().addScaledVector(axis, -depthMm);
  const b = a.clone().addScaledVector(axis, -(lengthMm - radiusMm));
  return [a, b];
}

export function measureClearance(pts, origin, axis, depthMm,
                                 lengthMm = LENGTH_MM, diameterMm = DIAMETER_MM) {
  if (!pts || !pts.length) return null;
  const r = diameterMm / 2;
  const [a, b] = axisSegment(origin, axis, depthMm, lengthMm, r);
  let best = Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    const d = distToSegment(pts[i], pts[i + 1], pts[i + 2], a, b);
    if (d < best) best = d;
  }
  return best - r;
}

/** The app's grading rule, with the app's own thresholds: a clearance is graded as
 *  `measured - that structure's inward p95`, then compared to the margin. `tight` is a
 *  headroom band, not a second margin. */
export function grade(mm, s = S) {
  if (mm == null || !isFinite(mm)) return { level: "no_verdict", mm: null, graded: null, headroom: null };
  const graded = mm - s.MODEL_INWARD_P95_MM;
  const headroom = graded - s.SAFETY_MARGIN_MM;
  const level = headroom < 0 ? "breach" : headroom < s.TIGHT_BAND_MM ? "tight" : "clear";
  return { level, mm, graded, headroom };
}

// ------------------------------------------------------------------- materials

/** Bone over paper.
 *
 *  The GLB bakes the mandible at opacity 0.34, tuned against #0a0e13, where a translucent
 *  surface reads by being LIGHTER than what is behind it. Over paper that inverts and the
 *  same value is nearly invisible, so the alpha goes up — and the volume comes back a
 *  second way: the mesh is drawn TWICE, back faces then front faces, instead of once
 *  double-sided. The GLB's own materials are doubleSided, and a single double-sided pass
 *  self-sorts badly on a concave bone; splitting the passes is the difference between a
 *  translucent solid and a smear. Neither pass writes depth.
 */
function bonePassMaterial(colour, side, opacity) {
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color().setHex(colour, THREE.SRGBColorSpace),
    roughness: 0.62,
    metalness: 0.0,
    transparent: true,
    opacity,
    depthWrite: false,
    side,
    // The environment is turned up for the metal's sake; the bone has to be pulled back
    // out of it or it goes chalky and stops reading as translucent.
    envMapIntensity: 0.35,
    sheen: 0.5,
    sheenRoughness: 0.75,
    sheenColor: new THREE.Color(0xffffff),
  });
}

/** Machined titanium.
 *
 *  vtk.js could not do this — its WebGL path reads neither metalness nor roughness, which
 *  is why the app's fixture gets its metal from geometry and a specular response. Three.js
 *  has real PBR and an environment map, so here the metal is metal.
 *
 *  NO `anisotropy`. It needs a tangent frame, three derives one from UVs, and `screwLocal`
 *  emits positions and normals only — setting it produces a degenerate frame, not brushed
 *  steel. It is also unnecessary: 96 helical crests at 0.80 mm pitch generate the streak
 *  physically. If it reads too smooth, lower the roughness rather than reach for it.
 */
function titaniumMaterial() {
  const rgb = G.BODY_RGB;
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace),
    metalness: 1.0,
    roughness: 0.26,
    envMapIntensity: 1.0,
  });
}

/** The safety envelope — the only thing that carries the verdict.
 *
 *  BackSide only: one wall, not two, so the fixture inside stays crisp and the tint does
 *  not double up on itself. But one flat translucent wall over translucent bone is a WASH,
 *  and at TIGHT that wash is amber over tan, which reads as a stain rather than a surface.
 *  So the envelope gets a Fresnel of its own: `sheen` lights the grazing angles, which is
 *  exactly where a capsule's silhouette is, and `emissive` holds the hue up out of the bone
 *  behind it. The result reads as a shell you can see the edge of. */
function shellMaterial() {
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0x34d399),
    emissive: new THREE.Color(0x34d399),
    emissiveIntensity: 0.22,
    roughness: 0.35,
    metalness: 0.0,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    side: THREE.BackSide,
    envMapIntensity: 0.5,
    sheen: 1.0,
    sheenRoughness: 0.35,
    sheenColor: new THREE.Color(0xffffff),
  });
}

// ---------------------------------------------------------------------------
function createRenderer() {
  renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, alpha: true, powerPreference: "high-performance",
  });
  renderer.setClearAlpha(0);                 // transparent — the paper stage shows through
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // NeutralToneMapping, not ACESFilmic. ACES tints a white ground warm-grey and crushes the
  // paper the hero is supposed to be sitting on; Neutral is Khronos' PBR-neutral, designed
  // for exactly this case. The old 0.92 exposure was graded against #0a0e13.
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); cancel(); }, false);
  canvas.addEventListener("webglcontextrestored", () => failToPoster(), false);
}

function createScene() {
  scene = new THREE.Scene();
  scene.background = null;
  camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 5000);

  // RoomEnvironment is doing most of the work on a metal hero: the thread's highlight is a
  // reflection of the room's rectangular soft boxes, not a specular dot. A plain gradient
  // sky gives metal nothing to reflect. Rotated so a panel rakes across the thread axis.
  const pmrem = new THREE.PMREMGenerator(renderer);
  envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 1.0;
  scene.environmentRotation = new THREE.Euler(0, -0.7, 0);
  pmrem.dispose();

  const key = new THREE.DirectionalLight(KEY, 1.6);
  key.position.set(28, 46, 30);
  scene.add(key);

  // The white page reflecting back up into the bone. Without it the underside goes grey and
  // the whole thing reads as a model rather than an object on paper.
  const bounce = new THREE.DirectionalLight(0xeef3fa, 0.55);
  bounce.position.set(-18, -34, 12);
  scene.add(bounce);

  // The one brand light: a violet rim that separates bone from paper without tinting it.
  const rim = new THREE.DirectionalLight(ACCENT, 0.30);
  rim.position.set(-32, 16, -34);
  scene.add(rim);

  scene.add(new THREE.AmbientLight(0xffffff, 0.28));
}

function fitCamera() {
  const vFov = (FOV * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  baseDist = Math.max(FRAME_RADIUS_MM / Math.tan(vFov / 2),
                      FRAME_RADIUS_MM / Math.tan(hFov / 2));
}

function buildImplant(root) {
  implantGroup = new THREE.Group();

  // The mobile mesh budget is not about the screw — 96 azimuths costs 19k triangles and a
  // few milliseconds — but a coarse pointer means a small screen where the thread is a few
  // pixels wide, so half the azimuths is free.
  const nAz = coarse ? 48 : G.SCREW_AZIMUTH;
  const screw = G.screwLocal(LENGTH_MM, DIAMETER_MM, nAz);
  screwMesh = new THREE.Mesh(toBufferGeometry(screw), titaniumMaterial());
  screwMesh.renderOrder = 1;
  screwMesh.userData.label = "Titanium fixture · " +
    DIAMETER_MM.toFixed(1) + " × " + LENGTH_MM.toFixed(0) + " mm";
  screwMesh.userData.swatch = "rgb(" + G.BODY_RGB.join(",") + ")";
  screwMesh.userData.meta = "FDI " + SITE_FDI;
  implantGroup.add(screwMesh);

  const shellR = G.SHELL_MARGIN_MM.mandible;
  const shell = G.capsuleLocal(LENGTH_MM + shellR, DIAMETER_MM + 2 * shellR,
                               G.SHELL_AZIMUTH, G.SHELL_DOME_RINGS);
  shellMat = shellMaterial();
  shellMesh = new THREE.Mesh(toBufferGeometry(shell), shellMat);
  shellMesh.renderOrder = 14;
  shellMesh.userData.label = "Safety envelope · " + shellR.toFixed(2) + " mm";
  shellMesh.userData.swatch = "#34d399";
  shellMesh.userData.meta =
    S.SAFETY_MARGIN_MM.toFixed(2) + " margin + " + S.MODEL_INWARD_P95_MM.toFixed(2) + " p95";
  implantGroup.add(shellMesh);

  // The screw's local frame is +z apical with the platform at z = 0. Point local +z along
  // the site's apical direction and the group inherits the arch's rotation for free.
  implantGroup.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 0, 1), site.axis.clone().negate());
  root.add(implantGroup);
  meshList.push(screwMesh, shellMesh);
}

function prepareModel(root, assets) {
  root_ = root;
  model = new THREE.Group();
  model.add(root);
  scene.add(model);
  model.updateMatrixWorld(true);

  bone = []; canalMeshes = []; meshList = [];
  const detach = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const id = structureId(o);
    // The cast is four structures. Everything else is DETACHED, not just hidden: a hidden
    // mesh still costs its share of every traverse and every matrix update.
    if (CAST.indexOf(id) < 0) { detach.push(o); return; }

    const s = structures[id];
    o.userData.label = prettyLabel(id);
    o.userData.swatch = (s && s.colour) || "#ffffff";
    o.userData.meta = s && s.volume_cm3 != null ? s.volume_cm3.toFixed(2) + " cm³" : "";

    if (id === "canal") {
      // OPAQUE. A translucent canal inside translucent bone reads as a stain; solid, it
      // reads as a structure the fixture has to stay away from, which is the point.
      o.material = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color().setHex(CANAL, THREE.SRGBColorSpace),
        roughness: 0.45, metalness: 0.0, envMapIntensity: 0.55,
        emissive: new THREE.Color().setHex(CANAL, THREE.SRGBColorSpace),
        emissiveIntensity: 0.0,
      });
      o.renderOrder = 2;
      canalMeshes.push(o);
    } else if (id === "mandible") {
      // Two passes over one geometry. `o` becomes the FRONT pass; a sibling carries the
      // back faces and is drawn first.
      const back = new THREE.Mesh(o.geometry, bonePassMaterial(BONE, THREE.BackSide, 0.30));
      back.renderOrder = 8;
      back.name = "mandible_back";
      o.parent.add(back);
      back.position.copy(o.position);
      back.quaternion.copy(o.quaternion);
      back.scale.copy(o.scale);
      o.material = bonePassMaterial(BONE, THREE.FrontSide, 0.34);
      o.renderOrder = 12;
      bone.push({ mesh: back, target: 0.30 }, { mesh: o, target: 0.34 });
    } else {
      o.material = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color().setHex(TOOTH, THREE.SRGBColorSpace),
        roughness: 0.42, metalness: 0.0, envMapIntensity: 0.55,
      });
      o.renderOrder = 0;
    }
    meshList.push(o);
  });
  for (const o of detach) o.parent && o.parent.remove(o);

  model.updateMatrixWorld(true);

  // THE BAKED FRAME. Not re-solved here — see the header.
  const baked = assets.site;
  if (!baked || !baked.origin || !baked.axis) {
    throw new Error("arch.assets.json carries no baked site — run scripts/measure_hero_site.mjs");
  }
  site = {
    origin: new THREE.Vector3().fromArray(baked.origin),
    axis: new THREE.Vector3().fromArray(baked.axis).normalize(),
  };

  const canalNode = root.getObjectByName("canal");
  canalPts = canalNode
    ? canalSamples(collectTriangles(canalNode), site.origin)
    : new Float32Array(0);

  buildImplant(root);

  // NO CAST SHADOW AND NO CONTACT BLOB, and this was tried before it was rejected.
  // A ground shadow says "object resting on a surface", and there is no surface here: this
  // is a mandible in space with the bone turned to glass. The shadow plane sat 32 mm below
  // the crest, which put it inside the ramus, and the key light printed two grey lozenges
  // of the teeth onto it that floated in the middle of the frame looking exactly like a
  // rendering bug. The environment map already separates the mass from the paper; the
  // brand's own hero render carries no shadow either.
  // Aim a little below the crest: the subject is the fixture and the canal under it, not
  // the ridge line.
  const down = site.axis.clone().negate();
  camTarget.copy(site.origin).addScaledVector(down, LENGTH_MM * 0.42);

  // A buccal-oblique three-quarter: out through the cheek, a little above the occlusal
  // plane, a little forward. "Out" is solved from the bone rather than assumed, so the
  // shot works whichever side of the arch the gap is on.
  const mandibleNode = root.getObjectByName("mandible");
  const bulk = mandibleNode ? centroid(collectPoints(mandibleNode)) : new THREE.Vector3();
  const out = new THREE.Vector3(site.origin.x - bulk.x, 0, site.origin.z - bulk.z);
  if (out.lengthSq() < 1e-6) out.set(0, 0, 1);
  camDir.copy(out.normalize()).multiplyScalar(0.86)
    .addScaledVector(site.axis, 0.34)
    .add(new THREE.Vector3(0, 0, 0.30)).normalize();

  model.rotation.order = "YXZ";
}

// ---------------------------------------------------------------- choreography

/** The depth curve. Not linear: it DWELLS either side of each verdict boundary, because a
 *  reader who slides straight through TIGHT never sees it. Crossings for this site and
 *  this fixture are baked alongside the frame, so the dwell lands on the real thresholds
 *  rather than on guessed fractions of the scroll. */
function depthAt(t, holds) {
  if (!holds || !holds.length) return t * DEPTH_MAX_MM;
  // Piecewise-linear through (scroll, depth) knots that put a flat stretch on each
  // crossing. Built once from the baked crossings.
  for (let i = 1; i < holds.length; i++) {
    if (t <= holds[i].t) {
      const p = holds[i - 1], n = holds[i];
      const u = n.t === p.t ? 0 : (t - p.t) / (n.t - p.t);
      return p.d + (n.d - p.d) * easeInOutCubic(u);
    }
  }
  return holds[holds.length - 1].d;
}

let depthHolds = null;

function buildHolds(crossings) {
  // Give each crossing a flat window: reach it, hold, then move on.
  const { tight_mm: tt, breach_mm: bb } = crossings || {};
  if (tt == null || bb == null) return null;
  return [
    { t: 0.00, d: 0 },
    { t: 0.26, d: tt - 0.35 },
    { t: 0.40, d: tt + 0.06 },      // TIGHT, and it stops here
    { t: 0.56, d: tt + 0.10 },
    { t: 0.72, d: bb + 0.08 },      // BREACH, and it stops here
    { t: 0.86, d: bb + 0.12 },
    { t: 1.00, d: DEPTH_MAX_MM },
  ];
}

function applyChoreography(p) {
  // 1. The bone turns to glass, early — a reader who never scrolls past the fold should
  //    still see what is inside.
  const reveal = easeInOutCubic(remap(p, REVEAL_FROM, REVEAL_TO));
  for (const b of bone) {
    b.mesh.material.opacity = 0.94 - (0.94 - b.target) * reveal;
    // Only stop writing depth once genuinely translucent, or the fixture pops through bone
    // that is still nearly opaque.
    b.mesh.material.depthWrite = reveal < 0.5;
  }
  for (const c of canalMeshes) c.material.emissiveIntensity = reveal * 0.16;

  // 2. The fixture seats. The only motion that changes a number.
  const seat = remap(p, SEAT_FROM, SEAT_TO);
  const depth = depthAt(seat, depthHolds);
  implantGroup.position.copy(site.origin).addScaledVector(site.axis, -depth);
  implantGroup.visible = reveal > 0.02;
  // The envelope arrives with the measurement, not before: it is the answer's surface.
  shellMesh.visible = seat > 0.001;

  // 3. Measure what is now on screen and grade it with the app's rule.
  const g = grade(measureClearance(canalPts, site.origin, site.axis, depth));
  g.depth_mm = depth;
  applyVerdict(g);

  // 4. A slow orbit underneath, so the shot is alive without competing with the seating.
  model.rotation.y = reducedMotion ? ORBIT_START : ORBIT_START + easeInOutCubic(p) * ORBIT_SWEEP;

  camera.position.copy(camTarget).addScaledVector(camDir, baseDist);
  camera.up.set(0, 1, 0);
  camera.lookAt(camTarget);

  stage.classList.toggle("is-climax", p > CLIMAX_AT);
  return g;
}

/** Colour the envelope and write the readout. The fixture is never touched. */
function applyVerdict(g) {
  const V = G.VERDICT_RGB;
  const rgb = V[g.level] || G.NEUTRAL_RGB;
  shellMat.color.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
  shellMat.emissive.copy(shellMat.color);
  // A breach has to be louder than a clearance, or the one state that matters is the
  // quietest thing on screen.
  shellMat.opacity = g.level === "breach" ? 0.30 : g.level === "tight" ? 0.24 : 0.17;
  if (shellMesh) shellMesh.userData.swatch = "rgb(" + rgb.join(",") + ")";

  if (!readout) return;
  readout.dataset.level = g.level;
  readout.dataset.mm = fmt(g.mm);
  readout.dataset.depth = g.depth_mm.toFixed(3);
  const chip = readout.querySelector("[data-hero-level]");
  const val = readout.querySelector("[data-hero-mm]");
  const dep = readout.querySelector("[data-hero-depth]");
  const sub = readout.querySelector("[data-hero-sub]");
  // The verdict is a WORD, never colour alone — the app's own rule.
  if (chip) chip.textContent = g.level === "no_verdict" ? "NOT GRADED" : g.level.toUpperCase();
  if (val) val.textContent = g.mm == null ? "—" : fmt(g.mm);
  if (dep) dep.textContent = g.depth_mm.toFixed(1);
  if (sub) {
    sub.textContent = g.mm == null
      ? "no canal at this site"
      : fmt(g.mm) + " measured − " + S.MODEL_INWARD_P95_MM.toFixed(2) + " model error = " +
        fmt(g.graded) + " against a " + S.SAFETY_MARGIN_MM.toFixed(2) + " mm margin";
  }
  // Announce the LEVEL only. Putting aria-live on the digits spams a screen reader sixty
  // times a second; the level changes three times in the whole scroll.
  if (liveEl && g.level !== lastLevel) {
    liveEl.textContent = "Clearance to the nerve canal: " +
      (g.level === "no_verdict" ? "not graded" : g.level) + ", " + fmt(g.mm) + " millimetres.";
  }
  lastLevel = g.level;
}

// ---------------------------------------------------------------------- hover
// Styles ship WITH this versioned module (not styles.css, a stable URL on a long cache
// that could lag the JS and leave the tooltip unstyled).
function injectTooltipStyles() {
  if (document.getElementById("hero3d-style")) return;
  const css = `
.hero3d-tooltip{position:fixed;left:0;top:0;z-index:60;pointer-events:none;
  display:inline-flex;align-items:center;gap:.55rem;padding:.38rem .66rem;
  font-family:var(--mono,ui-monospace,SFMono-Regular,Menlo,monospace);
  font-size:.72rem;letter-spacing:.02em;color:var(--text,#0f1520);
  background:rgba(255,255,255,.94);border:1px solid var(--hairline-strong,rgba(15,21,32,.18));
  border-radius:var(--radius-sm,5px);
  box-shadow:0 1px 2px rgba(16,24,40,.06),0 10px 26px rgba(16,24,40,.12);
  white-space:nowrap;opacity:0;transition:opacity .12s ease}
.hero3d-tooltip.is-visible{opacity:1}
.hero3d-tooltip__dot{width:.55rem;height:.55rem;flex:none;border-radius:50%;
  box-shadow:inset 0 0 0 1px rgba(15,21,32,.18)}
.hero3d-tooltip__meta{opacity:.55;font-variant-numeric:tabular-nums}`;
  const el = document.createElement("style");
  el.id = "hero3d-style";
  el.textContent = css;
  document.head.appendChild(el);
}

function setGlow(mesh, on) {
  const m = mesh && mesh.material;
  if (!m || !m.emissive) return;
  if (mesh === screwMesh) return;            // the metal does not change colour, ever
  if (on) {
    mesh.userData._e = m.emissiveIntensity;
    m.emissive.copy(m.color);
    m.emissiveIntensity = Math.max(m.emissiveIntensity, 0.4);
  } else if (mesh.userData._e != null) {
    m.emissiveIntensity = mesh.userData._e;
  }
}

function positionTooltip() {
  if (!tipEl) return;
  const pad = 16;
  const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  let x = ptrX + pad, y = ptrY + pad;
  if (x + w > window.innerWidth - 8) x = ptrX - pad - w;
  if (y + h > window.innerHeight - 8) y = ptrY - pad - h;
  tipEl.style.left = x + "px";
  tipEl.style.top = y + "px";
}

function setHover(mesh) {
  if (mesh === hovered) return;
  if (hovered) setGlow(hovered, false);
  hovered = mesh || null;
  if (hovered) {
    setGlow(hovered, true);
    if (tipEl) {
      tipLabel.textContent = hovered.userData.label || "Structure";
      tipMeta.textContent = hovered.userData.meta || "";
      tipDot.style.background = hovered.userData.swatch || "#fff";
      tipEl.classList.add("is-visible");
      positionTooltip();
    }
  } else if (tipEl) {
    tipEl.classList.remove("is-visible");
  }
}

function onPointerMove(e) {
  ptrX = e.clientX; ptrY = e.clientY;
  const r = canvas.getBoundingClientRect();
  ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  pointerMoved = true;
  if (hovered) positionTooltip();
  if (smoothP > HOVER_MIN_PROGRESS) wake();
}

function updateHover() {
  if (!pointerInside || smoothP <= HOVER_MIN_PROGRESS) {
    if (hovered) setHover(null);
    pointerMoved = false;
    return;
  }
  if (pointerMoved || smoothP !== targetP) {
    scene.updateMatrixWorld();
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(meshList.filter((m) => m.visible), false);
    setHover(hits.length ? hits[0].object : null);
  }
  pointerMoved = false;
}

// ---------------------------------------------------------------------------
function onResize() {
  // The CANVAS's own box, not its parent's. On wide screens the canvas is inset to the
  // right half of the stage while the parent stays full-bleed, so measuring the parent
  // renders a 100%-wide image into a 58%-wide element and squashes the fixture.
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  fitCamera();
  wake();
}

function tick(now) {
  raf = null;
  const dt = Math.min((now - lastT) / 1000, 0.05);
  lastT = now;

  targetP = progress();
  // Framerate-independent smoothing. A naive `+= (t-s)*0.12` runs twice as fast on a
  // 120 Hz display as on a 60 Hz one.
  const k = 1 - Math.exp(-SMOOTH_LAMBDA * dt);
  smoothP += (targetP - smoothP) * k;
  if (Math.abs(targetP - smoothP) < 0.0005) smoothP = targetP;

  applyChoreography(smoothP);
  if (finePointer) updateHover();
  renderer.render(scene, camera);

  if (visible && smoothP !== targetP) {
    raf = requestAnimationFrame(tick);
  } else {
    running = false;             // settled — sleep until scroll or resize wakes us
  }
}

function wake() {
  if (running || !initialized) return;
  running = true;
  lastT = performance.now();
  raf = requestAnimationFrame(tick);
}

function cancel() {
  if (raf) cancelAnimationFrame(raf);
  raf = null;
  running = false;
}

function dispose() {
  cancel();
  if (tipEl) { tipEl.remove(); tipEl = null; }
  if (renderer) renderer.dispose();
  if (envRT) envRT.dispose();
  if (model) {
    model.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose();
        const m = o.material;
        (Array.isArray(m) ? m : [m]).forEach((mm) => mm?.dispose?.());
      }
    });
  }
}

// ---------------------------------------------------------------------------
async function init() {
  stage = document.querySelector("[data-filmstage]");
  canvas = document.getElementById("heroCanvas");
  if (!stage || !canvas) return;
  if (!hasWebGL()) { failToPoster(); return; }

  const guard = setTimeout(() => { if (!initialized) failToPoster(); }, 12000);

  try {
    readout = document.querySelector("[data-hero-readout]");
    liveEl = document.querySelector("[data-hero-live]");

    // Revalidate the pointer file: it is tiny, everything it names is content-hashed, and
    // /assets/ is served immutable — force-cache would strand every hash in it.
    const assets = await fetch(ASSETS_URL, { cache: "no-cache" }).then((r) => r.json());
    await loadModules(assets);

    const useMobile = coarse || window.innerWidth <= 820 ||
      (navigator.deviceMemory && navigator.deviceMemory <= 4);
    const url = "/assets/" + (useMobile ? assets.mobile : assets.desktop);

    if (assets.manifest) {
      try {
        const man = await fetch("/assets/" + assets.manifest + "?v=" + BUILD).then((r) => r.json());
        for (const s of man.structures || []) structures[s.id] = s;
      } catch (e) { console.warn("[hero3d] manifest unavailable:", e); }
    }

    createRenderer();
    createScene();

    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(url);

    prepareModel(gltf.scene, assets);
    depthHolds = buildHolds(assets.site && assets.site.crossings);
    onResize();

    initialized = true;
    clearTimeout(guard);
    stage.classList.add("filmstage--live");

    console.info("[hero3d] FDI " + SITE_FDI + " · " + DIAMETER_MM.toFixed(1) + " x " +
      LENGTH_MM.toFixed(0) + " mm · envelope " + G.SHELL_MARGIN_MM.mandible.toFixed(2) +
      " mm (" + S.SAFETY_MARGIN_MM.toFixed(2) + " margin + " +
      S.MODEL_INWARD_P95_MM.toFixed(2) + " p95) · " + (canalPts.length / 3) +
      " canal samples · " + (useMobile ? "mobile" : "desktop") + " mesh");

    window.addEventListener("scroll", wake, { passive: true });
    window.addEventListener("resize", onResize, { passive: true });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) cancel(); else wake();
    });
    window.addEventListener("pagehide", dispose);

    if ("IntersectionObserver" in window) {
      new IntersectionObserver((entries) => {
        visible = entries[0].isIntersecting;
        if (visible) wake();
      }, { rootMargin: "200px" }).observe(stage);
    }

    if (finePointer) {
      injectTooltipStyles();
      tipEl = document.createElement("div");
      tipEl.className = "hero3d-tooltip";
      tipEl.innerHTML = '<span class="hero3d-tooltip__dot"></span>' +
        '<span class="hero3d-tooltip__label"></span>' +
        '<span class="hero3d-tooltip__meta"></span>';
      document.body.appendChild(tipEl);
      tipDot = tipEl.querySelector(".hero3d-tooltip__dot");
      tipLabel = tipEl.querySelector(".hero3d-tooltip__label");
      tipMeta = tipEl.querySelector(".hero3d-tooltip__meta");
      stage.addEventListener("pointermove", onPointerMove, { passive: true });
      stage.addEventListener("pointerenter", () => { pointerInside = true; });
      stage.addEventListener("pointerleave", () => {
        pointerInside = false; pointerMoved = true; wake();
      });
    }

    // The verification hook. Screenshots land on the browser's host rather than in the
    // shell that drove the page, so the hero is checked by MEASUREMENT: drive the scrub
    // deterministically and hand the checker every input it needs to recompute the
    // readout against its own oracle. `scripts/check_hero.mjs` is the consumer.
    window.__hero3d = {
      set(p) {
        smoothP = targetP = clamp01(p);
        const g = applyChoreography(smoothP);
        renderer.render(scene, camera);
        return { p: smoothP, level: g.level, mm: g.mm, depth_mm: g.depth_mm };
      },
      state() {
        let drawn = 0;
        model.traverse((o) => { if (o.isMesh && o.visible) drawn += 1; });
        return {
          p: smoothP,
          site: SITE_FDI,
          fixture: { diameter_mm: DIAMETER_MM, length_mm: LENGTH_MM },
          shell_mm: G.SHELL_MARGIN_MM.mandible,
          thresholds: {
            margin: S.SAFETY_MARGIN_MM, p95: S.MODEL_INWARD_P95_MM, tight: S.TIGHT_BAND_MM,
            worst: S.MODEL_INWARD_WORST_MM,
          },
          mesh: useMobile ? "mobile" : "desktop",
          drawnMeshes: drawn,
          canalSamples: canalPts.length / 3,
          screwTriangles: screwMesh.geometry.getIndex().count / 3,
          reducedMotion,
        };
      },
      measure() {
        const depth = Number(readout && readout.dataset.depth) || 0;
        const r = DIAMETER_MM / 2;
        const [a, b] = axisSegment(site.origin, site.axis, depth, LENGTH_MM, r);
        const g = grade(measureClearance(canalPts, site.origin, site.axis, depth));
        return {
          p: smoothP,
          depth_mm: +depth.toFixed(4),
          segment: [a.toArray().map((x) => +x.toFixed(5)), b.toArray().map((x) => +x.toFixed(5))],
          radius_mm: r,
          clearance_mm: g.mm == null ? null : +g.mm.toFixed(5),
          graded_mm: g.graded == null ? null : +g.graded.toFixed(5),
          headroom_mm: g.headroom == null ? null : +g.headroom.toFixed(5),
          level: g.level,
          readout: readout ? { mm: readout.dataset.mm, level: readout.dataset.level } : null,
          // The invariant that is worth asserting on every frame: the metal never carries
          // the verdict.
          bodyIsNeutral: screwMesh.material.color.getHex() ===
            new THREE.Color().setRGB(G.BODY_RGB[0] / 255, G.BODY_RGB[1] / 255,
                                     G.BODY_RGB[2] / 255, THREE.SRGBColorSpace).getHex(),
          shellColour: "#" + shellMat.color.getHexString(),
          boneOpacity: bone.map((b2) => +b2.mesh.material.opacity.toFixed(3)),
        };
      },
    };

    smoothP = targetP = progress();
    applyChoreography(smoothP);
    renderer.render(scene, camera);
    wake();
  } catch (err) {
    clearTimeout(guard);
    console.error("[hero3d] init failed:", err);
    failToPoster();
  }
}

if (BROWSER) init();

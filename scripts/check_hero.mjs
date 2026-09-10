/* Prove the landing hero's geometry against the real GLB, with an independent oracle.
 *
 * The hero puts a millimetre on a marketing page and grades it. That number is therefore
 * checked the way this repository checks the app's numbers -- by recomputing it a second,
 * different way -- rather than by looking at it. `viewer/check-equivalence.mjs` makes the
 * same argument across two languages; this makes it across two algorithms.
 *
 * THE ORACLE IS NOT THE PAGE'S CODE. The page prunes the canal, splits it until no edge
 * exceeds 0.4 mm, and takes point-to-segment distances -- fast enough to run every frame.
 * The oracle here walks the ORIGINAL, unsplit canal triangles with an exact
 * point-to-triangle routine over the axis segment sampled at 0.05 mm. If the two agree,
 * the page's sampling is fine; if they drift, the page is over-reporting clearance, which
 * is the one direction that matters.
 *
 *   node scripts/check_hero.mjs            run the checks
 *   node scripts/check_hero.mjs --prove    break each one on purpose and show it fails
 *
 * --prove exists because an assertion nobody has seen fail is a comment. Same discipline
 * as `web-auth/check-rail.mjs --prove`.
 */
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'landing/assets');
const VENDOR = path.join(ASSETS, 'vendor/three');

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'three') return { url: 'file://' + path.join(VENDOR, 'three.module.js'), shortCircuit: true };
    if (spec.startsWith('three/addons/'))
      return { url: 'file://' + path.join(VENDOR, 'jsm', spec.slice('three/addons/'.length)), shortCircuit: true };
    return next(spec, ctx);
  },
});

const THREE = await import('three');
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
const hero = await import('../landing/assets/hero3d.js');

const pointer = JSON.parse(readFileSync(path.join(ASSETS, 'arch.assets.json'), 'utf8'));
const G = await import(path.join(ASSETS, pointer.screw));
const S = await import(path.join(ASSETS, pointer.safety));

const PROVE = process.argv.includes('--prove');
let failures = 0;
const results = [];
function check(name, fn) {
  let ok = false, detail = '';
  try { detail = fn() || ''; ok = true; } catch (e) { detail = e.message; }
  results.push({ name, ok });
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
}
const must = (c, m) => { if (!c) throw new Error(m); };

async function loadGLB(file) {
  const buf = readFileSync(path.join(ASSETS, file));
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await new Promise((res, rej) => loader.parse(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej));
  gltf.scene.updateMatrixWorld(true);
  return gltf.scene;
}

// ------------------------------------------------------- the independent oracle
/** Exact squared distance from a point to a triangle (Ericson, Real-Time Collision
 *  Detection §5.1.5). Written here and NOWHERE ELSE in this repository on purpose: an
 *  oracle that shares code with the thing it checks is not an oracle. */
function distSqPointTriangle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const qx = ax + abx * v - px, qy = ay + aby * v - py, qz = az + abz * v - pz;
    return qx * qx + qy * qy + qz * qz;
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const qx = ax + acx * w - px, qy = ay + acy * w - py, qz = az + acz * w - pz;
    return qx * qx + qy * qy + qz * qz;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const qx = bx + (cx - bx) * w - px, qy = by + (cy - by) * w - py, qz = bz + (cz - bz) * w - pz;
    return qx * qx + qy * qy + qz * qz;
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  const qx = ax + abx * v + acx * w - px;
  const qy = ay + aby * v + acy * w - py;
  const qz = az + abz * v + acz * w - pz;
  return qx * qx + qy * qy + qz * qz;
}

/** Clearance the server's way: walk the axis segment, take the nearest point of the canal
 *  SURFACE at each station, subtract the radius. `plan_metrics` samples at 0.1 mm; 0.05
 *  here, so the oracle is strictly finer than the thing it is checking. */
function oracleClearance(tris, origin, axis, depthMm, lengthMm, diameterMm, pitch = 0.05) {
  const r = diameterMm / 2;
  const a = origin.clone().addScaledVector(axis, -depthMm);
  const span = lengthMm - r;                       // NOT lengthMm; see plan_metrics.axis_span_mm
  const n = Math.max(2, Math.ceil(span / pitch));
  let best = Infinity;
  for (let k = 0; k <= n; k++) {
    const t = (k / n) * span;
    const px = a.x - axis.x * t, py = a.y - axis.y * t, pz = a.z - axis.z * t;
    for (let i = 0; i < tris.length; i += 9) {
      const d2 = distSqPointTriangle(px, py, pz,
        tris[i], tris[i + 1], tris[i + 2],
        tris[i + 3], tris[i + 4], tris[i + 5],
        tris[i + 6], tris[i + 7], tris[i + 8]);
      if (d2 < best) best = d2;
    }
  }
  return Math.sqrt(best) - r;
}

// ------------------------------------------------------------------------ setup
const root = await loadGLB(pointer.desktop);
console.log(`# ${pointer.desktop} · fixture ${hero.DIAMETER_MM} x ${hero.LENGTH_MM} mm · site FDI ${hero.SITE_FDI}`);

const baked = pointer.site;
const solved = hero.solveSite(root);
const origin = new THREE.Vector3().fromArray(baked.origin);
const axis = new THREE.Vector3().fromArray(baked.axis).normalize();
const canalTris = hero.collectTriangles(root.getObjectByName('canal'));
const pts = hero.canalSamples(canalTris, origin);

// Prune the oracle's triangle set the same way, or it walks the whole canal for every one
// of ~320 stations x 12 positions. Correctness is unaffected: nothing 30 mm away can hold
// a minimum that the near field already bounds at a few millimetres.
const nearTris = [];
for (let i = 0; i < canalTris.length; i += 9) {
  let keep = false;
  for (let v = 0; v < 9; v += 3) {
    if ((canalTris[i + v] - origin.x) ** 2 + (canalTris[i + v + 1] - origin.y) ** 2 +
        (canalTris[i + v + 2] - origin.z) ** 2 < hero.PRUNE_MM ** 2) { keep = true; break; }
  }
  if (keep) for (let k = 0; k < 9; k++) nearTris.push(canalTris[i + k]);
}
const oracleTris = new Float32Array(nearTris);

// ------------------------------------------------------------------- the checks
check('the baked frame is still what the rule produces', () => {
  must(solved, 'solveSite() returned nothing');
  const dp = solved.origin.distanceTo(origin);
  const da = Math.acos(Math.min(1, solved.axis.dot(axis))) * 180 / Math.PI;
  must(dp < 1e-3, `the baked seat is ${dp.toFixed(4)} mm from the rule's answer`);
  must(da < 1e-3, `the baked axis is ${da.toFixed(4)} deg from the rule's answer`);
  must(baked.source_mesh === pointer.desktop, 'the frame was baked from a different mesh');
  return `seat and axis reproduce to ${dp.toExponential(1)} mm`;
});

check('the site is a real gap between two standing neighbours', () => {
  const man = root.getObjectByName('arch') || root;
  must(!root.getObjectByName('tooth_46'), 'tooth_46 is PRESENT — this is not an edentulous site');
  for (const n of ['tooth_45', 'tooth_47']) must(root.getObjectByName(n), `${n} is missing`);
  const c45 = hero.centroid(hero.collectPoints(root.getObjectByName('tooth_45')));
  const c47 = hero.centroid(hero.collectPoints(root.getObjectByName('tooth_47')));
  const mid = c45.clone().add(c47).multiplyScalar(0.5);
  const d = mid.clone().sub(origin);
  const along = d.dot(axis);
  const lateral = Math.sqrt(Math.max(0, d.lengthSq() - along * along));
  must(lateral <= 3.5 + 1e-6, `the seat is ${lateral.toFixed(2)} mm off the site line (rule says 3.5)`);
  must(along < 0, 'the seat is below the neighbours rather than above them');
  return `gap ${c45.distanceTo(c47).toFixed(1)} mm, seat ${lateral.toFixed(2)} mm off the line`;
});

check('the fixture is a catalogue size', () => {
  const cat = readFileSync(path.join(ROOT, 'dentistry/implants.py'), 'utf8');
  const lengths = [...cat.matchAll(/"length_mm":\s*([0-9.]+)/g)].map((m) => Number(m[1]));
  const diameters = [...cat.matchAll(/"diameter_mm":\s*\[([^\]]+)\]/g)]
    .flatMap((m) => m[1].split(',').map((x) => Number(x.trim())));
  must(lengths.includes(hero.LENGTH_MM), `${hero.LENGTH_MM} mm is not a catalogue length (${lengths.join(', ')})`);
  must(diameters.includes(hero.DIAMETER_MM), `${hero.DIAMETER_MM} mm is not a catalogue diameter`);
  return `${hero.DIAMETER_MM} x ${hero.LENGTH_MM} mm, both in dentistry/implants.py`;
});

let sweep = [];
check('the page agrees with an independent oracle to 0.01 mm', () => {
  sweep = [];
  let worst = 0, worstAt = 0, signedWorst = 0;
  for (let i = 0; i <= 12; i++) {
    const d = (i / 12) * hero.DEPTH_MAX_MM;
    const page = hero.measureClearance(pts, origin, axis, d, hero.LENGTH_MM, hero.DIAMETER_MM);
    const truth = oracleClearance(oracleTris, origin, axis, d, hero.LENGTH_MM, hero.DIAMETER_MM);
    sweep.push({ d, page, truth, level: hero.grade(page, S).level });
    const err = page - truth;
    if (Math.abs(err) > worst) { worst = Math.abs(err); worstAt = d; signedWorst = err; }
  }
  must(worst < 0.01, `worst disagreement ${worst.toFixed(4)} mm at ${worstAt.toFixed(2)} mm depth`);
  // The residual must not be systematically OPTIMISTIC. Over-reporting clearance is the
  // one direction that could make a breach look tight.
  const mean = sweep.reduce((a, s) => a + (s.page - s.truth), 0) / sweep.length;
  must(mean < 0.005, `the page over-reports by ${mean.toFixed(4)} mm on average`);
  return `worst ${signedWorst >= 0 ? '+' : ''}${signedWorst.toFixed(4)} mm, mean ${mean >= 0 ? '+' : ''}${mean.toFixed(4)} mm over 13 positions`;
});

check('seating deeper closes the clearance, monotonically', () => {
  for (let i = 1; i < sweep.length; i++) {
    must(sweep[i].page <= sweep[i - 1].page + 1e-9,
      `clearance ROSE from ${sweep[i - 1].page.toFixed(3)} to ${sweep[i].page.toFixed(3)}`);
  }
  return `${sweep[0].page.toFixed(2)} → ${sweep[sweep.length - 1].page.toFixed(2)} mm over ${hero.DEPTH_MAX_MM} mm`;
});

check('the scrub really passes through clear, tight and breach, in that order', () => {
  const order = sweep.map((s) => s.level).filter((l, i, a) => l !== a[i - 1]);
  must(order.join('>') === 'clear>tight>breach', `verdict order was ${order.join(' > ')}`);
  const c = baked.crossings;
  must(c.tight_mm > 0 && c.breach_mm > c.tight_mm && c.breach_mm < hero.DEPTH_MAX_MM,
    `crossings ${JSON.stringify(c)} do not both fall inside the ${hero.DEPTH_MAX_MM} mm sweep`);
  return `TIGHT at ${c.tight_mm.toFixed(2)} mm, BREACH at ${c.breach_mm.toFixed(2)} mm subcrestal`;
});

check("grading is the app's arithmetic, not a lookalike", () => {
  for (const s of sweep) {
    const g = hero.grade(s.page, S);
    must(Math.abs(g.graded - (s.page - S.MODEL_INWARD_P95_MM)) < 1e-12, 'graded is not measured - p95');
    const want = g.headroom < 0 ? 'breach' : g.headroom < S.TIGHT_BAND_MM ? 'tight' : 'clear';
    must(g.level === want, `at ${s.page.toFixed(3)} expected ${want}, got ${g.level}`);
  }
  // ...and the thresholds are the ones Python declares, not a copy that has drifted.
  const py = readFileSync(path.join(ROOT, 'dentistry/plan_safety.py'), 'utf8');
  for (const [k, v] of [['SAFETY_MARGIN_MM', S.SAFETY_MARGIN_MM], ['TIGHT_BAND_MM', S.TIGHT_BAND_MM],
                        ['MODEL_INWARD_P95_MM', S.MODEL_INWARD_P95_MM]]) {
    const m = py.match(new RegExp(`^${k}\\s*=\\s*([0-9.]+)`, 'm'));
    must(m && Math.abs(Number(m[1]) - v) < 1e-12, `${k} disagrees with plan_safety.py`);
  }
  return `margin ${S.SAFETY_MARGIN_MM} + p95 ${S.MODEL_INWARD_P95_MM}, tight band ${S.TIGHT_BAND_MM}`;
});

check('every drawn vertex is inside the measured capsule', () => {
  for (const nAz of [G.SCREW_AZIMUTH, 48]) {     // desktop and the coarse-pointer build
    const m = G.screwLocal(hero.LENGTH_MM, hero.DIAMETER_MM, nAz);
    const r = hero.DIAMETER_MM / 2, shoulder = hero.LENGTH_MM - r;
    let worst = -Infinity;
    for (let i = 0; i < m.verts.length; i += 3) {
      const rho = Math.hypot(m.verts[i], m.verts[i + 1]);
      worst = Math.max(worst, rho - G.envelopeRadius(m.verts[i + 2], r, shoulder));
    }
    must(worst < 1e-5, `at ${nAz} azimuths a vertex sits ${worst.toExponential(2)} mm OUTSIDE the capsule`);
  }
  const m = G.screwLocal(hero.LENGTH_MM, hero.DIAMETER_MM, G.SCREW_AZIMUTH);
  return `${m.nTris} tris at ${G.SCREW_AZIMUTH} azimuths, contained`;
});

check('the envelope is drawn at margin + p95 and nothing else', () => {
  const shellR = G.SHELL_MARGIN_MM.mandible;
  const want = S.SAFETY_MARGIN_MM + S.MODEL_INWARD_P95_MM;
  must(Math.abs(shellR - want) < 1e-9,
    `implants.js draws ${shellR} mm, plan_safety.py implies ${want.toFixed(2)} mm`);
  const s = G.capsuleLocal(hero.LENGTH_MM + shellR, hero.DIAMETER_MM + 2 * shellR,
                           G.SHELL_AZIMUTH, G.SHELL_DOME_RINGS);
  const rs = hero.DIAMETER_MM / 2 + shellR;
  let maxR = 0, maxZ = 0;
  for (let i = 0; i < s.verts.length; i += 3) {
    maxR = Math.max(maxR, Math.hypot(s.verts[i], s.verts[i + 1]));
    maxZ = Math.max(maxZ, s.verts[i + 2]);
  }
  must(Math.abs(maxR - rs) < 1e-4, `shell radius ${maxR.toFixed(4)}, expected ${rs.toFixed(4)}`);
  must(Math.abs(maxZ - (hero.LENGTH_MM + shellR)) < 1e-4, 'shell length is not length + margin');
  return `${shellR.toFixed(2)} mm shell sharing the fixture's shoulder`;
});

check('the two LODs do not disagree about the verdict', () => {
  must(baked.lod_agreement_mm < 0.05,
    `desktop and mobile differ by ${baked.lod_agreement_mm} mm`);
  return `${baked.lod_agreement_mm} mm across the sweep (baked)`;
});

const mobile = await loadGLB(pointer.mobile);
check('the mobile mesh reaches the same verdicts at the same depths', () => {
  const mpts = hero.canalSamples(hero.collectTriangles(mobile.getObjectByName('canal')), origin);
  let worst = 0;
  for (const s of sweep) {
    const m = hero.measureClearance(mpts, origin, axis, s.d, hero.LENGTH_MM, hero.DIAMETER_MM);
    worst = Math.max(worst, Math.abs(m - s.page));
    must(hero.grade(m, S).level === s.level,
      `at ${s.d.toFixed(2)} mm desktop says ${s.level}, mobile says ${hero.grade(m, S).level}`);
  }
  return `every verdict matches; worst clearance difference ${worst.toFixed(4)} mm`;
});

// ---------------------------------------------------------------------- --prove
if (PROVE) {
  console.log('\n# --prove: each assertion, deliberately broken');
  const proofs = [
    ['the baked frame check', () => {
      const moved = origin.clone().addScaledVector(axis, -0.5);
      return solved.origin.distanceTo(moved) >= 1e-3;
    }],
    ['the oracle agreement check', () => {
      // Measure with the WRONG span -- the full length rather than length - radius, the
      // exact mistake plan_metrics.axis_span_mm records.
      const r = hero.DIAMETER_MM / 2;
      const a = origin.clone();
      const b = a.clone().addScaledVector(axis, -hero.LENGTH_MM);
      let best = Infinity;
      for (let i = 0; i < pts.length; i += 3) {
        const d = hero.distToSegment(pts[i], pts[i + 1], pts[i + 2], a, b);
        if (d < best) best = d;
      }
      const wrong = best - r;
      const truth = oracleClearance(oracleTris, origin, axis, 0, hero.LENGTH_MM, hero.DIAMETER_MM);
      return Math.abs(wrong - truth) >= 0.01;
    }],
    ['monotonic clearance', () => {
      const bad = sweep.map((s, i) => (i === 6 ? { ...s, page: s.page + 0.5 } : s));
      for (let i = 1; i < bad.length; i++) if (bad[i].page > bad[i - 1].page + 1e-9) return true;
      return false;
    }],
    ['verdict ordering', () => {
      const order = sweep.map((s) => s.level).reverse().filter((l, i, a) => l !== a[i - 1]);
      return order.join('>') !== 'clear>tight>breach';
    }],
    ['capsule containment', () => {
      const m = G.screwLocal(hero.LENGTH_MM, hero.DIAMETER_MM, G.SCREW_AZIMUTH);
      const r = hero.DIAMETER_MM / 2, shoulder = hero.LENGTH_MM - r;
      let worst = -Infinity;
      for (let i = 0; i < m.verts.length; i += 3) {
        worst = Math.max(worst, Math.hypot(m.verts[i], m.verts[i + 1]) -
          G.envelopeRadius(m.verts[i + 2], r - 0.01, shoulder));
      }
      return worst > 1e-5;
    }],
    ['the catalogue check', () => {
      const cat = readFileSync(path.join(ROOT, 'dentistry/implants.py'), 'utf8');
      const lengths = [...cat.matchAll(/"length_mm":\s*([0-9.]+)/g)].map((m) => Number(m[1]));
      return !lengths.includes(15.5);             // a plausible-looking non-catalogue length
    }],
    ['the grading thresholds', () => hero.grade(S.SAFETY_MARGIN_MM + S.MODEL_INWARD_P95_MM - 0.01, S).level !== 'clear'],
  ];
  let proved = 0;
  for (const [name, fn] of proofs) {
    const caught = fn();
    console.log(`${caught ? 'ok  ' : 'FAIL'} ${name} fails when broken`);
    if (caught) proved += 1; else failures += 1;
  }
  console.log(`# proved ${proved}/${proofs.length}`);
}

console.log(`\n# ${results.filter((r) => r.ok).length}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);

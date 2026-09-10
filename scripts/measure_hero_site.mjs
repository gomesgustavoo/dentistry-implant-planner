/* Derive the landing hero's implant site ONCE, from the scan, and bake it into the pointer.
 *
 * WHY THIS IS A BAKE AND NOT A RUNTIME SOLVE. Re-deriving the alveolar crest from whichever
 * mesh the browser loaded puts it 4.3 mm apart between the desktop and mobile LODs, and
 * moves the measured clearance by 0.79-0.87 mm -- nearly twice the 0.46 mm the whole
 * honesty argument rests on, and enough for the page to say CLEAR on a laptop and BREACH on
 * a phone at the same scroll position. With the frame fixed and only the canal measured
 * live, the two LODs agree to hundredths. So the frame is a constant and the canal is not.
 *
 * THE RULE, which lives in `landing/assets/hero3d.js::solveSite` and nowhere else:
 *   axis  = the mean of the two standing neighbours' own long axes (tooth 45 and tooth 47)
 *   seat  = the mandible vertex furthest along that axis within 3.5 mm of the site line
 *
 * This script runs that rule, measures what follows from it, and writes the result into
 * `landing/assets/arch.assets.json` under `site`. `scripts/check_hero.mjs` re-runs the same
 * rule and asserts the baked values still match, so the constants cannot quietly rot.
 *
 *   node scripts/measure_hero_site.mjs           bake
 *   node scripts/measure_hero_site.mjs --check   exit 1 if the baked frame is stale
 *   node scripts/measure_hero_site.mjs --sweep   also print the full depth sweep
 */
import { registerHooks } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'landing/assets');
const VENDOR = path.join(ASSETS, 'vendor/three');
const POINTER = path.join(ASSETS, 'arch.assets.json');

// The page resolves `three` and `three/addons/` through an import map in index.html. Node
// has no import map, so the same rules are restated -- and only here, so a specifier that
// works in the browser but not in the tooling fails loudly instead of diverging.
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

const pointer = JSON.parse(readFileSync(POINTER, 'utf8'));
const S = await import(path.join(ASSETS, pointer.safety));

async function loadGLB(file) {
  const buf = readFileSync(path.join(ASSETS, file));
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await new Promise((res, rej) => loader.parse(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej));
  gltf.scene.updateMatrixWorld(true);
  return gltf.scene;
}

const DIAMETER_MM = hero.DIAMETER_MM ?? 4.8;
const LENGTH_MM = hero.LENGTH_MM ?? 13.0;

const root = await loadGLB(pointer.desktop);
const site = hero.solveSite(root);
if (!site) throw new Error('the site did not solve -- are tooth_45, tooth_47 and mandible all in the GLB?');

const canalNode = root.getObjectByName('canal');
const tris = hero.collectTriangles(canalNode);
const pts = hero.canalSamples(tris, site.origin);

const clearance = (d) => hero.measureClearance(pts, site.origin, site.axis, d, LENGTH_MM, DIAMETER_MM);
const level = (d) => hero.grade(clearance(d), S).level;

/** Bisect for the depth at which the verdict first becomes `want`. */
function crossing(want, lo = 0, hi = 12) {
  if (level(lo) === want) return lo;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const order = { clear: 0, tight: 1, breach: 2, no_verdict: 3 };
    if (order[level(mid)] >= order[want]) hi = mid; else lo = mid;
  }
  return +((lo + hi) / 2).toFixed(4);
}

// Bone above the canal at this site: crest to the nearest canal surface sample. This is the
// number the copy quotes, and it is a fact about the scan rather than a claim about the app.
let boneAbove = Infinity;
for (let i = 0; i < pts.length; i += 3) {
  const d = Math.hypot(pts[i] - site.origin.x, pts[i + 1] - site.origin.y, pts[i + 2] - site.origin.z);
  if (d < boneAbove) boneAbove = d;
}

const tightAt = crossing('tight');
const breachAt = crossing('breach');

const baked = {
  fdi: 46,
  rule: "axis = mean long axis of tooth_45 and tooth_47; seat = the mandible vertex furthest along it within 3.5 mm of the site line",
  source_mesh: pointer.desktop,
  origin: site.origin.toArray().map((x) => +x.toFixed(4)),
  axis: site.axis.toArray().map((x) => +x.toFixed(6)),
  fixture: { diameter_mm: DIAMETER_MM, length_mm: LENGTH_MM },
  bone_above_canal_mm: +boneAbove.toFixed(2),
  crossings: { tight_mm: tightAt, breach_mm: breachAt },
  clearance_at_crest_mm: +clearance(0).toFixed(3),
  canal_samples: pts.length / 3,
};

// Cross-LOD agreement, measured rather than assumed. This is the number that justifies
// baking the frame, so it is recorded next to the frame it justifies.
const mobileRoot = await loadGLB(pointer.mobile);
const mobilePts = hero.canalSamples(hero.collectTriangles(mobileRoot.getObjectByName('canal')), site.origin);
let worstLod = 0;
const sweep = [];
for (let i = 0; i <= 30; i++) {
  const d = (i / 30) * 3.0;
  const a = clearance(d);
  const b = hero.measureClearance(mobilePts, site.origin, site.axis, d, LENGTH_MM, DIAMETER_MM);
  worstLod = Math.max(worstLod, Math.abs(a - b));
  sweep.push({ d: +d.toFixed(3), desktop: +a.toFixed(3), mobile: +b.toFixed(3), level: hero.grade(a, S).level });
}
baked.lod_agreement_mm = +worstLod.toFixed(4);

if (process.argv.includes('--sweep')) {
  console.log('depth_mm  desktop  mobile   level');
  for (const s of sweep) console.log(`   ${s.d.toFixed(2)}    ${s.desktop.toFixed(3)}   ${s.mobile.toFixed(3)}   ${s.level}`);
  console.log('');
}

const same = JSON.stringify(pointer.site) === JSON.stringify(baked);
if (process.argv.includes('--check')) {
  if (same) { console.log('ok  arch.assets.json:site matches the rule run against ' + pointer.desktop); process.exit(0); }
  console.error('STALE: the baked site no longer matches solveSite() on ' + pointer.desktop);
  console.error('       run: node scripts/measure_hero_site.mjs');
  process.exit(1);
}

writeFileSync(POINTER, JSON.stringify({ ...pointer, site: baked }, null, 2) + '\n');
console.log(`FDI ${baked.fdi} · seat ${baked.origin.join(', ')} · axis ${baked.axis.join(', ')}`);
console.log(`fixture ${DIAMETER_MM} x ${LENGTH_MM} mm · ${baked.bone_above_canal_mm} mm of bone above the canal`);
console.log(`clearance at the crest ${baked.clearance_at_crest_mm} mm · TIGHT at ${tightAt} mm · BREACH at ${breachAt} mm subcrestal`);
console.log(`${baked.canal_samples} canal samples · desktop vs mobile agree to ${baked.lod_agreement_mm} mm`);
console.log('baked into landing/assets/arch.assets.json');

/* Differential test: is the rebuilt bundle the same bundle?
 *
 * `web/viewer.js` is the ORACLE and stays untouched until this passes.
 * `viewer/dist/viewer.js` is the candidate. Same discipline `web-auth/README.md`
 * states for `auth.js`, and for the same reason: the built artifact is what ships, so
 * the built artifact is what has to be compared.
 *
 * ## Why the literal multiset is the right oracle
 *
 * `--minify-identifiers` renames identifiers by WHOLE-BUNDLE frequency, so changing one
 * app-level name reshuffles the short names across all 3.8 MB of vendor code. That
 * makes byte-prefix comparison useless and, worse, makes "my transcription is wrong"
 * and "I have the wrong @kitware/vtk.js patch" look identical.
 *
 * String and numeric LITERALS are not renamed. So the sorted multiset of literals is a
 * rename-invariant fingerprint of the entire dependency closure: if it matches, the
 * versions and the tree-shaking outcome are right, and if it does not, the diff NAMES
 * the offending module through its own error strings. That is the difference between a
 * failure you can act on and a failure you can only stare at.
 *
 * Run:  node viewer/check-bundle.mjs [--verbose]
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
// The ORACLE is the PRESERVED v5 copy, not `web/viewer.js`. Once the rebuilt
// bundle ships, `web/viewer.js` IS the candidate, and comparing it against
// itself would pass vacuously. See viewer/reference/README.md.
const SHIPPED = process.env.DENT_VIEWER_ORACLE
  || path.join(HERE, 'reference', 'viewer-v5-shipped.js');
const CANDIDATE = path.join(HERE, 'dist', 'viewer.js');
const VERBOSE = process.argv.includes('--verbose');

// The app-authored region of the SHIPPED artifact: after the last @cornerstonejs/tools
// statement, up to the licence block. Located by sentinel, never by a stored offset,
// so it survives a dependency bump.
const APP_SENTINEL = 'OX.toolName="VideoRedaction";';
const LICENCE = '/*! Bundled license information:';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
  return ok;
};

if (!existsSync(CANDIDATE)) {
  console.error(`no candidate at ${CANDIDATE} — run: npm --prefix viewer run build:candidate`);
  process.exit(2);
}
const ship = readFileSync(SHIPPED, 'utf8');
const cand = readFileSync(CANDIDATE, 'utf8');

console.log(`shipped   ${ship.length} bytes\ncandidate ${cand.length} bytes\n`);

/* ------------------------------------------------------------------ gate A: shape */
console.log('Gate A — shape and literal fingerprint');

check('the candidate is an IIFE bound to the same global',
      cand.startsWith('var DentistryViewer=(()=>{'),
      cand.slice(0, 32));

// The shipped file is 3,998,373 bytes. The candidate carries a new module (implants)
// so it will not match exactly; a WILD divergence means a wrong dependency set.
const drift = Math.abs(cand.length - ship.length);
check('the size is within 5% of the shipped artifact',
      drift < ship.length * 0.05,
      `${drift} bytes apart (${(100 * drift / ship.length).toFixed(2)}%)`);

/** Every string and template literal, with REGEX literals skipped.
 *
 *  Skipping regexes is not optional. A regex like `/[ "<>`]|.../` contains a double
 *  quote and a backtick, so a naive string scanner starts a "string" inside it and
 *  consumes arbitrary code until the next quote. That produced 140 phantom
 *  "missing literals" on the first run of this check -- all of them fragments of
 *  `xmlbuilder2`, whose modules were in fact present in both bundles. A test that
 *  reports a difference where there is none is worse than no test, because it trains
 *  you to ignore it.
 *
 *  Regex-vs-division is decided by the preceding non-space character: a `/` after one
 *  of `(,=:[!&|?{};+-*%~^` or at the start of input begins a regex. That is the standard
 *  heuristic and it is sufficient here -- both inputs are minifier output, so there is
 *  no formatting to confuse it.
 */
const literals = (src) => {
  const out = [];
  const REGEX_PRECEDERS = '(,=:[!&|?{};+-*%~^<>';
  let i = 0;
  let prev = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const start = i;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === c) { i++; break; }
        if (c !== '`' && src[i] === '\n') break;      // unterminated: bail out
        i++;
      }
      out.push(src.slice(start, i));
      prev = c;
      continue;
    }
    if (c === '/' && (prev === '' || REGEX_PRECEDERS.includes(prev))) {
      // A regex literal. Skip it whole, including its character classes.
      i++;
      let inClass = false;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) { i++; break; }
        else if (src[i] === '\n') break;
        i++;
      }
      while (i < src.length && /[a-z]/.test(src[i])) i++;   // flags
      prev = '/';
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {                  // block comment
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
};
/* Two scopes, and the distinction is the whole point.
 *
 * The APP REGION's literals are the strong check: they are the transcription's own
 * output, they are what a mistake in this file would change, and they are few enough to
 * compare exactly. Every one of them must appear in the candidate.
 *
 * WHOLE-BUNDLE literals are reported and not asserted. Two reasons, both learned here:
 * a hand-rolled scanner cannot tokenise 3.8 MB of minified vendor code perfectly (an
 * apostrophe inside a regex is enough to slip quote parity for a stretch), and
 * TEMPLATE literals are not rename-invariant at all -- their `${...}` interpolations
 * carry minified identifiers, so the same template differs between two builds by
 * construction. Asserting on that produced 243 "missing" literals that were all
 * present. A check that cries wolf is worse than no check.
 *
 * The direction also matters. Shipped-minus-candidate in VENDOR code means the
 * candidate pulls LESS, which cannot break behaviour the app uses; and every app-level
 * behaviour is independently pinned by Gate C.
 */
const APP_REGION = (() => {
  const i = ship.indexOf(APP_SENTINEL);
  const j = ship.indexOf(LICENCE);
  return i >= 0 && j > i ? ship.slice(i + APP_SENTINEL.length, j) : null;
})();
check('the app-authored region was located in the shipped artifact',
      !!APP_REGION, APP_REGION ? `${APP_REGION.length} bytes` : 'sentinel not found');

const bag = (xs) => {
  const m = new Map();
  xs.forEach((x) => m.set(x, (m.get(x) || 0) + 1));
  return m;
};
// Static parts only, so a template's interpolated identifiers cannot matter.
const staticParts = (lit) => (lit.startsWith('`')
  ? lit.slice(1, -1).split(/\$\{[^}]*\}/g).filter((t) => t.length > 2)
  : [lit]);

if (APP_REGION) {
  const appLits = new Set(literals(APP_REGION).flatMap(staticParts));
  const candAll = new Set(literals(cand).flatMap(staticParts));
  const lost = [...appLits].filter((k) => !candAll.has(k));
  check('EVERY literal of the app-authored region survived the transcription',
        lost.length === 0,
        lost.length
          ? `${lost.length} lost: ${lost.slice(0, 4).map((s) => s.slice(0, 44)).join(' | ')}`
          : `${appLits.size} app literals matched`);

  const appNums = new Set((APP_REGION.match(/(?<![\w$.])\d+(?:\.\d+)?(?:e-?\d+)?/g) || [])
    .filter((n) => n.length > 1));
  const candNums = new Set((cand.match(/(?<![\w$.])\d+(?:\.\d+)?(?:e-?\d+)?/g) || []));
  const lostNums = [...appNums].filter((n) => !candNums.has(n));
  check('every multi-digit constant of the app region survived',
        lostNums.length === 0,
        lostNums.length ? `lost ${lostNums.slice(0, 8).join(', ')}`
                        : `${appNums.size} constants matched`);
}

const sb = bag(literals(ship));
const cb = bag(literals(cand));
console.log(`  info  whole-bundle literals: shipped ${sb.size} distinct, `
  + `candidate ${cb.size} distinct (not asserted -- see the comment above)`);
if (VERBOSE) {
  const onlyCand = [...cb.keys()].filter((k) => !sb.has(k));
  console.log('        candidate-only:',
              onlyCand.slice(0, 30).map((s) => s.slice(0, 40)).join(' | '));
}

// Export tables: every `var X={};Ct(X,{...})` key set is the public surface of one
// bundled module. A missing table means a module was tree-shaken differently.
const tables = (s) => {
  const out = [];
  const re = /var (\w+)=\{\};\w+\((\w+),\{([^}]*)\}\)/g;
  let m;
  while ((m = re.exec(s))) {
    const keys = [...m[3].matchAll(/(\w+):\s*\(\)\s*=>/g)].map((k) => k[1]).sort();
    if (keys.length) out.push(keys.join(','));
  }
  return new Set(out);
};
const st = tables(ship);
const ct = tables(cand);
// The ENTRY module's own table legitimately differs -- the implant API adds names to
// it -- and Gate B compares that one properly. Excluding it here keeps this check about
// the dependency closure, which is what it is for.
const isEntry = (k) => k.includes('mount') && k.includes('unmount');
const missingTables = [...st].filter((k) => !ct.has(k) && !isEntry(k));
// Informational, for the same reason: a vendor namespace the app never touches can be
// tree-shaken differently without any behavioural consequence. Verified for the one
// case this actually reported -- `HistoryMemo` -- which the app region never mentions
// and which IS present in the candidate, just reachable by a different path.
check('at most a couple of vendor export tables differ',
      missingTables.length <= 2,
      missingTables.length
        ? `${missingTables.length} differ, e.g. ${missingTables[0].slice(0, 60)}`
        : `all ${st.size} export tables matched`);

// Things that must NOT be in the bundle. `dicom-parser` is a peer of the tools package
// but nothing here loads DICOM in the browser, and polyseg is what the stub excludes.
[['parseDicom', 'a DICOM parser'], ['dicomParser', 'a DICOM parser'],
 ['@icr/polyseg-wasm', 'the polySeg WASM addon'],
 ['sourceMappingURL', 'a sourcemap reference']].forEach(([needle, what]) => {
  check(`no ${what} in the bundle`, !cand.includes(needle), needle);
});

// Recovered esbuild flags, asserted rather than assumed.
check('--charset is at its default (ascii): non-ASCII is escaped',
      cand.includes('\\u2014') && !cand.includes('—'),
      'the em dash in the LUT error message is escaped, as in the shipped file');
check('--legal-comments=eof: the licence block is at the end',
      cand.lastIndexOf(LICENCE) > cand.length - 4000,
      `at ${cand.lastIndexOf(LICENCE)} of ${cand.length}`);

/* ------------------------------------------------------- gate B: the public API */
console.log('\nGate B — the public API surface');

const exportMap = (s) => {
  // The entry module's table is the one containing `mount`.
  const re = /\w+\((\w+),\{([^}]*mount:[^}]*)\}\)/g;
  let m;
  while ((m = re.exec(s))) {
    const keys = [...m[2].matchAll(/(\w+):\s*\(\)\s*=>/g)].map((k) => k[1]);
    if (keys.includes('mount')) return keys.sort();
  }
  return null;
};
const shipApi = exportMap(ship);
const candApi = exportMap(cand);
check('the shipped export map was located', !!shipApi, shipApi ? `${shipApi.length} names` : '');
check('the candidate export map was located', !!candApi, candApi ? `${candApi.length} names` : '');
if (shipApi && candApi) {
  const lost = shipApi.filter((k) => !candApi.includes(k));
  const added = candApi.filter((k) => !shipApi.includes(k));
  check('no exported name was lost', lost.length === 0, lost.join(', ') || 'none');
  // An EXACT match against the frozen v5 oracle, so this list never self-heals: edit it
  // ONCE per change, with the union of every new name. Two changes each adding their own
  // export and each editing this for themselves means whichever lands second re-breaks
  // the gate for a reason that has nothing to do with it.
  //   0.11.x  the implant API
  //   0.13.0  setSurfaceFocus -- the plan tab's 3-D narrowing, so a molar implant is
  //           not drawn behind two tooth roots and a jaw
  check('the added names are exactly the implant API and the plan-tab surface controls',
        added.slice().sort().join(',') === ['focusImplant', 'implantGeometryForTest',
          'removeImplant', 'setImplantArch', 'setImplantVerdict', 'setImplants',
          'setSurfaceFocus', 'setSurfaceOpacity', 'updateImplant'].join(','),
        added.join(', ') || 'none');
}

/* --------------------------------------------- gate C: recovered app-region facts */
console.log('\nGate C — behaviour that must survive the transcription');

const REQUIRED = [
  ['the loader scheme', '"dentistryLocal"'],
  ['the MPR tool group', '"dentistry-mpr"'],
  ['the 3D tool group', '"dentistry-3d"'],
  ['the 3D viewport id', '"dent-3d"'],
  ['the frame of reference', '"dentistry-local"'],
  ['the rendering engine id', '"dentistry-engine"'],
  ['the surface actor uid prefix', 'dent-surface-'],
  ['the DSVM mesh magic', '"DSVM"'],
  ['the API drift guard message', 'Cornerstone API moved'],
  ['the volume size guard', 'volume size mismatch'],
  ['the LUT read-back error', 'did not take effect'],
  ['the cache-miss loader message', 'is not in the Cornerstone cache'],
  ['the mesh-version guard', 'is newer than this viewer'],
  ['the url stub path in its own message', 'viewer/stubs/url.js'],
  ['the per-structure surface opacity table', 'upper_teeth_unnumbered'],
];
REQUIRED.forEach(([what, needle]) => {
  check(`${what} survived`, cand.includes(needle), JSON.stringify(needle));
});

// The transfer-function control points, which are the recovered ones and are not
// derivable from anything.
check('the 3D transfer function control points survived',
      /addPoint\(165,\.12\)/.test(cand) && /addRGBPoint\(180,\.78,\.7,\.6\)/.test(cand),
      '(165, 0.12) and (180, 0.78, 0.70, 0.60)');

// The ordering that fixed the render-loop starvation: the MPR render must appear as a
// comma expression inside the `if` test, not after the block.
check('renderViewports fires INSIDE the 3D `if` test',
      /renderViewports\((\w+)\),\s*\w+\)/.test(cand),
      'the comma expression that keeps the segmentation render loop alive');

console.log(`\n${failures ? `FAILURES: ${failures}` : 'ALL PASS'}`);
process.exit(failures ? 1 : 0);

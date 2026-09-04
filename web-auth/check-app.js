#!/usr/bin/env node
/**
 * Static wiring check for web/app.js.
 *
 * The app has no build step and no module system -- app.js is one script full of
 * top-level function declarations, wired to the DOM by name. Nothing catches a
 * function that is declared and never called, or called and never declared, until
 * a user clicks the thing. This does.
 *
 * Rebuilt 2026-09-01: the original web-auth/ was destroyed with the project tree and
 * was not listed in the recovery doc's own tables, so it went unnoticed. The rule it
 * enforced is restored here along with the list.
 *
 * Three assertions:
 *
 *   1. every name in REQUIRED is DECLARED in app.js;
 *   2. every name in REQUIRED is REFERENCED somewhere other than its own
 *      declaration -- a render function nothing calls is dead weight that still
 *      passes review;
 *   3. every `render*` function that exists is in REQUIRED. This is the rule the
 *      file states about itself and the one that had silently lapsed: six openCase
 *      render functions were missing from the list before the deletion.
 *
 * Plus: every id passed to $('...') must exist in index.html. That is the check that
 * would have caught the duplicate id="planHint" -- two elements, one name, and the
 * plan tab writing its hint into the billing panel.
 */
// ESM, because web-auth/package.json declares "type": "module" for the esbuild build.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'web/app.js'), 'utf8');
const html = readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
const css = readFileSync(path.join(ROOT, 'web/app.css'), 'utf8');
const implantsJs = readFileSync(path.join(ROOT, 'viewer/src/implants.js'), 'utf8');

const REQUIRED = [
  // --- case view: everything openCase() fans out to ------------------------
  'openCase', 'teardownCase', 'caseSubtitle',
  'renderStructures', 'renderFindings', 'renderDownloads', 'renderSeries',
  'renderRunDetails', 'renderArch', 'renderAccuracy',
  'accuracyById', 'accuracyCanal', 'diceCell',
  'toggleIsolate',
  // --- stages --------------------------------------------------------------
  'setMode', 'selectPlane', 'setLayout', 'set3dMode',
  'mountVolume', 'afterLayoutChange',
  // --- the implant-planning tab -------------------------------------------
  'planState', 'archUrl', 'xsUrl', 'panUrl', 'loadArch', 'selectJaw',
  'drawPanoramic', 'drawArcMarker', 'selectXs', 'wirePlan',
  'canvasPoint',
  // the measurement layer: exact on the cross-section, vertical-only on the panoramic
  'rulerState', 'xsFrame', 'xsPixelToTZ', 'xsPixelToLps', 'panPixelToLps',
  'rulerKey', 'rulerLabel', 'drawRulers', 'drawArcMarkerOn', 'wireRuler',
  'renderRulerList', 'jumpToArcColumn',
  // placement: the implant object, the drag, and the clearance bar
  'implantState', 'implantOutline', 'tzToPixel', 'hitTest', 'drawImplants',
  'addImplant', 'nearestXsIndex', 'wireImplants', 'requestMeasure',
  'budgetBar', 'setBarSpan', 'clearanceBlock', 'renderImplantPanel', 'renderPlanBar',
  'renderPlanPriors',
  'renderVerdictStrip', 'drawContourSlice', 'drawXsContours',
  'loadXsContours', 'planKeySet', 'alignToSite', 'siteAt', 'implantKey', 'stepSize', 'clampImplant',
  'pushUndo', 'popUndo', 'selectImplant', 'refreshPlanFocus', 'setXsFit', 'wireXsFit', 'xsCropRows', 'drawDistances', 'drawSectionFrame',
  'withScreenUnits', 'drawChip', 'approachVector', 'implantEnvelope', 'setXsOverlay', 'wireXsOverlay', 'rulerText', 'fillPrintSheet',
  'toggleSide', 'wireSide', 'clearanceRow', 'clearanceValueText', 'openingIndex',
  'verdictColour', 'siteLine', 'siteTitle', 'wireImplantAdd',
  'syncImplants3d', 'loadImplantCatalog', 'implantSizes', 'planListState', 'loadPlans',
  'savePlan', 'openPlan', 'deletePlan', 'downloadPlanArtifact', 'planPrintTable',
  'scanFactsBlock', 'renderModelPriors', 'syncPlanToIsolate', 'wirePlanPrint',
  // the plan canvases: one backing-store scale, one coordinate conversion
  'planCtx', 'planSize', 'panAspectX', 'siteText',
  // the 3-D pane is reparented between stages rather than duplicated
  'move3dPane',
  'structureName',
  // --- account, teams, billing --------------------------------------------
  'renderAccount', 'renderSettings', 'renderTeam', 'renderInvite',
  'renderUsageChip', 'renderUsageHistory', 'renderPlanPanel', 'renderJobs',
  'refreshAccount', 'loadTeam', 'loadMembers', 'refreshWorkspaces',
  'switchWorkspace', 'startCheckout', 'openPortal',
  // --- plumbing ------------------------------------------------------------
  'api', 'authed', 'cachedFetch', 'navigate', 'setNotice', 'boot',
  // Artifact pictures travel through the bearer-authenticated path. An <img> cannot
  // carry a token, and these three are what stops that being rediscovered.
  'loadAuthedImage', 'revokeImage', 'isDrawable', 'loadImage',
];

const declared = new Set(
  [...src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]));

let failures = 0;
const fail = (msg) => { console.log(`  FAIL  ${msg}`); failures += 1; };
const pass = (msg) => console.log(`  PASS  ${msg}`);

// 1 + 2 -------------------------------------------------------------------
const missing = REQUIRED.filter((n) => !declared.has(n));
if (missing.length) fail(`declared: ${missing.length} REQUIRED name(s) absent -> ${missing.join(', ')}`);
else pass(`all ${REQUIRED.length} REQUIRED functions are declared`);

const unwired = REQUIRED.filter((n) => {
  if (!declared.has(n)) return false;
  const uses = [...src.matchAll(new RegExp(`\\b${n}\\b`, 'g'))].length;
  return uses < 2;                    // the declaration itself is one
});
if (unwired.length) fail(`wired: declared but never referenced -> ${unwired.join(', ')}`);
else pass('every REQUIRED function is referenced somewhere besides its declaration');

// 3 -----------------------------------------------------------------------
const req = new Set(REQUIRED);
const strayRenders = [...declared].filter((n) => /^render[A-Z]/.test(n) && !req.has(n));
if (strayRenders.length) {
  fail(`coverage: render* function(s) not in REQUIRED -> ${strayRenders.join(', ')}\n`
     + '        (this file\'s own rule: every render* belongs in the list, so a new '
     + 'one cannot be added unwired)');
} else pass(`every render* function in app.js is in REQUIRED`);

// ids ---------------------------------------------------------------------
const htmlIds = [...html.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
const idCount = htmlIds.reduce((a, i) => (a[i] = (a[i] || 0) + 1, a), {});
const dupes = Object.entries(idCount).filter(([, n]) => n > 1).map(([i]) => i);
if (dupes.length) {
  fail(`index.html has duplicate id(s) -> ${dupes.join(', ')}\n`
     + '        getElementById returns the FIRST, so the second element is '
     + 'unreachable and the first gets written by two unrelated features');
} else pass(`index.html has no duplicate ids (${htmlIds.length} checked)`);

// app.js also injects markup through innerHTML and then looks those ids up, so the
// static page is not the whole universe of ids. Both sources count; anything in
// NEITHER is a lookup that returns null at runtime -- which is how the recovered
// index.html came to be six days behind app.js, with renderAccuracy dereferencing an
// #accuracyCard that no longer existed and taking every case-open down with it.
const injectedIds = [...src.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
const known = new Set([...htmlIds, ...injectedIds]);
const used = [...src.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]);
const unknown = [...new Set(used)].filter((i) => !known.has(i));
if (unknown.length) {
  fail(`$('id') resolving to nothing -> ${unknown.join(', ')}\n`
     + '        (not in index.html and not injected by app.js: this throws on first use)');
} else {
  pass(`all ${new Set(used).size} $('id') lookups resolve `
     + `(${htmlIds.length} static, ${new Set(injectedIds).size} injected)`);
}

// authenticated artifacts -------------------------------------------------
// The defect this exists for: every planning picture and every slice tile was loaded
// with `img.src = <api url>`, and an <img> cannot carry a bearer token. With
// DENT_REQUIRE_AUTH true that is a guaranteed 401, so the panoramic read "panoramic
// unavailable", the cross-section was blank, the Slices tab read "slice unavailable" --
// and NEITHER offline harness could see it, because both serve `web/` from a static
// file server with no auth layer. A grep is the only thing that catches this class
// without a live logged-in browser.
//
// Rule: an `<img>`/`new Image()` src may be a blob: URL or a data: URL. Anything built
// from `API` has to go through `loadAuthedImage`.
// Comment lines are dropped first. Not a general JS comment stripper -- that is the
// trap `viewer/check-bundle.mjs` documents at length -- just the line shapes prose
// takes in this file (`//`, `/*`, ` * `), which is where every false positive lives.
// This very file's own explanation of the defect contains the offending pattern.
const codeLines = src.split('\n')
  .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
const imgSrcAssignments = [...codeLines.matchAll(/\.src\s*=\s*([^;\n]+)/g)].map((m) => m[1].trim());
const badSrc = imgSrcAssignments.filter((expr) => !/^blobUrl\b|^['"]data:|^['"]blob:/.test(expr));
if (badSrc.length) {
  fail(`image src assigned something that is not a blob/data URL -> ${badSrc.join(' | ')}\n`
     + '        an <img> cannot carry the bearer token; route artifact pictures through '
     + 'loadAuthedImage()');
} else pass(`every image src is a blob or data URL (${imgSrcAssignments.length} assignment(s))`);

// `img.complete` is TRUE for a broken image, so it is never a sufficient guard before
// drawImage -- which throws InvalidStateError and, when it happened inside drawRulers,
// escaped through addImplant and left an implant in state that the panel never drew.
const completeGuards = [...codeLines.matchAll(/\w+\.complete\b/g)].length;
const drawablePresent = /function isDrawable\b/.test(src) && /naturalWidth\s*>\s*0/.test(src);
if (completeGuards && !drawablePresent) {
  fail('a `.complete` guard exists without isDrawable()/naturalWidth > 0\n'
     + '        `complete` is true for a BROKEN image; drawImage then throws');
} else pass('broken-image guard checks naturalWidth, not just .complete');

// verdict levels <-> CSS --------------------------------------------------
// `plan_safety` emits four levels and the client interpolates them straight into a
// class attribute. A level with no rule renders as unstyled text, which is how
// `p-no_verdict` printed indistinguishable from a graded cell.
const LEVELS = ['clear', 'tight', 'breach', 'no_verdict'];
const missingLevelRules = LEVELS.filter((l) => !css.includes(`.verdict.${l}`))
  .concat(LEVELS.filter((l) => !css.includes(`.p-${l}`)).map((l) => `p-${l}`));
if (missingLevelRules.length) {
  fail(`verdict level(s) with no CSS rule -> ${missingLevelRules.join(', ')}`);
} else pass(`all ${LEVELS.length} verdict levels have screen and print rules`);

// every class app.js emits has a rule ------------------------------------
// Not exhaustive by construction -- a class can be legitimately unstyled -- so this is
// a NAMED list of the ones whose whole job is to look different. `.hint bad` sat in
// this state for the entire life of the plan tab: read back on the live site, the error
// colour and the ordinary hint colour were the same rgb().
const MUST_STYLE = ['bad', 'warn', 'mono', 'cbar-rule', 'cbar-open', 'imp-off', 'pane-tag',
                    'side-head', 'btn-add', 'plan-side', 'plan-panes', 'pan-wrap',
                    'pane3d-wrap', 'ptable-dark'];
// The class must appear UNQUALIFIED at the head of a compound selector, i.e. a rule
// that reaches an element carrying only that class. A naive `\.bad` substring test is
// satisfied by `.dice.bad` and `.kv dd.bad` -- which is precisely the defect: every
// `.bad` in this stylesheet was qualified, so `<p class="hint bad">` got no colour at
// all and a measurement failure read as ordinary prose. Verified by deleting the bare
// rule and watching this fail.
const headOfCompound = (c) =>
  new RegExp(`(?:^|[\\s,{}>+~])\\.${c}(?=[\\s,{:]|$)`, 'm').test(css);
const unstyled = MUST_STYLE.filter((c) => !headOfCompound(c));
if (unstyled.length) fail(`class(es) emitted with no CSS rule -> ${unstyled.join(', ')}`);
else pass(`all ${MUST_STYLE.length} load-bearing classes have a rule`);

// no undefined custom properties -----------------------------------------
// `var(--x)` with no fallback on an undefined property is invalid at computed-value
// time, so the whole DECLARATION is dropped. `--text` and `--line` were referenced six
// times and defined nowhere, which is why the 2 px rule marking the required safety
// margin painted rgba(0,0,0,0) -- the single most important mark the product draws.
const defined = new Set([...css.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]));
const referenced = [...css.matchAll(/var\((--[\w-]+)\s*(\)|,)/g)]
  .filter((m) => m[2] === ')').map((m) => m[1]);
const undef = [...new Set(referenced)].filter((v) => !defined.has(v));
if (undef.length) {
  fail(`var() with no fallback on undefined propert(ies) -> ${undef.join(', ')}\n`
     + '        invalid at computed-value time: the declaration is DROPPED, not defaulted');
} else pass(`all ${new Set(referenced).size} unguarded var() references are defined`);

// the verdict palette, in two files ---------------------------------------
// `viewer/src/implants.js` holds VERDICT_RGB as three RGB triples and its own header
// says they are "shared verbatim so the section and the 3-D actor can never disagree".
// They are not shared -- they are duplicated, in a bundled module and an inline ternary
// chain in app.js, with nothing tying them together. `check-equivalence.mjs` compares
// the implant GEOMETRY, not its colour, so a divergence would show a breach as green in
// one view and red in the other. Compared here because this is the only checker that
// reads both files.
const rgbFromViewer = {};
const vBlock = implantsJs.slice(implantsJs.indexOf('VERDICT_RGB'));
for (const m of vBlock.slice(0, 400).matchAll(/(breach|tight|clear)\s*:\s*\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)) {
  rgbFromViewer[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
}
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const appHex = {};
for (const m of codeLines.matchAll(/level === '(breach|tight|clear)'\s*\?\s*'(#[0-9a-fA-F]{6})'/g)) {
  appHex[m[1]] = m[2];
}
const levels3 = ['breach', 'tight', 'clear'];
const paletteProblems = levels3.flatMap((l) => {
  if (!rgbFromViewer[l]) return [`${l}: not found in viewer/src/implants.js`];
  if (!appHex[l]) return [`${l}: not found in web/app.js`];
  const a = hexToRgb(appHex[l]);
  const b = rgbFromViewer[l];
  return a.join(',') === b.join(',') ? []
    : [`${l}: app.js ${appHex[l]} (${a.join(',')}) vs viewer ${b.join(',')}`];
});
if (paletteProblems.length) {
  fail(`the 2-D and 3-D verdict palettes disagree -> ${paletteProblems.join('; ')}`);
} else pass(`the verdict palette matches between app.js and viewer/src/implants.js `
          + `(${levels3.length} levels)`);

console.log(`\n${failures ? `FAILURES: ${failures}` : 'ALL PASS'}  `
          + `(${declared.size} functions declared, ${REQUIRED.length} required)`);
process.exit(failures ? 1 : 0);

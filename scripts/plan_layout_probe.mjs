/* Does the plan tab's layout hold up on a REAL case, at the window it was complained
 * about -- and is the corner box actually gone?
 *
 * `check-rail.mjs` measures the same things across 156 fixture states, which is the
 * right instrument for "does any width overflow". It cannot answer two others:
 *
 *   1. the fixture never mounts a volume, so the 3-D pane in the plan tab is an empty
 *      box there and the caption assertion has nothing real painted underneath it;
 *   2. the fixture's saved-plan list is short, and the corner box was caused by a
 *      saved-plan NAME -- "46 and 44 posterior right · 2026-09-03 03:17" -- being wider
 *      than the panel. The bug needs a real plan list to reproduce.
 *
 * So this drives the real case on the real GPU and reads the layout back out of the DOM.
 * The scrollbar is read as `offsetHeight - clientHeight`, never off a screenshot: a
 * horizontal bar and no horizontal bar are a 16 px difference in a 725 px panel, and
 * the corner square that started all this is 16x8.
 *
 *   ./scripts/tour_stack.sh node scripts/plan_layout_probe.mjs
 */
import { writeFileSync } from 'node:fs';

const PORT = Number(process.env.TOUR_PORT || 8807);
const DEBUG_PORT = Number(process.env.TOUR_DEBUG_PORT || 9333);
const CASE = process.env.TOUR_CASE || 'e9d0c06b-0e97-4c00-a43c-d9ea0ba8200e';
const DIR = process.env.PROBE_DIR || '/tmp/dentistry-tour';
// The user's own window, which is where the complaint came from. Not a workstation.
const W = Number(process.env.PROBE_W || 1470);
const H = Number(process.env.PROBE_H || 836);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdp(port) {
  const deadline = Date.now() + 60000;
  let info;
  for (;;) {
    try { info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; }
    catch { if (Date.now() > deadline) throw new Error('no DevTools'); await sleep(250); }
  }
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('cdp')); });
  let id = 0; const waiting = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) {
      const { ok, no } = waiting.get(msg.id); waiting.delete(msg.id);
      msg.error ? no(new Error(JSON.stringify(msg.error))) : ok(msg.result);
    }
  };
  return (m, p = {}, s) => new Promise((ok, no) => {
    id += 1; waiting.set(id, { ok, no });
    ws.send(JSON.stringify({ id, method: m, params: p, ...(s ? { sessionId: s } : {}) }));
  });
}

const AUTH_STUB = `
const __u = { sub: 'probe', name: 'Demo', email: 'demo@example.invalid' };
Object.defineProperty(window, 'DentistryAuth', { configurable: true,
  get: () => ({ init: async () => __u, isSignedIn: () => true, profile: () => __u,
                signIn: () => {}, signOut: () => {}, token: () => 'probe' }),
  set: () => {} });
`;

const send = await cdp(DEBUG_PORT);
const t = await send('Target.getTargets');
const page = t.targetInfos.find((x) => x.type === 'page');
const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
const ev = (m, p = {}) => send(m, p, sessionId);

await ev('Page.enable'); await ev('Runtime.enable');
await ev('Page.addScriptToEvaluateOnNewDocument', { source: AUTH_STUB });
await ev('Emulation.setDeviceMetricsOverride',
         { width: W, height: H, deviceScaleFactor: 1, mobile: false });

const js = async (e) => {
  const r = await ev('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    const x = r.exceptionDetails.exception || {};
    return { __error: x.description || x.value || r.exceptionDetails.text };
  }
  return r.result.value;
};
const shot = async (name) => {
  const s = await ev('Page.captureScreenshot', { format: 'png' });
  const f = `${DIR}/${name}.png`;
  writeFileSync(f, Buffer.from(s.data, 'base64'));
  return f;
};

let failures = 0;
const check = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures += 1; };

await ev('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?probe=1#/case/${CASE}` });
console.log(`mounting the real case at ${W}x${H}…`);
await sleep(30000);

await js(`setMode('plan')`);
await sleep(2500);
// An implant, because an empty plan tab exercises none of the panel this is about.
await js(`(() => {
  const info = ((state.viewer.plan.arch || {}).jaws || {}).mandible;
  const st = ((info && info.sites) || {})['36'] || ((info && info.sites) || {})['46'];
  if (st && st.s_mm != null) addImplant(st.s_mm, 36);
})()`);
await sleep(3000);

const R = `((s) => { const e = document.querySelector(s); if (!e) return null;
  const r = e.getBoundingClientRect();
  return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })`;

const m = await js(`(() => {
  const R = ${R};
  const ps = document.getElementById('planSide');
  const bar = document.getElementById('siteBar');
  return {
    mounted: !!(state.viewer && state.viewer.mprMounted),
    mode: state.viewer && state.viewer.mode,
    railShown: !!document.querySelector('.rail') && getComputedStyle(document.querySelector('.rail')).display !== 'none',
    railEmpty: document.getElementById('workspace').classList.contains('rail-empty'),
    siteBar: R('#siteBar'), pan: R('.pan-wrap'), chart: R('.chart-card'), planBar: R('#planBar'),
    xs: R('.xs-wrap'), p3d: R('#plan3d'), side: R('#planSide'),
    chartIn: (() => { const c = document.querySelector('.chart-card');
      return !c ? 'absent' : c.closest('#siteBar') ? 'siteBar' : c.closest('.rail') ? 'rail' : 'lost'; })(),
    bars: { h: ps.offsetHeight - ps.clientHeight, w: ps.offsetWidth - ps.clientWidth },
    sideScroll: { cw: ps.clientWidth, sw: ps.scrollWidth },
    // The band the complaint was about: how much of the site bar is actually occupied.
    barFill: (() => {
      if (!bar) return null;
      const kids = [...bar.children].filter((e) => e.getBoundingClientRect().width > 0);
      const used = kids.reduce((a, e) => a + e.getBoundingClientRect().width, 0);
      return { used: Math.round(used), total: Math.round(bar.getBoundingClientRect().width),
               cells: kids.length };
    })(),
    tag3d: (() => {
      const t = document.querySelector('#plan3d > .pane-tag');
      if (!t) return 'absent';
      const pane = document.querySelector('#plan3d > .pane-3d.in-plan');
      if (!pane) return 'nopane';
      const z = (el) => { const v = parseInt(getComputedStyle(el).zIndex, 10); return Number.isNaN(v) ? 0 : v; };
      return z(t) > z(pane) ? 'above' : 'covered';
    })(),
    paneNote: (() => { const n = document.querySelector('#plan3d .pane-note');
      return !n ? 'absent' : getComputedStyle(n).display === 'none' ? 'hidden' : 'VISIBLE'; })(),
    arcHint: (document.getElementById('planArcHint') || {}).textContent || '',
    body: { sw: document.body.scrollWidth, iw: window.innerWidth },
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
  };
})()`);
console.log(JSON.stringify(m, null, 1));

check(m.mounted === true, 'the volume mounted (without this every assertion below is vacuous)');
check(m.mode === 'plan', 'the plan tab is open');

// THE CORNER BOX.
check(m.bars && m.bars.h === 0,
      `no horizontal scrollbar on the measurements panel — ${m.bars && m.bars.h} px of bar`);
check(m.bars && m.bars.w <= 8,
      `the vertical scrollbar is this app's 8 px — got ${m.bars && m.bars.w}`);
check(m.sideScroll && m.sideScroll.sw <= m.sideScroll.cw + 1,
      `the panel's content fits its width — ${m.sideScroll && m.sideScroll.sw}`
      + ` in ${m.sideScroll && m.sideScroll.cw}`);
check(m.colorScheme === 'dark', `the document declares a dark color-scheme — got "${m.colorScheme}"`);

// THE SPACE.
check(m.chartIn === 'siteBar', `the dental chart is in the site bar — got "${m.chartIn}"`);
check(m.railEmpty === true && m.railShown === false,
      'the rail is gone on an uncorrected case, not a 300 px column holding nothing');
if (m.barFill) {
  const pct = Math.round(100 * m.barFill.used / m.barFill.total);
  check(m.barFill.cells === 3 && pct >= 90,
        `the site bar is occupied — ${m.barFill.cells} cells filling ${pct}% of ${m.barFill.total} px`);
}
if (m.xs && m.p3d) {
  check(m.xs[2] >= 520 && m.p3d[2] >= 520,
        `the two working panes got the rail's width — section ${m.xs[2]} px, 3-D ${m.p3d[2]} px`
        + ' (395 each before)');
}

// THE COPY AND THE CAPTIONS.
check(m.tag3d === 'above', `the 3-D pane's caption paints above the pane — got "${m.tag3d}"`);
check(m.paneNote === 'hidden' || m.paneNote === 'absent',
      `the mesh build statistic is not in the planning pane — got "${m.paneNote}"`);
check(!/cross-section/.test(m.arcHint),
      `the arc hint no longer repeats the section count — "${m.arcHint}"`);
check(m.body.sw <= m.body.iw + 1, `the page does not scroll sideways — ${m.body.sw} vs ${m.body.iw}`);

console.log('frame:', await shot('plan-layout'));

/* PAPER. The screen layout sizes the chart's SVG from a definite grid row and derives its
 * width; the print block turns `.site-bar` into a block, so that row stops existing and
 * `height: 100%` resolves against `auto`. A zero-height chart on the printed plan is
 * exactly the kind of silent loss the print sheet exists to prevent, and it is invisible
 * from the screen. Emulated rather than reasoned about. */
await ev('Emulation.setEmulatedMedia', { media: 'print' });
await sleep(900);
const pr = await js(`(() => {
  const R = ${R};
  const vis = (s) => { const e = document.querySelector(s); if (!e) return null;
    const c = getComputedStyle(e); return { disp: c.display, r: R(s) }; };
  return {
    chart: vis('.site-bar > .chart-card'),
    svg: R('.site-bar > .chart-card .arch svg'),
    rail: vis('.rail'),
    railCards: [...document.querySelectorAll('.rail > .card, .rail > details.card')]
      .filter((e) => getComputedStyle(e).display !== 'none').length,
    sheet: vis('#planPrintSheet'),
    planbar: vis('#planBar'),
  };
})()`);
console.log('print:', JSON.stringify(pr));
check(!!(pr.svg && pr.svg[3] > 20), `the dental chart prints with height — ${pr.svg && pr.svg[3]} px`);
check(!!(pr.rail && pr.rail.disp !== 'none'),
      `the rail comes back on paper — display "${pr.rail && pr.rail.disp}"`);
check(pr.railCards >= 4, `the rail's cards print — ${pr.railCards} visible`);
check(!!(pr.sheet && pr.sheet.disp === 'block'), 'the measurement sheet prints');
check(!!(pr.planbar && pr.planbar.disp === 'none'), 'the plan controls do not print');
await ev('Emulation.setEmulatedMedia', { media: '' });

console.log(failures ? `\nFAILURES: ${failures}` : '\nALL PASS');
process.exit(failures ? 1 : 0);

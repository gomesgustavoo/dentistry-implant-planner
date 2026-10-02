#!/usr/bin/env node
/**
 * Characterization tests for web/app.js: a golden master of what the app SAYS, the
 * requests it MAKES, and what its pure helpers RETURN -- recorded from the code as it
 * is, so a refactor that changes any of them announces itself.
 *
 * Why this exists beside check-rail.mjs. check-rail asserts properties (no NaN, no
 * overflow, the right counts); it cannot tell you that a refactor moved a sentence, lost
 * a button or started fetching /me twice. app.js is 8 000 lines with no unit tests, and
 * it is about to be split into files and restyled. This is the vice it is clamped in.
 *
 * What is captured, and deliberately what is NOT:
 *   * the semantic DOM of each panel: visible text, ids, roles, aria-*, data-*, titles,
 *     hrefs, form values. NOT class names, inline styles or computed layout -- the visual
 *     pass will change all of those on purpose, and a snapshot that pinned them would
 *     have to be re-recorded wholesale, which is the same as having no snapshot.
 *   * the ordered list of requests per state (method + path), against stubbed fixtures.
 *   * a table of pure-helper calls and their results (HTML results reduced to text).
 *
 * Usage:
 *   node web-auth/golden.mjs            compare against web-auth/golden/*.json
 *   node web-auth/golden.mjs --update   re-record (review the diff like code)
 *   node web-auth/golden.mjs --prove    every comparison is shown to FAIL when broken
 *
 * Zero dependencies, like check-rail: Chrome over the DevTools protocol on Node's own
 * WebSocket. Time is frozen and the zone is UTC, so the master is reproducible.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const WEB = path.join(ROOT, 'web');
const FIX = path.join(HERE, 'fixtures');
const ASSETS = path.join(FIX, 'assets');
const GOLD = path.join(HERE, 'golden');
const UPDATE = process.argv.includes('--update');
const PROVE = process.argv.includes('--prove');
const NOW = '2026-10-01T12:00:00Z';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
// API replies. Tracked, unlike assets/: none of them carries imagery. models/examples/
// system/structures were captured from the real API; session.json is synthetic.
const APIFIX = path.join(FIX, 'api');
const API = {
  models: readJson(path.join(APIFIX, 'models.json')),
  examples: readJson(path.join(APIFIX, 'examples.json')),
  system: readJson(path.join(APIFIX, 'system.json')),
  structures: readJson(path.join(APIFIX, 'structures.json')),
  ...readJson(path.join(APIFIX, 'session.json')),
};
const ARCH = readJson(path.join(ASSETS, 'arch-mandible.json'));
const MEASURE = readJson(path.join(ASSETS, 'measure-mandible.json'));

// The auth bundle is replaced by a stub whose answer the state chooses, so the boot
// path can be driven signed in and signed out without a Keycloak.
const AUTH_STUB = `window.DentistryAuth = {
  init: async () => (window.__GOLDEN.signedIn ? { profile: { sub: 'u' } } : null),
  isSignedIn: () => !!window.__GOLDEN.signedIn,
  profile: () => (window.__GOLDEN.signedIn ? { sub: 'u', email: 'reader@example.org', username: 'reader' } : null),
  token: async () => 't',
  signIn: (to) => { window.__GOLDEN.signInCalls.push(String(to)); },
  signOut: () => { window.__GOLDEN.signOutCalls += 1; },
};`;

// ------------------------------------------------------------------ plumbing
function serve(dir) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                  '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png',
                  '.msh': 'application/octet-stream' };
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/auth.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' }).end(AUTH_STUB); return;
    }
    const p = rel.startsWith('/__fixtures/') ? path.join(ASSETS, rel.slice('/__fixtures/'.length))
      : path.join(dir, rel === '/' ? '/index.html' : rel);
    if (!existsSync(p) || ![dir, ASSETS].some((r) => p.startsWith(r))) {
      res.writeHead(404).end('no'); return;
    }
    res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
    res.end(readFileSync(p));
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, port: srv.address().port })));
}

async function cdp(debugPort) {
  const deadline = Date.now() + 45000;
  let info;
  for (;;) {
    try { info = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(); break; }
    catch { if (Date.now() > deadline) throw new Error('no DevTools port'); await new Promise((r) => setTimeout(r, 200)); }
  }
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('cdp connect failed')); });
  let id = 0; const waiting = new Map(); const events = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) {
      const { ok, no } = waiting.get(msg.id); waiting.delete(msg.id);
      msg.error ? no(new Error(JSON.stringify(msg.error))) : ok(msg.result);
    } else if (msg.method && events.has(msg.method)) {
      events.get(msg.method).forEach((f) => f(msg.params)); events.delete(msg.method);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((ok, no) => {
    id += 1; waiting.set(id, { ok, no });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const once = (method) => new Promise((ok) => {
    if (!events.has(method)) events.set(method, []);
    events.get(method).push(ok);
  });
  return { send, once, close: () => ws.close() };
}

// ------------------------------------------------- what runs before app.js
// Installed with addScriptToEvaluateOnNewDocument, so app.js finds a frozen clock and a
// recording fetch exactly as it would find the real ones. (No backticks inside: this is
// stringified.)
const PRELUDE = (cfg) => `(() => {
  const CFG = ${JSON.stringify(cfg)};
  window.__GOLDEN = { signedIn: CFG.signedIn, net: [], errors: [], signInCalls: [], signOutCalls: 0 };
  if (CFG.noBoot) window.DENTISTRY_NO_BOOT = true;
  // Accounts on unless the state says otherwise: the hosted deployment's configuration.
  if (!CFG.anonymous) window.DENTISTRY_CONFIG = { oidc: { authority: 'https://idp.invalid/realms/x',
    client_id: 'x' }, edgeBodyLimitMB: 100 };
  window.addEventListener('error', (e) => window.__GOLDEN.errors.push('error: ' + (e.message || e.type)));
  window.addEventListener('unhandledrejection',
    (e) => window.__GOLDEN.errors.push('rejection: ' + String((e.reason && e.reason.message) || e.reason)));
  const FIXED = Date.parse(CFG.now);
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); }
    static now() { return FIXED; }
  }
  window.Date = FrozenDate;
  const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200,
    headers: { 'content-type': 'application/json' } });
  const REAL_FETCH = window.fetch.bind(window);
  const A = CFG.api;
  window.fetch = async (input, init) => {
    const u = new URL(String(input && input.url || input), location.href);
    const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    const p = u.pathname.replace(/^.*?\\/v1\\//, '/v1/') + u.search;
    window.__GOLDEN.net.push(method + ' ' + p);
    if (p.includes('planning/arch.json')) return json(CFG.arch);
    if (p.includes('/measure')) return json(CFG.measure);
    if (p.includes('contours.json')) return REAL_FETCH('/__fixtures/contours-mandible.json');
    if (p.includes('planning/xs/')) return REAL_FETCH('/__fixtures/xs-mandible.jpg');
    if (p.includes('planning/pan/')) return REAL_FETCH('/__fixtures/pan-mandible.jpg');
    if (p.startsWith('/v1/structures')) return json(CFG.report ? { groups: CFG.report.structures || [] } : A.structures);
    if (p.startsWith('/v1/models')) return json(A.models);
    if (p.startsWith('/v1/examples')) return json(A.examples);
    if (p.startsWith('/v1/system')) return json(A.system);
    if (p.startsWith('/v1/me/usage')) return json(A.usage);
    if (p.startsWith('/v1/me')) return json(A.me);
    if (p.startsWith('/v1/tenants/current/members')) return json(A.members);
    if (p.startsWith('/v1/tenants')) return json(A.tenants);
    if (p.startsWith('/v1/plans')) return json(A.plans);
    if (p.startsWith('/v1/pair/devices')) return json(A.devices);
    if (p.startsWith('/v1/jobs?')) return json(A.jobs);
    if (p.startsWith('/v1/jobs/fixture/plans')) return json({ plans: [] });
    if (p.startsWith('/v1/jobs/fixture')) return json(CFG.job || {});
    return json({});
  };
})();`;

// ------------------------------------------------------- the in-page snapshot
// Reduces a subtree to lines that survive a restyle. (No backticks inside.)
const SNAP = `(() => {
  const KEEP_TAG = new Set(['A','BUTTON','INPUT','SELECT','OPTION','TEXTAREA','LABEL','H1','H2','H3',
    'H4','H5','H6','DETAILS','SUMMARY','TABLE','TH','TD','LI','DIALOG','IMG','text','FORM','KBD']);
  const SKIP = new Set(['SCRIPT','STYLE','TEMPLATE','CANVAS','NOSCRIPT','path','rect','circle','line','polyline','polygon','g','defs']);
  const norm = (s) => String(s).replace(/blob:[^\\s"']+/g, 'blob:*').replace(/\\s+/g, ' ').trim();
  const attrs = (el) => {
    const out = [];
    for (const a of [...el.attributes]) {
      const n = a.name;
      if (n === 'id' || n === 'role' || n === 'title' || n === 'href' || n === 'type' || n === 'alt'
          || n === 'name' || n === 'placeholder' || n === 'for' || n === 'disabled' || n === 'open'
          || n === 'checked' || n === 'download' || n.startsWith('aria-') || n.startsWith('data-')) {
        out.push(n + '=' + norm(a.value));
      }
    }
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
      if (el.type !== 'file') out.push('value=' + norm(el.value));
    }
    return out.sort();
  };
  const lines = [];
  const walk = (el) => {
    if (el.nodeType !== 1 || SKIP.has(el.tagName) || el.hasAttribute('hidden')) return;
    const own = norm([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' '));
    const at = attrs(el);
    if (own || at.length || KEEP_TAG.has(el.tagName)) {
      lines.push((KEEP_TAG.has(el.tagName) ? el.tagName.toLowerCase() : '*')
        + (at.length ? '[' + at.join(' ') + ']' : '') + (own ? ' ' + own : ''));
    }
    for (const c of el.children) walk(c);
  };
  return (sel) => {
    const root = document.querySelector(sel);
    if (!root) return ['<missing ' + sel + '>'];
    lines.length = 0; walk(root); return lines.slice();
  };
})()`;

// --------------------------------------------------------------- the states
const sleep = (ms) => `new Promise((r) => setTimeout(r, ${ms}))`;

const STATES = [];

// The cold load, signed out: what a stranger arriving from the landing page gets.
STATES.push({
  name: 'boot-signed-out',
  cfg: { signedIn: false, noBoot: false },
  hash: '',
  body: `await ${sleep(800)};`,
  snap: ['.topbar', '#views'],
});
// The cold load of a self-hosted deployment: no provider configured, no accounts.
STATES.push({
  name: 'boot-anonymous',
  cfg: { signedIn: false, noBoot: false, anonymous: true },
  hash: '#/cases',
  body: `await ${sleep(1500)}; clearInterval(state.poll);`,
  snap: ['.topbar', '#home'],
});
// The cold load, signed in, landing on the catalogue.
STATES.push({
  name: 'boot-cases',
  cfg: { signedIn: true, noBoot: false },
  hash: '#/cases',
  body: `await ${sleep(1500)}; clearInterval(state.poll);`,
  snap: ['.topbar', '#home'],
});
STATES.push({
  name: 'settings',
  cfg: { signedIn: true, noBoot: false },
  hash: '#/settings',
  body: `await ${sleep(1500)}; clearInterval(state.poll);`,
  snap: ['#settings'],
});
STATES.push({
  name: 'contact',
  cfg: { signedIn: true, noBoot: false },
  hash: '#/contact',
  body: `await ${sleep(1200)}; clearInterval(state.poll);`,
  snap: ['#contact'],
});

// One state per fixture report: the real openCase(), the plan tab when the job has one,
// and two implants placed, exactly as check-rail drives it.
for (const f of readdirSync(FIX).filter((x) => x.endsWith('.json')).sort()) {
  const report = readJson(path.join(FIX, f));
  const name = 'case-' + f.replace(/^report-/, '').replace(/\.json$/, '');
  const job = { id: 'fixture', state: 'done', results_expired: false, title: 'Fixture case',
                filename: 'fixture.nii.gz', created_at: '2026-08-29T19:05:00Z', reports: report };
  STATES.push({
    name,
    cfg: { signedIn: true, noBoot: true, report, job },
    hash: '',
    body: `
      state.catalog = { groups: (${JSON.stringify(report.structures || [])}) };
      try { await openCase('fixture'); } catch (e) { window.__GOLDEN.errors.push('openCase: ' + (e && e.message || e)); }
      for (const id of ['home', 'settings', 'contact', 'nav']) { const e = document.getElementById(id); if (e) e.hidden = true; }
      for (const id of ['workspace', 'casebar']) { const e = document.getElementById(id); if (e) e.hidden = false; }
      const planTab = document.getElementById('planTab');
      if (planTab && !planTab.hidden) {
        setMode('plan'); await ${sleep(320)};
        const info = ((state.viewer.plan.arch || {}).jaws || {}).mandible;
        const sites = (info && info.sites) || {};
        for (const fdi of ['46', '45']) {
          const st = sites[fdi];
          if (st && st.s_mm != null) addImplant(st.s_mm, Number(fdi));
        }
        await ${sleep(400)};
      }
      await ${sleep(200)};`,
    snap: ['#casebar', '.rail', '.dock', '#planStage'],
  });
}

// Pure helpers, called with a table of inputs. The outputs are whatever the code
// returned when this was recorded -- characterization, not specification.
const UNITS = `(() => {
  const strip = (s) => typeof s === 'string' && s.includes('<')
    ? s.replace(/<[^>]*>/g, ' ').replace(/\\s+/g, ' ').trim() : s;
  const call = (fn, args) => {
    try {
      const v = fn(...args);
      return v === undefined ? 'undefined' : JSON.parse(JSON.stringify(strip(v)));
    } catch (e) { return 'throws: ' + (e && e.message || e); }
  };
  state.catalog = window.__STRUCTURES;
  const T = {
    fmtBytes: [[0], [1.5e6], [2.3e9]],
    fmtSecs: [[null], [12.4], [89.6], [90], [600]],
    fmtDate: [['2026-09-30T10:00:00Z'], ['not a date']],
    fmtAgo: [['2026-10-01T11:59:30Z'], ['2026-10-01T10:00:00Z'], ['2026-09-28T12:00:00Z']],
    fmtWhen: [['2026-09-30T10:00:00Z'], ['nope']],
    esc: [['<a href="x">&\\'</a>'], [null], [5]],
    clearanceValueText: [[null], [{ numbers: { clearance_mm: 1.234 } }], [{ numbers: { distance_mm: 3 } }],
      [{ numbers: { at_least_mm: 9.71 } }], [{ numbers: {} }]],
    verdictColour: [[null], [{ level: 'breach' }], [{ level: 'tight' }], [{ level: 'clear' }],
      [{ level: 'no_verdict' }], [{ level: 'clear' }, true]],
    caseSubtitle: [[{ job: { attribution: 'X' }, report: { input: { size_xyz: [1, 2, 3], spacing_xyz: [0.3, 0.3, 0.25] } } }],
      [{ job: {}, report: {} }]],
    structureName: [['mandible'], ['canal'], ['nope']],
    siteLine: [[{ sites: { '36': { height_mm: 11.9, width_mm: 6.7, basis_height: 'b', basis_width: 'w' } } }, { site_fdi: 36 }],
      [{ sites: { '36': { reason: 'no crest' } } }, { site_fdi: 36 }], [{ sites: {} }, { site_fdi: null }]],
  };
  const out = {};
  for (const [name, rows] of Object.entries(T)) {
    // eslint-disable-next-line no-eval
    const fn = (0, eval)(name);
    out[name] = rows.map((args) => ({ args, result: call(fn, args) }));
  }
  const route = {};
  for (const h of ['', '#/cases', '#/settings', '#/contact', '#/case/abc', '#/case', '#/invite/t-1_x',
                   '#/invite/a/b', '#/nope', '#settings']) {
    history.replaceState({}, '', location.pathname + h);
    route[h || '(none)'] = call(parseRoute, []);
  }
  out.parseRoute = route;
  const plan = {};
  for (const q of ['', '?plan=clinician', '?plan=enterprise', '?plan=bogus', '?plan=clinician&x=1']) {
    history.replaceState({}, '', location.pathname + q);
    const got = call(pendingPlanFromUrl, []);
    plan[q || '(none)'] = { result: got, left: location.search };
  }
  history.replaceState({}, '', location.pathname);
  out.pendingPlanFromUrl = plan;
  MODEL_MENU = window.__MODELS; modelChoice = {};
  out.uploadConfig_default = call(uploadConfig, []);
  out.modelMode = (MODEL_MENU.models || []).map((m) => [m.key, call(modelMode, [m])]);
  modelChoice = { canal: 'off' };
  out.uploadConfig_changed = call(uploadConfig, []);
  modelChoice = {};
  return out;
})()`;

// ------------------------------------------------------------------- runner
async function withBrowser(fn) {
  const { srv, port } = await serve(WEB);
  const profile = mkdtempSync(path.join(tmpdir(), 'golden-'));
  const dbg = 9100 + Math.floor(Math.random() * 300);
  const chrome = spawn('google-chrome', [
    '--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--lang=en-US',
    '--disable-dev-shm-usage', '--no-sandbox', 'about:blank',
  ], { stdio: 'ignore', env: { ...process.env, TZ: 'UTC', LANG: 'en_US.UTF-8' } });
  try {
    const c = await cdp(dbg);
    return await fn(c, port);
  } finally {
    chrome.kill('SIGKILL'); srv.close();
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

async function page(c, port, cfg, hash, expression) {
  const { targetId } = await c.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    await c.send('Page.enable', {}, sessionId);
    await c.send('Runtime.enable', {}, sessionId);
    await c.send('Emulation.setDeviceMetricsOverride',
      { width: 1470, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await c.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' }, sessionId);
    await c.send('Page.addScriptToEvaluateOnNewDocument', {
      source: PRELUDE({ now: NOW, api: API, arch: ARCH, measure: MEASURE, ...cfg }) }, sessionId);
    const loaded = c.once('Page.loadEventFired');
    await c.send('Page.navigate', { url: `http://127.0.0.1:${port}/index.html${hash}` }, sessionId);
    await loaded;
    const { result, exceptionDetails } = await c.send('Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (exceptionDetails) {
      const ex = exceptionDetails.exception || {};
      throw new Error(ex.description || ex.value || exceptionDetails.text);
    }
    return result.value;
  } finally {
    await c.send('Target.closeTarget', { targetId });
  }
}

async function record(breakage) {
  return withBrowser(async (c, port) => {
    const got = {};
    for (const s of STATES) {
      const cfg = breakage && breakage.cfg ? breakage.cfg(s.name, structuredClone(s.cfg)) : s.cfg;
      const expr = `(async () => {
        ${breakage && breakage.inPage ? breakage.inPage(s.name) : ''}
        ${s.body}
        const snap = ${SNAP};
        const out = {};
        for (const sel of ${JSON.stringify(s.snap)}) out[sel] = snap(sel);
        return { snapshot: out, net: window.__GOLDEN.net.slice(), errors: window.__GOLDEN.errors.slice(),
                 signIn: window.__GOLDEN.signInCalls.slice() };
      })()`;
      got[s.name] = await page(c, port, cfg, s.hash, expr);
    }
    got.units = await page(c, port, { signedIn: true, noBoot: true }, '', `(async () => {
      window.__STRUCTURES = ${JSON.stringify(API.structures)};
      window.__MODELS = ${JSON.stringify(API.models)};
      ${breakage && breakage.inPage ? breakage.inPage('units') : ''}
      return ${UNITS};
    })()`);
    return got;
  });
}

function diff(name, want, got) {
  const a = JSON.stringify(want, null, 1).split('\n');
  const b = JSON.stringify(got, null, 1).split('\n');
  if (a.join('\n') === b.join('\n')) return null;
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return `${name}: first difference at line ${i + 1}\n    want: ${(a[i] || '<end>').trim()}\n    got:  ${(b[i] || '<end>').trim()}`;
}

function compare(got) {
  const problems = [];
  for (const [name, value] of Object.entries(got)) {
    const f = path.join(GOLD, `${name}.json`);
    if (!existsSync(f)) { problems.push(`${name}: no golden file (run --update)`); continue; }
    const d = diff(name, readJson(f), value);
    if (d) problems.push(d);
  }
  return problems;
}

async function main() {
  if (UPDATE) {
    const got = await record();
    mkdirSync(GOLD, { recursive: true });
    for (const [name, value] of Object.entries(got)) {
      writeFileSync(path.join(GOLD, `${name}.json`), JSON.stringify(value, null, 1) + '\n');
    }
    const errs = Object.entries(got).filter(([, v]) => v.errors && v.errors.length);
    for (const [n, v] of errs) console.log(`  note  ${n} recorded page errors: ${v.errors.join(' | ')}`);
    console.log(`recorded ${Object.keys(got).length} golden files in ${path.relative(ROOT, GOLD)}/`);
    return;
  }
  if (PROVE) {
    // Each break must make compare() fail, or the comparison it targets is vacuous.
    const BREAKS = {
      'a sentence in a panel changes': { cfg: (n, cfg) => {
        if (cfg.job) cfg.job.title = 'Renamed fixture'; return cfg; } },
      'the catalogue loses a button': { inPage: (n) => n === 'boot-cases'
        ? "setTimeout(() => { const b = document.querySelector('#jobFilter button'); if (b) b.remove(); }, 1200);" : '' },
      'an extra request is made': { inPage: (n) => n === 'settings' ? "fetch('/v1/me');" : '' },
      'a helper returns something else': { inPage: (n) => n === 'units'
        ? 'window.__STRUCTURES = { groups: [] };' : '' },
      'sign-in is asked to return somewhere else': { cfg: (n, cfg) => {
        if (n === 'boot-signed-out') cfg.signedIn = false; return cfg; },
        inPage: (n) => n === 'boot-signed-out'
          ? "window.__GOLDEN.signInCalls.push('/elsewhere');" : '' },
    };
    let bad = 0;
    for (const [label, br] of Object.entries(BREAKS)) {
      const problems = compare(await record(br));
      if (problems.length) console.log(`  PROVEN  ${label} -> ${problems.length} difference(s)`);
      else { console.log(`  VACUOUS ${label}: no difference detected`); bad += 1; }
    }
    if (bad) { console.log(`\n${bad} vacuous comparison(s)`); process.exit(1); }
    console.log('\nALL PROVEN'); return;
  }
  const problems = compare(await record());
  if (problems.length) {
    for (const p of problems) console.log('  FAIL  ' + p);
    console.log(`\n${problems.length} golden file(s) differ. If the change is intended, re-record with --update and review the diff.`);
    process.exit(1);
  }
  console.log(`ALL MATCH  (${STATES.length} states + units)`);
}

main().catch((e) => { console.error(e); process.exit(2); });

/* Drive the real landing page in real Chrome, on the real GPU, and measure the hero.
 *
 * `scripts/check_hero.mjs` proves the GEOMETRY in Node. This proves the PAGE: that the
 * scene boots, that the fixture and the canal are actually on screen, that the DOM readout
 * carries the number the geometry produces, and that the metal never takes the verdict's
 * colour.
 *
 * It is measured, not screenshotted, and that is not a preference. Screenshots land on the
 * browser's host rather than in the shell that drove the page, so a picture proves nothing
 * here -- which is why `hero3d.js` exposes `window.__hero3d`.
 *
 * `--use-angle=gl-egl` and NOT `--disable-gpu`: that pair is what reaches the RTX 3080.
 * With --disable-gpu Chrome falls back to SwiftShader, and every measurement taken through
 * it says nothing about what a visitor sees. The run FAILS rather than continues if the
 * renderer is software, for the same reason the film recorders do.
 *
 *   node scripts/check_hero_browser.mjs
 *   node scripts/check_hero_browser.mjs --shot /tmp/hero.png     also save a frame
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Validate what nginx serves, not the Astro source tree.
const LANDING = path.resolve(process.env.LANDING_DIST || path.join(ROOT, 'landing/dist'));
// HERO_LOCALE=es|pt-br checks the translated page: same geometry, its own words and
// decimal comma.
const LOCALE = process.env.HERO_LOCALE || 'en';
const PAGE = LOCALE === 'en' ? '/index.html' : `/${LOCALE}/index.html`;
const CHIPS = {
  en: { clear: 'CLEAR', tight: 'TIGHT', breach: 'BREACH', no_verdict: 'NOT GRADED' },
  es: { clear: 'SEGURO', tight: 'AJUSTADO', breach: 'INVADE', no_verdict: 'SIN GRADO' },
  'pt-br': { clear: 'SEGURO', tight: 'JUSTO', breach: 'INVADE', no_verdict: 'SEM GRAU' },
}[LOCALE];
const DEC = LOCALE === 'en' ? '.' : ',';
const SUB = {
  en: /mm measured − 0\.46 mm error budget = .* against a 2\.00 mm margin/,
  es: /mm medidos − 0,46 mm de presupuesto de error = .* frente a un margen de 2,00 mm/,
  'pt-br': /mm medidos − 0,46 mm de orçamento de erro = .* contra uma margem de 2,00 mm/,
}[LOCALE];
const PORT_DEBUG = Number(process.env.HERO_DEBUG_PORT || 9337);
const SHOT = process.argv.includes('--shot')
  ? process.argv[process.argv.indexOf('--shot') + 1] : null;

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
};

function serve() {
  const srv = createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = path.join(LANDING, p);
    if (!file.startsWith(LANDING) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404); res.end('no'); return;
    }
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream',
                         'content-length': body.length });
    res.end(body);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}

async function cdp(port) {
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const ws = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json())
        .webSocketDebuggerUrl;
      if (!ws) continue;
      const sock = new globalThis.WebSocket(ws);
      await new Promise((res, rej) => {
        sock.addEventListener('open', res);
        sock.addEventListener('error', rej);
      });
      let id = 0;
      return {
        send: (method, params = {}, sessionId) => new Promise((res, rej) => {
          const myId = ++id;
          const t = setTimeout(() => rej(new Error(method + ' timed out')), 45000);
          const on = (e) => {
            const m = JSON.parse(e.data);
            if (m.id === myId) {
              clearTimeout(t); sock.removeEventListener('message', on);
              if (m.error) rej(new Error(method + ': ' + m.error.message)); else res(m.result);
            }
          };
          sock.addEventListener('message', on);
          sock.send(JSON.stringify({ id: myId, method, params, sessionId }));
        }),
        raw: sock,
        close: () => sock.close(),
      };
    } catch { /* not up yet */ }
  }
  throw new Error('chrome did not expose a debugger on ' + port);
}

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
};

const { srv, port } = await serve();
const profile = '/tmp/hero-check-profile';
const chrome = spawn('google-chrome', [
  '--headless=new', '--ozone-platform=headless',
  '--use-angle=gl-egl',                      // NOT --disable-gpu; see the header
  '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-dev-shm-usage',
  '--remote-debugging-port=' + PORT_DEBUG,
  '--window-size=1600,1000', '--hide-scrollbars', '--force-device-scale-factor=1',
  'about:blank',
], { stdio: 'ignore' });

const done = (code) => { try { chrome.kill(); } catch {} srv.close(); process.exit(code); };

try {
  const client = await cdp(PORT_DEBUG);
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p = {}) => client.send(m, p, sessionId);

  const logs = [];
  client.raw.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      logs.push('EXCEPTION ' + (m.params.exceptionDetails?.exception?.description ||
                                m.params.exceptionDetails?.text));
    }
  });
  await S('Runtime.enable');
  await S('Page.enable');
  await S('Page.navigate', { url: `http://127.0.0.1:${port}${PAGE}` });

  const evalJs = async (expr) => {
    const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' +
      (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  };

  // The hero has a 12 s guard of its own; give it 25 before calling it dead.
  let booted = false;
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 250));
    booted = await evalJs('!!(window.__hero3d && window.__hero3d.state)');
    if (booted) break;
  }
  check('the hero boots', booted, booted ? '' : 'window.__hero3d never appeared');
  if (!booted) {
    console.log('\n--- console ---\n' + logs.join('\n'));
    done(1);
  }

  const renderer = await evalJs(`(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
  })()`);
  const realGpu = /nvidia|geforce|radeon|intel/i.test(renderer) && !/swiftshader|software|llvmpipe/i.test(renderer);
  check('a real GPU is rendering', realGpu, renderer);

  const state = await evalJs('window.__hero3d.state()');
  check('the cast is on screen and the rest is gone',
    state.drawnMeshes >= 4 && state.drawnMeshes <= 8,
    `${state.drawnMeshes} meshes drawn, ${state.canalSamples} canal samples, ` +
    `${state.screwTriangles} screw triangles`);
  check('the fixture is the catalogue size the bake used',
    state.fixture.diameter_mm === 4.8 && state.fixture.length_mm === 16,
    `${state.fixture.diameter_mm} x ${state.fixture.length_mm} mm on the ${state.mesh} mesh`);
  check('the thresholds came from plan_safety.py',
    state.thresholds.margin === 2 && state.thresholds.p95 === 0.46 &&
    state.thresholds.tight === 0.5 && state.shell_mm === 2.46,
    `margin ${state.thresholds.margin} + p95 ${state.thresholds.p95} -> shell ${state.shell_mm} mm`);

  // Drive the scrub and read the DOM back. The page's own numbers have to be the
  // geometry's numbers -- that is the whole claim the hero makes.
  const sweep = await evalJs(`(() => {
    const out = [];
    for (let i = 0; i <= 10; i++) {
      const p = i / 10;
      window.__hero3d.set(p);
      const m = window.__hero3d.measure();
      const el = document.querySelector('[data-hero-readout]');
      out.push({
        p, level: m.level, clearance: m.clearance_mm, depth: m.depth_mm,
        bodyIsNeutral: m.bodyIsNeutral, shell: m.shellColour,
        domMm: el.querySelector('[data-hero-mm]').textContent,
        domChip: el.querySelector('[data-hero-level]').textContent,
        domLevel: el.dataset.level,
        domSub: el.querySelector('[data-hero-sub]').textContent,
      });
    }
    return out;
  })()`);

  const domAgrees = sweep.every((s) =>
    s.domMm === s.clearance.toFixed(2).replace('.', DEC) &&
    s.domChip === CHIPS[s.level] &&
    s.domLevel === s.level);
  check('the readout on screen is the number the geometry produced', domAgrees,
    domAgrees ? `${sweep[0].domMm} mm -> ${sweep[sweep.length - 1].domMm} mm` :
      JSON.stringify(sweep.find((s) => s.domMm !== s.clearance.toFixed(2).replace('.', DEC))));

  const levels = [...new Set(sweep.map((s) => s.level))];
  const order = sweep.map((s) => s.level).filter((l, i, a) => l !== a[i - 1]);
  check('scrolling really moves the verdict through all three',
    order.join('>') === 'clear>tight>breach', order.join(' > '));

  check('the fixture never takes the verdict colour',
    sweep.every((s) => s.bodyIsNeutral),
    `body stayed neutral at all ${sweep.length} positions; shell went ` +
    [...new Set(sweep.map((s) => s.shell))].join(' '));

  check('the arithmetic is spelled out on screen',
    SUB.test(sweep[0].domSub),
    sweep[0].domSub);

  // The static fallback must not be showing while the live one is. "Showing" is what matters,
  // not how it is hidden: the landing keeps both cards in one grid cell and swaps them by
  // visibility, so the readout area is always as tall as the taller card and booting the
  // scene never shifts the page. display:none and visibility:hidden both count as hidden.
  const vis = await evalJs(`(() => {
    const st = document.querySelector('[data-filmstage]');
    const shown = (el) => { const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility === 'visible' && Number(cs.opacity) > 0; };
    const live = document.querySelector('.hero__live');
    const fb = document.querySelector('.hero__fallback');
    return { live: shown(live), fallback: shown(fb), cls: st.className };
  })()`);
  check('the live readout replaced the static fallback',
    vis.live && !vis.fallback,
    `live ${vis.live ? 'shown' : 'hidden'}, fallback ${vis.fallback ? 'shown' : 'hidden'}, stage "${vis.cls}"`);

  // Reduced motion still has to render and still has to carry a verdict.
  await S('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const rm = await evalJs(`(() => { window.__hero3d.set(0.6);
    const el = document.querySelector('[data-hero-readout]');
    return { chip: el.querySelector('[data-hero-level]').textContent, level: el.dataset.level }; })()`);
  check('a verdict is on screen under reduced motion', !!rm.chip && rm.level !== 'no_verdict',
    `${rm.chip} at p=0.6`);

  const errors = logs.filter((l) => /EXCEPTION|error|failed/i.test(l) &&
                                    !/favicon|Failed to load resource.*404/i.test(l));
  check('no exceptions on the console', errors.length === 0, errors.join(' | ') || 'clean');

  if (SHOT) {
    await evalJs('window.__hero3d.set(0.55)');
    const shot = await S('Page.captureScreenshot', { format: 'png' });
    writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log(`\n# frame written to ${SHOT}`);
  }

  console.log(`\n# ${failures ? failures + ' failing check(s)' : 'all checks passed'}`);
  done(failures ? 1 : 0);
} catch (e) {
  console.error('check_hero_browser failed:', e.message);
  done(1);
}

/* ImplantPlan landing checks: the contracts the VR launch adds on top of the shared harness.
 *
 * The shared `check-browser.mjs` (vendor/landing-ui) still runs first and still owns what both
 * sites promise. This file owns what only ImplantPlan promises, and it closes the shared
 * harness's one silent hole: `check-browser.mjs:48` skips the scroll sweep whenever the 3D
 * scene has not booted, so a dead stage reads as a pass. Here the boot is a check of its own.
 *
 * It measures the built site, never the source: `npm run build` first. It serves `dist/` with
 * its own server because the page now carries video, and a server that ignores `Range` makes
 * Chrome stall or refetch whole files on every seek, which would test the server instead of
 * the player. The server answers 206 with `Content-Range`, like nginx does in production.
 *
 *   node scripts/check-implantplan.mjs            every check; PASS/FAIL per record, exit 1 on any FAIL
 *   node scripts/check-implantplan.mjs --only=5,6 just those check numbers (13 rides with 1 and 2)
 *   node scripts/check-implantplan.mjs --static   only the checks that read files (no browser)
 *   node scripts/check-implantplan.mjs --serve    serve dist/ with the same server and wait
 *
 *   CHROME_BIN    the Chrome to drive (default /usr/bin/google-chrome: it has H.264, Chromium does not)
 *   LANDING_DIST  a dist/ other than landing/dist
 *   STRICT_LEGACY=1  copy-rule findings on /engineering/ and the legal pages fail instead of warn
 *
 * Results land in artifacts/implantplan-checks.json; a failing record leaves a screenshot of
 * the page it was looking at beside it.
 *
 * Every selector this file depends on is in SEL below. When a component renames one, fix it
 * there, once; a check that matches nothing fails and says which selector, rather than passing
 * because there was nothing to measure.
 */
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LANDING = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(LANDING, '..');
const DIST = path.resolve(process.env.LANDING_DIST || path.join(LANDING, 'dist'));
const ARTIFACTS = path.join(LANDING, 'artifacts');
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
// The shared harness's launch, kept identical so the two agree about what a page does.
// `--use-angle=gl-egl` reaches the real GPU from headless; Playwright adds a SwiftShader
// fallback of its own, which the renderer line in the report makes visible.
const LAUNCH = { executablePath: CHROME, headless: true, args: ['--no-sandbox', '--use-angle=gl-egl'] };
const ARGV = process.argv.slice(2);
const ONLY = new Set((ARGV.find(a => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean).map(Number));
const STRICT_LEGACY = process.env.STRICT_LEGACY === '1';

// --- the contracts ---------------------------------------------------------------------------
const SEL = {
  stage: '[data-filmstage]',
  pin: '[data-filmstage] .stage-pin',
  readout: '[data-hero-readout]',
  readoutArea: '.instrument .readout-area',
  loop: '.intro .loop',
  figure: '.intro figure',
  poster: '.loop__poster img',
  video: '.intro video',
  toggle: '.loop__toggle',
  caption: '.intro__caption',
  cta: '.hero__actions a.button',
  filmOpen: '.hero__actions a[data-film-open]',
  vrLink: '.hero__actions a[href$="/vr/"]',
  dialog: 'dialog#film',
  title: '#filmTitle',
  filmVideo: 'dialog#film video',
  fullscreen: 'dialog#film .player__fs',
  chapters: 'dialog#film .player__chapters button[data-t]',
  deepLink95: '#demo a[data-film-open][data-t="95"]',
  gauge: '.gauge',
  gaugeFill: '.gauge__fill',
  gaugeTrack: '.gauge__track',
  gaugeTick: '.gauge__tick, [data-tick]',
  gaugeMarker: '.gauge__marker',
  vrPhone: '.vr-phone',
  sha: '[data-sha256]',
  armed: '.is-armed',
  reveal: '[data-reveal]',
  chapter: '.chapter',
  chapterWord: '.chapter__word',
  chapterStill: '.chapter__still',
  transcript: '.transcript',
};
const CONTRAST_HOME = ['.intro__sub', '.intro__caption', '.intro__meta', '.instrument p', '.readout__sub', '.gauge',
  '.chapter__caption', '.chapter p', '.film-index', '.ledger p', '.ledger a', '.plan__allowance', '.faq-list dd'];
const CONTRAST_DIALOG = ['#filmTitle', 'dialog#film .player__chapters button', 'dialog#film .transcript'];
const CONTRAST_VR = ['.vr-phone'];
// The brief's list, then the release's own headings and controls (synthesis §9 item 13).
const SENTINELS = ['Open the app', 'Explore the project', 'Back to top', 'Research and educational use only',
  'Skip to content', 'Read the engineering notes', 'All prices in USD', 'Start here', 'Before you',
  'Watch the film', 'Get ImplantPlan VR', 'See ImplantPlan VR', 'The download opens', 'Download the APK', 'Pause the clip', 'Play the clip',
  'Every number on this page', 'Now seat one yourself', 'Take the plan into the headset',
  'Recorded in ImplantPlan VR', 'Close the film', 'Not a medical device'];
// Excluded from the numbers allowlist: what moves with the scroll (the live readout and its
// aria-live twin, the canvas tooltip), what is not a measurement (prices), what has its own
// check (the SHA-256, against apk.json in check 8), and the film's verbatim on-screen text.
const NUMBER_EXCLUDE = '[data-hero-readout], [data-hero-live], .hero3d-tooltip, .plan__price, [data-sha256], .transcript, time';

const LOCALES = [{ prefix: '', id: 'en', lang: 'en' }, { prefix: '/es', id: 'es', lang: 'es' }, { prefix: '/pt-br', id: 'pt-br', lang: 'pt-BR' }];
const OWN_ROUTES = ['/', '/vr/'];
// Release 1 leaves these on the shared components (critic P2-22); see check 15.
const LEGACY_ROUTES = ['/engineering/', '/privacy/', '/terms/'];
const VIEWPORTS = [[360, 800], [375, 812], [390, 844], [414, 896], [430, 932], [768, 1024], [1024, 768], [1280, 800], [1440, 1000], [1920, 1080], [844, 390]];

// --- inputs: every expected value is read out of the files that produce it -------------------
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const tryJson = file => { try { return readJson(file); } catch { return null; } };
const media = tryJson(path.join(LANDING, 'src/generated/media.json'));
const apk = tryJson(path.join(LANDING, 'src/generated/apk.json')) ?? { available: false };
const arch = tryJson(path.join(DIST, 'assets/arch.assets.json'));
const sources = tryJson(path.join(LANDING, 'scripts/number-sources.json'));
const TIGHT = arch?.site?.crossings?.tight_mm;
const BREACH = arch?.site?.crossings?.breach_mm;
const DEPTH_MAX = (() => {
  try { return Number(/export const DEPTH_MAX_MM = ([\d.]+);/.exec(readFileSync(path.join(DIST, 'assets/hero3d.js'), 'utf8'))[1]); }
  catch { return NaN; }
})();
// "2:27" is floor(147.77): the native controls floor, so every label on the page must too.
const FILM_SECONDS = media ? Math.floor(media.film.duration) : NaN;
const FILM_CLOCK = `${Math.floor(FILM_SECONDS / 60)}:${String(FILM_SECONDS % 60).padStart(2, '0')}`;
const isMp4 = u => /\.mp4$/i.test(new URL(u).pathname);
const isFilm = u => /\/film\.[^/]*\.(mp4|webm)$/i.test(new URL(u).pathname);

// --- a static server that behaves like nginx where video cares --------------------------------
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.map': 'application/json', '.webmanifest': 'application/manifest+json',
  '.glb': 'model/gltf-binary', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm', '.vtt': 'text/vtt',
  '.txt': 'text/plain', '.xml': 'application/xml', '.apk': 'application/vnd.android.package-archive',
};

function serve(root) {
  return createServer((req, res) => {
    const end = (status, headers = {}, body = '') => { res.writeHead(status, headers); res.end(req.method === 'HEAD' ? undefined : body); };
    let url;
    try { url = new URL(req.url, 'http://localhost'); url.pathname = decodeURIComponent(url.pathname); } catch { return end(400); }
    const pathname = url.pathname;
    // nginx: `location = /download/ { return 302 /vr/; }`
    if (pathname === '/download/') return end(302, { Location: '/vr/' });
    let file = path.resolve(root, '.' + pathname);
    if (file !== root && !file.startsWith(root + path.sep)) return end(404, {}, 'Not found');
    let st;
    try {
      st = statSync(file);
      if (st.isDirectory()) {
        // nginx answers /vr with a relative 301 to /vr/; the page's relative URLs depend on it.
        if (!pathname.endsWith('/')) return end(301, { Location: pathname + '/' + url.search });
        file = path.join(file, 'index.html');
        st = statSync(file);
      }
    } catch { return end(404, {}, 'Not found'); }
    const size = st.size;
    // HTML goes out as plain text/html with no charset parameter, as nginx sends it, so the
    // page's own <meta charset> is what decodes it (check 2 holds that to the first 1024 bytes).
    // no-cache, never no-store: no-store keeps a page out of the back/forward cache (check 7).
    const headers = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Accept-Ranges': 'bytes', 'Last-Modified': st.mtime.toUTCString(), 'Cache-Control': 'no-cache',
    };
    if (pathname.startsWith('/download/')) Object.assign(headers, { 'Content-Disposition': 'attachment', 'X-Content-Type-Options': 'nosniff' });
    let first = 0, last = size - 1, status = 200;
    const range = req.headers.range;
    // One range is all a media element asks for. A multi-range request may be answered with the
    // whole file (RFC 9110 §14.2), which is simpler than multipart/byteranges and still correct.
    if (range && !range.includes(',')) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!m || (m[1] === '' && m[2] === '')) return end(416, { 'Content-Range': `bytes */${size}` });
      if (m[1] === '') first = Math.max(0, size - Number(m[2]));     // bytes=-N: the last N bytes
      else { first = Number(m[1]); if (m[2] !== '') last = Math.min(Number(m[2]), size - 1); }
      if (first >= size || first > last) return end(416, { 'Content-Range': `bytes */${size}` });
      status = 206;
      headers['Content-Range'] = `bytes ${first}-${last}/${size}`;
    }
    headers['Content-Length'] = size === 0 ? 0 : last - first + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || size === 0) return res.end();
    const stream = createReadStream(file, { start: first, end: last });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

// --- records ---------------------------------------------------------------------------------
const records = [];
const warnings = [];
let BASE = '';
let browser = null;
let renderer = 'unknown';
let shotPage = null;

class CheckError extends Error {
  constructor(message, detail) { super(message); this.detail = detail; }
}
const preview = (list, n = 8) => list.slice(0, n).map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n       ')
  + (list.length > n ? `\n       ... ${list.length - n} more in artifacts/implantplan-checks.json` : '');
function assert(ok, message, detail) { if (!ok) throw new CheckError(message, detail); }
function none(list, what) { if (list.length) throw new CheckError(`${list.length} ${what}:\n       ${preview(list)}`, list); }
function warn(message) { if (warnings.includes(message)) return; warnings.push(message); console.log(`WARN ${message}`); }
const want = (...ids) => !ONLY.size || ids.some(id => ONLY.has(id));
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

async function record(id, name, run) {
  if (ONLY.size && !ONLY.has(id)) return;
  const started = Date.now();
  try {
    const detail = (await run()) ?? null;
    records.push({ id, name, ok: true, ms: Date.now() - started, detail });
    console.log(`PASS [${id}] ${name}`);
  } catch (e) {
    const entry = { id, name, ok: false, ms: Date.now() - started, error: e.message, detail: e.detail ?? null };
    if (shotPage && !shotPage.isClosed()) {
      const file = path.join(ARTIFACTS, `implantplan-fail-${id}-${slug(name)}.png`);
      try { await shotPage.screenshot({ path: file }); entry.screenshot = path.relative(LANDING, file); } catch { /* the page may be mid-navigation */ }
    }
    records.push(entry);
    console.log(`FAIL [${id}] ${name}\n       ${e.message}`);
  }
}

// --- page sessions ---------------------------------------------------------------------------
/** One context and one page, with the page-side helpers installed and the evidence collected. */
async function session(route, { width = 1440, height = 1000, phone = width < 600 || height < 500, options = {}, init = [], waitUntil = 'load', settleMs = 700, using = browser } = {}) {
  const context = await using.newContext({ viewport: { width, height }, isMobile: phone, hasTouch: phone, ...options });
  context.setDefaultTimeout(15000);
  await context.addInitScript(pageLib);
  for (const [fn, arg] of init) await context.addInitScript(fn, arg);
  const page = await context.newPage();
  const s = { context, page, errors: [], logs: [], requests: [], bad: [], response: null };
  page.on('pageerror', e => s.errors.push(`${new URL(page.url()).pathname}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'log' || m.type() === 'info') s.logs.push(`${new URL(page.url()).pathname} console.${m.type()}: ${m.text()}`); });
  page.on('request', r => s.requests.push(r.url()));
  page.on('response', r => { if (r.status() >= 400) s.bad.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  s.go = async (r, until = waitUntil) => {
    const response = await page.goto(BASE + r, { waitUntil: until });
    if (settleMs) await page.waitForTimeout(settleMs);
    return response;
  };
  s.close = async () => {
    for (const b of new Set(s.bad)) warn(`${b} was requested and failed`);
    await context.close();
  };
  shotPage = page;
  if (route != null) s.response = await s.go(route);
  return s;
}
async function withSession(route, options, run) {
  const s = await session(route, options);
  try { return await run(s); } finally { await s.close(); }
}
/** Fonts in, entrance animations over. An infinite animation is not waited for. */
async function settle(page, ms = 1500) {
  await page.evaluate(async ms => {
    const late = new Promise(r => setTimeout(r, ms));
    await Promise.race([document.fonts.ready, late]);
    const finite = document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming?.().endTime));
    await Promise.race([Promise.all(finite.map(a => a.finished.catch(() => {}))), late]);
  }, ms);
}
/** Scroll the whole page the way a reader does, so IntersectionObserver work actually runs. */
async function scrollThrough(page, step = .8, pause = 120) {
  await page.evaluate(async ({ step, pause }) => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight * step) {
      scrollTo({ top: y, behavior: 'instant' });
      await new Promise(r => setTimeout(r, pause));
    }
  }, { step, pause });
}
const waitTrue = (page, fn, arg, timeout) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);

/* Installed in every page before its own scripts run (context.addInitScript), as window.__ipc.
   It is serialized into the page, so it must not close over anything in this file. */
function pageLib() {
  const EXCLUDE = '.visually-hidden, .hero3d-tooltip, .skip-link';
  let ink = null;
  const lib = {
    /** A short, readable selector for an offender list. */
    sel(el) {
      if (!el || el.nodeType !== 1) return String(el);
      const part = e => (e.id ? `${e.localName}#${e.id}` : e.localName + [...e.classList].slice(0, 2).map(c => `.${c}`).join(''));
      const out = [];
      for (let e = el; e && e.nodeType === 1 && e !== document.body && out.length < 3; e = e.parentElement) {
        out.unshift(part(e));
        if (e.id) break;
      }
      return out.join(' > ') || el.localName;
    },
    /** Rendered at all: not display:none, not visibility:hidden, not in a closed dialog/details. */
    shown(el) {
      if (!el || !el.isConnected) return false;
      if (!el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true })) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    },
    /** Inside the page's horizontal extent and below its top (off-canvas menus are not). */
    onPage(r) { return r.right > 0 && r.left < innerWidth && r.bottom + scrollY > 0; },
    excluded(el, extra = '') { return !!el.closest(extra ? `${EXCLUDE}, ${extra}` : EXCLUDE); },
    /** Every visible, non-blank text node under root, with the element that styles it. */
    texts(root = document.body, extra = '') {
      const out = [];
      if (!root) return out;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!/\S/.test(n.data)) continue;
        const el = n.parentElement;
        if (!el || el.closest('script, style, noscript, template, svg, title') || lib.excluded(el, extra) || !lib.shown(el)) continue;
        range.selectNodeContents(n);
        const rect = [...range.getClientRects()].find(r => r.width > 0 && r.height > 0 && lib.onPage(r));
        if (rect) out.push({ el, text: n.data.trim().replace(/\s+/g, ' '), rect });
      }
      return out;
    },
    rgba(value) {
      const m = /^rgba?\(([^)]+)\)$/.exec(value);
      if (m) {
        const v = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
        return [v[0], v[1], v[2], v.length > 3 ? v[3] : 1];
      }
      const c = /^color\(srgb ([^)]+)\)$/.exec(value);
      if (c) {
        const v = c[1].split(/[\s/]+/).filter(Boolean).map(parseFloat);
        return [v[0] * 255, v[1] * 255, v[2] * 255, v.length > 3 ? v[3] : 1];
      }
      // oklch(), lab(), color-mix() results: let the canvas resolve them to sRGB.
      if (!ink) { const cv = document.createElement('canvas'); cv.width = cv.height = 1; ink = cv.getContext('2d', { willReadFrequently: true }); }
      ink.clearRect(0, 0, 1, 1); ink.fillStyle = '#000'; ink.fillStyle = value; ink.fillRect(0, 0, 1, 1);
      const d = ink.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    },
    /** The colour behind el: background colours composited up the ancestor chain, like the
        shared harness (images and gradients are not read; the report says when one is there). */
    background(el) {
      const layers = [];
      let image = false;
      for (let e = el; e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.backgroundImage !== 'none') image = true;
        const c = lib.rgba(cs.backgroundColor);
        if (c[3] > 0) layers.push(c);
        if (c[3] >= 1) break;
      }
      let base = [255, 255, 255];
      for (const c of layers.reverse()) base = base.map((v, i) => c[i] * c[3] + v * (1 - c[3]));
      return { rgb: base, image };
    },
    contrast(el) {
      const lum = c => c.map(v => v / 255).map(v => (v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
      const bg = lib.background(el);
      const fg = lib.rgba(getComputedStyle(el).color);
      const ink = bg.rgb.map((v, i) => fg[i] * fg[3] + v * (1 - fg[3]));
      const a = lum(ink), b = lum(bg.rgb);
      const hex = c => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
      return { ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), fg: hex(ink), bg: hex(bg.rgb), image: bg.image };
    },
    /** Every visible thing a finger can hit. */
    targets() {
      return [...document.querySelectorAll('a[href], button, summary, input:not([type=hidden]), select, textarea, [role=button]')]
        .filter(el => !lib.excluded(el) && lib.shown(el) && lib.onPage(el.getBoundingClientRect()));
    },
    /** A link inside running text (its block holds a sentence beyond the link's own words). */
    inProse(el) {
      if (el.localName !== 'a' || !getComputedStyle(el).display.startsWith('inline')) return false;
      let block = el.parentElement;
      while (block && /^(inline|contents)/.test(getComputedStyle(block).display)) block = block.parentElement;
      if (!block) return false;
      const words = e => (e.innerText || '').replace(/\s+/g, ' ').trim().length;
      return words(block) - words(el) >= 12;
    },
    /** WCAG 2.5.8 spacing: a 24 px circle on the target's centre touches no other target. */
    spaced(el, all, rects) {
      const r = rects.get(el), cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
      return all.every(o => {
        if (o === el || o.contains(el) || el.contains(o)) return true;
        const q = rects.get(o);
        return Math.hypot(Math.max(q.left - cx, 0, cx - q.right), Math.max(q.top - cy, 0, cy - q.bottom)) >= 12;
      });
    },
    /** Ask the browser: does a w × h box on el's centre hit el (padding, pseudo-element hit
        areas and negative margins all count, because hit testing counts them)? */
    hits(el, w, h) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect(), cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
      const dx = Math.max(w / 2 - 1, 0), dy = Math.max(h / 2 - 1, 0);
      return [[cx - dx, cy], [cx + dx, cy], [cx, cy - dy], [cx, cy + dy]].every(([x, y]) => {
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
        const hit = document.elementFromPoint(x, y);
        return !!hit && (hit === el || el.contains(hit));
      });
    },
  };
  Object.defineProperty(window, '__ipc', { value: lib, configurable: true, writable: true });
}

// --- probes (run in the page; each is serialized, so each stands alone) ------------------------
function firstViewportProbe({ sel, pin }) {
  scrollTo({ top: 0, behavior: 'instant' });
  const out = [], vh = innerHeight, vw = innerWidth;
  const nav = document.querySelector('.nav');
  const navBottom = nav && /fixed|sticky/.test(getComputedStyle(nav).position) ? nav.getBoundingClientRect().bottom : 0;
  if (pin) {
    // Critic P2-26: the sticky pin has to fit under the nav, or the readout's last line (three
    // lines long in ES/PT) is cut off for the whole scrub.
    const el = document.querySelector(sel.pin), room = vh - (nav ? nav.getBoundingClientRect().height : 0);
    if (!el) out.push(`${sel.pin} is missing`);
    else if (el.getBoundingClientRect().height > room + 1) out.push(`${sel.pin} is ${Math.round(el.getBoundingClientRect().height)} px tall, ${Math.round(room)} px fit under the nav`);
  }
  for (const [role, q] of [['h1', 'h1'], ['media', sel.loop], ['caption', sel.caption], ['button', sel.cta]]) {
    const el = document.querySelector(q);
    if (!el) { out.push(`${q} is missing`); continue; }
    const r = el.getBoundingClientRect();
    if (r.top < -.5 || r.left < -.5 || r.bottom > vh + .5 || r.right > vw + .5) out.push(`${q} spans y ${Math.round(r.top)}..${Math.round(r.bottom)}, x ${Math.round(r.left)}..${Math.round(r.right)}: not inside ${vw}x${vh}`);
    if (role === 'h1' && r.top < navBottom - 1) out.push(`h1 top ${Math.round(r.top)} is under the nav (bottom ${Math.round(navBottom)})`);
    if (role === 'button' && r.top < vh * .5) out.push(`${q} top ${Math.round(r.top)} is above the thumb zone (>= ${Math.round(vh * .5)})`);
  }
  return out;
}

function h1LineProbe() {
  const h = document.querySelector('h1');
  if (!h) return { lines: Infinity, missing: true };
  const cs = getComputedStyle(h);
  const height = h.getBoundingClientRect().height - ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((s, k) => s + parseFloat(cs[k]), 0);
  const lh = parseFloat(cs.lineHeight);
  // Second opinion from the line boxes themselves, used when line-height is `normal`.
  const range = document.createRange();
  range.selectNodeContents(h);
  const bottoms = [...range.getClientRects()].filter(r => r.width > 1 && r.height > 1).map(r => r.bottom).sort((a, b) => a - b);
  const byRects = bottoms.reduce((n, b, i) => n + (i === 0 || b - bottoms[i - 1] > 2 ? 1 : 0), 0);
  const lines = Number.isFinite(lh) && lh > 0 ? Math.round(height / lh) : byRects;
  return { lines, byRects, height: Math.round(height), lineHeight: Number.isFinite(lh) ? +lh.toFixed(1) : 'normal', fontSize: parseFloat(cs.fontSize) };
}

async function gaugeProbe(sel) {
  const stage = document.querySelector(sel.stage);
  // Park the real scroll at p = .6 first, so the scene's own scroll handler agrees with set(.6).
  scrollTo({ top: stage.getBoundingClientRect().top + scrollY + (stage.offsetHeight - innerHeight) * .6, behavior: 'instant' });
  await new Promise(r => setTimeout(r, 450));
  window.__hero3d.set(.6);
  // The gauge follows a MutationObserver on data-depth; its callback has run by the next frame.
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
  const gauge = document.querySelector(sel.gauge);
  if (!gauge) return { error: `${sel.gauge} is missing` };
  const fill = gauge.querySelector(sel.gaugeFill);
  if (!fill) return { error: `${sel.gaugeFill} is missing inside ${sel.gauge}` };
  const track = gauge.querySelector(sel.gaugeTrack) || fill.parentElement;
  const t = track.getBoundingClientRect();
  const f = fill.getBoundingClientRect();
  const m = /matrix(?:3d)?\(([^)]+)\)/.exec(getComputedStyle(fill).transform);
  const at = el => {
    const r = el.getBoundingClientRect();
    return { left: (r.left - t.left) / t.width, center: ((r.left + r.right) / 2 - t.left) / t.width };
  };
  const marker = gauge.querySelector(sel.gaugeMarker);
  return {
    depth: Number(document.querySelector(sel.readout)?.dataset.depth),
    scaleX: m ? Number(m[1].split(',')[0]) : null,
    box: (f.right - t.left) / t.width,
    ticks: [...gauge.querySelectorAll(sel.gaugeTick)].map(el => ({
      key: [el.dataset.tick, el.dataset.level, el.dataset.state, el.dataset.verdict, el.textContent].filter(Boolean).join(' ').toLowerCase(),
      ...at(el),
    })),
    marker: marker ? at(marker) : null,
  };
}

function loopState(sel) {
  const v = document.querySelector(sel.video), fig = document.querySelector(sel.figure), tg = document.querySelector(sel.toggle);
  return JSON.stringify({
    figure: fig?.dataset.state ?? null,
    video: v ? { paused: v.paused, readyState: v.readyState, src: v.currentSrc, error: v.error?.code ?? null } : null,
    toggle: tg ? { hidden: tg.hidden, label: tg.getAttribute('aria-label') || tg.innerText } : null,
  });
}

function overflowProbe() {
  const W = innerWidth, sw = document.documentElement.scrollWidth;
  if (sw <= W + 1) return null;
  const wide = [...document.body.querySelectorAll('*')].filter(el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && (r.right > W + 1 || r.left < -1) && getComputedStyle(el).position !== 'fixed';
  });
  const leaves = wide.filter(el => !wide.some(o => o !== el && el.contains(o)));
  return `scrollWidth ${sw} > ${W}: ${leaves.slice(0, 5).map(el => { const r = el.getBoundingClientRect(); return `${__ipc.sel(el)} (x ${Math.round(r.left)}..${Math.round(r.right)})`; }).join(', ')}`;
}

function dialogOverflowProbe(selector) {
  const d = document.querySelector(selector), out = [];
  if (!d) return [`${selector} is missing`];
  const W = innerWidth, r = d.getBoundingClientRect();
  if (document.documentElement.scrollWidth > W + 1) out.push(`page scrollWidth ${document.documentElement.scrollWidth} > ${W}`);
  if (d.scrollWidth > d.clientWidth + 1) out.push(`dialog scrollWidth ${d.scrollWidth} > clientWidth ${d.clientWidth}`);
  if (r.left < -1 || r.right > W + 1) out.push(`dialog spans x ${Math.round(r.left)}..${Math.round(r.right)} in a ${W} px viewport`);
  for (const el of d.querySelectorAll('*')) {
    const q = el.getBoundingClientRect();
    if (q.width > 0 && q.right > Math.min(W, r.right) + 1 && __ipc.shown(el)) { out.push(`${__ipc.sel(el)} reaches x ${Math.round(q.right)}`); if (out.length > 8) break; }
  }
  return out;
}

function clockProbe(root) {
  const out = [];
  for (const t of __ipc.texts(root ? document.querySelector(root) : document.body)) {
    for (const m of t.text.matchAll(/\b(\d{1,2}):(\d\d)\b/g)) out.push({ text: m[0], seconds: Number(m[1]) * 60 + Number(m[2]), where: __ipc.sel(t.el) });
  }
  return out;
}

async function seekProbe({ selector, t, timeout }) {
  const v = document.querySelector(selector);
  if (!v) return { ok: false, why: `${selector} is missing` };
  const end = performance.now() + timeout;
  let at = null;
  while (performance.now() < end) {
    if (v.readyState >= 1 && !v.seeking) {
      at = v.currentTime;
      if (Math.abs(at - t) <= .5) return { ok: true, at };
    }
    await new Promise(requestAnimationFrame);
  }
  return { ok: false, at, readyState: v.readyState };
}

function vrProbe() {
  const ld = [...document.querySelectorAll('script[type="application/ld+json"]')].flatMap(s => { try { return [JSON.parse(s.textContent)]; } catch { return []; } });
  const urls = [];
  const walk = o => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (k === 'downloadUrl') urls.push(v); walk(v); } };
  ld.forEach(walk);
  return {
    lang: document.documentElement.lang,
    hreflang: document.querySelectorAll('link[rel="alternate"][hreflang]').length,
    switcher: document.querySelector('.lang a[aria-current]')?.getAttribute('hreflang') ?? null,
    text: document.body.innerText.replace(/\s+/g, ' '),
    sha: [...document.querySelectorAll('[data-sha256]')].map(e => ({ text: e.textContent, data: e.dataset.sha256 })),
    downloads: [...document.querySelectorAll('a[href^="/download/"]')].map(a => ({ href: a.getAttribute('href'), download: a.getAttribute('download') })),
    downloadUrls: urls,
    comingSoonMarker: !!document.querySelector('[data-apk-state="coming-soon"], [data-apk="none"]'),
    leaks: [
      ...[...document.querySelectorAll('a[href^="/"]:not(.lang a):not(.legal__translated a)')].map(a => a.getAttribute('href')),
      ...[...document.querySelectorAll('track[src^="/"]')].map(e => e.getAttribute('src')),
    ],
  };
}

function typeTargetProbe() {
  const L = window.__ipc;
  const sizes = new Map(), small = [];
  for (const t of L.texts(document.body)) {
    const px = Math.round(parseFloat(getComputedStyle(t.el).fontSize) * 10) / 10;
    if (!sizes.has(px)) sizes.set(px, L.sel(t.el));
    if (px < 13.95) small.push({ size: px, sel: L.sel(t.el), text: t.text.slice(0, 40) });
  }
  const all = L.targets();
  const rects = new Map(all.map(el => [el, el.getBoundingClientRect()]));
  const under = [];
  for (const el of all) {
    const r = rects.get(el);
    if (L.inProse(el)) { if (r.height < 23.5 && !L.spaced(el, all, rects)) under.push({ el, kind: 'inline' }); }
    else if (r.width < 43.5 || r.height < 43.5) under.push({ el, kind: 'standalone' });
  }
  // A small box can still have a big hit area (padding on ::after, negative margins), and only
  // hit testing knows; the bounding box alone would flag those, so ask before reporting.
  const offenders = under.filter(u => !(u.kind === 'inline' ? L.hits(u.el, 2, 24) : L.hits(u.el, 44, 44))).map(u => {
    const r = rects.get(u.el);
    return { kind: u.kind, w: Math.round(r.width), h: Math.round(r.height), sel: L.sel(u.el), text: (u.el.innerText || u.el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 32) };
  });
  scrollTo({ top: 0, behavior: 'instant' });
  return { sizes: [...sizes].sort((a, b) => a[0] - b[0]), small, offenders };
}

function contrastProbe(selectors) {
  const L = window.__ipc, missing = [], hidden = [], fails = [];
  let checked = 0;
  for (const s of selectors) {
    const all = [...document.querySelectorAll(s)];
    if (!all.length) { missing.push(s); continue; }
    const roots = all.filter(e => L.shown(e) && !L.excluded(e));
    if (!roots.length) { hidden.push(s); continue; }
    // Every element under the root that owns visible text, not only the root: `.gauge` and
    // `.vr-phone` are containers, and their labels are what someone has to read.
    const owners = new Set();
    for (const root of roots) for (const e of [root, ...root.querySelectorAll('*')]) {
      if (e.closest('svg') || L.excluded(e) || !L.shown(e)) continue;
      if ([...e.childNodes].some(n => n.nodeType === 3 && /\S/.test(n.data))) owners.add(e);
    }
    for (const e of owners) {
      const c = L.contrast(e);
      checked += 1;
      if (c.ratio < 4.5) fails.push({ selector: s, el: L.sel(e), ratio: +c.ratio.toFixed(2), fg: c.fg, bg: c.bg, overImage: c.image, text: e.textContent.trim().replace(/\s+/g, ' ').slice(0, 40) });
    }
  }
  return { missing, hidden, fails, checked };
}

function readoutProbe(sel) {
  const area = document.querySelector(sel.readoutArea);
  if (!area) return { missing: true };
  const small = __ipc.texts(area).map(t => ({ px: parseFloat(getComputedStyle(t.el).fontSize), sel: __ipc.sel(t.el), text: t.text.slice(0, 30) })).filter(t => t.px < 13.95);
  return { height: area.getBoundingClientRect().height, small, live: !!document.querySelector(sel.stage)?.classList.contains('filmstage--live') };
}

function numberProbe(exclude) {
  // innerText is the text as rendered (no closed dialog, no closed details, "3.51mm" joined
  // across its spans the way a reader sees it), so hide the excluded parts and read it once.
  const style = document.createElement('style');
  style.textContent = '.__ipc-x{display:none!important}';
  document.head.append(style);
  const marked = [...document.querySelectorAll(exclude)];
  marked.forEach(e => e.classList.add('__ipc-x'));
  const body = document.body.innerText;
  const attrs = [...document.querySelectorAll('[aria-label], [alt], [title]')].filter(e => !e.closest('.__ipc-x'))
    .flatMap(e => ['aria-label', 'alt', 'title'].map(a => e.getAttribute(a)).filter(Boolean));
  marked.forEach(e => e.classList.remove('__ipc-x'));
  style.remove();
  return { body, attrs };
}

function copyProbe({ sentinels, transcript }) {
  const L = window.__ipc, main = document.querySelector('main');
  const lines = (main?.innerText ?? '').split('\n');
  const dashes = main ? L.texts(main, transcript).filter(t => /[\u2013\u2014]/.test(t.text)).map(t => `${L.sel(t.el)}: "${t.text.slice(0, 60)}"`) : [];
  // Sentinels: the text a reader or a screen reader can meet, hidden or not (a toggle's other
  // label, a closed dialog), plus labels and the runtime strings shipped as JSON. Blocks marked
  // lang="en" on purpose (the film transcript, the EN switch) are English by design.
  let found = [];
  if (sentinels) {
    const pool = [];
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || el.closest('[lang^="en"]:not(html), style, noscript, template')) continue;
      if (el.localName === 'script' && !/json/.test(el.type)) continue;
      pool.push(n.data);
    }
    for (const el of document.querySelectorAll('*')) {
      if (el.closest('[lang^="en"]:not(html)')) continue;
      for (const a of el.attributes) if (/^(aria-label|aria-description|aria-roledescription|alt|title|placeholder|label|content|data-.+)$/.test(a.name)) pool.push(a.value);
    }
    const all = pool.join('\n');
    found = sentinels.filter(s => all.includes(s));
  }
  const vt = [];
  const walk = (rules, media) => {
    for (const r of rules) {
      if (r.constructor.name === 'CSSViewTransitionRule' || /^@view-transition/.test(r.cssText)) vt.push({ media, navigation: r.navigation ?? (/navigation:\s*([\w-]+)/.exec(r.cssText) || [])[1] ?? null });
      else if (r.cssRules) walk(r.cssRules, r.media?.mediaText ?? r.conditionText ?? media);
    }
  };
  for (const sheet of document.styleSheets) { try { walk(sheet.cssRules, null); } catch { /* cross-origin */ } }
  return {
    numbered: lines.filter(l => /^\s*0\d\s*\//.test(l)).map(l => l.trim().slice(0, 60)),
    eyebrows: main ? main.querySelectorAll('.eyebrow').length : 0,
    dashes,
    sentinels: found,
    vt,
    lang: document.documentElement.lang,
    leaks: [...document.querySelectorAll('a[href^="/"]:not(.lang a):not(.legal__translated a)')].map(a => a.getAttribute('href'))
      .concat([...document.querySelectorAll('track[src^="/"]')].map(t => t.getAttribute('src'))),
  };
}

function restProbe(sel) {
  const out = [];
  const words = `${sel.chapterWord}, ${sel.chapterWord} *`;
  for (const el of document.querySelectorAll(`${sel.reveal}, ${words}, ${sel.chapterStill}`)) {
    const cs = getComputedStyle(el);
    if (cs.opacity !== '1') out.push(`${__ipc.sel(el)} opacity ${cs.opacity}`);
    if (el.matches(words)) {
      // A character parked below its clip line is as hidden as one at opacity 0; the rise may be
      // written with `transform` or with the individual `translate` property, so read both.
      if (cs.transform !== 'none' && !/^matrix\(1, 0, 0, 1, 0, 0\)$/.test(cs.transform)) out.push(`${__ipc.sel(el)} transform ${cs.transform}`);
      if (cs.translate !== 'none' && !/^0(px)?( 0(px)?){0,2}$/.test(cs.translate)) out.push(`${__ipc.sel(el)} translate ${cs.translate}`);
    }
    if (el.matches(sel.chapterStill) && /inset\([^)]*100%/.test(cs.clipPath)) out.push(`${__ipc.sel(el)} clip-path ${cs.clipPath}`);
  }
  // Critic P2-27: a word split into letters reads as letters unless the heading carries the word
  // and every letter is hidden from assistive tech.
  for (const word of document.querySelectorAll(sel.chapterWord)) {
    if (!word.getAttribute('aria-label')) out.push(`${__ipc.sel(word)} has no aria-label`);
    for (const ch of word.querySelectorAll('*')) if (/\S/.test(ch.textContent) && !ch.closest('[aria-hidden="true"]')) { out.push(`${__ipc.sel(ch)} "${ch.textContent.trim()}" is not aria-hidden`); break; }
  }
  return out;
}

const running = page => page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running')
  .map(a => `${__ipc.sel(a.effect?.target)} ${a.animationName || a.transitionProperty || a.id || a.constructor.name}`));

/** ES/PT links that drop out of the reader's language. */
const leaksOf = hrefs => hrefs.filter(h => /^\/(vr|film|engineering|privacy|terms|get-app)(\/|$)/.test(h) || h === '/' || h.startsWith('/#'));

// --- checks that read files only ---------------------------------------------------------------
const NUMBER_RE = new RegExp(sources?.regex ?? '(?!)', 'gu');
/** "3.51mm", "3.51 mm" and "3,51 mm" are one figure. */
function numberKey(text) {
  const m = /^([\d.,]+)\s?(mm|%|s|GB|MB|°)?$/u.exec(text.replace(/\s+/gu, ' ').trim());
  if (!m) return text;
  const n = m[1].replace(/,/g, '.');
  return m[2] ? `${n} ${m[2]}` : n;
}
const pinned = [];
/** null when the entry's line holds its pattern; otherwise why not. */
function verifySource(entry) {
  const file = path.resolve(REPO, entry.file);
  if (!existsSync(file)) return `${entry.text}: ${entry.file} does not exist`;
  const lines = readFileSync(file, 'utf8').split('\n');
  let line = entry.line;
  if (line == null) {
    const i = lines.findIndex(l => l.includes(entry.pattern));
    if (i < 0) return `${entry.text}: "${entry.pattern}" is nowhere in ${entry.file}`;
    line = i + 1;
    pinned.push(`${entry.text} -> ${entry.file}:${line}`);
  } else if (!lines[line - 1]?.includes(entry.pattern)) {
    return `${entry.text}: ${entry.file}:${line} does not contain "${entry.pattern}" (it reads: ${(lines[line - 1] ?? '<past the end>').trim().slice(0, 90)})`;
  }
  if (entry.digits != null) {
    const source = Number((entry.pattern.match(/\d+(?:\.\d+)?/g) ?? []).at(-1));
    const shown = Number(numberKey(entry.text).split(' ')[0]);
    if (source.toFixed(entry.digits) !== shown.toFixed(entry.digits)) return `${entry.text}: the source says ${source}, which rounds to ${source.toFixed(entry.digits)}, not ${shown}`;
  }
  return null;
}

function routeFiles() {
  return OWN_ROUTES.concat(LEGACY_ROUTES).flatMap(route => LOCALES.map(L => ({ route, url: L.prefix + route, file: path.join(DIST, L.prefix, route, 'index.html') })));
}

async function staticChecks() {
  await record(2, 'every built page declares its charset inside the first 1024 bytes', async () => {
    const bad = [];
    for (const { url, file } of routeFiles()) {
      if (!existsSync(file)) { bad.push(`${url}: not built`); continue; }
      const head = readFileSync(file).subarray(0, 1024).toString('latin1');
      if (!/<meta\s+charset=["']?utf-8["']?\s*\/?>/i.test(head)) bad.push(`${url}: <meta charset="utf-8"> is not in the first 1024 bytes`);
    }
    none(bad, 'pages');
  });
  await record(2, 'the importmap precedes every module script in the built HTML of / and /vr/', async () => {
    const bad = [];
    for (const { url, file } of routeFiles().filter(f => OWN_ROUTES.includes(f.route))) {
      if (!existsSync(file)) { bad.push(`${url}: not built`); continue; }
      const html = readFileSync(file, 'utf8');
      const maps = [...html.matchAll(/<script\b[^>]*\btype=["']?importmap\b/gi)];
      const firstModule = /<script\b[^>]*\btype=["']?module\b/i.exec(html);
      // Only a page that loads the 3D stage resolves the bare "three" specifier, so only it
      // needs the importmap; /vr/ loads no three.js at all and must not carry one either.
      const wantsMap = /\/assets\/hero3d\.js/.test(html);
      if (maps.length !== (wantsMap ? 1 : 0)) bad.push(`${url}: ${maps.length} importmaps (want ${wantsMap ? 'exactly one' : 'none'})`);
      else if (maps.length && firstModule && firstModule.index < maps[0].index) bad.push(`${url}: a module script at byte ${firstModule.index} precedes the importmap at ${maps[0].index}`);
    }
    none(bad, 'pages');
  });
  await record(14, 'number-sources.json: every entry points at a line that holds its figure', async () => {
    assert(sources?.entries?.length, 'scripts/number-sources.json is missing or has no entries');
    none(sources.entries.map(verifySource).filter(Boolean), 'entries do not match their source');
    for (const p of pinned) warn(`14: number-sources.json has line:null for ${p}; pin that line`);
    return { entries: sources.entries.length, unpinned: pinned };
  });
}

// --- browser checks --------------------------------------------------------------------------
async function heroChecks() {
  if (!want(1, 2, 13)) return;
  for (const [width, height] of [[390, 844], [1440, 1000]]) {
    await withSession('/', { width, height, settleMs: 1000 }, async s => {
      const { page } = s;
      // Before any scroll: largest-contentful-paint stops reporting once the page is used.
      await record(2, `the loop poster is the LCP element at ${width}x${height} and the importmap runs first`, async () => {
        const lcp = await page.evaluate(selector => new Promise(resolve => {
          let last = null;
          const po = new PerformanceObserver(list => { const e = list.getEntries(); if (e.length) last = e.at(-1); });
          po.observe({ type: 'largest-contentful-paint', buffered: true });
          setTimeout(() => {
            po.disconnect();
            resolve(last && { matches: !!last.element?.matches(selector), element: last.element ? __ipc.sel(last.element) : null, url: last.url || null, size: last.size, at: Math.round(last.startTime) });
          }, 400);
        }), SEL.poster);
        assert(lcp, 'no largest-contentful-paint entry was reported');
        assert(lcp.matches, `the LCP element is ${lcp.element ?? '(no longer in the DOM)'}${lcp.url ? ` (${lcp.url})` : ''}, not ${SEL.poster}`, lcp);
        const order = await page.evaluate(() => {
          const all = [...document.scripts], map = all.findIndex(x => x.type === 'importmap');
          return { maps: all.filter(x => x.type === 'importmap').length, early: all.slice(0, Math.max(map, 0)).filter(x => x.type === 'module').map(x => x.src || 'inline module') };
        });
        assert(order.maps === 1, `${order.maps} <script type="importmap"> in the live DOM (want exactly one)`);
        none(order.early, 'module scripts precede the importmap');
        return lcp;
      });

      let booted = false;
      await record(1, `the 3D stage boots and native scroll reaches CLEAR, TIGHT and BREACH at ${width}x${height}`, async () => {
        const pos = await page.evaluate(sel => {
          const st = document.querySelector(sel);
          return st ? { body: st.offsetParent === document.body, parent: st.offsetParent ? __ipc.sel(st.offsetParent) : null } : null;
        }, SEL.stage);
        assert(pos, `${SEL.stage} is missing`);
        assert(pos.body, `${SEL.stage}.offsetParent is ${pos.parent}, not <body>: a positioned ancestor makes offsetTop section-relative and the shared sweep scrolls to the wrong place (critic P1-2)`);
        await page.evaluate(sel => { const st = document.querySelector(sel); scrollTo({ top: Math.max(0, st.getBoundingClientRect().top + scrollY - innerHeight / 2), behavior: 'instant' }); }, SEL.stage);
        booted = await waitTrue(page, () => !!window.__hero3d, null, 10000);
        assert(booted, `window.__hero3d did not appear within 10 s (WebGL renderer: ${renderer})`);
        const levels = [];
        for (const p of [0, .15, .3, .45, .6, .75, .9, 1]) {
          await page.evaluate(({ sel, p }) => {
            const st = document.querySelector(sel);
            scrollTo({ top: st.getBoundingClientRect().top + scrollY + (st.offsetHeight - innerHeight) * p, behavior: 'instant' });
          }, { sel: SEL.stage, p });
          await page.waitForTimeout(550);
          levels.push(await page.locator(SEL.readout).getAttribute('data-level'));
        }
        assert(['clear', 'tight', 'breach'].every(l => levels.includes(l)), `the sweep read ${levels.join(', ')}`, levels);
        none(s.errors, 'page errors');
        return { levels };
      });
      if (!want(1) && want(13)) {
        // --only=13 still needs the live scene that check 1 would have booted.
        await page.evaluate(sel => { const st = document.querySelector(sel); if (st) scrollTo({ top: Math.max(0, st.getBoundingClientRect().top + scrollY - innerHeight / 2), behavior: 'instant' }); }, SEL.stage);
        booted = await waitTrue(page, () => !!window.__hero3d, null, 10000);
      }

      await record(13, `the depth gauge follows data-depth and its ticks sit at the measured crossings at ${width}px`, async () => {
        assert(booted, 'needs the live scene, and check 1 did not boot it');
        assert(Number.isFinite(DEPTH_MAX) && TIGHT && BREACH, `could not read DEPTH_MAX_MM from dist/assets/hero3d.js (${DEPTH_MAX}) or the crossings from dist/assets/arch.assets.json`);
        const g = await page.evaluate(gaugeProbe, SEL);
        assert(!g.error, g.error);
        assert(Number.isFinite(g.depth), `${SEL.readout} has no numeric data-depth`);
        const expect = g.depth / DEPTH_MAX;
        // scaleX with origin left is the spec; a box that ends at the depth (a width or a
        // translate inside a clipping track) draws the same thing, so either reading passes.
        const off = Math.min(...[g.scaleX, g.box].filter(v => v != null).map(v => Math.abs(v - expect)));
        assert(off <= .01, `the fill reads ${g.scaleX ?? '-'} by transform and ${g.box.toFixed(3)} by box; data-depth ${g.depth} / ${DEPTH_MAX} = ${expect.toFixed(3)}`, g);
        const sorted = [...g.ticks].sort((a, b) => a.left - b.left);
        for (const [name, mm, i] of [['tight', TIGHT, 0], ['breach', BREACH, 1]]) {
          const tick = g.ticks.find(t => t.key.includes(name)) ?? (g.ticks.length === 2 ? sorted[i] : null);
          assert(tick, `no ${name} tick under ${SEL.gauge} (${SEL.gaugeTick}, named by data-tick/data-level or its text)`, g.ticks);
          const at = mm / DEPTH_MAX;
          assert(Math.min(Math.abs(tick.left - at), Math.abs(tick.center - at)) <= .01, `the ${name} tick sits at ${tick.left.toFixed(3)} (left) / ${tick.center.toFixed(3)} (centre) of the track; ${mm} / ${DEPTH_MAX} = ${at.toFixed(4)}`, g.ticks);
        }
        if (g.marker) assert(Math.min(Math.abs(g.marker.left - expect), Math.abs(g.marker.center - expect)) <= .015, `${SEL.gaugeMarker} sits at ${g.marker.center.toFixed(3)}, the depth is ${expect.toFixed(3)} of the track`);
        return g;
      });
    });
  }
}

async function firstViewport() {
  if (!want(3)) return;
  for (const [width, height] of [[360, 640], [375, 553], [390, 664], [390, 750]]) {
    await withSession(null, { width, height, phone: true }, async s => {
      const pin = height === 664 || height === 640;
      await record(3, `h1, loop, caption and CTA fit the first ${width}x${height} screen, CTA in the thumb zone${pin ? ', the pin fits under the nav' : ''} (en, es, pt-br)`, async () => {
        const problems = [];
        for (const L of LOCALES) {
          await s.go(L.prefix + '/');
          await settle(s.page);
          for (const p of await s.page.evaluate(firstViewportProbe, { sel: SEL, pin })) problems.push(`${L.id}: ${p}`);
        }
        none(problems, 'layout problems');
      });
    });
  }
}

async function h1Lines() {
  if (!want(4)) return;
  for (const L of LOCALES) {
    const max = L.id === 'en' ? 2 : 3;
    await withSession(null, { width: 390, height: 844, phone: true }, async s => {
      await record(4, `the h1 stays within ${max} lines from 360 to 430 px (${L.id})`, async () => {
        await s.go(L.prefix + '/');
        await settle(s.page);
        const rows = [];
        for (let w = 360; w <= 430; w += 10) {
          await s.page.setViewportSize({ width: w, height: 844 });
          await s.page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
          rows.push({ width: w, ...(await s.page.evaluate(h1LineProbe)) });
        }
        none(rows.filter(r => r.lines > max).map(r => `${r.width} px: ${r.lines} lines (${r.height} px / ${r.lineHeight} px at ${r.fontSize} px)`), `widths wrap past ${max} lines`);
        return rows;
      });
    });
  }
}

async function autoplay() {
  if (!want(5)) return;
  await withSession('/', { width: 390, height: 844, phone: true, settleMs: 0 }, async s => {
    let playing = null;
    await record(5, 'the loop autoplays at 390 within 4 s, on the 4:5 rendition', async () => {
      playing = await s.page.waitForFunction(sel => {
        const v = document.querySelector(sel);
        return !!v && !v.paused && v.currentTime > 0 && v.readyState > 2 && v.currentSrc;
      }, SEL.video, { timeout: 4000 }).then(h => h.jsonValue(), () => null);
      assert(playing, `no ${SEL.video} was playing 4 s after load: ${await s.page.evaluate(loopState, SEL)}`);
      // AV1 when mediaCapabilities calls it power-efficient, else H.264; either is right.
      assert(/hands\.4x5\.(av1|h264)\./.test(playing), `currentSrc is ${playing}`);
      none(s.errors, 'page errors');
      return { currentSrc: playing };
    });
    await record(5, 'the loop pauses within 800 ms of leaving the viewport', async () => {
      assert(playing, 'needs the loop playing, and it was not');
      await s.page.evaluate(sel => { const f = document.querySelector(sel); scrollTo({ top: f.getBoundingClientRect().bottom + scrollY + 40, behavior: 'instant' }); }, SEL.loop);
      assert(await waitTrue(s.page, sel => document.querySelector(sel)?.paused, SEL.video, 800), 'the loop was still playing 800 ms after it left the viewport');
    });
  });

  const saveData = () => {
    const connection = new EventTarget();
    Object.assign(connection, { saveData: true, effectiveType: '4g', downlink: 10, rtt: 50 });
    Object.defineProperty(Navigator.prototype, 'connection', { configurable: true, get: () => connection });
  };
  for (const [label, options, init] of [
    ['reduced motion', { reducedMotion: 'reduce' }, []],
    ['Save-Data', {}, [[saveData]]],
  ]) {
    await withSession('/', { width: 390, height: 844, phone: true, options, init, settleMs: 3500 }, async s => {
      await record(5, `${label}: no video bytes are requested, on load or on scroll`, async () => {
        await scrollThrough(s.page);
        await s.page.waitForTimeout(500);
        none(s.requests.filter(isMp4).map(u => new URL(u).pathname), '.mp4 requests');
        none(s.errors, 'page errors');
      });
    });
  }

  const refusePlay = () => { HTMLMediaElement.prototype.play = function () { return Promise.reject(new DOMException('x', 'NotAllowedError')); }; };
  await withSession('/', { width: 390, height: 844, phone: true, init: [[refusePlay]], settleMs: 0 }, async s => {
    await record(5, 'a refused play() leaves the poster up and a visible "Play the clip" toggle', async () => {
      const blocked = await waitTrue(s.page, sel => !!document.querySelector(`${sel}[data-state="blocked"]`), SEL.figure, 4500);
      assert(blocked, `${SEL.figure} never reached data-state="blocked": ${await s.page.evaluate(loopState, SEL)}`);
      const r = await s.page.evaluate(sel => {
        const img = document.querySelector(sel.poster), tg = document.querySelector(sel.toggle);
        const opaque = e => { for (let x = e; x && x !== document.body; x = x.parentElement) if (getComputedStyle(x).opacity !== '1') return false; return true; };
        return {
          poster: !!img && __ipc.shown(img) && opaque(img),
          toggle: !!tg && __ipc.shown(tg),
          label: tg ? (tg.getAttribute('aria-label') || tg.innerText || '').trim() : null,
        };
      }, SEL);
      assert(r.poster, `${SEL.poster} is not fully visible in the blocked state`);
      assert(r.toggle, `${SEL.toggle} is not visible in the blocked state`);
      assert(/play/i.test(r.label ?? ''), `the toggle is labelled "${r.label}", not a Play label`);
      // A rejected play() that nobody caught surfaces here as an unhandled rejection.
      none(s.errors, 'page errors');
      return r;
    });
  });
}

async function player() {
  if (!want(6)) return;
  const filmPaths = s => s.requests.filter(isFilm).map(u => new URL(u).pathname);

  await withSession('/', { width: 390, height: 844, phone: true, settleMs: 1500 }, async s => {
    const { page } = s;
    await record(6, 'film at 390: nothing fetched before the click; it opens modal with focus on its title; Esc closes it and returns focus', async () => {
      await scrollThrough(page);
      await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
      none(filmPaths(s), 'film requests before anyone asked for the film');
      const pre = await page.evaluate(sel => {
        const b = document.querySelector(sel.fullscreen), v = document.querySelector(sel.filmVideo);
        return { fs: b ? b.disabled : null, ready: v ? v.readyState : null };
      }, SEL);
      assert(pre.fs !== null, `${SEL.fullscreen} is missing`);
      assert(pre.fs === true, `Full screen is enabled before the film has metadata (readyState ${pre.ready})`);
      const opener = page.locator(SEL.filmOpen);
      await opener.evaluate(el => el.setAttribute('data-check-opener', ''));
      await opener.click();
      await page.waitForSelector(`${SEL.dialog}[open]`, { timeout: 3000 });
      if (!(await waitTrue(page, () => document.activeElement?.id === 'filmTitle', null, 1500))) {
        throw new CheckError(`focus is on ${await page.evaluate(() => __ipc.sel(document.activeElement))}, not ${SEL.title}`);
      }
      assert(await page.evaluate(sel => document.querySelector('main')?.inert === true || document.querySelector(sel).matches(':modal'), SEL.dialog), 'main is not inert and the dialog is not :modal');
      await page.waitForTimeout(700);                     // the sheet animation
      none(await page.evaluate(dialogOverflowProbe, SEL.dialog), 'overflow problems with the dialog open at 390');
      assert(await waitTrue(page, sel => (document.querySelector(sel)?.readyState ?? 0) >= 1, SEL.filmVideo, 10000), 'the film never reached loadedmetadata');
      assert(await waitTrue(page, sel => document.querySelector(sel)?.disabled === false, SEL.fullscreen, 1500), 'Full screen is still disabled after loadedmetadata');
      await page.keyboard.press('Escape');
      assert(await waitTrue(page, sel => !document.querySelector(sel).open, SEL.dialog, 2000), 'Escape did not close the dialog');
      if (!(await waitTrue(page, () => !!document.activeElement?.hasAttribute('data-check-opener'), null, 1000))) {
        throw new CheckError(`after closing, focus is on ${await page.evaluate(() => __ipc.sel(document.activeElement))}, not the opener`);
      }
      none(s.errors, 'page errors');
    });
  });

  await withSession('/', { width: 1440, height: 1000, settleMs: 1200 }, async s => {
    const { page } = s;
    const open = async locator => {
      await locator.click();
      await page.waitForSelector(`${SEL.dialog}[open]`, { timeout: 3000 });
    };
    const close = async () => {
      await page.keyboard.press('Escape');
      await waitTrue(page, sel => !document.querySelector(sel).open, SEL.dialog, 2000);
    };
    await record(6, `the film's length reads ${FILM_CLOCK} (floor of ${media?.film.duration} s) everywhere it is shown`, async () => {
      assert(media, 'src/generated/media.json is missing');
      const wrong = list => list.filter(t => Math.abs(t.seconds - FILM_SECONDS) <= 7 && t.text !== FILM_CLOCK).map(t => `"${t.text}" at ${t.where}`);
      const onPage = await page.evaluate(clockProbe, null);
      const cta = (await page.locator(SEL.filmOpen).innerText()).replace(/\s+/g, ' ');
      assert(cta.includes(FILM_CLOCK), `the film CTA reads "${cta}", without ${FILM_CLOCK}`);
      await open(page.locator(SEL.filmOpen));
      const title = (await page.locator(SEL.title).innerText()).replace(/\s+/g, ' ');
      const inDialog = await page.evaluate(clockProbe, SEL.dialog);
      await close();
      assert(title.includes(FILM_CLOCK), `${SEL.title} reads "${title}", without ${FILM_CLOCK}`);
      none([...wrong(onPage), ...wrong(inDialog)], 'film lengths that are not the film');
    });
    await record(6, 'a chapter button seeks within 0.5 s of its data-t', async () => {
      await open(page.locator(SEL.filmOpen));
      assert(await waitTrue(page, sel => (document.querySelector(sel)?.readyState ?? 0) >= 1, SEL.filmVideo, 10000), 'the film never reached loadedmetadata');
      const t = await page.evaluate(sel => {
        const b = [...document.querySelectorAll(sel)].filter(x => __ipc.shown(x)).find(x => Number(x.dataset.t) >= 30);
        if (!b) return null;
        b.setAttribute('data-check-chapter', '');
        return Number(b.dataset.t);
      }, SEL.chapters);
      assert(t != null, `no visible ${SEL.chapters} with data-t >= 30`);
      await page.locator('[data-check-chapter]').click();
      const r = await page.evaluate(seekProbe, { selector: SEL.filmVideo, t, timeout: 8000 });
      await close();
      assert(r.ok, `asked for ${t} s, the film settled at ${r.at ?? 'nothing'} (${r.why ?? `readyState ${r.readyState}`})`);
      return { t, at: r.at };
    });
    await record(6, 'the VR section\'s 1:35 deep link opens the film at 95 s', async () => {
      const link = (await page.locator(SEL.deepLink95).count()) ? page.locator(SEL.deepLink95).first() : page.locator('a[data-film-open][data-t="95"]').first();
      assert(await link.count(), `no ${SEL.deepLink95}`);
      await open(link);
      const r = await page.evaluate(seekProbe, { selector: SEL.filmVideo, t: 95, timeout: 10000 });
      await close();
      assert(r.ok, `the film settled at ${r.at ?? 'nothing'} (${r.why ?? `readyState ${r.readyState}`}), not 95 +/- 0.5 s`);
      none(s.errors, 'page errors');
      return { at: r.at };
    });
  });
}

async function backForward() {
  if (!want(7)) return;
  // Playwright launches Chrome with --disable-back-forward-cache, which would turn this into a
  // test of a fresh load. The failure it guards (critic P1-5) only exists on a bfcache restore:
  // hero3d disposed its renderer on pagehide and nothing rebuilt it.
  const bf = await chromium.launch({ ...LAUNCH, ignoreDefaultArgs: ['--disable-back-forward-cache'] });
  const shows = () => addEventListener('pageshow', e => { (window.__ipShows ??= []).push(e.persisted); });
  try {
    await withSession(null, { using: bf, init: [[shows]] }, async s => {
      const { page } = s;
      await record(7, '/ -> Get ImplantPlan VR -> Back: the stage is alive and set(.75) grades BREACH', async () => {
        await s.go('/');
        assert(await waitTrue(page, () => !!window.__hero3d, null, 10000), 'window.__hero3d never appeared on / before leaving');
        await page.locator(SEL.vrLink).click();
        await page.waitForURL(u => u.pathname === '/vr/', { timeout: 10000 });
        await page.waitForLoadState('load');
        await page.goBack({ waitUntil: 'commit' }).catch(() => null);
        assert(await waitTrue(page, () => location.pathname === '/' && document.readyState === 'complete', null, 10000), 'Back did not return to /');
        assert(await waitTrue(page, () => !!window.__hero3d, null, 10000), 'window.__hero3d is gone after Back');
        const r = await page.evaluate(sel => {
          const out = typeof window.__hero3d.set === 'function' ? window.__hero3d.set(.75) : null;
          return { hasSet: !!out, level: out?.level ?? null, dom: document.querySelector(sel)?.dataset.level ?? null, persisted: (window.__ipShows ?? []).includes(true) };
        }, SEL.readout);
        if (!r.hasSet) warn('7: window.__hero3d has no set(); the BREACH reading was skipped');
        else assert(r.level === 'breach' && r.dom === 'breach', `__hero3d.set(.75) graded ${r.level} and the readout says ${r.dom}`, r);
        none(s.errors, 'page errors across / -> /vr/ -> back');
        if (!r.persisted) warn('7: Back was a fresh load, not a back/forward-cache restore, so the restore path went untested (something on / or /vr/ keeps the page out of the bfcache)');
        return r;
      });
    });
  } finally { await bf.close(); }
}

async function sha256(file) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

async function vrPage() {
  if (!want(8)) return;
  const dir = path.join(DIST, 'download');
  const shipped = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.apk')) : [];
  const apkFile = apk.available ? path.join(DIST, apk.href) : null;
  const apkSha = apkFile && existsSync(apkFile) ? await sha256(apkFile) : null;
  await withSession(null, {}, async s => {
    for (const L of LOCALES) {
      await record(8, `${L.prefix}/vr/: 200, ${L.lang}, hreflang, switcher, ${apk.available ? 'the download facts match the file' : 'the coming-soon state'}`, async () => {
        const res = await s.go(L.prefix + '/vr/');
        assert(res?.status() === 200, `${L.prefix}/vr/ answered ${res?.status()}`);
        const p = await s.page.evaluate(vrProbe);
        const problems = [];
        if (p.lang !== L.lang) problems.push(`<html lang="${p.lang}">`);
        if (p.hreflang !== 4) problems.push(`${p.hreflang} hreflang links (want 4)`);
        if (p.switcher !== L.lang) problems.push(`the language switcher marks ${p.switcher}`);
        if (/\bundefined\b|\bNaN\b/.test(p.text)) problems.push('the page prints "undefined" or "NaN"');
        if (apk.available !== shipped.length > 0) problems.push(`src/generated/apk.json says available:${apk.available}, dist/download holds ${shipped.length} APK(s)`);
        if (apk.available) {
          if (!apkSha) problems.push(`${apk.href} is not in dist`);
          else {
            if (apkSha !== apk.sha256) problems.push(`the file's SHA-256 is ${apkSha}, apk.json says ${apk.sha256}`);
            if (statSync(apkFile).size !== apk.bytes) problems.push(`the file is ${statSync(apkFile).size} bytes, apk.json says ${apk.bytes}`);
          }
          if (!p.sha.length) problems.push(`no ${SEL.sha} on the page`);
          for (const x of p.sha) {
            // Grouped 4 x 16 for reading; the element may also hold a Copy button, so take the
            // 64-hex run rather than every hex-looking letter.
            // The probed element can include the "SHA-256" label, whose digits run straight into
            // the hash once whitespace is gone ("256b889..."), so test containment, not a match.
            const flat = x.text.replace(/[\s\u200b\u2009\u202f]+/g, '').toLowerCase();
            const shown = flat.includes(String(x.data).toLowerCase()) ? String(x.data).toLowerCase() : (flat.match(/[0-9a-f]{64}/)?.[0] ?? '');
            if (shown !== x.data || x.data !== apk.sha256) problems.push(`SHA text ${shown.slice(0, 16)}..., data-sha256 ${String(x.data).slice(0, 16)}..., apk.json ${apk.sha256.slice(0, 16)}... disagree`);
          }
          if (!p.downloads.some(d => d.href === apk.href && d.download === apk.file)) problems.push(`no a[href="${apk.href}"][download="${apk.file}"]`);
          const size = `${new Intl.NumberFormat(L.lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(apk.bytes / 1e6)} MB`;
          if (!p.text.includes(size)) problems.push(`the size "${size}" is not on the page${L.id === 'en' ? '' : ' (with a decimal comma)'}`);
          if (!p.downloadUrls.some(u => String(u).endsWith(apk.href))) problems.push(`no JSON-LD downloadUrl ending in ${apk.href}`);
        } else {
          if (p.downloads.length) problems.push(`download links without an APK: ${p.downloads.map(d => d.href).join(' ')}`);
          if (p.sha.length) problems.push(`${SEL.sha} without an APK`);
          if (p.downloadUrls.length) problems.push('JSON-LD carries a downloadUrl without an APK');
          if (L.id === 'en' && !/download opens here shortly/i.test(p.text) && !p.comingSoonMarker) problems.push('no coming-soon message ("The download opens here shortly", or [data-apk-state="coming-soon"])');
        }
        if (L.id !== 'en') for (const h of leaksOf(p.leaks)) problems.push(`links out of ${L.id}: ${h}`);
        none(problems, 'problems');
      });
    }
  });
  await withSession(null, { width: 390, height: 844, phone: true }, async s => {
    await record(8, `${SEL.vrPhone} is visible at 390 with touch (en, es, pt-br)`, async () => {
      const problems = [];
      for (const L of LOCALES) {
        await s.go(L.prefix + '/vr/');
        const shown = await s.page.evaluate(sel => { const el = document.querySelector(sel); return el ? __ipc.shown(el) : null; }, SEL.vrPhone);
        if (shown !== true) problems.push(`${L.id}: ${shown === null ? 'missing' : 'not visible'}`);
      }
      none(problems, `pages without the phone panel`);
    });
  });
}

async function overflow() {
  if (!want(9)) return;
  const pages = OWN_ROUTES.flatMap(r => LOCALES.map(L => L.prefix + r));
  const found = new Map(pages.map(p => [p, []]));
  for (const [width, height] of VIEWPORTS) {
    await withSession(null, { width, height, settleMs: 900 }, async s => {
      for (const p of pages) {
        await s.go(p);
        const o = await s.page.evaluate(overflowProbe);
        if (!o) continue;
        found.get(p).push(`${width}x${height}: ${o}`);
        await s.page.screenshot({ path: path.join(ARTIFACTS, `implantplan-overflow-${slug(p) || 'home'}-${width}x${height}.png`) }).catch(() => {});
      }
    });
  }
  for (const p of pages) await record(9, `no horizontal overflow on ${p} at ${VIEWPORTS.length} viewports, 360 to 1920 and 844x390`, async () => none(found.get(p), 'viewports overflow'));
  for (const [width, height] of [[360, 800], [1440, 1000]]) {
    await withSession('/', { width, height, settleMs: 1000 }, async s => {
      await record(9, `no horizontal overflow with the film dialog open at ${width}x${height}`, async () => {
        await s.page.locator(SEL.filmOpen).click();
        await s.page.waitForSelector(`${SEL.dialog}[open]`, { timeout: 3000 });
        await s.page.waitForTimeout(700);
        none(await s.page.evaluate(dialogOverflowProbe, SEL.dialog), 'overflow problems');
      });
    });
  }
}

async function typeAndTargets() {
  if (!want(10)) return;
  await withSession(null, { width: 390, height: 844, phone: true, settleMs: 900 }, async s => {
    for (const r of OWN_ROUTES) for (const L of LOCALES) {
      await record(10, `text >= 14 px in <= 10 sizes, targets >= 44x44 (24 px inline) on ${L.prefix}${r} at 390`, async () => {
        await s.go(L.prefix + r);
        await settle(s.page);
        const rep = await s.page.evaluate(typeTargetProbe);
        const problems = [
          ...rep.small.map(t => `text at ${t.size} px: ${t.sel} "${t.text}"`),
          ...(rep.sizes.length > 10 ? [`${rep.sizes.length} font sizes (max 10): ${rep.sizes.map(([px, where]) => `${px} (${where})`).join(', ')}`] : []),
          ...rep.offenders.map(t => `${t.kind} target ${t.w}x${t.h}, under ${t.kind === 'inline' ? '24 px tall and crowded' : '44x44'}: ${t.sel} "${t.text}"`),
        ];
        none(problems, 'problems');
        return { sizes: rep.sizes.map(([px]) => px) };
      });
    }
  });
}

function contrastResult(r) {
  if (r.hidden.length) warn(`11: matched but not visible at this width: ${r.hidden.join(', ')}`);
  none([...r.missing.map(m => `${m} matched nothing (contract drift? fix SEL/CONTRAST lists)`),
    ...r.fails.map(f => `${f.ratio}:1 ${f.fg} on ${f.bg}${f.overImage ? ' (over a background image)' : ''}: ${f.el} [${f.selector}] "${f.text}"`)], 'contrast problems');
  return { checked: r.checked };
}

async function contrastChecks() {
  if (!want(11)) return;
  for (const [width, height] of [[1440, 1000], [390, 844]]) {
    await withSession('/', { width, height, settleMs: 1000 }, async s => {
      await record(11, `contrast >= 4.5:1 on / at ${width}px`, async () => contrastResult(await s.page.evaluate(contrastProbe, CONTRAST_HOME)));
      await record(11, `contrast >= 4.5:1 in the open film dialog at ${width}px`, async () => {
        await s.page.locator(SEL.filmOpen).click();
        await s.page.waitForSelector(`${SEL.dialog}[open]`, { timeout: 3000 });
        await s.page.evaluate(sel => document.querySelectorAll(`${sel} details`).forEach(d => { d.open = true; }), SEL.dialog);
        await s.page.waitForTimeout(700);
        return contrastResult(await s.page.evaluate(contrastProbe, CONTRAST_DIALOG));
      });
    });
  }
  await withSession('/vr/', { width: 390, height: 844, phone: true }, async s => {
    await record(11, 'contrast >= 4.5:1 on /vr/ at 390 with touch', async () => contrastResult(await s.page.evaluate(contrastProbe, CONTRAST_VR)));
  });
}

/** The 3D stage must never hold the rest of the page hostage: a non-async module script joins
 *  the deferred queue in document order, so with three.js still downloading the film dialog,
 *  the menu and the reveals had not run, and a tap on "Watch the film" left for the raw mp4. */
async function stageDoesNotBlock() {
  if (!want(6)) return;
  await withSession(null, { width: 390, height: 844, phone: true, settleMs: 0 }, async s => {
    await record(6, 'with three.js still downloading, "Watch the film" opens the dialog and the menu opens', async () => {
      let release;
      const gate = new Promise(r => { release = r; });
      await s.page.route(/\/assets\/vendor\/three\/three\.module\.min\.js(\?|$)/, async route => { await gate; await route.continue().catch(() => {}); });
      try {
        await s.page.goto(BASE + '/', { waitUntil: 'commit' });
        await s.page.waitForFunction(() => document.readyState !== 'loading', null, { timeout: 10000 });
        await s.page.waitForTimeout(600);
        const before = s.page.url();
        await s.page.locator('.hero__actions a[data-film-open]').click();
        await s.page.waitForTimeout(600);
        assert(s.page.url() === before, `the tap navigated to ${s.page.url()}`);
        assert(await s.page.evaluate(() => !!document.querySelector('dialog#film')?.open), 'dialog#film did not open while three.js was held');
        await s.page.keyboard.press('Escape');
        await s.page.waitForTimeout(500);
        await s.page.locator('#navToggle').click();
        assert(await s.page.locator('#navToggle').getAttribute('aria-expanded') === 'true', 'the menu did not open while three.js was held');
        release();
        assert(await waitTrue(s.page, () => document.querySelector('[data-filmstage]')?.classList.contains('filmstage--live'), null, 15000), 'the stage never went live after three.js was released');
      } finally { release(); }
    });
  });
}

async function readoutStable() {
  if (!want(12)) return;
  for (const [width, height, L] of [[390, 844, LOCALES[0]], [390, 844, LOCALES[1]], [390, 844, LOCALES[2]], [1440, 1000, LOCALES[0]]]) {
    await withSession(null, { width, height, settleMs: 0 }, async s => {
      await record(12, `the readout keeps its height (+/- 1 px) when the scene goes live, text >= 14 px (${L.id}, ${width}px)`, async () => {
        // Hold the scene back so the before-state is real: what a reader sees until three.js lands.
        // A held module script also holds DOMContentLoaded, hence waitUntil: 'commit'.
        let release;
        const gate = new Promise(r => { release = r; });
        await s.page.route(/\/assets\/hero3d\.js(\?|$)/, async route => { await gate; await route.continue().catch(() => {}); });
        try {
          await s.page.goto(BASE + L.prefix + '/', { waitUntil: 'commit' });
          await s.page.waitForSelector(SEL.readoutArea, { state: 'attached', timeout: 10000 });
          await s.page.waitForFunction(() => document.readyState !== 'loading', null, { timeout: 10000 });
          await s.page.evaluate(() => document.fonts.ready);
          await s.page.waitForTimeout(400);
          const before = await s.page.evaluate(readoutProbe, SEL);
          assert(!before.missing, `${SEL.readoutArea} is missing`);
          assert(!before.live, 'the stage was live before hero3d.js was released; the hold did not take');
          release();
          assert(await waitTrue(s.page, sel => document.querySelector(sel)?.classList.contains('filmstage--live'), SEL.stage, 15000), 'the stage never went live (filmstage--live)');
          await s.page.evaluate(() => document.fonts.ready);
          await s.page.waitForTimeout(400);
          const after = await s.page.evaluate(readoutProbe, SEL);
          assert(Math.abs(after.height - before.height) <= 1, `the readout is ${before.height.toFixed(1)} px before the scene and ${after.height.toFixed(1)} px live`);
          none([...before.small.map(t => `before: ${t.px} px ${t.sel} "${t.text}"`), ...after.small.map(t => `live: ${t.px} px ${t.sel} "${t.text}"`)], 'readout text under 14 px');
          return { before: before.height, live: after.height };
        } finally { release(); }
      });
    });
  }
}

async function numbers() {
  if (!want(14)) return;
  await withSession('/', { settleMs: 1500 }, async s => {
    await record(14, 'every unit-bearing number rendered on / (en) is listed in number-sources.json', async () => {
      assert(sources?.entries?.length, 'scripts/number-sources.json is missing');
      const allowed = new Map(sources.entries.map(e => [numberKey(e.text), e]));
      // The APK's size is the file's own and is checked against apk.json in check 8.
      if (apk.available) for (const n of [(apk.bytes / 1e6).toFixed(1), String(Math.round(apk.bytes / 1e6))]) allowed.set(`${n} MB`, { file: 'src/generated/apk.json' });
      const { body, attrs } = await s.page.evaluate(numberProbe, NUMBER_EXCLUDE);
      const text = [body, ...attrs].join('\n')
        .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')    // clock times (the film, its chapters)
        .replace(/[$€£]\s?\d[\d.,]*/g, ' ');             // prices
      const seen = new Map();
      for (const m of text.matchAll(NUMBER_RE)) {
        const key = numberKey(m[0]);
        const at = Math.max(0, m.index - 40);
        if (!seen.has(key)) seen.set(key, text.slice(at, m.index + m[0].length + 20).replace(/\s+/g, ' ').trim());
      }
      none([...seen].filter(([key]) => !allowed.has(key)).map(([key, context]) => `${key}  ("...${context}...")`), 'numbers with no source in number-sources.json');
      const unused = sources.entries.filter(e => !seen.has(numberKey(e.text))).map(e => e.text);
      return { rendered: [...seen.keys()], unused };
    });
  });
}

async function sweep() {
  if (!want(15, 17, 18)) return;
  const results = [];
  await withSession(null, { settleMs: 0 }, async s => {
    for (const route of [...OWN_ROUTES, ...LEGACY_ROUTES]) {
      for (const L of LOCALES) {
        const e0 = s.errors.length, l0 = s.logs.length;
        const res = await s.go(L.prefix + route);
        // The hero logs at boot, after load; give it the time it takes.
        await s.page.waitForTimeout(route === '/' ? 1800 : 500);
        const probe = await s.page.evaluate(copyProbe, { sentinels: L.id === 'en' ? null : SENTINELS, transcript: SEL.transcript });
        results.push({ route, L, status: res?.status(), errors: s.errors.slice(e0), logs: s.logs.slice(l0), ...probe });
      }
    }
  });
  for (const route of [...OWN_ROUTES, ...LEGACY_ROUTES]) {
    const rows = results.filter(r => r.route === route);
    const legacy = LEGACY_ROUTES.includes(route);
    await record(15, `copy rules on ${route} (en, es, pt-br): no "0N /", no eyebrows, no visible dashes, a quiet console`, async () => {
      const hard = [], soft = [];
      for (const r of rows) {
        const at = `${r.L.prefix}${route}`;
        if (r.status !== 200) hard.push(`${at}: HTTP ${r.status}`);
        for (const e of r.errors) hard.push(`${at}: pageerror ${e}`);
        for (const l of r.logs) hard.push(`${at}: ${l}`);
        for (const n of r.numbered) hard.push(`${at}: numbered "${n}"`);
        (legacy && !STRICT_LEGACY ? soft : hard).push(...(r.eyebrows ? [`${at}: ${r.eyebrows} .eyebrow in main`] : []), ...r.dashes.map(d => `${at}: dash in ${d}`));
      }
      // The engineering notes and the legal pages stay on the shared components this release
      // (critic P2-22); their eyebrows and dashes are reported, not failed, unless STRICT_LEGACY.
      if (soft.length) warn(`15: ${route} keeps ${soft.length} legacy copy finding(s), e.g. ${soft[0]}`);
      none(hard, 'problems');
      return soft.length ? { legacy: soft } : null;
    });
    if (OWN_ROUTES.includes(route)) {
      await record(17, `${route} declares a cross-document @view-transition, off under reduced motion`, async () => {
        const problems = [];
        for (const r of rows) {
          const auto = r.vt.some(v => v.navigation === 'auto' && !/prefers-reduced-motion:\s*reduce/.test(v.media ?? ''));
          const off = r.vt.some(v => v.navigation === 'none' && /prefers-reduced-motion:\s*reduce/.test(v.media ?? ''));
          if (!auto) problems.push(`${r.L.prefix}${route}: no @view-transition { navigation: auto } in the CSSOM`);
          if (!off) problems.push(`${r.L.prefix}${route}: no @view-transition { navigation: none } under prefers-reduced-motion: reduce`);
        }
        none(problems, 'problems');
      });
    }
    await record(18, `${route} in es and pt-br carries none of the English sentinels (text, labels, alt, runtime strings) and no out-of-locale links`, async () => {
      const problems = [];
      for (const r of rows.filter(x => x.L.id !== 'en')) {
        for (const p of r.sentinels) problems.push(`${r.L.prefix}${route} says "${p}"`);
        for (const h of leaksOf(r.leaks)) problems.push(`${r.L.prefix}${route} links out of ${r.L.id}: ${h}`);
      }
      none(problems, 'problems');
    });
  }
}

async function reducedMotion() {
  if (!want(16)) return;
  for (const [width, height] of [[390, 844], [1440, 1000]]) {
    await withSession('/', { width, height, options: { reducedMotion: 'reduce' }, settleMs: 1000 }, async s => {
      await record(16, `reduced motion at ${width}px: no row armed, no animation running, every reveal and chapter word at rest`, async () => {
        const atLoad = await running(s.page);
        // Scroll the whole page: an IntersectionObserver that arms despite the preference does it
        // on the way down, so a check at the top alone would miss it.
        const armed = await s.page.evaluate(async sel => {
          const seen = new Set();
          for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight * .6) {
            scrollTo({ top: y, behavior: 'instant' });
            await new Promise(r => setTimeout(r, 140));
            document.querySelectorAll(sel).forEach(e => seen.add(__ipc.sel(e)));
          }
          return [...seen];
        }, SEL.armed);
        // A reduced-motion fade is allowed to exist (150 ms opacity); it has to be over, not absent.
        await s.page.waitForTimeout(400);
        const afterScroll = await running(s.page);
        const rest = await s.page.evaluate(restProbe, SEL);
        none([...atLoad.map(a => `running at load: ${a}`), ...afterScroll.map(a => `running after scrolling: ${a}`),
          ...armed.map(a => `armed: ${a}`), ...rest], 'problems');
      });
    });
  }
}

async function focusRelease() {
  if (!want(16)) return;
  await withSession('/', { width: 1440, height: 1000, settleMs: 1000 }, async s => {
    await record(16, 'keyboard focus inside a chapter row still waiting below the fold reveals it (critic P2-27)', async () => {
      const r = await s.page.evaluate(async sel => {
        const row = [...document.querySelectorAll(sel.chapter)].find(x => x.getBoundingClientRect().top > innerHeight && x.querySelector('a[href], button'));
        if (!row) return { vacuous: 'no chapter row with a link below the fold' };
        const armed = row.classList.contains('is-armed');
        // preventScroll: scrolling would let the IntersectionObserver release the row and prove
        // nothing about focusin, which is the path a keyboard user depends on.
        row.querySelector('a[href], button').focus({ preventScroll: true });
        await new Promise(res => setTimeout(res, 1200));
        const hidden = [...row.querySelectorAll(`${sel.chapterWord}, ${sel.chapterWord} *, ${sel.chapterStill}`)].filter(e => {
          const cs = getComputedStyle(e);
          return cs.opacity !== '1' || (cs.translate !== 'none' && !/^0(px)?( 0(px)?){0,2}$/.test(cs.translate))
            || (cs.transform !== 'none' && !/^matrix\(1, 0, 0, 1, 0, 0\)$/.test(cs.transform)) || /inset\([^)]*100%/.test(cs.clipPath);
        }).map(e => __ipc.sel(e));
        return { armed, stillArmed: row.classList.contains('is-armed'), hidden, row: __ipc.sel(row) };
      }, SEL);
      if (r.vacuous || !r.armed) { warn(`16: the focusin release went untested (${r.vacuous ?? `${r.row} was not armed below the fold`})`); return r; }
      none(r.hidden.map(h => `${h} is still hidden 1.2 s after focus entered ${r.row}`), 'problems');
      return r;
    });
  });
}

// --- main ------------------------------------------------------------------------------------
async function writeReport() {
  const failed = records.filter(r => !r.ok);
  await writeFile(path.join(ARTIFACTS, 'implantplan-checks.json'), JSON.stringify({
    when: new Date().toISOString(), dist: DIST, chrome: browser ? browser.version() : null, renderer,
    apk: apk.available ? { version: apk.version, href: apk.href } : { available: false },
    passed: records.length - failed.length, failed: failed.length, warnings, records,
  }, null, 2) + '\n');
  console.log(`\n${records.length - failed.length} passed, ${failed.length} failed, ${warnings.length} warning(s). Report: artifacts/implantplan-checks.json`);
  return failed.length;
}

await mkdir(ARTIFACTS, { recursive: true });
if (!existsSync(path.join(DIST, 'index.html'))) {
  console.log(`FAIL ${path.relative(process.cwd(), DIST) || DIST}/index.html does not exist: run \`npm run build\` first`);
  process.exit(2);
}

if (ARGV.includes('--static')) {
  await staticChecks();
  process.exitCode = (await writeReport()) ? 1 : 0;
} else {
  const server = serve(DIST);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;
  if (ARGV.includes('--serve')) {
    console.log(`Serving ${DIST} at ${BASE}/ (Range-capable). Ctrl-C to stop.`);
  } else {
    try {
      await staticChecks();
      browser = await chromium.launch(LAUNCH);
      const probe = await browser.newPage();
      renderer = await probe.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2');
        const ext = gl?.getExtension('WEBGL_debug_renderer_info');
        return gl ? (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'webgl2 (renderer hidden)') : 'no WebGL';
      });
      await probe.close();
      console.log(`Chrome ${browser.version()} on ${renderer}; serving ${DIST} at ${BASE}`);
      if (/swiftshader|llvmpipe|software/i.test(renderer)) warn(`WebGL is software (${renderer}): the 3D checks run, but nothing they time says what a visitor sees`);
      for (const run of [heroChecks, firstViewport, h1Lines, autoplay, player, stageDoesNotBlock, backForward, vrPage, overflow,
        typeAndTargets, contrastChecks, readoutStable, numbers, sweep, reducedMotion, focusRelease]) {
        try { await run(); }
        catch (e) {
          // A crash inside a group (a page that never loads, a closed browser) is a failure of
          // that group, never a reason to skip the rest.
          records.push({ id: 0, name: `${run.name} crashed`, ok: false, error: e.stack ?? String(e) });
          console.log(`FAIL [${run.name}] crashed\n       ${e.message}`);
        }
      }
    } catch (e) {
      // The harness itself failed (no Chrome at CHROME_BIN, say). That is a failed run, and the
      // report must say so rather than count the zero checks that ran as zero failures.
      records.push({ id: 0, name: 'the harness crashed', ok: false, error: e.stack ?? String(e) });
      console.log(`FAIL the harness crashed\n       ${e.message}`);
    } finally {
      process.exitCode = (await writeReport()) ? 1 : 0;
      await browser?.close();
      server.close();
    }
  }
}

import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { checkMotion } from './check-motion.mjs';

const root = process.cwd();
const output = path.join(root, 'artifacts');
await mkdir(output, { recursive: true });
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.webp': 'image/webp', '.vtt': 'text/vtt', '.apk': 'application/vnd.android.package-archive', '.webm': 'video/webm' };
const server = createServer(async (req, res) => {
  try {
    let name = path.resolve(root, 'dist', '.' + new URL(req.url, 'http://localhost').pathname);
    if (!name.startsWith(path.join(root, 'dist') + '/') && name !== path.join(root, 'dist')) throw new Error('path');
    if ((await stat(name)).isDirectory()) name = path.join(name, 'index.html');
    const body = await readFile(name);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] || 'application/octet-stream' }); res.end(body);
  } catch { res.writeHead(404); res.end('Not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--use-angle=gl-egl'] });
const results = [];
async function record(name, run) { await run(); results.push(name); console.log(`PASS ${name}`); }
const dimensions = [[360,800],[390,844],[768,1024],[1440,1000],[1920,1080],[844,390],[720,450]];
try {
  for (const [width,height] of dimensions) {
    const page = await browser.newPage({ viewport: { width,height }, isMobile: width < 600 || height === 390, hasTouch: width < 600 || height === 390 });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(750);
    await record(`layout ${width}×${height}`, async () => {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'horizontal overflow');
      assert.equal(await page.locator('h1').count(), 1);
      assert.equal(await page.locator('iframe').count(), 0, 'video loads before activation');
      if (width === 390) {
        const b = await page.locator('.hero__actions .button').boundingBox();
        assert.ok(b && b.y + b.height <= height, 'primary action below first screen');
        assert.ok(await page.locator('.nav .brand').isVisible());
      }
      assert.deepEqual(errors, []);
    });
    await page.screenshot({ path: path.join(output, `landing-${width}x${height}.png`) });
    if (width === 1440 || width === 390) {
      await page.screenshot({ path: path.join(output, `full-${width}.png`), fullPage: true });
      if (await page.evaluate(() => !!window.__hero3d)) {
        await record(`native scroll reaches each clearance state at ${width}px`, async () => {
          const levels = [];
          for (const progress of [0,.15,.3,.45,.6,.75,.9,1]) {
            await page.evaluate(p => {
              const stage = document.querySelector('[data-filmstage]');
              window.scrollTo({ top: stage.offsetTop + (stage.offsetHeight - innerHeight) * p, behavior: 'instant' });
            }, progress);
            await page.waitForTimeout(550);
            levels.push(await page.locator('[data-hero-readout]').getAttribute('data-level'));
          }
          assert.ok(levels.includes('clear') && levels.includes('tight') && levels.includes('breach'), levels.join(','));
          await page.screenshot({ path: path.join(output, `scene-${width}.png`) });
        });
      }
    }
    if (width === 390) {
      await page.evaluate(() => scrollTo({top:0,behavior:'instant'}));
      await record('mobile menu keyboard and focus behavior', async () => {
        await page.locator('#navToggle').click();
        assert.equal(await page.locator('#navToggle').getAttribute('aria-expanded'), 'true');
        assert.ok(await page.evaluate(() => document.querySelector('#navMenu').contains(document.activeElement)));
        await page.keyboard.press('Escape');
        assert.ok(await page.evaluate(() => document.activeElement === document.querySelector('#navToggle')));
        assert.equal(await page.locator('main').evaluate(el => el.inert), false);
        await page.locator('#navToggle').click();
        await page.locator('#navMenu a[href="#pricing"]').click();
        assert.equal(await page.locator('#navToggle').getAttribute('aria-expanded'), 'false');
      });
    }
    await page.close();
  }
  await checkMotion(browser, url, record);
  const page = await browser.newPage({ viewport: { width:1440,height:1000 } });
  await page.goto(url, { waitUntil: 'networkidle' });
  await record('rendered text contrast across both theme surfaces', async () => {
    const failures = await page.evaluate(() => {
      const rgb = value => (value.match(/[\d.]+/g) || []).map(Number);
      const luminance = color => color.slice(0,3).map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum,c,i) => sum + c * [.2126,.7152,.0722][i],0);
      function background(el) {
        const color = rgb(getComputedStyle(el).backgroundColor);
        if (color.length === 3 || color[3] === 1) return color;
        const under = el.parentElement ? background(el.parentElement) : [255,255,255];
        const alpha = color[3] || 0;
        return under.slice(0,3).map((c,i) => color[i] * alpha + c * (1-alpha));
      }
      const selectors = ['.hero__sub','.hero .eyebrow','.hero__author','.hero__research','.scene-label','.scene-progress','.readout__chip','.readout__sub','.button','.text-link','.highlight p','.tags li','.plan__badge','.plan__allowance','.plan__note','.pricing-note','.faq summary','.creator__intro','.footer__bottom','.license'];
      return selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(el => getComputedStyle(el).display !== 'none').map(el => {
        const a = luminance(rgb(getComputedStyle(el).color)); const b = luminance(background(el));
        return { selector, ratio: (Math.max(a,b)+.05)/(Math.min(a,b)+.05) };
      })).filter(row => row.ratio < 4.5);
    });
    assert.deepEqual(failures, [], JSON.stringify(failures));
  });
  await record('click-to-play broadcast and 25-second start', async () => {
    assert.equal(await page.locator('iframe').count(), 0);
    // Test our player contract without depending on availability of YouTube in CI.
    await page.route('https://www.youtube-nocookie.com/**', route => route.fulfill({ status:200, contentType:'text/html', body:'<title>Video fixture</title>' }));
    await page.locator('.media__play').click();
    const src = new URL(await page.locator('iframe').getAttribute('src'));
    assert.equal(src.hostname, 'www.youtube-nocookie.com');
    assert.equal(src.searchParams.get('start'), '25');
    assert.equal(src.searchParams.get('autoplay'), '1');
    assert.ok(await page.locator('a[href="https://www.youtube.com/watch?v=-DcNCL3ux3Y"]').isVisible());
  });
  await record('engineering page and retained navigation', async () => {
    await page.goto(url + '/engineering/');
    assert.ok(await page.locator('.research h2').count() >= 4);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.ok(await page.locator('a[href="/#pricing"]').count());
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),true,'engineering page overflows on mobile');
    await page.screenshot({path:path.join(output,'engineering-390.png'),fullPage:true});
  });
  await record('every page exists in every language, in that language', async () => {
    const project = await page.evaluate(() => document.body.dataset.project);
    const pages = ['/', '/engineering/', '/privacy/', '/terms/', ...(project === 'dicomsegvr' ? ['/get-app/'] : [])];
    // Interface phrases that must never survive into a translated page.
    const english = ['Open the app', 'Explore the project', 'Back to top', 'Research and educational use only',
      'Skip to content', 'Read the engineering notes', 'All prices in USD', 'Start here', 'Before you'];
    for (const [prefix, lang] of [['', 'en'], ['/es', 'es'], ['/pt-br', 'pt-BR']]) {
      for (const route of pages) {
        const response = await page.goto(url + prefix + route);
        assert.equal(response.status(), 200, `${prefix}${route}`);
        assert.equal(await page.evaluate(() => document.documentElement.lang), lang, `${prefix}${route} lang`);
        assert.equal(await page.locator('link[rel="alternate"][hreflang]').count(), 4, `${prefix}${route} hreflang`);
        assert.equal(await page.locator('.lang a[aria-current]').getAttribute('hreflang'), lang, `${prefix}${route} switcher`);
        if (lang !== 'en') {
          const text = await page.evaluate(() => document.body.innerText);
          for (const phrase of english) assert.ok(!text.includes(phrase), `${prefix}${route} still says "${phrase}"`);
          const hrefs = await page.locator('a[href^="/"]:not(.lang a):not(.legal__translated a)').evaluateAll(els => els.map(e => e.getAttribute('href')));
          const leaks = hrefs.filter(h => /^\/(engineering|privacy|terms|get-app)\//.test(h) || h === '/');
          assert.equal(leaks.length, 0, `${prefix}${route} links out of its language: ${leaks.join(' ')}`);
        }
      }
    }
  });
  await page.close();
  for (const mode of ['reduced','no-js','no-webgl','asset-failure']) {
    const context = await browser.newContext({ viewport: {width:390,height:844}, javaScriptEnabled: mode !== 'no-js', reducedMotion: mode === 'reduced' ? 'reduce' : 'no-preference' });
    if (mode === 'no-webgl') await context.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type,...args) { return /webgl/.test(type) ? null : getContext.call(this,type,...args); };
    });
    if (mode === 'asset-failure') await context.route('**/*.glb', route => route.abort());
    const p = await context.newPage();
    await p.goto(url, {waitUntil:'networkidle'});
    await record(`${mode} content and fallback`, async () => {
      assert.ok(await p.locator('h1').isVisible());
      assert.ok(await p.locator('.hero__actions .button').isVisible());
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),true);
      if (mode === 'reduced') assert.equal(await p.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length),0);
      else assert.equal(await p.locator('.filmstage__poster').evaluate(el => getComputedStyle(el).opacity),'1');
    });
    await p.screenshot({ path: path.join(output, `${mode}.png`) });
    await context.close();
  }
  await writeFile(path.join(output,'checks.json'),JSON.stringify({passed:results.length,checks:results},null,2)+'\n');
  console.log(`${results.length} browser checks passed.`);
} finally { await browser.close(); server.close(); }

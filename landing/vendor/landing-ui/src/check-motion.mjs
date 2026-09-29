import assert from 'node:assert/strict';

// Follow actual painted frames: a card must never become less visible as it
// enters the viewport. This catches the visible -> hidden -> visible flash.
export async function checkMotion(browser, url, record) {
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    try {
      await page.goto(url, { waitUntil: 'networkidle' });
      await record(`scroll reveal never blinks or replays at ${width}px`, async () => {
        const frames = await page.locator('.highlight').first().evaluate(async el => {
          const top = el.getBoundingClientRect().top + scrollY;
          scrollTo({ top: top - innerHeight - 128, behavior: 'instant' });
          await new Promise(resolve => setTimeout(resolve, 80));
          const frames = [];
          for (let i = 0; i < 110; i++) {
            scrollBy({ top: 6, behavior: 'instant' });
            await new Promise(requestAnimationFrame);
            const rect = el.getBoundingClientRect();
            if (rect.top < innerHeight - 2 && rect.bottom > 0) {
              frames.push(Number(getComputedStyle(el).opacity));
            }
          }
          return frames;
        });
        assert.ok(frames.length > 20, 'not enough visible frames');
        for (let i = 1; i < frames.length; i++) {
          assert.ok(frames[i] >= frames[i - 1] - .01, `opacity dropped ${frames[i - 1]} -> ${frames[i]}`);
        }
        assert.ok(frames.some(opacity => opacity > 0 && opacity < .95), 'no gradual entrance');
        await page.waitForTimeout(900);
        await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
        await page.waitForTimeout(80);
        const opacity = await page.locator('.highlight').first().evaluate(async el => {
          el.scrollIntoView({ behavior: 'instant', block: 'center' });
          await new Promise(requestAnimationFrame);
          return Number(getComputedStyle(el).opacity);
        });
        assert.equal(opacity, 1, 'visited cards should stay visible');
      });
      await record(`keyboard focus and reduced motion reveal pending content at ${width}px`, async () => {
        await page.locator('.plan a').first().focus();
        assert.equal(await page.locator('.plan').first().evaluate(el => getComputedStyle(el).opacity), '1');
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.waitForTimeout(80);
        assert.ok(await page.locator('[data-reveal]').evaluateAll(elements => elements.every(el => getComputedStyle(el).opacity === '1')));
        assert.equal(await page.evaluate(() => document.getAnimations().filter(a => a.playState !== 'finished').length), 0);
      });
    } finally { await page.close(); }
  }
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  let releaseScript;
  const gate = new Promise(resolve => { releaseScript = resolve; });
  try {
    await page.route('**/_astro/*.js', async route => { await gate; await route.continue(); });
    await page.goto(url, { waitUntil: 'commit' });
    await page.locator('.plan').first().waitFor();
    await page.locator('.plan').first().evaluate(el => el.scrollIntoView({ behavior: 'instant', block: 'center' }));
    await record('late JavaScript never hides content already on screen', async () => {
      const samples = page.locator('.plan').first().evaluate(async el => {
        const values = [];
        for (let i = 0; i < 90; i++) {
          await new Promise(requestAnimationFrame);
          values.push(Number(getComputedStyle(el).opacity));
        }
        return values;
      });
      releaseScript();
      assert.ok((await samples).every(value => value === 1), 'late script reset visible content');
    });
  } finally { releaseScript(); await page.close(); }
}

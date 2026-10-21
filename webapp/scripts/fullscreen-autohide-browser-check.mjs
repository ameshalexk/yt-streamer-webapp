// Offline browser regression for the shared Mac/HA fullscreen player controls.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, playlists: [], items: [], sessions: [], data: [] }));
    return;
  }
  const full = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
  if (!full.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  try {
    res.writeHead(200, { 'content-type': mime[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(await fs.readFile(full));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.MOBILE_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox'] });
  for (const device of [{ name: 'mouse', hasTouch: false, isMobile: false }, { name: 'touch', hasTouch: true, isMobile: true }]) {
    const page = await browser.newPage({ viewport: { width: 900, height: 800 }, ...device });
    await page.clock.install();
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.setMode === 'function' && typeof window.showFullscreenOverlays === 'function', { timeout: 10000 });
    await page.evaluate(() => {
      window.setMode('watch');
      const screen = document.querySelector('#screen');
      screen.classList.add('playing', 'cyberdash-mode');
      screen.classList.remove('loading');
      document.querySelector('#pauseBtn').disabled = false;
      cyberdashPlayer = { isActive: () => true, pause: async () => {}, resume: async () => {} };
      playbackPaused = false;
      document.querySelector('#streamNotice').hidden = true;
      setSyntheticFullscreen(true);
      showFullscreenOverlays();
    });
    await page.locator('#pauseBtn').click();
    assert.equal(await page.evaluate(() => playbackPaused), true, `${device.name}: pause did not engage`);
    await page.clock.fastForward(5500);
    assert.equal(await page.locator('body').evaluate(el => el.classList.contains('fullscreen-controls-idle')), false, `${device.name}: paused controls disappeared`);
    await page.locator('#pauseBtn').click();
    await page.waitForFunction(() => playbackPaused === false);
    await page.clock.fastForward(5500);
    assert.equal(await page.locator('body').evaluate(el => el.classList.contains('fullscreen-controls-idle')), true,
      `${device.name}: controls did not auto-hide after tapping Resume and waiting 5 seconds`);
    // Releasing a finger off the controls bar must not strand the interaction flag.
    await page.evaluate(() => {
      const screen = document.querySelector('#screen');
      const button = document.querySelector('#pauseBtn');
      showFullscreenOverlays();
      const options = { bubbles: true, pointerId: 37, pointerType: 'touch' };
      button.dispatchEvent(new PointerEvent('pointerdown', options));
      if (!screen.classList.contains('controls-interacting')) {
        throw new Error('Regression fixture did not trigger the controls interaction');
      }
      document.dispatchEvent(new PointerEvent('pointerup', options));
    });
    await page.clock.fastForward(5500);
    assert.equal(await page.locator('body').evaluate(el => el.classList.contains('fullscreen-controls-idle')), true,
      `${device.name}: releasing outside the controls bar permanently disables auto-hide`);
    // Focus left on a button after keyboard or touchscreen Resume must also time out.
    await page.evaluate(() => {
      document.querySelector('#pauseBtn').focus();
      document.querySelector('#pauseBtn').dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    await page.clock.fastForward(5500);
    assert.equal(await page.locator('body').evaluate(el => el.classList.contains('fullscreen-controls-idle')), true,
      `${device.name}: focused Resume button kept controls visible indefinitely`);
    await page.close();
    console.log(`PASS ${device.name}: pause, resume, off-bar release and focused-button idle`);
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}

#!/usr/bin/env node
/**
 * Office ribbon check (manual, NOT part of CI).
 *
 * Serves a built `dist/`, opens Office in Chromium, creates a new document in each
 * editor (Writer, Calc, Impress) at several window widths, and checks that:
 *   - the editor opens on the Home tab (never on File);
 *   - on every ribbon tab no visible control renders outside the browser window
 *     (a control scrolled out of the tool row is clipped, not "outside");
 *   - the page itself never scrolls sideways;
 *   - the console stays free of errors.
 *
 * Usage:
 *   npm run build
 *   node scripts/office-ribbon-check.mjs [--dist dist] [--shots DIR] [--prefix NAME]
 *
 * Playwright is not a dependency of this repository: the script imports it from
 * `PLAYWRIGHT_MODULE` (a path to playwright's index.mjs) or from a global install,
 * and uses the browsers under `PLAYWRIGHT_BROWSERS_PATH`. It never installs anything.
 * Exit code 1 when any check fails.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const DIST = path.resolve(arg('dist', 'dist'));
const SHOTS = arg('shots', '');
const PREFIX = arg('prefix', 'ribbon');
const PORT = Number(arg('port', '4187'));
const WIDTHS = (arg('widths', '1280,1024,800,390')).split(',').map(Number);
const THEMES = (arg('themes', 'dark,light')).split(',');

async function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/node22/lib/node_modules/playwright/index.mjs'].filter(Boolean);
  for (const c of candidates) {
    try { return await import(c); } catch { /* next */ }
  }
  throw new Error('Playwright not found: set PLAYWRIGHT_MODULE to playwright/index.mjs');
}

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  let p = path.join(DIST, decodeURIComponent((req.url ?? '/').split('?')[0]));
  if (!p.startsWith(DIST) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
}).listen(PORT);

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const failures = [];
const log = (line) => { console.log(line); };

/**
 * Controls whose *visible* part (after every clipping ancestor) lies outside the window, and
 * how many ribbon controls are scrolled out of the tool row (allowed only with a scroll arrow).
 */
function offscreenControls() {
  const out = [];
  let clipped = 0;
  const vw = window.innerWidth;
  for (const b of document.querySelectorAll('.faisal-office button, .faisal-office select')) {
    if (!b.checkVisibility?.() && !b.offsetParent) continue;
    let r = b.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    let left = r.left, right = r.right;
    for (let a = b.parentElement; a && left < right; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX !== 'visible') {
        const ar = a.getBoundingClientRect();
        left = Math.max(left, ar.left);
        right = Math.min(right, ar.right);
      }
    }
    if (right - left < r.width - 1 && b.closest('.fo-toolrow')) clipped++;
    if (left >= right) continue; // fully clipped (scrolled away): not rendered
    if (left < -1 || right > vw + 1) out.push(`${b.dataset.control ?? b.className}@${Math.round(left)}..${Math.round(right)}`);
  }
  const arrow = [...document.querySelectorAll('.fo-rscroll')].some((a) => a.checkVisibility?.());
  return { out, clipped, arrow };
}

async function run(kind, width, theme) {
  const height = width < 500 ? 844 : 800;
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, hasTouch: width < 500, isMobile: false });
  await ctx.addInitScript((t) => {
    localStorage.setItem('faisal.settings.v1', JSON.stringify({
      'apps.installState': { removed: [], added: ['org.faisal.Office'] }, 'shell.firstRunDone': true, theme: t,
    }));
  }, theme);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  const tag = `${kind}@${width}/${theme}`;
  try {
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForTimeout(2000);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Alt+F1');
    await page.waitForTimeout(600);
    const icon = page.locator('[data-app-id="org.faisal.Office"]').first();
    if (await icon.count()) await icon.dblclick();
    else { await page.keyboard.type('Office'); await page.waitForTimeout(300); await page.keyboard.press('Enter'); }
    await page.waitForSelector('.faisal-office .fo-start', { timeout: 15000 });
    await page.waitForTimeout(400);
    if (SHOTS && kind === 'docx') await page.screenshot({ path: path.join(SHOTS, `${PREFIX}-start-${width}-${theme}.png`) });
    await page.locator(`.fo-card-${kind}`).click();
    await page.waitForSelector('.faisal-office .fo-body > :not(.fo-start)', { timeout: 15000 });
    await page.waitForTimeout(1200);
    const phone = !(await page.locator('.fo-ribbon').isVisible());
    const activeTab = phone ? '(phone)' : await page.locator('.fo-ribbon .fo-tab[aria-selected="true"]').getAttribute('data-tab');
    if (!phone && activeTab !== 'home') failures.push(`${tag}: opened on "${activeTab}", expected "home"`);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${PREFIX}-${kind}-${width}-${theme}.png`) });
    const tabs = phone ? [] : await page.locator('.fo-ribbon .fo-tab').all();
    const report = [];
    for (const t of tabs.length ? tabs : [null]) {
      if (t) { await t.click(); await page.waitForTimeout(150); }
      const id = t ? await t.getAttribute('data-tab') : 'phone';
      const { out: bad, clipped, arrow } = await page.evaluate(offscreenControls);
      if (clipped && !arrow) failures.push(`${tag} tab ${id}: ${clipped} control(s) cut off by the tool row with no scroll arrow`);
      const sideScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      const modes = await page.evaluate(() => [...document.querySelectorAll('.fo-toolpanel:not([hidden]) .fo-group')].map((g) => (g.dataset.mode ?? 'full')[0]).join(''));
      report.push(`${id}[${modes}]`);
      if (bad.length) failures.push(`${tag} tab ${id}: ${bad.length} control(s) outside the window: ${bad.slice(0, 4).join(', ')}`);
      if (sideScroll) failures.push(`${tag} tab ${id}: the page scrolls sideways`);
    }
    log(`${tag}: opened on ${activeTab}; ${report.join(' ')}`);
  } catch (e) {
    failures.push(`${tag}: step failed: ${String(e).split('\n')[0]}`);
  }
  if (errors.length) failures.push(`${tag}: console errors: ${errors.slice(0, 3).join(' | ')}`);
  await ctx.close();
}

for (const width of WIDTHS) {
  for (const theme of THEMES) {
    for (const kind of ['docx', 'xlsx', 'pptx']) await run(kind, width, theme);
  }
}
await browser.close();
server.close();
if (failures.length) {
  console.log(`\nFAILED (${failures.length}):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\nAll ribbon checks passed.');

import { loadChromium } from './playwright-loader.mjs';

const chromium = await loadChromium();

const url = process.argv[2] || 'http://127.0.0.1:4173/';
const out = process.argv[3] || '/tmp/shot.png';
const theme = process.argv[4] || 'light';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1600 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
});
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
page.on('requestfailed', (req) => errors.push(`requestfailed: ${req.url()} ${req.failure()?.errorText}`));

await page.addInitScript((t) => localStorage.setItem('theme', t), theme);
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('.m-cell', { timeout: 20000 });
await page.waitForTimeout(1500);
if (theme === 'dark') await page.waitForTimeout(800);

const summary = await page.evaluate(() => {
  const text = (sel) => document.querySelector(sel)?.textContent?.trim() || null;
  const count = (sel) => document.querySelectorAll(sel).length;
  const tile = (id) => ({
    value: text(`#${id}-value`),
    meta: text(`#${id}-meta`)
  });
  const chartSizes = [...document.querySelectorAll('.chart-svg')].map((s) => ({
    w: s.getBoundingClientRect().width,
    h: s.getBoundingClientRect().height,
    paths: s.querySelectorAll('path').length,
    texts: s.querySelectorAll('text').length
  }));
  return {
    title: document.title,
    dataset: text('#dataset-chip'),
    tiles: {
      train: tile('tile-train'),
      holdout: tile('tile-holdout'),
      probe: tile('tile-probe'),
      coverage: tile('tile-coverage')
    },
    notices: [...document.querySelectorAll('.notice-title')].map((n) => n.textContent.trim()),
    cells: count('.m-cell'),
    unclickableMissing: count('.m-cell--cross-block'),
    drawerHidden: document.querySelector('#cell-drawer').hidden,
    charts: chartSizes,
    curveNote: text('#curve-note'),
    sweepNote: text('#sweep-note'),
    batchRows: [...document.querySelectorAll('.batch-row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()),
    diag: [...document.querySelectorAll('.diag-title')].map((n) => n.textContent.trim()),
    fitRows: count('#fit-table tbody tr'),
    supportRows: count('#support-wrap tbody tr'),
    recordRows: count('#records-table tbody tr'),
    hasNaN: /NaN|undefined|Infinity/.test(document.body.innerText),
    bodyHeight: document.body.scrollHeight
  };
});
console.log(JSON.stringify({ summary, errors }, null, 2));
await page.screenshot({ path: out, fullPage: true });
await browser.close();

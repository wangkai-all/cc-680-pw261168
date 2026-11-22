import { loadChromium } from './playwright-loader.mjs';

const chromium = await loadChromium();

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu', '--single-process'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' });
await page.waitForSelector('.m-cell');
await page.waitForTimeout(800);

const report = {};

// 1. Open a completed cell drawer
const completedCell = page.locator('.m-cell[aria-label*="可补全"]').first();
await completedCell.click();
await page.waitForTimeout(600);
report.drawer = await page.evaluate(() => ({
  open: !document.querySelector('#cell-drawer').hidden,
  title: document.querySelector('#drawer-title').textContent,
  kicker: document.querySelector('#drawer-kicker').textContent,
  sections: [...document.querySelectorAll('.drawer-section-title')].map((n) => n.textContent),
  svgs: document.querySelectorAll('#drawer-body .chart-svg').length,
  text: document.querySelector('#drawer-body').innerText.replace(/\s+/g, ' ').slice(0, 500)
}));
await page.screenshot({ path: '/tmp/drawer.png' });
await page.click('#drawer-close');
report.drawerClosed = await page.evaluate(() => document.querySelector('#cell-drawer').hidden);

// 2. Open a cross-block cell
await page.locator('.m-cell--cross-block').first().click();
await page.waitForTimeout(400);
report.crossDrawer = await page.evaluate(() => ({
  title: document.querySelector('#drawer-title').textContent,
  text: document.querySelector('#drawer-body').innerText.replace(/\s+/g, ' ').slice(0, 300)
}));
await page.click('#drawer-close');

// 3. Switch views
for (const view of ['status', 'residual', 'stability', 'estimate']) {
  await page.selectOption('#matrix-view', view);
  await page.waitForTimeout(250);
  report[`view_${view}`] = await page.evaluate(() => ({
    legend: document.querySelector('#matrix-legend').innerText.replace(/\s+/g, ' ').slice(0, 160),
    scale: document.querySelector('#matrix-scale').innerText.replace(/\s+/g, ' ').slice(0, 160),
    styled: document.querySelectorAll('.m-cell[style]').length,
    blankMissing: document.querySelectorAll('.m-cell--cross-block .cell-mark').length
  }));
}

// 4. Apply a probe preset
await page.selectOption('#probe-preset', 'flagship-core');
await page.waitForTimeout(200);
await page.click('#probe-apply');
await page.waitForTimeout(1800);
report.probe = await page.evaluate(() => ({
  badge: document.querySelector('#probe-state').textContent,
  probeValue: document.querySelector('#tile-probe-value').textContent,
  probeMeta: document.querySelector('#tile-probe-meta').textContent,
  probeCells: document.querySelectorAll('.m-cell--observed-probe').length,
  notices: [...document.querySelectorAll('.notice-title')].map((n) => n.textContent),
  revealDisabled: document.querySelector('#probe-reveal').disabled
}));
await page.screenshot({ path: '/tmp/probe.png' });

// 5. Restore
await page.click('#probe-reveal');
await page.waitForTimeout(1500);
report.restored = await page.evaluate(() => ({
  badge: document.querySelector('#probe-state').textContent,
  probeCells: document.querySelectorAll('.m-cell--observed-probe').length,
  probeValue: document.querySelector('#tile-probe-value').textContent
}));

// 6. High lambda -> collapse
await page.evaluate(() => {
  const input = document.querySelector('#lambda-input');
  input.value = '92';
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(1600);
report.collapse = await page.evaluate(() => ({
  lambda: document.querySelector('#lambda-value').textContent,
  diag: [...document.querySelectorAll('.diag-title')].map((n) => n.textContent),
  collapseText: document.querySelector('#diag-collapse').innerText.replace(/\s+/g, ' ').slice(0, 220),
  notices: [...document.querySelectorAll('.notice-title')].map((n) => n.textContent)
}));
await page.screenshot({ path: '/tmp/collapse.png' });

// 7. High rank + low lambda via controls -> not converged
await page.evaluate(() => {
  const r = document.querySelector('#rank-input');
  r.value = '5'; r.dispatchEvent(new Event('input', { bubbles: true }));
  const l = document.querySelector('#lambda-input');
  l.value = '0'; l.dispatchEvent(new Event('input', { bubbles: true }));
  const i = document.querySelector('#inits-input');
  i.value = '2'; i.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(2500);
report.notConverged = await page.evaluate(() => ({
  rank: document.querySelector('#rank-value').textContent,
  lambda: document.querySelector('#lambda-value').textContent,
  diag: [...document.querySelectorAll('.diag-title')].map((n) => n.textContent),
  convText: document.querySelector('#diag-convergence').innerText.replace(/\s+/g, ' ').slice(0, 200),
  stabilityText: document.querySelector('#diag-stability').innerText.replace(/\s+/g, ' ').slice(0, 200)
}));

// Reset defaults via reload
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

// 8. Holdout: deselect all batches
await page.click('#holdout-none');
await page.waitForTimeout(1500);
report.noHoldout = await page.evaluate(() => ({
  tile: document.querySelector('#tile-holdout-value').textContent,
  meta: document.querySelector('#tile-holdout-meta').textContent,
  notices: [...document.querySelectorAll('.notice-title')].map((n) => n.textContent),
  batchEmpty: document.querySelector('#batch-errors').innerText.slice(0, 120)
}));

// 9. Table filter holdout
await page.click('#holdout-default');
await page.waitForTimeout(1500);
await page.selectOption('#table-filter', 'holdout');
await page.waitForTimeout(300);
report.holdoutTable = await page.evaluate(() => ({
  count: document.querySelector('#table-count').textContent,
  firstRow: document.querySelector('#records-table tbody tr')?.innerText.replace(/\s+/g, ' ')
}));

// 10. Dark theme
await page.click('#theme-toggle');
await page.waitForTimeout(700);
report.dark = await page.evaluate(() => ({
  theme: document.documentElement.dataset.theme,
  chartTexts: [...document.querySelectorAll('.chart-text')].slice(0, 2).map((n) => getComputedStyle(n).fill),
  hasNaN: /NaN|undefined/.test(document.body.innerText)
}));
await page.screenshot({ path: '/tmp/dark.png', fullPage: true });

console.log(JSON.stringify({ report, errors }, null, 2));
await browser.close();

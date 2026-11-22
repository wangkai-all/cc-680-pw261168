import { loadChromium } from './playwright-loader.mjs';

const chromium = await loadChromium();

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu', '--single-process'] });
const errors = [];

// ---- Desktop: custom probe ------------------------------------------------
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' });
await page.waitForSelector('.m-cell');
await page.waitForTimeout(700);

await page.selectOption('#probe-preset', 'custom');
await page.waitForTimeout(200);
const selects = page.locator('#custom-probe select');
await selects.nth(0).selectOption('S05');
await page.waitForTimeout(150);
await selects.nth(1).selectOption('Q03');
await page.waitForTimeout(150);
const preview = await page.evaluate(() => document.querySelector('#custom-probe').innerText.replace(/\s+/g, ' '));
await page.click('#probe-apply');
await page.waitForTimeout(1800);
const applied = await page.evaluate(() => ({
  badge: document.querySelector('#probe-state').textContent,
  tile: document.querySelector('#tile-probe-value').textContent,
  meta: document.querySelector('#tile-probe-meta').textContent,
  probeCells: document.querySelectorAll('.m-cell--observed-probe').length,
  desc: document.querySelector('#probe-preset-desc').textContent
}));
await page.click('#probe-reveal');
await page.waitForTimeout(1400);
const restored = await page.evaluate(() => ({
  badge: document.querySelector('#probe-state').textContent,
  probeCells: document.querySelectorAll('.m-cell--observed-probe').length,
  tile: document.querySelector('#tile-probe-value').textContent
}));

// ---- Desktop: residue view never paints completed cells with zero ---------
await page.selectOption('#matrix-view', 'residual');
await page.waitForTimeout(300);
const residual = await page.evaluate(() => {
  const cells = [...document.querySelectorAll('.m-cell')];
  const zeros = cells.filter((c) => c.classList.contains('m-cell--completed') && /^[+−]0\.00$/.test(c.innerText.trim()));
  return {
    styled: cells.filter((c) => c.style.backgroundColor).length,
    completedMarked: zeros.length,
    footnote: document.querySelector('#matrix-foot').innerText.includes('不是 0 分')
  };
});

// ---- Mobile viewport ------------------------------------------------------
const mobileBrowser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu', '--single-process'] });
const mobile = await mobileBrowser.newPage({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true
});
mobile.on('pageerror', (e) => errors.push(`mobile pageerror: ${e.message}`));
mobile.on('console', (m) => { if (m.type() === 'error') errors.push(`mobile console: ${m.text()}`); });
await mobile.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' });
await mobile.waitForSelector('.m-cell');
await mobile.waitForTimeout(900);
const mobileSummary = await mobile.evaluate(() => {
  const doc = document.documentElement;
  const overflow = [...document.querySelectorAll('body *')]
    .filter((n) => n.getBoundingClientRect().right > window.innerWidth + 2)
    .filter((n) => !n.closest('.matrix-wrap') && !n.closest('.data-table'))
    .slice(0, 5)
    .map((n) => `${n.tagName}.${n.className}`);
  return {
    viewport: window.innerWidth,
    scrollWidth: doc.scrollWidth,
    horizontalOverflow: doc.scrollWidth > window.innerWidth + 2,
    offenders: overflow,
    tiles: [...document.querySelectorAll('.tile-value')].map((n) => n.textContent),
    hasNaN: /NaN|undefined/.test(document.body.innerText)
  };
});
await mobile.screenshot({ path: '/tmp/mobile.png', fullPage: true });

// ---- Dark screenshot at full height --------------------------------------
await page.click('#theme-toggle');
await page.waitForTimeout(700);
await page.screenshot({ path: '/tmp/dark2.png', fullPage: true });

console.log(JSON.stringify({ preview, applied, restored, residual, mobileSummary, errors }, null, 2));
await mobileBrowser.close();
await browser.close();

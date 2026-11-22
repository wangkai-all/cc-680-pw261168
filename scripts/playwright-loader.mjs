/**
 * Loads playwright-core for the dev-only screenshot scripts.
 *
 * playwright-core is intentionally not a project dependency: it is only used
 * to verify rendering during development. Point PLAYWRIGHT_CORE at an
 * installation, or install it in a scratch directory:
 *
 *   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core/index.js node scripts/screenshot.mjs
 */
export async function loadChromium() {
  const candidates = [
    process.env.PLAYWRIGHT_CORE,
    'playwright-core',
    'playwright'
  ].filter(Boolean);
  let lastError;
  for (const specifier of candidates) {
    try {
      const mod = await import(specifier);
      const chromium = mod.chromium || mod.default?.chromium;
      if (chromium) return chromium;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `无法载入 playwright-core（${lastError?.message || '未找到'}）。` +
    '请设置 PLAYWRIGHT_CORE 指向 playwright-core/index.js，或安装 playwright-core。'
  );
}

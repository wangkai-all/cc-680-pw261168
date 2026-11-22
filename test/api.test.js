import test from 'node:test';
import { after, before } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { createApp, exportCsv } from '../server/index.js';
import { generateDataset } from '../server/data.js';
import { createServer } from 'node:http';

let server;
let base;

const dataset = generateDataset();

before(async () => {
  server = createServer(createApp(dataset));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function post(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

test('health and dataset endpoints describe the generated data', async () => {
  const health = await (await fetch(`${base}/api/health`)).json();
  strictEqual(health.ok, true);
  strictEqual(health.seed, dataset.meta.seed);
  strictEqual(health.rows, dataset.stores.length);

  const payload = await (await fetch(`${base}/api/dataset`)).json();
  strictEqual(payload.stores.length, dataset.stores.length);
  strictEqual(payload.items.length, dataset.items.length);
  strictEqual(payload.observations.length, dataset.observations.length);
  ok(payload.presets.length >= 3);
  for (const preset of payload.presets) {
    ok(preset.storeIds.length > 0 && preset.itemIds.length > 0);
  }
});

test('analyze endpoint returns the same structure the page renders', async () => {
  const { status, body } = await post('/api/analyze', { rank: 2, lambda: 1.2, inits: 3 });
  strictEqual(status, 200);
  strictEqual(body.config.rank, 2);
  strictEqual(body.config.lambda, 1.2);
  strictEqual(body.cells.length, dataset.stores.length * dataset.items.length);
  ok(body.errors.train.count > 0);
  ok(body.errors.holdout.count > 0);
  strictEqual(body.probeReport.active, false);
  ok(body.warnings.length > 0);
});

test('analyze endpoint rejects invalid complexity with HTTP 400', async () => {
  strictEqual((await post('/api/analyze', { rank: 9 })).status, 400);
  strictEqual((await post('/api/analyze', { lambda: 1000 })).status, 400);
  const bad = await fetch(`${base}/api/analyze`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops'
  });
  strictEqual(bad.status, 400);
});

test('sweep endpoint returns all points with explicit holdout gaps', async () => {
  const rank = await post('/api/sweep', { axis: 'rank', holdoutBatches: [] });
  strictEqual(rank.status, 200);
  strictEqual(rank.body.axis, 'rank');
  strictEqual(rank.body.points.length, 6);
  for (const point of rank.body.points) {
    strictEqual(point.holdout.rmse, null);
    strictEqual(point.evaluatedHoldoutCount, 0);
    ok(point.train.count > 0);
  }

  const lambda = await post('/api/sweep', { axis: 'lambda', rank: 2 });
  strictEqual(lambda.body.points.length, 7);
  for (const point of lambda.body.points) {
    ok(point.holdout.count > 0);
    ok(typeof point.collapsed === 'boolean');
  }
});

test('probe via API masks known cells and reveals them again', async () => {
  const payload = await (await fetch(`${base}/api/dataset`)).json();
  const preset = payload.presets.find((p) => p.id === 'flagship-core');
  const masked = await post('/api/analyze', {
    probe: { storeIds: preset.storeIds, itemIds: preset.itemIds, label: preset.label }
  });
  strictEqual(masked.body.probeReport.active, true);
  strictEqual(masked.body.cellCounts.probe, masked.body.probeReport.knownCells);
  ok(masked.body.errors.probe.count > 0);

  const revealed = await post('/api/analyze', { probe: null });
  strictEqual(revealed.body.probeReport.active, false);
  strictEqual(revealed.body.cellCounts.probe, 0);
  strictEqual(revealed.body.errors.probe, null);
});

test('CSV export keeps missing cells blank and labels statuses', async () => {
  const res = await fetch(`${base}/api/export`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
  strictEqual(res.status, 200);
  ok(res.headers.get('content-type').startsWith('text/csv'));
  const text = await res.text();
  const lines = text.replace(/^﻿/, '').split('\n');
  strictEqual(lines.length, dataset.stores.length * dataset.items.length + 1);
  ok(lines[0].includes('门店编码') && lines[0].includes('补全值'));
  ok(lines.some((line) => line.includes('跨块无依据')));
  ok(lines.some((line) => line.includes('可补全')));
});

test('exportCsv leaves unknown cells blank rather than zero', () => {
  const result = {
    cells: [
      { storeId: 'S01', itemId: 'Q01', status: 'completed', observed: false, estimate: 3.21, rowTrainRange: { count: 4 }, colTrainRange: { count: 5 } },
      { storeId: 'S01', itemId: 'Q02', status: 'cross-block', observed: false, rowTrainRange: { count: 4 }, colTrainRange: { count: 2 } }
    ]
  };
  const csv = exportCsv(result, new Map([['S01', { name: '门店甲' }]]), new Map());
  const rows = csv.replace(/^﻿/, '').split('\n');
  strictEqual(rows.length, 3);
  const cross = rows[2].split(',');
  strictEqual(cross[4], '跨块无依据');
  strictEqual(cross[5], '', 'no fabricated raw rating');
  strictEqual(cross[6], '', 'no fabricated estimate, and definitely not 0');
});

test('static files are served and path traversal is refused', async () => {
  const index = await fetch(`${base}/`);
  strictEqual(index.status, 200);
  ok((await index.text()).includes('门店体验评分补全实验室'));

  const app = await fetch(`${base}/app.js`);
  strictEqual(app.status, 200);
  strictEqual(app.headers.get('x-content-type-options'), 'nosniff');

  const missing = await fetch(`${base}/nope.js`);
  strictEqual(missing.status, 404);
});

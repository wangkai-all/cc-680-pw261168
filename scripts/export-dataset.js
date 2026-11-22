/**
 * Writes a frozen snapshot of the locally generated dataset to data/.
 *
 *   npm run export:data
 *
 * The server itself always regenerates the dataset from the fixed seed, so the
 * snapshot exists for inspection and for downstream tooling — never as an
 * input that could drift from the seed.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDataset } from '../server/data.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = join(ROOT, 'data');
const dataset = generateDataset();

await mkdir(OUT_DIR, { recursive: true });

const snapshot = {
  meta: dataset.meta,
  stores: dataset.stores,
  items: dataset.items,
  batches: dataset.batches,
  observations: dataset.observations
};
await writeFile(join(OUT_DIR, 'dataset.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

function escape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

const storeName = new Map(dataset.stores.map((s) => [s.id, s.name]));
const itemName = new Map(dataset.items.map((i) => [i.id, i.name]));
const batchLabel = new Map(dataset.batches.map((b) => [b.id, b.label]));

const rows = [['门店编码', '门店', '评分项编码', '评分项', '批次', '批次名称', '问卷块', '评分']];
for (const obs of dataset.observations) {
  rows.push([
    obs.storeId, storeName.get(obs.storeId) || '',
    obs.itemId, itemName.get(obs.itemId) || '',
    obs.batchId, batchLabel.get(obs.batchId) || '',
    obs.block, obs.value
  ]);
}
await writeFile(
  join(OUT_DIR, 'observations.csv'),
  `﻿${rows.map((row) => row.map(escape).join(',')).join('\n')}\n`,
  'utf8'
);

console.log(`已写出 ${dataset.observations.length} 个观测：`);
console.log(`  ${join(OUT_DIR, 'dataset.json')}`);
console.log(`  ${join(OUT_DIR, 'observations.csv')}`);

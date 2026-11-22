import test from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import {
  generateDataset, CORE_BATCHES, OUTLET_BATCHES, NEVER_OBSERVED_STORE_NAMES,
  DEFAULT_HOLDOUT_BATCHES
} from '../server/data.js';

const dataset = generateDataset();

test('dataset generation is deterministic for a fixed seed', () => {
  const again = generateDataset();
  deepStrictEqual(again.observations, dataset.observations);
  deepStrictEqual(again.meta, dataset.meta);
});

test('every rating is a single rating inside exactly one survey batch', () => {
  const batchIds = new Set(dataset.batches.map((b) => b.id));
  const seen = new Set();
  for (const obs of dataset.observations) {
    ok(batchIds.has(obs.batchId), `observation ${obs.id} references an existing batch`);
    const key = `${obs.storeId}\u0001${obs.itemId}`;
    ok(!seen.has(key), `cell ${key} has at most one raw rating`);
    seen.add(key);
    ok(obs.value >= 1 && obs.value <= 5, `rating ${obs.value} is inside 1–5`);
    strictEqual(obs.observed, true);
  }
});

test('missingness is non-uniform and substantial', () => {
  const { observedRate, missingCells, observedCells, totalCells } = dataset.meta;
  strictEqual(totalCells, dataset.stores.length * dataset.items.length);
  strictEqual(observedCells + missingCells, totalCells);
  ok(observedRate > 0.25 && observedRate < 0.6, `observed rate ${observedRate} is partial`);

  const storeCounts = new Set(dataset.stores.map((s) => s.observedCount));
  ok(storeCounts.size > 5, 'store observation counts vary');
  const itemCounts = new Set(dataset.items.map((i) => i.observedCount));
  ok(itemCounts.size > 3, 'item observation counts vary');
});

test('there are rows and columns that were never observed', () => {
  const unseenStores = dataset.stores.filter((s) => s.observedCount === 0);
  const unseenItems = dataset.items.filter((i) => i.observedCount === 0);
  strictEqual(unseenStores.length, NEVER_OBSERVED_STORE_NAMES.length);
  strictEqual(unseenItems.length, 1);
  strictEqual(unseenItems[0].name, '屋顶露台体验');
  strictEqual(unseenStores.some((s) => s.name === '新城筹备店'), true);
});

test('survey batches split into two disconnected instruments', () => {
  strictEqual(CORE_BATCHES.length, 8);
  strictEqual(OUTLET_BATCHES.length, 4);
  const coreObs = dataset.observations.filter((o) => o.batchId.startsWith('W'));
  const outletObs = dataset.observations.filter((o) => o.batchId.startsWith('O'));
  ok(coreObs.every((o) => o.block === 'core'));
  ok(outletObs.every((o) => o.block === 'outlet'));
  // No store or item belongs to both instruments.
  const coreStores = new Set(coreObs.map((o) => o.storeId));
  const outletStores = new Set(outletObs.map((o) => o.storeId));
  for (const id of coreStores) strictEqual(outletStores.has(id), false);
});

test('default batch holdout covers whole batches and leaves training support', () => {
  deepStrictEqual(dataset.meta.defaultHoldoutBatches, DEFAULT_HOLDOUT_BATCHES);
  const held = new Set(DEFAULT_HOLDOUT_BATCHES);
  for (const batchId of held) {
    ok(dataset.batches.some((b) => b.id === batchId), `holdout batch ${batchId} exists`);
  }
  const observedStores = dataset.stores.filter((s) => s.observedCount > 0);
  const observedItems = dataset.items.filter((i) => i.observedCount > 0);
  for (const store of observedStores) {
    const training = dataset.observations.filter((o) => o.storeId === store.id && !held.has(o.batchId));
    ok(training.length > 0, `store ${store.name} keeps a training rating under the default holdout`);
  }
  for (const item of observedItems) {
    const training = dataset.observations.filter((o) => o.itemId === item.id && !held.has(o.batchId));
    ok(training.length > 0, `item ${item.name} keeps a training rating under the default holdout`);
  }
});

test('batch labels and counts are consistent', () => {
  for (const batch of dataset.batches) {
    const count = dataset.observations.filter((o) => o.batchId === batch.id).length;
    strictEqual(batch.observationCount, count, `batch ${batch.id} count`);
  }
  const sum = dataset.batches.reduce((acc, b) => acc + b.observationCount, 0);
  strictEqual(sum, dataset.observations.length);
});

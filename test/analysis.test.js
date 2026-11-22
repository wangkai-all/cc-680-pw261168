import test from 'node:test';
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import { analyze } from '../server/analysis.js';
import { probePresets } from '../server/presets.js';
import { defaultDataset, assertNullMetrics } from './helpers.js';

const result = analyze(defaultDataset, {});

test('batch holdout never splits a questionnaire', () => {
  const held = new Set(defaultDataset.meta.defaultHoldoutBatches);
  const byBatch = new Map();
  for (const cell of result.cells) {
    if (!cell.observed) continue;
    if (!byBatch.has(cell.batchId)) byBatch.set(cell.batchId, new Set());
    byBatch.get(cell.batchId).add(cell.status);
  }
  for (const [batchId, statuses] of byBatch) {
    if (held.has(batchId)) {
      deepStrictEqual([...statuses], ['observed-holdout'], `held batch ${batchId} is wholly held out`);
    } else {
      deepStrictEqual([...statuses], ['observed-train'], `training batch ${batchId} is wholly in training`);
    }
  }
  // Every held observation is flagged, and none leaks into training records.
  const heldCells = result.cells.filter((c) => c.status === 'observed-holdout');
  strictEqual(heldCells.length, result.errors.holdoutObservationCount);
  for (const record of result.errorRecords.train) {
    strictEqual(held.has(record.batchId), false, `training record ${record.key} is not from a held batch`);
  }
  for (const record of result.errorRecords.holdout) {
    strictEqual(held.has(record.batchId), true, `holdout record ${record.key} comes from a held batch`);
  }
});

test('held-out batches are reported separately and evaluated on real ratings', () => {
  const batches = result.errors.perHoldoutBatch;
  strictEqual(batches.length, 2);
  strictEqual(batches.reduce((s, b) => s + b.observationCount, 0), result.errors.holdoutObservationCount);
  for (const batch of batches) {
    strictEqual(batch.metrics.count, batch.evaluatedCount);
    for (const record of result.errorRecords.holdout.filter((r) => r.batchId === batch.batchId)) {
      ok(Number.isFinite(record.truth), 'holdout record keeps its raw rating');
    }
    if (batch.evaluatedCount === 0) assertNullMetrics(batch.metrics, `batch ${batch.batchId}`);
  }
});

test('error metrics use only cells with a truth value, never unknown cells', () => {
  const allEvaluated = [
    ...result.errorRecords.train, ...result.errorRecords.holdout, ...result.errorRecords.probe
  ];
  strictEqual(result.errors.train.count, result.errorRecords.train.length);
  strictEqual(result.errors.holdout.count, result.errorRecords.holdout.length);
  for (const record of allEvaluated) {
    if (record.estimate == null) continue;
    ok(Number.isFinite(record.truth), `${record.key} has a real rating`);
  }
  // The residual map must not quietly contain zeros for missing cells.
  const zeros = result.cells.filter((c) => !c.observed && c.residual === 0);
  strictEqual(zeros.length, 0, 'missing cells carry no residual');
  for (const cell of result.cells) {
    if (!cell.observed) strictEqual(cell.value, undefined, 'missing cell keeps no fabricated value');
  }
});

test('unknown cells are never counted as zero error or a 0 estimate', () => {
  const unknown = result.cells.filter((c) => !c.observed);
  ok(unknown.length > 0);
  for (const cell of unknown) {
    if (cell.status !== 'completed') {
      strictEqual(cell.estimate, undefined, `${cell.key} (${cell.status}) must not receive an estimate`);
    }
    strictEqual(cell.value, undefined);
  }
  // A completed cell must have genuine training support on both axes.
  for (const cell of unknown.filter((c) => c.status === 'completed')) {
    ok(cell.rowTrainCount > 0, `${cell.key} row has training ratings`);
    ok(cell.colTrainCount > 0, `${cell.key} column has training ratings`);
    ok(cell.estimate >= 1 && cell.estimate <= 5, `${cell.key} estimate is on the rating scale`);
  }
});

test('no-observation rows and columns stay empty', () => {
  const unseenStores = defaultDataset.stores.filter((s) => s.observedCount === 0);
  const unseenItems = defaultDataset.items.filter((i) => i.observedCount === 0);
  ok(unseenStores.length > 0 && unseenItems.length > 0);

  for (const store of unseenStores) {
    const row = result.cells.filter((c) => c.storeId === store.id);
    strictEqual(row.length, defaultDataset.items.length);
    for (const cell of row) {
      strictEqual(cell.status, 'no-row-observations', `${store.name} × ${cell.itemId}`);
      strictEqual(cell.estimate, undefined);
    }
    const supported = result.support.rows.find((r) => r.id === store.id);
    strictEqual(supported.componentId, null);
    strictEqual(supported.trainComponentId, null);
  }
  for (const item of unseenItems) {
    const col = result.cells.filter((c) => c.itemId === item.id);
    for (const cell of col) {
      // Rows with no ratings themselves take precedence, but no row here may be completed.
      ok(['no-item-observations', 'no-row-observations'].includes(cell.status), `${cell.key} is ${cell.status}`);
      strictEqual(cell.estimate, undefined);
    }
  }
  const notice = result.warnings.find((w) => w.code === 'NEVER_OBSERVED');
  ok(notice, 'never-observed warning is present');
  ok(notice.message.includes('新城筹备店'));
  ok(notice.message.includes('屋顶露台体验'));
});

test('disconnected blocks are detected and cells spanning them get no estimate', () => {
  const observedComponents = result.components.observed;
  strictEqual(observedComponents.length, 2);
  const notice = result.warnings.find((w) => w.code === 'DISCONNECTED_BLOCKS');
  ok(notice, 'disconnected-block warning is present');
  ok(result.cellCounts.crossBlock > 0);

  const componentOfStore = new Map();
  const componentOfItem = new Map();
  for (const comp of observedComponents) {
    for (const id of comp.storeIds) componentOfStore.set(id, comp.id);
    for (const id of comp.itemIds) componentOfItem.set(id, comp.id);
  }
  for (const cell of result.cells) {
    if (cell.status !== 'cross-block') continue;
    strictEqual(cell.observed, false);
    strictEqual(cell.estimate, undefined);
    ok(componentOfStore.get(cell.storeId) !== componentOfItem.get(cell.itemId),
      `${cell.key} really spans two components`);
  }
  // Every unobserved cell whose row and column sit in different observed blocks
  // must be cross-block — no cross-block cell may be completed.
  for (const cell of result.cells) {
    if (cell.observed) continue;
    const rs = componentOfStore.get(cell.storeId);
    const cs = componentOfItem.get(cell.itemId);
    if (rs && cs && rs !== cs) strictEqual(cell.status, 'cross-block', `${cell.key} is cross-block`);
  }
});

test('estimates exist only inside a single training component', () => {
  for (const cell of result.cells) {
    if (cell.estimate == null) continue;
    const compId = cell.componentId;
    ok(compId, `${cell.key} has an attributed training component`);
    ok(result.components.training.some((c) => c.id === compId), `${compId} is a known training block`);
  }
  for (const cell of result.cells.filter((c) => c.status === 'completed')) {
    const comp = result.components.training.find((c) => c.id === cell.componentId);
    ok(comp, 'completed cell belongs to a training block');
    ok(comp.storeIds.includes(cell.storeId), 'its store is inside that block');
    ok(comp.itemIds.includes(cell.itemId), 'its item is inside that block');
  }
});

test('the probe masks a whole block and restores it without touching the data', () => {
  const preset = probePresets(defaultDataset).find((p) => p.id === 'flagship-core');
  const cfg = {
    probe: { storeIds: preset.storeIds, itemIds: preset.itemIds, label: preset.label }
  };
  const masked = analyze(defaultDataset, cfg);
  const S = new Set(preset.storeIds);
  const I = new Set(preset.itemIds);
  const known = defaultDataset.observations.filter((o) => S.has(o.storeId) && I.has(o.itemId));
  ok(known.length > 10);

  strictEqual(masked.cellCounts.probe, known.length);
  strictEqual(masked.probeReport.active, true);
  strictEqual(masked.probeReport.knownCells, known.length);
  ok(masked.probeReport.metrics.count > 0);
  strictEqual(masked.probeReport.metrics.count, masked.probeReport.evaluatedCells);
  strictEqual(masked.errors.train.count + known.filter((o) =>
    !defaultDataset.meta.defaultHoldoutBatches.includes(o.batchId)).length,
  result.errors.train.count, 'masked ratings leave the training set');

  for (const cell of masked.cells.filter((c) => c.status === 'observed-probe')) {
    ok(S.has(cell.storeId) && I.has(cell.itemId));
    ok(Number.isFinite(cell.value), 'masked cell keeps its raw rating for evaluation');
    ok(cell.estimate != null, 'masked cell is reconstructed from the remaining block');
  }

  // Restoring is just re-running without a probe: results match the original run.
  const restored = analyze(defaultDataset, {});
  strictEqual(restored.cellCounts.probe, 0);
  strictEqual(restored.errors.probe, null);
  deepStrictEqual(restored.cellCounts, result.cellCounts);
  deepStrictEqual(restored.cells.map((c) => c.estimate), result.cells.map((c) => c.estimate));
  strictEqual(defaultDataset.observations.length, 264, 'the source dataset was not mutated');
});

test('masked ratings do not influence the fit', () => {
  const preset = probePresets(defaultDataset).find((p) => p.id === 'flagship-core');
  const S = new Set(preset.storeIds);
  const I = new Set(preset.itemIds);
  const cfg = { probe: { storeIds: preset.storeIds, itemIds: preset.itemIds, label: preset.label } };
  const before = analyze(defaultDataset, cfg);

  const altered = structuredClone(defaultDataset);
  let changed = 0;
  for (const obs of altered.observations) {
    if (S.has(obs.storeId) && I.has(obs.itemId)) {
      obs.value = obs.value === 1 ? 5 : 1;
      changed += 1;
    }
  }
  ok(changed > 0);
  const after = analyze(altered, cfg);
  deepStrictEqual(after.cells.map((c) => c.estimate), before.cells.map((c) => c.estimate));
  ok(after.probeReport.metrics.rmse > before.probeReport.metrics.rmse,
    'the masked truth only affects probe evaluation, which is the point');
});

test('held-out ratings do not influence the fit', () => {
  const altered = structuredClone(defaultDataset);
  const held = new Set(defaultDataset.meta.defaultHoldoutBatches);
  let changed = 0;
  for (const obs of altered.observations) {
    if (held.has(obs.batchId)) { obs.value = 1; changed += 1; }
  }
  ok(changed > 0);
  const after = analyze(altered, {});
  deepStrictEqual(after.cells.map((c) => c.estimate), result.cells.map((c) => c.estimate));
  ok(after.errors.holdout.rmse > result.errors.holdout.rmse);
});

test('removing every held batch is reported as no holdout, not zero error', () => {
  const noHoldout = analyze(defaultDataset, { holdoutBatches: [] });
  assertNullMetrics(noHoldout.errors.holdout, 'holdout with no held batches');
  strictEqual(noHoldout.errors.holdoutObservationCount, 0);
  strictEqual(noHoldout.errors.perHoldoutBatch.length, 0);
  const notice = noHoldout.warnings.find((w) => w.code === 'NO_HOLDOUT');
  ok(notice, 'NO_HOLDOUT warning');
  strictEqual(notice.severity, 'critical');
  ok(noHoldout.errors.train.count > 0);
});

test('a held batch whose rows lose all training support is unevaluable, not zero', () => {
  // Hold out every core batch: core rows/columns keep no training ratings.
  const allCore = defaultDataset.batches.filter((b) => b.block === 'core').map((b) => b.id);
  const res = analyze(defaultDataset, { holdoutBatches: allCore });
  ok(res.errors.holdoutObservationCount > 0);
  assertNullMetrics(res.errors.holdout, 'unevaluable holdout');
  ok(res.warnings.some((w) => w.code === 'HOLDOUT_UNEVALUABLE'));
  const heldCells = res.cells.filter((c) => c.status === 'observed-holdout');
  for (const cell of heldCells) {
    strictEqual(cell.estimate, undefined, `${cell.key} has no estimate without training support`);
  }
  for (const batch of res.errors.perHoldoutBatch) {
    strictEqual(batch.evaluatedCount, 0);
    assertNullMetrics(batch.metrics, `batch ${batch.batchId}`);
  }
});

test('per-batch metrics degrade to null when a batch has no evaluated rating', () => {
  const res = analyze(defaultDataset, { holdoutBatches: ['W05', 'O02', 'W01'] });
  for (const batch of res.errors.perHoldoutBatch) {
    if (batch.evaluatedCount === 0) assertNullMetrics(batch.metrics, `batch ${batch.batchId}`);
  }
  strictEqual(res.errors.holdout.count, res.errors.perHoldoutBatch.reduce((s, b) => s + b.evaluatedCount, 0));
});

test('config validation rejects out-of-range complexity', () => {
  throws(() => analyze(defaultDataset, { rank: 6 }), /rank/);
  throws(() => analyze(defaultDataset, { rank: -1 }), /rank/);
  throws(() => analyze(defaultDataset, { lambda: 0 }), /lambda/);
  throws(() => analyze(defaultDataset, { lambda: 101 }), /lambda/);
  // Missing values fall back to defaults; init counts are clamped.
  strictEqual(analyze(defaultDataset, { lambda: null }).config.lambda, defaultDataset.meta.defaultLambda);
  strictEqual(analyze(defaultDataset, { inits: 0 }).diagnostics.stability.initCount, 1);
  strictEqual(analyze(defaultDataset, { inits: 99 }).diagnostics.stability.initCount, 6);
});

test('sweep keeps unevaluable holdout points null', async () => {
  const { runSweep } = await import('../server/sweep.js');
  const sweep = runSweep(defaultDataset, { holdoutBatches: [] });
  strictEqual(sweep.points.length, 6);
  for (const point of sweep.points) {
    strictEqual(point.evaluatedHoldoutCount, 0);
    assertNullMetrics(point.holdout, `sweep ${point.label}`);
  }
});

test('holding out every batch leaves no fit and says so plainly', () => {
  const allBatches = defaultDataset.batches.map((b) => b.id);
  const res = analyze(defaultDataset, { holdoutBatches: allBatches });
  strictEqual(res.cellCounts.training, 0);
  strictEqual(res.cellCounts.completed, 0);
  assertNullMetrics(res.errors.train, 'empty training set');
  assertNullMetrics(res.errors.holdout, 'nothing can be held-out-evaluated without a fit');
  strictEqual(res.diagnostics.convergence.fitCount, 0);
  ok(res.diagnostics.convergence.message.includes('没有进入训练集的观测'));
  ok(res.diagnostics.meanCollapse.message.includes('没有训练块'));
  ok(res.diagnostics.stability.note.includes('没有可补全的格子'));
  for (const cell of res.cells) {
    if (!cell.observed) strictEqual(cell.estimate, undefined);
  }
});

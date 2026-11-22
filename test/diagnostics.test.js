import test from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { analyze } from '../server/analysis.js';
import { defaultDataset } from './helpers.js';

const DEFAULTS = {};

test('convergence and mean-collapse are separate diagnostics', () => {
  const balanced = analyze(defaultDataset, DEFAULTS);
  strictEqual(balanced.diagnostics.convergence.anyNotConverged, false);
  strictEqual(balanced.diagnostics.meanCollapse.detected, false);
  strictEqual(balanced.warnings.some((w) => w.code === 'MEAN_COLLAPSE'), false);
  strictEqual(balanced.warnings.some((w) => w.code === 'NOT_CONVERGED'), false);

  // Very strong ridge: ALS converges cleanly, yet the fit flattens to the mean.
  const overRegularized = analyze(defaultDataset, { lambda: 92, inits: 2 });
  strictEqual(overRegularized.diagnostics.convergence.anyNotConverged, false,
    'strong ridge still converges');
  strictEqual(overRegularized.diagnostics.meanCollapse.detected, true,
    'strong ridge is flagged as mean collapse');
  ok(overRegularized.warnings.some((w) => w.code === 'MEAN_COLLAPSE'));
  strictEqual(overRegularized.warnings.some((w) => w.code === 'NOT_CONVERGED'), false);
  for (const comp of overRegularized.diagnostics.meanCollapse.components) {
    ok(comp.explainedVariance <= overRegularized.diagnostics.meanCollapse.thresholds.explainedVariance);
  }
});

test('an unconverged fit is reported without being mislabelled as collapse', () => {
  // High rank and almost no ridge: factors keep drifting past the iteration cap.
  const fit = analyze(defaultDataset, { rank: 5, lambda: 0.01, inits: 2 });
  ok(fit.diagnostics.convergence.notConvergedCount > 0);
  strictEqual(fit.diagnostics.convergence.fitCount, 4);
  strictEqual(fit.diagnostics.meanCollapse.detected, false);
  ok(fit.warnings.some((w) => w.code === 'NOT_CONVERGED'));
  strictEqual(fit.warnings.some((w) => w.code === 'MEAN_COLLAPSE'), false);
  for (const entry of fit.diagnostics.notConvergedFits) {
    ok(entry.iterations >= fit.config.maxIter - 3, 'the fit used (almost) all iterations');
  }
});

test('convergence history is exposed per iteration and never hides a gap', () => {
  const fit = analyze(defaultDataset, DEFAULTS);
  const history = fit.histories;
  strictEqual(history.length, fit.components.training.length);
  for (const block of history) {
    ok(block.history.length > 5);
    strictEqual(block.history[0].iteration, 0);
    for (const point of block.history) {
      ok(Number.isFinite(point.trainRmse));
      ok(point.reportRmse === null || Number.isFinite(point.reportRmse));
    }
    const last = block.history[block.history.length - 1];
    ok(Math.abs(last.trainRmse - fit.errors.train.rmse) < 0.2, 'curve ends near the reported training error');
  }
});

test('stability requires more than one initialization', () => {
  const single = analyze(defaultDataset, { ...DEFAULTS, inits: 1 });
  strictEqual(single.diagnostics.stability.comparable, false);
  strictEqual(single.diagnostics.stability.meanSd, null);
  strictEqual(single.diagnostics.stability.stableShare, null);
  ok(single.diagnostics.stability.note.includes('无法比较'));
  for (const cell of single.cells.filter((c) => c.status === 'completed')) {
    strictEqual(cell.stabilitySd, null);
    strictEqual(cell.stabilityRange, null);
    strictEqual(cell.stabilityLabel, '需多次初始化');
  }

  const multi = analyze(defaultDataset, { ...DEFAULTS, inits: 4 });
  strictEqual(multi.diagnostics.stability.comparable, true);
  ok(multi.diagnostics.stability.meanSd != null);
  for (const cell of multi.cells.filter((c) => c.status === 'completed')) {
    ok(Number.isFinite(cell.stabilitySd));
    strictEqual(cell.initEstimates.length, 4);
    const spread = Math.max(...cell.initEstimates) - Math.min(...cell.initEstimates);
    ok(Math.abs(spread - cell.stabilityRange) < 0.01);
  }
});

test('stability is larger when the model is deliberately unstable', () => {
  const stable = analyze(defaultDataset, DEFAULTS);
  const unstable = analyze(defaultDataset, { rank: 5, lambda: 0.05, inits: 2 });
  ok(unstable.diagnostics.stability.meanSd > stable.diagnostics.stability.meanSd);
});

test('fit details record the convergence flag per initialization', () => {
  const fit = analyze(defaultDataset, { rank: 5, lambda: 0.01, inits: 2 });
  strictEqual(fit.fits.length, 4);
  for (const row of fit.fits) {
    strictEqual(typeof row.converged, 'boolean');
    ok(row.iterations >= 1);
    strictEqual(row.maxIter, 90);
    ok(row.trainRmse >= 0);
    ok(row.reportRmse === null || row.reportRmse >= 0);
  }
  strictEqual(fit.fits.filter((f) => !f.converged).length, fit.diagnostics.convergence.notConvergedCount);
});

test('ALS reads only raw training ratings', () => {
  const fit = analyze(defaultDataset, DEFAULTS);
  strictEqual(fit.diagnostics.alsUsesRawTrainingRatingsOnly, true);
  // Training / holdout / probe counts partition the observations exactly.
  strictEqual(
    fit.cellCounts.training + fit.cellCounts.holdout + fit.cellCounts.probe,
    fit.cellCounts.observed
  );
  for (const record of fit.errorRecords.train) {
    strictEqual(record.estimate != null, true, 'training record has an out-of-sample-free fitted value');
  }
});

test('component diagnostics expose explained variance and shrinkage per block', () => {
  const fit = analyze(defaultDataset, DEFAULTS);
  strictEqual(fit.diagnostics.componentDiagnostics.length, fit.components.training.length);
  for (const comp of fit.diagnostics.componentDiagnostics) {
    ok(comp.explainedVariance >= 0 && comp.explainedVariance <= 1);
    ok(comp.shrinkage > 0);
    strictEqual(typeof comp.collapsed, 'boolean');
  }
});

/**
 * Complexity sweeps. Every point is a *complete refit* under that
 * configuration; nothing is selected behind the user's back and a point with
 * no evaluable held-out observation keeps `holdout.rmse === null` rather than
 * being plotted as zero.
 */
import { analyze } from './analysis.js';

export const RANK_POINTS = [0, 1, 2, 3, 4, 5];
export const LAMBDA_POINTS = [0.05, 0.15, 0.5, 1.2, 3, 10, 30];

export function runSweep(dataset, config = {}) {
  const axis = config.axis === 'lambda' ? 'lambda' : 'rank';
  const rank = Number.isInteger(config.rank) ? config.rank : dataset.meta.defaultRank;
  const lambda = Number.isFinite(config.lambda) ? config.lambda : dataset.meta.defaultLambda;
  const inits = Math.max(1, Math.min(2, Number.isInteger(config.inits) ? config.inits : 2));
  const base = {
    holdoutBatches: config.holdoutBatches,
    probe: config.probe || null,
    inits
  };
  const points = [];
  const xs = axis === 'rank' ? RANK_POINTS : LAMBDA_POINTS;
  for (const x of xs) {
    const pointConfig = axis === 'rank'
      ? { ...base, rank: x, lambda }
      : { ...base, rank, lambda: x };
    const result = analyze(dataset, pointConfig);
    const evaluated = result.errors.holdout?.count || 0;
    points.push({
      x,
      label: axis === 'rank' ? `秩 ${x}` : `λ ${x}`,
      config: { rank: pointConfig.rank, lambda: pointConfig.lambda },
      train: result.errors.train,
      // Explicitly unevaluable, not zero.
      holdout: evaluated ? result.errors.holdout : { ...result.errors.holdout, count: 0, rmse: null, mae: null, bias: null, maxAbs: null },
      probe: result.errors.probe,
      evaluatedHoldoutCount: evaluated,
      converged: !result.diagnostics.convergence.anyNotConverged,
      collapsed: result.diagnostics.meanCollapse.detected,
      completed: result.cellCounts.completed
    });
  }
  return { axis, points, current: { rank, lambda } };
}

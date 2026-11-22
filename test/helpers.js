import { deepStrictEqual, ok } from 'node:assert/strict';
import { generateDataset } from '../server/data.js';

export const defaultDataset = generateDataset();

export function assertNullMetrics(metrics, label) {
  ok(metrics, `${label} metrics object exists`);
  deepStrictEqual(
    { count: metrics.count, rmse: metrics.rmse, mae: metrics.mae, bias: metrics.bias, maxAbs: metrics.maxAbs },
    { count: 0, rmse: null, mae: null, bias: null, maxAbs: null },
    `${label} must be explicitly unevaluable, never zero`
  );
}

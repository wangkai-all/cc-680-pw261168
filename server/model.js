/**
 * Regularized low-rank matrix completion for the store/item rating matrix.
 *
 * Prediction for store i and item j:
 *
 *     r_hat_ij = mu + b_i + c_j + p_i . q_j
 *
 * The model is fitted by alternating least squares with ridge penalties on the
 * biases and factor matrices. Only *raw training ratings* enter the updates.
 * Held-out, block-probed and missing cells never feed an estimate back into the
 * fit.
 */

function zeros(n) {
  return new Float64Array(n);
}

function zerosMatrix(rows, cols) {
  return Array.from({ length: rows }, () => new Float64Array(cols));
}

/** Solve A x = b for a small symmetric positive-definite system. */
export function solveSPD(A, b) {
  const n = b.length;
  const M = A.map((row, i) => {
    const copy = new Float64Array(n + 1);
    copy.set(row.subarray ? row.subarray(0, n) : row.slice(0, n));
    copy[n] = b[i];
    return copy;
  });
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-14) {
      // Ridge should prevent this; fall back to a tiny diagonal nudge.
      M[col][col] += 1e-10;
    } else if (pivot !== col) {
      const tmp = M[col];
      M[col] = M[pivot];
      M[pivot] = tmp;
    }
    const diag = M[col][col];
    for (let r = col + 1; r < n; r += 1) {
      const factor = M[r][col] / diag;
      if (factor === 0) continue;
      for (let k = col; k <= n; k += 1) M[r][k] -= factor * M[col][k];
    }
  }
  const x = new Float64Array(n);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = M[row][n];
    for (let k = row + 1; k < n; k += 1) sum -= M[row][k] * x[k];
    x[row] = sum / M[row][row];
  }
  return x;
}

function rmseOf(errors) {
  if (!errors.length) return null;
  let sse = 0;
  for (const e of errors) sse += e * e;
  return Math.sqrt(sse / errors.length);
}

function mean(values) {
  if (!values.length) return null;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

function std(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  let s = 0;
  for (const v of values) s += (v - m) * (v - m);
  return Math.sqrt(s / values.length);
}

function clip(value, lo = 1, hi = 5) {
  return Math.min(hi, Math.max(lo, value));
}

export function makeRng(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussianFrom(rng) {
  const u = Math.max(rng(), 1e-12);
  const v = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Fit one connected component.
 *
 * @param {object} input
 * @param {string[]} input.rowIds
 * @param {string[]} input.colIds
 * @param {{ri:number, ci:number, value:number}[]} input.trainCells
 * @param {{ri:number, ci:number, value:number}[]} input.reportCells  cells with
 *        truth used only to *report* a validation curve (never for stopping)
 * @param {number} input.rank
 * @param {number} input.lambda
 * @param {number} input.maxIter
 * @param {number} input.tol
 * @param {number} input.seed
 */
export function fitComponent(input) {
  const {
    rowIds, colIds, trainCells, reportCells = [], rank, lambda, maxIter, tol, seed
  } = input;
  const R = rowIds.length;
  const C = colIds.length;
  if (!trainCells.length || !R || !C) {
    throw new Error('fitComponent requires at least one row, one column and one training cell');
  }

  const byRow = Array.from({ length: R }, () => []);
  const byCol = Array.from({ length: C }, () => []);
  for (const cell of trainCells) {
    byRow[cell.ri].push(cell);
    byCol[cell.ci].push(cell);
  }

  const trainValues = trainCells.map((c) => c.value);
  const mu = mean(trainValues);
  const b = zeros(R);
  const c = zeros(C);
  const rng = makeRng(seed);
  const P = zerosMatrix(R, rank);
  const Q = zerosMatrix(C, rank);
  for (let i = 0; i < R; i += 1) {
    for (let k = 0; k < rank; k += 1) P[i][k] = gaussianFrom(rng) * 0.12;
  }
  for (let j = 0; j < C; j += 1) {
    for (let k = 0; k < rank; k += 1) Q[j][k] = gaussianFrom(rng) * 0.12;
  }

  const predict = (ri, ci) => {
    let v = mu + b[ri] + c[ci];
    const p = P[ri];
    const q = Q[ci];
    for (let k = 0; k < rank; k += 1) v += p[k] * q[k];
    return v;
  };

  const evaluate = (cells) => {
    if (!cells.length) return { rmse: null, mae: null, bias: null, count: 0 };
    let sse = 0;
    let sae = 0;
    let sbias = 0;
    for (const cell of cells) {
      const err = cell.value - predict(cell.ri, cell.ci);
      sse += err * err;
      sae += Math.abs(err);
      sbias += err;
    }
    return {
      rmse: Math.sqrt(sse / cells.length),
      mae: sae / cells.length,
      bias: sbias / cells.length,
      count: cells.length
    };
  };

  const history = [];
  const trainEval0 = evaluate(trainCells);
  const reportEval0 = evaluate(reportCells);
  history.push({
    iteration: 0,
    trainRmse: trainEval0.rmse,
    reportRmse: reportEval0.rmse
  });

  const dim = rank + 1;
  const updateRows = () => {
    for (let i = 0; i < R; i += 1) {
      const list = byRow[i];
      if (!list.length) continue;
      const A = zerosMatrix(dim, dim);
      const rhs = zeros(dim);
      for (const cell of list) {
        const q = Q[cell.ci];
        const base = cell.value - mu - c[cell.ci];
        const v = new Float64Array(dim);
        v[0] = 1;
        for (let k = 0; k < rank; k += 1) v[k + 1] = q[k];
        for (let a = 0; a < dim; a += 1) {
          rhs[a] += v[a] * base;
          for (let d = a; d < dim; d += 1) A[a][d] += v[a] * v[d];
        }
      }
      for (let a = 0; a < dim; a += 1) {
        for (let d = 0; d < a; d += 1) A[a][d] = A[d][a];
        A[a][a] += lambda;
      }
      const x = solveSPD(A, rhs);
      b[i] = x[0];
      for (let k = 0; k < rank; k += 1) P[i][k] = x[k + 1];
    }
  };
  const updateCols = () => {
    for (let j = 0; j < C; j += 1) {
      const list = byCol[j];
      if (!list.length) continue;
      const A = zerosMatrix(dim, dim);
      const rhs = zeros(dim);
      for (const cell of list) {
        const p = P[cell.ri];
        const base = cell.value - mu - b[cell.ri];
        const v = new Float64Array(dim);
        v[0] = 1;
        for (let k = 0; k < rank; k += 1) v[k + 1] = p[k];
        for (let a = 0; a < dim; a += 1) {
          rhs[a] += v[a] * base;
          for (let d = a; d < dim; d += 1) A[a][d] += v[a] * v[d];
        }
      }
      for (let a = 0; a < dim; a += 1) {
        for (let d = 0; d < a; d += 1) A[a][d] = A[d][a];
        A[a][a] += lambda;
      }
      const x = solveSPD(A, rhs);
      c[j] = x[0];
      for (let k = 0; k < rank; k += 1) Q[j][k] = x[k + 1];
    }
  };

  let converged = false;
  let stableCount = 0;
  let iterations = 0;
  let prev = trainEval0.rmse;
  for (let iter = 1; iter <= maxIter; iter += 1) {
    updateRows();
    updateCols();
    iterations = iter;
    const trainEval = evaluate(trainCells);
    const reportEval = evaluate(reportCells);
    history.push({
      iteration: iter,
      trainRmse: trainEval.rmse,
      reportRmse: reportEval.rmse
    });
    const rel = prev > 1e-12 ? (prev - trainEval.rmse) / prev : 0;
    if (Math.abs(rel) < tol) stableCount += 1;
    else stableCount = 0;
    prev = trainEval.rmse;
    if (stableCount >= 3) {
      converged = true;
      break;
    }
  }

  const trainEval = evaluate(trainCells);
  const reportEval = evaluate(reportCells);

  // Prediction matrix for this component, clipped to the rating scale.
  const predictions = Array.from({ length: R }, () => new Float64Array(C));
  for (let i = 0; i < R; i += 1) {
    for (let j = 0; j < C; j += 1) {
      predictions[i][j] = clip(predict(i, j));
    }
  }

  const missingPredictions = [];
  const trainKey = new Set(trainCells.map((cell) => `${cell.ri}:${cell.ci}`));
  for (let i = 0; i < R; i += 1) {
    for (let j = 0; j < C; j += 1) {
      if (!trainKey.has(`${i}:${j}`)) missingPredictions.push(predictions[i][j]);
    }
  }
  const trainSd = std(trainValues);
  const predSd = std(missingPredictions);
  const muClipped = clip(mu);
  const nearMean = missingPredictions.filter((v) => Math.abs(v - muClipped) <= 0.15).length;

  const factorNorm = Math.sqrt(
    P.reduce((s, row) => s + row.reduce((a, v) => a + v * v, 0), 0) +
    Q.reduce((s, row) => s + row.reduce((a, v) => a + v * v, 0), 0)
  );
  const biasNorm = Math.sqrt(
    b.reduce((s, v) => s + v * v, 0) + c.reduce((s, v) => s + v * v, 0)
  );

  return {
    rowIds,
    colIds,
    rank,
    lambda,
    seed,
    mu,
    iterations,
    maxIter,
    converged,
    train: trainEval,
    report: reportEval,
    history,
    predictions,
    nTrain: trainCells.length,
    nReport: reportCells.length,
    trainSd,
    predSd,
    nearMeanShare: missingPredictions.length ? nearMean / missingPredictions.length : 0,
    factorNorm,
    biasNorm,
    shrinkage: trainSd > 1e-9 ? predSd / trainSd : 1
  };
}

export function aggregateHistories(fits) {
  const usable = fits.filter(Boolean);
  if (!usable.length) return [];
  const maxLen = Math.max(...usable.map((f) => f.history.length));
  const result = [];
  for (let t = 0; t < maxLen; t += 1) {
    let trainWeighted = 0;
    let trainWeight = 0;
    let reportWeighted = 0;
    let reportWeight = 0;
    for (const fit of usable) {
      const point = fit.history[Math.min(t, fit.history.length - 1)];
      if (point.trainRmse != null) {
        trainWeighted += point.trainRmse * fit.nTrain;
        trainWeight += fit.nTrain;
      }
      if (point.reportRmse != null) {
        reportWeighted += point.reportRmse * fit.nReport;
        reportWeight += fit.nReport;
      }
    }
    result.push({
      iteration: t,
      trainRmse: trainWeight ? trainWeighted / trainWeight : null,
      reportRmse: reportWeight ? reportWeighted / reportWeight : null
    });
  }
  return result;
}

export function metricsFromPairs(pairs) {
  if (!pairs.length) {
    return { count: 0, rmse: null, mae: null, bias: null, maxAbs: null };
  }
  let sse = 0;
  let sae = 0;
  let sbias = 0;
  let maxAbs = 0;
  for (const { truth, estimate } of pairs) {
    const e = truth - estimate;
    sse += e * e;
    sae += Math.abs(e);
    sbias += e;
    if (Math.abs(e) > maxAbs) maxAbs = Math.abs(e);
  }
  return {
    count: pairs.length,
    rmse: Math.sqrt(sse / pairs.length),
    mae: sae / pairs.length,
    bias: sbias / pairs.length,
    maxAbs
  };
}

export { std, mean, rmseOf };

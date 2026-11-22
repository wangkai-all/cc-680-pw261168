/**
 * Runs one analysis for a given configuration:
 *   - batch-level holdout (never cell-level random holdout),
 *   - optional whole-block masking (probe),
 *   - regularized low-rank ALS fitted only on raw training ratings,
 *   - multiple initializations for per-cell stability,
 *   - explicit support / connectivity / convergence / collapse diagnostics.
 */

import { fitComponent, aggregateHistories, metricsFromPairs, mean, std } from './model.js';

const MAX_ITER = 90;
const TOL = 1e-5;
const DEFAULT_INITS = 4;
const COLLAPSE_SHRINKAGE = 0.4;
const COLLAPSE_NEAR_MEAN = 0.55;
const COLLAPSE_R2_FLOOR = 0.2;

function sortIds(a, b) {
  return a.localeCompare(b, 'zh-Hans-CN', { numeric: true });
}

function componentIdList(components, prefix = 'C') {
  return components.map((comp, idx) => ({
    id: `${prefix}${idx + 1}`,
    storeIds: comp.rowIds,
    itemIds: comp.colIds,
    cellCount: comp.cells.length,
    trainCount: comp.trainCount ?? comp.cells.length
  }));
}

/**
 * Bipartite connected components over a set of observed cells.
 * Rows/columns with no cells are not part of any component.
 */
function findComponents(cells, rowIds, colIds) {
  const rowSet = new Map();
  const colSet = new Map();
  for (const cell of cells) {
    if (!rowSet.has(cell.storeId)) rowSet.set(cell.storeId, []);
    if (!colSet.has(cell.itemId)) colSet.set(cell.itemId, []);
    rowSet.get(cell.storeId).push(cell);
    colSet.get(cell.itemId).push(cell);
  }
  const seenRows = new Set();
  const seenCols = new Set();
  const components = [];
  const rowOrder = [...rowSet.keys()].sort(sortIds);
  for (const start of rowOrder) {
    if (seenRows.has(start)) continue;
    const compRows = [];
    const compCols = new Set();
    const compCells = [];
    const rowQueue = [start];
    seenRows.add(start);
    while (rowQueue.length) {
      const rowId = rowQueue.shift();
      compRows.push(rowId);
      for (const cell of rowSet.get(rowId) || []) {
        compCells.push(cell);
        if (!seenCols.has(cell.itemId)) {
          seenCols.add(cell.itemId);
          compCols.add(cell.itemId);
          for (const other of colSet.get(cell.itemId) || []) {
            if (!seenRows.has(other.storeId)) {
              seenRows.add(other.storeId);
              rowQueue.push(other.storeId);
            }
          }
        }
      }
    }
    components.push({
      rowIds: compRows.sort(sortIds),
      colIds: [...compCols].sort(sortIds),
      cells: compCells
    });
  }
  // Include isolated columns (items observed only through no rows is impossible,
  // but a column with cells has rows in a component already).
  for (const colId of [...colSet.keys()].sort(sortIds)) {
    if (!seenCols.has(colId)) {
      seenCols.add(colId);
      components.push({ rowIds: [], colIds: [colId], cells: [] });
    }
  }
  return components;
}

function round(value, digits = 3) {
  if (value == null || !Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function roundMetrics(metrics) {
  if (!metrics) return metrics;
  return {
    count: metrics.count,
    rmse: round(metrics.rmse),
    mae: round(metrics.mae),
    bias: round(metrics.bias),
    maxAbs: round(metrics.maxAbs)
  };
}

function splitHoldout(cells, heldBatches) {
  const train = [];
  const holdout = [];
  for (const cell of cells) {
    if (heldBatches.has(cell.batchId)) holdout.push(cell);
    else train.push(cell);
  }
  return { train, holdout };
}

function describeConfig(config, dataset) {
  const batchIds = new Set(dataset.batches.map((b) => b.id));
  const rank = Number.isInteger(config.rank) ? config.rank : dataset.meta.defaultRank;
  if (rank < 0 || rank > 5) throw new Error('rank 必须在 0 到 5 之间');
  const lambdaRaw = config.lambda == null ? dataset.meta.defaultLambda : Number(config.lambda);
  if (!Number.isFinite(lambdaRaw) || lambdaRaw < 0.01 || lambdaRaw > 100) {
    throw new Error('lambda 必须在 0.01 到 100 之间');
  }
  const lambda = lambdaRaw;
  const holdoutBatches = Array.isArray(config.holdoutBatches)
    ? [...new Set(config.holdoutBatches.filter((id) => batchIds.has(id)))]
    : [...dataset.meta.defaultHoldoutBatches];
  const probe = config.probe && (config.probe.storeIds?.length || config.probe.itemIds?.length)
    ? {
        storeIds: [...new Set(config.probe.storeIds || [])].filter((id) => dataset.stores.some((s) => s.id === id)),
        itemIds: [...new Set(config.probe.itemIds || [])].filter((id) => dataset.items.some((i) => i.id === id)),
        label: typeof config.probe.label === 'string' ? config.probe.label.slice(0, 120) : '自定义区块'
      }
    : null;
  const inits = Math.max(1, Math.min(6, Number.isInteger(config.inits) ? config.inits : DEFAULT_INITS));
  return { rank, lambda, holdoutBatches, probe, inits };
}

function fitSeeds(componentIndex, inits) {
  const seeds = [];
  for (let k = 0; k < inits; k += 1) seeds.push(20261122 + componentIndex * 101 + k * 7919);
  return seeds;
}

export function analyze(dataset, rawConfig = {}) {
  const config = describeConfig(rawConfig, dataset);
  const { rank, lambda, holdoutBatches, probe, inits } = config;
  const heldBatchSet = new Set(holdoutBatches);
  const observed = dataset.observations.map((o) => ({ ...o }));

  const storeById = new Map(dataset.stores.map((s) => [s.id, s]));
  const itemById = new Map(dataset.items.map((i) => [i.id, i]));
  const storeIndex = new Map(dataset.stores.map((s, idx) => [s.id, idx]));
  const itemIndex = new Map(dataset.items.map((i, idx) => [i.id, idx]));

  const probeStores = new Set(probe?.storeIds || []);
  const probeItems = new Set(probe?.itemIds || []);
  const probeActive = Boolean(probe && probeStores.size && probeItems.size);
  const isProbeCell = (o) => probeActive && probeStores.has(o.storeId) && probeItems.has(o.itemId);

  const observationByKey = new Map(observed.map((o) => [`${o.storeId}\u0001${o.itemId}`, o]));

  // Full observation graph ignores holdout/probe: it describes the evidence
  // that exists in the field, not just what is currently used for fitting.
  const fullComponents = findComponents(observed, storeById, itemById);
  const fullComponentOfRow = new Map();
  const fullComponentOfCol = new Map();
  fullComponents.forEach((comp, idx) => {
    comp.rowIds.forEach((id) => fullComponentOfRow.set(id, `C${idx + 1}`));
    comp.colIds.forEach((id) => fullComponentOfCol.set(id, `C${idx + 1}`));
  });

  // Training cells: raw ratings only, excluding whole held-out batches and the
  // temporarily masked probe block. No synthetic or imputed value is used.
  const training = observed.filter((o) => !heldBatchSet.has(o.batchId) && !isProbeCell(o));
  const probeCells = observed.filter(isProbeCell);
  const holdoutCells = observed.filter((o) => heldBatchSet.has(o.batchId) && !isProbeCell(o));

  const trainComponents = findComponents(training, storeById, itemById);
  trainComponents.forEach((comp) => {
    comp.trainCount = comp.cells.length;
  });
  const trainComponentOfRow = new Map();
  const trainComponentOfCol = new Map();
  trainComponents.forEach((comp, idx) => {
    comp.rowIds.forEach((id) => trainComponentOfRow.set(id, `T${idx + 1}`));
    comp.colIds.forEach((id) => trainComponentOfCol.set(id, `T${idx + 1}`));
  });

  const trainCountByRow = new Map();
  const trainCountByCol = new Map();
  for (const o of training) {
    trainCountByRow.set(o.storeId, (trainCountByRow.get(o.storeId) || 0) + 1);
    trainCountByCol.set(o.itemId, (trainCountByCol.get(o.itemId) || 0) + 1);
  }

  // ---- Fit each training component, multiple initializations -----------
  const componentEstimates = new Map(); // trainComponentId -> { estimates: Map, initValues: Map, fits }
  const fitSummaries = [];

  trainComponents.forEach((comp, compIdx) => {
    if (!comp.cells.length || !comp.rowIds.length || !comp.colIds.length) return;
    const rowIds = comp.rowIds;
    const colIds = comp.colIds;
    const rowLocal = new Map(rowIds.map((id, idx) => [id, idx]));
    const colLocal = new Map(colIds.map((id, idx) => [id, idx]));
    const toLocal = (cells) => cells.map((o) => ({
      ri: rowLocal.get(o.storeId),
      ci: colLocal.get(o.itemId),
      value: o.value,
      storeId: o.storeId,
      itemId: o.itemId,
      batchId: o.batchId
    })).filter((cell) => cell.ri != null && cell.ci != null);
    const localTrain = toLocal(comp.cells);
    const localReport = toLocal(holdoutCells.filter((o) =>
      rowLocal.has(o.storeId) && colLocal.has(o.itemId)
    ));

    const seeds = fitSeeds(compIdx, inits);
    const fits = seeds.map((seed) => fitComponent({
      rowIds,
      colIds,
      trainCells: localTrain,
      reportCells: localReport,
      rank,
      lambda,
      maxIter: MAX_ITER,
      tol: TOL,
      seed
    }));

    const estimates = new Map();
    const initValues = new Map();
    for (let i = 0; i < rowIds.length; i += 1) {
      for (let j = 0; j < colIds.length; j += 1) {
        const key = `${rowIds[i]}\u0001${colIds[j]}`;
        const values = fits.map((fit) => fit.predictions[i][j]);
        const avg = mean(values);
        estimates.set(key, avg);
        initValues.set(key, values);
      }
    }
    const missingEstimates = [];
    const trainValues = [];
    const missingKeys = [];
    for (let i = 0; i < rowIds.length; i += 1) {
      for (let j = 0; j < colIds.length; j += 1) {
        const key = `${rowIds[i]}\u0001${colIds[j]}`;
        if (!rowLocal.has(rowIds[i]) || !colLocal.has(colIds[j])) continue;
        if (localTrain.some((c) => c.ri === i && c.ci === j)) trainValues.push(estimates.get(key));
        else { missingEstimates.push(estimates.get(key)); missingKeys.push(key); }
      }
    }
    const ensembleTrainSd = std(trainValues);
    const ensemblePredSd = std(missingEstimates);
    const ensembleShrinkage = ensembleTrainSd > 1e-9 ? ensemblePredSd / ensembleTrainSd : 1;
    const trainTruthValues = localTrain.map((c) => c.value);
    const trainTruthSd = std(trainTruthValues);
    const trainTruthMean = mean(trainTruthValues);
    const explainedVariance = trainTruthSd > 1e-9
      ? 1 - (fits[0].train.rmse * fits[0].train.rmse) / (trainTruthSd * trainTruthSd)
      : 0;
    const nearMean = missingEstimates.length
      ? missingEstimates.filter((v) => Math.abs(v - Math.min(5, Math.max(1, fits[0].mu))) <= 0.15).length / missingEstimates.length
      : 0;

    const componentId = `T${compIdx + 1}`;
    comp.id = componentId;
    comp.fits = fits;
    comp.history = aggregateHistories(fits);
    comp.ensembleShrinkage = ensembleShrinkage;
    comp.ensembleNearMean = nearMean;
    comp.ensemblePredSd = ensemblePredSd;
    comp.trainSd = ensembleTrainSd;
    comp.trainTruthSd = trainTruthSd;
    comp.trainTruthMean = trainTruthMean;
    comp.explainedVariance = explainedVariance;
    comp.missingKeys = missingKeys;
    comp.estimates = estimates;
    comp.initValues = initValues;
    componentEstimates.set(componentId, { estimates, initValues, fits, rowIds, colIds, ensemble: {
      shrinkage: ensembleShrinkage,
      nearMeanShare: nearMean,
      predSd: ensemblePredSd,
      trainSd: ensembleTrainSd,
      trainTruthSd,
      explainedVariance
    } });

    fits.forEach((fit, idx) => {
      fitSummaries.push({
        componentId,
        componentStores: rowIds.length,
        componentItems: colIds.length,
        init: idx + 1,
        seed: fit.seed,
        iterations: fit.iterations,
        maxIter: fit.maxIter,
        converged: fit.converged,
        trainRmse: round(fit.train.rmse),
        trainMae: round(fit.train.mae),
        reportRmse: round(fit.report.rmse),
        reportCount: fit.nReport,
        mu: round(fit.mu),
        trainSd: round(fit.trainSd),
        predSd: round(fit.predSd),
        shrinkage: round(fit.shrinkage),
        nearMeanShare: round(fit.nearMeanShare),
        factorNorm: round(fit.factorNorm),
        biasNorm: round(fit.biasNorm)
      });
    });
  });

  // ---- Cell table ------------------------------------------------------
  const cells = [];
  for (const store of dataset.stores) {
    for (const item of dataset.items) {
      const key = `${store.id}\u0001${item.id}`;
      const obs = observationByKey.get(key);
      const trainCompId = trainComponentOfRow.get(store.id);
      const trainColCompId = trainComponentOfCol.get(item.id);
      const fullRowComp = fullComponentOfRow.get(store.id);
      const fullColComp = fullComponentOfCol.get(item.id);
      const rowFullCount = store.observedCount;
      const colFullCount = item.observedCount;
      const rowTrainCount = trainCountByRow.get(store.id) || 0;
      const colTrainCount = trainCountByCol.get(item.id) || 0;

      const payload = {
        key,
        storeId: store.id,
        itemId: item.id,
        rowFullCount,
        colFullCount,
        rowTrainCount,
        colTrainCount,
        rowComponentId: fullRowComp || null,
        colComponentId: fullColComp || null,
        rowTrainComponentId: trainCompId || null,
        colTrainComponentId: trainColCompId || null
      };

      if (obs) {
        payload.value = obs.value;
        payload.batchId = obs.batchId;
        payload.batchLabel = dataset.batches.find((b) => b.id === obs.batchId)?.label || obs.batchId;
        payload.observed = true;
        payload.block = obs.block;
        if (isProbeCell(obs)) payload.status = 'observed-probe';
        else if (heldBatchSet.has(obs.batchId)) payload.status = 'observed-holdout';
        else payload.status = 'observed-train';

        const fits = trainCompId ? componentEstimates.get(trainCompId) : null;
        if (fits && fits.estimates.has(key)) {
          const estimate = fits.estimates.get(key);
          const initValues = fits.initValues.get(key);
          payload.estimate = round(estimate, 3);
          payload.initEstimates = initValues.map((v) => round(v, 3));
          payload.stabilitySd = inits > 1 ? round(std(initValues), 4) : null;
          payload.stabilityRange = inits > 1 ? round(Math.max(...initValues) - Math.min(...initValues), 3) : null;
          payload.componentId = trainCompId;
        }
      } else {
        payload.observed = false;
        if (rowFullCount === 0) payload.status = 'no-row-observations';
        else if (colFullCount === 0) payload.status = 'no-item-observations';
        else if (fullRowComp !== fullColComp) payload.status = 'cross-block';
        else if (!trainCompId || !trainColCompId) payload.status = 'no-training-support';
        else if (trainCompId !== trainColCompId) payload.status = 'training-split';
        else {
          const fits = componentEstimates.get(trainCompId);
          if (fits && fits.estimates.has(key)) {
            const estimate = fits.estimates.get(key);
            const initValues = fits.initValues.get(key);
            const sd = inits > 1 ? std(initValues) : null;
            payload.status = 'completed';
            payload.estimate = round(estimate, 3);
            payload.initEstimates = initValues.map((v) => round(v, 3));
            payload.stabilitySd = sd == null ? null : round(sd, 4);
            payload.stabilityRange = inits > 1 ? round(Math.max(...initValues) - Math.min(...initValues), 3) : null;
            payload.componentId = trainCompId;
            payload.stabilityLabel = sd == null ? '需多次初始化' : sd <= 0.02 ? '稳定' : sd <= 0.08 ? '轻微波动' : '不稳定';
          } else {
            payload.status = 'no-training-support';
          }
        }
        if (trainCompId && trainCompId === trainColCompId) payload.componentId = trainCompId;
      }

      // Row/column training ranges (raw ratings only).
      const rowTrainValues = training.filter((o) => o.storeId === store.id).map((o) => o.value);
      const colTrainValues = training.filter((o) => o.itemId === item.id).map((o) => o.value);
      payload.rowTrainRange = rowTrainValues.length
        ? { count: rowTrainValues.length, min: round(Math.min(...rowTrainValues), 2), max: round(Math.max(...rowTrainValues), 2), mean: round(mean(rowTrainValues), 2) }
        : { count: 0, min: null, max: null, mean: null };
      payload.colTrainRange = colTrainValues.length
        ? { count: colTrainValues.length, min: round(Math.min(...colTrainValues), 2), max: round(Math.max(...colTrainValues), 2), mean: round(mean(colTrainValues), 2) }
        : { count: 0, min: null, max: null, mean: null };

      cells.push(payload);
    }
  }

  // ---- Error evaluation ------------------------------------------------
  const estimateFor = (storeId, itemId) => {
    const compId = trainComponentOfRow.get(storeId);
    if (!compId || compId !== trainComponentOfCol.get(itemId)) return null;
    const entry = componentEstimates.get(compId);
    if (!entry) return null;
    const value = entry.estimates.get(`${storeId}\u0001${itemId}`);
    return value == null ? null : value;
  };

  const trainPairs = [];
  const holdoutPairs = [];
  const probePairs = [];
  const trainRecords = [];
  const holdoutRecords = [];
  const probeRecords = [];

  for (const obs of observed) {
    const estimate = estimateFor(obs.storeId, obs.itemId);
    const key = `${obs.storeId}\u0001${obs.itemId}`;
    const record = {
      key,
      storeId: obs.storeId,
      storeName: storeById.get(obs.storeId)?.name || obs.storeId,
      itemId: obs.itemId,
      itemName: itemById.get(obs.itemId)?.name || obs.itemId,
      batchId: obs.batchId,
      batchLabel: dataset.batches.find((b) => b.id === obs.batchId)?.label || obs.batchId,
      truth: obs.value,
      estimate: estimate == null ? null : round(estimate, 3)
    };
    if (estimate != null) {
      record.residual = round(obs.value - estimate, 3);
      const pair = { truth: obs.value, estimate };
      if (isProbeCell(obs)) probePairs.push(pair);
      else if (heldBatchSet.has(obs.batchId)) holdoutPairs.push(pair);
      else trainPairs.push(pair);
    }
    if (isProbeCell(obs)) probeRecords.push(record);
    else if (heldBatchSet.has(obs.batchId)) holdoutRecords.push(record);
    else trainRecords.push(record);
  }

  const trainMetrics = metricsFromPairs(trainPairs);
  const holdoutMetrics = metricsFromPairs(holdoutPairs);
  const probeMetrics = probePairs.length ? metricsFromPairs(probePairs) : null;

  // Per-batch held-out evaluation. Batches with no evaluable rating stay
  // explicit; they are never plotted as an error of zero.
  const perBatch = dataset.batches
    .filter((b) => heldBatchSet.has(b.id))
    .map((batch) => {
      const records = holdoutRecords.filter((r) => r.batchId === batch.id);
      const pairs = records.filter((r) => r.estimate != null).map((r) => ({ truth: r.truth, estimate: r.estimate }));
      return {
        batchId: batch.id,
        label: batch.label,
        season: batch.season,
        block: batch.block,
        observationCount: records.length,
        evaluatedCount: pairs.length,
        metrics: metricsFromPairs(pairs)
      };
    });

  // ---- Community / connectivity warnings ------------------------------
  const warnings = [];
  const unseenStores = dataset.stores.filter((s) => s.observedCount === 0);
  const unseenItems = dataset.items.filter((i) => i.observedCount === 0);

  if (fullComponents.length > 1 && fullComponents.some((c) => c.rowIds.length && c.cells.length)) {
    warnings.push({
      code: 'DISCONNECTED_BLOCKS',
      severity: 'warning',
      title: '观测关系分成互不相连的块',
      message: `现有观测形成 ${fullComponents.length} 个互不相连的块。跨块格子的行与列从未出现在同一条观测链上，因此没有共同依据，本工具不会为它们给出补全值。块内补全仍然成立。`
    });
  }

  if (trainComponents.length > fullComponents.length) {
    warnings.push({
      code: 'TRAIN_GRAPH_SPLIT',
      severity: 'warning',
      title: '批次留出使训练图进一步分裂',
      message: `整批留出后，可用于训练的关系从 ${fullComponents.length} 块变成 ${trainComponents.length} 块。留出批次所在的观测不能帮助连接剩余的行列。`
    });
  }

  if (unseenStores.length || unseenItems.length) {
    warnings.push({
      code: 'NEVER_OBSERVED',
      severity: 'warning',
      title: '存在从未有观测的行或列',
      message: [
        unseenStores.length ? `${unseenStores.length} 家门店在全部批次中没有任何评分（${unseenStores.map((s) => s.name).join('、')}）` : '',
        unseenItems.length ? `${unseenItems.length} 个评分项从未投放（${unseenItems.map((i) => i.name).join('、')}）` : ''
      ].filter(Boolean).join('；') + '。这些行列保持“无观测/未投放”，不生成任何估计。'
    });
  }

  if (holdoutCells.length === 0) {
    warnings.push({
      code: 'NO_HOLDOUT',
      severity: 'critical',
      title: '没有留出的观测',
      message: '当前没有整批留出的调查批次，因此无法评估单独的留出误差。训练误差不能代替留出误差；未知格更不会被当作误差为零。'
    });
  } else if (!holdoutPairs.length) {
    warnings.push({
      code: 'HOLDOUT_UNEVALUABLE',
      severity: 'critical',
      title: '留出观测无法评估',
      message: `留出的 ${holdoutCells.length} 个观测都缺少训练支撑（其行或列在训练集中没有观测，或留出后训练图分裂），不能计算留出误差。`
    });
  }

  if (probeActive) {
    warnings.push({
      code: 'PROBE_ACTIVE',
      severity: 'info',
      title: '区块遮蔽进行中',
      message: `已暂时遮住 ${probeStores.size} 家门店 × ${probeItems.size} 个项目的已知评分，共 ${probeCells.length} 个观测。模型完全看不到这些格子；恢复后才回到原数据。`
    });
  }

  const unsupportedRows = dataset.stores.filter((s) => s.observedCount > 0 && !trainCountByRow.get(s.id));
  const unsupportedCols = dataset.items.filter((i) => i.observedCount > 0 && !trainCountByCol.get(i.id));
  if (unsupportedRows.length || unsupportedCols.length) {
    warnings.push({
      code: 'NO_TRAINING_SUPPORT',
      severity: 'warning',
      title: '有观测但训练无支撑',
      message: [
        unsupportedRows.length ? `${unsupportedRows.length} 家门店的训练观测全部被留出或遮住（${unsupportedRows.map((s) => s.name).join('、')}）` : '',
        unsupportedCols.length ? `${unsupportedCols.length} 个项目在训练集中没有观测（${unsupportedCols.map((i) => i.name).join('、')}）` : ''
      ].filter(Boolean).join('；') + '。涉及这些行列的格子不给补全值。'
    });
  }

  // ---- Convergence and collapse diagnostics (kept separate) -----------
  const notConverged = fitSummaries.filter((f) => !f.converged);
  const convergence = {
    anyNotConverged: notConverged.length > 0,
    notConvergedCount: notConverged.length,
    fitCount: fitSummaries.length,
    maxIterations: MAX_ITER,
    tolerance: TOL,
    message: !fitSummaries.length
      ? '当前没有进入训练集的观测，因此没有可拟合的参数，也无从谈收敛。'
      : notConverged.length
        ? `${notConverged.length}/${fitSummaries.length} 次拟合在 ${MAX_ITER} 次交替后仍未稳定（训练误差相对变化 > ${TOL}）。这些拟合的补全值可能随初始化路径变化，稳定度请以多次初始化结果为准。`
        : `${fitSummaries.length} 次拟合均已在训练误差相对变化 < ${TOL} 时稳定收敛。注意：收敛只说明交替拟合停下来了，不代表正则强度合适。`
  };

  // Two independent failure modes are reported separately:
  //   (1) alternating least squares has not stabilized within maxIter;
  //   (2) the ridge penalty is so strong that the model flattens toward the
  //       global mean (high bias, low explained variance), even though ALS
  //       converges cleanly. Convergence does not rule this out.
  const componentDiagnostics = trainComponents
    .filter((comp) => comp.fits)
    .map((comp) => {
      const first = comp.fits[0];
      const trainSd = comp.trainTruthSd;
      const mse = first.train.rmse * first.train.rmse;
      const r2 = trainSd > 1e-9 ? 1 - mse / (trainSd * trainSd) : 0;
      const meanCollapsed =
        r2 <= COLLAPSE_R2_FLOOR ||
        comp.ensembleShrinkage < COLLAPSE_SHRINKAGE ||
        (comp.ensembleNearMean > COLLAPSE_NEAR_MEAN && comp.ensembleShrinkage < 0.8);
      return {
        componentId: comp.id,
        storeCount: comp.rowIds.length,
        itemCount: comp.colIds.length,
        trainRmse: round(first.train.rmse),
        explainedVariance: round(r2),
        shrinkage: round(comp.ensembleShrinkage),
        nearMeanShare: round(comp.ensembleNearMean),
        predSd: round(comp.ensemblePredSd),
        trainSd: round(comp.trainTruthSd),
        collapsed: meanCollapsed
      };
    });
  const collapsed = componentDiagnostics.filter((c) => c.collapsed);
  const meanCollapse = {
    detected: collapsed.length > 0,
    components: collapsed.map((c) => ({
      componentId: c.componentId,
      storeCount: c.storeCount,
      itemCount: c.itemCount,
      explainedVariance: c.explainedVariance,
      shrinkage: c.shrinkage,
      nearMeanShare: c.nearMeanShare,
      predSd: c.predSd,
      trainSd: c.trainSd
    })),
    thresholds: {
      explainedVariance: COLLAPSE_R2_FLOOR,
      shrinkage: COLLAPSE_SHRINKAGE,
      nearMeanShare: COLLAPSE_NEAR_MEAN
    },
    componentsChecked: componentDiagnostics.length,
    message: !componentDiagnostics.length
      ? '当前没有训练块，无法检查均值塌缩：没有参数被拟合，也就没有补全值可塌缩。'
      : collapsed.length
        ? `正则过强：${collapsed.map((c) => `${c.componentId} 的训练解释方差仅 ${Math.round(c.explainedVariance * 100)}%、补全值离散度/训练离散度 ${Math.round(c.shrinkage * 100)}%、近均值比例 ${Math.round(c.nearMeanShare * 100)}%`).join('；')}。判定条件为训练解释方差 ≤ ${Math.round(COLLAPSE_R2_FLOOR * 100)}% 或离散度比 < ${COLLAPSE_SHRINKAGE}。补全值正在向总均值塌缩；这是正则强度问题，与“未收敛”是两件不同的事，即使交替拟合已经停止更新也不代表参数合理。`
        : `未检测到均值塌缩：${componentDiagnostics.length} 个训练块的解释方差在 ${Math.round(Math.min(...componentDiagnostics.map((c) => c.explainedVariance)) * 100)}%–${Math.round(Math.max(...componentDiagnostics.map((c) => c.explainedVariance)) * 100)}%，补全值离散度保持在训练评分离散度的 ${Math.round(Math.min(...componentDiagnostics.map((c) => c.shrinkage)) * 100)}%–${Math.round(Math.max(...componentDiagnostics.map((c) => c.shrinkage)) * 100)}%。`
  };

  if (meanCollapse.detected) {
    warnings.push({
      code: 'MEAN_COLLAPSE',
      severity: 'warning',
      title: '正则过强，补全值向均值塌缩',
      message: meanCollapse.message
    });
  }
  if (notConverged.length) {
    warnings.push({
      code: 'NOT_CONVERGED',
      severity: 'warning',
      title: '交替拟合尚未收敛',
      message: convergence.message
    });
  }

  // ---- Stability summary across completed cells ------------------------
  const completedCells = cells.filter((c) => c.status === 'completed');
  const sds = completedCells.map((c) => c.stabilitySd).filter((v) => v != null);
  const stability = {
    completedCount: completedCells.length,
    initCount: inits,
    meanSd: round(mean(sds)),
    medianSd: round(sds.length ? [...sds].sort((a, b) => a - b)[Math.floor(sds.length / 2)] : null),
    maxSd: round(sds.length ? Math.max(...sds) : null),
    stableShare: sds.length ? round(sds.filter((sd) => sd <= 0.02).length / sds.length) : null,
    comparable: inits > 1,
    note: completedCells.length === 0
      ? '当前没有可补全的格子，因此没有稳定度可比较。'
      : inits > 1
        ? `对 ${completedCells.length} 个可补全格子在 ${inits} 组随机初始化下重复拟合；标准差 ≤ 0.02 视为稳定。`
        : '当前只运行了 1 组初始化，无法比较多次初始化的稳定程度。请把初始化次数调到 2 或以上。'
  };

  // ---- Histories -------------------------------------------------------
  const histories = trainComponents
    .filter((c) => c.history && c.history.length)
    .map((c) => ({
      componentId: c.id,
      storeCount: c.rowIds.length,
      itemCount: c.colIds.length,
      history: c.history.map((point) => ({
        iteration: point.iteration,
        trainRmse: round(point.trainRmse, 4),
        reportRmse: round(point.reportRmse, 4)
      }))
    }));

  // ---- Support table ---------------------------------------------------
  const support = {
    rows: dataset.stores.map((s) => ({
      id: s.id,
      name: s.name,
      fullCount: s.observedCount,
      trainCount: trainCountByRow.get(s.id) || 0,
      holdoutCount: holdoutCells.filter((o) => o.storeId === s.id).length,
      probeCount: probeCells.filter((o) => o.storeId === s.id).length,
      componentId: fullComponentOfRow.get(s.id) || null,
      trainComponentId: trainComponentOfRow.get(s.id) || null
    })),
    cols: dataset.items.map((i) => ({
      id: i.id,
      name: i.name,
      fullCount: i.observedCount,
      trainCount: trainCountByCol.get(i.id) || 0,
      holdoutCount: holdoutCells.filter((o) => o.itemId === i.id).length,
      probeCount: probeCells.filter((o) => o.itemId === i.id).length,
      componentId: fullComponentOfCol.get(i.id) || null,
      trainComponentId: trainComponentOfCol.get(i.id) || null
    }))
  };

  const errorRecords = {
    train: trainRecords,
    holdout: holdoutRecords,
    probe: probeRecords
  };

  return {
    config: {
      rank,
      lambda,
      holdoutBatches,
      probe,
      inits,
      maxIter: MAX_ITER,
      tol: TOL
    },
    datasetMeta: dataset.meta,
    cellCounts: {
      total: cells.length,
      observed: observed.length,
      training: training.length,
      holdout: holdoutCells.length,
      probe: probeCells.length,
      completed: completedCells.length,
      crossBlock: cells.filter((c) => c.status === 'cross-block').length,
      noRowObservations: cells.filter((c) => c.status === 'no-row-observations').length,
      noItemObservations: cells.filter((c) => c.status === 'no-item-observations').length,
      noTrainingSupport: cells.filter((c) => c.status === 'no-training-support').length,
      trainingSplit: cells.filter((c) => c.status === 'training-split').length
    },
    cells,
    components: {
      observed: componentIdList(fullComponents, 'C'),
      training: componentIdList(trainComponents, 'T')
    },
    errors: {
      train: roundMetrics(trainMetrics),
      holdout: roundMetrics(holdoutMetrics),
      probe: probeMetrics ? roundMetrics(probeMetrics) : null,
      perHoldoutBatch: perBatch.map((b) => ({
        ...b,
        metrics: roundMetrics(b.metrics)
      })),
      holdoutObservationCount: holdoutCells.length,
      holdoutEvaluatedCount: holdoutPairs.length,
      holdoutUnevaluatedCount: holdoutCells.length - holdoutPairs.length,
      probeObservationCount: probeCells.length,
      probeEvaluatedCount: probePairs.length,
      probeUnevaluatedCount: probeCells.length - probePairs.length
    },
    errorRecords,
    fits: fitSummaries,
    histories,
    diagnostics: {
      convergence,
      meanCollapse,
      componentDiagnostics,
      stability,
      alsUsesRawTrainingRatingsOnly: true,
      notConvergedFits: notConverged.map((f) => ({ componentId: f.componentId, init: f.init, iterations: f.iterations }))
    },
    warnings,
    support,
    probeReport: probeActive
      ? {
          active: true,
          label: probe.label,
          storeIds: [...probeStores].sort(sortIds),
          itemIds: [...probeItems].sort(sortIds),
          knownCells: probeCells.length,
          evaluatedCells: probePairs.length,
          unevaluatedCells: probeCells.length - probePairs.length,
          metrics: probeMetrics ? roundMetrics(probeMetrics) : null,
          message: probePairs.length
            ? `已遮住并用 ${probePairs.length} 个已知评分检验。恢复后这些格子回到原始数据。`
            : '遮住的区域内没有可评估的已知评分（可能整行/整列因此失去训练支撑）。'
        }
      : { active: false, label: null, knownCells: 0, evaluatedCells: 0, unevaluatedCells: 0, metrics: null }
  };
}

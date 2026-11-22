/**
 * Local synthetic dataset for the store-experience imputation lab.
 *
 * Determinism: all draws come from a seeded mulberry32 PRNG, so the same
 * dataset is generated on every server start.
 *
 * Deliberate structure:
 *  - rows are stores, columns are service items; one rating per observed cell;
 *  - missingness is non-uniform (store response propensity, item popularity,
 *    facility availability and the latent score all matter);
 *  - each rating belongs to exactly one fielded survey batch, and each batch
 *    has its own mild level shift;
 *  - the observation graph has two disconnected instrument blocks plus rows
 *    and columns that were never observed at all;
 *  - one proposed item was never fielded.
 */

export const SEED = 20261122;

export const CORE_ITEM_DEFS = [
  { name: '迎宾问候', category: '人员服务', base: 4.15, pop: 0.94, loading: [0.30, 0.12, 0.04] },
  { name: '环境整洁', category: '空间环境', base: 4.02, pop: 0.92, loading: [0.22, 0.24, -0.10] },
  { name: '商品陈列', category: '商品体验', base: 3.92, pop: 0.86, loading: [0.10, 0.30, 0.02] },
  { name: '店员专业度', category: '人员服务', base: 3.84, pop: 0.88, loading: [0.34, 0.10, 0.16] },
  { name: '结账效率', category: '流程效率', base: 3.62, pop: 0.90, loading: [0.18, -0.24, 0.24] },
  { name: '退换货便利', category: '流程效率', base: 3.56, pop: 0.72, loading: [0.12, -0.18, 0.30] },
  { name: '试衣间体验', category: '空间环境', base: 3.78, pop: 0.80, loading: [0.08, 0.26, -0.22], requires: 'fitting' },
  { name: '会员权益', category: '会员运营', base: 3.70, pop: 0.62, loading: [0.05, 0.12, 0.28] },
  { name: '缺货补货', category: '商品体验', base: 3.45, pop: 0.68, loading: [-0.20, 0.10, 0.24] },
  { name: '停车指引', category: '到达体验', base: 3.30, pop: 0.58, loading: [-0.26, -0.12, 0.05], requires: 'parking' },
  { name: '母婴设施', category: '空间环境', base: 3.66, pop: 0.46, loading: [0.04, 0.20, -0.16], requires: 'family' },
  { name: '无障碍设施', category: '空间环境', base: 3.52, pop: 0.42, loading: [-0.10, 0.08, -0.20] }
];

export const OUTLET_ITEM_DEFS = [
  { name: '折扣清晰度', category: '奥莱体验', base: 3.72, pop: 0.86, loading: [0.24, 0.10, 0.12] },
  { name: '库存完整度', category: '奥莱体验', base: 3.48, pop: 0.80, loading: [0.14, 0.28, -0.06] },
  { name: '导购响应', category: '奥莱体验', base: 3.90, pop: 0.84, loading: [0.30, 0.06, 0.10] },
  { name: '停车指引', category: '奥莱体验', base: 3.34, pop: 0.58, loading: [-0.24, -0.10, 0.08], requires: 'parking' },
  { name: '礼品包装', category: '奥莱体验', base: 3.60, pop: 0.46, loading: [0.06, 0.16, 0.18] }
];

export const CORE_STORE_NAMES = [
  '望江旗舰店', '湖滨中心店', '南岸广场店', '北城天街店', '东港时代店', '西溪里店',
  '星河湾店', '青枫路店', '云栖小镇店', '海港城店', '新天地店', '世纪汇店',
  '万象城店', '银泰中心店', '龙湖天街店', '凯德广场店', '来福士店', '太古里店',
  '恒隆广场店', '大悦城店', '印象城店', '环贸广场店', '合生汇店', '荟聚中心店',
  '龙之梦店', '宝龙广场店', '万达广场店', '苏宁广场店'
];

export const OUTLET_STORE_NAMES = [
  '奥莱·东岸店', '奥莱·西岭店', '奥莱·南湖店', '奥莱·北苑店',
  '奥莱·云谷店', '奥莱·江畔店', '奥莱·晴岚店', '奥莱·松间店'
];

export const NEVER_OBSERVED_STORE_NAMES = ['新城筹备店', '老码头店'];

export const CORE_BATCHES = [
  { id: 'W01', label: '春季主问卷', season: '2026 春', block: 'core' },
  { id: 'W02', label: '春季回访', season: '2026 春', block: 'core' },
  { id: 'W03', label: '五一高峰问卷', season: '2026 春', block: 'core' },
  { id: 'W04', label: '夏季主问卷', season: '2026 夏', block: 'core' },
  { id: 'W05', label: '夏季回访', season: '2026 夏', block: 'core' },
  { id: 'W06', label: '秋季主问卷', season: '2026 秋', block: 'core' },
  { id: 'W07', label: '秋季回访', season: '2026 秋', block: 'core' },
  { id: 'W08', label: '双十一高峰问卷', season: '2026 秋', block: 'core' }
];

export const OUTLET_BATCHES = [
  { id: 'O01', label: '奥莱春季问卷', season: '2026 春', block: 'outlet' },
  { id: 'O02', label: '奥莱夏季问卷', season: '2026 夏', block: 'outlet' },
  { id: 'O03', label: '奥莱秋季问卷', season: '2026 秋', block: 'outlet' },
  { id: 'O04', label: '奥莱店庆问卷', season: '2026 秋', block: 'outlet' }
];

export const DEFAULT_HOLDOUT_BATCHES = ['W05', 'O02'];

/** Small deterministic PRNG (mulberry32). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  const u = Math.max(rand(), 1e-9);
  const v = Math.max(rand(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

export function generateDataset(seed = SEED) {
  const rand = mulberry32(seed);
  const stores = [];
  const items = [];
  const observations = [];
  const storeLatent = new Map();
  const batches = [...CORE_BATCHES, ...OUTLET_BATCHES];
  const held = new Set(DEFAULT_HOLDOUT_BATCHES);

  batches.forEach((batch) => {
    batch.effect = Math.round(gaussian(rand) * 0.16 * 100) / 100;
  });
  const batchEffect = new Map(batches.map((b) => [b.id, b.effect]));

  // ---- Stores ----------------------------------------------------------
  CORE_STORE_NAMES.forEach((name, idx) => {
    const flagship = idx < 6;
    const format = flagship ? '旗舰店' : idx % 4 === 0 ? '社区店' : '标准店';
    const hasParking = idx % 6 !== 4;
    const hasFitting = idx % 8 !== 6;
    const hasFamily = flagship || idx % 4 === 0;
    const responsePropensity = Math.round(clamp(0.58 + rand() * 0.4 + (flagship ? 0.04 : 0), 0.5, 0.99) * 100) / 100;
    const store = {
      id: `S${String(idx + 1).padStart(2, '0')}`,
      name,
      block: 'core',
      format,
      region: ['华东', '华南', '华北', '西南'][idx % 4],
      facilities: { parking: hasParking, fitting: hasFitting, family: hasFamily },
      responsePropensity
    };
    stores.push(store);
    storeLatent.set(store.id, [gaussian(rand) * 0.48, gaussian(rand) * 0.42, gaussian(rand) * 0.36]);
  });

  OUTLET_STORE_NAMES.forEach((name, idx) => {
    const responsePropensity = Math.round(clamp(0.6 + rand() * 0.34, 0.55, 0.96) * 100) / 100;
    const store = {
      id: `S${String(CORE_STORE_NAMES.length + idx + 1).padStart(2, '0')}`,
      name,
      block: 'outlet',
      format: '奥莱店',
      region: ['华东', '华南', '华北', '西南'][idx % 4],
      facilities: { parking: idx % 3 !== 2, fitting: false, family: idx % 4 === 0 },
      responsePropensity
    };
    stores.push(store);
    storeLatent.set(store.id, [gaussian(rand) * 0.42, gaussian(rand) * 0.38, gaussian(rand) * 0.3]);
  });

  NEVER_OBSERVED_STORE_NAMES.forEach((name, idx) => {
    stores.push({
      id: `S${String(CORE_STORE_NAMES.length + OUTLET_STORE_NAMES.length + idx + 1).padStart(2, '0')}`,
      name,
      block: 'none',
      format: idx === 0 ? '筹备中' : '已闭店',
      region: '—',
      facilities: { parking: false, fitting: false, family: false },
      responsePropensity: 0
    });
  });

  // ---- Items -----------------------------------------------------------
  CORE_ITEM_DEFS.forEach((def, idx) => {
    items.push({
      id: `Q${String(idx + 1).padStart(2, '0')}`,
      name: def.name,
      category: def.category,
      block: 'core',
      description: def.requires
        ? `仅向具备${def.requires === 'parking' ? '停车' : def.requires === 'fitting' ? '试衣间' : '母婴'}条件的门店投放`
        : '全部主问卷门店投放'
    });
  });
  OUTLET_ITEM_DEFS.forEach((def, idx) => {
    items.push({
      id: `Q${String(CORE_ITEM_DEFS.length + idx + 1).padStart(2, '0')}`,
      name: def.name,
      category: def.category,
      block: 'outlet',
      description: '奥莱专用问卷投放'
    });
  });
  items.push({
    id: `Q${String(CORE_ITEM_DEFS.length + OUTLET_ITEM_DEFS.length + 1).padStart(2, '0')}`,
    name: '屋顶露台体验',
    category: '概念测试',
    block: 'none',
    description: '仅概念测试，未在任何问卷中投放'
  });

  const coreStores = stores.filter((s) => s.block === 'core');
  const outletStores = stores.filter((s) => s.block === 'outlet');
  const coreItems = items.filter((i) => i.block === 'core');
  const outletItems = items.filter((i) => i.block === 'outlet');
  const coreBatchIds = CORE_BATCHES.map((b) => b.id);
  const outletBatchIds = OUTLET_BATCHES.map((b) => b.id);
  const used = new Set();

  const makeValue = (store, def, batchId) => {
    const latent = storeLatent.get(store.id);
    const raw = def.base + (rand() - 0.5) * 0.34 +
      latent[0] * def.loading[0] + latent[1] * def.loading[1] + latent[2] * def.loading[2] +
      (batchEffect.get(batchId) || 0) + gaussian(rand) * 0.32;
    return round1(clamp(raw, 1.2, 5));
  };

  const addObservation = (store, item, def, batchId, block, value) => {
    const key = `${store.id}\u0001${item.id}`;
    if (used.has(key)) return false;
    used.add(key);
    observations.push({
      storeId: store.id,
      itemId: item.id,
      batchId,
      value,
      block,
      observed: true
    });
    return true;
  };

  const drawBatch = (store, pool) => {
    // Stores with lower propensity also respond to fewer waves; give each
    // store a small deterministic set of "participated" batches.
    const idx = Number(store.id.slice(1));
    const k = store.block === 'core'
      ? 4 + (idx % 3) + (store.format === '旗舰店' ? 1 : 0)
      : 2 + (idx % 2);
    const ordered = [...pool];
    for (let i = ordered.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
    }
    const chosen = ordered.slice(0, Math.min(k, ordered.length)).map((b) => b.id);
    return chosen[Math.floor(rand() * chosen.length)];
  };

  // ---- Core block ------------------------------------------------------
  coreStores.forEach((store) => {
    coreItems.forEach((item) => {
      const def = CORE_ITEM_DEFS[coreItems.indexOf(item)];
      if (def.requires && !store.facilities[def.requires]) {
        // The item is not fielded at stores lacking the facility: a
        // structural reason for missingness, not a failed response.
        if (rand() < 0.94) return;
      }
      const batchId = drawBatch(store, CORE_BATCHES);
      const value = makeValue(store, def, batchId);
      const facilityPenalty = def.requires && !store.facilities[def.requires] ? 0.45 : 0;
      const scorePenalty = clamp((4.1 - value) * 0.12, -0.06, 0.36);
      const pObs = clamp(
        0.36 + store.responsePropensity * 0.34 + def.pop * 0.28 - facilityPenalty - scorePenalty,
        0.07, 0.94
      );
      if (rand() < pObs) addObservation(store, item, def, batchId, 'core', value);
    });
  });

  // ---- Outlet block ----------------------------------------------------
  outletStores.forEach((store) => {
    outletItems.forEach((item) => {
      const def = OUTLET_ITEM_DEFS[outletItems.indexOf(item)];
      if (def.requires && !store.facilities[def.requires]) {
        if (rand() < 0.9) return;
      }
      const batchId = drawBatch(store, OUTLET_BATCHES);
      const value = makeValue(store, def, batchId);
      const facilityPenalty = def.requires && !store.facilities[def.requires] ? 0.42 : 0;
      const scorePenalty = clamp((4.0 - value) * 0.1, -0.05, 0.3);
      const pObs = clamp(
        0.4 + store.responsePropensity * 0.32 + def.pop * 0.24 - facilityPenalty - scorePenalty,
        0.1, 0.95
      );
      if (rand() < pObs) addObservation(store, item, def, batchId, 'outlet', value);
    });
  });

  // ---- Support floor ---------------------------------------------------
  // Every *observed* store/item needs a few ratings so that holdouts and the
  // block probe have something to evaluate. New ratings are real synthetic
  // observations with a batch assignment; the missingness mechanism is not
  // rewritten after the fact.
  const observedStoreIds = new Set(observations.map((o) => o.storeId));
  const observedItemIds = new Set(observations.map((o) => o.itemId));
  const defByItemId = new Map();
  CORE_ITEM_DEFS.forEach((def, idx) => defByItemId.set(coreItems[idx].id, def));
  OUTLET_ITEM_DEFS.forEach((def, idx) => defByItemId.set(outletItems[idx].id, def));

  const ensureRow = (store, candidates, batchPool, block, minCount) => {
    let count = observations.filter((o) => o.storeId === store.id).length;
    const fresh = candidates.filter((item) => !used.has(`${store.id}\u0001${item.id}`));
    while (count < minCount && fresh.length) {
      const item = fresh.splice(Math.floor(rand() * fresh.length), 1)[0];
      const def = defByItemId.get(item.id);
      const batchId = batchPool[Math.floor(rand() * batchPool.length)].id;
      addObservation(store, item, def, batchId, block, makeValue(store, def, batchId));
      count += 1;
    }
  };
  const ensureColumn = (item, candidates, batchPool, block, minCount) => {
    let count = observations.filter((o) => o.itemId === item.id).length;
    const fresh = candidates.filter((store) => !used.has(`${store.id}\u0001${item.id}`));
    while (count < minCount && fresh.length) {
      const store = fresh.splice(Math.floor(rand() * fresh.length), 1)[0];
      const def = defByItemId.get(item.id);
      const batchId = batchPool[Math.floor(rand() * batchPool.length)].id;
      addObservation(store, item, def, batchId, block, makeValue(store, def, batchId));
      count += 1;
    }
  };

  coreStores.forEach((store) => ensureRow(store, coreItems, CORE_BATCHES, 'core', 4));
  outletStores.forEach((store) => ensureRow(store, outletItems, OUTLET_BATCHES, 'outlet', 2));
  coreItems.forEach((item) => ensureColumn(item, coreStores, CORE_BATCHES, 'core', 12));
  outletItems.forEach((item) => ensureColumn(item, outletStores, OUTLET_BATCHES, 'outlet', 4));

  // Guarantee every row and column has at least one *training* rating under
  // the default batch holdout, by relabeling an observation's batch. Values
  // are untouched; no observation is split.
  let relabeled = 0;
  const moveOffHoldout = (list, pool) => {
    if (list.some((o) => !held.has(o.batchId))) return;
    const target = list.find((o) => !o._moved);
    if (!target) return;
    const candidates = pool.filter((b) => !held.has(b.id));
    if (!candidates.length) return;
    target.batchId = candidates[0].id;
    target._moved = true;
    relabeled += 1;
  };
  for (const store of [...coreStores, ...outletStores]) {
    const pool = store.block === 'core' ? CORE_BATCHES : OUTLET_BATCHES;
    moveOffHoldout(observations.filter((o) => o.storeId === store.id), pool);
  }
  for (const item of [...coreItems, ...outletItems]) {
    const pool = item.block === 'core' ? CORE_BATCHES : OUTLET_BATCHES;
    moveOffHoldout(observations.filter((o) => o.itemId === item.id), pool);
  }
  observations.forEach((o) => delete o._moved);

  observations.sort((a, b) => a.storeId.localeCompare(b.storeId) || a.itemId.localeCompare(b.itemId));
  observations.forEach((o, idx) => { o.id = `obs-${String(idx + 1).padStart(4, '0')}`; });

  const batchSummaries = batches.map((batch) => ({
    id: batch.id,
    label: batch.label,
    season: batch.season,
    block: batch.block,
    effect: batch.effect,
    observationCount: observations.filter((o) => o.batchId === batch.id).length,
    isDefaultHoldout: held.has(batch.id)
  }));

  const storeObsCount = new Map();
  const itemObsCount = new Map();
  for (const o of observations) {
    storeObsCount.set(o.storeId, (storeObsCount.get(o.storeId) || 0) + 1);
    itemObsCount.set(o.itemId, (itemObsCount.get(o.itemId) || 0) + 1);
  }

  const totalCells = stores.length * items.length;
  const observedCells = observations.length;

  return {
    meta: {
      title: '门店体验评分补全实验室',
      seed,
      version: 1,
      generatedAt: '2026-11-22T09:00:00+08:00',
      synthetic: true,
      missingMechanism:
        '非均匀缺失：门店响应倾向、项目投放偏好、设施条件与真实评分共同影响是否被观测；批次之间还存在整体水平偏移；两个问卷块之间从未建立共同观测。',
      defaultHoldoutBatches: [...DEFAULT_HOLDOUT_BATCHES],
      defaultRank: 2,
      defaultLambda: 1.2,
      defaultInits: 4,
      relabeledForHoldoutSupport: relabeled,
      totalCells,
      observedCells,
      missingCells: totalCells - observedCells,
      observedRate: Math.round((observedCells / totalCells) * 1000) / 1000,
      storeCount: stores.length,
      itemCount: items.length
    },
    stores: stores.map((s) => ({
      ...s,
      observedCount: storeObsCount.get(s.id) || 0,
      displayBlock: s.block === 'core' ? '主问卷' : s.block === 'outlet' ? '奥莱问卷' : '从未观测'
    })),
    items: items.map((i) => ({
      ...i,
      observedCount: itemObsCount.get(i.id) || 0,
      displayBlock: i.block === 'core' ? '主问卷' : i.block === 'outlet' ? '奥莱问卷' : '从未投放'
    })),
    batches: batchSummaries,
    observations,
    observedStoreIds: [...observedStoreIds].sort(),
    observedItemIds: [...observedItemIds].sort()
  };
}

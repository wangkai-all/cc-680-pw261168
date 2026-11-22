import {
  renderLineChart, renderDotStrip, renderRangeBar, renderLegend, formatNumber
} from './charts.js';

/* ==========================================================================
   Small DOM helpers
   ========================================================================== */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(typeof child === 'string' || typeof child === 'number'
      ? document.createTextNode(String(child))
      : child);
  }
  return node;
}

const $ = (id) => document.getElementById(id);

/* ==========================================================================
   State
   ========================================================================== */

const LAMBDA_MIN = 0.05;
const LAMBDA_MAX = 100;

const state = {
  dataset: null,
  result: null,
  storeById: new Map(),
  itemById: new Map(),
  batchById: new Map(),
  rank: 2,
  lambda: 1.2,
  inits: 4,
  holdout: [],
  probe: null,
  probePreset: '',
  customProbe: { storeIds: [], itemIds: [] },
  view: 'estimate',
  sweepAxis: 'rank',
  sweep: null,
  sweepRequest: 0,
  supportTab: 'stores',
  tableFilter: 'all',
  selectedKey: null,
  runSeq: 0,
  debounce: null,
  sweepDebounce: null,
  lastFocused: null
};

const STATUS = {
  'observed-train': { label: '训练观测', kind: 'train', reason: '该评分在训练批次中，模型直接读取它。' },
  'observed-holdout': { label: '留出观测', kind: 'holdout', reason: '该评分属于整批留出的问卷；模型训练时看不到它，只用于评估。' },
  'observed-probe': { label: '遮蔽观测', kind: 'probe', reason: '该评分属于本次暂时遮住的区块；模型训练时看不到它，恢复后回到原数据。' },
  completed: { label: '可补全', kind: 'completed', reason: '该格没有原始评分，但所在行与列都在同一训练连通块内，具备训练支撑。' },
  'cross-block': { label: '跨块', kind: 'none', reason: '所在门店与评分项分属不同观测块，从未出现在同一条观测链上，没有共同依据。' },
  'no-row-observations': { label: '门店无观测', kind: 'none', reason: '这家门店在全部批次中都没有任何评分，无法给出估计。' },
  'no-item-observations': { label: '项目未投放', kind: 'none', reason: '这个评分项从未在任何问卷中投放，无法给出估计。' },
  'no-training-support': { label: '无训练支撑', kind: 'none', reason: '该格所在行或列在当前训练集中没有任何观测（可能全部被留出或遮住）。' },
  'training-split': { label: '训练关系拆断', kind: 'none', reason: '整批留出后，所在行与列在训练图中不再连通，不能借用彼此的信息。' }
};

const VIEW_NOTES = {
  estimate: '观测格显示原始评分；浅蓝格为低秩模型的补全值。空白与斜纹格不是 0 分，而是没有可用依据，保持缺失。',
  status: '按观测状态着色：训练、整批留出、区块遮蔽与可补全格严格区分；从未观测的行列保持斜纹空白。',
  residual: '只在“有真实评分且有补全值”的格子上显示残差（真实 − 补全）。空白 = 未观测或未评估，绝不画成 0。',
  stability: '只在可补全格上显示多次随机初始化之间的标准差；数值越大表示估计越依赖初始化路径。空白格不参与补全。'
};

/* ==========================================================================
   Utilities
   ========================================================================== */

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function lambdaFromSlider(t) {
  return LAMBDA_MIN * (LAMBDA_MAX / LAMBDA_MIN) ** (t / 100);
}

function sliderFromLambda(value) {
  return Math.round((100 * Math.log(value / LAMBDA_MIN)) / Math.log(LAMBDA_MAX / LAMBDA_MIN));
}

function trimNumber(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(digits).replace(/\.?0+$/, '') || '0';
}

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { toast.hidden = true; }, 3200);
}

function hexToRgb(hex) {
  const value = hex.trim().replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const n = Number.parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function mixHex(a, b, t) {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const k = clamp(t, 0, 1);
  const toHex = (n) => Math.round(n).toString(16).padStart(2, '0');
  return `#${toHex(ca.r + (cb.r - ca.r) * k)}${toHex(ca.g + (cb.g - ca.g) * k)}${toHex(ca.b + (cb.b - ca.b) * k)}`;
}

function readableOn(hex) {
  const { r, g, b } = hexToRgb(hex);
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.42 ? '#0b0b0b' : '#ffffff';
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function statusLabel(status) {
  return STATUS[status]?.label || status;
}

/* ==========================================================================
   API
   ========================================================================== */

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  let body = null;
  try { body = await res.json(); } catch { /* ignore */ }
  if (!res.ok) throw new Error(body?.error || `请求失败（${res.status}）`);
  return body;
}

function currentConfig() {
  return {
    rank: state.rank,
    lambda: state.lambda,
    inits: state.inits,
    holdoutBatches: state.holdout,
    probe: state.probe
      ? { storeIds: state.probe.storeIds, itemIds: state.probe.itemIds, label: state.probe.label }
      : null
  };
}

/* ==========================================================================
   Dataset bootstrap
   ========================================================================== */

async function loadDataset() {
  const payload = await fetchJson('/api/dataset');
  state.dataset = payload;
  state.storeById = new Map(payload.stores.map((s) => [s.id, s]));
  state.itemById = new Map(payload.items.map((i) => [i.id, i]));
  state.batchById = new Map(payload.batches.map((b) => [b.id, b]));
  state.rank = payload.meta.defaultRank;
  state.lambda = payload.meta.defaultLambda;
  state.inits = payload.meta.defaultInits || 4;
  state.holdout = [...payload.meta.defaultHoldoutBatches];

  $('dataset-chip').textContent =
    `${payload.stores.length} 门店 × ${payload.items.length} 项目 · ${payload.observations.length} 观测`;
  $('seed-text').textContent = String(payload.meta.seed);

  // Controls reflect defaults.
  $('rank-input').value = String(state.rank);
  $('rank-value').textContent = String(state.rank);
  $('inits-input').value = String(state.inits);
  $('inits-value').textContent = String(state.inits);
  $('lambda-input').value = String(sliderFromLambda(state.lambda));
  $('lambda-value').textContent = state.lambda.toFixed(2);

  buildBatchToggles();
  buildProbePresets(payload.presets);
  $('matrix-view').value = state.view;
  bindEvents();
  applyTheme(localStorage.getItem('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  await runAnalysis();
}

/* ==========================================================================
   Controls
   ========================================================================== */

function buildBatchToggles() {
  const host = $('batch-toggles');
  host.replaceChildren();
  const groups = [
    { block: 'core', title: '主问卷批次', filter: (b) => b.block === 'core' },
    { block: 'outlet', title: '奥莱问卷批次', filter: (b) => b.block === 'outlet' }
  ];
  const totalSelected = () => state.holdout.length;
  for (const group of groups) {
    const batches = state.dataset.batches.filter(group.filter);
    const list = el('div', { class: 'batch-list' });
    const title = el('div', { class: 'batch-group-title' },
      el('span', { text: group.title }),
      el('span', { text: `${batches.length} 个批次` })
    );
    for (const batch of batches) {
      const input = el('input', {
        type: 'checkbox',
        value: batch.id,
        checked: state.holdout.includes(batch.id),
        onchange: (event) => {
          if (event.target.checked) {
            if (!state.holdout.includes(batch.id)) state.holdout.push(batch.id);
          } else {
            state.holdout = state.holdout.filter((id) => id !== batch.id);
          }
          updateHoldoutSummary();
          scheduleAnalysis();
        }
      });
      const chip = el('label', { class: 'batch-chip', title: `${batch.label} · ${batch.observationCount} 个观测` },
        input,
        el('span', { class: 'chip-box', 'aria-hidden': 'true' }),
        el('span', { class: 'chip-text', text: `${batch.id} ${batch.label}` }),
        el('span', { class: 'chip-count', text: String(batch.observationCount) })
      );
      list.append(chip);
    }
    host.append(el('div', { class: 'batch-group' }, title, list));
  }
  updateHoldoutSummary();
}

function updateHoldoutSummary() {
  const dataset = state.dataset;
  if (!dataset) return;
  const selected = new Set(state.holdout);
  const heldObs = dataset.observations.filter((o) => selected.has(o.batchId)).length;
  const trainObs = dataset.observations.length - heldObs;
  const coveredRows = dataset.stores.filter((s) => s.observedCount > 0 &&
    dataset.observations.some((o) => o.storeId === s.id && !selected.has(o.batchId))).length;
  const coveredCols = dataset.items.filter((i) => i.observedCount > 0 &&
    dataset.observations.some((o) => o.itemId === i.id && !selected.has(o.batchId))).length;
  $('holdout-summary').replaceChildren(
    el('span', {}, '已选 ', el('strong', { text: String(state.holdout.length) }), ' 个批次'),
    el('span', {}, '整批留出 ', el('strong', { text: String(heldObs) }), ' 个观测'),
    el('span', {}, '进入训练 ', el('strong', { text: String(trainObs) }), ' 个观测'),
    el('span', {}, '训练图覆盖 ', el('strong', { text: `${coveredRows} 行 / ${coveredCols} 列` }))
  );
}

function buildProbePresets(presets) {
  const select = $('probe-preset');
  select.replaceChildren(el('option', { value: '', text: '选择一个区块…' }));
  for (const preset of presets) {
    select.append(el('option', { value: preset.id, text: preset.label }));
  }
  select.append(el('option', { value: 'custom', text: '自定义：在图例下方添加待遮行/列' }));
  select.addEventListener('change', () => {
    state.probePreset = select.value;
    updateProbePresetDescription();
    renderCustomProbe();
  });
  updateProbePresetDescription();
  renderCustomProbe();
}

function customProbeCounts() {
  const stores = new Set(state.customProbe.storeIds);
  const items = new Set(state.customProbe.itemIds);
  let known = 0;
  for (const obs of state.dataset.observations) {
    if (stores.has(obs.storeId) && items.has(obs.itemId)) known += 1;
  }
  return { stores: stores.size, items: items.size, known };
}

function renderCustomProbe() {
  const host = $('custom-probe');
  host.replaceChildren();
  if (state.probePreset !== 'custom') {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const { stores, items, known } = customProbeCounts();

  const addSelect = (kind) => {
    const all = kind === 'store' ? state.dataset.stores : state.dataset.items;
    const chosen = new Set(kind === 'store' ? state.customProbe.storeIds : state.customProbe.itemIds);
    const select = el('select', { class: 'select select-small', 'aria-label': kind === 'store' ? '添加门店到待遮区块' : '添加评分项到待遮区块' },
      el('option', { value: '', text: kind === 'store' ? '添加门店…' : '添加评分项…' }),
      ...all.map((node) => el('option', {
        value: node.id,
        text: `${node.id} ${node.name}${chosen.has(node.id) ? '（已选）' : ''}`
      }))
    );
    select.addEventListener('change', () => {
      if (!select.value) return;
      if (kind === 'store' && !state.customProbe.storeIds.includes(select.value)) {
        state.customProbe.storeIds.push(select.value);
      }
      if (kind === 'item' && !state.customProbe.itemIds.includes(select.value)) {
        state.customProbe.itemIds.push(select.value);
      }
      renderCustomProbe();
    });
    return select;
  };

  const chips = (kind) => {
    const ids = kind === 'store' ? state.customProbe.storeIds : state.customProbe.itemIds;
    if (!ids.length) {
      return el('div', { class: 'custom-chips' }, el('span', { class: 'custom-empty', text: kind === 'store' ? '尚未选择门店' : '尚未选择评分项' }));
    }
    return el('div', { class: 'custom-chips' }, ...ids.map((id) => {
      const node = kind === 'store' ? state.storeById.get(id) : state.itemById.get(id);
      return el('button', {
        type: 'button',
        class: 'custom-chip',
        title: '点击移除',
        onclick: () => {
          if (kind === 'store') state.customProbe.storeIds = state.customProbe.storeIds.filter((x) => x !== id);
          else state.customProbe.itemIds = state.customProbe.itemIds.filter((x) => x !== id);
          renderCustomProbe();
        }
      }, `${node?.name || id} ✕`);
    }));
  };

  host.append(
    el('p', { class: 'section-hint', text: '自定义整块：选择至少一行和一列，交叉的已知评分将被暂时遮住。' }),
    el('div', { class: 'custom-probe-group' },
      el('div', { class: 'custom-probe-label', text: '行（门店）' }),
      chips('store'), addSelect('store')
    ),
    el('div', { class: 'custom-probe-group' },
      el('div', { class: 'custom-probe-label', text: '列（评分项）' }),
      chips('item'), addSelect('item')
    ),
    el('p', { class: 'control-hint', text: `当前区块 ${stores} 行 × ${items} 列，包含 ${known} 个已知观测；不足 1 行或 1 列时不会启用。` })
  );
}

function updateProbePresetDescription() {
  const preset = state.dataset.presets.find((p) => p.id === state.probePreset);
  const desc = $('probe-preset-desc');
  if (preset) {
    const sizes = `${preset.storeIds.length} 家门店 × ${preset.itemIds.length} 个项目`;
    desc.textContent = `${preset.description}（${sizes}）`;
  } else if (state.probePreset === 'custom') {
    desc.textContent = '在下方自定义行与列；至少各选一项才能遮蔽。';
  } else {
    desc.textContent = '选择一个整块，右侧会预览将被遮住的行列。';
  }
}

function setProbeFromPreset() {
  if (state.probePreset === 'custom') {
    const { stores, items, known } = customProbeCounts();
    if (!stores || !items) {
      showToast('自定义区块至少需要 1 行和 1 列');
      return false;
    }
    if (!known) {
      showToast('该区块内没有已知评分，遮住它不会检验任何东西');
      return false;
    }
    state.probe = {
      storeIds: [...state.customProbe.storeIds],
      itemIds: [...state.customProbe.itemIds],
      label: `自定义 ${stores}×${items} 区块`
    };
    return true;
  }
  const preset = state.dataset.presets.find((p) => p.id === state.probePreset);
  if (!preset) {
    showToast('请先选择一个预置区块');
    return false;
  }
  state.probe = {
    storeIds: [...preset.storeIds],
    itemIds: [...preset.itemIds],
    label: preset.label
  };
  return true;
}

function updateProbeUI() {
  const active = Boolean(state.probe);
  const badge = $('probe-state');
  badge.textContent = active ? '遮蔽中' : '未启用';
  badge.classList.toggle('badge--on', active);
  $('probe-apply').disabled = active;
  $('probe-reveal').disabled = !active;
  if (active) {
    $('probe-preset-desc').textContent =
      `正在遮住：${state.probe.label}（${state.probe.storeIds.length} 行 × ${state.probe.itemIds.length} 列）。模型完全看不到这些已知评分。`;
  } else {
    updateProbePresetDescription();
  }
}

function bindEvents() {
  $('rank-input').addEventListener('input', (event) => {
    state.rank = Number(event.target.value);
    $('rank-value').textContent = String(state.rank);
    scheduleAnalysis();
  });
  $('lambda-input').addEventListener('input', (event) => {
    state.lambda = Number(lambdaFromSlider(Number(event.target.value)).toFixed(3));
    $('lambda-value').textContent = state.lambda.toFixed(2);
    scheduleAnalysis();
  });
  $('inits-input').addEventListener('input', (event) => {
    state.inits = Number(event.target.value);
    $('inits-value').textContent = String(state.inits);
    scheduleAnalysis();
  });

  $('run-btn').addEventListener('click', () => runAnalysis());
  $('holdout-default').addEventListener('click', () => {
    state.holdout = [...state.dataset.meta.defaultHoldoutBatches];
    syncBatchCheckboxes();
    updateHoldoutSummary();
    runAnalysis();
  });
  $('holdout-none').addEventListener('click', () => {
    state.holdout = [];
    syncBatchCheckboxes();
    updateHoldoutSummary();
    runAnalysis();
  });

  $('probe-apply').addEventListener('click', () => {
    if (!setProbeFromPreset()) return;
    updateProbeUI();
    runAnalysis();
  });
  $('probe-reveal').addEventListener('click', () => {
    state.probe = null;
    updateProbeUI();
    showToast('已恢复原数据：遮蔽区块回到训练与评估中。');
    runAnalysis();
  });

  for (const btn of document.querySelectorAll('[data-mode]')) {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode === 'probe') {
        $('probe-preset').focus();
        $('probe-section').scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      setSweepAxis(mode === 'sweep-lambda' ? 'lambda' : 'rank');
      $('sweep-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }
  for (const btn of document.querySelectorAll('[data-sweep]')) {
    btn.addEventListener('click', () => setSweepAxis(btn.dataset.sweep));
  }
  for (const btn of document.querySelectorAll('[data-support]')) {
    btn.addEventListener('click', () => {
      state.supportTab = btn.dataset.support;
      renderSupport();
    });
  }
  for (const btn of document.querySelectorAll('.table-toggle')) {
    btn.addEventListener('click', () => {
      const target = $(btn.dataset.target);
      const show = target.hidden;
      target.hidden = !show;
      btn.setAttribute('aria-expanded', String(show));
      btn.textContent = show ? '收起表格' : '表格';
    });
  }

  $('matrix-view').addEventListener('change', (event) => {
    state.view = event.target.value;
    renderMatrix();
  });
  $('matrix-export').addEventListener('click', exportCsv);

  $('table-filter').addEventListener('change', (event) => {
    state.tableFilter = event.target.value;
    renderRecords();
  });

  $('drawer-close').addEventListener('click', closeDrawer);
  $('drawer-backdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('cell-drawer').hidden) closeDrawer();
  });

  $('theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    if (state.result) {
      renderMatrix();
      renderResidualScale();
      renderCurve();
      renderDiagnostics();
    }
    if (state.sweep) renderSweep();
    if (!$('cell-drawer').hidden && state.selectedKey) {
      const cell = state.result?.cells.find((c) => c.key === state.selectedKey);
      if (cell) openDrawer(cell);
    }
  });

  // Keep the segmented controls in sync.
  setSweepAxis(state.sweepAxis, false);
}

function syncBatchCheckboxes() {
  for (const input of document.querySelectorAll('#batch-toggles input[type="checkbox"]')) {
    input.checked = state.holdout.includes(input.value);
  }
}

function setSweepAxis(axis, trigger = true) {
  state.sweepAxis = axis;
  for (const btn of document.querySelectorAll('[data-sweep]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.sweep === axis));
  }
  for (const btn of document.querySelectorAll('[data-mode]')) {
    btn.setAttribute('aria-pressed', String(
      (axis === 'rank' && btn.dataset.mode === 'sweep-rank') ||
      (axis === 'lambda' && btn.dataset.mode === 'sweep-lambda')
    ));
  }
  if (trigger) scheduleSweep(true);
}

/* ==========================================================================
   Analysis lifecycle
   ========================================================================== */

function scheduleAnalysis() {
  clearTimeout(state.debounce);
  state.debounce = setTimeout(() => runAnalysis(), 260);
}

async function runAnalysis() {
  clearTimeout(state.debounce);
  const seq = ++state.runSeq;
  const panel = document.body;
  panel.classList.add('is-refreshing');
  $('run-btn').disabled = true;
  $('run-btn').classList.add('is-running');
  try {
    const result = await fetchJson('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(currentConfig())
    });
    if (seq !== state.runSeq) return;
    state.result = result;
    state.selectedKey = null;
    renderAll();
    scheduleSweep(false);
  } catch (error) {
    if (seq === state.runSeq) showToast(error.message || '分析失败');
  } finally {
    if (seq === state.runSeq) {
      panel.classList.remove('is-refreshing');
      $('run-btn').disabled = false;
      $('run-btn').classList.remove('is-running');
    }
  }
}

function scheduleSweep(force) {
  clearTimeout(state.sweepDebounce);
  state.sweepDebounce = setTimeout(() => loadSweep(force), 320);
}

async function loadSweep() {
  if (!state.result) return;
  const seq = ++state.sweepRequest;
  try {
    const sweep = await fetchJson('/api/sweep', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...currentConfig(),
        axis: state.sweepAxis,
        inits: Math.max(2, state.inits)
      })
    });
    if (seq !== state.sweepRequest) return;
    state.sweep = sweep;
    renderSweep();
  } catch (error) {
    if (seq === state.sweepRequest) showToast(`扫描失败：${error.message}`);
  }
}

/* ==========================================================================
   Render orchestration
   ========================================================================== */

function renderAll() {
  if (!state.result) return;
  updateProbeUI();
  renderWarnings();
  renderTiles();
  renderMatrix();
  renderCurve();
  renderSweep();
  renderBatchErrors();
  renderDiagnostics();
  renderComponents();
  renderSupport();
  renderRecords();
  renderFitTable();
}

function renderWarnings() {
  const host = $('warnings');
  const warnings = [...(state.result?.warnings || [])];
  const order = { critical: 0, warning: 1, info: 2 };
  warnings.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
  host.replaceChildren();
  if (!warnings.length) {
    host.append(el('div', { class: 'notice notice--info' },
      el('span', { class: 'notice-icon', 'aria-hidden': 'true', text: 'i' }),
      el('div', {},
        el('p', { class: 'notice-title', text: '未发现需要提示的问题' }),
        el('p', { class: 'notice-text', text: '当前配置下没有从未观测的行列、跨块补全或不可评估的留出批次。' })
      )
    ));
    return;
  }
  for (const warning of warnings) {
    const icon = warning.severity === 'info' ? 'i' : '!';
    host.append(el('div', { class: `notice notice--${warning.severity}` },
      el('span', { class: 'notice-icon', 'aria-hidden': 'true', text: icon }),
      el('div', {},
        el('p', { class: 'notice-title', text: warning.title }),
        el('p', { class: 'notice-text', text: warning.message })
      )
    ));
  }
}

function renderTiles() {
  const result = state.result;
  const counts = result.cellCounts;
  const errors = result.errors;

  const trainValue = $('tile-train-value');
  const trainMeta = $('tile-train-meta');
  trainValue.textContent = errors.train.count ? formatNumber(errors.train.rmse, 3) : '—';
  trainValue.classList.toggle('tile-value--empty', !errors.train.count);
  trainMeta.replaceChildren();
  if (errors.train.count) {
    trainMeta.append(
      el('span', { class: 'mono', text: String(errors.train.count) }), ' 个训练观测 · MAE ',
      el('span', { class: 'mono', text: formatNumber(errors.train.mae, 3) }),
      ` · 偏差 ${formatNumber(errors.train.bias, 3)}`
    );
  } else {
    trainMeta.textContent = '没有训练观测，模型无法拟合';
  }

  const holdoutValue = $('tile-holdout-value');
  const holdoutMeta = $('tile-holdout-meta');
  holdoutValue.textContent = errors.holdout.count ? formatNumber(errors.holdout.rmse, 3) : '—';
  holdoutValue.classList.toggle('tile-value--empty', !errors.holdout.count);
  holdoutMeta.replaceChildren();
  if (errors.holdout.count) {
    holdoutMeta.append(
      el('span', { class: 'mono', text: String(errors.holdout.count) }), ' 个留出观测 · MAE ',
      el('span', { class: 'mono', text: formatNumber(errors.holdout.mae, 3) }),
      ` · 偏差 ${formatNumber(errors.holdout.bias, 3)}`
    );
    if (errors.holdoutUnevaluatedCount > 0) {
      holdoutMeta.append(` · ${errors.holdoutUnevaluatedCount} 个因缺少训练支撑未评估`);
    }
  } else if (errors.holdoutObservationCount > 0) {
    holdoutMeta.textContent =
      `${errors.holdoutObservationCount} 个留出观测全部无法评估；没有把未知格当作 0 误差。`;
  } else {
    holdoutMeta.textContent = '没有整批留出的观测。训练误差不能代替留出误差。';
  }

  const probeValue = $('tile-probe-value');
  const probeMeta = $('tile-probe-meta');
  const probe = result.probeReport;
  if (probe.active && probe.metrics?.count) {
    probeValue.textContent = formatNumber(probe.metrics.rmse, 3);
    probeValue.classList.remove('tile-value--empty');
    probeMeta.textContent = `${probe.evaluatedCells} 个已知评分被遮住后重建 · MAE ${formatNumber(probe.metrics.mae, 3)}`;
  } else if (probe.active) {
    probeValue.textContent = '—';
    probeValue.classList.add('tile-value--empty');
    probeMeta.textContent = '遮蔽区没有可评估的已知评分（可能因此失去训练支撑）';
  } else {
    probeValue.textContent = '—';
    probeValue.classList.add('tile-value--empty');
    probeMeta.textContent = '未启用区块遮蔽；随机留点看不出整块失败';
  }

  const coverageValue = $('tile-coverage-value');
  const coverageMeta = $('tile-coverage-meta');
  coverageValue.textContent = `${counts.completed} / ${counts.observed}`;
  coverageValue.classList.remove('tile-value--empty');
  coverageMeta.textContent =
    `${counts.crossBlock} 个跨块格、${counts.noRowObservations + counts.noItemObservations} 个从未观测格保持缺失`;
}

/* ==========================================================================
   Matrix
   ========================================================================== */

function cellDescriptor(cell) {
  const view = state.view;
  const store = state.storeById.get(cell.storeId);
  const item = state.itemById.get(cell.itemId);
  const base = { text: '', className: '', style: null, title: '', clickable: true };

  const observedText = cell.observed ? trimNumber(cell.value, 1) : '';
  const completedText = cell.estimate != null ? trimNumber(cell.estimate, 2) : '';

  if (view === 'status') {
    if (cell.status === 'observed-train') {
      base.text = observedText;
      base.className = 'm-cell--observed-train';
    } else if (cell.status === 'observed-holdout') {
      base.text = observedText;
      base.className = 'm-cell--observed-holdout';
    } else if (cell.status === 'observed-probe') {
      base.text = observedText;
      base.className = 'm-cell--observed-probe';
    } else if (cell.status === 'completed') {
      base.text = '·';
      base.className = 'm-cell--completed';
    } else if (cell.status === 'cross-block') {
      base.text = '×';
      base.className = 'm-cell--cross-block';
    } else if (cell.status === 'no-row-observations' || cell.status === 'no-item-observations') {
      base.text = '∅';
      base.className = `m-cell--${cell.status}`;
    } else {
      base.text = '…';
      base.className = `m-cell--${cell.status}`;
    }
  } else if (view === 'estimate') {
    if (cell.observed) {
      base.text = observedText;
      base.className = cell.status === 'observed-train'
        ? 'm-cell--observed-train'
        : cell.status === 'observed-holdout'
          ? 'm-cell--observed-holdout'
          : 'm-cell--observed-probe';
    } else if (cell.status === 'completed') {
      base.text = completedText;
      base.className = 'm-cell--completed';
    } else if (cell.status === 'cross-block') {
      base.text = '×';
      base.className = 'm-cell--cross-block';
    } else if (cell.status === 'no-row-observations' || cell.status === 'no-item-observations') {
      base.text = '∅';
      base.className = `m-cell--${cell.status}`;
    } else {
      base.text = '…';
      base.className = `m-cell--${cell.status}`;
    }
  } else if (view === 'residual') {
    if (cell.observed && cell.estimate != null) {
      const residual = cell.value - cell.estimate;
      const scale = state.result.errors.holdout?.maxAbs || 1;
      const maxAbs = Math.max(0.35, Math.min(2, Math.max(scale, Math.abs(residual))));
      const t = clamp(residual / maxAbs, -1, 1);
      const mid = cssVar('--div-mid');
      const color = t < 0
        ? mixHex(mid, cssVar('--div-neg-2'), Math.abs(t))
        : mixHex(mid, cssVar('--div-pos-2'), t);
      base.text = `${residual >= 0 ? '+' : '−'}${Math.abs(residual).toFixed(2)}`;
      base.className = '';
      base.style = { background: color, color: readableOn(color) };
    } else if (cell.status === 'completed') {
      base.text = '—';
      base.className = 'm-cell--completed';
      base.title = '可补全格没有真实评分，因此没有残差可画；不会以 0 代替。';
    } else if (cell.status === 'cross-block' || cell.status.startsWith('no-')) {
      base.text = '';
      base.className = `m-cell--${cell.status}`;
    } else {
      base.className = 'm-cell--no-training-support';
    }
  } else if (view === 'stability') {
    if (cell.status === 'completed' && cell.stabilitySd != null) {
      const steps = ['--seq-100', '--seq-200', '--seq-300', '--seq-400', '--seq-600'].map(cssVar);
      const thresholds = [0.005, 0.02, 0.05, 0.1];
      let idx = thresholds.findIndex((t) => cell.stabilitySd <= t);
      if (idx < 0) idx = 4;
      const color = steps[idx];
      base.text = cell.stabilitySd.toFixed(3);
      base.className = '';
      base.style = { background: color, color: readableOn(color) };
    } else if (cell.status === 'completed') {
      base.text = '—';
      base.className = 'm-cell--completed';
      base.title = '初始化次数为 1 时无法比较稳定度。';
    } else if (cell.observed) {
      base.text = '·';
      base.className = 'm-cell--observed-train';
      base.style = { background: 'var(--surface-2)', color: 'var(--muted)' };
    } else if (cell.status === 'cross-block' || cell.status.startsWith('no-')) {
      base.text = '';
      base.className = `m-cell--${cell.status}`;
    }
  }

  const bits = [`${store?.name || cell.storeId} × ${item?.name || cell.itemId}`, statusLabel(cell.status)];
  if (cell.observed) bits.push(`真实评分 ${trimNumber(cell.value, 1)}`);
  if (cell.estimate != null) bits.push(`补全 ${trimNumber(cell.estimate, 2)}`);
  if (cell.stabilitySd != null) bits.push(`初始化标准差 ${cell.stabilitySd.toFixed(3)}`);
  if (!cell.estimate && !cell.observed) bits.push('无估计，保持缺失');
  base.title = cell.title || bits.join(' · ');
  base.ariaLabel = bits.join('，');
  return base;
}

function renderMatrix() {
  const result = state.result;
  if (!result) return;
  const dataset = state.dataset;
  const items = dataset.items;
  const stores = dataset.stores;
  const host = $('matrix');
  const cellMap = new Map(result.cells.map((c) => [c.key, c]));

  const probeStores = new Set(result.probeReport?.storeIds || []);
  const probeItems = new Set(result.probeReport?.itemIds || []);

  host.style.gridTemplateColumns = `168px repeat(${items.length}, 38px)`;

  const fragment = document.createDocumentFragment();
  const cellNodeMap = new Map();
  fragment.append(el('div', { class: 'm-corner' }, el('span', { text: '门店 ＼ 评分项' })));

  for (const item of items) {
    const unobserved = item.observedCount === 0;
    const blocked = probeItems.has(item.id);
    fragment.append(el('div', {
      class: `m-head${unobserved ? ' m-head--blocked' : ''}`,
      title: `${item.id} ${item.name} · ${item.category} · ${item.description} · 全部观测 ${item.observedCount}`,
      'aria-label': `${item.name}，${item.displayBlock}，全部观测 ${item.observedCount} 个`
    },
    el('span', { class: 'm-head-code', text: item.id }),
    el('span', { class: 'm-head-name', text: item.name }),
    el('span', {
      class: 'chip-count',
      text: blocked ? '已遮蔽' : unobserved ? '未投放' : `${item.observedCount}`
    })
    ));
  }

  for (const store of stores) {
    const rowUnobserved = store.observedCount === 0;
    const rowProbe = probeStores.has(store.id);
    fragment.append(el('div', {
      class: `m-rowhead${rowUnobserved ? ' m-rowhead--unobserved' : ''}${rowProbe ? ' m-rowhead--probe' : ''}`,
      title: `${store.name} · ${store.format} · ${store.region} · 全部观测 ${store.observedCount} 个`
    },
    el('span', { class: 'rh-name', text: store.name }),
    el('span', { class: 'rh-meta' },
      el('span', { text: rowUnobserved ? '从未观测' : `${store.observedCount} 观测` }),
      store.block !== 'none' ? el('span', { text: store.displayBlock }) : null
    )
    ));

    for (const item of items) {
      const cell = cellMap.get(`${store.id}\u0001${item.id}`);
      if (!cell) continue;
      const desc = cellDescriptor(cell);
      const node = el('button', {
        type: 'button',
        class: `m-cell m-cell--clickable m-cell-loc-${store.id}-${item.id} ${desc.className}${state.selectedKey === cell.key ? ' m-cell--selected' : ''}`,
        title: desc.title,
        'aria-label': desc.ariaLabel,
        style: desc.style || undefined,
        dataset: { key: cell.key },
        onclick: () => openDrawer(cell)
      }, el('span', { class: 'cell-mark', text: desc.text }));
      cellNodeMap.set(cell.key, node);
      fragment.append(node);
    }
  }

  host.replaceChildren(fragment);
  renderMatrixLegend();
  renderMatrixScale();
  renderMatrixFoot();
  if (state.selectedKey) {
    const node = cellNodeMap.get(state.selectedKey);
    if (node) node.classList.add('m-cell--selected');
  }
}

function renderMatrixLegend() {
  const host = $('matrix-legend');
  host.replaceChildren();
  const swatch = (background, label, extra = '') => el('span', { class: 'mleg' },
    el('span', { class: 'mleg-swatch', style: { background }, 'aria-hidden': 'true' }),
    el('span', { text: label }),
    extra ? el('span', { class: 'chip-count', text: extra }) : null
  );
  const view = state.view;
  if (view === 'status' || view === 'estimate') {
    host.append(
      swatch('var(--seq-400)', '训练观测'),
      swatch('var(--series-2)', '整批留出观测'),
      swatch(`repeating-linear-gradient(135deg, var(--probe), var(--probe) 4px, color-mix(in srgb, var(--probe) 70%, #fff) 4px, color-mix(in srgb, var(--probe) 70%, #fff) 8px)`, '区块遮蔽（本次未知）'),
      swatch(`color-mix(in srgb, var(--seq-100) 62%, var(--surface-1))`, '模型补全值'),
      swatch(`repeating-linear-gradient(135deg, var(--surface-1), var(--surface-1) 5px, var(--ghost-2) 5px, var(--ghost-2) 7px)`, '跨块无依据'),
      swatch(`repeating-linear-gradient(135deg, var(--surface-1), var(--surface-1) 5px, var(--ghost) 5px, var(--ghost) 7px)`, '从未观测的行/列')
    );
  } else if (view === 'residual') {
    const ramp = el('span', { class: 'mleg' },
      el('span', { text: '高估（补全 > 真实）' }),
      el('span', { class: 'scale-ramp', 'aria-hidden': 'true' },
        ...['--div-neg-2', '--div-neg-1', '--div-mid', '--div-pos-1', '--div-pos-2'].map((v) =>
          el('span', { class: 'scale-step', style: { background: `var(${v})` } }))
      ),
      el('span', { text: '低估（补全 < 真实）' })
    );
    host.append(ramp, el('span', { class: 'mleg', text: '空白 = 未观测或不可补全（不画成 0）' }));
  } else {
    host.append(
      el('span', { class: 'mleg', text: '初始化标准差：' }),
      el('span', { class: 'mleg' },
        el('span', { class: 'scale-ramp', 'aria-hidden': 'true' },
          ...['--seq-100', '--seq-200', '--seq-300', '--seq-400', '--seq-600'].map((v) =>
            el('span', { class: 'scale-step', style: { background: `var(${v})` } }))
        ),
        el('span', { text: '低 → 高（≥ 0.10）' })
      ),
      el('span', { class: 'mleg', text: '仅补全格；观测格不参与' })
    );
  }
}

function renderMatrixScale() {
  const host = $('matrix-scale');
  host.replaceChildren();
  if (state.view === 'stability') {
    host.append(
      el('span', { text: '色阶：初始化标准差 0 → ≥ 0.10；阈值 0.005 / 0.02 / 0.05 / 0.10' })
    );
  } else if (state.view === 'residual') {
    host.append(
      el('span', { text: '残差 = 真实评分 − 补全值。留出与遮蔽观测都参与展示；训练观测的残差属于训练拟合。' })
    );
  } else {
    host.append(
      el('span', { text: '评分范围 1–5。观测值保留一位小数；补全值显示两位小数。' })
    );
  }
  host.append(el('span', { text: VIEW_NOTES[state.view] }));
}

function renderResidualScale() {
  if (state.view === 'residual') renderMatrixScale();
}

function renderMatrixFoot() {
  const host = $('matrix-foot');
  const counts = state.result.cellCounts;
  host.replaceChildren();
  host.append(
    el('span', {}, `矩阵 ${counts.total} 格：${counts.observed} 个真实观测，${counts.completed} 个可补全，` +
      `${counts.crossBlock} 个跨块，${counts.noTrainingSupport + counts.trainingSplit} 个缺训练支撑，` +
      `${counts.noRowObservations + counts.noItemObservations} 个涉及从未观测的行或列。`),
    el('span', { text: ' 空白与斜纹格表示“没有依据”，不是 0 分；它们不参与任何误差计算。' })
  );
}

/* ==========================================================================
   Curve
   ========================================================================== */

function colorRoles() {
  return {
    train: cssVar('--series-1'),
    holdout: cssVar('--series-2'),
    probe: cssVar('--probe')
  };
}

function renderCurve() {
  const result = state.result;
  const host = $('curve-chart');
  const legendHost = $('curve-legend');
  const note = $('curve-note');
  const histories = result.histories || [];
  const roles = colorRoles();

  if (!histories.length) {
    renderLineChart(host, {
      series: [], xValues: [], ariaLabel: '训练与留出误差曲线',
      emptyNote: '没有可拟合的训练连通块'
    });
    legendHost.replaceChildren();
    note.textContent = '训练集为空：当前留出/遮蔽把全部观测都排除了。';
    buildCurveTable([]);
    return;
  }

  const maxIter = Math.max(...histories.flatMap((h) => h.history.map((p) => p.iteration)));
  const xValues = Array.from({ length: maxIter + 1 }, (_, i) => String(i));

  const aggregate = Array.from({ length: maxIter + 1 }, (_, t) => {
    let trainSum = 0;
    let trainCount = 0;
    let holdSum = 0;
    let holdCount = 0;
    for (const h of histories) {
      const point = h.history[Math.min(t, h.history.length - 1)];
      if (point.trainRmse != null) { trainSum += point.trainRmse; trainCount += 1; }
      if (point.reportRmse != null) { holdSum += point.reportRmse; holdCount += 1; }
    }
    return {
      iteration: t,
      train: trainCount ? trainSum / trainCount : null,
      holdout: holdCount ? holdSum / holdCount : null
    };
  });

  const series = [
    { name: '训练误差 RMSE', color: roles.train, points: aggregate.map((p) => ({ x: p.iteration, y: p.train })) },
    { name: '留出观测误差 RMSE', color: roles.holdout, points: aggregate.map((p) => ({ x: p.iteration, y: p.holdout })) }
  ];

  renderLineChart(host, {
    series,
    xValues,
    xLabel: '交替拟合轮次',
    yLabel: 'RMSE',
    formatY: (v) => formatNumber(v, 2),
    ariaLabel: '训练误差与留出观测误差随拟合轮次变化',
    height: 250,
    yDomain: [0, undefined],
    emptyNote: '没有可绘制的误差'
  });

  renderLegend(legendHost, [
    { name: '训练误差 RMSE', color: roles.train },
    { name: '留出观测误差 RMSE', color: roles.holdout }
  ]);

  const holdoutCount = result.errors.holdout?.count || 0;
  note.textContent = holdoutCount
    ? `曲线按训练连通块等权平均；${histories.length} 个块、${holdoutCount} 个留出观测。留出曲线只用于观察，不参与收敛停止或选模。`
    : `当前没有可评估的留出观测，因此不绘制留出曲线（也不会画成 0）。${histories.length} 个训练块仍显示训练误差。`;

  buildCurveTable(histories, aggregate);
}

function buildCurveTable(histories, aggregate = []) {
  const host = $('curve-table');
  host.replaceChildren();
  if (!histories.length) {
    host.append(el('div', { class: 'empty', text: '没有可拟合的训练连通块。' }));
    return;
  }
  const table = el('table', {},
    el('thead', {}, el('tr', {},
      el('th', { text: '轮次' }),
      el('th', { class: 'num', text: '训练 RMSE' }),
      el('th', { class: 'num', text: '留出 RMSE' }),
      ...histories.map((h) => el('th', { class: 'num', text: `${h.componentId} 训练 / 留出` }))
    )),
    el('tbody', {}, ...aggregate.map((row) => {
      const cells = histories.map((h) => {
        const point = h.history[Math.min(row.iteration, h.history.length - 1)];
        return el('td', { class: 'num' },
          `${point.trainRmse == null ? '—' : formatNumber(point.trainRmse, 3)} / ${point.reportRmse == null ? '—' : formatNumber(point.reportRmse, 3)}`);
      });
      return el('tr', {},
        el('td', { text: String(row.iteration) }),
        el('td', { class: 'num', text: row.train == null ? '—' : formatNumber(row.train, 3) }),
        el('td', { class: 'num', text: row.holdout == null ? '—' : formatNumber(row.holdout, 3) }),
        ...cells
      );
    }))
  );
  host.append(table);
}

/* ==========================================================================
   Sweep
   ========================================================================== */

function renderSweep() {
  const sweep = state.sweep;
  const host = $('sweep-chart');
  const legendHost = $('sweep-legend');
  const note = $('sweep-note');
  const roles = colorRoles();
  if (!sweep) {
    note.textContent = '正在计算复杂度扫描…';
    renderLineChart(host, { series: [], xValues: [], ariaLabel: '复杂度扫描', emptyNote: '正在计算…' });
    legendHost.replaceChildren();
    buildSweepTable([]);
    return;
  }

  const points = sweep.points;
  const xValues = points.map((p) => p.label);
  const series = [
    { name: '训练 RMSE', color: roles.train, points: points.map((p) => ({ x: p.label, y: p.train?.rmse ?? null })) },
    { name: '留出 RMSE', color: roles.holdout, points: points.map((p) => ({ x: p.label, y: p.holdout?.rmse ?? null })) },
    { name: '遮蔽 RMSE', color: roles.probe, points: points.map((p) => ({ x: p.label, y: p.probe?.rmse ?? null })) }
  ];

  const annotationIndex = points.findIndex((p) =>
    sweep.axis === 'rank'
      ? p.config.rank === state.rank
      : Math.abs(p.config.lambda - state.lambda) < 1e-6
  );

  renderLineChart(host, {
    series,
    xValues,
    xLabel: sweep.axis === 'rank' ? '模型秩' : '正则强度 λ',
    yLabel: 'RMSE',
    formatY: (v) => formatNumber(v, 2),
    ariaLabel: '复杂度扫描：训练与留出误差',
    height: 250,
    yDomain: [0, undefined],
    markerThreshold: 30,
    annotations: annotationIndex >= 0 ? [{ index: annotationIndex, label: '当前' }] : [],
    emptyNote: '没有可绘制的误差'
  });

  const legendItems = [
    { name: '训练 RMSE', color: roles.train },
    { name: '留出 RMSE', color: roles.holdout }
  ];
  if (points.some((p) => p.probe?.rmse != null)) {
    legendItems.push({ name: '遮蔽 RMSE', color: roles.probe });
  }
  renderLegend(legendHost, legendItems);

  const evaluated = points.filter((p) => p.holdout?.rmse != null).length;
  note.textContent =
    `每一档都完整重拟合（固定 2 次初始化）。${evaluated}/${points.length} 档有可评估的留出观测；` +
    `缺失档位保持空白而不是 0。扫描结果不用于自动挑参，只用于观察过拟合与塌缩。`;

  buildSweepTable(points);
}

function buildSweepTable(points) {
  const host = $('sweep-table');
  host.replaceChildren();
  if (!points.length) {
    host.append(el('div', { class: 'empty', text: '扫描尚未返回。' }));
    return;
  }
  const table = el('table', {},
    el('thead', {}, el('tr', {},
      el('th', { text: state.sweepAxis === 'rank' ? '秩' : 'λ' }),
      el('th', { class: 'num', text: '训练 RMSE' }),
      el('th', { class: 'num', text: '留出 RMSE' }),
      el('th', { class: 'num', text: '遮蔽 RMSE' }),
      el('th', { class: 'num', text: '可补全格' }),
      el('th', { text: '收敛' }),
      el('th', { text: '均值塌缩' })
    )),
    el('tbody', {}, ...points.map((p) => el('tr', {},
      el('td', { class: 'strong', text: state.sweepAxis === 'rank' ? `秩 ${p.config.rank}` : `λ ${p.config.lambda}` }),
      el('td', { class: 'num', text: p.train?.rmse == null ? '—' : formatNumber(p.train.rmse, 3) }),
      el('td', { class: 'num', text: p.holdout?.rmse == null ? '—' : formatNumber(p.holdout.rmse, 3) }),
      el('td', { class: 'num', text: p.probe?.rmse == null ? '—' : formatNumber(p.probe.rmse, 3) }),
      el('td', { class: 'num', text: String(p.completed) }),
      el('td', { text: p.converged ? '已收敛' : '未收敛' }),
      el('td', { text: p.collapsed ? '检测到' : '未检测到' })
    )))
  );
  host.append(table);
}

/* ==========================================================================
   Batch errors
   ========================================================================== */

function renderBatchErrors() {
  const host = $('batch-errors');
  host.replaceChildren();
  const perBatch = state.result.errors.perHoldoutBatch || [];
  if (!perBatch.length) {
    host.append(el('div', { class: 'drawer-empty', text: '当前没有整批留出的问卷。选择至少一个批次后，这里会逐个批次给出留出误差。' }));
    return;
  }
  for (const batch of perBatch) {
    const evaluated = batch.evaluatedCount > 0 && batch.metrics?.rmse != null;
    const row = el('div', { class: `batch-row${evaluated ? '' : ' batch-row--unevaluable'}` },
      el('div', {},
        el('div', { class: 'batch-row-title' }, `${batch.batchId} ${batch.label}`),
        el('div', { class: 'batch-row-sub' },
          `${batch.season} · ${batch.block === 'core' ? '主问卷' : '奥莱问卷'} · ` +
          `${batch.observationCount} 个留出观测${batch.evaluatedCount < batch.observationCount ? `，${batch.observationCount - batch.evaluatedCount} 个无训练支撑` : ''}`)
      ),
      evaluated
        ? el('div', { class: 'batch-row-metrics' },
          el('span', {}, el('strong', { text: formatNumber(batch.metrics.rmse, 3) }), ' RMSE'),
          el('span', {}, el('strong', { text: String(batch.evaluatedCount) }), ' 参与')
        )
        : el('div', { class: 'batch-row-metrics' },
          el('span', { class: 'status-pill', text: '无可用观测' }),
          el('span', { text: '未参与误差，不计为 0' })
        )
    );
    host.append(row);
  }
}

/* ==========================================================================
   Diagnostics
   ========================================================================== */

function renderDiagnostics() {
  const result = state.result;
  const conv = result.diagnostics.convergence;
  const collapse = result.diagnostics.meanCollapse;
  const stability = result.diagnostics.stability;

  const convHost = $('diag-convergence');
  const noFit = conv.fitCount === 0;
  convHost.className = `diag-block ${noFit ? 'diag-block--empty' : conv.anyNotConverged ? 'diag-block--alert' : 'diag-block--ok'}`;
  convHost.replaceChildren(
    el('div', { class: 'diag-title' }, el('span', { class: 'dot', 'aria-hidden': 'true' }),
      el('span', { text: noFit ? '没有可拟合的参数' : conv.anyNotConverged ? '交替拟合尚未收敛' : '交替拟合已收敛' })),
    el('p', { class: 'diag-text', text: conv.message }),
    el('div', { class: 'diag-metrics' },
      el('div', { class: 'diag-metric' }, '拟合次数', el('strong', { text: String(conv.fitCount) })),
      el('div', { class: 'diag-metric' }, '未收敛', el('strong', { text: String(conv.notConvergedCount) })),
      el('div', { class: 'diag-metric' }, '最大轮次', el('strong', { text: String(conv.maxIterations) })),
      el('div', { class: 'diag-metric' }, '容差', el('strong', { text: String(conv.tolerance) }))
    )
  );

  const collapseHost = $('diag-collapse');
  const noBlocks = collapse.componentsChecked === 0;
  collapseHost.className = `diag-block ${noBlocks ? 'diag-block--empty' : collapse.detected ? 'diag-block--alert' : 'diag-block--ok'}`;
  const comp = collapse.components[0];
  collapseHost.replaceChildren(
    el('div', { class: 'diag-title' }, el('span', { class: 'dot', 'aria-hidden': 'true' }),
      el('span', { text: noBlocks ? '没有训练块可检查' : collapse.detected ? '正则过强：补全值向均值塌缩' : '未检测到均值塌缩' })),
    el('p', { class: 'diag-text', text: collapse.message }),
    el('div', { class: 'diag-metrics' },
      ...(comp ? [
        el('div', { class: 'diag-metric' }, '解释方差', el('strong', { text: `${Math.round(comp.explainedVariance * 100)}%` })),
        el('div', { class: 'diag-metric' }, '离散度比', el('strong', { text: comp.shrinkage.toFixed(2) })),
        el('div', { class: 'diag-metric' }, '近均值比例', el('strong', { text: `${Math.round(comp.nearMeanShare * 100)}%` }))
      ] : [
        el('div', { class: 'diag-metric' }, '检查块数', el('strong', { text: String(collapse.componentsChecked) })),
        el('div', { class: 'diag-metric' }, '塌缩阈值', el('strong', { text: `R² ≤ ${Math.round(collapse.thresholds.explainedVariance * 100)}%` }))
      ])
    )
  );

  const stabilityHost = $('diag-stability');
  const noCompleted = stability.completedCount === 0;
  stabilityHost.className = `diag-block ${noCompleted ? 'diag-block--empty' : 'diag-block--ok'}`;
  stabilityHost.replaceChildren(
    el('div', { class: 'diag-title' }, el('span', { class: 'dot', 'aria-hidden': 'true' }),
      el('span', { text: noCompleted ? '没有可比较稳定度的格子' : '多次初始化的稳定程度' })),
    el('p', { class: 'diag-text', text: stability.note }),
    el('div', { class: 'diag-metrics' },
      el('div', { class: 'diag-metric' }, '可补全格', el('strong', { text: String(stability.completedCount) })),
      el('div', { class: 'diag-metric' }, '平均标准差', el('strong', { text: stability.meanSd == null ? '—' : stability.meanSd.toFixed(3) })),
      el('div', { class: 'diag-metric' }, '最大标准差', el('strong', { text: stability.maxSd == null ? '—' : stability.maxSd.toFixed(3) })),
      el('div', { class: 'diag-metric' }, '稳定占比', el('strong', { text: stability.stableShare == null ? '—' : `${Math.round(stability.stableShare * 100)}%` }))
    )
  );
}

function renderFitTable() {
  const host = $('fit-table');
  host.replaceChildren();
  const fits = state.result?.fits || [];
  if (!fits.length) {
    host.append(el('div', { class: 'empty', text: '没有拟合记录（训练集为空）。' }));
    return;
  }
  const table = el('table', {},
    el('thead', {}, el('tr', {},
      el('th', { text: '块' }),
      el('th', { text: '初始化' }),
      el('th', { class: 'num', text: '轮次' }),
      el('th', { text: '收敛' }),
      el('th', { class: 'num', text: '训练 RMSE' }),
      el('th', { class: 'num', text: '留出 RMSE' }),
      el('th', { class: 'num', text: '解释方差' }),
      el('th', { class: 'num', text: '离散度比' })
    )),
    el('tbody', {}, ...fits.map((fit) => {
      const diag = state.result.diagnostics.componentDiagnostics?.find((d) => d.componentId === fit.componentId);
      return el('tr', {},
        el('td', { text: fit.componentId }),
        el('td', { text: String(fit.init) }),
        el('td', { class: 'num', text: `${fit.iterations}/${fit.maxIter}` }),
        el('td', { text: fit.converged ? '是' : '否' }),
        el('td', { class: 'num', text: fit.trainRmse == null ? '—' : formatNumber(fit.trainRmse, 3) }),
        el('td', { class: 'num', text: fit.reportRmse == null ? '—' : formatNumber(fit.reportRmse, 3) }),
        el('td', { class: 'num', text: diag ? `${Math.round(diag.explainedVariance * 100)}%` : '—' }),
        el('td', { class: 'num', text: fit.shrinkage == null ? '—' : fit.shrinkage.toFixed(2) })
      );
    }))
  );
  host.append(table);
}

/* ==========================================================================
   Components
   ========================================================================== */

function renderComponents() {
  const host = $('components-grid');
  host.replaceChildren();
  const observed = state.result.components.observed || [];
  const training = state.result.components.training || [];
  const fullToTrain = new Map();
  for (const comp of observed) {
    const match = training.find((t) =>
      t.storeIds.length === comp.storeIds.length && t.itemIds.length === comp.itemIds.length &&
      t.storeIds[0] && comp.storeIds.includes(t.storeIds[0]));
    if (match) fullToTrain.set(comp.id, match.id);
  }

  for (const comp of observed) {
    const storeNames = comp.storeIds.filter((id) => (state.storeById.get(id)?.observedCount || 0) > 0);
    const itemNames = comp.itemIds;
    const trainId = fullToTrain.get(comp.id);
    const card = el('div', { class: 'component-card' },
      el('div', { class: 'component-card-head' },
        el('span', { class: 'component-size', text: `${comp.storeIds.length} 行 × ${comp.itemIds.length} 列` }),
        el('span', { class: 'component-tag', text: `观测块 ${comp.id}` })
      ),
      el('div', { class: 'component-lists' },
        el('div', {}, el('b', { text: '门店：' }), storeNames.map((id) => state.storeById.get(id)?.name || id).join('、') || '无'),
        el('div', {}, el('b', { text: '评分项：' }), itemNames.map((id) => state.itemById.get(id)?.name || id).join('、')),
        el('div', { class: 'component-id', text: `${comp.cellCount} 个观测 · 训练对应 ${trainId || '无（全部留出/遮蔽）'}` })
      )
    );
    host.append(card);
  }
  if (observed.length < training.length) {
    host.append(el('div', { class: 'drawer-empty', text: '整批留出或区块遮蔽使训练图比观测图更分裂；仅按训练图拟合。' }));
  } else if (observed.length === 1) {
    host.append(el('div', { class: 'drawer-empty', text: '所有已知观测都在同一连通块内，跨块补全问题不出现。' }));
  }
}

/* ==========================================================================
   Support
   ========================================================================== */

function renderSupport() {
  const host = $('support-wrap');
  host.replaceChildren();
  const tab = state.supportTab;
  const rows = tab === 'stores' ? state.result.support.rows : state.result.support.cols;
  const itemLabel = tab === 'stores' ? '门店' : '评分项';

  const table = el('table', {},
    el('thead', {}, el('tr', {},
      el('th', { text: itemLabel }),
      el('th', { class: 'num', text: '全部观测' }),
      el('th', { class: 'num', text: '训练' }),
      el('th', { class: 'num', text: '留出' }),
      el('th', { class: 'num', text: '遮蔽' }),
      el('th', { text: '观测块' }),
      el('th', { text: '训练块' }),
      el('th', { text: '状态' })
    )),
    el('tbody', {}, ...rows.map((row) => {
      const unobserved = row.fullCount === 0;
      const status = unobserved
        ? (tab === 'stores' ? '从未观测' : '从未投放')
        : row.trainCount === 0
          ? '无训练观测'
          : '参与训练';
      return el('tr', { class: unobserved ? 'unobserved' : '' },
        el('td', { class: 'name' },
          el('span', {
            class: 'support-bar',
            'aria-hidden': 'true',
            style: { width: `${Math.min(46, 4 + row.fullCount * 2.2)}px` }
          }),
          row.name),
        el('td', { class: 'num', text: String(row.fullCount) }),
        el('td', { class: 'num', text: String(row.trainCount) }),
        el('td', { class: 'num', text: String(row.holdoutCount) }),
        el('td', { class: 'num', text: String(row.probeCount) }),
        el('td', { text: row.componentId || '—' }),
        el('td', { text: row.trainComponentId || '—' }),
        el('td', { text: status })
      );
    }))
  );
  host.append(table);

  for (const btn of document.querySelectorAll('[data-support]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.support === tab));
  }
}

/* ==========================================================================
   Records table
   ========================================================================== */

function renderRecords() {
  const host = $('records-table');
  host.replaceChildren();
  const result = state.result;
  const filter = state.tableFilter;
  let records;
  if (filter === 'all') {
    records = [...result.errorRecords.train, ...result.errorRecords.holdout, ...result.errorRecords.probe];
  } else {
    records = result.errorRecords[filter] || [];
  }
  records = records.slice().sort((a, b) =>
    a.storeId.localeCompare(b.storeId, 'zh-Hans-CN', { numeric: true }) ||
    a.itemId.localeCompare(b.itemId, 'zh-Hans-CN', { numeric: true }));

  $('table-count').textContent = `${records.length} 条`;

  if (!records.length) {
    host.append(el('div', { class: 'empty' },
      filter === 'all' ? '没有观测记录。' : '该类型下没有观测记录（未知格不会出现在这里）。'));
    return;
  }

  const table = el('table', {},
    el('thead', {}, el('tr', {},
      el('th', { text: '门店' }),
      el('th', { text: '评分项' }),
      el('th', { text: '批次' }),
      el('th', { text: '类型' }),
      el('th', { class: 'num', text: '真实评分' }),
      el('th', { class: 'num', text: '补全值' }),
      el('th', { class: 'num', text: '残差' }),
      el('th', { class: 'num', text: '初始化 SD' })
    )),
    el('tbody', {}, ...records.map((record) => {
      const cell = state.result.cells.find((c) => c.key === record.key);
      const kind = cell ? STATUS[cell.status]?.kind : null;
      const pillClass = kind === 'train' ? 'status-pill--train'
        : kind === 'holdout' ? 'status-pill--holdout'
          : kind === 'probe' ? 'status-pill--probe' : '';
      return el('tr', {},
        el('td', { class: 'strong', text: record.storeName }),
        el('td', { text: record.itemName }),
        el('td', { text: `${record.batchId} ${record.batchLabel}` }),
        el('td', {}, el('span', { class: `status-pill ${pillClass}`, text: STATUS[cell?.status]?.label || '—' })),
        el('td', { class: 'num', text: formatNumber(record.truth, 1) }),
        el('td', { class: 'num', text: record.estimate == null ? '—' : formatNumber(record.estimate, 2) }),
        el('td', { class: 'num', text: record.residual == null ? '—' : (record.residual >= 0 ? '+' : '−') + Math.abs(record.residual).toFixed(2) }),
        el('td', { class: 'num', text: cell?.stabilitySd == null ? '—' : cell.stabilitySd.toFixed(3) })
      );
    }))
  );
  host.append(table);
}

/* ==========================================================================
   Cell drawer
   ========================================================================== */

function openDrawer(cell) {
  const result = state.result;
  state.selectedKey = cell.key;
  state.lastFocused = document.activeElement;
  const store = state.storeById.get(cell.storeId);
  const item = state.itemById.get(cell.itemId);
  const status = STATUS[cell.status] || { label: cell.status, reason: '' };

  $('drawer-kicker').textContent = cell.observed
    ? '观测格详情'
    : cell.status === 'completed'
      ? '补全格详情'
      : '缺失格详情（无估计）';
  $('drawer-title').textContent = `${store?.name || cell.storeId} × ${item?.name || cell.itemId}`;
  const body = $('drawer-body');
  body.replaceChildren();

  body.append(el('section', { class: 'drawer-section' },
    el('div', { class: 'drawer-section-title', text: '格子状态' }),
    el('dl', { class: 'drawer-defs' },
      el('dt', { text: '状态' }), el('dd', { text: status.label }),
      el('dt', { text: '门店编码' }), el('dd', { class: 'mono', text: `${cell.storeId} · ${store?.format || ''} · ${store?.region || ''}` }),
      el('dt', { text: '评分项编码' }), el('dd', { class: 'mono', text: `${cell.itemId} · ${item?.category || ''}` }),
      cell.batchId ? el('dt', { text: '所属批次' }) : null,
      cell.batchId ? el('dd', { text: `${cell.batchId} ${cell.batchLabel}` }) : null,
      el('dt', { text: '门店所在块' }), el('dd', { class: 'mono', text: cell.rowComponentId ? `观测 ${cell.rowComponentId} · 训练 ${cell.rowTrainComponentId || '无'}` : '从未观测' }),
      el('dt', { text: '评分项所在块' }), el('dd', { class: 'mono', text: cell.colComponentId ? `观测 ${cell.colComponentId} · 训练 ${cell.colTrainComponentId || '无'}` : '从未投放' })
    ),
    el('p', { class: 'drawer-note', text: status.reason })
  ));

  if (cell.estimate != null) {
    body.append(el('section', { class: 'drawer-section' },
      el('div', { class: 'drawer-section-title', text: '补全结果' }),
      el('div', { class: 'drawer-stat-row' },
        el('div', { class: 'drawer-stat' }, el('div', { class: 'lbl', text: '补全值' }), el('div', { class: 'val', text: formatNumber(cell.estimate, 3) })),
        el('div', { class: 'drawer-stat' }, el('div', { class: 'lbl', text: '初始化 SD' }),
          el('div', { class: 'val', text: cell.stabilitySd == null ? '—' : cell.stabilitySd.toFixed(3) })),
        el('div', { class: 'drawer-stat' }, el('div', { class: 'lbl', text: '极差（多次初始化）' }),
          el('div', { class: 'val', text: cell.stabilityRange == null ? '—' : cell.stabilityRange.toFixed(3) }))
      ),
      cell.stabilityLabel ? el('p', { class: 'drawer-note', text: `稳定度判断：${cell.stabilityLabel}。` }) : null
    ));
  }

  if (cell.observed) {
    body.append(el('section', { class: 'drawer-section' },
      el('div', { class: 'drawer-section-title', text: '真实评分' }),
      el('div', { class: 'drawer-stat-row' },
        el('div', { class: 'drawer-stat' }, el('div', { class: 'lbl', text: '原始评分' }), el('div', { class: 'val', text: formatNumber(cell.value, 1) })),
        el('div', { class: 'drawer-stat' }, el('div', { class: 'lbl', text: '模型估计' }),
          el('div', { class: 'val', text: cell.estimate == null ? '—' : formatNumber(cell.estimate, 3) })),
        el('div', { class: 'drawer-stat' }, el('div', { class: 'lbl', text: '残差（真实 − 补全）' }),
          el('div', { class: 'val', text: cell.estimate == null ? '—' : (cell.value - cell.estimate >= 0 ? '+' : '−') + Math.abs(cell.value - cell.estimate).toFixed(3) }))
      )
    ));
  }

  // Training ranges
  const rangeSection = el('section', { class: 'drawer-section' },
    el('div', { class: 'drawer-section-title', text: '训练范围（只用原始训练评分）' })
  );
  const addRange = (label, range) => {
    const host = el('div', { class: 'drawer-chart', dataset: {} });
    rangeSection.append(
      el('p', { class: 'drawer-note', text: `${label} · ${range.count} 个训练观测 · 均值 ${range.mean == null ? '—' : formatNumber(range.mean, 2)} · 范围 ${range.count ? `${formatNumber(range.min, 1)}–${formatNumber(range.max, 1)}` : '无'}` }),
      host
    );
    requestAnimationFrame(() => {
      renderRangeBar(host, {
        min: range.min, max: range.max, mean: range.mean,
        point: cell.estimate, count: range.count,
        ariaLabel: `${label}的训练取值范围`
      });
    });
  };
  addRange(`门店「${store?.name || cell.storeId}」`, cell.rowTrainRange);
  addRange(`评分项「${item?.name || cell.itemId}」`, cell.colTrainRange);
  body.append(rangeSection);

  // Multiple init stability
  const initSection = el('section', { class: 'drawer-section' },
    el('div', { class: 'drawer-section-title', text: '多次初始化的稳定程度' })
  );
  if (cell.initEstimates?.length > 1) {
    const host = el('div', { class: 'drawer-chart' });
    initSection.append(
      el('div', { class: 'drawer-obs-list' },
        ...cell.initEstimates.map((value, idx) => el('div', { class: 'drawer-obs' },
          el('span', { class: 'muted', text: `初始化 ${idx + 1}` }),
          el('span', { class: 'mono', text: formatNumber(value, 3) })
        ))
      ),
      el('p', { class: 'drawer-note', text: `标准差 ${cell.stabilitySd == null ? '—' : cell.stabilitySd.toFixed(4)}；极差 ${cell.stabilityRange == null ? '—' : cell.stabilityRange.toFixed(3)}。标准差 ≤ 0.02 视为稳定。` }),
      host
    );
    requestAnimationFrame(() => {
      renderDotStrip(host, { values: cell.initEstimates, meanValue: cell.estimate, domain: [1, 5] });
    });
  } else if (cell.initEstimates?.length === 1) {
    initSection.append(el('div', { class: 'drawer-empty', text: '当前只运行了 1 组初始化，无法比较稳定程度。把“初始化次数”调到 2 或以上再查看。' }));
  } else {
    initSection.append(el('div', { class: 'drawer-empty', text: '该格没有补全值，因此没有初始化稳定性可比较。' }));
  }
  body.append(initSection);

  // Real observations in row and column
  const addObsList = (title, list) => {
    const section = el('section', { class: 'drawer-section' },
      el('div', { class: 'drawer-section-title', text: `${title}（${list.length} 个真实观测）` })
    );
    if (!list.length) {
      section.append(el('div', { class: 'drawer-empty', text: '没有真实观测。' }));
    } else {
      section.append(el('div', { class: 'drawer-obs-list' }, ...list.map((entry) => {
        const c = result.cells.find((x) => x.key === entry.key);
        return el('div', { class: 'drawer-obs' },
          el('span', {},
            el('span', { text: entry.name }),
            el('span', { class: 'muted', text: ` · ${entry.batchId}` })
          ),
          el('span', {},
            el('span', { class: 'mono', text: formatNumber(entry.value, 1) }),
            el('span', { class: 'muted', text: ` · ${STATUS[c?.status]?.label || ''}` })
          )
        );
      })));
    }
    body.append(section);
  };

  const rowObs = state.dataset.observations
    .filter((o) => o.storeId === cell.storeId)
    .map((o) => ({
      key: `${o.storeId}\u0001${o.itemId}`,
      name: state.itemById.get(o.itemId)?.name || o.itemId,
      value: o.value,
      batchId: o.batchId
    }));
  const colObs = state.dataset.observations
    .filter((o) => o.itemId === cell.itemId)
    .map((o) => ({
      key: `${o.storeId}\u0001${o.itemId}`,
      name: state.storeById.get(o.storeId)?.name || o.storeId,
      value: o.value,
      batchId: o.batchId
    }));

  addObsList(`所在门店「${store?.name || cell.storeId}」的真实观测`, rowObs);
  addObsList(`所在评分项「${item?.name || cell.itemId}」的真实观测`, colObs);

  $('drawer-backdrop').hidden = false;
  $('cell-drawer').hidden = false;
  $('drawer-close').focus();

  // Highlight selected cell in the matrix.
  for (const node of document.querySelectorAll('.m-cell--selected')) node.classList.remove('m-cell--selected');
  const selectedNode = document.querySelector(`.m-cell[data-key="${cssEscape(cell.key)}"]`);
  if (selectedNode) selectedNode.classList.add('m-cell--selected');
}

function cssEscape(value) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}

function closeDrawer() {
  $('cell-drawer').hidden = true;
  $('drawer-backdrop').hidden = true;
  state.selectedKey = null;
  for (const node of document.querySelectorAll('.m-cell--selected')) node.classList.remove('m-cell--selected');
  if (state.lastFocused?.focus) state.lastFocused.focus();
}

/* ==========================================================================
   Export
   ========================================================================== */

async function exportCsv() {
  if (!state.result) return;
  try {
    const res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(currentConfig())
    });
    if (!res.ok) {
      let message = `导出失败（${res.status}）`;
      try { message = (await res.json()).error || message; } catch { /* ignore */ }
      throw new Error(message);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = el('a', { href: url, download: 'store-experience-imputed.csv' });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast('已导出当前配置下的矩阵与补全结果（CSV）。');
  } catch (error) {
    showToast(error.message || '导出失败');
  }
}

/* ==========================================================================
   Theme
   ========================================================================== */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('theme', theme);
  $('theme-toggle').setAttribute('aria-label', theme === 'dark' ? '切换到浅色主题' : '切换到深色主题');
}

/* ==========================================================================
   Boot
   ========================================================================== */

loadDataset().catch((error) => {
  showToast(`无法载入数据：${error.message}`);
  const chip = $('dataset-chip');
  if (chip) chip.textContent = '数据载入失败';
});

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateDataset } from './data.js';
import { analyze } from './analysis.js';
import { probePresets } from './presets.js';
import { runSweep } from './sweep.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'"
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data)
  });
  res.end(data);
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

function normalizeConfig(body) {
  const cfg = {};
  if (body.rank != null) cfg.rank = Number(body.rank);
  if (body.lambda != null) cfg.lambda = Number(body.lambda);
  if (body.inits != null) cfg.inits = Number(body.inits);
  if (Array.isArray(body.holdoutBatches)) cfg.holdoutBatches = body.holdoutBatches.map(String);
  if (body.probe) {
    cfg.probe = {
      storeIds: Array.isArray(body.probe.storeIds) ? body.probe.storeIds.map(String) : [],
      itemIds: Array.isArray(body.probe.itemIds) ? body.probe.itemIds.map(String) : [],
      label: body.probe.label ? String(body.probe.label) : '自定义区块'
    };
  } else {
    cfg.probe = null;
  }
  return cfg;
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

const CELL_STATUS_LABELS = {
  'observed-train': '训练观测',
  'observed-holdout': '留出观测',
  'observed-probe': '遮蔽观测',
  completed: '可补全',
  'cross-block': '跨块无依据',
  'no-row-observations': '门店无观测',
  'no-item-observations': '项目未投放',
  'no-training-support': '无训练支撑',
  'training-split': '训练关系拆断'
};

export function exportCsv(result, storeById, itemById) {
  const rows = [[
    '门店编码', '门店', '评分项编码', '评分项', '状态',
    '原始评分', '补全值', '批次', '初始化标准差', '训练行样本', '训练列样本'
  ]];
  for (const cell of result.cells) {
    rows.push([
      cell.storeId,
      storeById.get(cell.storeId)?.name || '',
      cell.itemId,
      itemById.get(cell.itemId)?.name || '',
      CELL_STATUS_LABELS[cell.status] || cell.status,
      cell.observed ? cell.value : '',
      cell.estimate ?? '',
      cell.batchId || '',
      cell.stabilitySd ?? '',
      cell.rowTrainRange.count,
      cell.colTrainRange.count
    ]);
  }
  return '﻿' + rows.map((row) => row.map(csvEscape).join(',')).join('\n');
}

/**
 * Build the request handler around a concrete dataset.
 * Exported so tests can exercise the real HTTP surface on an ephemeral port.
 */
export function createApp(dataset, publicDir = PUBLIC_DIR) {
  const storeById = new Map(dataset.stores.map((s) => [s.id, s]));
  const itemById = new Map(dataset.items.map((i) => [i.id, i]));

  return async function handle(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname === '/api/health') {
        return sendJson(res, 200, {
          ok: true,
          seed: dataset.meta.seed,
          rows: dataset.stores.length,
          cols: dataset.items.length
        });
      }
      if (url.pathname === '/api/dataset' && req.method === 'GET') {
        return sendJson(res, 200, {
          meta: dataset.meta,
          stores: dataset.stores,
          items: dataset.items,
          batches: dataset.batches,
          observations: dataset.observations,
          presets: probePresets(dataset)
        });
      }
      if (url.pathname === '/api/analyze' && req.method === 'POST') {
        const body = await readBody(req);
        return sendJson(res, 200, analyze(dataset, normalizeConfig(body)));
      }
      if (url.pathname === '/api/sweep' && req.method === 'POST') {
        const body = await readBody(req);
        return sendJson(res, 200, runSweep(dataset, { ...normalizeConfig(body), axis: body.axis }));
      }
      if (url.pathname === '/api/export') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
        const body = await readBody(req);
        const result = analyze(dataset, normalizeConfig(body));
        const csv = exportCsv(result, storeById, itemById);
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="store-experience-imputed.csv"',
          'Cache-Control': 'no-store'
        });
        return res.end(csv);
      }

      // Static files, with a traversal guard.
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === '/') pathname = '/index.html';
      const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
      const filePath = join(publicDir, safePath);
      if (!filePath.startsWith(publicDir + '/') && filePath !== join(publicDir, 'index.html')) {
        return sendJson(res, 403, { error: '禁止访问' });
      }
      let data;
      try {
        data = await readFile(filePath);
      } catch {
        return sendJson(res, 404, { error: '未找到资源' });
      }
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
        'Cache-Control': 'no-cache'
      });
      res.end(data);
    } catch (error) {
      const status = /rank|lambda|必须|请求体/.test(error.message) ? 400 : 500;
      if (status === 500) console.error(error);
      sendJson(res, status, { error: error.message || '服务器内部错误' });
    }
  };
}

/** Start an HTTP server; resolves with the listening server. */
export function startServer({ port = PORT, host = HOST, dataset = generateDataset(), publicDir } = {}) {
  const server = createServer(createApp(dataset, publicDir));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  const dataset = generateDataset();
  startServer({ dataset }).then((server) => {
    const address = server.address();
    console.log(`门店体验评分补全实验室 → http://${HOST}:${address.port}`);
    console.log(`数据：${dataset.stores.length} 门店 × ${dataset.items.length} 项目，${dataset.observations.length} 个观测`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

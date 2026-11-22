/**
 * Tiny dependency-free SVG chart helpers tuned to the dashboard's tokens.
 * Forms: multi-series line chart with crosshair, dot strip, range bar.
 *
 * All chart chrome is styled through CSS classes (see styles.css) so light and
 * dark themes re-color without redrawing. Series colors are concrete values
 * captured at draw time, and the theme name is part of each chart's signature
 * so a theme switch forces a redraw.
 *
 * No chart draws a value for an undefined observation: null points become
 * gaps, and fully undefined series are named in a note instead of drawn at 0.
 */

const NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (key === 'style' && typeof value === 'object') {
      for (const [prop, val] of Object.entries(value)) node.style.setProperty(prop, val);
    } else if (key === 'class') {
      node.setAttribute('class', String(value));
    } else {
      node.setAttribute(key, String(value));
    }
  }
  return node;
}

function textNode(x, y, text, { anchor = 'middle', baseline = null, className = 'chart-text', extra = {} } = {}) {
  const node = svgEl('text', {
    x, y, 'text-anchor': anchor, class: className,
    ...(baseline ? { 'dominant-baseline': baseline } : {}),
    ...extra
  });
  node.textContent = text;
  return node;
}

export function formatNumber(value, digits = 2) {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

function niceTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (max - min < 1e-9) {
    const pad = Math.max(0.1, Math.abs(max) * 0.1);
    min -= pad;
    max += pad;
  }
  const span = max - min;
  const step0 = span / Math.max(1, count - 1);
  const mag = 10 ** Math.floor(Math.log10(step0));
  const norm = step0 / mag;
  let step;
  if (norm <= 1) step = mag;
  else if (norm <= 2) step = 2 * mag;
  else if (norm <= 2.5) step = 2.5 * mag;
  else if (norm <= 5) step = 5 * mag;
  else step = 10 * mag;
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + step * 1e-6; v += step) {
    ticks.push(Math.round(v * 1e9) / 1e9);
  }
  return ticks;
}

function chartHost(host) {
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  host.append(tip);
  return tip;
}

const chartRegistry = new WeakMap();

export function mountChart(host, draw) {
  const render = (force = false) => {
    const width = Math.max(260, Math.floor(host.clientWidth || 560));
    if (!force && host._lastWidth === width && host._lastSignature === draw.signature) return;
    host._lastWidth = width;
    host._lastSignature = draw.signature;
    const height = host.dataset.chartHeight ? Number(host.dataset.chartHeight) : 230;
    host.replaceChildren();
    const tip = chartHost(host);
    const svg = svgEl('svg', {
      width: '100%',
      height,
      viewBox: `0 0 ${width} ${height}`,
      role: 'img',
      'aria-label': draw.ariaLabel || '图表'
    });
    svg.classList.add('chart-svg');
    host.prepend(svg);
    draw({ host, svg, width, height, tip });
  };
  render(true);
  const previous = chartRegistry.get(host);
  if (previous) previous.disconnect();
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(host._raf);
    host._raf = requestAnimationFrame(() => render(false));
  });
  observer.observe(host);
  chartRegistry.set(host, observer);
  return { rerender: () => render(true) };
}

export function renderLegend(host, series) {
  const legend = document.createElement('div');
  legend.className = 'legend';
  for (const item of series) {
    const row = document.createElement('span');
    row.className = 'legend-item';
    const key = document.createElement('span');
    key.className = 'legend-key';
    key.style.background = item.color;
    if (item.shape === 'square') key.classList.add('legend-key--square');
    const label = document.createElement('span');
    label.textContent = item.name;
    row.append(key, label);
    legend.append(row);
  }
  host.append(legend);
}

function themeKey() {
  return document.documentElement.dataset.theme || 'light';
}

/**
 * Multi-series line chart.
 */
export function renderLineChart(host, opts) {
  const {
    series, xValues, xLabel, yLabel, height = 230, formatY = (v) => formatNumber(v, 2),
    yDomain, emptyNote = '没有可绘制的数据', ariaLabel = '折线图',
    markerThreshold = 14, annotations = [], tooltipNote = null
  } = opts;
  const drawable = series.filter((s) => s.points.some((p) => p.y != null && Number.isFinite(p.y)));
  const missing = series.filter((s) => !drawable.includes(s));
  const full = xValues.length === 0 || drawable.length === 0;
  const signature = JSON.stringify({
    theme: themeKey(),
    series: series.map((s) => ({ n: s.name, c: s.color, p: s.points.map((p) => p.y) })),
    xValues, height, yDomain, annotations, tooltipNote, emptyNote
  });

  mountChart(host, Object.assign(
    ({ svg, width, height: h, tip }) => {
      const margin = { top: 22, right: 74, bottom: 38, left: 50 };
      const innerW = Math.max(60, width - margin.left - margin.right);
      const innerH = Math.max(60, h - margin.top - margin.bottom);

      if (full) {
        svg.append(textNode(width / 2, h / 2, emptyNote, { className: 'chart-muted', extra: { 'font-size': 12 } }));
        if (missing.length) {
          svg.append(textNode(width / 2, h / 2 + 20,
            `未绘制：${missing.map((s) => s.name).join('、')}`,
            { className: 'chart-muted', extra: { 'font-size': 11 } }));
        }
        return;
      }

      const values = drawable.flatMap((s) => s.points.map((p) => p.y)).filter((v) => v != null && Number.isFinite(v));
      const autoMin = Math.min(...values);
      const autoMax = Math.max(...values);
      let yMin = yDomain && yDomain[0] != null ? yDomain[0] : autoMin;
      let yMax = yDomain && yDomain[1] != null ? yDomain[1] : autoMax;
      const pad = Math.max(0.02, (autoMax - autoMin) * 0.12);
      if (!yDomain || yDomain[0] == null) yMin = Math.max(0, yMin - pad);
      if (!yDomain || yDomain[1] == null) yMax = Math.max(yMin + pad, yMax + pad);
      if (yMax - yMin < 1e-9) yMax = yMin + 1;
      const ticks = niceTicks(yMin, yMax, 5);
      const yLo = Math.max(0, Math.min(yMin, ticks[0]));
      const yHi = Math.max(yMax, ticks[ticks.length - 1]);
      const yPos = (v) => margin.top + innerH - ((v - yLo) / (yHi - yLo || 1)) * innerH;
      const n = xValues.length;
      const xPos = (i) => margin.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);

      for (const t of ticks) {
        const y = yPos(t);
        if (y < margin.top - 1 || y > margin.top + innerH + 1) continue;
        svg.append(svgEl('line', {
          x1: margin.left, x2: margin.left + innerW, y1: y, y2: y, class: 'chart-gridline'
        }));
        svg.append(textNode(margin.left - 9, y, formatY(t), {
          anchor: 'end', baseline: 'middle', className: 'chart-muted axis-num',
          extra: { 'font-size': 10.5 }
        }));
      }

      svg.append(svgEl('line', {
        x1: margin.left, x2: margin.left + innerW,
        y1: margin.top + innerH, y2: margin.top + innerH, class: 'chart-axisline'
      }));

      const maxLabels = Math.max(4, Math.floor(innerW / 54));
      const step = Math.max(1, Math.ceil(n / maxLabels));
      for (let i = 0; i < n; i += 1) {
        if (i % step !== 0 && i !== n - 1) continue;
        if (i !== n - 1 && n - 1 - i < step * 0.6) continue;
        svg.append(textNode(xPos(i), margin.top + innerH + 18, xValues[i], {
          className: 'chart-muted axis-num', extra: { 'font-size': 10.5 }
        }));
      }

      if (xLabel) {
        svg.append(textNode(margin.left + innerW, h - 6, xLabel, {
          anchor: 'end', className: 'chart-muted', extra: { 'font-size': 10.5 }
        }));
      }
      if (yLabel) {
        svg.append(textNode(6, margin.top - 6, yLabel, {
          anchor: 'start', className: 'chart-muted', extra: { 'font-size': 10.5 }
        }));
      }

      for (const note of annotations) {
        if (note.index == null || note.index < 0 || note.index >= n) continue;
        const x = xPos(note.index);
        svg.append(svgEl('line', {
          x1: x, x2: x, y1: margin.top, y2: margin.top + innerH, class: 'chart-axisline'
        }));
        if (note.label) {
          svg.append(textNode(x, margin.top - 6, note.label, {
            className: 'chart-muted', extra: { 'font-size': 10 }
          }));
        }
      }

      const endPoints = [];
      for (const s of drawable) {
        const path = [];
        s.points.forEach((p, i) => {
          if (p.y == null || !Number.isFinite(p.y)) return;
          path.push(`${path.length ? 'L' : 'M'}${xPos(i).toFixed(2)},${yPos(p.y).toFixed(2)}`);
        });
        svg.append(svgEl('path', {
          d: path.join(' '), fill: 'none', stroke: s.color,
          'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round'
        }));

        if (n <= markerThreshold) {
          s.points.forEach((p, i) => {
            if (p.y == null || !Number.isFinite(p.y)) return;
            svg.append(svgEl('circle', {
              cx: xPos(i), cy: yPos(p.y), r: 4,
              fill: s.color, class: 'chart-surface-ring', 'stroke-width': 2
            }));
          });
        }

        let lastIndex = -1;
        for (let i = s.points.length - 1; i >= 0; i -= 1) {
          if (s.points[i].y != null && Number.isFinite(s.points[i].y)) { lastIndex = i; break; }
        }
        if (lastIndex >= 0) {
          endPoints.push({
            series: s,
            x: xPos(lastIndex),
            y: yPos(s.points[lastIndex].y),
            value: s.points[lastIndex].y
          });
        }
      }

      endPoints.sort((a, b) => a.y - b.y);
      for (let i = 0; i < endPoints.length; i += 1) {
        const p = endPoints[i];
        let labelY = p.y;
        if (i > 0) {
          const prev = endPoints[i - 1];
          if (labelY - prev.labelY < 14) labelY = prev.labelY + 14;
        }
        p.labelY = labelY;
        if (Math.abs(labelY - p.y) > 0.5) {
          svg.append(svgEl('line', {
            x1: p.x + 5, x2: p.x + 11, y1: p.y, y2: labelY, class: 'chart-axisline'
          }));
        }
        svg.append(textNode(p.x + 14, labelY, formatNumber(p.value, 3), {
          anchor: 'start', baseline: 'middle', className: 'chart-text axis-num',
          extra: { 'font-size': 11 }
        }));
      }

      if (missing.length) {
        svg.append(textNode(margin.left, margin.top - 6,
          `未绘制（无可用观测）：${missing.map((s) => s.name).join('、')}`,
          { anchor: 'start', className: 'chart-muted', extra: { 'font-size': 10.5 } }));
      }

      // ---- Hover / focus layer -----------------------------------------
      const cross = svgEl('line', {
        x1: 0, x2: 0, y1: margin.top, y2: margin.top + innerH,
        class: 'chart-crosshair', visibility: 'hidden'
      });
      svg.append(cross);
      const dots = drawable.map((s) => {
        const dot = svgEl('circle', {
          r: 4.5, fill: s.color, class: 'chart-surface-ring', 'stroke-width': 2,
          visibility: 'hidden'
        });
        svg.append(dot);
        return { s, dot };
      });

      const hit = svgEl('rect', {
        x: margin.left, y: margin.top, width: innerW, height: innerH,
        fill: 'transparent', style: 'cursor:crosshair'
      });
      svg.append(hit);

      let focusIndex = null;
      const showAt = (index) => {
        if (index < 0 || index >= n) return;
        focusIndex = index;
        cross.setAttribute('x1', xPos(index));
        cross.setAttribute('x2', xPos(index));
        cross.setAttribute('visibility', 'visible');
        tip.replaceChildren();
        const head = document.createElement('div');
        head.className = 'chart-tip-x';
        head.textContent = xValues[index];
        tip.append(head);
        dots.forEach(({ s, dot }) => {
          const p = s.points[index];
          const row = document.createElement('div');
          row.className = 'chart-tip-row';
          const key = document.createElement('span');
          key.className = 'legend-key';
          key.style.background = s.color;
          const label = document.createElement('span');
          const value = p && p.y != null && Number.isFinite(p.y);
          if (value) {
            dot.setAttribute('cx', xPos(index));
            dot.setAttribute('cy', yPos(p.y));
            dot.setAttribute('visibility', 'visible');
            label.textContent = `${s.name} ${formatNumber(p.y, 3)}`;
          } else {
            dot.setAttribute('visibility', 'hidden');
            label.textContent = `${s.name} 无观测`;
          }
          row.append(key, label);
          tip.append(row);
        });
        if (tooltipNote) {
          const note = document.createElement('div');
          note.className = 'chart-tip-note';
          note.textContent = tooltipNote;
          tip.append(note);
        }
        tip.hidden = false;
        const hostRect = host.getBoundingClientRect();
        const svgRect = svg.getBoundingClientRect();
        const scale = svgRect.width / width;
        let left = svgRect.left - hostRect.left + xPos(index) * scale + 12;
        if (left > host.clientWidth - 180) {
          left = svgRect.left - hostRect.left + xPos(index) * scale - 182;
        }
        tip.style.left = `${Math.max(4, left)}px`;
        tip.style.top = '8px';
      };
      const hide = () => {
        focusIndex = null;
        cross.setAttribute('visibility', 'hidden');
        dots.forEach(({ dot }) => dot.setAttribute('visibility', 'hidden'));
        tip.hidden = true;
      };
      hit.addEventListener('pointermove', (event) => {
        const rect = svg.getBoundingClientRect();
        const x = ((event.clientX - rect.left) / rect.width) * width;
        const idx = Math.round(((x - margin.left) / innerW) * (n - 1));
        showAt(Math.max(0, Math.min(n - 1, idx)));
      });
      hit.addEventListener('pointerleave', hide);

      svg.setAttribute('tabindex', '0');
      svg.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault();
          const base = focusIndex == null ? (event.key === 'ArrowRight' ? 0 : n - 1) : focusIndex;
          showAt(Math.max(0, Math.min(n - 1, base + (event.key === 'ArrowRight' ? 1 : -1))));
        } else if (event.key === 'Escape') {
          hide();
        }
      });
      svg.addEventListener('blur', hide);
    },
    { signature, ariaLabel }
  ));
}

/** Dot strip for multiple-initialization estimates on a 1–5 scale. */
export function renderDotStrip(host, opts) {
  const { values = [], meanValue = null, domain = [1, 5], tickLabels = true } = opts;
  const height = 78;
  const signature = JSON.stringify({ theme: themeKey(), values, meanValue, domain });

  mountChart(host, Object.assign(({ svg, width, height: h }) => {
    const margin = { left: 16, right: 16 };
    const innerW = Math.max(40, width - margin.left - margin.right);
    const xPos = (v) => margin.left + ((v - domain[0]) / (domain[1] - domain[0])) * innerW;
    const axisY = h - 24;

    svg.append(svgEl('line', {
      x1: margin.left, x2: margin.left + innerW, y1: axisY, y2: axisY, class: 'chart-axisline'
    }));
    for (let v = domain[0]; v <= domain[1]; v += 1) {
      const x = xPos(v);
      svg.append(svgEl('line', {
        x1: x, x2: x, y1: axisY, y2: axisY + 4, class: 'chart-axisline'
      }));
      if (tickLabels) {
        svg.append(textNode(x, axisY + 16, String(v), {
          className: 'chart-muted axis-num', extra: { 'font-size': 10 }
        }));
      }
    }

    if (!values.length) {
      svg.append(textNode(width / 2, axisY - 24, '没有可比较的初始化结果', {
        className: 'chart-muted', extra: { 'font-size': 11 }
      }));
      return;
    }

    const counts = new Map();
    values.forEach((value) => {
      if (value == null || !Number.isFinite(value)) return;
      const bucket = Math.round(value * 100);
      const seen = counts.get(bucket) || 0;
      counts.set(bucket, seen + 1);
      const x = xPos(Math.min(domain[1], Math.max(domain[0], value)));
      const y = 24 + (seen % 3) * 13;
      const dot = svgEl('circle', {
        cx: x, cy: y, r: 4.5, fill: 'var(--series-1)',
        class: 'chart-surface-ring', 'stroke-width': 2
      });
      const title = svgEl('title');
      title.textContent = `初始化 ${seen + 1}：${formatNumber(value, 3)}`;
      dot.append(title);
      svg.append(dot);
    });

    if (meanValue != null && Number.isFinite(meanValue)) {
      const x = xPos(Math.min(domain[1], Math.max(domain[0], meanValue)));
      svg.append(svgEl('line', {
        x1: x, x2: x, y1: 8, y2: axisY, class: 'chart-mean-line'
      }));
      svg.append(svgEl('rect', {
        x: x - 4, y: 2, width: 8, height: 8,
        transform: `rotate(45 ${x} 6)`, class: 'chart-mean-mark'
      }));
      svg.append(textNode(x, axisY - 6, '均值', {
        anchor: 'middle', className: 'chart-muted', extra: { 'font-size': 9.5 }
      }));
    }
  }, { signature, ariaLabel: opts.ariaLabel || '多次初始化估计分布' }));
}

/** Range bar: min–max of real training ratings with a mean tick. */
export function renderRangeBar(host, opts) {
  const { min, max, mean, point, domain = [1, 5], count = 0 } = opts;
  const height = 66;
  const signature = JSON.stringify({ theme: themeKey(), min, max, mean, point, domain, count });

  mountChart(host, Object.assign(({ svg, width, height: h }) => {
    const margin = { left: 16, right: 16 };
    const innerW = Math.max(40, width - margin.left - margin.right);
    const xPos = (v) => margin.left + ((v - domain[0]) / (domain[1] - domain[0])) * innerW;
    const y = 30;

    svg.append(svgEl('line', {
      x1: margin.left, x2: margin.left + innerW, y1: y, y2: y,
      class: 'chart-track', 'stroke-width': 6, 'stroke-linecap': 'round'
    }));
    for (let v = domain[0]; v <= domain[1]; v += 1) {
      const x = xPos(v);
      svg.append(svgEl('line', {
        x1: x, x2: x, y1: y + 9, y2: y + 13, class: 'chart-axisline'
      }));
      svg.append(textNode(x, y + 26, String(v), {
        className: 'chart-muted axis-num', extra: { 'font-size': 10 }
      }));
    }

    if (count > 0 && min != null && max != null) {
      svg.append(svgEl('rect', {
        x: xPos(min), y: y - 3, width: Math.max(2, xPos(max) - xPos(min)),
        height: 6, rx: 3, fill: 'var(--series-1)'
      }));
      if (mean != null) {
        const mx = xPos(mean);
        svg.append(svgEl('line', {
          x1: mx, x2: mx, y1: y - 9, y2: y + 9, class: 'chart-surface-line', 'stroke-width': 2
        }));
        svg.append(svgEl('line', {
          x1: mx, x2: mx, y1: y - 8, y2: y + 8, class: 'chart-mean-line'
        }));
      }
      svg.append(textNode(xPos(min), y - 10, formatNumber(min, 1), {
        className: 'chart-text axis-num', extra: { 'font-size': 10 }
      }));
      svg.append(textNode(xPos(max), y - 10, formatNumber(max, 1), {
        className: 'chart-text axis-num', extra: { 'font-size': 10 }
      }));
    } else {
      svg.append(textNode(width / 2, y, '该维度没有训练观测', {
        baseline: 'middle', className: 'chart-muted', extra: { 'font-size': 11 }
      }));
    }

    if (point != null && Number.isFinite(point)) {
      const px = xPos(Math.min(domain[1], Math.max(domain[0], point)));
      svg.append(svgEl('rect', {
        x: px - 4.5, y: y - 4.5, width: 9, height: 9,
        transform: `rotate(45 ${px} ${y})`, class: 'chart-point-mark'
      }));
    }
  }, { signature, ariaLabel: opts.ariaLabel || '取值范围' }));
}

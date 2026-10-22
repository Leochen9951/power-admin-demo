/* 轻量 SVG 图表：不引入第三方库 */

const PALETTE = ['#0d7a5b', '#dd7d0a', '#2d68d8', '#7a5cd6', '#1c925f', '#cf3f3f', '#8a9a93'];

function niceMax(v) {
  if (!v || v <= 0) return 10;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const n = v / base;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * base;
}
const fmtShort = (n) => {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 10000) return `${(v / 10000).toFixed(v >= 100000 ? 0 : 1)}万`;
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
};

/** 柱 + 折线组合图：用电量(柱) / 电费(线) */
export function comboChart({ labels, bars, line, height = 250, unitBar = 'kWh', unitLine = '元' }) {
  const W = 780;
  const H = height;
  const pad = { l: 46, r: 46, t: 18, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const maxBar = niceMax(Math.max(...bars, 1));
  const maxLine = niceMax(Math.max(...line, 1));
  const n = labels.length;
  const slot = iw / Math.max(n, 1);
  const bw = Math.min(26, slot * 0.44);

  const yBar = (v) => pad.t + ih - (v / maxBar) * ih;
  const yLine = (v) => pad.t + ih - (v / maxLine) * ih;

  const grid = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const y = pad.t + ih * t;
    return `<line class="grid-line" x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}"/>
      <text class="axis-text" x="${pad.l - 8}" y="${y + 3}" text-anchor="end">${fmtShort(maxBar * (1 - t))}</text>
      <text class="axis-text" x="${W - pad.r + 8}" y="${y + 3}">${fmtShort(maxLine * (1 - t))}</text>`;
  }).join('');

  const barEls = bars.map((v, i) => {
    const x = pad.l + slot * i + slot / 2 - bw / 2;
    const y = yBar(v);
    const h = Math.max(1, pad.t + ih - y);
    return `<g><rect x="${x}" y="${y}" width="${bw}" height="${h}" rx="4" fill="url(#barGrad)">
      <title>${labels[i]} 用电 ${v.toLocaleString()} ${unitBar}</title></rect></g>`;
  }).join('');

  const pts = line.map((v, i) => [pad.l + slot * i + slot / 2, yLine(v)]);
  const linePath = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ');
  const areaPath = `${linePath} L${pts[pts.length - 1][0]},${pad.t + ih} L${pts[0][0]},${pad.t + ih} Z`;
  const dots = pts.map((p, i) => `<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="#fff" stroke="#dd7d0a" stroke-width="2">
    <title>${labels[i]} 电费 ¥${line[i].toLocaleString()}</title></circle>`).join('');
  const xLabels = labels.map((l, i) => {
    if (n > 8 && i % 2 === 1 && i !== n - 1) return '';
    return `<text class="axis-text" x="${pad.l + slot * i + slot / 2}" y="${H - 8}" text-anchor="middle">${l}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px">
    <defs>
      <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#1fbd8b"/><stop offset="100%" stop-color="#0d7a5b" stop-opacity=".72"/>
      </linearGradient>
      <linearGradient id="lineGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#dd7d0a" stop-opacity=".18"/><stop offset="100%" stop-color="#dd7d0a" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${grid}
    ${barEls}
    <path d="${areaPath}" fill="url(#lineGrad)"/>
    <path d="${linePath}" fill="none" stroke="#dd7d0a" stroke-width="2" stroke-linejoin="round"/>
    ${dots}
    ${xLabels}
  </svg>`;
}

/** 环形图 */
export function donut(items, { size = 168, thickness = 20, centerLabel = '', centerValue = '' } = {}) {
  const total = items.reduce((s, i) => s + Number(i.value || 0), 0);
  const r = (size - thickness) / 2;
  const c = size / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  const arcs = items.map((it, idx) => {
    const frac = total ? Number(it.value) / total : 0;
    const len = frac * circ;
    const el = `<circle cx="${c}" cy="${c}" r="${r}" fill="none"
      stroke="${it.color || PALETTE[idx % PALETTE.length]}" stroke-width="${thickness}"
      stroke-dasharray="${Math.max(0, len - 2.5)} ${circ - Math.max(0, len - 2.5)}"
      stroke-dashoffset="${-offset}" stroke-linecap="butt"
      transform="rotate(-90 ${c} ${c})">
      <title>${it.label} ${it.value} (${(frac * 100).toFixed(1)}%)</title></circle>`;
    offset += len;
    return el;
  }).join('');
  return `<svg viewBox="0 0 ${size} ${size}" style="width:${size}px;height:${size}px">
    <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#eef2ef" stroke-width="${thickness}"/>
    ${arcs}
    <text x="${c}" y="${c - 2}" text-anchor="middle" font-size="20" font-weight="650" fill="#0d1a15">${centerValue}</text>
    <text x="${c}" y="${c + 16}" text-anchor="middle" font-size="10.5" fill="#78877f">${centerLabel}</text>
  </svg>`;
}

export function legend(items) {
  return `<div class="legend">${items.map((i, idx) => `<span><i style="background:${i.color || PALETTE[idx % PALETTE.length]}"></i>${i.label} <b style="font-variant-numeric:tabular-nums">${i.text ?? i.value}</b></span>`).join('')}</div>`;
}

/** 横向条形 */
export function hbars(items, { max = null, unit = '', color = '#0d7a5b' } = {}) {
  const m = max || Math.max(...items.map((i) => Number(i.value) || 0), 1);
  return `<div class="col" style="gap:12px">${items.map((it, idx) => `
    <div>
      <div class="row between" style="font-size:12px;margin-bottom:4px">
        <span style="color:var(--ink-2)">${it.label}</span>
        <b style="font-variant-numeric:tabular-nums">${it.text ?? it.value}${unit}</b>
      </div>
      <div class="bar"><i style="width:${Math.max(2, (Number(it.value) / m) * 100)}%;background:${it.color || color}"></i></div>
    </div>`).join('')}</div>`;
}

/** 迷你折线 */
export function sparkline(values, { color = '#0d7a5b', height = 30 } = {}) {
  const w = 96;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / Math.max(1, values.length - 1)) * w;
    const y = height - 3 - ((v - min) / span) * (height - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `<svg viewBox="0 0 ${w} ${height}" style="width:${w}px;height:${height}px" preserveAspectRatio="none">
    <polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

export { PALETTE };

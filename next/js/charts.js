/* Hand-drawn SVG charts (no libraries). */
import { el, sv, fmt, md } from './util.js';

function niceMax(v) {
  if (v <= 0) return 10000;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const k of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (v <= k * p) return k * p;
  return 10 * p;
}
const wan = (n) => { const w = n / 10000; return (Math.abs(w) >= 10 || Number.isInteger(w) ? Math.round(w) : Math.round(w * 10) / 10) + '萬'; };

/* 12 months: income (green) vs spending after the share (orange). Tap a month to select it. */
export function monthBars(months, selYm, onSel) {
  const W = 340, H = 168, L = 30, R = 4, T = 8, B = 30, n = months.length;
  const top = niceMax(Math.max(1, ...months.map((m) => Math.max(m.income, m.expense_net))));
  const band = (W - L - R) / n, bw = Math.min(9, band * 0.32);
  const y = (v) => T + (1 - Math.max(0, v) / top) * (H - T - B);
  const g = sv('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '近 12 個月收入與支出' });
  for (const f of [0, 0.5, 1]) {
    g.append(sv('line', { class: 'grid', x1: L, x2: W - R, y1: y(top * f), y2: y(top * f) }),
      sv('text', { x: L - 5, y: y(top * f) + 3.5, 'text-anchor': 'end' }, f ? wan(top * f) : '0'));
  }
  months.forEach((m, i) => {
    const cx = L + band * (i + 0.5), on = m.ym === selYm, part = !(m.complete?.income && m.complete?.card);
    const grp = sv('g', { class: selYm && !on ? 'dim' : null });
    if (on) grp.append(sv('rect', { class: 'sel-bg', x: cx - band / 2 + 1, y: T - 4, width: band - 2, height: H - T - B + 8, rx: 5 }));
    const bar = (x, v, cls) => {
      const yy = y(v), h = Math.max(1, H - B - yy), r = Math.min(3, bw / 2, h);
      return sv('path', { class: cls, d: `M${x},${H - B}V${yy + r}Q${x},${yy} ${x + r},${yy}H${x + bw - r}Q${x + bw},${yy} ${x + bw},${yy + r}V${H - B}Z` });
    };
    grp.append(bar(cx - bw - 0.8, m.income, 'b-in'), bar(cx + 0.8, m.expense_net, 'b-out'));
    if (part) grp.append(sv('circle', { cx, cy: H - B + 22, r: 2.2, fill: 'none', stroke: 'currentColor', class: 'incomplete', style: 'color:var(--label-2)' }));
    const mon = +m.ym.slice(5);
    grp.append(sv('text', { x: cx, y: H - B + 13, 'text-anchor': 'middle', style: on ? 'fill:var(--tint);font-weight:600' : null }, mon === 1 ? `${m.ym.slice(2, 4)}/1` : mon));
    const hit = sv('rect', { x: cx - band / 2, y: 0, width: band, height: H, fill: 'transparent' });
    hit.addEventListener('click', () => onSel(m.ym));
    grp.append(hit);
    g.append(grp);
  });
  const wrap = el('div', { class: 'chart' }, g);
  // swipe left/right on the chart moves the selected month
  let x0 = null;
  wrap.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  wrap.addEventListener('touchend', (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (Math.abs(dx) < 40) return;
    const i = months.findIndex((m) => m.ym === selYm);
    const j = Math.max(0, Math.min(months.length - 1, (i < 0 ? months.length - 1 : i) + (dx < 0 ? 1 : -1)));
    onSel(months[j].ym);
  });
  return wrap;
}

/* Decode a prices series {start, dd[], c[]} into [[Date, close], ...]. */
export function decodeSeries(s) {
  const out = [];
  let d = new Date(s.start + 'T00:00:00');
  s.dd.forEach((k, i) => { d = new Date(d.getTime() + k * 864e5); out.push([d, s.c[i]]); });
  return out;
}
const RANGES = { '1M': 31, '3M': 92, '6M': 183, '1Y': 366, '3Y': 1096, '5Y': 1827, ALL: 1e6 };
export const RANGE_KEYS = Object.keys(RANGES);
export const RANGE_LABEL = { '1M': '1月', '3M': '3月', '6M': '6月', '1Y': '1年', '3Y': '3年', '5Y': '5年', ALL: '全部' };

/* Price chart with cost line, buy points and dividends; press and drag to read a day. */
export function priceChart(points, range, item, fmtPx, tipEl) {
  const W = 340, H = 190, L = 4, R = 40, T = 10, B = 22;
  const last = points[points.length - 1][0];
  const from = new Date(last.getTime() - RANGES[range] * 864e5);
  const pts = points.filter((p) => p[0] >= from);
  if (pts.length < 2) return el('p', { class: 'empty' }, '這段期間沒有價格資料。');
  const vals = pts.map((p) => p[1]);
  const cost = item.avg_cost || null;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (cost && cost < hi * 1.6 && cost > lo * 0.6) { lo = Math.min(lo, cost); hi = Math.max(hi, cost); }
  const pad = (hi - lo) * 0.08 || hi * 0.05;
  lo -= pad; hi += pad;
  const t0 = pts[0][0].getTime(), t1 = pts[pts.length - 1][0].getTime();
  const x = (d) => L + ((d.getTime() - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const up = vals[vals.length - 1] >= vals[0];
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
  const g = sv('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${item.name} 收盤價走勢` });
  for (const f of [0, 0.5, 1]) {
    const v = lo + (hi - lo) * f;
    g.append(sv('line', { class: 'grid', x1: L, x2: W - R, y1: y(v), y2: y(v) }), sv('text', { x: W - R + 4, y: y(v) + 3.5 }, fmtPx(v)));
  }
  g.append(sv('path', { class: 'area ' + (up ? 'up' : 'down'), d: `${line}L${x(pts[pts.length - 1][0])},${H - B}L${x(pts[0][0])},${H - B}Z` }),
    sv('path', { class: 'ln ' + (up ? 'up' : 'down'), d: line }));
  if (cost && cost > lo && cost < hi) {
    g.append(sv('line', { class: 'cost', x1: L, x2: W - R, y1: y(cost), y2: y(cost) }),
      sv('text', { x: L + 2, y: y(cost) - 4, style: 'font-size:9px' }, '平均成本'));
  }
  for (const [d, px] of item.buys || []) {
    const dd = new Date(d + 'T00:00:00');
    if (dd >= pts[0][0] && px > lo && px < hi) g.append(sv('path', { class: 'buy', d: `M${x(dd)},${y(px) - 6}l4.5,7h-9z` }));
  }
  for (const [d] of item.divs || []) {
    const dd = new Date(d + 'T00:00:00');
    if (dd >= pts[0][0]) g.append(sv('circle', { class: 'div', cx: x(dd), cy: H - B - 3, r: 2.6 }));
  }
  // x labels: first, middle, last
  const lab = (p, anchor) => sv('text', { x: x(p[0]), y: H - 6, 'text-anchor': anchor }, range === '1M' || range === '3M' || range === '6M'
    ? `${p[0].getMonth() + 1}/${p[0].getDate()}` : `${p[0].getFullYear()}/${p[0].getMonth() + 1}`);
  g.append(lab(pts[0], 'start'), lab(pts[Math.floor(pts.length / 2)], 'middle'), lab(pts[pts.length - 1], 'end'));
  const xh = sv('line', { class: 'xh', y1: T, y2: H - B, visibility: 'hidden' });
  const xd = sv('circle', { class: 'xdot', r: 4, visibility: 'hidden' });
  g.append(xh, xd);
  const first = vals[0];
  const show = (i) => {
    const p = pts[i];
    xh.setAttribute('x1', x(p[0])); xh.setAttribute('x2', x(p[0])); xh.setAttribute('visibility', 'visible');
    xd.setAttribute('cx', x(p[0])); xd.setAttribute('cy', y(p[1])); xd.setAttribute('visibility', 'visible');
    const ch = (p[1] / first - 1) * 100;
    tipEl.replaceChildren(el('b', {}, `${p[0].getFullYear()}/${p[0].getMonth() + 1}/${p[0].getDate()}　${fmtPx(p[1])}`),
      `　區間 ${ch >= 0 ? '+' : '−'}${Math.abs(ch).toFixed(1)}%`);
  };
  const reset = () => {
    xh.setAttribute('visibility', 'hidden'); xd.setAttribute('visibility', 'hidden');
    const ch = (vals[vals.length - 1] / first - 1) * 100;
    tipEl.replaceChildren(`${RANGE_LABEL[range]}：`, el('b', { class: ch >= 0 ? 'up' : 'down' }, `${ch >= 0 ? '+' : '−'}${Math.abs(ch).toFixed(1)}%`),
      `　${span(pts[0][0])}–${span(pts[pts.length - 1][0])}　▲買進　●配息`);
  };
  const long = RANGES[range] > 200;
  const span = (d) => (long ? `${d.getFullYear()}/${d.getMonth() + 1}` : md(iso(d)));
  const pick = (clientX) => {
    const r = g.getBoundingClientRect();
    const fx = ((clientX - r.left) / r.width) * W;
    const t = t0 + ((fx - L) / (W - L - R)) * (t1 - t0);
    let best = 0;
    for (let i = 0; i < pts.length; i++) if (Math.abs(pts[i][0].getTime() - t) < Math.abs(pts[best][0].getTime() - t)) best = i;
    show(best);
  };
  const wrap = el('div', { class: 'chart', style: { touchAction: 'none' } }, g);
  wrap.addEventListener('pointerdown', (e) => { wrap.setPointerCapture(e.pointerId); pick(e.clientX); });
  wrap.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') pick(e.clientX); });
  wrap.addEventListener('pointerup', reset);
  wrap.addEventListener('pointercancel', reset);
  reset();
  return wrap;
}
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/* Tiny sparkline (last ~30 closes) for the stock list. */
export function spark(points, up) {
  const pts = points.slice(-30);
  if (pts.length < 2) return null;
  const vals = pts.map((p) => p[1]), lo = Math.min(...vals), hi = Math.max(...vals);
  const W = 56, H = 24;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${(i / (pts.length - 1) * W).toFixed(1)},${(2 + (1 - (p[1] - lo) / ((hi - lo) || 1)) * (H - 4)).toFixed(1)}`).join('');
  return el('span', { class: 'chart', style: { width: '56px', flex: 'none' } }, sv('svg', { viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' },
    sv('path', { class: 'ln ' + (up ? 'up' : 'down'), d, style: 'stroke-width:1.4' })));
}
export { fmt };

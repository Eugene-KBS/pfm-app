/* Small helpers. Data is rendered with textContent only (never innerHTML). */
export function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'value') n.value = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(4)) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
  return n;
}
const NS = 'http://www.w3.org/2000/svg';
export function sv(tag, attrs, ...kids) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'style') n.style.cssText = v;            // CSSOM, allowed by the strict CSP (no style attributes)
    else n.setAttribute(k, v);
  }
  for (const k of kids.flat(4)) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
  return n;
}
export const icon = (paths, cls) => sv('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', class: cls }, [].concat(paths).map((d) => sv('path', { d })));
export const IC = {
  home: 'M3 10.5L12 3l9 7.5V20a1 1 0 01-1 1h-5v-6h-6v6H4a1 1 0 01-1-1z',
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3.5 6h.01', 'M3.5 12h.01', 'M3.5 18h.01'],
  chart: ['M3 20h18', 'M5 16l4-5 4 3 6-8'],
  cal: ['M4 6h16v14H4z', 'M4 10h16', 'M8 3v4', 'M16 3v4'],
  gear: ['M12 15.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7z', 'M19.4 13a7.6 7.6 0 000-2l2-1.5-2-3.4-2.3 1a7.6 7.6 0 00-1.8-1L15 3.5h-4l-.4 2.5a7.6 7.6 0 00-1.7 1l-2.4-1-2 3.5 2 1.5a7.6 7.6 0 000 2l-2 1.5 2 3.4 2.4-1a7.6 7.6 0 001.7 1l.4 2.6h4l.3-2.6a7.6 7.6 0 001.8-1l2.3 1 2-3.4z'],
  refresh: ['M20 11a8 8 0 10-2.3 5.7', 'M20 4v7h-7'],
  eye: ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z', 'M12 15a3 3 0 100-6 3 3 0 000 6z'],
  eyeOff: ['M3 3l18 18', 'M10.6 5.1A9.7 9.7 0 0112 5c6.4 0 10 7 10 7a17 17 0 01-3.2 4', 'M6.5 6.6A17 17 0 002 12s3.6 7 10 7a9.6 9.6 0 004.3-1'],
  money: ['M3 7h18v10H3z', 'M12 14.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z', 'M6 10v.01', 'M18 14v.01'],
  alert: ['M12 3l10 18H2z', 'M12 10v4', 'M12 17.5v.01'],
  tag: ['M3 12V3h9l9 9-9 9z', 'M7.5 7.5h.01'],
  q: ['M9.1 9a3 3 0 015.8 1c0 2-3 2.5-3 4.5', 'M12 18h.01', 'M12 22a10 10 0 100-20 10 10 0 000 20z'],
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  check: 'M5 12.5l4.5 4.5L19 7',
  search: ['M11 18a7 7 0 100-14 7 7 0 000 14z', 'M20 20l-4-4'],
  clock: ['M12 21a9 9 0 100-18 9 9 0 000 18z', 'M12 7v5l3 2'],
  bell: ['M6 9a6 6 0 0112 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9z', 'M10 20a2 2 0 004 0'],
  repeat: ['M17 2l4 4-4 4', 'M3 11V9a3 3 0 013-3h15', 'M7 22l-4-4 4-4', 'M21 13v2a3 3 0 01-3 3H3'],
  advisor: ['M19.5 12.5A8 8 0 1 1 11.5 4.5v8z', 'M13 3a8 8 0 0 1 8 8h-8z'],      // pie with one slice pulled out: 顧問 (allocation)
};
export function chevron() {
  return sv('svg', { class: 'chev', viewBox: '0 0 8 13', 'aria-hidden': 'true' }, sv('path', { d: 'M1.5 1.5l5 5-5 5' }));
}
export const fmt = (n) => (n == null || Number.isNaN(n) ? '—' : Math.round(n).toLocaleString('en-US'));
export const fmt2 = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
export const signed = (n) => (n == null ? '—' : (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n)));
export const pct = (v, d = 1) => (v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d) + '%');
export const amt = (n, cls) => el('span', { class: 'amt' + (cls ? ' ' + cls : '') }, fmt(n));
export const samt = (n, cls) => el('span', { class: 'amt ' + (cls || (n > 0 ? 'pos' : n < 0 ? 'neg' : '')) }, signed(n));
export const md = (iso) => (iso ? `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}` : '');
export const ymShort = (ym) => `${+ym.slice(5)} 月`;
export const ymLong = (ym) => `${ym.slice(0, 4)} 年 ${+ym.slice(5)} 月`;
export const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
export const wd = (iso) => WEEK[new Date(iso + 'T00:00:00').getDay()];
export function ymAdd(ym, k) { const i = +ym.slice(0, 4) * 12 + +ym.slice(5) - 1 + k; return `${Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}`; }
export function todayIso() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
export function daysUntil(iso) { return Math.round((new Date(iso + 'T00:00:00') - new Date(todayIso() + 'T00:00:00')) / 864e5); }
export function stamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export function short(name, n = 14) {
  const x = String(name || '').replace(/（[^）]*）|\([^)]*\)/g, '').trim();
  return x.length <= n ? x : x.slice(0, n - 1) + '…';
}
export const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode / full */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  json(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  setJson(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
};
let toastT = null;
export function toast(text) {
  let t = document.querySelector('.toast');
  if (!t) { t = el('div', { class: 'toast', role: 'status' }); document.body.append(t); }
  t.textContent = text;
  requestAnimationFrame(() => t.classList.add('on'));
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('on'), 2400);
}
/* A grouped section: title (+ optional small text or right button) and content. */
export function group(title, content, opt = {}) {
  return el('section', { class: 'group' + (opt.cls ? ' ' + opt.cls : '') },
    title ? el('h2', {}, title, opt.small ? el('small', {}, opt.small) : null,
      opt.action ? el('button', { onclick: opt.action[1] }, opt.action[0]) : null) : null,
    content, opt.foot ? el('p', { class: 'group-foot' }, opt.foot) : null);
}
/* One list row. */
export function row({ icon: ic, title, sub, value, valueSub, onClick, chevron: chev, wrapSub, extra, cls }) {
  const kids = [ic || null,
    el('span', { class: 'main' }, el('span', { class: 't' }, title), sub ? el('span', { class: 's' + (wrapSub ? ' wrap' : '') }, sub) : null, extra || null),
    value != null ? el('span', { class: 'v' }, value, valueSub != null ? el('small', {}, valueSub) : null) : null,
    chev ? chevron() : null];
  return el('li', {}, onClick ? el('button', { class: 'row' + (cls ? ' ' + cls : ''), onclick: onClick }, kids) : el('div', { class: 'row' + (cls ? ' ' + cls : '') }, kids));
}
export function badgeIcon(kind, level) {
  const map = { fund: [IC.money, level === 'critical' ? 'crit' : level === 'serious' ? 'serious' : 'warning'], system: [IC.alert, 'crit'],
    anomaly: [IC.bolt, 'purple'], classify: [IC.tag, 'blue'], question: [IC.q, 'teal'] };
  const [p, c] = map[kind] || [IC.alert, 'info'];
  return el('span', { class: 'ico ' + c }, icon(p));
}
export function clockMark() { return sv('svg', { class: 'clock', viewBox: '0 0 24 24', 'aria-label': '已送出，明早生效' }, sv('circle', { cx: 12, cy: 12, r: 9 }), sv('path', { d: 'M12 7v5l3 2' })); }

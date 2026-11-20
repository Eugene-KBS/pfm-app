/* 明細: month strip, filters, search, grouped by day; tap a row for details and edits. */
import { el, group, fmt, md, wd, icon, IC, ymShort } from './util.js';
import { S, pendingView } from './data.js';
import { txRow, openTx, txView } from './actions.js';

const FILTERS = [['spend', '支出'], ['income', '收入'], ['move', '轉帳'], ['review', '待確認']];
const DIRS = { spend: ['e', 'r'], income: ['i'], move: ['to', 'ti', 'cp'] };

export function viewTx(app) {
  const d = S.data, st = app.tx;
  const months = d.months.slice().reverse();
  if (!st.ym) st.ym = d.month_now.ym;
  const pv = pendingView();
  const strip = el('div', { class: 'scroller', role: 'tablist', 'aria-label': '月份' },
    months.map((m) => el('button', { class: 'mchip' + (m.complete && !(m.complete.income && m.complete.card) ? ' partial' : ''), 'aria-pressed': String(m.ym === st.ym && !st.q),
      onclick: () => { st.ym = m.ym; st.q = ''; st.cat = null; app.render(); } },
    el('b', {}, m.ym.slice(0, 4) === d.month_now.ym.slice(0, 4) ? ymShort(m.ym) : `${m.ym.slice(2, 4)}/${+m.ym.slice(5)}`),
    el('span', { class: 'amt' }, '收 ' + fmt(m.income)), el('span', { class: 'amt' }, '支 ' + fmt(m.expense_net)))));
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': '篩選' }, FILTERS.map(([k, n]) =>
    el('button', { 'aria-pressed': String(st.f === k), onclick: () => { st.f = k; app.render(); } }, n)));
  const q = el('input', { type: 'search', placeholder: '搜尋商家、品項、分類或金額', value: st.q || '', enterkeyhint: 'search' });
  q.addEventListener('input', () => { st.q = q.value; clearTimeout(st._t); st._t = setTimeout(() => app.render({ keepFocus: true }), 250); });
  const search = el('div', { class: 'search' }, icon(IC.search), q);
  let list = d.tx;
  const needle = (st.q || '').trim().toLowerCase();
  if (needle) {
    list = list.filter((t) => [t.m, t.mr, t.i, t.c1, t.c2, t.n, String(t.a)].some((x) => x && String(x).toLowerCase().includes(needle))).slice(0, 300);
  } else {
    list = list.filter((t) => t.d.startsWith(st.ym));
  }
  if (st.f === 'review') list = list.filter((t) => { const v = txView(t, pv); return v.flags.has('uncl') || v.flags.has('rev') || v.flags.has('est') || v.pending; });
  else list = list.filter((t) => DIRS[st.f].includes(t.dir));
  if (st.cat) list = list.filter((t) => txView(t, pv).c1 === st.cat);
  const out = [el('div', { class: 'sticky' }, strip, seg, search)];
  if (st.cat) out.push(el('div', { class: 'banner' }, el('span', {}, `只看「${st.cat}」`), el('button', { onclick: () => { st.cat = null; app.render(); } }, '清除')));
  if (!list.length) {
    out.push(group(null, el('div', { class: 'card empty' }, needle ? '找不到符合的交易。' : st.f === 'income' ? '這個月沒有收入紀錄。' : '沒有符合的交易。')));
    return out;
  }
  let total = 0;
  const days = new Map();
  for (const t of list) {
    if (!days.has(t.d)) days.set(t.d, []);
    days.get(t.d).push(t);
    total += t.dir === 'r' ? -t.a : t.a;
  }
  out.push(el('p', { class: 'muted sm', style: { margin: '12px 6px 0' } }, `${list.length} 筆，合計 `, el('span', { class: 'amt' }, fmt(total)),
    needle ? '（搜尋全部月份）' : ''));
  let shown = 0;
  for (const [day, items] of days) {
    if (shown > 400) break;
    const sum = items.reduce((s, t) => s + (t.dir === 'r' ? -t.a : t.a), 0);
    out.push(el('div', { class: 'dayhead' }, el('span', {}, `${md(day)}（${wd(day)}）${needle ? '　' + day.slice(0, 4) : ''}`), el('span', { class: 'amt' }, fmt(sum))),
      el('ul', { class: 'list' }, items.map((t) => txRow(t, pv, (x) => openTx(x, () => app.render())))));
    shown += items.length;
  }
  return out;
}

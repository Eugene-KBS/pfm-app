/* 總覽: to-dos, this month's balance, everyday spending against the cap, 12 months, cash, weekly summary. */
import { el, group, row, amt, samt, fmt, ymShort, ymLong, md, short } from './util.js';
import { openSheet } from './sheet.js';
import { S, pendingView } from './data.js';
import { visibleTodos, todoRow, openTodoList, openTx, txById } from './actions.js';
import { monthBars } from './charts.js';

export const CARD_NAMES = { todo: '待處理', balance: '本月結餘', daily: '日常支出進度', months: '12 個月收支', cash: '現金與淨資產', weekly: '每週摘要' };

export function viewOverview(app) {
  const d = S.data, cur = d.month_now.ym;
  const sel = app.sel && d.months.some((m) => m.ym === app.sel) ? app.sel : cur;
  const isCur = sel === cur;
  const m = isCur ? Object.assign({}, d.months.find((x) => x.ym === cur), d.month_now) : d.months.find((x) => x.ym === sel);
  const rerender = () => app.render();
  const cards = {
    todo: () => (isCur ? todoCard(rerender) : null),
    balance: () => balanceCard(d, m, isCur, app),
    daily: () => dailyCard(d, m, isCur, app),
    months: () => monthsCard(d, sel, app),
    cash: () => (isCur ? cashCard(d) : null),
    weekly: () => (isCur && d.weekly ? weeklyCard(d) : null),
  };
  const order = (S.ui.cards || Object.keys(cards)).filter((k) => cards[k] && !(S.ui.hidden || []).includes(k));
  for (const k of Object.keys(cards)) if (!order.includes(k) && !(S.ui.hidden || []).includes(k)) order.push(k);
  const out = [];
  if (!isCur) {
    out.push(el('div', { class: 'banner' }, el('span', {}, `正在看 ${ymLong(sel)}`), el('button', { onclick: () => { app.sel = null; rerender(); } }, '回到本月')));
  }
  for (const k of order) out.push(cards[k]());
  return out;
}

function todoCard(rerender) {
  const list = visibleTodos();
  if (!list.length) return group('待處理', el('div', { class: 'card empty' }, '沒有要你動手的事 ✓'));
  const top = list.slice(0, 3);
  return group('待處理', [el('ul', { class: 'list indent' }, top.map((t) => todoRow(t, rerender))),
    list.length > 3 ? el('button', { class: 'more-btn', onclick: () => openTodoList(rerender) }, `還有 ${list.length - 3} 件`) : null],
  { small: `${list.length} 件` });
}

function balanceCard(d, m, isCur, app) {
  const share = m.share || 0, name = d.share_name || '分攤';
  const card = el('button', { class: 'card hero', style: { display: 'block', width: '100%', textAlign: 'left', border: '0', color: 'inherit' }, onclick: () => openBalance(d, m) },
    el('div', { class: 'label' }, `${ymShort(m.ym)}結餘`, m.income_is_estimate ? el('span', { class: 'est' }, '預估') : null,
      !(m.complete?.income && m.complete?.card) && !isCur ? el('span', { class: 'est' }, '資料不完整') : null),
    el('div', { class: 'big ' + (m.balance >= 0 ? 'pos' : 'neg') }, el('span', { class: 'cur' }, 'NT$'), el('span', { class: 'amt' }, (m.balance < 0 ? '−' : '') + fmt(Math.abs(m.balance)))),
    el('div', { class: 'line' }, '收入 ', el('b', {}, amt(m.income)), ' − 支出 ', el('b', {}, amt(m.expense_net)),
      share ? [`（已扣${name}分攤 `, amt(share), '）'] : null),
    el('div', { class: 'line' }, '投資後 ', el('b', {}, samt(m.balance_after_invest)), m.invest ? ['（投入股票 ', amt(m.invest), '）'] : null),
    m.income_is_estimate ? el('div', { class: 'line tiny' }, '薪水還沒入帳，收入暫用上次薪資；這段期間不會因為結餘轉負而通知。') : null);
  return group(null, card);
}

function openBalance(d, m) {
  const name = d.share_name || '分攤';
  const bigs = m.big || [];
  openSheet({ title: `${ymLong(m.ym)}的收支`, body: [
    group('結餘', el('dl', { class: 'kv card' },
      el('dt', {}, '收入' + (m.income_is_estimate ? '（含預估薪資）' : '')), el('dd', {}, amt(m.income)),
      el('dt', {}, '支出（毛）'), el('dd', {}, amt(m.expense_gross)),
      el('dt', {}, `${name}轉入`), el('dd', {}, amt(m.share_in)),
      el('dt', {}, `轉給${name}`), el('dd', {}, amt(m.share_out)),
      el('dt', {}, `支出（已扣${name}分攤）`), el('dd', {}, amt(m.expense_net)),
      el('dt', {}, '結餘'), el('dd', {}, samt(m.balance)),
      el('dt', {}, '投入股票'), el('dd', {}, amt(m.invest)),
      el('dt', {}, '投資後'), el('dd', {}, samt(m.balance_after_invest))),
    { foot: `${name}轉來的錢算她分攤的共同開銷，從你的支出扣掉，不算收入。` }),
    group('支出拆解', el('dl', { class: 'kv card' },
      el('dt', {}, '房貸'), el('dd', {}, amt(m.mortgage)),
      el('dt', {}, `大筆（${m.big_n || bigs.length} 筆）`), el('dd', {}, amt(m.big_total)),
      el('dt', {}, '日常支出'), el('dd', {}, amt(m.daily)))),
    bigs.length ? group('大筆', el('ul', { class: 'list' }, bigs.map((b) => row({ title: b.m, sub: md(b.d), value: amt(b.a), onClick: () => { const t = txById(b.id); if (t) openTx(t); } })))) : null,
  ] });
}

function dailyCard(d, m, isCur, app) {
  const cap = m.daily_cap || 80000, used = m.daily, ratio = used / Math.max(1, cap);
  const fill = el('div', { class: 'fill' + (ratio >= 1 ? ' over' : ratio >= 0.8 ? ' warn' : '') });
  fill.style.width = Math.min(100, ratio * 100) + '%';
  const track = el('div', { class: 'track' }, fill);
  if (isCur) {
    const mark = el('div', { class: 'mark', title: '照比例今天應該在的位置' });
    mark.style.left = `calc(${Math.min(100, (m.day / m.days) * 100)}% - 1px)`;
    track.append(mark);
  }
  let top = [];
  if (isCur) top = m.daily_top || [];
  else {
    const c = (d.cats || {})[m.ym] || {};
    top = Object.entries(c).map(([k, v]) => ({ cat: k, amount: k === '居住' ? v[0] - ((v[2] || {})['房貸'] || 0) : v[0] })).filter((x) => x.amount > 0)
      .sort((a, b) => b.amount - a.amount).slice(0, 3);
  }
  const left = cap - used;
  return group('日常支出', el('div', { class: 'card progress' },
    el('div', { class: 'head' }, el('b', { class: 'amt' }, fmt(used)), el('span', { class: 'muted sm' }, '上限 ', amt(cap))),
    track,
    el('div', { class: 'track-legend' }, el('span', {}, left >= 0 ? ['還可以花 ', amt(left)] : ['已超出 ', amt(-left)]),
      isCur ? el('span', {}, `第 ${m.day}/${m.days} 天｜照比例應在 `, amt(cap * m.day / m.days)) : el('span', {}, `${Math.round(ratio * 100)}%`)),
    top.length ? el('ul', { class: 'list cat-rows', style: { background: 'transparent' } }, top.map((c) => el('li', {}, el('button', { class: 'row', style: { padding: '8px 0', minHeight: '38px' },
      onclick: () => app.goTx({ ym: m.ym, cat: c.cat }) }, el('span', { class: 'main' }, el('span', { class: 't' }, c.cat)), el('span', { class: 'v amt' }, fmt(c.amount)))))) : null),
  { foot: '日常支出＝支出扣掉房貸與單筆大額（大筆）。點類別看那些交易。' });
}

function monthsCard(d, sel, app) {
  const ms = d.months.slice(-12);
  const cur = d.month_now.ym;
  const m = d.months.find((x) => x.ym === sel);
  return group('12 個月收支', el('div', { class: 'card pad' },
    monthBars(ms, sel === cur ? null : sel, (ym) => { app.sel = ym === cur ? null : ym; app.render(); }),
    el('div', { class: 'legend' }, el('span', {}, el('i', { style: { background: 'var(--bar-in)' } }), '收入'),
      el('span', {}, el('i', { style: { background: 'var(--bar-out)' } }), `支出（已扣${d.share_name || '分攤'}分攤）`), el('span', {}, '◌ 資料不完整')),
    m ? el('div', { class: 'chart-tip' }, el('b', {}, ymShort(m.ym)), '　收入 ', amt(m.income), '　支出 ', amt(m.expense_net), '　結餘 ', samt(m.balance)) : null),
  { foot: '點一個月份，整個總覽會切到那個月；左右滑動可以換月。' });
}

function cashCard(d) {
  const c = d.cash;
  if (!c) return null;
  return group('現金與淨資產', [el('ul', { class: 'list' },
    c.items.map((x) => row({ title: x.name, sub: x.as_of ? `${md(x.as_of)} 的餘額` : null, value: x.amount < 0 ? samt(x.amount) : amt(x.amount) })),
    c.stocks != null ? row({ title: '股票（收盤價估）', sub: c.stocks_date ? `${md(c.stocks_date)} 收盤` : null, value: amt(c.stocks) }) : null,
    row({ title: el('b', {}, '已知資產減負債'), sub: '不含房產與還沒接上的帳戶', value: el('b', {}, samt(c.net)) }))],
  { foot: '餘額是最後一次看到的數字（對帳單、匯出檔或截圖），不是即時餘額；房屋本身的價值沒有算進來。' });
}

function weeklyCard(d) {
  const w = d.weekly;
  return group('每週摘要', el('div', { class: 'card' }, w.lines.map((l) => el('p', { class: 'para' }, l))), { small: `${md(w.from)}–${md(w.to)}` });
}
export { short };

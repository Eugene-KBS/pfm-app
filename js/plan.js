/* 計畫: money needed before each debit, payday transfers, next 30 days, subscriptions, month-end and weekly reports. */
import { el, group, row, amt, samt, fmt, md, wd, short, ymLong, daysUntil, clockMark } from './util.js';
import { S, queueCmd, pendingView } from './data.js';

const STATUS = { open: '待補', done: '已完成', auto: '自動轉', past: '已過' };

export function viewPlan(app) {
  const d = S.data, pv = pendingView();
  const out = [];
  const fund = d.fund || [];
  out.push(group('補錢清單', fund.length ? el('ul', { class: 'list' }, fund.map((f) => {
    const pend = pv.todo.has(f.id);
    const st = pend ? 'done' : f.status;
    const left = daysUntil(f.topup_by);
    const sub = `${md(f.debit)}（${wd(f.debit)}）扣款・最晚 ${md(f.topup_by)} 補　${f.account}` + (f.balance ? `　餘額 ${fmt(f.balance.amount)}（${md(f.balance.date)}）` : '');
    return el('li', {}, el('div', { class: 'row' },
      el('span', { class: 'main' }, el('span', { class: 't' }, short(f.name, 18), el('span', { class: 'tag' + (st === 'open' && left <= 3 ? ' red' : st === 'open' ? ' warn' : '') }, STATUS[st] || st),
        pend ? clockMark() : null),
      el('span', { class: 's wrap' }, sub + (f.basis ? `　${f.basis}` : '') + (f.done_by && st === 'done' ? `　${f.done_by}` : ''))),
      el('span', { class: 'v' }, f.amount ? amt(f.amount) : '—', el('small', {}, f.estimate ? '估' : '')),
      st === 'open' ? el('button', { class: 'pill', onclick: () => { queueCmd({ done: { todo_id: f.id } }, '已記下「已轉」'); app.render(); } }, '已轉') : null));
  })) : el('div', { class: 'card empty' }, '未來 35 天沒有要補的錢。'),
  { foot: '最晚補錢日＝扣款日前一個營業日；只避開週末，遇到國定假日請自己提早。看到對應的轉帳或繳款入帳會自動完成。' }));

  const p = d.payday;
  if (p) {
    const lines = (xs) => xs.map((g) => row({ title: `轉到 ${g.account}`, sub: g.items.map((x) => short(x, 16)).join('、'), value: amt(g.amount), wrapSub: true }));
    out.push(group(`發薪日建議（${md(p.next_payday)}）`, [
      p.before.length ? el('ul', { class: 'list' }, el('li', {}, el('div', { class: 'row' }, el('span', { class: 'main' }, el('span', { class: 't' }, el('b', {}, '發薪前要扣的')),
        el('span', { class: 's' }, '這些要從郵局（或其他存款）先轉過去')), el('span', { class: 'v' }, el('b', {}, amt(p.before_total))))), lines(p.before)) : null,
      p.after.length ? el('ul', { class: 'list', style: { marginTop: '10px' } }, el('li', {}, el('div', { class: 'row' }, el('span', { class: 'main' }, el('span', { class: 't' }, el('b', {}, '發薪後到下次發薪前')),
        el('span', { class: 's' }, p.salary_estimate ? `預計薪資約 ${fmt(p.salary_estimate)}` : '')), el('span', { class: 'v' }, el('b', {}, amt(p.after_total))))), lines(p.after)) : null,
      !p.before.length && !p.after.length ? el('div', { class: 'card empty' }, '下次發薪前沒有要預先轉的錢。') : null]));
  }

  const cf = d.cashflow;
  if (cf && cf.events.length) {
    const days = new Map();
    for (const e of cf.events) { if (!days.has(e.d)) days.set(e.d, []); days.get(e.d).push(e); }
    const lst = [];
    for (const [day, evs] of days) {
      for (const e of evs) {
        lst.push(row({ title: [short(e.name, 18), e.kind === 'card' ? el('span', { class: 'tag' }, '刷卡') : null],
          sub: `${md(day)}（${wd(day)}）　${e.account || ''}`,
          value: e.amount ? el('span', { class: 'amt ' + (e.kind === 'in' ? 'pos' : '') }, (e.kind === 'in' ? '+' : '−') + fmt(e.amount)) : '—',
          valueSub: e.estimate ? '估' : null }));
      }
    }
    out.push(group('未來 30 天', el('ul', { class: 'list' }, lst), { small: `${md(cf.from)}–${md(cf.to)}`,
      foot: cf.by_account.map((a) => `${a.account}：進 ${fmt(a.in)}、出 ${fmt(a.out)}`).join('；') + '。刷卡的訂閱會併進信用卡帳單，不另外扣存款。' }));
  }

  const subs = d.subs;
  if (subs) {
    const act = subs.items.filter((x) => x.active), gone = subs.items.filter((x) => !x.active);
    out.push(group('訂閱與固定扣款', [
      el('div', { class: 'card pad', style: { display: 'flex', gap: '10px' } },
        el('div', { class: 'kv-chip', style: { flex: '1' } }, '每月', el('b', { class: 'amt' }, fmt(subs.monthly))),
        el('div', { class: 'kv-chip', style: { flex: '1' } }, '一年', el('b', { class: 'amt' }, fmt(subs.yearly))),
        el('div', { class: 'kv-chip', style: { flex: '1' } }, '項目', el('b', {}, String(subs.active_n)))),
      subs.overlaps.length ? el('div', { class: 'banner' }, el('span', {}, subs.overlaps.map((o) => `${o.title}：${o.names.join('、')} 同時在扣`).join('；'))) : null,
      el('ul', { class: 'list', style: { marginTop: '10px' } }, act.map((x) => row({
        title: [x.name, x.changed_pct > 0 ? el('span', { class: 'tag red' }, `漲 ${x.changed_pct}%`) : null, x.group ? el('span', { class: 'tag' }, x.group) : null],
        sub: `上次 ${md(x.last)}${x.next ? `　下次約 ${md(x.next)}` : ''}　${x.account || ''}`, value: amt(x.amount), valueSub: `一年 ${fmt(x.yearly)}` }))),
      gone.length ? el('details', { class: 'card', style: { marginTop: '10px', padding: '0 0 4px' } }, el('summary', { class: 'row', style: { color: 'var(--tint)' } }, `已停扣（${gone.length}）`),
        el('ul', { class: 'list' }, gone.map((x) => row({ title: x.name, sub: `最後一次 ${x.last}`, value: amt(x.amount) })))) : null],
    { foot: '不含房貸。金額是最近一次的扣款；收據沒寄到信箱的月份可能漏看。' }));
  }

  const r = d.monthly_report;
  if (r) {
    out.push(group(`${ymLong(r.ym)}月結`, [
      el('div', { class: 'card' }, r.lines.map((l) => el('p', { class: 'para' }, l))),
      r.cat_diffs.length ? el('ul', { class: 'list', style: { marginTop: '10px' } }, r.cat_diffs.map((c) => row({ title: c.cat, sub: `前 3 個月中位數 ${fmt(c.median3)}`,
        value: amt(c.amount), valueSub: (c.diff > 0 ? '多 ' : '少 ') + fmt(Math.abs(c.diff)) }))) : null,
      r.big.length ? el('ul', { class: 'list', style: { marginTop: '10px' } }, r.big.map((b) => row({ title: b.m, sub: `${md(b.d)}　大筆`, value: amt(b.a) }))) : null,
      r.tips.length ? el('ul', { class: 'list', style: { marginTop: '10px' } }, r.tips.map((t) => row({ title: t.title, sub: t.body, wrapSub: true, value: t.impact ? el('span', { class: 'sm pos' }, t.impact) : null }))) : null],
    { foot: '每月 6 日產生上個月的月結；建議由規則產生，不是投資或稅務建議。' }));
  }
  if (d.weekly) {
    out.push(group('每週摘要', el('div', { class: 'card' }, d.weekly.lines.map((l) => el('p', { class: 'para' }, l)),
      d.weekly.top.length ? el('p', { class: 'para muted sm' }, '這週最大的幾筆：' + d.weekly.top.map((t) => `${t.m} ${fmt(t.a)}`).join('、')) : null),
    { small: `${md(d.weekly.from)}–${md(d.weekly.to)}`, foot: '每週六早上的更新會推播一次週摘要。' }));
  }
  return out;
}
export { samt };

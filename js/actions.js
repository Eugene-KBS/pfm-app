/* Sheets and write-back actions shared by several tabs: a to-do, a transaction, classifying, answering. */
import { el, group, row, amt, fmt, md, wd, short, badgeIcon, clockMark, toast, ymLong, daysUntil } from './util.js';
import { openSheet } from './sheet.js';
import { S, queueCmd, pendingView } from './data.js';

export const CAT1 = ['飲食', '交通', '購物', '居住', '訂閱數位', '休閒娛樂', '旅遊', '醫療保健', '寵物', '家庭人情', '專業工作', '保險', '稅費', '金融費用', '教育', '其他'];
const DIRL = { r: '退款', ti: '轉入', to: '轉出', cp: '繳卡費', i: '收入', e: '支出' };
const SRC = {
  ctbc_cc_stmt: '中信卡帳單明細', sinopac_cc_stmt: '永豐卡電子帳單', ctbc_acct: '中信活存明細', ctbc_notice: '中信通知信', apple_invoice: 'Apple 發票',
  sinopac_bank_stmt: '永豐綜合對帳單', post_passbook: '郵局存簿匯出', ctbc_stmt: '中信存款對帳單', ctbc_cc_bill: '中信卡繳款通知', ctbc_loan_est: '中信房貸（推算）',
  post_stmt: '郵局對帳單', misc: '其他信件', sinopac_cc_gap: '永豐卡缺帳單推算', sinopac_daily: '永豐每日消費彙整', sec_cash: '證券分戶帳', travel: '訂位信',
  mcd_order: '麥當勞訂單', ctbc_loan: '中信房貸', petpark: '寵物公園', spotify: 'Spotify 收據', eztravel: '易遊網', momo_invoice: 'momo 發票',
  google_payments: 'Google 收據', sinopac_payment: '永豐繳款通知', einvoice_misc: '電子發票通知', post_transfer: '郵局轉帳通知', eximbay: 'Eximbay',
  einvoice_platform: '財政部載具發票', cht_bill: '中華電信帳單', einvoice_prize: '發票中獎', sinopac_auth: '永豐刷卡通知', insurance: '保險', cht_invoice: '中華電信發票',
  apple_store: 'Apple Store', manual: '手動輸入',
};
export const srcLabel = (s) => SRC[s] || s;

export function txById(id) { return (S.data?.tx || []).find((t) => t.id === id); }

/* Effective category / flags after not-yet-applied app actions. */
export function txView(t, pv) {
  const c = pv.cls[t.id], f = pv.flag[t.id] || {};
  const flags = new Set(t.f || []);
  if ('big' in f) f.big ? flags.add('big') : flags.delete('big');
  if ('reimb' in f) f.reimb ? flags.add('reimb') : flags.delete('reimb');
  if (c) flags.delete('uncl');
  return { c1: c ? c.cat1 : t.c1, c2: c ? c.cat2 : t.c2, flags, pending: !!(c || pv.flag[t.id]), note: 'note' in f ? f.note : t.an };
}

export function txRow(t, pv, onOpen) {
  const v = txView(t, pv);
  const tags = [];
  if (DIRL[t.dir] && t.dir !== 'e') tags.push(el('span', { class: 'tag' + (t.dir === 'i' ? ' blue' : '') }, DIRL[t.dir]));
  if (v.flags.has('big')) tags.push(el('span', { class: 'tag warn' }, '大筆'));
  if (v.flags.has('uncl')) tags.push(el('span', { class: 'tag red' }, '未分類'));
  if (v.flags.has('est')) tags.push(el('span', { class: 'tag' }, '推算'));
  if (v.flags.has('reimb')) tags.push(el('span', { class: 'tag blue' }, '可報帳'));
  if (v.flags.has('share')) tags.push(el('span', { class: 'tag' }, '分攤'));
  const sub = [v.c1 && v.c2 ? `${v.c1}／${v.c2}` : (v.c1 || v.c2), t.ac].filter(Boolean).join('　');
  const neg = t.dir === 'r' || t.dir === 'ti' || t.dir === 'i';
  return row({
    title: [t.m, tags, v.pending ? clockMark() : null], sub: t.i ? `${sub}　${t.i}` : sub,
    value: v.flags.has('na') ? el('span', { class: 'muted sm' }, t.fx || '外幣') : el('span', { class: 'amt' + (t.dir === 'i' || t.dir === 'r' ? ' pos' : '') }, (neg && t.dir === 'r' ? '−' : '') + fmt(t.a)),
    onClick: () => onOpen(t),
  });
}

/* ------------------------------------------------------------------ transaction sheet */
export function openTx(t, rerender) {
  const sh = openSheet({ title: '交易明細', body: () => body() });
  function body() {
    const pv = pendingView(), v = txView(t, pv);
    const kv = el('dl', { class: 'kv card' },
      el('dt', {}, '日期'), el('dd', {}, `${t.d.replace(/-/g, '/')}（${wd(t.d)}）`),
      el('dt', {}, '金額'), el('dd', {}, amt(t.a), t.fx ? el('span', { class: 'muted sm' }, `（${t.fx}）`) : null),
      el('dt', {}, '類型'), el('dd', {}, DIRL[t.dir] || t.dir),
      el('dt', {}, '分類'), el('dd', {}, `${v.c1}／${v.c2}`, v.pending ? clockMark() : null),
      t.ac ? [el('dt', {}, '帳戶'), el('dd', {}, t.ac)] : null,
      el('dt', {}, '來源'), el('dd', {}, srcLabel(t.s) + (t.lv ? `（${t.lv}）` : '')),
      t.mr ? [el('dt', {}, '原始商家'), el('dd', { class: 'selectable' }, t.mr)] : null,
      t.i ? [el('dt', {}, '品項'), el('dd', { class: 'selectable' }, t.i)] : null,
      t.n ? [el('dt', {}, '備註'), el('dd', { class: 'selectable' }, t.n)] : null,
      v.note ? [el('dt', {}, '我的備註'), el('dd', {}, v.note)] : null);
    const isSpend = t.dir === 'e' || t.dir === 'r';
    const sw = (label, on, key) => el('li', {}, el('label', { class: 'field' }, el('span', {}, label),
      el('span', { class: 'switch' }, el('input', { type: 'checkbox', checked: on ? true : null, onchange: (e) => {
        queueCmd({ flag: { txn_id: t.id, [key]: e.target.checked } }, e.target.checked ? `已標為${label}` : `已取消${label}`); rerender && rerender();
      } }), el('i'))));
    const note = el('input', { type: 'text', placeholder: '例：幫同事代墊', value: v.note || '', maxlength: '60' });
    return [
      group(null, [el('p', { class: 'para', style: { fontSize: '1.3rem', fontWeight: '600', paddingBottom: '2px' } }, t.m), kv]),
      isSpend ? group('整理', el('ul', { class: 'list' },
        row({ title: '改分類', sub: '例如把「其他」改成正確的類別', onClick: () => openClassify(t, () => { sh.set(body()); rerender && rerender(); }), chevron: true }),
        sw('大筆', v.flags.has('big'), 'big'), sw('可報帳', v.flags.has('reimb'), 'reimb'),
        el('li', {}, el('div', { class: 'field' }, el('label', {}, '備註'), note,
          el('button', { class: 'pill gray', onclick: () => { queueCmd({ flag: { txn_id: t.id, note: note.value.trim() } }, '備註已送出'); sh.set(body()); } }, '存'))),
      ), { foot: '改動會先顯示在這支手機上（時鐘符號），明早每日更新後正式生效。大筆不算進日常支出上限。' }) : null,
    ];
  }
  return sh;
}

export function openClassify(t, after) {
  const pv = pendingView(), v = txView(t, pv);
  let c1 = CAT1.includes(v.c1) ? v.c1 : null, c2 = v.c2 && v.c2 !== '未分類' ? v.c2 : '';
  const freq = {};
  for (const x of S.data?.tx || []) if (x.c1 && x.c2) (freq[x.c1] = freq[x.c1] || {})[x.c2] = (freq[x.c1][x.c2] || 0) + 1;
  const input = el('input', { type: 'text', placeholder: '細項，例：外食', maxlength: '20', value: c2 });
  const rule = el('input', { type: 'checkbox', checked: true });
  const cat2box = el('div', { class: 'cat-grid' });
  const draw2 = () => {
    const opts = Object.entries(freq[c1] || {}).sort((a, b) => b[1] - a[1]).slice(0, 12).map((x) => x[0]).filter((x) => x !== '未分類');
    cat2box.replaceChildren(...opts.map((o) => el('button', { 'aria-pressed': String(o === input.value), onclick: () => { input.value = o; draw2(); } }, o)));
  };
  const grid = el('div', { class: 'cat-grid' });
  const draw1 = () => grid.replaceChildren(...CAT1.map((c) => el('button', { 'aria-pressed': String(c === c1), onclick: () => { c1 = c; draw1(); draw2(); } }, c)));
  draw1(); draw2();
  const sh = openSheet({
    title: '改分類', left: '取消', right: '儲存',
    onRight: () => {
      const cat2 = input.value.trim();
      if (!c1 || !cat2) { toast('請選類別並填細項'); return; }
      queueCmd({ classify: { txn_id: t.id, cat1: c1, cat2, rule: rule.checked } }, `已改成 ${c1}／${cat2}`);
      sh.close(); after && after();
    },
    body: [
      el('p', { class: 'muted sm', style: { margin: '4px 4px 0' } }, `${t.m}　${fmt(t.a)}　${md(t.d)}`),
      group('類別', el('div', { class: 'card' }, grid)),
      group('細項', el('div', { class: 'card' }, el('div', { class: 'field' }, input), cat2box)),
      group(null, el('ul', { class: 'list' }, el('li', {}, el('label', { class: 'field' }, el('span', {}, '這個商家以後都這樣分'), el('span', { class: 'switch' }, rule, el('i')))))),
    ],
  });
}

/* ------------------------------------------------------------------ to-dos */
export function todoActions(t, rerender) {
  const out = [];
  for (const a of t.actions || []) {
    if (a.op === 'done') out.push(el('button', { class: 'pill', onclick: (e) => { e.stopPropagation(); queueCmd({ done: { todo_id: t.id } }, a.label === '已轉' ? '已記下「已轉」' : '已結案'); rerender(); } }, a.label));
    else if (a.op === 'classify') out.push(el('button', { class: 'pill', onclick: (e) => { e.stopPropagation(); const x = txById(t.txn_id); if (x) openClassify(x, rerender); } }, a.label));
    else if (a.op === 'answer') out.push(el('button', { class: 'pill', onclick: (e) => { e.stopPropagation(); openAnswer(t, rerender); } }, a.label));
  }
  return out.slice(0, 1);
}
export function todoRow(t, rerender) {
  const due = t.due ? daysUntil(t.due) : null;
  const sub = t.kind === 'fund' && due != null ? (due < 0 ? '已過最晚補錢日' : due === 0 ? '今天是最晚補錢日' : `還有 ${due} 天`) + (t.short != null && t.short > 0 ? `　帳戶可能差 ${fmt(t.short)}` : '')
    : t.kind === 'question' ? '回答後數字會更準' : (t.body || '').split('。')[0];
  return el('li', {}, el('div', { class: 'row tap', role: 'button', tabindex: '0', onclick: () => openTodo(t, rerender) },
    badgeIcon(t.kind, t.level), el('span', { class: 'main' }, el('span', { class: 't wrap' }, t.title), el('span', { class: 's wrap' }, sub)),
    ...todoActions(t, rerender)));
}
export function visibleTodos() {
  const pv = pendingView();
  return (S.data?.todo || []).filter((t) => !pv.todo.has(t.id));
}
export function openTodo(t, rerender) {
  const tx = t.txn_id ? txById(t.txn_id) : null;
  const sh = openSheet({ title: { fund: '要補的錢', system: '系統', anomaly: '異常', classify: '未分類', question: '待確認' }[t.kind] || '待處理', body: [
    group(null, el('div', { class: 'card' }, el('p', { class: 'para', style: { fontWeight: '600', fontSize: '1.08rem' } }, t.title), el('p', { class: 'para selectable' }, t.body),
      t.amount ? el('p', { class: 'para muted' }, '金額 ', amt(t.amount), t.due ? `　最晚 ${md(t.due)}（${wd(t.due)}）` : '') : null)),
    tx ? group('相關交易', el('ul', { class: 'list' }, txRow(tx, pendingView(), (x) => openTx(x, rerender)))) : null,
    group(null, [
      ...(t.actions || []).map((a) => {
        if (a.op === 'done') return el('button', { class: 'btn', onclick: () => { queueCmd({ done: { todo_id: t.id } }, '已記下'); sh.close(); rerender(); } }, a.label);
        if (a.op === 'snooze') return el('button', { class: 'btn gray', onclick: () => { const d = new Date(Date.now() + (a.days || 1) * 864e5); queueCmd({ snooze: { todo_id: t.id, until: d.toISOString().slice(0, 10) } }, `已延後 ${a.days || 1} 天`); sh.close(); rerender(); } }, a.label);
        if (a.op === 'classify' && tx) return el('button', { class: 'btn', onclick: () => { sh.close(); openClassify(tx, rerender); } }, '分類');
        if (a.op === 'answer') return el('button', { class: 'btn', onclick: () => { sh.close(); openAnswer(t, rerender); } }, '回答');
        if (a.op === 'tx' && tx) return null;
        return null;
      }),
      t.kind === 'fund' ? el('p', { class: 'group-foot' }, '最晚補錢日＝扣款日前一個營業日（只避開週末，國定假日請自己留意）。看到對應的轉帳入帳後會自動結案。') : null,
    ]),
  ] });
}
export function openAnswer(t, rerender) {
  const ta = el('textarea', { placeholder: '直接用自己的話回答，例如「是，兩筆都退了」', maxlength: '500', rows: '5' });
  const sh = openSheet({
    title: '回答', left: '取消', right: '送出',
    onRight: () => {
      const text = ta.value.trim();
      if (!text) { toast('請先寫下回答'); return; }
      queueCmd({ answer: { key: t.key, text } }, '回答已送出');
      sh.close(); rerender();
    },
    body: [group(null, el('div', { class: 'card' }, el('p', { class: 'para selectable' }, t.body))),
      group('你的回答', el('div', { class: 'card' }, el('div', { class: 'field' }, ta)), { foot: '回答會存進帳本的「已解決」清單，下一次整理帳本時照你的說明修正分類。' })],
  });
  setTimeout(() => ta.focus(), 350);
}
export function openTodoList(rerender) {
  const sh = openSheet({ title: '待處理', body: () => draw() });
  function draw() {
    const list = visibleTodos();
    return [group(null, list.length ? el('ul', { class: 'list indent' }, list.map((t) => todoRow(t, () => { rerender(); sh.set(draw()); })))
      : el('div', { class: 'card empty' }, '沒有待處理的事'))];
  }
}
export { ymLong, short };

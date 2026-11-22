/* 顧問設定 (F3): house values, First Bank loan, candidate list, spectrum cut points, reserve months, AI switch.   PFM-ADVISOR-SPEC §4, §6 row 8.
   Reference calculator only — 參考試算，非投資建議.  Everything is rendered with el()/textContent; money goes through amt() (the numbers a
   person types into an input box are the only exception); classes + rem + CSS variables only.

   What this module does when loaded: it plugs openHouse / openSettings into advisor.js (setAdvisorHooks), so the house rows, the
   「填寫」 button, the 「到顧問設定開啟」 link and the last row of the 顧問 page become live.  settings.js calls openAdvisorSettings() too.

   Commands queued (all validated again by tools/pfm_inbox.py; the form refuses the same bad values first):
     nw_set  {k:'h1'|'h2', value, as_of, label?}      value 0 clears (and still carries as_of)
     nw_set  {k:'fcb', mode:'balance', balance, as_of} | {k:'fcb', mode:'calc', rate_pct, months_left, payment, as_of} | {k:'fcb', mode:'clear'}
     wl_set  {ids:[…]}                                 the whole ticked list, sorted, at most 40
     set     {k:'adv_fcb_on'|'adv_ai_on', v:bool} | {k:'adv_reserve_months', v:1..12} | {k:'adv_cuts', v:[c0,c1,c2,c3]}
   Not-yet-applied values come from data.js pendingView(): .nw {h1,h2,fcb}, .wl [ids]|null, .adv {fcb_on, ai_on, reserve_months, cuts}.
   "current" below = what the last snapshot says; "effective" = pending value if there is one, else current. */
import { el, icon, IC, group, row, amt, md, todayIso, daysUntil, clockMark } from './util.js';
import { openSheet } from './sheet.js';
import { S, queueCmd, pendingView, onChange } from './data.js';
import { setAdvisorHooks, CLS, loadPublic, publicData, emptyCard, warnRow } from './advisor.js';

const DEFAULT_CUTS = [0, 7, 12, 20];
const CUT_MIN = -20, CUT_MAX = 60, CUT_STEP = 0.5;
const BANDS = ['不好', '普通', '尚可', '不錯', '佳'];
const WL_MAX = 40;
const WL_ID = /^(TW|US):[A-Z0-9.]{1,10}$/;
const HOUSE_NAME = { h1: '房屋 1', h2: '房屋 2' };
const SECTIONS = ['house', 'fcb', 'wl', 'cuts', 'reserve', 'ai'];

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const adv = () => (S.data && S.data.advisor && typeof S.data.advisor === 'object' ? S.data.advisor : null);
const advState = () => (adv() && adv().state) || {};
const prefsOf = () => (S.data && S.data.prefs) || {};
const blurActive = () => { const a = document.activeElement; if (a && a !== document.body && a.blur) a.blur(); };

/* ------------------------------------------------------------ current / pending / effective values */
const snapHouse = (k) => { const h = advState().houses && advState().houses[k]; return h && isNum(h.value) && h.value > 0 ? h : null; };
const pendHouse = (k) => pendingView().nw[k] || null;
const curHouse = (k) => { const p = pendHouse(k); return p ? (p.value > 0 ? p : null) : snapHouse(k); };
const snapFcb = () => { const f = advState().fcb; return f && (f.mode === 'balance' || f.mode === 'calc') ? f : null; };
const pendFcb = () => pendingView().nw.fcb || null;
const curFcb = () => { const p = pendFcb(); return p ? (p.mode === 'clear' ? null : p) : snapFcb(); };

const okCuts = (c) => Array.isArray(c) && c.length === 4 && c.every(isNum);
const snapCuts = () => (okCuts(adv() && adv().cuts) ? adv().cuts.slice() : okCuts(prefsOf().adv_cuts) ? prefsOf().adv_cuts.slice() : DEFAULT_CUTS.slice());
const effCuts = () => { const v = pendingView().adv.cuts; return okCuts(v) ? v.slice() : snapCuts(); };
const snapReserve = () => {
  const r = adv() && adv().reserve;
  return r && isNum(r.months_target) ? r.months_target : isNum(prefsOf().adv_reserve_months) ? prefsOf().adv_reserve_months : 3;
};
const effReserve = () => { const v = pendingView().adv.reserve_months; return isNum(v) ? v : snapReserve(); };
const snapFcbOn = () => { const n = adv() && adv().nw; return n && typeof n.fcb_on === 'boolean' ? n.fcb_on : prefsOf().adv_fcb_on === true; };
const effFcbOn = () => { const v = pendingView().adv.fcb_on; return typeof v === 'boolean' ? v : snapFcbOn(); };
const snapAiOn = () => { const a = adv() && adv().ai; return a && typeof a.on === 'boolean' ? a.on : prefsOf().adv_ai_on === true; };
const effAiOn = () => { const v = pendingView().adv.ai_on; return typeof v === 'boolean' ? v : snapAiOn(); };
const snapWl = () => (adv() && Array.isArray(adv().wl) ? adv().wl.filter((x) => typeof x === 'string') : []);
/* ids that are really in whitelist.json (the app ignores the others); null while the file is not loaded / unreadable */
function knownIds() {
  const w = publicData('whitelist');
  return w && Array.isArray(w.items) ? new Set(w.items.filter((x) => x && typeof x.id === 'string' && WL_ID.test(x.id)).map((x) => x.id)) : null;
}
const shownWl = (ids) => { const k = knownIds(); return (k ? ids.filter((id) => k.has(id)) : ids.slice()).sort(); };
/* exported for the calculator: the ticked candidate ids as they will be once the morning update has run */
export function effectiveWl() {
  const p = pendingView().wl;
  return (Array.isArray(p) ? p : snapWl()).slice();
}

/* ------------------------------------------------------------ input checks (the same limits as tools/pfm_inbox.py validate) */
const bad = (field, msg) => ({ error: msg, field });
function parseInt0(s) {
  const t = String(s == null ? '' : s).normalize('NFKC').replace(/[,\s]/g, '');
  if (t === '') return { empty: true };
  return /^\d{1,12}$/.test(t) ? { n: Number(t) } : { notInt: true };
}
function checkDay(s, name) {
  const t = String(s || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (!m) return { error: `請選擇${name}` };
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return { error: `${name}不是有效的日期` };
  const n = daysUntil(t);
  if (n > 0) return { error: `${name}不能晚於今天` };
  if (n < -3640) return { error: `${name}太久以前了，請填 10 年內的日期` };
  return { day: t };
}
function cleanLabel(s) {
  const t = String(s == null ? '' : s).normalize('NFKC').replace(/[\u0000-\u001f\u007f<>]/g, '').trim();
  return [...t].length > 12 ? { error: '名稱最多 12 個字' } : { text: t };
}
function checkHouse(vs, ds, ls) {
  const v = parseInt0(vs);
  if (v.empty) return bad('value', '請填入市值（元）');
  if (v.notInt) return bad('value', '市值請填整數（元），不要有小數、單位或文字');
  if (v.n < 100000 || v.n > 2000000000) return bad('value', '市值需介於 10 萬到 20 億元之間；要清除請按「清除這間房屋」');
  const d = checkDay(ds, '估值日期');
  if (d.error) return bad('date', d.error);
  const l = cleanLabel(ls);
  if (l.error) return bad('label', l.error);
  return { value: v.n, as_of: d.day, label: l.text };
}
function checkFcb(f) {
  const d = checkDay(f.date, '資料日期');
  if (f.mode === 'balance') {
    const b = parseInt0(f.balance);
    if (b.empty) return bad('balance', '請填入貸款餘額（元）');
    if (b.notInt) return bad('balance', '餘額請填整數（元），不要有小數、單位或文字');
    if (b.n > 200000000) return bad('balance', '餘額需介於 0 到 2 億元之間');
    if (d.error) return bad('date', d.error);
    return { cmd: { k: 'fcb', mode: 'balance', balance: b.n, as_of: d.day } };
  }
  const rs = String(f.rate == null ? '' : f.rate).normalize('NFKC').replace(/\s/g, '');
  if (rs === '') return bad('rate', '請填入年利率（%）');
  if (!/^\d{1,2}(\.\d{1,6})?$/.test(rs)) return bad('rate', '年利率請填數字，例如 2.15');
  const rate = Math.round(Number(rs) * 100) / 100;
  if (rate < 0.1 || rate > 15) return bad('rate', '年利率需介於 0.1% 到 15% 之間');
  const n = parseInt0(f.months);
  if (n.empty) return bad('months', '請填入剩餘期數（月）');
  if (n.notInt) return bad('months', '剩餘期數請填整數（月）');
  if (n.n < 1 || n.n > 480) return bad('months', '剩餘期數需介於 1 到 480 個月之間');
  const p = parseInt0(f.payment);
  if (p.empty) return bad('payment', '請填入每月月付金額（元）');
  if (p.notInt) return bad('payment', '月付金額請填整數（元），不要有小數、單位或文字');
  if (p.n < 1000 || p.n > 1000000) return bad('payment', '月付金額需介於 1000 元到 100 萬元之間');
  if (d.error) return bad('date', d.error);
  return { cmd: { k: 'fcb', mode: 'calc', rate_pct: rate, months_left: n.n, payment: p.n, as_of: d.day } };
}
const fmtCut = (v) => `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}%`;
function cutsError(c) {
  if (!okCuts(c) || c.some((v) => v < CUT_MIN || v > CUT_MAX || Math.round(v * 2) !== v * 2)) return '切點要介於 −20% 到 60%，每次調 0.5%';
  for (let i = 0; i < 3; i++) {
    if (c[i] >= c[i + 1]) return `「${BANDS[i]}」與「${BANDS[i + 1]}」的分界（${fmtCut(c[i])}）必須低於下一個分界（${fmtCut(c[i + 1])}），請調整後再送出`;
  }
  return '';
}
const bandLine = (c) => `${BANDS[0]} 低於 ${fmtCut(c[0])}　${BANDS[1]} ${fmtCut(c[0])}～${fmtCut(c[1])}　${BANDS[2]} ${fmtCut(c[1])}～${fmtCut(c[2])}　${BANDS[3]} ${fmtCut(c[2])}～${fmtCut(c[3])}　${BANDS[4]} ${fmtCut(c[3])} 以上`;
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/* ------------------------------------------------------------ small form parts */
function textInput(o) {
  return el('input', { class: 'advs-in' + (o.money ? ' amt advs-money' : ''), type: 'text', inputmode: o.mode || 'numeric', autocomplete: 'off', autocapitalize: 'off',
    spellcheck: 'false', enterkeyhint: o.enter || 'done', placeholder: o.placeholder || '', maxlength: o.maxlength || null, value: o.value == null ? '' : String(o.value),
    'aria-label': o.label, name: o.name || null, oninput: o.oninput || null });
}
function dayBounds() {
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { min: iso(new Date(Date.now() - 3640 * 864e5)), max: todayIso() };
}
function dateInput(value, label, oninput) {
  const b = dayBounds();
  return el('input', { class: 'advs-in', type: 'date', min: b.min, max: b.max, value: value || todayIso(), 'aria-label': label, oninput: oninput || null });
}
const fieldOf = (label, input, hint) => el('label', { class: 'advs-f' }, el('span', { class: 'advs-l' }, label), input, hint ? el('span', { class: 'advs-h' }, hint) : null);
const errBox = () => el('p', { class: 'advs-err', role: 'alert' });
function showError(box, inputs, r) {
  box.textContent = r.error;
  for (const i of Object.values(inputs)) i.removeAttribute('aria-invalid');
  const t = inputs[r.field];
  if (t) { t.setAttribute('aria-invalid', 'true'); t.focus(); }
}
function clearError(box, inputs) {
  box.textContent = '';
  for (const i of Object.values(inputs)) i.removeAttribute('aria-invalid');
}
function stepper(label, onStep) {
  const val = el('span', { class: 'advs-sv', 'aria-live': 'polite' });
  const dec = el('button', { type: 'button', 'aria-label': `${label}減少`, onclick: () => onStep(-1) }, '−');
  const inc = el('button', { type: 'button', 'aria-label': `${label}增加`, onclick: () => onStep(1) }, '＋');
  return { val, dec, inc, node: el('div', { class: 'stepper' }, dec, val, inc) };
}
function switchRow(label, checked, onchange, sub) {
  return el('li', {}, el('label', { class: 'field advs-sw' }, el('span', { class: 'advs-swl' }, label, sub ? el('span', { class: 'advs-h' }, sub) : null),
    el('span', { class: 'switch' }, el('input', { type: 'checkbox', checked: checked ? true : null, onchange: (e) => onchange(e.target.checked) }), el('i'))));
}
const pendMark = (text) => el('span', { class: 'adv-pendn' }, clockMark(), text || '待生效');
const withSec = (id, node) => { node.setAttribute('data-sec', id); node.classList.add('advs-g'); return node; };
const sendSet = (k, v, msg) => { blurActive(); queueCmd({ set: { k, v } }, msg); };

/* On a phone the soft keyboard covers the lower half: while a field has focus the body gets extra room to scroll,
   and the focused field is moved up so the save button stays reachable.  (Return on the keyboard also submits the form.) */
function keyboardAssist(body) {
  let t = 0;
  const inField = () => document.activeElement instanceof HTMLInputElement && document.activeElement.type !== 'checkbox' && body.contains(document.activeElement);
  body.addEventListener('focusin', (e) => {
    const n = e.target;
    if (!(n instanceof HTMLInputElement) || n.type === 'checkbox') return;
    body.classList.add('advs-kb');
    clearTimeout(t);
    t = setTimeout(() => {
      const top = n.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - body.clientHeight * 0.22;
      body.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }, 320);
  });
  body.addEventListener('focusout', () => { clearTimeout(t); setTimeout(() => { if (!inField()) body.classList.remove('advs-kb'); }, 120); });
}
function emptySheet(title, text) {
  openSheet({ title, body: [group(null, emptyCard(text))] });
}

/* ------------------------------------------------------------ 房屋市值 form (one house)  ·  HOOKS.openHouse */
export function openHouseSheet(k) {
  if (k !== 'h1' && k !== 'h2') return;
  if (!adv()) { emptySheet('房屋市值', '資料更新後就會出現'); return; }
  const cur = curHouse(k), p = pendHouse(k);
  const name = (cur && cur.label) || (snapHouse(k) && snapHouse(k).label) || HOUSE_NAME[k];
  const err = errBox();
  const inputs = {
    value: textInput({ label: '市值（元）', value: cur ? cur.value : '', placeholder: '填入整數（元）', money: true, name: 'value', oninput: () => clearError(err, inputs) }),
    date: dateInput(cur && cur.as_of ? String(cur.as_of).slice(0, 10) : todayIso(), '估值日期', () => clearError(err, inputs)),
    label: textInput({ label: '名稱', mode: 'text', value: cur ? cur.label || '' : '', placeholder: '可不填，最多 12 字', maxlength: 12, name: 'label', oninput: () => clearError(err, inputs) }),
  };
  let sh;
  const submit = (e) => {
    e.preventDefault();
    const r = checkHouse(inputs.value.value, inputs.date.value, inputs.label.value);
    if (r.error) { showError(err, inputs, r); return; }
    blurActive();
    const cmd = { nw_set: { k, value: r.value, as_of: r.as_of } };
    if (r.label) cmd.nw_set.label = r.label;
    queueCmd(cmd, `${name}市值已更新`);
    sh.close();
  };
  const clear = () => {
    blurActive();
    queueCmd({ nw_set: { k, value: 0, as_of: todayIso() } }, `${name}市值已清除`);
    sh.close();
  };
  sh = openSheet({ title: '房屋市值', body: () => [
    group(name, [
      cur ? el('div', { class: 'card pad advs-cur' }, el('div', { class: 'advs-l' }, p ? '待生效的市值' : '目前市值'),
        el('div', { class: 'advs-curv' }, el('span', { class: 'cur' }, 'NT$'), amt(cur.value), p ? clockMark() : null),
        el('div', { class: 'advs-h' }, cur.as_of ? `估值日 ${md(String(cur.as_of).slice(0, 10))}` : '')) : null,
      el('form', { class: 'card advs-form', novalidate: true, onsubmit: submit },
        fieldOf('市值（元）', inputs.value, '範圍 10 萬到 20 億元，填整數'),
        fieldOf('估值日期', inputs.date), fieldOf('名稱（可不填）', inputs.label, '例如「自住」，最多 12 字'),
        err, el('button', { class: 'btn', type: 'submit' }, cur ? '更新市值' : '儲存市值')),
      cur ? el('button', { class: 'btn danger', type: 'button', onclick: clear }, '清除這間房屋') : null,
    ], { foot: '市值是你自己填的估計值；明早更新後才會算進淨資產。' }),
  ] });
  keyboardAssist(sh.body);
}

/* ------------------------------------------------------------ the panel */
let PANEL = null;        // { api, dirty } while 顧問設定 is open
let D = null;            // draft values of the open panel: kept across redraws, reset from the effective values after a send

function fcbDraft() {
  const f = curFcb();
  const d = { mode: 'balance', balance: '', rate: '', months: '', payment: '', date: todayIso() };
  if (f) {
    d.mode = f.mode === 'calc' ? 'calc' : 'balance';
    if (f.as_of) d.date = String(f.as_of).slice(0, 10);
    if (f.mode === 'balance' && isNum(f.balance)) d.balance = String(f.balance);
    if (f.mode === 'calc') { d.rate = String(f.rate_pct); d.months = String(f.months_left); d.payment = String(f.payment); }
  }
  return d;
}
const newDraft = () => ({ cuts: effCuts(), reserve: effReserve(), wl: new Set(effectiveWl()), fcb: fcbDraft() });
/* after a First Bank send: refill the form from the new effective values (same object: the open form's handlers keep pointing at it) */
const resetFcbDraft = () => { Object.assign(D.fcb, fcbDraft()); redraw(); };

function houseRow(k) {
  const p = pendHouse(k), cur = curHouse(k), snap = snapHouse(k);
  const name = (cur && cur.label) || (snap && snap.label) || HOUSE_NAME[k];
  return row({ title: name, sub: cur ? `估值日 ${md(String(cur.as_of || '').slice(0, 10))}` : '還沒填',
    value: cur ? amt(cur.value) : el('span', { class: 'muted' }, p ? '已清除' : '未填'),
    extra: p ? pendMark(p.value > 0 ? '待生效' : '清除待生效') : null, chevron: true, onClick: () => openHouseSheet(k) });
}
function sectionHouse() {
  const pend = !!(pendHouse('h1') || pendHouse('h2'));
  return withSec('house', group('房屋市值', el('ul', { class: 'list' }, houseRow('h1'), houseRow('h2')),
    { small: pend ? pendMark() : null, foot: '點一間房屋，填市值、估值日期（名稱可不填）。市值是你自己填的估計值。' }));
}

/* 一銀房貸 */
function fcbSummary(f) {
  if (!f) return null;
  return f.mode === 'balance' ? ['餘額 ', amt(f.balance)] : [`利率 ${f.rate_pct}%・剩 ${f.months_left} 期・月付 `, amt(f.payment)];
}
function sectionFcb() {
  const on = effFcbOn(), pOn = pendingView().adv.fcb_on !== undefined, pFcb = pendFcb();
  const items = [el('ul', { class: 'list' }, switchRow('納入一銀房貸', on,
    (v) => sendSet('adv_fcb_on', v, v ? '已開啟一銀房貸' : '已關閉一銀房貸'), on ? '填好下方資料後，淨資產才會算進這筆貸款' : null))];
  if (on) {
    const d = D.fcb, cur = curFcb();
    const err = errBox();
    const inputs = {};
    const touch = (key) => (e) => { d[key] = e.target.value; clearError(err, inputs); };
    inputs.balance = textInput({ label: '貸款餘額（元）', value: d.balance, placeholder: '填入整數（元）', money: true, name: 'balance', oninput: touch('balance') });
    inputs.rate = textInput({ label: '年利率（%）', mode: 'decimal', value: d.rate, placeholder: '例如 2.15', name: 'rate', enter: 'next', oninput: touch('rate') });
    inputs.months = textInput({ label: '剩餘期數（月）', value: d.months, placeholder: '填入整數', name: 'months', enter: 'next', oninput: touch('months') });
    inputs.payment = textInput({ label: '每月月付金額（元）', value: d.payment, placeholder: '填入整數（元）', money: true, name: 'payment', oninput: touch('payment') });
    inputs.date = dateInput(d.date, '資料日期', touch('date'));
    const modeSeg = el('div', { class: 'seg advs-seg', role: 'group', 'aria-label': '填寫方式' }, [['balance', '填餘額'], ['calc', '利率＋期數＋月付']].map(([v, n]) =>
      el('button', { type: 'button', 'aria-pressed': String(d.mode === v), onclick: () => { d.mode = v; redraw(); } }, n)));
    const fields = d.mode === 'balance'
      ? [fieldOf('貸款餘額（元）', inputs.balance, '網銀或繳款單上的本金餘額；範圍 0 到 2 億元'), fieldOf('資料日期', inputs.date)]
      : [fieldOf('年利率（%）', inputs.rate, '0.1 到 15，取到小數 2 位'), fieldOf('剩餘期數（月）', inputs.months, '還要繳幾期，1 到 480'),
        fieldOf('每月月付金額（元）', inputs.payment, '每月實際繳的本息合計，1000 元到 100 萬元'), fieldOf('資料日期', inputs.date)];
    const submit = (e) => {
      e.preventDefault();
      const r = checkFcb(d);
      if (r.error) { showError(err, inputs, r); return; }
      blurActive();
      queueCmd({ nw_set: r.cmd }, '一銀房貸資料已更新');
      resetFcbDraft();
    };
    const clear = () => { blurActive(); queueCmd({ nw_set: { k: 'fcb', mode: 'clear' } }, '一銀房貸資料已清除'); resetFcbDraft(); };
    items.push(
      cur ? el('div', { class: 'card pad advs-cur' }, el('div', { class: 'advs-l' }, pFcb ? '待生效的一銀房貸資料' : '目前一銀房貸資料'),
        el('div', { class: 'advs-curv sm' }, fcbSummary(cur), pFcb ? clockMark() : null),
        el('div', { class: 'advs-h' }, cur.as_of ? `資料日 ${md(String(cur.as_of).slice(0, 10))}` : '')) : null,
      el('form', { class: 'card advs-form', novalidate: true, onsubmit: submit },
        el('span', { class: 'advs-l' }, '填寫方式'), modeSeg, el('div', { class: 'advs-gap' }), fields, err,
        el('button', { class: 'btn', type: 'submit' }, '儲存一銀房貸資料')),
      cur ? el('button', { class: 'btn danger', type: 'button', onclick: clear }, '清除一銀房貸資料') : null);
  } else items.push(warnRow('一銀房貸未納入，淨資產可能高估'));
  return withSec('fcb', group('一銀房貸', items, { small: pOn || pFcb ? pendMark() : null,
    foot: on ? '「利率＋期數＋月付」模式由系統推算目前餘額，會標示「推算」。' : null }));
}

/* 候選名單 */
function sectionWl() {
  const wl = publicData('whitelist');
  if (wl === undefined) { loadPublic('whitelist').then(() => redraw()); return withSec('wl', group('候選名單', emptyCard('讀取名單中…'))); }
  const list = wl && Array.isArray(wl.items) ? wl.items.filter((x) => x && typeof x.id === 'string' && WL_ID.test(x.id)) : [];
  if (!list.length) return withSec('wl', group('候選名單', emptyCard('名單讀不到')));
  const known = new Set(list.map((x) => x.id));
  const eff = effectiveWl().filter((id) => known.has(id)).sort();
  const count = el('span', { class: 'advs-wc' });
  const err = errBox();
  const send = el('button', { class: 'btn', type: 'button' }, '儲存勾選');
  const ids = () => [...D.wl].filter((id) => known.has(id)).sort();
  const refresh = () => {
    const now = ids();
    count.textContent = `已勾選 ${now.length} 檔（最多 ${WL_MAX} 檔）`;
    err.textContent = now.length > WL_MAX ? `最多只能勾 ${WL_MAX} 檔，請取消幾檔再儲存` : '';
    send.textContent = `儲存勾選（${now.length} 檔）`;
    send.disabled = now.length > WL_MAX || sameList(now, eff);
  };
  const classes = CLS.map(([id, label], i) => ({ id, label, i, items: list.filter((x) => x.cls === id) }));
  const rest = list.filter((x) => !CLS.some(([id]) => id === x.cls));
  if (rest.length) classes.push({ id: 'other', label: '其他', i: -1, items: rest });
  const blocks = classes.filter((c) => c.items.length).map((c) => el('div', { class: 'advs-cls' },
    el('div', { class: 'advs-ch' }, c.i >= 0 ? el('span', { class: `adv-sw adv-c${c.i}` }) : null, c.label),
    el('ul', { class: 'list' }, c.items.map((it) => wlItem(it, refresh)))));
  send.addEventListener('click', () => {
    const now = ids();
    if (now.length > WL_MAX) { refresh(); return; }
    blurActive();
    queueCmd({ wl_set: { ids: now } }, `候選名單已更新（${now.length} 檔）`);
    D.wl = new Set(effectiveWl());
  });
  refresh();
  const pend = Array.isArray(pendingView().wl);
  return withSec('wl', group('候選名單', [
    el('p', { class: 'advs-remind' }, '只是候選池，不是推薦'),
    el('div', { class: 'advs-wh' }, count, wl.as_of ? el('span', { class: 'advs-h' }, `名單資料日 ${wl.as_of}`) : null),
    blocks, err, send,
  ], { small: pend ? pendMark() : null,
    foot: '勾選的標的會出現在互動計算表的「搭配候選」。費用率、備註來自公開檔，標「待確認」的項目兩個以上來源的數字不一致或查不到。' }));
}
function wlItem(it, refresh) {
  const on = D.wl.has(it.id);
  const rate = isNum(it.er_pct) ? `${Number(it.er_pct.toFixed(3))}%` : '—';
  const note = el('div', { class: 'advs-wn', hidden: true },
    it.dist ? el('p', {}, el('b', {}, '配息　'), String(it.dist)) : null,
    it.settle ? el('p', {}, el('b', {}, '交割　'), String(it.settle)) : null,
    it.dca_ok ? el('p', {}, el('b', {}, '定期定額　'), String(it.dca_ok)) : null,
    it.min_fee_note ? el('p', {}, el('b', {}, '手續費　'), String(it.min_fee_note)) : null,
    it.note ? el('p', {}, el('b', {}, '備註　'), String(it.note)) : null);
  const more = el('button', { type: 'button', class: 'advs-more', 'aria-expanded': 'false', onclick: () => {
    note.hidden = !note.hidden;
    more.setAttribute('aria-expanded', String(!note.hidden));
    more.textContent = note.hidden ? '備註' : '收起備註';
  } }, '備註');
  return el('li', { class: 'advs-wli' },
    el('label', { class: 'advs-wl' },
      el('input', { type: 'checkbox', class: 'sr', checked: on ? true : null, onchange: (e) => { if (e.target.checked) D.wl.add(it.id); else D.wl.delete(it.id); refresh(); } }),
      el('span', { class: 'advs-ck', 'aria-hidden': 'true' }, icon(IC.check)),
      el('span', { class: 'advs-wm' },
        el('span', { class: 'advs-wt' }, String(it.name || it.id), it.status === '待確認' ? el('span', { class: 'tag warn' }, '待確認') : null),
        el('span', { class: 'advs-ws' }, `${it.code || it.id.split(':')[1]}・費用率 ${rate}・${it.ccy || '—'}`))),
    more, note);
}

/* spectrum 切點 */
function sectionCuts() {
  const cur = effCuts();
  const vals = [], decs = [], incs = [];
  const err = errBox();
  const prev = el('p', { class: 'advs-prev' });
  const send = el('button', { class: 'btn', type: 'button' }, '送出切點');
  const reset = el('button', { class: 'btn gray', type: 'button' }, '還原預設（0／7／12／20）');
  const refresh = () => {
    D.cuts.forEach((v, i) => { vals[i].textContent = fmtCut(v); decs[i].disabled = v <= CUT_MIN; incs[i].disabled = v >= CUT_MAX; });
    const e = cutsError(D.cuts);
    err.textContent = e;
    prev.textContent = e ? '' : bandLine(D.cuts);
    send.disabled = !!e || sameList(D.cuts, cur);
  };
  const rows = D.cuts.map((v, i) => {
    const label = `「${BANDS[i]}」與「${BANDS[i + 1]}」的分界`;
    const s = stepper(label, (dir) => { D.cuts[i] = Math.min(CUT_MAX, Math.max(CUT_MIN, Math.round((D.cuts[i] + dir * CUT_STEP) * 2) / 2)); refresh(); });
    vals[i] = s.val; decs[i] = s.dec; incs[i] = s.inc;
    return el('div', { class: 'advs-cut' }, el('span', { class: 'advs-cutl' }, label, el('span', { class: 'advs-h' }, i === 0 ? '年化報酬低於此值算「不好」' : `年化報酬達此值就進入「${BANDS[i + 1]}」`)), s.node);
  });
  reset.addEventListener('click', () => { D.cuts = DEFAULT_CUTS.slice(); refresh(); });
  send.addEventListener('click', () => {
    if (cutsError(D.cuts)) { refresh(); return; }
    blurActive();
    queueCmd({ set: { k: 'adv_cuts', v: D.cuts.slice() } }, '切點已更新');
    D.cuts = effCuts();
  });
  refresh();
  return withSec('cuts', group('報酬區間切點', [el('div', { class: 'card' }, rows), prev, err, send, reset],
    { small: pendingView().adv.cuts ? pendMark() : null, foot: '切點決定「年化報酬」落在不好、普通、尚可、不錯、佳的哪一段。要嚴格由小到大，每次調 0.5%，範圍 −20% 到 60%。' }));
}

/* 預備金月數 */
function sectionReserve() {
  const cur = effReserve();
  const send = el('button', { class: 'btn', type: 'button' }, '送出預備金月數');
  const s = stepper('預備金月數', (dir) => { D.reserve = Math.min(12, Math.max(1, D.reserve + dir)); refresh(); });
  const refresh = () => {
    s.val.textContent = `${D.reserve} 個月`;
    s.dec.disabled = D.reserve <= 1; s.inc.disabled = D.reserve >= 12;
    send.disabled = D.reserve === cur;
  };
  send.addEventListener('click', () => {
    if (!Number.isInteger(D.reserve) || D.reserve < 1 || D.reserve > 12) { refresh(); return; }
    blurActive();
    queueCmd({ set: { k: 'adv_reserve_months', v: D.reserve } }, `預備金月數改成 ${D.reserve} 個月`);
    D.reserve = effReserve();
  });
  refresh();
  return withSec('reserve', group('預備金月數', [
    el('div', { class: 'card advs-cut' }, el('span', { class: 'advs-cutl' }, '預備金目標月數', el('span', { class: 'advs-h' }, '預備金目標 ＝ 每月固定支出估計 × 月數')), s.node), send],
  { small: pendingView().adv.reserve_months !== undefined ? pendMark() : null, foot: '可選 1 到 12 個月，預設 3 個月。' }));
}

/* AI 解讀 */
function sectionAi() {
  const on = effAiOn();
  return withSec('ai', group('AI 解讀', [
    el('ul', { class: 'list' }, switchRow('啟用 AI 解讀', on, (v) => sendSet('adv_ai_on', v, v ? 'AI 解讀已開啟' : 'AI 解讀已關閉'), '文字由 AI 撰寫，數字由系統計算')),
    on ? warnRow('需先在 NAS 放好 AI 金鑰，否則顯示『尚未設定金鑰』') : null,
  ], { small: pendingView().adv.ai_on !== undefined ? pendMark() : null, foot: '關閉時顯示規則整理的重點。AI 只解讀系統算好的數字，不提個別標的。' }));
}

/* 目前生效值 */
function sectionSummary() {
  const pv = pendingView(), rows = [];
  const add = (title, curNode, pendNode) => rows.push(el('li', { class: 'advs-sr' }, el('span', { class: 'advs-srt' }, title), el('span', { class: 'advs-srv' }, curNode),
    pendNode ? el('span', { class: 'advs-srp' }, clockMark(), '待生效：', pendNode) : null));
  for (const k of ['h1', 'h2']) {
    const s = snapHouse(k), p = pendHouse(k);
    add((s && s.label) || HOUSE_NAME[k], s ? amt(s.value) : '未填', p ? (p.value > 0 ? amt(p.value) : '清除') : null);
  }
  const sf = snapFcb(), pf = pendFcb(), on = snapFcbOn(), pOn = pv.adv.fcb_on;
  add('一銀房貸', on ? el('span', {}, sf ? fcbSummary(sf) : '已納入，尚未填資料') : '未納入',
    pf || (typeof pOn === 'boolean' && pOn !== on)
      ? el('span', {}, typeof pOn === 'boolean' && pOn !== on ? (pOn ? '納入' : '不納入') : '', pf ? (pf.mode === 'clear' ? '　資料清除' : ['　', fcbSummary(pf)]) : '') : null);
  const sw = shownWl(snapWl()), pw = Array.isArray(pv.wl) ? shownWl(pv.wl) : null;
  add('候選名單', `${sw.length} 檔`, pw && !sameList(pw, sw) ? `${pw.length} 檔` : null);
  const sc = snapCuts(), pc = pv.adv.cuts;
  add('報酬區間切點', sc.map((v) => fmtCut(v)).join('／'), okCuts(pc) && !sameList(pc, sc) ? pc.map((v) => fmtCut(v)).join('／') : null);
  const sr = snapReserve(), pr = pv.adv.reserve_months;
  add('預備金月數', `${sr} 個月`, isNum(pr) && pr !== sr ? `${pr} 個月` : null);
  const sa = snapAiOn(), pa = pv.adv.ai_on;
  add('AI 解讀', sa ? '開' : '關', typeof pa === 'boolean' && pa !== sa ? (pa ? '開' : '關') : null);
  return withSec('summary', group('目前生效值', el('ul', { class: 'list' }, rows),
    { foot: '回寫將於明早更新後生效。送出後，上面各區會先顯示你送出的值，這裡的「待生效」會帶時鐘標記；更新完成後這裡才會變成新值。' }));
}

function buildPanel() {
  if (!adv()) return [group(null, emptyCard('資料更新後就會出現'))];
  if (!D) D = newDraft();
  return [el('p', { class: 'advs-intro' }, '參考試算的設定。送出後會排進回寫佇列，明早更新後生效。'),
    sectionHouse(), sectionFcb(), sectionWl(), sectionCuts(), sectionReserve(), sectionAi(), sectionSummary()];
}
/* what the panel was drawn from: pending values + snapshot time.  The queue also reports "batch delivered" (nothing visible changes then);
   such events must not rebuild the panel under a finger, so onChange redraws only when this signature moved. */
const sig = () => { const v = pendingView(); return JSON.stringify([v.nw, v.wl, v.adv, S.data && S.data.meta && S.data.meta.generated_at]); };
function redraw() {
  if (!PANEL) return;
  PANEL.sig = sig();
  const a = document.activeElement, body = PANEL.api.body;
  if (a instanceof HTMLInputElement && a.type !== 'checkbox' && body.contains(a)) { PANEL.dirty = true; return; }   // never pull the keyboard away mid-typing
  const top = body.scrollTop;
  PANEL.api.set(buildPanel());
  body.scrollTop = top;
}
function scrollToSection(api, sec) {
  if (!SECTIONS.includes(sec)) return;
  const go = () => {
    const t = api.body.querySelector(`[data-sec="${sec}"]`);
    if (t) api.body.scrollTop += t.getBoundingClientRect().top - api.body.getBoundingClientRect().top - 8;
  };
  requestAnimationFrame(() => requestAnimationFrame(go));
  setTimeout(go, 420);
}

export function openAdvisorSettings(section) {
  if (PANEL) { redraw(); scrollToSection(PANEL.api, section); return; }
  if (!adv()) { emptySheet('顧問設定', '資料更新後就會出現'); return; }
  D = newDraft();
  const sh = openSheet({ title: '顧問設定', onClose: () => { PANEL = null; D = null; }, body: (api) => { PANEL = { api, dirty: false, sig: sig() }; return buildPanel(); } });
  keyboardAssist(sh.body);
  sh.body.addEventListener('focusout', () => setTimeout(() => {
    const a = document.activeElement;
    if (PANEL && PANEL.dirty && !(a instanceof HTMLInputElement && a.type !== 'checkbox' && sh.body.contains(a))) { PANEL.dirty = false; redraw(); }
  }, 80));
  scrollToSection(sh, section);
}

/* the panel follows the queue (a send, or the batch being delivered) and fresh data */
onChange((what) => { if ((what === 'queue' || what === 'data') && PANEL && sig() !== PANEL.sig) redraw(); });
setAdvisorHooks({ openHouse: (k) => openHouseSheet(k), openSettings: (section) => openAdvisorSettings(section) });

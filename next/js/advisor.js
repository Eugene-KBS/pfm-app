/* 顧問: net worth, reserve, current allocation, stock return + spectrum, AI reading.   PFM-ADVISOR-SPEC §6, §5.4, §5.6 (app rendering row).
   Reference calculator / reference line / sheet tools only — 參考試算，非投資建議. Data is rendered with textContent / DOM API only.

   ── Work package F1 (this file) ───────────────────────────────────────────────────────────────────────────────────────────────
   Page order (see viewAdvisor): disclaimer → 1 blockNw → 2 blockReserve → 3 blockAlloc → 4 blockPerf → 5 blockCalc → 6 blockFunds
   → 7 blockAi → 8 blockSettings → fixed footer text.   Blocks 5, 6 and 8 are STUBS below (return null): later packages fill them in.
     F2 → blockCalc(ctx)      interactive calculator (§2.9, §6 row 5)     and  blockFunds(ctx)  cash-need what-if (§2.10, §6 row 6)
     F3 → blockSettings(ctx)  the last row of the page that opens 顧問設定 (§6 row 8); also call setAdvisorHooks({openHouse, openSettings})

   ── ctx (what every block function receives; built once per draw by makeCtx) ─────────────────────────────────────────────────
     ctx.app        main.js app object ({tab, render, …}); ctx.rerender() = app.render()
     ctx.d          S.data (the whole decrypted snapshot);  ctx.adv  = S.data.advisor (never null here: viewAdvisor handles null first)
     ctx.metrics    adv.metrics ({ "<id>": {v, f} });  ctx.text(str) = renderText(str, metrics) → Node[] | null (null = hide the whole text)
     ctx.cuts       the 4 spectrum cut points in percent (adv.cuts, falls back to [0,7,12,20] if malformed)
     ctx.pend       pendingView() from data.js (F3 adds .nw there; house rows already show a clock when ctx.pend.nw[k] is set)
     ctx.pub(name)  already-loaded public file ('benchmarks' | 'cma' | 'whitelist') or undefined (not loaded yet) or null (unreadable);
     ctx.load(name) Promise of the same (fetches data/<name>.json once; resolves null when unreadable — never throws, never an error toast)
     ctx.openSheet  sheet.js openSheet(); ctx.group / ctx.row / ctx.amt = util.js helpers (all money MUST go through amt()/samt())
   A block returns a node (usually group(title, content)) or null to leave the block out.

   ── Opening a panel (bottom sheet) ───────────────────────────────────────────────────────────────────────────────────────────
     const api = openSheet({ title, body, right, onRight, left, onClose });   // sheet.js; body = node | node[] | (api) => node[]
     api.set([...nodes]) redraws the body, api.setTitle(t), api.close();  openClassSheet() / openRefSheet() below are working examples.
     Panel content uses group()/row()/'kv card' like the rest of the app.  No inline style strings; classes + rem + CSS variables only.

   ── Exports for later packages: renderText, loadPublic, publicData, setAdvisorHooks, HOOKS, P1, CLS, cap, warnRow, emptyCard ───
   HOOKS.openHouse(k, ctx)        k = 'h1' | 'h2' → opens the house-value form (F3).  Until it is set, house rows are plain (no tap).
   HOOKS.openSettings(section, ctx)  section = 'ai' | undefined → opens 顧問設定 (F3).  Until it is set, the "到顧問設定開啟" hint is plain text.

   ── Units (easy to get wrong) ────────────────────────────────────────────────────────────────────────────────────────────────
   Inside the advisor block cum / xirr / alloc w / bench cum / est_share are DECIMALS (-0.0917).  adv.metrics[...].v with f:"pct" is
   already a PERCENT NUMBER (-9.17).  Spectrum cuts and benchmark value_pct are percent numbers.
*/
import { el, sv, icon, IC, group, row, amt, pct as pctS, md, daysUntil, clockMark } from './util.js';
import { openSheet } from './sheet.js';
import { S, queueCmd, pendingView } from './data.js';

export const CLS = [['cash', '現金／定存'], ['bond_s', '短期美債'], ['bond_l', '中長期債'], ['tw_eq', '台股大盤'], ['us_eq', '美股大盤'],
  ['gl_eq', '全球（含非美）股票'], ['us_tech', '美股科技']];
const DEFAULT_CUTS = [0, 7, 12, 20];
const BANDS = ['不好', '普通', '尚可', '不錯', '佳'];
const FOOTER = '試算根據最近收盤價與一組長期假設，不預測市場；持股紀錄約自 2026 年中起；不含稅務與費用的完整計算。';
// §3.6 display texts ({n} = number of houses not filled in; {{…}} placeholders go through the same renderer as AI text)
const LIMIT_ORDER = ['fcb_missing', 'house_missing', 'card_unknown', 'cash_stale', 'short_history', 'est_dates', 'inferred_trades', 'split',
  'realized_missing', 'unmapped', 'est_shares'];
const LIMIT_TEXT = {
  fcb_missing: '一銀房貸未納入，淨資產可能高估',
  house_missing: '房屋市值未填（{n} 間）',
  card_unknown: '有信用卡帳款金額未知，未計入負債',
  cash_stale: '部分現金餘額超過 14 天沒更新',
  short_history: '持有不到一年，年化為外推、僅供參考',
  est_dates: '約 {{perf.est_share}} 的投入金額沒有成交明細（對帳單缺或尚未入庫），日期為推定',
  inferred_trades: '有成交紀錄是由持股差額反推',
  split: '近期有股票分割，股數已是分割後',
  realized_missing: '有處分紀錄算不出成本，已實現損益未計入',
  unmapped: '有持股尚未歸類',
  est_shares: '部分股數是定期定額推估',
};
const SEC_TITLE = { nw: '資產負債', reserve: '預備金', alloc: '配置與集中度', perf: '報酬', data: '資料限制' };
const REF_SHORT = { deposit: '定存', cpi_tw: '通膨', tw50_lt: '0050 長期', sp500_lt: 'S&P 500 長期' };

export const HOOKS = { openHouse: null, openSettings: null };
export function setAdvisorHooks(h) { Object.assign(HOOKS, h || {}); }

/* ------------------------------------------------------------ small helpers */
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
/* one decimal + %, "−" for negatives, no "+" (also used for shares such as 37.9%); input is a percent number */
export function P1(v) {
  if (!isNum(v)) return '—';
  const r = Math.round(Math.abs(v) * 10) / 10;
  return (v < 0 && r > 0 ? '−' : '') + r.toFixed(1) + '%';
}
const upDown = (v) => (v == null ? '' : v >= 0 ? 'up' : 'down');       // stock colours (紅漲綠跌 unless switched in 設定)
export const cap = (text) => el('span', { class: 'adv-cap' }, text);
export const warnRow = (...nodes) => el('div', { class: 'adv-warn' }, icon(IC.alert), el('span', {}, nodes));
export const emptyCard = (text) => el('div', { class: 'card empty' }, text);
const subHead = (text) => el('div', { class: 'adv-subh' }, text);
function normCuts(c) {
  return Array.isArray(c) && c.length === 4 && c.every(isNum) && c[0] < c[1] && c[1] < c[2] && c[2] < c[3] ? c.slice() : DEFAULT_CUTS.slice();
}
const bandIndex = (r0, cuts) => {
  const r = Math.round(r0 * 10) / 10;                  // the screen shows one decimal; compare what is shown (same rule as pfm_advisor.band)
  return r < cuts[0] ? 0 : r < cuts[1] ? 1 : r < cuts[2] ? 2 : r < cuts[3] ? 3 : 4;
};
const codeOf = (key) => String(key || '').split(':').pop();
const nextMonthFirst = (ym) => {
  const m = /^(\d{4})-(\d{2})$/.exec(ym || '');
  return m ? `${(+m[2] % 12) + 1}/1` : '下月 1 日';
};

/* ------------------------------------------------------------ placeholder renderer (§3.2, §5.6)
   "…{{perf.cum}}…" → text nodes + value nodes.  Text is always a text node (never markup); f=twd values are util.amt() nodes so
   they blur with 隱藏金額.  Unknown placeholder, null/ill-typed value or a stray "{{" → returns null: the caller hides the whole text. */
const PH = /\{\{([a-z0-9_.]+)\}\}/g;
function metricNode(m) {
  if (!m || typeof m !== 'object' || m.v == null) return null;
  const v = m.v;
  switch (m.f) {
    case 'twd': return isNum(v) ? amt(v) : null;
    case 'pct': return isNum(v) ? P1(v) : null;
    case 'mo': return isNum(v) ? v.toFixed(1) : null;
    case 'days': return isNum(v) ? String(Math.round(v)) : null;
    case 'int': return isNum(v) ? Math.round(v).toLocaleString('en-US') : null;
    case 'date': return typeof v === 'string' || isNum(v) ? String(v) : null;
    default: return typeof v === 'string' || isNum(v) ? String(v) : null;
  }
}
export function renderText(text, metrics) {
  if (typeof text !== 'string' || !text) return null;
  const out = [];
  let last = 0;
  for (const m of text.matchAll(PH)) {
    const lit = text.slice(last, m.index);
    if (/\{\{|\}\}/.test(lit)) return null;
    const met = metrics && Object.prototype.hasOwnProperty.call(metrics, m[1]) ? metrics[m[1]] : null;
    const node = metricNode(met);
    if (node == null) return null;
    if (lit) out.push(lit);
    out.push(node);
    last = m.index + m[0].length;
  }
  const rest = text.slice(last);
  if (/\{\{|\}\}/.test(rest)) return null;
  if (rest) out.push(rest);
  return out.length ? out : null;
}

/* ------------------------------------------------------------ public files (data/*.json, same origin; never an error toast) */
const PUB = {};
const PUB_P = {};
const PUB_NAMES = ['benchmarks', 'cma', 'whitelist'];
export function publicData(name) { return PUB[name]; }
export function loadPublic(name) {
  if (!PUB_NAMES.includes(name)) return Promise.resolve(null);
  if (name in PUB) return Promise.resolve(PUB[name]);
  if (!PUB_P[name]) {
    PUB_P[name] = fetch(`data/${name}.json`, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null)
      .then((j) => { PUB[name] = j && typeof j === 'object' ? j : null; return PUB[name]; });
  }
  return PUB_P[name];
}

/* ------------------------------------------------------------ page */
export function viewAdvisor(app) {
  const d = S.data;
  const adv = d && d.advisor && typeof d.advisor === 'object' ? d.advisor : null;
  const out = [el('p', { class: 'adv-disclaimer' }, '參考試算，非投資建議')];
  if (!adv) out.push(group(null, emptyCard('資料更新後就會出現')));
  else {
    const ctx = makeCtx(app, d, adv);
    for (const block of [blockNw, blockReserve, blockAlloc, blockPerf, blockCalc, blockFunds, blockAi, blockSettings]) {
      let node = null;
      try { node = block(ctx); } catch (e) { console.error(e); node = group(null, emptyCard('這一塊暫時顯示不出來')); }
      if (node) out.push(node);
    }
  }
  out.push(el('p', { class: 'adv-foot' }, FOOTER));
  return out;
}
function makeCtx(app, d, adv) {
  const metrics = adv.metrics && typeof adv.metrics === 'object' ? adv.metrics : {};
  const pend = pendingView();
  const pendCuts = pend.adv && Array.isArray(pend.adv.cuts) ? pend.adv.cuts : null;   // just-sent cut points apply locally at once
  return { app, d, adv, metrics, cuts: normCuts(pendCuts || adv.cuts), pend, rerender: () => app.render(),
    text: (t) => renderText(t, metrics), pub: publicData, load: loadPublic, openSheet, group, row, amt };
}
function houseKeysMissing(adv) {
  const have = new Set(((adv.nw && adv.nw.items) || []).filter((i) => i && i.kind === 'house').map((i) => String(i.id).split(':')[1]));
  return ['h1', 'h2'].filter((k) => !have.has(k));
}

/* ------------------------------------------------------------ block 1: 資產負債 */
function blockNw(ctx) {
  const { adv } = ctx, nw = adv.nw;
  if (!nw) return group('資產負債', emptyCard('資料不足，暫時算不出來'));
  const items = Array.isArray(nw.items) ? nw.items : [];
  const openHouse = (k) => (HOOKS.openHouse ? () => HOOKS.openHouse(k, ctx) : null);
  const assetKinds = ['cash', 'stocks', 'house'], liabKinds = ['mortgage', 'card', 'fcb'];
  const li = (i) => {
    const k = i.kind === 'house' ? String(i.id).split(':')[1] : null;
    const onClick = k ? openHouse(k) : null;
    const pending = k && ctx.pend && ctx.pend.nw && ctx.pend.nw[k];
    const estTag = i.est ? el('span', { class: 'tag warn' }, i.kind === 'fcb' ? '推算' : '預估') : null;
    return itemRow(i.name, i.as_of ? md(i.as_of) : '', amt(i.amount), onClick, [estTag, pending ? clockMark() : null]);
  };
  const assets = items.filter((i) => assetKinds.includes(i.kind)).map(li);
  const missing = houseKeysMissing(adv);
  const sentVal = (k) => { const v = ctx.pend && ctx.pend.nw && ctx.pend.nw[k]; return v && isNum(v.value) && v.value > 0 ? v : null; };
  for (const k of missing) {
    const h = adv.state && adv.state.houses && adv.state.houses[k];
    const sv = sentVal(k);
    assets.push(sv
      ? itemRow(sv.label || (h && h.label) || `房屋 ${k.slice(1)}`, sv.as_of ? md(sv.as_of) : '', amt(sv.value), openHouse(k), [clockMark()])
      : itemRow((h && h.label) || `房屋 ${k.slice(1)}`, '', el('span', { class: 'muted' }, '未填'), openHouse(k), null));
  }
  const stillMissing = missing.filter((k) => !sentVal(k));
  const liabs = items.filter((i) => liabKinds.includes(i.kind)).map(li);
  const hero = el('div', { class: 'card hero adv-nw' },
    el('div', { class: 'label' }, '淨資產'),
    nw.net == null
      ? el('div', { class: 'adv-big adv-todo' }, stillMissing.length ? '待填房屋市值' : '待明早更新',
        stillMissing.length ? (HOOKS.openHouse ? el('button', { class: 'pill', onclick: () => HOOKS.openHouse(stillMissing[0], ctx) }, '填寫') : null) : clockMark())
      : el('div', { class: 'adv-big' }, el('span', { class: 'cur' }, 'NT$'), amt(nw.net)),
    nw.net == null ? el('div', { class: 'line' }, '資產小計 ', amt(nw.assets), '　負債小計 ', amt(nw.liab)) : null,
    el('div', { class: 'adv-cols' }, itemCol('資產', nw.assets, assets), itemCol('負債', nw.liab, liabs)),
    adv.inv ? el('div', { class: 'adv-inv' },
      el('div', { class: 'adv-invt' }, el('span', {}, '可投資資產（現金＋股票）'), el('span', { class: 'adv-invv' }, el('span', { class: 'cur' }, 'NT$'), amt(adv.inv.total))),
      el('div', { class: 'line tiny' }, '現金 ', amt(adv.inv.cash), '　股票 ', amt(adv.inv.stocks))) : null,
    (adv.limits || []).includes('fcb_missing') ? warnRow(LIMIT_TEXT.fcb_missing) : null);
  return group('資產負債', hero);
}
function itemCol(title, total, list) {
  return el('div', { class: 'adv-col' },
    el('div', { class: 'adv-colhead' }, el('span', {}, title), amt(total)),
    list.length ? el('ul', { class: 'adv-items' }, list) : el('p', { class: 'adv-none' }, '沒有項目'));
}
function itemRow(name, date, valueNode, onClick, extra) {
  const inner = [el('span', { class: 'adv-in' }, name, extra), el('span', { class: 'adv-id' }, date || ''), el('span', { class: 'adv-ia' }, valueNode)];
  return el('li', {}, onClick ? el('button', { class: 'adv-item', onclick: onClick }, inner) : el('div', { class: 'adv-item' }, inner));
}

/* ------------------------------------------------------------ block 2: 預備金 */
function blockReserve(ctx) {
  const r = ctx.adv.reserve;
  if (!r) return group('預備金', emptyCard('資料不足，暫時算不出來'));
  const ratio = r.target > 0 ? Math.min(1, Math.max(0, r.held / r.target)) : 1;
  const enough = !(r.gap > 0);
  return group('預備金', el('div', { class: 'card progress adv-rsv' },
    el('div', { class: 'head' }, el('b', {}, amt(r.held)), el('span', { class: 'muted sm' }, '已備　目標 ', amt(r.target))),
    sv('svg', { class: 'adv-bar', role: 'img', 'aria-label': `預備金已備 ${Math.round(ratio * 100)}%` },
      sv('rect', { class: 'adv-bar-bg', x: 0, y: 0, width: '100%', height: '100%', rx: 6 }),
      sv('rect', { class: 'adv-bar-fill' + (enough ? '' : ' warn'), x: 0, y: 0, width: `${(ratio * 100).toFixed(2)}%`, height: '100%', rx: 6 })),
    el('div', { class: 'line sm muted' }, isNum(r.months) ? `約 ${r.months.toFixed(1)} 個月` : '—', isNum(r.months_target) ? `（目標 ${r.months_target} 個月）` : ''),
    enough ? el('div', { class: 'adv-ok' }, icon(IC.check), '預備金已足')
      : warnRow('尚缺 ', amt(r.gap))));
}

/* ------------------------------------------------------------ block 3: 目前配置 */
/* current weights over the allocatable amount (§2.3): stocks by class + the cash above the reserve target as the 現金 class.
   alloc.by_cls only carries the stock part (cash value = 0), so the cash weight is added here. */
function currentWeights(adv) {
  const a = adv.alloc;
  if (!a) return null;
  const vals = CLS.map(([id]) => {
    const e = (a.by_cls || []).find((x) => x && x.cls === id);
    return e && isNum(e.value) ? e.value : 0;
  });
  const stocks = vals.reduce((s, x) => s + x, 0);
  const alloc = adv.reserve && isNum(adv.reserve.allocatable) ? adv.reserve.allocatable : 0;
  const base = Math.max(alloc, stocks);
  if (!(base > 0)) return null;
  vals[0] += base - stocks;
  return { vals, base, w: vals.map((v) => v / base) };
}
function blockAlloc(ctx) {
  const { adv } = ctx, a = adv.alloc;
  const cw = currentWeights(adv);
  if (!a || !cw) return group('目前配置', emptyCard('沒有持股資料'));
  const open = (i) => () => openClassSheet(ctx, i, cw);
  const here = (i) => cw.w[i] >= 0.0005;                    // rounds to at least 0.1%: ignores yen-sized rounding residue in the cash class
  let x = 0;
  const segs = [];
  cw.w.forEach((w, i) => {
    if (!here(i)) return;
    segs.push(sv('rect', { class: `adv-seg adv-c${i}`, x: `${(x * 100).toFixed(3)}%`, y: 0, width: `${(w * 100).toFixed(3)}%`, height: '100%', onclick: open(i) }));
    x += w;
  });
  const shown = CLS.map((c, i) => i).filter(here);
  const absent = CLS.map((c, i) => i).filter((i) => !here(i)).map((i) => CLS[i][1]);
  const legend = el('ul', { class: 'list adv-legend' }, shown.map((i) => row({
    icon: el('span', { class: `adv-sw adv-c${i}` }), title: CLS[i][1], value: P1(cw.w[i] * 100), valueSub: amt(cw.vals[i]), onClick: open(i), chevron: true })));
  const chips = el('div', { class: 'adv-chips' },
    isNum(a.single_w) ? chip('個股佔股票', P1(a.single_w * 100)) : null,
    a.top1 && isNum(a.top1.w) ? chip('最大單一持股', P1(a.top1.w * 100), a.top1.name) : null,
    isNum(a.tsmc_lt) ? chip('台積電合計曝險', P1(a.tsmc_lt * 100), '含基金內含') : null);
  return group('目前配置', [
    el('div', { class: 'card pad' },
      el('div', { class: 'adv-stack' }, sv('svg', { role: 'img', 'aria-label': '目前配置：' + shown.map((i) => `${CLS[i][1]} ${P1(cw.w[i] * 100)}`).join('、') }, segs)),
      chips),
    legend,
    el('p', { class: 'group-foot' }, '比例以可配置金額（', amt(cw.base), '）為基數。', absent.length ? `目前沒有：${absent.join('、')}。` : '', '點類別看持股。'),
  ]);
}
const chip = (label, value, note) => el('div', { class: 'kv-chip' }, label, el('b', {}, value), note ? el('small', { class: 'adv-chipn' }, note) : null);

function openClassSheet(ctx, i, cw) {
  const { adv } = ctx, [id, label] = CLS[i];
  let rows;
  if (id === 'cash') {
    const cash = ((adv.nw && adv.nw.items) || []).filter((x) => x.kind === 'cash');
    rows = cash.map((c) => row({ title: c.name, sub: c.as_of ? `${md(c.as_of)} 更新` : null, value: amt(c.amount) }));
  } else {
    const list = ((adv.alloc && adv.alloc.items) || []).filter((x) => x.cls === id);
    rows = list.map((h) => row({
      title: [h.name, el('span', { class: 'tag' }, codeOf(h.key)), h.single ? el('span', { class: 'tag blue' }, '個股') : null],
      sub: String(h.tag || '').replace(/（.*$/, '') || null, value: amt(h.value_twd), valueSub: P1((h.value_twd / cw.base) * 100) }));
  }
  openSheet({ title: label, body: () => [
    group(null, rows.length ? el('ul', { class: 'list' }, rows) : emptyCard('這一類目前沒有項目')),
    group(null, el('dl', { class: 'kv card' }, el('dt', {}, '這一類合計'), el('dd', {}, amt(cw.vals[i])), el('dt', {}, '占可配置金額'), el('dd', {}, P1(cw.w[i] * 100)))),
    id === 'cash' ? el('p', { class: 'group-foot' }, '預備金以內的現金不計入配置；這裡只算超出預備金目標的部分。') : null,
  ] });
}

/* ------------------------------------------------------------ block 4: 股票總投報 + spectrum */
function blockPerf(ctx) {
  const { adv } = ctx, p = adv.perf;
  if (!p) return group('股票總投報', emptyCard('沒有投報資料'));
  const enoughDays = isNum(p.days) && p.days >= 90;
  const xirr = enoughDays && isNum(p.xirr) ? p.xirr * 100 : null;
  const band = xirr == null ? null : BANDS[bandIndex(xirr, ctx.cuts)];
  const box = el('div', { class: 'adv-spec' });
  const draw = () => drawSpectrum(box, ctx, xirr, !!p.provisional);
  draw();
  if (ctx.pub('benchmarks') === undefined) ctx.load('benchmarks').then(draw);
  const bench = enoughDays && Array.isArray(p.bench) ? p.bench.filter((b) => b && isNum(b.cum)) : [];
  const limits = LIMIT_ORDER.filter((c) => (adv.limits || []).includes(c)).map((c) => {
    const text = c === 'house_missing' ? LIMIT_TEXT[c].replace('{n}', String(Math.max(1, houseKeysMissing(adv).length))) : LIMIT_TEXT[c];
    const parts = ctx.text(text);
    return parts ? warnRow(parts) : null;
  }).filter(Boolean);
  const hero = el('div', { class: 'card hero adv-perf' },
    el('div', { class: 'label' }, '累計報酬', isNum(p.days) ? el('span', { class: 'muted tiny' }, `持有 ${Math.round(p.days)} 天`) : null),
    el('div', { class: 'adv-big ' + upDown(p.cum) }, isNum(p.cum) ? pctS(p.cum * 100, 1) : '—'),
    el('div', { class: 'line tiny' }, '成本 ', amt(p.cost), '・市值 ', amt(p.value), '・股利 ', amt(p.divs)),
    el('div', { class: 'adv-sh' }, el('span', { class: 'adv-shl' }, '年化報酬（金額加權）'),
      xirr == null ? el('b', { class: 'adv-shv muted' }, '資料不足 90 天') : el('b', { class: 'adv-shv' }, pctS(xirr, 1)),
      xirr != null && p.provisional ? cap('暫估') : null),
    band ? el('div', { class: 'line tiny' }, '所在區間：', el('b', {}, band), p.provisional ? '（暫估）' : '') : null,
    box,
    isNum(p.est_share) && p.est_share > 0.25 ? warnRow(`約 ${Math.round(p.est_share * 100)}% 投入日期為推定（沒有成交明細時，用每月投入額推算日期）`) : null,
    bench.length ? el('div', { class: 'adv-sub' }, subHead('同現金流基準'), el('p', { class: 'adv-hint adv-hint0' }, '假設在你每次投入股票的同一天，把同樣的錢投入這個基準，到現在的累計報酬。'),
      bench.map((b) => el('div', { class: 'adv-b' },
        el('div', { class: 'adv-bm' }, el('span', { class: 't' }, `同現金流投入 ${b.name || ''}`), b.note ? el('span', { class: 's' }, b.note) : null),
        el('b', { class: 'adv-bv ' + upDown(b.cum) }, pctS(b.cum * 100, 1))))) : null,
    limits.length ? el('div', { class: 'adv-sub' }, subHead('資料限制'), limits) : null);
  return group('股票總投報', hero);
}

/* spectrum bar (§2.6): x range [c0-10, c3+10]; pointer = annualised return (hollow when provisional; clamped to the edge with an
   arrow when outside); numbered reference marks from benchmarks.json (dashed = status 待確認) with a chip list below. */
function drawSpectrum(box, ctx, xirr, provisional) {
  const bm = ctx.pub('benchmarks');
  const lines = bm && Array.isArray(bm.lines) ? bm.lines.filter((l) => l && isNum(l.value_pct)) : [];
  const refs = lines.map((ln, i) => ({ n: i + 1, ln, v: ln.value_pct, dash: ln.status === '待確認' }));
  const name = (r) => REF_SHORT[r.ln.id] || r.ln.label || '參考線';
  box.replaceChildren(
    spectrumSvg(ctx.cuts, xirr, provisional, refs, (r) => openRefSheet(r.ln)),
    refs.length ? el('div', { class: 'adv-refs' }, refs.map((r) => el('button', { class: 'adv-ref' + (r.dash ? ' dash' : ''), onclick: () => openRefSheet(r.ln) },
      el('span', { class: 'n' }, String(r.n)), `${name(r)} ${P1(r.v)}`, r.dash ? el('span', { class: 'tag warn' }, '待確認') : null))) : null,
    refs.length ? el('p', { class: 'adv-hint' }, '點參考線看來源與資料日；虛線代表還在待確認。') : null);
}
function spectrumSvg(cuts, xirr, provisional, refs, onRef) {
  const VW = 320, PAD = 12, W = VW - 2 * PAD, BY = 28, BH = 22, BB = BY + BH;
  const [c0, c1, c2, c3] = cuts, lo = c0 - 10, hi = c3 + 10;
  const X = (v) => PAD + ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * W;
  const f = (n) => n.toFixed(2);
  const bounds = [lo, c0, c1, c2, c3, hi];
  const k = [];
  for (let i = 0; i < 5; i++) {
    const x0 = X(bounds[i]), x1 = X(bounds[i + 1]);
    k.push(sv('rect', { class: `adv-sp adv-s${i}`, x: f(x0), y: BY, width: f(x1 - x0), height: BH }));
  }
  for (let i = 0; i < 5; i++) {
    const x0 = X(bounds[i]), x1 = X(bounds[i + 1]);
    if (x1 - x0 >= 26) k.push(sv('text', { class: 'adv-sp-t', x: f((x0 + x1) / 2), y: BY + BH / 2 + 4, 'text-anchor': 'middle' }, BANDS[i]));
  }
  let lastLabel = -99;
  for (const c of cuts) {
    const x = X(c);
    k.push(sv('line', { class: 'adv-tick', x1: f(x), y1: BB, x2: f(x), y2: BB + 5 }));
    if (x - lastLabel >= 22) { k.push(sv('text', { class: 'adv-sp-c', x: f(x), y: BB + 17, 'text-anchor': 'middle' }, `${Number.isInteger(c) ? c : c.toFixed(1)}%`)); lastLabel = x; }
  }
  const drawn = refs.filter((r) => r.v >= lo && r.v <= hi).sort((a, b) => a.v - b.v);
  const lastX = [-99, -99];
  let rows = 0;
  const marks = [];
  for (const r of drawn) {
    const x = X(r.v), rowIx = x - lastX[0] >= 20 ? 0 : 1, cy = 86 + 19 * rowIx;
    lastX[rowIx] = x; rows = Math.max(rows, rowIx + 1);
    const dash = r.dash ? ' dash' : '';
    k.push(sv('line', { class: 'adv-refln' + dash, x1: f(x), y1: BY, x2: f(x), y2: cy - 9 }));
    marks.push(sv('g', { class: 'adv-refg', 'aria-hidden': 'true', onclick: () => onRef(r) },
      sv('circle', { class: 'adv-refdot' + dash, cx: f(x), cy, r: 8.5 }),
      sv('text', { class: 'adv-refn', x: f(x), y: cy + 3.6, 'text-anchor': 'middle' }, String(r.n)),
      sv('circle', { class: 'adv-hit', cx: f(x), cy, r: 13 })));
  }
  k.push(...marks);
  if (xirr != null) {
    const px = X(xirr), edge = xirr < lo ? -1 : xirr > hi ? 1 : 0, hol = provisional ? ' hollow' : '';
    k.push(sv('line', { class: 'adv-ptr-ln' + hol, x1: f(px), y1: 26, x2: f(px), y2: BB + 4 }));
    k.push(sv('polygon', { class: 'adv-ptr' + hol, points: edge === 0 ? `${f(px - 6)},11 ${f(px + 6)},11 ${f(px)},26`
      : edge < 0 ? `${f(px - 9)},19 ${f(px + 1)},12 ${f(px + 1)},26` : `${f(px + 9)},19 ${f(px - 1)},12 ${f(px - 1)},26` }));
  } else k.push(sv('text', { class: 'adv-nodata', x: VW / 2, y: 16, 'text-anchor': 'middle' }, '資料不足 90 天'));
  const H = drawn.length ? 86 + 19 * (rows - 1) + 14 : BB + 26;
  const label = xirr == null ? '年化報酬：資料不足 90 天' : `年化報酬 ${P1(xirr)}，所在區間${BANDS[bandIndex(xirr, cuts)]}${provisional ? '（暫估）' : ''}`;
  return sv('svg', { class: 'adv-spec-svg', viewBox: `0 0 ${VW} ${H}`, role: 'img', 'aria-label': label }, k);
}
function openRefSheet(ln) {
  const src = Array.isArray(ln.src) ? ln.src : [];
  const kv = (dt, dd) => (dd ? [el('dt', {}, dt), el('dd', {}, dd)] : null);
  openSheet({ title: REF_SHORT[ln.id] || ln.label || '參考線', body: () => [
    group(null, el('dl', { class: 'kv card' },
      kv('項目', ln.label), kv('數值', P1(ln.value_pct) + (ln.ccy ? `（${ln.ccy}）` : '')), kv('資料日', ln.as_of), kv('期間', ln.period), kv('口徑', ln.basis),
      kv('狀態', ln.status === '待確認' ? '待確認' : ln.status ? '已核對' : ''))),
    ln.note ? group('說明', el('div', { class: 'card' }, el('p', { class: 'para' }, ln.note))) : null,
    group('來源', src.length ? el('div', { class: 'card' }, src.map((s) => [
      el('p', { class: 'para' }, s && s.title ? s.title : '（無標題）'),
      el('p', { class: 'para muted tiny selectable adv-url' }, [s && s.date, s && s.url].filter(Boolean).join('　'))]))
      : emptyCard('沒有來源資料')),
  ] });
}

/* ------------------------------------------------------------ block 5, 6, 8: STUBS for later packages (see header) */
/* ------------------------------------------------------------ block 5 + 6 (F2): 互動計算表 and 資金需求試算
   PFM-ADVISOR-SPEC §2.9, §2.10, §6 rows 5-6.  Reference calculator only — 參考試算，非投資建議.  The numbers come only from advisor_calc.js.
   The imports of this section sit here on purpose: they keep the F1 / F3 import lines untouched (import declarations are hoisted). */
import * as AC from './advisor_calc.js';
import { fundsTrial } from './advisor_calc.js';                       // the pure what-if function (neutral alias of E2's export)
import { samt as calcSamt, todayIso as calcToday, wd as calcWd } from './util.js';
import { saveUi as calcSave } from './data.js';

const CALC_ID = CLS.map((c) => c[0]);
const BROKER_TXT = '以券商為準';
const calcPct = (v) => { const x = Math.round(v * 1000) / 10; return `${Number.isInteger(x) ? x : x.toFixed(1)}%`; };    // decimal → "7%" / "7.5%"
const calcChip = (label, value, note) => el('div', { class: 'kv-chip' }, label, el('b', {}, value), note ? el('small', { class: 'adv-chipn' }, note) : null);
const kvPair = (dt, ...dd) => [el('dt', {}, dt), el('dd', {}, dd)];
const calcSnap = (v, sl, dflt) => {
  if (!isNum(v)) return dflt;
  const k = Math.round((Math.min(sl.max, Math.max(sl.min, v)) - sl.min) / sl.step);
  return Math.round((sl.min + k * sl.step) * 1e6) / 1e6;
};
/* slider state lives in S.ui.adv = {T, L, H} (decimals; local only, never written back) */
function calcUiState() {
  const raw = S.ui.adv && typeof S.ui.adv === 'object' ? S.ui.adv : {};
  S.ui.adv = { T: calcSnap(raw.T, AC.SLIDERS.T, AC.SLIDERS.T.def), L: calcSnap(raw.L, AC.SLIDERS.L, AC.SLIDERS.L.def), H: AC.PROB_YEARS.includes(raw.H) ? raw.H : 5 };
  return S.ui.adv;
}

function blockCalc(ctx) {
  const body = el('div', { class: 'adv-calc' });
  const draw = () => calcDraw(body, ctx);
  draw();
  const wait = ['cma', 'whitelist'].filter((n) => ctx.pub(n) === undefined);
  if (wait.length) Promise.all(wait.map((n) => ctx.load(n))).then(() => { if (body.isConnected) draw(); });
  return group('互動計算表', body);
}

function calcDraw(body, ctx) {
  const { adv } = ctx, r = adv.reserve;
  const gap = r && isNum(r.gap) ? r.gap : 0;
  const allocatable = r && isNum(r.allocatable) ? r.allocatable : 0;
  const nodes = [];
  if (gap > 0) {
    nodes.push(el('div', { class: 'card pad adv-calc-hint' }, warnRow('預備金尚缺 ', amt(gap), isNum(r.months) ? `（目前約 ${r.months.toFixed(1)} 個月）` : '',
      '。以下比例只適用已投入的 ', amt(allocatable), '；新增資金先補預備金')));
  }
  const done = () => body.replaceChildren(...nodes);
  if (allocatable <= 0) {                                   // §2.9-6: nothing allocated yet → only the reserve sentence
    if (!(gap > 0)) nodes.push(emptyCard('沒有持股資料，無法試算'));
    return done();
  }
  const cur = adv.alloc ? AC.currentFromAlloc(adv.alloc, allocatable) : null;
  if (!cur || !cur.ok) { nodes.push(emptyCard('沒有持股資料，無法試算')); return done(); }
  const cma = ctx.pub('cma'), wl = ctx.pub('whitelist');
  if (cma === undefined || wl === undefined) { nodes.push(emptyCard('載入計算參數…')); return done(); }
  if (!cma || !AC.validateCma(cma).ok) { nodes.push(emptyCard('計算參數讀不到，稍後再試')); return done(); }
  nodes.push(...calcPanel(ctx, cma, wl, cur));
  return done();
}

function calcPanel(ctx, cma, wl, cur) {
  const { adv } = ctx;
  const wlItems = wl && Array.isArray(wl.items) ? wl.items : null;
  const wlNow = ctx.pend && Array.isArray(ctx.pend.wl) ? ctx.pend.wl : adv.wl;     // a just-sent (not yet applied) selection shows at once
  const ids = new Set(Array.isArray(wlNow) ? wlNow : []);
  const checked = wlItems ? wlItems.filter((i) => i && ids.has(i.id) && CALC_ID.includes(i.cls)) : [];
  const allowed = AC.allowedClasses(cur.w, checked.map((i) => i.cls));
  const grid = AC.buildGrid(cma, allowed);                                    // warm the cache once; sliders only filter afterwards
  if (!grid || !grid.ok) return [emptyCard('計算參數讀不到，稍後再試')];
  const ui = calcUiState();
  const res = el('div', { class: 'adv-cres' });
  const update = () => res.replaceChildren(calcResult(ctx, cma, cur, AC.solve(cma, { T: ui.T, Lmax: ui.L, allowed, current: cur.w }), ui, checked, !!wlItems));
  let raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; update(); }); };
  const segBtns = AC.PROB_YEARS.map((y) => el('button', { 'aria-pressed': String(ui.H === y), onclick: () => {
    ui.H = y; calcSave();
    segBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(AC.PROB_YEARS[i] === y)));
    schedule();
  } }, `${y} 年`));
  const ctl = el('div', { class: 'card pad adv-ctl' },
    calcRange('T', '目標年化報酬', AC.SLIDERS.T, ui.T, calcPct, (v) => { ui.T = v; schedule(); }),
    calcRange('L', '最大可承受虧損', AC.SLIDERS.L, ui.L, calcPct, (v) => { ui.L = v; schedule(); }),
    el('p', { class: 'adv-hint' }, '最大可承受虧損以「1 年 95% 下行」衡量：約 20 年有 1 年會比這更差。'),
    el('div', { class: 'adv-hz' }, el('span', {}, '達標機率的年期'), el('div', { class: 'seg', role: 'group', 'aria-label': '達標機率的年期' }, segBtns)));
  update();
  return [ctl, res,
    el('ul', { class: 'list adv-assume' }, row({ title: '假設', sub: '資本市場假設與來源', value: cma.as_of || null, valueSub: cma.as_of ? '資料日' : null, wrapSub: true, chevron: true, onClick: () => openAssumptions(ctx, cma) })),
    el('p', { class: 'group-foot' }, '比例以可配置金額（', amt(cur.base), '）為基數，只算到類別，不含個股；結果是在長期假設下的試算。')];
}

/* one native range slider.  The input works in percent units (e.g. 2 … 20, step 0.5) so the browser never rounds binary fractions;
   the filled part of the track is an SVG rect whose width attribute follows the thumb (no inline style needed). */
function calcRange(key, label, cfg, value, fmtv, onValue) {
  const id = `adv-r-${key}`;
  const min = Math.round(cfg.min * 1000) / 10, max = Math.round(cfg.max * 1000) / 10, step = Math.round(cfg.step * 1000) / 10;
  const out = el('output', { class: 'adv-rv', for: id, 'aria-live': 'off' }, fmtv(value));
  const fill = sv('rect', { class: 'adv-sl-fill', x: 0, y: 0, width: '0%', height: '100%' });
  const input = el('input', { class: 'adv-range', type: 'range', id, min, max, step, 'aria-label': label });
  input.value = String(Math.round(value * 1000) / 10);
  const read = () => {
    const v = Number(input.value), p = (v - min) / (max - min), dec = Math.round(v * 10) / 1000;
    fill.setAttribute('width', `${(p * 100).toFixed(2)}%`);
    out.textContent = fmtv(dec);
    input.setAttribute('aria-valuetext', fmtv(dec));
    return dec;
  };
  read();
  input.addEventListener('input', () => onValue(read()));
  input.addEventListener('change', () => { onValue(read()); calcSave(); });
  return el('div', { class: 'adv-rg' },
    el('div', { class: 'adv-rh' }, el('label', { for: id }, label), out),
    el('div', { class: 'adv-sl' }, sv('svg', { class: 'adv-sl-svg', 'aria-hidden': 'true', width: '100%', height: 6 }, sv('rect', { class: 'adv-sl-bg', x: 0, y: 0, width: '100%', height: '100%' }), fill), input));
}

function calcStack(w, label) {
  let x = 0;
  const segs = [];
  w.forEach((v, i) => {
    if (!(v >= 0.0005)) return;
    segs.push(sv('rect', { class: `adv-seg adv-c${i}`, x: `${(x * 100).toFixed(3)}%`, y: 0, width: `${(v * 100).toFixed(3)}%`, height: '100%' }));
    x += v;
  });
  return el('div', { class: 'adv-stack' }, sv('svg', { role: 'img', 'aria-label': label }, segs));
}
const calcStackLabel = (name, w) => `${name}：` + w.map((v, i) => (v >= 0.0005 ? `${CLS[i][1]} ${P1(v * 100)}` : null)).filter(Boolean).join('、');

function calcResult(ctx, cma, cur, out, ui, checked, wlOk) {
  if (!out || !out.ok) return emptyCard('這組條件算不出來');
  if (!out.feasible) {                                           // §2.9-5: two sentences only — never a class ratio or weight
    const hasMax = isNum(out.maxMedianWithinLmax), hasMin = out.reachable && isNum(out.minLossForTarget);
    const NOGO = '在目前假設與護欄內無法達成。';
    return el('div', { class: 'card pad adv-res adv-no' },
      el('div', { class: 'adv-verdict no' }, '不可行'),
      el('p', { class: 'adv-line' }, hasMax ? `在可承受虧損 ${calcPct(ui.L)} 內，預期年化最高約 ${P1(out.maxMedianWithinLmax * 100)}。` : NOGO),
      hasMax || hasMin ? el('p', { class: 'adv-line' }, hasMin ? `要達到 ${calcPct(ui.T)}，1 年 95% 下行至少約 ${P1(out.minLossForTarget * 100)}。` : NOGO) : null);
  }
  const rows = AC.gapVsCurrent(out.w, cur.w, cur.base).rows;
  const st = out.stats;
  const gaps = rows.map((g, i) => ({ g, i })).filter(({ g }) => g.cur >= 0.0005 || g.target >= 0.0005).map(({ g, i }) => {
    const same = Math.abs(g.diffPp) < 0.05;
    const text = same ? '與試算比例相同' : g.diffPp < 0 ? `現況高於試算比例 ${Math.abs(g.diffPp).toFixed(1)} 個百分點` : `現況低於試算比例 ${g.diffPp.toFixed(1)} 個百分點`;
    return el('li', { class: 'adv-gr' },
      el('span', { class: 'adv-gn' }, el('span', { class: `adv-sw adv-c${i}` }), CLS[i][1]),
      el('span', { class: 'adv-gv' }, `${P1(g.cur * 100)} → ${P1(g.target * 100)}`),
      el('span', { class: 'adv-gd' }, text),
      same ? el('span', { class: 'adv-ga' }) : el('span', { class: 'adv-ga' }, '約 NT$ ', amt(Math.abs(g.amount))));
  });
  return el('div', { class: 'card pad adv-res adv-yes' },
    el('div', { class: out.prob[ui.H] >= 0.65 ? 'adv-verdict ok' : 'adv-verdict mid' }, '依假設可達'),
    el('div', { class: 'adv-dbar' },
      el('span', {}, '現況'), calcStack(cur.w, calcStackLabel('現況', cur.w)),
      el('span', {}, '試算'), calcStack(out.w, calcStackLabel('試算', out.w))),
    el('div', { class: 'adv-stats' },
      calcChip('預期年化（中位數）', P1(st.median * 100)),
      calcChip('波動', P1(st.sigma * 100)),
      calcChip('1 年 95% 下行虧損', P1(st.loss95 * 100), `可承受上限 ${calcPct(ui.L)}`),
      calcChip(`達標機率（${ui.H} 年）`, P1(out.prob[ui.H] * 100), `年化達 ${calcPct(ui.T)} 以上`)),
    el('p', { class: 'adv-hint' }, '「依假設可達」只代表預期年化（中位數）不低於目標；達標機率越接近 50%，代表只是剛好達到。機率依假設估算，不是預測。'),
    el('div', { class: 'adv-sub' }, subHead('與現況差距（現況 → 試算）'), el('ul', { class: 'adv-gaps' }, gaps)),
    calcCandidates(ctx, rows, checked, wlOk));
}

function calcCandidates(ctx, rows, checked, wlOk) {
  const head = [subHead('搭配候選'), el('p', { class: 'adv-hint adv-hint0' }, '候選池，不是推薦；只列出你在顧問設定勾選的標的。')];
  if (!wlOk) return el('div', { class: 'adv-sub' }, head, el('p', { class: 'adv-none' }, '名單讀不到'));
  const pc = AC.pickCandidates(rows, checked);
  const list = pc && pc.ok ? pc.list.filter((c) => c.cls !== 'cash') : [];
  if (!list.length) return el('div', { class: 'adv-sub' }, head, el('p', { class: 'adv-none' }, '現況沒有任何非現金類別低於試算比例 2.5 個百分點以上，暫無候選。'));
  const link = () => (HOOKS.openSettings ? el('button', { class: 'adv-link adv-link0', onclick: () => HOOKS.openSettings(undefined, ctx) }, '到顧問設定勾選')
    : el('p', { class: 'adv-none' }, '到顧問設定勾選'));
  return el('div', { class: 'adv-sub' }, head, list.map((c) => {
    const i = CALC_ID.indexOf(c.cls);
    return el('div', { class: 'adv-cg' },
      el('div', { class: 'adv-cgh' }, el('span', { class: `adv-sw adv-c${i}` }), CLS[i][1], el('span', { class: 'adv-cgd' }, `低於試算比例 ${c.diffPp.toFixed(1)} 個百分點`)),
      c.empty ? [el('p', { class: 'adv-none adv-none0' }, '這個類別還沒有勾選候選'), link()]
        : c.items.map((it) => el('div', { class: 'adv-ci' },
          el('b', {}, it.name || it.id), it.code ? el('span', { class: 'tag' }, it.code) : null,
          el('small', {}, [isNum(it.er_pct) ? `費用率 ${it.er_pct}%` : '費用率待確認', it.ccy, it.settle].filter(Boolean).join('・')),
          it.min_fee_note ? el('small', {}, it.min_fee_note) : null)));
  }));
}

/* ------------------------------------------------------------ 假設 panel */
function openAssumptions(ctx, cma) {
  const seen = new Set(), srcs = [];
  const add = (list) => { for (const s of Array.isArray(list) ? list : []) { const k = s && (s.url || s.title); if (k && !seen.has(k)) { seen.add(k); srcs.push(s); } } };
  cma.classes.forEach((c) => add(c.src)); add(cma.corr_src); add(cma.idio && cma.idio.src);
  const tagFor = (s) => (s === '待確認' ? el('span', { class: 'tag warn' }, '待確認') : s ? el('span', { class: 'tag' }, '已核對') : null);
  const cmv = (k, v) => el('div', { class: 'adv-cmi' }, el('small', {}, k), el('b', {}, v));
  const classCard = (c, i) => el('div', { class: 'card pad adv-cm' },
    el('div', { class: 'adv-cmh' }, el('span', { class: `adv-sw adv-c${i}` }), el('b', {}, CLS[i][1]), tagFor(c.status)),
    el('div', { class: 'adv-cmv' }, cmv('期望年報酬（幾何，年化複利）', P1(c.mu * 100)), cmv('波動', P1(c.sigma * 100)), cmv('上限', `${Math.round(c.cap * 100)}%`)),
    c.proxy ? el('p', { class: 'adv-cmp' }, '代理標的：', c.proxy.name || '', c.proxy.code ? `（${c.proxy.code}）` : '') : null,
    el('p', { class: 'adv-cmp' }, `來源 ${Array.isArray(c.src) ? c.src.length : 0} 筆`));
  const nm = (i) => CLS[i][1];
  const pairs = [];
  for (let i = 1; i < 7; i++) for (let j = i + 1; j < 7; j++) pairs.push({ i, j, v: cma.corr[i][j] });
  const pairKv = (list) => el('dl', { class: 'kv card' }, list.map((p) => kvPair(`${nm(p.i)}－${nm(p.j)}`, p.v.toFixed(2))));
  const cashV = cma.corr[0].slice(1), cMin = Math.min(...cashV), cMax = Math.max(...cashV);
  const corrNodes = [subHead('相關最高的三組'), pairKv(pairs.slice().sort((a, b) => b.v - a.v).slice(0, 3)),
    subHead('相關最低的三組'), pairKv(pairs.slice().sort((a, b) => a.v - b.v).slice(0, 3)),
    el('p', { class: 'group-foot' }, `${nm(0)}與其他類別：`, cMin === 0 && cMax === 0 ? '視為 0（無關）' : `${cMin.toFixed(2)}～${cMax.toFixed(2)}`, '。')];
  openSheet({ title: '假設', body: () => [
    group(null, el('div', { class: 'card pad adv-asm' }, el('b', { class: 'adv-asm-b' }, '這是假設，不是預測'),
      el('dl', { class: 'kv adv-asm-kv' }, kvPair('資料日期', cma.as_of || '—'), kvPair('參數版本', String(cma.rev ?? '—'))))),
    group('資本市場假設（7 類）', cma.classes.map(classCard), { foot: ['期望年報酬為台幣、名目；上限是設計護欄，不是市場數據。', el('br'), '機構預測多為年化複利報酬；本試算據此計入波動拖累。'] }),
    group('相關係數摘要', corrNodes),
    cma.idio ? group('個股個別波動', el('dl', { class: 'kv card' }, kvPair('台股個股', P1(cma.idio.tw_single * 100)), kvPair('美股個股', P1(cma.idio.us_single * 100))),
      { foot: '只用在現況的風險估算；試算比例只到類別，不含個股。' }) : null,
    group(`來源（${srcs.length} 筆）`, srcs.length ? el('div', { class: 'card' }, srcs.map((s) => el('div', { class: 'adv-src' },
      el('p', { class: 'para' }, s.title || '（無標題）'),
      el('p', { class: 'para muted tiny selectable adv-url' }, [s.date, s.url].filter(Boolean).join('　'))))) : emptyCard('沒有來源資料')),
  ] });
}

/* ------------------------------------------------------------ block 6: 資金需求試算 */
const calcIsoPlus = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const calcDay = (iso) => (iso ? `${iso}（週${calcWd(iso)}）` : '—');
const calcRate = (v) => (isNum(v) ? `${parseFloat((v * 100).toFixed(4))}%` : BROKER_TXT);

function blockFunds(ctx) {
  const sl = ctx.d.stocks_live;
  const items = sl && Array.isArray(sl.items) ? sl.items.filter((x) => x && typeof x.key === 'string' && isNum(x.value_twd)) : [];
  const ok = items.length > 0;
  return group(null, [
    el('ul', { class: 'list adv-funds' }, row({ title: '資金需求試算', sub: ok ? '輸入需要金額與最晚日期，勾選持股試算' : '沒有持股資料', wrapSub: true, chevron: ok, onClick: ok ? () => openFunds(ctx, items) : null })),
    el('p', { class: 'group-foot' }, '用最近收盤價試算，費用與交割日以券商為準。')]);
}

function openFunds(ctx, items) {
  const { adv } = ctx;
  const st = { need: '', date: calcIsoPlus(14), sel: new Set() };
  const meta = new Map(((adv.alloc && adv.alloc.items) || []).filter((a) => a && typeof a.key === 'string').map((a) => [a.key, a]));
  const clsName = (it) => {
    const a = meta.get(it.key), i = a ? CALC_ID.indexOf(a.cls) : -1;
    return { name: i >= 0 ? CLS[i][1] : it.mkt === 'TW' ? CLS[3][1] : CLS[4][1], single: a ? a.single === true : true };
  };
  const feesOf = () => { const b = ctx.pub('benchmarks'); return b && b.fees && typeof b.fees === 'object' ? b.fees : null; };
  const result = el('div', { class: 'adv-fres' });
  const strip = el('div', { class: 'adv-fstrip', hidden: true, 'aria-live': 'polite' });
  const countNode = el('small', {}, '');
  const redraw = () => {
    countNode.textContent = st.sel.size ? `已勾選 ${st.sel.size} 檔` : '';
    const r = fundsResult(ctx, items, st, feesOf(), ctx.pub('benchmarks') === undefined);
    result.replaceChildren(...r.nodes);
    strip.replaceChildren(...(r.strip || []));
    strip.hidden = !r.strip;
  };
  if (ctx.pub('benchmarks') === undefined) ctx.load('benchmarks').then(redraw);
  const needIn = el('input', { class: 'adv-fi', type: 'number', id: 'adv-need', inputmode: 'numeric', min: 0, max: 99999999, step: 1000, placeholder: '例：200000', enterkeyhint: 'done' });
  needIn.addEventListener('input', () => { st.need = needIn.value; redraw(); });
  const dateIn = el('input', { class: 'adv-fi', type: 'date', id: 'adv-date', min: calcToday() });
  dateIn.value = st.date;
  dateIn.addEventListener('input', () => { st.date = dateIn.value; redraw(); });
  const pick = (it) => {
    const chk = el('input', { class: 'adv-chk', type: 'checkbox', 'aria-label': `勾選 ${it.name || it.key}` });
    chk.addEventListener('change', () => { if (chk.checked) st.sel.add(it.key); else st.sel.delete(it.key); redraw(); });
    const c = clsName(it);
    return el('li', {}, el('label', { class: 'row adv-pick' }, chk,
      el('span', { class: 'main' }, el('span', { class: 't wrap' }, it.name || it.key, el('span', { class: 'tag' }, it.code || codeOf(it.key))),
        el('span', { class: 's wrap' }, c.name + (c.single ? '・個股' : ''))),
      el('span', { class: 'v' }, amt(it.value_twd), el('small', {}, '損益 ', isNum(it.pnl_twd) ? calcSamt(it.pnl_twd, upDown(it.pnl_twd)) : '—'))));
  };
  const picks = group('持股', el('ul', { class: 'list' }, items.map(pick)));
  picks.querySelector('h2').append(countNode);
  openSheet({ title: '資金需求試算', body: () => [
    strip,
    group(null, el('div', { class: 'card adv-fform' },
      el('div', { class: 'field adv-fneed' }, el('label', { for: 'adv-need' }, '需要金額'), needIn, el('span', { class: 'muted sm' }, '元')),
      el('div', { class: 'field' }, el('label', { for: 'adv-date' }, '最晚日期'), dateIn))),
    picks, result] });
  redraw();
}

/* returns {nodes, strip}: nodes = the result sections, strip = the one-line live summary pinned at the top of the panel (or null) */
function fundsResult(ctx, items, st, fees, feesLoading) {
  const only = (n) => ({ nodes: [n], strip: null });
  if (st.sel.size === 0) return only(emptyCard('勾選要試算的持股'));
  const blank = st.need.trim() === '';
  const need = blank ? 0 : Number(st.need);
  if (!isNum(need) || need < 0 || need > 99999999) return only(el('p', { class: 'adv-err' }, '需要金額請填 0 到 99,999,999 元'));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(st.date)) return only(el('p', { class: 'adv-err' }, '請選擇最晚日期'));
  if (feesLoading) return only(emptyCard('載入費率…'));
  const { d, adv } = ctx;
  const cash = adv.inv && isNum(adv.inv.cash) ? adv.inv.cash : 0;
  const t = fundsTrial({ need, deadline: st.date, selected: st.sel, items, alloc: adv.alloc, fees, fx: d.stocks_live.fx, cash,
    monthly: adv.reserve && isNum(adv.reserve.monthly) ? adv.reserve.monthly : 0 });
  if (!t.ok) return only(el('p', { class: 'adv-err' }, t.error === 'missing_fx' ? '缺少匯率，美股持股無法試算' : '這組條件算不出來'));
  const out = [];
  const c = t.cover, straddle = c.straddle;
  const range = (a, b, fn) => (Math.round(a) === Math.round(b) ? [fn(a)] : [el('span', { class: 'adv-nb' }, fn(a), '～', fn(b))]);
  /* verdict */
  out.push(el('div', { class: 'card pad adv-fhero' },
    blank ? el('div', { class: 'adv-line muted' }, '輸入需要金額，才會比較足夠或不足') : [
      el('div', { class: 'adv-verdict ' + (c.status === 'enough' ? 'ok' : 'no') }, c.status === 'enough' ? '足夠' : '不足'),
      el('p', { class: 'adv-line' }, c.status === 'enough'
        ? ['淨入帳（低）比需要金額多 ', amt(c.diffLow), Math.round(c.diffHigh) === Math.round(c.diffLow) ? '' : ['，區間上緣多 ', amt(c.diffHigh)]]
        : ['淨入帳（低）還差 ', amt(c.shortfall), straddle ? '；區間上緣可達需要金額，實際看費用' : ''])],
    el('p', { class: 'adv-line' }, '淨入帳區間　', range(t.net.low, t.net.high, amt)),
    el('p', { class: 'adv-line muted sm' }, '毛額 ', amt(t.gross), `（${t.count} 檔）`)));
  /* fees */
  const unk = (prefix) => t.fees.unknown.some((u) => u.key.startsWith(prefix));
  const feeRows = [];
  if (t.fees.tw) {
    feeRows.push(kvPair('台股手續費', unk('tw_fee') ? BROKER_TXT : amt(t.fees.tw.commission)));
    feeRows.push(kvPair('台股證交稅', unk('tw_tax') ? (t.fees.tw.tax > 0 ? [amt(t.fees.tw.tax), '（部分', BROKER_TXT, '）'] : BROKER_TXT) : amt(t.fees.tw.tax)));
  }
  if (t.fees.us) {
    const u = t.fees.us;
    feeRows.push(kvPair('美股・定期定額比率（僅供參考，處分通常不適用）', u.dca == null ? BROKER_TXT : amt(u.dca)));
    feeRows.push(kvPair('美股・電子單牌告', u.std == null ? BROKER_TXT : amt(u.std)));
    feeRows.push(kvPair('美股・一般單最低', u.min == null ? BROKER_TXT : [amt(u.min), el('small', { class: 'muted tiny adv-nb' }, '　待券商確認')]));
  }
  feeRows.push(kvPair('費用合計', range(t.fees.total.low, t.fees.total.high, amt)));
  const warns = t.fees.us ? t.fees.us.warnings.map((w) => warnRow(`${w.name || w.key} 的一般單最低費用 US$${w.minFeeUsd}（約 NT$ `, amt(w.minFeeTwd), `）占該檔市值 ${Math.round(w.pct * 100)}%`)) : [];
  const caps = [];
  if (t.fees.tw && fees) caps.push(`台股：手續費率 ${calcRate(fees.tw_fee_rate)}（每檔最低 NT$${isNum(fees.tw_fee_min) ? fees.tw_fee_min : '—'}）；證交稅 個股 ${calcRate(fees.tw_tax_stock)}、ETF ${calcRate(fees.tw_tax_etf)}、債券 ETF ${calcRate(fees.tw_tax_bond_etf)}。`);
  if (t.fees.us && fees) caps.push(`美股處分：費用區間取電子單牌告 ${calcRate(fees.us_std_rate)}（最樂觀）與一般單最低 US$${isNum(fees.us_min_usd) ? fees.us_min_usd : '—'}／檔（最保守，匯率 ${d.stocks_live.fx}，可能已取消，待券商確認）；定期定額 ${calcRate(fees.us_dca_rate)} 只適用定期定額，僅供參考，不入區間；${BROKER_TXT}。`);
  out.push(group('費用', [el('dl', { class: 'kv card' }, feeRows), warns.length ? el('div', { class: 'adv-fw' }, warns) : null], { foot: caps.join(' ') || null }));
  /* latest date */
  const L = t.latest, late = (iso) => (iso && iso < calcToday() ? el('span', { class: 'tag warn' }, '已過') : null);
  const dl = [];
  if (L.TW) dl.push(kvPair(`台股（T+${L.settleDays.TW}）`, calcDay(L.TW), late(L.TW)));
  if (L.US) dl.push(kvPair(`美股（T+${L.settleDays.US}）`, calcDay(L.US), late(L.US)));
  out.push(group('最晚處分日（估）', el('dl', { class: 'kv card' }, dl),
    { foot: `從最晚日期往前推 1 個營業日（轉出）加交割日；最晚日期若落在週末，先視為前一個週五。只避開週末，國定假日與美股休市未處理，${BROKER_TXT}。` }));
  /* after */
  const a = t.after, tgt = adv.reserve && isNum(adv.reserve.months_target) ? adv.reserve.months_target : null;
  const mo = (v) => (isNum(v) ? v.toFixed(1) : '—');
  const wRows = a.byCls.map((x, i) => ({ x, i })).filter(({ x }) => x.value > 0).map(({ x, i }) => el('li', { class: 'adv-gr' },
    el('span', { class: 'adv-gn' }, el('span', { class: `adv-sw adv-c${i}` }), CLS[i][1]),
    el('span', { class: 'adv-gv' }, P1(x.w * 100)),
    el('span', { class: 'adv-gd' }),
    el('span', { class: 'adv-ga' }, amt(x.value))));
  out.push(group('處分後', [
    el('dl', { class: 'kv card' },
      kvPair('現金', amt(cash), ' → ', amt(a.cash)),
      kvPair('預備金月數', `${mo(a.monthsBefore)} → ${mo(a.months)} 個月`, tgt != null ? `（目標 ${tgt}）` : '')),
    a.base > 0 ? el('div', { class: 'card pad adv-after' }, subHead('剩餘持股的類別權重'), el('ul', { class: 'adv-gaps' }, wRows),
      el('p', { class: 'adv-hint' }, '以剩餘持股市值 ', amt(a.base), ' 為基數。'))
      : el('div', { class: 'card pad adv-after' }, el('p', { class: 'adv-none adv-none0' }, '已全數處分，沒有剩餘持股。'))]));
  /* P&L */
  const sg = (v) => calcSamt(v, upDown(v));
  out.push(group('損益', el('dl', { class: 'kv card' },
    kvPair('本次已實現損益', range(t.realized.low, t.realized.high, sg)),
    kvPair('處分部位成本', amt(t.realized.cost)),
    kvPair(`剩餘持股未實現損益（${t.remaining.count} 檔）`, sg(t.remaining.unrealized))),
    { foot: '已實現損益：已處分的部分，淨入帳減去成本後賺或賠的錢。' }));
  /* fixed notes */
  out.push(group('提示', el('div', { class: 'card pad' }, el('ul', { class: 'adv-notes' }, t.notes.map((n) => el('li', {}, n))))));
  const strip = [el('span', { class: 'adv-fsn' }, `已勾選 ${t.count} 檔`),
    blank ? null : el('b', { class: 'adv-fsv ' + (c.status === 'enough' ? 'ok' : 'no') }, c.status === 'enough' ? '足夠' : '不足'),
    el('span', { class: 'adv-fsr' }, '淨入帳 ', range(t.net.low, t.net.high, amt))];
  return { nodes: out, strip };
}
/* F3: 顧問設定入口（§6 row 8）— the last row; the panel itself is js/advisor_settings.js, which sets HOOKS.openSettings when it loads */
function blockSettings(ctx) {
  if (!HOOKS.openSettings) return null;
  const p = ctx.pend || {};
  const n = Object.keys(p.nw || {}).length + (p.wl ? 1 : 0) + Object.keys(p.adv || {}).length;     // settings sent from this phone, not yet applied
  return group(null, el('ul', { class: 'list' }, row({ title: '顧問設定', sub: '房屋市值、一銀房貸、候選名單、切點、預備金月數、AI 解讀', wrapSub: true,
    extra: n ? el('span', { class: 'adv-pendn' }, clockMark(), `${n} 項設定待生效`) : null, chevron: true, onClick: () => HOOKS.openSettings(undefined, ctx) })));
}

/* ------------------------------------------------------------ block 7: AI 解讀 (status line §5.4, text = ai.result or rule) */
function localAiPending() {
  return S.queue.some((b) => (b.cmds || []).some((c) => c && Object.prototype.hasOwnProperty.call(c, 'ai_request')));
}
function makeRid() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return Array.from(a, (x) => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join('');    // matches ^[a-z0-9]{6,12}$
}
/* returns {text, press, hideBtn, hint}: press = the 重新分析 button is enabled; hint = "到顧問設定開啟" line */
function aiState(ai) {
  const st = ai && ai.status ? ai.status : 'off';
  const month = (ai && ai.month) || {};
  const limit = isNum(month.limit) ? month.limit : 3, used = isNum(month.manual) ? month.manual : 0;
  const made = ai && ai.result && ai.result.made_at ? md(String(ai.result.made_at).slice(0, 10)) : '';
  const left = Math.max(0, limit - used);
  switch (st) {
    case 'nokey': return { text: 'NAS 還沒有放 AI 金鑰（見待辦）', press: false };
    case 'idle': case 'done': return { text: `上次分析：${made || '—'}・本月已用 ${used}/${limit} 次`, press: left > 0, left };
    case 'queued': return { text: '已排入，下一次更新處理', press: false };
    case 'pending': return { text: `NAS 處理中，下次更新取回${ai.pending_since ? `（自 ${md(String(ai.pending_since).slice(0, 10))}）` : ''}`, press: false };
    case 'cached': return { text: `資料沒有實質變化，沿用 ${made || '上次'} 的分析`, press: left > 0, left };
    case 'failed': return { text: `這次分析沒有完成${ai.status_note ? `（${ai.status_note}）` : ''}，已改用規則文字`, press: left > 0, left };
    case 'quota': return { text: `本月 ${limit} 次已用完，${nextMonthFirst(month.ym)} 重置`, press: false };
    case 'budget': return { text: '本月 AI 預算已達上限', press: false };
    default: return { text: 'AI 解讀未開啟（目前顯示規則整理的重點）', press: false, hideBtn: true, hint: true };
  }
}
function sectionNodes(sections, metrics) {
  const out = [];
  for (const s of Array.isArray(sections) ? sections : []) {
    const parts = s && renderText(s.text, metrics);
    if (!parts) continue;
    out.push(el('div', { class: 'adv-sec' }, SEC_TITLE[s.id] ? el('h3', { class: 'adv-sech' }, SEC_TITLE[s.id]) : null, el('p', {}, parts)));
  }
  return out;
}
function blockAi(ctx) {
  const { adv, metrics } = ctx, ai = adv.ai && typeof adv.ai === 'object' ? adv.ai : null;
  const res = ai && ai.result && Array.isArray(ai.result.sections) ? ai.result : null;
  const st = ai && ai.status ? ai.status : 'off';
  const useAi = !!res && !['off', 'failed', 'nokey'].includes(st);
  let secs = useAi ? sectionNodes(res.sections, metrics) : [];
  const fromAi = secs.length > 0;
  if (!fromAi) secs = sectionNodes(adv.rule && adv.rule.sections, metrics);
  const s = aiState(ai);
  const local = localAiPending() && s.press;                    // already sent from this phone, not yet applied by the morning update
  const old = fromAi && res.made_at && -daysUntil(String(res.made_at).slice(0, 10)) > 45;
  const press = s.press && !local;
  const send = () => {
    queueCmd({ ai_request: { rid: makeRid() } }, '已排入重新分析', '明早更新時交給 NAS 分析');
  };
  const card = el('div', { class: 'card pad adv-ai' },
    el('div', { class: 'adv-ai-st' }, local ? '已送出，明早更新時交給 NAS 分析' : s.text, old ? el('span', { class: 'tag warn' }, '較舊') : null),
    secs.length ? secs : el('p', { class: 'adv-none' }, '目前沒有可顯示的文字'),
    s.hideBtn ? (s.hint ? (HOOKS.openSettings ? el('button', { class: 'adv-link', onclick: () => HOOKS.openSettings('ai', ctx) }, '到顧問設定開啟')
      : el('p', { class: 'adv-none' }, '到顧問設定開啟')) : null)
      : el('button', { class: 'btn', disabled: press ? null : true, onclick: send }, s.left != null ? `重新分析（本月還剩 ${s.left} 次）` : '重新分析'));
  return group('AI 解讀', card, { foot: fromAi ? '文字由 AI 撰寫，數字由系統計算' : '由規則整理' });
}

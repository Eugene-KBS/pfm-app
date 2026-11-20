/* 股票: holdings valued at the latest close, one-line "why it moved", a drawn long-term chart per stock. */
import { el, group, row, amt, samt, fmt, fmt2, pct, md } from './util.js';
import { openSheet } from './sheet.js';
import { S, loadPrices } from './data.js';
import { decodeSeries, priceChart, spark, RANGE_KEYS, RANGE_LABEL } from './charts.js';

const cls = (v) => (v == null ? '' : v >= 0 ? 'up' : 'down');
const pxFmt = (ccy) => (v) => (ccy === 'USD' ? (v >= 100 ? v.toFixed(1) : v.toFixed(2)) : (v >= 1000 ? Math.round(v).toLocaleString('en-US') : v >= 100 ? v.toFixed(1) : v.toFixed(2)));

export function viewStocks(app) {
  const d = S.data, live = d.stocks_live, v1 = d.stocks;
  if (!live && !v1) return [group(null, el('div', { class: 'card empty' }, '還沒有股票資料。'))];
  if (!S.prices && !app.pricesLoading) {
    app.pricesLoading = true;
    loadPrices().then(() => { app.pricesLoading = false; app.render(); });
  }
  const out = [];
  if (live) {
    const t = live.total;
    out.push(group(null, el('div', { class: 'card hero' },
      el('div', { class: 'label' }, '股票總市值', el('span', { class: 'muted tiny' }, `${md(live.as_of)} 收盤`)),
      el('div', { class: 'big' }, el('span', { class: 'cur' }, 'NT$'), el('span', { class: 'amt' }, fmt(t.value_twd))),
      el('div', { class: 'line' }, '今天 ', el('b', { class: cls(t.chg_1d) }, samt(t.chg_1d_twd, cls(t.chg_1d)), `（${pct(t.chg_1d, 2)}）`),
        '　本週 ', el('b', { class: cls(t.chg_1w) }, pct(t.chg_1w))),
      el('div', { class: 'line' }, '未實現損益 ', el('b', { class: cls(t.pnl_twd) }, samt(t.pnl_twd, cls(t.pnl_twd))), `（${pct(t.ret)}）　成本 `, amt(t.cost_twd)),
      el('div', { class: 'line tiny' }, `美股以 1 美元＝${live.fx.toFixed(2)} 元換算（${md(live.fx_date)}）。收盤價每天更新一次，不是即時報價。`
        + (live.est_any ? '標「估」的股數是定期定額扣款後、對帳單還沒到的推估。' : '')))));
    const items = live.items;
    const ser = S.prices?.series || {};
    out.push(group('持股', el('ul', { class: 'list' }, items.map((h) => {
      const pts = ser[h.key] ? decodeSeries(ser[h.key]) : null;
      const note = h.note && h.note.text ? el('span', { class: 'note1' }, h.note.text, el('span', { class: 'd' }, md(h.note.date))) : null;
      return el('li', {}, el('button', { class: 'row stock-row', onclick: () => openStock(h) },
        el('span', { class: 'main' }, el('span', { class: 't' }, h.name, el('span', { class: 'tag' }, h.code), h.shares_est ? el('span', { class: 'tag warn' }, '估') : null),
          el('span', { class: 's' }, `${qty(h.shares)} 股　損益 `, samt(h.pnl_twd, cls(h.pnl_twd)), `（${pct(h.ret)}）`), note),
        pts ? spark(pts, (h.chg_1w ?? 0) >= 0) : null,
        el('span', { class: 'v' }, amt(h.value_twd), el('small', { class: 'chg ' + cls(h.chg_1d) }, `今 ${pct(h.chg_1d, 2)}`))));
    })), { foot: '一句話：平日只寫當天漲跌超過門檻的，週六每檔各寫一句本週。依新聞標題整理，不是買賣建議。' }));
  } else if (v1) {
    out.push(group(null, el('div', { class: 'card hero' }, el('div', { class: 'label' }, '股票總市值（券商截圖）'),
      el('div', { class: 'big' }, el('span', { class: 'cur' }, 'NT$'), el('span', { class: 'amt' }, fmt(v1.total.value_twd))),
      el('div', { class: 'line' }, '未實現損益 ', samt(v1.total.pnl_twd, cls(v1.total.pnl_twd)), `（${pct(v1.total.ret)}）`),
      el('div', { class: 'line tiny' }, `${md(v1.as_of)} 收盤。每日收盤價還沒接上。`))));
  }
  if (v1 && v1.dca && v1.dca.length) {
    const missed = v1.missed_dca || [];
    out.push(group('定期定額', el('ul', { class: 'list' }, v1.dca.map((p) => row({ title: p.name, sub: `每月 ${p.day} 日　${p.market === 'US' ? '美股' : '台股'}`,
      value: el('span', { class: 'amt' }, (p.ccy === 'USD' ? 'US$ ' : '') + fmt(p.amount)) }))),
    { foot: `每月合計 NT$ ${fmt(v1.dca_month.TWD)}＋US$ ${fmt(v1.dca_month.USD)}。` + (missed.length ? `${[...new Set(missed.map((x) => +x.ym.slice(5) + ' 月'))].join('、')}有 ${missed.length} 筆沒成交（扣款日前證券戶餘額不夠會跳過）。` : '') }));
  }
  if (v1) {
    const f = v1.min_fee;
    out.push(group('其他', el('dl', { class: 'kv card' },
      el('dt', {}, '近 12 個月已領股利'), el('dd', {}, amt(v1.dividends_twd_12m)),
      f ? [el('dt', {}, `付最低手續費的美股單（${f.n} 筆）`), el('dd', {}, `US$ ${fmt(f.fee_usd)}（${f.pct}%）`)] : null)));
  }
  return out;
}
const qty = (n) => (Number.isInteger(n) ? fmt(n) : String(Math.round(n * 1e4) / 1e4));

function openStock(h) {
  const st = { range: '1Y' };
  const tip = el('div', { class: 'chart-tip' });
  const chartBox = el('div', {});
  const seg = el('div', { class: 'seg ranges' });
  const fp = pxFmt(h.ccy);
  const drawChart = () => {
    seg.replaceChildren(...RANGE_KEYS.map((k) => el('button', { 'aria-pressed': String(st.range === k), onclick: () => { st.range = k; drawChart(); } }, RANGE_LABEL[k])));
    const s = S.prices?.series?.[h.key];
    if (!s) { chartBox.replaceChildren(el('p', { class: 'empty' }, S.prices ? '這檔還沒有歷史價格。' : '載入價格中…')); tip.textContent = ''; return; }
    chartBox.replaceChildren(priceChart(decodeSeries(s), st.range, h, fp, tip));
  };
  const sh = openSheet({ title: h.name, body: () => [
    el('div', { class: 'card hero stock-head' },
      el('div', { class: 'label' }, h.code, h.mkt === 'US' ? '　美股' : '　台股', el('span', { class: 'muted tiny' }, `${md(h.px_date)} 收盤`)),
      el('div', { class: 'px' }, (h.ccy === 'USD' ? 'US$ ' : '') + fp(h.px)),
      el('div', { class: 'line' }, '今天 ', el('b', { class: cls(h.chg_1d) }, pct(h.chg_1d, 2)), '　本週 ', el('b', { class: cls(h.chg_1w) }, pct(h.chg_1w, 2))),
      seg, chartBox, tip),
    h.note && h.note.text ? group('為什麼動', el('div', { class: 'card' }, el('p', { class: 'para' }, h.note.text), el('p', { class: 'para muted tiny' }, md(h.note.date) + (h.note.src_title ? '　' + h.note.src_title : '')))) : null,
    group('持股', el('dl', { class: 'kv card' },
      el('dt', {}, '股數'), el('dd', {}, qty(h.shares) + (h.shares_est ? `（含估 ${qty(h.shares_est)}）` : '')),
      el('dt', {}, '平均成本'), el('dd', {}, (h.ccy === 'USD' ? 'US$ ' : '') + fp(h.avg_cost)),
      el('dt', {}, '市值'), el('dd', {}, amt(h.value_twd), h.ccy === 'USD' ? el('span', { class: 'muted sm' }, `（US$ ${fmt2(h.value_ccy)}）`) : null),
      el('dt', {}, '投入成本'), el('dd', {}, amt(h.cost_twd)),
      el('dt', {}, '未實現損益'), el('dd', { class: cls(h.pnl_twd) }, samt(h.pnl_twd, cls(h.pnl_twd)), `（${pct(h.ret)}）`),
      el('dt', {}, '買進紀錄'), el('dd', {}, `${(h.buys || []).length} 筆`),
      (h.divs || []).length ? [el('dt', {}, '配息'), el('dd', {}, `${h.divs.length} 次，共 NT$ ${fmt(h.divs.reduce((s, x) => s + x[1], 0))}`)] : null)),
    (h.notes || []).length > 1 ? group('最近的摘要', el('ul', { class: 'list' }, h.notes.slice(0, 8).map((n) =>
      row({ title: n.text, sub: `${md(n.date)}　${n.kind === 'weekly' ? '週摘要' : (n.chg >= 0 ? '+' : '') + n.chg + '%'}`, wrapSub: true })))) : null,
    group(null, el('div', { class: 'card' }, el('a', { class: 'tv', href: `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(h.tv)}`, target: '_blank', rel: 'noopener noreferrer' }, '在 TradingView 開啟'))),
  ] });
  drawChart();
  if (!S.prices) loadPrices().then(() => { if (document.body.contains(sh.el)) drawChart(); });
}

/* 收支帳 v2 — app shell. No personal data in this repository; data arrives encrypted and is decrypted on the phone. */
import { el, icon, IC, toast, md, stamp } from './util.js';
import { S, LS, VERSION, onChange, loadCached, refresh, loadDemo, trySetup, keys, flush, checkPushKey } from './data.js';
import { store } from './util.js';
import { viewOverview } from './overview.js';
import { viewTx } from './tx.js';
import { viewStocks } from './stocks.js';
import { viewPlan } from './plan.js';
import { viewAdvisor } from './advisor.js';
import './advisor_settings.js';
import { viewSettings, applyUi } from './settings.js';
import { visibleTodos, openTodo, openTx, txById } from './actions.js';
import { closeAllSheets } from './sheet.js';

const root = document.getElementById('app');
const TABS = [
  ['home', '總覽', IC.home, viewOverview],
  ['tx', '明細', IC.list, viewTx],
  ['stocks', '股票', IC.chart, viewStocks],
  ['plan', '計畫', IC.cal, viewPlan],
  ['advisor', '顧問', IC.advisor, viewAdvisor],
  ['settings', '設定', IC.gear, viewSettings],
];
const app = {
  tab: 'home', sel: null, tx: { f: 'spend', ym: null, q: '', cat: null }, pages: {}, scroll: {}, setup: false, updateReady: null,
  render, goTx(f) { Object.assign(app.tx, { ym: f.ym, cat: f.cat || null, q: '', f: 'spend' }); switchTab('tx'); },
  showSetup() { app.setup = true; closeAllSheets(); render(); },
  checkUpdate,
};

/* ------------------------------------------------------------ zoom & web-page feel off */
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
let lastTouch = 0;
document.addEventListener('touchend', (e) => {
  const now = Date.now();
  if (now - lastTouch < 300 && !e.target.closest('input, textarea')) e.preventDefault();
  lastTouch = now;
}, { passive: false });
document.addEventListener('contextmenu', (e) => { if (!e.target.closest('.selectable, input, textarea')) e.preventDefault(); });

/* ------------------------------------------------------------ render */
function navbar(title, sub) {
  return el('div', { class: 'navbar' }, el('h1', {}, el('span', { class: 'sub' }, sub || ''), title),
    el('div', { class: 'nav-actions' },
      el('button', { class: 'icon-btn', 'aria-label': S.ui.hide ? '顯示金額' : '隱藏金額', 'aria-pressed': String(!!S.ui.hide),
        onclick: () => { S.ui.hide = !S.ui.hide; store.setJson(LS.prefs, S.ui); applyUi(); render(); } }, icon(S.ui.hide ? IC.eyeOff : IC.eye)),
      !S.demo ? el('button', { class: 'icon-btn' + (S.busy ? ' spin' : ''), 'aria-label': '重新整理', onclick: () => refresh(true) }, icon(IC.refresh)) : null));
}
function banner() {
  const b = S.demo ? { text: '這是示範資料，不是你的帳。', demo: true } : S.banner;
  const items = [];
  if (app.updateReady) items.push(el('div', { class: 'banner' }, el('span', {}, '有新版本'), el('button', { onclick: () => applyUpdate() }, '更新')));
  if (S.data && S.data.meta && S.data.meta.app_min && cmpVer(VERSION, S.data.meta.app_min) < 0) items.push(el('div', { class: 'banner err' }, el('span', {}, '資料需要較新的 app，請更新。'), el('button', { onclick: () => checkUpdate(true) }, '更新')));
  if (b) items.push(el('div', { class: 'banner' + (b.err ? ' err' : '') }, el('span', {}, b.text),
    b.demo ? el('button', { onclick: () => app.showSetup() }, '輸入設定碼') : b.fix ? el('button', { onclick: () => app.showSetup() }, '去設定') : b.retry ? el('button', { onclick: () => refresh(true) }, '再試一次') : null));
  return items;
}
const cmpVer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };

function titleFor(tab) {
  const d = S.data;
  if (tab === 'home') return [`${+d.month_now.ym.slice(5)} 月`, `資料至 ${md(d.meta?.data_through || d.data_through)}`];
  if (tab === 'tx') return ['明細', `${d.tx.length.toLocaleString()} 筆交易`];
  if (tab === 'stocks') return ['股票', d.stocks_live ? `${md(d.stocks_live.as_of)} 收盤` : ''];
  if (tab === 'plan') return ['計畫', '補錢、現金流、訂閱、月結'];
  if (tab === 'advisor') return ['顧問', d.advisor && d.advisor.as_of ? `資料至 ${md(d.advisor.as_of)}` : ''];
  return ['設定', `版本 ${VERSION}`];
}

let renderOpts = {};
function render(opts) {
  renderOpts = opts || {};
  if (app.setup || (!S.data && !keys() && !S.demo)) { root.replaceChildren(viewSetup()); return; }
  if (!S.data) {
    root.replaceChildren(el('main', { class: 'page' }, S.banner && S.banner.err
      ? [el('h1', {}, '收支帳'), el('p', { class: 'error' }, S.banner.text), el('button', { class: 'btn', onclick: () => refresh(true) }, '再試一次'),
        el('button', { class: 'btn gray', onclick: () => app.showSetup() }, '重新貼設定碼或金鑰')]
      : el('p', { class: 'loading' }, '讀取資料中…')));
    return;
  }
  if (!S.data.meta) {
    root.replaceChildren(el('main', { class: 'page' }, el('h1', {}, '收支帳'),
      el('p', { class: 'note' }, '這份資料還是舊格式（v1）。新版的資料會在下一次每日更新（每天 05:37）後出現；在那之前請先用原本的 app。'),
      el('button', { class: 'btn', onclick: () => refresh(true) }, '重新整理')));
    return;
  }
  let frame = root.querySelector('.frame');
  if (!frame) {
    frame = el('div', { class: 'frame' });
    for (const [k] of TABS) { app.pages[k] = el('main', { class: 'page', hidden: k !== app.tab ? true : null, 'data-tab': k }); frame.append(app.pages[k]); }
    frame.append(tabbar());
    root.replaceChildren(frame);
  }
  const focus = renderOpts.keepFocus ? document.activeElement : null;
  const sel = focus && focus.selectionStart;
  for (const [k, , , view] of TABS) {
    if (k !== app.tab && app.pages[k].dataset.ready && !renderOpts.all) { app.pages[k].dataset.stale = '1'; continue; }
    drawPage(k, view);
  }
  updateTabbar();
  if (focus && focus.tagName === 'INPUT') {
    const n = app.pages[app.tab].querySelector('input[type="search"]');
    if (n) { n.focus(); try { n.setSelectionRange(sel, sel); } catch (e) { /* ignore */ } }
  }
  setBadge();
}
function drawPage(k, view) {
  const [t, sub] = titleFor(k);
  let body;
  try { body = view(app); } catch (e) { console.error(e); body = [el('p', { class: 'note' }, '這一頁顯示時出了問題：' + e.message)]; }
  app.pages[k].replaceChildren(navbar(t, sub), ...banner(), ...[].concat(body).filter(Boolean));
  app.pages[k].dataset.ready = '1';
  delete app.pages[k].dataset.stale;
}
function tabbar() {
  return el('nav', { class: 'tabbar', role: 'tablist' }, TABS.map(([k, n, ic]) => el('button', { role: 'tab', 'data-k': k, 'aria-selected': String(app.tab === k),
    onclick: () => { if (app.tab === k) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; } switchTab(k); } }, icon(ic), el('span', {}, n),
  k === 'home' ? el('span', { class: 'badge', hidden: true }) : null)));
}
function updateTabbar() {
  const n = visibleTodos().length;
  document.querySelectorAll('.tabbar button').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.k === app.tab));
    const bd = b.querySelector('.badge');
    if (bd) { bd.hidden = !n; bd.textContent = n > 99 ? '99+' : String(n); }
  });
}
function switchTab(k) {
  app.scroll[app.tab] = window.scrollY;
  app.pages[app.tab].hidden = true;
  app.tab = k;
  const p = app.pages[k];
  if (!p.dataset.ready || p.dataset.stale || k === 'tx') drawPage(k, TABS.find((t) => t[0] === k)[3]);
  p.hidden = false;
  window.scrollTo(0, app.scroll[k] || 0);
  updateTabbar();
}
function setBadge() {
  try { if ('setAppBadge' in navigator) { const n = visibleTodos().length; n ? navigator.setAppBadge(n) : navigator.clearAppBadge(); } } catch (e) { /* unsupported */ }
}

/* ------------------------------------------------------------ setup */
function viewSetup() {
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const code = el('textarea', { autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'PFM1.…', value: store.get(LS.setup) || '' });
  const tok = el('input', { type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'github_pat_…', value: store.get(LS.token) || '' });
  const err = el('p', { class: 'error', role: 'alert' });
  const btn = el('button', { class: 'btn', type: 'submit' }, '完成設定');
  const go = async (e) => {
    e.preventDefault();
    err.textContent = '';
    if (!tok.value.trim()) { err.textContent = '請貼上 GitHub 金鑰。'; return; }
    btn.disabled = true; btn.textContent = '檢查中…';
    try { await trySetup(code.value, tok.value); app.setup = false; S.banner = null; root.replaceChildren(); render(); flush(); }
    catch (e2) { err.textContent = e2.message || '設定失敗'; btn.disabled = false; btn.textContent = '完成設定'; }
  };
  return el('main', { class: 'page setup' },
    el('h1', {}, '收支帳'),
    el('p', { class: 'lead' }, '帳務資料加密後放在私人 repo，只有這支裝置上的設定碼解得開。貼上兩樣東西就能開始。'),
    ios && !standalone ? el('p', { class: 'note' }, '先把這一頁加到主畫面（分享 → 加入主畫面），再從主畫面打開來設定；Safari 和主畫面 app 的儲存空間是分開的。') : null,
    el('form', { onsubmit: go },
      el('label', {}, '設定碼（Claude 給你的，以 PFM1. 開頭）'), code,
      el('label', {}, 'GitHub 金鑰（Contents 唯讀＋Issues 讀寫）'), tok, err, btn),
    el('button', { class: 'btn gray', onclick: () => { app.setup = false; loadDemo(); } }, '先看示範資料'),
    keys() && S.data ? el('button', { class: 'btn gray', onclick: () => { app.setup = false; root.replaceChildren(); render(); } }, '取消') : null,
    el('p', { class: 'muted tiny', style: { textAlign: 'center', marginTop: '18px' } }, `版本 ${VERSION}。設定碼和金鑰只存在這支裝置上。`));
}

/* ------------------------------------------------------------ service worker / updates */
let reg = null;
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    reg = await navigator.serviceWorker.register('sw.js');
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw && nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) setTimeout(() => { if (reg.waiting) { app.updateReady = reg.waiting; render({ all: true }); } }, 1500); });
    });
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.go) handleGo(e.data.go); });
  } catch (e) { /* offline first load */ }
}
async function checkUpdate(manual) {
  if (!reg) { if (manual) toast('這個瀏覽器沒有啟用離線功能'); return; }
  try { await reg.update(); } catch (e) { /* offline */ }
  if (reg.waiting) { app.updateReady = reg.waiting; render({ all: true }); if (manual) toast('有新版本'); }
  else if (manual) toast(`已是最新版本 ${VERSION}`);
}
function applyUpdate() {
  const w = app.updateReady || (reg && reg.waiting);
  if (!w) { location.reload(); return; }
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  w.postMessage({ type: 'skip' });
}

/* ------------------------------------------------------------ deep links from notifications (?go=…) */
function handleGo(go) {
  if (!go || !S.data) return;
  closeAllSheets();
  if (go.startsWith('tx:')) { const t = txById(go.slice(3)); if (t) { switchTab('tx'); openTx(t, render); } return; }
  if (go === 'weekly') { switchTab('plan'); return; }
  if (go === 'overview') { switchTab('home'); return; }
  const t = (S.data.todo || []).find((x) => x.id === go);
  switchTab('home');
  if (t) openTodo(t, render);
}

/* ------------------------------------------------------------ boot */
onChange((what) => {
  if (what === 'busy') { const b = document.querySelector('.page:not([hidden]) .nav-actions .icon-btn:last-child'); if (b) b.classList.toggle('spin', S.busy); return; }
  render(what === 'data' ? { all: true } : {});
});
window.addEventListener('online', () => flush());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !S.data || S.demo) return;
  if (!S.fetched || Date.now() - new Date(S.fetched).getTime() > 15 * 60 * 1000) refresh(false);
  flush();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyUi);

(async function boot() {
  applyUi();
  registerSW();
  const go = new URLSearchParams(location.search).get('go');
  if (go) history.replaceState(null, '', location.pathname);
  if (store.get(LS.demo) === '1') { await loadDemo(); if (go) handleGo(go); return; }
  if (!keys()) { render(); return; }
  await loadCached();
  render({ all: true });
  if (go) handleGo(go);
  await refresh(false);
  if (go && S.data) handleGo(go);
  checkPushKey();
  flush();
})();
export { stamp };

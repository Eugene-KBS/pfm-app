/* Data layer: fetch + decrypt the snapshot, prices, the write-back queue (GitHub Issues) and push subscription. */
import { store, toast } from './util.js';
import { parseSetup, decryptEnvelope, sealCommands, b64u, b64uEnc } from './crypto.js';

export const VERSION = '2.0.0';
export const LS = {
  token: 'pfm.token', setup: 'pfm.setup',                     // shared with v1: no new setup after the switch
  env: 'pfm2.env', fetched: 'pfm2.fetched', penv: 'pfm2.penv', prefs: 'pfm2.ui', queue: 'pfm2.queue', dev: 'pfm2.dev',
  seq: 'pfm2.seq', vapid: 'pfm2.vapid', demo: 'pfm2.demo',
};
export const S = {
  data: null, prices: null, demo: false, busy: false, banner: null, fetched: null,
  ui: Object.assign({ theme: 'auto', fs: 'm', hide: false, stockColor: 'tw', cards: ['todo', 'balance', 'daily', 'months', 'cash', 'weekly'], hidden: [] },
    store.json(LS.prefs, {})),
  queue: store.json(LS.queue, []),            // [{seq, ts, cmds, sent, issue}]
  listeners: [],
};
export function saveUi() { store.setJson(LS.prefs, S.ui); }
export function onChange(fn) { S.listeners.push(fn); }
function changed(what) { for (const f of S.listeners) f(what); }

class AppError extends Error { constructor(kind, msg) { super(msg); this.kind = kind; } }

async function ghGet(path, token, raw = true) {
  let res;
  try {
    res = await fetch(`https://api.github.com/${path}`, {
      headers: { Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', Authorization: 'Bearer ' + token }, cache: 'no-store' });
  } catch (e) { throw new AppError('offline', '連不上網路'); }
  if (res.status === 401) throw new AppError('auth', 'GitHub 金鑰無效或已過期，請到「設定 → 連線」重新貼上。');
  if (res.status === 404) throw new AppError('auth', '讀不到資料檔：GitHub 金鑰沒有資料 repo 的讀取權限，或資料還沒發布。');
  if (res.status === 403 || res.status === 429) throw new AppError('limit', 'GitHub 暫時拒絕讀取（次數上限或權限不足），稍後再試。');
  if (!res.ok) throw new AppError('http', `GitHub 回應 ${res.status}，稍後再試。`);
  return res.text();
}
async function openEnv(text, setup) {
  let env;
  try { env = JSON.parse(text); } catch (e) { throw new AppError('format', '資料檔格式不對。'); }
  try { return await decryptEnvelope(env, setup); } catch (e) { throw new AppError('key', '設定碼解不開這份資料（可能已換新金鑰），請到設定重新貼上設定碼。'); }
}
export function keys() {
  const token = store.get(LS.token), code = store.get(LS.setup);
  if (!token || !code) return null;
  try { return { token, setup: parseSetup(code) }; } catch (e) { return null; }
}
export async function trySetup(code, token) {
  const setup = parseSetup(code);
  const text = await ghGet(`repos/${setup.r}/contents/app/data.enc.json`, token);
  const data = await openEnv(text, setup);
  store.set(LS.setup, code.replace(/\s+/g, '')); store.set(LS.token, token.trim()); store.set(LS.env, text);
  store.del(LS.demo);
  S.demo = false; S.data = data; S.fetched = new Date().toISOString(); store.set(LS.fetched, S.fetched);
  reconcileQueue();
  changed('data');
}
export async function loadCached() {
  const k = keys(), cached = store.get(LS.env);
  S.fetched = store.get(LS.fetched);
  if (k && cached) { try { S.data = await openEnv(cached, k.setup); reconcileQueue(); } catch (e) { /* refetch */ } }
}
export async function refresh(manual) {
  if (S.demo || S.busy) return;
  const k = keys();
  if (!k) return;
  S.busy = true; changed('busy');
  try {
    const text = await ghGet(`repos/${k.setup.r}/contents/app/data.enc.json`, k.token);
    S.data = await openEnv(text, k.setup);
    store.set(LS.env, text);
    S.fetched = new Date().toISOString(); store.set(LS.fetched, S.fetched);
    S.banner = null;
    reconcileQueue();
    if (S.prices && S.prices._gen !== S.data.meta?.generated_at) S.prices = null;   // reload lazily
    if (manual) toast('已更新');
  } catch (e) {
    if (e.kind === 'offline' && S.data) S.banner = { text: '離線中，顯示的是先前取得的資料。', retry: true };
    else S.banner = { err: true, text: e.message || '更新失敗', retry: e.kind !== 'auth' && e.kind !== 'key', fix: e.kind === 'auth' || e.kind === 'key' };
  }
  S.busy = false;
  changed('data');
  flush();
}
export async function loadPrices() {
  if (S.prices) return S.prices;
  if (S.demo) {
    try { S.prices = await (await fetch('demo-prices.json', { cache: 'no-store' })).json(); } catch (e) { S.prices = { series: {} }; }
    return S.prices;
  }
  const k = keys();
  if (!k) return null;
  const cached = store.get(LS.penv);
  try {
    const text = await ghGet(`repos/${k.setup.r}/contents/app/prices.enc.json`, k.token);
    S.prices = await openEnv(text, k.setup);
    store.set(LS.penv, text);
  } catch (e) {
    if (cached) { try { S.prices = await openEnv(cached, k.setup); } catch (e2) { S.prices = null; } }
  }
  if (S.prices) S.prices._gen = S.data?.meta?.generated_at;
  return S.prices;
}
export async function loadDemo() {
  S.demo = true; store.set(LS.demo, '1');
  try { S.data = await (await fetch('demo-data.json', { cache: 'no-store' })).json(); } catch (e) { S.banner = { err: true, text: '示範資料讀不到。' }; }
  S.prices = null;
  changed('data');
}
export function leaveDemo() { S.demo = false; store.del(LS.demo); S.data = null; S.prices = null; changed('data'); }
export function signOut() {
  for (const k of Object.values(LS)) store.del(k);
  S.data = null; S.prices = null; S.queue = []; changed('data');
}

/* ------------------------------------------------------------ write-back queue */
function dev() {
  let d = store.get(LS.dev);
  if (!d) { d = b64uEnc(crypto.getRandomValues(new Uint8Array(9))); store.set(LS.dev, d); }
  return d;
}
function nextSeq() { const n = (+store.get(LS.seq) || 0) + 1; store.set(LS.seq, String(n)); return n; }
function saveQueue() { store.setJson(LS.queue, S.queue); }
let flushT = null;
export function queueCmd(cmd, label) {
  let batch = S.queue.find((b) => !b.sent);
  if (!batch) { batch = { seq: nextSeq(), ts: new Date().toISOString(), cmds: [], sent: false }; S.queue.push(batch); }
  batch.cmds.push(cmd);
  saveQueue();
  changed('queue');
  if (label) toast(label + (S.demo ? '（示範模式不會送出）' : '　明早更新後生效'));
  clearTimeout(flushT);
  flushT = setTimeout(flush, 1500);
}
export async function flush() {
  const batch = S.queue.find((b) => !b.sent && b.cmds.length);
  if (!batch || S.flushing) return;
  if (S.demo) { batch.sent = true; batch.issue = 0; saveQueue(); changed('queue'); return; }
  const k = keys(), inbox = S.data?.inbox;
  if (!k || !inbox?.key) return;
  S.flushing = true;
  try {
    const body = await sealCommands({ v: 1, ts: batch.ts, seq: batch.seq, dev: dev(), cmds: batch.cmds }, inbox.key);
    const res = await fetch(`https://api.github.com/repos/${inbox.repo || k.setup.r}/issues`, {
      method: 'POST', headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + k.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `pfm-cmd ${batch.ts}`, body }) });
    if (res.status === 201) {
      const j = await res.json().catch(() => ({}));
      batch.sent = true; batch.issue = j.number || 0; saveQueue();
      S.writeErr = null;
    } else if ([401, 403, 404].includes(res.status)) {
      S.writeErr = 'GitHub 金鑰沒有 Issues 寫入權限：到 GitHub 金鑰設定加開「Issues：Read and write」，回 app 按「回寫權限檢查」。';
    } else {
      S.writeErr = `送出失敗（GitHub ${res.status}），下次開啟會再試。`;
    }
  } catch (e) { S.writeErr = '離線中，操作已排隊，連上網路後自動送出。'; }
  S.flushing = false;
  changed('queue');
  if (S.queue.some((b) => !b.sent && b.cmds.length) && !S.writeErr) setTimeout(flush, 500);
}
/* Drop batches the pipeline has applied (snapshot.inbox.applied[dev] >= seq). */
export function reconcileQueue() {
  const applied = (S.data?.inbox?.applied || {})[store.get(LS.dev) || ''] || 0;
  const before = S.queue.length;
  S.queue = S.queue.filter((b) => !(b.sent && b.seq <= applied));
  if (S.queue.length !== before) saveQueue();
}
/* What the not-yet-applied commands change, so the screen reflects them at once. */
export function pendingView() {
  const v = { todo: new Set(), cls: {}, flag: {}, answered: new Set(), set: {} };
  for (const b of S.queue) {
    for (const c of b.cmds) {
      const [op, a] = Object.entries(c)[0];
      if (op === 'done' || op === 'snooze') v.todo.add(a.todo_id);
      else if (op === 'classify') { v.cls[a.txn_id] = a; v.todo.add('classify:' + a.txn_id); }
      else if (op === 'flag') v.flag[a.txn_id] = Object.assign(v.flag[a.txn_id] || {}, a);
      else if (op === 'answer') { v.answered.add(a.key); v.todo.add('question:' + a.key); }
      else if (op === 'set') v.set[a.k] = a.v;
    }
  }
  return v;
}
export function pendingCount() { return S.queue.reduce((n, b) => n + b.cmds.length, 0); }
export function unsentCount() { return S.queue.filter((b) => !b.sent).reduce((n, b) => n + b.cmds.length, 0); }
export function pref(k) {
  const pv = pendingView().set;
  if (k in pv) return pv[k];
  const p = S.data?.prefs || {};
  if (k.startsWith('notify.')) return (p.notify || {})[k.slice(7)] !== false;
  return p[k];
}

/* ------------------------------------------------------------ push */
export function pushSupport() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return { ok: false, why: ios && !standalone ? '先把 app 加到主畫面，並從主畫面打開，才能開啟通知（iOS 16.4 以上）。' : '這個瀏覽器不支援網頁通知。' };
  }
  if (ios && !standalone) return { ok: false, why: '請從主畫面的圖示打開 app 再開啟通知。' };
  return { ok: true, perm: Notification.permission };
}
export async function enablePush() {
  const sup = pushSupport();
  if (!sup.ok) throw new Error(sup.why);
  const vapid = S.data?.push?.vapid_public;
  if (!vapid) throw new Error('資料裡還沒有通知金鑰，等明早更新後再試。');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('通知權限沒有開啟（可到 iPhone 設定 → 通知 → 收支帳 打開）。');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && store.get(LS.vapid) !== vapid) { try { await sub.unsubscribe(); } catch (e) { /* ignore */ } sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(vapid) });
  store.set(LS.vapid, vapid);
  const j = sub.toJSON();
  queueCmd({ push_sub: { sub: { endpoint: j.endpoint, keys: j.keys, vapid: vapid.slice(0, 16) } } }, '已開啟通知');
}
export async function disablePush() {
  try { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); if (sub) await sub.unsubscribe(); } catch (e) { /* ignore */ }
  store.del(LS.vapid);
  queueCmd({ push_unsub: {} }, '已關閉通知');
}
/* The pipeline may rotate the VAPID key (e.g. after a full restore): resubscribe quietly. */
export async function checkPushKey() {
  if (S.demo || !S.data?.push?.vapid_public || !store.get(LS.vapid)) return;
  if (store.get(LS.vapid) === S.data.push.vapid_public) return;
  if (pushSupport().ok && Notification.permission === 'granted') { try { await enablePush(); } catch (e) { /* shown in settings */ } }
}
export async function checkWrite() {
  if (S.demo) return '示範模式不會連線。';
  const k = keys(), inbox = S.data?.inbox;
  if (!k || !inbox?.key) return '還沒設定好，或資料裡沒有回寫金鑰。';
  queueCmd({ set: { k: 'notify_amounts', v: pref('notify_amounts') !== false } });
  await flush();
  return S.writeErr ? S.writeErr : '回寫正常：GitHub 已收到測試指令，明早更新時會處理掉。';
}

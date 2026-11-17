/* 收支帳 — app shell. No personal data lives in this file or this repository.
   Data arrives encrypted from a private repository and is decrypted on this device only. */
(() => {
  'use strict';
  const VERSION = '1.0.0';
  const LS = { token: 'pfm.token', setup: 'pfm.setup', env: 'pfm.env', fetched: 'pfm.fetched', hide: 'pfm.hide', demo: 'pfm.demo' };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  const S = { data: null, tab: 'home', hide: store.get(LS.hide) === '1', demo: false, banner: null, busy: false,
              txFilter: 'spend', trendSel: null, fetched: null };
  const root = document.getElementById('app');

  // ---------------------------------------------------------------- tiny DOM helpers (textContent only — never innerHTML)
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat(3)) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  }
  const NS = 'http://www.w3.org/2000/svg';
  function sv(tag, attrs, ...kids) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null && v !== false) n.setAttribute(k, v);
    for (const k of kids.flat(3)) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  }
  const fmt = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));
  const amt = (n, cls) => el('span', { class: 'amt num' + (cls ? ' ' + cls : '') }, fmt(n));
  const wan = (n) => { const w = n / 10000; return (w >= 10 || Number.isInteger(w) ? Math.round(w) : Math.round(w * 10) / 10) + ' 萬'; };
  const md = (iso) => `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}`;
  const ymLabel = (ym) => `${ym.slice(0, 4)} 年 ${+ym.slice(5)} 月`;
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  const icon = (d) => sv('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, sv('path', { d }));
  const IC = {
    eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7zm10 3a3 3 0 100-6 3 3 0 000 6z',
    eyeOff: 'M3 3l18 18M10.6 5.1A9.7 9.7 0 0112 5c6.4 0 10 7 10 7a17 17 0 01-3.2 4M6.5 6.6A17 17 0 002 12s3.6 7 10 7a9.6 9.6 0 004.3-1',
    gear: 'M12 15.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM19.4 13a7.6 7.6 0 000-2l2-1.5-2-3.4-2.3 1a7.6 7.6 0 00-1.8-1L15 3.5h-4l-.4 2.5a7.6 7.6 0 00-1.7 1l-2.4-1-2 3.5 2 1.5a7.6 7.6 0 000 2l-2 1.5 2 3.4 2.4-1a7.6 7.6 0 001.7 1l.4 2.6h4l.3-2.6a7.6 7.6 0 001.8-1l2.3 1 2-3.4z',
  };

  // ---------------------------------------------------------------- crypto (WebCrypto only)
  function b64u(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  function parseSetup(code) {
    code = (code || '').replace(/\s+/g, '');
    if (!code.startsWith('PFM1.')) throw new Error('設定碼要以 PFM1. 開頭，請整段重新貼上。');
    let j;
    try { j = JSON.parse(new TextDecoder().decode(b64u(code.slice(5)))); } catch (e) { throw new Error('設定碼不完整，請整段重新貼上。'); }
    if (!j.r || !j.k) throw new Error('設定碼不完整，請整段重新貼上。');
    return j;
  }
  async function decryptEnvelope(env, setup) {
    const AAD = new TextEncoder().encode('pfm-app-v1');
    const ecdh = { name: 'ECDH', namedCurve: 'P-256' };
    const priv = await crypto.subtle.importKey('pkcs8', b64u(setup.k), ecdh, false, ['deriveBits']);
    const epkRaw = b64u(env.epk);
    const epk = await crypto.subtle.importKey('raw', epkRaw, ecdh, false, []);
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: epk }, priv, 256);
    const hk = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: epkRaw, info: AAD }, hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64u(env.iv), additionalData: AAD }, key, b64u(env.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  }

  // ---------------------------------------------------------------- data loading
  class AppError extends Error { constructor(kind, msg) { super(msg); this.kind = kind; } }
  async function fetchEnvelope(setup, token) {
    let res;
    try {
      res = await fetch(`https://api.github.com/repos/${setup.r}/contents/app/data.enc.json`, {
        headers: { Accept: 'application/vnd.github.raw+json', Authorization: 'Bearer ' + token }, cache: 'no-store' });
    } catch (e) { throw new AppError('offline', '連不上網路'); }
    if (res.status === 401) throw new AppError('auth', 'GitHub 金鑰無效或已過期，請到設定重新貼上。');
    if (res.status === 404) throw new AppError('auth', '讀不到資料檔：GitHub 金鑰沒有資料 repo 的讀取權限，或資料還沒發布。');
    if (res.status === 403 || res.status === 429) throw new AppError('limit', 'GitHub 暫時拒絕讀取（次數上限或權限不足），稍後再試。');
    if (!res.ok) throw new AppError('http', `GitHub 回應 ${res.status}，稍後再試。`);
    return res.text();
  }
  async function useEnvelope(text, setup) {
    let env;
    try { env = JSON.parse(text); } catch (e) { throw new AppError('format', '資料檔格式不對。'); }
    try { return await decryptEnvelope(env, setup); }
    catch (e) { throw new AppError('key', '設定碼解不開這份資料（可能已換新金鑰），請到設定重新貼上設定碼。'); }
  }
  async function refresh(manual) {
    if (S.demo || S.busy) return;
    const token = store.get(LS.token), code = store.get(LS.setup);
    if (!token || !code) return;
    let setup;
    try { setup = parseSetup(code); } catch (e) { S.banner = { err: true, text: e.message }; return render(); }
    S.busy = true;
    if (manual) { S.banner = { text: '更新中…' }; render(); }
    try {
      const text = await fetchEnvelope(setup, token);
      S.data = await useEnvelope(text, setup);
      store.set(LS.env, text);
      S.fetched = new Date().toISOString();
      store.set(LS.fetched, S.fetched);
      S.banner = null;
    } catch (e) {
      if (e.kind === 'offline' && S.data) S.banner = { text: `離線中，顯示的是 ${stamp(S.fetched)} 取得的資料。`, retry: true };
      else S.banner = { err: true, text: e.message || '更新失敗', retry: e.kind !== 'auth' && e.kind !== 'key', fix: e.kind === 'auth' || e.kind === 'key' };
    }
    S.busy = false;
    render();
  }
  function stamp(iso) {
    if (!iso) return '先前';
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  async function boot() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    document.body.classList.toggle('hide', S.hide);
    if (store.get(LS.demo) === '1') return loadDemo();
    const token = store.get(LS.token), code = store.get(LS.setup), cached = store.get(LS.env);
    if (!token || !code) return render();
    S.fetched = store.get(LS.fetched);
    if (cached) { try { S.data = await useEnvelope(cached, parseSetup(code)); } catch (e) { /* refetch below */ } }
    render();
    refresh(false);
  }
  async function loadDemo() {
    S.demo = true;
    try { S.data = await (await fetch('demo-data.json', { cache: 'no-store' })).json(); }
    catch (e) { S.banner = { err: true, text: '示範資料讀不到。' }; }
    render();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !S.data || S.demo) return;
    if (!S.fetched || Date.now() - new Date(S.fetched).getTime() > 20 * 60 * 1000) refresh(false);
  });

  // ---------------------------------------------------------------- charts
  function tipBox() { return el('div', { class: 'tip', hidden: true, role: 'status' }); }
  function placeTip(tip, wrap, xFrac, lines) {
    tip.replaceChildren(...lines.flatMap((l, i) => (i ? [el('br'), l] : [l])));
    tip.hidden = false;
    const w = wrap.clientWidth, half = tip.offsetWidth / 2;
    tip.style.left = Math.min(w - half, Math.max(half, xFrac * w)) + 'px';
  }

  /* Hero: cumulative spend on a month ruler — this month (to the data date) against last month. */
  function rulerChart(m) {
    const W = 340, H = 128, L = 2, R = 2, T = 8, B = 24;
    const days = Math.max(m.days, m.prev_cum.length, 28);
    const top = Math.max(1, ...m.cum, ...m.prev_cum) * 1.06;
    const x = (d) => L + ((d - 1) / (days - 1)) * (W - L - R);
    const y = (v) => T + (1 - Math.max(0, v) / top) * (H - T - B);
    const step = (arr) => arr.map((v, i) => (i ? `H${x(i + 1).toFixed(1)}V${y(v).toFixed(1)}` : `M${x(1).toFixed(1)},${y(v).toFixed(1)}`)).join('');
    const g = sv('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `本月累計支出與上月比較，到第 ${m.cmp_day} 天` });
    g.append(sv('line', { class: 'axis', x1: L, x2: W - R, y1: H - B, y2: H - B }));
    for (let d = 1; d <= days; d++) {
      const major = d === 1 || d % 5 === 0;
      g.append(sv('line', { class: 'tick', x1: x(d), x2: x(d), y1: H - B, y2: H - B + (major ? 7 : 3.5) }));
      if (major) g.append(sv('text', { x: x(d), y: H - 5, 'text-anchor': d === 1 ? 'start' : d >= days ? 'end' : 'middle' }, d));
    }
    if (m.prev_cum.length) g.append(sv('path', { class: 'ln-prev', d: step(m.prev_cum) }));
    if (m.cum.length) {
      const p = sv('path', { class: 'ln-cur draw', d: step(m.cum) });
      g.append(p, sv('circle', { class: 'dot-cur', cx: x(m.cum.length), cy: y(m.cum[m.cum.length - 1]), r: 4.5 }));
      requestAnimationFrame(() => { try { p.style.setProperty('--len', Math.ceil(p.getTotalLength())); } catch (e) { p.classList.remove('draw'); } });
    }
    const hair = sv('line', { class: 'xhair', y1: T, y2: H - B, visibility: 'hidden' });
    g.append(hair);
    const tip = tipBox(), wrap = el('div', { class: 'chart' }, tip, g);
    const move = (ev) => {
      const r = g.getBoundingClientRect();
      const d = Math.min(days, Math.max(1, Math.round(((ev.clientX - r.left) / r.width * W - L) / (W - L - R) * (days - 1)) + 1));
      hair.setAttribute('x1', x(d)); hair.setAttribute('x2', x(d)); hair.setAttribute('visibility', 'visible');
      const lines = [`${+m.ym.slice(5)}/${d}`];
      if (d <= m.cum.length) lines.push(el('span', {}, '本月累計 ', amt(m.cum[d - 1])));
      if (d <= m.prev_cum.length) lines.push(el('span', {}, '上月同日 ', amt(m.prev_cum[d - 1])));
      placeTip(tip, wrap, x(d) / W, lines);
    };
    g.addEventListener('pointerdown', move); g.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' || e.buttons || e.pressure) move(e); });
    g.addEventListener('pointerleave', () => { tip.hidden = true; hair.setAttribute('visibility', 'hidden'); });
    return el('div', {}, wrap, el('p', { class: 'legend' }, el('span', {}, el('i'), '本月累計'), el('span', {}, el('i', { class: 'prev' }), '上月累計')));
  }

  function niceMax(v) {
    if (v <= 0) return 10000;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const k of [1, 1.5, 2, 3, 4, 5, 6, 8, 10]) if (v <= k * p) return k * p;
    return 10 * p;
  }
  /* Monthly bars. series: [{key, cls}] stacked bottom-up; one y-axis; tap selects a month. */
  function barChart(trend, series, selIdx, onSel, label) {
    const W = 340, H = 178, L = 34, R = 4, T = 10, B = 40, n = trend.length;
    const top = niceMax(Math.max(...trend.map((t) => series.reduce((s, q) => s + Math.max(0, t[q.key]), 0))));
    const band = (W - L - R) / n, bw = Math.min(16, band * 0.6);
    const y = (v) => T + (1 - v / top) * (H - T - B);
    const g = sv('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label });
    for (const f of [0, 0.5, 1]) {
      g.append(sv('line', { class: f ? 'grid' : 'axis', x1: L, x2: W - R, y1: y(top * f), y2: y(top * f) }),
               sv('text', { x: L - 6, y: y(top * f) + 3.5, 'text-anchor': 'end' }, f ? wan(top * f) : '0'));
    }
    trend.forEach((t, i) => {
      const cx = L + band * (i + 0.5), grp = sv('g', {}), on = i === selIdx;
      let base = 0;
      const live = series.filter((q) => t[q.key] > 0);
      live.forEach((q, k) => {
        const y0 = y(base), y1 = y(base + t[q.key]), isTop = k === live.length - 1;
        const h = Math.max(1, y0 - y1 - (k ? 2 : 0));
        const yy = y1, r = isTop ? Math.min(4, h, bw / 2) : 0;
        const d = `M${cx - bw / 2},${yy + h}V${yy + r}Q${cx - bw / 2},${yy} ${cx - bw / 2 + r},${yy}H${cx + bw / 2 - r}Q${cx + bw / 2},${yy} ${cx + bw / 2},${yy + r}V${yy + h}Z`;
        grp.append(sv('path', { class: q.cls, d }));
        base += t[q.key];
      });
      const mon = +t.ym.slice(5);
      if (on) grp.append(sv('rect', { class: 'selmark', x: cx - bw / 2 - 2, y: H - B + 1, width: bw + 4, height: 2.5 }));
      grp.append(sv('text', { class: on ? 'sel' : null, x: cx, y: H - B + 15, 'text-anchor': 'middle' }, mon));
      if (t.flags && t.flags.length) grp.append(sv('circle', { class: 'flagdot', cx, cy: H - B + 22.5, r: 2.4 }));
      if (mon === 1 || i === 0) grp.append(sv('text', { x: cx - (i === 0 ? bw / 2 : 0), y: H - B + 37, 'text-anchor': i === 0 ? 'start' : 'middle' }, t.ym.slice(0, 4)));
      const hit = sv('rect', { x: cx - band / 2, y: T, width: band, height: H - T, fill: 'transparent' });
      hit.addEventListener('click', () => onSel(i));
      grp.append(hit);
      g.append(grp);
    });
    return el('div', { class: 'chart' }, g);
  }

  // ---------------------------------------------------------------- views
  const LEVEL = { critical: '馬上處理', serious: '需要處理', warning: '留意', info: '提醒' };
  function alertRow(a) {
    const lv = LEVEL[a.level] ? a.level : 'info';
    const ic = sv('svg', { class: 'ic ic-' + lv, viewBox: '0 0 20 20', 'aria-hidden': 'true' },
      lv === 'info' ? sv('circle', { cx: 10, cy: 10, r: 7 }) : sv('path', { d: 'M10 2.2l8.6 15H1.4z' }));
    return el('div', { class: 'alert' }, ic, el('div', {}, el('span', { class: 'lv' }, LEVEL[lv]), el('h3', {}, a.title), a.body && el('p', {}, a.body)));
  }
  const tabBtn = (t) => () => { S.tab = t; window.scrollTo(0, 0); render(); };

  function viewHome(d) {
    const m = d.month, mon = +m.ym.slice(5), diff = m.spend - m.prev_same_period;
    const cmp = !m.cmp_day ? '這個月還沒有入帳的資料'
      : diff === 0 ? '和上月同期一樣' : ['比上月同期', el('b', {}, diff > 0 ? '多 ' : '少 ', amt(Math.abs(diff)))];
    const hero = el('section', { class: 'sec hero' },
      el('p', { class: 'hero-label' }, `${mon} 月已知支出`),
      el('p', { class: 'hero-num' }, el('span', { class: 'cur' }, 'NT$'), el('span', { class: 'amt' }, fmt(m.spend))),
      el('p', { class: 'hero-cmp' }, cmp),
      el('div', { class: 'postmark', 'aria-label': `資料到 ${md(d.data_through)}` }, el('span', {}, '資料至'), el('b', {}, md(d.data_through).replace('/', '.'))),
      rulerChart(m),
      el('dl', { class: 'stats' },
        el('div', {}, el('dt', {}, (d.labels && d.labels.fixed) || '固定支出'), el('dd', {}, amt(m.mortgage))),
        el('div', {}, el('dt', {}, '其他支出'), el('dd', {}, amt(m.other))),
        el('div', {}, el('dt', {}, `轉入${m.spending_name.replace('消費帳戶', '')}`), el('dd', {}, amt(m.to_spending)),
          !m.spending_covered && m.to_spending ? el('small', {}, '花在哪裡還看不到') : null)),
      m.budget && budgetBar(m.budget));
    const adv = d.advice, acts = adv.actions.filter((a) => a.impact_label).slice(0, 3);
    const brief = el('section', { class: 'sec' }, el('h2', {}, '理財短評'),
      el('p', { class: 'headline' }, adv.headline),
      acts.length ? el('ul', { class: 'compact', style: null }, acts.map((a) => el('li', {}, el('span', {}, a.title), el('span', { class: 'amt' }, a.impact_label)))) : null,
      el('button', { class: 'link', onclick: tabBtn('advice') }, '看完整匯報'));
    const alerts = d.alerts.length ? el('section', { class: 'sec' }, el('h2', {}, '要處理的事'), d.alerts.map(alertRow)) : null;
    const cats = m.by_cat.filter((c) => c.amount > 0), mx = Math.max(1, ...cats.map((c) => c.amount));
    const catSec = el('section', { class: 'sec' }, el('h2', {}, '錢花在哪', el('small', {}, '點一下看細項')),
      cats.length ? cats.map((c) => {
        const bar = el('div', { class: 'bar' });
        bar.style.width = Math.max(1, (c.amount / mx) * 100) + '%';
        return el('details', { class: 'cat' }, el('summary', {}, el('span', {}, c.cat), el('div', {}, bar), amt(c.amount, 'v')),
          el('ul', { class: 'subs' }, c.subs.map((s) => el('li', {}, el('span', {}, s.name || '其他'), amt(s.amount))),
            el('li', {}, el('span', {}, '上月同期'), amt(c.prev))));
      }) : el('p', { class: 'muted' }, '這個月還沒有支出紀錄。'));
    const top = m.top.length ? el('section', { class: 'sec' }, el('h2', {}, '本月最大的幾筆'),
      el('ul', { class: 'rows' }, m.top.map((t) => el('li', {}, el('span', { class: 'n' }, t.m), amt(t.a, 'v'), el('span', { class: 'm' }, `${t.d.replace('-', '/')}　${t.c}`))))) : null;
    return [hero, alerts, brief, catSec, top];
  }
  function budgetBar(b) {
    const fill = el('div', { class: 'fill' + (b.left < 0 ? ' over' : '') });
    fill.style.width = Math.min(100, (b.used / Math.max(1, b.limit)) * 100) + '%';
    return el('div', { class: 'budget' }, el('div', { class: 'track' }, fill),
      el('p', {}, el('span', {}, `${b.label}預算 `, amt(b.limit)), el('span', {}, b.left >= 0 ? '還可以花 ' : '已超出 ', amt(Math.abs(b.left)))));
  }

  function viewAdvice(d) {
    const a = d.advice;
    const st = { ok: '完整', partial: '部分', missing: '還沒有' };
    return [
      el('section', { class: 'sec' }, el('p', { class: 'muted' }, `依 ${md(d.data_through)} 為止的帳本整理`), el('p', { class: 'big-headline' }, a.headline),
        a.status.map((s) => el('p', { class: 'para' }, s)), a.note && el('p', { class: 'para' }, a.note.text)),
      a.actions.length ? el('section', { class: 'sec' }, el('h2', {}, '可以調整的地方', el('small', {}, '依金額大小排列')),
        el('ol', { class: 'actions' }, a.actions.map((x, i) => el('li', {}, el('span', { class: 'rank' }, i + 1),
          el('div', {}, el('h3', {}, x.title), el('p', {}, x.body), x.impact_label && el('span', { class: 'impact amt' }, x.impact_label)))))) : null,
      d.alerts.length ? el('section', { class: 'sec' }, el('h2', {}, '要處理的事'), d.alerts.map(alertRow)) : null,
      d.questions.length ? el('section', { class: 'sec' }, el('h2', {}, '等你確認', el('small', {}, '回答後數字會更準')),
        el('ul', { class: 'rows' }, d.questions.map((q) => el('li', {}, el('span', { class: 'n' }, q.q), q.amount ? amt(q.amount, 'v') : el('span'))))) : null,
      d.coverage.length ? el('section', { class: 'sec' }, el('h2', {}, '這些數字涵蓋了什麼'),
        el('ul', { class: 'cov' }, d.coverage.map((c) => el('li', {}, el('span', { class: 'st ' + (st[c.status] ? c.status : 'missing') }, st[c.status] || c.status),
          el('p', {}, el('b', {}, c.name), c.note))))) : null,
      el('p', { class: 'foot' }, a.disclaimer || ''),
    ];
  }

  function viewTx(d) {
    const F = { spend: ['e', 'r'], income: ['i'], move: ['to', 'ti', 'cp'] };
    const list = d.txns.filter((t) => F[S.txFilter].includes(t.dir));
    const chips = el('div', { class: 'chips', role: 'group', 'aria-label': '篩選' },
      [['spend', '支出'], ['income', '收入'], ['move', '轉帳與繳卡費']].map(([k, n]) =>
        el('button', { class: 'chip', 'aria-pressed': String(S.txFilter === k), onclick: () => { S.txFilter = k; render(); } }, n)));
    const out = [el('section', { class: 'sec' }, el('h2', {}, '近三個月明細', el('small', {}, `到 ${md(d.data_through)}`)), chips)];
    const sec = out[0];
    if (!list.length) sec.append(el('p', { class: 'muted' }, S.txFilter === 'income' ? '還沒有收入紀錄；薪轉戶的存入明細接上後會出現在這裡。' : '沒有符合的紀錄。'));
    let cur = null, ul = null, sum = 0, head = null;
    const close = () => { if (head) head.append(el('span', { class: 'amt num' }, fmt(sum))); };
    for (const t of list) {
      if (t.d !== cur) {
        close();
        cur = t.d; sum = 0;
        const dt = new Date(t.d + 'T00:00:00');
        head = el('p', { class: 'day-h' }, el('span', {}, `${md(t.d)}（${WEEK[dt.getDay()]}）`));
        ul = el('ul', { class: 'rows' });
        sec.append(head, ul);
      }
      sum += t.dir === 'r' ? -t.a : t.a;
      const DIRL = { r: '退款', ti: '轉入', to: '轉出', cp: '繳卡費', i: '收入' };
      const meta = [t.c1 && t.c2 ? `${t.c1}／${t.c2}` : (t.c1 || t.c2), t.i && t.i !== t.m ? t.i : null].filter(Boolean).join('　');
      ul.append(el('li', {}, el('span', { class: 'n' }, t.m, DIRL[t.dir] && el('span', { class: 'tag' }, DIRL[t.dir]),
        t.f === 'est' && el('span', { class: 'tag' }, '推算'), t.f === 'rev' && el('span', { class: 'tag' }, '待確認')),
        t.na ? el('span', { class: 'v' }, '外幣') : el('span', { class: 'v amt' }, (t.dir === 'r' ? '−' : '') + fmt(t.a)),
        meta && el('span', { class: 'm' }, meta)));
    }
    close();
    return out;
  }

  const flagText = (f, fx) => ({ no_post: `沒有薪轉戶資料，${fx}和轉帳可能漏記`, no_mort: `沒看到${fx}紀錄`, est: '含推算值（缺信用卡帳單）' }[f] || f);
  function viewTrend(d) {
    const tr = d.trend, sel = S.trendSel == null || S.trendSel >= tr.length ? tr.length - 1 : S.trendSel, t = tr[sel], name = d.month.spending_name;
    const fx = (d.labels && d.labels.fixed) || '固定支出';
    const onSel = (i) => { S.trendSel = i; render(); };
    const detail = el('div', { class: 'detail', 'aria-live': 'polite' },
      el('b', {}, ymLabel(t.ym)), '　已知支出 ', amt(t.spend), `（${fx} `, amt(t.mortgage), '、其他 ', amt(t.other), '）', el('br'),
      `轉入${name} `, amt(t.to_spending), t.fees ? ['　利息與手續費 ', amt(t.fees)] : null,
      t.flags.length ? [el('br'), '○ ' + t.flags.map((f) => flagText(f, fx)).join('；')] : null);
    const table = el('details', { class: 'more' }, el('summary', {}, '用表格看'),
      el('table', { class: 'tbl' }, el('thead', {}, el('tr', {}, ['月份', '已知支出', fx, '其他', `轉入${name.replace('消費帳戶', '')}`].map((h) => el('th', {}, h)))),
        el('tbody', {}, tr.slice().reverse().map((r) => el('tr', {}, el('td', {}, r.ym + (r.flags.length ? ' ○' : '')),
          [r.spend, r.mortgage, r.other, r.to_spending].map((v) => el('td', { class: 'amt' }, fmt(v))))))));
    const rec = d.recurring.filter((r) => r.active), gone = d.recurring.filter((r) => !r.active);
    const recSec = el('section', { class: 'sec' }, el('h2', {}, '固定在扣的錢'),
      el('ul', { class: 'rows' },
        d.fixed.mortgage_typical ? el('li', {}, el('span', { class: 'n' }, fx), amt(d.fixed.mortgage_typical, 'v'), el('span', { class: 'm' }, '每月，通常的金額')) : null,
        rec.map((r) => el('li', {}, el('span', { class: 'n' }, r.name), amt(r.amount, 'v'), el('span', { class: 'm' }, `每月　上次扣款 ${md(r.last)}　一年約 ${fmt(r.yearly)}`)))),
      el('p', { class: 'muted' }, '訂閱、電信、會員合計每月 ', amt(d.fixed.recurring_monthly), '。收據不是每期都寄到信箱，所以上次扣款日可能比實際早。'),
      gone.length ? el('details', { class: 'more' }, el('summary', {}, `近期沒有再扣款（${gone.length}）`),
        el('ul', { class: 'rows' }, gone.map((r) => el('li', {}, el('span', { class: 'n' }, r.name), amt(r.amount, 'v'), el('span', { class: 'm' }, `最後一次 ${r.last}`))))) : null);
    const f = d.fees, misc = el('section', { class: 'sec' }, el('h2', {}, '其他數字', el('small', {}, '近 12 個月')),
      el('dl', { class: 'kv' },
        el('dt', {}, '信用卡循環利息與違約金' + (f.late_estimated ? '（部分推算）' : '')), el('dd', {}, amt(f.late_12m)),
        el('dt', {}, '國外交易手續費'), el('dd', {}, amt(f.fx_12m)),
        d.watch.map((w) => [el('dt', {}, `${w.name} 淨轉入（轉入 ${fmt(w.in)}、轉出 ${fmt(w.out)}）`), el('dd', {}, amt(w.net))])));
    const nw = d.net_worth, inc = d.income;
    const pos = el('section', { class: 'sec' }, el('h2', {}, '收入與淨資產'),
      inc ? el('dl', { class: 'kv' }, inc.source === 'ledger' ? [el('dt', {}, '本月收入'), el('dd', {}, amt(inc.month)), el('dt', {}, '上月收入'), el('dd', {}, amt(inc.prev_month))]
        : [el('dt', {}, `每月實領（估計${inc.as_of ? '，' + inc.as_of : ''}）`), el('dd', {}, amt(inc.monthly))])
        : el('p', { class: 'muted' }, '收入還沒接上；薪轉戶的存入明細匯入後才算得出結餘。'),
      nw ? el('dl', { class: 'kv' }, el('dt', {}, '資產'), el('dd', {}, amt(nw.assets)), el('dt', {}, '負債'), el('dd', {}, amt(nw.liabilities)), el('dt', {}, '淨資產'), el('dd', {}, amt(nw.net)))
        : el('p', { class: 'muted' }, '帳戶餘額與貸款餘額還沒提供，暫時算不出淨資產。'));
    return [
      el('section', { class: 'sec' }, el('h2', {}, '每月已知支出', el('small', {}, '點長條看那個月')),
        barChart(tr, [{ key: 'mortgage', cls: 'seg-a' }, { key: 'other', cls: 'seg-b' }], sel, onSel, `每月已知支出，分${fx}與其他`),
        el('p', { class: 'legend' }, el('span', {}, el('i', { class: 'box' }), fx), el('span', {}, el('i', { class: 'box b' }), '其他已知支出'), el('span', {}, el('i', { class: 'ring' }), '資料不完整')),
        detail, table),
      el('section', { class: 'sec' }, el('h2', {}, `每月轉入${name}`),
        barChart(tr, [{ key: 'to_spending', cls: 'seg-c' }], sel, onSel, `每月轉入${name}的金額`),
        el('p', { class: 'muted' }, d.month.spending_covered ? '已接上明細，這些轉帳只是自己帳戶之間的移動。' : '這個帳戶的消費明細還沒接上；這裡的金額不算在上面的支出裡。')),
      recSec, misc, pos,
    ];
  }

  // ---------------------------------------------------------------- setup + settings
  function viewSetup(err) {
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    const code = el('textarea', { id: 'f-code', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'PFM1.…' });
    const tok = el('input', { id: 'f-token', type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'github_pat_…' });
    code.value = store.get(LS.setup) || ''; tok.value = store.get(LS.token) || '';
    const errBox = el('p', { class: 'error', role: 'alert' }, err || '');
    const go = async (ev) => {
      ev.preventDefault();
      errBox.textContent = '';
      let setup;
      try { setup = parseSetup(code.value); } catch (e) { errBox.textContent = e.message; return; }
      const token = tok.value.trim();
      if (!token) { errBox.textContent = '請貼上 GitHub 金鑰。'; return; }
      btn.disabled = true; btn.textContent = '檢查中…';
      try {
        const text = await fetchEnvelope(setup, token);
        S.data = await useEnvelope(text, setup);
        store.set(LS.setup, code.value.replace(/\s+/g, '')); store.set(LS.token, token); store.set(LS.env, text);
        S.fetched = new Date().toISOString(); store.set(LS.fetched, S.fetched); store.del(LS.demo);
        S.demo = false; S.banner = null; S.tab = 'home';
        render();
      } catch (e) { errBox.textContent = e.message || '設定失敗'; btn.disabled = false; btn.textContent = '完成設定'; }
    };
    const btn = el('button', { class: 'btn', type: 'submit' }, '完成設定');
    return el('main', { class: 'shell setup' },
      el('h1', {}, '收支帳'),
      el('p', { class: 'lead' }, '你的帳務資料加密後放在私人 repo，只有這支裝置上的設定碼解得開。貼上兩樣東西就能開始。'),
      ios && !standalone ? el('p', { class: 'note' }, '先把這一頁加到主畫面（分享 → 加入主畫面），再從主畫面打開來設定。Safari 和主畫面 app 的儲存空間是分開的，在這裡設定不會帶過去。') : null,
      el('form', { onsubmit: go },
        el('div', { class: 'field' }, el('label', { for: 'f-code' }, '設定碼'), code, el('p', { class: 'hint' }, 'Claude 在對話裡給你的那一長串，以 PFM1. 開頭。')),
        el('div', { class: 'field' }, el('label', { for: 'f-token' }, 'GitHub 金鑰'), tok, el('p', { class: 'hint' }, '只能讀取資料 repo 的 fine-grained token，以 github_pat_ 開頭。')),
        errBox, btn),
      el('button', { class: 'btn ghost', onclick: () => { store.set(LS.demo, '1'); loadDemo(); } }, '先看示範資料'),
      el('p', { class: 'foot' }, `版本 ${VERSION}。設定碼和金鑰只存在這支裝置上。`));
  }
  function openSettings() {
    const d = S.data, dlg = el('dialog', { 'aria-label': '設定' });
    const close = () => { dlg.close(); dlg.remove(); };
    const hide = el('input', { type: 'checkbox', id: 's-hide' });
    hide.checked = S.hide;
    hide.addEventListener('change', () => { S.hide = hide.checked; store.set(LS.hide, S.hide ? '1' : '0'); document.body.classList.toggle('hide', S.hide); render(); });
    dlg.append(el('div', { class: 'sheet' },
      el('h2', {}, '設定'),
      d ? el('dl', { class: 'kv' }, el('dt', {}, '帳本資料到'), el('dd', {}, d.data_through), el('dt', {}, '這份報表產生於'), el('dd', {}, stamp(d.generated_at)),
        !S.demo ? [el('dt', {}, '這支裝置上次取得'), el('dd', {}, stamp(S.fetched))] : null) : null,
      el('label', { class: 'sw', for: 's-hide' }, '隱藏金額（在外面看的時候）', hide),
      !S.demo ? el('button', { class: 'btn', onclick: () => { close(); refresh(true); } }, '立刻更新') : null,
      S.demo ? el('button', { class: 'btn', onclick: () => { store.del(LS.demo); S.demo = false; S.data = null; close(); render(); } }, '離開示範，輸入設定碼') : null,
      !S.demo ? el('button', { class: 'btn ghost', onclick: () => { S.data = null; S.reSetup = true; close(); render(); } }, '重新貼設定碼或金鑰') : null,
      !S.demo ? el('button', { class: 'btn danger', onclick: () => { if (dlg.dataset.sure) { Object.values(LS).forEach(store.del); S.data = null; S.banner = null; close(); render(); } else { dlg.dataset.sure = '1'; dlg.querySelector('.danger').textContent = '再按一次，清除這支裝置上的金鑰與資料'; } } }, '登出這支裝置') : null,
      el('button', { class: 'btn ghost', onclick: close }, '關閉'),
      el('p', { class: 'foot' }, `版本 ${VERSION}`)));
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
    document.body.append(dlg);
    dlg.showModal();
  }

  // ---------------------------------------------------------------- render
  function render() {
    const hasKeys = store.get(LS.token) && store.get(LS.setup);
    if (!S.data && (!hasKeys || S.reSetup)) {
      S.reSetup = false;
      root.replaceChildren(viewSetup(S.banner && S.banner.err ? S.banner.text : ''));
      return;
    }
    if (!S.data) {
      root.replaceChildren(el('main', { class: 'shell' },
        S.banner && S.banner.err
          ? el('div', { class: 'setup' }, el('h1', {}, '收支帳'), el('p', { class: 'error' }, S.banner.text),
              el('button', { class: 'btn', onclick: () => refresh(true) }, '再試一次'),
              el('button', { class: 'btn ghost', onclick: () => { S.reSetup = true; render(); } }, '重新貼設定碼或金鑰'))
          : el('p', { class: 'loading' }, '讀取資料中…')));
      return;
    }
    const d = S.data, m = d.month;
    const views = { home: viewHome, advice: viewAdvice, tx: viewTx, trend: viewTrend };
    const TITLES = { home: `${+m.ym.slice(5)} 月`, advice: '匯報', tx: '明細', trend: '趨勢' };
    const b = S.demo ? { text: '這是示範資料，不是你的帳。', demo: true } : S.banner;
    const banner = b ? el('div', { class: 'banner' + (b.err ? ' err' : '') }, el('span', {}, b.text),
      b.demo ? el('button', { onclick: () => { store.del(LS.demo); S.demo = false; S.data = null; render(); } }, '輸入設定碼')
        : b.fix ? el('button', { onclick: () => { S.data = null; S.reSetup = true; render(); } }, '去設定')
        : b.retry ? el('button', { onclick: () => refresh(true) }, '再試一次') : null) : null;
    const eye = el('button', { class: 'icon-btn', 'aria-label': S.hide ? '顯示金額' : '隱藏金額', 'aria-pressed': String(S.hide),
      onclick: () => { S.hide = !S.hide; store.set(LS.hide, S.hide ? '1' : '0'); document.body.classList.toggle('hide', S.hide); render(); } }, icon(S.hide ? IC.eyeOff : IC.eye));
    const top = el('header', { class: 'top' },
      el('h1', {}, TITLES[S.tab], S.tab === 'home' ? el('span', { class: 'sub' }, `第 ${m.cmp_day || m.day} 天，共 ${m.days} 天`) : null),
      el('div', {}, eye, el('button', { class: 'icon-btn', 'aria-label': '設定', onclick: openSettings }, icon(IC.gear))));
    const tabs = el('div', { class: 'tabbar' }, el('nav', { 'aria-label': '主選單' },
      [['home', '總覽'], ['advice', '匯報'], ['tx', '明細'], ['trend', '趨勢']].map(([k, n]) =>
        el('button', { 'aria-current': S.tab === k ? 'page' : null, onclick: tabBtn(k) }, n))));
    root.replaceChildren(el('main', { class: 'shell' }, top, banner, views[S.tab](d)), tabs);
  }

  boot();
})();

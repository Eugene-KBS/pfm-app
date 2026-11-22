/* 設定: appearance, privacy, budget & thresholds, notifications, home cards, data, connection, widget, about. */
import { el, group, row, amt, fmt, stamp, md, toast } from './util.js';
import { openSheet } from './sheet.js';
import { S, VERSION, saveUi, queueCmd, pref, pushSupport, enablePush, disablePush, checkWrite, pendingCount, unsentCount, signOut, leaveDemo, refresh, LS } from './data.js';
import { CARD_NAMES } from './overview.js';
import { openAdvisorSettings } from './advisor_settings.js';
import { store } from './util.js';

export function applyUi() {
  const r = document.documentElement;
  if (S.ui.theme === 'auto') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', S.ui.theme);
  r.setAttribute('data-fs', S.ui.fs || 'm');
  r.setAttribute('data-stockcolor', S.ui.stockColor || 'tw');
  document.body.classList.toggle('hide', !!S.ui.hide);
  const dark = S.ui.theme === 'dark' || (S.ui.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', dark ? '#000000' : '#f2f2f7'));
}

const segRow = (label, key, opts, app) => el('li', {}, el('div', { class: 'field' }, el('label', {}, label),
  el('div', { class: 'seg', style: { flex: '1' } }, opts.map(([v, n]) => el('button', { 'aria-pressed': String((S.ui[key] || opts[0][0]) === v),
    onclick: () => { S.ui[key] = v; saveUi(); applyUi(); app.render(); } }, n)))));
const swRow = (label, checked, onchange, sub) => el('li', {}, el('label', { class: 'field' }, el('span', {}, label, sub ? el('span', { class: 's muted tiny', style: { display: 'block' } }, sub) : null),
  el('span', { class: 'switch' }, el('input', { type: 'checkbox', checked: checked ? true : null, onchange: (e) => onchange(e.target.checked) }), el('i'))));

const steps = {};
function stepRow(label, key, step, min, max, unit, app) {
  const v0 = pref(key);
  const val = el('span', { class: 'amt' }, key === 'move_pct' ? `${v0}%` : key === 'remind_days' ? `${v0} 天` : fmt(v0));
  const set = (dv) => {
    const cur = steps[key] ?? pref(key);
    let nv = Math.round((cur + dv) * 10) / 10;
    nv = Math.max(min, Math.min(max, nv));
    steps[key] = nv;
    val.textContent = key === 'move_pct' ? `${nv}%` : key === 'remind_days' ? `${nv} 天` : fmt(nv);
    clearTimeout(steps['_t' + key]);
    steps['_t' + key] = setTimeout(() => { queueCmd({ set: { k: key, v: nv } }, `${label}改成 ${val.textContent}`); delete steps[key]; app.render(); }, 1200);
  };
  return el('li', {}, el('div', { class: 'field' }, el('label', {}, label, unit ? el('span', { class: 'muted tiny', style: { display: 'block' } }, unit) : null),
    el('div', { class: 'stepper' }, el('button', { onclick: () => set(-step), 'aria-label': '減少' }, '−'), val, el('button', { onclick: () => set(step), 'aria-label': '增加' }, '＋'))));
}

export function viewSettings(app) {
  const d = S.data;
  const sup = pushSupport();
  const subscribed = d.push?.subscribed || !!store.get(LS.vapid);
  const out = [];
  out.push(group('外觀', el('ul', { class: 'list' },
    segRow('主題', 'theme', [['auto', '跟系統'], ['light', '淺色'], ['dark', '深色']], app),
    segRow('文字', 'fs', [['s', '小'], ['m', '標準'], ['l', '大'], ['xl', '特大']], app),
    segRow('股票顏色', 'stockColor', [['tw', '紅漲綠跌'], ['us', '綠漲紅跌']], app))));
  out.push(group('隱私', el('ul', { class: 'list' },
    swRow('隱藏金額', S.ui.hide, (v) => { S.ui.hide = v; saveUi(); applyUi(); }, '在外面打開時把數字模糊掉'),
    swRow('通知顯示金額', pref('notify_amounts') !== false, (v) => queueCmd({ set: { k: 'notify_amounts', v } }, v ? '通知會顯示金額' : '通知不顯示金額')))));
  out.push(group('預算與門檻', el('ul', { class: 'list' },
    stepRow('日常支出上限', 'daily_cap', 5000, 5000, 1000000, '每月，不含房貸與大筆', app),
    stepRow('大額門檻', 'large_txn', 5000, 1000, 1000000, '單筆超過算「大筆」並通知', app),
    stepRow('扣款前提醒', 'remind_days', 1, 0, 10, '通知在最晚補錢日前幾天', app),
    stepRow('股票漲跌門檻', 'move_pct', 0.5, 0.5, 20, '平日超過才寫一句話', app)),
  { foot: '改動會送到帳本，明早更新後生效。' }));
  out.push(group('顧問', el('ul', { class: 'list' },
    row({ title: '顧問設定', sub: '房屋市值、一銀房貸、候選名單、切點、預備金月數、AI 解讀', wrapSub: true, chevron: true, onClick: () => openAdvisorSettings() })),
  { foot: '參考試算用的設定；送出後明早更新生效。' }));
  out.push(group('通知', el('ul', { class: 'list' },
    row({ title: subscribed ? '通知已開啟' : '開啟通知', sub: sup.ok ? (subscribed ? (d.push?.last_ok ? `上次送達 ${md(d.push.last_ok)}` : '明早更新後開始收到') : '每天早上更新後，有事才會跳通知') : sup.why,
      value: sup.ok ? el('button', { class: 'pill' + (subscribed ? ' gray' : ''), onclick: async () => {
        try { if (subscribed) await disablePush(); else await enablePush(); app.render(); } catch (e) { toast(e.message || '開啟失敗'); }
      } }, subscribed ? '關閉' : '開啟') : null }),
    swRow('要我動手的事', pref('notify.action'), (v) => queueCmd({ set: { k: 'notify.action', v } }), '補錢、新帳單、系統問題'),
    swRow('大額與異常', pref('notify.big'), (v) => queueCmd({ set: { k: 'notify.big', v } })),
    swRow('超支預警', pref('notify.budget'), (v) => queueCmd({ set: { k: 'notify.budget', v } }), '日常支出到 80%、100%，結餘轉負'),
    swRow('每週摘要', pref('notify.weekly'), (v) => queueCmd({ set: { k: 'notify.weekly', v } }), '週六早上')),
  { foot: 'iPhone 要從主畫面打開 app 才能開啟通知。一次更新最多一則，多件事會合併。' }));
  out.push(group('首頁卡片', el('ul', { class: 'list' }, homeCards(app))));
  out.push(group('資料', el('ul', { class: 'list' },
    row({ title: '帳本資料到', value: d.meta?.data_through || d.data_through }),
    row({ title: '這份資料產生於', value: stamp(d.meta?.generated_at || d.generated_at) }),
    !S.demo ? row({ title: '這支手機上次取得', value: stamp(S.fetched) }) : null,
    row({ title: '涵蓋範圍', sub: '哪些帳戶與來源已接上', chevron: true, onClick: () => openCoverage(d) }),
    !S.demo ? row({ title: '立刻重新整理', onClick: () => refresh(true), chevron: true }) : null)));
  out.push(group('連線', el('ul', { class: 'list' },
    row({ title: '待生效的操作', value: `${pendingCount()} 件`, sub: unsentCount() ? `${unsentCount()} 件還沒送出` + (S.writeErr ? `：${S.writeErr}` : '') : '都已送出，明早更新後生效', wrapSub: true }),
    row({ title: '回寫權限檢查', sub: '送一個測試指令，確認 GitHub 金鑰能開 Issue', chevron: true, onClick: async () => { toast('檢查中…'); toast(await checkWrite()); app.render(); } }),
    S.demo ? row({ title: '離開示範，輸入設定碼', chevron: true, onClick: () => leaveDemo() })
      : row({ title: '重新貼設定碼或金鑰', chevron: true, onClick: () => app.showSetup() }),
    !S.demo ? row({ title: el('span', { class: 'neg' }, '登出這支裝置'), onClick: () => { if (confirmTwice()) signOut(); } }) : null),
  { foot: 'GitHub 金鑰需要：資料 repo 的 Contents 唯讀＋Issues 讀寫。' }));
  out.push(group('主畫面小工具', el('ul', { class: 'list' },
    row({ title: '複製小工具金鑰', sub: 'Scriptable 第一次執行時貼上；只存在 iPhone 鑰匙圈', chevron: true, onClick: async () => {
      const k = d.widget?.key;
      if (!k) { toast('資料裡還沒有小工具金鑰'); return; }
      try { await navigator.clipboard.writeText(k); toast('已複製'); } catch (e) { toast('複製失敗，請長按選取'); }
    } }),
    row({ title: '安裝說明', chevron: true, onClick: () => openWidgetHelp() }))));
  out.push(group('關於', el('ul', { class: 'list' },
    row({ title: 'app 版本', value: VERSION }),
    row({ title: '資料管線', value: d.meta?.pipeline || 'v1' }),
    row({ title: '檢查更新', chevron: true, onClick: () => app.checkUpdate(true) }),
    row({ title: '更新紀錄', chevron: true, onClick: () => openChangelog() }))));
  return out;
}
let sure = 0;
function confirmTwice() { if (Date.now() - sure < 4000) return true; sure = Date.now(); toast('再按一次，清除這支裝置上的金鑰與資料'); return false; }

function homeCards(app) {
  const order = (S.ui.cards || Object.keys(CARD_NAMES)).slice();
  for (const k of Object.keys(CARD_NAMES)) if (!order.includes(k)) order.push(k);
  const hidden = new Set(S.ui.hidden || []);
  const move = (i, dir) => { const j = i + dir; if (j < 0 || j >= order.length) return; [order[i], order[j]] = [order[j], order[i]]; S.ui.cards = order; saveUi(); app.render(); };
  return order.map((k, i) => el('li', {}, el('div', { class: 'field' },
    el('span', { class: 'switch', style: { marginLeft: '0' } }, el('input', { type: 'checkbox', checked: hidden.has(k) ? null : true, onchange: (e) => {
      if (e.target.checked) hidden.delete(k); else hidden.add(k); S.ui.hidden = [...hidden]; saveUi();
    } }), el('i')),
    el('span', { style: { flex: '1' } }, CARD_NAMES[k]),
    el('button', { class: 'icon-btn', onclick: () => move(i, -1), 'aria-label': '上移', disabled: i === 0 ? true : null }, '↑'),
    el('button', { class: 'icon-btn', onclick: () => move(i, 1), 'aria-label': '下移', disabled: i === order.length - 1 ? true : null }, '↓'))));
}

function openCoverage(d) {
  const st = { ok: '完整', partial: '部分', missing: '還沒有' };
  openSheet({ title: '涵蓋範圍', body: [group(null, el('ul', { class: 'list' }, (d.coverage || []).map((c) => row({ title: [c.name, el('span', { class: 'tag' + (c.status === 'ok' ? ' blue' : c.status === 'partial' ? ' warn' : ' red') }, st[c.status] || c.status)], sub: c.note, wrapSub: true })))),
    group('資料不完整的月份', el('div', { class: 'card' }, el('p', { class: 'para' },
      (d.months || []).filter((m) => m.complete && !(m.complete.income && m.complete.card)).map((m) => `${m.ym}（${!m.complete.income ? '收入' : ''}${!m.complete.income && !m.complete.card ? '、' : ''}${!m.complete.card ? '中信卡明細' : ''}）`).join('、') || '沒有')))] });
}
function openWidgetHelp() {
  openSheet({ title: '主畫面小工具', body: [group(null, el('div', { class: 'card' },
    el('p', { class: 'para' }, '1. 在 App Store 安裝 Scriptable（免費）。'),
    el('p', { class: 'para' }, '2. 用 Safari 打開 eugene-kbs.github.io/pfm-app/widget/pfm-widget.js，全選複製，在 Scriptable 新增腳本貼上，命名「收支帳」。'),
    el('p', { class: 'para' }, '3. 在 Scriptable 執行一次：依序貼上 GitHub 金鑰和小工具金鑰（上一頁「複製小工具金鑰」），會存進 iPhone 鑰匙圈。'),
    el('p', { class: 'para' }, '4. 主畫面長按 → 加入小工具 → Scriptable 中型 → 編輯小工具 → Script 選「收支帳」。'),
    el('p', { class: 'para muted sm' }, '限制：點小工具只能打開 Safari 版，iOS 不允許小工具直接打開主畫面上的 app。')))] });
}
function openChangelog() {
  openSheet({ title: '更新紀錄', body: [group(null, el('ul', { class: 'list' },
    row({ title: '2.1.0', sub: '新增「顧問」分頁（參考試算，非投資建議）：資產負債、預備金、目前配置、股票總投報與報酬區間、互動計算表、資金需求試算、AI 解讀；「顧問設定」可填房屋市值與一銀房貸、勾選候選名單、調整切點與預備金月數、開關 AI 解讀。', wrapSub: true }),
    row({ title: '2.0.1', sub: '每個彈出頁面都有多種離開方式：右上角 ×、底部「關閉」、往下拉（內容在最上面時任何地方都可以拉）、從左邊緣往右滑、點上方暗處；頁首不再被狀態列蓋住。', wrapSub: true }),
    row({ title: '2.0.0', sub: '新版：五個分頁、待處理清單、本月結餘與日常支出上限、12 個月收支、全部交易與分類回寫、補錢清單與發薪日建議、訂閱與異常、月結與週摘要、每日收盤價與自繪走勢圖、app 通知、主畫面小工具、深色模式與文字大小。', wrapSub: true }),
    row({ title: '1.1.0', sub: '股票分頁。', wrapSub: true }),
    row({ title: '1.0.0', sub: '第一版：本月支出、匯報、明細、趨勢。', wrapSub: true })))] });
}
export { amt };

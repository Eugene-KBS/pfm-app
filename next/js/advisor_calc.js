/* advisor_calc.js — 「顧問」分頁的純計算。無 DOM、無相依、純函式。規格：PFM-ADVISOR-SPEC §2.8–2.10。
 *
 * 通則
 *  - 報酬、機率、權重一律用小數：7% 寫 0.07、權重 30% 寫 0.3。金額為新台幣元（內部不四捨五入，顯示交給 util.amt()）。
 *  - 類別順序固定 CLS = [cash, bond_s, bond_l, tw_eq, us_eq, gl_eq, us_tech]（§2.1）；所有「權重向量 w」都與此同序、長度 7。
 *  - 錯誤不丟例外：回傳 {ok:false, error, field}。error ∈ invalid_number | out_of_range | invalid_shape | invalid_date |
 *    unknown_key（另帶 key＝找不到的持股 key）| missing_fx | bad_key。成功的物件含 ok:true。例外：phi／erf（純數學）、hitProb（無效回 null）、probTable（無效回 null）、backBusinessDays（無效回 null）。
 *  - cma 物件請當唯讀並重複使用同一個物件（快取以物件為鍵）；若改了內容要呼叫 clearCache()。
 *
 * ── 常數 ──────────────────────────────────────────────────────────────────────────────────────
 *  CLS                 ['cash','bond_s','bond_l','tw_eq','us_eq','gl_eq','us_tech']（凍結）
 *  ALL_ALLOWED         [true×7]（凍結；「全開」）
 *  PROB_YEARS          [1,3,5,10]（達標機率的年期）
 *  SLIDERS             {T:{min:.02,max:.20,step:.005,def:.07}, L:{min:.05,max:.50,step:.01,def:.20}}（§2.9-9；T＝目標年化、L＝最大可承受虧損）
 *  CANDIDATE_PP        2.5（§2.9-8：搭配候選門檻，百分點）
 *  SELL_NOTES          賣出試算固定提示文字陣列（§2.10「提示」）
 *
 * ── 數學 ──────────────────────────────────────────────────────────────────────────────────────
 *  erf(x) → number                       Abramowitz–Stegun 7.1.26（p=0.3275911；a=0.254829592,−0.284496736,1.421413741,−1.453152027,1.061405429）
 *  phi(x) → number                       Φ(x)=½(1+erf(x/√2))；phi(NaN)=NaN
 *
 * ── CMA ───────────────────────────────────────────────────────────────────────────────────────
 *  cma 形狀＝cma.json：{mu_kind:'geometric', classes:[{id,mu,sigma,cap}×7（順序同 CLS）], corr:[[7×7]], idio:{tw_single, us_single}}（其餘欄位忽略）
 *  mu 是機構預測的「年化複利（幾何）報酬」（V2 審查 A-1 修正）：模型先換成 GBM 漂移 d_i = ln(1+mu_i) + σ_i²/2，組合後才扣波動拖累 σp²/2。
 *  因此「單一類別 100%（無個股）」時 median 恰等於該類別輸入的 mu。cma.mu_kind 必須是 'geometric'，缺或其他值一律拒絕（不猜口徑）。
 *  validateCma(cma) → {ok:true} | {ok:false,error,field}
 *      檢查：mu_kind==='geometric'（否則 invalid_shape／mu_kind）、7 類且 id 同 CLS、mu／sigma／cap 為有限數（mu>−1 才能取對數；sigma≥0、0<cap≤1）、corr 7×7 對稱、對角 1、|ρ|≤1、idio 為有限數≥0。不檢查 Cholesky（那是 check_public_data.py 的事）。
 *
 * ── 組合統計（§2.8；對數常態近似）─────────────────────────────────────────────────────────────
 *  portfolioStats(w, cma, singles?) → {ok:true, mu, sigma, g, median, loss95}
 *      w        長度 7、有限、≥0、合計 1（容差 1e-6）。
 *      singles  個股項（只用於「現況」；試算類別層不傳）：[{w:數字≥0, mkt:'TW'|'US'}]，w 與 w 向量同基數（可配置金額）。
 *               σp² = ΣΣ wi·wj·ρij·σi·σj + Σ_k wk²·idio_k²（TW→idio.tw_single，US→idio.us_single）。個股項只增加變異數，不改均值。
 *      各類漂移 d_i = ln(1+mu_i)+σ_i²/2（mu_i 為幾何報酬）；mu＝μp＝Σ w_i·d_i（組合的 GBM 漂移，不是輸入 mu 的加權平均）。
 *      sigma＝σp、g＝μp−σp²/2、median＝e^g−1（預期年化中位數）、loss95＝1−e^{g−1.645σp}（1 年 95% 下行虧損，正值＝虧損）。
 *      性質：單一類別 100%、無個股 → g＝ln(1+mu_i)、median＝mu_i（容差 1e-9）；多類別時 g 大於各類 g_i 的加權平均（分散效果）。
 *  hitProb({g,sigma}, T, H) → number|null
 *      達標機率 Φ((g−ln(1+T))·√H / max(σ,1e-9))。T 有限且>−1、H 有限且>0；否則 null。
 *  probTable({g,sigma}, T) → {1:p,3:p,5:p,10:p}|null     （PROB_YEARS 各年期；取 table[5] 為預設）
 *
 * ── 現況權重與允許類別（輔助；規格 §2.3／§2.8 末句／§2.9-1）──────────────────────────────────────
 *  currentFromAlloc(alloc, allocatable) → {ok:true, w:[7], singles:[{key,name,mkt,w}], base, stocks, cashExcess}
 *      alloc＝快照 advisor.alloc（用 by_cls[{cls,value}] 與 items[{key,name,single,value_twd}]）；allocatable＝advisor.reserve.allocatable（可配置金額＝股票＋max(0,現金−預備金目標)）。
 *      base＝max(allocatable, 股票合計)；cash 類權重＝(base−股票合計)/base；其餘類＝value/base；singles 只取 single===true，mkt 由 key 前綴 'TW:'／'US:' 判定（其他前綴→bad_key）。
 *      alloc 為 null 或 base≤0 → {ok:false,error:'invalid_shape',field:'alloc'}。回傳的 w、singles 可直接餵 portfolioStats 與 solve/gapVsCurrent。
 *  allowedClasses(currentW, wlCls?) → boolean[7]
 *      cash 永遠 true；currentW[i]>0 為 true；wlCls（已勾選白名單標的的 cls 字串陣列）內的類別為 true；其餘 false。
 *
 * ── 可行性與求解（§2.9；確定性網格）────────────────────────────────────────────────────────────
 *  buildGrid(cma, allowed?) → {ok:true, count, hit:boolean} | {ok:false,…}
 *      預熱用。列舉並快取（以 cma 物件＋allowed 遮罩為鍵；μp、σp、g、中位數、loss95 只算一次）。allowed 省略＝ALL_ALLOWED。
 *      列舉：每類權重為 5% 的整數倍；依 CLS 順序前 6 類巢狀迴圈（0..min(剩餘, cap)；不允許的類別固定 0），第 7 類＝剩餘（須 ≤cap 且允許）。全開＝198,744 組。
 *  solve(cma, {T, Lmax, allowed?, current?}) → 兩種形狀
 *      T 0..1、Lmax 0..1（小數）。allowed 省略＝全開。current＝現況權重向量（長度 7，只用於第三順位平手規則；省略＝不比較）。
 *      可行（loss95 ≤ Lmax 且 e^g−1 ≥ T，容差 1e-12）：
 *        {ok:true, feasible:true, T, Lmax, count, w:[7], stats:{mu,sigma,g,median,loss95}, prob:{1,3,5,10}}
 *        w＝z=(g−ln(1+T))/σp 最大者；平手→loss95 小者→與 current 差距 Σ|wi−curi| 小者→先列舉到者（三個量先四捨五入到小數 10 位）。stats 不含個股項。
 *      不可行（不給任何比例／權重欄位）：
 *        {ok:true, feasible:false, T, Lmax, count, maxMedianWithinLmax:number|null, reachable:boolean, minLossForTarget:number|null}
 *        maxMedianWithinLmax＝loss95≤Lmax 的組合中最高的 e^g−1（「在可承受虧損 Lmax 內，預期年化最高約 X%」）。
 *        reachable＝是否有任何組合（不看 Lmax）達 T；minLossForTarget＝達 T 的組合中最小的 loss95（「要達到 T，1 年 95% 下行至少約 Y%」）；reachable=false 時為 null →「在目前假設與護欄內無法達成」。
 *  gapVsCurrent(target, current, allocatable) → {ok:true, rows:[{cls, cur, target, diff, diffPp, amount}×7]}
 *      target／current 為長度 7 權重；diff＝target−cur（小數）、diffPp＝diff×100（百分點）、amount＝diff×allocatable（元；正＝試算高於現況）。
 *  pickCandidates(rows, checkedItems, thresholdPp?) → {ok:true, list:[{cls, diffPp, amount, items:[{id,name,er_pct,ccy,min_fee_note,settle,mkt,code}], empty:boolean}]}
 *      rows＝gapVsCurrent().rows；檢列 diffPp ≥ thresholdPp（預設 2.5，容差 1e-9）的類別，依 CLS 順序；checkedItems＝已勾選白名單物件（需 cls、name…）。
 *      items＝該類已勾選標的（欄位缺漏為 null）；empty＝items 為空（UI 顯示「這個類別還沒有勾選候選」＋到顧問設定的連結）。cash 類若達門檻也會列出（items 恆空；是否顯示由 UI 決定）。
 *
 * ── 賣出試算（§2.10）──────────────────────────────────────────────────────────────────────────
 *  backBusinessDays(iso, n) → 'YYYY-MM-DD'|null      iso 往前推 n 個營業日（逐日倒退、只跳過週六日；UTC 運算，與裝置時區無關）。無效日期回 null。
 *      注意：iso 若落在週六／週日，「前一個營業日」＝上一個週五＝第 1 天，所以週末起算比週五起算少 1 天緩衝（D-4）；
 *      sellTrial 用 rollBackToWeekday 先把週末期限滾到週五再倒推，兩者不要混用。國定假日與美股休市未處理。
 *  rollBackToWeekday(iso) → 'YYYY-MM-DD'|null        iso 落在週六或週日 → 回上一個週五；平日原樣回傳。無效日期回 null。
 *  sellTrial({need, deadline, selected, items, alloc, fees, fx, cash, monthly}) → {ok:false,…} | 結果
 *      need      需要金額 0..99,999,999（元）。deadline 最晚日期 'YYYY-MM-DD'。
 *      selected  勾選持股的 key 陣列或 Set（'TW:0050'、'US:D03'…；整檔）；找不到 → unknown_key。
 *      items     快照 stocks_live.items（用 key、code、name、mkt、value_twd、cost_twd、pnl_twd）。
 *      alloc     快照 advisor.alloc（用 items[{key,cls,single}] 判類別與是否個股；key 不在其中 → 依 §2.2 預設：TW→tw_eq、US→us_eq，single=true，並列入 unmapped）。
 *      fees      benchmarks.json 的 fees（tw_fee_rate, tw_fee_min, tw_tax_stock, tw_tax_etf, tw_tax_bond_etf, us_dca_rate, us_min_usd, us_std_rate, settle:{TW,US}）；可為 null。費率須為比率（0.001425＝0.1425%）。
 *                美股處分費用只用兩個情境算區間（C-2）：us_std_rate＝電子單牌告 0.5%（最樂觀）、us_min_usd＝一般單最低（最保守，可能已取消，待券商確認）。
 *                us_dca_rate＝定期定額比率，官方資料寫明只適用定期定額扣款（不含處分），處分依牌告；故只當參考列回傳（欄位 usDca／fees.us.dca 保留），不參與 net 區間與足夠／不足判斷。
 *                us_std_rate 欄位缺或 null → 以券商為準、列入 fees.unknown，不出錯（此時美股區間只剩 us_min 一點）。
 *                null／非數字／負數／超過 0.1 的比率 → 視為「以券商為準」，不計入並列入 fees.unknown。
 *      fx        快照匯率（USD→TWD）；勾選含美股時必填且>0。cash 現金（元，≥0）。monthly 預備金月額（元，≥0；0 → 月數為 null）。
 *      結果：
 *      { ok:true, empty:boolean(未勾選), need, deadline, count, unmapped:[key],
 *        gross,                                                  // Σ 勾選 value_twd
 *        rows:[{key,code,name,mkt,cls,single,value,cost,taxKind:'stock'|'etf'|'bond_etf'|null,
 *               twCommission:number|null, twTax:number|null,     // 台股才有；null＝未計入
 *               usDca:number|null, usMin:number|null, usStd:number|null}],   // 美股才有；usDca＝市值×us_dca_rate；usMin＝us_min_usd×fx（每檔）；usStd＝市值×us_std_rate；null＝未計入
 *        fees:{ tw:{commission,tax,total}|null,                  // 台股；手續費＝每檔 max(value×tw_fee_rate, tw_fee_min)；稅依 taxKind
 *                                                                // taxKind：台股且 cls∈{bond_s,bond_l}→bond_etf；台股且非個股→etf；台股且個股→stock
 *               us:{dca:number|null, min:number|null, std:number|null,   // 三情境總額：dca 定期定額比率（僅供參考，不入區間）、min 一般單最低、std 電子單牌告（null＝該情境不可算）
 *                   warnings:[{key,name,value,minFeeUsd,minFeeTwd,pct}]}|null,   // 該檔「一般單最低」費用 ≥ 市值 5%（pct＝minFeeTwd/value）；只看 min 情境，與 dca／std 無關
 *               unknown:[{key:費率鍵, reason:'null'|'invalid'}], // 以券商為準、未計入
 *               total:{low,high} },                              // low＝台股費用＋美股 std／min 中「可算者的最低」；high＝＋最高者（dca 不參與）；std、min 皆不可算則美股視為 0
 *        net:{low, high},                                        // 淨入帳區間＝gross−fees.total.high／gross−fees.total.low（美股只看 std、min 兩情境；dca 不參與）
 *        cover:{status:'enough'|'short', diffLow, diffHigh, shortfall, straddle},
 *               // 以保守的 net.low 判定：enough＝net.low≥need；diffLow＝net.low−need、diffHigh＝net.high−need；shortfall＝max(0,need−net.low)；
 *               // straddle＝net.low<need≤net.high（落在區間內，UI 可提示）
 *        latest:{TW:'YYYY-MM-DD'|null, US:'YYYY-MM-DD'|null, binding:'YYYY-MM-DD'|null, settleDays:{TW,US}},
 *               // 最晚處分日＝期限（deadline）往前推 1 個營業日（轉出）＋交割日數（TW 預設 2、US 預設 1，取自 fees.settle 'T+n'，讀不到用預設）；
 *               // 期限落在週六／週日 → 先滾到上一個週五（rollBackToWeekday），再 backBusinessDays 倒推；平日直接倒推。→ 週五、週六、週日三種期限結果相同（D-4）。
 *               // 只避開週末，國定假日與美股休市未處理（以券商為準）；只算有勾選的市場；binding＝兩者較早者（只有一個市場時等於該市場）
 *        after:{ byCls:[{cls,value,w}×7], base,                  // 賣出後剩餘持股的類別金額／權重（§2.2 口徑：以剩餘股票市值為基數；base=0 時 w 全 0）
 *                cash, months, monthsBefore },                   // cash＝現金＋net.low−need；months＝cash/monthly；monthsBefore＝現金/monthly；monthly=0 → null
 *        realized:{low, high, cost},                             // 本次已實現損益＝net−Σcost_twd（low 對 net.low）
 *        remaining:{count, value, cost, unrealized},             // 未勾選持股：unrealized＝Σ pnl_twd
 *        notes:[string] }                                        // SELL_NOTES＋以券商為準／歷史買進紀錄／週末說明
 *
 * ── 其他 ──────────────────────────────────────────────────────────────────────────────────────
 *  clearCache()                                                  清掉 CMA 與網格快取
 */

export const CLS = Object.freeze(['cash', 'bond_s', 'bond_l', 'tw_eq', 'us_eq', 'gl_eq', 'us_tech']);
export const ALL_ALLOWED = Object.freeze([true, true, true, true, true, true, true]);
export const PROB_YEARS = Object.freeze([1, 3, 5, 10]);
export const SLIDERS = Object.freeze({
  T: Object.freeze({ min: 0.02, max: 0.2, step: 0.005, def: 0.07 }),
  L: Object.freeze({ min: 0.05, max: 0.5, step: 0.01, def: 0.2 }),
});
export const CANDIDATE_PP = 2.5;
export const SELL_NOTES = Object.freeze([
  '不做稅務判斷；已實現損益與海外所得申報請對照報稅資料',
  '試算用最近收盤價，實際成交價會不同',
]);

const N = 7;
const UNITS = 20;            // 5% 網格 → 合計 20 格
const Z95 = 1.645;
const TOL = 1e-12;
const MAX_COMBOS = 230230;   // C(26,6)：無 cap 的上限，用來預配陣列
const BROKER = '以券商為準';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const bad = (error, field) => ({ ok: false, error, field });
const r10 = (x) => Math.round(x * 1e10) / 1e10;
const nz = (x) => (x === 0 ? 0 : x);   // 去掉 -0

/* ── Φ ─────────────────────────────────────────────────────────────────────────────────────── */
export function erf(x) {
  const s = x < 0 ? -1 : 1, ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return s * (1 - poly * Math.exp(-ax * ax));
}
export const phi = (x) => 0.5 * (1 + erf(x / Math.SQRT2));

/* ── CMA 驗證與預處理（快取）────────────────────────────────────────────────────────────────── */
let cmaCache = new WeakMap();
let gridCache = new WeakMap();
export function clearCache() { cmaCache = new WeakMap(); gridCache = new WeakMap(); }

export function validateCma(cma) {
  if (!cma || typeof cma !== 'object') return bad('invalid_shape', 'cma');
  if (cma.mu_kind !== 'geometric') return bad('invalid_shape', 'mu_kind');   // mu 的口徑必須明示為年化複利（幾何）
  const cl = cma.classes;
  if (!Array.isArray(cl) || cl.length !== N) return bad('invalid_shape', 'classes');
  for (let i = 0; i < N; i++) {
    const c = cl[i];
    if (!c || c.id !== CLS[i]) return bad('invalid_shape', `classes[${i}].id`);
    if (!isNum(c.mu)) return bad('invalid_number', `classes[${i}].mu`);
    if (c.mu <= -1) return bad('out_of_range', `classes[${i}].mu`);            // ln(1+mu) 要求 mu>−1
    if (!isNum(c.sigma) || c.sigma < 0) return bad('invalid_number', `classes[${i}].sigma`);
    if (!isNum(c.cap) || c.cap <= 0 || c.cap > 1) return bad('out_of_range', `classes[${i}].cap`);
  }
  const k = cma.corr;
  if (!Array.isArray(k) || k.length !== N) return bad('invalid_shape', 'corr');
  for (let i = 0; i < N; i++) {
    if (!Array.isArray(k[i]) || k[i].length !== N) return bad('invalid_shape', 'corr');
    for (let j = 0; j < N; j++) if (!isNum(k[i][j]) || Math.abs(k[i][j]) > 1) return bad('invalid_number', `corr[${i}][${j}]`);
  }
  for (let i = 0; i < N; i++) {
    if (Math.abs(k[i][i] - 1) > 1e-9) return bad('out_of_range', `corr[${i}][${i}]`);
    for (let j = i + 1; j < N; j++) if (Math.abs(k[i][j] - k[j][i]) > 1e-9) return bad('invalid_shape', 'corr.symmetry');
  }
  const d = cma.idio;
  if (!d || !isNum(d.tw_single) || d.tw_single < 0) return bad('invalid_number', 'idio.tw_single');
  if (!isNum(d.us_single) || d.us_single < 0) return bad('invalid_number', 'idio.us_single');
  return { ok: true };
}

function loadCma(cma) {
  if (!cma || typeof cma !== 'object') return bad('invalid_shape', 'cma');
  let p = cmaCache.get(cma);
  if (p) return p;
  const v = validateCma(cma);
  if (!v.ok) p = v;
  else {
    const sigma = cma.classes.map((c) => c.sigma), cap = cma.classes.map((c) => c.cap);
    // mu 是幾何（年化複利）報酬 → GBM 漂移 d_i = ln(1+mu_i) + σ_i²/2；組合後才在 g 扣一次 σp²/2
    const drift = cma.classes.map((c, i) => Math.log(1 + c.mu) + (sigma[i] * sigma[i]) / 2);
    const K = new Float64Array(N * N);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) K[i * N + j] = cma.corr[i][j] * sigma[i] * sigma[j];
    p = { ok: true, P: { drift, sigma, cap, K, idio: { TW: cma.idio.tw_single, US: cma.idio.us_single } } };
  }
  cmaCache.set(cma, p);
  return p;
}

/* ── 組合統計 ──────────────────────────────────────────────────────────────────────────────── */
function checkW(w, field) {
  if (!Array.isArray(w) || w.length !== N) return bad('invalid_shape', field);
  let s = 0;
  for (let i = 0; i < N; i++) {
    if (!isNum(w[i])) return bad('invalid_number', `${field}[${i}]`);
    if (w[i] < 0) return bad('out_of_range', `${field}[${i}]`);
    s += w[i];
  }
  if (Math.abs(s - 1) > 1e-6) return bad('out_of_range', `${field}.sum`);
  return null;
}

export function portfolioStats(w, cma, singles) {
  const L = loadCma(cma);
  if (!L.ok) return L;
  const e = checkW(w, 'w');
  if (e) return e;
  const P = L.P;
  let v = 0, mu = 0;
  for (let i = 0; i < N; i++) {
    mu += w[i] * P.drift[i];
    for (let j = 0; j < N; j++) v += w[i] * w[j] * P.K[i * N + j];
  }
  if (singles != null) {
    if (!Array.isArray(singles)) return bad('invalid_shape', 'singles');
    for (let k = 0; k < singles.length; k++) {
      const s = singles[k];
      if (!s || !isNum(s.w) || s.w < 0) return bad('invalid_number', `singles[${k}].w`);
      if (s.mkt !== 'TW' && s.mkt !== 'US') return bad('invalid_shape', `singles[${k}].mkt`);
      v += s.w * s.w * P.idio[s.mkt] * P.idio[s.mkt];
    }
  }
  if (v < 0) v = 0;
  const sigma = Math.sqrt(v), g = mu - v / 2;
  return { ok: true, mu, sigma, g, median: Math.exp(g) - 1, loss95: 1 - Math.exp(g - Z95 * sigma) };
}

export function hitProb(st, T, H) {
  if (!st || !isNum(st.g) || !isNum(st.sigma) || !isNum(T) || T <= -1 || !isNum(H) || H <= 0) return null;
  return phi(((st.g - Math.log(1 + T)) * Math.sqrt(H)) / Math.max(st.sigma, 1e-9));
}

export function probTable(st, T) {
  const out = {};
  for (const H of PROB_YEARS) {
    const p = hitProb(st, T, H);
    if (p == null) return null;
    out[H] = p;
  }
  return out;
}

/* ── 現況權重與允許類別 ─────────────────────────────────────────────────────────────────────── */
export function currentFromAlloc(alloc, allocatable) {
  if (!alloc || !Array.isArray(alloc.by_cls)) return bad('invalid_shape', 'alloc');
  if (!isNum(allocatable) || allocatable < 0) return bad('invalid_number', 'allocatable');
  const val = new Array(N).fill(0);
  let stocks = 0;
  for (const c of alloc.by_cls) {
    const i = CLS.indexOf(c && c.cls);
    if (i < 0) return bad('invalid_shape', 'alloc.by_cls.cls');
    if (!isNum(c.value) || c.value < 0) return bad('invalid_number', 'alloc.by_cls.value');
    val[i] += c.value;
    stocks += c.value;
  }
  const base = Math.max(allocatable, stocks);
  if (!(base > 0)) return bad('invalid_shape', 'alloc');
  const cashExcess = base - stocks;
  val[0] += cashExcess;
  const w = val.map((x) => x / base);
  const singles = [];
  for (const it of alloc.items || []) {
    if (!it || it.single !== true) continue;
    const mkt = typeof it.key === 'string' && it.key.startsWith('TW:') ? 'TW' : typeof it.key === 'string' && it.key.startsWith('US:') ? 'US' : null;
    if (!mkt) return bad('bad_key', 'alloc.items.key');
    if (!isNum(it.value_twd) || it.value_twd < 0) return bad('invalid_number', 'alloc.items.value_twd');
    singles.push({ key: it.key, name: it.name, mkt, w: it.value_twd / base });
  }
  return { ok: true, w, singles, base, stocks, cashExcess };
}

export function allowedClasses(currentW, wlCls) {
  const out = CLS.map(() => false);
  out[0] = true;
  if (Array.isArray(currentW)) for (let i = 0; i < N; i++) if (isNum(currentW[i]) && currentW[i] > 0) out[i] = true;
  if (Array.isArray(wlCls)) for (const c of wlCls) { const i = CLS.indexOf(c); if (i >= 0) out[i] = true; }
  return out;
}

/* ── 網格列舉（§2.9-2）────────────────────────────────────────────────────────────────────────── */
function normMask(allowed) {
  if (allowed == null) return ALL_ALLOWED.slice();
  if (!Array.isArray(allowed) || allowed.length !== N) return null;
  const m = allowed.map(Boolean);
  m[0] = true;
  return m;
}

function enumerate(P, mask) {
  const lim = mask.map((on, i) => (on ? Math.min(UNITS, Math.floor(P.cap[i] * UNITS + 1e-9)) : 0));
  const [l0, l1, l2, l3, l4, l5, l6] = lim;
  const units = new Int8Array(MAX_COMBOS * N);
  const G = new Float64Array(MAX_COMBOS), S = new Float64Array(MAX_COMBOS), M = new Float64Array(MAX_COMBOS), LS = new Float64Array(MAX_COMBOS);
  const u = new Int8Array(N), K = P.K, dr = P.drift;
  let n = 0;
  for (let a = 0, A = Math.min(UNITS, l0); a <= A; a++) {
    const r1 = UNITS - a;
    for (let b = 0, B = Math.min(r1, l1); b <= B; b++) {
      const r2 = r1 - b;
      for (let c = 0, C = Math.min(r2, l2); c <= C; c++) {
        const r3 = r2 - c;
        for (let d = 0, D = Math.min(r3, l3); d <= D; d++) {
          const r4 = r3 - d;
          for (let e = 0, E = Math.min(r4, l4); e <= E; e++) {
            const r5 = r4 - e;
            // 第 6 類 f 之後，第 7 類 = r5 − f 必須 ≤ l6（f 從 r5−l6 起跳，等同逐一檢查但不改變列舉順序）
            for (let f = Math.max(0, r5 - l6), F = Math.min(r5, l5); f <= F; f++) {
              u[0] = a; u[1] = b; u[2] = c; u[3] = d; u[4] = e; u[5] = f; u[6] = r5 - f;
              let m = 0, q = 0;
              for (let i = 0; i < N; i++) {
                const ui = u[i];
                if (!ui) continue;
                m += ui * dr[i];
                q += ui * ui * K[i * N + i];
                for (let j = i + 1; j < N; j++) { const uj = u[j]; if (uj) q += 2 * ui * uj * K[i * N + j]; }
              }
              m /= UNITS;
              let v = q / (UNITS * UNITS);
              if (v < 0) v = 0;
              const sg = Math.sqrt(v), g = m - v / 2;
              const o = n * N;
              units[o] = a; units[o + 1] = b; units[o + 2] = c; units[o + 3] = d; units[o + 4] = e; units[o + 5] = f; units[o + 6] = u[6];
              G[n] = g; S[n] = sg; M[n] = Math.exp(g) - 1; LS[n] = 1 - Math.exp(g - Z95 * sg);
              n++;
            }
          }
        }
      }
    }
  }
  return { count: n, units: units.subarray(0, n * N), g: G.subarray(0, n), sigma: S.subarray(0, n), median: M.subarray(0, n), loss95: LS.subarray(0, n) };
}

function gridFor(cma, allowed) {
  const L = loadCma(cma);
  if (!L.ok) return L;
  const mask = normMask(allowed);
  if (!mask) return bad('invalid_shape', 'allowed');
  let m = gridCache.get(cma);
  if (!m) { m = new Map(); gridCache.set(cma, m); }
  const key = mask.map((b) => (b ? 1 : 0)).join('');
  let grid = m.get(key);
  const hit = !!grid;
  if (!grid) { grid = enumerate(L.P, mask); m.set(key, grid); }
  return { ok: true, grid, hit };
}

export function buildGrid(cma, allowed) {
  const r = gridFor(cma, allowed);
  return r.ok ? { ok: true, count: r.grid.count, hit: r.hit } : r;
}

/* ── 求解（§2.9-3～5）──────────────────────────────────────────────────────────────────────── */
export function solve(cma, params) {
  const { T, Lmax, allowed, current } = params || {};
  if (!isNum(T)) return bad('invalid_number', 'T');
  if (T < 0 || T > 1) return bad('out_of_range', 'T');
  if (!isNum(Lmax)) return bad('invalid_number', 'Lmax');
  if (Lmax < 0 || Lmax > 1) return bad('out_of_range', 'Lmax');
  let cur = null;
  if (current != null) {
    if (!Array.isArray(current) || current.length !== N) return bad('invalid_shape', 'current');
    for (let i = 0; i < N; i++) if (!isNum(current[i])) return bad('invalid_number', `current[${i}]`);
    cur = current;
  }
  const r = gridFor(cma, allowed);
  if (!r.ok) return r;
  const { grid } = r;
  const n = grid.count, lnT = Math.log(1 + T);
  const Mx = grid.median, Ls = grid.loss95, Gg = grid.g, Sg = grid.sigma, U = grid.units;
  let best = -1, bz = 0, bl = 0, bd = 0;
  let maxMed = -Infinity, minLoss = Infinity, reach = false;
  const dist = (k) => {
    if (!cur) return 0;
    let s = 0;
    for (let i = 0; i < N; i++) s += Math.abs(U[k * N + i] / UNITS - cur[i]);
    return r10(s);
  };
  for (let k = 0; k < n; k++) {
    const med = Mx[k], loss = Ls[k];
    const medOk = med >= T - TOL, lossOk = loss <= Lmax + TOL;
    if (medOk) { reach = true; if (loss < minLoss) minLoss = loss; }
    if (lossOk && med > maxMed) maxMed = med;
    if (!(medOk && lossOk)) continue;
    const z = r10((Gg[k] - lnT) / Math.max(Sg[k], 1e-9));
    if (best < 0 || z > bz) { best = k; bz = z; bl = r10(loss); bd = dist(k); continue; }
    if (z < bz) continue;
    const l = r10(loss);
    if (l < bl) { best = k; bl = l; bd = dist(k); continue; }
    if (l > bl) continue;
    const d = dist(k);
    if (d < bd) { best = k; bd = d; }          // 嚴格較小才換 → 全平手時保留先列舉到者
  }
  if (best < 0) {
    return {
      ok: true, feasible: false, T, Lmax, count: n,
      maxMedianWithinLmax: maxMed === -Infinity ? null : maxMed,
      reachable: reach,
      minLossForTarget: reach ? minLoss : null,
    };
  }
  const w = [];
  for (let i = 0; i < N; i++) w.push(U[best * N + i] / UNITS);
  const st = portfolioStats(w, cma);
  const stats = { mu: st.mu, sigma: st.sigma, g: st.g, median: st.median, loss95: st.loss95 };
  return { ok: true, feasible: true, T, Lmax, count: n, w, stats, prob: probTable(stats, T) };
}

/* ── 與現況差距、搭配候選（§2.9-7、8）─────────────────────────────────────────────────────────── */
export function gapVsCurrent(target, current, allocatable) {
  if (!Array.isArray(target) || target.length !== N) return bad('invalid_shape', 'target');
  if (!Array.isArray(current) || current.length !== N) return bad('invalid_shape', 'current');
  for (let i = 0; i < N; i++) {
    if (!isNum(target[i])) return bad('invalid_number', `target[${i}]`);
    if (!isNum(current[i])) return bad('invalid_number', `current[${i}]`);
  }
  if (!isNum(allocatable) || allocatable < 0) return bad('invalid_number', 'allocatable');
  const rows = CLS.map((cls, i) => {
    const diff = target[i] - current[i];
    return { cls, cur: current[i], target: target[i], diff: nz(diff), diffPp: nz(diff * 100), amount: nz(diff * allocatable) };
  });
  return { ok: true, rows };
}

export function pickCandidates(rows, checkedItems, thresholdPp) {
  const th = thresholdPp == null ? CANDIDATE_PP : thresholdPp;
  if (!Array.isArray(rows)) return bad('invalid_shape', 'rows');
  if (!isNum(th) || th < 0) return bad('invalid_number', 'thresholdPp');
  if (checkedItems != null && !Array.isArray(checkedItems)) return bad('invalid_shape', 'checkedItems');
  const picked = checkedItems || [];
  const list = [];
  for (const r of rows) {
    if (!r || !isNum(r.diffPp)) return bad('invalid_number', 'rows.diffPp');
    if (r.diffPp < th - 1e-9) continue;
    const items = picked.filter((x) => x && x.cls === r.cls).map((x) => ({
      id: x.id ?? null, name: x.name ?? null, er_pct: x.er_pct ?? null, ccy: x.ccy ?? null,
      min_fee_note: x.min_fee_note ?? null, settle: x.settle ?? null, mkt: x.mkt ?? null, code: x.code ?? null,
    }));
    list.push({ cls: r.cls, diffPp: r.diffPp, amount: r.amount, items, empty: items.length === 0 });
  }
  list.sort((a, b) => CLS.indexOf(a.cls) - CLS.indexOf(b.cls));
  return { ok: true, list };
}

/* ── 日期（UTC，只避開週末）───────────────────────────────────────────────────────────────────── */
const DAY = 86400000;
function parseIso(s) {
  const m = typeof s === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) : null;
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = Date.UTC(y, mo - 1, d), dt = new Date(t);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? t : null;
}
const pad2 = (x) => String(x).padStart(2, '0');
function isoOf(t) { const d = new Date(t); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }
const isWeekend = (t) => { const w = new Date(t).getUTCDay(); return w === 0 || w === 6; };

export function backBusinessDays(iso, n) {
  const t0 = parseIso(iso);
  if (t0 == null || !Number.isInteger(n) || n < 0) return null;
  let t = t0;
  for (let i = 0; i < n; i++) {
    t -= DAY;
    while (isWeekend(t)) t -= DAY;
  }
  return isoOf(t);
}

/* 期限落在週六／週日 → 上一個週五；平日原樣。供最晚處分日使用，讓週五、週六、週日期限得到相同的緩衝。 */
export function rollBackToWeekday(iso) {
  let t = parseIso(iso);
  if (t == null) return null;
  while (isWeekend(t)) t -= DAY;
  return isoOf(t);
}

/* ── 賣出試算（§2.10）──────────────────────────────────────────────────────────────────────── */
function rateOf(fees, key) {
  const v = fees ? fees[key] : null;
  if (v == null) return { v: null, reason: 'null' };
  if (!isNum(v) || v < 0 || v > 0.1) return { v: null, reason: 'invalid' };
  return { v, reason: null };
}
function plainOf(fees, key) {   // 金額型（tw_fee_min 元、us_min_usd 美元）
  const v = fees ? fees[key] : null;
  if (v == null) return { v: null, reason: 'null' };
  if (!isNum(v) || v < 0) return { v: null, reason: 'invalid' };
  return { v, reason: null };
}
function settleDays(fees, mkt, dflt) {
  const s = fees && fees.settle && fees.settle[mkt];
  const m = typeof s === 'string' ? /^T\+(\d+)$/.exec(s) : null;
  return m ? +m[1] : dflt;
}

export function sellTrial(inp) {
  const { need, deadline, selected, items, alloc, fees, fx, cash, monthly } = inp || {};
  if (!isNum(need)) return bad('invalid_number', 'need');
  if (need < 0 || need > 99999999) return bad('out_of_range', 'need');
  if (parseIso(deadline) == null) return bad('invalid_date', 'deadline');
  if (!Array.isArray(items)) return bad('invalid_shape', 'items');
  if (!(Array.isArray(selected) || selected instanceof Set)) return bad('invalid_shape', 'selected');
  if (!isNum(cash)) return bad('invalid_number', 'cash');
  if (cash < 0) return bad('out_of_range', 'cash');
  if (!isNum(monthly)) return bad('invalid_number', 'monthly');
  if (monthly < 0) return bad('out_of_range', 'monthly');
  if (fees != null && typeof fees !== 'object') return bad('invalid_shape', 'fees');

  const byKey = new Map();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || typeof it.key !== 'string') return bad('invalid_shape', `items[${i}].key`);
    if (it.mkt !== 'TW' && it.mkt !== 'US') return bad('invalid_shape', `items[${i}].mkt`);
    if (!isNum(it.value_twd) || it.value_twd < 0) return bad('invalid_number', `items[${i}].value_twd`);
    if (!isNum(it.cost_twd)) return bad('invalid_number', `items[${i}].cost_twd`);
    byKey.set(it.key, it);
  }
  const sel = new Set(selected);
  for (const k of sel) if (!byKey.has(k)) return { ok: false, error: 'unknown_key', field: 'selected', key: k };

  const meta = new Map();
  for (const a of (alloc && alloc.items) || []) if (a && typeof a.key === 'string') meta.set(a.key, a);
  const unmapped = [];
  const clsOf = (it) => {
    const a = meta.get(it.key);
    if (a && CLS.includes(a.cls)) return { cls: a.cls, single: a.single === true };
    unmapped.push(it.key);
    return { cls: it.mkt === 'TW' ? 'tw_eq' : 'us_eq', single: true };
  };

  const chosen = items.filter((it) => sel.has(it.key));
  const rest = items.filter((it) => !sel.has(it.key));
  const hasTW = chosen.some((it) => it.mkt === 'TW'), hasUS = chosen.some((it) => it.mkt === 'US');
  if (hasUS && !(isNum(fx) && fx > 0)) return bad('missing_fx', 'fx');

  const unknown = [];
  const note = (key, r) => { if (r.v == null && !unknown.some((u) => u.key === key)) unknown.push({ key, reason: r.reason }); };
  const fRate = rateOf(fees, 'tw_fee_rate'), fMin = plainOf(fees, 'tw_fee_min');
  const tRate = { stock: rateOf(fees, 'tw_tax_stock'), etf: rateOf(fees, 'tw_tax_etf'), bond_etf: rateOf(fees, 'tw_tax_bond_etf') };
  const usDcaRate = rateOf(fees, 'us_dca_rate'), usMinUsd = plainOf(fees, 'us_min_usd'), usStdRate = rateOf(fees, 'us_std_rate');
  if (hasTW) { note('tw_fee_rate', fRate); if (fRate.v != null) note('tw_fee_min', fMin); }
  if (hasUS) { note('us_dca_rate', usDcaRate); note('us_min_usd', usMinUsd); note('us_std_rate', usStdRate); }

  let gross = 0, cost = 0;
  let twCommission = 0, twTax = 0, usDca = 0, usMin = 0, usStd = 0;
  const warnings = [];
  const rows = chosen.map((it) => {
    const { cls, single } = clsOf(it);
    const value = it.value_twd;
    gross += value;
    cost += it.cost_twd;
    const row = {
      key: it.key, code: it.code ?? null, name: it.name ?? null, mkt: it.mkt, cls, single, value, cost: it.cost_twd,
      taxKind: null, twCommission: null, twTax: null, usDca: null, usMin: null, usStd: null,
    };
    if (it.mkt === 'TW') {
      const kind = cls === 'bond_s' || cls === 'bond_l' ? 'bond_etf' : single ? 'stock' : 'etf';
      row.taxKind = kind;
      note(`tw_tax_${kind}`, tRate[kind]);        // tw_tax_stock／tw_tax_etf／tw_tax_bond_etf
      if (fRate.v != null) {
        row.twCommission = Math.max(value * fRate.v, fMin.v == null ? 0 : fMin.v);
        twCommission += row.twCommission;
      }
      if (tRate[kind].v != null) { row.twTax = value * tRate[kind].v; twTax += row.twTax; }
    } else {
      if (usDcaRate.v != null) { row.usDca = value * usDcaRate.v; usDca += row.usDca; }
      if (usStdRate.v != null) { row.usStd = value * usStdRate.v; usStd += row.usStd; }
      if (usMinUsd.v != null) {
        row.usMin = usMinUsd.v * fx;
        usMin += row.usMin;
        if (row.usMin >= 0.05 * value) {
          warnings.push({ key: it.key, name: it.name ?? null, value, minFeeUsd: usMinUsd.v, minFeeTwd: row.usMin, pct: value > 0 ? row.usMin / value : null });
        }
      }
    }
    return row;
  });

  const tw = hasTW ? { commission: twCommission, tax: twTax, total: twCommission + twTax } : null;
  const us = hasUS ? { dca: usDcaRate.v == null ? null : usDca, min: usMinUsd.v == null ? null : usMin, std: usStdRate.v == null ? null : usStd, warnings } : null;
  // C-2：區間只用 std（最樂觀）與 min（最保守）；dca（定期定額比率）只適用定期定額扣款、不適用處分，保留在 us.dca 當參考，不入區間
  const usAvail = us ? [us.min, us.std].filter((v) => v != null) : [];
  const usLow = usAvail.length ? Math.min(...usAvail) : 0, usHigh = usAvail.length ? Math.max(...usAvail) : 0;
  const twTotal = tw ? tw.total : 0;
  const feeTotal = { low: twTotal + usLow, high: twTotal + usHigh };
  const net = { low: gross - feeTotal.high, high: gross - feeTotal.low };

  const cover = {
    status: net.low >= need ? 'enough' : 'short',
    diffLow: net.low - need, diffHigh: net.high - need,
    shortfall: Math.max(0, need - net.low),
    straddle: net.low < need && need <= net.high,
  };

  const sd = { TW: settleDays(fees, 'TW', 2), US: settleDays(fees, 'US', 1) };
  const dl = rollBackToWeekday(deadline);          // 週六／週日期限先滾到上一個週五（D-4）；國定假日與美股休市未處理
  const latest = {
    TW: hasTW ? backBusinessDays(dl, 1 + sd.TW) : null,
    US: hasUS ? backBusinessDays(dl, 1 + sd.US) : null,
    binding: null, settleDays: sd,
  };
  const ds = [latest.TW, latest.US].filter(Boolean).sort();
  latest.binding = ds.length ? ds[0] : null;

  const clsVal = new Array(N).fill(0);
  let restValue = 0, restCost = 0, restPnl = 0;
  for (const it of rest) {
    clsVal[CLS.indexOf(clsOf(it).cls)] += it.value_twd;
    restValue += it.value_twd;
    restCost += it.cost_twd;
    restPnl += isNum(it.pnl_twd) ? it.pnl_twd : it.value_twd - it.cost_twd;
  }
  const cashAfter = cash + net.low - need;
  const after = {
    byCls: CLS.map((cls, i) => ({ cls, value: clsVal[i], w: restValue > 0 ? clsVal[i] / restValue : 0 })),
    base: restValue,
    cash: cashAfter,
    months: monthly > 0 ? cashAfter / monthly : null,
    monthsBefore: monthly > 0 ? cash / monthly : null,
  };

  const notes = SELL_NOTES.slice();
  if (hasTW) notes.push(`台股手續費與證交稅${BROKER}`);
  if (hasUS) notes.push(`美股處分費用以電子單牌告與一般單最低兩個情境估算區間；定期定額比率只適用定期定額，僅供參考，${BROKER}`);
  notes.push(`最晚處分日只避開週末（期限落在週末先視為前一個週五），國定假日與美股休市未處理，${BROKER}`);
  if (unknown.length) notes.push(`部分費率查無資料，該項${BROKER}、未計入`);

  return {
    ok: true, empty: chosen.length === 0, need, deadline, count: chosen.length, unmapped: [...new Set(unmapped)],
    gross, rows,
    fees: { tw, us, unknown, total: feeTotal },
    net, cover, latest, after,
    realized: { low: net.low - cost, high: net.high - cost, cost },
    remaining: { count: rest.length, value: restValue, cost: restCost, unrealized: restPnl },
    notes,
  };
}

// Neutral-named aliases for the UI layer (same functions; the original names stay for the tests).
export const fundsTrial = sellTrial;
export const FUNDS_NOTES = SELL_NOTES;

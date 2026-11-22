/* advisor_calc.js 單元測試。執行：cd pfm-app && node --test tools/test_advisor_calc.mjs
 * 全部資料皆為虛構（規格 §2.9 的虛構 CMA、虛構持股）；repo 內不放真實財務數字。
 * 規格 §2.9 案例 1（真實 13 檔個股權重的「現況」）無法在 repo 內驗證，這裡改用虛構現況＋含 3 檔虛構個股項，
 * 期望值來自獨立的 Python 參考實作（numpy 全網格＋math.erf；腳本不在 repo）。真實權重的案例 1 由主對話另行驗證。
 * V2 審查 A-1 之後：cma.mu 是年化複利（幾何）報酬，模型用漂移 d_i = ln(1+mu_i) + σ_i²/2 再扣 σp²/2；
 * 下列所有「現況／案例／不可行」期望值都是以新公式由 Python 參考實作重算（不是沿用舊值、也不是由被測程式反推）。
 * 另有「單一類別 100% → median 恰等於該類 mu」的性質測試（七類都測，容差 1e-9），含 next/data/cma.json 的實際檔案。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as A from '../next/js/advisor_calc.js';

const MODULE_URL = new URL('../next/js/advisor_calc.js', import.meta.url).href;
const BANNED = /買進|賣出|買入|賣掉|加碼|減碼|出清|停損|停利|獲利了結|進場|出場|抄底|buy|sell/i;   // 畫面文字禁用字詞（§0／§5.6）
const near = (a, b, tol, label) => assert.ok(Math.abs(a - b) <= tol, `${label ?? ''} expected ${b}, got ${a} (tol ${tol})`);
const nearArr = (a, b, tol, label) => { assert.equal(a.length, b.length); a.forEach((x, i) => near(x, b[i], tol, `${label ?? ''}[${i}]`)); };

/* ── 虛構 CMA（§2.9）──────────────────────────────────────────────────────────────────────── */
function mkCma() {
  const mu = [0.015, 0.03, 0.04, 0.08, 0.08, 0.075, 0.1];
  const sg = [0.005, 0.06, 0.08, 0.2, 0.17, 0.16, 0.24];
  const cap = [1, 1, 0.6, 0.6, 0.7, 0.7, 0.3];
  const corr = Array.from({ length: 7 }, (_, i) => Array.from({ length: 7 }, (_, j) => (i === j ? 1 : 0)));
  const set = (i, j, v) => { corr[i][j] = v; corr[j][i] = v; };
  set(1, 2, 0.5); set(1, 3, -0.1); set(1, 4, 0.1); set(1, 5, 0.1); set(1, 6, 0.1);
  set(2, 3, 0.1); set(2, 4, 0.2); set(2, 5, 0.2); set(2, 6, 0.2);
  set(3, 4, 0.6); set(3, 5, 0.7); set(3, 6, 0.65);
  set(4, 5, 0.9); set(4, 6, 0.9);
  set(5, 6, 0.8);
  return { rev: 0, mu_kind: 'geometric', classes: A.CLS.map((id, i) => ({ id, mu: mu[i], sigma: sg[i], cap: cap[i] })), corr, idio: { tw_single: 0.25, us_single: 0.35 } };
}
const CMA = mkCma();

/* 獨立計數（DP）：5% 網格、cap、第 7 類＝剩餘 */
function countGrid(cma, mask) {
  const lim = cma.classes.map((c, i) => (mask[i] ? Math.min(20, Math.floor(c.cap * 20 + 1e-9)) : 0));
  let ways = new Array(21).fill(0); ways[0] = 1;
  for (let k = 0; k < 7; k++) {
    const nx = new Array(21).fill(0);
    for (let s = 0; s <= 20; s++) if (ways[s]) for (let u = 0; u <= Math.min(lim[k], 20 - s); u++) nx[s + u] += ways[s];
    ways = nx;
  }
  return ways[20];
}

/* ── Φ ────────────────────────────────────────────────────────────────────────────────────── */
test('Φ：已知點與對稱', () => {
  near(A.phi(0), 0.5, 1e-8, 'Φ(0)');
  near(A.phi(1.96), 0.975, 1e-4, 'Φ(1.96)≈0.975');
  near(A.phi(1.96), 0.9750021048517795, 2e-7, 'Φ(1.96) 精確值');
  near(A.phi(1), 0.8413447460685429, 2e-7, 'Φ(1)');
  near(A.phi(-1.645), 0.04998491, 2e-7, 'Φ(-1.645)');
  near(A.phi(3), 0.9986501019683699, 2e-7, 'Φ(3)');
  for (const x of [0.3, 1.1, 2.7, 5]) near(A.phi(x) + A.phi(-x), 1, 1e-15, `對稱 ${x}`);
  assert.equal(A.phi(Infinity), 1);
  assert.equal(A.phi(-Infinity), 0);
  assert.ok(Number.isNaN(A.phi(NaN)));
  near(A.erf(0.5), 0.5204998778130465, 1.5e-7, 'erf(0.5)');
});

/* ── CMA 驗證 ─────────────────────────────────────────────────────────────────────────────── */
test('validateCma：好壞樣本', () => {
  assert.deepEqual(A.validateCma(mkCma()), { ok: true });
  const mut = (f) => { const c = mkCma(); f(c); return A.validateCma(c); };
  assert.equal(A.validateCma(null).ok, false);
  assert.equal(mut((c) => { c.classes.pop(); }).error, 'invalid_shape');
  assert.equal(mut((c) => { c.classes[2].id = 'x'; }).error, 'invalid_shape');
  assert.equal(mut((c) => { c.classes[3].mu = NaN; }).error, 'invalid_number');
  assert.deepEqual(mut((c) => { c.classes[3].mu = -1; }), { ok: false, error: 'out_of_range', field: 'classes[3].mu' });   // ln(1+mu) 要求 mu>−1
  assert.deepEqual(mut((c) => { c.classes[0].mu = -2; }), { ok: false, error: 'out_of_range', field: 'classes[0].mu' });
  assert.equal(mut((c) => { c.classes[3].mu = -0.99; }).ok, true);
  assert.equal(mut((c) => { c.classes[3].sigma = -0.1; }).error, 'invalid_number');
  assert.equal(mut((c) => { c.classes[3].cap = 0; }).error, 'out_of_range');
  assert.equal(mut((c) => { c.classes[3].cap = 1.5; }).error, 'out_of_range');
  assert.equal(mut((c) => { c.corr[1][2] = 0.9; }).error, 'invalid_shape');      // 不對稱
  assert.equal(mut((c) => { c.corr[2][2] = 0.9; }).error, 'out_of_range');       // 對角不是 1
  assert.equal(mut((c) => { c.corr[1][2] = 1.5; c.corr[2][1] = 1.5; }).error, 'invalid_number');
  assert.equal(mut((c) => { c.idio.us_single = -1; }).error, 'invalid_number');
  assert.equal(A.portfolioStats([0, 0, 0, 0, 0, 0, 1], { classes: [] }).ok, false);
});

test('validateCma：mu_kind 必須是 geometric（缺、arithmetic、其他值一律拒絕；既有錯誤格式 invalid_shape＋欄位名）', () => {
  const mut = (f) => { const c = mkCma(); f(c); return A.validateCma(c); };
  const want = { ok: false, error: 'invalid_shape', field: 'mu_kind' };
  assert.deepEqual(mut((c) => { delete c.mu_kind; }), want);                      // 缺
  assert.deepEqual(mut((c) => { c.mu_kind = 'arithmetic'; }), want);              // 算術口徑 → 不收
  assert.deepEqual(mut((c) => { c.mu_kind = 'Geometric'; }), want);               // 大小寫不同也不收
  assert.deepEqual(mut((c) => { c.mu_kind = ''; }), want);
  assert.deepEqual(mut((c) => { c.mu_kind = null; }), want);
  assert.deepEqual(mut((c) => { c.mu_kind = true; }), want);
  // 口徑不明時所有入口都不給數字（不猜）
  const noKind = mkCma(); delete noKind.mu_kind;
  assert.deepEqual(A.portfolioStats([0, 0, 0, 1, 0, 0, 0], noKind), want);
  assert.deepEqual(A.buildGrid(noKind), want);
  assert.deepEqual(A.solve(noKind, { T: 0.07, Lmax: 0.2 }), want);
  const arith = mkCma(); arith.mu_kind = 'arithmetic';
  assert.equal(A.solve(arith, { T: 0.07, Lmax: 0.2 }).ok, false);
  assert.equal(A.validateCma(mkCma()).ok, true);
});

/* ── 組合統計（虛構現況，含 3 檔虛構個股項）──────────────────────────────────────────────────── */
const CUR_A = [0, 0.1, 0, 0.4, 0.1, 0, 0.4];
const SINGLES = [{ w: 0.15, mkt: 'TW' }, { w: 0.2, mkt: 'US' }, { w: 0.1, mkt: 'US' }];

test('現況統計：μp（漂移）、σp、g、中位數、loss95（Python 參考值，幾何 mu，含個股項）', () => {
  const s = A.portfolioStats(CUR_A, CMA, SINGLES);
  assert.equal(s.ok, true);
  near(s.mu, 0.1007054727, 1e-9, 'mu＝Σ w·(ln(1+mu)+σ²/2)');
  near(s.sigma, 0.1951036904, 1e-9, 'sigma（不受 mu 口徑影響）');
  near(s.g, 0.0816727477, 1e-9, 'g');
  near(s.median, 0.0851006501, 1e-9, 'median');
  near(s.loss95, 0.2127999132, 1e-9, 'loss95');
  // 達標機率（T=7%）：Python 以精確 erf 計算；A&S 7.1.26 誤差 ≤ 7.5e-8
  const ref = { 1: 0.5286309955, 3: 0.5495052437, 5: 0.5638014768, 10: 0.5898437963 };
  const t = A.probTable(s, 0.07);
  for (const H of A.PROB_YEARS) near(t[H], ref[H], 1e-6, `P(${H}年)`);
  near(A.hitProb(s, 0.07, 5), ref[5], 1e-6, 'hitProb');
});

test('個股項只加在現況：不傳 singles 與傳空陣列結果相同，且 σp 較小', () => {
  const s0 = A.portfolioStats(CUR_A, CMA);
  near(s0.sigma, 0.1747403788, 1e-9, 'sigma 無個股項');
  near(s0.g, 0.0854383727, 1e-9, 'g 無個股項');
  near(s0.median, 0.0891944352, 1e-9, 'median 無個股項');
  near(s0.loss95, 0.1829128757, 1e-9, 'loss95 無個股項');
  assert.deepEqual(A.portfolioStats(CUR_A, CMA, []), s0);
  assert.ok(A.portfolioStats(CUR_A, CMA, SINGLES).sigma > s0.sigma);
  // 個股項只增加變異數、不改均值（維持既有作法）：μp 逐位相同，g 因 σp 變大而較低
  assert.equal(A.portfolioStats(CUR_A, CMA, SINGLES).mu, s0.mu);
  assert.ok(A.portfolioStats(CUR_A, CMA, SINGLES).g < s0.g);
});

/* ── A-1：mu 是幾何（年化複利）報酬 ───────────────────────────────────────────────────────────── */
const unit = (i) => { const w = [0, 0, 0, 0, 0, 0, 0]; w[i] = 1; return w; };

test('A-1 驗收性質：單一類別 100%（無個股）→ median 恰等於該類輸入的 mu（七類都測，容差 1e-9）', () => {
  for (let i = 0; i < 7; i++) {
    const s = A.portfolioStats(unit(i), CMA);
    assert.equal(s.ok, true);
    near(s.median, CMA.classes[i].mu, 1e-9, `${A.CLS[i]} median`);
    near(s.g, Math.log(1 + CMA.classes[i].mu), 1e-12, `${A.CLS[i]} g＝ln(1+mu)`);
    near(s.sigma, CMA.classes[i].sigma, 1e-12, `${A.CLS[i]} sigma`);
    near(s.mu, Math.log(1 + CMA.classes[i].mu) + CMA.classes[i].sigma ** 2 / 2, 1e-12, `${A.CLS[i]} 漂移`);
    // loss95 閉式：1 − (1+mu)·e^{−1.645σ}
    near(s.loss95, 1 - (1 + CMA.classes[i].mu) * Math.exp(-1.645 * CMA.classes[i].sigma), 1e-12, `${A.CLS[i]} loss95`);
    // 達標機率：目標＝mu 時 z=0 → 各年期都是 0.5
    near(A.hitProb(s, CMA.classes[i].mu, 5), 0.5, 1e-7, `${A.CLS[i]} P(T=mu)`);
  }
  // 與單類 cap 無關（portfolioStats 不看 cap）；不同 mu 也成立（隨機抽樣 mu、sigma）
  for (const [mu, sg] of [[0.064, 0.24], [-0.03, 0.1], [0.2, 0.6], [0.0, 0.05], [0.017, 0.006]]) {
    const c = mkCma(); c.classes[3].mu = mu; c.classes[3].sigma = sg;
    near(A.portfolioStats(unit(3), c).median, mu, 1e-9, `mu=${mu} sigma=${sg}`);
  }
});

test('A-1：實際檔案 next/data/cma.json 也滿足「單類 100% → median＝mu」，且 mu_kind＝geometric', () => {
  const real = JSON.parse(readFileSync(new URL('../next/data/cma.json', import.meta.url), 'utf8'));
  assert.equal(real.mu_kind, 'geometric');
  assert.deepEqual(A.validateCma(real), { ok: true });
  for (let i = 0; i < 7; i++) near(A.portfolioStats(unit(i), real).median, real.classes[i].mu, 1e-9, `real ${A.CLS[i]}`);
});

test('A-1：多類別時分散效果仍在（組合 g 大於各類 g 的加權平均）；個股項不改均值；σp 與 mu 口徑無關', () => {
  const mixes = [[0, 0, 0, 0.5, 0.5, 0, 0], [0, 0.2, 0.2, 0.2, 0.2, 0.1, 0.1], [0.1, 0.1, 0.1, 0.2, 0.2, 0.2, 0.1], CUR_A];
  for (const w of mixes) {
    const s = A.portfolioStats(w, CMA);
    const avgG = w.reduce((a, wi, i) => a + wi * Math.log(1 + CMA.classes[i].mu), 0);   // 單類 g_i＝ln(1+mu_i)
    assert.ok(s.g > avgG, `g ${s.g} 應大於加權平均 ${avgG}`);
  }
  near(A.portfolioStats(mixes[0], CMA).g, 0.0804735411, 1e-9, '50/50 台股＋美股 g（Python 參考）');
  near(A.portfolioStats(mixes[1], CMA).g, 0.0675026037, 1e-9, '混合 g（Python 參考）');
  // σp 不受 mu 影響：把所有 mu 加 5 個百分點，σp 不變、g 與 median 變大
  const hi = mkCma(); hi.classes.forEach((c) => { c.mu += 0.05; });
  for (const w of mixes) {
    const a = A.portfolioStats(w, CMA), b = A.portfolioStats(w, hi);
    assert.equal(a.sigma, b.sigma);
    assert.ok(b.g > a.g && b.median > a.median);
  }
  // 完全正相關、同 sigma 的兩類各 50%：σp＝σ，g＝ln(1+mu) 的加權平均（沒有分散效果）
  const same = mkCma();
  same.classes[4].mu = same.classes[3].mu; same.classes[4].sigma = same.classes[3].sigma;
  for (let k = 0; k < 7; k++) if (k !== 3 && k !== 4) { same.corr[4][k] = same.corr[3][k]; same.corr[k][4] = same.corr[k][3]; }
  same.corr[3][4] = 1; same.corr[4][3] = 1;
  near(A.portfolioStats([0, 0, 0, 0.5, 0.5, 0, 0], same).median, same.classes[3].mu, 1e-9, '完全相關：median＝mu');
});

test('A-1：網格（快速迴圈）與 portfolioStats 用同一組漂移：逐格比對 Lmax 內最高中位數；只開 cash 時只有 1 格且 median＝mu', () => {
  // 獨立暴力：以遞迴列出全開 198,744 組 5% 網格，逐組呼叫 portfolioStats，取 loss95≤Lmax 的最高 median
  const lim = CMA.classes.map((c) => Math.min(20, Math.floor(c.cap * 20 + 1e-9)));
  let best = -Infinity, n = 0;
  const u = new Array(7).fill(0);
  const rec = (k, rem) => {
    if (k === 6) {
      if (rem > lim[6]) return;
      u[6] = rem; n++;
      const st = A.portfolioStats(u.map((x) => x / 20), CMA);
      if (st.loss95 <= 0.1 + 1e-12 && st.median > best) best = st.median;
      return;
    }
    for (let x = 0; x <= Math.min(rem, lim[k]); x++) { u[k] = x; rec(k + 1, rem - x); }
  };
  rec(0, 20);
  assert.equal(n, 198744);
  const r = A.solve(CMA, { T: 0.12, Lmax: 0.1 });                       // 達不到 T → 不可行，回報 Lmax 內最高中位數
  assert.equal(r.feasible, false);
  near(r.maxMedianWithinLmax, best, 1e-12, 'grid vs portfolioStats');
  // 只開 cash：列舉只有 100% cash 一格；median＝cash 的 mu
  const only = [true, false, false, false, false, false, false];
  assert.equal(A.buildGrid(CMA, only).count, 1);
  const c = A.solve(CMA, { T: CMA.classes[0].mu - 1e-9, Lmax: 1, allowed: only });
  assert.equal(c.feasible, true);
  nearArr(c.w, [1, 0, 0, 0, 0, 0, 0], 0);
  near(c.stats.median, CMA.classes[0].mu, 1e-9, 'cash-only median＝mu');
});

test('hitProb：σ 極小時以 1e-9 保底；無效輸入回 null', () => {
  assert.equal(A.hitProb({ g: 0.1, sigma: 0 }, 0.05, 5), 1);
  assert.equal(A.hitProb({ g: 0.01, sigma: 0 }, 0.05, 5), 0);
  assert.equal(A.hitProb({ g: 0.1, sigma: 0.1 }, NaN, 5), null);
  assert.equal(A.hitProb({ g: 0.1, sigma: 0.1 }, -1, 5), null);
  assert.equal(A.hitProb({ g: 0.1, sigma: 0.1 }, 0.05, 0), null);
  assert.equal(A.hitProb({ g: 0.1, sigma: 0.1 }, 0.05, -3), null);
  assert.equal(A.hitProb(null, 0.05, 5), null);
  assert.equal(A.probTable({ g: NaN, sigma: 0.1 }, 0.05), null);
});

/* ── 網格列舉 ─────────────────────────────────────────────────────────────────────────────── */
test('網格：全開 198,744 組（與獨立 DP 計數一致）、快取行為', () => {
  const c = mkCma();
  const b1 = A.buildGrid(c);
  assert.deepEqual(b1, { ok: true, count: 198744, hit: false });
  assert.equal(countGrid(c, A.ALL_ALLOWED), 198744);
  assert.deepEqual(A.buildGrid(c), { ok: true, count: 198744, hit: true });          // 同物件同遮罩 → 命中
  assert.equal(A.buildGrid(mkCma()).hit, false);                                       // 不同物件 → 重算
  A.clearCache();
  assert.equal(A.buildGrid(c).hit, false);
  // 滑桿只篩選：多次 solve 不重新列舉
  A.solve(c, { T: 0.07, Lmax: 0.2 });
  assert.equal(A.buildGrid(c).hit, true);
  A.solve(c, { T: 0.05, Lmax: 0.1 });
  assert.equal(A.buildGrid(c).hit, true);
});

test('網格：允許類別遮罩縮小列舉數，且只用允許的類別', () => {
  const mask = [true, true, false, true, true, false, true];
  const b = A.buildGrid(CMA, mask);
  assert.equal(b.count, 7791);                     // Python 參考
  assert.equal(b.count, countGrid(CMA, mask));
  // 全開時 T=.05、Lmax=.10 的最適解用到 bond_l 與 gl_eq（[0,.15,.35,.2,.05,.05,.2]）；遮罩後必須改選別的組合且 w[2]、w[5] 為 0
  const open = A.solve(CMA, { T: 0.05, Lmax: 0.1 });
  nearArr(open.w, [0, 0.15, 0.35, 0.2, 0.05, 0.05, 0.2], 1e-9, '全開 w');
  const r = A.solve(CMA, { T: 0.05, Lmax: 0.1, allowed: mask });
  assert.equal(r.feasible, true);
  assert.equal(r.count, 7791);
  assert.equal(r.w[2], 0);
  assert.equal(r.w[5], 0);
  nearArr(r.w, [0, 0.45, 0, 0.25, 0.15, 0, 0.15], 1e-9, 'masked w（Python 參考）');
  near(r.stats.median, 0.0674792515, 1e-9, 'masked median');
  near(r.stats.loss95, 0.0999766116, 1e-9, 'masked loss95');
  assert.notDeepEqual(r.w, open.w);
  // cash 永遠允許，即使呼叫端傳 false
  const onlyEq = A.buildGrid(CMA, [false, false, false, true, true, false, true]);
  assert.equal(onlyEq.count, countGrid(CMA, [true, false, false, true, true, false, true]));
  // 遮罩長度錯誤
  assert.equal(A.buildGrid(CMA, [true]).error, 'invalid_shape');
});

test('allowedClasses：cash ∪ 現況>0 ∪ 勾選白名單類別', () => {
  assert.deepEqual(A.allowedClasses([0, 0.1, 0, 0.4, 0.1, 0, 0.4], []), [true, true, false, true, true, false, true]);
  assert.deepEqual(A.allowedClasses([0, 0, 0, 1, 0, 0, 0], ['gl_eq', 'bogus']), [true, false, false, true, false, true, false]);
  assert.deepEqual(A.allowedClasses(null, null), [true, false, false, false, false, false, false]);
});

/* ── 求解：規格 §2.9 案例 2–5（幾何 mu 修訂後的期望值；誤差 ≤1e-6）──────────────────────────────── */
const CUR_B = [0.25, 0, 0.25, 0.25, 0, 0.25, 0];   // 另一組虛構現況：結果應與現況無關

test('案例 2：T=.07、Lmax=.20、全開 → 可行', () => {
  for (const cur of [CUR_A, CUR_B, undefined]) {
    const r = A.solve(CMA, { T: 0.07, Lmax: 0.2, current: cur });
    assert.equal(r.ok, true);
    assert.equal(r.feasible, true);
    assert.equal(r.count, 198744);
    nearArr(r.w, [0, 0, 0, 0.4, 0.3, 0, 0.3], 1e-6, 'w');
    near(r.stats.median, 0.090735, 1e-6, 'median');
    near(r.stats.sigma, 0.18215, 1e-6, 'sigma');
    near(r.stats.loss95, 0.19167, 1e-6, 'loss95');
    near(r.prob[5], 0.593133, 1e-6, 'P(5年)');
    assert.deepEqual(Object.keys(r.prob), ['1', '3', '5', '10']);
    assert.ok(r.stats.loss95 <= 0.2 + 1e-12 && r.stats.median >= 0.07 - 1e-12);
  }
});

test('案例 3：T=.05、Lmax=.10 → 可行', () => {
  for (const cur of [CUR_A, CUR_B, undefined]) {
    const r = A.solve(CMA, { T: 0.05, Lmax: 0.1, current: cur });
    assert.equal(r.feasible, true);
    assert.equal(r.count, 198744);
    nearArr(r.w, [0, 0.15, 0.35, 0.2, 0.05, 0.05, 0.2], 1e-6, 'w');
    near(r.stats.median, 0.069409, 1e-6, 'median');
    near(r.stats.sigma, 0.104742, 1e-6, 'sigma');
    near(r.stats.loss95, 0.099851, 1e-6, 'loss95');
    near(r.prob[5], 0.652109, 1e-6, 'P(5年)');
  }
});

test('案例 4：T=.12、Lmax=.10 → 不可行；Lmax 內最高中位數 .069409；達 T 無解', () => {
  const r = A.solve(CMA, { T: 0.12, Lmax: 0.1, current: CUR_A });
  assert.equal(r.ok, true);
  assert.equal(r.feasible, false);
  assert.equal(r.count, 198744);
  near(r.maxMedianWithinLmax, 0.069409, 1e-6, 'X');
  assert.equal(r.reachable, false);
  assert.equal(r.minLossForTarget, null);
});

// 舊案例 5（T=.09、Lmax=.30）在幾何 mu 下變成可行（全開最高中位數 .090801），故改用 T=.10：仍是「Lmax 夠鬆但目標達不到」的不可行案例
test('案例 5：T=.10、Lmax=.30 → 不可行；Lmax 內最高中位數 .090801；達 T 無解', () => {
  const r = A.solve(CMA, { T: 0.1, Lmax: 0.3, current: CUR_B });
  assert.equal(r.feasible, false);
  near(r.maxMedianWithinLmax, 0.090801, 1e-6, 'X');
  assert.equal(r.reachable, false);
  assert.equal(r.minLossForTarget, null);
});

test('案例 5b：T=.09、Lmax=.30 → 在幾何 mu 下可行（舊算術口徑下不可行；Python 參考）', () => {
  const r = A.solve(CMA, { T: 0.09, Lmax: 0.3, current: CUR_B });
  assert.equal(r.feasible, true);
  nearArr(r.w, [0, 0, 0, 0.45, 0.25, 0, 0.3], 1e-9, 'w');
  near(r.stats.median, 0.090801, 1e-6, 'median');
  near(r.stats.loss95, 0.193197, 1e-6, 'loss95');
  assert.ok(r.stats.median >= 0.09 - 1e-12 && r.stats.loss95 <= 0.3 + 1e-12);
});

test('不可行但達得到 T：給「達 T 所需的最小 1 年 95% 下行」（Python 參考 .1018488052）', () => {
  const r = A.solve(CMA, { T: 0.07, Lmax: 0.1 });
  assert.equal(r.feasible, false);
  assert.equal(r.reachable, true);
  near(r.minLossForTarget, 0.1018488052, 1e-9, 'Y');
  near(r.maxMedianWithinLmax, 0.0694092832, 1e-9, 'X');
  assert.ok(r.minLossForTarget > 0.1);                   // 必然大於 Lmax，否則就可行
});

test('不可行時回傳物件「沒有任何權重欄位」', () => {
  for (const [T, L] of [[0.12, 0.1], [0.1, 0.3], [0.07, 0.1]]) {
    const r = A.solve(CMA, { T, Lmax: L, current: CUR_A });
    assert.equal(r.feasible, false);
    assert.deepEqual(Object.keys(r).sort(), ['T', 'Lmax', 'count', 'feasible', 'maxMedianWithinLmax', 'minLossForTarget', 'ok', 'reachable'].sort());
    const s = JSON.stringify(r);
    for (const bad of ['"w"', 'weight', 'units', 'stats', 'prob', 'alloc']) assert.ok(!s.includes(bad), `不該出現 ${bad}`);
  }
});

test('可行判定容差 1e-12：差 5e-13 仍算可行，差 1e-9 就不算', () => {
  const r0 = A.solve(CMA, { T: 0.07, Lmax: 0.2 });
  const exact = A.solve(CMA, { T: r0.stats.median, Lmax: r0.stats.loss95 });   // 邊界值
  assert.equal(exact.feasible, true);
  nearArr(exact.w, r0.w, 0, 'w 相同');
  // 在容差內：loss95 超出 Lmax 5e-13、中位數低於 T 5e-13 → 同一個組合仍可行
  const within = A.solve(CMA, { T: r0.stats.median + 5e-13, Lmax: r0.stats.loss95 - 5e-13 });
  assert.equal(within.feasible, true);
  nearArr(within.w, r0.w, 0, 'w 相同（容差內）');
  // 超出容差：該組合必須被排除（可能改選別的組合或不可行，但絕不能回傳違反條件者）
  for (const p of [{ T: r0.stats.median + 1e-9, Lmax: r0.stats.loss95 }, { T: r0.stats.median, Lmax: r0.stats.loss95 - 1e-9 }]) {
    const r = A.solve(CMA, p);
    if (r.feasible) {
      assert.notDeepEqual(r.w, r0.w);
      assert.ok(r.stats.median >= p.T - 1e-12 && r.stats.loss95 <= p.Lmax + 1e-12);
    }
  }
});

/* ── 平手規則 ─────────────────────────────────────────────────────────────────────────────── */
test('平手規則：z 與 loss95 完全相同時，取與現況差距小者，再平手取先列舉到者', () => {
  // 讓 tw_eq 與 us_eq 完全相同（含相關係數 1）→ 兩類的權重在總和不變下互換，統計量逐位相同
  const dup = mkCma();
  dup.classes[4].mu = dup.classes[3].mu;
  dup.classes[4].sigma = dup.classes[3].sigma;
  for (let k = 0; k < 7; k++) if (k !== 3 && k !== 4) { dup.corr[4][k] = dup.corr[3][k]; dup.corr[k][4] = dup.corr[k][3]; }
  dup.corr[3][4] = 1; dup.corr[4][3] = 1;
  assert.equal(A.validateCma(dup).ok, true);

  const params = { T: 0.07, Lmax: 0.2 };
  const base = A.solve(dup, { ...params, current: undefined });
  assert.equal(base.feasible, true);
  const S = Math.round((base.w[3] + base.w[4]) * 20);      // 兩類合計格數
  assert.ok(S >= 2, '測試前提：最適解同時用到兩個相同類別');

  // 後 3 組的現況會讓「等距拆法」的浮點距離相差約 1e-17；沒有先把距離四捨五入到 10 位就會誤選後面的拆法
  const curs = [[0, 0, 0, 0.1, 0.1, 0, 0], [0, 0, 0, 0.3, 0, 0, 0], [0, 0, 0, 0, 0.35, 0, 0], [0, 0, 0, 0.2, 0.2, 0, 0.1],
    [0, 0, 0, 0.0214, 0.0309, 0, 0.1], [0, 0, 0, 0.0214, 0.1236, 0, 0.1], [0, 0, 0, 0.0428, 0.0721, 0, 0.1]];
  for (const cur of curs) {
    const r = A.solve(dup, { ...params, current: cur });
    assert.equal(Math.round((r.w[3] + r.w[4]) * 20), S);
    // 獨立期望：在合計 S 格的所有拆法（a=tw 格數，受 cap 12/14 限制）中，取 L1 距離最小（四捨五入 10 位），平手取 a 最小（先列舉到）
    let best = null;
    const nTied = [];
    for (let a = 0; a <= Math.min(S, 12); a++) {
      const b = S - a;
      if (b > 14) continue;
      let d = 0;
      for (let i = 0; i < 7; i++) {
        const wi = i === 3 ? a / 20 : i === 4 ? b / 20 : base.w[i];
        d += Math.abs(wi - cur[i]);
      }
      d = Math.round(d * 1e10) / 1e10;
      nTied.push(d);
      if (best == null || d < best.d) best = { a, b, d };
    }
    assert.equal(r.w[3], best.a / 20, `tw 權重 current=${cur}`);
    assert.equal(r.w[4], best.b / 20, `us 權重 current=${cur}`);
    if (cur[3] === 0.1 && cur[4] === 0.1) assert.ok(nTied.filter((d) => d === best.d).length >= 2, '此案例確實有多個同距離拆法');
  }
  // 沒有 current → 全平手 → 先列舉到者＝tw 格數最小的拆法
  const none = A.solve(dup, params);
  const aMin = Math.max(0, S - 14);
  assert.equal(none.w[3], aMin / 20);
  assert.equal(none.w[4], (S - aMin) / 20);

  // 「三個量先四捨五入到小數 10 位」：tw_eq 的 mu 只高 1e-12（z 差約 1e-12 < 1e-10）仍視為平手 → 仍由現況距離決定；
  // 若不先四捨五入，z 較大的 tw 偏重拆法會勝出
  const tilt = mkCma();
  tilt.classes[4].mu = tilt.classes[3].mu;
  tilt.classes[4].sigma = tilt.classes[3].sigma;
  for (let k = 0; k < 7; k++) if (k !== 3 && k !== 4) { tilt.corr[4][k] = tilt.corr[3][k]; tilt.corr[k][4] = tilt.corr[k][3]; }
  tilt.corr[3][4] = 1; tilt.corr[4][3] = 1;
  tilt.classes[3].mu += 1e-12;
  const usHeavy = [0, 0, 0, 0, 0.35, 0, 0];
  const exactUs = A.solve(dup, { ...params, current: usHeavy });
  const tiltUs = A.solve(tilt, { ...params, current: usHeavy });
  assert.ok(exactUs.w[4] > exactUs.w[3], '測試前提：現況偏美股時，平手規則選到美股偏重的拆法');
  assert.deepEqual(tiltUs.w, exactUs.w);
});

/* ── 與現況差距、搭配候選 ───────────────────────────────────────────────────────────────────── */
test('currentFromAlloc：權重基數＝可配置金額，多出的現金記在 cash', () => {
  const alloc = {
    base: 400000,
    by_cls: [{ cls: 'bond_s', value: 40000 }, { cls: 'tw_eq', value: 160000 }, { cls: 'us_eq', value: 40000 }, { cls: 'us_tech', value: 160000 }],
    items: [
      { key: 'TW:9001', name: '虛構ETF', cls: 'tw_eq', single: false, value_twd: 100000 },
      { key: 'TW:1111', name: '虛構個股甲', cls: 'tw_eq', single: true, value_twd: 60000 },
      { key: 'US:AAA', name: '虛構個股乙', cls: 'us_tech', single: true, value_twd: 120000 },
      { key: 'US:BBB', name: '虛構個股丙', cls: 'us_eq', single: true, value_twd: 40000 },
    ],
  };
  const c = A.currentFromAlloc(alloc, 500000);
  assert.equal(c.ok, true);
  assert.equal(c.base, 500000);
  assert.equal(c.stocks, 400000);
  assert.equal(c.cashExcess, 100000);
  nearArr(c.w, [0.2, 0.08, 0, 0.32, 0.08, 0, 0.32], 1e-12, 'w');
  near(c.w.reduce((a, b) => a + b, 0), 1, 1e-12, 'sum');
  assert.deepEqual(c.singles.map((s) => [s.key, s.mkt, s.w]), [['TW:1111', 'TW', 0.12], ['US:AAA', 'US', 0.24], ['US:BBB', 'US', 0.08]]);
  // 可配置金額 = 股票（沒有多餘現金）
  const c2 = A.currentFromAlloc(alloc, 400000);
  assert.equal(c2.cashExcess, 0);
  nearArr(c2.w, [0, 0.1, 0, 0.4, 0.1, 0, 0.4], 1e-12);
  // 可直接餵 portfolioStats
  assert.equal(A.portfolioStats(c2.w, CMA, c2.singles).ok, true);
  // 壞輸入
  assert.equal(A.currentFromAlloc(null, 1).ok, false);
  assert.equal(A.currentFromAlloc(alloc, NaN).error, 'invalid_number');
  assert.equal(A.currentFromAlloc({ by_cls: [], items: [] }, 0).ok, false);
  assert.equal(A.currentFromAlloc({ ...alloc, items: [{ key: 'XX:1', single: true, value_twd: 1 }] }, 500000).error, 'bad_key');
});

test('gapVsCurrent：百分點差與金額（差×可配置金額）', () => {
  const target = [0, 0.05, 0.45, 0.15, 0.25, 0.05, 0.05];
  const g = A.gapVsCurrent(target, CUR_A, 200000);
  assert.equal(g.ok, true);
  const row = Object.fromEntries(g.rows.map((r) => [r.cls, r]));
  assert.equal(g.rows.length, 7);
  near(row.bond_l.diffPp, 45, 1e-9); near(row.bond_l.amount, 90000, 1e-6);
  near(row.tw_eq.diffPp, -25, 1e-9); near(row.tw_eq.amount, -50000, 1e-6);
  near(row.us_tech.diffPp, -35, 1e-9); near(row.us_tech.amount, -70000, 1e-6);
  near(row.us_eq.diff, 0.15, 1e-12);
  assert.equal(row.cash.diffPp, 0);
  assert.ok(Object.is(row.cash.diffPp, 0), '不出現 -0');
  assert.equal(row.bond_s.cur, 0.1);
  assert.equal(row.bond_s.target, 0.05);
  near(g.rows.reduce((s, r) => s + r.amount, 0), 0, 1e-6, '差額合計 0');
  assert.equal(A.gapVsCurrent([1], CUR_A, 1).error, 'invalid_shape');
  assert.equal(A.gapVsCurrent(target, CUR_A, -1).error, 'invalid_number');
  assert.equal(A.gapVsCurrent(target, [NaN, 0, 0, 0, 0, 0, 0], 1).error, 'invalid_number');
});

test('pickCandidates：≥2.5 個百分點的類別列出已勾選標的；沒有勾選 → empty', () => {
  const target = [0, 0.05, 0.45, 0.15, 0.25, 0.05, 0.05];
  const rows = A.gapVsCurrent(target, CUR_A, 200000).rows;
  const checked = [
    { id: 'TW:9101', name: '虛構債券ETF甲', cls: 'bond_l', er_pct: 0.1, ccy: 'TWD', min_fee_note: '手續費照一般', settle: 'T+2', mkt: 'TW', code: '9101' },
    { id: 'US:ZZZ', name: '虛構債券ETF乙', cls: 'bond_l', er_pct: 0.05, ccy: 'USD', min_fee_note: '最低 US$35', settle: 'T+1', mkt: 'US', code: 'ZZZ' },
    { id: 'US:YYY', name: '虛構全球ETF', cls: 'gl_eq', er_pct: 0.2, ccy: 'USD', mkt: 'US', code: 'YYY' },
    { id: 'TW:9102', name: '虛構台股ETF（現況已超過）', cls: 'tw_eq' },
  ];
  const p = A.pickCandidates(rows, checked);
  assert.equal(p.ok, true);
  assert.deepEqual(p.list.map((x) => x.cls), ['bond_l', 'us_eq', 'gl_eq']);        // 依 CLS 順序；tw_eq／us_tech 為負、bond_s／cash 不達門檻
  const [bl, us, gl] = p.list;
  assert.equal(bl.items.length, 2);
  assert.equal(bl.empty, false);
  assert.deepEqual(bl.items[0], { id: 'TW:9101', name: '虛構債券ETF甲', er_pct: 0.1, ccy: 'TWD', min_fee_note: '手續費照一般', settle: 'T+2', mkt: 'TW', code: '9101' });
  near(bl.diffPp, 45, 1e-9); near(bl.amount, 90000, 1e-6);
  assert.equal(us.empty, true);
  assert.deepEqual(us.items, []);
  assert.equal(gl.items.length, 1);
  assert.equal(gl.items[0].min_fee_note, null);              // 缺漏欄位為 null
  // 門檻邊界：剛好 2.5 個百分點（含浮點誤差）要算；2.49 不算
  const edge = A.gapVsCurrent([0, 0, 0, 0.3, 0.15, 0.03, 0], [0, 0, 0, 0.275, 0.125, 0.00505, 0], 1000).rows;
  assert.deepEqual(A.pickCandidates(edge, []).list.map((x) => x.cls), ['tw_eq', 'us_eq']);
  assert.equal(A.pickCandidates(edge, [], 2.4).list.length, 3);
  // 沒有候選任何類別
  assert.deepEqual(A.pickCandidates(A.gapVsCurrent(CUR_A, CUR_A, 1).rows, []).list, []);
  assert.equal(A.pickCandidates('x', []).ok, false);
  assert.equal(A.pickCandidates(rows, 'x').ok, false);
});

/* ── 輸入防呆 ─────────────────────────────────────────────────────────────────────────────── */
test('輸入防呆：NaN、負值、型別錯誤、範圍外', () => {
  const ok = [0, 0, 0, 0.5, 0.5, 0, 0];
  assert.equal(A.portfolioStats(ok, CMA).ok, true);
  assert.equal(A.portfolioStats([0, 0, 0, NaN, 1, 0, 0], CMA).error, 'invalid_number');
  assert.equal(A.portfolioStats([0, 0, 0, 1.5, -0.5, 0, 0], CMA).error, 'out_of_range');
  assert.equal(A.portfolioStats([0, 0, 0, 0.5, 0.4, 0, 0], CMA).error, 'out_of_range');       // 合計 ≠ 1
  assert.equal(A.portfolioStats([0.5, 0.5], CMA).error, 'invalid_shape');
  assert.equal(A.portfolioStats('abc', CMA).error, 'invalid_shape');
  assert.equal(A.portfolioStats(ok, CMA, [{ w: -0.1, mkt: 'TW' }]).error, 'invalid_number');
  assert.equal(A.portfolioStats(ok, CMA, [{ w: 0.1, mkt: 'JP' }]).error, 'invalid_shape');
  assert.equal(A.portfolioStats(ok, CMA, 'x').error, 'invalid_shape');

  assert.equal(A.solve(CMA, { T: NaN, Lmax: 0.2 }).error, 'invalid_number');
  assert.equal(A.solve(CMA, { T: -0.01, Lmax: 0.2 }).error, 'out_of_range');
  assert.equal(A.solve(CMA, { T: 1.5, Lmax: 0.2 }).error, 'out_of_range');
  assert.equal(A.solve(CMA, { T: 0.07, Lmax: NaN }).error, 'invalid_number');
  assert.equal(A.solve(CMA, { T: 0.07, Lmax: -0.2 }).error, 'out_of_range');
  assert.equal(A.solve(CMA, { T: '0.07', Lmax: 0.2 }).error, 'invalid_number');       // 字串不收（UI 要先轉數字）
  assert.equal(A.solve(CMA, { T: 0.07, Lmax: 0.2, current: [1, 2] }).error, 'invalid_shape');
  assert.equal(A.solve(CMA, { T: 0.07, Lmax: 0.2, current: [0, 0, 0, NaN, 0, 0, 0] }).error, 'invalid_number');
  assert.equal(A.solve(CMA, { T: 0.07, Lmax: 0.2, allowed: [true] }).error, 'invalid_shape');
  assert.equal(A.solve(null, { T: 0.07, Lmax: 0.2 }).ok, false);
  assert.equal(A.solve(CMA).ok, false);
  assert.equal(A.buildGrid(undefined).ok, false);
  const badCma = mkCma(); badCma.classes[0].mu = NaN;
  assert.equal(A.solve(badCma, { T: 0.07, Lmax: 0.2 }).ok, false);
});

/* ── 賣出試算（虛構持股）──────────────────────────────────────────────────────────────────────── */
const mkItem = (key, mkt, name, value, cost) => ({ key, code: key.split(':')[1], name, mkt, value_twd: value, cost_twd: cost, pnl_twd: value - cost });
const ITEMS = [
  mkItem('US:AAA', 'US', '虛構美股甲', 200000, 150000),
  mkItem('TW:1111', 'TW', '虛構台股甲', 100000, 80000),
  mkItem('US:CCC', 'US', '虛構美股丙', 60000, 55000),
  mkItem('TW:9001', 'TW', '虛構台股ETF', 50000, 40000),
  mkItem('TW:9002', 'TW', '虛構長債ETF', 30000, 31000),
  mkItem('TW:9003', 'TW', '虛構短債ETF', 20000, 19000),
  mkItem('TW:2222', 'TW', '虛構台股乙', 10000, 12000),
  mkItem('US:BBB', 'US', '虛構美股乙', 1301, 1500),
];
const meta = (key, cls, single) => ({ key, name: key, cls, single, tag: '', value_twd: ITEMS.find((i) => i.key === key).value_twd, w: 0 });
const ALLOC = {
  items: [
    meta('US:AAA', 'us_tech', true), meta('TW:1111', 'tw_eq', true), meta('US:CCC', 'us_eq', true), meta('TW:9001', 'tw_eq', false),
    meta('TW:9002', 'bond_l', false), meta('TW:9003', 'bond_s', false), meta('TW:2222', 'tw_eq', true), meta('US:BBB', 'us_eq', true),
  ],
};
// 虛構費率（各稅率刻意取不同值，才能分辨類別判定）
const FEES = { tw_fee_rate: 0.001425, tw_fee_min: 20, tw_tax_stock: 0.003, tw_tax_etf: 0.001, tw_tax_bond_etf: 0.0005, us_dca_rate: 0.002, us_min_usd: 35, us_std_rate: 0.005, settle: { TW: 'T+2', US: 'T+1' } };
// 舊版 benchmarks.json（沒有 us_std_rate 欄位）：區間只剩 us_min 一點（C-2：定期定額比率不入區間）
const { us_std_rate: _omit, ...FEES_OLD } = FEES;
const base = { need: 200000, deadline: '2026-12-04', selected: [], items: ITEMS, alloc: ALLOC, fees: FEES, fx: 30, cash: 100000, monthly: 50000 };
const trial = (o) => A.sellTrial({ ...base, ...o });

test('賣出試算：台股（個股／ETF／債券 ETF 三種稅率、單檔最低手續費）— 足夠', () => {
  const r = trial({ selected: ['TW:1111', 'TW:2222', 'TW:9001', 'TW:9002', 'TW:9003'] });
  assert.equal(r.ok, true);
  assert.equal(r.empty, false);
  assert.equal(r.count, 5);
  assert.equal(r.gross, 210000);
  const row = Object.fromEntries(r.rows.map((x) => [x.key, x]));
  assert.equal(row['TW:1111'].taxKind, 'stock');
  assert.equal(row['TW:2222'].taxKind, 'stock');
  assert.equal(row['TW:9001'].taxKind, 'etf');
  assert.equal(row['TW:9002'].taxKind, 'bond_etf');   // cls=bond_l
  assert.equal(row['TW:9003'].taxKind, 'bond_etf');   // cls=bond_s
  near(row['TW:1111'].twCommission, 142.5, 1e-9);
  near(row['TW:2222'].twCommission, 20, 1e-9, '10,000×0.1425%=14.25 不足最低 20');
  near(row['TW:9001'].twCommission, 71.25, 1e-9);
  near(row['TW:1111'].twTax, 300, 1e-9);
  near(row['TW:2222'].twTax, 30, 1e-9);
  near(row['TW:9001'].twTax, 50, 1e-9);
  near(row['TW:9002'].twTax, 15, 1e-9);
  near(row['TW:9003'].twTax, 10, 1e-9);
  near(r.fees.tw.commission, 305, 1e-9);
  near(r.fees.tw.tax, 405, 1e-9);
  near(r.fees.tw.total, 710, 1e-9);
  assert.equal(r.fees.us, null);
  assert.deepEqual(r.fees.unknown, []);
  near(r.fees.total.low, 710, 1e-9); near(r.fees.total.high, 710, 1e-9);
  near(r.net.low, 209290, 1e-9); near(r.net.high, 209290, 1e-9);
  assert.equal(r.cover.status, 'enough');
  near(r.cover.diffLow, 9290, 1e-9);
  assert.equal(r.cover.shortfall, 0);
  assert.equal(r.cover.straddle, false);
  near(r.realized.cost, 182000, 1e-9);
  near(r.realized.low, 27290, 1e-9); near(r.realized.high, 27290, 1e-9);
  // 賣出後
  assert.equal(r.remaining.count, 3);
  near(r.remaining.value, 261301, 1e-9); near(r.remaining.cost, 206500, 1e-9); near(r.remaining.unrealized, 54801, 1e-9);
  const by = Object.fromEntries(r.after.byCls.map((x) => [x.cls, x]));
  assert.equal(r.after.byCls.length, 7);
  near(by.us_tech.value, 200000, 1e-9); near(by.us_eq.value, 61301, 1e-9); assert.equal(by.tw_eq.value, 0);
  near(by.us_tech.w, 200000 / 261301, 1e-12);
  near(r.after.byCls.reduce((s, x) => s + x.w, 0), 1, 1e-12);
  near(r.after.base, 261301, 1e-9);
  near(r.after.cash, 109290, 1e-9);                      // 100,000 + 209,290 − 200,000
  near(r.after.months, 2.1858, 1e-9);
  near(r.after.monthsBefore, 2, 1e-12);
  assert.deepEqual(r.unmapped, []);
  assert.ok(r.notes.includes('不做稅務判斷；已實現損益與海外所得申報請對照報稅資料'));
  assert.ok(r.notes.includes('試算用最近收盤價，實際成交價會不同'));
  // 最晚賣出日：2026-12-04（五）往前 1+2＝3 個營業日 → 12-01（二）
  assert.equal(r.latest.TW, '2026-12-01');
  assert.equal(r.latest.US, null);
  assert.equal(r.latest.binding, '2026-12-01');
  assert.deepEqual(r.latest.settleDays, { TW: 2, US: 1 });
});

test('賣出試算：台股 — 不足與差額', () => {
  const r = trial({ selected: ['TW:1111', 'TW:2222', 'TW:9001', 'TW:9002', 'TW:9003'], need: 210000 });
  assert.equal(r.cover.status, 'short');
  near(r.cover.shortfall, 710, 1e-9);
  near(r.cover.diffLow, -710, 1e-9);
  assert.equal(r.cover.straddle, false);
  near(r.after.cash, 100000 + 209290 - 210000, 1e-9);
  // 恰好足夠（net.low === need）
  assert.equal(trial({ selected: ['TW:9001'], need: 50000 - 71.25 - 50 }).cover.status, 'enough');
});

test('賣出試算：美股 std／min 兩情境、定期定額比率只當參考、5% 最低費用警示、區間落在需要金額兩側', () => {
  const r = trial({ selected: ['US:AAA', 'US:BBB'] });
  assert.equal(r.ok, true);
  assert.equal(r.gross, 201301);
  assert.equal(r.fees.tw, null);
  near(r.fees.us.dca, 402.602, 1e-9);                    // 201,301 × 0.2%：仍回傳（欄位不變），但只供參考，不入區間
  near(r.fees.us.min, 2100, 1e-9);                       // 35 × 30 × 2 檔：最保守
  near(r.fees.us.std, 1006.505, 1e-9);                   // 201,301 × 0.5%：最樂觀
  assert.equal(r.fees.us.warnings.length, 1);
  const w = r.fees.us.warnings[0];
  assert.equal(w.key, 'US:BBB');
  near(w.minFeeTwd, 1050, 1e-9); near(w.minFeeUsd, 35, 1e-12); near(w.pct, 1050 / 1301, 1e-12);
  assert.ok(w.pct > 0.8);
  near(r.fees.total.low, 1006.505, 1e-9); near(r.fees.total.high, 2100, 1e-9);   // 不是 dca 的 402.602
  near(r.net.low, 199201, 1e-9); near(r.net.high, 200294.495, 1e-9);            // 201,301 − 1,006.505
  assert.equal(r.cover.status, 'short');                 // 以保守的 net.low 判定
  near(r.cover.shortfall, 799, 1e-9);
  assert.equal(r.cover.straddle, true);                  // 200,000 落在 [199,201 , 200,294.495]
  near(r.cover.diffHigh, 294.495, 1e-9);
  near(r.realized.cost, 151500, 1e-9);                   // 150,000 + 1,500
  near(r.realized.low, 199201 - 151500, 1e-9); near(r.realized.high, 200294.495 - 151500, 1e-9);
  near(r.after.cash, 100000 + 199201 - 200000, 1e-9);    // 賣出後現金用淨入帳（低）
  near(r.after.months, 99201 / 50000, 1e-12);
  assert.equal(r.latest.US, '2026-12-02');               // 1+1＝2 個營業日
  assert.equal(r.latest.TW, null);
  assert.equal(r.latest.binding, '2026-12-02');
  assert.deepEqual(r.latest.settleDays, { TW: 2, US: 1 });
  // 沒有任何一檔低於 5%
  assert.equal(trial({ selected: ['US:AAA', 'US:CCC'] }).fees.us.warnings.length, 0);
  // 舊版費率檔（沒有 us_std_rate）：std 不可算 → 區間只剩 min 一點（定期定額比率不補位）；警示不變
  const old = trial({ selected: ['US:AAA', 'US:BBB'], fees: FEES_OLD });
  near(old.net.low, 199201, 1e-9); near(old.net.high, 199201, 1e-9);
  near(old.fees.us.dca, 402.602, 1e-9);
  assert.equal(old.fees.us.warnings.length, 1);
  assert.equal(old.cover.status, 'short');
  assert.equal(old.cover.straddle, false);
  // 恰好 5%：最低費用 1,050 vs 市值 21,000
  const edge = A.sellTrial({ ...base, items: [mkItem('US:EDG', 'US', '虛構', 21000, 20000)], alloc: { items: [] }, selected: ['US:EDG'] });
  assert.equal(edge.fees.us.warnings.length, 1);
  assert.deepEqual(edge.unmapped, ['US:EDG']);
});

test('賣出試算：台美混合、最晚賣出日取較早者', () => {
  const r = trial({ selected: ['TW:9001', 'US:CCC'], deadline: '2026-12-07' });   // 週一
  assert.equal(r.latest.TW, '2026-12-02');
  assert.equal(r.latest.US, '2026-12-03');
  assert.equal(r.latest.binding, '2026-12-02');
  near(r.fees.tw.total, 71.25 + 50, 1e-9);
  near(r.fees.us.dca, 120, 1e-9);                        // 60,000 × 0.2%（參考，不入區間）
  near(r.fees.us.min, 1050, 1e-9);
  near(r.fees.us.std, 300, 1e-9);                        // 60,000 × 0.5%
  near(r.net.low, 110000 - 121.25 - 1050, 1e-9);
  near(r.net.high, 110000 - 121.25 - 300, 1e-9);         // 最樂觀＝std（不是 dca 的 120）
});

test('賣出試算：交割日數取自 fees.settle（T+n），讀不到用預設 TW 2／US 1', () => {
  const sel = ['TW:9001', 'US:CCC'], deadline = '2026-12-07';          // 週一
  const withSettle = (settle) => trial({ selected: sel, deadline, fees: { ...FEES, settle } });
  let r = withSettle({ TW: 'T+3', US: 'T+0' });
  assert.deepEqual(r.latest.settleDays, { TW: 3, US: 0 });
  assert.equal(r.latest.TW, '2026-12-01');                            // 1+3＝4 個營業日：五、四、三、二
  assert.equal(r.latest.US, '2026-12-04');                            // 1+0＝1 個營業日
  for (const s of [undefined, null, {}, { TW: null, US: 'x' }, { TW: 'T+', US: 'T+1d' }]) {
    r = withSettle(s);
    assert.deepEqual(r.latest.settleDays, { TW: 2, US: 1 });
    assert.equal(r.latest.TW, '2026-12-02');
    assert.equal(r.latest.US, '2026-12-03');
  }
  assert.deepEqual(trial({ selected: sel, deadline, fees: null }).latest.settleDays, { TW: 2, US: 1 });
});

test('賣出試算：費率為 null → 標「以券商為準」、不計入', () => {
  const f = { ...FEES, tw_fee_min: null, tw_tax_bond_etf: null, us_dca_rate: null };
  const r = trial({ selected: ['TW:9002', 'US:CCC'], fees: f });
  assert.equal(r.ok, true);
  const keys = r.fees.unknown.map((u) => u.key).sort();
  assert.deepEqual(keys, ['tw_fee_min', 'tw_tax_bond_etf', 'us_dca_rate']);
  assert.ok(r.fees.unknown.every((u) => u.reason === 'null'));
  const row = Object.fromEntries(r.rows.map((x) => [x.key, x]));
  near(row['TW:9002'].twCommission, 42.75, 1e-9);        // 沒有最低手續費 → 只用費率
  assert.equal(row['TW:9002'].twTax, null);               // 債券 ETF 稅率 null → 不計
  assert.equal(row['US:CCC'].usDca, null);
  near(row['US:CCC'].usMin, 1050, 1e-9);
  near(row['US:CCC'].usStd, 300, 1e-9);
  assert.equal(r.fees.us.dca, null);
  near(r.fees.us.min, 1050, 1e-9);
  near(r.fees.us.std, 300, 1e-9);
  near(r.fees.total.low, 42.75 + 300, 1e-9); near(r.fees.total.high, 42.75 + 1050, 1e-9);   // 剩 min、std 兩個美股情境
  near(r.net.low, 90000 - 1092.75, 1e-9); near(r.net.high, 90000 - 342.75, 1e-9);
  assert.ok(r.notes.some((n) => n.includes('以券商為準')));
  // 手續費率 null → 手續費整項不計（最低手續費也不單獨計）
  const r2 = trial({ selected: ['TW:1111'], fees: { ...FEES, tw_fee_rate: null } });
  assert.equal(r2.rows[0].twCommission, null);
  assert.deepEqual(r2.fees.unknown.map((u) => u.key), ['tw_fee_rate']);
  near(r2.fees.tw.total, 300, 1e-9);                      // 只剩個股證交稅
  // 只列「被用到」的稅率：只勾 ETF 時，個股／債券 ETF 稅率為 null 也不列入
  const r3 = trial({ selected: ['TW:9001'], fees: { ...FEES, tw_tax_stock: null, tw_tax_bond_etf: null } });
  assert.deepEqual(r3.fees.unknown, []);
  // 三個美股情境都不可算 → 美股費用視為 0（但有 unknown）
  const r4 = trial({ selected: ['US:CCC'], fees: { ...FEES, us_dca_rate: null, us_min_usd: null, us_std_rate: null } });
  assert.deepEqual(r4.fees.unknown.map((u) => u.key).sort(), ['us_dca_rate', 'us_min_usd', 'us_std_rate']);
  near(r4.net.low, 60000, 1e-9); near(r4.net.high, 60000, 1e-9);
  assert.equal(r4.fees.us.warnings.length, 0);
  assert.deepEqual([r4.fees.us.dca, r4.fees.us.min, r4.fees.us.std], [null, null, null]);
  // fees 整份為 null
  const r5 = trial({ selected: ['TW:1111', 'US:CCC'], fees: null });
  assert.equal(r5.ok, true);
  near(r5.net.low, 160000, 1e-9);
  assert.ok(r5.fees.unknown.length >= 4);
  assert.ok(r5.fees.unknown.some((u) => u.key === 'us_std_rate'));
  // 不合理的費率（單位寫成百分比）→ invalid，不計入
  const r6 = trial({ selected: ['TW:1111'], fees: { ...FEES, tw_tax_stock: 0.3 } });
  assert.deepEqual(r6.fees.unknown, [{ key: 'tw_tax_stock', reason: 'invalid' }]);
  assert.equal(r6.rows[0].twTax, null);
});

test('賣出試算（C-2）：美股區間只用 std（最樂觀）與 min（最保守）；dca 保留為參考列、不入區間', () => {
  const one = (value, cost, fees) => A.sellTrial({ ...base, items: [mkItem('US:DDD', 'US', '虛構美股丁', value, cost)], alloc: { items: [] }, selected: ['US:DDD'], fees });
  // (a) 市值 400,000：dca 800、min 1,050、std 2,000 → 區間 [min 1,050 , std 2,000] 之中取低高（std 反而最貴）
  let r = one(400000, 300000, FEES);
  near(r.fees.us.dca, 800, 1e-9); near(r.fees.us.min, 1050, 1e-9); near(r.fees.us.std, 2000, 1e-9);
  assert.equal(r.rows[0].usStd, 2000);
  assert.equal(r.rows[0].usDca, 800);                    // 列層級欄位名不變
  near(r.fees.total.low, 1050, 1e-9); near(r.fees.total.high, 2000, 1e-9);        // 不是 dca 的 800
  near(r.net.low, 398000, 1e-9); near(r.net.high, 398950, 1e-9);
  near(r.realized.low, 98000, 1e-9); near(r.realized.high, 98950, 1e-9);
  assert.equal(r.fees.us.warnings.length, 0);
  // 需要金額落在 [398,000 , 398,950] → short 且 straddle；落在舊區間上緣（399,200，原由 dca 撐出）之上則不再 straddle
  r = A.sellTrial({ ...base, items: [mkItem('US:DDD', 'US', '虛構美股丁', 400000, 300000)], alloc: { items: [] }, selected: ['US:DDD'], need: 398500 });
  assert.equal(r.cover.status, 'short'); near(r.cover.shortfall, 500, 1e-9); assert.equal(r.cover.straddle, true);
  r = A.sellTrial({ ...base, items: [mkItem('US:DDD', 'US', '虛構美股丁', 400000, 300000)], alloc: { items: [] }, selected: ['US:DDD'], need: 399100 });
  assert.equal(r.cover.status, 'short'); assert.equal(r.cover.straddle, false);
  // (b) std 最低：std 費率 0.05% → 60,000 × 0.05% = 30 < dca 120 < min 1,050 → 區間 [30 , 1,050]（dca 落在中間，不改變區間）
  r = trial({ selected: ['US:CCC'], fees: { ...FEES, us_std_rate: 0.0005 } });
  near(r.fees.us.std, 30, 1e-9);
  near(r.fees.total.low, 30, 1e-9); near(r.fees.total.high, 1050, 1e-9);
  near(r.net.low, 60000 - 1050, 1e-9); near(r.net.high, 60000 - 30, 1e-9);
  // (c) 預設費率：std 300、min 1,050、dca 120 → 區間 [300 , 1,050]；舊行為會把低端拉到 dca 的 120
  r = trial({ selected: ['US:CCC'] });
  near(r.fees.us.dca, 120, 1e-9);
  near(r.fees.total.low, 300, 1e-9); near(r.fees.total.high, 1050, 1e-9);
  near(r.net.low, 60000 - 1050, 1e-9); near(r.net.high, 60000 - 300, 1e-9);
  // (c2) dca 費率改成極低或極高，都不影響區間與足夠／不足
  for (const dca of [0, 0.00001, 0.05, 0.1]) {
    const x = trial({ selected: ['US:CCC'], fees: { ...FEES, us_dca_rate: dca } });
    near(x.fees.us.dca, 60000 * dca, 1e-9);
    near(x.fees.total.low, 300, 1e-9); near(x.fees.total.high, 1050, 1e-9);
    near(x.net.low, 58950, 1e-9); near(x.net.high, 59700, 1e-9);
    assert.equal(x.cover.status, trial({ selected: ['US:CCC'] }).cover.status);
  }
  // (c3) 足夠／不足以 min（最保守）判定：need 落在 [58,950 , 59,700] → 不足但 straddle；dca 若入區間，low 端會是 59,880
  r = trial({ selected: ['US:CCC'], need: 59500 });
  assert.equal(r.cover.status, 'short'); assert.equal(r.cover.straddle, true); near(r.cover.shortfall, 550, 1e-9);
  r = trial({ selected: ['US:CCC'], need: 58950 });
  assert.equal(r.cover.status, 'enough');
  // (d) 只有 std 可算（dca、min 都是 null）→ low＝high＝std
  r = trial({ selected: ['US:CCC'], fees: { ...FEES, us_dca_rate: null, us_min_usd: null } });
  assert.deepEqual(r.fees.unknown.map((u) => u.key).sort(), ['us_dca_rate', 'us_min_usd']);
  near(r.fees.total.low, 300, 1e-9); near(r.fees.total.high, 300, 1e-9);
  near(r.net.low, 59700, 1e-9); near(r.net.high, 59700, 1e-9);
  // (d2) 只有 min 可算 → low＝high＝min；只有 dca 可算（std、min 都不可算）→ 美股費用視為 0，dca 不補位
  r = trial({ selected: ['US:CCC'], fees: { ...FEES, us_std_rate: null } });
  near(r.fees.total.low, 1050, 1e-9); near(r.fees.total.high, 1050, 1e-9);
  r = trial({ selected: ['US:CCC'], fees: { ...FEES, us_std_rate: null, us_min_usd: null } });
  near(r.fees.us.dca, 120, 1e-9); assert.equal(r.fees.us.std, null); assert.equal(r.fees.us.min, null);
  near(r.fees.total.low, 0, 1e-9); near(r.fees.total.high, 0, 1e-9);
  near(r.net.low, 60000, 1e-9); near(r.net.high, 60000, 1e-9);
  assert.ok(r.notes.some((n) => n.includes('以券商為準')));
  // (e) 台美混合：台股費用照加，美股取 std／min 的最低／最高
  r = trial({ selected: ['TW:9001', 'US:CCC'], fees: { ...FEES, us_std_rate: 0.0005 } });
  near(r.fees.total.low, 121.25 + 30, 1e-9); near(r.fees.total.high, 121.25 + 1050, 1e-9);
  // (f) 5% 警示仍只看「一般單最低」情境：std 費率 6%（≥5%）也不會觸發；min 1,050 / 100,000 = 1.05% 不到 5%
  r = one(100000, 90000, { ...FEES, us_std_rate: 0.06 });
  near(r.fees.us.std, 6000, 1e-9);
  assert.equal(r.fees.us.warnings.length, 0);
  assert.equal(one(21000, 20000, { ...FEES, us_std_rate: 0.0005 }).fees.us.warnings.length, 1);   // min 1,050 ≥ 市值 5%
  // (g) 畫面文字不得出現買賣字詞（notes 是 UI 直接渲染的）
  for (const x of [r, trial({ selected: ['US:CCC'] }), trial({ selected: ['TW:9001', 'US:CCC'] }), trial({ selected: ['TW:9001'] })]) {
    for (const n of x.notes) assert.ok(!BANNED.test(n), `notes 含禁用字詞：${n}`);
  }
  for (const n of A.FUNDS_NOTES) assert.ok(!BANNED.test(n));
});

test('賣出試算：us_std_rate 欄位缺漏／null／無效 → 以券商為準、列入 unknown，不出錯；區間只剩 min', () => {
  const sel = ['US:AAA', 'US:BBB'];
  const expectOld = (r, reason) => {
    assert.equal(r.ok, true);
    assert.deepEqual(r.fees.unknown, [{ key: 'us_std_rate', reason }]);
    assert.equal(r.fees.us.std, null);
    assert.ok(r.rows.every((x) => x.usStd === null));
    near(r.fees.us.dca, 402.602, 1e-9); near(r.fees.us.min, 2100, 1e-9);        // dca 只當參考列、min 照算
    near(r.net.low, 199201, 1e-9); near(r.net.high, 199201, 1e-9);              // std 不可算 → 區間只剩 min 一點（dca 不補位）
    assert.equal(r.fees.us.warnings.length, 1);
    assert.ok(r.notes.some((n) => n.includes('以券商為準')));
  };
  expectOld(trial({ selected: sel, fees: FEES_OLD }), 'null');                           // 欄位缺
  expectOld(trial({ selected: sel, fees: { ...FEES, us_std_rate: null } }), 'null');      // 明確 null
  expectOld(trial({ selected: sel, fees: { ...FEES, us_std_rate: undefined } }), 'null');
  for (const bad of [-0.001, 0.5, NaN, Infinity, '0.005']) expectOld(trial({ selected: sel, fees: { ...FEES, us_std_rate: bad } }), 'invalid');
  // 只勾台股時不需要 us_std_rate：缺漏也不列入 unknown
  assert.deepEqual(trial({ selected: ['TW:9001'], fees: FEES_OLD }).fees.unknown, []);
  // fees 整份 null：unknown 含 us_std_rate，仍不出錯
  const nul = trial({ selected: sel, fees: null });
  assert.equal(nul.ok, true);
  assert.ok(nul.fees.unknown.some((u) => u.key === 'us_std_rate'));
  near(nul.net.low, 201301, 1e-9);
  // 欄位存在且有效時不列入 unknown
  assert.deepEqual(trial({ selected: sel }).fees.unknown, []);
});

test('賣出試算：未勾選、全部賣出、剩餘持股損益', () => {
  const none = trial({ selected: [] });
  assert.equal(none.ok, true);
  assert.equal(none.empty, true);
  assert.equal(none.gross, 0);
  assert.equal(none.latest.binding, null);
  assert.equal(none.cover.status, 'short');
  assert.equal(none.remaining.count, 8);
  near(none.remaining.unrealized, 20000 - 2000 + 10000 - 1000 + 1000 + 50000 - 199 + 5000, 1e-9);
  assert.equal(trial({ selected: [], need: 0 }).cover.status, 'enough');
  const all = trial({ selected: ITEMS.map((i) => i.key) });
  assert.equal(all.remaining.count, 0);
  assert.equal(all.after.base, 0);
  assert.ok(all.after.byCls.every((x) => x.w === 0 && x.value === 0));
  // Set 也能當 selected
  assert.equal(trial({ selected: new Set(['TW:9001']) }).count, 1);
  // 月額 0 → 月數為 null
  assert.equal(trial({ selected: ['TW:9001'], monthly: 0 }).after.months, null);
});

test('賣出試算：alloc 缺該檔 → 依 §2.2 預設（個股）並列入 unmapped', () => {
  const r = trial({ selected: ['TW:9001'], alloc: { items: ALLOC.items.filter((a) => a.key !== 'TW:9001') } });
  assert.deepEqual(r.unmapped, ['TW:9001']);
  assert.equal(r.rows[0].cls, 'tw_eq');
  assert.equal(r.rows[0].single, true);
  assert.equal(r.rows[0].taxKind, 'stock');
  near(r.rows[0].twTax, 150, 1e-9);                       // 50,000 × 0.3%
});

test('賣出試算：輸入防呆', () => {
  const ok = trial({ selected: ['TW:9001'] });
  assert.equal(ok.ok, true);
  assert.equal(trial({ need: NaN }).error, 'invalid_number');
  assert.equal(trial({ need: -1 }).error, 'out_of_range');
  assert.equal(trial({ need: 100000000 }).error, 'out_of_range');
  assert.equal(trial({ need: 99999999 }).ok, true);
  assert.equal(trial({ need: '100' }).error, 'invalid_number');
  assert.equal(trial({ need: Infinity }).error, 'invalid_number');
  assert.equal(trial({ deadline: '2026-02-30' }).error, 'invalid_date');
  assert.equal(trial({ deadline: '2026/12/04' }).error, 'invalid_date');
  assert.equal(trial({ deadline: undefined }).error, 'invalid_date');
  assert.equal(trial({ selected: ['TW:0000'] }).error, 'unknown_key');
  assert.equal(trial({ selected: 'TW:9001' }).error, 'invalid_shape');
  assert.equal(trial({ items: null }).error, 'invalid_shape');
  assert.equal(trial({ selected: ['US:CCC'], fx: undefined }).error, 'missing_fx');
  assert.equal(trial({ selected: ['US:CCC'], fx: 0 }).error, 'missing_fx');
  assert.equal(trial({ selected: ['US:CCC'], fx: NaN }).error, 'missing_fx');
  assert.equal(trial({ selected: ['TW:9001'], fx: undefined }).ok, true);      // 沒勾美股不需要匯率
  assert.equal(trial({ cash: NaN }).error, 'invalid_number');
  assert.equal(trial({ cash: -5 }).error, 'out_of_range');
  assert.equal(trial({ monthly: NaN }).error, 'invalid_number');
  assert.equal(trial({ monthly: -1 }).error, 'out_of_range');
  assert.equal(trial({ items: [{ key: 'TW:1', mkt: 'TW', value_twd: -5, cost_twd: 1 }] }).error, 'invalid_number');
  assert.equal(trial({ items: [{ key: 'TW:1', mkt: 'JP', value_twd: 5, cost_twd: 1 }] }).error, 'invalid_shape');
  assert.equal(A.sellTrial(undefined).ok, false);
  assert.equal(trial({ fees: 'x' }).error, 'invalid_shape');
});

/* ── 最晚賣出日（只避開週末；UTC）──────────────────────────────────────────────────────────────── */
test('backBusinessDays：週末、跨年、閏日、無效輸入', () => {
  const b = A.backBusinessDays;
  assert.equal(b('2026-12-04', 3), '2026-12-01');   // 五 → 二
  assert.equal(b('2026-12-07', 3), '2026-12-02');   // 一 → 三（跳過週六日）
  assert.equal(b('2026-12-07', 2), '2026-12-03');
  assert.equal(b('2026-12-06', 3), '2026-12-02');   // 日：上一個營業日（週五）算第 1 天 → 五、四、三（所以週末起算比週五起算少 1 天緩衝，見 D-4 測試）
  assert.equal(b('2026-12-05', 2), '2026-12-03');   // 六
  assert.equal(b('2026-12-04', 0), '2026-12-04');
  assert.equal(b('2027-01-04', 3), '2026-12-30');   // 跨年（2027-01-01 為週五，不處理國定假日）
  assert.equal(b('2028-03-01', 2), '2028-02-28');   // 閏年 2/29 為週二
  assert.equal(b('2026-03-01', 1), '2026-02-27');   // 日 → 退到週五
  assert.equal(b('2026-02-30', 1), null);
  assert.equal(b('2026-12-04', -1), null);
  assert.equal(b('2026-12-04', 1.5), null);
  assert.equal(b(20261204, 1), null);
  assert.equal(b(null, 1), null);
});

/* ── D-4：最晚處分日的週末緩衝（V2 實測：週五期限 → 週二；週六、週日、週一期限 → 都是週三）────────────────────── */
test('D-4：rollBackToWeekday — 週六／週日滾到上一個週五，平日原樣，無效回 null', () => {
  const r = A.rollBackToWeekday;
  assert.equal(r('2026-11-28'), '2026-11-27');     // 六 → 五
  assert.equal(r('2026-11-29'), '2026-11-27');     // 日 → 五
  for (const d of ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-30']) assert.equal(r(d), d);   // 一～五原樣
  assert.equal(r('2026-03-01'), '2026-02-27');     // 跨月（日）
  assert.equal(r('2028-01-01'), '2027-12-31');     // 跨年（六）
  assert.equal(r('2026-02-30'), null);
  assert.equal(r(20261128), null);
  assert.equal(r(null), null);
});

test('D-4：釐清 V2 看到的數字——backBusinessDays 本身把週末期限的「前一個營業日」當週五＝第 1 天，所以不一致來自未滾動就倒推', () => {
  const b = A.backBusinessDays;
  // 台股 T+2＝轉出 1 ＋ 交割 2 ＝ 3 個營業日；V2 看到：週五 → 週二 11/24；週六、週日、週一 → 都是週三 11/25
  assert.equal(b('2026-11-27', 3), '2026-11-24');   // 五
  assert.equal(b('2026-11-28', 3), '2026-11-25');   // 六（未滾動：比週五期限晚 1 天）
  assert.equal(b('2026-11-29', 3), '2026-11-25');   // 日（同上）
  assert.equal(b('2026-11-30', 3), '2026-11-25');   // 一（平日，本來就該是週三）
  // 修正：先滾到上一個週五再倒推 → 週六日與週五相同
  for (const d of ['2026-11-28', '2026-11-29']) assert.equal(b(A.rollBackToWeekday(d), 3), '2026-11-24');
});

test('D-4：sellTrial 最晚處分日 — 期限為週一至週日七種（再加下週一），台股 T+2 與美股 T+1 各一組', () => {
  //            期限（星期）              台股（n＝3）    美股（n＝2）
  const table = [['2026-11-23', '一', '2026-11-18', '2026-11-19'],
    ['2026-11-24', '二', '2026-11-19', '2026-11-20'],
    ['2026-11-25', '三', '2026-11-20', '2026-11-23'],
    ['2026-11-26', '四', '2026-11-23', '2026-11-24'],
    ['2026-11-27', '五', '2026-11-24', '2026-11-25'],
    ['2026-11-28', '六', '2026-11-24', '2026-11-25'],     // 週末 → 先視為週五 11/27，緩衝與週五期限相同
    ['2026-11-29', '日', '2026-11-24', '2026-11-25'],
    ['2026-11-30', '一', '2026-11-25', '2026-11-26']];
  for (const [deadline, wd, tw, us] of table) {
    assert.equal(new Date(`${deadline}T00:00:00Z`).getUTCDay(), '日一二三四五六'.indexOf(wd), `${deadline} 應為週${wd}`);
    const t = trial({ selected: ['TW:9001'], deadline });
    assert.equal(t.latest.TW, tw, `台股 期限 ${deadline}（週${wd}）`);
    assert.equal(t.latest.US, null);
    assert.equal(t.latest.binding, tw);
    const u = trial({ selected: ['US:CCC'], deadline });
    assert.equal(u.latest.US, us, `美股 期限 ${deadline}（週${wd}）`);
    assert.equal(u.latest.TW, null);
    assert.equal(u.latest.binding, us);
    // 台美混合：binding 取較早者（台股）
    const m = trial({ selected: ['TW:9001', 'US:CCC'], deadline });
    assert.deepEqual([m.latest.TW, m.latest.US, m.latest.binding], [tw, us, tw]);
  }
  // 週五、週六、週日三種期限結果完全相同（D-4 驗收）
  const lat = (d, sel) => trial({ selected: sel, deadline: d }).latest;
  for (const sel of [['TW:9001'], ['US:CCC']]) {
    assert.deepEqual(lat('2026-11-28', sel), lat('2026-11-27', sel));
    assert.deepEqual(lat('2026-11-29', sel), lat('2026-11-27', sel));
  }
});

test('D-4：性質掃描 — 連續 60 天的期限：最晚處分日必為平日、不晚於期限、隨期限不遞減；週末期限等於其前一個週五', () => {
  const day = 86400000, t0 = Date.UTC(2026, 10, 1);
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const wk = (t) => new Date(t).getUTCDay();
  for (const [sel, key] of [[['TW:9001'], 'TW'], [['US:CCC'], 'US']]) {
    let prev = '';
    for (let i = 0; i < 60; i++) {
      const t = t0 + i * day, d = iso(t);
      const L = trial({ selected: sel, deadline: d }).latest[key];
      const w = wk(Date.parse(`${L}T00:00:00Z`));
      assert.ok(w >= 1 && w <= 5, `${key} 期限 ${d} → ${L} 不是平日`);
      assert.ok(L < d, `${key} 最晚處分日 ${L} 應早於期限 ${d}`);
      assert.ok(L >= prev, `${key} 隨期限不遞減：${prev} → ${L}`);
      prev = L;
      if (wk(t) === 6 || wk(t) === 0) {
        const fri = iso(t - (wk(t) === 6 ? 1 : 2) * day);
        assert.equal(L, trial({ selected: sel, deadline: fri }).latest[key], `${key} 週末期限 ${d} 應同前一個週五 ${fri}`);
      }
    }
  }
  // 交割日數取自 fees.settle 時同樣適用（T+3、T+0 各測週六）
  const r = trial({ selected: ['TW:9001', 'US:CCC'], deadline: '2026-11-28', fees: { ...FEES, settle: { TW: 'T+3', US: 'T+0' } } });
  assert.equal(r.latest.TW, '2026-11-23');       // 週五 11/27 起算 1+3＝4 個營業日：四、三、二、一
  assert.equal(r.latest.US, '2026-11-26');       // 1+0＝1 個營業日：週四
  // notes 說明週末規則與「國定假日與美股休市未處理」
  assert.ok(r.notes.some((n) => n.includes('週末') && n.includes('國定假日與美股休市未處理')));
});

test('日期推算與裝置時區無關（子行程，多個 TZ）', () => {
  const code = `import * as A from ${JSON.stringify(MODULE_URL)};
    console.log(JSON.stringify([A.backBusinessDays('2026-12-04',3), A.backBusinessDays('2026-12-07',3), A.backBusinessDays('2027-01-04',3), A.backBusinessDays('2026-03-30',2), A.backBusinessDays('2026-11-02',2),
      A.rollBackToWeekday('2026-11-28'), A.rollBackToWeekday('2026-11-29'), A.rollBackToWeekday('2026-11-30'), A.rollBackToWeekday('2026-03-01')]));`;
  const expected = JSON.stringify([A.backBusinessDays('2026-12-04', 3), A.backBusinessDays('2026-12-07', 3), A.backBusinessDays('2027-01-04', 3), A.backBusinessDays('2026-03-30', 2), A.backBusinessDays('2026-11-02', 2),
    A.rollBackToWeekday('2026-11-28'), A.rollBackToWeekday('2026-11-29'), A.rollBackToWeekday('2026-11-30'), A.rollBackToWeekday('2026-03-01')]);
  assert.equal(expected, JSON.stringify(['2026-12-01', '2026-12-02', '2026-12-30', '2026-03-26', '2026-10-29', '2026-11-27', '2026-11-27', '2026-11-30', '2026-02-27']));
  for (const TZ of ['UTC', 'Asia/Taipei', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TZ }, encoding: 'utf8' }).trim();
    assert.equal(out, expected, `TZ=${TZ}`);
  }
});

/* ── 效能：全開列舉 ───────────────────────────────────────────────────────────────────────── */
test('效能：全開列舉（198,744 組）在 node 下 <300 ms（冷啟動子行程量測，放寬上限 600 ms）', (t) => {
  const code = `import * as A from ${JSON.stringify(MODULE_URL)};
    const CLS = A.CLS;
    const mu=[.015,.03,.04,.08,.08,.075,.10], sg=[.005,.06,.08,.20,.17,.16,.24], cap=[1,1,.6,.6,.7,.7,.3];
    const corr=Array.from({length:7},(_,i)=>Array.from({length:7},(_,j)=>i===j?1:0));
    const set=(i,j,v)=>{corr[i][j]=v;corr[j][i]=v;};
    set(1,2,.5);set(1,3,-.1);set(1,4,.1);set(1,5,.1);set(1,6,.1);set(2,3,.1);set(2,4,.2);set(2,5,.2);set(2,6,.2);set(3,4,.6);set(3,5,.7);set(3,6,.65);set(4,5,.9);set(4,6,.9);set(5,6,.8);
    const cma={mu_kind:'geometric',classes:CLS.map((id,i)=>({id,mu:mu[i],sigma:sg[i],cap:cap[i]})),corr,idio:{tw_single:.25,us_single:.35}};
    const t0=performance.now(); const b=A.buildGrid(cma); const t1=performance.now();
    const r=A.solve(cma,{T:.07,Lmax:.2}); const t2=performance.now();
    const r2=A.solve(cma,{T:.05,Lmax:.1}); const t3=performance.now();
    console.log(JSON.stringify({count:b.count, build:t1-t0, solveCached:t2-t1, solveCached2:t3-t2, ok:r.feasible&&r2.feasible}));`;
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push(JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' })));
  const builds = runs.map((x) => x.build), best = Math.min(...builds), worst = Math.max(...builds);
  t.diagnostic(`冷啟動全開列舉 ms：${builds.map((x) => x.toFixed(1)).join(' / ')}（最佳 ${best.toFixed(1)}、最差 ${worst.toFixed(1)}）；快取後重算 ms：${runs.map((x) => x.solveCached.toFixed(1)).join(' / ')}`);
  for (const x of runs) { assert.equal(x.count, 198744); assert.equal(x.ok, true); }
  assert.ok(best < 300, `最佳 ${best} ms 應 <300`);
  assert.ok(worst < 600, `最差 ${worst} ms 應 <600`);
  for (const x of runs) assert.ok(x.solveCached < 100 && x.solveCached2 < 100, '滑桿重算（快取後）應 <100 ms');
  // 同一行程內（已暖機）也量一次
  const c = mkCma();
  const t0 = performance.now();
  A.buildGrid(c);
  const ms = performance.now() - t0;
  t.diagnostic(`本行程（已暖機）全開列舉 ${ms.toFixed(1)} ms`);
  assert.ok(ms < 300, `本行程 ${ms} ms 應 <300`);
});

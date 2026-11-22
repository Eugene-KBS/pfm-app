// 收支帳 — Scriptable 中型小工具（4×2）。這個檔案不含任何金鑰或個人資料。
// 第一次在 Scriptable 裡執行時，會請你貼上 GitHub 金鑰和小工具金鑰（app「設定 → 主畫面小工具」複製），
// 兩者只存在 iPhone 的鑰匙圈。資料檔 app/widget.enc.json 用 AES-256-GCM 加密，這裡用純 JavaScript 解開。
// 限制：點小工具會打開 Safari 版的 app（iOS 不允許小工具直接打開主畫面上的 PWA）。

const REPO = 'Eugene-KBS/pfm-data';
const APP_URL = 'https://eugene-kbs.github.io/pfm-app/';
const K_TOKEN = 'pfm.widget.token', K_KEY = 'pfm.widget.key', K_CACHE = 'pfm.widget.cache';

// ------------------------------------------------------------ AES-256-GCM (decrypt only), no dependencies
const SBOX = (() => {
  const s = new Uint8Array(256), p = [];
  let x = 1;
  for (let i = 0; i < 256; i++) { p[i] = x; x ^= (x << 1) ^ ((x & 0x80) ? 0x1b : 0); x &= 0xff; }
  const log = new Uint8Array(256);
  for (let i = 0; i < 255; i++) log[p[i]] = i;
  const inv = (a) => (a === 0 ? 0 : p[(255 - log[a]) % 255]);
  for (let i = 0; i < 256; i++) {
    let b = inv(i), r = b;
    for (let k = 0; k < 4; k++) { b = ((b << 1) | (b >> 7)) & 0xff; r ^= b; }
    s[i] = r ^ 0x63;
  }
  return s;
})();
function xt(a) { return ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 0xff; }
function expandKey(key) {                      // 32-byte key -> 15 round keys (240 bytes)
  const w = new Uint8Array(240);
  w.set(key);
  let rcon = 1;
  for (let i = 32; i < 240; i += 4) {
    let t = w.slice(i - 4, i);
    if (i % 32 === 0) {
      t = new Uint8Array([SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]]);
      rcon = xt(rcon);
    } else if (i % 32 === 16) {
      t = new Uint8Array([SBOX[t[0]], SBOX[t[1]], SBOX[t[2]], SBOX[t[3]]]);
    }
    for (let j = 0; j < 4; j++) w[i + j] = w[i - 32 + j] ^ t[j];
  }
  return w;
}
function encBlock(w, inp) {
  const s = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = inp[i] ^ w[i];
  for (let r = 1; r <= 14; r++) {
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
    const t = s.slice();                                    // ShiftRows
    for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) s[c * 4 + rr] = t[((c + rr) % 4) * 4 + rr];
    if (r < 14) {                                           // MixColumns
      for (let c = 0; c < 4; c++) {
        const a0 = s[c * 4], a1 = s[c * 4 + 1], a2 = s[c * 4 + 2], a3 = s[c * 4 + 3], x = a0 ^ a1 ^ a2 ^ a3;
        s[c * 4] ^= x ^ xt(a0 ^ a1); s[c * 4 + 1] ^= x ^ xt(a1 ^ a2); s[c * 4 + 2] ^= x ^ xt(a2 ^ a3); s[c * 4 + 3] ^= x ^ xt(a3 ^ a0);
      }
    }
    for (let i = 0; i < 16; i++) s[i] ^= w[r * 16 + i];
  }
  return s;
}
function gmul(x, y) {                          // GF(2^128) multiply, GCM bit order
  const z = new Uint8Array(16), v = y.slice();
  for (let i = 0; i < 128; i++) {
    if ((x[i >> 3] >> (7 - (i & 7))) & 1) for (let j = 0; j < 16; j++) z[j] ^= v[j];
    const lsb = v[15] & 1;
    for (let j = 15; j > 0; j--) v[j] = (v[j] >> 1) | ((v[j - 1] & 1) << 7);
    v[0] >>= 1;
    if (lsb) v[0] ^= 0xe1;
  }
  return z;
}
function ghash(h, aad, ct) {
  let y = new Uint8Array(16);
  const feed = (buf) => {
    for (let i = 0; i < buf.length; i += 16) {
      const blk = new Uint8Array(16); blk.set(buf.slice(i, i + 16));
      for (let j = 0; j < 16; j++) y[j] ^= blk[j];
      y = gmul(y, h);
    }
  };
  feed(aad); feed(ct);
  const len = new Uint8Array(16), la = aad.length * 8, lc = ct.length * 8;
  for (let i = 0; i < 4; i++) { len[7 - i] = (la / Math.pow(2, 8 * i)) & 0xff; len[15 - i] = (lc / Math.pow(2, 8 * i)) & 0xff; }
  for (let j = 0; j < 16; j++) y[j] ^= len[j];
  return gmul(y, h);
}
function gcmDecrypt(key, iv, data, aad) {
  const w = expandKey(key), h = encBlock(w, new Uint8Array(16));
  const ct = data.slice(0, data.length - 16), tag = data.slice(data.length - 16);
  const j0 = new Uint8Array(16); j0.set(iv); j0[15] = 1;
  const s = ghash(h, aad, ct), ek = encBlock(w, j0);
  let bad = 0;
  for (let i = 0; i < 16; i++) bad |= (s[i] ^ ek[i]) ^ tag[i];
  if (bad) throw new Error('解密失敗：小工具金鑰不對或資料損壞');
  const out = new Uint8Array(ct.length), ctr = j0.slice();
  for (let i = 0; i < ct.length; i += 16) {
    for (let k = 15; k >= 12; k--) { ctr[k] = (ctr[k] + 1) & 0xff; if (ctr[k]) break; }
    const ks = encBlock(w, ctr);
    for (let j = 0; j < 16 && i + j < ct.length; j++) out[i + j] = ct[i + j] ^ ks[j];
  }
  return out;
}
function b64u(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  s = String(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/[=\s]/g, '');
  const out = [];
  let buf = 0, bits = 0;
  for (const ch of s) {
    const v = A.indexOf(ch);
    if (v < 0) continue;
    buf = (buf << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
  }
  return new Uint8Array(out);
}
function utf8(bytes) {
  let s = '', i = 0;
  while (i < bytes.length) {
    const c = bytes[i++];
    if (c < 0x80) s += String.fromCharCode(c);
    else if (c < 0xe0) s += String.fromCharCode(((c & 0x1f) << 6) | (bytes[i++] & 0x3f));
    else if (c < 0xf0) s += String.fromCharCode(((c & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
    else { const cp = ((c & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f); s += String.fromCodePoint(cp); }
  }
  return s;
}
function openWidgetEnvelope(env, keyB64) {
  const aad = new Uint8Array([...'pfm-widget-v1'].map((c) => c.charCodeAt(0)));
  return JSON.parse(utf8(gcmDecrypt(b64u(keyB64), b64u(env.iv), b64u(env.ct), aad)));
}
if (typeof module !== 'undefined') module.exports = { openWidgetEnvelope };   // for tests in Node

// ------------------------------------------------------------ Scriptable
async function ask(title, msg, key) {
  const a = new Alert();
  a.title = title; a.message = msg;
  a.addSecureTextField('', '');
  a.addAction('儲存'); a.addCancelAction('取消');
  if ((await a.present()) === -1) return null;
  const v = a.textFieldValue(0).trim();
  if (v) Keychain.set(key, v);
  return v || null;
}
async function load() {
  const token = Keychain.contains(K_TOKEN) ? Keychain.get(K_TOKEN) : null;
  const key = Keychain.contains(K_KEY) ? Keychain.get(K_KEY) : null;
  if (!token || !key) return { err: '還沒設定：在 Scriptable 裡執行一次這個腳本。' };
  try {
    const r = new Request(`https://api.github.com/repos/${REPO}/contents/app/widget.enc.json`);
    r.headers = { Accept: 'application/vnd.github.raw+json', Authorization: 'Bearer ' + token };
    r.timeoutInterval = 20;
    const txt = await r.loadString();
    if (r.response.statusCode !== 200) throw new Error('GitHub ' + r.response.statusCode);
    const d = openWidgetEnvelope(JSON.parse(txt), key);
    Keychain.set(K_CACHE, JSON.stringify(d));
    return d;
  } catch (e) {
    if (Keychain.contains(K_CACHE)) { const d = JSON.parse(Keychain.get(K_CACHE)); d.stale = true; return d; }
    return { err: String(e.message || e) };
  }
}
const fmt = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));
function bar(ratio, w, h, color) {
  const dc = new DrawContext();
  dc.size = new Size(w, h); dc.opaque = false; dc.respectScreenScale = true;
  const p = new Path(); p.addRoundedRect(new Rect(0, 0, w, h), h / 2, h / 2);
  dc.addPath(p); dc.setFillColor(Color.dynamic(new Color('#000000', 0.08), new Color('#ffffff', 0.15))); dc.fillPath();
  const q = new Path(); q.addRoundedRect(new Rect(0, 0, Math.max(h, w * Math.min(1, ratio)), h), h / 2, h / 2);
  dc.addPath(q); dc.setFillColor(color); dc.fillPath();
  return dc.getImage();
}
function build(d) {
  const w = new ListWidget();
  w.url = APP_URL;
  w.backgroundColor = Color.dynamic(new Color('#ffffff'), new Color('#1c1c1e'));
  w.setPadding(14, 16, 12, 16);
  const label = Color.dynamic(new Color('#000000'), new Color('#ffffff'));
  const sub = Color.dynamic(new Color('#3c3c43', 0.65), new Color('#ebebf5', 0.6));
  if (d.err) { const t = w.addText(d.err); t.font = Font.systemFont(13); t.textColor = sub; return w; }
  const row = w.addStack(); row.layoutHorizontally();
  const left = row.addStack(); left.layoutVertically();
  const mon = +String(d.ym || '').slice(5) || '';
  const l1 = left.addText(`${mon} 月結餘${d.balance_is_estimate ? '（預估）' : ''}`); l1.font = Font.mediumSystemFont(12); l1.textColor = sub;
  const big = left.addText((d.balance < 0 ? '−' : '') + fmt(Math.abs(d.balance)));
  big.font = Font.boldRoundedSystemFont(28); big.minimumScaleFactor = 0.6;
  big.textColor = d.balance >= 0 ? Color.dynamic(new Color('#1f9d55'), new Color('#30d158')) : Color.dynamic(new Color('#e5352b'), new Color('#ff5c52'));
  left.addSpacer(6);
  const ratio = (d.daily || 0) / Math.max(1, d.daily_cap || 1);
  const col = ratio >= 1 ? new Color('#e5352b') : ratio >= 0.8 ? new Color('#f29900') : new Color('#34c759');
  left.addImage(bar(ratio, 140, 8, col));
  left.addSpacer(3);
  const l2 = left.addText(`日常 ${fmt(d.daily)} / ${fmt(d.daily_cap)}`); l2.font = Font.systemFont(11); l2.textColor = sub;
  row.addSpacer();
  const right = row.addStack(); right.layoutVertically(); right.size = new Size(130, 0);
  const n = d.todo_count || 0;
  const h = right.addText(n ? `待處理 ${n} 件` : '沒有待處理'); h.font = Font.semiboldSystemFont(12); h.textColor = n ? Color.orange() : sub;
  right.addSpacer(4);
  if (d.next) {
    const t = right.addText(d.next.title || ''); t.font = Font.systemFont(12); t.textColor = label; t.lineLimit = 3;
    if (d.next.due) { const due = right.addText(`最晚 ${+d.next.due.slice(5, 7)}/${+d.next.due.slice(8, 10)}`); due.font = Font.systemFont(11); due.textColor = sub; }
  }
  w.addSpacer();
  const g = new Date(d.generated_at || Date.now());
  const foot = w.addText(`${d.stale ? '離線・' : ''}更新於 ${g.getMonth() + 1}/${g.getDate()} ${String(g.getHours()).padStart(2, '0')}:${String(g.getMinutes()).padStart(2, '0')}`);
  foot.font = Font.systemFont(10); foot.textColor = sub;
  w.refreshAfterDate = new Date(Date.now() + 60 * 60 * 1000);
  return w;
}
async function main() {
  if (!config.runsInWidget) {
    if (!Keychain.contains(K_TOKEN)) await ask('GitHub 金鑰', '貼上 app 用的同一把 GitHub 金鑰（github_pat_…）', K_TOKEN);
    if (!Keychain.contains(K_KEY)) await ask('小工具金鑰', '在 app「設定 → 主畫面小工具 → 複製小工具金鑰」複製後貼上', K_KEY);
  }
  const d = await load();
  const w = build(d);
  if (config.runsInWidget) Script.setWidget(w); else await w.presentMedium();
  Script.complete();
}
if (typeof Script !== 'undefined') await main();

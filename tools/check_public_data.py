#!/usr/bin/env python3
"""check_public_data.py — schema and hygiene check for the advisor tab's public data files (PFM-ADVISOR-SPEC §3.3).

  python3 tools/check_public_data.py <dir>                 e.g. data   (checks the files that exist; at least one)
  python3 tools/check_public_data.py <dir> --require-all   all of benchmarks.json, cma.json, whitelist.json must exist
  python3 tools/check_public_data.py --selftest            built-in made-up samples + deliberately broken ones

Exit code 0 = everything passed, 1 = at least one error (each one is printed), 2 = bad command line.
Extra fields are allowed; only what the spec lists is checked. Pure standard library (the Cholesky test is plain Python).
The files are public: besides the schema, every string is scanned for personal-data patterns, and whitelist.json
for buy/sell wording ("候選池，不是推薦").
"""
import argparse
import contextlib
import copy
import datetime as dt
import io
import json
import math
import os
import re
import sys
import tempfile
import unicodedata
import urllib.parse

FILES = ("benchmarks.json", "cma.json", "whitelist.json")
CLASS_IDS = ["cash", "bond_s", "bond_l", "tw_eq", "us_eq", "gl_eq", "us_tech"]          # §2.1, fixed order
LINE_IDS = ["deposit", "cpi_tw", "tw50_lt", "sp500_lt"]                                  # §3.3 benchmarks.lines
FEE_NUMBERS = ["tw_fee_rate", "tw_fee_min", "tw_tax_stock", "tw_tax_etf", "tw_tax_bond_etf", "us_dca_rate", "us_min_usd"]
STATUSES = ("ok", "待確認")
DCA_VALUES = ("是", "否", "待確認")
CMA_NOTE = "假設不是預測"
CMA_MU_KIND = "geometric"   # cma.mu 的口徑：機構預測的年化複利（幾何）報酬；模型內部換成漂移後才計入波動拖累（V2 審查 A-1）
WL_NOTE = "候選池，不是推薦"
WL_ID_RE = re.compile(r"^(TW|US):[A-Z0-9.]{1,10}$")
DAY_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
MONTH_RE = re.compile(r"^[0-9]{4}-[0-9]{2}$")
MISSING = object()

# buy/sell wording that must not appear in whitelist.json text fields (English ones as whole words, any case)
BUYSELL_ZH = ["買進", "賣出", "買入", "賣掉", "加碼", "減碼", "出清", "停損", "停利", "獲利了結", "進場", "出場", "抄底", "推薦買", "首選"]
BUYSELL_EN = re.compile(r"(?<![A-Za-z])(?:buy(?:s|ing)?|sell(?:s|ing)?)(?![A-Za-z])", re.I)   # not "Russell", not "buyback"

# personal-data patterns, run on every string (and key) of every file; the first two also run on URLs
PII_ALWAYS = [
    ("身分證格式", re.compile(r"(?<![A-Za-z0-9])[A-Z][12][0-9]{8}(?![0-9])")),
    ("email", re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}")),
]
PII_TEXT = [
    ("連續 8 位以上數字", re.compile(r"[0-9]{8,}")),
    ("手機號碼", re.compile(r"(?<![0-9])09[0-9]{2}[- ]?[0-9]{3}[- ]?[0-9]{3}(?![0-9])")),
    ("市話號碼", re.compile(r"(?<![0-9])\(?0[2-8][0-9]?\)?[- ]?[0-9]{3,4}[- ]?[0-9]{4}(?![0-9])")),
    ("國際電話", re.compile(r"(?<![0-9A-Za-z])\+[0-9]{1,3}[- ]?[0-9]{1,4}(?:[- ]?[0-9]{2,4}){2,3}(?![0-9])")),
    ("帳號樣式（分段數字）", re.compile(r"(?<![0-9])[0-9]{3,6}(?:-[0-9]{3,6}){2,}(?![0-9])")),
    ("帳號樣式（16 碼卡號）", re.compile(r"(?<![0-9])[0-9]{4}([- ])[0-9]{4}\1[0-9]{4}\1[0-9]{4}(?![0-9])")),
    ("帳號樣式（遮罩尾碼）", re.compile(r"(?:[*＊•]{2,}|[xX]{3,})\s?[0-9]{3,}")),
    ("帳號樣式（帳號字樣）", re.compile(r"(?:帳號|帳戶|戶號|卡號|account\s*(?:no|number|#))\s*[:：#]?\s*[0-9*\-]{4,}", re.I)),
]


# ------------------------------------------------------------------ small checks
def is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def iso_day(s):
    if not isinstance(s, str) or not DAY_RE.fullmatch(s):
        return False
    try:
        dt.date.fromisoformat(s)
    except ValueError:
        return False
    return True


def src_day(s):
    """A source's data date: a real YYYY-MM-DD, or YYYY-MM (monthly statistics)."""
    if iso_day(s):
        return True
    if isinstance(s, str) and MONTH_RE.fullmatch(s):
        return 1 <= int(s[5:]) <= 12
    return False


def cholesky_ok(m):
    """True when the symmetric matrix m (list of lists) is positive definite — plain-Python Cholesky."""
    n = len(m)
    L = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(i + 1):
            s = m[i][j] - sum(L[i][k] * L[j][k] for k in range(j))
            if i == j:
                if s <= 1e-12:
                    return False
                L[i][i] = math.sqrt(s)
            else:
                L[i][j] = s / L[j][j]
    return True


class Check:
    """Collects errors for one file; every message starts with 'file: path:'."""

    def __init__(self, fname):
        self.fname, self.errors = fname, []

    def err(self, where, msg):
        self.errors.append(f"{self.fname}: {where}: {msg}")

    def get(self, obj, key, where):
        if key not in obj:
            self.err(f"{where}.{key}" if where else key, "缺少欄位")
            return MISSING
        return obj[key]

    def text(self, obj, key, where, empty_ok=False):
        v = self.get(obj, key, where)
        if v is not MISSING and not (isinstance(v, str) and (empty_ok or v.strip())):
            self.err(f"{where}.{key}", "必須是" + ("字串" if empty_ok else "非空字串"))
        return v

    def day(self, obj, key, where):
        v = self.get(obj, key, where)
        if v is not MISSING and not iso_day(v):
            self.err(f"{where}.{key}" if where else key, f"不是 ISO 日期 YYYY-MM-DD（{str(v)[:30]!r}）")
        return v

    def header(self, d):
        rev = self.get(d, "rev", "")
        if rev is not MISSING and not (is_int(rev) and rev > 0):
            self.err("rev", f"必須是正整數（{str(rev)[:20]!r}）")
        self.day(d, "as_of", "")

    def src(self, obj, where, key="src", need=2):
        v = self.get(obj, key, where)
        if v is MISSING:
            return
        p = f"{where}.{key}" if where else key
        if not isinstance(v, list):
            return self.err(p, "必須是陣列")
        if len(v) < need:
            self.err(p, f"來源至少 {need} 個（現有 {len(v)}）")
        urls = set()
        for i, s in enumerate(v):
            q = f"{p}[{i}]"
            if not isinstance(s, dict):
                self.err(q, "必須是物件 {title,url,date}")
                continue
            self.text(s, "title", q)
            u = self.get(s, "url", q)
            if u is not MISSING:
                host = ""
                try:
                    host = urllib.parse.urlparse(u).hostname or "" if isinstance(u, str) else ""
                except ValueError:
                    pass
                if not (isinstance(u, str) and u.startswith("https://") and host and not re.search(r"\s", u)):
                    self.err(f"{q}.url", f"必須以 https:// 開頭且是有效網址（{str(u)[:40]!r}）")
                else:
                    urls.add(u.rstrip("/"))
            d = self.get(s, "date", q)
            if d is not MISSING and not src_day(d):
                self.err(f"{q}.date", f"資料日期必須是 YYYY-MM-DD（或 YYYY-MM）（{str(d)[:20]!r}）")
        if len(v) >= need and len(urls) < need:
            self.err(p, f"來源網址必須至少 {need} 個不同的（現有 {len(urls)}）")

    def status(self, obj, where, note=True):
        """status in {ok, 待確認}; items that carry a `note` field must explain a 待確認 there."""
        st = self.get(obj, "status", where)
        if st is not MISSING and st not in STATUSES:
            self.err(f"{where}.status", f"必須是 ok 或 待確認（{str(st)[:20]!r}）")
        if note:
            n = self.text(obj, "note", where, empty_ok=True)
            if st == "待確認" and n is not MISSING and isinstance(n, str) and not n.strip():
                self.err(f"{where}.note", "status 是 待確認 時 note 必須寫明差異或查不到的原因")
        return st

    def number(self, obj, key, where, lo=None, hi=None, lo_open=False, null_ok=False):
        v = self.get(obj, key, where)
        if v is MISSING or (v is None and null_ok):
            return v
        if not is_num(v):
            self.err(f"{where}.{key}", f"必須是數字（{str(v)[:20]!r}）")
            return v
        if lo is not None and (v <= lo if lo_open else v < lo) or hi is not None and v > hi:
            rng = f"{'(' if lo_open else '['}{lo}, {hi}]"
            self.err(f"{where}.{key}", f"{v} 不在 {rng}")
        return v


# ------------------------------------------------------------------ benchmarks.json
def check_benchmarks(d):
    c = Check("benchmarks.json")
    c.header(d)
    lines = c.get(d, "lines", "")
    if lines is not MISSING:
        if not isinstance(lines, list):
            c.err("lines", "必須是陣列")
        else:
            seen = []
            for i, ln in enumerate(lines):
                p = f"lines[{i}]"
                if not isinstance(ln, dict):
                    c.err(p, "必須是物件")
                    continue
                lid = c.get(ln, "id", p)
                if lid is not MISSING:
                    if lid not in LINE_IDS:
                        c.err(f"{p}.id", f"不是固定 id 之一 {LINE_IDS}（{str(lid)[:20]!r}）")
                    elif lid in seen:
                        c.err(f"{p}.id", f"重複的 id {lid}")
                    seen.append(lid)
                c.text(ln, "label", p)
                st = c.status(ln, p)
                vp = c.get(ln, "value_pct", p)
                if vp is not MISSING:
                    if vp is None:
                        if st != "待確認":
                            c.err(f"{p}.value_pct", "null 只允許用在 status=待確認")
                    elif not is_num(vp):
                        c.err(f"{p}.value_pct", f"必須是數字或 null（{str(vp)[:20]!r}）")
                for k in ("basis", "period", "ccy"):
                    c.text(ln, k, p)
                tr = c.get(ln, "total_return", p)
                if tr is not MISSING and not isinstance(tr, bool):
                    c.err(f"{p}.total_return", "必須是 true/false")
                c.day(ln, "as_of", p)
                c.src(ln, p)
            for need in LINE_IDS:
                if need not in seen:
                    c.err("lines", f"缺少固定 id {need}")
    fees = c.get(d, "fees", "")
    if fees is not MISSING:
        if not isinstance(fees, dict):
            c.err("fees", "必須是物件")
        else:
            nulls = []
            for k in FEE_NUMBERS:
                v = c.number(fees, k, "fees", lo=0, null_ok=True)
                if v is None:
                    nulls.append(k)
            settle = c.get(fees, "settle", "fees")
            if settle is not MISSING:
                if not isinstance(settle, dict):
                    c.err("fees.settle", "必須是物件 {TW,US}")
                else:
                    for m in ("TW", "US"):
                        v = c.get(settle, m, "fees.settle")
                        if v is None:
                            nulls.append("settle." + m)
                        elif v is not MISSING and not (isinstance(v, str) and v.strip()):
                            c.err(f"fees.settle.{m}", "必須是非空字串或 null")
            c.src(fees, "fees")
            st = c.status(fees, "fees")
            if nulls and st == "ok":
                c.err("fees.status", f"有 null 欄位（{', '.join(nulls)}）時 status 必須是 待確認")
    return c.errors


# ------------------------------------------------------------------ cma.json
def check_cma(d):
    c = Check("cma.json")
    c.header(d)
    n = c.get(d, "note", "")
    if n is not MISSING and not (isinstance(n, str) and CMA_NOTE in n):
        c.err("note", f"頂層 note 必須是「{CMA_NOTE}」")
    mk = c.get(d, "mu_kind", "")
    if mk is not MISSING and not (isinstance(mk, str) and mk == CMA_MU_KIND):
        c.err("mu_kind", f"必須是「{CMA_MU_KIND}」（mu 是年化複利報酬，不是算術平均；現為 {str(mk)[:20]!r}）")
    cls = c.get(d, "classes", "")
    if cls is not MISSING:
        if not isinstance(cls, list):
            c.err("classes", "必須是陣列")
        else:
            if len(cls) != 7:
                c.err("classes", f"必須剛好 7 類（現有 {len(cls)}）")
            for i, x in enumerate(cls):
                p = f"classes[{i}]"
                if not isinstance(x, dict):
                    c.err(p, "必須是物件")
                    continue
                cid = c.get(x, "id", p)
                if cid is not MISSING and i < 7 and cid != CLASS_IDS[i]:
                    c.err(f"{p}.id", f"順序必須同規格 §2.1，這一格應為 {CLASS_IDS[i]}（現為 {str(cid)[:20]!r}）")
                c.text(x, "label", p)
                c.number(x, "mu", p, lo=-0.05, hi=0.2)
                c.number(x, "sigma", p, lo=0, hi=0.6, lo_open=True)
                c.number(x, "cap", p, lo=0, hi=1, lo_open=True)
                px = c.get(x, "proxy", p)
                if px is not MISSING:
                    if isinstance(px, dict):
                        c.text(px, "name", p + ".proxy")
                        c.text(px, "code", p + ".proxy")
                    else:
                        c.err(f"{p}.proxy", "必須是物件 {name,code}")
                c.text(x, "basis", p)
                c.src(x, p)
                c.status(x, p, note=False)
    corr = c.get(d, "corr", "")
    if corr is not MISSING:
        ok = isinstance(corr, list) and len(corr) == 7 and all(isinstance(r, list) and len(r) == 7 for r in corr)
        if not ok:
            c.err("corr", "必須是 7×7 的二維陣列")
        elif not all(is_num(v) for r in corr for v in r):
            c.err("corr", "所有元素必須是數字")
        else:
            bad = [(i, j) for i in range(7) for j in range(7) if not -1 <= corr[i][j] <= 1]
            if bad:
                c.err("corr", f"元素必須在 [-1, 1]（例：[{bad[0][0]}][{bad[0][1]}]={corr[bad[0][0]][bad[0][1]]}）")
            asym = [(i, j) for i in range(7) for j in range(i) if abs(corr[i][j] - corr[j][i]) > 1e-9]
            if asym:
                c.err("corr", f"不對稱（例：[{asym[0][0]}][{asym[0][1]}] ≠ [{asym[0][1]}][{asym[0][0]}]）")
            diag = [i for i in range(7) if abs(corr[i][i] - 1) > 1e-9]
            if diag:
                c.err("corr", f"對角必須是 1（例：[{diag[0]}][{diag[0]}]={corr[diag[0]][diag[0]]}）")
            if not bad and not asym and not diag and not cholesky_ok(corr):
                c.err("corr", "不是正定矩陣，無法 Cholesky 分解")
    c.text(d, "corr_basis", "")
    c.src(d, "", key="corr_src")
    idio = c.get(d, "idio", "")
    if idio is not MISSING:
        if not isinstance(idio, dict):
            c.err("idio", "必須是物件 {tw_single,us_single,basis,src}")
        else:
            for k in ("tw_single", "us_single"):
                c.number(idio, k, "idio", lo=0, hi=1, lo_open=True)
            c.text(idio, "basis", "idio")
            c.src(idio, "idio")
    return c.errors


# ------------------------------------------------------------------ whitelist.json
def check_whitelist(d):
    c = Check("whitelist.json")
    c.header(d)
    n = c.get(d, "note", "")
    if n is not MISSING and not (isinstance(n, str) and (WL_NOTE in n or unicodedata.normalize("NFKC", WL_NOTE) in unicodedata.normalize("NFKC", n))):
        c.err("note", f"頂層 note 必須含「{WL_NOTE}」")
    items = c.get(d, "items", "")
    if items is MISSING:
        return c.errors + whitelist_text_errors(c, d)
    if not isinstance(items, list):
        c.err("items", "必須是陣列")
        return c.errors
    ids, per_mkt, per_cls = set(), {"TW": 0, "US": 0}, {}
    for i, it in enumerate(items):
        p = f"items[{i}]"
        if not isinstance(it, dict):
            c.err(p, "必須是物件")
            continue
        iid = c.get(it, "id", p)
        prefix = suffix = None
        if iid is not MISSING:
            if not (isinstance(iid, str) and WL_ID_RE.fullmatch(iid)):
                c.err(f"{p}.id", f"格式必須是 ^(TW|US):[A-Z0-9.]{{1,10}}$（{str(iid)[:24]!r}）")
            else:
                prefix, suffix = iid.split(":", 1)
                if iid in ids:
                    c.err(f"{p}.id", f"重複的 id {iid}")
                ids.add(iid)
                per_mkt[prefix] += 1
        mkt = c.get(it, "mkt", p)
        if mkt is not MISSING and (mkt not in ("TW", "US") or (prefix and mkt != prefix)):
            c.err(f"{p}.mkt", f"必須是 TW 或 US，且與 id 前綴一致（{str(mkt)[:20]!r}）")
        code = c.text(it, "code", p)
        if suffix and isinstance(code, str) and code != suffix:
            c.err(f"{p}.code", f"必須等於 id 冒號後的代號 {suffix}（現為 {code[:20]!r}）")
        c.text(it, "name", p)
        cl = c.get(it, "cls", p)
        if cl is not MISSING:
            if cl not in CLASS_IDS:
                c.err(f"{p}.cls", f"必須是 7 類之一（{str(cl)[:20]!r}）")
            else:
                per_cls[cl] = per_cls.get(cl, 0) + 1
        c.text(it, "ccy", p)
        st = c.status(it, p)
        er = c.number(it, "er_pct", p, lo=0, hi=10, null_ok=True)
        ed = c.get(it, "er_date", p)
        if er is None:
            if st != "待確認":
                c.err(f"{p}.er_pct", "null 只允許用在 status=待確認")
            if ed is not MISSING and ed is not None and not iso_day(ed):
                c.err(f"{p}.er_date", "必須是 ISO 日期或 null")
        elif ed is not MISSING and not iso_day(ed):
            c.err(f"{p}.er_date", f"不是 ISO 日期 YYYY-MM-DD（{str(ed)[:30]!r}）")
        c.text(it, "dist", p)
        c.text(it, "min_fee_note", p, empty_ok=True)
        c.text(it, "settle", p)
        dca = c.get(it, "dca_ok", p)
        if dca is not MISSING and dca not in DCA_VALUES:
            c.err(f"{p}.dca_ok", f"必須是 是／否／待確認（{str(dca)[:20]!r}）")
        c.src(it, p)
    for m, label in (("TW", "台股 ETF"), ("US", "美股 ETF")):
        if not 5 <= per_mkt[m] <= 8:
            c.err("items", f"{label}（{m}:）必須 5–8 檔（現有 {per_mkt[m]}）")
    for k in CLASS_IDS[1:]:
        if per_cls.get(k, 0) < 2:
            c.err("items", f"類別 {k} 至少 2 檔（現有 {per_cls.get(k, 0)}）")
    return c.errors + whitelist_text_errors(c, d)


def strings(obj, path=""):
    """(path, key, text) for every string value in the document; keys are yielded too, with key='<key>'."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield f"{path}.{k}" if path else str(k), "<key>", str(k)
            if isinstance(v, str):
                yield f"{path}.{k}" if path else str(k), str(k), v
            else:
                yield from strings(v, f"{path}.{k}" if path else str(k))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            if isinstance(v, str):
                yield f"{path}[{i}]", "", v
            else:
                yield from strings(v, f"{path}[{i}]")


def whitelist_text_errors(c, d):
    """No buy/sell wording in any text field (urls and ticker ids/codes excluded)."""
    out = []
    for path, key, s in strings(d):
        if key in ("url", "id", "code", "<key>"):
            continue
        t = unicodedata.normalize("NFKC", s)
        hit = [w for w in BUYSELL_ZH if w in t] + [m.group(0) for m in BUYSELL_EN.finditer(t)]
        if hit:
            out.append(f"{c.fname}: {path}: 含買賣字詞「{hit[0]}」")
    return out


# ------------------------------------------------------------------ all files: no personal-data patterns
def pii_errors(fname, d):
    out = []
    for path, key, s in strings(d):
        t = unicodedata.normalize("NFKC", s)
        is_url = key == "url" or t.lower().startswith(("http://", "https://"))
        for name, rx in PII_ALWAYS + ([] if is_url else PII_TEXT):
            m = rx.search(t)
            if m:
                out.append(f"{fname}: {path}: 疑似個資（{name}）")
                break

    def ints(o, p):
        if isinstance(o, dict):
            for k, v in o.items():
                yield from ints(v, f"{p}.{k}" if p else str(k))
        elif isinstance(o, list):
            for i, v in enumerate(o):
                yield from ints(v, f"{p}[{i}]")
        elif is_int(o) and abs(o) >= 10_000_000:
            yield p
    for p in ints(d, ""):
        out.append(f"{fname}: {p}: 疑似個資（8 位以上的整數）")
    return out


CHECKERS = {"benchmarks.json": check_benchmarks, "cma.json": check_cma, "whitelist.json": check_whitelist}


def check_data(fname, d):
    """All errors for one parsed file."""
    if not isinstance(d, dict):
        return [f"{fname}: (top level): 最外層必須是物件"]
    return CHECKERS[fname](d) + pii_errors(fname, d)


# ------------------------------------------------------------------ loading and the directory run
def _no_dups(pairs):
    seen = set()
    for k, _ in pairs:
        if k in seen:
            raise ValueError(f"重複的鍵 {k!r}")
        seen.add(k)
    return dict(pairs)


def _no_const(name):
    raise ValueError(f"不合法的 JSON 常數 {name}")


def load_file(path):
    with open(path, encoding="utf-8") as f:
        return json.loads(f.read(), object_pairs_hook=_no_dups, parse_constant=_no_const)


def check_dir(path, require_all=False, out=print):
    """Returns the process exit code."""
    if not os.path.isdir(path):
        out(f"錯誤：找不到目錄 {path}")
        return 1
    present = [f for f in FILES if os.path.isfile(os.path.join(path, f))]
    errors = []
    for f in FILES:
        if f not in present:
            if require_all:
                errors.append(f"{f}: 檔案不存在（--require-all）")
            else:
                out(f"{f}: 不在目錄中，略過")
    if not present:
        errors.append(f"{path}: 目錄中一個公開檔都沒有（benchmarks.json、cma.json、whitelist.json 至少要有一個）")
    for f in present:
        try:
            errs = check_data(f, load_file(os.path.join(path, f)))
        except (OSError, ValueError) as e:                       # includes UnicodeDecodeError and JSON errors
            errs = [f"{f}: (parse): 讀不了或不是合法 JSON（{type(e).__name__}: {str(e)[:80]}）"]
        out(f"{f}: " + ("OK" if not errs else f"{len(errs)} 個錯誤"))
        errors += errs
    for e in errors:
        out("  - " + e)
    out("通過" if not errors else f"失敗：共 {len(errors)} 個錯誤")
    return 0 if not errors else 1


# ------------------------------------------------------------------ self test (made-up samples only)
def _src(n=2, tag="x"):
    return [{"title": f"示範來源 {tag}{i}", "url": f"https://example.com/{tag}/{i}", "date": "2026-10-31"} for i in range(n)]


def sample_benchmarks():
    lines = [{"id": i, "label": f"示範線 {i}", "value_pct": v, "basis": "示範基礎", "period": "2016-2025", "ccy": "TWD",
              "total_return": t, "as_of": "2026-10-31", "src": _src(2, i), "status": "ok", "note": ""}
             for i, v, t in zip(LINE_IDS, (1.7, 1.8, 9.5, 12.0), (False, False, True, True))]
    fees = {"tw_fee_rate": 0.001425, "tw_fee_min": 20, "tw_tax_stock": 0.003, "tw_tax_etf": 0.001, "tw_tax_bond_etf": 0,
            "us_dca_rate": 0.002, "us_min_usd": 35, "settle": {"TW": "T+2", "US": "T+1"}, "src": _src(2, "fees"),
            "status": "ok", "note": ""}
    return {"rev": 1, "as_of": "2026-11-01", "lines": lines, "fees": fees}


def sample_cma():
    mu, sg, cap = [.015, .03, .04, .08, .08, .075, .10], [.005, .06, .08, .20, .17, .16, .24], [1, 1, .6, .6, .7, .7, .3]
    R = [[1.0 if i == j else 0.0 for j in range(7)] for i in range(7)]

    def s(i, j, v):
        R[i][j] = R[j][i] = v
    for j, v in zip([2, 3, 4, 5, 6], [.5, -.1, .1, .1, .1]):
        s(1, j, v)
    for j, v in zip([3, 4, 5, 6], [.1, .2, .2, .2]):
        s(2, j, v)
    for j, v in zip([4, 5, 6], [.6, .7, .65]):
        s(3, j, v)
    for j, v in zip([5, 6], [.9, .9]):
        s(4, j, v)
    s(5, 6, .8)
    classes = [{"id": cid, "label": f"示範 {cid}", "mu": mu[i], "sigma": sg[i], "cap": cap[i],
                "proxy": {"name": f"示範代理 {i}", "code": f"X{i}"}, "basis": "示範方法", "src": _src(2, cid), "status": "ok"}
               for i, cid in enumerate(CLASS_IDS)]
    return {"rev": 1, "as_of": "2026-11-01", "note": CMA_NOTE, "mu_kind": CMA_MU_KIND, "classes": classes, "corr": R, "corr_basis": "示範",
            "corr_src": _src(2, "corr"), "idio": {"tw_single": .25, "us_single": .35, "basis": "示範", "src": _src(2, "idio")}}


def sample_whitelist():
    spec = [("TW", "tw_eq"), ("TW", "tw_eq"), ("TW", "bond_s"), ("TW", "bond_l"), ("TW", "us_tech"),
            ("US", "us_eq"), ("US", "us_eq"), ("US", "gl_eq"), ("US", "gl_eq"), ("US", "bond_s"), ("US", "bond_l"), ("US", "us_tech")]
    items = []
    for n, (m, cl) in enumerate(spec):
        code = f"ZZ{n:02d}"
        items.append({"id": f"{m}:{code}", "mkt": m, "code": code, "name": f"示範基金 {n}", "cls": cl,
                      "ccy": "TWD" if m == "TW" else "USD", "er_pct": 0.1 + n / 100, "er_date": "2026-10-31", "dist": "季配",
                      "min_fee_note": "", "settle": "T+2" if m == "TW" else "T+1", "dca_ok": "是", "note": "",
                      "src": _src(2, code), "status": "ok"})
    return {"rev": 1, "as_of": "2026-11-01", "note": "這是候選池，不是推薦", "items": items}


def _set(path, value):
    """Mutation: set d[path...] = value (path is a tuple of keys/indices); value ... deletes the last key."""
    def f(d):
        o = d
        for k in path[:-1]:
            o = o[k]
        if value is ...:
            del o[path[-1]]
        else:
            o[path[-1]] = value
    return f


def _many(*fs):
    def f(d):
        for g in fs:
            g(d)
    return f


def _bad_cases():
    """(file, description, mutation, expected text in at least one error)."""
    out = []

    def add(file, desc, mut, want):
        out.append((file, desc, mut, want))
    for f in FILES:                                                    # header / status / src rules, shared shape
        add(f, "rev = 0", _set(("rev",), 0), "rev")
        add(f, "rev = -3", _set(("rev",), -3), "rev")
        add(f, "rev = true", _set(("rev",), True), "rev")
        add(f, "rev = '1'", _set(("rev",), "1"), "rev")
        add(f, "rev = 1.5", _set(("rev",), 1.5), "rev")
        add(f, "rev missing", _set(("rev",), ...), "rev")
        add(f, "as_of with slashes", _set(("as_of",), "2026/11/01"), "as_of")
        add(f, "as_of impossible date", _set(("as_of",), "2026-02-30"), "as_of")
        add(f, "as_of missing", _set(("as_of",), ...), "as_of")
        add(f, "as_of number", _set(("as_of",), 20261101), "as_of")
    first = {"benchmarks.json": ("lines", 0), "cma.json": ("classes", 0), "whitelist.json": ("items", 0)}
    for f, (k, i) in first.items():
        base = (k, i)
        add(f, "status 'OK'", _set(base + ("status",), "OK"), "status")
        add(f, "status missing", _set(base + ("status",), ...), "status")
        add(f, "src has only 1 source", _set(base + ("src",), _src(1)), "來源至少 2")
        add(f, "src missing", _set(base + ("src",), ...), "src")
        add(f, "src not a list", _set(base + ("src",), "https://example.com"), "src")
        add(f, "src url is http://", _set(base + ("src", 0, "url"), "http://example.com/a"), "https://")
        add(f, "src url without scheme", _set(base + ("src", 1, "url"), "example.com/a"), "https://")
        add(f, "src url with a space", _set(base + ("src", 1, "url"), "https://example.com/a b"), "https://")
        add(f, "src title missing", _set(base + ("src", 0, "title"), ...), "title")
        add(f, "src title empty", _set(base + ("src", 0, "title"), "  "), "title")
        add(f, "src date missing", _set(base + ("src", 0, "date"), ...), "date")
        add(f, "src date bad", _set(base + ("src", 0, "date"), "last week"), "date")
        add(f, "src date impossible month", _set(base + ("src", 0, "date"), "2026-13"), "date")
        add(f, "two sources with the same url", _set(base + ("src", 1, "url"), "https://example.com/" + {"benchmarks.json": "deposit", "cma.json": "cash", "whitelist.json": "ZZ00"}[f] + "/0"), "不同")
        add(f, "src entry not an object", _set(base + ("src", 0), "https://example.com"), "物件")
    # benchmarks
    B = "benchmarks.json"
    add(B, "lines missing", _set(("lines",), ...), "lines")
    add(B, "lines not a list", _set(("lines",), {}), "lines")
    add(B, "a fixed id is missing", lambda d: d["lines"].pop(), "缺少固定 id")
    add(B, "duplicate line id", _set(("lines", 1, "id"), "deposit"), "重複")
    add(B, "unknown line id", _set(("lines", 1, "id"), "gold"), "固定 id")
    add(B, "value_pct is a string", _set(("lines", 0, "value_pct"), "1.7"), "value_pct")
    add(B, "value_pct null while status ok", _set(("lines", 0, "value_pct"), None), "value_pct")
    add(B, "value_pct is bool", _set(("lines", 0, "value_pct"), True), "value_pct")
    add(B, "line label missing", _set(("lines", 0, "label"), ...), "label")
    add(B, "period empty", _set(("lines", 0, "period"), ""), "period")
    add(B, "total_return not bool", _set(("lines", 0, "total_return"), "yes"), "total_return")
    add(B, "line as_of bad", _set(("lines", 2, "as_of"), "Oct 2026"), "as_of")
    add(B, "line note missing", _set(("lines", 0, "note"), ...), "note")
    add(B, "待確認 without a note", _many(_set(("lines", 0, "status"), "待確認"), _set(("lines", 0, "note"), "")), "note")
    add(B, "fees missing", _set(("fees",), ...), "fees")
    add(B, "fees field missing", _set(("fees", "us_min_usd"), ...), "us_min_usd")
    add(B, "fees field is a string", _set(("fees", "tw_fee_rate"), "0.1425%"), "tw_fee_rate")
    add(B, "fees field is bool", _set(("fees", "tw_tax_etf"), True), "tw_tax_etf")
    add(B, "fees field negative", _set(("fees", "tw_tax_stock"), -0.003), "tw_tax_stock")
    add(B, "fees null while status ok", _set(("fees", "us_dca_rate"), None), "待確認")
    add(B, "fees settle missing", _set(("fees", "settle"), ...), "settle")
    add(B, "fees settle.US missing", _set(("fees", "settle", "US"), ...), "settle.US")
    add(B, "fees settle not an object", _set(("fees", "settle"), "T+2"), "settle")
    add(B, "fees src has 1 source", _set(("fees", "src"), _src(1)), "來源至少 2")
    add(B, "fees status bad", _set(("fees", "status"), "maybe"), "status")
    # cma
    C = "cma.json"
    add(C, "note missing", _set(("note",), ...), "note")
    add(C, "note is not the assumption line", _set(("note",), "預測值"), "假設不是預測")
    add(C, "mu_kind missing", _set(("mu_kind",), ...), "mu_kind")
    add(C, "mu_kind is 'arithmetic'", _set(("mu_kind",), "arithmetic"), "mu_kind")
    add(C, "mu_kind wrong case 'Geometric'", _set(("mu_kind",), "Geometric"), "mu_kind")
    add(C, "mu_kind is not a string", _set(("mu_kind",), True), "mu_kind")
    add(C, "only 6 classes", lambda d: d["classes"].pop(), "7 類")
    add(C, "8 classes", lambda d: d["classes"].append(copy.deepcopy(d["classes"][0])), "7 類")
    add(C, "class order swapped", lambda d: d["classes"].insert(0, d["classes"].pop(1)), "順序")
    add(C, "unknown class id", _set(("classes", 2, "id"), "gold"), "順序")
    add(C, "mu above 0.2", _set(("classes", 3, "mu"), 0.21), "mu")
    add(C, "mu below -0.05", _set(("classes", 3, "mu"), -0.06), "mu")
    add(C, "mu in percent units", _set(("classes", 3, "mu"), 8), "mu")
    add(C, "mu is bool", _set(("classes", 3, "mu"), True), "mu")
    add(C, "mu is a string", _set(("classes", 3, "mu"), "0.08"), "mu")
    add(C, "mu null", _set(("classes", 3, "mu"), None), "mu")
    add(C, "sigma 0", _set(("classes", 3, "sigma"), 0), "sigma")
    add(C, "sigma above 0.6", _set(("classes", 3, "sigma"), 0.61), "sigma")
    add(C, "sigma negative", _set(("classes", 3, "sigma"), -0.1), "sigma")
    add(C, "cap 0", _set(("classes", 3, "cap"), 0), "cap")
    add(C, "cap above 1", _set(("classes", 3, "cap"), 1.01), "cap")
    add(C, "cap missing", _set(("classes", 3, "cap"), ...), "cap")
    add(C, "proxy missing code", _set(("classes", 3, "proxy", "code"), ...), "code")
    add(C, "proxy not an object", _set(("classes", 3, "proxy"), "0050"), "proxy")
    add(C, "class basis empty", _set(("classes", 3, "basis"), ""), "basis")
    add(C, "corr missing", _set(("corr",), ...), "corr")
    add(C, "corr only 6 rows", lambda d: d["corr"].pop(), "7×7")
    add(C, "corr row of length 6", lambda d: d["corr"][2].pop(), "7×7")
    add(C, "corr element is a string", _set(("corr", 2, 3), "0.5"), "數字")
    add(C, "corr element above 1", lambda d: (d["corr"][3].__setitem__(4, 1.2), d["corr"][4].__setitem__(3, 1.2)), "[-1, 1]")
    add(C, "corr not symmetric", _set(("corr", 3, 4), 0.55), "不對稱")
    add(C, "corr diagonal 0.99", _set(("corr", 3, 3), 0.99), "對角")
    add(C, "corr not positive definite", lambda d: [d["corr"][i].__setitem__(j, v) or d["corr"][j].__setitem__(i, v)
                                                      for i, j, v in ((3, 4, .95), (3, 5, .95), (4, 5, -.95))], "Cholesky")
    add(C, "two classes perfectly correlated", lambda d: (d["corr"][3].__setitem__(4, 1.0), d["corr"][4].__setitem__(3, 1.0)), "Cholesky")
    add(C, "corr_basis missing", _set(("corr_basis",), ...), "corr_basis")
    add(C, "corr_src has 1 source", _set(("corr_src",), _src(1)), "來源至少 2")
    add(C, "idio missing", _set(("idio",), ...), "idio")
    add(C, "idio.us_single missing", _set(("idio", "us_single"), ...), "us_single")
    add(C, "idio in percent units", _set(("idio", "tw_single"), 25), "tw_single")
    add(C, "idio 0", _set(("idio", "tw_single"), 0), "tw_single")
    add(C, "idio src has 1 source", _set(("idio", "src"), _src(1)), "來源至少 2")
    # whitelist
    W = "whitelist.json"
    add(W, "note without the not-a-recommendation line", _set(("note",), "精選清單"), "候選池，不是推薦")
    add(W, "note missing", _set(("note",), ...), "note")
    add(W, "items missing", _set(("items",), ...), "items")
    add(W, "id lower case", _set(("items", 0, "id"), "tw:zz00"), "id")
    add(W, "id unknown market", _set(("items", 0, "id"), "JP:ZZ00"), "id")
    add(W, "id code too long", _set(("items", 0, "id"), "TW:ABCDEFGHIJK"), "id")
    add(W, "id with a space", _set(("items", 0, "id"), "TW:ZZ 00"), "id")
    add(W, "id with trailing newline", _set(("items", 0, "id"), "TW:ZZ00\n"), "id")
    add(W, "duplicate id", lambda d: d["items"][1].update(id="TW:ZZ00", code="ZZ00"), "重複")
    add(W, "mkt does not match id", _set(("items", 0, "mkt"), "US"), "mkt")
    add(W, "code does not match id", _set(("items", 0, "code"), "QQ99"), "code")
    add(W, "cls unknown", _set(("items", 0, "cls"), "gold"), "cls")
    add(W, "dca_ok 'yes'", _set(("items", 0, "dca_ok"), "yes"), "dca_ok")
    add(W, "dca_ok missing", _set(("items", 0, "dca_ok"), ...), "dca_ok")
    add(W, "er_pct negative", _set(("items", 0, "er_pct"), -0.1), "er_pct")
    add(W, "er_pct a string", _set(("items", 0, "er_pct"), "0.3%"), "er_pct")
    add(W, "er_pct null while status ok", _set(("items", 0, "er_pct"), None), "er_pct")
    add(W, "er_date bad", _set(("items", 0, "er_date"), "2026/10/31"), "er_date")
    add(W, "er_date missing", _set(("items", 0, "er_date"), ...), "er_date")
    add(W, "name empty", _set(("items", 0, "name"), ""), "name")
    add(W, "ccy missing", _set(("items", 0, "ccy"), ...), "ccy")
    add(W, "only 4 Taiwan ETFs", lambda d: d["items"].pop(0), "台股 ETF")
    add(W, "9 Taiwan ETFs", lambda d: [d["items"].append(dict(copy.deepcopy(d["items"][0]), id=f"TW:YY0{n}", code=f"YY0{n}")) for n in range(4)], "台股 ETF")
    add(W, "only 4 US ETFs", lambda d: [d["items"].pop() for _ in range(3)], "美股 ETF")
    add(W, "9 US ETFs", lambda d: [d["items"].append(dict(copy.deepcopy(d["items"][6]), id=f"US:YY0{n}", code=f"YY0{n}")) for n in range(3)], "美股 ETF")
    add(W, "a class with only 1 fund", lambda d: [x.update(cls="us_eq") for x in d["items"] if x["cls"] == "gl_eq"][:1], "gl_eq 至少 2")
    add(W, "no fund for a class", lambda d: [x.update(cls="us_eq") for x in d["items"] if x["cls"] == "gl_eq"], "gl_eq 至少 2")
    for w in ("買進", "賣出", "買入", "賣掉", "加碼", "減碼", "出清", "停損", "停利", "獲利了結", "進場", "出場", "抄底", "推薦買", "首選"):
        add(W, f"item note says {w}", _set(("items", 3, "note"), f"適合{w}的人"), "買賣字詞")
    for w in ("buy", "BUY", "Sell", "sELL", "buying", "Selling", "buys"):
        add(W, f"item note says {w}", _set(("items", 3, "note"), f"good to {w} now"), "買賣字詞")
    add(W, "buy word in the name", _set(("items", 3, "name"), "Buy the dip ETF"), "買賣字詞")
    add(W, "full-width BUY", _set(("items", 3, "note"), "ＢＵＹ now"), "買賣字詞")
    add(W, "buy word in the top-level note", _set(("note",), "候選池，不是推薦；請買進"), "買賣字詞")
    add(W, "buy word in dist", _set(("items", 3, "dist"), "出場前配息"), "買賣字詞")
    add(W, "buy word in a source title", _set(("items", 3, "src", 0, "title"), "How to buy this fund"), "買賣字詞")
    # personal-data patterns, in every file
    place = {B: ("lines", 0, "note"), C: ("classes", 0, "basis"), W: ("items", 0, "note")}
    for f, path in place.items():
        add(f, "national-ID shaped text", _set(path, "聯絡 A123456789"), "個資")
        add(f, "email address", _set(path, "洽 someone@example.com"), "個資")
        add(f, "8+ digit run", _set(path, "編號 12345678"), "個資")
        add(f, "full-width digit run", _set(path, "編號 １２３４５６７８９"), "個資")
        add(f, "mobile phone", _set(path, "0912-345-678"), "個資")
        add(f, "mobile phone no dashes", _set(path, "call 0912345678"), "個資")
        add(f, "landline phone", _set(path, "02-2345-6789"), "個資")
        add(f, "international phone", _set(path, "+886 912 345 678"), "個資")
        add(f, "account number groups", _set(path, "帳號 123-456-7890"), "個資")
        add(f, "16-digit card", _set(path, "1234 5678 9012 3456"), "個資")
        add(f, "masked card tail", _set(path, "卡片 ****1234"), "個資")
        add(f, "account keyword + digits", _set(path, "account no: 12-34"), "個資")
        add(f, "personal data in an extra field", _set(("extra_field",), "A223456789"), "個資")
        add(f, "personal data in a key", _set(("a123456789@example.com",), 1), "個資")
        add(f, "big integer", _set(("extra_int",), 123456789012), "個資")
        add(f, "url carrying an email", _set(first[f] + ("src", 0, "url"), "https://example.com/u?mail=x@example.com"), "個資")
        add(f, "url carrying an ID-shaped string", _set(first[f] + ("src", 0, "url"), "https://example.com/u/A123456789"), "個資")
    return out


def _good_variants():
    """(file, description, mutation) that must still pass: extra fields, harmless look-alikes, allowed nulls."""
    out = []
    for f in FILES:
        out.append((f, "extra top-level and nested fields", lambda d: (d.update(extra={"a": [1, 2, 3], "t": "ok"}),
                                                                       d.update(rev=7, as_of="2026-12-31"))))
        out.append((f, "long digit runs inside a url are fine", _set(
            {"benchmarks.json": ("lines", 0), "cma.json": ("classes", 0), "whitelist.json": ("items", 0)}[f] + ("src", 0, "url"),
            "https://example.com/doc/20261101123456/report-2026.pdf?id=1234567890")))
        out.append((f, "source dated by month", _set(
            {"benchmarks.json": ("lines", 0), "cma.json": ("classes", 0), "whitelist.json": ("items", 0)}[f] + ("src", 0, "date"), "2026-10")))
        out.append((f, "dates and percentages are not phone numbers", _set(
            {"benchmarks.json": ("lines", 0, "note"), "cma.json": ("classes", 0, "basis"), "whitelist.json": ("items", 0, "note")}[f],
            "2016-01-01 ~ 2025-12-31；0.0675%；0.03%–0.09%；T+2；TW:00878；約 1,234,567 元")))
    out.append(("benchmarks.json", "待確認 line with null value and a note", _many(
        _set(("lines", 0, "value_pct"), None), _set(("lines", 0, "status"), "待確認"), _set(("lines", 0, "note"), "兩個來源差 0.2 個百分點"))))
    out.append(("benchmarks.json", "fees null with 待確認 and a note", _many(
        _set(("fees", "tw_tax_bond_etf"), None), _set(("fees", "status"), "待確認"), _set(("fees", "note"), "債券 ETF 證交稅查不到"))))
    out.append(("benchmarks.json", "fees settle null with 待確認", _many(
        _set(("fees", "settle", "US"), None), _set(("fees", "status"), "待確認"), _set(("fees", "note"), "美股交割日待查"))))
    out.append(("whitelist.json", "待確認 fund without an expense ratio", _many(
        _set(("items", 0, "er_pct"), None), _set(("items", 0, "er_date"), None), _set(("items", 0, "status"), "待確認"),
        _set(("items", 0, "note"), "費用率兩個來源不一致"), _set(("items", 0, "dca_ok"), "待確認"))))
    out.append(("whitelist.json", "Russell and buyback are not buy/sell words", _many(
        _set(("items", 0, "name"), "Russell 1000 Buyback Index ETF"), _set(("items", 1, "note"), "追蹤羅素指數，與 Russell 指數同名"))))
    out.append(("whitelist.json", "8 Taiwan ETFs and 8 US ETFs", lambda d: (
        [d["items"].append(dict(copy.deepcopy(d["items"][0]), id=f"TW:YY0{n}", code=f"YY0{n}")) for n in range(3)],
        [d["items"].append(dict(copy.deepcopy(d["items"][6]), id=f"US:YY0{n}", code=f"YY0{n}")) for n in range(1)])))
    out.append(("whitelist.json", "a cash fund is allowed", lambda d: d["items"].append(
        dict(copy.deepcopy(d["items"][0]), id="TW:YY09", code="YY09", cls="cash"))))
    return out


def selftest():
    samples = {"benchmarks.json": sample_benchmarks, "cma.json": sample_cma, "whitelist.json": sample_whitelist}
    fails, n_pass = [], 0

    def expect(ok, what):
        nonlocal n_pass
        if ok:
            n_pass += 1
        else:
            fails.append(what)

    for f, mk in samples.items():                                      # the minimal samples are valid
        errs = check_data(f, mk())
        expect(not errs, f"valid {f} should pass: {errs[:3]}")
    for f, desc, mut in _good_variants():                              # harmless variants stay valid
        d = samples[f]()
        mut(d)
        errs = check_data(f, d)
        expect(not errs, f"{f} / {desc} should pass: {errs[:3]}")
    cases = _bad_cases()
    for f, desc, mut, want in cases:                                   # broken samples must be refused, for the right reason
        d = samples[f]()
        try:
            mut(d)
        except Exception as e:                                         # a selftest bug, not a checker result
            fails.append(f"{f} / {desc}: mutation failed ({type(e).__name__}: {e})")
            continue
        errs = check_data(f, d)
        expect(any(want in e for e in errs), f"{f} / {desc}: expected an error containing {want!r}, got {errs[:3]}")
    # the primitives
    expect(cholesky_ok([[1, .5], [.5, 1]]) and not cholesky_ok([[1, 1], [1, 1]]) and not cholesky_ok([[1, 2], [2, 1]]), "cholesky_ok")
    expect(iso_day("2026-02-28") and not iso_day("2026-02-30") and not iso_day("２０２６-02-28") and not iso_day(20260228), "iso_day")
    expect(BUYSELL_EN.search("Sell") and not BUYSELL_EN.search("Russell") and not BUYSELL_EN.search("buyback"), "buy/sell regex")
    # directory level (tempfile only)
    quiet = io.StringIO()
    with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(quiet):
        def run(files, **kw):
            d = tempfile.mkdtemp(dir=tmp)
            for name, text in files.items():
                with open(os.path.join(d, name), "w", encoding="utf-8") as fh:
                    fh.write(text if isinstance(text, str) else json.dumps(text, ensure_ascii=False))
            return check_dir(d, out=lambda s: None, **kw)
        allv = {f: mk() for f, mk in samples.items()}
        expect(run(allv, require_all=True) == 0, "dir: all three files pass with --require-all")
        expect(run({"cma.json": allv["cma.json"]}) == 0, "dir: one file only passes by default")
        expect(run({"cma.json": allv["cma.json"]}, require_all=True) == 1, "dir: --require-all fails when a file is missing")
        expect(run({}) == 1, "dir: an empty directory fails")
        expect(run({"readme.txt": "x"}) == 1, "dir: a directory without any public file fails")
        expect(run({"cma.json": "{not json"}) == 1, "dir: invalid JSON fails")
        expect(run({"cma.json": "[]"}) == 1, "dir: top level not an object fails")
        expect(run({"cma.json": "﻿" + json.dumps(allv["cma.json"])}) == 1, "dir: BOM fails")
        expect(run({"cma.json": json.dumps(allv["cma.json"]).replace('"rev": 1', '"rev": 1, "rev": 2')}) == 1, "dir: duplicate key fails")
        expect(run({"cma.json": json.dumps(allv["cma.json"]).replace('"rev": 1', '"rev": NaN')}) == 1, "dir: NaN constant fails")
        expect(run({**allv, "whitelist.json": {**allv["whitelist.json"], "rev": 0}}) == 1, "dir: one bad file among good ones fails")
        expect(check_dir(os.path.join(tmp, "nope"), out=lambda s: None) == 1, "dir: a missing directory fails")
        expect(main([os.path.join(tmp, "nope")]) == 1, "main: a missing directory fails")
    total = n_pass + len(fails)
    for x in fails:
        print("SELFTEST FAIL:", x)
    kinds = f"{len(samples)} valid samples, {len(_good_variants())} harmless variants, {len(cases)} broken samples"
    print(f"selftest: {n_pass}/{total} checks passed ({kinds}, plus primitives and directory runs)")
    return 0 if not fails else 1


def main(argv=None):
    ap = argparse.ArgumentParser(description="Check the advisor tab's public data files (benchmarks.json, cma.json, whitelist.json).")
    ap.add_argument("dir", nargs="?", help="directory holding the files, e.g. data")
    ap.add_argument("--require-all", action="store_true", help="all three files must exist")
    ap.add_argument("--selftest", action="store_true", help="run the built-in samples and exit")
    a = ap.parse_args(argv)
    if a.selftest:
        return selftest()
    if not a.dir:
        ap.error("給目錄（例：data）或用 --selftest")
    return check_dir(a.dir, require_all=a.require_all)


if __name__ == "__main__":
    sys.exit(main())

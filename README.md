# 收支帳 — a private-data finance PWA shell

A small, dependency-free progressive web app that shows a personal spending overview on a phone home screen.

**This repository contains no personal data.** It is only the app shell:

- The real data lives in a separate private repository as one encrypted file
  (ECDH P-256 → HKDF-SHA256 → AES-256-GCM).
- On first run the app asks for a setup code (the decryption key) and a read-only GitHub token.
  Both are stored only on that device; decryption happens in the browser with WebCrypto.
- `demo-data.json` is fictional sample data so the interface can be previewed without a key.
- A strict Content-Security-Policy limits network access to this site and `api.github.com`.

Files: `index.html`, `style.css`, `app.js`, `sw.js` (offline shell cache), `manifest.webmanifest`, `icons/`.

## v2 (live since 2026-11-20) and widget

- The root is version 2 (five tabs, to-do list, write-back through encrypted GitHub Issues, Web Push, daily closing
  prices with a drawn chart). ES modules, no build step, the same strict CSP; `demo-*.json` is fictional (`make_demo.py`).
  It reuses the v1 keys in localStorage (`pfm.token`, `pfm.setup`), so the existing home-screen icon needs no new setup.
- `v1/` keeps version 1 as a fallback (own service-worker cache `pfm-v1-…`). `next/` is the preview of version 2.1.0 (six tabs: the five
  above plus 顧問 "advisor"), with its own service-worker cache `pfm-next-…`.
- `widget/pfm-widget.js` is a Scriptable home-screen widget. It contains no keys: the GitHub token and the widget
  key are pasted once and kept in the iPhone Keychain; the data file is AES-256-GCM, decrypted in plain JavaScript.
- `tools/shots2.py` screenshots every v2 tab and the main sheets at iPhone size in light and dark mode; `tools/shots.py` does v1 at `/v1/`.
- Pages is served from the `gh-pages` branch: push `main` and `main:gh-pages` together.
- The 顧問 tab: net worth, reserve, allocation, return spectrum, what-if calculator, funds-needed estimate, settings; reference calculations only, not investment advice. `next/` replaces the root only after it is approved.
  `next/data/*.json` are public reference data (capital market assumptions, candidate ETF pool, benchmarks and fees) and
  contain no personal data. Checks: `tools/check_public_data.py` (public data) and `tools/test_advisor_calc.mjs` (calculation tests).

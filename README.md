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

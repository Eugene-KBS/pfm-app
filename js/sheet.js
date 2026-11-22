/* Bottom sheet: slides up over the page instead of navigating away.
   Ways out (2.0.1 — several, because iOS 26 standalone can push the top of fixed layers under the status bar):
   1. the header button (always at least ~64pt below the top edge, see --sheet-top in app.css)
   2. a round × button pinned to the sheet's top-right corner
   3. pull down anywhere — on the handle/header, or on the content when it is scrolled to the top
   4. swipe right from the left edge (like iOS "back")
   5. tap the dimmed strip above the sheet
   6. a 關閉 button at the end of every sheet (and Escape on a keyboard) */
import { el } from './util.js';

const stack = [];
const DISMISS = 90;

export function openSheet({ title, body, right, onRight, left = '關閉', onClose }) {
  const scrim = el('div', { class: 'scrim' });
  const bodyEl = el('div', { class: 'body' });
  const rightBtn = right ? el('button', { class: 'r', onclick: () => onRight && onRight(api) }, right) : el('span', { style: { minWidth: '52px' } });
  const head = el('header', {}, el('button', { class: 'l', onclick: () => api.close() }, left), el('h3', {}, title || ''), rightBtn);
  const grab = el('div', { class: 'grab' }, el('i'));
  const x = el('button', { class: 'sheet-x', 'aria-label': '關閉', onclick: () => api.close() }, '×');
  const foot = el('button', { class: 'btn gray sheet-foot', onclick: () => api.close() }, '關閉');
  const sheet = el('div', { class: 'sheet' + (right ? ' has-r' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '' }, grab, head, x, bodyEl);
  let closed = false;
  const api = {
    el: sheet, body: bodyEl,
    set(nodes) { bodyEl.replaceChildren(...[].concat(nodes).filter(Boolean), foot); },
    setTitle(t) { head.querySelector('h3').textContent = t; },
    close() {
      if (closed) return;
      closed = true;
      sheet.classList.remove('on'); scrim.classList.remove('on');
      sheet.style.transform = '';
      const i = stack.indexOf(api); if (i >= 0) stack.splice(i, 1);
      setTimeout(() => { sheet.remove(); scrim.remove(); }, 320);
      if (!stack.length) document.body.style.overflow = '';
      if (onClose) onClose();
    },
  };
  api.set(typeof body === 'function' ? body(api) : body);
  scrim.addEventListener('click', () => api.close());

  /* ---- drag to dismiss: vertical (down) from handle/header/top-of-content, horizontal (right) from the left edge */
  let g = null; // {x0, y0, axis: 'y'|'x'|null, d}
  const follow = (d, axis) => {
    sheet.style.transition = 'none';
    sheet.style.transform = axis === 'x' ? `translateX(${d}px)` : `translateY(${d}px)`;
    scrim.style.opacity = String(Math.max(0, 1 - d / 400));
  };
  const release = () => {
    if (!g) return;
    const { d, axis } = g; g = null;
    sheet.style.transition = ''; scrim.style.opacity = '';
    if (axis && d > DISMISS) { api.close(); return; }
    sheet.style.transform = '';
  };
  const begin = (cx, cy, from) => { g = { x0: cx, y0: cy, axis: null, d: 0, from, edge: cx < 28 }; };
  const track = (cx, cy, e) => {
    if (!g) return;
    const dx = cx - g.x0, dy = cy - g.y0;
    if (!g.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (g.edge && dx > 0 && Math.abs(dx) > Math.abs(dy)) g.axis = 'x';
      else if (dy > 0 && Math.abs(dy) > Math.abs(dx) && (g.from === 'head' || bodyEl.scrollTop <= 0)) g.axis = 'y';
      else { g = null; return; } // normal scroll / chart drag: leave it alone
    }
    g.d = Math.max(0, g.axis === 'x' ? dx : dy);
    if (e && e.cancelable) e.preventDefault();
    follow(g.d, g.axis);
  };
  // handle + header: pointer events (touch-action: none in CSS)
  for (const h of [grab, head]) {
    h.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) return; begin(e.clientX, e.clientY, 'head'); h.setPointerCapture && h.setPointerCapture(e.pointerId); });
    h.addEventListener('pointermove', (e) => track(e.clientX, e.clientY));
    h.addEventListener('pointerup', release);
    h.addEventListener('pointercancel', release);
  }
  // content: touch events so the list can still scroll normally; we only take over when pulled down at the top or swiped from the left edge
  bodyEl.addEventListener('touchstart', (e) => { if (e.touches.length === 1) begin(e.touches[0].clientX, e.touches[0].clientY, 'body'); else g = null; }, { passive: true });
  bodyEl.addEventListener('touchmove', (e) => { if (g && e.touches.length === 1) track(e.touches[0].clientX, e.touches[0].clientY, e); }, { passive: false });
  bodyEl.addEventListener('touchend', release);
  bodyEl.addEventListener('touchcancel', release);

  document.body.append(scrim, sheet);
  document.body.style.overflow = 'hidden';
  stack.push(api);
  requestAnimationFrame(() => requestAnimationFrame(() => { scrim.classList.add('on'); sheet.classList.add('on'); }));
  return api;
}

export function closeAllSheets() { [...stack].reverse().forEach((s) => s.close()); }
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && stack.length) stack[stack.length - 1].close(); });

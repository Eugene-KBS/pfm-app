/* Bottom sheet: slides up over the page instead of navigating away; drag the handle down to close. */
import { el } from './util.js';

const stack = [];
export function openSheet({ title, body, right, onRight, left = '關閉', onClose }) {
  const scrim = el('div', { class: 'scrim' });
  const bodyEl = el('div', { class: 'body' });
  const rightBtn = right ? el('button', { class: 'r', onclick: () => onRight && onRight(api) }, right) : el('span', { style: { minWidth: '52px' } });
  const head = el('header', {}, el('button', { class: 'l', onclick: () => api.close() }, left), el('h3', {}, title || ''), rightBtn);
  const grab = el('div', { class: 'grab' }, el('i'));
  const sheet = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '' }, grab, head, bodyEl);
  const api = {
    el: sheet, body: bodyEl,
    set(nodes) { bodyEl.replaceChildren(...[].concat(nodes).filter(Boolean)); },
    setTitle(t) { head.querySelector('h3').textContent = t; },
    close() {
      sheet.classList.remove('on'); scrim.classList.remove('on');
      const i = stack.indexOf(api); if (i >= 0) stack.splice(i, 1);
      setTimeout(() => { sheet.remove(); scrim.remove(); }, 320);
      if (!stack.length) document.body.style.overflow = '';
      if (onClose) onClose();
    },
  };
  api.set(typeof body === 'function' ? body(api) : body);
  scrim.addEventListener('click', () => api.close());
  // drag down to dismiss (from the handle or the header)
  let y0 = null, dy = 0;
  const start = (e) => { y0 = e.clientY; dy = 0; sheet.style.transition = 'none'; e.target.setPointerCapture && e.target.setPointerCapture(e.pointerId); };
  const move = (e) => { if (y0 == null) return; dy = Math.max(0, e.clientY - y0); sheet.style.transform = `translateY(${dy}px)`; };
  const end = () => {
    if (y0 == null) return;
    y0 = null; sheet.style.transition = ''; sheet.style.transform = '';
    if (dy > 90) api.close();
  };
  for (const h of [grab, head]) {
    h.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) return; start(e); });
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
  }
  document.body.append(scrim, sheet);
  document.body.style.overflow = 'hidden';
  stack.push(api);
  requestAnimationFrame(() => requestAnimationFrame(() => { scrim.classList.add('on'); sheet.classList.add('on'); }));
  return api;
}
export function closeAllSheets() { [...stack].forEach((s) => s.close()); }
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && stack.length) stack[stack.length - 1].close(); });

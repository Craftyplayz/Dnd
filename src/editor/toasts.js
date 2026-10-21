// Toasts in #toasts from 'status' events.
import { html, icon } from './ui.js';

const TTL = { info: 4000, ok: 4000, warn: 7000, error: 10000 };
const MAX = 4;

export function initToasts({ bus, dom }) {
  const box = dom.toasts;
  bus.on('status', ({ level = 'info', message } = {}) => {
    if (!message) return;
    const close = html('button', { type: 'button', class: 'bms-icon-btn', 'aria-label': 'Dismiss' }, [icon('close')]);
    const t = html('div', { class: `bms-toast card ${level}`, role: level === 'error' ? 'alert' : 'status' }, [
      html('span', { class: 'bms-dot', 'aria-hidden': 'true' }), html('span', { class: 'bms-toast-msg', text: message }), close,
    ]);
    const remove = () => t.remove();
    close.addEventListener('click', remove);
    let timer = setTimeout(remove, TTL[level] ?? 5000);
    // Keep it while the pointer is over it so long errors can be read.
    t.addEventListener('pointerenter', () => clearTimeout(timer));
    t.addEventListener('pointerleave', () => { timer = setTimeout(remove, 2500); });
    box.append(t);
    while (box.children.length > MAX) box.firstElementChild.remove();
  });
}

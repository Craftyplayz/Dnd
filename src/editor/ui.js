// Small HTML helpers shared by editor UI pieces.
export function html(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

let uid = 0;
export const nextId = prefix => `bms-${prefix}-${++uid}`;

// Seconds counter for long requests. Returns stop().
export function elapsed(onTick) {
  const t0 = Date.now();
  onTick(0);
  const t = setInterval(() => onTick(Math.floor((Date.now() - t0) / 1000)), 1000);
  return () => { clearInterval(t); return Math.round((Date.now() - t0) / 1000); };
}

// Inline SVG icons (no emoji). 16px, currentColor.
const ICONS = {
  chevronRight: 'M6 3l5 5-5 5',
  chevronLeft: 'M10 3L5 8l5 5',
  close: 'M4 4l8 8M12 4l-8 8',
  chevronDown: 'M3 6l5 5 5-5',
  chevronUp: 'M3 10l5-5 5 5',
  cursor: 'M3 2l10 5-4.5 1.5L7 13z',
  ruler: 'M2 11L11 2l3 3-9 9zM5 8l1.5 1.5M7 6l1.5 1.5M9 4l1.5 1.5',
  undo: 'M5 3L2 6l3 3M2 6h7a4 4 0 010 8H6',
  redo: 'M11 3l3 3-3 3M14 6H7a4 4 0 000 8h3',
};
export function icon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('width', '16');
  s.setAttribute('height', '16');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', 'bms-icon');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[name]);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.6');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  s.append(p);
  return s;
}

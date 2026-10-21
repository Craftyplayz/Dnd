// Draws the editor overlay (selection outlines, handles, size tag, measure line) into view.overlay.
// Everything is in feet; screen-constant sizes are divided by the current zoom.
import { h } from '../core/svg.js';
import { TYPES, findElement } from '../schema.js';
import { shapeOf, toWorld, boundsOf } from '../core/geom.js';
import { sizeTag } from './ops.js';

const ACCENT = '#e0b45a';
const DARK = '#202020';
const NS = { 'vector-effect': 'non-scaling-stroke', fill: 'none', 'pointer-events': 'none' };

const RESIZE = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
const CURSORS = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'];
function resizeCursor(hx, hy, rot) {
  const a = (Math.atan2(hy, hx) * 180) / Math.PI + rot;
  return CURSORS[((Math.round(a / 45) % 4) + 4) % 4];
}

function outline(el, doc) {
  const s = shapeOf(el);
  const draw = attrs => {
    if (s.core === 'point') return h('circle', { cx: s.pts[0][0], cy: s.pts[0][1], r: Math.max(s.r, 0.5), ...attrs }, [], doc);
    const d = 'M' + s.pts.map(p => `${p[0]} ${p[1]}`).join('L') + (s.core === 'poly' || s.closed ? 'Z' : '');
    return h('path', { d, ...attrs }, [], doc);
  };
  return [
    draw({ ...NS, stroke: DARK, 'stroke-width': 3.5, 'stroke-opacity': 0.7 }),
    draw({ ...NS, stroke: ACCENT, 'stroke-width': 1.5, 'stroke-dasharray': s.core === 'line' ? '6 4' : null }),
  ];
}

function tagText(x, y, text, z, doc, anchor = 'middle') {
  return h('text', {
    x, y, 'font-size': 12 / z, 'font-family': 'Roboto, sans-serif', 'font-weight': 500, 'text-anchor': anchor,
    fill: '#ffffff', stroke: DARK, 'stroke-width': 3.5 / z, 'stroke-linejoin': 'round', 'paint-order': 'stroke',
    'pointer-events': 'none', class: 'bms-tag',
  }, [text], doc);
}

function handlesFor(el, z, doc) {
  const kind = TYPES[el.type]?.kind;
  const out = [];
  const hs = 9 / z;
  if (kind === 'path' || kind === 'region') {
    el.params.points.forEach((p, i) => {
      const [x, y] = toWorld(el, p);
      out.push(h('circle', {
        cx: x, cy: y, r: 5 / z, fill: '#ffffff', stroke: DARK, 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke',
        'data-handle': 'point', 'data-i': i, 'pointer-events': 'all', style: 'cursor: move', class: 'bms-handle',
      }, [h('title', {}, [`Point ${i + 1} (double-click to remove)`], doc)], doc));
    });
    return out;
  }
  const w = el.size.w / 2, hh = el.size.h / 2;
  const rot = el.rotation || 0;
  if (kind === 'object') {
    const small = Math.min(el.size.w, el.size.h) * z < 40; // tiny on screen: corners only
    for (const [hx, hy] of RESIZE) {
      if (small && (!hx || !hy)) continue;
      const [x, y] = toWorld(el, [hx * w, hy * hh]);
      out.push(h('rect', {
        x: x - hs / 2, y: y - hs / 2, width: hs, height: hs, fill: '#ffffff', stroke: DARK, 'stroke-width': 1.5,
        'vector-effect': 'non-scaling-stroke', transform: `rotate(${rot} ${x} ${y})`,
        'data-handle': 'resize', 'data-hx': hx, 'data-hy': hy, 'pointer-events': 'all', class: 'bms-handle',
        style: `cursor: ${resizeCursor(hx, hy, rot)}`,
      }, [], doc));
    }
  }
  // Rotation handle above the local top edge.
  const top = toWorld(el, [0, -hh]);
  const knob = toWorld(el, [0, -hh - 26 / z]);
  out.push(h('line', { x1: top[0], y1: top[1], x2: knob[0], y2: knob[1], ...NS, stroke: ACCENT, 'stroke-width': 1.5 }, [], doc));
  out.push(h('circle', {
    cx: knob[0], cy: knob[1], r: 6 / z, fill: ACCENT, stroke: DARK, 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke',
    'data-handle': 'rotate', 'pointer-events': 'all', style: 'cursor: grab', class: 'bms-handle',
  }, [h('title', {}, ['Rotate (snaps to 15 degrees, Alt for free)'], doc)], doc));
  return out;
}

function unionBounds(els) {
  const b = els.map(boundsOf);
  return { minX: Math.min(...b.map(q => q.minX)), minY: Math.min(...b.map(q => q.minY)), maxX: Math.max(...b.map(q => q.maxX)), maxY: Math.max(...b.map(q => q.maxY)) };
}

export function selectionBounds(scene, ids) {
  const els = ids.map(id => findElement(scene, id)?.el).filter(Boolean);
  return els.length ? unionBounds(els) : null;
}

// state: { ids, showHandles, measure: {line?: {a, b, text}, pair?: {a, b, text}, pending?: id} }
export function drawOverlay(view, scene, state) {
  const g = view.overlay;
  const doc = g.ownerDocument;
  const z = view.getViewport().zoom || 1;
  g.replaceChildren();
  const els = state.ids.map(id => findElement(scene, id)?.el).filter(Boolean);
  for (const el of els) g.append(...outline(el, doc));
  if (els.length) {
    const b = unionBounds(els);
    if (els.length > 1) {
      g.append(h('rect', { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY, ...NS, stroke: '#ffffff', 'stroke-width': 1, 'stroke-dasharray': '3 3' }, [], doc));
    } else if (state.showHandles) {
      g.append(...handlesFor(els[0], z, doc));
    }
    const label = els.length === 1 ? sizeTag(els[0]) : `${els.length} elements selected`;
    g.append(tagText((b.minX + b.maxX) / 2, b.maxY + 18 / z, label, z, doc));
  }
  const m = state.measure || {};
  if (m.pending) {
    const el = findElement(scene, m.pending)?.el;
    if (el) g.append(...outline(el, doc));
  }
  const seg = m.line || m.pair;
  if (seg) {
    const [a, b] = [seg.a, seg.b];
    g.append(
      h('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, ...NS, stroke: DARK, 'stroke-width': 4, 'stroke-opacity': 0.7 }, [], doc),
      h('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, ...NS, stroke: '#ffffff', 'stroke-width': 2, 'stroke-dasharray': '8 5' }, [], doc),
      h('circle', { cx: a.x, cy: a.y, r: 4 / z, fill: '#ffffff', stroke: DARK, 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none' }, [], doc),
      h('circle', { cx: b.x, cy: b.y, r: 4 / z, fill: '#ffffff', stroke: DARK, 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none' }, [], doc),
    );
    const lines = seg.text.split('\n');
    // Stack the lines just above the midpoint so they never sit on the line itself.
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    lines.forEach((t, i) => g.append(tagText(mx, my - (10 + (lines.length - 1 - i) * 15) / z, t, z, doc)));
  }
}

// Lighting overlay (ambient tint by time of day, campfire light pools, vignette) and the grid.
import { h } from '../core/svg.js';
import { hash32 } from '../schema.js';
import { n2 } from './paint.js';
import { PALETTE as C } from './palette.js';

const AMBIENT = {
  day: { color: '#fff1d6', op: 0.07, multiply: false, vignette: 0.2, glow: 0.12, glowCore: 0.18 },
  dusk: { color: '#f2a676', op: 0.55, multiply: true, vignette: 0.32, glow: 0.3, glowCore: 0.35 },
  night: { color: '#24345a', op: 0.86, multiply: true, vignette: 0.42, glow: 0.42, glowCore: 0.5 },
};

export const BRIGHT_FT = 20, DIM_FT = 40;

export function litFires(scene) {
  return (scene.objects || []).filter(o => o.type === 'campfire' && o.params?.lit !== false).map(o => [o.position.x, o.position.y]);
}

export function renderLighting(scene, doc) {
  const W = scene.grid.widthFt, H = scene.grid.heightFt;
  const L = scene.lighting || { time: 'day' };
  const A = AMBIENT[L.time] || AMBIENT.day;
  const fires = litFires(scene);
  const P = `l${hash32(JSON.stringify([L, fires, W, H])).toString(36)}-`;
  const defs = [], kids = [];
  const stop = (offset, color, op = 1) => h('stop', { offset, 'stop-color': color, 'stop-opacity': op }, [], doc);

  defs.push(h('radialGradient', { id: `${P}vignette`, cx: 0.5, cy: 0.5, r: 0.72 }, [stop(0.55, '#000', 0), stop(1, '#000', 1)], doc));
  if (fires.length) {
    // Mask luminance: black = no darkening. Bright light to 20 ft, dim to 40 ft.
    defs.push(h('radialGradient', { id: `${P}hole` }, [stop(0, '#000'), stop(BRIGHT_FT / DIM_FT * 0.92, '#000'), stop(BRIGHT_FT / DIM_FT * 1.08, '#5a5a5a'), stop(0.85, '#b8b8b8'), stop(1, '#fff')], doc));
    defs.push(h('radialGradient', { id: `${P}glow` }, [stop(0, C.fire[2], 1), stop(0.25, C.fire[1], 0.6), stop(0.5, C.fire[1], 0.25), stop(1, C.fire[0], 0)], doc));
  }
  const ambientColor = L.ambient || A.color;
  const tint = h('rect', { x: 0, y: 0, width: W, height: H, fill: ambientColor, opacity: A.op, style: A.multiply ? 'mix-blend-mode:multiply' : null }, [], doc);
  if (fires.length && A.multiply) {
    defs.push(h('mask', { id: `${P}dark-mask`, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: W, height: H }, [
      h('rect', { x: 0, y: 0, width: W, height: H, fill: '#fff' }, [], doc),
      ...fires.map(([x, y]) => h('circle', { cx: x, cy: y, r: DIM_FT, fill: `url(#${P}hole)` }, [], doc)),
    ], doc));
    tint.setAttribute('mask', `url(#${P}dark-mask)`);
  }
  kids.push(tint);
  for (const [x, y] of fires) {
    kids.push(h('circle', { cx: x, cy: y, r: DIM_FT, fill: `url(#${P}glow)`, opacity: A.glow, style: 'mix-blend-mode:screen' }, [], doc));
    kids.push(h('circle', { cx: x, cy: y, r: 8, fill: `url(#${P}glow)`, opacity: A.glowCore, style: 'mix-blend-mode:screen' }, [], doc));
  }
  kids.push(h('rect', { x: 0, y: 0, width: W, height: H, fill: `url(#${P}vignette)`, opacity: n2(A.vignette) }, [], doc));
  return h('g', { 'data-layer': 'lighting', 'pointer-events': 'none' }, [h('defs', {}, defs, doc), ...kids], doc);
}

export function renderGrid(scene, doc) {
  const { widthFt: W, heightFt: H, cellFt = 5, color = '#000000', opacity = 0.22 } = scene.grid;
  let d = '';
  for (let x = 0; x <= W + 1e-9; x += cellFt) d += `M${x} 0V${H}`;
  for (let y = 0; y <= H + 1e-9; y += cellFt) d += `M0 ${y}H${W}`;
  return h('g', { 'data-layer': 'grid', 'pointer-events': 'none' }, [
    h('path', { d, fill: 'none', stroke: color, 'stroke-opacity': opacity, 'stroke-width': 0.08 }, [], doc),
  ], doc);
}

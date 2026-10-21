// Lighting overlay (ambient tint by time of day, campfire light pools, vignette) and the grid.
import { h } from '../core/svg.js';
import { hash32 } from '../schema.js';
import { n2 } from './paint.js';
import { PALETTE as C } from './palette.js';

// tint: multiply colour/opacity over the whole map; cool/warm: directional low-sun wash (dusk);
// glow: strength of campfire light pools (screen blend).
const AMBIENT = {
  day: { color: '#fff1d6', op: 0.07, multiply: false, vignette: 0.18, vcolor: '#000', glow: 0.3, warm: 0, cool: 0 },
  dusk: { color: '#ffc896', op: 0.42, multiply: true, vignette: 0.3, vcolor: '#2a1630', glow: 0.75, warm: 0.16, cool: 0.32 },
  night: { color: '#34477a', op: 0.84, multiply: true, vignette: 0.4, vcolor: '#05070f', glow: 0.9, warm: 0, cool: 0 },
};

export const BRIGHT_FT = 20, DIM_FT = 40;

export function litFires(scene) {
  return (scene.objects || []).filter(o => o.type === 'campfire' && o.params?.lit !== false).map(o => [o.position.x, o.position.y]);
}

export function renderLighting(scene, doc, clipId = null) {
  const W = scene.grid.widthFt, H = scene.grid.heightFt;
  const L = scene.lighting || { time: 'day' };
  const A = AMBIENT[L.time] || AMBIENT.day;
  const fires = litFires(scene);
  const P = `l${hash32(JSON.stringify([L, fires, W, H])).toString(36)}-`;
  const defs = [], kids = [];
  const clip = clipId ? `url(#${clipId})` : null;
  const stop = (offset, color, op = 1) => h('stop', { offset, 'stop-color': color, 'stop-opacity': op }, [], doc);
  const rect = attrs => h('rect', { x: 0, y: 0, width: W, height: H, ...attrs }, [], doc);
  const blend = m => `mix-blend-mode:${m}`;

  defs.push(h('radialGradient', { id: `${P}vignette`, cx: 0.5, cy: 0.5, r: 0.72 }, [stop(0.55, A.vcolor, 0), stop(1, A.vcolor, 1)], doc));
  if (fires.length) {
    // Mask luminance: black = no darkening. Bright light to 20 ft, dim to 40 ft.
    const k = BRIGHT_FT / DIM_FT;
    defs.push(h('radialGradient', { id: `${P}hole` }, [stop(0, '#000'), stop(k * 0.9, '#000'), stop(k * 1.1, '#4a4a4a'), stop(0.85, '#b0b0b0'), stop(1, '#fff')], doc));
    defs.push(h('radialGradient', { id: `${P}glow` }, [stop(0, C.fire[2], 1), stop(0.12, C.fire[2], 0.75), stop(k, C.fire[1], 0.42), stop(0.75, C.fire[1], 0.14), stop(1, C.fire[0], 0)], doc));
  }
  const tint = rect({ fill: L.ambient || A.color, opacity: A.op, style: A.multiply ? blend('multiply') : null });
  if (fires.length && A.multiply) {
    defs.push(h('mask', { id: `${P}dark-mask`, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: W, height: H }, [
      rect({ fill: '#fff' }),
      ...fires.map(([x, y]) => h('circle', { cx: x, cy: y, r: DIM_FT, fill: `url(#${P}hole)` }, [], doc)),
    ], doc));
    tint.setAttribute('mask', `url(#${P}dark-mask)`);
  }
  kids.push(tint);
  if (A.warm || A.cool) {
    // Low sun: warm wash on the side the light comes from, cool shade on the far side.
    const az = ((L.azimuth ?? 315) * Math.PI) / 180, dx = Math.sin(az), dy = -Math.cos(az);
    const cx = W / 2, cy = H / 2, R = Math.hypot(W, H) / 2;
    const g = (id, from, to) => h('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: n2(cx - dx * R), y1: n2(cy - dy * R), x2: n2(cx + dx * R), y2: n2(cy + dy * R) }, [from, to], doc);
    defs.push(g(`${P}cool`, stop(0, '#6f7fb8', 1), stop(1, '#6f7fb8', 0)));
    defs.push(g(`${P}warm`, stop(0, '#ffb060', 0), stop(1, '#ffb060', 1)));
    kids.push(rect({ fill: `url(#${P}cool)`, opacity: A.cool, style: blend('multiply'), mask: fires.length && A.multiply ? `url(#${P}dark-mask)` : null }));
    kids.push(rect({ fill: `url(#${P}warm)`, opacity: A.warm, style: blend('screen') }));
  }
  for (const [x, y] of fires) {
    kids.push(h('circle', { cx: x, cy: y, r: DIM_FT, fill: `url(#${P}glow)`, opacity: A.glow, style: blend('screen'), 'clip-path': clip }, [], doc));
    kids.push(h('circle', { cx: x, cy: y, r: BRIGHT_FT, fill: `url(#${P}glow)`, opacity: n2(A.glow * 0.45), style: blend('soft-light'), 'clip-path': clip }, [], doc));
  }
  kids.push(rect({ fill: `url(#${P}vignette)`, opacity: n2(A.vignette) }));
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

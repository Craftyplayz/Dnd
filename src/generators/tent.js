// Camp tent from above. a-frame: ridge along local x, door at +x. round: conical bell tent.
// pavilion: hipped striped roof with a scalloped valance. params.color = canvas colour.
import { env, polyD, fmt, clamp, ramp, shade, mix, tonesFrom, lineD, circleD, ellipseD, buckets, rectD } from './_paint.js';

const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

export default {
  type: 'tent',
  render(el, rng, ctx) {
    const E = env(el, ctx);
    const p = el.params || {};
    const variant = ['a-frame', 'round', 'pavilion'].includes(p.variant) ? p.variant : 'a-frame';
    const color = /^#[0-9a-fA-F]{6}$/.test(p.color || '') ? p.color : '#8a7a5a';
    const T = tonesFrom(color);
    const kids = variant === 'round' ? round(E, rng, el, T) : variant === 'pavilion' ? pavilion(E, rng, el, T) : aframe(E, rng, el, T);
    return E.g({ class: `tent tent-${variant}` }, kids);
  },
};

function ropes(E, pairs) {
  const rope = mix('#7a6a50', '#000000', 0.1);
  let d = '', stakes = '';
  for (const [a, b] of pairs) { d += lineD(a[0], a[1], b[0], b[1]); stakes += circleD(b[0], b[1], 0.14); }
  return [E.shadowEl(d, 0.6, { stroke: 0.08, max: 0.5 }), E.path(d, { stroke: rope, 'stroke-width': 0.08, fill: 'none' }), E.path(stakes, { fill: '#5a4630', stroke: '#2a2016', 'stroke-width': 0.05 })];
}

function aframe(E, rng, el, T) {
  const W = el.size.w, H = el.size.h;
  const hx = W / 2 * 0.86, hy = H / 2 * 0.8, sag = hy * 0.06;
  const kids = [];
  const body = polyD([[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]], true);
  kids.push(...ropes(E, [[[-hx, -hy], [-W / 2 + 0.1, -H / 2 + 0.1]], [[hx, -hy], [W / 2 - 0.1, -H / 2 + 0.1]], [[-hx, hy], [-W / 2 + 0.1, H / 2 - 0.1]], [[hx, hy], [W / 2 - 0.1, H / 2 - 0.1]], [[-hx, 0], [-W / 2 + 0.05, 0]]]));
  kids.push(E.shadowEl(body, clamp(Math.min(W, H) * 0.35, 0.8, 4)));
  for (const s of [-1, 1]) {
    const lit = E.lit(0, s);
    const eave = `M${fmt(-hx)} 0L${fmt(hx)} 0L${fmt(hx)} ${fmt(s * hy)}Q0 ${fmt(s * (hy - sag * 2))} ${fmt(-hx)} ${fmt(s * hy)}Z`;
    kids.push(E.path(eave, { fill: ramp(T, 0.5 + 0.32 * lit + rng.range(-0.03, 0.03)), stroke: shade(T[0], -0.3), 'stroke-width': 0.08, 'stroke-linejoin': 'round' }));
    // canvas seams and folds down the slope
    let d = '';
    const n = Math.max(2, Math.round(W / 2));
    for (let i = 1; i < n; i++) { const x = -hx + (2 * hx * i) / n; d += lineD(x, s * 0.1, x + rng.range(-0.1, 0.1), s * (hy - sag)); }
    kids.push(E.path(d, { stroke: ramp(T, 0.25 + 0.3 * lit), 'stroke-width': 0.06, fill: 'none', opacity: 0.6 }));
    // canvas falls away from the ridge: light near the ridge, darker toward the eave
    const g = E.def(`g-tent-slope-${s > 0 ? 's' : 'n'}`, () => E.h('linearGradient', { x1: 0, x2: 0, y1: s > 0 ? 0 : 1, y2: s > 0 ? 1 : 0 }, [
      E.h('stop', { offset: 0, 'stop-color': '#ffffff', 'stop-opacity': 0.16 }),
      E.h('stop', { offset: 0.45, 'stop-color': '#ffffff', 'stop-opacity': 0 }),
      E.h('stop', { offset: 1, 'stop-color': '#000000', 'stop-opacity': 0.3 }),
    ]));
    if (g) kids.push(E.path(eave, { fill: g }));
    // sagging canvas between the poles: soft catenary folds
    for (const k of [0.45, 0.75]) kids.push(E.path(`M${fmt(-hx * 0.95)} ${fmt(s * hy * k)}Q0 ${fmt(s * (hy * k + sag * 3))} ${fmt(hx * 0.95)} ${fmt(s * hy * k)}`, { fill: 'none', stroke: lit > 0 ? T[2] : T[0], 'stroke-width': fmt(hy * 0.08), opacity: 0.3 }));
  }
  // ridge pole and door flap at +x
  kids.push(E.path(lineD(-hx - 0.15, 0, hx + 0.15, 0), { stroke: shade(T[0], -0.4), 'stroke-width': 0.14 }));
  kids.push(E.path(lineD(-hx, 0, hx, 0), { stroke: shade(T[2], 0.2), 'stroke-width': 0.12, transform: `translate(0 ${fmt(E.ly < 0 ? -0.13 : 0.13)})`, opacity: 0.75 }));
  kids.push(E.path(polyD([[hx, 0], [hx - hy * 0.1, hy * 0.55], [hx, hy * 0.6]], true), { fill: '#1e1a14', opacity: 0.85 }));
  kids.push(E.path(polyD([[hx, 0], [hx, hy * 0.6], [hx + Math.min(W / 2 - hx, 0.5), hy * 0.45]], true), { fill: T[2], stroke: T[0], 'stroke-width': 0.04 }));
  return kids;
}

function round(E, rng, el, T) {
  const rx = el.size.w / 2 * 0.86, ry = el.size.h / 2 * 0.86;
  const kids = [];
  const n = 8, pr = [];
  for (let i = 0; i < n; i++) { const a = (i * 2 * Math.PI) / n + 0.2; pr.push([[Math.cos(a) * rx, Math.sin(a) * ry], [Math.cos(a) * el.size.w / 2 * 0.98, Math.sin(a) * el.size.h / 2 * 0.98]]); }
  kids.push(...ropes(E, pr));
  kids.push(E.shadowEl(ellipseD(0, 0, rx, ry), clamp(Math.min(rx, ry) * 0.5, 1, 5)));
  const N = 12, ph = rng.next() * Math.PI;
  const P = a => [Math.cos(a) * rx, Math.sin(a) * ry];
  for (let i = 0; i < N; i++) {
    const a0 = ph + (i * 2 * Math.PI) / N, a1 = ph + ((i + 1) * 2 * Math.PI) / N, am = (a0 + a1) / 2;
    const lit = E.lit(Math.cos(am), Math.sin(am));
    const seg = [];
    for (let k = 0; k <= 4; k++) seg.push(P(a0 + ((a1 - a0) * k) / 4));
    // panels sag slightly between seams
    const mid = P(am).map(v => v * 0.96);
    kids.push(E.path(`M0 0L${fmt(seg[0][0])} ${fmt(seg[0][1])}Q${fmt(mid[0] * 1.04)} ${fmt(mid[1] * 1.04)} ${fmt(seg[4][0])} ${fmt(seg[4][1])}Z`, { fill: ramp(T, 0.5 + 0.34 * lit + (i % 2 ? 0.03 : -0.03)) }));
  }
  let seams = '';
  for (let i = 0; i < N; i++) { const a = ph + (i * 2 * Math.PI) / N, q = P(a); seams += lineD(0, 0, q[0], q[1]); }
  kids.push(E.path(seams, { stroke: shade(T[0], -0.2), 'stroke-width': 0.07, opacity: 0.7, fill: 'none' }));
  kids.push(E.path(ellipseD(0, 0, rx, ry), { fill: 'none', stroke: shade(T[0], -0.35), 'stroke-width': 0.1 }));
  kids.push(E.path(ellipseD(0, 0, rx * 0.9, ry * 0.9), { fill: 'none', stroke: T[0], 'stroke-width': 0.12, opacity: 0.35 }));
  // door flap on +x, pole cap
  kids.push(E.path(polyD([[rx * 0.55, 0], [rx, -ry * 0.12], [rx * 0.98, ry * 0.12]], true), { fill: '#1e1a14', opacity: 0.8 }));
  kids.push(E.path(circleD(0, 0, Math.min(rx, ry) * 0.08), { fill: shade(T[0], -0.3) }));
  kids.push(E.path(circleD(E.lx * 0.05, E.ly * 0.05, Math.min(rx, ry) * 0.04), { fill: '#9a8a6a' }));
  return kids;
}

function pavilion(E, rng, el, T) {
  const W = el.size.w, H = el.size.h, val = clamp(Math.min(W, H) * 0.05, 0.3, 1);
  const hx = W / 2 - val - 0.2, hy = H / 2 - val - 0.2;
  const kids = [];
  const corners = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]];
  const pr = [];
  for (const [x, y] of corners) pr.push([[x, y], [Math.sign(x) * (W / 2 - 0.1), Math.sign(y) * (H / 2 - 0.1)]]);
  kids.push(...ropes(E, pr));
  kids.push(E.shadowEl(polyD(corners, true), clamp(Math.min(W, H) * 0.3, 1, 5), { wide: true }));
  // valance: scallops along the eave
  const stripe = mix(T[2], '#f2ead6', 0.75);
  let sc = '';
  const edges = [[corners[0], corners[1]], [corners[1], corners[2]], [corners[2], corners[3]], [corners[3], corners[0]]];
  for (const [a, b] of edges) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(2, Math.round(L / (val * 2.2)));
    const nx = (b[1] - a[1]) / L, ny = -(b[0] - a[0]) / L;
    for (let i = 0; i < n; i++) {
      const p0 = lerp2(a, b, i / n), p1 = lerp2(a, b, (i + 1) / n), m = lerp2(p0, p1, 0.5);
      sc += `M${fmt(p0[0])} ${fmt(p0[1])}Q${fmt(m[0] + nx * val * 1.6)} ${fmt(m[1] + ny * val * 1.6)} ${fmt(p1[0])} ${fmt(p1[1])}Z`;
    }
  }
  kids.push(E.path(sc, { fill: T[1], stroke: shade(T[0], -0.3), 'stroke-width': 0.05 }));
  // hip roof faces: ridge along the long axis
  const long = hx >= hy, d = Math.min(hx, hy);
  const r0 = long ? [-hx + d, 0] : [0, -hy + d], r1 = long ? [hx - d, 0] : [0, hy - d];
  const faces = long
    ? [[corners[0], corners[1], r1, r0, [0, -1]], [corners[1], corners[2], r1, r1, [1, 0]], [corners[2], corners[3], r0, r1, [0, 1]], [corners[3], corners[0], r0, r0, [-1, 0]]]
    : [[corners[0], corners[1], r0, r0, [0, -1]], [corners[1], corners[2], r1, r0, [1, 0]], [corners[2], corners[3], r1, r1, [0, 1]], [corners[3], corners[0], r0, r1, [-1, 0]]];
  for (const [e0, e1, q1, q0, n] of faces) {
    const lit = E.lit(n[0], n[1]);
    const L = Math.hypot(e1[0] - e0[0], e1[1] - e0[1]), k = Math.max(2, Math.round(L / 2.2));
    const fa = buckets();
    for (let j = 0; j < k; j++) {
      const q = [lerp2(e0, e1, j / k), lerp2(e0, e1, (j + 1) / k), lerp2(q0, q1, (j + 1) / k), lerp2(q0, q1, j / k)];
      fa.add(j % 2 ? stripe : T[1], polyD(q, true));
    }
    kids.push(...fa.nodes(E));
    kids.push(E.path(polyD([e0, e1, q1, q0], true), { fill: lit > 0 ? '#ffffff' : '#000000', opacity: fmt(Math.abs(lit) * (lit > 0 ? 0.14 : 0.26)), stroke: shade(T[0], -0.3), 'stroke-width': 0.06, 'stroke-opacity': 1 }));
  }
  kids.push(E.path(polyD([r0, r1]), { stroke: shade(T[0], -0.35), 'stroke-width': 0.15 }));
  // pennants on the ridge ends
  for (const [x, y] of [r0, r1]) {
    kids.push(E.path(circleD(x, y, 0.18), { fill: '#c9a640', stroke: '#6a5420', 'stroke-width': 0.04 }));
    kids.push(E.path(polyD([[x, y], [x + 1.4, y + 0.25], [x, y + 0.5]], true), { fill: shade(T[1], 0.05), stroke: T[0], 'stroke-width': 0.04 }));
  }
  return kids;
}

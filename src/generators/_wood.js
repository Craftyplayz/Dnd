// Painted wood helpers: plank fields, spoked wheels, crate and barrel tops.
// Shared by wagon, crate, barrel, building (floors, doors), bridge and fence.
import { polyD, fmt, ramp, shade, jit, mix, clamp, buckets, clipPoly, circleD, lineD, TONES, rectD } from './_paint.js';

// Boards filling the rect [x0,x1]x[y0,y1] (optionally clipped to a convex polygon).
// axis 'x' = boards run along x. Returns nodes (background, boards, grain, nails).
export function paintPlanks(E, rng, o) {
  const { x0, y0, x1, y1, axis = 'x', board = 0.8, len = [4, 9], tones = E.pal('wood'), clip = null, gap = 0.06, missing = 0, nails = true, bg = true } = o;
  const along = axis === 'x' ? [x0, x1] : [y0, y1], across = axis === 'x' ? [y0, y1] : [x0, x1];
  const P = (u, v) => (axis === 'x' ? [u, v] : [v, u]);
  const area = clip || [P(along[0], across[0]), P(along[1], across[0]), P(along[1], across[1]), P(along[0], across[1])];
  const nodes = [];
  const dark = shade(tones[0], -0.35);
  if (bg) nodes.push(E.path(polyD(area, true), { fill: dark }));
  const V = [0, 1, 2, 3].map(i => jit(rng, ramp(tones, 0.32 + i * 0.13), 0.05));
  const fills = buckets(), grain = [], nailD = [], hiD = [];
  const span = across[1] - across[0], rows = Math.max(1, Math.round(span / board)), bw = span / rows;
  const lit = axis === 'x' ? E.ly : E.lx;
  for (let r = 0; r < rows; r++) {
    const v0 = across[0] + r * bw + gap / 2, v1 = v0 + bw - gap;
    for (let u = along[0] - rng.range(0, len[1] * 0.8); u < along[1];) {
      const u1 = u + rng.range(len[0], len[1]), a = Math.max(u, along[0]), b = Math.min(u1, along[1]);
      u = u1;
      if (b - a < 0.15 || rng.chance(missing)) continue;
      let q = [P(a + gap / 2, v0), P(b - gap / 2, v0), P(b - gap / 2, v1), P(a + gap / 2, v1)];
      if (clip) { q = clipPoly(q, clip); if (q.length < 3) continue; }
      fills.add(V[rng.int(0, 3)], polyD(q, true));
      if (!clip || q.length === 4) {
        const vl = lit < 0 ? v0 + 0.03 : v1 - 0.03;
        hiD.push(polyD([P(a + gap, vl), P(b - gap, vl)]));
      }
      for (let k = rng.int(0, 2); k > 0; k--) {
        const vv = rng.range(v0 + 0.12, v1 - 0.12), ua = rng.range(a, (a + b) / 2), ub = rng.range((a + b) / 2, b);
        const g = clip ? clipSegLine(P(ua, vv), P(ub, vv), clip) : [P(ua, vv), P(ub, vv)];
        if (g) grain.push(polyD(g));
      }
      if (nails && b - a > 1) for (const uu of [a + 0.25, b - 0.25]) {
        const p = P(uu, (v0 + v1) / 2);
        if (!clip || inside(p, clip)) nailD.push(circleD(p[0], p[1], 0.05));
      }
    }
  }
  nodes.push(...fills.nodes(E));
  if (hiD.length) nodes.push(E.path(hiD.join(''), { fill: 'none', stroke: tones[2], 'stroke-width': 0.05, opacity: 0.5 }));
  if (grain.length) nodes.push(E.path(grain.join(''), { fill: 'none', stroke: tones[0], 'stroke-width': 0.04, opacity: 0.45 }));
  if (nailD.length) nodes.push(E.path(nailD.join(''), { fill: TONES.metal[0], opacity: 0.8 }));
  return nodes;
}

function inside(p, poly) {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}
function clipSegLine(a, b, clip) {
  const q = clipPoly([a, b, [b[0] + 1e-4, b[1] + 1e-4], [a[0] + 1e-4, a[1] + 1e-4]], clip);
  if (q.length < 2) return null;
  return [q[0], q[1]];
}

// Spoked wheel seen flat (lying on the ground or an overturned wagon). r = radius.
export function wheelFlat(E, rng, x, y, r, { broken = false } = {}) {
  const wood = E.pal('wood'), wd = E.pal('woodDark'), metal = TONES.metal;
  const spokes = r > 1 ? 10 : 8, nodes = [];
  const a0 = rng.next() * Math.PI;
  nodes.push(E.path(circleD(x, y, r), { fill: 'none', stroke: metal[1], 'stroke-width': fmt(r * 0.11) }));
  nodes.push(E.path(circleD(x, y, r * 0.86), { fill: 'none', stroke: wood[0], 'stroke-width': fmt(r * 0.16) }));
  nodes.push(E.path(circleD(x + E.lx * r * 0.02, y + E.ly * r * 0.02, r * 0.86), { fill: 'none', stroke: wood[2], 'stroke-width': fmt(r * 0.05), opacity: 0.6 }));
  let d = '';
  for (let i = 0; i < spokes; i++) {
    if (broken && i % 4 === 1) continue;
    const a = a0 + (i * 2 * Math.PI) / spokes;
    d += lineD(x + Math.cos(a) * r * 0.2, y + Math.sin(a) * r * 0.2, x + Math.cos(a) * r * 0.8, y + Math.sin(a) * r * 0.8);
  }
  nodes.push(E.path(d, { fill: 'none', stroke: wood[1], 'stroke-width': fmt(r * 0.09), 'stroke-linecap': 'round' }));
  nodes.push(E.path(circleD(x, y, r * 0.22), { fill: wd[1], stroke: metal[0], 'stroke-width': fmt(r * 0.05) }));
  nodes.push(E.path(circleD(x - E.lx * r * 0.03, y - E.ly * r * 0.03, r * 0.08), { fill: metal[1] }));
  return nodes;
}

// Wheel standing upright, seen from above: a thin tyre-shod slab.
export function wheelEdge(E, x, y, diam, thick) {
  const wood = E.pal('wood'), metal = TONES.metal;
  return [
    E.path(rectD(x, y, diam, thick), { fill: metal[1], stroke: metal[0], 'stroke-width': 0.05 }),
    E.path(rectD(x, y, diam * 0.82, thick * 0.55), { fill: wood[0] }),
    E.path(rectD(x, y - thick * 0.15, diam * 0.7, thick * 0.18), { fill: metal[2], opacity: 0.55 }),
  ];
}

// Crate top: frame with boards, corner braces. Draws within [-w/2,w/2]x[-hh/2,hh/2] at (cx, cy) rotated ang.
export function crateTop(E, rng, cx, cy, w, hh, angDeg = 0, { broken = false } = {}) {
  const wood = E.pal('wood'), wd = E.pal('woodDark');
  const base = jit(rng, wood[1], 0.06), T = [mix(wood[0], base, 0.3), base, jit(rng, wood[2], 0.05)];
  const m = Math.min(w, hh), fw = clamp(m * 0.13, 0.12, 0.45);
  const kids = [];
  kids.push(E.path(rectD(0, 0, w, hh), { fill: wd[0], stroke: shade(wd[0], -0.3), 'stroke-width': 0.08 }));
  // boards across the inner field
  const inner = { x0: -w / 2 + fw, y0: -hh / 2 + fw, x1: w / 2 - fw, y1: hh / 2 - fw };
  const nb = clamp(Math.round((inner.y1 - inner.y0) / 0.55), 2, 7);
  const planks = paintPlanks(E, rng, { ...inner, axis: 'x', board: (inner.y1 - inner.y0) / nb, len: [w * 2, w * 2], tones: T, nails: false, missing: broken ? 0.45 : 0, gap: 0.05 });
  if (broken) {
    // dark interior with straw where boards are gone
    kids.push(E.path(rectD(0, 0, w - fw * 2, hh - fw * 2), { fill: wd[0] }));
    let d = '';
    for (let i = 0; i < 14; i++) {
      const x = rng.range(inner.x0, inner.x1), y = rng.range(inner.y0, inner.y1), a = rng.next() * Math.PI;
      d += lineD(x, y, clamp(x + Math.cos(a) * 0.4, inner.x0, inner.x1), clamp(y + Math.sin(a) * 0.4, inner.y0, inner.y1));
    }
    kids.push(E.path(d, { stroke: TONES.hay[1], 'stroke-width': 0.05, opacity: 0.8, fill: 'none' }));
    planks.shift();
  }
  kids.push(...planks);
  // frame: four edge boards, lit edge brighter
  const fr = [
    [0, -hh / 2 + fw / 2, w, fw, 0, -1], [0, hh / 2 - fw / 2, w, fw, 0, 1],
    [-w / 2 + fw / 2, 0, fw, hh - fw * 2, 1, 0], [w / 2 - fw / 2, 0, fw, hh - fw * 2, -1, 0],
  ];
  for (const [x, y, fwid, fh, nx, ny] of fr) {
    const lit = E.lit(nx, ny);
    kids.push(E.path(rectD(x, y, fwid - 0.04, fh - 0.04), { fill: ramp(T, 0.45 + lit * 0.3) }));
  }
  // diagonal brace
  if (!broken || rng.chance(0.5)) {
    const s = rng.chance(0.5) ? 1 : -1;
    kids.push(E.path(polyD([[-w / 2 + fw, s * (-hh / 2 + fw)], [w / 2 - fw, s * (hh / 2 - fw)]]), { stroke: ramp(T, 0.62), 'stroke-width': fmt(fw * 0.9), 'stroke-linecap': 'butt', fill: 'none' }));
  }
  // corner nails
  let n = '';
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) n += circleD(sx * (w / 2 - fw / 2), sy * (hh / 2 - fw / 2), 0.05);
  kids.push(E.path(n, { fill: TONES.metal[0] }));
  return E.g({ transform: `translate(${fmt(cx)} ${fmt(cy)}) rotate(${fmt(angDeg)})` }, kids);
}

// Barrel seen from above: stave ring, hoops and lid.
export function barrelTop(E, rng, cx, cy, r) {
  const wood = E.pal('wood'), metal = TONES.metal, kids = [];
  const T = [jit(rng, wood[0], 0.05), jit(rng, wood[1], 0.06), jit(rng, wood[2], 0.05)];
  kids.push(E.path(circleD(cx, cy, r), { fill: T[0], stroke: shade(T[0], -0.35), 'stroke-width': fmt(r * 0.05) }));
  // staves visible as a ring of segments
  let st = '';
  const n = Math.max(12, Math.round(r * 9));
  for (let i = 0; i < n; i++) {
    const a = (i * 2 * Math.PI) / n;
    st += lineD(cx + Math.cos(a) * r * 0.78, cy + Math.sin(a) * r * 0.78, cx + Math.cos(a) * r * 0.98, cy + Math.sin(a) * r * 0.98);
  }
  kids.push(E.path(circleD(cx + E.lx * r * 0.04, cy + E.ly * r * 0.04, r * 0.88), { fill: 'none', stroke: T[1], 'stroke-width': fmt(r * 0.18) }));
  kids.push(E.path(st, { stroke: shade(T[0], -0.3), 'stroke-width': fmt(r * 0.025), fill: 'none' }));
  kids.push(E.path(circleD(cx, cy, r * 0.94), { fill: 'none', stroke: metal[1], 'stroke-width': fmt(r * 0.07) }));
  kids.push(E.path(circleD(cx + E.lx * r * 0.02, cy + E.ly * r * 0.02, r * 0.94), { fill: 'none', stroke: metal[2], 'stroke-width': fmt(r * 0.025), opacity: 0.6, 'stroke-dasharray': `${fmt(r * 1.2)} ${fmt(r * 4.6)}`, transform: `rotate(${fmt((Math.atan2(E.ly, E.lx) * 180) / Math.PI - 15)} ${fmt(cx)} ${fmt(cy)})` }));
  // lid boards
  const lr = r * 0.74, lid = [];
  for (let i = 0; i < 24; i++) { const a = (i * 2 * Math.PI) / 24; lid.push([cx + Math.cos(a) * lr, cy + Math.sin(a) * lr]); }
  const ang = rng.next() * 180;
  const g = E.g({ transform: `rotate(${fmt(ang)} ${fmt(cx)} ${fmt(cy)})` }, paintPlanks(E, rng, { x0: cx - lr, y0: cy - lr, x1: cx + lr, y1: cy + lr, axis: 'x', board: lr * 2 / 4, len: [lr * 3, lr * 3], tones: [T[0], T[1], T[2]], clip: lid, nails: false }));
  kids.push(g);
  kids.push(E.path(circleD(cx, cy, lr), { fill: 'none', stroke: shade(T[0], -0.3), 'stroke-width': fmt(r * 0.05) }));
  kids.push(E.path(circleD(cx + rng.range(-0.3, 0.3) * lr, cy + rng.range(-0.3, 0.3) * lr, r * 0.07), { fill: shade(T[0], -0.4) }));
  return kids;
}

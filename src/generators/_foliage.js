// Layered leaf-clump painter shared by tree (oak, birch) and bush.
// clumps: [{x, y, r}] local ft. Each clump has a scalloped outline and four tones stacked
// toward the light; leaf dabs add texture. Outer clumps are drawn first.
import { smoothD, ramp, shade, buckets, lensD, clamp, fmt, circleD } from './_paint.js';

// Cauliflower outline: alternating outer and inner radii, smoothed.
export function lobedPts(rng, cx, cy, r, lobes = 8, depth = 0.13) {
  const pts = [], ph = rng.next() * Math.PI * 2, n = lobes * 2;
  for (let i = 0; i < n; i++) {
    const a = ph + ((i + rng.range(-0.25, 0.25)) * 2 * Math.PI) / n;
    const k = i % 2 ? 1 - depth * rng.range(0.6, 1.4) : rng.range(0.95, 1.04);
    pts.push([cx + Math.cos(a) * r * k, cy + Math.sin(a) * r * k]);
  }
  return pts;
}

export function paintFoliage(E, rng, { clumps, tones, shadowH = 2, dabs = 30, dabSize = 1, lobes = 8, depth = 0.13, under = [], rimFt = 0.25, flowers = null, contrast = 1 }) {
  const shapes = clumps.map(c => ({ ...c, pts: lobedPts(rng, c.x, c.y, c.r, lobes, depth) }));
  const allD = shapes.map(s => smoothD(s.pts, true)).join('');
  const rim = shade(tones[0], -0.3);
  const kids = [E.shadowEl(allD, shadowH, { wide: true }), ...under];
  // Rim and base in one path: interior stroke parts are covered by the clump layers drawn next.
  kids.push(E.path(allD, { fill: tones[0], stroke: rim, 'stroke-width': fmt(rimFt * 2), 'stroke-linejoin': 'round' }));
  const ext = Math.max(...shapes.map(s => Math.hypot(s.x, s.y) + s.r), 1e-3);
  const order = shapes.map((s, i) => [Math.hypot(s.x, s.y) + rng.range(0, 0.25) * s.r, i]).sort((a, b) => b[0] - a[0]).map(a => a[1]);
  const c = contrast;
  for (const i of order) {
    const s = shapes[i];
    const lf = clamp((s.x * E.lx + s.y * E.ly) / ext, -1, 1);
    const off = (k, sc) => s.pts.map(([x, y]) => [s.x + (x - s.x) * sc + E.lx * s.r * k, s.y + (y - s.y) * sc + E.ly * s.r * k]);
    const j = rng.range(-0.03, 0.03);
    kids.push(E.path(smoothD(s.pts, true), { fill: ramp(tones, 0.24 + 0.08 * lf + j) }));
    kids.push(E.path(smoothD(off(0.12, 0.8), true), { fill: ramp(tones, 0.24 + c * 0.26 + 0.11 * lf + j) }));
    kids.push(E.path(smoothD(off(0.36, 0.44), true), { fill: ramp(tones, 0.24 + c * 0.54 + 0.14 * lf + j), opacity: 0.85 }));
  }
  // Leaf dabs: bright on each clump's lit side, dark on its shadow side.
  const hi = buckets(), lo = buckets();
  const hiC = shade(tones[2], 0.1), loC = shade(tones[0], -0.12);
  for (let i = 0; i < dabs; i++) {
    const s = shapes[rng.int(0, shapes.length - 1)];
    const a = rng.next() * Math.PI * 2, rr = Math.sqrt(rng.next()) * s.r * 0.9;
    const dx = Math.cos(a) * rr, dy = Math.sin(a) * rr, lit = (dx * E.lx + dy * E.ly) / s.r;
    const len = rng.range(0.35, 0.75) * dabSize * clamp(s.r / 2.5, 0.5, 1.3), ang = rng.next() * Math.PI;
    if (lit > 0.1) hi.add(hiC, lensD(s.x + dx, s.y + dy, len, len * 0.32, ang));
    else if (lit < -0.2) lo.add(loC, lensD(s.x + dx, s.y + dy, len, len * 0.32, ang));
  }
  kids.push(...lo.nodes(E, fill => ({ fill, opacity: 0.55 })), ...hi.nodes(E, fill => ({ fill, opacity: 0.6 })));
  if (flowers) {
    const fb = buckets(), fc = buckets();
    for (let i = 0; i < flowers.count; i++) {
      const s = shapes[rng.int(0, shapes.length - 1)];
      const a = rng.next() * Math.PI * 2, rr = Math.sqrt(rng.next()) * s.r * 0.8;
      const x = s.x + Math.cos(a) * rr, y = s.y + Math.sin(a) * rr, r = rng.range(0.14, 0.22);
      const col = flowers.colors[rng.int(0, flowers.colors.length - 1)];
      for (let k = 0; k < 5; k++) {
        const b = (k * 2 * Math.PI) / 5 + a;
        fb.add(col, lensD(x + Math.cos(b) * r * 0.55, y + Math.sin(b) * r * 0.55, r * 1.1, r * 0.4, b));
      }
      fc.add('#f3d36a', circleD(x, y, 0.06));
    }
    kids.push(...fb.nodes(E), ...fc.nodes(E));
  }
  return kids;
}

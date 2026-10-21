// Shrub, bramble, hedge or flowering bush seen from above, filling size.w x size.h.
import { env, jit, hsl, shade, fmt, clamp } from './_paint.js';
import { paintFoliage } from './_foliage.js';

const FLOWERS = [['#e8a6c4', '#f4d0e0'], ['#f2f0e6', '#e6dcc0'], ['#e8c640', '#f4dc78'], ['#b090d8', '#d0bff0'], ['#d8503c', '#f08a6a']];

export default {
  type: 'bush',
  render(el, rng, ctx) {
    const E = env(el, ctx);
    const p = el.params || {};
    const species = ['shrub', 'bramble', 'hedge', 'flowering'].includes(p.species) ? p.species : 'shrub';
    const hw = el.size.w / 2, hh = el.size.h / 2, m = Math.min(hw, hh);
    const heightFt = Number.isFinite(p.heightFt) ? p.heightFt : 4;
    const F = E.pal('foliage');
    let base = F;
    if (species === 'bramble') base = [hsl(F[0], -0.015, -0.05, -0.03), hsl(F[1], -0.02, -0.08, -0.05), hsl(F[2], -0.02, -0.08, -0.05)];
    if (species === 'hedge') base = [hsl(F[0], 0.01, 0, -0.01), hsl(F[1], 0.01, 0, -0.02), hsl(F[2], 0.01, 0, -0.02)];
    const tones = base.map(c => jit(rng, c, 0.06));
    const C = rng.fork('clumps'), clumps = [];
    if (species === 'hedge') {
      // trimmed block: clumps tiled along the long axis, small inset from the edge
      const long = hw >= hh, L = long ? hw : hh, S = long ? hh : hw;
      const r = S * 0.62, n = Math.max(1, Math.ceil((L * 2 - r) / (r * 1.1)));
      for (let i = 0; i < n; i++) {
        const u = n === 1 ? 0 : -L + r * 0.85 + (i * (2 * L - r * 1.7)) / (n - 1);
        for (const v of S > 1.2 ? [-S * 0.38, S * 0.38] : [0]) {
          const rr = r * C.range(0.8, 0.95);
          clumps.push(long ? { x: u + C.range(-0.1, 0.1), y: v * (rr / r), r: rr } : { x: v * (rr / r), y: u, r: rr });
        }
      }
    } else {
      const nOut = C.int(5, 7), ph = C.next() * Math.PI * 2;
      for (let i = 0; i < nOut; i++) {
        const a = ph + ((i + C.range(-0.2, 0.2)) * 2 * Math.PI) / nOut, r = m * C.range(0.36, 0.46), d = 1 - r / m * C.range(0.95, 1.05);
        clumps.push({ x: Math.cos(a) * hw * d, y: Math.sin(a) * hh * d, r });
      }
      clumps.push({ x: C.range(-0.1, 0.1) * m, y: C.range(-0.1, 0.1) * m, r: m * C.range(0.42, 0.5) });
    }
    const under = [];
    const kids = paintFoliage(E, rng.fork('paint'), {
      clumps, tones, shadowH: clamp(heightFt * 0.35, 0.4, 3), dabs: Math.round(m * m * 6 + 8), dabSize: clamp(m / 2, 0.35, 0.8),
      lobes: species === 'bramble' ? 9 : 8, depth: species === 'bramble' ? 0.18 : 0.12, rimFt: clamp(m * 0.08, 0.1, 0.25), under,
      flowers: species === 'flowering' ? { count: Math.round(m * m * 3 + 6), colors: FLOWERS[rng.int(0, FLOWERS.length - 1)] } : null,
    });
    if (species === 'bramble') {
      // thorny looping stems over the leaves, a few dark berries
      const S = rng.fork('stems');
      let d = '', th = '', be = '';
      for (let i = 0; i < Math.round(m * 4 + 3); i++) {
        const a = S.next() * Math.PI * 2, r0 = m * S.range(0, 0.4), r1 = m * S.range(0.7, 1.05), b = a + S.range(-0.8, 0.8);
        const x0 = Math.cos(a) * r0 * hw / m, y0 = Math.sin(a) * r0 * hh / m, x1 = Math.cos(b) * r1 * hw / m, y1 = Math.sin(b) * r1 * hh / m;
        const cx = (x0 + x1) / 2 + S.range(-0.4, 0.4) * m, cy = (y0 + y1) / 2 + S.range(-0.4, 0.4) * m;
        d += `M${fmt(x0)} ${fmt(y0)}Q${fmt(cx)} ${fmt(cy)} ${fmt(x1)} ${fmt(y1)}`;
        for (let k = 0; k < 3; k++) {
          const t = S.range(0.2, 0.9), x = (1 - t) * (1 - t) * x0 + 2 * t * (1 - t) * cx + t * t * x1, y = (1 - t) * (1 - t) * y0 + 2 * t * (1 - t) * cy + t * t * y1;
          const ta = S.next() * Math.PI * 2;
          th += `M${fmt(x)} ${fmt(y)}l${fmt(Math.cos(ta) * 0.18)} ${fmt(Math.sin(ta) * 0.18)}`;
        }
        if (S.chance(0.5)) { const x = x1 * 0.9, y = y1 * 0.9; be += `M${fmt(x - 0.09)} ${fmt(y)}a0.09 0.09 0 1 0 0.18 0a0.09 0.09 0 1 0 -0.18 0Z`; }
      }
      const stem = hsl(tones[0], -0.06, -0.1, 0.06);
      kids.push(E.path(d, { fill: 'none', stroke: shade(stem, -0.3), 'stroke-width': 0.14, 'stroke-linecap': 'round', opacity: 0.8 }));
      kids.push(E.path(d, { fill: 'none', stroke: stem, 'stroke-width': 0.07, 'stroke-linecap': 'round' }));
      kids.push(E.path(th, { fill: 'none', stroke: stem, 'stroke-width': 0.05, 'stroke-linecap': 'round' }));
      if (be) kids.push(E.path(be, { fill: '#3a1530', stroke: '#1e0c18', 'stroke-width': 0.03 }));
    }
    return E.g({ class: `bush bush-${species}` }, kids);
  },
};

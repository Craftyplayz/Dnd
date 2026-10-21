// A scatter of `count` rocks inside size.w x size.h, larger rocks first, plus pebbles.
import { env, polyD, clamp } from './_paint.js';
import { paintRock, paintPebbles, stoneTones } from './_stone.js';

export default {
  type: 'rock-cluster',
  render(el, rng, ctx) {
    const E = env(el, ctx);
    const p = el.params || {};
    const stone = ['granite', 'sandstone', 'slate', 'mossy'].includes(p.stone) ? p.stone : 'granite';
    const count = clamp(Math.round(Number.isFinite(p.count) ? p.count : 5), 1, 14);
    const hw = el.size.w / 2, hh = el.size.h / 2, m = Math.min(hw, hh);
    const tones = stoneTones(E, stone);
    const L = rng.fork('layout'), placed = [];
    // Radii shrink geometrically; each rock tries a few spots and keeps the least overlapping one.
    const r0 = clamp(Math.sqrt((hw * hh * 0.55) / count), 0.25, m * 0.6);
    for (let i = 0; i < count; i++) {
      const r = r0 * (i === 0 ? 1.25 : L.range(0.55, 1.05));
      let best = null;
      for (let t = 0; t < 12; t++) {
        const a = L.next() * Math.PI * 2, d = Math.sqrt(L.next());
        const x = Math.cos(a) * (hw - r) * d, y = Math.sin(a) * (hh - r) * d;
        const over = placed.reduce((s, q) => s + Math.max(0, r + q.r * 0.9 - Math.hypot(x - q.x, y - q.y)), 0);
        if (!best || over < best.over) best = { x, y, r, over };
        if (over === 0) break;
      }
      placed.push(best);
    }
    const rocks = placed.map((q, i) => paintRock(E, rng.fork('rock' + i), { cx: q.x, cy: q.y, rx: q.r, ry: q.r * L.range(0.65, 0.95), rot: L.next() * Math.PI, tones, moss: stone === 'mossy' && L.chance(0.7), n: L.int(6, 9) }));
    const shadow = E.shadowEl(rocks.map(r => polyD(r.outline, true)).join(''), clamp(r0 * 0.7, 0.3, 2));
    const pebbles = [];
    for (let i = 0; i < count * 3; i++) {
      const a = L.next() * Math.PI * 2, d = Math.sqrt(L.next()) * 0.95;
      pebbles.push({ x: Math.cos(a) * hw * d, y: Math.sin(a) * hh * d, r: clamp(r0 * L.range(0.12, 0.25), 0.08, 0.5) });
    }
    return E.g({ class: `rock-cluster rock-cluster-${stone}` }, [...paintPebbles(E, rng.fork('pebbles'), pebbles, tones, { shadowH: 0.25 }), shadow, ...rocks.flatMap(r => r.nodes)]);
  },
};

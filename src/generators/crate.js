// Wooden crate(s) seen from above. stack 1-3 piles smaller crates on top; broken = smashed lid
// with straw and loose boards.
import { env, rectD, fmt, clamp, buckets, jit } from './_paint.js';
import { crateTop } from './_wood.js';
import { rectPolyD } from './_stone.js';

export default {
  type: 'crate',
  render(el, rng, ctx) {
    const E = env(el, ctx);
    const p = el.params || {};
    const stack = clamp(Math.round(Number.isFinite(p.stack) ? p.stack : 1), 1, 3);
    const broken = !!p.broken;
    const w = el.size.w, hh = el.size.h, m = Math.min(w, hh);
    const kids = [];
    let bw = w, bh = hh;
    if (broken) { bw = w * 0.86; bh = hh * 0.86; }
    kids.push(E.shadowEl(rectD(0, 0, bw, bh), clamp(m * 0.45, 0.4, 2.5)));
    if (broken) {
      // loose boards around the smashed crate, inside the footprint
      const B = rng.fork('boards'), wood = E.pal('wood'), pb = buckets();
      for (let i = 0; i < 3; i++) {
        const a = B.next() * Math.PI * 2;
        pb.add(jit(B, wood[1], 0.06), rectPolyD(Math.cos(a) * w * 0.32, Math.sin(a) * hh * 0.32, m * B.range(0.5, 0.8), m * 0.14, a + B.range(-0.6, 0.6)));
      }
      kids.push(...pb.nodes(E, fill => ({ fill, stroke: E.pal('woodDark')[0], 'stroke-width': 0.05 })));
    }
    kids.push(crateTop(E, rng.fork('c0'), 0, 0, bw, bh, 0, { broken }));
    let cx = 0, cy = 0, s = 1;
    for (let i = 1; i < stack; i++) {
      const R = rng.fork('c' + i);
      s *= R.range(0.66, 0.76);
      const cw = bw * s, ch = bh * s;
      cx = clamp(cx + R.range(-0.15, 0.15) * bw, -(bw - cw) / 2, (bw - cw) / 2);
      cy = clamp(cy + R.range(-0.15, 0.15) * bh, -(bh - ch) / 2, (bh - ch) / 2);
      const ang = R.range(-10, 10);
      const [dx, dy] = E.shadow(clamp(m * 0.4 * s, 0.3, 2));
      kids.push(E.path(rectD(cx + dx, cy + dy, cw, ch, ang), { fill: '#000', opacity: fmt(E.shadowOpacity * 1.2), filter: 'url(#f-shadow)' }));
      kids.push(crateTop(E, R, cx, cy, cw, ch, ang, { broken: broken && i === stack - 1 && R.chance(0.5) }));
    }
    return E.g({ class: 'crate' }, kids);
  },
};

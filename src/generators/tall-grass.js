// Tall grass / meadow: thousands of seeded blade tufts over a soft darker underlay,
// thinning out toward the edge so the patch melts into the ground. Blades on the lit side
// of a tuft are lighter; each tuft drops a soft shadow.
import { h } from '../core/svg.js';
import { PALETTE as C, mix, jitter, shade } from '../render/palette.js';
import { D, wobble, bboxOf, grow, surfaceFilter, blurFilter, strokeBatch, batchPaths, bladeD, litDir, scatter, polyArea, smoothstep, n2 } from '../render/paint.js';

const TONES = {
  swamp: [C.swamp[0], C.swamp[2], '#7a8448'],
  sand: ['#7d7a3e', '#a6a060', '#c9c07a'],
  snow: ['#6f7a5a', '#8f9a76', '#b5b894'],
};

export default {
  type: 'tall-grass',
  render(el, rng, ctx) {
    const doc = ctx.doc, p = el.params, density = p.density ?? 0.6, ht = p.heightFt ?? 3;
    const outline = wobble(p.points, rng.fork('edge'), { amp: 0.5, wavelength: 6, closed: true, step: 0.6 });
    const bb = bboxOf(outline), box = grow(bb, 5);
    const id = n => `g-tall-grass-${el.id}-${n}`;
    const d = D(outline, true);
    const lit = litDir(el, ctx);
    const base = TONES[ctx.scene?.terrain?.base];
    const tr = rng.fork('tone');
    const dark = jitter(base ? base[0] : C.grass[0], tr, 0.05), mid = jitter(base ? base[1] : mix(C.grass[1], '#7a7a3a', 0.15), tr, 0.06), light = jitter(base ? base[2] : mix(C.grass[2], '#b8b868', 0.2), tr, 0.06);
    const defs = [
      surfaceFilter(doc, id('under'), box, { seed: el.seed, rough: 2, roughFreq: 0.12, mottle: 0.35, mottleFreq: 0.15, blur: 0.9 }),
      blurFilter(doc, id('shadow'), box, 0.3),
    ];
    const kids = [
      h('path', { d, fill: '#000', 'fill-opacity': 0 }, [], doc), // hit area for selection
      h('path', { d, fill: dark, stroke: dark, 'stroke-width': 1.5, opacity: n2(0.4 + 0.45 * density), filter: `url(#${id('under')})` }, [], doc),
    ];
    const area = polyArea(outline);
    const want = Math.min(4000, Math.round(area * density * 1.5));
    const pts = scatter(rng.fork('tufts'), outline, Math.round(want * 1.3));
    const r = rng.fork('blades'), b = strokeBatch(), sh = strokeBatch();
    const wind = r.range(-Math.PI, Math.PI), windK = r.range(0.25, 0.55);
    const len = 0.3 + ht * 0.24;
    const so = ctx.shadow(el, ht * 0.5);
    const deep = shade(dark, -0.25);
    let kept = 0;
    for (const { p: q, edge } of pts) {
      if (kept >= want) break;
      const keep = smoothstep(0, 2.2, edge);
      if (r.next() > keep) continue;
      kept++;
      const n = r.int(6, 10), scale = 0.5 + 0.5 * keep;
      b.add(`f|${deep}|0.55`, `M${n2(q[0] - 0.3)} ${n2(q[1])}a0.3 0.26 0 1 0 0.6 0a0.3 0.26 0 1 0 -0.6 0`);
      for (let k = 0; k < n; k++) {
        let a = r.range(-Math.PI, Math.PI);
        a += Math.sin(wind - a) * windK; // lean with the wind
        const L = len * scale * r.range(0.55, 1.3), bend = r.range(-0.4, 0.4) * L;
        const x = q[0] + r.range(-0.12, 0.12), y = q[1] + r.range(-0.12, 0.12);
        const facing = Math.cos(a) * lit[0] + Math.sin(a) * lit[1];
        const u = r.next() + facing * 0.45;
        const tone = u > 1.05 ? light : u > 0.45 ? mid : u > 0.1 ? dark : deep;
        b.add(`f|${tone}|0.97`, bladeD(x, y, a, L, 0.15, bend));
        if (k < 2) sh.add('f|#000000|1', bladeD(x + so[0] * 0.45, y + so[1] * 0.45, a, L, 0.3, bend));
      }
      if (r.chance(0.06)) {
        const a = r.range(-Math.PI, Math.PI), L = len * 1.15;
        const tx = q[0] + Math.cos(a) * L, ty = q[1] + Math.sin(a) * L;
        b.add(`s|${mix(light, '#e8dca0', 0.45)}|0.9|0.15`, `M${n2(tx)} ${n2(ty)}l${n2(Math.cos(a) * 0.3)} ${n2(Math.sin(a) * 0.3)}`);
      }
    }
    kids.push(h('g', { opacity: n2(0.22 * ctx.light.intensity + 0.08), filter: `url(#${id('shadow')})` }, batchPaths(doc, sh), doc));
    // Draw dark tones first, then mid, then light so highlights sit on top.
    const order = [deep, dark, mid, light];
    const rank = e => { const i = order.indexOf(e.getAttribute('fill')); return i < 0 ? 9 : i; };
    const paths = batchPaths(doc, b).sort((A, B) => rank(A) - rank(B));
    kids.push(h('g', {}, paths, doc));
    return h('g', {}, [h('defs', {}, defs, doc), ...kids], doc);
  },
};

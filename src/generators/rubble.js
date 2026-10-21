// Rubble: dusty gravel bed feathered into the ground, then many angular stones (mostly small,
// a few chunks), each with a shadow, a lit facet and a dark rim.
import { h } from '../core/svg.js';
import { createRng } from '../core/rng.js';
import { PALETTE as C, mix } from '../render/palette.js';
import { D, wobble, bboxOf, grow, surfaceFilter, blurFilter, strokeBatch, batchPaths, stonePts, litDir, scatter, polyArea, smoothstep, n2 } from '../render/paint.js';

const STONE = {
  granite: ['#5e5c56', '#7f7c74', '#a29e93'],
  sandstone: ['#7a603f', '#a2845a', '#c6aa7c'],
  slate: ['#353b41', '#4f5860', '#6f7a84'],
  mossy: ['#53554c', '#74746a', '#959488'],
};

export default {
  type: 'rubble',
  render(el, rng, ctx) {
    const doc = ctx.doc, p = el.params, density = p.density ?? 0.5, tones = STONE[p.stone] || STONE.granite;
    const outline = wobble(p.points, rng.fork('edge'), { amp: 0.6, wavelength: 7, closed: true, step: 0.6 });
    const bb = bboxOf(outline), box = grow(bb, 6);
    const id = n => `g-rubble-${el.id}-${n}`;
    const d = D(outline, true);
    const lit = litDir(el, ctx);
    const bed = mix(tones[0], C.dirt[0], 0.55);
    const defs = [
      surfaceFilter(doc, id('bed'), box, { seed: el.seed, rough: 2.2, roughFreq: 0.12, mottle: 0.3, mottleFreq: 0.1, feather: 1.2 }),
      surfaceFilter(doc, id('dust'), box, { seed: el.seed, rough: 2.5, roughFreq: 0.1, blur: 1.6 }),
      blurFilter(doc, id('shadow'), box, 0.15),
    ];
    const kids = [
      h('path', { d, fill: '#000', 'fill-opacity': 0 }, [], doc),
      h('path', { d, fill: bed, stroke: bed, 'stroke-width': 3, opacity: 0.25, filter: `url(#${id('dust')})` }, [], doc),
      h('path', { d, fill: bed, stroke: bed, 'stroke-width': 1.5, opacity: n2(0.3 + 0.35 * density), filter: `url(#${id('bed')})` }, [], doc),
    ];
    const area = polyArea(outline);
    const want = Math.min(1800, Math.round(area * density * 0.7));
    const r = rng.fork('stones'), sh = strokeBatch(), b = strokeBatch(), hi = strokeBatch(), rim = strokeBatch();
    const pts = scatter(r, outline, Math.round(want * 1.4));
    let kept = 0;
    for (const { p: q, edge } of pts) {
      if (kept >= want) break;
      const keep = smoothstep(0, 3, edge);
      if (r.next() > 0.25 + 0.75 * keep) continue;
      kept++;
      const u = r.next();
      let R = (0.14 + 0.9 * u ** 3) * (0.7 + 0.6 * density) * (0.5 + 0.5 * keep);
      if (r.chance(0.025 * (0.5 + density))) R = r.range(0.9, 1.7) * (0.5 + 0.5 * keep);
      const s = r.int(1, 2 ** 30);
      const shape = stonePts(createRng(s), q[0], q[1], R, { squash: 0.35 });
      const so = ctx.shadow(el, R * 0.9);
      sh.add('f|#000000|1', D(shape.map(v => [v[0] + so[0], v[1] + so[1]]), true));
      const tIdx = r.int(0, 2);
      b.add(`f|${tones[tIdx]}|1`, D(shape, true));
      const facet = shape.map(v => [q[0] + (v[0] - q[0]) * 0.55 + lit[0] * R * 0.25, q[1] + (v[1] - q[1]) * 0.55 + lit[1] * R * 0.25]);
      hi.add(`f|${p.stone === 'mossy' && r.chance(0.5) ? C.moss[1] : tones[2]}|${tIdx === 2 ? 0.55 : 0.75}`, D(facet, true));
      if (R > 0.35) rim.add(`s|${tones[0]}|0.8|${n2(Math.min(0.12, R * 0.12))}`, D(shape, true));
      if (R > 0.8 && r.chance(0.6)) rim.add(`s|#2b2a27|0.6|0.07`, `M${n2(q[0] - R * 0.3)} ${n2(q[1] - R * 0.1)}l${n2(R * 0.35)} ${n2(R * 0.25)}l${n2(R * 0.2)} ${n2(-R * 0.1)}`);
    }
    // Grit between the stones.
    const g = strokeBatch(), gr = rng.fork('grit');
    for (const { p: q, edge } of scatter(gr, outline, Math.min(5000, Math.round(area * density * 3)))) {
      if (gr.next() > smoothstep(0, 2, edge)) continue;
      const R = gr.range(0.04, 0.11);
      g.add(`f|${gr.pick(tones)}|0.9`, `M${n2(q[0] - R)} ${n2(q[1])}a${n2(R)} ${n2(R)} 0 1 0 ${n2(2 * R)} 0a${n2(R)} ${n2(R)} 0 1 0 ${n2(-2 * R)} 0`);
    }
    kids.push(h('g', {}, batchPaths(doc, g), doc));
    kids.push(h('g', { opacity: n2(0.28 * ctx.light.intensity + 0.1 + 0.15), filter: `url(#${id('shadow')})` }, batchPaths(doc, sh), doc));
    kids.push(h('g', {}, [...batchPaths(doc, b), ...batchPaths(doc, hi), ...batchPaths(doc, rim)], doc));
    return h('g', {}, [h('defs', {}, defs, doc), ...kids], doc);
  },
};

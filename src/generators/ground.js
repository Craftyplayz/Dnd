// Ground patch (dirt, mud, sand, gravel, stone floor, moss, crops, grass) that feathers into the terrain.
import { h } from '../core/svg.js';
import { PALETTE as C } from '../render/palette.js';
import { D, wobble, bboxOf, grow, surfaceFilter, blurFilter, strokeBatch, batchPaths, scatter, polyArea, n2 } from '../render/paint.js';

const MAT = {
  dirt: { pattern: 'p-dirt', halo: C.dirt[0], haloOp: 0.35, rough: 1.4 },
  mud: { pattern: 'p-mud', halo: '#2a2016', haloOp: 0.5, rough: 1.6, wet: true },
  sand: { pattern: 'p-sand', halo: C.sand[0], haloOp: 0.25, rough: 1.4, mottle: 0.35 },
  gravel: { pattern: 'p-gravel', halo: '#4a453c', haloOp: 0.35, rough: 1.0 },
  'stone-floor': { pattern: 'p-stone-floor', halo: '#3a3833', haloOp: 0.3, rough: 0.25, crisp: true, linear: true },
  moss: { pattern: 'p-moss', halo: C.moss[0], haloOp: 0.3, rough: 1.6 },
  crops: { pattern: 'p-crops', halo: '#4a3a26', haloOp: 0.4, rough: 0.6, linear: true },
  grass: { pattern: 'p-grass', halo: C.grass[0], haloOp: 0.25, rough: 1.6 },
};

export default {
  type: 'ground',
  render(el, rng, ctx) {
    const doc = ctx.doc, p = el.params, m = MAT[p.material] || MAT.dirt;
    const soft = p.softness ?? 0.5;
    const outline = wobble(p.points, rng.fork('edge'), { amp: m.crisp ? 0.08 : m.linear ? 0.25 : 0.35 + soft * 0.5, wavelength: 7, closed: true, step: 0.6, linear: !!m.linear });
    const feather = m.crisp ? 0.12 + soft * 0.4 : 0.25 + soft * 2.2;
    const box = grow(bboxOf(outline), feather * 4 + m.rough * 2 + 3);
    const id = n => `g-ground-${el.id}-${n}`;
    const d = D(outline, true);
    const defs = [
      surfaceFilter(doc, id('halo'), box, { seed: el.seed, rough: m.rough * 1.5, roughFreq: 0.12, blur: feather * 1.4 + 0.5 }),
      surfaceFilter(doc, id('body'), box, { seed: el.seed, rough: m.rough, roughFreq: 0.16, mottle: m.mottle ?? 0.22, mottleFreq: 0.07, grain: 0.1, feather }),
    ];
    const kids = [
      h('path', { d, fill: m.halo, stroke: m.halo, 'stroke-width': feather * 2 + 1, 'stroke-linejoin': 'round', opacity: m.haloOp * (0.6 + soft * 0.6), filter: `url(#${id('halo')})` }, [], doc),
      h('path', { d, fill: `url(#${m.pattern})`, stroke: `url(#${m.pattern})`, 'stroke-width': feather * 1.6, 'stroke-linejoin': 'round', filter: `url(#${id('body')})` }, [], doc),
    ];
    if (m.wet) {
      // Standing water sheen in the lowest parts of the mud.
      const r = rng.fork('puddles'), b = strokeBatch();
      const n = Math.min(40, Math.round(polyArea(outline) / 25));
      for (const { p: q, edge } of scatter(r, outline, n)) {
        if (edge < 1.2) continue;
        const rx = Math.min(edge * 0.6, r.range(0.4, 1.4)), ry = rx * r.range(0.35, 0.6);
        b.add('f|#2b2a22|0.6', `M${n2(q[0] - rx)} ${n2(q[1])}a${n2(rx)} ${n2(ry)} 0 1 0 ${n2(2 * rx)} 0a${n2(rx)} ${n2(ry)} 0 1 0 ${n2(-2 * rx)} 0`);
        b.add('s|#a9b4ac|0.35|0.08', `M${n2(q[0] - rx * 0.5)} ${n2(q[1] - ry * 0.4)}q${n2(rx * 0.4)} ${n2(-ry * 0.3)} ${n2(rx * 0.8)} 0`);
      }
      defs.push(blurFilter(doc, id('soft'), box, 0.12));
      kids.push(h('g', { filter: `url(#${id('soft')})` }, batchPaths(doc, b), doc));
    }
    return h('g', {}, [h('defs', {}, defs, doc), ...kids], doc);
  },
};

// Road / track: worn verge that bleeds into the terrain, textured body with ragged edges,
// wheel ruts, a trampled centre, and pebbles / grass tufts along the margins.
import { h } from '../core/svg.js';
import { PALETTE as C, mix } from '../render/palette.js';
import { D, wobble, bboxOf, grow, normals, cumLengths, offset, noise1, at, surfaceFilter, strokeBatch, batchPaths, bladeD, pebble, litDir, stonePts, n2 } from '../render/paint.js';
import { createRng } from '../core/rng.js';

const TUFTS = {
  grass: [C.grass[0], C.grass[1], C.grass[2]],
  'forest-floor': [C.moss[0], C.moss[1], C.foliage[2]],
  dirt: [C.grass[0], C.grass[1], C.grass[2]],
  stone: [C.moss[1], C.grass[1]],
  sand: ['#8a8a48', '#a6a060', '#6e6e3a'],
  snow: ['#8a9890', '#a0aca4'],
  swamp: [C.swamp[0], C.swamp[2], C.moss[1]],
};

function cobblePattern(doc) {
  const r = createRng(0xc0bb1e), b = strokeBatch(), T = 4;
  for (let row = 0; row < 6; row++) {
    const y = (row + 0.5) * (T / 6), shift = (row % 2) * 0.33;
    for (let col = 0; col < 6; col++) {
      const x = (col + 0.5 + shift) * (T / 6);
      const tone = r.pick(['#6b6860', '#77736a', '#625f58', '#817c71', '#6f685c']);
      for (const dx of [-T, 0, T]) {
        b.add('f|#2a2824|0.5', D(stonePts(createRng(row * 31 + col), x + dx + 0.04, y + 0.05, 0.38, { sides: 7, squash: 0.15 }), true));
        b.add(`f|${tone}|1`, D(stonePts(createRng(row * 31 + col), x + dx, y, 0.36, { sides: 7, squash: 0.15 }), true));
        b.add('f|#ffffff|0.16', D(stonePts(createRng(row * 37 + col), x + dx - 0.07, y - 0.08, 0.14, { sides: 6 }), true));
      }
    }
  }
  return h('pattern', { patternUnits: 'userSpaceOnUse', width: T, height: T }, [h('rect', { width: T, height: T, fill: '#46423a' }, [], doc), ...batchPaths(doc, b)], doc);
}

export default {
  type: 'road',
  render(el, rng, ctx) {
    const doc = ctx.doc, p = el.params, w = p.width, closed = !!p.closed;
    const surface = p.surface || 'dirt';
    const center = wobble(p.points, rng.fork('meander'), { amp: Math.min(1.4, w * 0.07), wavelength: 22, closed, step: 0.6 });
    const nm = normals(center, closed), cum = cumLengths(center, closed), total = cum[cum.length - 1];
    const d = D(center, closed);
    const box = grow(bboxOf(center), w * 1.1 + 4);
    const id = n => `g-road-${el.id}-${n}`;
    const rough = Math.min(3.2, 1 + w * 0.16);
    const paint = surface === 'cobble' ? ctx.def('g-road-cobble', () => cobblePattern(doc)) : `url(#${surface === 'gravel' ? 'p-gravel' : 'p-dirt'})`;
    const cap = closed ? 'butt' : 'round';
    const stroke = (sw, s, extra = {}) => h('path', { d, fill: 'none', stroke: s, 'stroke-width': sw, 'stroke-linecap': cap, 'stroke-linejoin': 'round', ...extra }, [], doc);
    const defs = [
      surfaceFilter(doc, id('verge'), box, { seed: el.seed, rough: rough * 2, roughFreq: 0.09, blur: 1.1 }),
      surfaceFilter(doc, id('body'), box, { seed: el.seed, rough, roughFreq: 0.22, mottle: 0.28, mottleFreq: 0.06, grain: 0.12, feather: 0.55 }),
      surfaceFilter(doc, id('soft'), box, { seed: el.seed + 5, rough: 0.6, roughFreq: 0.4, blur: 0.9 }),
      surfaceFilter(doc, id('rut'), box, { seed: el.seed + 9, rough: 0.5, roughFreq: 0.6, blur: 0.1 }),
    ];
    const vergeColor = surface === 'cobble' ? '#4d4a40' : mix(C.dirt[0], C.grass[0], 0.3);
    const kids = [
      stroke(w * 1.75, vergeColor, { opacity: 0.16, filter: `url(#${id('verge')})` }),
      stroke(w * 1.3, vergeColor, { opacity: 0.4, filter: `url(#${id('verge')})` }),
      stroke(w, paint, { filter: `url(#${id('body')})` }),
    ];
    if (surface !== 'cobble') {
      kids.push(stroke(w * 0.42, C.dirt[2], { opacity: 0.2, filter: `url(#${id('soft')})` }));
      kids.push(stroke(w * 0.95, C.dirt[0], { opacity: 0.12, filter: `url(#${id('soft')})`, 'stroke-dasharray': `${n2(w * 2)} ${n2(w * 1.3)}` }));
    } else {
      kids.push(stroke(w * 0.9, '#000', { opacity: 0.12, filter: `url(#${id('soft')})`, 'stroke-dasharray': `${n2(w * 1.5)} ${n2(w)}` }));
    }
    const lit = litDir(el, ctx);
    if (p.ruts !== false && surface !== 'cobble' && w >= 4) {
      const nz = noise1(rng.fork('ruts'), 6, closed ? total : 0), b = strokeBatch();
      for (const side of [-1, 1]) {
        const off = i => side * w * 0.21 + nz(cum[i] + side * 50) * 0.25;
        const rut = offset(center, nm, off);
        // A rut is a dip: its far wall (away from the light) catches the light.
        const hl = offset(center, nm, i => off(i) + (nm[i][0] * lit[0] + nm[i][1] * lit[1] > 0 ? -0.24 : 0.24));
        b.add(`s|${C.mud[0]}|0.38|${n2(Math.min(0.8, w * 0.06))}`, D(rut, closed));
        b.add(`s|${C.dirt[2]}|0.35|0.16`, D(hl, closed));
      }
      kids.push(h('g', { filter: `url(#${id('rut')})` }, batchPaths(doc, b), doc));
    }
    // Margins: pebbles that spill onto the verge, grass that creeps onto the edge, centre-strip tufts.
    const r = rng.fork('margin'), b = strokeBatch();
    const tones = TUFTS[ctx.scene?.terrain?.base] || TUFTS.grass;
    for (let s = r.range(0, 1.5); s < total; s += r.range(0.5, 1.8)) {
      const a = at(center, cum, s), side = r.chance(0.5) ? 1 : -1;
      if (r.chance(0.55)) {
        const dist = w / 2 + r.range(-1.2, 0.8);
        pebble(b, r, a.p[0] + a.n[0] * dist * side, a.p[1] + a.n[1] * dist * side, r.range(0.1, 0.3), r.pick([C.stone[1], C.stone[2], C.dirt[2], C.stone[0]]), lit);
      }
      // Grass clumps creeping over the edge, darker at their base.
      for (let c = r.int(1, 3); c--;) {
        if (surface === 'cobble' && !r.chance(0.3)) continue;
        const dist = w / 2 + r.range(-1, 0.6), x = a.p[0] + a.n[0] * dist * side + a.t[0] * r.range(-0.6, 0.6), y = a.p[1] + a.n[1] * dist * side + a.t[1] * r.range(-0.6, 0.6);
        b.add(`f|${tones[0]}|0.35`, `M${n2(x - 0.35)} ${n2(y)}a0.35 0.3 0 1 0 0.7 0a0.35 0.3 0 1 0 -0.7 0`);
        for (let k = r.int(4, 9); k--;) b.add(`f|${r.pick(tones)}|0.92`, bladeD(x + r.range(-0.25, 0.25), y + r.range(-0.25, 0.25), r.range(-Math.PI, Math.PI), r.range(0.4, 1), 0.12, r.range(-0.25, 0.25)));
      }
      if (p.ruts !== false && surface === 'dirt' && r.chance(0.18)) {
        const x = a.p[0] + a.n[0] * r.range(-0.5, 0.5), y = a.p[1] + a.n[1] * r.range(-0.5, 0.5);
        for (let k = r.int(3, 6); k--;) b.add(`f|${r.pick(tones)}|0.7`, bladeD(x, y, r.range(-Math.PI, Math.PI), r.range(0.3, 0.6), 0.1, 0));
      }
    }
    kids.push(h('g', {}, batchPaths(doc, b), doc));
    return h('g', {}, [h('defs', {}, defs, doc), ...kids], doc);
  },
};

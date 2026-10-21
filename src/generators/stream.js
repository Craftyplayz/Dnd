// Stream / river: wet bank soaking into the ground, pebble margins, shallow-to-deep water body
// with a foam line at the edge, flow ripples and the odd stone in shallow water.
import { h } from '../core/svg.js';
import { PALETTE as C, mix } from '../render/palette.js';
import { D, wobble, bboxOf, grow, cumLengths, at, surfaceFilter, blurFilter, strokeBatch, batchPaths, pebble, litDir, n2 } from '../render/paint.js';

export const WATER = {
  shallow: mix(C.water[1], C.sand[0], 0.42),
  mid: C.water[1],
  deep: C.water[0],
  foam: '#cfdcd2',
  ripple: '#dbe9e4',
};

export default {
  type: 'stream',
  render(el, rng, ctx) {
    const doc = ctx.doc, p = el.params, w = p.width, closed = !!p.closed, deep = p.depth === 'deep';
    const center = wobble(p.points, rng.fork('meander'), { amp: Math.min(2, w * 0.12), wavelength: 24, closed, step: 0.6 });
    const cum = cumLengths(center, closed), total = cum[cum.length - 1];
    const d = D(center, closed);
    const box = grow(bboxOf(center), w + 9);
    const id = n => `g-stream-${el.id}-${n}`;
    const rough = Math.min(3, 0.8 + w * 0.15);
    const cap = closed ? 'butt' : 'round';
    const stroke = (sw, s, extra = {}) => h('path', { d, fill: 'none', stroke: s, 'stroke-width': sw, 'stroke-linecap': cap, 'stroke-linejoin': 'round', ...extra }, [], doc);
    const defs = [
      surfaceFilter(doc, id('halo'), box, { seed: el.seed, rough: rough * 1.6, roughFreq: 0.08, blur: 1.6 }),
      surfaceFilter(doc, id('bank'), box, { seed: el.seed, rough, roughFreq: 0.12, mottle: 0.25, mottleFreq: 0.1, blur: 0.35 }),
      surfaceFilter(doc, id('water'), box, { seed: el.seed, rough: rough * 0.8, roughFreq: 0.12, mottle: 0.12, mottleFreq: 0.05, feather: 0.25 }),
      blurFilter(doc, id('chan'), box, Math.max(0.4, w * 0.13)),
      blurFilter(doc, id('soft'), box, 0.06),
      blurFilter(doc, id('sky'), box, Math.max(0.25, w * 0.04)),
    ];
    const kids = [
      stroke(w + 6, C.mud[0], { opacity: 0.32, filter: `url(#${id('halo')})` }),
      stroke(w + 2.4, C.mud[1], { opacity: 0.9, filter: `url(#${id('bank')})` }),
    ];
    const lit = litDir(el, ctx);
    // Bank pebbles and wet stones.
    const r = rng.fork('bank'), b = strokeBatch();
    for (let s = r.range(0, 1); s < total; s += r.range(0.35, 1.2)) {
      const a = at(center, cum, s), side = r.chance(0.5) ? 1 : -1, dist = w / 2 + r.range(0.1, 1.5);
      pebble(b, r, a.p[0] + a.n[0] * dist * side, a.p[1] + a.n[1] * dist * side, r.range(0.1, 0.32), r.pick([C.stone[0], C.stone[1], '#5d5446', C.stone[2]]), lit, 0.35);
    }
    kids.push(h('g', {}, batchPaths(doc, b), doc));
    // Water body: foam rim, shallow bed, blurred deep channel; displaced together so the edges agree.
    const water = [
      stroke(w, WATER.foam, { opacity: 0.9 }),
      stroke(Math.max(0.5, w - 0.5), WATER.shallow),
      stroke(Math.max(0.5, w - 0.6), 'url(#p-water-shallow)', { opacity: 0.55 }),
      stroke(w * (deep ? 0.78 : 0.5), deep ? WATER.deep : WATER.mid, { opacity: deep ? 0.95 : 0.75, filter: `url(#${id('chan')})` }),
    ];
    if (deep) water.push(stroke(w * 0.35, '#10262e', { opacity: 0.6, filter: `url(#${id('chan')})` }));
    kids.push(h('g', { filter: `url(#${id('water')})` }, water, doc));
    // Ripples follow the flow (first -> last point); shallow water gets more riffles and stones.
    const rr = rng.fork('ripples'), rb = strokeBatch();
    const step = deep ? 1.6 : 0.9;
    for (let s = rr.range(0, step); s < total; s += rr.range(step * 0.5, step * 1.3)) {
      const a = at(center, cum, s), u = rr.range(-0.36, 0.36) * w, L = rr.range(0.4, 1.6) * Math.min(1.5, 0.5 + w / 10);
      const cx = a.p[0] + a.n[0] * u, cy = a.p[1] + a.n[1] * u, bow = rr.range(0.1, 0.3) * (u > 0 ? 1 : -1);
      const x0 = cx - a.t[0] * L / 2, y0 = cy - a.t[1] * L / 2, x1 = cx + a.t[0] * L / 2, y1 = cy + a.t[1] * L / 2;
      const q = `M${n2(x0)} ${n2(y0)}Q${n2(cx + a.n[0] * bow)} ${n2(cy + a.n[1] * bow)} ${n2(x1)} ${n2(y1)}`;
      rb.add(`s|${WATER.ripple}|${n2((deep ? 0.16 : 0.26) * rr.range(0.6, 1.2))}|${n2(rr.range(0.05, 0.11))}`, q);
      rb.add(`s|${C.water[0]}|0.25|0.12`, `M${n2(x0 + a.n[0] * 0.14)} ${n2(y0 + a.n[1] * 0.14)}Q${n2(cx + a.n[0] * (bow + 0.14))} ${n2(cy + a.n[1] * (bow + 0.14))} ${n2(x1 + a.n[0] * 0.14)} ${n2(y1 + a.n[1] * 0.14)}`);
      if (!deep && rr.chance(0.07) && w > 3) {
        const sr = rr.range(0.3, 0.6);
        // Wet stone with a foam crescent on its upstream side and a wake behind it.
        const ux = -a.t[0], uy = -a.t[1], R = sr * 1.35;
        rb.add(`s|${WATER.foam}|0.6|0.12`, `M${n2(cx + a.n[0] * R)} ${n2(cy + a.n[1] * R)}Q${n2(cx + ux * R * 1.6)} ${n2(cy + uy * R * 1.6)} ${n2(cx - a.n[0] * R)} ${n2(cy - a.n[1] * R)}`);
        pebble(rb, rr, cx, cy, sr, C.stone[0], lit, 0.25);
      }
    }
    // Long, very soft sky-reflection streaks.
    const sky = strokeBatch();
    for (let s = rr.range(0, 6); s < total; s += rr.range(6, 14)) {
      const a = at(center, cum, s), b2 = at(center, cum, s + rr.range(2, 5)), u = rr.range(-0.2, 0.2) * w;
      sky.add(`s|#ffffff|0.08|${n2(Math.max(0.3, w * 0.09))}`, `M${n2(a.p[0] + a.n[0] * u)} ${n2(a.p[1] + a.n[1] * u)}L${n2(b2.p[0] + b2.n[0] * u)} ${n2(b2.p[1] + b2.n[1] * u)}`);
    }
    kids.push(h('g', { filter: `url(#${id('soft')})` }, batchPaths(doc, rb), doc));
    kids.push(h('g', { filter: `url(#${id('sky')})` }, batchPaths(doc, sky), doc));
    return h('g', {}, [h('defs', {}, defs, doc), ...kids], doc);
  },
};

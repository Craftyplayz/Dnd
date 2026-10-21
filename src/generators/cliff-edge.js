// Cliff edge: the line is the top edge; the rock face band extends `width` toward lowSide.
// Face shading follows the light per point along the line; the drop casts a shadow onto the
// low ground when the face turns away from the light. Scree collects at the toe.
import { h } from '../core/svg.js';
import { PALETTE as C, mix, shade } from '../render/palette.js';
import { D, wobble, bboxOf, grow, normals, cumLengths, noise1, bandD, offset, surfaceFilter, blurFilter, strokeBatch, batchPaths, bladeD, pebble, litDir, stonePts, n2 } from '../render/paint.js';

export default {
  type: 'cliff-edge',
  render(el, rng, ctx) {
    const doc = ctx.doc, p = el.params, w = p.width, closed = !!p.closed;
    const sign = p.lowSide === 'left' ? 1 : -1; // left normal * sign = toward the low side
    const drop = p.dropFt ?? 15;
    const top = wobble(p.points, rng.fork('top'), { amp: Math.min(1, w * 0.12), wavelength: 7, closed, step: 0.5 });
    const nm = normals(top, closed), cum = cumLengths(top, closed), total = cum[cum.length - 1];
    const lit = litDir(el, ctx);
    const L = ctx.light;
    // Per point: how much the face (normal toward the low side) faces the light, -1..1.
    const facing = nm.map(n => sign * (n[0] * lit[0] + n[1] * lit[1]));
    const nzToe = noise1(rng.fork('toe'), 3.5, closed ? total : 0);
    const toe = i => sign * w * (0.85 + 0.25 * nzToe(cum[i]));
    const shLen = Math.min(drop / Math.tan((Math.max(5, L.elevation) * Math.PI) / 180), drop * 1.2, w * 2.5 + 8);
    const shadowEnd = i => toe(i) + sign * (1 + Math.max(0, -facing[i]) * shLen);
    const box = grow(bboxOf(top), w * 1.3 + shLen + 6);
    const id = n => `g-cliff-edge-${el.id}-${n}`;
    const defs = [
      surfaceFilter(doc, id('shadow'), box, { seed: el.seed, rough: 1.5, roughFreq: 0.15, blur: 1.1 }),
      surfaceFilter(doc, id('face'), box, { seed: el.seed, rough: Math.min(0.9, 0.3 + w * 0.06), roughFreq: 0.6, mottle: 0.2, mottleFreq: 0.12, grain: 0.18, grainFreq: 1.1 }),
      blurFilter(doc, id('soft'), box, 0.5),
      blurFilter(doc, id('ao'), box, Math.max(0.4, w * 0.12)),
      h('clipPath', { id: id('clip') }, [h('path', { d: bandD(top, nm, 0, toe, closed), 'clip-rule': 'evenodd' }, [], doc)], doc),
    ];
    const meanFacing = facing.reduce((a, b) => a + b, 0) / facing.length;
    const faceBase = mix(C.stone[1], meanFacing > 0 ? C.stone[2] : C.stone[0], Math.abs(meanFacing) * 0.5);
    const kids = [
      // Cast shadow onto the low ground plus a constant contact shadow at the toe.
      h('path', { d: bandD(top, nm, i => toe(i) * 0.6, shadowEnd, closed), fill: '#000', 'fill-rule': 'evenodd', opacity: n2(0.4 * L.intensity + 0.15), filter: `url(#${id('shadow')})` }, [], doc),
      h('path', { d: bandD(top, nm, i => toe(i) * 0.6, i => toe(i) + (shadowEnd(i) - toe(i)) * 0.45, closed), fill: '#000', 'fill-rule': 'evenodd', opacity: n2(0.35 * L.intensity + 0.12), filter: `url(#${id('shadow')})` }, [], doc),
    ];
    // Scree at the toe.
    const r = rng.fork('scree'), sb = strokeBatch();
    for (let i = 0; i < top.length; i += 1) {
      if (!r.chance(0.55)) continue;
      const dd = toe(i) + sign * r.range(-0.2, 2.6) * Math.min(1.5, 0.5 + w / 6);
      const rr = r.range(0.12, 0.45) * (r.chance(0.08) ? 2.2 : 1);
      pebble(sb, r, top[i][0] + nm[i][0] * dd, top[i][1] + nm[i][1] * dd, rr, r.pick([C.stone[0], '#5f5c55', '#6d6a62']), lit, 0.4);
    }
    // Rock face: fractured blocks. Chunks along the top edge, each split into 2-3 tiers by jagged
    // seams; block tone follows how much that stretch faces the light, plus a random jitter.
    const face = [h('path', { d: bandD(top, nm, 0, toe, closed), fill: shade(faceBase, -0.15), 'fill-rule': 'evenodd' }, [], doc)];
    const fb = strokeBatch(), cr = rng.fork('blocks');
    const pt = (i, u) => [top[i][0] + nm[i][0] * u, top[i][1] + nm[i][1] * u];
    const last = top.length - (closed ? 0 : 1);
    for (let i0 = 0; i0 < last;) {
      const i1 = Math.min(last, i0 + cr.int(2, 6));
      const f = facing.slice(i0, i1 + 1).reduce((x, y) => x + y, 0) / (i1 - i0 + 1);
      const tiers = cr.int(2, 3);
      let prev = Array.from({ length: i1 - i0 + 1 }, () => 0);
      for (let t = 1; t <= tiers; t++) {
        const frac = t === tiers ? 1 : t / tiers + cr.range(-0.12, 0.12);
        const cut = prev.map((_, k) => (t === tiers ? 1 : frac + cr.range(-0.05, 0.05)));
        const I = k => (i0 + k) % top.length;
        const upper = prev.map((u, k) => pt(I(k), toe(I(k)) * u));
        const lower = cut.map((u, k) => pt(I(k), toe(I(k)) * u));
        // Lower tiers sit deeper in shadow; lit stretches get the light tone.
        const lt = Math.max(-1, Math.min(1, f * 1.1 + cr.range(-0.3, 0.3))) - (t - 1) * 0.18 + 0.1;
        const tone = lt > 0 ? mix(faceBase, '#c9c4b6', lt * 0.8) : mix(faceBase, '#25282c', -lt * 0.85);
        fb.add(`f|${tone}|1`, D([...upper, ...lower.reverse()], true));
        // Lit upper rim of the block and a dark seam under it.
        if (lt > -0.3) fb.add(`s|${shade(tone, 0.25)}|0.7|0.12`, D(upper.map(q => [q[0], q[1]]), false));
        fb.add(`s|${C.slate[0]}|0.65|0.1`, D(lower.reverse(), false));
        prev = cut;
      }
      // Vertical crevice between chunks.
      const c = [];
      for (let k = 0; k <= 4; k++) { const u = toe(i1 % top.length) * k / 4, j = cr.range(-0.2, 0.2); const q = pt(i1 % top.length, u); c.push([q[0] - nm[i1 % top.length][1] * j, q[1] + nm[i1 % top.length][0] * j]); }
      fb.add(`s|#1d2024|0.75|0.14`, D(c, false));
      i0 = i1;
    }
    face.push(h('g', { 'clip-path': `url(#${id('clip')})` }, [
      ...batchPaths(doc, fb),
      // Occlusion toward the toe.
      h('path', { d: bandD(top, nm, i => toe(i) * 0.65, i => toe(i) * 1.1, closed), fill: '#000', 'fill-rule': 'evenodd', opacity: 0.35, filter: `url(#${id('ao')})` }, [], doc),
    ], doc));
    const kids2 = [h('g', { filter: `url(#${id('face')})` }, face, doc)];
    // Top lip: dark crisp edge, light rim, and grass hanging over from the high side.
    const tb = strokeBatch(), tr = rng.fork('lip');
    if (meanFacing > -0.2) tb.add(`s|${C.stone[2]}|0.5|0.25`, D(offset(top, nm, sign * 0.18), closed));
    tb.add(`s|#1d2024|0.7|0.16`, D(top, closed));
    const grassy = ['grass', 'forest-floor', 'swamp', 'dirt'].includes(ctx.scene?.terrain?.base);
    if (grassy) {
      for (let i = 0; i < top.length; i++) {
        if (!tr.chance(0.6)) continue;
        const bx = top[i][0] - nm[i][0] * sign * tr.range(0, 0.5), by = top[i][1] - nm[i][1] * sign * tr.range(0, 0.5);
        const ang = Math.atan2(nm[i][1] * sign, nm[i][0] * sign) + tr.range(-0.9, 0.9);
        tb.add(`f|${tr.pick([C.grass[0], C.grass[1], C.grass[2]])}|0.95`, bladeD(bx, by, ang, tr.range(0.4, 1), 0.13, tr.range(-0.2, 0.2)));
      }
    }
    return h('g', {}, [h('defs', {}, defs, doc), ...kids, h('g', {}, batchPaths(doc, sb), doc), ...kids2, h('g', {}, batchPaths(doc, tb), doc)], doc);
  },
};

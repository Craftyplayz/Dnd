// Pond: muddy shoreline, shallow rim fading to a deep centre, foam edge, sky reflections,
// lily pads in shallow water, and reed clumps along the shore.
import { h } from '../core/svg.js';
import { PALETTE as C, jitter } from '../render/palette.js';
import { D, wobble, bboxOf, grow, cumLengths, at, surfaceFilter, blurFilter, strokeBatch, batchPaths, bladeD, pebble, litDir, scatter, n2, noise1 } from '../render/paint.js';
import { WATER } from './stream.js';

export default {
  type: 'pond',
  render(el, rng, ctx) {
    const doc = ctx.doc, p = el.params, deep = p.depth === 'deep';
    const outline = wobble(p.points, rng.fork('shore'), { amp: 0.6, wavelength: 8, closed: true, step: 0.6 });
    const orient = orientation(outline);
    const bb = bboxOf(outline), m = Math.max(2, Math.min(bb.w, bb.h));
    const box = grow(bb, 10);
    const id = n => `g-pond-${el.id}-${n}`;
    const d = D(outline, true);
    const lit = litDir(el, ctx);
    const defs = [
      surfaceFilter(doc, id('halo'), box, { seed: el.seed, rough: 2.4, roughFreq: 0.08, blur: 1.6 }),
      surfaceFilter(doc, id('bank'), box, { seed: el.seed, rough: 1.6, roughFreq: 0.12, mottle: 0.25, mottleFreq: 0.1, blur: 0.35 }),
      surfaceFilter(doc, id('water'), box, { seed: el.seed, rough: 1.3, roughFreq: 0.12, mottle: 0.12, mottleFreq: 0.05, feather: 0.25 }),
      blurFilter(doc, id('depth'), box, m * 0.11),
      blurFilter(doc, id('soft'), box, 0.06),
      h('clipPath', { id: id('clip') }, [h('path', { d }, [], doc)], doc),
    ];
    const path = (attrs) => h('path', { d, 'stroke-linejoin': 'round', ...attrs }, [], doc);
    const kids = [
      path({ fill: C.mud[0], stroke: C.mud[0], 'stroke-width': 7, opacity: 0.3, filter: `url(#${id('halo')})` }),
      path({ fill: C.mud[1], stroke: C.mud[1], 'stroke-width': 2.6, opacity: 0.9, filter: `url(#${id('bank')})` }),
    ];
    const r = rng.fork('bank'), b = strokeBatch();
    const cum = cumLengths(outline, true), total = cum[cum.length - 1];
    for (let s = r.range(0, 1); s < total; s += r.range(0.4, 1.4)) {
      const a = at(outline, cum, s), dist = r.range(-0.2, 1.4), out = outward(a, orient);
      pebble(b, r, a.p[0] + out[0] * dist, a.p[1] + out[1] * dist, r.range(0.1, 0.3), r.pick([C.stone[0], C.stone[1], '#5d5446']), lit, 0.35);
    }
    kids.push(h('g', {}, batchPaths(doc, b), doc));
    // Water: deep fill, blurred shallow rim stroke clipped to the shore (works for any concave outline).
    kids.push(h('g', { filter: `url(#${id('water')})` }, [
      path({ fill: WATER.foam, stroke: WATER.foam, 'stroke-width': 0.5, opacity: 0.9 }),
      path({ fill: deep ? WATER.deep : WATER.mid }),
      h('g', { 'clip-path': `url(#${id('clip')})` }, [
        path({ fill: 'none', stroke: WATER.shallow, 'stroke-width': m * (deep ? 0.32 : 0.6), filter: `url(#${id('depth')})` }),
        path({ fill: 'none', stroke: WATER.foam, 'stroke-width': 0.7, opacity: 0.6 }),
      ], doc),
      path({ fill: `url(#${deep ? 'p-water-deep' : 'p-water-shallow'})`, opacity: 0.35 }),
      // Sky reflection: a soft bright patch toward the shadow-side shore (the far bank mirrors the sky).
      h('g', { 'clip-path': `url(#${id('clip')})` }, [h('ellipse', { cx: n2(bb.x + bb.w / 2 - lit[0] * bb.w * 0.22), cy: n2(bb.y + bb.h / 2 - lit[1] * bb.h * 0.22), rx: n2(bb.w * 0.28), ry: n2(bb.h * 0.2), fill: '#e8f2f0', opacity: 0.12, filter: `url(#${id('depth')})` }, [], doc)], doc),
    ], doc));
    // Reflections and ripples inside the water (scattered points well inside the shore).
    const wr = rng.fork('surface'), wb = strokeBatch();
    const pts = scatter(wr, outline, Math.min(220, Math.round(bb.w * bb.h / 6)));
    for (const { p: q, edge } of pts) {
      if (edge < 1) continue;
      const L = Math.min(edge, wr.range(0.6, 2.4));
      wb.add(`s|${WATER.ripple}|0.25|${n2(wr.range(0.07, 0.13))}`, `M${n2(q[0] - L / 2)} ${n2(q[1])}q${n2(L / 2)} ${n2(-L * 0.12)} ${n2(L)} 0`);
    }
    kids.push(h('g', { filter: `url(#${id('soft')})` }, batchPaths(doc, wb), doc));
    // Lily pads in shallow ponds.
    const lr = rng.fork('lily'), lb = strokeBatch();
    if (!deep) {
      for (const { p: q, edge } of pts.slice(0, 40)) {
        if (edge < 1 || edge > m * 0.3 || !lr.chance(0.25)) continue;
        const R = lr.range(0.35, 0.75), a0 = lr.next() * Math.PI * 2, tone = jitter(C.foliage[1], lr, 0.1);
        const pad = (cx, cy, rad) => `M${n2(cx)} ${n2(cy)}L${n2(cx + Math.cos(a0) * rad)} ${n2(cy + Math.sin(a0) * rad)}A${n2(rad)} ${n2(rad)} 0 1 1 ${n2(cx + Math.cos(a0 + 0.5) * rad)} ${n2(cy + Math.sin(a0 + 0.5) * rad)}Z`;
        lb.add('f|#000000|0.25', pad(q[0] - lit[0] * 0.12, q[1] - lit[1] * 0.12, R));
        lb.add(`f|${tone}|1`, pad(q[0], q[1], R));
        lb.add(`f|${C.foliage[2]}|0.5`, pad(q[0] + lit[0] * R * 0.15, q[1] + lit[1] * R * 0.15, R * 0.55));
        if (lr.chance(0.25)) lb.add('f|#f2e6ec|0.95', `M${n2(q[0] - 0.12)} ${n2(q[1])}a0.12 0.12 0 1 0 0.24 0a0.12 0.12 0 1 0 -0.24 0`);
      }
    }
    // Reeds along the shore, clumped by a noise along the shoreline.
    if (p.reeds !== false) {
      const rd = rng.fork('reeds'), nz = noise1(rd, 9, total);
      const sh = ctx.shadow(el, 2.5);
      for (let s = rd.range(0, 1); s < total; s += rd.range(0.6, 1.6)) {
        if (nz(s) < 0.05) continue;
        const a = at(outline, cum, s), out = outward(a, orient), dist = rd.range(-1.6, 0.7);
        const x = a.p[0] + out[0] * dist, y = a.p[1] + out[1] * dist;
        for (let k = rd.int(5, 12); k--;) {
          const ang = rd.range(-Math.PI, Math.PI), L = rd.range(0.9, 2.2), bx = x + rd.range(-0.4, 0.4), by = y + rd.range(-0.4, 0.4);
          const blade = bladeD(bx, by, ang, L, 0.13, rd.range(-0.25, 0.25));
          lb.add('f|#000000|0.18', bladeD(bx + sh[0] * 0.25, by + sh[1] * 0.25, ang, L, 0.13, 0));
          lb.add(`f|${rd.pick([C.grass[0], C.foliage[1], '#6f7a3a', C.grass[2]])}|0.95`, blade);
          if (rd.chance(0.12)) {
            const tx = bx + Math.cos(ang) * L * 0.8, ty = by + Math.sin(ang) * L * 0.8;
            lb.add('s|#5a3a22|1|0.22', `M${n2(tx)} ${n2(ty)}l${n2(Math.cos(ang) * 0.35)} ${n2(Math.sin(ang) * 0.35)}`);
          }
        }
      }
    }
    kids.push(h('g', {}, batchPaths(doc, lb), doc));
    return h('g', {}, [h('defs', {}, defs, doc), ...kids], doc);
  },
};

// Outward unit normal. Left normals point outward on a ring that is clockwise on screen (signed area > 0, y down).
function outward(a, orient) {
  return orient > 0 ? a.n : [-a.n[0], -a.n[1]];
}

function orientation(poly) {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return s;
}

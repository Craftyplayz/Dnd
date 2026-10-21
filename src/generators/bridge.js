// Bridge: size.w = span along local x, size.h = deck width. wood = planks across stringers with
// post-and-rail sides; stone = flagged arch deck with parapets. broken = a collapsed section.
import { env, polyD, fmt, clamp, ramp, shade, jit, buckets, rectD, lineD } from './_paint.js';
import { paintWall, paintPebbles, stoneTones, rectPolyD } from './_stone.js';

export default {
  type: 'bridge',
  render(el, rng, ctx) {
    const E = env(el, ctx);
    const p = el.params || {};
    const stone = p.material === 'stone', rails = p.rails !== false, broken = !!p.broken;
    const L = el.size.w, Wd = el.size.h, hx = L / 2, hy = Wd / 2;
    let gap = null; // collapsed section somewhere in the middle third
    if (broken) { const g = clamp(L * rng.range(0.12, 0.2), Math.min(1.2, L * 0.3), 10), c = rng.range(-L / 6, L / 6); gap = [c - g / 2, c + g / 2]; }
    const deckSpans = gap ? [[-hx, gap[0]], [gap[1], hx]] : [[-hx, hx]];
    const kids = [E.shadowEl(deckSpans.map(([a, b]) => rectD((a + b) / 2, 0, b - a, Wd)).join(''), 3)];
    const G = { L, Wd, hx, hy, rails, gap, deckSpans };
    kids.push(...(stone ? stoneDeck(E, rng, G) : woodDeck(E, rng, G)));
    return E.g({ class: `bridge bridge-${stone ? 'stone' : 'wood'}${broken ? ' broken' : ''}` }, kids);
  },
};

function woodDeck(E, rng, { Wd, hx, hy, rails, gap }) {
  const wood = E.pal('wood'), wd = E.pal('woodDark'), kids = [];
  const inGap = (x0, x1) => gap && x1 > gap[0] && x0 < gap[1];
  const rw = rails ? clamp(Wd * 0.07, 0.3, 0.7) : 0;
  // stringers under the deck: visible through the gap
  const sy = [-hy * 0.7, 0, hy * 0.7];
  let str = '';
  for (const y of sy) {
    if (gap && rng.chance(0.6)) str += lineD(-hx, y, gap[0] + rng.range(0.3, 1.2), y + rng.range(-0.3, 0.3)) + lineD(gap[1] - rng.range(0, 0.8), y, hx, y);
    else str += lineD(-hx, y, hx, y);
  }
  kids.push(E.path(str, { stroke: wd[0], 'stroke-width': fmt(clamp(Wd * 0.08, 0.3, 0.8)), fill: 'none' }));
  // planks run across the span
  const V = [0, 1, 2, 3].map(i => jit(rng, ramp(wood, 0.32 + i * 0.13), 0.05));
  const pb = buckets(), grain = [], nails = [], loose = buckets();
  const pw = 0.8;
  for (let x = -hx; x < hx - 0.05; x += pw) {
    const x1 = Math.min(x + pw - 0.07, hx);
    if (inGap(x, x1)) {
      if (rng.chance(0.25)) loose.add(V[rng.int(0, 3)], rectPolyD((x + x1) / 2 + rng.range(-0.3, 0.3), rng.range(-hy, hy) * 0.5, Wd * rng.range(0.3, 0.6), pw * 0.8, Math.PI / 2 + rng.range(-0.6, 0.6)));
      continue;
    }
    const e0 = -hy + rw + rng.range(-0.15, 0.1), e1 = hy - rw + rng.range(-0.1, 0.15);
    const nearGap = gap && (Math.abs(x - gap[1]) < pw * 1.5 || Math.abs(x1 - gap[0]) < pw * 1.5);
    const cut = nearGap ? rng.range(0.3, 0.8) : 1; // splintered planks at the break
    const e2 = e0 + (e1 - e0) * cut;
    pb.add(V[rng.int(0, 3)], polyD([[x, e0], [x1, e0 + rng.range(-0.05, 0.05)], [x1, e2], [x, e2 * rng.range(0.92, 1)]], true));
    grain.push(lineD(x + pw * 0.4, e0 + 0.3, x + pw * 0.45, e0 + (e2 - e0) * 0.6));
    for (const y of sy) if (y > e0 && y < e2) nails.push(`M${fmt(x + pw * 0.45)} ${fmt(y)}h0.01`);
  }
  kids.push(...pb.nodes(E, fill => ({ fill, stroke: shade(wd[0], -0.2), 'stroke-width': 0.04 })));
  if (grain.length) kids.push(E.path(grain.join(''), { stroke: wood[0], 'stroke-width': 0.04, opacity: 0.5, fill: 'none' }));
  if (nails.length) kids.push(E.path(nails.join(''), { stroke: '#2a2a2c', 'stroke-width': 0.1, 'stroke-linecap': 'round', fill: 'none' }));
  kids.push(...loose.nodes(E, fill => ({ fill, stroke: wd[0], 'stroke-width': 0.05, opacity: 0.9 })));
  if (rails) {
    const ps = rw * 1.3, postsD = buckets();
    let rd = '';
    for (const s of [-1, 1]) {
      const y = s * (hy - rw / 2);
      const spans = gap ? [[-hx, gap[0] - 0.2], [gap[1] + 0.2, hx]] : [[-hx, hx]];
      for (const [a, b] of spans) {
        if (b - a < 0.4) continue;
        rd += lineD(a + 0.1, y, b - 0.1, y);
        const n = Math.max(1, Math.round((b - a) / 5));
        for (let k = 0; k <= n; k++) {
          const x = clamp(a + ((b - a) * k) / n, -hx + ps / 2, hx - ps / 2);
          postsD.add(wd[1], rectD(x, y, ps, ps));
          postsD.add(wood[2], rectD(x + E.lx * ps * 0.12, y + E.ly * ps * 0.12, ps * 0.5, ps * 0.5));
        }
      }
    }
    if (rd) {
      kids.push(E.shadowEl(rd, 1.5, { stroke: fmt(rw * 0.8) }));
      kids.push(E.path(rd, { stroke: wd[0], 'stroke-width': fmt(rw), fill: 'none', 'stroke-linecap': 'butt' }));
      kids.push(E.path(rd, { stroke: wood[1], 'stroke-width': fmt(rw * 0.65), fill: 'none', 'stroke-linecap': 'butt' }));
      kids.push(E.path(rd, { stroke: wood[2], 'stroke-width': fmt(rw * 0.2), fill: 'none', opacity: 0.6, transform: `translate(0 ${fmt(E.ly * rw * 0.2)})` }));
    }
    kids.push(...postsD.nodes(E, fill => ({ fill, stroke: fill === wd[1] ? shade(wd[0], -0.3) : 'none', 'stroke-width': 0.05 })));
  }
  return kids;
}

function stoneDeck(E, rng, { Wd, hy, rails, gap, deckSpans }) {
  const st = stoneTones(E, 'granite'), kids = [];
  const pw = rails ? clamp(Wd * 0.12, 0.8, 2) : 0;
  const R = rng.fork('deck');
  for (const [a, b] of deckSpans) {
    kids.push(E.path(rectD((a + b) / 2, 0, b - a, Wd), { fill: shade(st[0], -0.25) }));
    // flagstones in courses across the deck
    const fb = buckets(), V = [0, 1, 2, 3].map(i => jit(R, ramp(st, 0.42 + i * 0.12), 0.04));
    for (let x = a; x < b - 0.1;) {
      const cw = Math.min(R.range(1, 1.6), b - x);
      for (let y = -hy + pw - R.range(0, 1); y < hy - pw;) {
        const ch = R.range(1.2, 2.4), y0 = Math.max(y, -hy + pw), y1 = Math.min(y + ch, hy - pw);
        if (y1 - y0 > 0.2) fb.add(V[R.int(0, 3)], rectD(x + cw / 2, (y0 + y1) / 2, Math.max(0.05, cw - 0.1), y1 - y0 - 0.1));
        y += ch;
      }
      x += cw;
    }
    kids.push(...fb.nodes(E));
  }
  // arch: the deck rises toward the middle, so the ends sit in shade
  const arch = E.def('g-bridge-arch', () => E.h('linearGradient', { x1: 0, x2: 1, y1: 0, y2: 0 }, [
    E.h('stop', { offset: 0, 'stop-color': '#000', 'stop-opacity': 0.3 }),
    E.h('stop', { offset: 0.3, 'stop-color': '#000', 'stop-opacity': 0 }),
    E.h('stop', { offset: 0.5, 'stop-color': '#fff', 'stop-opacity': 0.08 }),
    E.h('stop', { offset: 0.7, 'stop-color': '#000', 'stop-opacity': 0 }),
    E.h('stop', { offset: 1, 'stop-color': '#000', 'stop-opacity': 0.3 }),
  ]));
  if (arch) kids.push(E.path(deckSpans.map(([a, b]) => rectD((a + b) / 2, 0, b - a, Wd)).join(''), { fill: arch }));
  if (gap) {
    // fallen masonry at the breach edges
    const items = [];
    for (let i = 0; i < Math.round((gap[1] - gap[0]) * Wd * 0.5); i++) {
      const side = R.chance(0.5) ? gap[0] : gap[1];
      items.push({ x: side + R.range(-0.8, 0.8), y: R.range(-hy, hy) * 0.9, r: R.range(0.2, 0.55) });
    }
    kids.push(...paintPebbles(E, R, items, st, { shadowH: 0.3 }));
  }
  if (rails) {
    for (const s of [-1, 1]) {
      const y = s * (hy - pw / 2);
      deckSpans.forEach(([a, b], i) => {
        const w = paintWall(E, R.fork(`p${s}${i}`), { points: [[a, y], [b, y]], width: pw, material: 'stone', heightFt: 1.5, rubble: false });
        kids.push(...w.shadow, ...w.body);
      });
    }
  }
  return kids;
}

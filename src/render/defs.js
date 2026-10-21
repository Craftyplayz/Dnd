// Shared <defs>: the filters and patterns listed in docs/CONTRACT.md 5.1.
// Scene independent (fixed seeds), so a live view builds them once.
import { h } from '../core/svg.js';
import { createRng } from '../core/rng.js';
import { PALETTE as C, mix, shade, jitter } from './palette.js';
import { n2, D, stonePts, blobD, bladeD, strokeBatch } from './paint.js';

const bboxFilter = (doc, id, m, prims) => h('filter', {
  id, x: -m, y: -m, width: 1 + 2 * m, height: 1 + 2 * m,
  filterUnits: 'objectBoundingBox', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB',
}, prims, doc);

function contractFilters(doc) {
  return [
    bboxFilter(doc, 'f-shadow', 1, [h('feGaussianBlur', { stdDeviation: 0.6 }, [], doc)]),
    bboxFilter(doc, 'f-shadow-wide', 1, [h('feGaussianBlur', { stdDeviation: 1.6 }, [], doc)]),
    bboxFilter(doc, 'f-soft-edge', 1, [h('feGaussianBlur', { stdDeviation: 2 }, [], doc)]),
    bboxFilter(doc, 'f-rough', 0.2, [
      h('feTurbulence', { type: 'fractalNoise', baseFrequency: 1.1, numOctaves: 2, seed: 7, result: 'n' }, [], doc),
      h('feDisplacementMap', { in: 'SourceGraphic', in2: 'n', scale: 0.6, xChannelSelector: 'R', yChannelSelector: 'G' }, [], doc),
    ]),
    bboxFilter(doc, 'f-grain', 0.05, [
      h('feTurbulence', { type: 'fractalNoise', baseFrequency: 1.6, numOctaves: 2, seed: 3, result: 'n' }, [], doc),
      h('feColorMatrix', { in: 'n', type: 'matrix', values: '1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 0 0 0 0 1', result: 'g' }, [], doc),
      h('feComposite', { in: 'SourceGraphic', in2: 'g', operator: 'arithmetic', k1: 0.36, k2: 0.82, k3: 0, k4: 0, result: 'm' }, [], doc),
      h('feComposite', { in: 'm', in2: 'SourceAlpha', operator: 'in' }, [], doc),
    ]),
  ];
}

// Pattern tile builder. Marks near an edge are repeated on the opposite side so tiles are seamless.
function tile(doc, id, W, H, bg, draw) {
  const b = strokeBatch(), extra = [];
  const wrap = (x, y, m, fn) => {
    for (const dx of [-W, 0, W]) for (const dy of [-H, 0, H]) {
      const X = x + dx, Y = y + dy;
      if (X > -m && X < W + m && Y > -m && Y < H + m) fn(X, Y);
    }
  };
  draw({ add: b.add, wrap, extra });
  const kids = [h('rect', { width: W, height: H, fill: bg }, [], doc)];
  for (const k of b.keys()) {
    const [kind, color, op, sw] = k.split('|');
    const attrs = kind === 's'
      ? { d: b.get(k), fill: 'none', stroke: color, 'stroke-width': sw, 'stroke-linecap': 'round', opacity: op }
      : { d: b.get(k), fill: color, opacity: op };
    kids.push(h('path', attrs, [], doc));
  }
  for (const e of extra) kids.push(e(doc));
  return h('pattern', { id, patternUnits: 'userSpaceOnUse', width: W, height: H }, kids, doc);
}

const dot = (x, y, r) => `M${n2(x - r)} ${n2(y)}a${n2(r)} ${n2(r)} 0 1 0 ${n2(2 * r)} 0a${n2(r)} ${n2(r)} 0 1 0 ${n2(-2 * r)} 0`;
const ell = (x, y, rx, ry, a) => {
  const c = Math.cos(a), s = Math.sin(a);
  const p = t => [x + Math.cos(t) * rx * c - Math.sin(t) * ry * s, y + Math.cos(t) * rx * s + Math.sin(t) * ry * c];
  return D([0, 1, 2, 3, 4, 5, 6, 7].map(i => p(i * Math.PI / 4)), true);
};
const blades = (t, r, n, tones, len = [0.4, 0.9], w = 0.11, W = 7) => {
  for (let i = 0; i < n; i++) {
    const x = r.next() * W, y = r.next() * W, a = r.range(-Math.PI, Math.PI), L = r.range(len[0], len[1]);
    const tone = tones[Math.floor(r.next() * tones.length)];
    t.wrap(x, y, 1, (X, Y) => t.add(`f|${tone[0]}|${tone[1]}`, bladeD(X, Y, a, L, w, r.range(-0.15, 0.15))));
  }
};
const specks = (t, r, n, W, H, color, op, rr = [0.04, 0.1]) => {
  for (let i = 0; i < n; i++) {
    const x = r.next() * W, y = r.next() * H, R = r.range(rr[0], rr[1]);
    t.wrap(x, y, R, (X, Y) => t.add(`f|${color}|${op}`, dot(X, Y, R)));
  }
};
const pebbles = (t, r, n, W, H, tones, rr) => {
  for (let i = 0; i < n; i++) {
    const x = r.next() * W, y = r.next() * H, R = r.range(rr[0], rr[1]), tone = r.pick(tones);
    t.wrap(x, y, R * 1.3, (X, Y) => {
      t.add(`f|#000000|0.25`, D(stonePts(r.fork(`${i}`), X + R * 0.25, Y + R * 0.3, R), true));
      t.add(`f|${tone}|1`, D(stonePts(r.fork(`${i}`), X, Y, R), true));
      t.add(`f|#ffffff|0.18`, D(stonePts(r.fork(`${i}h`), X - R * 0.25, Y - R * 0.25, R * 0.45), true));
    });
  }
};

function patterns(doc) {
  const P = [];
  const R = id => createRng(0x5eed ^ id.length * 977 ^ id.charCodeAt(2) * 131);

  P.push(tile(doc, 'p-grass', 7, 7, C.grass[1], t => {
    const r = R('p-grass');
    specks(t, r, 60, 7, 7, C.grass[0], 0.35, [0.1, 0.3]);
    blades(t, r, 420, [[C.grass[0], 0.55], [shade(C.grass[0], -0.1), 0.45], [C.grass[2], 0.4], [mix(C.grass[2], '#c8c070', 0.4), 0.25]], [0.3, 0.7], 0.1, 7);
  }));
  P.push(tile(doc, 'p-forest-floor', 8, 8, C.forest[1], t => {
    const r = R('p-forest-floor');
    specks(t, r, 120, 8, 8, C.forest[0], 0.5, [0.05, 0.16]);
    const tones = ['#6b4a26', '#8a5e2a', '#5e5a2c', '#7a3f22', '#9a7a3c', C.forest[2]];
    for (let i = 0; i < 170; i++) {
      const x = r.next() * 8, y = r.next() * 8, a = r.next() * Math.PI, L = r.range(0.18, 0.34), tone = r.pick(tones);
      t.wrap(x, y, 0.4, (X, Y) => t.add(`f|${tone}|0.8`, ell(X, Y, L, L * 0.45, a)));
    }
    for (let i = 0; i < 14; i++) {
      const x = r.next() * 8, y = r.next() * 8, a = r.next() * Math.PI, L = r.range(0.5, 1.3);
      t.wrap(x, y, L, (X, Y) => t.add(`s|#2a1f14|0.7|0.07`, `M${n2(X)} ${n2(Y)}l${n2(Math.cos(a) * L)} ${n2(Math.sin(a) * L)}`));
    }
    blades(t, r, 40, [[C.moss[1], 0.5], [C.moss[2], 0.35]], [0.25, 0.5], 0.09, 8);
  }));
  P.push(tile(doc, 'p-dirt', 8, 8, C.dirt[1], t => {
    const r = R('p-dirt');
    specks(t, r, 18, 8, 8, C.dirt[0], 0.25, [0.4, 0.9]);
    specks(t, r, 260, 8, 8, C.dirt[0], 0.55);
    specks(t, r, 180, 8, 8, C.dirt[2], 0.45);
    pebbles(t, r, 22, 8, 8, [C.stone[1], C.stone[2], C.dirt[2]], [0.08, 0.22]);
  }));
  P.push(tile(doc, 'p-mud', 9, 9, C.mud[1], t => {
    const r = R('p-mud');
    for (let i = 0; i < 14; i++) {
      const x = r.next() * 9, y = r.next() * 9, rx = r.range(0.5, 1.6);
      t.wrap(x, y, rx * 1.2, (X, Y) => t.add(`f|${C.mud[0]}|0.45`, blobD(r.fork(`b${i}`), X, Y, rx, rx * 0.6)));
    }
    for (let i = 0; i < 26; i++) {
      const x = r.next() * 9, y = r.next() * 9, L = r.range(0.3, 0.9);
      t.wrap(x, y, 1, (X, Y) => t.add(`s|#c9c2b0|0.22|0.06`, `M${n2(X)} ${n2(Y)}q${n2(L / 2)} -0.08 ${n2(L)} 0`));
    }
    specks(t, r, 160, 9, 9, C.mud[2], 0.4);
  }));
  P.push(tile(doc, 'p-sand', 10, 10, C.sand[1], t => {
    const r = R('p-sand');
    for (let i = 0; i < 9; i++) {
      const y0 = i * 10 / 9 + r.range(-0.2, 0.2);
      let d = `M-1 ${n2(y0)}`;
      for (let x = 0; x <= 11; x += 1) d += `Q${n2(x - 0.5)} ${n2(y0 + r.range(-0.25, 0.25))} ${n2(x)} ${n2(y0 + Math.sin(x * 1.3 + i) * 0.12)}`;
      t.add(`s|${C.sand[0]}|0.35|0.08`, d);
      t.add(`s|${C.sand[2]}|0.4|0.06`, d.replace(/(-?\d+\.?\d*) (-?\d+\.?\d*)/g, (m, a, b) => `${a} ${n2(+b - 0.12)}`));
    }
    specks(t, r, 260, 10, 10, C.sand[0], 0.4, [0.03, 0.07]);
    specks(t, r, 160, 10, 10, C.sand[2], 0.5, [0.03, 0.06]);
  }));
  P.push(tile(doc, 'p-gravel', 6, 6, '#5e584d', t => {
    const r = R('p-gravel');
    pebbles(t, r, 200, 6, 6, ['#8b857a', '#a19b8e', '#77716a', '#958b78', '#6d675e'], [0.1, 0.24]);
  }));
  P.push(tile(doc, 'p-stone', 8, 8, C.stone[1], t => {
    const r = R('p-stone');
    for (let i = 0; i < 16; i++) {
      const x = r.next() * 8, y = r.next() * 8, rx = r.range(0.6, 1.8), tone = r.pick([C.stone[0], C.stone[2], '#7a776c']);
      t.wrap(x, y, rx * 1.2, (X, Y) => t.add(`f|${tone}|0.3`, blobD(r.fork(`s${i}`), X, Y, rx, rx * 0.7)));
    }
    for (let i = 0; i < 14; i++) {
      let x = r.next() * 8, y = r.next() * 8, d = `M${n2(x)} ${n2(y)}`, a = r.next() * 6.28;
      for (let k = 0; k < 4; k++) { a += r.range(-0.8, 0.8); x += Math.cos(a) * 0.5; y += Math.sin(a) * 0.5; d += `L${n2(x)} ${n2(y)}`; }
      t.add(`s|#3a3935|0.55|0.06`, d);
    }
    specks(t, r, 30, 8, 8, '#8a9a5a', 0.35, [0.08, 0.2]);
    specks(t, r, 200, 8, 8, C.stone[0], 0.4, [0.03, 0.07]);
  }));
  P.push(tile(doc, 'p-stone-floor', 10, 10, '#3e3b36', t => {
    const r = R('p-stone-floor');
    const rows = 4, rh = 10 / rows;
    for (let row = 0; row < rows; row++) {
      let x = r.range(0, 3);
      const start = x;
      while (x < start + 10 - 0.6) {
        const w = Math.min(r.range(1.6, 3.2), start + 10 - x);
        const y0 = row * rh, tone = jitter(r.pick(['#8a857a', '#7d786d', '#958f82', '#857f72']), r, 0.07);
        const g = 0.09, j = () => r.range(-0.06, 0.06);
        const pts = [[x + g + j(), y0 + g + j()], [x + w - g + j(), y0 + g + j()], [x + w - g + j(), y0 + rh - g + j()], [x + g + j(), y0 + rh - g + j()]];
        for (const dx of [-10, 0, 10]) {
          const q = pts.map(p => [p[0] + dx, p[1]]);
          t.add(`f|${tone}|1`, D(q, true));
          t.add(`f|#ffffff|0.08`, D([q[0], q[1], [q[1][0] - 0.15, q[1][1] + 0.18], [q[0][0] + 0.15, q[0][1] + 0.18]], true));
          t.add(`f|#000000|0.12`, D([q[3], q[2], [q[2][0] - 0.15, q[2][1] - 0.15], [q[3][0] + 0.15, q[3][1] - 0.15]], true));
        }
        x += w;
      }
    }
    specks(t, r, 240, 10, 10, '#000000', 0.12, [0.03, 0.08]);
  }));
  P.push(tile(doc, 'p-moss', 6, 6, C.moss[1], t => {
    const r = R('p-moss');
    specks(t, r, 40, 6, 6, C.moss[0], 0.4, [0.15, 0.4]);
    specks(t, r, 300, 6, 6, C.moss[2], 0.5, [0.04, 0.1]);
    specks(t, r, 200, 6, 6, C.moss[0], 0.5, [0.04, 0.09]);
  }));
  P.push(tile(doc, 'p-crops', 6, 3, '#5a4630', t => {
    const r = R('p-crops');
    t.add(`s|#3e2f1f|0.8|0.5`, 'M-1 2.6H7');
    t.add(`s|#6e5838|0.6|0.3`, 'M-1 0.4H7');
    for (let i = 0; i < 18; i++) {
      const x = i / 3 + r.range(-0.08, 0.08), y = 1.3 + r.range(-0.12, 0.12);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + r.range(-0.3, 0.3), L = r.range(0.35, 0.65);
        const tone = r.pick([[C.crops[0], 0.9], [C.crops[1], 0.9], [C.crops[2], 0.7]]);
        t.wrap(x, y, 1, (X, Y) => t.add(`f|${tone[0]}|${tone[1]}`, bladeD(X, Y, a, L, 0.16, r.range(-0.1, 0.1))));
      }
    }
  }));
  P.push(tile(doc, 'p-snow', 10, 10, C.snow[1], t => {
    const r = R('p-snow');
    for (let i = 0; i < 12; i++) {
      const x = r.next() * 10, y = r.next() * 10, rx = r.range(0.8, 2.2);
      t.wrap(x, y, rx * 1.2, (X, Y) => t.add(`f|${C.snow[0]}|0.22`, blobD(r.fork(`s${i}`), X, Y, rx, rx * 0.5)));
    }
    specks(t, r, 160, 10, 10, '#ffffff', 0.7, [0.03, 0.07]);
    specks(t, r, 90, 10, 10, C.snow[0], 0.4, [0.03, 0.06]);
  }));
  P.push(tile(doc, 'p-swamp', 9, 9, C.swamp[1], t => {
    const r = R('p-swamp');
    for (let i = 0; i < 8; i++) {
      const x = r.next() * 9, y = r.next() * 9, rx = r.range(0.5, 1.4);
      t.wrap(x, y, rx * 1.2, (X, Y) => {
        t.add(`f|#1f2a22|0.75`, blobD(r.fork(`p${i}`), X, Y, rx, rx * 0.7));
        t.add(`s|#8fa0a0|0.25|0.05`, `M${n2(X - rx * 0.4)} ${n2(Y - rx * 0.2)}q${n2(rx * 0.3)} -0.1 ${n2(rx * 0.6)} 0`);
      });
    }
    specks(t, r, 220, 9, 9, C.swamp[2], 0.5, [0.04, 0.12]);
    blades(t, r, 60, [[C.swamp[0], 0.6], [C.moss[2], 0.4]], [0.3, 0.6], 0.09, 9);
  }));
  const water = (id, bg, light, dark) => tile(doc, id, 8, 8, bg, t => {
    const r = R(id);
    for (let i = 0; i < 26; i++) {
      const x = r.next() * 8, y = r.next() * 8, L = r.range(0.5, 1.4);
      t.wrap(x, y, L, (X, Y) => t.add(`s|${light}|0.3|0.07`, `M${n2(X)} ${n2(Y)}q${n2(L / 2)} ${n2(-L * 0.18)} ${n2(L)} 0`));
    }
    for (let i = 0; i < 18; i++) {
      const x = r.next() * 8, y = r.next() * 8, L = r.range(0.6, 1.6);
      t.wrap(x, y, L, (X, Y) => t.add(`s|${dark}|0.25|0.1`, `M${n2(X)} ${n2(Y)}q${n2(L / 2)} ${n2(L * 0.15)} ${n2(L)} 0`));
    }
  });
  P.push(water('p-water-shallow', mix(C.water[1], C.sand[0], 0.35), '#d6e6e0', C.water[0]));
  P.push(water('p-water-deep', C.water[0], C.water[2], '#0f242c'));
  P.push(tile(doc, 'p-wood', 8, 4, C.wood[1], t => {
    const r = R('p-wood');
    for (let k = 0; k < 4; k++) {
      const y0 = k, tone = jitter(C.wood[1], r, 0.08);
      t.add(`f|${tone}|1`, `M-1 ${y0}H9V${y0 + 1}H-1Z`);
      for (let g = 0; g < 4; g++) {
        const y = y0 + 0.15 + g * 0.22 + r.range(-0.04, 0.04);
        let d = `M-1 ${n2(y)}`;
        for (let x = 0; x <= 9; x += 1.5) d += `Q${n2(x - 0.75)} ${n2(y + r.range(-0.05, 0.05))} ${n2(x)} ${n2(y)}`;
        t.add(`s|${C.wood[0]}|0.35|0.035`, d);
      }
      const joint = r.range(1, 7);
      t.add(`s|${C.woodDark[0]}|0.8|0.06`, `M${n2(joint)} ${y0}v1`);
      t.add(`s|${C.woodDark[0]}|0.9|0.07`, `M-1 ${y0 + 0.98}H9`);
      t.add(`s|${C.wood[2]}|0.35|0.05`, `M-1 ${y0 + 0.05}H9`);
    }
  }));
  return P;
}

export function buildDefs(doc) {
  return h('defs', { 'data-layer': 'defs' }, [...contractFilters(doc), ...patterns(doc)], doc);
}

export const PATTERN_IDS = ['p-grass', 'p-forest-floor', 'p-dirt', 'p-mud', 'p-sand', 'p-gravel', 'p-stone', 'p-stone-floor', 'p-moss', 'p-crops', 'p-snow', 'p-swamp', 'p-water-shallow', 'p-water-deep', 'p-wood'];
export const FILTER_IDS = ['f-shadow', 'f-shadow-wide', 'f-rough', 'f-grain', 'f-soft-edge'];

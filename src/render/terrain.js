// Terrain base layer: painted ground for terrain.base with layered, non-repeating variation.
// Large-scale mottling and fine grain come from feTurbulence in user space (no tiles);
// mid-scale patches and detail marks are seeded scatter over the whole map (no tiles either).
// The pattern underneath only supplies micro texture and is broken up by everything above it.
import { h } from '../core/svg.js';
import { createRng } from '../core/rng.js';
import { hash32 } from '../schema.js';
import { PALETTE as C, mix, shade, hexToRgb } from './palette.js';
import { n2, D, blobD, bladeD, stonePts, strokeBatch, filterEl } from './paint.js';

const leaf = ['#6b4a26', '#8a5e2a', '#5e5a2c', '#7a3f22', '#9a7a3c'];

// Per base: colours, pattern, mottle tones, patch recipes and detail scatter.
const BASES = {
  grass: { tones: C.grass, pattern: 'p-grass', dark: '#2c4519', light: '#a5ad55', patches: [
    { color: '#3a5a20', op: 0.45, rate: 1 / 260, r: [1.5, 4.5] },
    { color: '#8e9a4a', op: 0.35, rate: 1 / 500, r: [2, 6] },
    { color: C.dirt[1], op: 0.5, rate: 1 / 2200, r: [0.6, 1.8] },
  ], detail: 'grass' },
  'forest-floor': { tones: C.forest, pattern: 'p-forest-floor', dark: '#17150b', light: '#72703c', patches: [
    { color: C.moss[1], op: 0.5, rate: 1 / 300, r: [1.5, 5] },
    { color: '#241d12', op: 0.45, rate: 1 / 350, r: [2, 5] },
    { color: '#7a5a30', op: 0.35, rate: 1 / 500, r: [1.5, 4] },
  ], detail: 'forest' },
  dirt: { tones: C.dirt, pattern: 'p-dirt', dark: '#3d2e1e', light: '#b49a70', patches: [
    { color: C.grass[1], op: 0.35, rate: 1 / 1100, r: [0.8, 2.2] },
    { color: '#4a3926', op: 0.4, rate: 1 / 300, r: [1.5, 4] },
  ], detail: 'dirt' },
  stone: { tones: C.stone, pattern: 'p-stone', dark: '#45443f', light: '#c2beb0', mottle: 0.75, patches: [
    { color: '#6f7a4a', op: 0.3, rate: 1 / 1200, r: [0.8, 2.2] },
    { color: '#5a5852', op: 0.45, rate: 1 / 250, r: [2, 5] },
  ], detail: 'stone' },
  sand: { tones: C.sand, pattern: 'p-sand', dark: '#9a8058', light: '#efdcae', mottle: 0.6, grain: 0.07, patches: [
    { color: '#a78f62', op: 0.35, rate: 1 / 350, r: [2, 6] },
    { color: '#8a8a48', op: 0.3, rate: 1 / 1600, r: [0.8, 1.8] },
  ], detail: 'sand' },
  snow: { tones: C.snow, pattern: 'p-snow', dark: '#8aa3c8', light: '#ffffff', mid: '#b4c4dc', mottle: 0.7, grain: 0.04, patches: [
    { color: '#b7c4d6', op: 0.4, rate: 1 / 300, r: [2, 6] },
    { color: '#7d7a70', op: 0.35, rate: 1 / 3000, r: [0.4, 1.2] },
  ], detail: 'snow' },
  swamp: { tones: C.swamp, pattern: 'p-swamp', dark: '#11160e', light: '#6f7a44', patches: [
    { color: '#1d2a26', op: 0.7, rate: 1 / 260, r: [1.5, 4.5], sheen: true },
    { color: C.moss[1], op: 0.45, rate: 1 / 300, r: [1.5, 4] },
  ], detail: 'swamp' },
};

// Detail marks scattered across the map, batched by tone. Returns [{d, fill|stroke...}].
function details(kind, rng, W, H, b) {
  const area = W * H;
  const N = rate => Math.min(Math.round(area * rate), 9000);
  const pos = () => [rng.next() * W, rng.next() * H];
  const tuft = (x, y, n, L, tones, w = 0.12) => {
    for (let k = 0; k < n; k++) {
      const a = rng.range(-Math.PI, Math.PI), tone = rng.pick(tones);
      b.add(`f|${tone}`, bladeD(x + rng.range(-0.15, 0.15), y + rng.range(-0.15, 0.15), a, L * rng.range(0.6, 1.1), w, rng.range(-0.2, 0.2)));
    }
  };
  const pebble = (x, y, r, tone) => {
    const s = createRng(rng.int(1, 2 ** 30));
    b.add('f|#000000|0.3', D(stonePts(s.fork('a'), x + r * 0.3, y + r * 0.35, r), true));
    b.add(`f|${tone}`, D(stonePts(s.fork('a'), x, y, r), true));
    b.add('f|#ffffff|0.2', D(stonePts(s.fork('b'), x - r * 0.25, y - r * 0.3, r * 0.45), true));
  };
  if (kind === 'grass') {
    for (let i = N(0.16); i--;) { const [x, y] = pos(); tuft(x, y, rng.int(4, 7), rng.range(0.6, 1.1), [C.grass[0], shade(C.grass[0], -0.15), C.grass[2], mix(C.grass[2], '#d0c878', 0.35)]); }
    for (let i = N(1 / 160); i--;) {
      const [x, y] = pos(), tone = rng.pick(['#e8e4d0', '#e6c84a', '#b088c8', '#e8a0a0']);
      for (let k = rng.int(3, 7); k--;) b.add(`f|${tone}|0.85`, dotD(x + rng.range(-0.6, 0.6), y + rng.range(-0.6, 0.6), rng.range(0.06, 0.11)));
    }
    for (let i = N(1 / 300); i--;) { const [x, y] = pos(); pebble(x, y, rng.range(0.12, 0.3), rng.pick(C.stone)); }
  } else if (kind === 'forest') {
    for (let i = N(0.3); i--;) {
      const [x, y] = pos(), a = rng.next() * Math.PI, L = rng.range(0.2, 0.4), tone = rng.pick(leaf);
      b.add(`f|${tone}|0.85`, ellD(x, y, L, L * 0.45, a));
    }
    for (let i = N(1 / 40); i--;) {
      const [x, y] = pos(), a = rng.next() * Math.PI, L = rng.range(0.6, 1.8);
      b.add('s|#2a1f14|0.75|0.08', `M${n2(x)} ${n2(y)}q${n2(Math.cos(a) * L / 2 + 0.1)} ${n2(Math.sin(a) * L / 2)} ${n2(Math.cos(a) * L)} ${n2(Math.sin(a) * L)}`);
    }
    for (let i = N(1 / 120); i--;) { const [x, y] = pos(); tuft(x, y, rng.int(5, 9), rng.range(0.6, 1.2), [C.moss[1], C.moss[2], C.foliage[1]], 0.16); }
    for (let i = N(1 / 250); i--;) { const [x, y] = pos(); pebble(x, y, rng.range(0.15, 0.4), rng.pick(C.stone)); }
  } else if (kind === 'stone') {
    for (let i = N(1 / 30); i--;) {
      const [x, y] = pos(), r = rng.range(1, 2.8);
      const pts = stonePts(rng, x, y, r, { sides: rng.int(5, 7), squash: 0.3 });
      b.add(`f|${rng.pick([C.stone[0], C.stone[2], '#77746a'])}|0.22`, D(pts, true));
    }
    for (let i = N(1 / 35); i--;) {
      let [x, y] = pos(), a = rng.next() * 6.28, d = `M${n2(x)} ${n2(y)}`, e = `M${n2(x + 0.08)} ${n2(y + 0.08)}`;
      for (let k = rng.int(4, 10); k--;) { a += rng.range(-0.7, 0.7); x += Math.cos(a) * 0.7; y += Math.sin(a) * 0.7; d += `L${n2(x)} ${n2(y)}`; e += `L${n2(x + 0.08)} ${n2(y + 0.08)}`; }
      b.add('s|#2e2d29|0.6|0.08', d);
      b.add('s|#d6d2c6|0.3|0.05', e);
    }
    for (let i = N(1 / 18); i--;) { const [x, y] = pos(); pebble(x, y, rng.range(0.1, 0.35), rng.pick(C.stone)); }
    for (let i = N(1 / 200); i--;) { const [x, y] = pos(); tuft(x, y, rng.int(4, 7), rng.range(0.4, 0.8), [C.moss[1], C.grass[1], C.moss[2]]); }
  } else if (kind === 'dirt') {
    for (let i = N(kind === 'dirt' ? 1 / 12 : 1 / 25); i--;) { const [x, y] = pos(); pebble(x, y, rng.range(0.1, 0.32), rng.pick(kind === 'dirt' ? [C.stone[1], C.stone[2], C.dirt[2]] : C.stone)); }
    for (let i = N(1 / 60); i--;) {
      let [x, y] = pos(), a = rng.next() * 6.28, d = `M${n2(x)} ${n2(y)}`;
      for (let k = rng.int(3, 7); k--;) { a += rng.range(-0.9, 0.9); x += Math.cos(a) * 0.6; y += Math.sin(a) * 0.6; d += `L${n2(x)} ${n2(y)}`; }
      b.add(`s|${kind === 'dirt' ? '#3a2b1c' : '#33322e'}|0.5|0.07`, d);
    }
    for (let i = N(1 / 90); i--;) { const [x, y] = pos(); tuft(x, y, rng.int(4, 8), rng.range(0.5, 1), [C.grass[0], C.grass[1], C.grass[2]]); }
  } else if (kind === 'sand') {
    for (let i = N(1 / 30); i--;) {
      const [x, y] = pos(), L = rng.range(1.5, 4);
      const bow = rng.range(-0.4, 0.4);
      b.add('s|#9a8258|0.3|0.08', `M${n2(x)} ${n2(y)}q${n2(L / 2)} ${n2(bow)} ${n2(L)} 0`);
      b.add('s|#f0e0b8|0.25|0.06', `M${n2(x)} ${n2(y - 0.12)}q${n2(L / 2)} ${n2(bow)} ${n2(L)} 0`);
    }
    for (let i = N(1 / 50); i--;) { const [x, y] = pos(); pebble(x, y, rng.range(0.08, 0.2), rng.pick(['#d8ccb0', '#8a7a62', '#b8a888'])); }
    for (let i = N(1 / 600); i--;) { const [x, y] = pos(); tuft(x, y, rng.int(5, 9), rng.range(0.7, 1.3), ['#8a8a48', '#a6a060', '#6e6e3a']); }
  } else if (kind === 'snow') {
    for (let i = N(1 / 25); i--;) {
      const [x, y] = pos(), L = rng.range(1.5, 5);
      b.add('s|#a8b8cc|0.35|0.12', `M${n2(x)} ${n2(y)}q${n2(L / 2)} ${n2(rng.range(-0.3, 0.3))} ${n2(L)} 0`);
    }
    for (let i = N(0.15); i--;) { const [x, y] = pos(); b.add('f|#ffffff|0.85', dotD(x, y, rng.range(0.03, 0.07))); }
  } else if (kind === 'swamp') {
    for (let i = N(1 / 40); i--;) { const [x, y] = pos(); tuft(x, y, rng.int(5, 10), rng.range(0.8, 1.6), [C.swamp[0], C.swamp[2], '#7a8448', C.moss[1]], 0.13); }
    for (let i = N(1 / 30); i--;) { const [x, y] = pos(); b.add(`f|${rng.pick([C.moss[2], '#8a9050'])}|0.6`, dotD(x, y, rng.range(0.08, 0.2))); }
  }
}

const dotD = (x, y, r) => `M${n2(x - r)} ${n2(y)}a${n2(r)} ${n2(r)} 0 1 0 ${n2(2 * r)} 0a${n2(r)} ${n2(r)} 0 1 0 ${n2(-2 * r)} 0`;
function ellD(x, y, rx, ry, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return D([0, 1, 2, 3, 4, 5, 6, 7].map(i => { const t = i * Math.PI / 4; return [x + Math.cos(t) * rx * c - Math.sin(t) * ry * s, y + Math.cos(t) * rx * s + Math.sin(t) * ry * c]; }), true);
}

// Turbulence -> single colour with noise-driven alpha (contrast k around threshold t).
function noiseFilter(doc, id, box, { freq, oct, seed, color, k, t, type = 'fractalNoise' }) {
  const [r, g, b] = hexToRgb(color).map(v => n2(v / 255));
  return filterEl(doc, id, box, [
    h('feTurbulence', { type, baseFrequency: freq, numOctaves: oct, seed, result: 'n' }, [], doc),
    h('feColorMatrix', { in: 'n', type: 'matrix', values: `0 0 0 0 ${r} 0 0 0 0 ${g} 0 0 0 0 ${b} ${k} 0 0 0 ${n2(-k * t)}` }, [], doc),
  ]);
}

export function renderTerrain(scene, ctx) {
  const doc = ctx.doc;
  const W = scene.grid.widthFt, H = scene.grid.heightFt;
  const base = BASES[scene.terrain.base] || BASES.grass;
  const v = scene.terrain.variation ?? 0.5;
  const rng = createRng(scene.seed >>> 0).fork('terrain');
  const box = { x: 0, y: 0, w: W, h: H };
  // Scene-specific ids, so several maps can share one HTML document without filter clashes.
  const T = `t${hash32(JSON.stringify([scene.terrain, W, H, scene.seed])).toString(36)}-`;
  const s = () => rng.int(1, 9000);
  const local = [
    noiseFilter(doc, `${T}mottle-dark`, box, { freq: 0.02, oct: 4, seed: s(), color: base.dark, k: 4.5, t: 0.5 }),
    noiseFilter(doc, `${T}mottle-light`, box, { freq: 0.03, oct: 4, seed: s(), color: base.light, k: 4.5, t: 0.56 }),
    noiseFilter(doc, `${T}mottle-mid`, box, { freq: 0.09, oct: 3, seed: s(), color: base.mid || base.tones[0], k: 3.5, t: 0.5 }),
    noiseFilter(doc, `${T}grain`, box, { freq: 0.9, oct: 2, seed: s(), color: '#000000', k: 3, t: 0.42 }),
    filterEl(doc, `${T}patch-blur`, null, [h('feGaussianBlur', { stdDeviation: 0.9 }, [], doc)]),
  ];
  // Patch blur needs a region larger than any patch; objectBoundingBox margins.
  local[4].setAttribute('filterUnits', 'objectBoundingBox');
  for (const [k, val] of [['x', -0.5], ['y', -0.5], ['width', 2], ['height', 2]]) local[4].setAttribute(k, String(val));

  const rect = (attrs) => h('rect', { x: 0, y: 0, width: W, height: H, ...attrs }, [], doc);
  const kids = [h('defs', {}, local, doc), rect({ fill: base.tones[1] }), rect({ fill: `url(#${base.pattern})`, opacity: 0.9 })];
  const ms = base.mottle ?? 1;
  kids.push(rect({ fill: '#000', filter: `url(#${T}mottle-mid)`, opacity: n2((0.25 + 0.35 * v) * ms) }));
  kids.push(rect({ fill: '#000', filter: `url(#${T}mottle-dark)`, opacity: n2((0.25 + 0.5 * v) * ms) }));
  kids.push(rect({ fill: '#000', filter: `url(#${T}mottle-light)`, opacity: n2((0.2 + 0.5 * v) * ms) }));

  // Mid-scale patches, blurred into the ground.
  const pr = rng.fork('patches'), area = W * H;
  const patchKids = [];
  for (const p of base.patches) {
    const n = Math.min(400, Math.round(area * p.rate * (0.5 + v)));
    let d = '', sheen = '';
    for (let i = 0; i < n; i++) {
      const x = pr.next() * W, y = pr.next() * H, r = pr.range(p.r[0], p.r[1]);
      d += blobD(pr, x, y, r, r * pr.range(0.5, 1));
      if (p.sheen) sheen += `M${n2(x - r * 0.4)} ${n2(y - r * 0.15)}q${n2(r * 0.3)} -0.15 ${n2(r * 0.6)} 0`;
    }
    if (d) patchKids.push(h('path', { d, fill: p.color, opacity: p.op, filter: `url(#${T}patch-blur)` }, [], doc));
    if (sheen) patchKids.push(h('path', { d: sheen, fill: 'none', stroke: '#9fb4b4', 'stroke-width': 0.1, 'stroke-linecap': 'round', opacity: 0.22 }, [], doc));
  }
  kids.push(h('g', { 'data-part': 'patches' }, patchKids, doc));

  // Detail marks (seeded over the whole map, so nothing repeats).
  const b = strokeBatch();
  details(base.detail, rng.fork('detail'), W, H, b);
  const dk = [];
  for (const key of b.keys()) {
    const [kind, color, op, sw] = key.split('|');
    dk.push(kind === 's'
      ? h('path', { d: b.get(key), fill: 'none', stroke: color, 'stroke-width': sw, 'stroke-linecap': 'round', opacity: op }, [], doc)
      : h('path', { d: b.get(key), fill: color, opacity: op ?? 0.9 }, [], doc));
  }
  kids.push(h('g', { 'data-part': 'detail' }, dk, doc));
  kids.push(rect({ fill: '#000', filter: `url(#${T}grain)`, opacity: base.grain ?? 0.16 }));
  if (scene.terrain.tint) kids.push(rect({ fill: scene.terrain.tint, opacity: 0.35, style: 'mix-blend-mode:color' }));
  return h('g', { 'data-layer': 'terrain', 'pointer-events': 'none' }, kids, doc);
}

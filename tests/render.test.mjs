// Run: node --test tests/render.test.mjs
// Renderer tests that need no browser: light/shadow math, layer structure, determinism,
// generator error isolation, path helpers. Uses a tiny hand-written fake DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkScene } from '../src/schema.js';
import { renderScene, lightOf, shadowOffset, LAYER_ORDER } from '../src/render/index.js';
import { GENERATORS } from '../src/generators/index.js';
import { PATTERN_IDS, FILTER_IDS } from '../src/render/defs.js';
import { PALETTE } from '../src/render/palette.js';
import { densify, wobble, normals, bandD, noise1 } from '../src/render/paint.js';
import { createRng } from '../src/core/rng.js';

// ---- fake DOM ----
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
class Node {
  constructor(tag, text) { this.tagName = tag; this.text = text; this.attrs = new Map(); this.childNodes = []; this.parentNode = null; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  setAttributeNS(ns, k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  appendChild(c) { return this.insertBefore(c, null); }
  insertBefore(c, ref) {
    c.parentNode?.removeChild(c);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c);
    c.parentNode = this;
    return c;
  }
  removeChild(c) { this.childNodes.splice(this.childNodes.indexOf(c), 1); c.parentNode = null; return c; }
  remove() { this.parentNode?.removeChild(this); }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get children() { return this.childNodes.filter(c => c.tagName); }
  set textContent(t) { this.childNodes = [new Node(null, t)]; }
  get textContent() { return this.text ?? this.childNodes.map(c => c.textContent).join(''); }
  get outerHTML() {
    if (!this.tagName) return esc(this.text);
    const a = [...this.attrs].map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
    return `<${this.tagName}${a}>${this.childNodes.map(c => c.outerHTML).join('')}</${this.tagName}>`;
  }
  *walk() { yield this; for (const c of this.childNodes) yield* c.walk(); }
}
const fakeDoc = () => ({ createElementNS: (ns, tag) => new Node(tag), createTextNode: t => new Node(null, t) });

const load = name => checkScene(JSON.parse(readFileSync(new URL(`../samples/${name}.json`, import.meta.url), 'utf8'))).scene;
const quiet = fn => { const e = console.error; console.error = () => {}; try { return fn(); } finally { console.error = e; } };

test('light: shadowDir points away from the azimuth', () => {
  const near = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9, `${a} vs ${b}`));
  near(lightOf({ lighting: { azimuth: 0, intensity: 1, time: 'day' } }).shadowDir, [0, 1]);   // from north -> south
  near(lightOf({ lighting: { azimuth: 90, intensity: 1, time: 'day' } }).shadowDir, [-1, 0]); // from east -> west
  near(lightOf({ lighting: { azimuth: 315, intensity: 1, time: 'day' } }).shadowDir, [Math.SQRT1_2, Math.SQRT1_2]);
});

test('shadow offset: height / tan(elevation), capped, rotated into the local frame', () => {
  const L = lightOf({ lighting: { azimuth: 0, elevation: 45, intensity: 1, time: 'day' } });
  const [x, y] = shadowOffset(L, { rotation: 0 }, 10);
  assert.ok(Math.abs(x) < 1e-9 && Math.abs(y - 10) < 1e-9);
  const low = lightOf({ lighting: { azimuth: 0, elevation: 10, intensity: 1, time: 'day' } });
  assert.ok(Math.abs(shadowOffset(low, { rotation: 0 }, 10)[1] - 20) < 1e-9, 'capped at 2 * height');
  const [rx, ry] = shadowOffset(L, { rotation: 90 }, 10); // world south == local -x after a 90 deg cw rotation
  assert.ok(Math.abs(rx - 10) < 1e-9 || Math.abs(rx + 10) < 1e-9);
  assert.ok(Math.abs(ry) < 1e-9);
  // Rotating the local offset back by +rotation must give the world offset (0, 10).
  const r = Math.PI / 2, wx = rx * Math.cos(r) - ry * Math.sin(r), wy = rx * Math.sin(r) + ry * Math.cos(r);
  assert.ok(Math.abs(wx) < 1e-9 && Math.abs(wy - 10) < 1e-9);
});

test('palette: every contract key is a 3-tone #rrggbb array', () => {
  for (const k of ['grass', 'foliage', 'pine', 'bark', 'wood', 'woodDark', 'stone', 'dirt', 'water', 'cloth', 'fire', 'thatch', 'slate']) {
    assert.equal(PALETTE[k].length, 3, k);
    for (const c of PALETTE[k]) assert.match(c, /^#[0-9a-f]{6}$/);
  }
});

for (const name of ['forest-road-ambush', 'riverside-ruin']) {
  test(`renderScene ${name}: layer order, element groups, shared defs`, () => {
    const scene = load(name);
    const svg = quiet(() => renderScene(scene, { doc: fakeDoc() }));
    assert.equal(svg.getAttribute('viewBox'), `0 0 ${scene.grid.widthFt} ${scene.grid.heightFt}`);
    const kids = svg.children;
    assert.equal(kids[0].tagName, 'defs');
    assert.deepEqual(kids.slice(1).map(k => k.getAttribute('data-layer')), LAYER_ORDER);
    const ids = new Set([...svg.walk()].map(n => n.getAttribute?.('id')).filter(Boolean));
    for (const id of [...FILTER_IDS, ...PATTERN_IDS]) assert.ok(ids.has(id), `missing def ${id}`);
    const groups = [...svg.walk()].filter(n => n.getAttribute?.('class') === 'el');
    const total = scene.regions.length + scene.paths.length + scene.objects.length + scene.labels.length;
    assert.equal(groups.length, total);
    for (const g of groups) {
      assert.match(g.getAttribute('transform'), /^translate\(-?[\d.]+ -?[\d.]+\) rotate\(-?[\d.]+\)$/);
      assert.equal(g.parentNode.getAttribute('data-layer'), g.getAttribute('data-layer'));
    }
    // Every map layer is clipped to the map rect.
    const clip = [...svg.walk()].find(n => n.tagName === 'clipPath' && n.getAttribute('id') === `map-clip-${scene.grid.widthFt}x${scene.grid.heightFt}`);
    assert.equal(clip.children[0].getAttribute('width'), String(scene.grid.widthFt));
    for (const k of kids.slice(1)) assert.equal(k.getAttribute('clip-path'), `url(#${clip.getAttribute('id')})`);
    // Within a layer: regions, paths, objects, labels.
    const ground = kids.find(k => k.getAttribute('data-layer') === 'ground').children.map(g => g.getAttribute('data-id'));
    const order = [...scene.regions, ...scene.paths, ...scene.objects, ...scene.labels].filter(e => e.layer === 'ground').map(e => e.id);
    assert.deepEqual(ground, order);
  });

  test(`renderScene ${name}: deterministic`, () => {
    const scene = load(name);
    const a = quiet(() => renderScene(scene, { doc: fakeDoc() }).outerHTML);
    const b = quiet(() => renderScene(structuredClone(scene), { doc: fakeDoc() }).outerHTML);
    assert.equal(a, b);
    assert.ok(!/NaN|undefined|Infinity/.test(a), 'no NaN/undefined in output');
  });
}

test('hidden layers are omitted; opts.grid overrides scene.grid.visible', () => {
  const scene = load('riverside-ruin');
  const svg = quiet(() => renderScene(scene, { doc: fakeDoc(), layers: { lighting: false, canopy: false }, grid: false }));
  const names = svg.children.slice(1).map(k => k.getAttribute('data-layer'));
  assert.deepEqual(names, ['terrain', 'ground', 'low', 'objects', 'labels']);
});

test('a throwing generator becomes a red dashed placeholder', () => {
  const scene = load('riverside-ruin');
  const orig = GENERATORS.boulder.render;
  GENERATORS.boulder.render = () => { throw new Error('boom'); };
  try {
    const svg = quiet(() => renderScene(scene, { doc: fakeDoc() }));
    const g = [...svg.walk()].find(n => n.getAttribute?.('data-id') === 'boulder-1');
    assert.equal(g.children[0].getAttribute('data-error'), 'generator');
    assert.ok(g.children[0].getAttribute('stroke-dasharray'));
  } finally { GENERATORS.boulder.render = orig; }
});

test('my generators: every terrain base / material / option renders without NaN', () => {
  const base = load('riverside-ruin');
  const mats = ['dirt', 'mud', 'sand', 'gravel', 'stone-floor', 'moss', 'crops', 'grass'];
  const poly = [[0, 0], [20, 2], [24, 18], [6, 22], [-3, 10]];
  for (const terrain of ['grass', 'forest-floor', 'dirt', 'stone', 'sand', 'snow', 'swamp']) {
    const s = structuredClone(base);
    s.terrain.base = terrain;
    s.regions = [
      ...mats.map((m, i) => ({ id: `g-${i}`, type: 'ground', position: { x: 30, y: 30 }, params: { points: poly, material: m } })),
      { id: 'pond-a', type: 'pond', position: { x: 60, y: 60 }, params: { points: poly, depth: 'deep', reeds: true } },
      { id: 'pond-b', type: 'pond', position: { x: 60, y: 20 }, params: { points: poly } },
      { id: 'rub-a', type: 'rubble', position: { x: 20, y: 80 }, params: { points: poly, stone: 'mossy', density: 1 } },
      { id: 'tg-a', type: 'tall-grass', position: { x: 80, y: 80 }, params: { points: poly, density: 1 } },
    ];
    s.paths = [
      { id: 'road-a', type: 'road', position: { x: 0, y: 0 }, params: { points: [[0, 10], [50, 12]], width: 10, surface: 'cobble' } },
      { id: 'road-b', type: 'road', position: { x: 0, y: 0 }, params: { points: [[10, 10], [50, 12], [40, 40]], width: 8, surface: 'gravel', closed: true } },
      { id: 'cliff-a', type: 'cliff-edge', position: { x: 0, y: 0 }, params: { points: [[5, 100], [60, 95], [110, 104]], width: 6, lowSide: 'left' } },
      { id: 'cliff-b', type: 'cliff-edge', position: { x: 50, y: 50 }, params: { points: [[0, 0], [20, 0], [20, 20], [0, 20]], width: 4, closed: true } },
      { id: 'stream-a', type: 'stream', position: { x: 0, y: 0 }, params: { points: [[0, 60], [120, 70]], width: 20, depth: 'deep' } },
      { id: 'stream-b', type: 'stream', position: { x: 0, y: 0 }, params: { points: [[3, 3], [4, 4]], width: 1 } },
    ];
    s.objects = []; s.labels = []; s.constraints = [];
    const res = checkScene(s);
    assert.ok(res.ok, JSON.stringify(res.errors));
    let errs = 0;
    const e = console.error; console.error = () => { errs++; };
    let out;
    try { out = renderScene(res.scene, { doc: fakeDoc() }).outerHTML; } finally { console.error = e; }
    assert.equal(errs, 0, `generator errors for terrain ${terrain}`);
    assert.ok(!/NaN|undefined|Infinity/.test(out), `bad number for terrain ${terrain}`);
  }
});

test('paint helpers: densify passes through points, wobble pins open ends, band is closed', () => {
  const pts = [[0, 0], [10, 0], [20, 5]];
  const dense = densify(pts, false, 0.5);
  assert.deepEqual(dense[0], [0, 0]);
  assert.deepEqual(dense[dense.length - 1], [20, 5]);
  assert.ok(dense.some(p => Math.abs(p[0] - 10) < 1e-9 && Math.abs(p[1]) < 1e-9));
  const w = wobble(pts, createRng(5), { amp: 2, wavelength: 6 });
  assert.ok(Math.hypot(w[0][0], w[0][1]) < 1e-9 && Math.hypot(w.at(-1)[0] - 20, w.at(-1)[1] - 5) < 1e-9);
  const nm = normals([[0, 0], [10, 0]]);
  assert.deepEqual(nm[0].map(v => v + 0), [0, -1]); // heading east, left is north
  assert.match(bandD([[0, 0], [10, 0]], nm, 0, 2), /^M.*Z$/);
  const nz = noise1(createRng(1), 5, 50);
  assert.ok(Math.abs(nz(0) - nz(50)) < 1e-9, 'periodic noise wraps');
});

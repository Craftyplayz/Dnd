// Run: node --test tests/generators.test.mjs
// Object generators (agent 2): determinism, no-throw across every enum value and param
// extreme, finite output, and only contract-listed def references. Uses a tiny fake DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TYPES, normalizeElement } from '../src/schema.js';
import { createRng } from '../src/core/rng.js';
import tree from '../src/generators/tree.js';
import bush from '../src/generators/bush.js';
import boulder from '../src/generators/boulder.js';
import rockCluster from '../src/generators/rock-cluster.js';
import wagon from '../src/generators/wagon.js';
import crate from '../src/generators/crate.js';
import barrel from '../src/generators/barrel.js';
import tent from '../src/generators/tent.js';
import campfire from '../src/generators/campfire.js';
import building from '../src/generators/building.js';
import bridge from '../src/generators/bridge.js';
import ruinedWall from '../src/generators/ruined-wall.js';
import fence from '../src/generators/fence.js';
import label from '../src/generators/label.js';

const GENS = [tree, bush, boulder, rockCluster, wagon, crate, barrel, tent, campfire, building, bridge, ruinedWall, fence, label];

// ---- fake DOM ----
class Node {
  constructor(tag, text) { this.tag = tag; this.text = text; this.attrs = new Map(); this.children = []; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.get(k) ?? null; }
  appendChild(c) { this.children.push(c); return c; }
}
const doc = { createElementNS: (ns, tag) => new Node(tag), createTextNode: t => new Node('#text', t) };
const ser = n => (n.tag === '#text' ? n.text : `<${n.tag}${[...n.attrs].map(([k, v]) => ` ${k}="${v}"`).join('')}>${n.children.map(ser).join('')}</${n.tag}>`);

const SHARED = ['f-shadow', 'f-shadow-wide', 'f-rough', 'f-grain', 'f-soft-edge'];
function makeCtx(light = { azimuth: 315, elevation: 45, intensity: 0.6, time: 'day' }) {
  const defs = new Map();
  const az = (light.azimuth * Math.PI) / 180, sd = [-Math.sin(az), Math.cos(az)];
  return {
    doc, scene: {}, defs,
    light: { ...light, shadowDir: sd },
    shadow(el, hFt) {
      const d = Math.min(hFt / Math.tan((light.elevation * Math.PI) / 180), 2 * hFt), r = (-(el.rotation || 0) * Math.PI) / 180;
      const x = sd[0] * d, y = sd[1] * d;
      return [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)];
    },
    def(id, build) { if (!defs.has(id)) { const n = build(); n.setAttribute('id', id); defs.set(id, n); } return `url(#${id})`; },
  };
}

let n = 0;
function make(type, params = {}, size, extra = {}) {
  const def = TYPES[type];
  const el = { id: `t-${n++}`, type, name: type, position: { x: 50, y: 50 }, rotation: 0, params: structuredClone(params), ...extra };
  if (size) el.size = size;
  else if (def.sizeFt) el.size = { w: def.sizeFt.typical[0], h: def.sizeFt.typical[1] };
  else el.size = { w: 1, h: 1 };
  return normalizeElement(el, 7);
}
const render = (el, ctx = makeCtx()) => { const g = GENS.find(x => x.type === el.type); return ser(g.render(el, createRng(el.seed), ctx)); };

// All enum combinations (cartesian over enum/boolean params), each at min, typical and max size.
function variants(type) {
  const props = TYPES[type].params?.properties || {};
  let combos = [{}];
  for (const [k, s] of Object.entries(props)) {
    const vals = s.enum || (s.type === 'boolean' ? [false, true] : null);
    if (!vals) continue;
    combos = combos.flatMap(c => vals.map(v => ({ ...c, [k]: v })));
  }
  // numeric extremes
  const nums = Object.entries(props).filter(([, s]) => s.type === 'number' || s.type === 'integer');
  const out = [];
  combos.forEach((c, i) => {
    const pick = i % 3 === 0 ? 'minimum' : i % 3 === 1 ? 'maximum' : 'default';
    const p = { ...c };
    for (const [k, s] of nums) if (s[pick] !== undefined) p[k] = s[pick];
    out.push(p);
  });
  return out;
}
const PATH_POINTS = [[[0, 0], [20, 0], [25, 10]], [[0, 0], [0, 0]], [[0, 0], [10, 0], [10, 10], [0, 10]], [[0, 0], [0.2, 0.1]]];

test('generator type names match files and schema', () => {
  for (const g of GENS) { assert.ok(TYPES[g.type], g.type); assert.equal(typeof g.render, 'function'); }
});

for (const g of GENS) {
  const def = TYPES[g.type];
  test(`${g.type}: never throws, finite output, allowed defs`, () => {
    const sizes = def.sizeFt ? [def.sizeFt.min, def.sizeFt.typical, def.sizeFt.max].map(([w, h]) => ({ w, h })) : [null];
    let count = 0;
    for (const p of variants(g.type)) {
      for (const size of sizes) {
        const extras = def.kind === 'path' ? PATH_POINTS.map(points => ({ ...p, points, width: p.width ?? def.widthFt?.typical ?? 1 })) : def.kind === 'label' ? [{ ...p, text: 'Ruined Watchtower' }, { ...p, text: 'x' }] : [p];
        for (const params of extras) {
          for (const closed of def.kind === 'path' ? [false, true] : [undefined]) {
            const pp = closed === undefined ? params : { ...params, closed };
            const el = make(g.type, pp, size, { rotation: (count * 37) % 360 });
            const ctx = makeCtx({ azimuth: (count * 53) % 360, elevation: 5 + (count % 9) * 10, intensity: (count % 5) / 4, time: 'day' });
            const out = render(el, ctx);
            assert.ok(!/NaN|Infinity|undefined/.test(out), `${g.type} ${JSON.stringify(pp)} produced non-finite output`);
            for (const m of out.matchAll(/url\(#([^)]+)\)/g)) {
              const id = m[1];
              assert.ok(SHARED.includes(id) || id.startsWith('p-') || id.startsWith(`g-${g.type}-`), `${g.type} references unknown def #${id}`);
            }
            count++;
          }
        }
      }
    }
    assert.ok(count > 0);
  });

  test(`${g.type}: deterministic`, () => {
    const params = def.kind === 'path' ? { points: PATH_POINTS[0], width: def.widthFt.typical } : def.kind === 'label' ? { text: 'Camp' } : {};
    const a = make(g.type, params), b = structuredClone(a);
    b.id = a.id; // same element twice
    assert.equal(render(a), render(b));
  });
}

test('every tree differs by seed; species are distinct', () => {
  for (const species of TYPES.tree.params.properties.species.enum) {
    const a = make('tree', { species }, { w: 20, h: 20 }, { seed: 1 }), b = make('tree', { species }, { w: 20, h: 20 }, { seed: 2 });
    assert.notEqual(render(a), render(b), species);
  }
  const outs = TYPES.tree.params.properties.species.enum.map(species => render(make('tree', { species }, { w: 20, h: 20 }, { seed: 5 })));
  assert.equal(new Set(outs).size, outs.length);
});

test('building ruin removes the roof and doors appear as openings', () => {
  const intact = render(make('building', { ruined: 0, roof: 'slate' }, { w: 30, h: 20 }, { seed: 3 }));
  const ruin = render(make('building', { ruined: 1, roof: 'slate' }, { w: 30, h: 20 }, { seed: 3 }));
  assert.notEqual(intact, ruin);
  // the ruin has no roof clip and no roof-coloured footprint; holed roof uses a per-element clip id
  const holed = render(make('building', { ruined: 0.25, roof: 'slate' }, { w: 30, h: 20 }, { id: 'house-a', seed: 3 }));
  assert.match(holed, /clip-path="url\(#g-building-house-a-roof\)"/);
});

test('shadow uses the contract filter and light-dependent offset', () => {
  const el = make('boulder', {}, { w: 5, h: 4 }, { seed: 9 });
  const a = render(el, makeCtx({ azimuth: 315, elevation: 45, intensity: 0.6, time: 'day' }));
  const b = render(el, makeCtx({ azimuth: 135, elevation: 45, intensity: 0.6, time: 'day' }));
  assert.match(a, /filter="url\(#f-shadow\)"/);
  assert.notEqual(a, b);
});

test('building doors: every side, extreme offsets, round and tiny footprints', () => {
  const doors = ['n', 'e', 's', 'w'].flatMap(side => [{ side, offsetFt: -100 }, { side, offsetFt: 100 }]).slice(0, 6);
  for (const shape of ['rect', 'round']) for (const size of [{ w: 8, h: 8 }, { w: 80, h: 12 }]) for (const ruined of [0, 0.5, 1]) {
    const out = render(make('building', { shape, doors, ruined, roof: 'none' }, size));
    assert.ok(!/NaN|Infinity/.test(out));
  }
  assert.doesNotThrow(() => render(make('building', { doors: [] }, { w: 20, h: 20 })));
});

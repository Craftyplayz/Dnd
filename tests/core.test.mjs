// Run: node --test tests/
// Core contract tests: shared validator/patch cases, geometry, rng, store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkScene, hash32, findElement } from '../src/schema.js';
import { applyPatch, touchedIds } from '../src/core/patch.js';
import { distanceFt, overlaps, footprintOf, snapPosition, shapeOf, gap } from '../src/core/geom.js';
import { createRng } from '../src/core/rng.js';
import { createStore } from '../src/core/store.js';
import { createBus } from '../src/core/bus.js';

const load = name => JSON.parse(readFileSync(new URL(`../samples/${name}.json`, import.meta.url), 'utf8'));
const { cases, hash32: vectors } = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));

for (const c of cases) {
  test(`case: ${c.name}`, () => {
    const base = checkScene(load(c.base));
    assert.ok(base.ok, 'base sample must be valid');
    let next;
    try { next = applyPatch(base.scene, c.ops); } catch (e) {
      assert.equal(c.patch, 'error', `unexpected patch error: ${e.message}`);
      return;
    }
    assert.equal(c.patch, 'ok', 'patch should have failed');
    const res = checkScene(next);
    assert.equal(res.ok, c.valid, JSON.stringify(res.errors));
  });
}

test('hash32 vectors', () => {
  for (const v of vectors) assert.equal(hash32(v.input), v.output);
});

test('patch is all-or-nothing and does not mutate input', () => {
  const s = checkScene(load('riverside-ruin')).scene;
  const before = JSON.stringify(s);
  assert.throws(() => applyPatch(s, [{ op: 'replace', path: '/meta/name', value: 'X' }, { op: 'remove', path: '/objects/ghost' }]));
  applyPatch(s, [{ op: 'replace', path: '/meta/name', value: 'Y' }]);
  assert.equal(JSON.stringify(s), before);
});

test('removing an element removes constraints that reference it', () => {
  const s = checkScene(load('riverside-ruin')).scene;
  const next = applyPatch(s, [{ op: 'remove', path: '/paths/stream' }]);
  assert.equal(next.constraints.length, 0);
});

test('touchedIds', () => {
  const s = checkScene(load('riverside-ruin')).scene;
  assert.deepEqual(touchedIds(s, [{ op: 'replace', path: '/objects/campfire/params/lit', value: true }, { op: 'add', path: '/objects/-', value: { id: 'new-1' } }, { op: 'replace', path: '/terrain/base', value: 'snow' }]), ['campfire', 'new-1']);
});

test('sample constraints hold to 0.05 ft', () => {
  for (const name of ['riverside-ruin', 'forest-road-ambush']) {
    const s = checkScene(load(name)).scene;
    for (const c of s.constraints) {
      const d = distanceFt(findElement(s, c.a).el, findElement(s, c.b).el, c.measure);
      assert.ok(Math.abs(d - c.ft) <= 0.05, `${name} ${c.id}: ${d}`);
    }
  }
});

test('geometry basics', () => {
  const mk = (type, x, y, w, h, rotation = 0, params = {}) => ({ id: 'a', type, position: { x, y }, rotation, size: { w, h }, params });
  // two 10x5 wagons side by side with a 20 ft gap
  assert.equal(distanceFt(mk('wagon', 0, 0, 10, 5), mk('wagon', 30, 0, 10, 5)), 20);
  assert.equal(distanceFt(mk('wagon', 0, 0, 10, 5), mk('wagon', 30, 0, 10, 5), 'center'), 30);
  // rotated 90: long axis vertical, edge gap = 30 - 2.5 - 5
  assert.ok(Math.abs(distanceFt(mk('wagon', 0, 0, 10, 5, 90), mk('wagon', 30, 0, 10, 5)) - 22.5) < 1e-9);
  // circle vs circle
  assert.equal(distanceFt(mk('barrel', 0, 0, 2, 2), mk('barrel', 10, 0, 2, 2)), 8);
  // touching rects do not overlap, crossing ones do
  assert.equal(overlaps(footprintOf(mk('crate', 0, 0, 2, 2)), footprintOf(mk('crate', 2, 0, 2, 2))), false);
  assert.equal(overlaps(footprintOf(mk('crate', 0, 0, 2, 2)), footprintOf(mk('crate', 1.5, 0, 2, 2))), true);
  assert.equal(overlaps(footprintOf(mk('crate', 0, 0, 2, 2)), footprintOf(mk('crate', 1, 1, 2, 2, 45))), true);
  // path: point 10 ft from a 4 ft wide road centreline -> 8 ft edge gap minus barrel radius 1
  const road = { id: 'r', type: 'road', position: { x: 0, y: 0 }, rotation: 0, size: { w: 1, h: 1 }, params: { points: [[0, 0], [100, 0]], width: 4 } };
  assert.equal(distanceFt(road, mk('barrel', 50, 10, 2, 2)), 7);
  assert.equal(gap(shapeOf(road), shapeOf(mk('barrel', 50, 1, 2, 2))), 0);
  // snap: 10x5 wagon corner on grid
  assert.deepEqual(snapPosition(mk('wagon', 0, 0, 10, 5), { x: 13, y: 9 }), { x: 15, y: 7.5 });
});

test('rng is deterministic and forks are independent', () => {
  const a = createRng(42), b = createRng(42);
  const xs = Array.from({ length: 5 }, () => a.next());
  assert.deepEqual(xs, Array.from({ length: 5 }, () => b.next()));
  assert.equal(createRng(42).fork('leaves').next(), createRng(42).fork('leaves').next());
  assert.notEqual(createRng(42).fork('leaves').next(), createRng(42).fork('bark').next());
});

test('store: commit validates, undo/redo restore', () => {
  const bus = createBus();
  const events = [];
  bus.on('scene:changed', e => events.push(e.source));
  const store = createStore(load('riverside-ruin'), bus);
  assert.equal(store.commit([{ op: 'replace', path: '/objects/campfire/params/lit', value: 'yes' }]).ok, false);
  assert.equal(store.commit([{ op: 'replace', path: '/objects/campfire/params/lit', value: true }], { label: 'light fire' }).ok, true);
  assert.equal(findElement(store.get(), 'campfire').el.params.lit, true);
  assert.ok(store.undo());
  assert.equal(findElement(store.get(), 'campfire').el.params.lit, false);
  assert.ok(store.redo());
  assert.equal(findElement(store.get(), 'campfire').el.params.lit, true);
  assert.deepEqual(events, ['edit', 'undo', 'redo']);
});

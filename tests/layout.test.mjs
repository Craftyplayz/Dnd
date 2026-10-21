// Run: node --test tests/layout.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { layoutScene, checkScene, neighbours, summarizeScene } from '../src/layout/index.js';
import { checkScene as validate, findElement } from '../src/schema.js';
import { distanceFt, overlaps, footprintOf } from '../src/core/geom.js';

const load = name => JSON.parse(readFileSync(new URL(`../samples/${name}.json`, import.meta.url), 'utf8'));
const el = (s, id) => findElement(s, id).el;
const errors = r => r.items.filter(i => i.level === 'error');
const kinds = (r, kind, level) => r.items.filter(i => i.kind === kind && (!level || i.level === level));

const blank = (extra = {}) => ({
  meta: { name: 'Test', version: 1 }, grid: { cellFt: 5, widthFt: 100, heightFt: 100, visible: true },
  terrain: { base: 'grass' }, lighting: { azimuth: 315, intensity: 0.6, time: 'day' }, seed: 3,
  regions: [], paths: [], objects: [], labels: [], constraints: [], ...extra,
});
const obj = (id, type, x, y, w, h, more = {}) => ({ id, type, name: id, position: { x, y }, rotation: 0, size: { w, h }, params: {}, ...more });

test('samples report ok and layout leaves them alone', () => {
  for (const name of ['riverside-ruin', 'forest-road-ambush']) {
    const s = load(name);
    const r = checkScene(s);
    assert.ok(r.ok, JSON.stringify(errors(r)));
    assert.equal(r.stats.lanes.westEast && r.stats.lanes.northSouth, true);
    assert.ok(r.stats.coverPct >= 60);
    const L = layoutScene(s);
    assert.deepEqual(L.report.moved, []);
    assert.ok(validate(L.scene).ok);
  }
});

test('constraint becomes exact (object, moved along direction)', () => {
  const s = load('forest-road-ambush');
  el(s, 'wagon-rear').position.x = 30;
  const { scene, report } = layoutScene(s);
  const a = el(scene, 'wagon-wreck'), b = el(scene, 'wagon-rear');
  assert.ok(Math.abs(distanceFt(a, b) - 20) <= 0.01);
  assert.equal(b.position.y, 50); // moved only along west
  assert.ok(b.position.x < a.position.x);
  assert.ok(report.moved.some(m => m.id === 'wagon-rear' && m.reason === 'constraint c-wagons'));
  assert.equal(kinds(report, 'constraint')[0].level, 'ok');
  assert.match(kinds(report, 'constraint')[0].message, /^Second wagon is 20\.0 ft west of Overturned wagon \(stated 20 ft\)$/);
});

test('constraint picks the stated side when b starts on the wrong side', () => {
  const s = load('forest-road-ambush');
  el(s, 'wagon-rear').position.x = 120;
  const { scene, report } = layoutScene(s);
  const a = el(scene, 'wagon-wreck'), b = el(scene, 'wagon-rear');
  assert.ok(Math.abs(distanceFt(a, b) - 20) <= 0.01);
  assert.ok(b.position.x < a.position.x, `b at ${b.position.x}`);
  assert.equal(kinds(report, 'constraint')[0].level, 'ok');
});

test('constraint on a path b (stream moved off)', () => {
  const s = load('riverside-ruin');
  el(s, 'stream').position.x = 9;
  const { scene, report } = layoutScene(s);
  assert.ok(Math.abs(distanceFt(el(scene, 'watchtower'), el(scene, 'stream')) - 30) <= 0.01);
  assert.equal(el(scene, 'watchtower').position.x, 40.78); // anchor never moves
  assert.ok(report.moved.some(m => m.id === 'stream'));
});

test('center measure and direction any; ft 0 touching', () => {
  const s = blank({
    objects: [obj('a', 'boulder', 20, 20, 4, 4), obj('b', 'boulder', 50, 60, 4, 4), obj('c', 'crate', 80, 80, 3, 3), obj('d', 'crate', 81, 70, 3, 3)],
    constraints: [
      { id: 'c1', kind: 'distance', a: 'a', b: 'b', ft: 25, measure: 'center', direction: 'any' },
      { id: 'c2', kind: 'distance', a: 'c', b: 'd', ft: 0, direction: 'north' },
    ],
  });
  const { scene, report } = layoutScene(s);
  assert.ok(Math.abs(distanceFt(el(scene, 'a'), el(scene, 'b'), 'center') - 25) <= 0.01);
  assert.ok(Math.abs(distanceFt(el(scene, 'c'), el(scene, 'd')) - 0) <= 0.01);
  assert.ok(el(scene, 'd').position.y < el(scene, 'c').position.y);
  assert.equal(el(scene, 'd').position.x, 80); // aligned on the line north of c
  assert.equal(overlaps(footprintOf(el(scene, 'c')), footprintOf(el(scene, 'd'))), false); // touching, not inside
  assert.ok(report.ok, JSON.stringify(errors(report)));
});

test('locked b is not moved and is reported', () => {
  const s = blank({
    objects: [obj('a', 'boulder', 20, 20, 4, 4), obj('b', 'boulder', 60, 20, 4, 4, { locked: true })],
    constraints: [{ id: 'c1', kind: 'distance', a: 'a', b: 'b', ft: 10, direction: 'east' }],
  });
  const { scene, report } = layoutScene(s);
  assert.equal(el(scene, 'b').position.x, 60);
  assert.equal(kinds(report, 'constraint')[0].level, 'error');
  assert.equal(report.ok, false);
});

test('overlaps resolved: later non-pinned object moves, pinned ones stay', () => {
  const s = blank({
    objects: [obj('rock-a', 'boulder', 50, 50, 5, 5), obj('rock-b', 'boulder', 51, 50, 5, 5), obj('tree-a', 'tree', 20, 20, 20, 20),
      obj('barrel-a', 'barrel', 21, 20, 2.5, 2.5, { locked: true })],
  });
  const before = checkScene(s);
  assert.equal(kinds(before, 'collision').length, 2);
  const { scene, report } = layoutScene(s);
  assert.deepEqual(errors(report), []);
  assert.deepEqual(el(scene, 'rock-a').position, { x: 50, y: 50 });
  assert.deepEqual(el(scene, 'barrel-a').position, { x: 21, y: 20 });
  assert.deepEqual(report.moved.map(m => [m.id, m.reason]), [['rock-b', 'collision'], ['tree-a', 'collision']]);
  for (const [x, y] of [['rock-a', 'rock-b'], ['tree-a', 'barrel-a']]) assert.equal(overlaps(footprintOf(el(scene, x)), footprintOf(el(scene, y))), false);
  // moved to a 2.5 ft lattice point
  const m = el(scene, 'rock-b').position;
  assert.ok(Number.isInteger((m.x - 51) / 2.5));
  assert.ok(Number.isInteger((m.y - 50) / 2.5));
});

test('constraint elements are pinned; a tree on the road moves off it', () => {
  const s = load('forest-road-ambush');
  s.objects.push(obj('tree-x', 'tree', 53.63, 50, 20, 20));
  const { scene, report } = layoutScene(s);
  assert.deepEqual(errors(report), []);
  assert.deepEqual(el(scene, 'wagon-rear').position, { x: 53.63, y: 50 });
  assert.ok(report.moved.some(m => m.id === 'tree-x'));
});

test('unresolvable collision is reported, not moved', () => {
  const s = blank({ grid: { cellFt: 5, widthFt: 20, heightFt: 20, visible: true },
    objects: [obj('b1', 'building', 10, 10, 20, 20, { locked: true }), obj('t1', 'tent', 10, 10, 6, 6)] });
  const { scene, report } = layoutScene(s);
  assert.deepEqual(el(scene, 't1').position, { x: 10, y: 10 });
  assert.equal(kinds(report, 'collision', 'error').length, 1);
});

test('bounds: clamped by layout, reported by check', () => {
  const s = blank({ objects: [obj('w', 'wagon', 98, 50, 10, 5)] });
  assert.equal(kinds(checkScene(s), 'bounds', 'error').length, 1);
  const { scene, report } = layoutScene(s);
  assert.equal(el(scene, 'w').position.x, 95);
  assert.equal(kinds(report, 'bounds').length, 0);
  assert.equal(report.moved[0].reason, 'bounds');
});

test('determinism and purity', () => {
  const s = load('forest-road-ambush');
  el(s, 'wagon-rear').position.x = 30;
  s.objects.push(obj('rock-z', 'boulder', 70, 26, 5, 5));
  const before = JSON.stringify(s);
  const a = JSON.stringify(layoutScene(s)), b = JSON.stringify(layoutScene(JSON.parse(before)));
  assert.equal(a, b);
  assert.equal(JSON.stringify(s), before);
  checkScene(s);
  assert.equal(JSON.stringify(s), before);
});

test('report: size, spacing, bridge, lanes, cover', () => {
  const s = blank({
    objects: [obj('big-wagon', 'wagon', 30, 30, 40, 30), obj('dry-bridge', 'bridge', 50, 10, 20, 10),
      obj('tent-a', 'tent', 70, 20, 8, 6), obj('tent-b', 'tent', 80, 20, 8, 6)],
    paths: [
      { id: 'wall', type: 'ruined-wall', name: 'Wall', position: { x: 0, y: 0 }, params: { points: [[0, 50], [100, 50]], width: 1 } },
      { id: 'river', type: 'stream', name: 'River', position: { x: 0, y: 0 }, params: { points: [[50, 0], [50, 100]], width: 10 } },
      { id: 'road', type: 'road', name: 'Road', position: { x: 0, y: 0 }, params: { points: [[0, 85], [100, 85]], width: 60 } },
    ],
  });
  const r = checkScene(s);
  assert.ok(kinds(r, 'size', 'warn').some(i => i.ids[0] === 'big-wagon'));
  assert.ok(kinds(r, 'size', 'warn').some(i => i.ids[0] === 'road'));
  assert.ok(kinds(r, 'spacing', 'warn').some(i => i.ids.join() === 'tent-a,tent-b' && i.expectedFt === 3 && i.actualFt === 2));
  assert.ok(kinds(r, 'bridge', 'warn').some(i => i.ids.join() === 'road,river'));
  assert.ok(!kinds(r, 'bridge', 'warn').some(i => i.ids[0] === 'dry-bridge')); // sits on the river
  assert.equal(r.stats.lanes.northSouth, false); // wall spans the map
  assert.equal(r.stats.lanes.westEast, true);
  assert.equal(kinds(r, 'lane', 'warn').length, 1);
  const empty = checkScene(blank());
  assert.equal(empty.stats.coverPct, 0);
  assert.equal(kinds(empty, 'cover', 'warn').length, 1);
  assert.equal(empty.ok, true);
  const dry = checkScene(blank({ objects: [obj('br', 'bridge', 50, 50, 20, 10)] }));
  assert.equal(kinds(dry, 'bridge', 'warn')[0].ids[0], 'br');
});

test('deep stream blocks lanes except at a bridge; a thin diagonal fence blocks without leaks', () => {
  const stream = { id: 'river', type: 'stream', name: 'River', position: { x: 0, y: 0 }, params: { points: [[52, 0], [52, 100]], width: 3, depth: 'deep' } };
  assert.equal(checkScene(blank({ paths: [stream] })).stats.lanes.westEast, false);
  assert.equal(checkScene(blank({ paths: [stream], objects: [obj('br', 'bridge', 52, 50, 10, 5)] })).stats.lanes.westEast, true);
  const fence = { id: 'f', type: 'fence', name: 'Fence', position: { x: 0, y: 0 }, params: { points: [[0, 3], [100, 97]], width: 0.5 } };
  // corner to corner: west->east must cross the fence's line... unless it runs along an edge row, so close both edges
  const r = checkScene(blank({ paths: [fence, { ...fence, id: 'g', params: { points: [[0, 0], [100, 0]], width: 0.5 } },
    { ...fence, id: 'h', params: { points: [[0, 100], [100, 100]], width: 0.5 } }] }));
  assert.equal(r.stats.lanes.westEast, false);
});

test('neighbours and summarizeScene', () => {
  const s = validate(load('riverside-ruin')).scene;
  const n = neighbours(s, ['campfire'], 10).map(e => e.id);
  assert.ok(n.includes('barrel-1') && n.includes('crate-1'));
  assert.ok(!n.includes('campfire') && !n.includes('tree-1'));
  for (const e of neighbours(s, ['campfire'], 10)) assert.ok(distanceFt(el(s, 'campfire'), e) <= 10);
  const sum = summarizeScene(s);
  assert.equal(sum.widthFt, 120);
  assert.equal(sum.counts.tree, 5);
  assert.equal(sum.elements.length, 24);
  assert.deepEqual(Object.keys(sum.elements[0]), ['id', 'type', 'name', 'x', 'y', 'w', 'h', 'rotation']);
  const many = blank({ objects: Array.from({ length: 450 }, (_, i) => obj(`c-${i}`, 'crate', 5 + (i % 30) * 3, 5 + Math.floor(i / 30) * 3, 2, 2)) });
  assert.equal(summarizeScene(validate(many).scene).elements.length, 400);
});

test('the example scene in prompts/generate.md is valid and satisfies its constraint', () => {
  const md = readFileSync(new URL('../prompts/generate.md', import.meta.url), 'utf8');
  const example = JSON.parse(md.match(/```json\n([\s\S]*?)\n```/)[1]);
  const res = validate(example);
  assert.ok(res.ok, JSON.stringify(res.errors));
  const r = checkScene(example);
  assert.ok(r.ok, JSON.stringify(errors(r)));
  assert.equal(kinds(r, 'constraint')[0].level, 'ok');
  assert.equal(kinds(r, 'bridge').length, 0);
});

test('moving a path b west keeps the scene valid (QA D1)', () => {
  const s = validate(load('riverside-ruin')).scene;
  findElement(s, 'watchtower').el.position.x -= 1; // stream must now move 1 ft west, origin goes negative
  const { scene } = layoutScene(s, { fix: true });
  const res = validate(scene);
  assert.ok(res.ok, JSON.stringify(res.errors));
  assert.ok(Math.abs(distanceFt(findElement(scene, 'watchtower').el, findElement(scene, 'stream').el) - 30) <= 0.05);
});

test('D1: a constraint that pushes b off the map is reported and the result stays valid', () => {
  const s = blank({ grid: { cellFt: 5, widthFt: 120, heightFt: 120, visible: true },
    objects: [obj('wagon', 'wagon', 100, 60, 10, 5), obj('crate', 'crate', 60, 60, 3, 3)],
    constraints: [{ id: 'c1', kind: 'distance', a: 'wagon', b: 'crate', ft: 30, direction: 'east' }] });
  const { scene, report } = layoutScene(s);
  assert.ok(validate(scene).ok, JSON.stringify(validate(scene).errors));
  const c = el(scene, 'crate');
  assert.ok(c.position.x + 1.5 <= 120 + 1e-9, `crate at ${c.position.x}`);
  assert.equal(report.ok, false);
  assert.equal(kinds(report, 'constraint')[0].level, 'error');
});

test('D1: layoutScene never returns a scene that fails checkScene', () => {
  // label pushed far east by a constraint: labels are not clamped, so the result would be invalid
  const s = blank({ objects: [obj('rock', 'boulder', 90, 50, 4, 4)],
    labels: [{ id: 'lbl', type: 'label', name: 'L', position: { x: 50, y: 50 }, params: { text: 'Here' } }],
    constraints: [{ id: 'c1', kind: 'distance', a: 'rock', b: 'lbl', ft: 40, direction: 'east', measure: 'center' }] });
  const { scene, report } = layoutScene(s);
  assert.ok(validate(scene).ok);
  assert.equal(report.ok, false);
  assert.deepEqual(el(scene, 'lbl').position, { x: 50, y: 50 }); // input kept
  assert.ok(report.items.some(i => i.level === 'error' && /unchanged/.test(i.message)));
});

test('D2: stated direction puts b on the line through a; chains converge; over-constraint flagged', () => {
  const s = blank({
    objects: [obj('a', 'boulder', 20, 20, 4, 4), obj('b', 'boulder', 45, 31, 4, 4), obj('c', 'crate', 70, 70, 3, 3)],
    constraints: [
      { id: 'c2', kind: 'distance', a: 'b', b: 'c', ft: 15, direction: 'south' }, // chain: listed before b is placed
      { id: 'c1', kind: 'distance', a: 'a', b: 'b', ft: 20, direction: 'east' },
    ],
  });
  const { scene, report } = layoutScene(s);
  const [A, B, C] = ['a', 'b', 'c'].map(id => el(scene, id));
  assert.equal(B.position.y, 20);
  assert.equal(C.position.x, B.position.x);
  assert.ok(Math.abs(distanceFt(A, B) - 20) <= 0.01 && Math.abs(distanceFt(B, C) - 15) <= 0.01);
  assert.ok(report.ok, JSON.stringify(errors(report)));
  assert.equal(report.moved.filter(m => m.id === 'b').length, 1);
  // b in two compatible constraints (west of x, north of y) converges
  const two = blank({
    objects: [obj('x', 'boulder', 60, 40, 4, 4), obj('y', 'boulder', 50, 70, 4, 4), obj('b', 'crate', 30, 30, 2, 2)],
    constraints: [{ id: 'k1', kind: 'distance', a: 'x', b: 'b', ft: 10, direction: 'west', measure: 'center' },
      { id: 'k2', kind: 'distance', a: 'y', b: 'b', ft: 30, direction: 'north', measure: 'center' }],
  });
  const t = layoutScene(two);
  assert.ok(t.report.ok, JSON.stringify(errors(t.report)));
  assert.deepEqual(el(t.scene, 'b').position, { x: 50, y: 40 });
  // impossible: b 10 ft east and 10 ft west of the same anchor
  const bad = blank({
    objects: [obj('x', 'boulder', 50, 50, 4, 4), obj('b', 'crate', 30, 30, 2, 2)],
    constraints: [{ id: 'k1', kind: 'distance', a: 'x', b: 'b', ft: 10, direction: 'west' },
      { id: 'k2', kind: 'distance', a: 'x', b: 'b', ft: 10, direction: 'east' }],
  });
  const r = layoutScene(bad).report;
  assert.ok(r.items.some(i => i.kind === 'constraint' && /over-constrained/.test(i.message)));
  assert.equal(JSON.stringify(layoutScene(bad)), JSON.stringify(layoutScene(bad))); // deterministic
});

// ---- QA N1 / N1b: attached features follow a moved path; every move is reported; no barrier crossings
const ford = () => blank({
  grid: { cellFt: 5, widthFt: 120, heightFt: 100, visible: true },
  objects: [obj('tower', 'building', 30, 20, 15, 15, { params: { shape: 'round', style: 'watchtower' } }),
    obj('bridge', 'bridge', 72.5, 60, 18, 13), obj('wagon', 'wagon', 100, 60, 10, 5)],
  paths: [
    { id: 'river', type: 'stream', name: 'River', position: { x: 0, y: 0 }, params: { points: [[72.5, 0], [72.5, 100]], width: 10 } },
    { id: 'road', type: 'road', name: 'Road', position: { x: 0, y: 0 }, params: { points: [[0, 60], [120, 60]], width: 12 } },
  ],
  regions: [{ id: 'reeds', type: 'tall-grass', name: 'Reeds', position: { x: 0, y: 0 }, params: { points: [[61, 5], [66, 5], [66, 40], [61, 40]] } }],
  constraints: [{ id: 'c1', kind: 'distance', a: 'tower', b: 'river', ft: 30, direction: 'east', text: 'river 30 ft east of the tower' }],
});

test('N1: bridge, bank regions and props follow a path b moved by the solver', () => {
  const s = ford();
  assert.ok(checkScene(s).ok);
  el(s, 'tower').position.x -= 10;
  const { scene, report } = layoutScene(s);
  assert.ok(Math.abs(distanceFt(el(scene, 'tower'), el(scene, 'river')) - 30) <= 0.01);
  assert.equal(el(scene, 'river').position.x, -10);
  assert.deepEqual(el(scene, 'bridge').position, { x: 62.5, y: 60 });
  assert.deepEqual(el(scene, 'reeds').position, { x: -10, y: 0 });
  assert.deepEqual(el(scene, 'road').position, { x: 0, y: 0 });   // the road does not belong to the river
  assert.deepEqual(el(scene, 'wagon').position, { x: 100, y: 60 });
  assert.equal(kinds(report, 'bridge').length, 0, JSON.stringify(kinds(report, 'bridge')));
  assert.ok(kinds(report, 'moved', 'warn').some(i => i.ids[0] === 'bridge' && i.message === 'bridge moved 10.0 ft with River'));
  assert.ok(validate(scene).ok);
});

test('N1: props on a moved road travel with it', () => {
  const s = blank({
    objects: [obj('rock', 'boulder', 50, 20, 4, 4), obj('cart', 'wagon', 30, 60, 10, 5), obj('oak', 'tree', 80, 80, 16, 16)],
    paths: [{ id: 'road', type: 'road', name: 'Road', position: { x: 0, y: 0 }, params: { points: [[0, 60], [100, 60]], width: 10 } }],
    constraints: [{ id: 'c1', kind: 'distance', a: 'rock', b: 'road', ft: 30, direction: 'south' }],
  });
  const { scene } = layoutScene(s);
  assert.equal(el(scene, 'road').position.y, el(scene, 'cart').position.y - 60);
  assert.deepEqual(el(scene, 'oak').position, { x: 80, y: 80 });
});

test('N1: a road crossing water beside (not on) the bridge is flagged', () => {
  const s = ford();
  el(s, 'bridge').position.y = 72; // deck overlaps the road edge but not where the centreline is wet
  assert.ok(kinds(checkScene(s), 'bridge', 'warn').some(i => i.ids.join() === 'road,river'));
  assert.equal(kinds(checkScene(ford()), 'bridge').length, 0);
});

test('N1b: every move is a report item, and collision fixes never cross a wall', () => {
  const s = ford();
  s.objects.push(obj('rock', 'boulder', 100, 30, 4, 4), obj('rock-2', 'boulder', 101, 30, 4, 4));
  const r = layoutScene(s).report;
  assert.equal(r.moved.length, kinds(r, 'moved').length);
  assert.match(kinds(r, 'moved').find(i => i.ids[0] === 'rock-2').message, /^rock-2 moved \d+\.\d ft to clear a collision with rock$/);
  const walled = (withWall) => blank({
    grid: { cellFt: 5, widthFt: 60, heightFt: 20, visible: true },
    objects: [obj('house', 'building', 55.5, 10, 9, 20, { locked: true }), obj('b', 'boulder', 55, 10, 3, 3)],
    paths: withWall ? [{ id: 'wall', type: 'ruined-wall', name: 'Wall', position: { x: 0, y: 0 }, params: { points: [[50, 0], [50, 20]], width: 1 } }] : [],
  });
  const free = layoutScene(walled(false));
  assert.ok(el(free.scene, 'b').position.x < 51); // without the wall it escapes west
  const blocked = layoutScene(walled(true));
  assert.deepEqual(el(blocked.scene, 'b').position, { x: 55, y: 10 });
  assert.ok(kinds(blocked.report, 'collision', 'error').length >= 1);
});

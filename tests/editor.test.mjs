// Run: node --test tests/editor.test.mjs
// Pure editor logic: scope check, op builders, formatting, error messages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkScene, findElement } from '../src/schema.js';
import { applyPatch } from '../src/core/patch.js';
import { toWorld } from '../src/core/geom.js';
import {
  outOfScope, addedIds, moveOps, nudgeOps, deleteOps, resizeOps, rotateOps, pointOps,
  removePointOps, insertPointOps, fieldOps, formatFeet, sizeTag, errorMessage, elPath,
  layoutOrFallback, reportErrors,
} from '../src/editor/ops.js';
import * as layout from '../src/layout/index.js';
import { parseSize } from '../src/editor/topbar.js';

const load = name => checkScene(JSON.parse(readFileSync(new URL(`../samples/${name}.json`, import.meta.url), 'utf8'))).scene;
const scene = load('riverside-ruin');
const firstOf = (coll, pred = () => true) => scene[coll].find(pred);
const obj = firstOf('objects', o => (o.rotation || 0) === 0);
const obj2 = scene.objects.find(o => o.id !== obj.id);
const path = firstOf('paths');
const region = firstOf('regions');
const valid = ops => { const r = checkScene(applyPatch(scene, ops)); assert.ok(r.ok, JSON.stringify(r.errors)); return r.scene; };

test('scope: edits inside selection or neighbours pass', () => {
  const ops = [{ op: 'replace', path: elPath(obj, 'name'), value: 'X' }, { op: 'replace', path: elPath(obj2, 'rotation'), value: 10 }];
  assert.deepEqual(outOfScope(scene, ops, [obj.id], [obj2.id]), []);
});

test('scope: edits outside are reported, added ids are allowed', () => {
  const ops = [
    { op: 'replace', path: elPath(obj2, 'rotation'), value: 10 },
    { op: 'add', path: '/objects/-', value: { id: 'crate-new', type: 'crate', position: { x: 10, y: 10 }, size: { w: 3, h: 3 } } },
    { op: 'add', path: '/objects/barrel-new', value: { id: 'barrel-new', type: 'barrel', position: { x: 12, y: 10 }, size: { w: 2, h: 2 } } },
  ];
  assert.deepEqual(outOfScope(scene, ops, [obj.id]), [obj2.id]);
  assert.deepEqual(addedIds(scene, ops), ['crate-new', 'barrel-new']);
});

test('scope: removing an unselected element is out of scope; top-level ops are not elements', () => {
  const ops = [{ op: 'remove', path: elPath(obj2) }, { op: 'replace', path: '/lighting/time', value: 'night' }];
  assert.deepEqual(outOfScope(scene, ops, [obj.id]), [obj2.id]);
  // "add" to an existing id is not a new element.
  assert.deepEqual(addedIds(scene, [{ op: 'add', path: elPath(obj), value: { id: obj.id } }]), []);
});

test('move: primary snaps with snapPosition, others follow the same delta', () => {
  const ops = moveOps(scene, [obj.id, obj2.id], obj.id, 3.3, 1.2);
  const next = valid(ops);
  const a = findElement(next, obj.id).el, b = findElement(next, obj2.id).el;
  const dx = a.position.x - obj.position.x, dy = a.position.y - obj.position.y;
  // Bounding-box corner of an unrotated object lands on the 5 ft grid.
  assert.equal(((a.position.x - a.size.w / 2) % 5 + 5) % 5 < 1e-9 || ((a.position.x - a.size.w / 2) % 5 + 5) % 5 > 5 - 1e-9, true);
  assert.ok(Math.abs(b.position.x - obj2.position.x - dx) < 0.011 || b.position.x === 0 || b.position.x === scene.grid.widthFt);
  assert.ok(Math.abs(b.position.y - obj2.position.y - dy) < 0.011 || b.position.y === 0 || b.position.y === scene.grid.heightFt);
});

test('move: free (Alt) is exact; no-op move yields no ops; clamps into the map', () => {
  const [op] = moveOps(scene, [obj.id], obj.id, 1.23, -0.5, { free: true });
  assert.deepEqual(op.value, { x: Math.round((obj.position.x + 1.23) * 100) / 100, y: Math.round((obj.position.y - 0.5) * 100) / 100 });
  assert.deepEqual(moveOps(scene, [obj.id], obj.id, 0, 0, { free: true }), []);
  const far = moveOps(scene, [obj.id], obj.id, -9999, 9999, { free: true });
  assert.deepEqual(far[0].value, { x: 0, y: scene.grid.heightFt });
  valid(far);
});

test('nudge and delete build one op per element', () => {
  const ops = nudgeOps(scene, [obj.id, path.id], 5, 0);
  assert.equal(ops.length, 2);
  assert.equal(findElement(valid(ops), obj.id).el.position.x, obj.position.x + 5);
  const del = deleteOps(scene, [obj.id, region.id, 'nope']);
  assert.equal(del.length, 2);
  const next = valid(del);
  assert.equal(findElement(next, obj.id), null);
  assert.equal(findElement(next, region.id), null);
});

test('resize: east handle grows width, keeps the west edge fixed', () => {
  const el = { ...obj, rotation: 0 };
  const east = toWorld(el, [el.size.w / 2 + 4, 0]);
  const ops = resizeOps(scene, el, 1, 0, { x: east[0], y: east[1] });
  const size = ops.find(o => o.path.endsWith('/size')).value;
  const pos = ops.find(o => o.path.endsWith('/position')).value;
  assert.equal(size.w, Math.round(el.size.w + 4));
  assert.equal(size.h, el.size.h);
  const westBefore = el.position.x - el.size.w / 2, westAfter = pos.x - size.w / 2;
  assert.ok(Math.abs(westBefore - westAfter) < 0.011);
});

test('resize: rotated element keeps the opposite corner fixed in world space', () => {
  const el = { ...obj, rotation: 90, size: { w: 10, h: 6 }, position: { x: 50, y: 50 } };
  const corner = toWorld(el, [7, 5]); // drag the SE handle outward
  const ops = resizeOps(scene, el, 1, 1, { x: corner[0], y: corner[1] }, { free: true });
  const size = ops[0].value, pos = ops[1].value;
  assert.deepEqual(size, { w: 12, h: 8 });
  const fixedBefore = toWorld(el, [-5, -3]);
  const fixedAfter = toWorld({ ...el, size, position: pos }, [-6, -4]);
  assert.ok(Math.abs(fixedBefore[0] - fixedAfter[0]) < 0.011 && Math.abs(fixedBefore[1] - fixedAfter[1]) < 0.011);
});

test('resize: never below the minimum size', () => {
  const ops = resizeOps(scene, { ...obj, rotation: 0 }, -1, 0, { x: obj.position.x + 100, y: obj.position.y });
  assert.equal(ops[0].value.w, 1);
});

test('rotate: snaps to 15 degrees, Alt is free, handle above = 0', () => {
  const el = { ...obj, rotation: 30 };
  const { x, y } = el.position;
  assert.deepEqual(rotateOps(el, { x, y: y - 10 }), [{ op: 'replace', path: elPath(el, 'rotation'), value: 0 }]);
  assert.equal(rotateOps(el, { x: x + 10, y: y - 9.5 })[0].value, 45);
  assert.equal(rotateOps(el, { x: x + 10, y })[0].value, 90);
  assert.equal(rotateOps(el, { x: x - 10, y })[0].value, 270);
  assert.ok(Math.abs(rotateOps(el, { x: x + 10, y: y - 9.5 }, { free: true })[0].value - 46.47) < 0.01);
  assert.deepEqual(rotateOps({ ...el, rotation: 90 }, { x: x + 10, y: y + 1 }), []);
});

test('points: move snaps to 2.5 ft in world space; remove keeps the minimum; insert lands on nearest segment', () => {
  const el = { ...path, position: { x: 10, y: 0 } };
  const [op] = pointOps(el, 1, { x: 41.2, y: 22.4 });
  assert.equal(op.path, `/paths/${path.id}/params/points/1`);
  assert.deepEqual(op.value, [30, 22.5]);
  assert.deepEqual(removePointOps({ ...region, params: { ...region.params, points: [[0, 0], [5, 0], [0, 5]] } }, 0), []);
  assert.equal(removePointOps(region, 0).length, 1);
  const p0 = toWorld(path, path.params.points[0]), p1 = toWorld(path, path.params.points[1]);
  const mid = { x: (p0[0] + p1[0]) / 2, y: (p0[1] + p1[1]) / 2 };
  const [ins] = insertPointOps(path, mid);
  assert.equal(ins.path, `/paths/${path.id}/params/points/1`);
  const next = valid([ins]);
  assert.equal(findElement(next, path.id).el.params.points.length, path.params.points.length + 1);
});

test('field edits commit through the validator', () => {
  const next = valid([...fieldOps(obj, 'name', 'Renamed'), ...fieldOps(obj, 'locked', true), ...fieldOps(obj, 'position/x', 20)]);
  const el = findElement(next, obj.id).el;
  assert.equal(el.name, 'Renamed'); assert.equal(el.locked, true); assert.equal(el.position.x, 20);
  assert.equal(checkScene(applyPatch(scene, fieldOps(obj, 'name', ''))).ok, false);
});

test('ids with slashes and tildes are escaped in paths', () => {
  assert.equal(elPath({ id: 'a/b~c', type: 'tree' }, 'name'), '/objects/a~1b~0c/name');
});

test('measure formatting: one decimal feet and squares', () => {
  assert.equal(formatFeet(25), '25.0 ft (5 squares)');
  assert.equal(formatFeet(5), '5.0 ft (1 square)');
  assert.equal(formatFeet(12.34), '12.3 ft (2.5 squares)');
  assert.equal(formatFeet(0), '0.0 ft (0 squares)');
  assert.equal(sizeTag({ name: 'Wagon', size: { w: 10, h: 5 } }), 'Wagon — 10 x 5 ft');
});

test('error messages for ApiError codes', () => {
  assert.match(errorMessage({ code: 'daily_cap', message: 'Daily limit reached (300 requests). Resets at 00:00 UTC.' }), /Daily limit reached \(300/);
  assert.match(errorMessage({ code: 'daily_cap' }), /Daily limit/);
  assert.equal(errorMessage({ code: 'rate_limited', retryAfterSec: 12 }), 'Too many requests. Try again in 12 s.');
  assert.match(errorMessage({ code: 'llm_invalid', details: [{ path: '/objects/0', message: 'bad' }] }), /failed validation twice.*\/objects\/0 bad/);
  assert.match(errorMessage(new TypeError('Failed to fetch')), /Could not reach the server/);
  assert.equal(errorMessage(new Error('boom')), 'boom');
});

test('generate size parsing', () => {
  assert.deepEqual(parseSize(''), { ok: true, value: undefined });
  assert.deepEqual(parseSize('120'), { ok: true, value: 120 });
  assert.equal(parseSize('122').ok, false);
  assert.equal(parseSize('15').ok, false);
  assert.equal(parseSize('605').ok, false);
  assert.equal(parseSize('abc').ok, false);
});

test('layoutOrFallback: real layout repairs a stated distance broken by an edit', () => {
  const c = scene.constraints[0];
  assert.ok(c, 'sample has a constraint');
  const b = findElement(scene, c.b).el;
  const moved = valid([{ op: 'replace', path: elPath(b, 'position'), value: { x: Math.min(scene.grid.widthFt, b.position.x + 7), y: b.position.y } }]);
  assert.ok(reportErrors(layout.checkScene(moved)) > 0, 'edit breaks the constraint');
  const lo = layoutOrFallback(moved, layout);
  assert.equal(lo.error, null);
  assert.ok(checkScene(lo.scene).ok);
  const item = lo.report.items.find(i => i.kind === 'constraint' && i.ids.includes(c.b));
  assert.equal(item.level, 'ok');
});

test('layoutOrFallback: throwing or invalid layout keeps the candidate', () => {
  const thrown = layoutOrFallback(scene, { layoutScene: () => { throw new Error('boom'); } });
  assert.equal(thrown.scene, scene);
  assert.match(thrown.error, /boom/);
  const bad = layoutOrFallback(scene, { layoutScene: s => ({ scene: { ...s, grid: { ...s.grid, widthFt: 7 } }, report: {} }) });
  assert.equal(bad.scene, scene);
  assert.match(bad.error, /invalid scene/);
  const none = layoutOrFallback(scene, { layoutScene: () => undefined });
  assert.equal(none.scene, scene);
  assert.ok(none.error);
  assert.equal(reportErrors({ items: [{ level: 'error' }, { level: 'warn' }, { level: 'error' }] }), 2);
  assert.equal(reportErrors(null), 0);
});

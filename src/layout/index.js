// Layout engine: exact stated distances, collision resolution, distance/sanity report.
// Pure and deterministic. See docs/CONTRACT.md section 9. All distance math comes from geom.js.
import { TYPES, normalizeScene, allElements, findElement, checkScene as validateScene } from '../schema.js';
import { shapeOf, footprintOf, distanceFt, overlaps, gap, coreDistance, pointInPoly, boundsOf, DIRECTIONS } from '../core/geom.js';

const CONSTRAINT_TOL = 0.05;   // report tolerance (contract 2.3)
const SOLVE_TOL = 0.01;        // solver target
const RELAX_PASSES = 6;        // passes over all constraints so chains converge
const SPIRAL_STEP = 2.5;
const SPIRAL_MAX = 30;
const CELL = 5;
const COVER_FT = 30;
const COVER_MIN_PCT = 60;
const COVER_TYPES = new Set(['tree', 'boulder', 'rock-cluster', 'wagon', 'building', 'ruined-wall', 'crate', 'tent']);

const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;
const r3 = v => Math.round(v * 1000) / 1000;
const def = el => TYPES[el.type] || {};
const isObject = el => def(el).kind === 'object';
const nameOf = el => el.name || el.id;
const boxOfShape = s => {
  const xs = s.pts.map(p => p[0]), ys = s.pts.map(p => p[1]);
  return { minX: Math.min(...xs) - s.r, minY: Math.min(...ys) - s.r, maxX: Math.max(...xs) + s.r, maxY: Math.max(...ys) + s.r };
};
const boxesNear = (a, b, pad = 0) => a.minX - pad <= b.maxX && b.minX - pad <= a.maxX && a.minY - pad <= b.maxY && b.minY - pad <= a.maxY;
const centerOf = el => { const b = boundsOf(el); return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2]; };
const pointShape = (x, y) => ({ core: 'point', pts: [[x, y]], r: 0 });
const moveTo = (el, x, y) => ({ ...el, position: { x, y } });

// Collision relation (contract 4): at least one object, and one blocks the other's category.
function blocks(a, b) {
  if (!isObject(a) && !isObject(b)) return false;
  const da = def(a), db = def(b);
  return (da.blockedBy || []).includes(db.cat) || (db.blockedBy || []).includes(da.cat);
}

// Footprint cache keyed by element object; drop the entry whenever an element moves.
function footprints() {
  const cache = new Map();
  const get = el => {
    let v = cache.get(el);
    if (!v) { const fp = footprintOf(el); v = { fp, box: boxOfShape(fp) }; cache.set(el, v); }
    return v;
  };
  return { get, forget: el => cache.delete(el) };
}

const insideMap = (box, W, H, tol = 0.01) => box.minX >= -tol && box.minY >= -tol && box.maxX <= W + tol && box.maxY <= H + tol;

// ---------------------------------------------------------------- fixing

function clampToMap(scene, fps, moved) {
  const W = scene.grid.widthFt, H = scene.grid.heightFt;
  for (const el of scene.objects) {
    if (el.locked) continue;
    const { box } = fps.get(el);
    const shift = (lo, hi, max) => (hi - lo > max ? max / 2 - (lo + hi) / 2 : lo < 0 ? -lo : hi > max ? max - hi : 0);
    const dx = shift(box.minX, box.maxX, W), dy = shift(box.minY, box.maxY, H);
    if (!dx && !dy) continue;
    const from = { ...el.position };
    el.position = { x: r3(el.position.x + dx), y: r3(el.position.y + dy) };
    fps.forget(el);
    moved.push({ id: el.id, from, to: { ...el.position }, reason: 'bounds' });
  }
}

// Move b along the constraint direction until distanceFt(a, b) == ft (bisection on the move distance).
// Picks the root nearest to the current position that keeps b on the stated side of a.
// align: for a stated direction, first put an object/label b on the line through a's centre along it
// ("20 ft west" means west, not north-west); paths and regions keep their offset (their centre is not meaningful).
function solveConstraint(scene, c, fps, align) {
  const A = findElement(scene, c.a)?.el, B = findElement(scene, c.b)?.el;
  if (!A || !B || B.locked) return;
  let d = DIRECTIONS[c.direction];
  if (d && align && (def(B).kind === 'object' || def(B).kind === 'label')) {
    const [ax, ay] = centerOf(A), [bx, by] = centerOf(B);
    const along = (bx - ax) * d[0] + (by - ay) * d[1];
    const px = ax + d[0] * along - bx, py = ay + d[1] * along - by;
    if (Math.hypot(px, py) > 1e-6) { B.position = { x: B.position.x + px, y: B.position.y + py }; fps.forget(B); }
  }
  if (!d) {
    const [ax, ay] = centerOf(A), [bx, by] = centerOf(B);
    const len = Math.hypot(bx - ax, by - ay);
    d = len > 1e-9 ? [(bx - ax) / len, (by - ay) / len] : [1, 0];
  }
  const { x: x0, y: y0 } = B.position;
  const at = t => moveTo(B, x0 + d[0] * t, y0 + d[1] * t);
  const f = t => distanceFt(A, at(t), c.measure) - c.ft;
  const [ax, ay] = centerOf(A);
  const rightSide = t => { const [bx, by] = centerOf(at(t)); return (bx - ax) * d[0] + (by - ay) * d[1] >= -1e-9; };
  const pointLike = def(B).kind === 'object' || def(B).kind === 'label';
  if (Math.abs(f(0)) <= SOLVE_TOL && (!pointLike || !DIRECTIONS[c.direction] || rightSide(0))) return;
  // Converge on the boundary and return its positive side, so ft = 0 ends touching rather than overlapping.
  const bisect = (lo, hi) => {
    const posLo = f(lo) > 0;
    for (let i = 0; i < 60 && Math.abs(hi - lo) > 1e-7; i++) {
      const mid = (lo + hi) / 2;
      if ((f(mid) > 0) === posLo) lo = mid; else hi = mid;
    }
    return posLo ? lo : hi;
  };
  const step = 0.5;
  const maxT = 2 * (scene.grid.widthFt + scene.grid.heightFt) + c.ft;
  let fallback = null, found = null;
  let fPrevPos = f(0), fPrevNeg = fPrevPos;
  for (let k = 1; k * step <= maxT && found === null; k++) {
    for (const sgn of [1, -1]) {
      const t1 = sgn * k * step, t0 = sgn * (k - 1) * step;
      const v1 = f(t1), v0 = sgn > 0 ? fPrevPos : fPrevNeg;
      if (sgn > 0) fPrevPos = v1; else fPrevNeg = v1;
      if ((v0 > 0) === (v1 > 0)) continue;
      const t = bisect(t0, t1);
      if (rightSide(t)) { found = t; break; }
      if (fallback === null) fallback = t;
    }
  }
  const t = found ?? fallback;
  if (t === null) return;
  B.position = { x: r3(x0 + d[0] * t), y: r3(y0 + d[1] * t) };
  if (Math.abs(distanceFt(A, B, c.measure) - c.ft) > SOLVE_TOL) {
    B.position = { x: x0 + d[0] * t, y: y0 + d[1] * t }; // rounding broke it: keep the exact value
  }
  fps.forget(B);
}

const satisfied = (scene, c) => {
  const A = findElement(scene, c.a)?.el, B = findElement(scene, c.b)?.el;
  return !!A && !!B && Math.abs(distanceFt(A, B, c.measure) - c.ft) <= SOLVE_TOL;
};

// Relaxation: repeat passes so chains (b of one is a of another) settle. Returns report items for
// elements that are b of several constraints that could not all be met (over-constrained).
// Features that belong to a path/region b and must move with it: bridges and props sitting on it
// (allowed there by the collision rules), and ground/vegetation/water regions hugging it (banks, reeds).
const ATTACH_BAND_FT = 12;
function attachmentsOf(scene, b, fps, skip) {
  const bs = shapeOf(b), band = bs.r + ATTACH_BAND_FT, cat = def(b).cat;
  const near = ([x, y]) => coreDistance(pointShape(x, y), { ...bs, r: 0 }) <= band;
  const out = [];
  for (const e of allElements(scene)) {
    if (e === b || skip.has(e.id) || e.locked) continue;
    const d = def(e);
    if (d.kind === 'region' && ['veg', 'ground', 'water'].includes(d.cat)) {
      const pts = shapeOf(e).pts, frac = pts.filter(near).length / pts.length;
      if (frac >= 0.5 || (frac >= 0.25 && overlaps(shapeOf(e), bs))) out.push(e);
    } else if (d.kind === 'object' && cat !== 'veg' && cat !== 'ground' && !blocks(e, b) && overlaps(fps.get(e).fp, bs)) {
      out.push(e);
    }
  }
  return out;
}

function solveConstraints(scene, fps, moved, pinned) {
  const asB = new Map();
  for (const c of scene.constraints) asB.set(c.b, [...(asB.get(c.b) || []), c]);
  const start = new Map([...asB.keys()].map(id => [id, findElement(scene, id)?.el]).filter(([, e]) => e).map(([id, e]) => [id, { ...e.position }]));
  const skip = new Set(scene.constraints.flatMap(c => [c.a, c.b]));
  const attached = new Map(); // b id -> elements (decided before anything moves; first b wins)
  for (const id of asB.keys()) {
    const b = findElement(scene, id)?.el;
    if (!b || isObject(b) || def(b).kind === 'label') continue;
    const list = attachmentsOf(scene, b, fps, skip);
    list.forEach(e => skip.add(e.id));
    attached.set(id, list);
  }
  for (let pass = 0; pass < RELAX_PASSES; pass++) {
    for (const c of scene.constraints) solveConstraint(scene, c, fps, asB.get(c.b).length === 1);
    if (scene.constraints.every(c => satisfied(scene, c))) break;
  }
  for (const [id, from] of start) {
    const to = findElement(scene, id).el.position;
    if (to.x === from.x && to.y === from.y) continue;
    moved.push({ id, from, to: { ...to }, reason: `constraint ${asB.get(id).map(c => c.id).join(',')}` });
    const dx = to.x - from.x, dy = to.y - from.y;
    for (const e of attached.get(id) || []) {
      const f = { ...e.position };
      e.position = { x: r3(f.x + dx), y: r3(f.y + dy) };
      fps.forget(e);
      pinned.add(e.id);
      moved.push({ id: e.id, from: f, to: { ...e.position }, reason: 'attached', with: id });
    }
  }
  const items = [];
  for (const [id, cs] of asB) {
    if (cs.length < 2 || cs.every(c => satisfied(scene, c))) continue;
    const el = findElement(scene, id)?.el;
    items.push({ level: 'error', kind: 'constraint', ids: [id, ...cs.map(c => c.a)], message: `${el ? nameOf(el) : id} is over-constrained: ${cs.map(c => c.text || c.id).join('; ')} cannot all hold` });
  }
  return items;
}

const SPIRAL = (() => {
  const out = [];
  const n = SPIRAL_MAX / SPIRAL_STEP;
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
    const dx = i * SPIRAL_STEP, dy = j * SPIRAL_STEP, dist = Math.hypot(dx, dy);
    if (dist === 0 || dist > SPIRAL_MAX) continue;
    // angle clockwise from north, so ties at equal distance resolve the same way everywhere
    out.push({ dx, dy, dist, ang: (Math.atan2(dx, -dy) + 2 * Math.PI) % (2 * Math.PI) });
  }
  return out.sort((a, b) => a.dist - b.dist || a.ang - b.ang);
})();

function collidesWithAny(el, all, fps, self = el) {
  const { fp, box } = fps.get(el);
  for (const o of all) {
    if (o === self || !blocks(el, o)) continue;
    const other = fps.get(o);
    if (boxesNear(box, other.box) && overlaps(fp, other.fp)) return o;
  }
  return null;
}

// Water, walls and cliffs: a collision fix must not carry an object across one of these.
function barriersOf(scene) {
  return allElements(scene).filter(e => { const c = def(e).cat; return (c === 'water' || c === 'wall') && def(e).kind !== 'object'; })
    .map(e => (def(e).kind === 'path' ? { line: shapeOf(e, { center: true }) } : { poly: shapeOf(e) }));
}

function crossesBarrier(barriers, [x0, y0], [x1, y1]) {
  const seg = { core: 'line', pts: [[x0, y0], [x1, y1]], r: 0 };
  return barriers.some(b => {
    if (b.line) return coreDistance(seg, b.line) < 1e-9;
    if (pointInPoly([x0, y0], b.poly.pts)) return false; // starting inside: any way out is fine
    return coreDistance(seg, b.poly) < 1e-9;
  });
}

function resolveCollisions(scene, fps, moved, extraPinned = new Set()) {
  const W = scene.grid.widthFt, H = scene.grid.heightFt;
  const barriers = barriersOf(scene);
  const pinned = new Set(extraPinned);
  for (const c of scene.constraints) { pinned.add(c.a); pinned.add(c.b); }
  const all = allElements(scene);
  for (const el of all) if (el.locked || !isObject(el)) pinned.add(el.id);
  // An object yields to pinned elements and to earlier objects; later ones yield to it when their turn comes.
  const settled = all.filter(e => pinned.has(e.id));
  for (const el of scene.objects) {
    const blocker = pinned.has(el.id) ? null : collidesWithAny(el, settled, fps);
    if (!blocker) { if (!pinned.has(el.id)) settled.push(el); continue; }
    settled.push(el);
    const { x, y } = el.position;
    for (const s of SPIRAL) {
      if (crossesBarrier(barriers, [x, y], [x + s.dx, y + s.dy])) continue;
      const cand = moveTo(el, x + s.dx, y + s.dy);
      if (!insideMap(fps.get(cand).box, W, H)) { fps.forget(cand); continue; }
      const hit = collidesWithAny(cand, all, fps, el);
      fps.forget(cand);
      if (hit) continue;
      el.position = { ...cand.position };
      fps.forget(el);
      moved.push({ id: el.id, from: { x, y }, to: { ...el.position }, reason: 'collision', with: blocker.id });
      break;
    }
  }
}

// ---------------------------------------------------------------- report

const DIR_WORD = d => (d === 'any' || !d ? 'from' : `${d} of`);

function constraintItems(scene) {
  return scene.constraints.map(c => {
    const A = findElement(scene, c.a)?.el, B = findElement(scene, c.b)?.el;
    if (!A || !B) return { level: 'error', kind: 'constraint', ids: [c.a, c.b], message: `Constraint ${c.id} refers to a missing element`, expectedFt: c.ft };
    const actual = distanceFt(A, B, c.measure);
    let level = Math.abs(actual - c.ft) <= CONSTRAINT_TOL ? 'ok' : 'error';
    let message = `${nameOf(B)} is ${actual.toFixed(1)} ft ${DIR_WORD(c.direction)} ${nameOf(A)} (stated ${c.ft} ft)`;
    const d = DIRECTIONS[c.direction];
    if (level === 'ok' && d && !def(A).kind?.match(/path|region/) && !def(B).kind?.match(/path|region/)) {
      const [ax, ay] = centerOf(A), [bx, by] = centerOf(B);
      if ((bx - ax) * d[0] + (by - ay) * d[1] < -1e-6) { level = 'warn'; message += `, but it is not ${c.direction} of it`; }
    }
    return { level, kind: 'constraint', ids: [c.a, c.b], message, expectedFt: c.ft, actualFt: r2(actual) };
  });
}

function pairItems(all, fps) {
  const items = [];
  for (let i = 0; i < all.length; i++) {
    const A = all[i];
    for (let j = i + 1; j < all.length; j++) {
      const B = all[j];
      if (!blocks(A, B)) continue;
      const a = fps.get(A), b = fps.get(B);
      const need = Math.max(def(A).minGapFt || 0, def(B).minGapFt || 0);
      if (!boxesNear(a.box, b.box, need)) continue;
      if (overlaps(a.fp, b.fp)) {
        items.push({ level: 'error', kind: 'collision', ids: [A.id, B.id], message: `${nameOf(A)} overlaps ${nameOf(B)}` });
      } else if (need > 0) {
        const g = gap(a.fp, b.fp);
        if (g < need - 0.01) {
          items.push({ level: 'warn', kind: 'spacing', ids: [A.id, B.id], message: `${nameOf(A)} and ${nameOf(B)} are ${g.toFixed(1)} ft apart (want ${need} ft)`, expectedFt: need, actualFt: r2(g) });
        }
      }
    }
  }
  return items;
}

function boundsAndSizeItems(scene, fps) {
  const W = scene.grid.widthFt, H = scene.grid.heightFt, items = [];
  for (const el of scene.objects) {
    if (!insideMap(fps.get(el).box, W, H)) items.push({ level: 'error', kind: 'bounds', ids: [el.id], message: `${nameOf(el)} extends outside the ${W} x ${H} ft map` });
    const s = def(el).sizeFt;
    if (s) {
      const fits = (w, h) => w >= s.min[0] - 1e-9 && h >= s.min[1] - 1e-9 && w <= s.max[0] + 1e-9 && h <= s.max[1] + 1e-9;
      const { w, h } = el.size;
      if (!fits(w, h) && !fits(h, w)) {
        items.push({ level: 'warn', kind: 'size', ids: [el.id], message: `${nameOf(el)} is ${w} x ${h} ft; a ${el.type} is ${s.min.join(' x ')} to ${s.max.join(' x ')} ft (typical ${s.typical.join(' x ')})` });
      }
    }
  }
  for (const el of scene.paths) {
    const wf = def(el).widthFt, w = el.params.width;
    if (wf && (w < wf.min || w > wf.max)) {
      items.push({ level: 'warn', kind: 'size', ids: [el.id], message: `${nameOf(el)} is ${w} ft wide; a ${el.type} is ${wf.min} to ${wf.max} ft (typical ${wf.typical})` });
    }
  }
  return items;
}

function bridgeItems(scene, fps) {
  const all = allElements(scene), items = [];
  const water = all.filter(e => def(e).cat === 'water');
  const bridges = scene.objects.filter(e => e.type === 'bridge');
  for (const b of bridges) {
    if (!water.some(w => overlaps(fps.get(b).fp, shapeOf(w)))) items.push({ level: 'warn', kind: 'bridge', ids: [b.id], message: `${nameOf(b)} does not cross any water` });
  }
  // A road crosses water where its centreline is wet; every wet sample (1 ft apart) must be on a bridge deck.
  for (const road of scene.paths.filter(e => e.type === 'road')) {
    const line = shapeOf(road, { center: true });
    const segs = line.pts.slice(1).map((p, i) => [line.pts[i], p]);
    if (line.closed && line.pts.length > 2) segs.push([line.pts[line.pts.length - 1], line.pts[0]]);
    const samples = segs.flatMap(([a, b]) => {
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
      return Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
    });
    for (const w of water) {
      const ws = shapeOf(w);
      const wet = ([x, y]) => (ws.core === 'poly' ? pointInPoly([x, y], ws.pts) : coreDistance(pointShape(x, y), ws) < ws.r);
      const onBridge = ([x, y]) => bridges.some(b => gap(pointShape(x, y), fps.get(b).fp) <= 0.01);
      if (samples.some(p => wet(p) && !onBridge(p))) {
        items.push({ level: 'warn', kind: 'bridge', ids: [road.id, w.id], message: `${nameOf(road)} crosses ${nameOf(w)} with no bridge` });
      }
    }
  }
  return items;
}

// 5 ft cells; true = blocked. Line blockers block every cell they touch (centre within width/2 + half the
// cell diagonal), so a thin fence cannot leak a diagonal gap; area blockers use the cell centre.
function blockedGrid(scene, fps) {
  const cols = Math.round(scene.grid.widthFt / CELL), rows = Math.round(scene.grid.heightFt / CELL);
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(false));
  const touch = CELL * Math.SQRT1_2;
  const forCells = (box, pad, fn) => {
    const c0 = Math.max(0, Math.floor((box.minX - pad) / CELL)), c1 = Math.min(cols - 1, Math.floor((box.maxX + pad) / CELL));
    const r0 = Math.max(0, Math.floor((box.minY - pad) / CELL)), r1_ = Math.min(rows - 1, Math.floor((box.maxY + pad) / CELL));
    for (let r = r0; r <= r1_; r++) for (let c = c0; c <= c1; c++) fn(r, c, (c + 0.5) * CELL, (r + 0.5) * CELL);
  };
  const inside = (s, x, y) => (s.core === 'poly' && s.r === 0 ? pointInPoly([x, y], s.pts) : coreDistance(pointShape(x, y), s) < s.r);
  const all = allElements(scene);
  for (const el of all) {
    const d = def(el), deep = el.params?.depth === 'deep';
    if (d.cat !== 'water' || !deep) continue;
    const s = shapeOf(el);
    if (d.kind === 'path') forCells(boxOfShape(s), touch, (r, c, x, y) => { if (coreDistance(pointShape(x, y), s) <= s.r + touch) grid[r][c] = true; });
    else forCells(boxOfShape(s), 0, (r, c, x, y) => { if (inside(s, x, y)) grid[r][c] = true; });
  }
  for (const b of scene.objects.filter(e => e.type === 'bridge')) {
    const { fp, box } = fps.get(b);
    forCells(box, CELL, (r, c, x, y) => { if (gap(pointShape(x, y), fp) <= CELL / 2) grid[r][c] = false; });
  }
  for (const el of all) {
    const d = def(el);
    if (d.cat === 'wall') {
      const s = shapeOf(el);
      forCells(boxOfShape(s), touch, (r, c, x, y) => { if (coreDistance(pointShape(x, y), s) <= s.r + touch) grid[r][c] = true; });
    } else if (d.kind === 'object' && (d.cat === 'object' || d.cat === 'structure')) {
      const { fp, box } = fps.get(el);
      forCells(box, 0, (r, c, x, y) => { if (inside(fp, x, y)) grid[r][c] = true; });
    }
  }
  return grid;
}

function hasRoute(grid, westEast) {
  const rows = grid.length, cols = grid[0]?.length || 0;
  if (!rows || !cols) return false;
  const seen = grid.map(row => row.map(() => false));
  const queue = [];
  if (westEast) { for (let r = 0; r < rows; r++) if (!grid[r][0]) { seen[r][0] = true; queue.push([r, 0]); } }
  else { for (let c = 0; c < cols; c++) if (!grid[0][c]) { seen[0][c] = true; queue.push([0, c]); } }
  for (let q = 0; q < queue.length; q++) {
    const [r, c] = queue[q];
    if (westEast ? c === cols - 1 : r === rows - 1) return true;
    for (const [nr, nc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
      if (nr < 0 || nc < 0 || nr >= rows || nc >= cols || seen[nr][nc] || grid[nr][nc]) continue;
      seen[nr][nc] = true;
      queue.push([nr, nc]);
    }
  }
  return false;
}

function coverPct(scene, grid) {
  const covers = allElements(scene).filter(e => COVER_TYPES.has(e.type)).map(e => { const s = shapeOf(e); return { s, box: boxOfShape(s) }; });
  let open = 0, covered = 0;
  grid.forEach((row, r) => row.forEach((blocked, c) => {
    if (blocked) return;
    open++;
    const x = (c + 0.5) * CELL, y = (r + 0.5) * CELL, p = pointShape(x, y), pb = { minX: x, minY: y, maxX: x, maxY: y };
    if (covers.some(cv => boxesNear(pb, cv.box, COVER_FT) && gap(p, cv.s) <= COVER_FT)) covered++;
  }));
  return open ? r1((100 * covered) / open) : 0;
}

function movedItems(scene, moved) {
  const nm = id => { const e = findElement(scene, id)?.el; return e ? nameOf(e) : id; };
  return moved.map(m => {
    const ft = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y).toFixed(1);
    const why = m.reason === 'collision' ? `to clear a collision with ${nm(m.with)}`
      : m.reason === 'bounds' ? 'back inside the map'
      : m.reason === 'attached' ? `with ${nm(m.with)}`
      : `to keep ${scene.constraints.filter(c => m.reason.split(/[ ,]/).includes(c.id)).map(c => c.text || c.id).join('; ')}`;
    return { level: 'warn', kind: 'moved', ids: [m.id], message: `${nm(m.id)} moved ${ft} ft ${why}` };
  });
}

function buildReport(scene, fps, moved, extra = []) {
  const all = allElements(scene);
  const items = [...constraintItems(scene), ...extra, ...movedItems(scene, moved), ...pairItems(all, fps), ...boundsAndSizeItems(scene, fps), ...bridgeItems(scene, fps)];
  const grid = blockedGrid(scene, fps);
  const lanes = { westEast: hasRoute(grid, true), northSouth: hasRoute(grid, false) };
  items.push(lanes.westEast
    ? { level: 'ok', kind: 'lane', ids: [], message: 'A 5 ft route crosses the map west to east' }
    : { level: 'warn', kind: 'lane', ids: [], message: 'No 5 ft wide route crosses the map west to east' });
  items.push(lanes.northSouth
    ? { level: 'ok', kind: 'lane', ids: [], message: 'A 5 ft route crosses the map north to south' }
    : { level: 'warn', kind: 'lane', ids: [], message: 'No 5 ft wide route crosses the map north to south' });
  const pct = coverPct(scene, grid);
  items.push({ level: pct < COVER_MIN_PCT ? 'warn' : 'ok', kind: 'cover', ids: [], message: `${pct}% of open ground is within ${COVER_FT} ft of cover` + (pct < COVER_MIN_PCT ? ` (aim for ${COVER_MIN_PCT}%)` : '') });
  return { ok: !items.some(i => i.level === 'error'), items, moved, stats: { elements: all.length, coverPct: pct, lanes } };
}

// ---------------------------------------------------------------- API

export function layoutScene(input, { fix = true } = {}) {
  const scene = normalizeScene(input);
  const fps = footprints();
  const moved = [];
  if (!fix) return { scene, report: buildReport(scene, fps, moved) };
  clampToMap(scene, fps, moved);
  const attachedPinned = new Set();
  const extra = solveConstraints(scene, fps, moved, attachedPinned);
  clampToMap(scene, fps, moved); // a solved b may have left the map; the broken constraint is then reported
  resolveCollisions(scene, fps, moved, attachedPinned);
  const report = buildReport(scene, fps, moved, extra);
  // Never hand back a scene the validator rejects: keep the input instead and say why.
  const check = validateScene(scene);
  if (!check.ok && validateScene(input).ok) {
    const kept = layoutScene(input, { fix: false });
    kept.report.items.push({ level: 'error', kind: 'bounds', ids: [], message: `Layout left the scene unchanged: its result was invalid (${check.errors[0]?.path}: ${check.errors[0]?.message})` });
    kept.report.ok = false;
    return kept;
  }
  return { scene, report };
}

export function checkScene(scene) {
  return layoutScene(scene, { fix: false }).report;
}

export function neighbours(scene, ids, radiusFt = 40) {
  const want = new Set(ids);
  const all = allElements(scene);
  const targets = all.filter(e => want.has(e.id)).map(e => ({ el: e, box: boundsOf(e) }));
  return all.filter(e => !want.has(e.id) && targets.some(t => boxesNear(t.box, boundsOf(e), radiusFt) && distanceFt(t.el, e, 'edge') <= radiusFt));
}

export function summarizeScene(scene) {
  const all = allElements(scene);
  const counts = {};
  for (const e of all) counts[e.type] = (counts[e.type] || 0) + 1;
  return {
    name: scene.meta?.name,
    widthFt: scene.grid.widthFt,
    heightFt: scene.grid.heightFt,
    terrain: scene.terrain,
    lighting: scene.lighting,
    counts,
    elements: all.slice(0, 400).map(e => ({
      id: e.id, type: e.type, name: e.name,
      x: r1(e.position.x), y: r1(e.position.y), w: r1(e.size?.w ?? 0), h: r1(e.size?.h ?? 0), rotation: r1(e.rotation || 0),
    })),
  };
}

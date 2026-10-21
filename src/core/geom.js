// Geometry in feet. x east, y south, rotation degrees clockwise (same as SVG rotate()).
// This is the single definition of "distance" used by layout, measure tool and report.
import { TYPES } from '../schema.js';

export const rotatePt = ([x, y], deg) => {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [x * c - y * s, x * s + y * c];
};

// Local element coordinates (relative to position, before rotation) -> world feet.
export function toWorld(el, p) {
  const [x, y] = rotatePt(p, el.rotation || 0);
  return [x + el.position.x, y + el.position.y];
}

export function toLocal(el, [wx, wy]) {
  return rotatePt([wx - el.position.x, wy - el.position.y], -(el.rotation || 0));
}

export const kindOf = el => TYPES[el.type]?.kind;

// Shape = { core: 'point'|'line'|'poly', pts: [[x,y],...], r, closed }.
// Distance between shapes = distance between cores minus both radii (never negative).
// scale < 1 shrinks object footprints (collision); scale 1 is the visual extent (measuring).
export function shapeOf(el, { scale = 1, center = false } = {}) {
  const def = TYPES[el.type] || {};
  const kind = def.kind;
  const { w, h } = el.size;
  if (kind === 'path') {
    return { core: 'line', pts: el.params.points.map(p => toWorld(el, p)), r: center ? 0 : (el.params.width / 2) * scale, closed: !!el.params.closed };
  }
  if (kind === 'region') return { core: 'poly', pts: el.params.points.map(p => toWorld(el, p)), r: 0 };
  if (center) return { core: 'point', pts: [[el.position.x, el.position.y]], r: 0 };
  const footprint = el.params?.shape === 'round' ? 'circle' : def.footprint;
  if (kind === 'object' && footprint === 'circle') {
    return { core: 'point', pts: [[el.position.x, el.position.y]], r: ((w + h) / 4) * scale };
  }
  const hw = (w / 2) * scale, hh = (h / 2) * scale;
  return { core: 'poly', pts: [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(p => toWorld(el, p)), r: 0 };
}

// Collision footprint uses the type's footprintScale.
export const footprintOf = el => shapeOf(el, { scale: TYPES[el.type]?.footprintScale ?? 1 });

function segments(s) {
  const { pts } = s;
  if (s.core === 'point' || pts.length === 1) return [[pts[0], pts[0]]];
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) out.push([pts[i], pts[i + 1]]);
  if ((s.core === 'poly' || s.closed) && pts.length > 2) out.push([pts[pts.length - 1], pts[0]]);
  return out;
}

export function pointSegDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

// Proper crossing (interiors intersect, not merely touching).
function segsCross(a, b, c, d) {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
}

export function segSegDist(a, b, c, d) {
  if (segsCross(a, b, c, d)) return 0;
  return Math.min(pointSegDist(a, c, d), pointSegDist(b, c, d), pointSegDist(c, a, b), pointSegDist(d, a, b));
}

export function pointInPoly(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const centroid = pts => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];

// Minimum distance between cores; 0 when one core is inside a polygon core.
export function coreDistance(A, B) {
  if (A.core === 'poly' && B.pts.some(p => pointInPoly(p, A.pts))) return 0;
  if (B.core === 'poly' && A.pts.some(p => pointInPoly(p, B.pts))) return 0;
  let best = Infinity;
  for (const [a, b] of segments(A)) for (const [c, d] of segments(B)) best = Math.min(best, segSegDist(a, b, c, d));
  return best;
}

// Edge-to-edge gap in feet (0 when touching or overlapping).
export const gap = (A, B) => Math.max(0, coreDistance(A, B) - A.r - B.r);

// True when the shapes share positive area (touching is not overlap). tol in feet.
export function overlaps(A, B, tol = 0.01) {
  if (A.r > 0 || B.r > 0) return coreDistance(A, B) < A.r + B.r - tol;
  if (A.core === 'poly' && B.core === 'poly') {
    const strictlyInside = (p, poly) => pointInPoly(p, poly) && segments({ core: 'poly', pts: poly }).every(([a, b]) => pointSegDist(p, a, b) > tol);
    // Probe vertices, edge midpoints and centroid: catches aligned rects whose corners sit exactly on edges.
    const probes = s => [...s.pts, ...segments(s).map(([a, b]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]), centroid(s.pts)];
    if (probes(A).some(p => strictlyInside(p, B.pts)) || probes(B).some(p => strictlyInside(p, A.pts))) return true;
    for (const [a, b] of segments(A)) for (const [c, d] of segments(B)) if (segsCross(a, b, c, d)) return true;
    return false;
  }
  return false; // zero-radius line or point vs non-poly: no area
}

// Distance between two elements as the measure tool and constraints define it.
// measure 'edge': visual edge to visual edge. 'center': centre point (objects/labels),
// centreline (paths) or polygon (regions) to the same on the other element.
export function distanceFt(elA, elB, measure = 'edge') {
  const center = measure === 'center';
  const A = shapeOf(elA, { center }), B = shapeOf(elB, { center });
  return center ? coreDistance(A, B) : gap(A, B);
}

// World axis-aligned bounds {minX, minY, maxX, maxY} of the visual extent.
export function boundsOf(el) {
  const s = shapeOf(el);
  const xs = s.pts.map(p => p[0]), ys = s.pts.map(p => p[1]);
  return { minX: Math.min(...xs) - s.r, minY: Math.min(...ys) - s.r, maxX: Math.max(...xs) + s.r, maxY: Math.max(...ys) + s.r };
}

export const DIRECTIONS = {
  north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0],
  northeast: [Math.SQRT1_2, -Math.SQRT1_2], northwest: [-Math.SQRT1_2, -Math.SQRT1_2],
  southeast: [Math.SQRT1_2, Math.SQRT1_2], southwest: [-Math.SQRT1_2, Math.SQRT1_2],
};

export const snap = (v, step = 5) => Math.round(v / step) * step;

// Grid snap for drag: if rotation is a multiple of 90, snap the bounding-box corner to the
// 5 ft grid (so a 10x5 wagon fills exactly 2x1 squares); otherwise snap the centre to 2.5 ft.
export function snapPosition(el, pos) {
  const rot = (((el.rotation || 0) % 360) + 360) % 360;
  if (kindOf(el) !== 'object' || rot % 90 !== 0) return { x: snap(pos.x, 2.5), y: snap(pos.y, 2.5) };
  const swap = rot % 180 !== 0;
  const hw = (swap ? el.size.h : el.size.w) / 2, hh = (swap ? el.size.w : el.size.h) / 2;
  return { x: snap(pos.x - hw, 5) + hw, y: snap(pos.y - hh, 5) + hh };
}

// Painting helpers shared by the renderer and the terrain/path/region generators (agent 1).
// Pure geometry + small SVG builders. Everything is in feet, everything is deterministic.
import { h, smoothD } from '../core/svg.js';
import { pointInPoly, pointSegDist } from '../core/geom.js';

// 2-decimal number formatting keeps dense paths compact and byte-stable.
export const n2 = v => { const r = Math.round(v * 100) / 100; return Object.is(r, -0) ? 0 : r; };
export const D = (pts, closed = false) => pts.length ? 'M' + pts.map(p => `${n2(p[0])} ${n2(p[1])}`).join('L') + (closed ? 'Z' : '') : '';

export function bboxOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
export const grow = (b, m) => ({ x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m });

// Catmull-Rom spline (same curve as core smoothD, tension 0.5) sampled to a dense polyline.
export function densify(pts, closed = false, step = 0.75, linear = false) {
  const n = pts.length;
  if (n < 2) return pts.slice();
  if (linear) {
    const out = [];
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = pts[i], b = pts[(i + 1) % n], k = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
      for (let j = 0; j < k; j++) out.push([a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k]);
    }
    if (!closed) out.push(pts[n - 1].slice());
    return out;
  }
  if (n === 2 && !closed) {
    const L = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
    const k = Math.max(1, Math.ceil(L / step));
    return Array.from({ length: k + 1 }, (_, i) => [pts[0][0] + (pts[1][0] - pts[0][0]) * i / k, pts[0][1] + (pts[1][1] - pts[0][1]) * i / k]);
  }
  const P = i => closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))];
  const k = 0.5 / 3, out = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const c1 = [p1[0] + (p2[0] - p0[0]) * k, p1[1] + (p2[1] - p0[1]) * k];
    const c2 = [p2[0] - (p3[0] - p1[0]) * k, p2[1] - (p3[1] - p1[1]) * k];
    const L = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const m = Math.max(2, Math.ceil(L / step));
    for (let j = 0; j < m; j++) {
      const t = j / m, u = 1 - t;
      const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
      out.push([a * p1[0] + b * c1[0] + c * c2[0] + d * p2[0], a * p1[1] + b * c1[1] + c * c2[1] + d * p2[1]]);
    }
  }
  if (!closed) out.push(pts[n - 1].slice());
  return out;
}

export function cumLengths(poly, closed = false) {
  const cum = [0];
  for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]));
  if (closed && poly.length > 1) cum.push(cum[cum.length - 1] + Math.hypot(poly[0][0] - poly[poly.length - 1][0], poly[0][1] - poly[poly.length - 1][1]));
  return cum;
}

// Left-hand unit normals (walking first -> last point, y south: heading east, left is north).
export function normals(poly, closed = false) {
  const n = poly.length;
  return poly.map((p, i) => {
    const a = closed ? poly[(i - 1 + n) % n] : poly[Math.max(0, i - 1)];
    const b = closed ? poly[(i + 1) % n] : poly[Math.min(n - 1, i + 1)];
    const tx = b[0] - a[0], ty = b[1] - a[1], L = Math.hypot(tx, ty) || 1;
    return [ty / L, -tx / L];
  });
}

// Smooth 1D value noise in [-1, 1] over arc length s with the given wavelength. Wraps at period if set.
export function noise1(rng, wavelength, period = 0) {
  const knots = period ? Math.max(3, Math.round(period / wavelength)) : 0;
  const cache = [];
  const r = rng.fork('n1');
  const val = i => {
    if (knots) i = ((i % knots) + knots) % knots;
    else if (i < 0) i = -i;
    while (cache.length <= i) cache.push(r.range(-1, 1));
    return cache[i];
  };
  const wl = knots ? period / knots : wavelength;
  return s => {
    const x = s / wl, i = Math.floor(x), f = x - i, t = f * f * (3 - 2 * f);
    return val(i) * (1 - t) + val(i + 1) * t;
  };
}

// Dense, gently meandering version of a polyline/polygon (seeded perpendicular wobble).
export function wobble(pts, rng, { amp = 0.6, wavelength = 12, step = 0.75, closed = false, linear = false } = {}) {
  const poly = densify(pts, closed, step, linear);
  if (!amp) return poly;
  const cum = cumLengths(poly, closed), total = cum[cum.length - 1];
  const nz = noise1(rng, wavelength, closed ? total : 0);
  const nm = normals(poly, closed);
  return poly.map((p, i) => {
    // Pin open ends so paths still meet the points the user gave (map edges, bridges).
    const fade = closed ? 1 : Math.min(1, cum[i] / (wavelength * 0.5), (total - cum[i]) / (wavelength * 0.5));
    const d = nz(cum[i]) * amp * fade;
    return [p[0] + nm[i][0] * d, p[1] + nm[i][1] * d];
  });
}

// Offset polyline by per-point distance d(i) along the left normal (negative = right).
export function offset(poly, nm, d) {
  return poly.map((p, i) => { const v = typeof d === 'function' ? d(i) : d; return [p[0] + nm[i][0] * v, p[1] + nm[i][1] * v]; });
}

// Band between two offsets of a centreline as SVG path data (open: one polygon; closed: two rings, evenodd).
export function bandD(poly, nm, dA, dB, closed = false) {
  const A = offset(poly, nm, dA), B = offset(poly, nm, dB);
  return closed ? D(A, true) + D(B.reverse(), true) : D([...A, ...B.reverse()], true);
}

// Position + unit tangent at arc length s along a dense polyline.
export function at(poly, cum, s) {
  const n = poly.length;
  let lo = 0, hi = cum.length - 1;
  s = Math.max(0, Math.min(cum[hi], s));
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
  const a = poly[lo % n], b = poly[hi % n];
  const L = cum[hi] - cum[lo] || 1, t = (s - cum[lo]) / L;
  const tx = (b[0] - a[0]) / L, ty = (b[1] - a[1]) / L;
  return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], t: [tx, ty], n: [ty, -tx] };
}

export function edgeDist(p, poly) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) best = Math.min(best, pointSegDist(p, poly[j], poly[i]));
  return best;
}

// Uniform random points inside a polygon (rejection sampling), each with its distance to the edge.
export function scatter(rng, poly, count, maxTries = count * 6) {
  const b = bboxOf(poly), out = [];
  for (let t = 0; t < maxTries && out.length < count; t++) {
    const p = [b.x + rng.next() * b.w, b.y + rng.next() * b.h];
    if (pointInPoly(p, poly)) out.push({ p, edge: edgeDist(p, poly) });
  }
  return out;
}

export function polyArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  return Math.abs(a / 2);
}

// Irregular angular stone outline around (cx, cy).
export function stonePts(rng, cx, cy, r, { sides = 0, squash = 0.25 } = {}) {
  const n = sides || rng.int(5, 8), rot = rng.next() * Math.PI * 2, sq = 1 - rng.next() * squash, out = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2 + rng.range(-0.35, 0.35) / n * 2;
    const rr = r * rng.range(0.72, 1.12);
    const x = Math.cos(a) * rr, y = Math.sin(a) * rr * sq;
    out.push([cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)]);
  }
  return out;
}

// Seeded blob (soft organic patch) as a closed polygon.
export function blobPts(rng, cx, cy, rx, ry = rx, n = 9) {
  const rot = rng.next() * Math.PI * 2, out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, k = rng.range(0.65, 1.15);
    const x = Math.cos(a) * rx * k, y = Math.sin(a) * ry * k;
    out.push([cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)]);
  }
  return out;
}

// Smooth closed blob path (Catmull-Rom through blobPts).
export const blobD = (rng, cx, cy, rx, ry = rx, n = 9) => smoothD(blobPts(rng, cx, cy, rx, ry, n), true);

// ---- filter builders (userSpaceOnUse everywhere: identical at any export scale) ----

export function filterEl(doc, id, box, prims) {
  const attrs = { id, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' };
  if (box) Object.assign(attrs, { x: n2(box.x), y: n2(box.y), width: n2(box.w), height: n2(box.h) });
  return h('filter', attrs, prims, doc);
}

const greyMatrix = '1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 0 0 0 0 1';

// Painted-surface filter chain for path/region bodies:
// rough = displacement (ft) for ragged edges, mottle/grain = brightness modulation amplitudes,
// feather = alpha blur (ft) for a soft edge, blur = plain blur (ft) for soft underlays.
export function surfaceFilter(doc, id, box, { seed = 1, rough = 0, roughFreq = 0.15, mottle = 0, mottleFreq = 0.07, grain = 0, grainFreq = 1.4, feather = 0, blur = 0 } = {}) {
  const P = [], s = seed % 9973;
  let cur = 'SourceGraphic';
  if (rough) {
    P.push(h('feTurbulence', { type: 'fractalNoise', baseFrequency: roughFreq, numOctaves: 3, seed: s, result: 'rn' }, [], doc));
    P.push(h('feDisplacementMap', { in: cur, in2: 'rn', scale: rough, xChannelSelector: 'R', yChannelSelector: 'G', result: 'disp' }, [], doc));
    cur = 'disp';
  }
  if (blur) { P.push(h('feGaussianBlur', { in: cur, stdDeviation: blur, result: 'bl' }, [], doc)); cur = 'bl'; }
  const shapeRef = cur;
  const modulate = (amp, freq, oct, tag) => {
    P.push(h('feTurbulence', { type: 'fractalNoise', baseFrequency: freq, numOctaves: oct, seed: s + tag, result: `t${tag}` }, [], doc));
    P.push(h('feColorMatrix', { in: `t${tag}`, type: 'matrix', values: greyMatrix, result: `g${tag}` }, [], doc));
    P.push(h('feComposite', { in: cur, in2: `g${tag}`, operator: 'arithmetic', k1: n2(2 * amp), k2: n2(1 - amp), k3: 0, k4: 0, result: `m${tag}` }, [], doc));
    P.push(h('feComposite', { in: `m${tag}`, in2: shapeRef, operator: 'in', result: `c${tag}` }, [], doc));
    cur = `c${tag}`;
  };
  if (mottle) modulate(mottle, mottleFreq, 3, 11);
  if (grain) modulate(grain, grainFreq, 2, 23);
  if (feather) {
    P.push(h('feGaussianBlur', { in: shapeRef, stdDeviation: feather, result: 'fa' }, [], doc));
    P.push(h('feComposite', { in: cur, in2: 'fa', operator: 'in', result: 'out' }, [], doc));
  } else if (cur === 'SourceGraphic') {
    P.push(h('feOffset', { in: cur, dx: 0, dy: 0 }, [], doc));
  }
  return filterEl(doc, id, box, P);
}

// Water surface sheen: thin bright caustic veins where |noise| is near zero, kept inside the source shape.
export const sheenFilter = (doc, id, box, seed, freq = 0.45) => filterEl(doc, id, box, [
  h('feTurbulence', { type: 'turbulence', baseFrequency: freq, numOctaves: 2, seed: seed % 9973, result: 'n' }, [], doc),
  h('feColorMatrix', { in: 'n', type: 'matrix', values: '0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 -7 0 0 0 1', result: 'v' }, [], doc),
  h('feComposite', { in: 'v', in2: 'SourceAlpha', operator: 'in' }, [], doc),
]);

export const blurFilter = (doc, id, box, sd) => filterEl(doc, id, box, [h('feGaussianBlur', { stdDeviation: sd }, [], doc)]);

// Collect many small marks into one <path> per tone (keeps the DOM small).
export function strokeBatch() {
  const parts = new Map();
  return {
    add(key, d) { if (!parts.has(key)) parts.set(key, []); parts.get(key).push(d); },
    get: key => (parts.get(key) || []).join(''),
    keys: () => [...parts.keys()],
  };
}

// Tapered grass blade (filled) from base (x, y) at angle a (radians), length L, base width w.
export function bladeD(x, y, a, L, w, bend) {
  const dx = Math.cos(a), dy = Math.sin(a), nx = -dy, ny = dx;
  const tx = x + dx * L + nx * bend, ty = y + dy * L + ny * bend;
  const mx = x + dx * L * 0.55 + nx * bend * 0.6, my = y + dy * L * 0.55 + ny * bend * 0.6;
  const hw = w / 2, x0 = x + nx * hw, y0 = y + ny * hw;
  // Relative commands keep the (very many) blade paths short.
  return `M${n2(x0)} ${n2(y0)}q${n2(mx + nx * hw * 0.6 - x0)} ${n2(my + ny * hw * 0.6 - y0)} ${n2(tx - x0)} ${n2(ty - y0)}q${n2(mx - nx * hw * 0.6 - tx)} ${n2(my - ny * hw * 0.6 - ty)} ${n2(x - nx * hw - tx)} ${n2(y - ny * hw - ty)}z`;
}

// Local-frame light direction (toward the light) for an element: -shadowDir rotated by -rotation.
export function litDir(el, ctx) {
  const [sx, sy] = ctx.light.shadowDir;
  const r = -(el.rotation || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return [-(sx * c - sy * s), -(sx * s + sy * c)];
}
export const shadowAlpha = ctx => 0.28 * ctx.light.intensity + 0.1;

// Batch keys: 'f|color|opacity' (fill) or 's|color|opacity|strokeWidth' (stroke) -> <path> elements.
export function batchPaths(doc, b, extra = {}) {
  return b.keys().map(k => {
    const [kind, color, op = 1, sw] = k.split('|');
    return kind === 's'
      ? h('path', { d: b.get(k), fill: 'none', stroke: color, 'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: op, ...extra }, [], doc)
      : h('path', { d: b.get(k), fill: color, opacity: op, ...extra }, [], doc);
  });
}

// One small stone with a contact shadow and a lit facet, into a batch. lit = local unit vector toward the light.
export function pebble(b, rng, x, y, r, tone, lit = [-0.7, -0.7], shadowOp = 0.3) {
  const s = rng.int(1, 2 ** 30);
  const shape = (cx, cy, rr) => D(stonePts(createRngLite(s), cx, cy, rr), true);
  b.add(`f|#000000|${shadowOp}`, shape(x - lit[0] * r * 0.35, y - lit[1] * r * 0.35, r * 1.05));
  b.add(`f|${tone}|1`, shape(x, y, r));
  b.add('f|#ffffff|0.22', D(stonePts(createRngLite(s + 1), x + lit[0] * r * 0.28, y + lit[1] * r * 0.28, r * 0.45), true));
}

// Minimal mulberry32 (same as core rng) for throwaway shape streams without hashing cost.
function createRngLite(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, range: (lo, hi) => lo + (hi - lo) * next(), int: (lo, hi) => Math.floor(lo + (hi - lo + 1) * next()) };
}

export const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Shared painting helpers for the object generators (underscore prefix: helper, not a type).
// Colour maths, lighting in the element's local frame, shape builders, fill buckets, clipping
// and a polyline walker. Everything is pure and deterministic.
import { h, fmt } from '../core/svg.js';

export { fmt };

// Path data at 0.01 ft (0.6 px at print scale): ~25% smaller SVG than 3 decimals, no visible loss.
const f2 = v => Math.round(v * 100) / 100;
export function polyD(pts, closed = false) {
  if (!pts.length) return '';
  return 'M' + pts.map(p => `${f2(p[0])} ${f2(p[1])}`).join('L') + (closed ? 'Z' : '');
}
// Catmull-Rom spline as cubic Beziers (same as core smoothD, coarser number format).
export function smoothD(pts, closed = false, tension = 0.5) {
  const n = pts.length;
  if (n < 3) return polyD(pts, closed);
  const P = i => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  const k = tension / 3;
  let d = `M${f2(pts[0][0])} ${f2(pts[0][1])}`;
  for (let i = 0, segs = closed ? n : n - 1; i < segs; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    d += `C${f2(p1[0] + (p2[0] - p0[0]) * k)} ${f2(p1[1] + (p2[1] - p0[1]) * k)} ${f2(p2[0] - (p3[0] - p1[0]) * k)} ${f2(p2[1] - (p3[1] - p1[1]) * k)} ${f2(p2[0])} ${f2(p2[1])}`;
  }
  return d + (closed ? 'Z' : '');
}

// Used only when ctx.palette (src/render/palette.js) is missing a key.
const FALLBACK = {
  grass: ['#3e5a28', '#5a7a38', '#7e9c4c'],
  foliage: ['#2c4520', '#476b2e', '#7a9c46'],
  pine: ['#1c3524', '#2d5236', '#4c7646'],
  bark: ['#36271c', '#56402e', '#7a5f46'],
  wood: ['#5a3e25', '#86613c', '#ad8857'],
  woodDark: ['#2f2219', '#463224', '#5f4531'],
  stone: ['#55575a', '#7c7e80', '#a7a8a3'],
  dirt: ['#57432e', '#7a6244', '#9e835d'],
  water: ['#23465a', '#33687e', '#5d94a6'],
  cloth: ['#a99c7c', '#d2c6a6', '#ece3cb'],
  fire: ['#b8361a', '#f08424', '#ffe08a'],
  thatch: ['#76592c', '#a3833f', '#cbb06a'],
  slate: ['#39414c', '#525c68', '#77818d'],
};
// Extra tones the shared palette does not define.
export const TONES = {
  sandstone: ['#7a5a3a', '#a7825a', '#cfae80'],
  slateStone: ['#363d44', '#535b63', '#7b848b'],
  moss: ['#2f4a1e', '#4f6e2a', '#7d9a40'],
  metal: ['#2c2c2e', '#4a4b4e', '#7b7d80'],
  brick: ['#6a3224', '#93492f', '#b86b4a'],
  plaster: ['#9c8f78', '#cbbfa5', '#e8dfc8'],
  ash: ['#3a3734', '#5e5a55', '#8f8a82'],
  hay: ['#8a6d2c', '#bf9a45', '#e3c878'],
  burlap: ['#6e5636', '#9a7d52', '#c2a573'],
  rope: ['#6f5a3c', '#9d845c', '#c4ad82'],
};

export const pal = (ctx, key) => {
  const p = ctx && ctx.palette && ctx.palette[key];
  return Array.isArray(p) && p.length >= 3 ? p : FALLBACK[key] || TONES[key] || FALLBACK.stone;
};

export const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
export const lerp = (a, b, t) => a + (b - a) * t;

// ---------- colour ----------
function rgbOf(hex) {
  const n = parseInt(String(hex).slice(1, 7), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [128, 128, 128];
}
const hexOf = c => '#' + c.map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');

function toHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const hh = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [hh / 6, s, l];
}
function fromHsl([hh, s, l]) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = t => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(hh + 1 / 3) * 255, f(hh) * 255, f(hh - 1 / 3) * 255];
}

export const mix = (a, b, t) => {
  const A = rgbOf(a), B = rgbOf(b);
  return hexOf(A.map((v, i) => v + (B[i] - v) * t));
};
// k > 0 lightens toward white, k < 0 darkens toward black.
export const shade = (c, k) => (k >= 0 ? mix(c, '#ffffff', k) : mix(c, '#000000', -k));
// Shift hue (turns), saturation and lightness (absolute).
export function hsl(c, dh = 0, ds = 0, dl = 0) {
  const [hh, s, l] = toHsl(rgbOf(c));
  return hexOf(fromHsl([(hh + dh + 1) % 1, clamp(s + ds), clamp(l + dl)]));
}
// Natural variation: small hue/saturation/lightness jitter.
export const jit = (rng, c, amt = 0.06) => hsl(c, rng.range(-amt, amt) * 0.15, rng.range(-amt, amt) * 0.5, rng.range(-amt, amt) * 0.6);
// tones = [dark, mid, light]; t 0..1 walks dark -> mid -> light.
export function ramp(tones, t) {
  t = clamp(t);
  return t < 0.5 ? mix(tones[0], tones[1], t * 2) : mix(tones[1], tones[2], (t - 0.5) * 2);
}
// Build [dark, mid, light] from one base colour (tent cloth, label halo).
export const tonesFrom = c => [shade(hsl(c, 0, 0.02, 0), -0.42), c, shade(c, 0.3)];
export const luminance = c => { const [r, g, b] = rgbOf(c); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };

// ---------- environment ----------
// Lighting in the element's local frame plus small drawing shortcuts.
export function env(el, ctx = {}) {
  const L = ctx.light || {};
  const az = ((Number.isFinite(L.azimuth) ? L.azimuth : 315) * Math.PI) / 180;
  const rot = (-(el.rotation || 0) * Math.PI) / 180;
  const wx = Math.sin(az), wy = -Math.cos(az); // world unit vector toward the light
  const lx = wx * Math.cos(rot) - wy * Math.sin(rot), ly = wx * Math.sin(rot) + wy * Math.cos(rot);
  const intensity = clamp(Number.isFinite(L.intensity) ? L.intensity : 0.6);
  const elev = clamp(Number.isFinite(L.elevation) ? L.elevation : 45, 5, 90);
  const doc = ctx.doc || globalThis.document;
  const E = {
    el, ctx, doc, lx, ly, intensity,
    shadowOpacity: fmt(0.28 * intensity + 0.1),
    h: (tag, attrs, kids) => h(tag, attrs, kids, doc),
    pal: k => pal(ctx, k),
    // -1 (facing away from the light) .. 1 (facing it) for a local unit normal.
    lit: (nx, ny) => nx * lx + ny * ly,
    // max caps the offset length (ft) so low sun never throws a detached copy across neighbours.
    shadow(hFt, max = Infinity) {
      let v = null;
      if (typeof ctx.shadow === 'function') {
        const s = ctx.shadow(el, hFt);
        if (Array.isArray(s) && Number.isFinite(s[0]) && Number.isFinite(s[1])) v = s;
      }
      if (!v) { const d = Math.min(hFt / Math.tan((elev * Math.PI) / 180), 2 * hFt); v = [-lx * d, -ly * d]; }
      const L = Math.hypot(v[0], v[1]);
      return L > max ? [(v[0] * max) / L, (v[1] * max) / L] : v;
    },
    // Soft drop shadow: same silhouette, offset by the shadow vector for hFt.
    shadowEl(d, hFt, { wide = false, stroke = null, opacity = 1, max = Infinity } = {}) {
      const [dx, dy] = E.shadow(hFt, max);
      const a = { d, transform: `translate(${fmt(dx)} ${fmt(dy)})`, opacity: fmt(E.shadowOpacity * opacity), filter: `url(#${wide ? 'f-shadow-wide' : 'f-shadow'})` };
      if (stroke) Object.assign(a, { fill: 'none', stroke: '#000', 'stroke-width': stroke, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
      else a.fill = '#000';
      return h('path', a, [], doc);
    },
    def: (id, build) => (typeof ctx.def === 'function' ? ctx.def(id, build) : null),
    g: (attrs, kids) => h('g', attrs, kids, doc),
    path: (d, attrs = {}) => h('path', { d, ...attrs }, [], doc),
  };
  return E;
}

// ---------- shapes (path data strings) ----------
export function blobPts(rng, cx, cy, rx, ry, n = 9, jitter = 0.14, phase = null) {
  const ph = phase === null ? rng.next() * Math.PI * 2 : phase;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = ph + ((i + rng.range(-0.22, 0.22)) * 2 * Math.PI) / n;
    const k = 1 + rng.range(-jitter, jitter);
    pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
  }
  return pts;
}
export const blob = (rng, cx, cy, rx, ry, n, jitter, phase) => smoothD(blobPts(rng, cx, cy, rx, ry, n, jitter, phase), true);

export const circleD = (cx, cy, r) => `M${fmt(cx - r)} ${fmt(cy)}a${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(2 * r)} 0a${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(-2 * r)} 0Z`;
export const ellipseD = (cx, cy, rx, ry) => `M${fmt(cx - rx)} ${fmt(cy)}a${fmt(rx)} ${fmt(ry)} 0 1 0 ${fmt(2 * rx)} 0a${fmt(rx)} ${fmt(ry)} 0 1 0 ${fmt(-2 * rx)} 0Z`;

export function rectPts(cx, cy, w, hh, angDeg = 0) {
  const a = (angDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [[-w / 2, -hh / 2], [w / 2, -hh / 2], [w / 2, hh / 2], [-w / 2, hh / 2]].map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
}
export const rectD = (cx, cy, w, hh, ang = 0) => polyD(rectPts(cx, cy, w, hh, ang), true);

// Leaf / dab: a lens of length len and width wid at angle ang (radians).
export function lensD(x, y, len, wid, ang) {
  const fmt = f2, c = Math.cos(ang), s = Math.sin(ang);
  const ax = x - (c * len) / 2, ay = y - (s * len) / 2, bx = x + (c * len) / 2, by = y + (s * len) / 2;
  const nx = -s * wid, ny = c * wid;
  return `M${fmt(ax)} ${fmt(ay)}Q${fmt(x + nx)} ${fmt(y + ny)} ${fmt(bx)} ${fmt(by)}Q${fmt(x - nx)} ${fmt(y - ny)} ${fmt(ax)} ${fmt(ay)}Z`;
}
export const lineD = (x1, y1, x2, y2) => `M${f2(x1)} ${f2(y1)}L${f2(x2)} ${f2(y2)}`;

export const scalePts = (pts, k, cx = 0, cy = 0, dx = 0, dy = 0) => pts.map(([x, y]) => [cx + (x - cx) * k + dx, cy + (y - cy) * k + dy]);
export const centroid = pts => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];

// ---------- fill buckets ----------
// Many small shapes sharing a colour become one <path>; keys keep insertion order.
export function buckets() {
  const m = new Map();
  return {
    add(key, d) { if (d) m.set(key, (m.get(key) || '') + d); },
    has: () => m.size > 0,
    nodes(E, mk = fill => ({ fill })) {
      return [...m.entries()].map(([k, d]) => E.path(d, mk(k)));
    },
  };
}

// ---------- clipping ----------
// Sutherland-Hodgman: subject polygon clipped by a convex polygon (either winding).
export function clipPoly(subject, clip) {
  let area = 0;
  for (let i = 0; i < clip.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const sgn = area >= 0 ? 1 : -1;
  let out = subject;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const side = p => sgn * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
    const inp = out;
    out = [];
    for (let j = 0; j < inp.length; j++) {
      const p = inp[j], q = inp[(j + 1) % inp.length];
      const sp = side(p), sq = side(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
  }
  return out;
}
// Segment p0-p1 clipped by a convex polygon -> [a, b] or null.
export function clipSeg(p0, p1, clip) {
  let area = 0;
  for (let i = 0; i < clip.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const sgn = area >= 0 ? 1 : -1;
  let t0 = 0, t1 = 1;
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  for (let i = 0; i < clip.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const num = sgn * (ex * (p0[1] - a[1]) - ey * (p0[0] - a[0]));
    const den = sgn * (ex * dy - ey * dx);
    if (Math.abs(den) < 1e-12) { if (num < 0) return null; continue; }
    const t = -num / den;
    if (den > 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return [[p0[0] + dx * t0, p0[1] + dy * t0], [p0[0] + dx * t1, p0[1] + dy * t1]];
}

// ---------- polylines ----------
// Arc-length walker over params.points. at(s) -> {x, y, tx, ty, nx, ny}; sub(s0, s1) -> points.
export function walker(points, closed = false) {
  const raw = (Array.isArray(points) ? points : []).filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  const pts = closed && raw.length > 2 ? [...raw, raw[0]] : raw;
  const segs = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    segs.push({ a, b, len, s0: total, tx: (b[0] - a[0]) / len, ty: (b[1] - a[1]) / len });
    total += len;
  }
  const find = s => {
    let lo = 0, hi = segs.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (segs[mid].s0 <= s) lo = mid; else hi = mid - 1; }
    return segs[lo];
  };
  return {
    total, segs, closed: closed && raw.length > 2,
    at(s) {
      if (!segs.length) { const p = raw[0] || [0, 0]; return { x: p[0], y: p[1], tx: 1, ty: 0, nx: 0, ny: 1 }; }
      s = clamp(s, 0, total);
      const g = find(s), t = s - g.s0;
      return { x: g.a[0] + g.tx * t, y: g.a[1] + g.ty * t, tx: g.tx, ty: g.ty, nx: -g.ty, ny: g.tx };
    },
    sub(s0, s1) {
      if (!segs.length) return [];
      const a = this.at(s0), out = [[a.x, a.y]];
      for (const g of segs) if (g.s0 > s0 && g.s0 < s1) out.push(g.a);
      const b = this.at(s1);
      out.push([b.x, b.y]);
      return out;
    },
    // Arc-length positions of interior corners (and the start for closed lines).
    corners() { return segs.map(g => g.s0).filter(s => s > 0 || this.closed); },
  };
}

// Subtract intervals from [0, total]; inputs [[a, b], ...]; returns sorted kept intervals.
export function subtract(total, cuts) {
  let keep = [[0, total]];
  for (const [c0, c1] of cuts) {
    const next = [];
    for (const [a, b] of keep) {
      if (c1 <= a || c0 >= b) { next.push([a, b]); continue; }
      if (c0 > a) next.push([a, c0]);
      if (c1 < b) next.push([c1, b]);
    }
    keep = next;
  }
  return keep.filter(([a, b]) => b - a > 1e-3);
}

// SVG element helper shared by renderer, generators, editor and export.
export const SVG_NS = 'http://www.w3.org/2000/svg';

// h('path', { d, fill }, [children]) -> SVGElement. Numbers are rounded to 3 decimals
// so output is byte-stable across runs. null/undefined/false attributes are skipped.
export function h(tag, attrs = {}, children = [], doc = globalThis.document) {
  const el = doc.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    el.setAttribute(k, typeof v === 'number' ? String(fmt(v)) : String(v));
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c);
  }
  return el;
}

export const fmt = v => Math.round(v * 1000) / 1000;

// Points [[x,y],...] -> path data. closed adds Z.
export function polyD(pts, closed = false) {
  if (!pts.length) return '';
  return 'M' + pts.map(p => `${fmt(p[0])} ${fmt(p[1])}`).join('L') + (closed ? 'Z' : '');
}

// Smooth Catmull-Rom spline through points as cubic Beziers. tension 0..1 (0.5 is natural).
export function smoothD(pts, closed = false, tension = 0.5) {
  const n = pts.length;
  if (n < 3) return polyD(pts, closed);
  const P = i => closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))];
  const k = tension / 3;
  let d = `M${fmt(pts[0][0])} ${fmt(pts[0][1])}`;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const c1 = [p1[0] + (p2[0] - p0[0]) * k, p1[1] + (p2[1] - p0[1]) * k];
    const c2 = [p2[0] - (p3[0] - p1[0]) * k, p2[1] - (p3[1] - p1[1]) * k];
    d += `C${fmt(c1[0])} ${fmt(c1[1])} ${fmt(c2[0])} ${fmt(c2[1])} ${fmt(p2[0])} ${fmt(p2[1])}`;
  }
  return d + (closed ? 'Z' : '');
}

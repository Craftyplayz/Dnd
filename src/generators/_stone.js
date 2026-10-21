// Painted stone helpers: faceted rocks, pebble scatters and walls along polylines
// (stone, brick, timber, plaster) with gaps and rubble. Used by boulder, rock-cluster,
// campfire, building, bridge, ruined-wall and fence.
import { polyD, fmt, ramp, shade, jit, mix, clamp, walker, subtract, buckets, TONES, lineD, smoothD, circleD } from './_paint.js';

export function stoneTones(E, stone) {
  if (stone === 'sandstone') return TONES.sandstone;
  if (stone === 'slate') return TONES.slateStone;
  return E.pal('stone');
}

export function rockOutline(rng, cx, cy, rx, ry, rot = 0, n = rng.int(7, 10)) {
  const ph = rng.next() * Math.PI * 2, c = Math.cos(rot), s = Math.sin(rot), pts = [];
  for (let i = 0; i < n; i++) {
    const a = ph + ((i + rng.range(-0.3, 0.3)) * 2 * Math.PI) / n, k = rng.range(0.84, 1);
    const x = Math.cos(a) * rx * k, y = Math.sin(a) * ry * k;
    pts.push([cx + x * c - y * s, cy + x * s + y * c]);
  }
  return pts;
}

// One faceted rock. Returns { outline, nodes } (draw the shadow from outline yourself).
export function paintRock(E, rng, { cx = 0, cy = 0, rx, ry, rot = 0, tones, moss = false, cracks = true, n }) {
  const outer = rockOutline(rng, cx, cy, rx, ry, rot, n || rng.int(7, 10) + (Math.min(rx, ry) > 3 ? 3 : 0));
  const m = Math.min(rx, ry);
  const px = cx + rng.range(-0.14, 0.14) * rx + E.lx * 0.1 * m, py = cy + rng.range(-0.14, 0.14) * ry + E.ly * 0.1 * m;
  const ring = k0 => outer.map(([x, y]) => { const k = k0 * rng.range(0.88, 1.1); return [px + (x - px) * k, py + (y - py) * k]; });
  const mid = ring(0.74), inner = ring(0.44);
  const base = jit(rng, tones[1], 0.05);
  const T = [mix(tones[0], base, 0.25), base, jit(rng, tones[2], 0.04)];
  const rim = shade(tones[0], -0.3);
  const nodes = [E.path(polyD(outer, true), { fill: T[0], stroke: rim, 'stroke-width': fmt(clamp(m * 0.08, 0.08, 0.3)), 'stroke-linejoin': 'round' })];
  const N = outer.length, hi = [], lo = [];
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N, a = outer[i], b = outer[j];
    let nx = (a[0] + b[0]) / 2 - px, ny = (a[1] + b[1]) / 2 - py;
    const l = Math.hypot(nx, ny) || 1;
    nx /= l; ny /= l;
    const lit = E.lit(nx, ny);
    nodes.push(E.path(polyD([a, b, mid[j], mid[i]], true), { fill: ramp(T, clamp(0.3 + 0.36 * lit + rng.range(-0.06, 0.06))) }));
    nodes.push(E.path(polyD([mid[i], mid[j], inner[j], inner[i]], true), { fill: ramp(T, clamp(0.52 + 0.24 * lit + rng.range(-0.05, 0.05))) }));
    // Ridges: bright toward the light, dark away.
    if (lit > 0.25) hi.push(lineD(mid[i][0], mid[i][1], mid[j][0], mid[j][1]));
    else if (lit < -0.3) lo.push(lineD(a[0], a[1], b[0], b[1]));
    if (rng.chance(0.4)) (lit > 0 ? hi : lo).push(lineD(mid[i][0], mid[i][1], inner[i][0], inner[i][1]));
  }
  nodes.push(E.path(polyD(inner, true), { fill: ramp(T, 0.74 + rng.range(-0.05, 0.05)) }));
  const sw = fmt(clamp(m * 0.05, 0.05, 0.18));
  if (m > 0.8) {
    // speckle: painted grain on the stone surface
    let dk = '', lt = '';
    for (let k = Math.round(clamp(m * m * 4, 4, 160)); k > 0; k--) {
      const a2 = rng.next() * Math.PI * 2, rr = Math.sqrt(rng.next()) * 0.8;
      const x = cx + Math.cos(a2) * rx * rr, y = cy + Math.sin(a2) * ry * rr, r = clamp(m * rng.range(0.012, 0.03), 0.03, 0.09);
      if (rng.chance(0.5)) dk += circleD(x, y, r); else lt += circleD(x, y, r);
    }
    nodes.push(E.path(dk, { fill: rim, opacity: 0.35 }), E.path(lt, { fill: T[2], opacity: 0.4 }));
  }
  if (hi.length) nodes.push(E.path(hi.join(''), { fill: 'none', stroke: shade(T[2], 0.15), 'stroke-width': sw, 'stroke-linecap': 'round', opacity: 0.5 }));
  if (lo.length) nodes.push(E.path(lo.join(''), { fill: 'none', stroke: rim, 'stroke-width': sw, 'stroke-linecap': 'round', opacity: 0.6 }));
  if (cracks && m > 0.6) {
    let d = '';
    for (let k = rng.int(1, 2); k > 0; k--) {
      const i = rng.int(0, N - 1), a = inner[i], b = outer[i];
      const mx = (a[0] + b[0]) / 2 + rng.range(-0.1, 0.1) * m, my = (a[1] + b[1]) / 2 + rng.range(-0.1, 0.1) * m;
      d += `M${fmt(a[0])} ${fmt(a[1])}L${fmt(mx)} ${fmt(my)}L${fmt(lerpPt(a, b, 0.85)[0])} ${fmt(lerpPt(a, b, 0.85)[1])}`;
    }
    nodes.push(E.path(d, { fill: 'none', stroke: rim, 'stroke-width': fmt(sw * 0.8), opacity: 0.55, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  }
  if (moss) {
    const M = TONES.moss, dm = buckets(), dl = buckets();
    for (let k = rng.int(3, 6); k > 0; k--) {
      const a = rng.next() * Math.PI * 2, rr = rng.range(0, 0.6) * m;
      const mx = px + Math.cos(a) * rr - E.lx * 0.15 * m, my = py + Math.sin(a) * rr - E.ly * 0.15 * m;
      const r0 = rng.range(0.14, 0.28) * m;
      dm.add(jit(rng, M[1], 0.05), smoothD(rockOutline(rng, mx, my, r0, r0 * rng.range(0.6, 1), rng.next() * 3, 8), true));
      dl.add(M[2], smoothD(rockOutline(rng, mx + E.lx * r0 * 0.3, my + E.ly * r0 * 0.3, r0 * 0.45, r0 * 0.35, rng.next() * 3, 6), true));
    }
    nodes.push(...dm.nodes(E, fill => ({ fill, opacity: 0.8 })), ...dl.nodes(E, fill => ({ fill, opacity: 0.75 })));
  }
  return { outline: outer, nodes };
}
const lerpPt = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

// Many small stones in few paths. items: [{x, y, r, e (elongation), rot}].
export function paintPebbles(E, rng, items, tones, { shadowH = 0.4, shadow = true } = {}) {
  if (!items.length) return [];
  const sh = [], base = buckets(), mid = buckets(), hi = buckets();
  const V = [0, 1, 2].map(i => jit(rng, ramp(tones, 0.42 + i * 0.12), 0.04));
  const dark = mix(tones[0], '#000000', 0.15);
  for (const p of items) {
    const pts = rockOutline(rng, p.x, p.y, p.r, p.r * (p.e || rng.range(0.6, 0.95)), p.rot ?? rng.next() * Math.PI, rng.int(5, 7));
    const d = polyD(pts, true);
    sh.push(d);
    base.add(dark, d);
    const k = p.r * 0.14;
    mid.add(V[rng.int(0, 2)], polyD(pts.map(([x, y]) => [p.x + (x - p.x) * 0.82 + E.lx * k, p.y + (y - p.y) * 0.82 + E.ly * k]), true));
    if (p.r > 0.18) hi.add(tones[2], polyD(pts.map(([x, y]) => [p.x + (x - p.x) * 0.4 + E.lx * k * 2.4, p.y + (y - p.y) * 0.4 + E.ly * k * 2.4]), true));
  }
  return [
    shadow ? E.shadowEl(sh.join(''), shadowH) : null,
    ...base.nodes(E), ...mid.nodes(E), ...hi.nodes(E, fill => ({ fill, opacity: 0.7 })),
  ].filter(Boolean);
}

function union(list) {
  const s = list.filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]), out = [];
  for (const iv of s) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

const WALL = {
  stone: { block: 1.15, rowFt: 1.0 },
  brick: { block: 0.9, rowFt: 0.5 },
};

// Wall along a polyline. integrity 1 = continuous, 0 = rubble only. openings = [[s0, s1]] arc
// ranges left open (doors). keepCorners 0..1 = chance a stub survives at each corner.
// Returns { shadow: [nodes], body: [nodes], rubble: [nodes], kept, gaps }.
export function paintWall(E, rng, o) {
  const { points, closed = false, width, material = 'stone', integrity = 1, heightFt = 4, openings = [], keepCorners = 0, rubble = true, join = 'round', tones: tonesIn } = o;
  const W = walker(points, closed), L = W.total;
  const out = { shadow: [], body: [], rubble: [], kept: [], gaps: [] };
  if (L <= 0 || !(width > 0)) return out;
  const R = rng.fork('runs');
  const cuts = [];
  if (integrity < 0.999) {
    for (let s = -R.range(0, 5); s < L;) {
      const C = R.range(4, 10), intact = C * clamp(integrity * R.range(0.7, 1.3));
      if (C - intact > 0.35) cuts.push([s + intact, s + C]);
      s += C;
    }
  }
  const opens = union(openings.map(([a, b]) => [clamp(a, 0, L), clamp(b, 0, L)]));
  let kept = subtract(L, union(cuts));
  if (keepCorners > 0 && integrity < 0.999) {
    const a = Math.max(width * 1.6, 1.2), extra = [];
    for (const sc of W.corners()) {
      if (!R.chance(keepCorners)) continue;
      const a1 = a * R.range(0.8, 2);
      extra.push([sc - a1, sc + a1]);
      if (W.closed && sc - a1 < 0) extra.push([L + sc - a1, L]);
      if (W.closed && sc + a1 > L) extra.push([0, sc + a1 - L]);
    }
    kept = union([...kept, ...extra.map(([p, q]) => [clamp(p, 0, L), clamp(q, 0, L)])]);
  }
  kept = subtract(L, opens).flatMap(([a, b]) => kept.map(([c, d]) => [Math.max(a, c), Math.min(b, d)]).filter(([c, d]) => d - c > 0.05));
  kept = union(kept);
  const gaps = subtract(L, [...kept, ...opens]);
  out.kept = kept; out.gaps = gaps;
  const isOpenEnd = s => opens.some(([a, b]) => Math.abs(a - s) < 1e-6 || Math.abs(b - s) < 1e-6);
  const isEnd = s => !W.closed && (s < 1e-6 || s > L - 1e-6);

  const tones = tonesIn || (material === 'brick' ? TONES.brick : material === 'plaster' ? TONES.plaster : material === 'timber' ? E.pal('wood') : E.pal('stone'));
  const P = (s, t) => { const a = W.at(s); return [a.x + a.nx * t, a.y + a.ny * t]; };
  const strokeD = kept.map(([a, b]) => polyD(W.sub(a, b))).join('');
  if (strokeD) {
    out.shadow.push(E.shadowEl(strokeD, heightFt, { stroke: fmt(width) }));
    out.shadow[0].setAttribute('stroke-linecap', 'butt');
    out.shadow[0].setAttribute('stroke-linejoin', join);
  }
  const band = (color, wd = width) => E.path(strokeD, { fill: 'none', stroke: color, 'stroke-width': fmt(wd), 'stroke-linecap': 'butt', 'stroke-linejoin': join, 'stroke-miterlimit': 3 });

  if (material === 'stone' || material === 'brick') {
    const spec = WALL[material];
    const mortar = material === 'brick' ? '#5e554a' : shade(tones[0], -0.45);
    const rows = clamp(Math.round(width / spec.rowFt), 1, 8), rowT = width / rows, gap = Math.min(0.07, rowT * 0.12);
    const V = [0, 1, 2, 3].map(i => jit(rng, ramp(tones, 0.5 + i * 0.12), 0.05));
    const fills = buckets(), hiD = [], loD = [], mort = [];
    const B = rng.fork('blocks');
    for (const [a, b] of kept) {
      const raggedA = !isOpenEnd(a) && !isEnd(a), raggedB = !isOpenEnd(b) && !isEnd(b);
      for (let r = 0; r < rows; r++) {
        const t0 = -width / 2 + r * rowT, t1 = t0 + rowT;
        const unit = material === 'brick' ? spec.block : Math.max(spec.block, rowT * 1.1);
        let s = a + (material === 'brick' ? (r % 2) * unit * 0.5 - unit * 0.5 : -B.range(0, unit * 0.6));
        s = Math.max(a, s);
        if (raggedA) s += B.range(0, unit * 0.9);
        const end = raggedB ? b - B.range(0, unit * 0.9) : b;
        while (s < end - 0.12) {
          const len = Math.min(end - s, material === 'brick' ? unit : unit * B.range(0.6, 1.4));
          const s1 = s + len;
          const j = () => (material === 'brick' ? 0 : B.range(-0.06, 0.06));
          const q = [P(s + gap, t0 + gap + j()), P(s1 - gap, t0 + gap + j()), P(s1 - gap, t1 - gap + j()), P(s + gap, t1 - gap + j())];
          const corner = W.at((s + s1) / 2);
          fills.add(V[B.int(0, 3)], material === 'brick' ? polyD(q, true) : smoothD(q, true, 0.18));
          mort.push(polyD([P(s, t0), P(s1, t0), P(s1, t1), P(s, t1)], true));
          // Edge facing the light gets a highlight, the opposite edge a dark line.
          const nOut = E.lit(corner.nx, corner.ny);
          if (nOut > 0.2) hiD.push(polyD([q[3], q[2]])); else if (nOut < -0.2) hiD.push(polyD([q[0], q[1]]));
          if (nOut > 0.2) loD.push(polyD([q[0], q[1]])); else if (nOut < -0.2) loD.push(polyD([q[3], q[2]]));
          const tl = E.lit(corner.tx, corner.ty);
          if (tl > 0.3) hiD.push(polyD([q[1], q[2]])); else if (tl < -0.3) hiD.push(polyD([q[3], q[0]]));
          s = s1;
        }
      }
    }
    // mortar only under the blocks, so ragged ends stay ragged
    if (mort.length) out.body.push(E.path(mort.join(''), { fill: mortar, stroke: mortar, 'stroke-width': 0.06, 'stroke-linejoin': 'round' }));
    out.body.push(...fills.nodes(E));
    const lw = fmt(clamp(rowT * 0.12, 0.05, 0.14));
    if (hiD.length) out.body.push(E.path(hiD.join(''), { fill: 'none', stroke: shade(tones[2], 0.2), 'stroke-width': lw, opacity: 0.7, 'stroke-linecap': 'round' }));
    if (loD.length) out.body.push(E.path(loD.join(''), { fill: 'none', stroke: shade(tones[0], -0.35), 'stroke-width': lw, opacity: 0.6, 'stroke-linecap': 'round' }));
  } else {
    // timber / plaster: a solid band with planks or render, timber posts at corners and intervals.
    const wood = E.pal('wood'), woodDark = E.pal('woodDark');
    if (strokeD) {
      if (material === 'timber') {
        out.body.push(band(woodDark[1]));
        const rows = clamp(Math.round(width / 0.4), 1, 4), rowT = width / rows, fills = buckets(), B = rng.fork('planks');
        const V = [0, 1, 2].map(i => jit(B, ramp(wood, 0.35 + i * 0.13), 0.05));
        for (const [a, b] of kept) for (let r = 0; r < rows; r++) {
          const t0 = -width / 2 + r * rowT + 0.04, t1 = t0 + rowT - 0.08;
          for (let s = a - B.range(0, 3); s < b;) {
            const s1 = Math.min(b, s + B.range(3, 7)), s0 = Math.max(a, s);
            if (s1 - s0 > 0.15) fills.add(V[B.int(0, 2)], polyD([...W.sub(s0 + 0.05, s1 - 0.05).map(([x, y], i, arr) => offsetPt(W, x, y, t0)), ...W.sub(s0 + 0.05, s1 - 0.05).reverse().map(([x, y]) => offsetPt(W, x, y, t1))], true));
            s = s1;
          }
        }
        out.body.push(...fills.nodes(E));
      } else {
        out.body.push(band(shade(tones[0], -0.1)));
        out.body.push(band(tones[1], width * 0.84));
        out.body.push(E.path(strokeD, { fill: 'none', stroke: tones[2], 'stroke-width': fmt(width * 0.3), 'stroke-linejoin': join, opacity: 0.55, transform: `translate(${fmt(E.lx * width * 0.15)} ${fmt(E.ly * width * 0.15)})` }));
      }
      // posts
      const posts = buckets(), ps = Math.max(width * 1.25, 0.6);
      const B = rng.fork('posts');
      for (const [a, b] of kept) {
        const marks = new Set([a, b]);
        for (const c of W.corners()) if (c >= a && c <= b) marks.add(c);
        for (let s = a + 5; s < b - 2; s += 5 + B.range(-0.5, 0.5)) marks.add(s);
        for (const s of marks) {
          const p = W.at(b - a > ps ? clamp(s, a + ps / 2, b - ps / 2) : (a + b) / 2);
          const ang = Math.atan2(p.ty, p.tx);
          posts.add(woodDark[0], rectPolyD(p.x, p.y, ps, ps, ang));
          posts.add(woodDark[2], rectPolyD(p.x + E.lx * ps * 0.12, p.y + E.ly * ps * 0.12, ps * 0.62, ps * 0.62, ang));
        }
      }
      out.body.push(...posts.nodes(E));
    }
  }

  if (rubble) {
    const Rb = rng.fork('rubble'), items = [], planks = [];
    const sites = [...gaps.map(([a, b]) => [a, b, 1]), ...kept.flatMap(([a, b]) => [!isOpenEnd(a) && !isEnd(a) && a > 0 ? [a - 0.3, a + 0.6, 0.6] : null, !isOpenEnd(b) && !isEnd(b) && b < L ? [b - 0.6, b + 0.3, 0.6] : null]).filter(Boolean)];
    for (const [a, b, k] of sites) {
      const n = Math.min(70, Math.round((b - a + 0.6) * Math.max(width, 0.8) * Rb.range(0.9, 1.5) * k));
      for (let i = 0; i < n; i++) {
        const s = Rb.range(a - 0.3, b + 0.3), t = Rb.normal(0, width * 0.75);
        const p = P(clamp(s, 0, L), t);
        if (material === 'timber' || (material === 'plaster' && Rb.chance(0.4))) {
          if (Rb.chance(0.35)) planks.push([p[0], p[1], Rb.range(0.8, 2.6), Rb.range(0.25, 0.45), Rb.next() * Math.PI]);
          else if (material === 'plaster') items.push({ x: p[0], y: p[1], r: Rb.range(0.12, 0.35) });
        } else {
          const big = Rb.chance(0.25);
          items.push({ x: p[0], y: p[1], r: (big ? Rb.range(0.3, 0.55) : Rb.range(0.1, 0.3)) * clamp(width / 1.5, 0.6, 1.4), e: material === 'brick' ? 0.55 : undefined });
        }
      }
    }
    const rt = material === 'plaster' ? TONES.plaster : material === 'timber' ? E.pal('stone') : tones;
    out.rubble.push(...paintPebbles(E, Rb, items, rt, { shadowH: 0.35 }));
    if (planks.length) {
      const wd = E.pal('wood'), pb = buckets();
      for (const [x, y, len, wdt, ang] of planks) pb.add(jit(Rb, wd[Rb.int(0, 1)], 0.05), rectPolyD(x, y, len, wdt, ang));
      out.rubble.push(...pb.nodes(E, fill => ({ fill, stroke: E.pal('woodDark')[0], 'stroke-width': 0.06 })));
    }
  }
  return out;
}

function offsetPt(W, x, y, t) {
  // Offset a point on the line by t along the normal of its nearest segment.
  let best = null, bd = Infinity;
  for (const g of W.segs) {
    const px = x - g.a[0], py = y - g.a[1], u = clamp(px * g.tx + py * g.ty, 0, g.len);
    const d = Math.hypot(px - g.tx * u, py - g.ty * u);
    if (d < bd - 1e-9) { bd = d; best = g; }
  }
  return best ? [x - best.ty * t, y + best.tx * t] : [x, y];
}

export function rectPolyD(cx, cy, w, h, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return polyD([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]), true);
}

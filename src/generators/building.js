// Building footprint: roof when intact; floor, walls, doors and furnishings when the roof is
// gone (roof 'none' or ruined). ruined 0..1 first holes then removes the roof, then breaks the
// walls into stubs with rubble. Rect walls run along the footprint edge; round = ellipse.
import { env, polyD, fmt, clamp, ramp, shade, jit, mix, hsl, buckets, clipPoly, clipSeg, lineD, circleD, rectD, blobPts, smoothD, TONES } from './_paint.js';
import { paintWall, paintPebbles, stoneTones, rectPolyD } from './_stone.js';
import { paintPlanks, crateTop, barrelTop } from './_wood.js';
import { lobedPts } from './_foliage.js';

const STYLE = {
  cottage: { shadow: 4, door: 4 },
  barn: { shadow: 6, door: 9 },
  watchtower: { shadow: 10, door: 4 },
  shrine: { shadow: 3.5, door: 5 },
  shed: { shadow: 2.5, door: 3.5 },
};
const THICK = { stone: 1.5, timber: 0.8, plaster: 1.0 };
const pick = (v, list, d) => (list.includes(v) ? v : d);

export default {
  type: 'building',
  render(el, rng, ctx) {
    const E = env(el, ctx);
    const p = el.params || {};
    const B = {
      E, rng, el,
      style: pick(p.style, Object.keys(STYLE), 'cottage'),
      round: p.shape === 'round',
      roof: pick(p.roof, ['thatch', 'slate', 'wood', 'none'], 'thatch'),
      wall: pick(p.wall, ['stone', 'timber', 'plaster'], 'timber'),
      floor: pick(p.floor, ['wood', 'stone', 'dirt'], 'wood'),
      ruined: clamp(Number.isFinite(p.ruined) ? p.ruined : 0),
      W: el.size.w, H: el.size.h,
    };
    B.t = Math.min(THICK[B.wall], Math.min(B.W, B.H) * 0.12);
    B.roofKeep = B.roof === 'none' ? 0 : clamp(1 - B.ruined * 2.4);
    if (B.roofKeep < 0.12) B.roofKeep = 0;
    B.footprint = outline(B, 0);
    B.inner = outline(B, B.t / 2);
    B.wallLine = B.inner;
    B.doors = doorList(B, Array.isArray(p.doors) ? p.doors : [{ side: 's', offsetFt: 0 }]);
    const kids = [];
    const interior = B.roofKeep < 1;
    if (B.roofKeep > 0) kids.push(E.shadowEl(polyD(B.footprint, true), STYLE[B.style].shadow, { wide: true }));
    if (interior) {
      kids.push(...floorNodes(B));
      kids.push(...furnish(B));
      if (B.roof !== 'none' && B.ruined < 0.8) kids.push(...rafters(B, B.roofKeep > 0 ? 1 : clamp(1 - B.ruined * 1.3)));
    }
    const wall = paintWall(E, rng.fork('walls'), {
      points: B.wallLine, closed: true, width: B.t, material: B.wall,
      integrity: 1 - B.ruined * 0.8, keepCorners: B.ruined > 0 ? 0.8 : 0,
      heightFt: 3 * (1 - B.ruined * 0.55), openings: B.doors.map(d => [d.s - d.w / 2, d.s + d.w / 2]), join: B.round ? 'round' : 'miter',
      rubble: B.ruined > 0,
    });
    if (interior) {
      kids.push(...wall.shadow, ...wall.rubble, ...wall.body);
      kids.push(...doorNodes(B, wall));
    }
    if (B.roofKeep > 0) kids.push(...roofNodes(B));
    if (B.roofKeep > 0) kids.push(...stepNodes(B));
    return E.g({ class: `building building-${B.style}` }, kids);
  },
};

// Footprint polygon inset by d: rect corners clockwise from NW, or a 48-gon ellipse from north.
function outline(B, d) {
  const a = B.W / 2 - d, b = B.H / 2 - d;
  if (!B.round) return [[-a, -b], [a, -b], [a, b], [-a, b]];
  const n = 48, pts = [];
  for (let i = 0; i < n; i++) { const th = -Math.PI / 2 + (i * 2 * Math.PI) / n; pts.push([Math.cos(th) * a, Math.sin(th) * b]); }
  return pts;
}

function perimeter(pts) {
  let L = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; L += Math.hypot(b[0] - a[0], b[1] - a[1]); }
  return L;
}

// Doors -> {s (arc position on the wall line), w, x, y, tx, ty (along wall), nx, ny (inward)}.
function doorList(B, doors) {
  const out = [];
  const L = perimeter(B.wallLine);
  const a = B.W / 2 - B.t / 2, b = B.H / 2 - B.t / 2;
  for (const d of doors.slice(0, 6)) {
    if (!d || !['n', 'e', 's', 'w'].includes(d.side)) continue;
    const off = Number.isFinite(d.offsetFt) ? d.offsetFt : 0;
    let w = STYLE[B.style].door;
    if (B.round) {
      const r = (a + b) / 2;
      w = Math.min(w, r * 0.9);
      const base = { n: -Math.PI / 2, e: 0, s: Math.PI / 2, w: Math.PI }[d.side];
      const th = base + clamp(off / Math.max(r, 0.1), -Math.PI / 3, Math.PI / 3);
      const s = ((((th + Math.PI / 2) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * L;
      const x = Math.cos(th) * a, y = Math.sin(th) * b;
      out.push({ s, w, x, y, tx: -Math.sin(th), ty: Math.cos(th), nx: -Math.cos(th), ny: -Math.sin(th) });
      continue;
    }
    const half = d.side === 'n' || d.side === 's' ? a : b;
    w = Math.min(w, Math.max(1, 2 * half - B.t * 2));
    const o = clamp(off, -(half - w / 2 - B.t), half - w / 2 - B.t) || 0;
    if (d.side === 'n') out.push({ s: a + o, w, x: o, y: -b, tx: 1, ty: 0, nx: 0, ny: 1 });
    if (d.side === 'e') out.push({ s: 2 * a + b + o, w, x: a, y: o, tx: 0, ty: 1, nx: -1, ny: 0 });
    if (d.side === 's') out.push({ s: 3 * a + 2 * b - o, w, x: o, y: b, tx: -1, ty: 0, nx: 0, ny: -1 });
    if (d.side === 'w') out.push({ s: 4 * a + 3 * b - o, w, x: -a, y: o, tx: 0, ty: -1, nx: 1, ny: 0 });
  }
  return out;
}

// ---------- floor ----------
function floorNodes(B) {
  const { E, rng, inner, floor, ruined } = B;
  const R = rng.fork('floor');
  const xs = inner.map(p => p[0]), ys = inner.map(p => p[1]);
  const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  const kids = [];
  const dirt = E.pal('dirt');
  if (floor === 'wood') {
    kids.push(E.path(polyD(inner, true), { fill: shade(dirt[0], -0.1) }));
    kids.push(...paintPlanks(E, R, { ...box, axis: B.W >= B.H ? 'x' : 'y', board: 0.9, len: [4, 10], clip: inner, missing: ruined * 0.3, bg: false }));
  } else if (floor === 'stone') {
    const st = stoneTones(E, 'granite'), T = [st[1], hsl(st[1], 0.02, 0.02, 0.05), st[2]];
    kids.push(E.path(polyD(inner, true), { fill: mix(shade(st[0], -0.15), dirt[0], 0.5) }));
    const V = [0, 1, 2, 3].map(i => jit(R, ramp(T, 0.2 + i * 0.18), 0.04)), fb = buckets(), hi = [];
    for (let y = box.y0 - R.range(0, 1); y < box.y1;) {
      const rh = R.range(1.3, 2.1);
      for (let x = box.x0 - R.range(0, 1.5); x < box.x1;) {
        const sw = R.range(1.3, 2.6);
        if (R.chance(ruined * 0.25)) {
          const q = clipPoly([[x, y], [x + sw, y], [x + sw, y + rh], [x, y + rh]], inner);
          if (q.length > 2) fb.add(dirt[1], polyD(q, true));
        } else {
          const j = () => R.range(-0.06, 0.06), g = 0.07;
          let q = [[x + g + j(), y + g + j()], [x + sw - g + j(), y + g + j()], [x + sw - g + j(), y + rh - g + j()], [x + g + j(), y + rh - g + j()]];
          q = clipPoly(q, inner);
          if (q.length > 2) {
            fb.add(V[R.int(0, 3)], polyD(q, true));
            if (q.length === 4) hi.push(E.ly < 0 ? polyD([q[0], q[1]]) : polyD([q[3], q[2]]));
          }
        }
        x += sw;
      }
      y += rh;
    }
    kids.push(...fb.nodes(E));
    kids.push(E.path(hi.join(''), { fill: 'none', stroke: T[2], 'stroke-width': 0.06, opacity: 0.5 }));
  } else {
    kids.push(E.path(polyD(inner, true), { fill: dirt[1] }));
    const d1 = buckets();
    const area = (box.x1 - box.x0) * (box.y1 - box.y0);
    for (let i = 0; i < Math.min(400, area * 0.6); i++) {
      const x = R.range(box.x0, box.x1), y = R.range(box.y0, box.y1);
      if (!inPoly([x, y], inner)) continue;
      d1.add(R.chance(0.5) ? dirt[0] : dirt[2], circleD(x, y, R.range(0.05, 0.2)));
    }
    kids.push(...d1.nodes(E, fill => ({ fill, opacity: 0.45 })));
  }
  // Interior walls shade the floor edge (ambient occlusion).
  kids.push(E.path(polyD(inner, true), { fill: 'none', stroke: '#000', 'stroke-width': fmt(B.t * 1.6), opacity: 0.18, filter: 'url(#f-shadow)' }));
  if (ruined > 0) kids.push(...ruinDressing(B, box));
  return kids;
}

function inPoly(p, poly) {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}

// Moss and grass creeping in, cracks and fallen debris, all growing with ruin.
function ruinDressing(B, box) {
  const { E, rng, inner, ruined } = B;
  const R = rng.fork('ruin'), kids = [];
  const g = E.pal('grass'), moss = TONES.moss;
  const area = (box.x1 - box.x0) * (box.y1 - box.y0);
  const patches = buckets(), tufts = [];
  const n = Math.round(ruined * area / 40) + (ruined > 0.3 ? 1 : 0);
  for (let i = 0; i < n; i++) {
    // favour the wall edges
    const k = R.int(0, inner.length - 1), a = inner[k], b = inner[(k + 1) % inner.length], t = R.next();
    const cx = (a[0] + (b[0] - a[0]) * t) * R.range(0.55, 0.95), cy = (a[1] + (b[1] - a[1]) * t) * R.range(0.55, 0.95);
    const r = R.range(1, 3) * (0.5 + ruined);
    const pts = clipPoly(lobedPts(R, cx, cy, r, 6, 0.25), inner);
    if (pts.length > 2) patches.add(jit(R, R.chance(0.5) ? g[1] : moss[1], 0.05), smoothD(pts, true));
    for (let j = 0; j < 6; j++) { const x = cx + R.range(-r, r) * 0.7, y = cy + R.range(-r, r) * 0.7; if (inPoly([x, y], inner)) tufts.push(`M${fmt(x)} ${fmt(y)}l${fmt(R.range(-0.25, 0.25))} ${fmt(-R.range(0.25, 0.5))}M${fmt(x)} ${fmt(y)}l${fmt(R.range(0.1, 0.35))} ${fmt(-R.range(0.2, 0.4))}`); }
  }
  kids.push(...patches.nodes(E, fill => ({ fill, opacity: 0.85 })));
  if (tufts.length) kids.push(E.path(tufts.join(''), { fill: 'none', stroke: g[2], 'stroke-width': 0.08, 'stroke-linecap': 'round', opacity: 0.8 }));
  let cr = '';
  for (let i = 0; i < Math.round(ruined * 6); i++) {
    let x = R.range(box.x0, box.x1) * 0.8, y = R.range(box.y0, box.y1) * 0.8;
    cr += `M${fmt(x)} ${fmt(y)}`;
    for (let k = 0; k < 4; k++) { x += R.range(-1, 1); y += R.range(-1, 1); cr += `L${fmt(x)} ${fmt(y)}`; }
  }
  if (cr) kids.push(E.path(cr, { fill: 'none', stroke: '#000', 'stroke-width': 0.06, opacity: 0.35 }));
  const items = [];
  for (let i = 0; i < Math.round(ruined * area * 0.06); i++) {
    const x = R.range(box.x0, box.x1), y = R.range(box.y0, box.y1);
    if (inPoly([x, y], inner)) items.push({ x, y, r: R.range(0.1, 0.4) });
  }
  const tones = B.wall === 'timber' ? E.pal('stone') : B.wall === 'plaster' ? TONES.plaster : E.pal('stone');
  kids.push(...paintPebbles(E, R, items, tones, { shadowH: 0.3 }));
  return kids;
}

// ---------- furnishings ----------
function furnish(B) {
  const { E, rng, style, ruined, W, H, t } = B;
  const R = rng.fork('furnish'), kids = [];
  const iw = W / 2 - t, ih = H / 2 - t; // inner half extents
  if (iw < 2 || ih < 2) return kids;
  const wood = E.pal('wood'), wd = E.pal('woodDark'), st = E.pal('stone');
  const doorSides = new Set(B.doors.map(d => (Math.abs(d.ny) > Math.abs(d.nx) ? (d.ny > 0 ? 'n' : 's') : d.nx > 0 ? 'w' : 'e')));
  const freeSide = ['n', 'w', 'e', 's'].find(s => !doorSides.has(s)) || 'n';
  const sideVec = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] }[freeSide];
  const along = s => (s === 'n' || s === 's' ? iw : ih);
  const ang = { n: 0, s: 180, e: 90, w: -90 }[freeSide];
  const lost = ruined > 0.5;
  const box = (x, y, w, h, a, fill, hgt = 1) => {
    const [dx, dy] = E.shadow(hgt);
    return [E.path(rectD(x + dx, y + dy, w, h, a), { fill: '#000', opacity: E.shadowOpacity, filter: 'url(#f-shadow)' }), E.path(rectD(x, y, w, h, a), { fill, stroke: shade(fill, -0.4), 'stroke-width': 0.06 })];
  };
  if (B.round && style === 'watchtower') {
    // spiral stair wedges hugging the wall
    const a = W / 2 - t, b = H / 2 - t, n = 12, start = R.next() * Math.PI * 2, fb = buckets();
    for (let i = 0; i < n; i++) {
      const a0 = start + i * 0.42, a1 = a0 + 0.4;
      const q = [[Math.cos(a0) * a, Math.sin(a0) * b], [Math.cos(a1) * a, Math.sin(a1) * b], [Math.cos(a1) * a * 0.55, Math.sin(a1) * b * 0.55], [Math.cos(a0) * a * 0.55, Math.sin(a0) * b * 0.55]];
      fb.add(ramp(st, 0.35 + (i / n) * 0.55), polyD(q, true));
    }
    kids.push(...fb.nodes(E, fill => ({ fill, stroke: shade(st[0], -0.3), 'stroke-width': 0.06 })));
    kids.push(E.path(circleD(0, 0, Math.min(a, b) * 0.5), { fill: 'none', stroke: shade(st[0], -0.3), 'stroke-width': 0.2 }));
    return kids;
  }
  if (style === 'watchtower') {
    // ladder in a corner and a trapdoor
    const x = -iw + 1.2, y0 = -ih + 0.4, y1 = Math.min(ih - 0.4, y0 + 6);
    let d = lineD(x - 0.6, y0, x - 0.6, y1) + lineD(x + 0.6, y0, x + 0.6, y1);
    for (let y = y0 + 0.4; y < y1; y += 0.9) d += lineD(x - 0.6, y, x + 0.6, y);
    kids.push(E.path(d, { stroke: wood[1], 'stroke-width': 0.18, fill: 'none', 'stroke-linecap': 'round' }));
    kids.push(E.path(rectD(iw - 2, -ih + 2, 2.5, 2.5), { fill: wd[0], stroke: wood[0], 'stroke-width': 0.15 }));
    return kids;
  }
  if (style === 'cottage' && iw > 4 && ih > 3) {
    // hearth on a wall without a door
    const hw = Math.min(5, along(freeSide) * 0.6), hd = 2.4;
    const cx = sideVec[0] * (iw - hd / 2), cy = sideVec[1] * (ih - hd / 2);
    const g = E.g({ transform: `translate(${fmt(cx)} ${fmt(cy)}) rotate(${ang})` }, [
      E.path(rectD(0, 0, hw, hd), { fill: st[1], stroke: shade(st[0], -0.3), 'stroke-width': 0.1 }),
      E.path(rectD(0, 0.3, hw * 0.6, hd * 0.55), { fill: '#2a2420' }),
      E.path(circleD(0, 0.35, hd * 0.2), { fill: TONES.ash[1] }),
      E.path(lineD(-hw * 0.2, 0.4, hw * 0.2, 0.2), { stroke: E.pal('bark')[1], 'stroke-width': 0.3, 'stroke-linecap': 'round' }),
    ]);
    kids.push(g);
    if (!lost) {
      const tx = -sideVec[1] * iw * 0.35 + R.range(-0.5, 0.5), ty = sideVec[0] * ih * 0.35;
      kids.push(...box(tx, ty, 4, 2.5, R.range(-8, 8), wood[1], 1.2));
      kids.push(E.path(circleD(tx + 2.6, ty, 0.55) + circleD(tx - 2.6, ty + 0.3, 0.55), { fill: wood[0], stroke: wd[0], 'stroke-width': 0.06 }));
      if (iw > 7 && ih > 5) {
        const bx = sideVec[1] !== 0 ? iw - 2 : -iw * 0.3, by = sideVec[1] !== 0 ? -sideVec[1] * (ih - 3.6) : ih - 2;
        const cloth = E.pal('cloth');
        kids.push(...box(bx, by, 3, 6.5, sideVec[1] !== 0 ? 0 : 90, wood[0], 1));
        kids.push(E.path(rectD(bx, by + 0.5, 2.6, 5, sideVec[1] !== 0 ? 0 : 90), { fill: hsl(cloth[1], 0.55, 0.15, -0.15) }));
      }
    }
  } else if (style === 'barn') {
    const hay = TONES.hay;
    for (const [sx, sy] of [[-1, -1], [1, 1], [-1, 1]].slice(0, lost ? 1 : 3)) {
      const r = Math.min(iw, ih) * 0.28, cx = sx * (iw - r), cy = sy * (ih - r);
      const pts = blobPts(R, cx, cy, r, r * 0.8, 10, 0.12);
      kids.push(E.shadowEl(smoothD(pts, true), 1), E.path(smoothD(pts, true), { fill: hay[1], stroke: hay[0], 'stroke-width': 0.1 }));
      let d = '';
      for (let i = 0; i < 25; i++) { const x = cx + R.range(-r, r) * 0.7, y = cy + R.range(-r, r) * 0.6, a = R.next() * Math.PI; d += lineD(x, y, x + Math.cos(a) * 0.6, y + Math.sin(a) * 0.6); }
      kids.push(E.path(d, { stroke: hay[2], 'stroke-width': 0.06, fill: 'none' }));
    }
    if (!lost) {
      let d = '';
      const long = iw >= ih;
      for (let u = -(long ? iw : ih) + 6; u < (long ? iw : ih) - 4; u += 6) d += long ? lineD(u, -ih, u, -ih + Math.min(6, ih)) : lineD(-iw, u, -iw + Math.min(6, iw), u);
      kids.push(E.path(d, { stroke: wood[0], 'stroke-width': 0.35, fill: 'none' }));
    }
  } else if (style === 'shrine') {
    const cx = sideVec[0] * (iw - 1.6), cy = sideVec[1] * (ih - 1.6);
    const aw = Math.min(4, along(freeSide)), g = E.g({ transform: `translate(${fmt(cx)} ${fmt(cy)}) rotate(${ang})` }, [
      ...box(0, 0.2, aw, 1.8, 0, st[2], 1.2),
      E.path(circleD(0, -0.6, 0.55), { fill: st[1], stroke: shade(st[0], -0.3), 'stroke-width': 0.08 }),
      E.path(circleD(-aw * 0.35, 0.2, 0.12) + circleD(aw * 0.35, 0.2, 0.12), { fill: '#f6e3a0' }),
      E.path(circleD(-aw * 0.35, 0.2, 0.3) + circleD(aw * 0.35, 0.2, 0.3), { fill: '#ffd070', opacity: 0.25 }),
    ]);
    if (!lost) kids.push(E.path(polyD([[cx * 0.75 - sideVec[1] * 0.9, cy * 0.75 - sideVec[0] * 0.9], [cx * 0.75 + sideVec[1] * 0.9, cy * 0.75 + sideVec[0] * 0.9], [-cx + sideVec[1] * 0.9, -cy + sideVec[0] * 0.9], [-cx - sideVec[1] * 0.9, -cy - sideVec[0] * 0.9]], true), { fill: '#7a2a24', opacity: 0.85 }));
    kids.push(g);
  } else if (style === 'shed' && !lost) {
    const c = Math.min(iw, ih) * 0.45;
    kids.push(...crateBox(E, R, -iw + c, -ih + c, c * 1.4), ...crateBox(E, R, -iw + c * 2.6, -ih + c * 0.9, c));
    const [dx, dy] = E.shadow(1);
    kids.push(E.path(circleD(iw - c * 0.8 + dx, -ih + c * 0.8 + dy, c * 0.6), { fill: '#000', opacity: E.shadowOpacity, filter: 'url(#f-shadow)' }), ...barrelTop(E, R, iw - c * 0.8, -ih + c * 0.8, c * 0.6));
  }
  return kids;
}
function crateBox(E, R, x, y, s) {
  const [dx, dy] = E.shadow(s * 0.5);
  return [E.path(rectD(x + dx, y + dy, s, s), { fill: '#000', opacity: E.shadowOpacity, filter: 'url(#f-shadow)' }), crateTop(E, R, x, y, s, s, R.range(-10, 10))];
}

// Roof beams, seen through holes or left charred after the roof burns away.
function rafters(B, keep) {
  const { E, rng, W, H, inner } = B;
  const R = rng.fork('rafters'), wd = E.pal('woodDark');
  const long = W >= H, L = long ? W : H, S = long ? H : W;
  let d = '', hi = '';
  for (let u = -L / 2 + 1.5; u < L / 2 - 1; u += 2.2) {
    if (!R.chance(keep)) continue;
    const cut = R.chance(1 - keep) ? R.range(0.3, 0.8) : 1;
    const a = long ? [u, -S / 2] : [-S / 2, u], b = long ? [u, -S / 2 + S * cut] : [-S / 2 + S * cut, u];
    const sg = clipSeg(a, b, inner);
    if (sg) { d += polyD(sg); hi += polyD(sg.map(([x, y]) => [x + E.lx * 0.08, y + E.ly * 0.08])); }
  }
  if (keep > 0.3) { const sg = clipSeg(long ? [-L / 2, 0] : [0, -L / 2], long ? [L / 2, 0] : [0, L / 2], inner); if (sg) d += polyD(sg); }
  if (!d) return [];
  return [
    E.shadowEl(d, 2.5, { stroke: 0.45 }),
    E.path(d, { stroke: mix(wd[0], '#111111', 0.3), 'stroke-width': 0.45, fill: 'none', 'stroke-linecap': 'butt' }),
    E.path(hi, { stroke: wd[2], 'stroke-width': 0.12, fill: 'none', opacity: 0.6 }),
  ];
}

// ---------- doors ----------
function doorNodes(B, wall) {
  const { E, rng, t, ruined } = B;
  const wood = E.pal('wood'), wd = E.pal('woodDark'), st = E.pal('stone'), kids = [];
  const R = rng.fork('doors');
  for (const d of B.doors) {
    // threshold across the wall thickness
    const ang = (Math.atan2(d.ty, d.tx) * 180) / Math.PI;
    kids.push(E.path(rectD(d.x, d.y, d.w, t * 1.05, ang), { fill: B.wall === 'stone' ? st[1] : wd[1], stroke: shade(wd[0], -0.2), 'stroke-width': 0.05 }));
    if (ruined > 0.55 && R.chance(ruined)) continue; // door gone
    // leaf hinged at one jamb, swung into the room
    const side = R.chance(0.5) ? 1 : -1, open = R.range(55, 85) * (Math.PI / 180);
    const hx = d.x + d.tx * side * d.w / 2 + d.nx * t * 0.5, hy = d.y + d.ty * side * d.w / 2 + d.ny * t * 0.5;
    const leaves = d.w > 6 ? [[hx, hy, side], [d.x - d.tx * side * d.w / 2 + d.nx * t * 0.5, d.y - d.ty * side * d.w / 2 + d.ny * t * 0.5, -side]] : [[hx, hy, side]];
    const lw = d.w > 6 ? d.w / 2 : d.w * 0.92;
    for (const [x, y, sd] of leaves) {
      // direction: from hinge toward the opening, rotated inward by `open`
      const ux = -d.tx * sd, uy = -d.ty * sd;
      const vx = ux * Math.cos(open) + d.nx * Math.sin(open), vy = uy * Math.cos(open) + d.ny * Math.sin(open);
      const cx = x + vx * lw / 2, cy = y + vy * lw / 2, a = Math.atan2(vy, vx);
      kids.push(E.shadowEl(rectPolyD(cx, cy, lw, 0.3, a), 1.5));
      kids.push(E.path(rectPolyD(cx, cy, lw, 0.3, a), { fill: jit(R, wood[1], 0.05), stroke: wd[0], 'stroke-width': 0.06 }));
      kids.push(E.path(lineD(x + vx * lw * 0.2, y + vy * lw * 0.2, x + vx * lw * 0.95, y + vy * lw * 0.95), { stroke: TONES.metal[1], 'stroke-width': 0.08 }));
    }
  }
  return kids;
}

// Door steps outside the roof edge when the roof hides the walls.
function stepNodes(B) {
  const { E } = B, st = E.pal('stone'), kids = [];
  for (const d of B.doors) {
    const ang = (Math.atan2(d.ty, d.tx) * 180) / Math.PI;
    const x = d.x - d.nx * B.t * 0.15, y = d.y - d.ny * B.t * 0.15;
    kids.push(E.shadowEl(rectD(x, y, d.w * 0.9, B.t * 0.9, ang), 0.4));
    kids.push(E.path(rectD(x, y, d.w * 0.9, B.t * 0.9, ang), { fill: st[2], stroke: shade(st[0], -0.3), 'stroke-width': 0.06 }));
    kids.push(E.path(rectD(x + d.nx * B.t * 0.2, y + d.ny * B.t * 0.2, d.w * 0.7, B.t * 0.3, ang), { fill: '#000', opacity: 0.25 }));
  }
  return kids;
}

// ---------- roofs ----------
function roofTones(B) {
  const { E } = B;
  if (B.roof === 'slate') return E.pal('slate');
  if (B.roof === 'wood') return E.pal('wood').map(c => hsl(c, -0.01, -0.12, -0.03));
  return E.pal('thatch');
}

// Faces: {poly (convex), r: point on the ridge, down: unit downslope}. ridges: segments.
function roofFaces(B) {
  const hx = B.W / 2, hy = B.H / 2, long = B.W >= B.H;
  const sw = ([x, y]) => (long ? [x, y] : [y, x]);
  const L = long ? hx : hy, S = long ? hy : hx;
  let faces, ridges;
  if (B.style === 'shed') {
    faces = [{ poly: [[-L, -S], [L, -S], [L, S], [-L, S]], r: [0, -S], down: [0, 1] }];
    ridges = [[[-L, -S], [L, -S]]];
  } else if (B.style === 'watchtower' || B.style === 'shrine') {
    const d = S;
    const r0 = [-L + d, 0], r1 = [L - d, 0];
    faces = [
      { poly: [[-L, -S], [L, -S], r1, r0], r: [0, 0], down: [0, -1] },
      { poly: [[L, -S], [L, S], r1], r: r1, down: [1, 0] },
      { poly: [[L, S], [-L, S], r0, r1], r: [0, 0], down: [0, 1] },
      { poly: [[-L, S], [-L, -S], r0], r: r0, down: [-1, 0] },
    ];
    ridges = [[r0, r1], [[-L, -S], r0], [[-L, S], r0], [[L, -S], r1], [[L, S], r1]];
  } else {
    faces = [
      { poly: [[-L, -S], [L, -S], [L, 0], [-L, 0]], r: [0, 0], down: [0, -1] },
      { poly: [[-L, 0], [L, 0], [L, S], [-L, S]], r: [0, 0], down: [0, 1] },
    ];
    ridges = [[[-L, 0], [L, 0]]];
  }
  return {
    faces: faces.map(f => ({ poly: f.poly.map(sw), r: sw(f.r), down: sw(f.down) })),
    ridges: ridges.map(s => s.map(sw)),
  };
}

function tileFace(E, R, f, kind, T, out) {
  const [dx, dy] = f.down, ux = -dy, uy = dx;
  const rel = p => [(p[0] - f.r[0]) * ux + (p[1] - f.r[1]) * uy, (p[0] - f.r[0]) * dx + (p[1] - f.r[1]) * dy];
  const uv = f.poly.map(rel);
  const u0 = Math.min(...uv.map(p => p[0])), u1 = Math.max(...uv.map(p => p[0])), v1 = Math.max(...uv.map(p => p[1]));
  const P = (u, v) => [f.r[0] + ux * u + dx * v, f.r[1] + uy * u + dy * v];
  const rowH = kind === 'thatch' ? 1.3 : kind === 'slate' ? 0.9 : 0.8;
  let row = 0;
  for (let v = Math.max(0, Math.min(...uv.map(p => p[1]))); v < v1; v += rowH, row++) {
    const va = v, vb = Math.min(v + rowH, v1);
    if (kind === 'thatch') {
      const band = clipPoly([P(u0, va), P(u1, va), P(u1, vb), P(u0, vb)], f.poly);
      if (band.length > 2) out.fill.add(row % 2 ? T.v[1] : T.v[2], polyD(band, true));
      // ragged lower edge of each course
      let d = '', u = u0;
      const pts = [];
      while (u <= u1 + 0.5) { pts.push(P(u, vb - R.range(0, 0.25))); u += 0.5; }
      for (let i = 0; i < pts.length - 1; i++) { const sg = clipSeg(pts[i], pts[i + 1], f.poly); if (sg) d += polyD(sg); }
      out.lines.push(d);
      for (let k = 0; k < (u1 - u0) * 3.2; k++) {
        const uu = R.range(u0, u1), vv = R.range(va, vb);
        const sg = clipSeg(P(uu, vv), P(uu + R.range(-0.08, 0.08), vv + R.range(0.4, 0.8)), f.poly);
        if (sg) (R.chance(0.5) ? out.straw : out.strawDark).push(polyD(sg));
      }
    } else {
      const tw = kind === 'slate' ? 1.0 : 0.75;
      for (let u = u0 - (row % 2) * tw * 0.5; u < u1; ) {
        const w = kind === 'wood' ? tw * R.range(0.6, 1.3) : tw;
        const q = clipPoly([P(u + 0.04, va), P(u + w - 0.04, va), P(u + w - 0.04, vb), P(u + 0.04, vb)], f.poly);
        if (q.length > 2) out.fill.add(T.v[R.int(0, 3)], polyD(q, true));
        u += w;
      }
      const sg = clipSeg(P(u0 - 1, vb), P(u1 + 1, vb), f.poly);
      if (sg) out.lines.push(polyD(sg));
    }
  }
}

function roofNodes(B) {
  const { E, rng, el } = B;
  const R = rng.fork('roof');
  const T0 = roofTones(B);
  const T = { t: T0, v: [0, 1, 2, 3].map(i => jit(R, ramp(T0, 0.3 + i * 0.13), 0.035)) };
  const kind = B.roof === 'none' ? 'thatch' : B.roof;
  const kids = [];
  const fpD = polyD(B.footprint, true);
  kids.push(E.path(fpD, { fill: shade(T0[0], -0.2) }));
  const out = { fill: buckets(), lines: [], straw: [], strawDark: [] };
  const shadeN = [];
  if (B.round) {
    const a = B.W / 2, b = B.H / 2, N = 16;
    for (let i = 0; i < N; i++) {
      const th0 = (i * 2 * Math.PI) / N, th1 = ((i + 1) * 2 * Math.PI) / N, tm = (th0 + th1) / 2;
      const poly = [[0, 0], [Math.cos(th0) * a, Math.sin(th0) * b], [Math.cos(th1) * a, Math.sin(th1) * b]];
      const down = [Math.cos(tm), Math.sin(tm)];
      // ring courses: treat each slice as a face whose ridge is the apex
      tileFace(E, R, { poly, r: [0, 0], down }, kind, T, out);
      shadeN.push({ poly, lit: E.lit(down[0], down[1]) });
    }
  } else {
    const { faces, ridges } = roofFaces(B);
    for (const f of faces) { tileFace(E, R, f, kind, T, out); shadeN.push({ poly: f.poly, lit: E.lit(f.down[0], f.down[1]) }); }
    B.ridges = ridges;
  }
  kids.push(...out.fill.nodes(E));
  if (out.lines.length) kids.push(E.path(out.lines.join(''), { fill: 'none', stroke: shade(T0[0], -0.3), 'stroke-width': kind === 'thatch' ? 0.12 : 0.1, opacity: kind === 'thatch' ? 0.45 : 0.75, 'stroke-linecap': 'round' }));
  if (out.strawDark.length) kids.push(E.path(out.strawDark.join(''), { fill: 'none', stroke: T0[0], 'stroke-width': 0.06, opacity: 0.6 }));
  if (out.straw.length) kids.push(E.path(out.straw.join(''), { fill: 'none', stroke: shade(T0[2], 0.15), 'stroke-width': 0.06, opacity: 0.6 }));
  // light: each face tinted by how it faces the light
  for (const s of shadeN) {
    const k = s.lit;
    kids.push(E.path(polyD(s.poly, true), { fill: k > 0 ? '#fff4d8' : '#000000', opacity: fmt(k > 0 ? k * 0.16 : -k * 0.32) }));
  }
  // ridges and hips
  if (B.round) {
    kids.push(E.path(circleD(0, 0, Math.min(B.W, B.H) * 0.06), { fill: shade(T0[0], -0.2), stroke: shade(T0[0], -0.4), 'stroke-width': 0.1 }));
    kids.push(E.path(circleD(E.lx * 0.1, E.ly * 0.1, Math.min(B.W, B.H) * 0.025), { fill: TONES.metal[2] }));
  } else {
    const rd = B.ridges.map(s => polyD(s)).join('');
    const cap = kind === 'thatch' ? 0.9 : 0.45;
    kids.push(E.path(rd, { fill: 'none', stroke: shade(T0[0], -0.15), 'stroke-width': fmt(cap), 'stroke-linecap': 'butt' }));
    kids.push(E.path(rd, { fill: 'none', stroke: T0[2], 'stroke-width': fmt(cap * 0.35), 'stroke-linecap': 'butt', opacity: 0.55, transform: `translate(${fmt(E.lx * cap * 0.2)} ${fmt(E.ly * cap * 0.2)})` }));
    if (B.style === 'cottage' && Math.min(B.W, B.H) >= 10) {
      // stone chimney on the ridge near one gable end
      const long = B.W >= B.H, Lh = (long ? B.W : B.H) / 2, c = clamp(Math.min(B.W, B.H) * 0.13, 1.5, 3);
      const s = R.chance(0.5) ? 1 : -1, cx = long ? s * (Lh - c * 1.4) : 0, cy = long ? 0 : s * (Lh - c * 1.4);
      const st = E.pal('stone');
      kids.push(E.shadowEl(rectD(cx, cy, c, c), 3));
      kids.push(E.path(rectD(cx, cy, c, c), { fill: st[1], stroke: shade(st[0], -0.3), 'stroke-width': 0.1 }));
      kids.push(E.path(rectD(cx + E.lx * c * 0.08, cy + E.ly * c * 0.08, c * 0.7, c * 0.7), { fill: st[2], opacity: 0.6 }));
      kids.push(E.path(rectD(cx, cy, c * 0.42, c * 0.42), { fill: '#1e1b18' }));
    }
    if (B.style === 'barn' && Math.min(B.W, B.H) >= 14) {
      const c = 3, wd = E.pal('wood');
      kids.push(E.shadowEl(rectD(0, 0, c, c), 2.5));
      kids.push(E.path(rectD(0, 0, c, c), { fill: wd[1], stroke: shade(wd[0], -0.3), 'stroke-width': 0.1 }));
      kids.push(E.path(lineD(-c / 2, 0, c / 2, 0) + lineD(0, -c / 2, 0, c / 2), { stroke: wd[0], 'stroke-width': 0.15 }));
    }
  }
  kids.push(E.path(fpD, { fill: 'none', stroke: shade(T0[0], -0.45), 'stroke-width': 0.18, 'stroke-linejoin': 'round' }));
  if (B.roofKeep >= 1) return kids;
  // Holes: an even-odd clip (footprint minus ragged hole blobs), per element.
  const area = B.W * B.H, loss = 1 - B.roofKeep;
  const n = Math.max(1, Math.round(loss * area / 90));
  const rr = Math.sqrt((loss * area) / n / Math.PI) * 0.95;
  const H = rng.fork('holes');
  let holes = '';
  for (let i = 0; i < n; i++) {
    const x = H.range(-0.4, 0.4) * B.W, y = H.range(-0.4, 0.4) * B.H;
    const hp = clipPoly(blobPts(H, x, y, rr * H.range(0.7, 1.2), rr * H.range(0.6, 1.1), 11, 0.3), outline(B, 0.3));
    if (hp.length > 2) holes += smoothD(hp, true, 0.4);
  }
  const id = `g-building-${String(el.id || el.seed || 'x').replace(/[^a-z0-9-]/gi, '')}-roof`;
  const clip = E.h('clipPath', { id }, [E.path(fpD + holes, { 'clip-rule': 'evenodd' })]);
  kids.push(E.path(holes, { fill: 'none', stroke: '#1e1812', 'stroke-width': 0.6, opacity: 0.85, 'stroke-dasharray': '0.5 0.25', 'stroke-linejoin': 'round' }));
  return [E.h('defs', {}, [clip]), E.g({ 'clip-path': `url(#${id})` }, kids)];
}

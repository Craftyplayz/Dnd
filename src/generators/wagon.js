// Wagon or cart. size.w = length (tongue toward +x), size.h = width across the wheels.
// overturned = upside down showing bottom boards, bolsters, axles and skewed wheels.
import { env, rectD, polyD, fmt, clamp, ramp, shade, jit, mix, buckets, lineD, circleD, blobPts, smoothD, TONES } from './_paint.js';
import { paintPlanks, wheelFlat, wheelEdge, crateTop } from './_wood.js';
import { rectPolyD } from './_stone.js';

export default {
  type: 'wagon',
  render(el, rng, ctx) {
    const E = env(el, ctx);
    const p = el.params || {};
    const variant = ['covered', 'open', 'cart'].includes(p.variant) ? p.variant : 'open';
    const cargo = ['none', 'crates', 'sacks', 'hay'].includes(p.cargo) ? p.cargo : 'none';
    const overturned = !!p.overturned, broken = !!p.broken;
    const W = el.size.w, H = el.size.h;
    const cart = variant === 'cart';
    const tongue = W * (cart ? 0.36 : 0.24);
    const bedL = W - tongue, bx0 = -W / 2, bx1 = bx0 + bedL, bcx = (bx0 + bx1) / 2;
    const wheelT = clamp(H * 0.09, 0.2, 0.6), bedW = H - wheelT * 2 - H * 0.04;
    const wheelD = Math.min(cart ? W * 0.42 : W * 0.3, bedL * (cart ? 0.8 : 0.42));
    const axles = cart ? [bcx] : [bx0 + bedL * 0.22, bx1 - bedL * 0.22];
    const wy = H / 2 - wheelT / 2;
    const G = { E, rng, W, H, cart, variant, cargo, broken, tongue, bedL, bx0, bx1, bcx, bedW, wheelT, wheelD, axles, wy };
    const kids = overturned ? drawOverturned(G) : drawUpright(G);
    return E.g({ class: `wagon wagon-${variant}${overturned ? ' overturned' : ''}${broken ? ' broken' : ''}` }, kids);
  },
};

function tongueNodes(G, { snapped = false } = {}) {
  const { E, rng, W, H, cart, bx1, bedW } = G;
  const wd = E.pal('woodDark'), wood = E.pal('wood'), x2 = W / 2 - 0.15;
  const tw = clamp(H * 0.07, 0.18, 0.45);
  let d = '';
  if (cart) {
    for (const s of [-1, 1]) d += polyD([[bx1 - 0.3, s * bedW * 0.36], [snapped && s > 0 ? bx1 + (x2 - bx1) * 0.5 : x2, s * bedW * 0.26]]);
  } else {
    const end = snapped ? bx1 + (x2 - bx1) * rng.range(0.4, 0.6) : x2;
    d += polyD([[bx1 - 0.3, 0], [end, snapped ? rng.range(-0.3, 0.3) : 0]]);
    if (!snapped) d += polyD([[x2 - 0.5, -bedW * 0.32], [x2 - 0.5, bedW * 0.32]]);
  }
  return [
    E.path(d, { fill: 'none', stroke: wd[0], 'stroke-width': fmt(tw * 1.3), 'stroke-linecap': 'round' }),
    E.path(d, { fill: 'none', stroke: wood[1], 'stroke-width': fmt(tw), 'stroke-linecap': 'round' }),
    E.path(d, { fill: 'none', stroke: wood[2], 'stroke-width': fmt(tw * 0.3), opacity: 0.6, transform: `translate(${fmt(E.lx * tw * 0.2)} ${fmt(E.ly * tw * 0.2)})` }),
  ];
}

function cargoNodes(G, x0, x1, y0, y1, spill = false) {
  const { E, rng, cargo } = G;
  const R = rng.fork('cargo'), kids = [];
  const L = x1 - x0, Wd = y1 - y0;
  if (cargo === 'crates') {
    const n = spill ? 2 : clamp(Math.floor(L / (Wd * 0.55)), 1, 4);
    for (let i = 0; i < n; i++) {
      const s = Wd * R.range(0.42, 0.55), x = x0 + (L * (i + 0.5)) / n, y = (y0 + y1) / 2 + R.range(-0.2, 0.2) * (Wd - s);
      const [dx, dy] = E.shadow(s * 0.4);
      kids.push(E.path(rectD(x + dx, y + dy, s, s), { fill: '#000', opacity: E.shadowOpacity, filter: 'url(#f-shadow)' }));
      kids.push(crateTop(E, R, x, y, s, s, R.range(-15, 15)));
    }
  } else if (cargo === 'sacks') {
    const bur = TONES.burlap, n = clamp(Math.round((L * Wd) / 1.6), 2, 10) / (spill ? 2 : 1);
    for (let i = 0; i < n; i++) {
      const x = R.range(x0 + 0.6, x1 - 0.6), y = R.range(y0 + 0.5, y1 - 0.5), a = R.next() * Math.PI, sl = R.range(1.2, 1.6), sw = sl * 0.62;
      const pts = blobPts(R, 0, 0, sl / 2, sw / 2, 8, 0.08);
      const t = `translate(${fmt(x)} ${fmt(y)}) rotate(${fmt((a * 180) / Math.PI)})`;
      const [dx, dy] = E.shadow(0.5);
      kids.push(E.path(smoothD(pts, true), { fill: '#000', opacity: E.shadowOpacity, filter: 'url(#f-shadow)', transform: `translate(${fmt(dx)} ${fmt(dy)}) ${t}` }));
      const c = jit(R, bur[1], 0.06);
      kids.push(E.g({ transform: t }, [
        E.path(smoothD(pts, true), { fill: c, stroke: shade(bur[0], -0.3), 'stroke-width': 0.06 }),
        E.path(smoothD(pts.map(([px, py]) => [px * 0.6 - 0.1, py * 0.55 - 0.08]), true), { fill: bur[2], opacity: 0.45 }),
        E.path(lineD(sl * 0.36, -sw * 0.2, sl * 0.36, sw * 0.2), { stroke: TONES.rope[0], 'stroke-width': 0.08 }),
        E.path(`M${fmt(-sl * 0.1)} ${fmt(-sw * 0.25)}q${fmt(sl * 0.15)} ${fmt(sw * 0.1)} ${fmt(sl * 0.3)} 0`, { fill: 'none', stroke: shade(bur[0], -0.1), 'stroke-width': 0.04, opacity: 0.7 }),
      ]));
    }
  } else if (cargo === 'hay') {
    const hay = TONES.hay;
    const pts = blobPts(R, (x0 + x1) / 2, (y0 + y1) / 2, L / 2 * (spill ? 0.6 : 1.02), Wd / 2 * (spill ? 0.6 : 1.04), 14, 0.08);
    kids.push(E.shadowEl(smoothD(pts, true), 0.8));
    kids.push(E.path(smoothD(pts, true), { fill: hay[0] }));
    kids.push(E.path(smoothD(pts.map(([x, y]) => [x * 0.85 + E.lx * 0.2 + (x0 + x1) / 2 * 0.15, y * 0.8 + E.ly * 0.2 + (y0 + y1) / 2 * 0.2]), true), { fill: hay[1] }));
    let d = '', d2 = '';
    for (let i = 0; i < Math.round(L * Wd * 4); i++) {
      const x = R.range(x0 + 0.2, x1 - 0.2), y = R.range(y0 + 0.2, y1 - 0.2), a = R.next() * Math.PI, l = R.range(0.3, 0.7);
      const seg = lineD(x, y, x + Math.cos(a) * l, y + Math.sin(a) * l);
      if ((x - (x0 + x1) / 2) * E.lx + (y - (y0 + y1) / 2) * E.ly > 0) d2 += seg; else d += seg;
    }
    kids.push(E.path(d, { stroke: hay[0], 'stroke-width': 0.05, fill: 'none', opacity: 0.8 }), E.path(d2, { stroke: hay[2], 'stroke-width': 0.06, fill: 'none', opacity: 0.9 }));
  }
  return kids;
}

function drawUpright(G) {
  const { E, rng, H, cart, variant, cargo, broken, bx0, bx1, bcx, bedL, bedW, wheelT, wheelD, axles, wy } = G;
  const wood = E.pal('wood'), wd = E.pal('woodDark');
  const kids = [];
  const covered = variant === 'covered';
  const missing = broken ? rng.int(0, axles.length * 2 - 1) : -1; // index of the lost wheel
  const sh = rectD(bcx, 0, bedL, bedW) + axles.map(x => rectD(x, 0, wheelD, H)).join('');
  kids.push(E.shadowEl(sh, covered ? 3.2 : 1.8));
  kids.push(...tongueNodes(G, { snapped: broken && rng.chance(0.5) }));
  // wheels and axle ends stick out past the bed
  axles.forEach((x, i) => [-1, 1].forEach((s, k) => {
    if (i * 2 + k === missing) return;
    kids.push(...wheelEdge(E, x, s * wy, wheelD, wheelT));
  }));
  // bed: dark frame, planked floor, side boards
  const side = clamp(bedW * 0.08, 0.15, 0.4);
  const tilt = missing >= 0 ? (missing % 2 ? 1 : -1) : 0; // broken wagon sags toward the lost wheel
  kids.push(E.path(rectD(bcx, 0, bedL, bedW), { fill: wd[0], stroke: shade(wd[0], -0.3), 'stroke-width': 0.08 }));
  kids.push(...paintPlanks(E, rng.fork('floor'), { x0: bx0 + side, y0: -bedW / 2 + side, x1: bx1 - side, y1: bedW / 2 - side, axis: 'x', board: 0.75, len: [bedL, bedL * 1.3], missing: broken ? 0.25 : 0, bg: false }));
  const T = [wood[0], jit(rng, wood[1], 0.05), wood[2]];
  const boards = [[bcx, -bedW / 2 + side / 2, bedL, side, 0, -1], [bcx, bedW / 2 - side / 2, bedL, side, 0, 1], [bx0 + side / 2, 0, side, bedW, -1, 0], [bx1 - side / 2, 0, side, bedW, 1, 0]];
  boards.forEach(([x, y, w, h, nx, ny], i) => {
    if (broken && i === (missing % 2 ? 1 : 0)) {
      // splintered side board: two pieces with a gap
      const g = rng.range(0.25, 0.6) * w;
      kids.push(E.path(rectD(x - w / 2 + g / 2 - 0.4, y, g, h), { fill: ramp(T, 0.5 + 0.3 * E.lit(nx, ny)) }));
      return;
    }
    kids.push(E.path(rectD(x, y, w, h), { fill: ramp(T, 0.5 + 0.3 * E.lit(nx, ny)), stroke: wd[0], 'stroke-width': 0.04 }));
  });
  // stake pockets
  let st = '';
  for (let x = bx0 + 0.6; x < bx1 - 0.3; x += bedL / Math.max(2, Math.round(bedL / 2.2))) for (const s of [-1, 1]) st += rectD(x, s * (bedW / 2 - side / 2), side * 1.2, side * 1.3);
  kids.push(E.path(st, { fill: wd[1] }));
  if (tilt) kids.push(E.path(polyD([[bx0, tilt * bedW / 2], [bx1, tilt * bedW / 2], [bx1, 0], [bx0, 0]], true), { fill: '#000', opacity: 0.12 }));
  if (covered) {
    kids.push(...coverNodes(G, { torn: broken }));
    // driver's bench in front of the canvas
    kids.push(E.path(rectD(bx1 - 0.6, 0, 0.9, bedW - side * 2), { fill: ramp(T, 0.6), stroke: wd[0], 'stroke-width': 0.05 }));
  } else if (cargo !== 'none') {
    kids.push(...cargoNodes(G, bx0 + side, bx1 - side - (cart ? 0 : 0.9), -bedW / 2 + side, bedW / 2 - side));
  }
  if (!covered && !cart) kids.push(E.path(rectD(bx1 - side - 0.45, 0, 0.8, bedW - side * 2), { fill: ramp(T, 0.62), stroke: wd[0], 'stroke-width': 0.05 }));
  if (missing >= 0) {
    // the lost wheel lies flat beside the tongue
    const r = Math.min(wheelD / 2, (H / 2) * 0.9, G.tongue * 0.48);
    const s = missing % 2 ? 1 : -1;
    const x = bx1 + G.tongue * 0.5, y = s * (H / 2 - r);
    kids.push(E.shadowEl(circleD(x, y, r), 0.3));
    kids.push(...wheelFlat(E, rng.fork('lost'), x, y, r, { broken: true }));
  }
  return kids;
}

function coverNodes(G, { torn = false, crumpled = false } = {}) {
  const { E, rng, bx0, bx1, bedW } = G;
  const cloth = E.pal('cloth');
  const C = [jit(rng, cloth[0], 0.04), jit(rng, cloth[1], 0.04), jit(rng, cloth[2], 0.03)];
  const x0 = bx0 + 0.15, x1 = bx1 - 1.1, hw = bedW / 2 + 0.1, kids = [];
  const pucker = 0.35;
  const outline = `M${fmt(x0)} ${fmt(-hw)}L${fmt(x1)} ${fmt(-hw)}Q${fmt(x1 + pucker)} 0 ${fmt(x1)} ${fmt(hw)}L${fmt(x0)} ${fmt(hw)}Q${fmt(x0 - pucker)} 0 ${fmt(x0)} ${fmt(-hw)}Z`;
  kids.push(E.path(outline, { fill: C[1], stroke: shade(C[0], -0.35), 'stroke-width': 0.08 }));
  // arch shading across the width: bright on the side toward the light, shaded on the far side
  const lit = E.ly <= 0 ? 'n' : 's';
  const arch = E.def(`g-wagon-arch-${lit}`, () => E.h('linearGradient', { x1: 0, x2: 0, y1: lit === 'n' ? 0 : 1, y2: lit === 'n' ? 1 : 0 }, [
    E.h('stop', { offset: 0, 'stop-color': '#ffffff', 'stop-opacity': 0.1 }),
    E.h('stop', { offset: 0.28, 'stop-color': '#ffffff', 'stop-opacity': 0.35 }),
    E.h('stop', { offset: 0.55, 'stop-color': '#000000', 'stop-opacity': 0 }),
    E.h('stop', { offset: 1, 'stop-color': '#000000', 'stop-opacity': 0.42 }),
  ]));
  if (arch) kids.push(E.path(outline, { fill: arch }));
  // hoop ribs and sag between them
  const n = Math.max(2, Math.round((x1 - x0) / 1.8));
  let ribs = '', sag = '';
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    ribs += lineD(x, -hw, x, hw);
    if (i < n) { const xm = x + (x1 - x0) / n / 2; sag += lineD(xm, -hw * 0.9, xm, hw * 0.9); }
  }
  kids.push(E.path(ribs, { stroke: shade(C[0], -0.2), 'stroke-width': 0.08, fill: 'none', opacity: 0.6 }));
  kids.push(E.path(sag, { stroke: C[0], 'stroke-width': 0.35, fill: 'none', opacity: 0.12 }));
  if (torn) {
    const tx = rng.range(x0 + 1, x1 - 1.5), ty = rng.range(-hw * 0.4, hw * 0.2);
    const pts = blobPts(rng, tx, ty, 0.9, hw * 0.45, 7, 0.35);
    kids.push(E.path(smoothD(pts, true, 0.2), { fill: E.pal('woodDark')[0], stroke: C[0], 'stroke-width': 0.08 }));
  }
  return kids;
}

function drawOverturned(G) {
  const { E, rng, W, H, cart, variant, cargo, broken, bx0, bx1, bcx, bedL, bedW, wheelD, axles } = G;
  const wood = E.pal('wood'), wd = E.pal('woodDark'), metal = TONES.metal;
  const kids = [];
  const R = rng.fork('over');
  // spilled canvas/cargo on one side (local -y or +y), drawn under the wagon
  const spillSide = R.chance(0.5) ? 1 : -1;
  if (variant === 'covered') {
    const cloth = E.pal('cloth');
    const pts = blobPts(R, bcx - 0.3, spillSide * bedW * 0.32, bedL * 0.5, bedW * 0.36, 12, 0.18);
    kids.push(E.shadowEl(smoothD(pts, true), 0.4));
    kids.push(E.path(smoothD(pts, true), { fill: jit(R, cloth[1], 0.04), stroke: shade(cloth[0], -0.3), 'stroke-width': 0.08 }));
    let folds = '';
    for (let i = 0; i < 7; i++) { const x = R.range(bx0 + 0.5, bx1 - 0.5), y = spillSide * R.range(bedW * 0.2, H * 0.48); folds += `M${fmt(x)} ${fmt(y)}q${fmt(R.range(-0.6, 0.6))} ${fmt(spillSide * -0.5)} ${fmt(R.range(-0.3, 0.3))} ${fmt(spillSide * -1.1)}`; }
    kids.push(E.path(folds, { fill: 'none', stroke: cloth[0], 'stroke-width': 0.12, opacity: 0.7, 'stroke-linecap': 'round' }));
    // broken hoops sticking out
    let hoops = '';
    for (let i = 0; i < 3; i++) { const x = bx0 + bedL * (0.2 + i * 0.3); hoops += `M${fmt(x)} ${fmt(spillSide * bedW * 0.3)}q${fmt(R.range(-0.5, 0.5))} ${fmt(spillSide * 0.8)} ${fmt(R.range(-0.4, 0.4))} ${fmt(spillSide * (H / 2 - bedW * 0.3 - 0.2))}`; }
    kids.push(E.path(hoops, { fill: 'none', stroke: wd[1], 'stroke-width': 0.12, 'stroke-linecap': 'round' }));
  }
  const bodyD = rectD(bcx, 0, bedL, bedW * 0.94);
  kids.push(E.shadowEl(bodyD, 2.2));
  // tongue now points the other way relative to the flipped bed? It stays attached: drawn first, snapped if broken.
  kids.push(...tongueNodes(G, { snapped: broken }));
  // bottom boards run across the bed (weathered, darker than the deck)
  const dark = [mix(wd[0], wood[0], 0.4), mix(wd[1], wood[1], 0.4), mix(wd[2], wood[2], 0.5)];
  kids.push(...paintPlanks(E, R, { x0: bx0, y0: -bedW * 0.47, x1: bx1, y1: bedW * 0.47, axis: 'y', board: 0.7, len: [bedW * 1.2, bedW * 1.3], tones: dark, missing: broken ? 0.2 : 0 }));
  kids.push(E.path(bodyD, { fill: 'none', stroke: wd[0], 'stroke-width': 0.12 }));
  // long sills and bolsters
  const sill = clamp(bedW * 0.08, 0.2, 0.45);
  for (const s of [-1, 1]) kids.push(E.path(rectD(bcx, s * bedW * 0.28, bedL * 0.98, sill), { fill: wd[1], stroke: wd[0], 'stroke-width': 0.05 }));
  // axles across with hubs; wheels skewed after the crash
  const lost = broken ? R.int(0, axles.length * 2 - 1) : -1;
  axles.forEach((x, i) => {
    kids.push(E.path(rectD(x, 0, sill * 1.6, bedW * 0.94), { fill: wd[0] }));
    kids.push(E.path(rectD(x, 0, sill * 0.8, H * 0.96), { fill: metal[1], stroke: metal[0], 'stroke-width': 0.05 }));
    kids.push(E.path(rectD(x - E.lx * 0.05, 0, sill * 0.25, H * 0.96), { fill: metal[2], opacity: 0.6 }));
    [-1, 1].forEach((s, k) => {
      const y = s * (H / 2 - wheelD * 0.18);
      if (i * 2 + k === lost) {
        kids.push(E.path(circleD(x, s * (H / 2 - 0.15), 0.25), { fill: metal[0] }));
        return;
      }
      const skew = R.range(0.22, 0.4), r = wheelD / 2;
      const g = E.g({ transform: `translate(${fmt(x)} ${fmt(y)}) rotate(${fmt(R.range(-12, 12))}) scale(1 ${fmt(skew)})` }, wheelFlat(E, R, 0, 0, r));
      const [dx, dy] = E.shadow(0.6);
      kids.push(E.path(`M${fmt(x - r + dx)} ${fmt(y + dy)}a${fmt(r)} ${fmt(r * skew)} 0 1 0 ${fmt(2 * r)} 0a${fmt(r)} ${fmt(r * skew)} 0 1 0 ${fmt(-2 * r)} 0Z`, { fill: '#000', opacity: E.shadowOpacity, filter: 'url(#f-shadow)' }));
      kids.push(g);
    });
  });
  if (lost >= 0) {
    const r = Math.min(wheelD / 2, G.tongue * 0.48, H * 0.45);
    const x = bx1 + G.tongue * 0.5, y = -spillSide * (H / 2 - r);
    kids.push(E.shadowEl(circleD(x, y, r), 0.3), ...wheelFlat(E, R.fork('lost'), x, y, r, { broken: true }));
  }
  if (cargo !== 'none') kids.push(...cargoNodes(G, bx0 + 0.3, bx1 - 0.3, spillSide > 0 ? bedW * 0.2 : -H / 2 + 0.1, spillSide > 0 ? H / 2 - 0.1 : -bedW * 0.2, true));
  return kids;
}

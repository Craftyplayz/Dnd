// Tree seen from above. size = canopy diameter. Species: oak, pine, birch, willow, dead.
import { env, blobPts, smoothD, fmt, ramp, shade, jit, hsl, clamp, buckets, lensD, circleD, lineD } from './_paint.js';
import { paintFoliage } from './_foliage.js';

export default {
  type: 'tree',
  render(el, rng, ctx) {
    const E = env(el, ctx);
    const p = el.params || {};
    const species = ['oak', 'pine', 'birch', 'willow', 'dead'].includes(p.species) ? p.species : 'oak';
    const sx = el.size.w / 2, sy = el.size.h / 2;
    const R = Math.min(sx, sy) * rng.range(0.93, 1);
    const heightFt = Number.isFinite(p.heightFt) ? p.heightFt : 40;
    const trunk = clamp(Number.isFinite(p.trunkFt) ? p.trunkFt : 2, 0.3, R);
    // Canopy shadow offset: a fraction of the height so it reads as soft ground shade, not a detached copy.
    const shH = Math.min(heightFt * 0.14, R * 0.55);
    const ex = sx / Math.min(sx, sy), ey = sy / Math.min(sx, sy); // ellipse stretch for non-square sizes
    const kids = SPECIES[species](E, rng, { R, ex, ey, shH, trunk, heightFt });
    return E.g({ class: `tree tree-${species}` }, kids);
  },
};

const stretch = (pts, ex, ey) => pts.map(([x, y]) => [x * ex, y * ey]);

function oak(E, rng, { R, ex, ey, shH }) {
  const F = E.pal('foliage');
  const tones = [jit(rng, F[0], 0.05), jit(rng, F[1], 0.06), jit(rng, F[2], 0.05)];
  const clumps = [];
  const C = rng.fork('clumps');
  const nOut = C.int(7, 10), ph = C.next() * Math.PI * 2;
  for (let i = 0; i < nOut; i++) {
    const a = ph + ((i + C.range(-0.25, 0.25)) * 2 * Math.PI) / nOut, r = R * C.range(0.27, 0.36);
    const d = R - r * C.range(0.95, 1.08);
    clumps.push({ x: Math.cos(a) * d * ex, y: Math.sin(a) * d * ey, r });
  }
  const nMid = C.int(3, 5), ph2 = C.next() * Math.PI * 2;
  for (let i = 0; i < nMid; i++) {
    const a = ph2 + ((i + C.range(-0.2, 0.2)) * 2 * Math.PI) / nMid, r = R * C.range(0.28, 0.36), d = R * C.range(0.3, 0.42);
    clumps.push({ x: Math.cos(a) * d * ex, y: Math.sin(a) * d * ey, r });
  }
  clumps.push({ x: C.range(-0.08, 0.08) * R, y: C.range(-0.08, 0.08) * R, r: R * C.range(0.3, 0.36) });
  return paintFoliage(E, rng.fork('paint'), { clumps, tones, shadowH: shH, dabs: Math.round(R * 8), lobes: 8, depth: 0.11 });
}

function birch(E, rng, { R, ex, ey, shH }) {
  const F = E.pal('foliage');
  const base = [hsl(F[0], 0.03, -0.06, 0.05), hsl(F[1], 0.035, -0.06, 0.08), hsl(F[2], 0.03, -0.04, 0.1)];
  const tones = base.map(c => jit(rng, c, 0.05));
  const kids = [];
  // White branches show between the airy leaf clumps.
  const B = rng.fork('branches'), bark = '#d9d4c6', mark = '#3a3530';
  let d = '', dm = '';
  const nb = B.int(4, 6), ph = B.next() * Math.PI * 2;
  for (let i = 0; i < nb; i++) {
    const a = ph + (i * 2 * Math.PI) / nb + B.range(-0.3, 0.3), L = R * B.range(0.4, 0.6);
    const mx = Math.cos(a + 0.2) * L * 0.5, my = Math.sin(a + 0.2) * L * 0.5;
    d += `M0 0Q${fmt(mx * ex)} ${fmt(my * ey)} ${fmt(Math.cos(a) * L * ex)} ${fmt(Math.sin(a) * L * ey)}`;
    const t = B.range(0.3, 0.6);
    dm += `M${fmt(Math.cos(a) * L * t * ex)} ${fmt(Math.sin(a) * L * t * ey)}l${fmt(Math.cos(a + 1.6) * 0.25)} ${fmt(Math.sin(a + 1.6) * 0.25)}`;
  }
  const clumps = [];
  const C = rng.fork('clumps');
  const n = C.int(13, 16);
  for (let i = 0; i < n; i++) {
    const a = C.next() * Math.PI * 2, dist = R * Math.sqrt(C.range(0.02, 1)) * 0.74, r = R * C.range(0.22, 0.29);
    clumps.push({ x: Math.cos(a) * dist * ex, y: Math.sin(a) * dist * ey, r });
  }
  const branches = [
    E.shadowEl(d, shH * 0.6, { stroke: fmt(R * 0.06) }),
    E.path(d, { fill: 'none', stroke: shade(bark, -0.25), 'stroke-width': fmt(R * 0.07), 'stroke-linecap': 'round' }),
    E.path(d, { fill: 'none', stroke: bark, 'stroke-width': fmt(R * 0.045), 'stroke-linecap': 'round' }),
    E.path(dm, { fill: 'none', stroke: mark, 'stroke-width': fmt(R * 0.035), 'stroke-linecap': 'round', opacity: 0.8 }),
    E.path(circleD(0, 0, R * 0.07), { fill: bark, stroke: mark, 'stroke-width': 0.08 }),
  ];
  kids.push(...paintFoliage(E, rng.fork('paint'), { clumps, tones, shadowH: shH, dabs: Math.round(R * 9), dabSize: 0.5, lobes: 7, depth: 0.12, under: branches }));
  return kids;
}

function pine(E, rng, { R, ex, ey, shH }) {
  const P = E.pal('pine');
  const tones = [jit(rng, P[0], 0.05), jit(rng, P[1], 0.05), jit(rng, hsl(P[2], 0, 0.02, 0.06), 0.05)];
  const kids = [];
  // A tier is a round crown ring with soft bumps (needle clusters) and a slightly ragged edge.
  const tier = (r, n, cx, cy) => {
    const pts = [], ph = rng.next() * Math.PI * 2, tips = [];
    for (let i = 0; i < n * 2; i++) {
      const a = ph + ((i + rng.range(-0.2, 0.2)) * Math.PI) / n;
      const rr = r * (i % 2 ? rng.range(0.86, 0.97) : rng.range(0.93, 1.03));
      pts.push([cx + Math.cos(a) * rr * ex, cy + Math.sin(a) * rr * ey]);
      if (!(i % 2)) tips.push(a);
    }
    return { pts, tips };
  };
  const tiers = [];
  for (let k = 0; k < 5; k++) {
    const r = R * (1 - k * 0.19), sh = R * 0.035 * k;
    tiers.push({ r, cx: E.lx * sh, cy: E.ly * sh, ...tier(r, Math.max(7, Math.round((21 - k * 3.2) * rng.range(0.9, 1.1))), E.lx * sh, E.ly * sh) });
  }
  const outD = smoothD(tiers[0].pts, true);
  kids.push(E.shadowEl(outD, shH, { wide: true }));
  const rim = shade(tones[0], -0.35);
  kids.push(E.path(outD, { fill: rim, stroke: rim, 'stroke-width': 0.4, 'stroke-linejoin': 'round' }));
  tiers.forEach((t, k) => {
    const base = 0.04 + k * 0.17;
    kids.push(E.path(smoothD(t.pts, true), { fill: ramp(tones, base), stroke: rim, 'stroke-width': fmt(R * 0.014), 'stroke-opacity': 0.35 }));
    // lit crescent: the tier again, smaller and shifted toward the light
    const sh = t.r * 0.1;
    kids.push(E.path(smoothD(t.pts.map(([x, y]) => [t.cx + (x - t.cx) * 0.86 + E.lx * sh, t.cy + (y - t.cy) * 0.86 + E.ly * sh]), true), { fill: ramp(tones, base + 0.15) }));
    if (k === 0) {
      // faint radial branch structure under the upper tiers
      let d = '';
      for (const a of t.tips) if (rng.chance(0.5)) d += lineD(0, 0, Math.cos(a) * t.r * 0.8 * ex, Math.sin(a) * t.r * 0.8 * ey);
      if (d) kids.push(E.path(d, { fill: 'none', stroke: rim, 'stroke-width': fmt(R * 0.03), opacity: 0.45, 'stroke-linecap': 'round' }));
    }
    // needle tufts at each bump: light on the lit side, dark on the far side
    let lt = '', dk = '';
    for (const a of t.tips) {
      const lit = Math.cos(a) * E.lx + Math.sin(a) * E.ly;
      if (Math.abs(lit) < 0.15) continue;
      const r0 = t.r * rng.range(0.74, 0.82), b2 = a + rng.range(-0.06, 0.06);
      const d = lineD(t.cx + Math.cos(a) * r0 * ex, t.cy + Math.sin(a) * r0 * ey, t.cx + Math.cos(b2) * t.r * 0.93 * ex, t.cy + Math.sin(b2) * t.r * 0.93 * ey);
      if (lit > 0) lt += d; else dk += d;
    }
    const nw = fmt(R * 0.02);
    if (dk) kids.push(E.path(dk, { fill: 'none', stroke: rim, 'stroke-width': nw, opacity: 0.35, 'stroke-linecap': 'round' }));
    if (lt) kids.push(E.path(lt, { fill: 'none', stroke: shade(tones[2], 0.08 + k * 0.04), 'stroke-width': nw, opacity: 0.45, 'stroke-linecap': 'round' }));
  });
  kids.push(E.path(circleD(E.lx * R * 0.16, E.ly * R * 0.16, R * 0.07), { fill: shade(tones[2], 0.12), opacity: 0.85 }));
  return kids;
}

function willow(E, rng, { R, ex, ey, shH }) {
  const F = E.pal('foliage');
  const base = [hsl(F[0], 0.02, -0.02, 0.02), hsl(F[1], 0.03, 0, 0.05), hsl(F[2], 0.03, 0.02, 0.08)];
  const tones = base.map(c => jit(rng, c, 0.05));
  const kids = [];
  // frilly outline of hanging fronds
  const n = rng.int(44, 60), out = [], ph = rng.next();
  for (let i = 0; i < n; i++) {
    const a = ph + (i * 2 * Math.PI) / n, r = R * (i % 2 ? rng.range(0.86, 0.93) : rng.range(0.96, 1.0));
    out.push([Math.cos(a) * r * ex, Math.sin(a) * r * ey]);
  }
  const d0 = smoothD(out, true, 0.35);
  kids.push(E.shadowEl(d0, shH, { wide: true }));
  kids.push(E.path(d0, { fill: tones[0], stroke: shade(tones[0], -0.3), 'stroke-width': 0.3 }));
  // drooping strands radiating from the crown, curling one way
  const dirn = rng.chance(0.5) ? 1 : -1;
  const groups = [buckets(), buckets(), buckets()];
  const ns = Math.round(R * 13);
  for (let i = 0; i < ns; i++) {
    const a = rng.next() * Math.PI * 2, r0 = R * rng.range(0.05, 0.45), r1 = R * rng.range(0.75, 0.97);
    const lit = Math.cos(a) * E.lx + Math.sin(a) * E.ly;
    const tier = lit > 0.35 ? 2 : lit > -0.25 ? 1 : 0;
    const b = a + dirn * rng.range(0.15, 0.3), m = (r0 + r1) / 2;
    const c = a + dirn * rng.range(0.05, 0.12);
    groups[tier].add(tier, `M${fmt(Math.cos(a) * r0 * ex)} ${fmt(Math.sin(a) * r0 * ey)}Q${fmt(Math.cos(c) * m * 1.05 * ex)} ${fmt(Math.sin(c) * m * 1.05 * ey)} ${fmt(Math.cos(b) * r1 * ex)} ${fmt(Math.sin(b) * r1 * ey)}`);
  }
  const col = [ramp(tones, 0.35), ramp(tones, 0.62), ramp(tones, 0.92)];
  groups.forEach((g, t) => kids.push(...g.nodes(E, () => ({ fill: 'none', stroke: col[t], 'stroke-width': fmt(R * 0.034), 'stroke-linecap': 'round', opacity: 0.9 }))));
  // fine light strands on top
  let d = '';
  for (let i = 0; i < Math.round(R * 4); i++) {
    const a = Math.atan2(E.ly, E.lx) + rng.range(-1.3, 1.3), r0 = R * rng.range(0.15, 0.4), r1 = R * rng.range(0.6, 0.9), b = a + dirn * 0.2;
    d += `M${fmt(Math.cos(a) * r0 * ex)} ${fmt(Math.sin(a) * r0 * ey)}L${fmt(Math.cos(b) * r1 * ex)} ${fmt(Math.sin(b) * r1 * ey)}`;
  }
  kids.push(E.path(d, { fill: 'none', stroke: shade(tones[2], 0.12), 'stroke-width': fmt(R * 0.022), opacity: 0.7, 'stroke-linecap': 'round' }));
  // crown
  const cpts = blobPts(rng, E.lx * R * 0.08, E.ly * R * 0.08, R * 0.13, R * 0.13, 8, 0.18);
  kids.push(E.path(smoothD(cpts, true), { fill: ramp(tones, 0.55) }));
  kids.push(E.path(smoothD(cpts.map(([x, y]) => [x * 0.55 + E.lx * R * 0.08, y * 0.55 + E.ly * R * 0.08]), true), { fill: ramp(tones, 0.85), opacity: 0.9 }));
  return kids;
}

function dead(E, rng, { R, ex, ey, shH, trunk }) {
  const bark = E.pal('bark');
  const tones = [hsl(bark[0], 0, -0.12, 0.03), hsl(bark[1], 0, -0.14, 0.06), hsl(bark[2], 0, -0.14, 0.08)].map(c => jit(rng, c, 0.04));
  const byW = new Map(); // width -> path data (branches bucketed by width)
  const add = (w, d) => { const k = fmt(Math.max(0.06, Math.round(w * 20) / 20)); byW.set(k, (byW.get(k) || '') + d); };
  const B = rng.fork('branches');
  const grow = (x, y, ang, len, w, depth) => {
    const bend = B.range(-0.35, 0.35);
    const mx = x + Math.cos(ang + bend * 0.5) * len * 0.5, my = y + Math.sin(ang + bend * 0.5) * len * 0.5;
    let ex2 = x + Math.cos(ang + bend) * len, ey2 = y + Math.sin(ang + bend) * len;
    const r = Math.hypot(ex2 / ex, ey2 / ey);
    if (r > R * 0.98) { ex2 *= (R * 0.98) / r; ey2 *= (R * 0.98) / r; }
    add(w, `M${fmt(x)} ${fmt(y)}Q${fmt(mx)} ${fmt(my)} ${fmt(ex2)} ${fmt(ey2)}`);
    if (depth <= 0 || w < 0.08) return;
    const kids = B.chance(0.3) ? 3 : 2;
    for (let i = 0; i < kids; i++) {
      const spread = (i - (kids - 1) / 2) * B.range(0.45, 0.8);
      grow(ex2, ey2, ang + bend + spread, len * B.range(0.55, 0.72), w * 0.62, depth - 1);
    }
  };
  const nMain = B.int(4, 6), ph = B.next() * Math.PI * 2;
  const tw = clamp(trunk, 0.5, R * 0.5);
  for (let i = 0; i < nMain; i++) {
    const a = ph + ((i + B.range(-0.2, 0.2)) * 2 * Math.PI) / nMain;
    grow(Math.cos(a) * tw * 0.3, Math.sin(a) * tw * 0.3, a, R * B.range(0.38, 0.5), tw * B.range(0.45, 0.6), 3);
  }
  const all = [...byW.entries()];
  const kids = [];
  const [dx, dy] = E.shadow(shH * 0.8);
  const sh = all.map(([w, d]) => E.path(d, { fill: 'none', stroke: '#000', 'stroke-width': w, 'stroke-linecap': 'round' }));
  kids.push(E.g({ transform: `translate(${fmt(dx)} ${fmt(dy)})`, opacity: E.shadowOpacity, filter: 'url(#f-shadow)' }, sh));
  for (const [w, d] of all) kids.push(E.path(d, { fill: 'none', stroke: tones[0], 'stroke-width': fmt(Number(w) * 1.15), 'stroke-linecap': 'round' }));
  for (const [w, d] of all) kids.push(E.path(d, { fill: 'none', stroke: tones[1], 'stroke-width': w, 'stroke-linecap': 'round' }));
  for (const [w, d] of all) if (Number(w) > 0.15) kids.push(E.path(d, { fill: 'none', stroke: tones[2], 'stroke-width': fmt(Number(w) * 0.35), 'stroke-linecap': 'round', opacity: 0.75, transform: `translate(${fmt(E.lx * Number(w) * 0.25)} ${fmt(E.ly * Number(w) * 0.25)})` }));
  // trunk top with growth rings / broken crown
  kids.push(E.path(circleD(0, 0, tw * 0.55), { fill: tones[0] }));
  kids.push(E.path(circleD(E.lx * tw * 0.06, E.ly * tw * 0.06, tw * 0.42), { fill: tones[1] }));
  kids.push(E.path(circleD(E.lx * tw * 0.12, E.ly * tw * 0.12, tw * 0.22), { fill: tones[2], opacity: 0.8 }));
  return kids;
}

const SPECIES = { oak, pine, birch, willow, dead };

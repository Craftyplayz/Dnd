// Fire pit: stone ring (ring), ash bed, logs; lit adds embers, flames and a warm glow.
import { env, fmt, clamp, circleD, blobPts, smoothD, shade, jit, mix, TONES, buckets, lineD } from './_paint.js';
import { paintPebbles, stoneTones } from './_stone.js';

export default {
  type: 'campfire',
  render(el, rng, ctx) {
    const E = env(el, ctx);
    const p = el.params || {};
    const lit = p.lit !== false, ring = p.ring !== false;
    const R = Math.min(el.size.w, el.size.h) / 2;
    const fire = E.pal('fire'), ash = TONES.ash, bark = E.pal('bark');
    const kids = [];
    const pit = ring ? R * 0.72 : R * 0.9;
    // scorched earth and ash bed
    kids.push(E.path(smoothD(blobPts(rng, 0, 0, pit * 1.08, pit * 1.08, 12, 0.08), true), { fill: '#2a241e', opacity: 0.55, filter: 'url(#f-shadow)' }));
    kids.push(E.path(smoothD(blobPts(rng, 0, 0, pit * 0.92, pit * 0.92, 10, 0.08), true), { fill: lit ? '#3a2e26' : ash[1] }));
    const A = rng.fork('ash');
    let ad = '';
    for (let i = 0; i < Math.round(R * R * 5 + 6); i++) { const a = A.next() * Math.PI * 2, r = Math.sqrt(A.next()) * pit * 0.85; ad += circleD(Math.cos(a) * r, Math.sin(a) * r, A.range(0.04, 0.12)); }
    kids.push(E.path(ad, { fill: lit ? ash[1] : ash[2], opacity: 0.7 }));
    if (lit) {
      const glow = E.def('g-campfire-embers', () => E.h('radialGradient', {}, [
        E.h('stop', { offset: '0', 'stop-color': fire[2], 'stop-opacity': 0.95 }),
        E.h('stop', { offset: '0.45', 'stop-color': fire[1], 'stop-opacity': 0.75 }),
        E.h('stop', { offset: '1', 'stop-color': fire[0], 'stop-opacity': 0 }),
      ]));
      kids.push(E.path(circleD(0, 0, pit * 0.9), { fill: glow || fire[1], opacity: glow ? 1 : 0.5 }));
    }
    // logs laid in a star, ends pointing in
    const L = rng.fork('logs'), n = L.int(3, 5), ph = L.next() * Math.PI * 2;
    const logs = buckets(), ends = buckets(), hiD = [];
    const lw = clamp(R * 0.16, 0.18, 0.6);
    const logTone = lit ? jit(L, bark[1], 0.05) : mix(bark[0], '#1a1714', 0.6);
    for (let i = 0; i < n; i++) {
      const a = ph + ((i + L.range(-0.15, 0.15)) * 2 * Math.PI) / n;
      const r0 = pit * L.range(0.05, 0.2), r1 = pit * L.range(0.8, 1.0);
      const x0 = Math.cos(a) * r0, y0 = Math.sin(a) * r0, x1 = Math.cos(a) * r1, y1 = Math.sin(a) * r1;
      const nx = -Math.sin(a) * lw / 2, ny = Math.cos(a) * lw / 2;
      logs.add(logTone, `M${fmt(x0 + nx)} ${fmt(y0 + ny)}L${fmt(x1 + nx)} ${fmt(y1 + ny)}L${fmt(x1 - nx)} ${fmt(y1 - ny)}L${fmt(x0 - nx)} ${fmt(y0 - ny)}Z`);
      const s = E.lit(-Math.sin(a), Math.cos(a)) > 0 ? 1 : -1;
      hiD.push(lineD(x0 + nx * s * 0.6, y0 + ny * s * 0.6, x1 + nx * s * 0.6, y1 + ny * s * 0.6));
      ends.add(lit ? bark[2] : ash[1], circleD(x1, y1, lw / 2));
      if (!lit) ends.add(ash[2], circleD(x0, y0, lw * 0.45));
    }
    kids.push(...logs.nodes(E, fill => ({ fill, stroke: shade(bark[0], -0.4), 'stroke-width': 0.05 })));
    kids.push(E.path(hiD.join(''), { stroke: lit ? bark[2] : ash[0], 'stroke-width': fmt(lw * 0.18), opacity: 0.6, fill: 'none' }));
    kids.push(...ends.nodes(E, fill => ({ fill, stroke: shade(bark[0], -0.3), 'stroke-width': 0.04 })));
    if (lit) {
      // flames: three nested tongued blobs, hottest in the middle
      const F = rng.fork('flames');
      const tongue = (r, k) => {
        const pts = [], m = 7, ph2 = F.next() * Math.PI * 2;
        for (let i = 0; i < m * 2; i++) { const a = ph2 + (i * Math.PI) / m, rr = r * (i % 2 ? F.range(0.45, 0.6) : F.range(0.85, 1.1)); pts.push([Math.cos(a) * rr + E.lx * k, Math.sin(a) * rr + E.ly * k]); }
        return smoothD(pts, true, 0.35);
      };
      kids.push(E.path(tongue(pit * 0.62, 0), { fill: fire[0], opacity: 0.9 }));
      kids.push(E.path(tongue(pit * 0.45, pit * 0.04), { fill: fire[1] }));
      kids.push(E.path(tongue(pit * 0.24, pit * 0.06), { fill: fire[2] }));
      let sp = '';
      for (let i = 0; i < 6; i++) { const a = F.next() * Math.PI * 2, r = pit * F.range(0.6, 1.2); sp += circleD(Math.cos(a) * r, Math.sin(a) * r, 0.05); }
      kids.push(E.path(sp, { fill: fire[2], opacity: 0.8 }));
      const halo = E.def('g-campfire-glow', () => E.h('radialGradient', {}, [
        E.h('stop', { offset: '0', 'stop-color': fire[1], 'stop-opacity': 0.35 }),
        E.h('stop', { offset: '1', 'stop-color': fire[1], 'stop-opacity': 0 }),
      ]));
      if (halo) kids.push(E.path(circleD(0, 0, R * 1.5), { fill: halo, 'pointer-events': 'none' }));
    }
    if (ring) {
      const S = rng.fork('stones'), rr = R * 0.84, items = [];
      const k = Math.max(7, Math.round((2 * Math.PI * rr) / (R * 0.32)));
      for (let i = 0; i < k; i++) {
        const a = ((i + S.range(-0.15, 0.15)) * 2 * Math.PI) / k;
        items.push({ x: Math.cos(a) * rr, y: Math.sin(a) * rr, r: R * S.range(0.13, 0.17), e: S.range(0.7, 0.9), rot: a + Math.PI / 2 });
      }
      const st = stoneTones(E, 'granite');
      kids.push(...paintPebbles(E, S, items, lit ? [st[0], st[1], mix(st[2], fire[2], 0.25)] : st, { shadowH: 0.5 }));
    }
    return E.g({ class: `campfire${lit ? ' lit' : ''}` }, kids);
  },
};

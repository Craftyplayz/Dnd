// Fence along params.points: rail (posts + split rails), picket, or stone-low (dry stone).
// gaps 0..1 = share of sections missing; a fallen rail sometimes lies in a gap.
import { env, polyD, fmt, clamp, jit, shade, walker, buckets } from './_paint.js';
import { paintWall, rectPolyD } from './_stone.js';

export default {
  type: 'fence',
  render(el, rng, ctx) {
    const E = env(el, ctx);
    const p = el.params || {};
    const style = ['rail', 'picket', 'stone-low'].includes(p.style) ? p.style : 'rail';
    const width = clamp(Number(p.width) || 1, 0.2, 4);
    const gaps = clamp(Number.isFinite(p.gaps) ? p.gaps : 0.1);
    if (style === 'stone-low') {
      const w = paintWall(E, rng, { points: p.points, closed: !!p.closed, width, material: 'stone', integrity: 1 - gaps, heightFt: 1 });
      return E.g({ class: 'fence fence-stone-low' }, [...w.shadow, ...w.rubble, ...w.body]);
    }
    const W = walker(p.points, !!p.closed);
    if (W.total <= 0) return E.g({ class: 'fence' }, []);
    // posts: start, end, corners and every ~step ft between them
    const step = 6;
    const marks = [...new Set([0, ...W.corners(), W.total])].sort((a, b) => a - b);
    const posts = [];
    for (let i = 0; i < marks.length - 1; i++) {
      const a = marks[i], b = marks[i + 1], n = Math.max(1, Math.round((b - a) / step));
      for (let k = 0; k < n; k++) posts.push(a + ((b - a) * k) / n);
    }
    posts.push(W.total);
    const G = rng.fork('gaps'), sections = [];
    for (let i = 0; i < posts.length - 1; i++) sections.push({ a: posts[i], b: posts[i + 1], gone: G.chance(gaps) });
    const wood = E.pal('wood'), wd = E.pal('woodDark');
    const T = [jit(rng, wood[0], 0.05), jit(rng, wood[1], 0.06), jit(rng, wood[2], 0.05)];
    const postS = clamp(width * 0.8, 0.5, 1.4), railW = clamp(width * 0.3, 0.16, 0.6);
    let rails = '', shadowD = '';
    const pick = buckets(), fallen = buckets(), postsD = buckets();
    const R = rng.fork('rails');
    const offsetLine = (a, b, t) => {
      // offset each vertex along the averaged normal of its neighbouring segments
      const pts = W.sub(a, b);
      let s = a;
      return pts.map(([x, y], i) => {
        if (i) s += Math.hypot(x - pts[i - 1][0], y - pts[i - 1][1]);
        const q0 = W.at(Math.max(a, s - 1e-3)), q1 = W.at(Math.min(b, s + 1e-3));
        return [x + ((q0.nx + q1.nx) / 2) * t, y + ((q0.ny + q1.ny) / 2) * t];
      });
    };
    for (const sec of sections) {
      if (sec.gone) {
        if (style === 'rail' && R.chance(0.5)) {
          const m = W.at((sec.a + sec.b) / 2), t = R.range(-1, 1) * width;
          fallen.add(T[1], rectPolyD(m.x + m.nx * t, m.y + m.ny * t, (sec.b - sec.a) * R.range(0.6, 0.9), railW * 1.4, Math.atan2(m.ty, m.tx) + R.range(-0.5, 0.5)));
        }
        continue;
      }
      for (const t of style === 'rail' ? [-width * 0.18, width * 0.18] : [0]) {
        const pts = offsetLine(sec.a, sec.b, t);
        // slight sag so rails are not ruler-straight
        if (pts.length === 2 && style === 'rail') pts.splice(1, 0, [(pts[0][0] + pts[1][0]) / 2 + R.range(-0.08, 0.08), (pts[0][1] + pts[1][1]) / 2 + R.range(-0.08, 0.08)]);
        rails += polyD(pts);
      }
      if (style === 'picket') {
        // close-set stakes (reads as a palisade at larger widths)
        const pw = clamp(width * 0.4, 0.25, 0.8);
        for (let s = sec.a + pw * 0.6; s < sec.b - pw * 0.4; s += pw * 1.05) {
          if (R.chance(gaps * 0.3)) continue;
          const q = W.at(s), ang = Math.atan2(q.ty, q.tx);
          pick.add(R.chance(0.5) ? T[1] : T[2], rectPolyD(q.x, q.y, pw, Math.max(width * 0.75, 0.3) * R.range(0.92, 1.05), ang));
          pick.add(shade(T[2], 0.15), rectPolyD(q.x + E.lx * pw * 0.15, q.y + E.ly * pw * 0.15, pw * 0.35, Math.max(width * 0.6, 0.2), ang));
        }
      }
      shadowD += polyD(W.sub(sec.a, sec.b));
    }
    const postSet = new Set();
    for (const sec of sections) if (!sec.gone) { postSet.add(sec.a); postSet.add(sec.b); }
    const postShadow = [];
    for (const s of postSet) {
      const q = W.at(s), ang = Math.atan2(q.ty, q.tx);
      postsD.add(wd[1], rectPolyD(q.x, q.y, postS, postS, ang + R.range(-0.15, 0.15)));
      postsD.add(T[2], rectPolyD(q.x + E.lx * postS * 0.12, q.y + E.ly * postS * 0.12, postS * 0.55, postS * 0.55, ang));
      postShadow.push(rectPolyD(q.x, q.y, postS, postS, ang));
    }
    const kids = [];
    if (shadowD) kids.push(E.shadowEl(shadowD, style === 'picket' ? 2.5 : 1.6, { stroke: fmt(style === 'picket' ? Math.max(width * 0.75, 0.3) : railW * 2.5), max: style === 'picket' ? 2.5 : 1.5, opacity: 1.3 }));
    if (postShadow.length) kids.push(E.shadowEl(postShadow.join(''), 2.2, { max: 1.8, opacity: 1.3 }));
    kids.push(...fallen.nodes(E, fill => ({ fill, stroke: wd[0], 'stroke-width': 0.05 })));
    if (rails) {
      kids.push(E.path(rails, { fill: 'none', stroke: wd[0], 'stroke-width': fmt(railW * 1.5), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      kids.push(E.path(rails, { fill: 'none', stroke: T[1], 'stroke-width': fmt(railW), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      kids.push(E.path(rails, { fill: 'none', stroke: T[2], 'stroke-width': fmt(railW * 0.35), opacity: 0.6, transform: `translate(${fmt(E.lx * railW * 0.2)} ${fmt(E.ly * railW * 0.2)})` }));
    }
    kids.push(...pick.nodes(E, fill => ({ fill, stroke: shade(wd[0], -0.2), 'stroke-width': 0.05 })));
    kids.push(...postsD.nodes(E, fill => ({ fill, stroke: fill === wd[1] ? shade(wd[0], -0.3) : 'none', 'stroke-width': 0.05 })));
    return E.g({ class: `fence fence-${style}` }, kids);
  },
};

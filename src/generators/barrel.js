// Barrel. Upright: seen from above (staves, hoops, lid). tipped: lying on its side along local x.
import { env, fmt, clamp, shade, jit, circleD, ellipseD, TONES, lineD, mix } from './_paint.js';
import { barrelTop } from './_wood.js';

export default {
  type: 'barrel',
  render(el, rng, ctx) {
    const E = env(el, ctx);
    const w = el.size.w, hh = el.size.h, m = Math.min(w, hh);
    if (!(el.params && el.params.tipped)) {
      const r = m / 2;
      return E.g({ class: 'barrel' }, [E.shadowEl(circleD(0, 0, r), clamp(r * 1.1, 0.4, 2)), ...barrelTop(E, rng, 0, 0, r)]);
    }
    // Lying barrel: length along x = w, diameter = 0.82 * h (bulging middle).
    const L = w * 0.96, D = Math.min(hh * 0.86, w * 0.75), r = D / 2;
    const wood = E.pal('wood'), metal = TONES.metal;
    const T = [jit(rng, wood[0], 0.05), jit(rng, wood[1], 0.06), jit(rng, wood[2], 0.05)];
    const end = r * 0.32; // ellipse half-width of the visible end cap
    const x0 = -L / 2 + end, x1 = L / 2 - end * 0.3;
    const body = `M${fmt(x0)} ${fmt(-r * 0.86)}Q${fmt(0)} ${fmt(-r * 1.14)} ${fmt(x1)} ${fmt(-r * 0.86)}L${fmt(x1)} ${fmt(r * 0.86)}Q${fmt(0)} ${fmt(r * 1.14)} ${fmt(x0)} ${fmt(r * 0.86)}Z`;
    const kids = [E.shadowEl(body + ellipseD(x0, 0, end, r * 0.86), clamp(r, 0.4, 1.5))];
    kids.push(E.path(body, { fill: T[1], stroke: shade(T[0], -0.35), 'stroke-width': fmt(r * 0.05), 'stroke-linejoin': 'round' }));
    // cylinder shading: bands across y, lit side toward the light
    const sgn = E.ly <= 0 ? -1 : 1;
    kids.push(E.path(`M${fmt(x0)} ${fmt(sgn * r * 0.15)}Q0 ${fmt(sgn * r * 0.2)} ${fmt(x1)} ${fmt(sgn * r * 0.15)}L${fmt(x1)} ${fmt(sgn * r * 0.7)}Q0 ${fmt(sgn * r * 0.95)} ${fmt(x0)} ${fmt(sgn * r * 0.7)}Z`, { fill: T[2], opacity: 0.55 }));
    kids.push(E.path(`M${fmt(x0)} ${fmt(-sgn * r * 0.35)}Q0 ${fmt(-sgn * r * 0.45)} ${fmt(x1)} ${fmt(-sgn * r * 0.35)}L${fmt(x1)} ${fmt(-sgn * r * 0.86)}Q0 ${fmt(-sgn * r * 1.14)} ${fmt(x0)} ${fmt(-sgn * r * 0.86)}Z`, { fill: T[0], opacity: 0.6 }));
    // stave lines
    let st = '';
    for (const k of [-0.6, -0.3, 0, 0.3, 0.6]) st += `M${fmt(x0)} ${fmt(k * r * 0.86)}Q0 ${fmt(k * r * 1.14)} ${fmt(x1)} ${fmt(k * r * 0.86)}`;
    kids.push(E.path(st, { fill: 'none', stroke: shade(T[0], -0.3), 'stroke-width': fmt(r * 0.035), opacity: 0.7 }));
    // hoops
    let hp = '';
    for (const t of [0.1, 0.3, 0.7, 0.9]) {
      const x = x0 + (x1 - x0) * t, yy = r * (0.86 + 0.28 * (1 - (2 * t - 1) ** 2));
      hp += lineD(x, -yy, x, yy);
    }
    kids.push(E.path(hp, { fill: 'none', stroke: metal[1], 'stroke-width': fmt(r * 0.12) }));
    kids.push(E.path(hp, { fill: 'none', stroke: metal[2], 'stroke-width': fmt(r * 0.04), opacity: 0.6, transform: `translate(${fmt(-r * 0.03)} 0)` }));
    // end cap (lid) facing -x
    kids.push(E.path(ellipseD(x0, 0, end, r * 0.86), { fill: mix(T[0], T[1], 0.5), stroke: metal[1], 'stroke-width': fmt(r * 0.09) }));
    kids.push(E.path(ellipseD(x0, 0, end * 0.6, r * 0.6), { fill: 'none', stroke: shade(T[0], -0.25), 'stroke-width': fmt(r * 0.03), opacity: 0.7 }));
    return E.g({ class: 'barrel barrel-tipped' }, kids);
  },
};

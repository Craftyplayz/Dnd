// Map text centred on (0,0) with an optional contrasting halo.
import { env, fmt, clamp, luminance, shade } from './_paint.js';

export default {
  type: 'label',
  render(el, rng, ctx) {
    const E = env(el, ctx);
    const p = el.params || {};
    const text = String(p.text ?? '').slice(0, 80) || ' ';
    const size = clamp(Number.isFinite(p.fontFt) ? p.fontFt : 3, 0.5, 40);
    const color = /^#[0-9a-fA-F]{6}$/.test(p.color || '') ? p.color : '#ffffff';
    const halo = p.halo !== false;
    const haloColor = luminance(color) > 0.5 ? shade(color, -0.88) : shade(color, 0.85);
    return E.h('text', {
      x: 0, y: 0, 'text-anchor': 'middle', 'dominant-baseline': 'central',
      'font-family': 'Roboto, sans-serif', 'font-size': fmt(size), 'font-weight': 600, 'letter-spacing': fmt(size * 0.02),
      fill: color,
      stroke: halo ? haloColor : null, 'stroke-width': halo ? fmt(size * 0.16) : null, 'stroke-opacity': halo ? 0.85 : null,
      'stroke-linejoin': halo ? 'round' : null, 'paint-order': halo ? 'stroke' : null,
      class: 'label',
    }, [text]);
  },
};

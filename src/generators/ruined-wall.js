// Free-standing stone or brick wall along params.points. integrity 1 = continuous,
// lower values break it into runs with gaps and rubble.
import { env, clamp } from './_paint.js';
import { paintWall } from './_stone.js';

export default {
  type: 'ruined-wall',
  render(el, rng, ctx) {
    const E = env(el, ctx);
    const p = el.params || {};
    const w = paintWall(E, rng, {
      points: p.points, closed: !!p.closed, width: clamp(Number(p.width) || 2, 0.3, 8),
      material: p.material === 'brick' ? 'brick' : 'stone',
      integrity: clamp(Number.isFinite(p.integrity) ? p.integrity : 0.6),
      heightFt: clamp((Number.isFinite(p.heightFt) ? p.heightFt : 4) * 0.5, 0.5, 6),
    });
    return E.g({ class: 'ruined-wall' }, [...w.shadow, ...w.rubble, ...w.body]);
  },
};

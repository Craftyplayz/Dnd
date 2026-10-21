// One large faceted rock seen from above, filling size.w x size.h.
import { env, polyD, clamp } from './_paint.js';
import { paintRock, stoneTones } from './_stone.js';

export default {
  type: 'boulder',
  render(el, rng, ctx) {
    const E = env(el, ctx);
    const p = el.params || {};
    const stone = ['granite', 'sandstone', 'slate', 'mossy'].includes(p.stone) ? p.stone : 'granite';
    const heightFt = Number.isFinite(p.heightFt) ? p.heightFt : 4;
    const rock = paintRock(E, rng.fork('rock'), { rx: el.size.w / 2, ry: el.size.h / 2, tones: stoneTones(E, stone), moss: stone === 'mossy' });
    // Shadow kept short so tall rocks still read as sitting on the ground.
    const shadow = E.shadowEl(polyD(rock.outline, true), clamp(heightFt * 0.4, 0.4, Math.max(el.size.w, el.size.h) * 0.45));
    return E.g({ class: `boulder boulder-${stone}` }, [shadow, ...rock.nodes]);
  },
};

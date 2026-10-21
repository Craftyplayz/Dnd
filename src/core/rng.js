// Seeded deterministic RNG. Never use Math.random() in rendering or layout.
import { hash32 } from '../schema.js';

// mulberry32; returns an object so generators get helpers without extra imports.
export function createRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = {
    seed: seed >>> 0,
    next,                                             // [0, 1)
    range: (lo, hi) => lo + (hi - lo) * next(),       // [lo, hi)
    int: (lo, hi) => Math.floor(lo + (hi - lo + 1) * next()), // inclusive
    pick: arr => arr[Math.floor(next() * arr.length)],
    chance: p => next() < p,
    normal: (mean = 0, sd = 1) => mean + sd * Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next()),
    // Independent sub-stream: adding draws to one feature never shifts another.
    fork: label => createRng(hash32(`${seed >>> 0}:${label}`)),
  };
  return rng;
}

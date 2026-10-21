// Shared painted-style colours (docs/CONTRACT.md 5.1). Each entry is [dark, mid, light].
// Muted, slightly warm VTT tones; generators jitter them per element.
export const PALETTE = {
  grass: ['#3d5524', '#5a7431', '#87a04c'],
  foliage: ['#2b4520', '#4a682c', '#7d9a47'],
  pine: ['#1d3627', '#2e4f37', '#4e7350'],
  bark: ['#3a2a1d', '#5a412f', '#7e6046'],
  wood: ['#5a3d25', '#8a633a', '#b88c57'],
  woodDark: ['#2e2117', '#463325', '#5f4733'],
  stone: ['#5b5a55', '#85827a', '#b0ac9f'],
  dirt: ['#57432e', '#7c6444', '#a28962'],
  water: ['#1b3a45', '#2e5f6c', '#6a9ea3'],
  cloth: ['#6b5a40', '#a08a62', '#cdb98c'],
  fire: ['#c0451a', '#f08a24', '#ffd36a'],
  thatch: ['#7a6236', '#a68a4c', '#ccb070'],
  slate: ['#33393f', '#4b545c', '#6b7680'],
  // Extra tones used by terrain and ground materials (additions to the contract set).
  forest: ['#2c2a19', '#433d24', '#66603a'],
  mud: ['#2e2a21', '#4a4334', '#6b624c'],
  sand: ['#9a845a', '#bba375', '#dcc897'],
  snow: ['#a9b6c4', '#d5dde5', '#f4f7fa'],
  swamp: ['#2a2f1c', '#3f4728', '#5f6a3a'],
  moss: ['#344a1e', '#4f6b2a', '#76923f'],
  crops: ['#5f6a2a', '#8c8f3c', '#c2b45a'],
};

// ---- colour helpers (deterministic, hex in / hex out) ----
const clamp01 = v => Math.max(0, Math.min(1, v));
export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgbToHex = ([r, g, b]) => '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
export function mix(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return rgbToHex(A.map((v, i) => v + (B[i] - v) * clamp01(t)));
}
// Lighten (dl > 0) or darken (dl < 0) by a fraction of the way to white/black.
export const shade = (hex, dl) => (dl >= 0 ? mix(hex, '#ffffff', dl) : mix(hex, '#000000', -dl));
// Natural jitter: ±amt lightness and a small warm/cool shift.
export function jitter(hex, rng, amt = 0.06) {
  const [r, g, b] = hexToRgb(hex);
  const l = 1 + rng.range(-amt, amt), w = rng.range(-amt, amt) * 0.5;
  return rgbToHex([r * l * (1 + w), g * l, b * l * (1 - w)]);
}

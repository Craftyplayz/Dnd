// Export size math, filenames and tile planning (docs/CONTRACT.md section 10). Pure, no DOM.
import { slugify } from '../schema.js';

export const SQUARE_FT = 5;
export const MAX_SINGLE_PX = 8192;     // above this on either side, render tiles
export const TILE_W = 4096;            // no tile canvas exceeds 4096 px on a side
export const TILE_H = 1024;            // short bands keep one band of RGBA rows small in memory
export const CONFIRM_MEGAPIXELS = 400;

// pxPerFt null = current viewport zoom x devicePixelRatio. grid null = scene setting.
export const MODES = {
  vtt: { label: 'PNG - VTT', pxPerFt: 28, grid: null, hint: '140 px per square, for virtual tabletops' },
  print: { label: 'PNG - Print', pxPerFt: 60, grid: null, hint: '300 DPI, 1 inch per square' },
  screen: { label: 'PNG - Screen', pxPerFt: null, grid: null, hint: 'Visible area at screen resolution' },
  nogrid: { label: 'PNG - No grid', pxPerFt: 28, grid: false, hint: '140 px per square, grid hidden' },
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Visible span [a, a + len] rounded to whole squares and clipped to [0, max]; at least one square.
function squareSpan(a, len, max) {
  let lo = clamp(Math.round(a / SQUARE_FT) * SQUARE_FT, 0, max);
  let hi = clamp(Math.round((a + len) / SQUARE_FT) * SQUARE_FT, 0, max);
  if (hi - lo < SQUARE_FT) {
    lo = clamp(Math.floor((a + len / 2) / SQUARE_FT) * SQUARE_FT, 0, max - SQUARE_FT);
    hi = lo + SQUARE_FT;
  }
  return [lo, hi];
}

// -> { viewBox: {x, y, w, h} ft, pxPerFt, widthPx, heightPx, squaresW, squaresH, grid }
export function exportArea(scene, mode, viewport = null, dpr = 1) {
  const m = MODES[mode];
  if (!m) throw new Error(`unknown export mode "${mode}"`);
  const W = scene.grid.widthFt, H = scene.grid.heightFt;
  const grid = m.grid ?? scene.grid.visible !== false;
  let viewBox = { x: 0, y: 0, w: W, h: H }, pxPerFt = m.pxPerFt;
  if (pxPerFt === null) {
    if (!viewport || !(viewport.zoom > 0)) throw new Error('screen export needs the current view');
    const [x0, x1] = squareSpan(viewport.x, viewport.w, W);
    const [y0, y1] = squareSpan(viewport.y, viewport.h, H);
    viewBox = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    pxPerFt = viewport.zoom * (dpr > 0 ? dpr : 1);
  }
  return {
    viewBox, pxPerFt, grid,
    widthPx: Math.max(1, Math.round(viewBox.w * pxPerFt)),
    heightPx: Math.max(1, Math.round(viewBox.h * pxPerFt)),
    squaresW: Math.round(viewBox.w / SQUARE_FT),
    squaresH: Math.round(viewBox.h / SQUARE_FT),
  };
}

export function exportFilename(scene, area) {
  return `${slugify(scene.meta?.name ?? '')}_${area.squaresW}x${area.squaresH}.png`;
}

export const needsTiles = (widthPx, heightPx) => widthPx > MAX_SINGLE_PX || heightPx > MAX_SINGLE_PX;

// Tiles in PNG row order: bands top to bottom, tiles left to right within a band.
// -> [{ y, h, tiles: [{ x, y, w, h }] }] in px.
export function planTiles(widthPx, heightPx) {
  const bands = [];
  for (let y = 0; y < heightPx; y += TILE_H) {
    const h = Math.min(TILE_H, heightPx - y);
    const tiles = [];
    for (let x = 0; x < widthPx; x += TILE_W) tiles.push({ x, y, w: Math.min(TILE_W, widthPx - x), h });
    bands.push({ y, h, tiles });
  }
  return bands;
}

// Sub-viewBox in ft for a px tile of the export area.
export function tileViewBox(area, tile) {
  const { viewBox: vb, pxPerFt } = area;
  // Last tile ends exactly on the area edge so rounding never stretches it.
  const x1 = tile.x + tile.w >= area.widthPx ? vb.x + vb.w : vb.x + (tile.x + tile.w) / pxPerFt;
  const y1 = tile.y + tile.h >= area.heightPx ? vb.y + vb.h : vb.y + (tile.y + tile.h) / pxPerFt;
  const x0 = vb.x + tile.x / pxPerFt, y0 = vb.y + tile.y / pxPerFt;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

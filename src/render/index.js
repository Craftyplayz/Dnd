// Renderer: scene JSON -> layered SVG (docs/CONTRACT.md section 6). Pure and deterministic.
import { h, fmt, SVG_NS } from '../core/svg.js';
import { createRng } from '../core/rng.js';
import { iterElements } from '../schema.js';
import { GENERATORS } from '../generators/index.js';
import { PALETTE } from './palette.js';
import { buildDefs } from './defs.js';
import { renderTerrain } from './terrain.js';
import { renderLighting, renderGrid } from './lighting.js';

export { mountView } from './viewport.js';
export { PALETTE };

export const LAYER_ORDER = ['terrain', 'ground', 'low', 'objects', 'canopy', 'lighting', 'labels', 'grid'];
export const ELEMENT_LAYERS = ['ground', 'low', 'objects', 'canopy', 'labels'];
export const DEFAULT_LAYERS = { terrain: true, ground: true, low: true, objects: true, canopy: true, labels: true, grid: true, lighting: true };

export function lightOf(scene) {
  const L = scene.lighting || {};
  const azimuth = L.azimuth ?? 315, elevation = L.elevation ?? 45, intensity = L.intensity ?? 0.6, time = L.time || 'day';
  const a = (azimuth * Math.PI) / 180;
  return { azimuth, elevation, intensity, time, shadowDir: [-Math.sin(a) + 0, Math.cos(a) + 0] };
}

// Local-frame shadow offset: shadowDir * height / tan(elevation), capped at 2 * height, rotated by -rotation.
export function shadowOffset(light, el, heightFt) {
  const t = Math.tan((Math.max(1, light.elevation) * Math.PI) / 180);
  const len = Math.min(heightFt / t, 2 * heightFt);
  const wx = light.shadowDir[0] * len, wy = light.shadowDir[1] * len;
  const r = (-(el?.rotation || 0) * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [wx * c - wy * s, wx * s + wy * c];
}

// ctx shared by every generator in one render. `registry` maps def id -> owning element id
// so a live view can drop stale per-element defs (`g-<type>-<el.id>-<name>`) on re-render.
export function makeCtx(doc, scene, defsEl, registry = new Map()) {
  const light = lightOf(scene);
  const ctx = {
    doc, scene, light, palette: PALETTE, currentId: null,
    shadow: (el, heightFt) => shadowOffset(light, el, heightFt),
    def(id, build) {
      if (!registry.has(id)) {
        const node = build();
        node.setAttribute('id', id);
        defsEl.appendChild(node);
        registry.set(id, ctx.currentId);
      }
      return `url(#${id})`;
    },
  };
  return ctx;
}

const elTransform = el => `translate(${fmt(el.position.x)} ${fmt(el.position.y)}) rotate(${fmt(el.rotation || 0)})`;

function placeholder(el, doc) {
  let x = -el.size.w / 2, y = -el.size.h / 2, w = el.size.w, hh = el.size.h;
  const pts = el.params?.points;
  if (Array.isArray(pts) && pts.length) {
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]), pad = (el.params.width || 0) / 2;
    x = Math.min(...xs) - pad; y = Math.min(...ys) - pad; w = Math.max(...xs) - Math.min(...xs) + 2 * pad; hh = Math.max(...ys) - Math.min(...ys) + 2 * pad;
  }
  return h('rect', { x, y, width: Math.max(0.5, w), height: Math.max(0.5, hh), fill: '#e26b6b', 'fill-opacity': 0.15, stroke: '#e26b6b', 'stroke-width': 0.3, 'stroke-dasharray': '1 0.6', 'data-error': 'generator' }, [], doc);
}

export function renderElement(el, ctx, interactive = false) {
  const g = h('g', {
    class: 'el', 'data-id': el.id, 'data-type': el.type, 'data-layer': el.layer, transform: elTransform(el),
    'pointer-events': interactive ? 'visiblePainted' : null, style: interactive ? 'cursor:pointer' : null,
  }, [], ctx.doc);
  ctx.currentId = el.id;
  try {
    const gen = GENERATORS[el.type];
    if (!gen) throw new Error(`no generator for type "${el.type}"`);
    const out = gen.render(el, createRng(el.seed), ctx);
    if (out) g.appendChild(out);
  } catch (e) {
    console.error(`generator ${el.type} failed for ${el.id}`, e);
    while (g.firstChild) g.removeChild(g.firstChild);
    g.appendChild(placeholder(el, ctx.doc));
  }
  ctx.currentId = null;
  return g;
}
export { elTransform };

export function mapClip(doc, id, W, H) {
  return h('clipPath', { id, clipPathUnits: 'userSpaceOnUse' }, [h('rect', { x: 0, y: 0, width: W, height: H }, [], doc)], doc);
}

export function resolveLayers(scene, opts = {}) {
  const vis = { ...DEFAULT_LAYERS, ...(opts.layers || {}) };
  vis.grid = vis.grid && (opts.grid ?? scene.grid?.visible ?? true);
  return vis;
}

export function renderScene(scene, opts = {}) {
  const doc = opts.doc || globalThis.document;
  const W = scene.grid.widthFt, H = scene.grid.heightFt;
  const vb = opts.viewBox || { x: 0, y: 0, w: W, h: H };
  const vis = resolveLayers(scene, opts);
  const svg = h('svg', {
    viewBox: `${fmt(vb.x)} ${fmt(vb.y)} ${fmt(vb.w)} ${fmt(vb.h)}`, 'shape-rendering': 'geometricPrecision',
    width: opts.widthPx, height: opts.heightPx, preserveAspectRatio: 'none',
  }, [], doc);
  svg.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns', SVG_NS);
  const defs = buildDefs(doc);
  svg.appendChild(defs);
  // Every map layer is clipped to the map rect so verges, canopies and blur never spill past the border.
  const clipId = `map-clip-${W}x${H}`;
  defs.appendChild(mapClip(doc, clipId, W, H));
  const ctx = makeCtx(doc, scene, defs);
  const buckets = Object.fromEntries(ELEMENT_LAYERS.map(l => [l, []]));
  for (const { el } of iterElements(scene)) (buckets[el.layer] || buckets.objects).push(el);
  for (const name of LAYER_ORDER) {
    if (!vis[name]) continue;
    const g = name === 'terrain' ? renderTerrain(scene, ctx)
      : name === 'lighting' ? renderLighting(scene, doc, clipId)
      : name === 'grid' ? renderGrid(scene, doc)
      : h('g', { 'data-layer': name }, buckets[name].map(el => renderElement(el, ctx, !!opts.interactive)), doc);
    // A clipped group is isolated, which would stop the lighting blend modes from reaching the map below;
    // lighting clips its own shapes instead.
    if (name !== 'lighting') g.setAttribute('clip-path', `url(#${clipId})`);
    svg.appendChild(g);
  }
  return svg;
}

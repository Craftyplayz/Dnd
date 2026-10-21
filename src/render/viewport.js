// Live pan/zoom view with per-element render caching (docs/CONTRACT.md section 6).
import { h, fmt, SVG_NS } from '../core/svg.js';
import { iterElements } from '../schema.js';
import { buildDefs } from './defs.js';
import { renderTerrain } from './terrain.js';
import { renderLighting, renderGrid, litFires } from './lighting.js';
import { LAYER_ORDER, ELEMENT_LAYERS, DEFAULT_LAYERS, makeCtx, renderElement, elTransform } from './index.js';

const ZMIN = 1, ZMAX = 200;
const clampZ = z => Math.max(ZMIN, Math.min(ZMAX, z));
const typing = t => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export function mountView(container, bus) {
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  const svg = h('svg', { class: 'bms-view', 'shape-rendering': 'geometricPrecision', preserveAspectRatio: 'none' }, [], doc);
  svg.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns', SVG_NS);
  const defs = buildDefs(doc);
  const registry = new Map();
  const groups = {};
  svg.appendChild(defs);
  for (const name of LAYER_ORDER) {
    const g = h('g', { 'data-layer': name, 'pointer-events': ELEMENT_LAYERS.includes(name) ? null : 'none' }, [], doc);
    groups[name] = g;
    svg.appendChild(g);
  }
  const overlay = h('g', { 'data-layer': 'overlay' }, [], doc);
  svg.appendChild(overlay);
  container.appendChild(svg);

  const vis = { ...DEFAULT_LAYERS };
  let scene = null, vp = { x: 0, y: 0, zoom: 4 }, userMoved = false, lastDims = '';
  const keys = { terrain: null, lighting: null, grid: null };
  const cache = new Map(); // id -> { key, node, transform }

  const size = () => ({ w: container.clientWidth || 1, h: container.clientHeight || 1 });
  const getViewport = () => { const s = size(); return { x: vp.x, y: vp.y, w: s.w / vp.zoom, h: s.h / vp.zoom, zoom: vp.zoom }; };
  function apply(emit = true) {
    const v = getViewport();
    svg.setAttribute('viewBox', `${fmt(v.x)} ${fmt(v.y)} ${fmt(v.w)} ${fmt(v.h)}`);
    if (emit) bus?.emit('view:changed', v);
  }
  function fit() {
    if (!scene) return;
    const s = size(), W = scene.grid.widthFt, H = scene.grid.heightFt;
    vp.zoom = clampZ(Math.min(s.w / W, s.h / H) * 0.94);
    vp.x = W / 2 - s.w / vp.zoom / 2;
    vp.y = H / 2 - s.h / vp.zoom / 2;
    apply();
  }
  function setViewport({ x = vp.x, y = vp.y, zoom = vp.zoom } = {}) {
    vp = { x, y, zoom: clampZ(zoom) };
    userMoved = true;
    apply();
  }
  function zoomAt(cx, cy, zoom) {
    const r = svg.getBoundingClientRect();
    const fx = vp.x + (cx - r.left) / vp.zoom, fy = vp.y + (cy - r.top) / vp.zoom;
    vp.zoom = clampZ(zoom);
    vp.x = fx - (cx - r.left) / vp.zoom;
    vp.y = fy - (cy - r.top) / vp.zoom;
    userMoved = true;
    apply();
  }

  function replaceKids(g, fresh) {
    while (g.firstChild) g.removeChild(g.firstChild);
    while (fresh.firstChild) g.appendChild(fresh.firstChild);
  }
  function applyVisibility() {
    for (const name of LAYER_ORDER) {
      const on = vis[name] && (name !== 'grid' || !scene || scene.grid.visible);
      if (on) groups[name].removeAttribute('display'); else groups[name].setAttribute('display', 'none');
    }
  }

  function setScene(next) {
    scene = next;
    const ctx = makeCtx(doc, scene, defs, registry);
    const W = scene.grid.widthFt, H = scene.grid.heightFt;
    const tk = JSON.stringify([scene.terrain, W, H, scene.seed]);
    if (tk !== keys.terrain) { keys.terrain = tk; replaceKids(groups.terrain, renderTerrain(scene, ctx)); }
    const lk = JSON.stringify([scene.lighting, litFires(scene), W, H]);
    if (lk !== keys.lighting) { keys.lighting = lk; replaceKids(groups.lighting, renderLighting(scene, doc)); }
    const gk = JSON.stringify(scene.grid);
    if (gk !== keys.grid) { keys.grid = gk; replaceKids(groups.grid, renderGrid(scene, doc)); }

    const lightKey = JSON.stringify(ctx.light);
    const want = Object.fromEntries(ELEMENT_LAYERS.map(l => [l, []]));
    const seen = new Set();
    for (const { el } of iterElements(scene)) {
      seen.add(el.id);
      // Position only changes the wrapper transform, so dragging never re-runs a generator.
      const key = JSON.stringify({ ...el, position: 0 }) + lightKey;
      let c = cache.get(el.id);
      if (!c || c.key !== key) {
        for (const [id, owner] of registry) {
          if (owner === el.id && id.includes(`-${el.id}-`)) { registry.delete(id); defs.querySelector(`[id="${id}"]`)?.remove(); }
        }
        const node = renderElement(el, ctx, true);
        if (c?.node.parentNode) c.node.parentNode.removeChild(c.node);
        c = { key, node, transform: node.getAttribute('transform') };
        cache.set(el.id, c);
      } else {
        const t = elTransform(el);
        if (t !== c.transform) { c.node.setAttribute('transform', t); c.transform = t; }
      }
      (want[el.layer] || want.objects).push(c.node);
    }
    for (const [id, c] of cache) if (!seen.has(id)) { c.node.parentNode?.removeChild(c.node); cache.delete(id); }
    for (const name of ELEMENT_LAYERS) {
      const g = groups[name], list = want[name];
      for (let i = 0; i < list.length; i++) if (g.childNodes[i] !== list[i]) g.insertBefore(list[i], g.childNodes[i] || null);
      while (g.childNodes.length > list.length) g.removeChild(g.lastChild);
    }
    applyVisibility();
    const dims = `${W}x${H}`;
    if (dims !== lastDims) { lastDims = dims; fit(); } // new map size: show all of it
  }

  // ---- interaction: wheel zoom, middle/right/Space+left drag pan ----
  let space = false, pan = null;
  const onKey = e => {
    if (e.code !== 'Space' || typing(e.target)) return;
    const down = e.type === 'keydown';
    if (down) e.preventDefault();
    space = down;
    svg.classList.toggle('pan-ready', space);
  };
  win.addEventListener('keydown', onKey);
  win.addEventListener('keyup', onKey);
  win.addEventListener('blur', () => { space = false; svg.classList.remove('pan-ready'); });

  svg.addEventListener('pointerdown', e => {
    if (!(e.button === 1 || e.button === 2 || (e.button === 0 && space))) return;
    e.preventDefault();
    e.stopPropagation(); // left button + Space must not reach the editor
    pan = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x: vp.x, y: vp.y };
    svg.setPointerCapture?.(e.pointerId);
    svg.classList.add('panning');
  }, { capture: true });
  svg.addEventListener('pointermove', e => {
    if (!pan || e.pointerId !== pan.id) return;
    e.stopPropagation();
    vp.x = pan.x - (e.clientX - pan.sx) / vp.zoom;
    vp.y = pan.y - (e.clientY - pan.sy) / vp.zoom;
    userMoved = true;
    apply();
  }, { capture: true });
  const end = e => {
    if (!pan || e.pointerId !== pan.id) return;
    e.stopPropagation();
    pan = null;
    svg.classList.remove('panning');
  };
  svg.addEventListener('pointerup', end, { capture: true });
  svg.addEventListener('pointercancel', end, { capture: true });
  svg.addEventListener('contextmenu', e => e.preventDefault());
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : 0.0015;
    zoomAt(e.clientX, e.clientY, vp.zoom * Math.exp(-e.deltaY * unit));
  }, { passive: false });

  let lastSize = '';
  const ro = new win.ResizeObserver(() => {
    const s = size(), k = `${s.w}x${s.h}`;
    if (k === lastSize) return;
    const before = lastSize ? lastSize.split('x').map(Number) : null;
    lastSize = k;
    if (!scene) return;
    if (!userMoved || !before) { fit(); return; }
    // Keep the centre fixed when the container resizes.
    const cx = vp.x + before[0] / vp.zoom / 2, cy = vp.y + before[1] / vp.zoom / 2;
    vp.x = cx - s.w / vp.zoom / 2; vp.y = cy - s.h / vp.zoom / 2;
    apply();
  });
  ro.observe(container);

  return {
    svg, overlay, setScene, fit, getViewport, setViewport,
    setLayerVisibility(name, visible) { if (name in vis) { vis[name] = !!visible; applyVisibility(); } },
    getLayerVisibility: () => ({ ...vis }),
    screenToFt(cx, cy) { const r = svg.getBoundingClientRect(); return { x: vp.x + (cx - r.left) / vp.zoom, y: vp.y + (cy - r.top) / vp.zoom }; },
    ftToScreen(x, y) { const r = svg.getBoundingClientRect(); return { x: r.left + (x - vp.x) * vp.zoom, y: r.top + (y - vp.y) * vp.zoom }; },
    elementIdAt(cx, cy) {
      for (const e of doc.elementsFromPoint(cx, cy)) {
        if (!svg.contains(e) || overlay.contains(e)) continue;
        const g = e.closest('g.el');
        if (g && svg.contains(g)) return g.getAttribute('data-id');
      }
      return null;
    },
  };
}

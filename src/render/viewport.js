// Live pan/zoom view with per-element render caching (docs/CONTRACT.md section 6).
import { h, fmt, SVG_NS } from '../core/svg.js';
import { iterElements } from '../schema.js';
import { buildDefs } from './defs.js';
import { renderTerrain } from './terrain.js';
import { renderLighting, renderGrid, litFires } from './lighting.js';
import { LAYER_ORDER, ELEMENT_LAYERS, DEFAULT_LAYERS, makeCtx, renderElement, elTransform, mapClip } from './index.js';

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
  // Map-rect clip shared by all map layers (not the overlay); its rect follows the scene size.
  const clip = mapClip(doc, 'map-clip-view', 1, 1);
  defs.appendChild(clip);
  for (const name of LAYER_ORDER) {
    const g = h('g', { 'data-layer': name, 'pointer-events': ELEMENT_LAYERS.includes(name) ? null : 'none', 'clip-path': name === 'lighting' ? null : 'url(#map-clip-view)' }, [], doc);
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
  // vp is the live viewport (what the user sees). The SVG content is only re-laid-out at commit():
  // during a pan/zoom gesture we move the already-rasterised, composited <svg> with a CSS transform,
  // and commit the real viewBox once the gesture has been idle for IDLE_MS.
  // The svg is larger than the container by OVER px on each side so short pans reveal real content.
  const IDLE_MS = 100;
  let committed = null, over = 0, idleTimer = 0;
  svg.style.willChange = 'transform';
  // Screen position of the container's padding box (where map x = vp.x sits).
  const origin = () => { const r = container.getBoundingClientRect(); return [r.left + container.clientLeft, r.top + container.clientTop]; };
  const getViewport = () => { const s = size(); return { x: vp.x, y: vp.y, w: s.w / vp.zoom, h: s.h / vp.zoom, zoom: vp.zoom }; };
  function commit() {
    clearTimeout(idleTimer); idleTimer = 0;
    const s = size();
    over = Math.round(Math.max(s.w, s.h) * 0.25);
    committed = { ...vp, w: s.w, h: s.h, over };
    const z = vp.zoom;
    Object.assign(svg.style, { inset: 'auto', left: `${-over}px`, top: `${-over}px`, width: `${s.w + 2 * over}px`, height: `${s.h + 2 * over}px`, transform: '', transformOrigin: `${over}px ${over}px` });
    svg.setAttribute('viewBox', `${fmt(vp.x - over / z)} ${fmt(vp.y - over / z)} ${fmt((s.w + 2 * over) / z)} ${fmt((s.h + 2 * over) / z)}`);
  }
  // Live viewport still inside the rendered (committed) area?
  function covered() {
    const c = committed, s = size();
    if (!c || c.w !== s.w || c.h !== s.h) return false;
    const r = vp.zoom / c.zoom;
    if (r < 0.6 || r > 3) return false; // keep scaled bitmaps from getting too blurry / too small
    const x0 = c.x - c.over / c.zoom, y0 = c.y - c.over / c.zoom, x1 = x0 + (c.w + 2 * c.over) / c.zoom, y1 = y0 + (c.h + 2 * c.over) / c.zoom;
    return vp.x >= x0 && vp.y >= y0 && vp.x + s.w / vp.zoom <= x1 && vp.y + s.h / vp.zoom <= y1;
  }
  function apply(emit = true, gesture = false) {
    if (gesture && covered()) {
      const c = committed, k = vp.zoom / c.zoom;
      svg.style.transform = `translate(${fmt((c.x - vp.x) * vp.zoom)}px, ${fmt((c.y - vp.y) * vp.zoom)}px) scale(${k})`;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(commit, IDLE_MS);
    } else commit();
    if (emit) bus?.emit('view:changed', getViewport());
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
    const [ox, oy] = origin();
    const fx = vp.x + (cx - ox) / vp.zoom, fy = vp.y + (cy - oy) / vp.zoom;
    vp.zoom = clampZ(zoom);
    vp.x = fx - (cx - ox) / vp.zoom;
    vp.y = fy - (cy - oy) / vp.zoom;
    userMoved = true;
    apply(true, true);
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
    clip.firstChild.setAttribute('width', String(W));
    clip.firstChild.setAttribute('height', String(H));
    const tk = JSON.stringify([scene.terrain, W, H, scene.seed]);
    if (tk !== keys.terrain) { keys.terrain = tk; replaceKids(groups.terrain, renderTerrain(scene, ctx)); }
    const lk = JSON.stringify([scene.lighting, litFires(scene), W, H]);
    if (lk !== keys.lighting) { keys.lighting = lk; replaceKids(groups.lighting, renderLighting(scene, doc, 'map-clip-view')); }
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
    apply(true, true);
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
    screenToFt(cx, cy) { const [ox, oy] = origin(); return { x: vp.x + (cx - ox) / vp.zoom, y: vp.y + (cy - oy) / vp.zoom }; },
    ftToScreen(x, y) { const [ox, oy] = origin(); return { x: ox + (x - vp.x) * vp.zoom, y: oy + (y - vp.y) * vp.zoom }; },
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

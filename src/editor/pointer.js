// Pointer interaction on the map: click-select, drag-move, resize/rotate/point handles, measure tool.
// Left button without Space belongs to the editor; the view owns pan (middle/right/Space+left) and wheel.
import { findElement, normalizeScene } from '../schema.js';
import { applyPatch } from '../core/patch.js';
import { distanceFt, boundsOf } from '../core/geom.js';
import { moveOps, resizeOps, rotateOps, pointOps, removePointOps, insertPointOps, formatFeet } from './ops.js';

const DRAG_PX = 4;
const centreOf = el => { const b = boundsOf(el); return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }; };

export function initPointer(ctx) {
  const { view, store, state } = ctx;
  const svg = view.svg;
  let g = null; // active gesture

  const ft = e => view.screenToFt(e.clientX, e.clientY);
  const readout = document.createElement('div');
  readout.className = 'bms-readout';
  readout.setAttribute('role', 'status');
  readout.hidden = true;
  ctx.dom.map.append(readout);
  const setReadout = text => { readout.hidden = !text; readout.textContent = text || ''; };
  ctx.bus.on('tool:changed', () => setReadout(''));

  function buildOps(e) {
    const scene = g.scene, p = ft(e), free = e.altKey;
    const el = g.id && findElement(scene, g.id)?.el;
    switch (g.kind) {
      case 'move': return moveOps(scene, state.ids, g.id, p.x - g.start.x, p.y - g.start.y, { free });
      case 'resize': return resizeOps(scene, el, g.hx, g.hy, p, { free, keepAspect: e.shiftKey });
      case 'rotate': return rotateOps(el, p, { free });
      case 'point': return pointOps(el, g.i, p, { free });
      default: return [];
    }
  }

  const LABELS = { move: 'Move', resize: 'Resize', rotate: 'Rotate', point: 'Move point' };

  svg.addEventListener('pointerdown', e => {
    if (e.button !== 0 || state.space) return;
    const start = ft(e);
    const scene = store.get();
    const handle = e.target.closest?.('[data-handle]');
    g = { kind: null, start, sx: e.clientX, sy: e.clientY, scene, moved: false, pointerId: e.pointerId, ops: [] };

    if (state.tool === 'measure') {
      g.kind = 'measure';
      g.hit = view.elementIdAt(e.clientX, e.clientY);
    } else if (handle && state.ids.length === 1) {
      g.kind = handle.dataset.handle;
      g.id = state.ids[0];
      g.hx = Number(handle.dataset.hx); g.hy = Number(handle.dataset.hy); g.i = Number(handle.dataset.i);
    } else {
      const id = view.elementIdAt(e.clientX, e.clientY);
      if (!id) { if (!e.shiftKey) ctx.select([]); g = null; return; }
      if (e.shiftKey) {
        ctx.select(state.ids.includes(id) ? state.ids.filter(x => x !== id) : [...state.ids, id]);
        if (!state.ids.includes(id)) { g = null; return; }
      } else if (!state.ids.includes(id)) ctx.select([id]);
      g.kind = 'move';
      g.id = id;
    }
    e.preventDefault();
    try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic pointers */ }
  });

  svg.addEventListener('pointermove', e => {
    if (!g || e.pointerId !== g.pointerId) return;
    if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < DRAG_PX) return;
    g.moved = true;
    if (g.kind === 'measure') {
      const b = ft(e);
      const d = Math.hypot(b.x - g.start.x, b.y - g.start.y);
      state.measure = { line: { a: g.start, b, text: formatFeet(d) } };
      setReadout(`Distance: ${formatFeet(d)}`);
      ctx.redraw();
      return;
    }
    state.dragging = true;
    ctx.dom.map.classList.add('bms-dragging');
    g.ops = buildOps(e);
    let temp = g.scene;
    if (g.ops.length) {
      try { temp = normalizeScene(applyPatch(g.scene, g.ops)); } catch { temp = g.scene; g.ops = []; }
    }
    ctx.preview(temp);
  });

  function finish(e, cancel) {
    if (!g || e.pointerId !== g.pointerId) return;
    const cur = g; g = null;
    state.dragging = false;
    ctx.dom.map.classList.remove('bms-dragging');
    try { svg.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (cur.kind === 'measure') { if (!cur.moved && !cancel) measureClick(cur.hit); return; }
    if (!cur.moved) return;
    if (cancel || !cur.ops.length) { ctx.preview(null); return; }
    const res = ctx.commit(cur.ops, LABELS[cur.kind], 'drag');
    if (!res.ok) ctx.preview(null);
  }
  svg.addEventListener('pointerup', e => finish(e, false));
  svg.addEventListener('pointercancel', e => finish(e, true));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && g && g.moved && g.kind !== 'measure') {
      const id = g.pointerId; g.ops = [];
      finish({ pointerId: id }, true);
    }
  });

  function measureClick(id) {
    const scene = store.get();
    const m = state.measure;
    if (!id) { state.measure = {}; setReadout(''); ctx.redraw(); return; }
    if (m.pending && m.pending !== id) {
      const A = findElement(scene, m.pending).el, B = findElement(scene, id).el;
      const edge = distanceFt(A, B, 'edge'), centre = distanceFt(A, B, 'center');
      const text = `Edge ${formatFeet(edge)}\nCentre ${formatFeet(centre)}`;
      state.measure = { pair: { a: centreOf(A), b: centreOf(B), text, ids: [A.id, B.id] } };
      setReadout(`${A.name} to ${B.name}: edge ${formatFeet(edge)}, centre ${formatFeet(centre)}`);
    } else {
      state.measure = { pending: id };
      setReadout(`${findElement(scene, id).el.name}: click a second element`);
    }
    ctx.redraw();
  }

  // Double-click on a point handle removes it; on a selected path/region inserts a point.
  svg.addEventListener('dblclick', e => {
    if (state.tool !== 'select' || state.ids.length !== 1) return;
    const el = findElement(store.get(), state.ids[0])?.el;
    if (!el?.params?.points) return;
    // Pointer capture retargets click events to the svg, so hit-test the point instead of e.target.
    const handle = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-handle="point"]');
    if (handle) {
      const ops = removePointOps(el, Number(handle.dataset.i));
      if (!ops.length) ctx.status('warn', 'This shape already has the minimum number of points.');
      ctx.commit(ops, 'Remove point');
    } else if (view.elementIdAt(e.clientX, e.clientY) === el.id) {
      ctx.commit(insertPointOps(el, ft(e)), 'Add point');
    }
  });
}

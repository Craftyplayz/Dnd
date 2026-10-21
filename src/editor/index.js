// Editor entry: selection, tools, keyboard, overlay, and the UI pieces (topbar, popover, side panel, toasts).
// See docs/CONTRACT.md section 8.
import { findElement } from '../schema.js';
import { drawOverlay } from './overlay.js';
import { initPointer } from './pointer.js';
import { initPopover } from './popover.js';
import { initTopbar } from './topbar.js';
import { initPanels } from './panels.js';
import { initToasts } from './toasts.js';
import { deleteOps, nudgeOps, formatErrors } from './ops.js';

const isTyping = t => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export function initEditor({ store, view, bus, api, layout, dom }) {
  const state = { ids: [], tool: 'select', busy: false, measure: {}, preview: null, dragging: false, space: false };

  const ctx = {
    store, view, bus, api, layout, dom, state,
    onRedraw: [], // UI pieces that follow the overlay (popover position)
    scene: () => state.preview || store.get(),
    status: (level, message) => bus.emit('status', { level, message }),
    redraw() {
      drawOverlay(view, ctx.scene(), { ids: state.ids, showHandles: state.tool === 'select', measure: state.measure });
      for (const fn of ctx.onRedraw) fn();
    },
    // Show a temporary scene (drag preview) without committing; null restores the store scene.
    preview(scene) {
      state.preview = scene;
      view.setScene(scene || store.get());
      ctx.redraw();
    },
    select(ids) {
      const scene = store.get();
      const next = [...new Set(ids || [])].filter(id => findElement(scene, id));
      if (next.length === state.ids.length && next.every((id, i) => id === state.ids[i])) return;
      state.ids = next;
      bus.emit('selection:changed', { ids: [...next] });
      ctx.redraw();
    },
    setTool(tool) {
      if (tool !== 'select' && tool !== 'measure') return;
      if (tool === state.tool) return;
      state.tool = tool;
      state.measure = {};
      dom.map.classList.toggle('bms-measuring', tool === 'measure');
      bus.emit('tool:changed', { tool });
      ctx.redraw();
    },
    // One commit with user feedback on failure. Returns the store result.
    commit(ops, label, source = 'edit') {
      if (!ops.length) return { ok: true, errors: [] };
      const res = store.commit(ops, { label, source });
      if (!res.ok) ctx.status('error', `${label} failed: ${formatErrors(res.errors)}`);
      return res;
    },
    // Serialises long requests (generate / AI edit): one at a time, emits busy.
    async runBusy(label, fn) {
      if (state.busy) { ctx.status('warn', 'Please wait for the current request to finish.'); return undefined; }
      state.busy = true;
      bus.emit('busy', { busy: true, label });
      try { return await fn(); } finally {
        state.busy = false;
        bus.emit('busy', { busy: false, label });
      }
    },
  };

  bus.on('scene:changed', ({ scene }) => {
    state.preview = null;
    const kept = state.ids.filter(id => findElement(scene, id));
    if (kept.length !== state.ids.length) { state.ids = kept; bus.emit('selection:changed', { ids: [...kept] }); }
    if (state.measure.pending && !findElement(scene, state.measure.pending)) state.measure = {};
    // Defer so the view (re-rendered by main.js on the same event) is current first.
    queueMicrotask(ctx.redraw);
  });
  bus.on('view:changed', () => ctx.redraw());

  initToasts(ctx);
  initTopbar(ctx);
  initPopover(ctx);
  initPanels(ctx);
  initPointer(ctx);

  document.addEventListener('keydown', e => {
    if (e.key === ' ' && !isTyping(e.target)) state.space = true;
    if (isTyping(e.target) || e.defaultPrevented) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); store.undo(); return; }
    if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); store.redo(); return; }
    if (mod || e.altKey) return;
    if (state.dragging) { if (k === 'escape') e.preventDefault(); return; }
    if (k === 'escape') { state.measure = {}; ctx.select([]); ctx.redraw(); return; }
    if (k === 'v') { ctx.setTool('select'); return; }
    if (k === 'm') { ctx.setTool('measure'); return; }
    if ((k === 'delete' || k === 'backspace') && state.ids.length) {
      e.preventDefault();
      const n = state.ids.length;
      ctx.commit(deleteOps(store.get(), state.ids), n === 1 ? 'Delete' : `Delete ${n} elements`, 'delete');
      return;
    }
    const dir = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] }[k];
    if (dir && state.ids.length) {
      e.preventDefault();
      const step = e.shiftKey ? 1 : 5;
      ctx.commit(nudgeOps(store.get(), state.ids, dir[0] * step, dir[1] * step), 'Nudge', 'edit');
    }
  });
  document.addEventListener('keyup', e => { if (e.key === ' ') state.space = false; });
  window.addEventListener('blur', () => { state.space = false; });

  ctx.redraw();
  return {
    select: ids => ctx.select(ids),
    getSelection: () => [...state.ids],
    setTool: name => ctx.setTool(name),
  };
}

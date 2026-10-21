// "Describe the change" popover beside the selection, or a docked whole-map box when nothing is selected.
import { findElement, TYPES } from '../schema.js';
import { html, nextId, elapsed, icon } from './ui.js';
import { selectionBounds } from './overlay.js';
import { boundsOf } from '../core/geom.js';
import { outOfScope, errorMessage, formatErrors } from './ops.js';

const trim1 = v => String(Math.round(v * 10) / 10);

export function initPopover(ctx) {
  const { store, view, bus, api, layout, state, dom } = ctx;
  const taId = nextId('describe');
  const title = html('strong', { class: 'bms-pop-title' });
  const sub = html('span', { class: 'bms-pop-sub' });
  const meta = html('div', { class: 'bms-pop-meta' });
  const ta = html('textarea', { id: taId, class: 'input', rows: 2, maxlength: 2000 });
  const applyBtn = html('button', { type: 'button', class: 'btn primary', text: 'Apply', title: 'Apply (Ctrl+Enter)' });
  const statusEl = html('div', { class: 'bms-pop-status', role: 'status', 'aria-live': 'polite' });
  const collapseBtn = html('button', { type: 'button', class: 'bms-icon-btn', 'aria-label': 'Hide the map change box', title: 'Hide' }, [icon('close')]);
  const minBtn = html('button', { type: 'button', class: 'bms-icon-btn', 'aria-expanded': 'true' });
  const head = html('div', { class: 'bms-pop-head', title: 'Drag to move' }, [html('div', { class: 'bms-pop-name' }, [title, sub]), minBtn, collapseBtn]);
  const body = html('div', { class: 'bms-pop-body' }, [
    meta,
    html('label', { for: taId, class: 'bms-label', text: 'Describe the change' }),
    ta,
    html('div', { class: 'bms-pop-actions' }, [html('span', { class: 'bms-hint', text: 'Ctrl+Enter' }), applyBtn]),
  ]);
  const box = html('div', { class: 'bms-popover card', role: 'region', 'aria-label': 'Describe a change' }, [head, body, statusEl]);
  const pill = html('button', { type: 'button', class: 'btn bms-map-pill', text: 'Describe a change to the whole map' });
  dom.map.append(box, pill);

  // The whole-map box starts collapsed to a small button; the selection popover can be minimised to its title bar.
  let mode = null, collapsed = true, minimised = false, manualPos = null;
  const drafts = new Map(); // instruction drafts per selection ('' key = whole map)
  let draftKey = null;

  function setStatus(level, text) {
    statusEl.className = `bms-pop-status ${level || ''}`;
    statusEl.textContent = text || '';
    if (mode === 'selection' && !box.hidden) place(ctx.scene()); // height may have changed
  }

  function render() {
    const scene = ctx.scene();
    const ids = state.ids;
    const newMode = ids.length ? 'selection' : 'map';
    const key = [...ids].sort().join(',');
    if (key !== draftKey) {
      if (draftKey !== null) drafts.set(draftKey, ta.value);
      ta.value = drafts.get(key) || '';
      draftKey = key;
      mode = newMode;
      manualPos = null;
      if (!state.busy) setStatus('', '');
    }
    const hide = state.tool !== 'select' || state.dragging;
    box.classList.toggle('docked', mode === 'map');
    box.hidden = hide || (mode === 'map' && collapsed);
    pill.hidden = hide || mode !== 'map' || !collapsed;
    collapseBtn.hidden = mode !== 'map';
    minBtn.hidden = mode === 'map';
    const min = mode === 'selection' && minimised;
    box.classList.toggle('min', min);
    body.hidden = min;
    minBtn.replaceChildren(icon(min ? 'chevronDown' : 'chevronUp'));
    minBtn.setAttribute('aria-expanded', String(!min));
    minBtn.setAttribute('aria-label', min ? 'Expand the change box' : 'Minimise the change box');
    minBtn.title = minBtn.getAttribute('aria-label');
    if (mode === 'map') {
      title.textContent = 'Change the whole map';
      sub.textContent = '';
      meta.textContent = 'Nothing selected. Click an element to edit just that.';
      ta.placeholder = 'e.g. make it dusk and add a second campfire near the tents';
      box.style.left = box.style.top = '';
      return;
    }
    const els = ids.map(id => findElement(scene, id)?.el).filter(Boolean);
    if (els.length === 1) {
      const el = els[0];
      title.textContent = el.name;
      sub.textContent = ` ${el.type}`;
      meta.textContent = `${trim1(el.size.w)} x ${trim1(el.size.h)} ft at (${trim1(el.position.x)}, ${trim1(el.position.y)})${el.rotation ? `, rotated ${trim1(el.rotation)} deg` : ''}`;
      ta.placeholder = TYPES[el.type]?.kind === 'object' ? 'e.g. make it twice as big and turn it to face the road' : 'e.g. make it wider and curve it around the boulder';
    } else {
      title.textContent = `${els.length} elements`;
      sub.textContent = '';
      meta.textContent = els.map(e => e.name).join(', ');
      ta.placeholder = 'e.g. spread these out along the road';
    }
    if (!box.hidden) place(scene);
  }

  // Beside the selection on the side that covers the fewest neighbouring objects, or where the user dragged it.
  function place(scene) {
    const mr = dom.map.getBoundingClientRect();
    const w = box.offsetWidth || 280, hgt = box.offsetHeight || 180, pad = 12, gapPx = 16;
    const clampRect = (left, top) => ({
      l: Math.max(pad, Math.min(left, mr.width - w - pad)),
      t: Math.max(pad, Math.min(top, mr.height - hgt - pad)),
    });
    if (manualPos) { const c = clampRect(manualPos.l, manualPos.t); setPos(c); return; }
    const b = selectionBounds(scene, state.ids);
    if (!b) return;
    const toRect = bb => {
      const p1 = view.ftToScreen(bb.minX, bb.minY), p2 = view.ftToScreen(bb.maxX, bb.maxY);
      return { l: Math.min(p1.x, p2.x) - mr.left, t: Math.min(p1.y, p2.y) - mr.top, r: Math.max(p1.x, p2.x) - mr.left, b: Math.max(p1.y, p2.y) - mr.top };
    };
    const sel = toRect(b);
    // Keep clear of the overlay's name/size tag and rotation handle too.
    for (const n of view.overlay.querySelectorAll('.bms-tag, [data-handle="rotate"]')) {
      const q = n.getBoundingClientRect();
      if (!q.width) continue;
      sel.l = Math.min(sel.l, q.left - mr.left); sel.r = Math.max(sel.r, q.right - mr.left);
      sel.t = Math.min(sel.t, q.top - mr.top); sel.b = Math.max(sel.b, q.bottom - mr.top);
    }
    // Large terrain (regions, paths) is under everything; only objects and labels count as obstacles.
    const others = [...scene.objects, ...scene.labels].filter(e => !state.ids.includes(e.id)).map(e => toRect(boundsOf(e)));
    const area = (a, r) => Math.max(0, Math.min(a.l + w, r.r) - Math.max(a.l, r.l)) * Math.max(0, Math.min(a.t + hgt, r.b) - Math.max(a.t, r.t));
    const midY = (sel.t + sel.b) / 2 - hgt / 2, midX = (sel.l + sel.r) / 2 - w / 2;
    // Right, left, below, above: centred first, then aligned to either end of that side.
    const right = sel.r + gapPx, left = sel.l - gapPx - w, below = sel.b + gapPx, above = sel.t - gapPx - hgt;
    const candidates = [
      [right, midY], [left, midY], [midX, below], [midX, above],
      [right, sel.t], [right, sel.b - hgt], [left, sel.t], [left, sel.b - hgt],
      [sel.l, below], [sel.r - w, below], [sel.l, above], [sel.r - w, above],
    ].map(([l, t]) => clampRect(l, t));
    let best = null, bestScore = Infinity;
    for (const c of candidates) {
      const score = area(c, sel) * 20 + others.reduce((s, r) => s + area(c, r), 0);
      if (score < bestScore - 1) { best = c; bestScore = score; }
    }
    setPos(best);
  }
  function setPos(c) {
    box.style.left = `${c.l}px`;
    box.style.top = `${c.t}px`;
  }

  async function apply() {
    const instruction = ta.value.trim();
    if (!instruction) { setStatus('error', 'Describe the change first.'); ta.focus(); return; }
    const scene = store.get();
    const ids = [...state.ids];
    const selected = ids.map(id => findElement(scene, id)?.el).filter(Boolean);
    let neighbours = [], summary;
    try {
      neighbours = ids.length ? layout.neighbours(scene, ids, 40) : [];
      summary = layout.summarizeScene(scene);
    } catch (err) {
      setStatus('error', `Could not prepare the request: ${err.message}`);
      return;
    }
    await ctx.runBusy('AI edit', async () => {
      const stop = elapsed(s => setStatus('busy', `Working on it... ${s} s`));
      let res;
      try {
        res = await api.edit({ instruction, selectedIds: ids, selected, neighbours, summary, scene });
      } catch (err) {
        stop();
        return fail(errorMessage(err));
      }
      const secs = stop();
      if (!res || !Array.isArray(res.ops)) return fail('The server returned an unexpected response. Nothing was changed.');
      if (ids.length) {
        const bad = outOfScope(scene, res.ops, ids, neighbours.map(n => n.id));
        if (bad.length) return fail(`The AI tried to change elements outside the selection (${bad.join(', ')}). Nothing was changed.`);
      }
      if (!res.ops.length) { setStatus('warn', res.summary ? `No changes: ${res.summary}` : 'The AI made no changes.'); return; }
      const label = 'AI: ' + (instruction.length > 60 ? instruction.slice(0, 57) + '...' : instruction);
      const r = store.commit(res.ops, { label, source: 'ai' });
      if (!r.ok) return fail(`The AI's change was invalid, so nothing was changed: ${formatErrors(r.errors)}`);
      if (draftKey === [...ids].sort().join(',')) ta.value = '';
      drafts.delete([...ids].sort().join(','));
      setStatus('ok', `${res.summary || 'Change applied.'} (${secs} s)`);
      ctx.status('ok', res.summary || 'AI change applied.');
    });
  }
  function fail(message) {
    setStatus('error', message);
    ctx.status('error', message);
  }

  applyBtn.addEventListener('click', apply);
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); apply(); }
    if (e.key === 'Escape') ta.blur();
  });
  collapseBtn.addEventListener('click', () => { collapsed = true; render(); pill.focus(); });
  minBtn.addEventListener('click', () => { minimised = !minimised; render(); if (!minimised) ta.focus(); });
  // Drag the popover by its title bar; the position holds until the selection changes.
  head.addEventListener('pointerdown', e => {
    if (mode !== 'selection' || e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, l: box.offsetLeft, t: box.offsetTop };
    head.setPointerCapture(e.pointerId);
    const move = ev => { manualPos = { l: start.l + ev.clientX - start.x, t: start.t + ev.clientY - start.y }; place(ctx.scene()); };
    const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); head.removeEventListener('pointercancel', up); };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
  });
  pill.addEventListener('click', () => { collapsed = false; render(); ta.focus(); });
  // Keep pointer events in the popover from reaching the map.
  box.addEventListener('pointerdown', e => e.stopPropagation());

  bus.on('busy', ({ busy }) => { applyBtn.disabled = busy; ta.readOnly = busy; });
  ctx.onRedraw.push(render);
  window.addEventListener('resize', render);
  render();
}

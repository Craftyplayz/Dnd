// "Describe the change" popover beside the selection, or a docked whole-map box when nothing is selected.
import { findElement, TYPES } from '../schema.js';
import { html, nextId, elapsed, icon } from './ui.js';
import { selectionBounds } from './overlay.js';
import { outOfScope, errorMessage, formatErrors } from './ops.js';

const trim1 = v => String(Math.round(v * 10) / 10);

export function initPopover(ctx) {
  const { store, view, bus, api, layout, state, dom } = ctx;
  const taId = nextId('describe');
  const title = html('strong', { class: 'bms-pop-title' });
  const sub = html('span', { class: 'bms-pop-sub' });
  const meta = html('div', { class: 'bms-pop-meta' });
  const ta = html('textarea', { id: taId, class: 'input', rows: 3, maxlength: 2000 });
  const applyBtn = html('button', { type: 'button', class: 'btn primary', text: 'Apply', title: 'Apply (Ctrl+Enter)' });
  const statusEl = html('div', { class: 'bms-pop-status', role: 'status', 'aria-live': 'polite' });
  const collapseBtn = html('button', { type: 'button', class: 'bms-icon-btn', 'aria-label': 'Hide the map change box', title: 'Hide' }, [icon('close')]);
  const box = html('div', { class: 'bms-popover card', role: 'region', 'aria-label': 'Describe a change' }, [
    html('div', { class: 'bms-pop-head' }, [html('div', {}, [title, sub]), collapseBtn]),
    meta,
    html('label', { for: taId, class: 'bms-label', text: 'Describe the change' }),
    ta,
    html('div', { class: 'bms-pop-actions' }, [html('span', { class: 'bms-hint', text: 'Ctrl+Enter' }), applyBtn]),
    statusEl,
  ]);
  const pill = html('button', { type: 'button', class: 'btn bms-map-pill', text: 'Describe a change to the whole map' });
  dom.map.append(box, pill);

  let mode = null, collapsed = false;
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
      if (!state.busy) setStatus('', '');
    }
    const hide = state.tool !== 'select' || state.dragging;
    box.classList.toggle('docked', mode === 'map');
    box.hidden = hide || (mode === 'map' && collapsed);
    pill.hidden = hide || mode !== 'map' || !collapsed;
    collapseBtn.hidden = mode !== 'map';
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

  // Beside the selection's screen rectangle, flipping left when there is no room.
  function place(scene) {
    const b = selectionBounds(scene, state.ids);
    if (!b) return;
    const mr = dom.map.getBoundingClientRect();
    const p1 = view.ftToScreen(b.minX, b.minY), p2 = view.ftToScreen(b.maxX, b.maxY);
    const r = { l: Math.min(p1.x, p2.x) - mr.left, t: Math.min(p1.y, p2.y) - mr.top, r: Math.max(p1.x, p2.x) - mr.left };
    // Keep clear of the overlay's name/size tag too.
    const tag = view.overlay.querySelector('.bms-tag')?.getBoundingClientRect();
    if (tag?.width) { r.l = Math.min(r.l, tag.left - mr.left); r.r = Math.max(r.r, tag.right - mr.left); }
    const w = box.offsetWidth || 320, hgt = box.offsetHeight || 220, pad = 12, gapPx = 18;
    let left = r.r + gapPx;
    if (left + w > mr.width - pad) left = r.l - gapPx - w;
    if (left < pad) left = Math.max(pad, mr.width - w - pad);
    const top = Math.max(pad, Math.min(r.t, mr.height - hgt - pad));
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
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
  pill.addEventListener('click', () => { collapsed = false; render(); ta.focus(); });
  // Keep pointer events in the popover from reaching the map.
  box.addEventListener('pointerdown', e => e.stopPropagation());

  bus.on('busy', ({ busy }) => { applyBtn.disabled = busy; ta.readOnly = busy; });
  ctx.onRedraw.push(render);
  window.addEventListener('resize', render);
  render();
}

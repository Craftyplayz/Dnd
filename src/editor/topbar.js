// #topbar: title, generate box, tools, undo/redo, save, logout.
import { html, nextId, elapsed, icon } from './ui.js';
import { errorMessage, formatErrors, layoutOrFallback, reportErrors } from './ops.js';

// Optional map size: blank, or an integer multiple of 5 in 20..600.
export function parseSize(v) {
  const s = String(v ?? '').trim();
  if (!s) return { ok: true, value: undefined };
  const n = Number(s);
  if (!Number.isInteger(n) || n < 20 || n > 600 || n % 5) return { ok: false };
  return { ok: true, value: n };
}

export function initTopbar(ctx) {
  const { store, bus, api, layout, dom, view } = ctx;
  const top = dom.topbar;
  const descId = nextId('gen'), wId = nextId('w'), hId = nextId('h');

  const desc = html('textarea', {
    id: descId, class: 'input bms-gen-desc', rows: 1, maxlength: 4000,
    placeholder: 'Describe a new map, e.g. a forest road ambush with an overturned wagon',
  });
  const wIn = html('input', { id: wId, class: 'input bms-num', type: 'number', min: 20, max: 600, step: 5, placeholder: 'auto', inputmode: 'numeric' });
  const hIn = html('input', { id: hId, class: 'input bms-num', type: 'number', min: 20, max: 600, step: 5, placeholder: 'auto', inputmode: 'numeric' });
  const genBtn = html('button', { type: 'submit', class: 'btn primary', text: 'Generate' });
  const timer = html('span', { class: 'bms-timer', role: 'status', 'aria-live': 'polite' });

  const form = html('form', { class: 'bms-gen', 'aria-label': 'Generate a new map' }, [
    html('label', { for: descId, class: 'sr-only', text: 'Map description' }), desc,
    html('label', { for: wId, class: 'bms-mini-label', text: 'W ft' }), wIn,
    html('label', { for: hId, class: 'bms-mini-label', text: 'H ft' }), hIn,
    genBtn, timer,
  ]);

  const toolBtn = (tool, label, ic, key) => html('button', {
    type: 'button', class: 'bms-tool', 'aria-pressed': tool === ctx.state.tool ? 'true' : 'false',
    title: `${label} (${key})`, 'aria-label': `${label} tool`, onclick: () => ctx.setTool(tool),
  }, [icon(ic), html('span', { text: label })]);
  const selBtn = toolBtn('select', 'Select', 'cursor', 'V');
  const meaBtn = toolBtn('measure', 'Measure', 'ruler', 'M');
  bus.on('tool:changed', ({ tool }) => {
    selBtn.setAttribute('aria-pressed', String(tool === 'select'));
    meaBtn.setAttribute('aria-pressed', String(tool === 'measure'));
  });

  const undoBtn = html('button', { type: 'button', class: 'bms-icon-btn', 'aria-label': 'Undo', title: 'Undo (Ctrl+Z)', onclick: () => store.undo() }, [icon('undo')]);
  const redoBtn = html('button', { type: 'button', class: 'bms-icon-btn', 'aria-label': 'Redo', title: 'Redo (Ctrl+Y)', onclick: () => store.redo() }, [icon('redo')]);
  const saveBtn = html('button', { type: 'button', class: 'btn', text: 'Save', title: 'Save to the scene library', onclick: () => ctx.saveScene?.() });
  const logoutBtn = html('button', {
    type: 'button', class: 'btn', text: 'Log out',
    onclick: async () => { try { await api.logout(); } catch { /* go to login anyway */ } location.assign('/login'); },
  });
  const syncHistory = () => {
    undoBtn.disabled = !store.canUndo();
    redoBtn.disabled = !store.canRedo();
    const h = store.history();
    undoBtn.title = h.past.length ? `Undo ${h.current} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
    redoBtn.title = h.future.length ? `Redo ${h.future[0]} (Ctrl+Y)` : 'Redo (Ctrl+Y)';
  };
  bus.on('scene:changed', syncHistory);
  syncHistory();

  top.append(
    html('h1', { class: 'bms-title', text: 'Battle Map Studio' }),
    form,
    html('div', { class: 'bms-tools', role: 'group', 'aria-label': 'Tools' }, [selBtn, meaBtn]),
    html('div', { class: 'bms-tools', role: 'group', 'aria-label': 'History' }, [undoBtn, redoBtn]),
    saveBtn, logoutBtn,
  );

  desc.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const description = desc.value.trim();
    if (!description) { ctx.status('warn', 'Describe the map you want first.'); desc.focus(); return; }
    const w = parseSize(wIn.value), hh = parseSize(hIn.value);
    if (!w.ok || !hh.ok) { ctx.status('error', 'Width and height must be whole multiples of 5 between 20 and 600 ft (or blank).'); return; }
    const req = { description };
    if (w.value) req.widthFt = w.value;
    if (hh.value) req.heightFt = hh.value;
    await ctx.runBusy('Generating map', async () => {
      form.classList.add('busy');
      const stop = elapsed(s => { timer.textContent = `Generating... ${s} s`; });
      try {
        const res = await api.generate(req);
        const secs = stop();
        // A paid generation is never lost: if layout fails, keep the server's (already validated) scene.
        let out = layoutOrFallback(res.scene, layout);
        let r = store.set(out.scene, { label: 'Generate', source: 'generate' });
        if (!r.ok && out.scene !== res.scene) {
          out = { ...out, scene: res.scene, report: null, error: `the laid-out map was rejected (${formatErrors(r.errors)})` };
          r = store.set(res.scene, { label: 'Generate', source: 'generate' });
        }
        if (!r.ok) { ctx.status('error', `The generated map was invalid: ${formatErrors(r.errors)}`); return; }
        ctx.select([]);
        view.fit();
        const name = store.get().meta.name;
        if (out.error) { ctx.status('warn', `Generated "${name}" in ${secs} s, but ${out.error}. The map is shown without layout fixes.`); return; }
        const issues = reportErrors(out.report);
        ctx.status(issues ? 'warn' : 'ok', `Generated "${name}" in ${secs} s${issues ? `, ${issues} layout issue(s): see Distances` : ''}.`);
      } catch (err) {
        stop();
        ctx.status('error', `Generate failed: ${errorMessage(err)}`);
      } finally {
        timer.textContent = '';
        form.classList.remove('busy');
      }
    });
  });

  bus.on('busy', ({ busy }) => { genBtn.disabled = busy; desc.readOnly = busy; });
}

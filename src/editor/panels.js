// #sidepanel: collapse toggle, Layers, Distances, Properties, Usage, Scenes.
import { SCHEMA, TYPES, VIEW_LAYERS, findElement, slugify } from '../schema.js';
import { downloadSceneJson, pickSceneJson } from '../storage/file.js';
import { html, nextId, icon } from './ui.js';
import { fieldOps, errorMessage, formatErrors, layoutOrFallback, reportErrors } from './ops.js';

const LAYER_NAMES = { terrain: 'Terrain', ground: 'Ground', low: 'Low features', objects: 'Objects', canopy: 'Tree canopy', labels: 'Labels', grid: 'Grid', lighting: 'Lighting' };
const resolve = s => (s?.$ref ? s.$ref.slice(2).split('/').reduce((o, k) => o[k], SCHEMA) : s || {});
const panel = (title, ...children) => html('section', { class: 'panel card', 'aria-label': title }, [html('h2', { text: title }), ...children]);

export function initPanels(ctx) {
  const { dom } = ctx;
  const side = dom.sidepanel;
  const toggle = html('button', { type: 'button', class: 'bms-icon-btn panel-toggle', 'aria-expanded': 'true', 'aria-controls': side.id || null, 'aria-label': 'Collapse side panel', title: 'Collapse side panel' }, [icon('chevronRight')]);
  toggle.addEventListener('click', () => {
    const collapsed = side.classList.toggle('collapsed');
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Expand side panel' : 'Collapse side panel');
    toggle.title = toggle.getAttribute('aria-label');
    toggle.replaceChildren(icon(collapsed ? 'chevronLeft' : 'chevronRight'));
  });
  side.append(toggle, layersPanel(ctx), propertiesPanel(ctx), distancesPanel(ctx), usagePanel(ctx), scenesPanel(ctx));
}

// ---------- Layers ----------
function layersPanel({ view, bus }) {
  const vis = view.getLayerVisibility() || {};
  const list = html('div', { class: 'bms-layers' });
  for (const name of VIEW_LAYERS) {
    const id = nextId(`layer-${name}`);
    const cb = html('input', { type: 'checkbox', id, checked: vis[name] !== false });
    cb.addEventListener('change', () => {
      view.setLayerVisibility(name, cb.checked);
      bus.emit('layers:changed', { visible: { ...view.getLayerVisibility() } });
    });
    list.append(html('div', { class: 'bms-check' }, [cb, html('label', { for: id, text: LAYER_NAMES[name] || name })]));
  }
  return panel('Layers', list);
}

// ---------- Distances (layout report) ----------
function distancesPanel(ctx) {
  const head = html('p', { class: 'bms-dim', text: 'No report yet.' });
  const list = html('ul', { class: 'bms-report' });
  const order = { error: 0, warn: 1, ok: 2 };
  const fixBtn = html('button', { type: 'button', class: 'btn small', text: 'Fix layout', disabled: true, title: 'Move elements to satisfy stated distances and remove collisions' });
  fixBtn.addEventListener('click', () => {
    const before = reportErrors(lastReport);
    const lo = layoutOrFallback(ctx.store.get(), ctx.layout);
    if (lo.error) { ctx.status('error', `Fix layout failed: ${lo.error}.`); return; }
    const r = ctx.store.set(lo.scene, { label: 'Fix layout', source: 'layout' });
    if (!r.ok) { ctx.status('error', `Fix layout failed: ${formatErrors(r.errors)}`); return; }
    const after = reportErrors(lo.report), moved = lo.report?.moved?.length ?? 0;
    ctx.status(after ? 'warn' : 'ok', `Fix layout moved ${moved} element${moved === 1 ? '' : 's'}; ${before - after} of ${before} errors fixed${after ? `, ${after} remain` : ''}.`);
  });
  let lastReport = null;
  ctx.bus.on('report:updated', ({ report }) => {
    lastReport = report;
    fixBtn.disabled = !reportErrors(report);
    const items = [...(report?.items || [])].sort((a, b) => order[a.level] - order[b.level]);
    const n = l => items.filter(i => i.level === l).length;
    const s = report?.stats;
    const lanes = s?.lanes ? `, lanes W-E ${s.lanes.westEast ? 'open' : 'blocked'}, N-S ${s.lanes.northSouth ? 'open' : 'blocked'}` : '';
    const pl = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
    head.textContent = `${pl(n('error'), 'error')}, ${pl(n('warn'), 'warning')}${s ? `. Cover ${Math.round(s.coverPct)}%${lanes}` : ''}.`;
    list.replaceChildren(...items.map(item => {
      const ids = item.ids || [];
      const btn = html('button', { type: 'button', class: `bms-report-item ${item.level}`, disabled: !ids.length },
        [html('span', { class: 'bms-dot', 'aria-hidden': 'true' }), html('span', { class: 'sr-only', text: `${item.level}: ` }), html('span', { text: item.message })]);
      btn.title = ids.length ? `Select ${ids.join(', ')}` : '';
      btn.addEventListener('click', () => ctx.select(ids));
      return html('li', {}, [btn]);
    }));
  });
  return panel('Distances', html('div', { class: 'bms-report-head' }, [head, fixBtn]), list);
}

// ---------- Properties ----------
function makeField(label, schema, value, onCommit, { readonly = false } = {}) {
  schema = resolve(schema);
  const id = nextId('prop');
  let input, get, set;
  if (readonly) {
    input = html('output', { id, class: 'bms-ro' });
    set = v => { input.textContent = v; };
  } else if (schema.enum) {
    input = html('select', { id, class: 'input' }, schema.enum.map(v => html('option', { value: v, text: String(v) })));
    get = () => input.value; set = v => { input.value = v ?? ''; };
  } else if (schema.type === 'boolean') {
    input = html('input', { id, type: 'checkbox' });
    get = () => input.checked; set = v => { input.checked = !!v; };
  } else if (schema.type === 'number' || schema.type === 'integer') {
    input = html('input', { id, class: 'input', type: 'number', step: schema.type === 'integer' ? 1 : 'any', min: schema.minimum, max: schema.maximum });
    get = () => (input.value.trim() === '' ? NaN : Number(input.value));
    set = v => { input.value = v === undefined ? '' : String(Math.round(v * 100) / 100); };
  } else if (schema.pattern === '^#[0-9a-fA-F]{6}$') {
    input = html('input', { id, type: 'color', class: 'bms-color' });
    get = () => input.value; set = v => { input.value = v || '#000000'; };
  } else {
    input = html(schema.maxLength > 100 ? 'textarea' : 'input', { id, class: 'input', type: 'text', maxlength: schema.maxLength, rows: 2 });
    get = () => input.value; set = v => { input.value = v ?? ''; };
  }
  set(value);
  let current = value;
  if (!readonly) {
    input.addEventListener('change', () => {
      const v = get();
      if (typeof v === 'number' && !Number.isFinite(v)) { set(current); return; }
      if (schema.type === 'integer' && !Number.isInteger(v)) { set(current); return; }
      if (!onCommit(v)) set(current);
    });
  }
  const row = html('div', { class: `bms-field${schema.type === 'boolean' && !readonly ? ' check' : ''}` }, [html('label', { for: id, text: label }), input]);
  return { row, update(v) { current = v; if (document.activeElement !== input) set(v); } };
}

function propertiesPanel(ctx) {
  const { store, bus, state } = ctx;
  const body = html('div', { class: 'bms-props' });
  let key = null, fields = [];

  const commitEl = (id, field, label) => v => {
    const el = findElement(store.get(), id)?.el;
    if (!el) return false;
    return ctx.commit(fieldOps(el, field, v), label).ok;
  };
  const commitMap = (path, label) => v => ctx.commit([{ op: 'add', path, value: v }], label).ok;

  function specs(scene) {
    if (state.ids.length > 1) return null;
    if (!state.ids.length) {
      const d = SCHEMA.$defs;
      return { key: 'map', title: 'Map', list: [
        ['Name', d.meta.properties.name, scene.meta.name, commitMap('/meta/name', 'Rename map')],
        ['Width ft', { ...d.grid.properties.widthFt, type: 'integer' }, scene.grid.widthFt, commitMap('/grid/widthFt', 'Map width')],
        ['Height ft', { ...d.grid.properties.heightFt, type: 'integer' }, scene.grid.heightFt, commitMap('/grid/heightFt', 'Map height')],
        ['Show grid', d.grid.properties.visible, scene.grid.visible, commitMap('/grid/visible', 'Grid')],
        ['Terrain', d.terrain.properties.base, scene.terrain.base, commitMap('/terrain/base', 'Terrain')],
        ['Time of day', d.lighting.properties.time, scene.lighting.time, commitMap('/lighting/time', 'Lighting')],
        ['Light from (deg)', d.lighting.properties.azimuth, scene.lighting.azimuth, commitMap('/lighting/azimuth', 'Light direction')],
        ['Light strength', d.lighting.properties.intensity, scene.lighting.intensity, commitMap('/lighting/intensity', 'Light strength')],
      ] };
    }
    const el = findElement(scene, state.ids[0])?.el;
    if (!el) return null;
    const def = TYPES[el.type] || {};
    const c = (f, l) => commitEl(el.id, f, l);
    const num = (min, max) => ({ type: 'number', minimum: min, maximum: max });
    const sized = def.kind === 'object';
    const list = [
      ['Name', { type: 'string', minLength: 1, maxLength: 80 }, el.name, c('name', 'Rename')],
      ['Type', {}, el.type, null, true],
      ['Layer', { enum: def.layers || [el.layer] }, el.layer, c('layer', 'Change layer'), (def.layers || []).length < 2],
      ['X ft', num(0, scene.grid.widthFt), el.position.x, c('position/x', 'Move')],
      ['Y ft', num(0, scene.grid.heightFt), el.position.y, c('position/y', 'Move')],
      ['Width ft', num(0.1, 2000), el.size.w, c('size/w', 'Resize'), !sized],
      ['Height ft', num(0.1, 2000), el.size.h, c('size/h', 'Resize'), !sized],
      ['Rotation deg', num(-360, 360), el.rotation, c('rotation', 'Rotate')],
      ['Locked', { type: 'boolean' }, !!el.locked, c('locked', el.locked ? 'Unlock' : 'Lock')],
    ];
    for (const [k, s] of Object.entries(def.params?.properties || {})) {
      if (k === 'points') { list.push(['Points', {}, `${el.params.points.length} points`, null, true]); continue; }
      list.push([k.replace(/([A-Z])/g, ' $1').replace(/^./, m => m.toUpperCase()), s, el.params[k], c(`params/${k}`, `Change ${k}`)]);
    }
    list.push(['Notes', { type: 'string', maxLength: 500 }, el.notes || '', c('notes', 'Notes')]);
    return { key: `${el.id}:${el.type}`, title: el.name, list };
  }

  function render() {
    const scene = store.get();
    const sp = specs(scene);
    if (!sp) {
      key = null; fields = [];
      body.replaceChildren(html('p', { class: 'bms-dim', text: `${state.ids.length} elements selected. Select one element to edit its properties.` }));
      return;
    }
    if (sp.key === key && fields.length === sp.list.length) {
      sp.list.forEach(([, , v], i) => fields[i].update(v));
      return;
    }
    key = sp.key;
    fields = sp.list.map(([label, schema, value, commit, ro]) => makeField(label, schema, value, commit, { readonly: ro || !commit }));
    body.replaceChildren(...fields.map(f => f.row));
  }
  bus.on('selection:changed', render);
  bus.on('scene:changed', render);
  render();
  return panel('Properties', body);
}

// ---------- Usage ----------
function usagePanel({ bus, api }) {
  const text = html('p', { class: 'bms-dim', text: 'No usage data yet.' });
  const meter = html('div', { class: 'bms-meter', role: 'meter', 'aria-label': 'Requests used today', 'aria-valuemin': '0' }, [html('span')]);
  const cost = html('p', { class: 'bms-usage-cost' });
  const show = u => {
    if (!u) return;
    const pct = u.cap ? Math.min(100, (u.requests / u.cap) * 100) : 0;
    text.textContent = `${u.requests} / ${u.cap} requests today (${u.remaining} left)`;
    meter.setAttribute('aria-valuemax', String(u.cap));
    meter.setAttribute('aria-valuenow', String(u.requests));
    meter.classList.toggle('high', pct >= 80);
    meter.firstChild.style.width = `${pct}%`;
    cost.textContent = `Estimated cost today: $${Number(u.costUsd || 0).toFixed(2)}${u.model ? ` (${u.model})` : ''}`;
  };
  bus.on('usage:updated', ({ usage }) => show(usage));
  Promise.resolve().then(() => api.usage?.()).then(u => show(u?.usage || u)).catch(() => { /* shown once a request reports usage */ });
  return panel('Usage', text, meter, cost);
}

// ---------- Scenes ----------
function scenesPanel(ctx) {
  const { store, bus, api, view } = ctx;
  const list = html('ul', { class: 'bms-scenes' });
  let scenes = [];
  // The store state at the last open/load/save; anything else counts as unsaved changes.
  let savedRef = store.get(), last = store.get();
  const dirty = () => store.get() !== savedRef;
  const okToDiscard = () => !dirty() || confirm(`Discard unsaved changes to "${store.get().meta.name}"?`);

  async function refresh() {
    try {
      const res = await api.listScenes();
      scenes = res?.scenes || [];
      renderList();
    } catch (err) {
      list.replaceChildren(html('li', { class: 'bms-dim', text: `Could not load scenes: ${errorMessage(err)}` }));
    }
  }
  function renderList() {
    const cur = store.get().meta.id;
    if (!scenes.length) { list.replaceChildren(html('li', { class: 'bms-dim', text: 'No saved scenes yet.' })); return; }
    list.replaceChildren(...scenes.map(s => html('li', { class: `bms-scene${s.id === cur ? ' current' : ''}` }, [
      html('div', { class: 'bms-scene-info' }, [
        html('span', { class: 'bms-scene-name', text: s.name || s.id }),
        html('span', { class: 'bms-dim', text: `${s.widthFt} x ${s.heightFt} ft${s.updatedAt ? ', ' + new Date(s.updatedAt).toLocaleString() : ''}` }),
      ]),
      html('button', { type: 'button', class: 'btn small', text: 'Open', 'aria-label': `Open ${s.name || s.id}`, onclick: () => open(s) }),
      html('button', { type: 'button', class: 'btn small danger', text: 'Delete', 'aria-label': `Delete ${s.name || s.id}`, onclick: () => remove(s) }),
    ])));
  }
  async function open(s) {
    if (!okToDiscard()) return;
    try {
      const res = await api.getScene(s.id);
      const r = store.reset(res.scene, { label: 'Open' });
      if (!r.ok) { ctx.status('error', `"${s.name}" is not a valid scene: ${formatErrors(r.errors)}`); return; }
      savedRef = store.get();
      ctx.select([]);
      view.fit();
      renderList();
      ctx.status('ok', `Opened "${store.get().meta.name}".`);
    } catch (err) { ctx.status('error', `Could not open "${s.name}": ${errorMessage(err)}`); }
  }
  async function remove(s) {
    if (!confirm(`Delete "${s.name || s.id}" from the library? This cannot be undone.`)) return;
    try { await api.deleteScene(s.id); ctx.status('ok', `Deleted "${s.name || s.id}".`); } catch (err) { ctx.status('error', `Delete failed: ${errorMessage(err)}`); }
    refresh();
  }

  // Meta changes for saving must not add undo history.
  const setMeta = partial => {
    const r = store.setMeta(partial);
    if (!r.ok) ctx.status('error', `Save failed: ${formatErrors(r.errors)}`);
    return r.ok;
  };
  // Save (name = undefined) or Save as (new name -> new id).
  async function save(name) {
    let scene = store.get();
    if (name !== undefined) {
      const id = slugify(name);
      if (id !== scene.meta.id && scenes.some(s => s.id === id) && !confirm(`A scene with id "${id}" exists. Overwrite it?`)) return;
      if (!setMeta({ name, id })) return;
    } else if (!scene.meta.id) {
      if (!setMeta({ id: slugify(scene.meta.name) })) return;
    }
    scene = store.get();
    try {
      const res = await api.saveScene(scene.meta.id, scene);
      savedRef = store.get();
      if (res?.updatedAt) store.setMeta({ updatedAt: res.updatedAt });
      bus.emit('scene:saved', { id: res?.id ?? scene.meta.id, updatedAt: res?.updatedAt });
      ctx.status('ok', `Saved "${scene.meta.name}".`);
      refresh();
    } catch (err) { ctx.status('error', `Save failed: ${errorMessage(err)}`); }
  }
  ctx.saveScene = () => save();

  const asId = nextId('saveas');
  const asInput = html('input', { id: asId, class: 'input', type: 'text', maxlength: 80, placeholder: 'New scene name' });
  const asForm = html('form', { class: 'bms-saveas', hidden: true }, [
    html('label', { for: asId, class: 'sr-only', text: 'New scene name' }), asInput,
    html('button', { type: 'submit', class: 'btn small primary', text: 'Save' }),
    html('button', { type: 'button', class: 'btn small', text: 'Cancel', onclick: () => { asForm.hidden = true; } }),
  ]);
  asForm.addEventListener('submit', e => {
    e.preventDefault();
    const name = asInput.value.trim();
    if (!name) { asInput.focus(); return; }
    asForm.hidden = true;
    save(name);
  });

  const actions = html('div', { class: 'bms-actions' }, [
    html('button', { type: 'button', class: 'btn small', text: 'Save', onclick: () => save() }),
    html('button', { type: 'button', class: 'btn small', text: 'Save as', onclick: () => { asForm.hidden = false; asInput.value = store.get().meta.name; asInput.select(); asInput.focus(); } }),
    html('button', { type: 'button', class: 'btn small', text: 'Download JSON', onclick: () => downloadSceneJson(store.get()) }),
    html('button', { type: 'button', class: 'btn small', text: 'Upload JSON', onclick: upload }),
    html('button', { type: 'button', class: 'btn small', text: 'Refresh', onclick: refresh }),
  ]);
  async function upload() {
    let scene;
    try { scene = await pickSceneJson(); } catch (err) { if (err?.name !== 'AbortError') ctx.status('error', `Upload failed: ${errorMessage(err)}`); return; }
    if (!scene || !okToDiscard()) return;
    const r = store.reset(scene, { label: 'Open file' });
    if (!r.ok) { ctx.status('error', `Not a valid scene: ${formatErrors(r.errors)}`); return; }
    savedRef = store.get();
    ctx.select([]);
    view.fit();
    ctx.status('ok', `Loaded "${store.get().meta.name}" from file. Save it to keep it in the library.`);
  }
  bus.on('scene:changed', ({ scene, source }) => {
    if (source === 'meta' && last === savedRef) savedRef = scene; // meta-only updates keep a clean scene clean
    last = scene;
    if (source === 'reset' || source === 'meta') renderList();
  });
  bus.on('scenes:refresh', refresh);
  refresh();
  return panel('Scenes', actions, asForm, list);
}

// App entry: wires store, renderer, editor, export, storage and layout (docs/CONTRACT.md section 14).
import { createBus } from './core/bus.js';
import { createStore } from './core/store.js';
import { checkScene } from './schema.js';
import { mountView } from './render/index.js';
import { initEditor } from './editor/index.js';
import { initExportBar } from './export/index.js';
import { createApi } from './storage/api.js';
import { saveDraft, loadDraft } from './storage/draft.js';
import * as layout from './layout/index.js';
import ambush from '../samples/forest-road-ambush.json' with { type: 'json' };
import ruin from '../samples/riverside-ruin.json' with { type: 'json' };

const $ = id => document.getElementById(id);
const bus = createBus();
const api = createApi(bus);

const draft = loadDraft();
const store = createStore(draft || ambush, bus);
const view = mountView($('map'), bus);

const refresh = scene => {
  view.setScene(scene);
  bus.emit('report:updated', { report: layout.checkScene(scene) });
};

bus.on('scene:changed', ({ scene }) => {
  refresh(scene);
  saveDraft(scene);
});

initEditor({ store, view, bus, api, layout, dom: { topbar: $('topbar'), map: $('map'), sidepanel: $('sidepanel'), toasts: $('toasts') } });
initExportBar($('exportbar'), { store, view, bus });

refresh(store.get());
view.fit();

// First run: put the two samples in the server library so there is something to open.
(async () => {
  try {
    await api.usage();
    const { scenes } = await api.listScenes();
    if (!scenes.length && !draft) {
      for (const s of [ambush, ruin]) await api.saveScene(s.meta.id, checkScene(s).scene);
      bus.emit('scenes:refresh', {});
    }
  } catch (e) {
    if (e?.status !== 401) bus.emit('status', { level: 'warn', message: `Could not reach the server: ${e.message}` });
  }
})();

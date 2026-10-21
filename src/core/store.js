// The scene store: the only place the working scene changes. Every change is validated on a
// copy before it is committed, and every commit is one undo step. Snapshot history, no cap.
import { checkScene } from '../schema.js';
import { applyPatch } from './patch.js';

export function createStore(initialScene, bus) {
  const first = checkScene(initialScene);
  if (!first.ok) throw new Error(`initial scene invalid: ${first.errors[0].path} ${first.errors[0].message}`);
  let past = [], future = [];
  let current = { scene: first.scene, label: 'open' };

  const emit = (source, label, ops) => bus?.emit('scene:changed', { scene: current.scene, source, label, ops: ops || null });

  // Validate candidate and make it current. Returns { ok, errors }.
  function push(candidate, label, source, ops) {
    const res = checkScene(candidate);
    if (!res.ok) return { ok: false, errors: res.errors };
    past.push(current);
    future = [];
    current = { scene: res.scene, label };
    emit(source, label, ops);
    return { ok: true, errors: [] };
  }

  return {
    get: () => current.scene, // treat as immutable; change it only through commit/set
    // Apply patch ops as one undo step.
    commit(ops, { label = 'edit', source = 'edit' } = {}) {
      let next;
      try { next = applyPatch(current.scene, ops); } catch (e) { return { ok: false, errors: [{ path: '/', message: e.message }] }; }
      return push(next, label, source, ops);
    },
    // Replace the whole scene as one undo step (generate, whole-map rewrite, layout fix).
    set(scene, { label = 'replace', source = 'set' } = {}) {
      return push(scene, label, source, null);
    },
    // Replace the scene and clear history (open from library or file).
    reset(scene, { label = 'open' } = {}) {
      const res = checkScene(scene);
      if (!res.ok) return { ok: false, errors: res.errors };
      past = []; future = [];
      current = { scene: res.scene, label };
      emit('reset', label, null);
      return { ok: true, errors: [] };
    },
    // Merge fields into meta without an undo step (library id and timestamps after a save).
    // Applied to every history entry too, so undo never resurrects the old id.
    setMeta(partial) {
      const res = checkScene({ ...current.scene, meta: { ...current.scene.meta, ...partial } });
      if (!res.ok) return { ok: false, errors: res.errors };
      current = { ...current, scene: res.scene };
      const merge = h => ({ ...h, scene: { ...h.scene, meta: { ...h.scene.meta, ...partial } } });
      past = past.map(merge); future = future.map(merge);
      emit('meta', 'meta', null);
      return { ok: true, errors: [] };
    },
    undo() {
      if (!past.length) return false;
      future.push(current);
      current = past.pop();
      emit('undo', current.label, null);
      return true;
    },
    redo() {
      if (!future.length) return false;
      past.push(current);
      current = future.pop();
      emit('redo', current.label, null);
      return true;
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    history: () => ({ past: past.map(h => h.label), current: current.label, future: future.map(h => h.label).reverse() }),
  };
}

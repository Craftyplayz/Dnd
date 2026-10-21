// The unsaved working draft in localStorage (docs/CONTRACT.md section 11).
// Every access is guarded: private mode, quota or blocked storage must never break the app.
import { checkScene } from '../schema.js';

export const DRAFT_KEY = 'bms:draft:v1';

const storage = () => globalThis.localStorage;

export function saveDraft(scene) {
  try {
    storage().setItem(DRAFT_KEY, JSON.stringify(scene));
  } catch { /* quota or storage disabled: the draft is best effort */ }
}

// -> normalised scene, or null when there is no draft or it is no longer a valid scene.
export function loadDraft() {
  try {
    const text = storage().getItem(DRAFT_KEY);
    if (!text) return null;
    const res = checkScene(JSON.parse(text));
    return res.ok ? res.scene : null;
  } catch {
    return null;
  }
}

export function clearDraft() {
  try {
    storage().removeItem(DRAFT_KEY);
  } catch { /* nothing to clear */ }
}

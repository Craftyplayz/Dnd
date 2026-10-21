// Scene JSON download/upload and generic blob download (docs/CONTRACT.md section 11).
import { checkScene, slugify } from '../schema.js';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export function downloadBlob(blob, filename, doc = document) {
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);  // revoking at once can cancel the download in Firefox
}

export function downloadSceneJson(scene, doc = document) {
  const blob = new Blob([JSON.stringify(scene, null, 2) + '\n'], { type: 'application/json' });
  downloadBlob(blob, `${slugify(scene.meta?.name ?? '')}.json`, doc);
}

// Text of a scene file -> normalised scene. Throws Error with a readable message.
export function parseSceneJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Not a JSON file: ${e.message}`);
  }
  const res = checkScene(data);
  if (!res.ok) {
    const shown = res.errors.slice(0, 5).map(e => `${e.path} ${e.message}`).join('; ');
    const more = res.errors.length > 5 ? ` (and ${res.errors.length - 5} more)` : '';
    throw new Error(`Not a valid scene: ${shown}${more}`);
  }
  return res.scene;
}

// Opens the file picker. Resolves with a normalised scene; rejects with a readable Error
// (name 'AbortError' when the user cancels).
export function pickSceneJson(doc = document) {
  return new Promise((resolve, reject) => {
    const input = doc.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('cancel', () => {
      const err = new Error('No file selected');
      err.name = 'AbortError';
      reject(err);
    });
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      try {
        if (!file) throw Object.assign(new Error('No file selected'), { name: 'AbortError' });
        if (file.size > MAX_UPLOAD_BYTES) throw new Error(`File is too large (${Math.round(file.size / 1024)} KiB, max 5 MiB)`);
        resolve(parseSceneJson(await file.text()));
      } catch (e) {
        reject(e);
      }
    });
    input.click();
  });
}

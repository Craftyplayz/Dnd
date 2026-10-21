// PNG export (docs/CONTRACT.md section 10): bottom bar with four buttons, and exportPng().
import { renderScene } from '../render/index.js';
import { downloadBlob } from '../storage/file.js';
import { CONFIRM_MEGAPIXELS, MODES, exportArea, exportFilename, needsTiles, planTiles, tileViewBox } from './plan.js';
import { createPngWriter } from './png.js';

const ALL_LAYERS = { terrain: true, ground: true, low: true, objects: true, canopy: true, labels: true, grid: true, lighting: true };

const cancelled = () => Object.assign(new Error('Export cancelled'), { name: 'AbortError' });
const fmtVb = vb => `${vb.x} ${vb.y} ${vb.w} ${vb.h}`;

// Points the shared <svg> at one viewBox / pixel size and rasterises it into `canvas`.
async function rasterise(svg, viewBox, w, h, canvas) {
  svg.setAttribute('viewBox', fmtVb(viewBox));
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  svg.setAttribute('preserveAspectRatio', 'none');  // tile aspect is exact; avoid sub-pixel letterboxing
  const text = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      throw new Error('the map SVG could not be rasterised');
    }
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return ctx;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const toBlob = canvas => new Promise((resolve, reject) =>
  canvas.toBlob(b => (b ? resolve(b) : reject(new Error('the browser could not encode the PNG'))), 'image/png'));

// -> Promise<{ blob, filename, widthPx, heightPx }>. opts.onProgress(fraction 0..1, label) is optional.
export async function exportPng(scene, mode, { view, onProgress = () => {}, confirm = q => globalThis.confirm(q), doc = globalThis.document } = {}) {
  const viewport = mode === 'screen' ? view?.getViewport?.() : null;
  const area = exportArea(scene, mode, viewport, globalThis.devicePixelRatio || 1);
  const { widthPx: W, heightPx: H } = area;
  const mp = (W * H) / 1e6;
  if (mp > CONFIRM_MEGAPIXELS && !confirm(`This export is ${W} x ${H} px (${Math.round(mp)} megapixels). It may take minutes and a lot of memory. Continue?`)) throw cancelled();

  onProgress(0, 'Rendering');
  const svg = renderScene(scene, { doc, layers: { ...ALL_LAYERS, grid: area.grid }, grid: area.grid, viewBox: area.viewBox, widthPx: W, heightPx: H, interactive: false });
  const canvas = doc.createElement('canvas');
  let blob;
  if (!needsTiles(W, H)) {
    await rasterise(svg, area.viewBox, W, H, canvas);
    onProgress(0.6, 'Encoding');
    blob = await toBlob(canvas);
  } else {
    const bands = planTiles(W, H);
    const total = bands.reduce((n, b) => n + b.tiles.length, 0);
    const png = createPngWriter(W, H);
    let done = 0;
    for (const band of bands) {
      const rows = new Uint8Array(W * band.h * 4);
      for (const tile of band.tiles) {
        onProgress(done / total, `Tile ${done + 1} of ${total}`);
        const ctx = await rasterise(svg, tileViewBox(area, tile), tile.w, tile.h, canvas);
        const px = ctx.getImageData(0, 0, tile.w, tile.h).data;
        for (let r = 0; r < tile.h; r++) rows.set(px.subarray(r * tile.w * 4, (r + 1) * tile.w * 4), (r * W + tile.x) * 4);
        done++;
      }
      await png.writeRows(rows, band.h);
    }
    onProgress(1, 'Finishing');
    blob = await png.finish();
    canvas.width = canvas.height = 0;  // release the tile backing store now
  }
  onProgress(1, 'Done');
  return { blob, filename: exportFilename(scene, area), widthPx: W, heightPx: H };
}

export function initExportBar(container, { store, view, bus }) {
  container.classList.add('export-bar');
  container.setAttribute('aria-label', 'Export');
  const buttons = Object.entries(MODES).map(([mode, m]) => {
    const b = doc(container).createElement('button');
    b.type = 'button';
    b.className = 'btn export-btn';
    b.dataset.mode = mode;
    b.textContent = m.label;
    b.title = m.hint;
    b.addEventListener('click', () => run(mode));
    return b;
  });
  const status = doc(container).createElement('div');
  status.className = 'export-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const progress = doc(container).createElement('progress');
  progress.className = 'export-progress';
  progress.max = 1;
  progress.value = 0;
  const text = doc(container).createElement('span');
  text.className = 'export-text';
  status.append(progress, text);
  status.hidden = true;
  container.append(...buttons, status);

  // Size hints are computed when the user reaches for the bar, so they always match the scene and view.
  const updateHints = () => {
    for (const b of buttons) {
      try {
        const a = exportArea(store.get(), b.dataset.mode, b.dataset.mode === 'screen' ? view?.getViewport?.() : null, globalThis.devicePixelRatio || 1);
        b.title = `${MODES[b.dataset.mode].hint}: ${a.widthPx} x ${a.heightPx} px (${a.squaresW} x ${a.squaresH} squares)`;
      } catch { b.title = MODES[b.dataset.mode].hint; }
    }
  };
  container.addEventListener('pointerenter', updateHints);
  container.addEventListener('focusin', updateHints);

  let busy = false;
  async function run(mode) {
    if (busy) return;
    busy = true;
    const label = `Exporting ${MODES[mode].label}`;
    for (const b of buttons) b.disabled = true;
    container.setAttribute('aria-busy', 'true');
    status.hidden = false;
    progress.value = 0;
    text.textContent = label;
    bus?.emit('busy', { busy: true, label });
    try {
      const res = await exportPng(store.get(), mode, {
        view,
        onProgress: (f, step) => { progress.value = f; text.textContent = `${label}: ${step}`; },
      });
      downloadBlob(res.blob, res.filename, doc(container));
      bus?.emit('status', { level: 'ok', message: `Exported ${res.filename} (${res.widthPx} x ${res.heightPx} px)` });
    } catch (e) {
      if (e?.name === 'AbortError') bus?.emit('status', { level: 'info', message: 'Export cancelled' });
      else {
        console.error('export failed', e);
        bus?.emit('status', { level: 'error', message: `Export failed: ${e?.message || e}` });
      }
    } finally {
      busy = false;
      for (const b of buttons) b.disabled = false;
      container.removeAttribute('aria-busy');
      status.hidden = true;
      bus?.emit('busy', { busy: false, label });
    }
  }

  return { run };
}

const doc = el => el.ownerDocument || globalThis.document;

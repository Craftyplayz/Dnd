// node --test tests/export.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { exportArea, exportFilename, needsTiles, planTiles, tileViewBox, TILE_W, TILE_H } from '../src/export/plan.js';
import { crc32, createPngWriter } from '../src/export/png.js';

const sample = name => JSON.parse(readFileSync(new URL(`../samples/${name}.json`, import.meta.url), 'utf8'));
const forest = sample('forest-road-ambush');   // 150 x 100 ft
const river = sample('riverside-ruin');        // 120 x 120 ft

test('full-map sizes are squares x px per square', () => {
  const vtt = exportArea(forest, 'vtt');
  assert.deepEqual([vtt.widthPx, vtt.heightPx, vtt.squaresW, vtt.squaresH], [30 * 140, 20 * 140, 30, 20]);
  const print = exportArea(forest, 'print');
  assert.deepEqual([print.widthPx, print.heightPx], [9000, 6000]);
  assert.equal(needsTiles(print.widthPx, print.heightPx), true);
  assert.equal(needsTiles(vtt.widthPx, vtt.heightPx), false);
  const nogrid = exportArea(river, 'nogrid');
  assert.deepEqual([nogrid.widthPx, nogrid.heightPx, nogrid.grid], [3360, 3360, false]);
  assert.equal(exportArea(river, 'vtt').grid, true);
  assert.equal(exportArea({ ...river, grid: { ...river.grid, visible: false } }, 'print').grid, false);
});

test('screen mode rounds the visible area to whole squares, clipped to the map', () => {
  const a = exportArea(forest, 'screen', { x: 12.4, y: -20, w: 51.3, h: 300, zoom: 8 }, 2);
  assert.deepEqual(a.viewBox, { x: 10, y: 0, w: 55, h: 100 });
  assert.deepEqual([a.squaresW, a.squaresH, a.pxPerFt, a.widthPx, a.heightPx], [11, 20, 16, 880, 1600]);
  const tiny = exportArea(forest, 'screen', { x: 149, y: 99, w: 1, h: 1, zoom: 100 }, 1);
  assert.deepEqual(tiny.viewBox, { x: 145, y: 95, w: 5, h: 5 });
  assert.throws(() => exportArea(forest, 'screen', null));
  assert.throws(() => exportArea(forest, 'bogus'));
});

test('filename rule', () => {
  assert.equal(exportFilename(forest, exportArea(forest, 'vtt')), 'forest-road-ambush_30x20.png');
  assert.equal(exportFilename({ ...forest, meta: { ...forest.meta, name: 'Ruined Watchtower!' } }, { squaresW: 30, squaresH: 24 }), 'ruined-watchtower_30x24.png');
});

test('tile plan covers every pixel exactly once and no tile exceeds 4096', () => {
  const W = 9000, H = 6000, area = exportArea(forest, 'print');
  const bands = planTiles(W, H);
  let covered = 0, y = 0;
  for (const band of bands) {
    assert.equal(band.y, y);
    let x = 0;
    for (const t of band.tiles) {
      assert.ok(t.w <= TILE_W && t.h <= TILE_H && t.w <= 4096 && t.h <= 4096);
      assert.equal(t.x, x);
      x += t.w;
      covered += t.w * t.h;
      const vb = tileViewBox(area, t);
      assert.ok(Math.abs(vb.w * 60 - t.w) < 1e-6 && Math.abs(vb.h * 60 - t.h) < 1e-6);
    }
    assert.equal(x, W);
    y += band.h;
  }
  assert.equal(y, H);
  assert.equal(covered, W * H);
  const last = bands.at(-1).tiles.at(-1), vb = tileViewBox(area, last);
  assert.equal(vb.x + vb.w, 150);
  assert.equal(vb.y + vb.h, 100);
});

test('crc32 matches zlib', () => {
  const data = new TextEncoder().encode('IEND battle map studio');
  assert.equal(crc32(data), zlib.crc32(data));
  assert.equal(crc32(new Uint8Array(0)), 0);
});

// Minimal PNG decoder for RGBA8 Sub-filtered output: checks structure and every CRC.
function decodePng(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  let off = 8, ihdr = null;
  const idat = [], types = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('latin1', off + 4, off + 8);
    const body = buf.subarray(off + 4, off + 8 + len);
    assert.equal(buf.readUInt32BE(off + 8 + len), zlib.crc32(body), `${type} crc`);
    types.push(type);
    const data = body.subarray(4);
    if (type === 'IHDR') ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    if (type === 'IDAT') idat.push(data);
    if (type === 'sRGB') ihdr.srgb = data[0];
    off += 12 + len;
  }
  assert.equal(types[0], 'IHDR');
  assert.equal(types[1], 'sRGB');
  assert.equal(types.at(-1), 'IEND');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = ihdr.width * 4;
  assert.equal(raw.length, ihdr.height * (stride + 1));
  const px = new Uint8Array(ihdr.width * ihdr.height * 4);
  for (let r = 0; r < ihdr.height; r++) {
    const f = raw[r * (stride + 1)];
    assert.equal(f, 1);
    for (let i = 0; i < stride; i++) {
      const v = raw[r * (stride + 1) + 1 + i];
      px[r * stride + i] = (v + (i >= 4 ? px[r * stride + i - 4] : 0)) & 0xff;
    }
  }
  return { ihdr, px };
}

test('streaming PNG encoder writes a valid PNG in bands', async () => {
  const W = 37, H = 23;
  const img = new Uint8Array(W * H * 4);
  for (let i = 0; i < img.length; i++) img[i] = (i * 31 + (i >> 7)) & 0xff;
  const png = createPngWriter(W, H);
  for (let y = 0; y < H; y += 10) {
    const rows = Math.min(10, H - y);
    await png.writeRows(img.subarray(y * W * 4, (y + rows) * W * 4), rows);
  }
  const blob = await png.finish();
  assert.equal(blob.type, 'image/png');
  const { ihdr, px } = decodePng(Buffer.from(await blob.arrayBuffer()));
  assert.deepEqual(ihdr, { width: W, height: H, depth: 8, color: 6, interlace: 0, srgb: 0 });
  assert.deepEqual(px, img);
});

test('PNG encoder rejects missing rows', async () => {
  const png = createPngWriter(4, 4);
  await png.writeRows(new Uint8Array(4 * 4 * 2), 2);
  await assert.rejects(png.finish(), /2 of 4 rows/);
  await assert.rejects(png.writeRows(new Uint8Array(4 * 4 * 3), 3), /too many/);
});

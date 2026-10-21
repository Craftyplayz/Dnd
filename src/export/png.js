// Streaming PNG encoder: RGBA 8-bit, rows fed in bands, zlib via CompressionStream('deflate').
// Used for exports too large for one canvas (docs/CONTRACT.md section 10).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

export const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

// length (4) + type (4) + data + crc32(type + data) (4)
export function pngChunk(type, data = new Uint8Array(0)) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function ihdr(width, height) {
  const d = new Uint8Array(13);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  d[8] = 8;  // bit depth
  d[9] = 6;  // colour type RGBA
  // compression 0, filter method 0, interlace 0
  return pngChunk('IHDR', d);
}

// createPngWriter(w, h) -> { writeRows(rgba, rows), finish() -> Promise<Blob> }.
// rgba holds `rows` full-width rows (rows * w * 4 bytes). Rows use the Sub filter.
export function createPngWriter(width, height) {
  if (!(width > 0 && height > 0 && width <= 0x7fffffff && height <= 0x7fffffff)) throw new Error('bad PNG size');
  const parts = [PNG_SIGNATURE, ihdr(width, height)];
  const cs = new CompressionStream('deflate');  // 'deflate' = zlib wrapper, which is what IDAT holds
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();
  const drained = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      if (value.length) parts.push(pngChunk('IDAT', value));
    }
  })();
  drained.catch(() => {});  // surfaced by finish()
  const stride = width * 4;
  let written = 0;

  return {
    async writeRows(rgba, rows) {
      if (written + rows > height) throw new Error('too many PNG rows');
      if (rgba.length < rows * stride) throw new Error('short PNG row data');
      const out = new Uint8Array(rows * (stride + 1));
      for (let r = 0; r < rows; r++) {
        const src = r * stride, dst = r * (stride + 1);
        out[dst] = 1;  // Sub: byte minus the same channel of the pixel to its left
        for (let i = 0; i < 4 && i < stride; i++) out[dst + 1 + i] = rgba[src + i];
        for (let i = 4; i < stride; i++) out[dst + 1 + i] = rgba[src + i] - rgba[src + i - 4];
      }
      written += rows;
      await writer.ready;
      await writer.write(out);
    },
    async finish() {
      if (written !== height) throw new Error(`PNG has ${written} of ${height} rows`);
      await writer.close();
      await drained;
      parts.push(pngChunk('IEND'));
      return new Blob(parts, { type: 'image/png' });
    },
  };
}


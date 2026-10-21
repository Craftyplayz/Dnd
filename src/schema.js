// Scene schema access, normalisation and validation. Mirrors server.py's validator.
// The validator implements only the JSON Schema keywords listed in docs/CONTRACT.md section 3.
import SCHEMA from '../schema.json' with { type: 'json' };

export { SCHEMA };
// Null-prototype so lookups like TYPES['constructor'] miss, matching Python dict semantics.
export const TYPES = Object.assign(Object.create(null), SCHEMA['x-elementTypes']);
export const LAYERS = ['ground', 'low', 'objects', 'canopy', 'labels'];
// Toggleable in the layer panel; 'terrain', 'grid' and 'lighting' are not element layers.
export const VIEW_LAYERS = ['terrain', ...LAYERS, 'grid', 'lighting'];
// Collection name -> element kind. Render order within a layer follows this order.
export const COLLECTIONS = { regions: 'region', paths: 'path', objects: 'object', labels: 'label' };
export const KIND_COLLECTION = { region: 'regions', path: 'paths', object: 'objects', label: 'labels' };
export const ID_RE = /^[a-z][a-z0-9-]{0,47}$/;
export const SCENE_ID_RE = /^[a-z0-9-]{1,64}$/;

// FNV-1a 32-bit over UTF-8 bytes. server.py implements the same function.
export function hash32(str) {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(String(str))) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function slugify(name) {
  const s = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return s || 'untitled';
}

export function* iterElements(scene) {
  for (const collection of Object.keys(COLLECTIONS)) {
    const arr = scene[collection] || [];
    for (let index = 0; index < arr.length; index++) yield { el: arr[index], collection, index };
  }
}

export function allElements(scene) {
  return [...iterElements(scene)].map(r => r.el);
}

export function findElement(scene, id) {
  for (const r of iterElements(scene)) if (r.el.id === id) return r;
  return null;
}

export function newId(scene, type) {
  const used = new Set([...allElements(scene).map(e => e.id), ...(scene.constraints || []).map(c => c.id)]);
  const base = slugify(type).replace(/^[^a-z]+/, '') || 'el';
  for (let i = 1; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}

const r2 = v => Math.round(v * 100) / 100;

// Fill defaults and derived fields. Returns a new scene; never mutates the input.
// Rules (server.py must match): rotation 0, layer = type default, seed = hash32(id) ^ scene.seed,
// missing params filled from type param defaults, size of paths/regions = bbox of points
// (paths grow by width), size of labels from text length.
export function normalizeScene(input) {
  const scene = structuredClone(input);
  scene.constraints ??= [];
  scene.regions ??= []; scene.paths ??= []; scene.objects ??= []; scene.labels ??= [];
  scene.seed ??= 1;
  if (scene.grid) {
    scene.grid.color ??= '#000000';
    scene.grid.opacity ??= 0.22;
  }
  if (scene.terrain) scene.terrain.variation ??= 0.5;
  if (scene.lighting) scene.lighting.elevation ??= 45;
  for (const c of scene.constraints) {
    c.measure ??= 'edge';
    c.direction ??= 'any';
  }
  for (const { el } of iterElements(scene)) normalizeElement(el, scene.seed);
  return scene;
}

export function normalizeElement(el, sceneSeed = 0) {
  const def = TYPES[el.type];
  el.rotation ??= 0;
  if (typeof el.id === 'string') el.seed ??= (hash32(el.id) ^ (sceneSeed >>> 0)) >>> 0;
  el.params ??= {};
  el.name ??= el.id;
  if (!def) return el;
  el.layer ??= def.layer;
  const props = def.params?.properties || {};
  for (const [k, s] of Object.entries(props)) {
    if (el.params[k] === undefined && s.default !== undefined) el.params[k] = structuredClone(s.default);
  }
  const pts = el.params.points;
  if ((def.kind === 'path' || def.kind === 'region') && Array.isArray(pts) && pts.length) {
    const pad = def.kind === 'path' ? (Number(el.params.width) || 0) : 0;
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    el.size = {
      w: Math.max(0.1, r2(Math.max(...xs) - Math.min(...xs) + pad)),
      h: Math.max(0.1, r2(Math.max(...ys) - Math.min(...ys) + pad)),
    };
  }
  if (def.kind === 'label' && typeof el.params.text === 'string') {
    const f = el.params.fontFt ?? 3;
    el.size = { w: Math.max(0.1, r2(el.params.text.length * f * 0.55)), h: r2(f * 1.2) };
  }
  return el;
}

// ---------- generic validator (JSON Schema subset) ----------

function typeOk(t, v) {
  switch (t) {
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    default: return false;
  }
}

function resolveRef(ref, root) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref ${ref}`);
  return ref.slice(2).split('/').reduce((o, k) => o[k.replace(/~1/g, '/').replace(/~0/g, '~')], root);
}

const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function validateAgainst(schema, value, path = '', root = SCHEMA, errors = []) {
  if (schema.$ref) return validateAgainst(resolveRef(schema.$ref, root), value, path, root, errors);
  const err = message => errors.push({ path: path || '/', message });
  if (schema.const !== undefined && !deepEq(schema.const, value)) { err(`must equal ${JSON.stringify(schema.const)}`); return errors; }
  if (schema.enum && !schema.enum.some(e => deepEq(e, value))) { err(`must be one of ${schema.enum.join(', ')}`); return errors; }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(t => typeOk(t, value))) { err(`must be ${types.join(' or ')}`); return errors; }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) err(`must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) err(`must be <= ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) err(`must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) err(`must be at most ${schema.maxLength} characters`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) err(`must match ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) err(`must have at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) err(`must have at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => validateAgainst(schema.items, v, `${path}/${i}`, root, errors));
  }
  if (typeOk('object', value)) {
    for (const k of schema.required || []) if (!Object.hasOwn(value, k)) err(`missing required property "${k}"`);
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (Object.hasOwn(props, k)) validateAgainst(props[k], v, `${path}/${k}`, root, errors);
      else if (schema.additionalProperties === false) err(`unknown property "${k}"`);
      else if (typeof schema.additionalProperties === 'object') validateAgainst(schema.additionalProperties, v, `${path}/${k}`, root, errors);
    }
  }
  return errors;
}

// Structural + semantic validation. Call on a normalised scene.
// Returns { ok, errors: [{ path, message }] }.
export function validateScene(scene) {
  const errors = validateAgainst(SCHEMA, scene, '');
  if (errors.length || !typeOk('object', scene)) return { ok: false, errors };
  const err = (path, message) => errors.push({ path, message });
  const W = scene.grid.widthFt, H = scene.grid.heightFt;
  if (W % 5 || H % 5) err('/grid', 'widthFt and heightFt must be multiples of 5');
  const ids = new Set();
  for (const { el, collection, index } of iterElements(scene)) {
    const p = `/${collection}/${index}`;
    if (ids.has(el.id)) err(`${p}/id`, `duplicate id "${el.id}"`);
    ids.add(el.id);
    const def = TYPES[el.type];
    if (!def) { err(`${p}/type`, `unknown element type "${el.type}"`); continue; }
    if (COLLECTIONS[collection] !== def.kind) err(`${p}/type`, `type "${el.type}" is a ${def.kind} and belongs in "${KIND_COLLECTION[def.kind]}"`);
    if (!def.layers.includes(el.layer)) err(`${p}/layer`, `layer for "${el.type}" must be one of ${def.layers.join(', ')}`);
    validateAgainst(def.params, el.params, `${p}/params`, SCHEMA, errors);
    if (def.kind === 'region' && Array.isArray(el.params.points) && el.params.points.length < 3) err(`${p}/params/points`, 'region needs at least 3 points');
    const { x, y } = el.position;
    // Paths and regions: position is only the origin of their points, so it may sit outside the map.
    if ((def.kind === 'object' || def.kind === 'label') && (x < 0 || y < 0 || x > W || y > H)) err(`${p}/position`, `position (${x}, ${y}) is outside the ${W}x${H} ft map`);
  }
  for (const [i, c] of scene.constraints.entries()) {
    const p = `/constraints/${i}`;
    if (ids.has(c.id)) err(`${p}/id`, `duplicate id "${c.id}"`);
    ids.add(c.id);
    if (!findElement(scene, c.a)) err(`${p}/a`, `unknown element "${c.a}"`);
    if (!findElement(scene, c.b)) err(`${p}/b`, `unknown element "${c.b}"`);
    if (c.a === c.b) err(`${p}/b`, 'a and b must differ');
  }
  return { ok: errors.length === 0, errors };
}

// Convenience: normalise then validate. Returns { ok, errors, scene }.
export function checkScene(input) {
  let scene;
  try { scene = normalizeScene(input); } catch (e) { return { ok: false, errors: [{ path: '/', message: String(e.message || e) }], scene: input }; }
  return { ...validateScene(scene), scene };
}

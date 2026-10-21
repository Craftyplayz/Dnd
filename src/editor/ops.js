// Pure editor logic: op builders, scope check, formatting. No DOM; tested by tests/editor.test.mjs.
import { TYPES, findElement, KIND_COLLECTION, checkScene } from '../schema.js';
import { touchedIds, parsePath } from '../core/patch.js';
import { snapPosition, toLocal, toWorld, pointSegDist, snap } from '../core/geom.js';

const ELEMENT_COLLECTIONS = ['regions', 'paths', 'objects', 'labels'];
const r2 = v => Math.round(v * 100) / 100;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const esc = id => String(id).replace(/~/g, '~0').replace(/\//g, '~1');

export const collectionOf = el => KIND_COLLECTION[TYPES[el.type]?.kind];
export const elPath = (el, field) => `/${collectionOf(el)}/${esc(el.id)}${field ? '/' + field : ''}`;

// Positions must stay inside the map or the store rejects the commit.
export const clampPos = (scene, p) => ({ x: r2(clamp(p.x, 0, scene.grid.widthFt)), y: r2(clamp(p.y, 0, scene.grid.heightFt)) });

// Ids an AI edit would touch that it is not allowed to: outside selected ∪ neighbours ∪ newly added.
export function outOfScope(scene, ops, selectedIds, neighbourIds = []) {
  const allowed = new Set([...selectedIds, ...neighbourIds, ...addedIds(scene, ops)]);
  return touchedIds(scene, ops).filter(id => !allowed.has(id));
}

// Ids of whole elements that an op list adds (and that do not exist yet).
export function addedIds(scene, ops) {
  const out = [];
  for (const o of ops || []) {
    if (o?.op !== 'add') continue;
    let t;
    try { t = parsePath(o.path); } catch { continue; }
    if (t.length !== 2 || !ELEMENT_COLLECTIONS.includes(t[0])) continue;
    const id = t[1] === '-' ? o.value?.id : t[1];
    if (id && !findElement(scene, id)) out.push(id);
  }
  return out;
}

// Move every selected element by the same delta. The primary element (the one grabbed)
// is snapped with snapPosition unless free; the others follow its snapped delta.
export function moveOps(scene, ids, primaryId, dx, dy, { free = false } = {}) {
  const els = ids.map(id => findElement(scene, id)?.el).filter(Boolean);
  const primary = els.find(e => e.id === primaryId) || els[0];
  if (!primary) return [];
  let target = { x: primary.position.x + dx, y: primary.position.y + dy };
  if (!free) target = snapPosition(primary, target);
  const ddx = target.x - primary.position.x, ddy = target.y - primary.position.y;
  return translateOps(scene, els, ddx, ddy);
}

export function nudgeOps(scene, ids, dx, dy) {
  return translateOps(scene, ids.map(id => findElement(scene, id)?.el).filter(Boolean), dx, dy);
}

function translateOps(scene, els, dx, dy) {
  const ops = [];
  for (const el of els) {
    const p = clampPos(scene, { x: el.position.x + dx, y: el.position.y + dy });
    if (p.x !== el.position.x || p.y !== el.position.y) ops.push({ op: 'replace', path: elPath(el, 'position'), value: p });
  }
  return ops;
}

export const deleteOps = (scene, ids) =>
  ids.map(id => findElement(scene, id)?.el).filter(Boolean).map(el => ({ op: 'remove', path: elPath(el) }));

// Resize an object by dragging handle (hx, hy) in {-1,0,1}^2 to world point p.
// The opposite edge/corner stays fixed. Sizes snap to 1 ft unless free; keepAspect for corners.
export function resizeOps(scene, el, hx, hy, p, { free = false, keepAspect = false } = {}) {
  const [lx, ly] = toLocal(el, [p.x, p.y]);
  const { w, h } = el.size;
  const min = free ? 0.5 : 1;
  const q = v => (free ? r2(v) : Math.round(v));
  let nw = hx ? Math.max(min, q(hx > 0 ? lx + w / 2 : w / 2 - lx)) : w;
  let nh = hy ? Math.max(min, q(hy > 0 ? ly + h / 2 : h / 2 - ly)) : h;
  if (keepAspect && hx && hy) {
    const k = Math.max(nw / w, nh / h);
    nw = Math.max(min, q(w * k)); nh = Math.max(min, q(h * k));
  }
  nw = Math.min(nw, 2000); nh = Math.min(nh, 2000);
  // Fixed side in local coords, new centre halfway to the moved side.
  const cx = hx ? (hx > 0 ? -w / 2 + nw / 2 : w / 2 - nw / 2) : 0;
  const cy = hy ? (hy > 0 ? -h / 2 + nh / 2 : h / 2 - nh / 2) : 0;
  const [wx, wy] = toWorld(el, [cx, cy]);
  if (nw === w && nh === h) return [];
  return [
    { op: 'replace', path: elPath(el, 'size'), value: { w: nw, h: nh } },
    { op: 'replace', path: elPath(el, 'position'), value: clampPos(scene, { x: wx, y: wy }) },
  ];
}

export const normDeg = d => r2(((d % 360) + 360) % 360);

// Rotation from the element centre to world point p (handle sits "above" = local -y).
export function rotateOps(el, p, { free = false } = {}) {
  const raw = (Math.atan2(p.y - el.position.y, p.x - el.position.x) * 180) / Math.PI + 90;
  const deg = normDeg(free ? raw : snap(raw, 15));
  if (deg === normDeg(el.rotation || 0)) return [];
  return [{ op: 'replace', path: elPath(el, 'rotation'), value: deg }];
}

// Move point i of a path/region to world point p (snapped to 2.5 ft unless free).
export function pointOps(el, i, p, { free = false } = {}) {
  const wp = free ? [p.x, p.y] : [snap(p.x, 2.5), snap(p.y, 2.5)];
  const [lx, ly] = toLocal(el, wp).map(r2);
  const cur = el.params.points[i];
  if (cur && cur[0] === lx && cur[1] === ly) return [];
  return [{ op: 'replace', path: elPath(el, `params/points/${i}`), value: [lx, ly] }];
}

export const minPoints = el => (TYPES[el.type]?.kind === 'region' ? 3 : 2);

export function removePointOps(el, i) {
  if (el.params.points.length <= minPoints(el)) return [];
  return [{ op: 'remove', path: elPath(el, `params/points/${i}`) }];
}

// Insert a point on the segment nearest to world point p.
export function insertPointOps(el, p) {
  const pts = el.params.points.map(q => toWorld(el, q));
  const closed = TYPES[el.type]?.kind === 'region' || !!el.params.closed;
  let best = -1, bestD = Infinity;
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const d = pointSegDist([p.x, p.y], pts[i], pts[(i + 1) % pts.length]);
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0) return [];
  return [{ op: 'add', path: elPath(el, `params/points/${best + 1}`), value: toLocal(el, [p.x, p.y]).map(r2) }];
}

// One property edit -> op. field is a pointer suffix inside the element, e.g. "params/species".
export function fieldOps(el, field, value) {
  return [{ op: 'add', path: elPath(el, field), value }]; // add sets a key whether or not it exists
}

// ---------- formatting ----------

export const fmt1 = v => (Math.round(v * 10) / 10).toFixed(1);
const trim = v => String(Math.round(v * 10) / 10);

export function formatFeet(ft) {
  const sq = ft / 5;
  return `${fmt1(ft)} ft (${trim(sq)} ${Math.round(sq * 10) === 10 ? 'square' : 'squares'})`;
}

export function sizeTag(el) {
  return `${el.name} — ${trim(el.size.w)} x ${trim(el.size.h)} ft`;
}

// Human message for an error thrown by the api (ApiError duck-typed) or anything else.
export function errorMessage(err) {
  if (!err) return 'Unknown error.';
  const details = Array.isArray(err.details) && err.details.length
    ? ' ' + err.details.slice(0, 3).map(d => (typeof d === 'string' ? d : [d.path, d.message].filter(Boolean).join(' '))).join('; ')
    : '';
  switch (err.code) {
    case 'daily_cap': return err.message || 'Daily limit reached. Resets at 00:00 UTC.';
    case 'rate_limited': return `Too many requests. Try again in ${err.retryAfterSec ?? 60} s.`;
    case 'llm_invalid': return `The AI's answer failed validation twice, so nothing was changed.${details}`;
    case 'llm_refusal': return 'The AI declined this request. Nothing was changed.';
    case 'llm_error': return 'The AI service failed or timed out. Nothing was changed. Try again.';
    case 'llm_not_configured': return 'The server has no Anthropic API key configured.';
    case 'invalid_scene': return `The server rejected the scene as invalid.${details}`;
    case 'locked_out': return err.message || 'Too many failed logins. Try again later.';
    default:
      if (err.name === 'TypeError') return 'Could not reach the server. Check your connection.';
      return (err.message || String(err)) + details;
  }
}

export const formatErrors = errors => (errors || []).slice(0, 3).map(e => `${e.path} ${e.message}`).join('; ');

// Run the layout engine on a candidate scene. Never loses the candidate: if layout throws or
// returns an invalid scene, the candidate comes back unchanged with the reason in `error`.
export function layoutOrFallback(candidate, layout) {
  try {
    const out = layout.layoutScene(candidate, { fix: true });
    const res = checkScene(out?.scene);
    if (res.ok) return { scene: out.scene, report: out.report || null, moved: out.moved || out.report?.moved || [], error: null };
    return { scene: candidate, report: null, moved: [], error: `layout produced an invalid scene (${formatErrors(res.errors)})` };
  } catch (e) {
    return { scene: candidate, report: null, moved: [], error: `layout failed (${e?.message || e})` };
  }
}

export const reportErrors = report => (report?.items || []).filter(i => i.level === 'error').length;

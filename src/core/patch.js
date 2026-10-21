// Scene patches: RFC 6902 add/remove/replace, except that element collections are
// addressed by id instead of array index ("/objects/wagon-1/position/x"), because
// indices shift as elements are added and removed. server.py implements the same rules.
// See docs/CONTRACT.md section 7.

export const ID_COLLECTIONS = ['regions', 'paths', 'objects', 'labels', 'constraints'];
const ELEMENT_COLLECTIONS = ['regions', 'paths', 'objects', 'labels'];

export class PatchError extends Error {
  constructor(opIndex, message) {
    super(`op ${opIndex}: ${message}`);
    this.opIndex = opIndex;
  }
}

const unescape = t => t.replace(/~1/g, '/').replace(/~0/g, '~');

export function parsePath(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error(`path must start with "/"`);
  return path.slice(1).split('/').map(unescape);
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// Resolve tokens to [parent container, key]. Collection id tokens become numeric indices.
function resolve(doc, tokens, op) {
  if (!tokens.length || tokens[0] === '') throw new Error('cannot target the scene root');
  if (!(tokens[0] in doc)) throw new Error(`unknown top-level key "${tokens[0]}"`);
  let parent = doc, key = tokens[0];
  for (let i = 1; i < tokens.length; i++) {
    let node = parent[key];
    let tok = tokens[i];
    if (i === 1 && ID_COLLECTIONS.includes(tokens[0])) {
      if (tok === '-') {
        if (tokens.length !== 2 || op !== 'add') throw new Error(`"-" is only valid for add of a whole element`);
      } else {
        const idx = node.findIndex(e => e && e.id === tok);
        if (idx < 0) {
          if (op === 'add' && tokens.length === 2) tok = '-'; // add by explicit id == append
          else throw new Error(`no element with id "${tok}" in ${tokens[0]}`);
        } else tok = idx;
      }
    } else if (Array.isArray(node)) {
      if (tok !== '-') {
        if (!/^(0|[1-9][0-9]*)$/.test(tok)) throw new Error(`bad array index "${tok}"`);
        tok = Number(tok);
      }
    } else if (!isObj(node)) {
      throw new Error(`cannot descend into ${JSON.stringify(tokens.slice(0, i).join('/'))}`);
    }
    if (i < tokens.length - 1 && (tok === '-' || node[tok] === undefined)) throw new Error(`path /${tokens.slice(0, i + 1).join('/')} does not exist`);
    parent = node; key = tok;
  }
  return [parent, key];
}

// Apply ops to a deep copy. All-or-nothing: throws PatchError and leaves the input untouched.
// Removing a whole element also removes constraints that reference it.
export function applyPatch(scene, ops) {
  if (!Array.isArray(ops)) throw new PatchError(-1, 'ops must be an array');
  const doc = structuredClone(scene);
  ops.forEach((o, i) => {
    try {
      if (!isObj(o)) throw new Error('op must be an object');
      const { op, path, value } = o;
      if (!['add', 'remove', 'replace'].includes(op)) throw new Error(`unsupported op "${op}"`);
      if (op !== 'remove' && !('value' in o)) throw new Error('missing value');
      const tokens = parsePath(path);
      const [parent, key] = resolve(doc, tokens, op);
      const v = structuredClone(value);
      if (op === 'add') {
        if (Array.isArray(parent)) {
          if (key === '-') parent.push(v);
          else if (key > parent.length) throw new Error('index out of range');
          else parent.splice(key, 0, v);
        } else parent[key] = v;
      } else {
        if (parent[key] === undefined) throw new Error(`path ${path} does not exist`);
        if (op === 'replace') parent[key] = v;
        else if (Array.isArray(parent)) {
          const [removed] = parent.splice(key, 1);
          if (tokens.length === 2 && ELEMENT_COLLECTIONS.includes(tokens[0]) && removed?.id) {
            doc.constraints = (doc.constraints || []).filter(c => c.a !== removed.id && c.b !== removed.id);
          }
        } else delete parent[key];
      }
    } catch (e) {
      throw e instanceof PatchError ? e : new PatchError(i, e.message);
    }
  });
  return doc;
}

// Element ids an op list touches (for "only edit the selection" checks).
export function touchedIds(scene, ops) {
  const ids = new Set();
  for (const o of ops || []) {
    let t;
    try { t = parsePath(o.path); } catch { continue; }
    if (!ELEMENT_COLLECTIONS.includes(t[0])) continue;
    if (t[1] === '-' || t.length === 1) { if (o.value?.id) ids.add(o.value.id); }
    else ids.add(t[1]);
  }
  return [...ids];
}

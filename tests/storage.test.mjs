// node --test tests/storage.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ApiError, createApi } from '../src/storage/api.js';
import { DRAFT_KEY, clearDraft, loadDraft, saveDraft } from '../src/storage/draft.js';
import { parseSceneJson } from '../src/storage/file.js';

const sample = JSON.parse(readFileSync(new URL('../samples/riverside-ruin.json', import.meta.url), 'utf8'));

function harness(responses) {
  const calls = [], events = [], redirects = [];
  const fetch = async (url, init) => {
    calls.push({ url, ...init });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: k => (r.headers || {})[k] ?? null },
      json: async () => { if (r.body === undefined) throw new SyntaxError('no body'); return r.body; },
    };
  };
  const bus = { emit: (e, p) => events.push([e, p]) };
  const api = createApi(bus, { fetch, location: { assign: u => redirects.push(u) } });
  return { api, calls, events, redirects };
}

test('requests use the contract routes, methods and headers', async () => {
  const ok = { status: 200, body: { ok: true } };
  const h = harness(Array.from({ length: 10 }, () => ({ ...ok })));
  await h.api.session();
  await h.api.login('pw');
  await h.api.logout();
  await h.api.generate({ description: 'a ruin', widthFt: 100 });
  await h.api.edit({ instruction: 'x', selectedIds: [], selected: [], neighbours: [], summary: {}, scene: sample });
  await h.api.listScenes();
  await h.api.getScene('my scene');
  await h.api.saveScene('a-1', sample);
  await h.api.deleteScene('a-1');
  await h.api.usage();
  assert.deepEqual(h.calls.map(c => `${c.method} ${c.url}`), [
    'GET /api/session', 'POST /login', 'POST /logout', 'POST /api/generate', 'POST /api/edit',
    'GET /api/scenes', 'GET /api/scenes/my%20scene', 'PUT /api/scenes/a-1', 'DELETE /api/scenes/a-1', 'GET /api/usage',
  ]);
  for (const c of h.calls) {
    assert.equal(c.credentials, 'same-origin');
    if (c.method === 'GET') assert.equal(c.body, undefined);
    else { assert.equal(c.headers['Content-Type'], 'application/json'); JSON.parse(c.body); }
  }
  assert.deepEqual(JSON.parse(h.calls[3].body), { description: 'a ruin', widthFt: 100 });
  assert.deepEqual(JSON.parse(h.calls[7].body), { scene: sample });
});

test('usage is emitted from responses and from usage()', async () => {
  const usage = { date: '2026-10-21', requests: 3, cap: 300 };
  const h = harness([{ status: 200, body: { ops: [], usage } }, { status: 200, body: usage }]);
  await h.api.edit({ instruction: 'x', selectedIds: [], selected: [], neighbours: [], summary: {}, scene: sample });
  await h.api.usage();
  assert.deepEqual(h.events, [['usage:updated', { usage }], ['usage:updated', { usage }]]);
});

test('errors become ApiError; 401 redirects except on login', async () => {
  const h = harness([
    { status: 429, headers: { 'Retry-After': '30' }, body: { error: { code: 'rate_limited', message: 'Slow down' } } },
    { status: 401, body: { error: { code: 'unauthorized', message: 'Log in' } } },
    { status: 401, body: { error: { code: 'invalid_password', message: 'Wrong', details: [{ attemptsLeft: 4 }] } } },
    { status: 502 },
    new TypeError('Failed to fetch'),
  ]);
  const e1 = await h.api.generate({ description: 'x' }).catch(e => e);
  assert.ok(e1 instanceof ApiError && e1 instanceof Error);
  assert.deepEqual([e1.status, e1.code, e1.message, e1.retryAfterSec], [429, 'rate_limited', 'Slow down', 30]);
  const e2 = await h.api.listScenes().catch(e => e);
  assert.equal(e2.code, 'unauthorized');
  assert.deepEqual(h.redirects, ['/login']);
  const e3 = await h.api.login('nope').catch(e => e);
  assert.equal(e3.code, 'invalid_password');
  assert.deepEqual(e3.details, [{ attemptsLeft: 4 }]);
  assert.deepEqual(h.redirects, ['/login']);
  const e4 = await h.api.session().catch(e => e);
  assert.deepEqual([e4.status, e4.code], [502, 'http_502']);
  const e5 = await h.api.session().catch(e => e);
  assert.deepEqual([e5.status, e5.code], [0, 'network']);
});

test('draft round-trips and never throws', () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: k => mem.delete(k) };
  assert.equal(loadDraft(), null);
  saveDraft(sample);
  assert.ok(mem.has(DRAFT_KEY));
  assert.equal(loadDraft().meta.name, sample.meta.name);
  mem.set(DRAFT_KEY, '{"not": "a scene"}');
  assert.equal(loadDraft(), null);
  mem.set(DRAFT_KEY, '{broken');
  assert.equal(loadDraft(), null);
  clearDraft();
  assert.equal(mem.size, 0);
  const boom = () => { throw new Error('SecurityError'); };
  globalThis.localStorage = { getItem: boom, setItem: boom, removeItem: boom };
  saveDraft(sample);
  assert.equal(loadDraft(), null);
  clearDraft();
  delete globalThis.localStorage;
  saveDraft(sample);
  assert.equal(loadDraft(), null);
});

test('scene file parsing gives readable errors', () => {
  assert.equal(parseSceneJson(JSON.stringify(sample)).meta.name, sample.meta.name);
  assert.throws(() => parseSceneJson('{oops'), /Not a JSON file/);
  assert.throws(() => parseSceneJson('{"meta": {}}'), /Not a valid scene: /);
});

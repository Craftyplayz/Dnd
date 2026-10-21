// HTTP client for server.py (docs/CONTRACT.md sections 11 and 12).
// Every method resolves with the parsed JSON response body as the server sends it.

export class ApiError extends Error {
  constructor({ status = 0, code = 'error', message = 'Request failed', details = null, retryAfterSec = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterSec = retryAfterSec;
  }
}

// deps are for tests; the app calls createApi(bus).
export function createApi(bus, { fetch = (...a) => globalThis.fetch(...a), location = globalThis.location } = {}) {
  async function request(method, path, body) {
    const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (method !== 'GET') {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body ?? {});
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch (e) {
      throw new ApiError({ status: 0, code: 'network', message: `Cannot reach the server (${e.message || e})` });
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty or non-JSON body */ }
    if (data && typeof data === 'object' && data.usage) bus?.emit('usage:updated', { usage: data.usage });
    if (!res.ok) {
      const e = (data && data.error) || {};
      const header = Number(res.headers?.get?.('Retry-After'));
      if (res.status === 401 && path !== '/login') location?.assign('/login');
      throw new ApiError({
        status: res.status,
        code: e.code || `http_${res.status}`,
        message: e.message || `Request failed (${res.status})`,
        details: e.details ?? null,
        retryAfterSec: e.retryAfterSec ?? (Number.isFinite(header) && header > 0 ? header : null),
      });
    }
    return data;
  }

  const scenePath = id => `/api/scenes/${encodeURIComponent(id)}`;

  return {
    session: () => request('GET', '/api/session'),
    login: password => request('POST', '/login', { password }),
    logout: () => request('POST', '/logout'),
    async usage() {
      const usage = await request('GET', '/api/usage');
      if (usage) bus?.emit('usage:updated', { usage });
      return usage;
    },
    generate({ description, widthFt, heightFt, seed } = {}) {
      const body = { description };
      if (widthFt !== undefined) body.widthFt = widthFt;
      if (heightFt !== undefined) body.heightFt = heightFt;
      if (seed !== undefined) body.seed = seed;
      return request('POST', '/api/generate', body);
    },
    edit: ({ instruction, selectedIds, selected, neighbours, summary, scene }) =>
      request('POST', '/api/edit', { instruction, selectedIds, selected, neighbours, summary, scene }),
    listScenes: () => request('GET', '/api/scenes'),
    getScene: id => request('GET', scenePath(id)),
    saveScene: (id, scene) => request('PUT', scenePath(id), { scene }),
    deleteScene: id => request('DELETE', scenePath(id)),
  };
}

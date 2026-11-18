// The server's HTTP API (DESIGN.md "HTTP API") as small functions. Every failure is an ApiError
// ({status, code, message, retryAfter, details}); describeError() in errors.js turns it into words.

import { ApiError, apiErrorFrom } from './errors.js';

export function makeApi({ base = '', fetchFn = (...a) => fetch(...a) } = {}) {
  async function req(method, path, { json, text, headers, signal } = {}) {
    const init = { method, headers: { ...(headers || {}) }, signal, credentials: 'same-origin' };
    if (json !== undefined) {
      init.body = JSON.stringify(json);
      init.headers['Content-Type'] = 'application/json';
    } else if (text !== undefined) {
      init.body = text;
      init.headers['Content-Type'] = 'text/plain; charset=utf-8';
    }
    let res;
    try {
      res = await fetchFn(base + path, init);
    } catch (e) {
      throw new ApiError({ code: 'network', message: e && e.message ? e.message : 'network error' });
    }
    const ct = res.headers.get('Content-Type') || '';
    let body = null;
    if (ct.includes('json')) {
      try { body = await res.json(); } catch { body = null; }
    } else {
      try { body = await res.text(); } catch { body = null; }
    }
    if (!res.ok) throw apiErrorFrom(res.status, typeof body === 'object' ? body : null, res.headers.get('Retry-After'));
    return body;
  }
  const enc = encodeURIComponent;
  return {
    base,
    info: () => req('GET', '/api/info'),
    examples: () => req('GET', '/api/examples'),
    exampleText: (name) => req('GET', `/examples/${enc(name)}.btw`),
    instruments: () => req('GET', '/api/instruments'),
    check: (text) => req('POST', '/api/check', { json: { text } }),
    fmt: (text) => req('POST', '/api/fmt', { json: { text } }),
    share: (text) => req('POST', '/api/share', { json: { text } }),
    open: (url) => req('POST', '/api/open', { json: { url } }),
    putProgram: (cid, text) => req('PUT', `/api/programs/${enc(cid)}`, { text }),
    getProgram: (cid) => req('GET', `/api/programs/${enc(cid)}`),
    renderUrl: (cid, format = 'wav', sr = 44100) => `${base}/api/render/${enc(cid)}?format=${format}${format === 'wav' ? `&sr=${sr}` : ''}`,
    renderStatus: (cid) => req('GET', `/api/render/${enc(cid)}/status`),
    compose: (body, signal) => req('POST', '/api/compose', { json: body, signal }),
    challenge: () => req('GET', '/api/auth/challenge'),
    login: (body) => req('POST', '/api/auth/login', { json: body }),
    logout: () => req('POST', '/api/auth/logout', { json: {} }),
    me: () => req('GET', '/api/auth/me'),
    createToken: () => req('POST', '/api/auth/token', { json: {} }),
    revokeTokens: () => req('DELETE', '/api/auth/token'),
    createSession: () => req('POST', '/api/session', { json: {} }),
    report: (id, state) => req('POST', `/api/session/${enc(id)}/report`, { json: state }),
    reply: (id, requestId, state) => req('POST', `/api/session/${enc(id)}/reply`, { json: { request_id: requestId, state } }),
    eventsUrl: (id) => `${base}/api/session/${enc(id)}/events`,
  };
}

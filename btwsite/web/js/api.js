// The server's HTTP API (DESIGN.md "HTTP API") as small functions. Every failure is an ApiError
// ({status, code, message, retryAfter, details}); describeError() in errors.js turns it into words.

import { ApiError, apiErrorFrom } from './errors.js';
import { CID_RE, EXAMPLE_RE, SESSION_RE, trunc } from './util.js';

// Anything that becomes part of a URL path is checked here, at the last step before the URL is built, whoever called:
// a CID, an example's name or a session id that is not exactly what the server makes cannot name another path.
const seg = (re, what) => (v) => {
  if (typeof v !== 'string' || !re.test(v)) throw new ApiError({ status: 0, code: 'bad_request', message: `${trunc(String(v), 60)} is not ${what}` });
  return encodeURIComponent(v);
};
const cidSeg = seg(CID_RE, 'a CID');
const nameSeg = seg(EXAMPLE_RE, 'an example name');
const sidSeg = seg(SESSION_RE, 'a session id');
/** A call that returns a promise answers a bad argument with a rejection, not a throw. */
const rejecting = (fn) => (...a) => {
  try { return fn(...a); } catch (e) { return Promise.reject(e); }
};

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
  return {
    base,
    info: () => req('GET', '/api/info'),
    examples: () => req('GET', '/api/examples'),
    exampleText: rejecting((name) => req('GET', `/examples/${nameSeg(name)}.btw`)),
    instruments: () => req('GET', '/api/instruments'),
    check: (text) => req('POST', '/api/check', { json: { text } }),
    fmt: (text) => req('POST', '/api/fmt', { json: { text } }),
    share: (text) => req('POST', '/api/share', { json: { text } }),
    open: (url) => req('POST', '/api/open', { json: { url } }),
    putProgram: rejecting((cid, text) => req('PUT', `/api/programs/${cidSeg(cid)}`, { text })),
    getProgram: rejecting((cid) => req('GET', `/api/programs/${cidSeg(cid)}`)),
    renderUrl: (cid, format = 'wav', sr = 44100) => `${base}/api/render/${cidSeg(cid)}?format=${format === 'opus' ? 'opus' : 'wav'}${format === 'opus' ? '' : `&sr=${Number(sr) === 48000 ? 48000 : 44100}`}`,
    renderStatus: rejecting((cid) => req('GET', `/api/render/${cidSeg(cid)}/status`)),
    compose: (body, signal) => req('POST', '/api/compose', { json: body, signal }),
    challenge: () => req('GET', '/api/auth/challenge'),
    login: (body) => req('POST', '/api/auth/login', { json: body }),
    logout: () => req('POST', '/api/auth/logout', { json: {} }),
    me: () => req('GET', '/api/auth/me'),
    createToken: () => req('POST', '/api/auth/token', { json: {} }),
    revokeTokens: () => req('DELETE', '/api/auth/token'),
    createSession: () => req('POST', '/api/session', { json: {} }),
    report: rejecting((id, state) => req('POST', `/api/session/${sidSeg(id)}/report`, { json: state })),
    reply: rejecting((id, requestId, state) => req('POST', `/api/session/${sidSeg(id)}/reply`, { json: { request_id: requestId, state } })),
    eventsUrl: (id) => `${base}/api/session/${sidSeg(id)}/events`,
  };
}

// Words for errors: the API's {error:{code,message,retry_after,details}} shape, and the checker's
// diagnostics (line:col, message, expected, did-you-mean). Pure, so the tests can pin the wording.

export class ApiError extends Error {
  constructor({ status = 0, code = 'error', message = '', retryAfter = 0, details = null } = {}) {
    super(message || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.details = details;
  }
}

/** Build an ApiError from a response body (already parsed, or null) and its status. */
export function apiErrorFrom(status, body, retryAfterHeader) {
  const e = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : {};
  const ra = Number(e.retry_after || retryAfterHeader || 0) || 0;
  const details = e.details || (body && (body.attempts || body.diagnostics) ? { attempts: body.attempts, diagnostics: body.diagnostics } : null);
  return new ApiError({ status, code: e.code || (status === 401 ? 'auth_required' : status === 429 ? 'rate_limited' : `http_${status}`), message: e.message || '', retryAfter: ra, details });
}

/** One diagnostic as a line: "3:14 error: expected ...". */
export function diagLine(d) {
  return `${d.line}:${d.col} ${d.severity || 'error'}: ${d.message}`;
}

/** The extra lines a diagnostic carries: what was expected, what was found, the help. */
export function diagDetails(d) {
  const out = [];
  if (d.expected && d.expected.length) out.push(`expected: ${d.expected.join(', ')}`);
  if (d.found) out.push(`found: ${d.found}`);
  if (d.help) out.push(/^did you mean/i.test(d.help) ? d.help : `did you mean: ${d.help}`);
  return out;
}

/** "2 errors, 1 warning" / "no problems". */
export function summary(report) {
  if (!report) return '';
  const e = report.errors ?? (report.diagnostics || []).filter((d) => d.severity !== 'warning').length;
  const w = report.warnings ?? (report.diagnostics || []).filter((d) => d.severity === 'warning').length;
  if (!e && !w) return 'no problems';
  const parts = [];
  if (e) parts.push(`${e} error${e === 1 ? '' : 's'}`);
  if (w) parts.push(`${w} warning${w === 1 ? '' : 's'}`);
  return parts.join(', ');
}

/**
 * What to show for an error: {title, lines[], kind}. `lines` is more detail (the attempts of an unrepairable
 * compose, each with its diagnostics).
 */
export function describeError(err) {
  const e = err instanceof ApiError ? err : new ApiError({ code: 'network', message: err && err.message ? err.message : String(err) });
  const lines = [];
  switch (e.code) {
    case 'rate_limited':
      return { kind: 'warn', title: e.retryAfter ? `rate limited, try again in ${Math.ceil(e.retryAfter)} s` : 'rate limited, try again in a little while', lines };
    case 'busy':
      return { kind: 'warn', title: e.retryAfter ? `all render slots are busy, try again in ${Math.ceil(e.retryAfter)} s` : 'all render slots are busy, try again shortly', lines };
    case 'auth_required':
    case 'bad_signature':
    case 'challenge_stale':
      return { kind: 'warn', title: e.code === 'auth_required' ? 'signed-in only: sign in first' : e.message || 'sign-in failed, try again', lines };
    case 'not_configured':
      return { kind: 'info', title: 'compose is not configured on this server', lines };
    case 'disabled':
      return { kind: 'info', title: 'compose is switched off for now', lines };
    case 'spend_cap':
      return { kind: 'info', title: "today's compose budget is used up; try again tomorrow", lines };
    case 'prompt_too_long':
      return { kind: 'warn', title: e.message || 'the prompt is too long', lines };
    case 'model_error':
      return { kind: 'error', title: 'the model could not be reached or answered badly; try again', lines };
    case 'restricted':
      return { kind: 'error', title: 'this program uses private or restricted sounds and cannot be stored or streamed', lines };
    case 'cid_mismatch':
      return { kind: 'error', title: e.message || "refused: the CID is not that text's CID", lines };
    case 'not_found':
      return { kind: 'error', title: e.message || 'not found', lines };
    case 'network':
      return { kind: 'error', title: `cannot reach the server (${e.message})`, lines };
    case 'unrepairable': {
      const d = e.details || {};
      const attempts = Array.isArray(d.attempts) ? d.attempts : [];
      for (const a of attempts) {
        lines.push(`attempt ${a.n}: ${a.ok ? 'ok' : `${a.errors ?? (a.diagnostics || []).length} error${(a.errors ?? 1) === 1 ? '' : 's'}`}`);
        for (const dg of a.diagnostics || []) lines.push(`  ${diagLine(dg)}`);
      }
      if (!attempts.length) for (const dg of d.diagnostics || []) lines.push(diagLine(dg));
      return { kind: 'error', title: 'unrepairable: see attempts', lines };
    }
    default:
      return { kind: 'error', title: e.message || `error ${e.status || ''} ${e.code}`.trim(), lines };
  }
}

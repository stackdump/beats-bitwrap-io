// The programs a program draws on (an `import`, a borrowed part): fetched once, kept by CID, told to the module. Pure (no DOM), so
// Node tests it.
//
// The language never fetches: whether a program checks is a function of its text and the programs it is given (R-06). The page
// is a host: before the module checks a text it finds the CIDs the text names, fetches the ones it has not got from
// `/api/programs/<cid>` (a CID names exactly one text, so what is fetched is kept for the life of the page and is never stale)
// and tells the module each, which re-hashes it. What a program draws on in turn is found the same way, so a chain of imports
// resolves without the module ever asking. A link carries its programs (`open` answers them as `bundle`): they are kept the same
// way, with nothing fetched.

import { CID_RE } from './util.js';

/** A CID as a word of a program: `z` and base58, 21 to 81 characters (the store's `is_cid`). */
const CID_WORD = /(?<![A-Za-z0-9_])z[1-9A-HJ-NP-Za-km-z]{20,80}(?![A-Za-z0-9_])/g;

/** The most programs one page fetches: a program that draws on more than this is not fetched further (and says it is not here). */
export const MAX_FETCHED = 64;

/** What the module says of a program it has no text for (djlive `env::not_here`). */
export const NOT_HERE = 'is not here: this program draws on it';

/**
 * Every CID the code of `text` names, each once, in order. A comment is not read: a `#! forked-from:` or `#! credit:` header
 * names programs this one is not made of, and none of them is fetched for it.
 */
export function cidsIn(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const code = line.replace(/(^|\s)#.*$/, '$1');
    for (const m of code.matchAll(CID_WORD)) if (!out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

/** Is this diagnostic the module saying a program is not here? */
export function isNotHere(d) {
  return !!d && typeof d.message === 'string' && d.message.includes(NOT_HERE);
}

export class Resolver {
  /**
   * @param fetchProgram `(cid) => Promise<{text}>`: the server's program, as `api.getProgram` answers
   * @param know `(cid, text) => {ok, error}`: tells the module (null: the module predates it, and nothing is fetched)
   * @param onChange called when a fetch has finished, so the text is checked again
   */
  constructor({ fetchProgram, know, onChange = () => {}, max = MAX_FETCHED }) {
    this.fetchProgram = fetchProgram;
    this.know = know;
    this.onChange = onChange;
    this.max = max;
    /** cid -> canonical text, as told to the module */
    this.texts = new Map();
    /** cid -> Promise, while it is being fetched */
    this.pending = new Map();
    /** cid -> why it could not be had */
    this.failed = new Map();
    this.fetched = 0;
  }

  get on() {
    return typeof this.know === 'function';
  }

  /** Tell the module a program the page already has (a link's bundle, a program just fetched): kept once, re-hashed by the module. */
  keep(cid, text) {
    if (!this.on || this.texts.has(cid)) return true;
    let r;
    try {
      r = this.know(cid, text);
    } catch (e) {
      r = { ok: false, error: String(e && e.message ? e.message : e) };
    }
    if (!r || !r.ok) {
      this.failed.set(cid, (r && r.error) || 'the module did not take it');
      return false;
    }
    this.texts.set(cid, text);
    this.failed.delete(cid);
    // what it draws on in turn
    this.want(text);
    return true;
  }

  /** Keep every program of a link's bundle (`{cid: text}`). */
  keepBundle(bundle) {
    if (!bundle || typeof bundle !== 'object') return 0;
    let n = 0;
    for (const [cid, text] of Object.entries(bundle)) if (CID_RE.test(cid) && typeof text === 'string' && this.keep(cid, text)) n++;
    return n;
  }

  /** Start fetching the programs `text` names that are not had, not on their way and not known to be missing. The CIDs started. */
  want(text) {
    if (!this.on) return [];
    const started = [];
    for (const cid of cidsIn(text)) {
      if (this.texts.has(cid) || this.pending.has(cid) || this.failed.has(cid)) continue;
      if (this.fetched >= this.max) {
        this.failed.set(cid, `the page fetches at most ${this.max} programs`);
        continue;
      }
      this.fetched++;
      started.push(cid);
      const p = Promise.resolve()
        .then(() => this.fetchProgram(cid))
        .then((got) => {
          if (!got || typeof got.text !== 'string') throw new Error('the server sent no text');
          if (!this.keep(cid, got.text) && !this.failed.has(cid)) this.failed.set(cid, 'refused');
        })
        .catch((e) => this.failed.set(cid, String(e && e.message ? e.message : e)))
        .finally(() => {
          this.pending.delete(cid);
          this.onChange(cid);
        });
      this.pending.set(cid, p);
    }
    return started;
  }

  /** A promise that settles when nothing is being fetched (what a fetch started meanwhile finds included). */
  async settled() {
    while (this.pending.size) await Promise.allSettled([...this.pending.values()]);
  }

  /**
   * A check's report with what is only waiting left out: a "not here" at a CID whose fetch is on its way is not an error yet
   * (it may be in a moment), so it is not shown, and the report says what it waits for (`waiting`). One whose fetch failed, or
   * which is not being fetched, stays, and says so in the module's words.
   */
  settle(report, text) {
    if (!report || !this.pending.size || !Array.isArray(report.diagnostics)) return report;
    const waits = (d) => isNotHere(d) && [...this.pending.keys()].some((c) => String(text).slice(d.start, d.end).includes(c));
    const shown = report.diagnostics.filter((d) => !waits(d));
    if (shown.length === report.diagnostics.length) return report;
    const errors = shown.filter((d) => d.severity !== 'warning').length;
    return { ...report, diagnostics: shown, errors, warnings: shown.length - errors, waiting: [...this.pending.keys()] };
  }

  /** The programs a report says it drew on (`uses`, leaves first) as [cid, text] a store can take in that order. */
  closureOf(report) {
    const out = [];
    for (const cid of (report && report.uses) || []) if (this.texts.has(cid)) out.push([cid, this.texts.get(cid)]);
    return out;
  }
}

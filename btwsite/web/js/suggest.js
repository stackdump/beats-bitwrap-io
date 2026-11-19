// "Did you mean" suggestions as one-click edits. Pure: no DOM, so test/unit.mjs pins it.
//
// The checker's diagnostics carry only free text in `help` (there is no structured replacement field), so a suggestion is
// DERIVED, conservatively: the candidates are the quoted or comma/"or"-separated single tokens after "did you mean", or a
// bare single-token help; the span to replace is line/col/end_col (1-based, columns in code points). Nothing is offered when
// the help is prose, a multi-word template ("kick x ~ x ~"), an insertion ("}"), or when the text under the span is no longer
// what the checker saw.

import { lineStarts, offsetOfLineCol, lineEnd } from './geometry.js';

const TOKEN = /^[A-Za-z0-9_][A-Za-z0-9_.:+#-]*$/;
const MAX_CANDIDATES = 6;

/** The single-token candidates a help string names, in order, without duplicates. [] when there are none or it is not a plain token list. */
export function parseHelp(help) {
  if (typeof help !== 'string') return [];
  let s = help.trim();
  if (!s) return [];
  const dym = /^did you mean\b[\s:]*/i.exec(s);
  if (dym) s = s.slice(dym[0].length);
  s = s.replace(/[?.!]+$/, '').trim();
  if (!s) return [];
  const quoted = [...s.matchAll(/`([^`]*)`|"([^"]*)"|'([^']*)'/g)];
  let items;
  if (quoted.length) {
    // everything outside the quotes must be only separators, else it is prose with a quoted word in it
    const rest = s.replace(/`[^`]*`|"[^"]*"|'[^']*'/g, ' ').replace(/\b(or|and)\b/gi, ' ').replace(/[\s,;/|]+/g, '');
    if (rest) return [];
    items = quoted.map((m) => (m[1] ?? m[2] ?? m[3]).trim());
  } else if (dym || !/\s/.test(s)) {
    // "did you mean: a, b or c" or a bare word; a bare multi-word help is a template or a sentence, never a replacement
    items = s.split(/\s*(?:,|;|\bor\b)\s*/i).map((x) => x.trim());
    if (items.some((x) => /\s/.test(x))) return [];
  } else return [];
  if (!items.every((it) => TOKEN.test(it))) return [];
  const out = [...new Set(items)];
  return out.length > MAX_CANDIDATES ? [] : out;
}

const bare = (s) => String(s ?? '').replace(/^`(.*)`$/, '$1').trim();

/**
 * The one-click edits for a diagnostic against `text`: [{label, replacement, from, to, line, col}] with from/to UTF-16 offsets.
 * Empty when the span is not one token on one line, the text there is not what the checker found, or help names no token.
 */
export function suggestionsFor(d, text) {
  if (!d || typeof text !== 'string' || !(d.line >= 1) || !(d.col >= 1)) return [];
  const cands = parseHelp(d.help);
  if (!cands.length) return [];
  const starts = lineStarts(text);
  if (d.line > starts.length) return [];
  const endCol = d.end_col && d.end_col > d.col ? d.end_col : d.col + 1;
  const from = offsetOfLineCol(text, starts, d.line, d.col);
  let to = offsetOfLineCol(text, starts, d.line, endCol);
  to = Math.min(to, lineEnd(text, starts, d.line - 1));
  const old = text.slice(from, to);
  if (!old || /\s/.test(old)) return [];
  const found = bare(d.found);
  if (found && TOKEN.test(found) && found !== old) return [];
  return cands.filter((c) => c !== old).map((c) => ({ label: `Replace \`${old}\` with \`${c}\``, replacement: c, from, to, line: d.line, col: d.col }));
}

/** The text after applying one suggestion (the editor does the real, undoable edit; this is the model of it) and the caret just after the replacement. */
export function applySuggestion(text, s) {
  return { text: text.slice(0, s.from) + s.replacement + text.slice(s.to), caret: s.from + s.replacement.length };
}

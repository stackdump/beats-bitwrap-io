// The header row's numbers, from the runtime's status() and marks() and the checker's section list.
// Pure.

import { cleanName } from './util.js';

/** Which section (0-based) the 0-based song bar falls in, or -1. */
export function sectionIndex(sections, songBar0) {
  if (!sections || songBar0 == null) return -1;
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (songBar0 >= s.start && songBar0 < s.start + s.bars) return i;
  }
  return -1;
}

export function headerModel(status, marks, sections) {
  const st = status || {};
  const idx = st.song_bar != null ? sectionIndex(sections, st.song_bar - 1) : -1;
  const gen = st.generation ?? (marks ? marks.generation : null) ?? null;
  let progress = null;
  if (marks && marks.header && marks.header.progress != null) progress = marks.header.progress;
  else if (st.section_bar != null && st.section_bars) progress = (st.section_bar - 1) / st.section_bars;
  return {
    running: !!st.running,
    ended: !!st.ended,
    section: st.section ?? null,
    secN: idx >= 0 ? idx + 1 : null,
    secM: sections && sections.length ? sections.length : null,
    songBar: st.song_bar ?? null,
    songBars: st.song_bars ?? null,
    bar: st.bar != null ? st.bar + 1 : null,
    barInPhrase: st.bar_in_phrase ?? null,
    phrase: st.phrase ?? null,
    gen: gen == null ? null : gen,
    progress,
  };
}

/** A name to show for a program: `#! name:` in its text, else a short first comment, else "btw <short cid>". */
export function programName(text, cid) {
  const m = /^#!\s*name:\s*(.+)$/m.exec(text || '');
  if (m) return cleanName(m[1]) || (cid ? `btw ${cid.slice(-6)}` : 'untitled');
  const c = /^#\s*([^!\n][^\n]{2,60})$/m.exec(text || '');
  if (c && !/^(intro|build|drop)/i.test(c[1])) return cleanName(c[1].trim().replace(/[:.]$/, ''));
  return cid ? `btw ${cid.slice(-6)}` : 'untitled';
}

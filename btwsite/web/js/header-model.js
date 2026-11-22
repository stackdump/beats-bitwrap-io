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

/**
 * `arrange { }` with mutations: the play under the playhead, from check's `arrange` table (song bars are 1-based, a
 * play's start_bar 0-based). Null without a table, or before / after every play.
 */
export function arrangePlay(arrange, songBar) {
  if (!arrange || !Array.isArray(arrange.plays) || songBar == null) return null;
  const b = songBar - 1;
  return arrange.plays.find((p) => p.start_bar != null && b >= p.start_bar && b < p.start_bar + p.bars) || null;
}

/**
 * The header's generation chip for a play: `pass 2/4 · acid_a@3 hoov_b@0+once` (only the patterns a mutation touched),
 * and the title: each pattern's current text, one a line, so the editor shows the generation that is playing.
 */
export function arrangeLabel(play, arrange) {
  if (!play) return null;
  const passes = arrange && arrange.passes > 1 ? `pass ${play.pass + 1}/${arrange.passes}` : arrange && arrange.unbounded ? 'loop' : '';
  const head = play.coda ? 'coda' : passes;
  const reads = (play.reads || []).map((r) => `${r.pattern}@${r.gen}${r.once ? '+once' : ''}`);
  // a counted line (`~3`, `@4`) that fired just before this play, the first to read it (check's `arrange.fires`)
  const at = arrange && Array.isArray(arrange.fires) && Array.isArray(arrange.plays) ? arrange.plays.indexOf(play) : -1;
  const fired = at < 0 ? [] : arrange.fires.filter((f) => (f.plays || []).includes(at)).map((f) => `${f.once ? '@' : '~'}${f.every} fired`);
  const text = [head, ...reads, ...fired].filter(Boolean).join(' · ');
  const title = (play.reads || []).map((r) => `${r.pattern}@${r.gen}${r.once ? ' (this section only)' : ''} = ${r.text}`).join('\n');
  return text ? { text, title, section: play.section } : null;
}

/** A name to show for a program: `#! name:` in its text, else a short first comment, else "BeatScript <short cid>". */
export function programName(text, cid) {
  const m = /^#!\s*name:\s*(.+)$/m.exec(text || '');
  if (m) return cleanName(m[1]) || (cid ? `BeatScript ${cid.slice(-6)}` : 'untitled');
  const c = /^#\s*([^!\n][^\n]{2,60})$/m.exec(text || '');
  if (c && !/^(intro|build|drop)/i.test(c[1])) return cleanName(c[1].trim().replace(/[:.]$/, ''));
  return cid ? `BeatScript ${cid.slice(-6)}` : 'untitled';
}

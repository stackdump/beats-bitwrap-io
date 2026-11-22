// The embed player's words (embed-player.js), pure so Node tests them: what the position line says from the runtime's
// status and the program's sections.

/** The section playing as `name n/m` (n counted from 1), from the song bar (1-based) and the sections ({name,start,bars}). */
export function sectionLabel(status, sections) {
  const st = status || {};
  const secs = Array.isArray(sections) ? sections : [];
  const bar = st.song_bar;
  if (bar != null && secs.length) {
    const i = secs.findIndex((s) => bar - 1 >= s.start && bar - 1 < s.start + s.bars);
    if (i >= 0) return `${secs[i].name} ${i + 1}/${secs.length}`;
  }
  return st.section ? String(st.section) : 'playing';
}

/** The bar as `bar n/m` within the section (the runtime's `section_bar`, 1-based), else the song's bar, else nothing. */
export function barLabel(status) {
  const st = status || {};
  if (st.section_bar != null) return st.section_bars ? `bar ${st.section_bar}/${st.section_bars}` : `bar ${st.section_bar}`;
  if (st.song_bar != null) return st.song_bars ? `bar ${st.song_bar}/${st.song_bars}` : `bar ${st.song_bar}`;
  return '';
}

/** The section's doc comment as the page's program block gives it (`section: [{name, description}]`, a `#` line above
 * the section in the shared text), for the section playing; '' when it has none. */
export function sectionDoc(status, sections, docs) {
  const st = status || {};
  const secs = Array.isArray(sections) ? sections : [];
  const list = Array.isArray(docs) ? docs : [];
  let name = st.section ? String(st.section) : '';
  const bar = st.song_bar;
  if (bar != null && secs.length) {
    const s = secs.find((x) => bar - 1 >= x.start && bar - 1 < x.start + x.bars);
    if (s) name = s.name;
  }
  if (!name) return '';
  const d = list.find((x) => x && x.name === name && typeof x.description === 'string');
  return d ? d.description : '';
}

/** Both, for a status; `idle` when nothing plays. */
export function positionModel(status, sections, playing) {
  if (!playing) return { sec: 'not playing', bar: '' };
  return { sec: sectionLabel(status, sections), bar: barLabel(status) };
}

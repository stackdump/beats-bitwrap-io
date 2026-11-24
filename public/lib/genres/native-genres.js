// The four genres only djwasm composes (djrust data/genres-native.json), as plain data: what the
// picker, the traits row, the feel puck and the share card need without loading the engine.
// The engine side is native.js.

/** Genres only the engine composes, in picker order. */
export const NATIVE_GENRES = ['acid', 'deephouse', 'electro', 'italo'];

export function isNativeGenre(name) {
    return NATIVE_GENRES.includes(name);
}

/** Picker labels. */
export const NATIVE_GENRE_LABELS = {
    acid: 'Acid',
    deephouse: 'Deep House',
    electro: 'Electro',
    italo: 'Italo Disco',
};

/**
 * What the traits row and the feel puck need for each (djrust data/genres-native.json, `genre`):
 * bpm, swing, humanize, syncopation, ghostNotes, plus the flags the JS genre table also keeps.
 */
export const NATIVE_GENRE_TRAITS = {
    acid:      { name: 'acid',      bpm: 125, swing: 10, humanize: 8,  syncopation: 0.3,  ghostNotes: 0.3 },
    deephouse: { name: 'deephouse', bpm: 122, swing: 15, humanize: 12, syncopation: 0.25, ghostNotes: 0.35 },
    electro:   { name: 'electro',   bpm: 118, swing: 8,  humanize: 6,  syncopation: 0.45, ghostNotes: 0.2 },
    italo:     { name: 'italo',     bpm: 120, swing: 0,  humanize: 5,  syncopation: 0.1,  ghostNotes: 0.15, tensionCurve: true },
};

/** Card colour and a position on the feel puck [energy, depth], for each. */
export const NATIVE_GENRE_COLORS = {
    acid: '#b6ff00', deephouse: '#2b6cb0', electro: '#00e5c7', italo: '#ff7ac8',
};
export const NATIVE_GENRE_FEEL = {
    acid: [0.70, 0.35], deephouse: [0.50, 0.62], electro: [0.60, 0.30], italo: [0.52, 0.70],
};

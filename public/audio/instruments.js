// The studio's instrument catalogue: the names a track's `instrument` may
// carry (mixer dropdown, shuffle, share overrides). The sound of each name is
// djrust's (djengine/data/instruments.json overlays, family-voice fallback by
// name); this file only lists them. The list is the one tone-engine.js had, so
// every existing share and saved project keeps a valid instrument name.
//
// internal/share/category_doc_test.go counts the entries below (one quoted
// name per line, four-space indent) against docs/control-category.svg.

export const INSTRUMENT_NAMES = [
    'piano',
    'electric-piano',
    'bass',
    'sub-bass',
    'acid',
    'reese',
    'lead',
    'square-lead',
    'pwm-lead',
    'supersaw',
    'hoover',
    'detuned-saw',
    'wobble-bass',
    'distorted-lead',
    'scream-lead',
    'rave-stab',
    'pad',
    'warm-pad',
    'strings',
    'dark-pad',
    'fm-bell',
    'marimba',
    'vibes',
    'organ',
    'clavinet',
    'pluck',
    'bright-pluck',
    'muted-pluck',
    'metallic',
    'noise-hit',
    'drums',
    'drums-breakbeat',
    'drums-cr78',
    'drums-v8',
    'drums-808',
    'drums-lofi',
    'brass',
    'trumpet',
    'flute',
    'sax',
    'choir',
    'sitar',
    'kalimba',
    'steel-drum',
    'music-box',
    'harpsichord',
    'acoustic-guitar',
    'electric-guitar',
    'distorted-guitar',
    'glass-pad',
    'tape-lead',
    'sync-lead',
    'rubber-bass',
    'talkbox',
    'duo-lead',
    'duo-bass',
    'am-bell',
    'am-pad',
    'big-saw',
    'edm-stab',
    'trance-lead',
    'edm-pluck',
    'drop-bass',
    'chiptune',
    'rave-organ',
    'laser',
    'wobble-lead',
    'screech',
    'fm-bass',
    'sine',
    'unbound',   // reserved: the net fires, nothing sounds (a stinger slot that only triggers macros)
];

// GM-style drum bus: channels 10–15 are drum roles (kick/snare/hihat/clap…),
// each on its own mixer strip. Same predicate as wave-engine/synth.js.
export function isDrumChannel(ch) {
    return ch >= 10 && ch <= 15;
}

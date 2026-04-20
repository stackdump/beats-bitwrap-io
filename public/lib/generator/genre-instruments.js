// Genre-specific instrument mappings (channel → instrument name). Consumed
// by the generator when producing a default project so each genre has a
// recognizable sonic fingerprint out of the box.

export const GENRE_INSTRUMENTS = {
    'techno': { 4: 'supersaw', 5: 'pluck', 6: 'acid', 10: 'drums' },
    'house':  { 4: 'electric-piano', 5: 'bright-pluck', 6: 'bass', 10: 'drums' },
    'jazz':   { 4: 'vibes', 5: 'pluck', 6: 'sub-bass', 10: 'drums-cr78' },
    'ambient':{ 4: 'warm-pad', 5: 'fm-bell', 6: 'sub-bass', 10: 'drums' },
    'dnb':    { 4: 'square-lead', 5: 'bright-pluck', 6: 'reese', 10: 'drums-breakbeat' },
    'edm':    { 4: 'supersaw', 5: 'bright-pluck', 6: 'acid', 10: 'drums' },
    'speedcore': { 4: 'scream-lead', 5: 'pluck', 6: 'acid', 10: 'drums-v8' },
    'dubstep': { 4: 'detuned-saw', 5: 'rave-stab', 6: 'wobble-bass', 10: 'drums-v8' },
};

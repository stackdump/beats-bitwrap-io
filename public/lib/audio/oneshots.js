// One-shot instrument catalog + tone-shaping dropdown tables.
// Values are raw engine params so they can be forwarded to
// `toneEngine.playOneShot` / `playOneShotInstrument` without remapping.
//
// kind='custom': routed to toneEngine.playOneShot (hardcoded airhorn/laser/…)
// kind='note':   routed to toneEngine.playOneShotInstrument which spins up a
//                throwaway synth instance, runs it through the one-shot chain,
//                and disposes after the tail. `note` is the default MIDI pitch
//                the Pitch dropdown transposes from.

export const ONESHOT_INSTRUMENTS = [
    // --- Stingers / FX ---
    { id: 'airhorn', label: 'Airhorn',   kind: 'custom', group: 'Stingers' },
    { id: 'laser',   label: 'Laser',     kind: 'custom', group: 'Stingers' },
    { id: 'subdrop', label: 'Subdrop',   kind: 'custom', group: 'Stingers' },
    { id: 'booj',    label: 'Booj',      kind: 'custom', group: 'Stingers' },
    // --- Drum kits (note = kick voice; pitch shifts to 38=snare, 42=hat, etc.) ---
    { id: 'drums',           label: 'Kit Std',      kind: 'note', note: 36, group: 'Drums' },
    { id: 'drums-808',       label: 'Kit 808',      kind: 'note', note: 36, group: 'Drums' },
    { id: 'drums-cr78',      label: 'Kit CR-78',    kind: 'note', note: 36, group: 'Drums' },
    { id: 'drums-v8',        label: 'Kit V8',       kind: 'note', note: 36, group: 'Drums' },
    { id: 'drums-breakbeat', label: 'Kit Break',    kind: 'note', note: 36, group: 'Drums' },
    { id: 'drums-lofi',      label: 'Kit Lo-Fi',    kind: 'note', note: 36, group: 'Drums' },
    // --- Pitched percussion / bells ---
    { id: 'fm-bell',    label: 'FM Bell',     kind: 'note', note: 72, group: 'Percussion' },
    { id: 'am-bell',    label: 'AM Bell',     kind: 'note', note: 72, group: 'Percussion' },
    { id: 'marimba',    label: 'Marimba',     kind: 'note', note: 60, group: 'Percussion' },
    { id: 'vibes',      label: 'Vibes',       kind: 'note', note: 60, group: 'Percussion' },
    { id: 'kalimba',    label: 'Kalimba',     kind: 'note', note: 67, group: 'Percussion' },
    { id: 'steel-drum', label: 'Steel Drum',  kind: 'note', note: 60, group: 'Percussion' },
    { id: 'music-box',  label: 'Music Box',   kind: 'note', note: 72, group: 'Percussion' },
    { id: 'metallic',   label: 'Metallic',    kind: 'note', note: 60, group: 'Percussion' },
    { id: 'noise-hit',  label: 'Noise Hit',   kind: 'note', note: 60, group: 'Percussion' },
    // --- Stabs / Plucks ---
    { id: 'rave-stab',   label: 'Rave Stab',   kind: 'note', note: 60, group: 'Stabs' },
    { id: 'edm-stab',    label: 'EDM Stab',    kind: 'note', note: 60, group: 'Stabs' },
    { id: 'hoover',      label: 'Hoover',      kind: 'note', note: 48, group: 'Stabs' },
    { id: 'pluck',       label: 'Pluck',       kind: 'note', note: 60, group: 'Stabs' },
    { id: 'bright-pluck',label: 'Bright Pluck',kind: 'note', note: 60, group: 'Stabs' },
    { id: 'muted-pluck', label: 'Muted Pluck', kind: 'note', note: 60, group: 'Stabs' },
    { id: 'edm-pluck',   label: 'EDM Pluck',   kind: 'note', note: 60, group: 'Stabs' },
    { id: 'chiptune',    label: 'Chiptune',    kind: 'note', note: 60, group: 'Stabs' },
    // --- Bass hits ---
    { id: '808-bass',  label: '808 Hit',   kind: 'note', note: 36, group: 'Bass' },
    { id: 'sub-bass',  label: 'Sub Hit',   kind: 'note', note: 36, group: 'Bass' },
    { id: 'drop-bass', label: 'Drop Bass', kind: 'note', note: 36, group: 'Bass' },
    { id: 'fm-bass',   label: 'FM Bass',   kind: 'note', note: 36, group: 'Bass' },
];

export function oneShotSpec(id) {
    return ONESHOT_INSTRUMENTS.find(o => o.id === id) || null;
}

// Prettify an instrument id for display when it isn't in ONESHOT_INSTRUMENTS.
// "drums-v8" → "Drums V8", "fm-bass" → "Fm Bass".
export function prettifyInstrumentName(id) {
    if (!id) return '';
    return id.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

export const ONESHOT_HP  = [[0, 'HP Off'], [80, 'HP 80'], [200, 'HP 200'], [500, 'HP 500'], [1500, 'HP 1.5k']];
export const ONESHOT_LP  = [[20000, 'LP Open'], [8000, 'LP 8k'], [3000, 'LP 3k'], [1000, 'LP 1k'], [400, 'LP 400']];
export const ONESHOT_Q   = [[0.5, 'Q1'], [2, 'Q2'], [5, 'Q3'], [12, 'Q4'], [25, 'Q5']];
export const ONESHOT_ATK = [[0, 'A 0'], [30, 'A 30'], [80, 'A 80'], [200, 'A 200'], [500, 'A 500']];
export const ONESHOT_DEC = [[0, 'D Off'], [200, 'D 200'], [500, 'D 500'], [1200, 'D 1.2s'], [3000, 'D 3s']];

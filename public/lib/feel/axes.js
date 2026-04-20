// Feel bar — 4 abstract axes. Each slider is 0–100 (default 50). On change
// we compute a deterministic mapping onto three surfaces:
//   1) Master FX sliders (applied immediately via host._setFxValue)
//   2) Auto-DJ knobs (applied immediately to the panel form elements)
//   3) Trait overrides (stashed on host._traitOverrides; applied on next
//      Generate click — we don't auto-Generate on every slider wiggle).
//
// Mapping is `lerp(min, max, v/100)` or a threshold — kept in data rather
// than inline so users can see "what does Chop do" at a glance in source.
//
// Effect classification:
//   live    = applies the moment you move the slider (FX, Auto-DJ, tempo)
//   pending = takes effect only on the next Generate (trait overrides
//             consumed by the composer). The modal surfaces these so users
//             know which Feel changes need a regenerate to fully land.

export const FEEL_AXES = [
    { id: 'energy', label: 'Energy', tip: 'Tempo, drum fills, distortion, Auto-DJ cadence',
      live: 'BPM, distortion, Auto-DJ rate', pending: 'drum-fills, tension-curve' },
    { id: 'groove', label: 'Groove', tip: 'Swing, humanize, ghost notes, syncopation',
      live: '',  pending: 'swing, humanize, syncopation, ghost-notes, walking-bass' },
    { id: 'chop',   label: 'Chop',   tip: 'Stack size, bit-crush, delay feedback, Auto-DJ mute pool weight',
      live: 'bit-crush, delay feedback, Auto-DJ stack+pools', pending: '' },
    { id: 'space',  label: 'Space',  tip: 'Reverb wet, delay wet, low-pass opening, decay tails',
      live: 'reverb, delay, LP cutoff, reverb damp', pending: '' },
];

export const FEEL_MAP = {
    // v is 0..100. Each axis also reads sibling axes via host._feelState for
    // cross-axis synergy (e.g. high Energy + high Chop pushes Mute-group
    // macros so the Auto-DJ actually chops rather than just stacks).
    energy: (v, host) => {
        const norm = v / 100;
        host._setFxByKey('distortion', Math.round(norm * 45));
        const rateBars = v < 25 ? 8 : v < 50 ? 4 : v < 75 ? 2 : 1;
        host._setAutoDjValue('rate', rateBars);
        host._traitOverrides['drum-fills']    = v > 60;
        host._traitOverrides['tension-curve'] = v > 40;
        // Tempo: scale genre's base BPM ±25% around Energy=50. Genre base is
        // looked up live from the select so switching genres mid-set doesn't
        // leave tempo locked to the old base.
        const genreKey = host.querySelector('.pn-genre-select')?.value;
        const baseBpm = host._genreData?.[genreKey]?.bpm || host._tempo || 120;
        const bpm = Math.round(baseBpm * (0.75 + norm * 0.5));
        host._setTempo(Math.max(40, Math.min(220, bpm)));
    },
    groove: (v, host) => {
        const norm = v / 100;
        host._traitOverrides['syncopation']  = +(norm * 0.6).toFixed(2);
        host._traitOverrides['ghost-notes']  = +(norm * 0.8).toFixed(2);
        host._traitOverrides['walking-bass'] = v > 55;
        // Swing & humanize are the dominant groove levers at the generator
        // level — without them Groove only changes rhythmic content, not
        // timing feel. Generator reads swing as 0..60 and humanize as 0..40.
        host._traitOverrides['swing']        = Math.round(norm * 55);
        host._traitOverrides['humanize']     = Math.round(norm * 35);
    },
    chop: (v, host) => {
        const norm = v / 100;
        host._setFxByKey('crush-bits',    Math.round(norm * 60));
        host._setFxByKey('delay-feedback', Math.round(25 + norm * 50));
        const stack = v < 33 ? 1 : v < 66 ? 2 : 3;
        host._setAutoDjValue('stack', stack);
        // Bias the Auto-DJ pool set: at Chop > 50 force the Mute pool on so
        // the performer reaches for Beat Repeat / Cut / Drop. At Chop > 75
        // also pull in FX (bit-crush fires / delay throws).
        const panel = host.querySelector('.pn-autodj-panel');
        if (panel) {
            const setPool = (name, on) => {
                const cb = panel.querySelector(`.pn-autodj-pool[value="${name}"]`);
                if (cb) cb.checked = on;
            };
            if (v > 50) setPool('Mute', true);
            if (v > 75) setPool('FX', true);
        }
    },
    space: (v, host) => {
        const norm = v / 100;
        host._setFxByKey('reverb-wet',  Math.round(20 + norm * 60));
        host._setFxByKey('reverb-size', Math.round(50 + norm * 45));
        host._setFxByKey('delay-wet',   Math.round(15 + norm * 55));
        // Wider LP range so max Space audibly closes the mix into a
        // muffled, distant room. Prior 15-point window was imperceptible.
        host._setFxByKey('lp-freq',     Math.round(100 - norm * 40));
        // Cross-axis: when Space is high AND Energy low, damp the reverb so
        // it reads "ambient" rather than "cavernous wash". When Energy is
        // also high, keep damping low for wet shimmer.
        const energy = host._feelState?.energy ?? 50;
        const damp = Math.round(30 + (1 - energy / 100) * norm * 50);
        host._setFxByKey('reverb-damp', Math.max(10, Math.min(90, damp)));
    },
};

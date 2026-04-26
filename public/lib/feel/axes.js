// Feel — XY morph pad with two orthogonal axes:
//   X = tone (left = dark / LP closed; right = bright / LP open)
//   Y = BPM  (bottom = slow; top = fast, relative to project base)
//
//   TL (0,1) Dark/Fast     TR (1,1) Bright/Fast
//   ┌──────────────────────┐
//   │                      │
//   │        (puck)        │
//   │                      │
//   └──────────────────────┘
//   BL (0,0) Dark/Slow     BR (1,0) Bright/Slow
//
// Each corner only changes tone and BPM — clean two-axis control
// instead of the previous Alchemy-style multi-parameter morph.
// Releasing the puck resets it to its pre-grab position so dragging
// is a temporary modulation, not a destructive setter.

export const CORNERS = [
    { id: 'dark-slow',   name: 'Dark / Slow',   x: 0, y: 0, bpmMult: 0.6, lpFreq:  50 },
    { id: 'bright-slow', name: 'Bright / Slow', x: 1, y: 0, bpmMult: 0.6, lpFreq: 100 },
    { id: 'dark-fast',   name: 'Dark / Fast',   x: 0, y: 1, bpmMult: 1.4, lpFreq:  50 },
    { id: 'bright-fast', name: 'Bright / Fast', x: 1, y: 1, bpmMult: 1.4, lpFreq: 100 },
];

// Corner colors match the marker palette used by earlier triangle iteration
// so the UI keeps a visual identity across revisions.
export const CORNER_COLORS = ['#ff6b9d', '#6ad3ff', '#ffd36a', '#a58aff'];

export const DEFAULT_PUCK = [0.5, 0.5];

// Hand-curated genre "constellation" — where each genre's default vibe
// lives inside the Feel square. X tracks tempo/drive (low BPM → left,
// high BPM → right). Y tracks ambience (dry/tight → bottom,
// wet/atmospheric → top). These are defaults, not constraints — the
// user can still drag the puck anywhere.
export const GENRE_FEEL_POSITIONS = {
    ambient:   [0.10, 0.90],
    lofi:      [0.20, 0.65],
    reggae:    [0.15, 0.22],
    bossa:     [0.22, 0.50],
    blues:     [0.25, 0.38],
    country:   [0.30, 0.20],
    jazz:      [0.32, 0.55],
    synthwave: [0.45, 0.72],
    funk:      [0.50, 0.32],
    house:     [0.55, 0.42],
    techno:    [0.65, 0.25],
    garage:    [0.62, 0.48],
    edm:       [0.72, 0.62],
    trap:      [0.78, 0.40],
    trance:    [0.78, 0.82],
    dubstep:   [0.82, 0.52],
    dnb:       [0.90, 0.55],
    metal:     [0.92, 0.18],
    speedcore: [0.98, 0.08],
};

export function clampPuck([x, y]) {
    const cx = Math.max(0, Math.min(1, Number.isFinite(+x) ? +x : 0.5));
    const cy = Math.max(0, Math.min(1, Number.isFinite(+y) ? +y : 0.5));
    return [cx, cy];
}

export function sanitizePuck(p) {
    if (!Array.isArray(p) || p.length !== 2) return [...DEFAULT_PUCK];
    return clampPuck(p);
}

// Bilinear corner weights. Corners indexed as in CORNERS above:
// [DarkSlow(BL), BrightSlow(BR), DarkFast(TL), BrightFast(TR)].
export function cornerWeights([x, y]) {
    return [
        (1 - x) * (1 - y),
        x       * (1 - y),
        (1 - x) * y,
        x       * y,
    ];
}

// Blend the two snapshot fields at the puck position. X axis is
// tone (lpFreq), Y axis is BPM (bpmMult). Other live parameters
// (FX, swing, humanize, Auto-DJ) stay where the user set them.
export function blendCorners(puck) {
    const w = cornerWeights(puck);
    const out = {};
    for (const k of ['bpmMult', 'lpFreq']) {
        out[k] = CORNERS[0][k]*w[0] + CORNERS[1][k]*w[1] + CORNERS[2][k]*w[2] + CORNERS[3][k]*w[3];
    }
    out.weights = w;
    return out;
}

// Push the blended parameters onto the live surfaces. No regenerate.
export function applyFeelGrid(el, puck) {
    const p = sanitizePuck(puck);
    const b = blendCorners(p);

    const genreKey = el.querySelector('.pn-genre-select')?.value;
    const baseBpm = el._genreData?.[genreKey]?.bpm || el._tempo || 120;
    const bpm = Math.round(baseBpm * b.bpmMult);
    el._setTempo(Math.max(40, Math.min(300, bpm)));

    el._setFxByKey('lp-freq', Math.round(b.lpFreq));
}

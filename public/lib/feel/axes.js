// Feel — XY morph pad with four corner snapshots (Alchemy-style).
//
// The user drags a single puck inside a [0..1] × [0..1] square. Its
// position bilinearly blends four full parameter snapshots sitting at
// the corners. The blended values drive tempo, master FX, Auto-DJ,
// swing, and humanize in place — no regenerate. This mirrors the
// Transform Pad / Morpher pattern from Logic Alchemy and NI Massive X.
//
//   TL (0,1) Ambient       TR (1,1) Euphoric
//   ┌──────────────────────┐
//   │                      │
//   │        (puck)        │
//   │                      │
//   └──────────────────────┘
//   BL (0,0) Chill         BR (1,0) Drive
//
// Each corner is a full snapshot — everything a live performance
// surface can express at once. Moving the puck blends every parameter
// simultaneously via bilinear weights.

export const CORNERS = [
    { id: 'chill',    name: 'Chill',    x: 0, y: 0,
      bpmMult: 0.78, distortion: 0,  crushBits: 0,
      reverbWet: 25, reverbSize: 55, reverbDamp: 65, delayWet: 15, delayFeedback: 25,
      lpFreq: 95,
      autoDjRate: 8, autoDjStack: 1,
      swing: 35, humanize: 25 },
    { id: 'drive',    name: 'Drive',    x: 1, y: 0,
      bpmMult: 1.28, distortion: 45, crushBits: 45,
      reverbWet: 20, reverbSize: 50, reverbDamp: 40, delayWet: 15, delayFeedback: 60,
      lpFreq: 100,
      autoDjRate: 1, autoDjStack: 3,
      swing: 0,  humanize: 5 },
    { id: 'ambient',  name: 'Ambient',  x: 0, y: 1,
      bpmMult: 0.78, distortion: 0,  crushBits: 15,
      reverbWet: 80, reverbSize: 95, reverbDamp: 78, delayWet: 70, delayFeedback: 55,
      lpFreq: 60,
      autoDjRate: 8, autoDjStack: 1,
      swing: 55, humanize: 35 },
    { id: 'euphoric', name: 'Euphoric', x: 1, y: 1,
      bpmMult: 1.20, distortion: 35, crushBits: 50,
      reverbWet: 70, reverbSize: 85, reverbDamp: 30, delayWet: 60, delayFeedback: 70,
      lpFreq: 70,
      autoDjRate: 1, autoDjStack: 3,
      swing: 10, humanize: 15 },
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
// [Chill(BL), Drive(BR), Ambient(TL), Euphoric(TR)].
export function cornerWeights([x, y]) {
    return [
        (1 - x) * (1 - y),
        x       * (1 - y),
        (1 - x) * y,
        x       * y,
    ];
}

// Blend every numeric snapshot field at the puck position.
export function blendCorners(puck) {
    const w = cornerWeights(puck);
    const keys = ['bpmMult','distortion','crushBits','reverbWet','reverbSize','reverbDamp','delayWet','delayFeedback','lpFreq','swing','humanize','autoDjRate','autoDjStack'];
    const out = {};
    for (const k of keys) {
        out[k] = CORNERS[0][k]*w[0] + CORNERS[1][k]*w[1] + CORNERS[2][k]*w[2] + CORNERS[3][k]*w[3];
    }
    // Snap Auto-DJ bar counts to valid discrete values (1, 2, 4, 8 bars).
    out.autoDjRate  = out.autoDjRate  < 1.5 ? 1 : out.autoDjRate  < 3 ? 2 : out.autoDjRate  < 6 ? 4 : 8;
    out.autoDjStack = out.autoDjStack < 1.5 ? 1 : out.autoDjStack < 2.5 ? 2 : 3;
    // Auto-DJ pool enables follow the "driving" half of the pad —
    // Mute pool on the right side, FX pool near the right/top corner.
    out.autoDjMutePool = (w[1] + w[3]) > 0.5;
    out.autoDjFxPool   = (w[1] + w[3]) > 0.7;
    out.weights = w;
    return out;
}

// Push every blended parameter onto the live surfaces. No regenerate.
export function applyFeelGrid(el, puck) {
    const p = sanitizePuck(puck);
    const b = blendCorners(p);

    const genreKey = el.querySelector('.pn-genre-select')?.value;
    const baseBpm = el._genreData?.[genreKey]?.bpm || el._tempo || 120;
    const bpm = Math.round(baseBpm * b.bpmMult);
    el._setTempo(Math.max(40, Math.min(220, bpm)));

    el._setFxByKey('distortion',     Math.round(b.distortion));
    el._setFxByKey('crush-bits',     Math.round(b.crushBits));
    el._setFxByKey('reverb-wet',     Math.round(b.reverbWet));
    el._setFxByKey('reverb-size',    Math.round(b.reverbSize));
    el._setFxByKey('reverb-damp',    Math.max(10, Math.min(90, Math.round(b.reverbDamp))));
    el._setFxByKey('delay-wet',      Math.round(b.delayWet));
    el._setFxByKey('delay-feedback', Math.round(b.delayFeedback));
    el._setFxByKey('lp-freq',        Math.round(b.lpFreq));

    el._setAutoDjValue('rate',  b.autoDjRate);
    el._setAutoDjValue('stack', b.autoDjStack);
    const panel = el.querySelector('.pn-autodj-panel');
    if (panel) {
        const setPool = (name, on) => {
            const cb = panel.querySelector(`.pn-autodj-pool[value="${name}"]`);
            if (cb) cb.checked = on;
        };
        setPool('Mute', b.autoDjMutePool);
        setPool('FX',   b.autoDjFxPool);
    }

    el._swing    = Math.max(0, Math.min(100, Math.round(b.swing)));
    el._humanize = Math.max(0, Math.min(100, Math.round(b.humanize)));
    if (el._project) {
        el._project.swing    = el._swing;
        el._project.humanize = el._humanize;
    }
}

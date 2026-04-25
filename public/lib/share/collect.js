// State collectors (DOM / in-memory → plain objects). Each exported
// function takes the custom element (`el`) and returns a serializable
// slice of the live track state. Consumed by `buildSharePayload()` to
// produce the canonical share-v1 envelope.
//
// Extracted from petri-note.js (Phase A.2). The class keeps one-line
// wrapper methods so any `el._collectFxState()` call site still works.

const SHARE_CONTEXT = 'https://beats.bitwrap.io/schema/beats-share.context.jsonld';

export function collectFxState(el) {
    const fx = {};
    el.querySelectorAll('.pn-effects-panel .pn-fx-slider').forEach(s => {
        fx[s.dataset.fx] = parseInt(s.value);
    });
    if (el._fxBypassed) fx._bypassed = true;
    return fx;
}

export function collectFeelState(el) {
    return {
        engaged: !el._feelDisengaged,
        sliders: el._feelState ? { ...el._feelState } : {},
    };
}

export function collectAutoDjState(el) {
    const panel = el.querySelector('.pn-autodj-panel');
    if (!panel) return null;
    const pools = {};
    for (const cb of panel.querySelectorAll('.pn-autodj-pool')) pools[cb.value] = cb.checked;
    // Coerce <select>.value strings to ints so the share payload hits the
    // schema's integer typing (and keeps CIDs stable across sessions —
    // "2" vs 2 would otherwise hash to different bytes).
    const intOr = (node, fallback) => {
        const n = parseInt(node?.value, 10);
        return Number.isFinite(n) ? n : fallback;
    };
    return {
        showAutoDj:  !!el._showAutoDj,
        run:         !!panel.querySelector('.pn-autodj-enable')?.checked,
        animateOnly: !!panel.querySelector('.pn-autodj-animate-only')?.checked,
        rate:        intOr(panel.querySelector('.pn-autodj-rate'),  2),
        regen:       intOr(panel.querySelector('.pn-autodj-regen'), 0),
        stack:       intOr(panel.querySelector('.pn-autodj-stack'), 1),
        pools,
    };
}

export function collectDisabledMacros(el) {
    el._disabledMacros = el._disabledMacros || el._loadDisabledMacros();
    return [...el._disabledMacros];
}

// Per-channel track overrides (mix + instrument + generator recipe).
// Keyed by channel number — stable across regens even when netIds shift.
export function collectTrackOverrides(el) {
    const out = {};
    const nets = el._project?.nets || {};
    for (const [, net] of Object.entries(nets)) {
        if (net.role === 'control') continue;
        const ch = net.track?.channel;
        if (ch == null) continue;
        let mixRow = null;
        const rows = el._mixerEl?.querySelectorAll('.pn-mixer-row');
        if (rows) {
            for (const r of rows) {
                const nid = r.dataset.netId;
                if (nid && nets[nid]?.track?.channel === ch) { mixRow = r; break; }
            }
        }
        const mix = {};
        if (mixRow) {
            const v = (cls) => mixRow.querySelector(`.${cls}`)?.value;
            const parse = (x) => (x == null ? null : parseInt(x));
            const pairs = [
                ['volume', 'pn-mixer-vol'],
                ['pan',    'pn-mixer-pan'],
                ['loCut',  'pn-mixer-locut'],
                ['loResonance', 'pn-mixer-loreso'],
                ['cutoff', 'pn-mixer-cutoff'],
                ['resonance', 'pn-mixer-reso'],
                ['decay',  'pn-mixer-decay'],
            ];
            for (const [k, cls] of pairs) {
                const n = parse(v(cls));
                if (n != null && !Number.isNaN(n)) mix[k] = n;
            }
        } else if (net.track?.mix) {
            Object.assign(mix, net.track.mix);
        }
        const entry = {};
        if (Object.keys(mix).length) entry.mix = mix;
        if (net.track?.instrument) entry.instrument = net.track.instrument;
        if (net.track?.instrumentSet) entry.instrumentSet = net.track.instrumentSet;
        if (net.track?.generator) entry.generator = net.track.generator;
        if (net.track?.generatorParams) entry.generatorParams = net.track.generatorParams;
        if (Object.keys(entry).length) out[String(ch)] = entry;
    }
    return out;
}

export function collectInitialMutes(el) {
    return Array.isArray(el._project?.initialMutes) ? [...el._project.initialMutes] : [];
}

// Per-hit Fire pad config (bars, pitch, paired FX). Keyed by hit slot
// id so a v2 Beats panel that adds/removes slots doesn't scramble the
// mapping.
export function collectHitState(el) {
    const out = {};
    for (const id of ['hit1', 'hit2', 'hit3', 'hit4']) {
        if (!el._project?.nets?.[id]) continue;
        const bars  = parseInt(el.querySelector(`.pn-os-bars[data-macro="${id}"]`)?.value, 10);
        const pitch = parseInt(el.querySelector(`.pn-os-pitch[data-macro="${id}"]`)?.value, 10);
        const pair  = el.querySelector(`.pn-os-pair[data-macro="${id}"]`)?.value || '';
        const entry = {};
        if (Number.isFinite(bars) && bars !== 2) entry.bars = bars;   // 2 is default
        if (Number.isFinite(pitch) && pitch !== 0) entry.pitch = pitch; // 0 is default
        if (pair) entry.pair = pair;
        if (Object.keys(entry).length) out[id] = entry;
    }
    return out;
}

// Loop / crop region — shared only when the user has narrowed it away
// from the full track range. Full-range (0 … totalSteps) is the
// default and would just bloat every payload.
export function collectLoopRegion(el) {
    const start = el._loopStart;
    const end   = el._loopEnd;
    const total = el._totalSteps;
    if (!Number.isFinite(start) || !Number.isFinite(end) || !total) return null;
    if (start <= 0 && end >= total) return null;
    return { startTick: start, endTick: end };
}

// Non-mix UI state that still affects the listening experience —
// playback mode (single/repeat/shuffle) + which side panels are open.
export function collectUiState(el) {
    const out = {};
    if (el._playbackMode && el._playbackMode !== 'single') out.playbackMode = el._playbackMode;
    if (el._showFx === false) out.showFx = false;           // FX panel defaults open
    if (el._showMacros) out.showMacros = true;
    if (el._showOneShots) out.showOneShots = true;
    return out;
}

// Build the `share-v1` JSON-LD payload from the live UI + project.
// Reproducibility contract: genre + params regenerate nets; overrides
// carry everything not reconstructible from the recipe alone.
export function buildSharePayload(el) {
    const cur = el._currentGen;
    const genre = cur?.genre || el.querySelector('.pn-genre-select')?.value || 'techno';
    const params = { ...(cur?.params || {}) };
    // Bars is stamped on the project by the composer (1 for loop mode;
    // sum(structure.steps)/16 for song mode). Fall back to the structure
    // sum if the field is missing (older projects mid-migration).
    let bars = el._project?.bars;
    if (bars == null) {
        const structureArr = Array.isArray(el._project?.structure) ? el._project.structure : [];
        const totalSteps = structureArr.reduce((s, sec) => s + (sec?.steps || 0), 0);
        bars = Math.max(0, Math.round(totalSteps / 16));
    }

    const payload = {
        '@context': SHARE_CONTEXT,
        '@type': 'BeatsShare',
        v: 1,
        genre,
        seed: typeof params.seed === 'number' ? params.seed : null,
        tempo: el._project?.tempo ?? el._tempo ?? 120,
        swing: el._project?.swing ?? 0,
        humanize: el._project?.humanize ?? 0,
        rootNote: el._project?.rootNote ?? null,
        scaleName: el._project?.scaleName ?? null,
        bars,
        structure: params.structure || el.querySelector('.pn-structure-select')?.value || null,
    };
    // Composer mints names like "techno · Crystal Ember" onto _project.name.
    // Sealing them into the envelope means the feed and player can show the
    // human label instead of "{genre} · {seed}". Skip pure "Untitled" /
    // "{genre}" defaults so they don't bloat hand-authored shares.
    const projName = (el._project?.name || '').trim();
    if (projName && projName !== 'Untitled' && projName.toLowerCase() !== genre) {
        payload.name = projName.slice(0, 60);
    }
    const traits = {};
    for (const [k, v] of Object.entries(params)) {
        if (k === 'seed' || k === 'structure') continue;
        traits[k] = v;
    }
    if (Object.keys(traits).length) payload.traits = traits;
    const tracks = collectTrackOverrides(el);
    if (Object.keys(tracks).length) payload.tracks = tracks;
    const fx = collectFxState(el);
    if (Object.keys(fx).length) payload.fx = fx;
    const feel = collectFeelState(el);
    if (feel.engaged || Object.keys(feel.sliders).length) payload.feel = feel;
    const autoDj = collectAutoDjState(el);
    if (autoDj) payload.autoDj = autoDj;
    const disabled = collectDisabledMacros(el);
    if (disabled.length) payload.macrosDisabled = disabled;
    const mutes = collectInitialMutes(el);
    if (mutes.length) payload.initialMutes = mutes;
    const hits = collectHitState(el);
    if (Object.keys(hits).length) payload.hits = hits;
    const ui = collectUiState(el);
    if (Object.keys(ui).length) payload.ui = ui;
    const loop = collectLoopRegion(el);
    if (loop) payload.loop = loop;
    // Hand-authored escape hatch: when there's no (genre, seed) recipe to
    // reconstruct from, dump the raw nets so the share URL round-trips
    // the literal petri net authoring. Inflates the URL (≈10-100 kB
    // post-gzip depending on size) but is the only way to share tracks
    // that came in via POST /api/project or were post-edited past the
    // point where `tracks`/`fx` overrides can re-derive them.
    if (!el._currentGen && el._project?.nets && Object.keys(el._project.nets).length) {
        payload.nets = el._project.nets;
    }
    return payload;
}

// Macros runtime — the main-thread half of the live-performance macro
// pipeline: musicNets iterator, firing + executing catalog entries,
// serial queue + badges, one-shot row controls, macro-disable toggle,
// Auto-DJ tick loop (cadence + regen prefetch + transition injection),
// and ring-spin animation.
//
// Extracted from petri-note.js. Each function takes the element (`el`)
// as first argument; petri-note.js keeps one-line class-method wrappers
// so call sites like `el._fireMacro(id)` are unchanged.

import { toneEngine } from '../../audio/tone-engine.js';
import { MACROS, TRANSITION_MACRO_IDS } from './catalog.js';
import { oneShotSpec } from '../audio/oneshots.js';

// Slider keys tracked by the tone reset/nav/save machinery. Pitch/Hits/
// Instrument stay outside — they're semantic params, not tone.
export const ONESHOT_SLIDER_KEYS = [
    ['pn-os-vol', 80],
    ['pn-os-hp',  0],
    ['pn-os-hpr', 0],
    ['pn-os-lp',  100],
    ['pn-os-lpr', 0],
    ['pn-os-atk', 0],
    ['pn-os-dec', 0],
];

// --- Music nets iterator ---

export function musicNets(el) {
    const out = [];
    for (const [id, net] of Object.entries(el._project?.nets || {})) {
        if (net.role === 'control') continue;
        out.push([id, net]);
    }
    return out;
}

// --- Panic: cancel every pending / in-flight macro effect ---

export function panicMacros(el) {
    // 1. Drop queued macros; they never fire.
    el._macroQueue = [];
    el._runningMacro = null;
    if (el._runningTimer) { clearTimeout(el._runningTimer); el._runningTimer = null; }

    // 2. Break any beat-repeat loop — the token guard exits on next tick.
    el._beatRepeatRuns = (el._beatRepeatRuns || 0) + 1;

    // 2b. Clear any compound-macro delayed sub-fires still pending.
    if (el._compoundTimers) {
        for (const t of el._compoundTimers) clearTimeout(t);
        el._compoundTimers = [];
    }

    // 2c. Tempo: if a tempo-hold / tempo-sweep is running, cancel + snap
    //     back to its captured start BPM instead of waiting for the
    //     setTimeout / sweep to finish.
    if (el._tempoAnim) {
        const tok = el._tempoAnim;
        tok.cancelled = true;
        if (tok.timeout) clearTimeout(tok.timeout);
        if (typeof tok.startBpm === 'number') el._setTempo(tok.startBpm);
        el._tempoAnim = null;
    }

    // 3. Cancel + restore every in-flight channel param animation
    //    (pan-move / decay-move).
    if (el._chanAnim) {
        for (const id of Object.keys(el._chanAnim)) {
            const t = el._chanAnim[id];
            if (!t) continue;
            if (t.hardStop) { clearTimeout(t.hardStop); }
            // Run restore manually via the stored snapshot.
            if (t.before) {
                for (const ch of Object.keys(t.before)) {
                    const v = t.before[ch];
                    const chNum = parseInt(ch, 10);
                    // Snapshot format differs by kind — decay is a scalar
                    // multiplier in roughly [0.05, 3.0]; pan is the raw
                    // panner.pan.value in [-1, +1].
                    if (v >= -1 && v <= 1) {
                        const cc = Math.max(0, Math.min(127, Math.round((v + 1) * 63.5)));
                        toneEngine.controlChange(chNum, 10, cc);
                    } else {
                        toneEngine.setChannelDecay(chNum, v);
                    }
                }
            }
            t.cancelled = true;
        }
        el._chanAnim = {};
    }

    // 4. Cancel every pulse token and strip its CSS.
    if (el._pulseAnim) {
        for (const id of Object.keys(el._pulseAnim)) {
            const t = el._pulseAnim[id];
            if (t) t.cancelled = true;
        }
        el._pulseAnim = {};
    }
    el.querySelectorAll('.pn-pulsing, .pn-pulsing-hot').forEach(node => {
        node.classList.remove('pn-pulsing', 'pn-pulsing-hot');
    });

    // 5. Cancel master-FX sweep/hold animations AND restore their slider
    //    to the pre-macro start value. Without the restore, the slider
    //    stays wherever the ramp was when we cancelled — "stranded
    //    reverb" etc.
    if (el._fxAnim) {
        for (const key of Object.keys(el._fxAnim)) {
            const t = el._fxAnim[key];
            if (!t) continue;
            t.cancelled = true;
            if (t.slider && typeof t.start === 'number') {
                el._setFxValue(t.slider, t.start);
            }
        }
        el._fxAnim = {};
    }

    // 6. Tell the worker to prune in-flight macro control nets, then
    //    unmute anything not in the user's manual mute set — but keep
    //    the project's schema-reserved `initialMutes` (hit1-hit4 stinger
    //    slots) muted. Without this guard, Panic unmutes the stinger
    //    tracks and the first beat after panic dumps four stingers onto
    //    the mix.
    el._sendWs({ type: 'cancel-macros' });
    const manual = el._manualMutedNets || new Set();
    const initial = new Set(el._project?.initialMutes || []);
    const muted = [...el._mutedNets];
    for (const id of muted) {
        if (manual.has(id) || initial.has(id)) continue;
        el._mutedNets.delete(id);
        el._sendWs({ type: 'mute', netId: id, muted: false });
    }

    // 7. Visual book-keeping — drop queue badges, reset serial slot UI.
    updateQueuedBadges(el);
    el.querySelectorAll('.pn-macro-btn.running, .pn-macro-btn.queued, .pn-macro-btn.firing')
        .forEach(b => b.classList.remove('running', 'queued', 'firing'));
    el.querySelectorAll('.pn-macro-queue-badge').forEach(b => b.remove());

    const statusEl = el.querySelector('.pn-autodj-status');
    if (statusEl && el.querySelector('.pn-autodj-enable')?.checked) {
        statusEl.textContent = '(panicked — cycle will resume)';
    }
}

// --- Fire + execute ---

export function fireMacro(el, id) {
    // Serial execution: if anything is running, push onto the FIFO queue.
    el._macroQueue ||= [];
    if (el._runningMacro) {
        el._macroQueue.push(id);
        updateQueuedBadges(el);
        return;
    }
    executeMacro(el, id);
}

export function executeMacro(el, id) {
    const macro = MACROS.find(m => m.id === id);
    if (!macro) return;
    const sel = el.querySelector(`.pn-macro-bars[data-macro="${id}"]`);
    const duration = parseInt(sel?.value, 10) || macro.defaultDuration;
    const durationTicks = macro.durationUnit === 'tick' ? duration : duration * 16;
    const msPerTick = el._msPerBar() / 16;
    const durationMs = durationTicks * msPerTick;

    if (macro.kind === 'mute') {
        const targets = macro.targets(el);
        if (targets.length > 0) {
            el._sendWs({
                type: 'fire-macro',
                macroId: `${id}-${Date.now().toString(36)}`,
                targets,
                durationTicks,
                muteAction: 'mute-track',
                restoreAction: 'unmute-track',
            });
            // Pulse the mute buttons of affected rows for the duration so
            // the mixer signals what the macro is touching.
            const muteEls = targets
                .map(tid => el._mixerEl?.querySelector(`.pn-mixer-row[data-net-id="${tid}"] .pn-mixer-mute`)
                         || el._mixerEl?.querySelector(`.pn-mixer-row[data-riff-group="${tid}"] .pn-mixer-mute`))
                .filter(Boolean);
            el._macroPulse(muteEls, durationMs, `mute:${id}`);
        }
    } else if (macro.kind === 'fx-sweep' || macro.kind === 'fx-hold') {
        const ops = macro.ops || [{ fxKey: macro.fxKey, toValue: macro.toValue }];
        for (const op of ops) {
            if (macro.kind === 'fx-sweep') el._fxSweep(op.fxKey, op.toValue, durationMs);
            else                           el._fxHold (op.fxKey, op.toValue, durationMs, macro.tailFrac);
        }
        // Pulse the affected FX sliders for the duration of the macro.
        const fxEls = ops.map(op => el._fxSlider(op.fxKey)).filter(Boolean);
        el._macroPulse(fxEls, durationMs, `fx:${id}`);
    } else if (macro.kind === 'pan-move' || macro.kind === 'decay-move') {
        el._channelParamMove(macro, durationMs);
    } else if (macro.kind === 'beat-repeat') {
        el._runBeatRepeat(macro, durationMs);
    } else if (macro.kind === 'compound') {
        el._runCompound(macro, duration, macro.durationUnit, msPerTick);
    } else if (macro.kind === 'tempo-hold') {
        el._tempoHold(macro.factor, durationMs);
    } else if (macro.kind === 'tempo-sweep') {
        el._tempoSweep(macro.finalBpm, durationMs);
    } else if (macro.kind === 'one-shot') {
        // Fire pad: route through the track's channel strip (so track vol
        // /pan/filters apply) and bypass the mute filter — so Fire still
        // works even when the stinger track starts muted.
        const pitchSel = el.querySelector(`.pn-os-pitch[data-macro="${id}"]`);
        const pitch = parseInt(pitchSel?.value, 10) || 0;
        const track = el._project?.nets?.[id];
        const channel = track?.track?.channel;
        const currentInst = track?.track?.instrument;
        el._ensureToneStarted().then(() => {
            if (currentInst === 'unbound') {
                // Silent slot — Fire still fires paired FX macros, but no sound
            } else if (channel != null) {
                toneEngine.playNote({ channel, note: 60 + pitch, velocity: 110, duration: 200 });
            } else {
                toneEngine.playOneShot(macro.sound, pitch);
            }
        });
        // Paired macro: fire the chosen FX macro alongside the sound.
        const pairSel = el.querySelector(`.pn-os-pair[data-macro="${id}"]`);
        const pairId = pairSel?.value;
        if (pairId && pairId !== id) {
            const savedRunning = el._runningMacro;
            el._runningMacro = null;        // bypass serial queue for this side-effect
            try { executeMacro(el, pairId); } finally { el._runningMacro = savedRunning; }
        }
    }

    const btn = el.querySelector(`.pn-macro-btn[data-macro="${id}"]`);
    if (btn) {
        btn.classList.add('firing');
        setTimeout(() => btn.classList.remove('firing'), 120);
    }
    // One-shots finish fast — budget ~700 ms per hit so the serial queue
    // doesn't release while stutters are still firing.
    const runTime = macro.kind === 'one-shot'
        ? 700 + Math.max(0, duration - 1) * (el._msPerBar() / 16)
        : durationMs;
    markMacroRunning(el, id, runTime);
}

// --- One-shot row: snapshot / apply / reset / nav / favorites ---

export function snapshotOneShot(el, macroId) {
    const snap = {};
    for (const [cls] of ONESHOT_SLIDER_KEYS) {
        const node = el.querySelector(`.${cls}[data-macro="${macroId}"]`);
        if (node) snap[cls] = parseFloat(node.value);
    }
    const inst = el.querySelector(`.pn-os-inst[data-macro="${macroId}"]`);
    if (inst) snap.inst = inst.value;
    const hits = el.querySelector(`.pn-os-hits[data-macro="${macroId}"]`);
    if (hits) snap.hits = hits.value;
    const pit  = el.querySelector(`.pn-os-pitch[data-macro="${macroId}"]`);
    if (pit)  snap.pitch = pit.value;
    return snap;
}

export function applyOneShotSnapshot(el, macroId, snap) {
    for (const [cls] of ONESHOT_SLIDER_KEYS) {
        const node = el.querySelector(`.${cls}[data-macro="${macroId}"]`);
        if (node && snap[cls] != null) node.value = snap[cls];
    }
    if (snap.inst != null) {
        const inst = el.querySelector(`.pn-os-inst[data-macro="${macroId}"]`);
        if (inst) {
            inst.value = snap.inst;
            const btn = el.querySelector(`.pn-os-fire[data-macro="${macroId}"]`);
            if (btn) btn.textContent = `Fire ${oneShotSpec(snap.inst)?.label || snap.inst}`;
        }
    }
    if (snap.hits != null) {
        const hits = el.querySelector(`.pn-os-hits[data-macro="${macroId}"]`);
        if (hits) hits.value = snap.hits;
    }
    if (snap.pitch != null) {
        const pit = el.querySelector(`.pn-os-pitch[data-macro="${macroId}"]`);
        if (pit) pit.value = snap.pitch;
    }
}

export function oneShotToneReset(el, macroId) {
    const snap = {};
    for (const [cls, def] of ONESHOT_SLIDER_KEYS) snap[cls] = def;
    applyOneShotSnapshot(el, macroId, snap);
    el._oneShotToneHistory ||= new Map();
    el._oneShotToneIndex   ||= new Map();
    el._oneShotToneHistory.set(macroId, [snap]);
    el._oneShotToneIndex.set(macroId, 0);
}

export function oneShotToneStep(el, macroId, dir) {
    el._oneShotToneHistory ||= new Map();
    el._oneShotToneIndex   ||= new Map();
    const hist = el._oneShotToneHistory.get(macroId) || [snapshotOneShot(el, macroId)];
    let idx = el._oneShotToneIndex.get(macroId) ?? (hist.length - 1);
    if (dir > 0) {
        // Generate a random mutation and append.
        const snap = {};
        for (const [cls] of ONESHOT_SLIDER_KEYS) {
            snap[cls] = Math.round(Math.random() * 100);
        }
        // Keep Vol sane (50–100) so randoms don't disappear.
        snap['pn-os-vol'] = 50 + Math.round(Math.random() * 50);
        hist.push(snap);
        idx = hist.length - 1;
    } else {
        idx = Math.max(0, idx - 1);
    }
    el._oneShotToneHistory.set(macroId, hist);
    el._oneShotToneIndex.set(macroId, idx);
    applyOneShotSnapshot(el, macroId, hist[idx]);
}

export function oneShotFavorite(el, macroId, ev) {
    const storeKey = 'pn-oneshot-favorites';
    const favs = JSON.parse(localStorage.getItem(storeKey) || '{}');
    const list = favs[macroId] || [];
    if (ev.shiftKey && list.length > 0) {
        // Shift-click → cycle through favorites.
        el._oneShotFavIdx ||= new Map();
        const idx = ((el._oneShotFavIdx.get(macroId) ?? -1) + 1) % list.length;
        el._oneShotFavIdx.set(macroId, idx);
        applyOneShotSnapshot(el, macroId, list[idx].snap);
        return;
    }
    if (list.length > 0 && !ev.altKey) {
        const names = list.map((f, i) => `${i+1}. ${f.name}`).join('\n');
        const choice = prompt(`Favorites for ${macroId}:\n${names}\n\nEnter number to load, 's' to save current, or blank to cancel:`, 's');
        if (!choice) return;
        if (choice === 's') {
            const name = prompt('Name this favorite:', list.length ? `${macroId}-${list.length + 1}` : macroId);
            if (!name) return;
            list.push({ name, snap: snapshotOneShot(el, macroId) });
            favs[macroId] = list;
            localStorage.setItem(storeKey, JSON.stringify(favs));
            return;
        }
        const n = parseInt(choice, 10);
        if (Number.isFinite(n) && n >= 1 && n <= list.length) {
            applyOneShotSnapshot(el, macroId, list[n - 1].snap);
        }
        return;
    }
    // First-time save.
    const name = prompt('Name this favorite:', macroId);
    if (!name) return;
    list.push({ name, snap: snapshotOneShot(el, macroId) });
    favs[macroId] = list;
    localStorage.setItem(storeKey, JSON.stringify(favs));
}

// --- Long-press toggle for touch (disable macro from the panel) ---

export function bindLongPressToggle(el, panel) {
    const LONG_PRESS_MS = 450;
    let timer = null;
    let activeBtn = null;
    const cancel = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        activeBtn = null;
    };
    panel.addEventListener('touchstart', (e) => {
        const btn = e.target.closest('.pn-macro-btn');
        if (!btn) return;
        // Fresh press → any prior suppression flag is stale; drop it.
        delete btn.dataset.suppressClick;
        cancel();
        activeBtn = btn;
        timer = setTimeout(() => {
            if (!activeBtn) return;
            activeBtn.dataset.suppressClick = '1';
            toggleMacroDisabled(el, activeBtn.dataset.macro);
            // Haptic nudge where supported.
            if (navigator.vibrate) navigator.vibrate(15);
            timer = null;
        }, LONG_PRESS_MS);
    }, { passive: true });
    panel.addEventListener('touchmove', cancel,   { passive: true });
    panel.addEventListener('touchend', cancel,    { passive: true });
    panel.addEventListener('touchcancel', cancel, { passive: true });
    // Capture-phase click filter: if the long-press timer flagged a
    // button, swallow the resulting click so the macro doesn't fire.
    panel.addEventListener('click', (e) => {
        const btn = e.target.closest('.pn-macro-btn');
        if (btn?.dataset.suppressClick) {
            delete btn.dataset.suppressClick;
            e.stopPropagation();
            e.preventDefault();
        }
    }, true);
}

// --- Disable toggle ---

export function toggleMacroDisabled(el, id) {
    el._disabledMacros = el._disabledMacros || loadDisabledMacros(el);
    if (el._disabledMacros.has(id)) el._disabledMacros.delete(id);
    else                            el._disabledMacros.add(id);
    saveDisabledMacros(el);
    refreshMacroDisabledMarks(el);
}

export function loadDisabledMacros(el) {
    try {
        const raw = localStorage.getItem('pn-macro-disabled');
        return new Set(raw ? JSON.parse(raw) : []);
    } catch { return new Set(); }
}

export function saveDisabledMacros(el) {
    try {
        localStorage.setItem('pn-macro-disabled', JSON.stringify([...el._disabledMacros]));
    } catch {}
}

export function refreshMacroDisabledMarks(el) {
    if (!el._disabledMacros) return;
    for (const btn of el.querySelectorAll('.pn-macro-btn[data-macro]')) {
        btn.classList.toggle('pn-macro-disabled', el._disabledMacros.has(btn.dataset.macro));
    }
}

// --- Auto-DJ settings persistence ---

export function saveAutoDjSettings(el) {
    try {
        const panel = el.querySelector('.pn-autodj-panel');
        if (!panel) return;
        const pools = {};
        for (const cb of panel.querySelectorAll('.pn-autodj-pool')) {
            pools[cb.value] = cb.checked;
        }
        const state = {
            showAutoDj: !!el._showAutoDj,
            run:         !!panel.querySelector('.pn-autodj-enable')?.checked,
            animateOnly: !!panel.querySelector('.pn-autodj-animate-only')?.checked,
            rate:        panel.querySelector('.pn-autodj-rate')?.value,
            regen:       panel.querySelector('.pn-autodj-regen')?.value,
            stack:       panel.querySelector('.pn-autodj-stack')?.value,
            pools,
        };
        localStorage.setItem('pn-autodj-settings', JSON.stringify(state));
    } catch {}
}

export function restoreAutoDjSettings(el, autoDjBtn, panel) {
    let state;
    try {
        const raw = localStorage.getItem('pn-autodj-settings');
        if (!raw) return;
        state = JSON.parse(raw);
    } catch { return; }
    if (!state) return;
    if (state.showAutoDj) {
        el._showAutoDj = true;
        panel.style.display = 'flex';
        autoDjBtn.classList.add('active');
    }
    const set = (cls, val) => {
        const node = panel.querySelector(`.${cls}`);
        if (!node) return;
        if (node.type === 'checkbox') node.checked = !!val;
        else if (val != null) node.value = val;
    };
    set('pn-autodj-enable',        state.run);
    set('pn-autodj-animate-only',  state.animateOnly);
    set('pn-autodj-rate',          state.rate);
    set('pn-autodj-regen',         state.regen);
    set('pn-autodj-stack',         state.stack);
    if (state.pools) {
        for (const cb of panel.querySelectorAll('.pn-autodj-pool')) {
            if (cb.value in state.pools) cb.checked = !!state.pools[cb.value];
        }
    }
}

// --- Auto-DJ tick: cadence + regen prefetch + transition injection ---

export function autoDjTick(el, prevTick, curTick) {
    // Arm state is the Run checkbox, not tab visibility.
    const enableEl = el.querySelector('.pn-autodj-enable');
    if (!enableEl?.checked) return;
    if (curTick === prevTick) return;
    // Tick wrap (loop wrap or freshly-regenerated project resets to 0).
    if (curTick < prevTick) { el._autoDjPreviewPending = false; return; }
    const ticksPerBar = 16;

    // Regen check runs independently of macro cadence.
    const regenBars = parseInt(el.querySelector('.pn-autodj-regen')?.value, 10) || 0;
    if (regenBars > 0) {
        const regenBoundary = regenBars * ticksPerBar;
        const prefetchTick = regenBoundary - ticksPerBar; // 1 bar early
        const prPf = ((prevTick) % regenBoundary) < prefetchTick;
        const crPf = ((curTick)  % regenBoundary) >= prefetchTick;
        if (prPf && crPf && !el._autoDjPreviewPending && curTick > 0) {
            el._autoDjPreviewPending = true;
            const genre = el.querySelector('.pn-genre-select')?.value || 'techno';
            const params = { ...(el._traitOverrides || {}) };
            const structure = el.querySelector('.pn-structure-select')?.value || '';
            if (structure) params.structure = structure;
            const reqId = ++el._previewReqId;
            el._sendWs({ type: 'generate-preview', genre, params, reqId });
            const statusEl = el.querySelector('.pn-autodj-status');
            if (statusEl) statusEl.textContent = `pre-loading next…`;
        }

        const pr = Math.floor(prevTick / regenBoundary);
        const cr = Math.floor(curTick  / regenBoundary);
        if (cr !== pr && curTick > 0) {
            const preview = el._pendingNextTrack;
            if (preview) {
                // Seamless regen: hand the pre-rendered project to the
                // worker via project-queue so the swap lands on a bar
                // boundary (resets tickCount).
                el._pendingNextTrack = null;
                const label = injectTransitionNet(el, preview);
                el._sendWs({ type: 'project-queue', project: preview });
                const statusEl = el.querySelector('.pn-autodj-status');
                if (statusEl && label) statusEl.textContent = `⟳ ${label}`;
            } else {
                // Pre-load didn't land in time — fall back to a sync gen.
                // The generate click below sets _injectTransitionOnNextSync,
                // so the transition still lands on the fresh project.
                el._previewReqId++;
                el.querySelector('.pn-generate-btn')?.click();
            }
            el._autoDjPreviewPending = false;
            const statusEl = el.querySelector('.pn-autodj-status');
            if (statusEl) statusEl.textContent = `regenerating…`;
        }
    }

    const rateBars = parseInt(el.querySelector('.pn-autodj-rate')?.value, 10) || 2;
    const boundary = rateBars * ticksPerBar;
    const prev = Math.floor(prevTick / boundary);
    const cur  = Math.floor(curTick / boundary);
    if (cur === prev) return;

    autoDjFireMacros(el);
}

export function pickTransitionMacroId(el) {
    if (!el.querySelector('.pn-autodj-enable')?.checked) return null;
    const pools = el.querySelectorAll('.pn-autodj-pool:checked');
    const enabled = new Set([...pools].map(cb => cb.value));
    if (!enabled.has('Transition')) return null;
    el._disabledMacros = el._disabledMacros || loadDisabledMacros(el);
    const ids = [...TRANSITION_MACRO_IDS].filter(id => !el._disabledMacros.has(id));
    if (ids.length === 0) return null;
    return ids[Math.floor(Math.random() * ids.length)];
}

export function fireTransitionMacro(el) {
    const id = pickTransitionMacroId(el);
    if (!id) return;
    const macro = MACROS.find(m => m.id === id);
    fireMacro(el, id);
    const statusEl = el.querySelector('.pn-autodj-status');
    if (statusEl) statusEl.textContent = `⟳ ${macro?.label || id}`;
}

// Plain-JSON one-transition control net that fires a `fire-macro`
// control binding on its first tick.
export function transitionNetJson(macroId) {
    return {
        role: 'control',
        track: { channel: 1 },
        places: { p0: { initial: [1] }, p1: {} },
        transitions: {
            t0: {
                control: { action: 'fire-macro', targetNet: macroId },
            },
        },
        arcs: [
            { source: 'p0', target: 't0' },
            { source: 't0', target: 'p1' },
        ],
    };
}

export function injectTransitionNet(el, project) {
    const id = pickTransitionMacroId(el);
    if (!id || !project?.nets) return null;
    const netId = `macro:transition:${id}:${Date.now().toString(36)}`;
    project.nets[netId] = transitionNetJson(id);
    return MACROS.find(m => m.id === id)?.label || id;
}

export function autoDjFireMacros(el) {
    const stack = parseInt(el.querySelector('.pn-autodj-stack')?.value, 10) || 1;
    const animateOnly = !!el.querySelector('.pn-autodj-animate-only')?.checked;
    const statusEl = el.querySelector('.pn-autodj-status');

    // Animate-only: skip macro selection entirely, just spin the ring.
    if (animateOnly) {
        autoDjSpin(el, stack);
        if (statusEl) statusEl.textContent = `(animate only)`;
        return;
    }

    // Don't pile up — if any macro is still running or queued, skip.
    if (el._runningMacro || (el._macroQueue && el._macroQueue.length > 0)) {
        if (statusEl) statusEl.textContent = `(skipped — busy)`;
        return;
    }

    const poolBoxes = el.querySelectorAll('.pn-autodj-pool:checked');
    const enabled = new Set([...poolBoxes].map(cb => cb.value));

    el._disabledMacros = el._disabledMacros || loadDisabledMacros(el);
    const candidates = enabled.size === 0 ? [] : MACROS.filter(m => {
        if (m.kind === 'compound') return false;
        if (el._disabledMacros.has(m.id)) return false;
        if (m.kind === 'one-shot') return enabled.has('Beats');
        return enabled.has(m.group);
    });

    if (candidates.length === 0) {
        autoDjSpin(el, stack);
        if (statusEl) statusEl.textContent = `(no candidates)`;
        return;
    }

    const fired = [];
    for (let i = 0; i < stack; i++) {
        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        fired.push(pick.label);
        if (i === 0) fireMacro(el, pick.id);
        else         executeMacro(el, pick.id);
    }
    autoDjSpin(el, stack);
    if (statusEl) statusEl.textContent = `→ ${fired.join(', ')}`;
}

// --- Ring rotation ---

// Nudge the ring-visualization rotation by ±90° per step, alternating
// direction between cadences so consecutive fires visibly swing.
export function autoDjSpin(el, steps = 1) {
    if (steps <= 0) return;
    const dir = el._autoDjDir || 1;
    el._autoDjTargetAngle = (el._autoDjTargetAngle || 0) + dir * 90 * steps;
    el._autoDjDir = -dir;
    el._autoDjSpinStart = performance.now();
    el._autoDjSpinFrom = el._autoDjAngleDeg || 0;
    // Arrow direction follows rotation direction.
    el._autoDjReverse = dir < 0;
    autoDjSpinAnimate(el);
}

export function autoDjSpinAnimate(el) {
    const DURATION = 800;
    const t0 = el._autoDjSpinStart;
    const from = el._autoDjSpinFrom || 0;
    const to   = el._autoDjTargetAngle || 0;
    const step = (now) => {
        const elapsed = now - t0;
        const t = Math.min(1, elapsed / DURATION);
        // cubic-bezier-ish ease out.
        const eased = 1 - Math.pow(1 - t, 3);
        el._autoDjAngleDeg = from + (to - from) * eased;
        // When the viz loop is running, it redraws every rAF with rotation
        // applied — calling _draw() here would clear its timeline.
        if (!el._vizRafId) el._draw();
        if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}

// --- Repeating one-shots + running marks + queue badges ---

export function fireRepeatingOneShots(el, prevTick, curTick) {
    if (!el._showOneShots || curTick === prevTick) return;
    const prevBeat = Math.floor(prevTick / 4);
    const curBeat  = Math.floor(curTick / 4);
    if (curBeat === prevBeat) return;
    const boxes = el.querySelectorAll('.pn-os-repeat:checked');
    for (const cb of boxes) fireMacro(el, cb.dataset.macro);
}

export function markMacroRunning(el, id, durationMs) {
    el._runningMacro = id;
    const btn = el.querySelector(`.pn-macro-btn[data-macro="${id}"]`);
    if (btn) btn.classList.add('running');
    updateQueuedBadges(el);
    el._runningTimer = setTimeout(() => {
        const b = el.querySelector(`.pn-macro-btn[data-macro="${id}"]`);
        if (b) b.classList.remove('running');
        el._runningMacro = null;
        el._runningTimer = null;
        const next = (el._macroQueue || []).shift();
        if (next !== undefined) {
            updateQueuedBadges(el);
            executeMacro(el, next);
        } else {
            el.querySelectorAll('.pn-macro-btn.queued').forEach(b => b.classList.remove('queued'));
            el.querySelectorAll('.pn-macro-queue-badge').forEach(b => b.remove());
        }
    }, Math.max(100, durationMs + 40));
}

export function updateQueuedBadges(el) {
    const counts = new Map();
    for (const qid of (el._macroQueue || [])) counts.set(qid, (counts.get(qid) || 0) + 1);
    for (const btn of el.querySelectorAll('.pn-macro-btn')) {
        const qid = btn.dataset.macro;
        const count = counts.get(qid) || 0;
        btn.classList.toggle('queued', count > 0);
        let badge = btn.querySelector('.pn-macro-queue-badge');
        if (count > 0) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'pn-macro-queue-badge';
                btn.appendChild(badge);
            }
            badge.textContent = count > 1 ? `+${count}` : '•';
        } else if (badge) {
            badge.remove();
        }
    }
}

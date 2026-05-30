// Device map — visual representation of the APC mini mk2 with labels
// and live LED mirror. Renders inside .pn-device-panel and updates on a
// ~100ms tick while the panel is open. Reads the same source-of-truth
// state apc-mini-mk2.js writes (padBindings / ccBindings / mutedNets /
// apcSections / apcMacroFired) so the panel can't drift from the device.
//
// Layout matches the device in its natural orientation: faders on the
// left, 8x8 grid in the middle (row 0 on top for screen sanity — we
// flip the note numbering from the device's bottom-up scheme), red
// track-button column to the right of the grid, green scene-launch
// column at the far right.

import { MACROS } from '../macros/catalog.js';

const APC_RE = /apc.*mini.*mk2/i;
const MPK_RE = /mpk.*mini/i;
const REFRESH_MS = 100;
const FLASH_MS = 180;

// MPK Mini Mk II defaults (factory). Keys: 25 mini keys, default range
// MIDI 48..72 (C3..C5) with octave shift. Pads: 8 (Bank A) at MIDI
// 36..43. Knobs: 8 CCs at 70..77 (K1..K8). User can reprogram these in
// the Akai MPK Editor — we render the factory defaults as a reference.
const MPK_KEY_LO = 48, MPK_KEY_HI = 72;
const MPK_PAD_LO = 36, MPK_PAD_HI = 43;
const MPK_CC_LO  = 70, MPK_CC_HI  = 77;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (n) => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
const isBlackKey = (n) => [1, 3, 6, 8, 10].includes(n % 12);

// Velocity → CSS color for the APC palette indices we actually use.
const PALETTE = {
    0:  'transparent',     // off
    3:  '#ffffff',         // white
    5:  '#ff2d2d',         // red
    9:  '#ff8c00',         // orange
    13: '#ffd400',         // yellow
    21: '#19c34d',         // green
    37: '#1ec8ff',         // cyan
    45: '#3a5cff',         // blue
    53: '#d63ad6',         // magenta
};

const GROUP_COLOR_KEY = {
    Mute: 5, FX: 37, Pan: 45, Shape: 9, Pitch: 53,
    Feel: 21, Tempo: 13, 'One-Shot': 3,
};

const MACRO_BY_ID = new Map(MACROS.map(m => [m.id, m]));

const FADER_FX = [
    ['delay-time',     'Delay Time'],
    ['delay-feedback', 'Delay Fb'],
    ['reverb-wet',     'Reverb Wet'],
    ['reverb-size',    'Reverb Size'],
    ['lp-freq',        'LP Freq'],
    ['hp-freq',        'HP Freq'],
    ['master-pitch',   'Pitch'],
    ['crush-bits',     'Crush'],
    ['master-vol',     'Master'],
];

const SCENE_LABELS = [
    'Play', 'Generate', 'Shuffle', 'Auto-DJ',
    'Stage', 'FX Bypass', 'FX Reset', 'Panic',
];

export function renderDeviceMap(el) {
    const panel = el.querySelector('.pn-device-panel');
    if (!panel) return;
    panel.innerHTML = buildHTML(el);
    wireXpose(el, panel);
    paint(el, panel);
}

function wireXpose(el, panel) {
    const setX = (v) => el._setLiveTranspose?.(Math.max(-24, Math.min(24, v|0)));
    const cur  = () => (el._liveTranspose ?? 0) | 0;
    panel.querySelector('.pn-dm-xpose-octdown')?.addEventListener('click', () => setX(cur() - 12));
    panel.querySelector('.pn-dm-xpose-down')   ?.addEventListener('click', () => setX(cur() - 1));
    panel.querySelector('.pn-dm-xpose-up')     ?.addEventListener('click', () => setX(cur() + 1));
    panel.querySelector('.pn-dm-xpose-octup')  ?.addEventListener('click', () => setX(cur() + 12));
    panel.querySelector('.pn-dm-xpose-reset')  ?.addEventListener('click', () => setX(0));
    panel.querySelector('.pn-dm-xpose-listen') ?.addEventListener('click', (e) => {
        el._transposeListen = !el._transposeListen;
        const btn = e.currentTarget;
        btn.classList.toggle('on', el._transposeListen);
        btn.setAttribute('aria-pressed', el._transposeListen ? 'true' : 'false');
        // Mirror state into the MIDI panel's listen pill so both stay in sync.
        const sibling = el.querySelector('.pn-transpose-listen');
        if (sibling) {
            sibling.setAttribute('aria-pressed', el._transposeListen ? 'true' : 'false');
            sibling.classList.toggle('on', el._transposeListen);
        }
    });
}

export function startDeviceLoop(el) {
    if (el._deviceTimer) return;
    el._deviceTimer = setInterval(() => {
        const panel = el.querySelector('.pn-device-panel');
        if (!panel || panel.style.display === 'none') return;
        // Detect connect/disconnect: rebuild HTML if presence flipped.
        const wasConnected = panel.dataset.connected === '1';
        const isConnected = apcConnected(el);
        if (wasConnected !== isConnected) {
            renderDeviceMap(el);
        } else {
            paint(el, panel);
        }
    }, REFRESH_MS);
}

export function stopDeviceLoop(el) {
    if (el._deviceTimer) { clearInterval(el._deviceTimer); el._deviceTimer = null; }
}

function apcConnected(el) {
    if (!el?._midiAccess) return false;
    for (const inp of el._midiAccess.inputs.values()) {
        if (APC_RE.test(inp.name || '')) return true;
    }
    return false;
}

function mpkConnected(el) {
    if (!el?._midiAccess) return false;
    for (const inp of el._midiAccess.inputs.values()) {
        if (MPK_RE.test(inp.name || '')) return true;
    }
    return false;
}

function buildHTML(el) {
    const apc = apcConnected(el);
    const mpk = mpkConnected(el);

    if (!apc && !mpk) {
        return `<div class="pn-device-empty">
            No supported controller detected (APC mini mk2, MPK Mini Mk II).<br>
            Plug one in, then reload the page (or click anywhere to re-trigger MIDI permission).
        </div>`;
    }

    return `
        <div class="pn-device-wrap">
            <div class="pn-device-side-by-side">
                ${mpk ? buildMPK(el) : ''}
                ${apc ? buildAPC(el) : ''}
            </div>
        </div>
    `;
}

function buildAPC(el) {

    // 8x8 grid: visual row 0 on top = device row 7 (note 56..63).
    let gridHTML = '';
    for (let vRow = 0; vRow < 8; vRow++) {
        const devRow = 7 - vRow;
        for (let col = 0; col < 8; col++) {
            const note = devRow * 8 + col;
            const b = el._padBindings?.get(note);
            const labelText = padLabel(b);
            const macroId = typeof b === 'string' ? b : '';
            gridHTML += `<div class="pn-dm-pad" data-note="${note}" data-macro="${macroId}" title="note 0x${note.toString(16).padStart(2,'0')}${macroId ? ` — ${macroId}` : ''}">
                <span class="pn-dm-pad-label">${labelText}</span>
            </div>`;
        }
    }

    // Track-button column (red, single LED). Visual rows top→bottom map to
    // device notes 0x64..0x6B (left-to-right on the physical row); we still
    // show in physical left-to-right order, just stacked vertically.
    let trackHTML = '';
    for (let i = 0; i < 8; i++) {
        const note = 0x64 + i;
        const b = el._padBindings?.get(note);
        const label = (b && b.type === 'mute') ? b.target : '—';
        trackHTML += `<div class="pn-dm-track" data-note="${note}" title="note 0x${note.toString(16)} — mute ${label}">
            <span class="pn-dm-track-label">${label}</span>
        </div>`;
    }

    // Scene-launch column (green, single LED).
    let sceneHTML = '';
    for (let i = 0; i < 8; i++) {
        const note = 0x70 + i;
        sceneHTML += `<div class="pn-dm-scene" data-note="${note}" title="note 0x${note.toString(16)} — ${SCENE_LABELS[i]}">
            <span class="pn-dm-scene-label">${SCENE_LABELS[i]}</span>
        </div>`;
    }

    // Faders: vertical strips on the left.
    let faderHTML = '';
    FADER_FX.forEach(([fx, label], i) => {
        const cc = 0x30 + i;
        faderHTML += `<div class="pn-dm-fader" data-cc="${cc}" title="CC 0x${cc.toString(16)} → ${label}">
            <div class="pn-dm-fader-track"><div class="pn-dm-fader-thumb"></div></div>
            <span class="pn-dm-fader-label">${label}</span>
        </div>`;
    });

    return `
        <div class="pn-device-col" data-device="apc">
            <div class="pn-device-header">APC mini mk2</div>
            <div class="pn-device-body">
                <div class="pn-dm-faders">${faderHTML}</div>
                <div class="pn-dm-center">
                    <div class="pn-dm-tracks">${trackHTML}</div>
                    <div class="pn-dm-grid">${gridHTML}</div>
                </div>
                <div class="pn-dm-scenes">${sceneHTML}</div>
            </div>
            <div class="pn-device-legend">
                <span><i class="pn-dm-sw" style="background:#ff2d2d"></i> Mute</span>
                <span><i class="pn-dm-sw" style="background:#1ec8ff"></i> FX</span>
                <span><i class="pn-dm-sw" style="background:#3a5cff"></i> Pan</span>
                <span><i class="pn-dm-sw" style="background:#ff8c00"></i> Shape</span>
                <span><i class="pn-dm-sw" style="background:#d63ad6"></i> Pitch</span>
                <span><i class="pn-dm-sw" style="background:#19c34d"></i> Feel</span>
                <span><i class="pn-dm-sw" style="background:#ffd400"></i> Tempo</span>
                <span><i class="pn-dm-sw" style="background:#ffffff"></i> One-Shot</span>
            </div>
        </div>
    `;
}

function buildMPK(el) {
    // 8 knobs (CC 70..77, K1..K8)
    let knobsHTML = '';
    for (let i = 0; i < 8; i++) {
        const cc = MPK_CC_LO + i;
        const b = el._ccBindings?.get(cc);
        const label = b?.key ? b.key.replace(/^fx:/, '') : '—';
        knobsHTML += `<div class="pn-dm-knob" data-cc="${cc}" title="K${i+1} (CC ${cc})${b?.key ? ` → ${b.key}` : ''}">
            <div class="pn-dm-knob-dial"><div class="pn-dm-knob-mark"></div></div>
            <span class="pn-dm-knob-label">K${i+1}</span>
            <span class="pn-dm-knob-bind">${label}</span>
        </div>`;
    }

    // 8 pads (notes 36..43, MPK Bank A factory default). 2 rows × 4 columns
    // matching the silkscreen on the device: top row pads 5-8 (left→right),
    // bottom row pads 1-4 (left→right). The MIDI notes each pad sends can
    // be reprogrammed in MPK Editor, so we label by *pad position only* and
    // let the live flash reveal the actual mapping when you tap the pad.
    let padsHTML = '';
    const padNumOrder = [5, 6, 7, 8, 1, 2, 3, 4];   // top row, then bottom row
    for (const padNum of padNumOrder) {
        const note = MPK_PAD_LO + (padNum - 1);
        padsHTML += `<div class="pn-dm-mpk-pad" data-note="${note}" data-pad="${padNum}" title="Pad ${padNum} — factory default note ${note} (${noteName(note)}). Tap to confirm.">
            <span class="pn-dm-mpk-pad-label">Pad ${padNum}</span>
            <span class="pn-dm-mpk-pad-note">${note}</span>
        </div>`;
    }

    // 25 mini keys (C3..C5). White keys laid out as flex columns; black
    // keys absolute-positioned over the boundaries between white keys.
    const whiteNotes = [];
    const blackNotes = [];
    for (let n = MPK_KEY_LO; n <= MPK_KEY_HI; n++) {
        if (isBlackKey(n)) blackNotes.push(n);
        else whiteNotes.push(n);
    }
    const whiteHTML = whiteNotes.map(n => `<div class="pn-dm-key pn-dm-key-w" data-note="${n}" title="${noteName(n)} (MIDI ${n})">
        <span class="pn-dm-key-label">${(n % 12 === 0) ? noteName(n) : ''}</span>
    </div>`).join('');
    // Position black keys by the index of the preceding white key.
    const blackHTML = blackNotes.map(n => {
        const idx = whiteNotes.findIndex(w => w > n) - 1;
        return `<div class="pn-dm-key pn-dm-key-b" data-note="${n}" style="left:calc((100% / ${whiteNotes.length}) * ${idx + 1} - (100% / ${whiteNotes.length}) * 0.3)" title="${noteName(n)} (MIDI ${n})"></div>`;
    }).join('');

    const xposeVal = (el._liveTranspose ?? 0);
    const listenOn = !!el._transposeListen;
    return `
        <div class="pn-device-col" data-device="mpk">
            <div class="pn-device-header">MPK Mini Mk II</div>
            <div class="pn-device-body pn-mpk-body">
                <div class="pn-dm-mpk-top">
                    <div class="pn-dm-knobs">${knobsHTML}</div>
                    <div class="pn-dm-mpk-pads">${padsHTML}</div>
                </div>
                <div class="pn-dm-keys">
                    <div class="pn-dm-keys-whites">${whiteHTML}</div>
                    <div class="pn-dm-keys-blacks">${blackHTML}</div>
                </div>
            </div>
            <div class="pn-dm-xpose-row" title="Live transpose — applied to all non-drum channels. 🎹 toggles 'listen' mode: next MIDI Note On from your keybed snaps the transpose to that key (relative to project root or C4 fallback). Latched.">
                <span class="pn-dm-xpose-label">Xpose</span>
                <button type="button" class="pn-dm-xpose-octdown" title="Octave down">«</button>
                <button type="button" class="pn-dm-xpose-down" title="Semitone down">−</button>
                <span class="pn-dm-xpose-val">${xposeVal >= 0 ? '+' : ''}${xposeVal}</span>
                <button type="button" class="pn-dm-xpose-up" title="Semitone up">+</button>
                <button type="button" class="pn-dm-xpose-octup" title="Octave up">»</button>
                <button type="button" class="pn-dm-xpose-reset" title="Reset to +0">↺</button>
                <button type="button" class="pn-dm-xpose-listen ${listenOn ? 'on' : ''}" aria-pressed="${listenOn}" title="Listen — next key sets transpose. Latched.">🎹</button>
            </div>
            <div class="pn-device-legend">
                <span>Octave default C3–C5 — shift on device to retune live</span>
            </div>
        </div>
    `;
}

function padLabel(binding) {
    if (typeof binding === 'string') {
        const m = MACRO_BY_ID.get(binding);
        return m ? m.label : binding;
    }
    if (binding && binding.type === 'click') return binding.label || 'click';
    if (binding && binding.type === 'mute')  return `mute:${binding.target}`;
    return '';
}

function paint(el, panel) {
    const apc = apcConnected(el);
    const mpk = mpkConnected(el);
    if (!apc && !mpk) { panel.dataset.connected = '0'; return; }
    panel.dataset.connected = '1';

    const now = performance.now();
    if (mpk) paintMPK(el, panel, now);
    if (!apc) return;

    // Grid pads — paint per-binding color, full when recently fired.
    const pads = panel.querySelectorAll('.pn-dm-pad');
    pads.forEach(node => {
        const note = parseInt(node.dataset.note, 10);
        const b = el._padBindings?.get(note);
        let bg = 'transparent';
        let bright = false;
        if (typeof b === 'string') {
            const macro = MACRO_BY_ID.get(b);
            const colorKey = GROUP_COLOR_KEY[macro?.group] ?? 3;
            bg = PALETTE[colorKey] || '#ffffff';
            const fired = el._apcMacroFired?.get(b) || 0;
            bright = (now - fired) < FLASH_MS;
        }
        node.style.background = bg;
        node.classList.toggle('pn-dm-bright', bright);
        node.classList.toggle('pn-dm-bound', bg !== 'transparent');
    });

    // Track buttons — red, solid/blink/off mirroring section state.
    const sections = el._apcSections || [];
    panel.querySelectorAll('.pn-dm-track').forEach((node, i) => {
        const section = sections[i];
        const st = section ? sectionState(el, section) : 'absent';
        node.classList.toggle('pn-dm-on',    st === 'active');
        node.classList.toggle('pn-dm-blink', st === 'muted');
        node.classList.toggle('pn-dm-off',   st === 'absent');
        // Refresh label in case the section set changed since render.
        const label = section || '—';
        const labelEl = node.querySelector('.pn-dm-track-label');
        if (labelEl && labelEl.textContent !== label) labelEl.textContent = label;
    });

    // Scene-launch — green, play blinks while transport runs.
    panel.querySelectorAll('.pn-dm-scene').forEach((node, i) => {
        const playingBlink = (i === 0) && !!el._playing;
        node.classList.toggle('pn-dm-on', !playingBlink);
        node.classList.toggle('pn-dm-blink', playingBlink);
    });

    // Faders — reflect current slider value (0..100 typical).
    panel.querySelectorAll('.pn-dm-fader').forEach((node, i) => {
        const [fx] = FADER_FX[i];
        const sliderEl = el.querySelector(`.pn-fx-slider[data-fx="${fx}"]`);
        if (!sliderEl) return;
        const min = parseFloat(sliderEl.min || '0');
        const max = parseFloat(sliderEl.max || '100');
        const val = parseFloat(sliderEl.value || '0');
        const pct = max > min ? Math.max(0, Math.min(1, (val - min) / (max - min))) : 0;
        const thumb = node.querySelector('.pn-dm-fader-thumb');
        if (thumb) thumb.style.bottom = `${pct * 100}%`;
    });
}

function paintMPK(el, panel, now) {
    const activity = el._midiActivity || new Map();
    const flash = (key) => (now - (activity.get(key) || 0)) < FLASH_MS;

    panel.querySelectorAll('.pn-dm-key').forEach(node => {
        const n = parseInt(node.dataset.note, 10);
        node.classList.toggle('pn-dm-key-active', flash(`note:${n}`));
    });
    panel.querySelectorAll('.pn-dm-mpk-pad').forEach(node => {
        const n = parseInt(node.dataset.note, 10);
        node.classList.toggle('pn-dm-mpk-pad-active', flash(`note:${n}`));
    });
    panel.querySelectorAll('.pn-dm-knob').forEach(node => {
        const cc = parseInt(node.dataset.cc, 10);
        node.classList.toggle('pn-dm-knob-active', flash(`cc:${cc}`));
    });

    // Xpose value tracks _liveTranspose. Listen LED tracks _transposeListen.
    const valEl = panel.querySelector('.pn-dm-xpose-val');
    if (valEl) {
        const v = (el._liveTranspose ?? 0) | 0;
        const txt = (v >= 0 ? '+' : '') + v;
        if (valEl.textContent !== txt) valEl.textContent = txt;
    }
    const listenBtn = panel.querySelector('.pn-dm-xpose-listen');
    if (listenBtn) {
        const on = !!el._transposeListen;
        if (listenBtn.classList.contains('on') !== on) {
            listenBtn.classList.toggle('on', on);
            listenBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
    }
}

function sectionState(el, group) {
    const nets = el?._project?.nets || {};
    const muted = el._mutedNets || new Set();
    const manual = el._manualMutedNets || new Set();
    let any = false, allMuted = true;
    for (const [id, net] of Object.entries(nets)) {
        if (net?.track?.group !== group) continue;
        any = true;
        if (!muted.has(id) && !manual.has(id)) allMuted = false;
    }
    if (!any) return 'absent';
    return allMuted ? 'muted' : 'active';
}

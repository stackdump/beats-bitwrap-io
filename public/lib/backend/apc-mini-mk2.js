// Akai APC mini mk2 integration — zero-config default layout + LED feedback.
//
// The APC mini mk2 is a class-compliant USB MIDI controller (8x8 RGB grid,
// 9 faders, 8 red track buttons, 8 green scene-launch buttons, shift). It
// works through the existing Web MIDI plumbing in audio-io.js: faders send
// CC, pads/buttons send Note On. All this module adds on the *input* side is
// a sensible default binding map so plugging the controller in "just works";
// the heavy lifting is the *output* side — lighting the surface from live app
// state, which the rest of the codebase has no path for.
//
// Detection + lifecycle is driven from audio-io.js::connectMidiInputs — on
// MIDI connect AND statechange we call apcSync(el), which installs the layout
// and starts/stops the LED refresh loop as the device comes and goes.
//
// Protocol reference: "APC mini mk2 - Communications Protocol v1.0" (Akai).
//   - Pads: notes 0x00-0x3F, note 0 = bottom-left, +1 right, +8 up.
//   - Pad LED: Note On, status byte 0x90|channel sets brightness/behavior
//     (0x90=10% … 0x96=100% solid; 0x97-0x9A pulse; 0x9B-0x9F blink),
//     velocity = a fixed 128-entry color palette.
//   - Track buttons (red single LED): notes 0x64-0x6B.
//   - Scene-launch buttons (green single LED): notes 0x70-0x77.
//   - Single LED: status always 0x90, velocity 0=off / 1=on / 2=blink.
//   - Faders 1-8: CC 0x30-0x37; Master fader: CC 0x38 (all channel 0).
//   - No SysEx needed for any of the above (we request MIDI without sysex).

import { MACROS } from '../macros/catalog.js';

const APC_RE = /apc.*mini.*mk2/i;

// --- Protocol constants ---

const PAD_LO = 0x00, PAD_HI = 0x3F;        // 8x8 RGB grid
const TRACK_LO = 0x64;                       // 0x64-0x6B, red single LEDs
const SCENE_LO = 0x70;                       // 0x70-0x77, green single LEDs
const FADER_CC_LO = 0x30;                    // 0x30-0x38 (8 + master)

// Pad LED status bytes (Note On channel encodes brightness/behavior).
const PAD_DIM  = 0x92;  // solid 50% — resting macro color
const PAD_FULL = 0x96;  // solid 100% — momentary flash when a macro fires

// Color palette indices (velocity) — canonical primaries from the protocol's
// velocity→RGB chart.
const C_OFF = 0, C_WHITE = 3, C_RED = 5, C_ORANGE = 9, C_YELLOW = 13,
      C_GREEN = 21, C_CYAN = 37, C_BLUE = 45, C_MAGENTA = 53;

// Single-LED velocities.
const LED_OFF = 0, LED_ON = 1, LED_BLINK = 2;

const MACRO_FLASH_MS = 180;

// --- Default layout ---

// The 9 faders, left→right, mapped to the FX sliders most worth a dedicated
// physical control. Master fader (CC 0x38) → master volume. Names match the
// data-fx attributes on .pn-fx-slider (see lib/ui/build.js).
const FADER_FX = [
    'delay-time', 'delay-feedback', 'reverb-wet', 'reverb-size',
    'lp-freq', 'hp-freq', 'master-pitch', 'crush-bits', 'master-vol',
];

// Scene-launch buttons → global transport / studio actions (synthesised
// clicks on stable selectors). Order top→bottom on the device.
const SCENE_ACTIONS = [
    '.pn-play',                          // 0x70 play / stop
    '[data-midi-action="generate"]',     // 0x71 generate
    '[data-midi-action="shuffle"]',      // 0x72 shuffle
    '.pn-autodj-btn',                    // 0x73 auto-DJ
    '.pn-stage-btn',                     // 0x74 stage
    '.pn-fx-bypass',                     // 0x75 FX bypass
    '.pn-fx-reset',                      // 0x76 FX reset
    '.pn-macro-panic',                   // 0x77 panic
];

// Resting color per macro group (see catalog.js groups).
const GROUP_COLOR = {
    Mute: C_RED, FX: C_CYAN, Pan: C_BLUE, Shape: C_ORANGE,
    Pitch: C_MAGENTA, Feel: C_GREEN, Tempo: C_YELLOW, 'One-Shot': C_WHITE,
};

// macroId → group, built once.
const MACRO_GROUP = new Map(MACROS.map(m => [m.id, m.group]));

// Pad layout — explicit grid (8 cols × 8 rows, bottom-up: PAD_LAYOUT[0]
// is bottom-left, PAD_LAYOUT[63] is top-right). null = leave unbound so
// the LED stays dark and the pad is a no-op. Goals: each group fits on
// one row without wrapping; Hits on top row only; empty rows as visual
// breathing room; vertical ordering from "destructive" at the bottom
// (mute / FX) through "sound-shaping" in the middle (pan / shape /
// pitch / tempo) to "emotional + temporal" up top (feel / hits). Built
// for the APC mini mk2's 8x8 grid; changing this shifts the physical
// layout but not the catalog order (so the Macros panel in the page UI
// stays grouped + ordered by catalog.js as before).
const _ = null;
const PAD_LAYOUT = [
    // Row 0 (bottom) — Mute (6) + 2 empty
    'drop', 'breakdown', 'solo-drums', 'cut', 'beat-repeat', 'double-drop', _, _,
    // Row 1 — FX-A (5 of 10 cyan): sweeps + ambient builds
    'sweep-lp', 'sweep-hp', 'reverb-wash', 'delay-throw', 'riser', _, _, _,
    // Row 2 — FX-B (5 of 10 cyan): washes + filter
    'build-crush', 'phaser-drone', 'cathedral', 'dub-delay', 'filter-res', _, _, _,
    // Row 3 — Pan (4) + Mono (Shape, but stereo-adjacent so it lives here)
    'ping-pong', 'hard-left', 'hard-right', 'auto-pan', 'mono', _, _, _,
    // Row 4 — Pitch (4) + Tempo (3) + 1 empty
    'octave-up', 'octave-down', 'pitch-bend', 'vinyl-brake', 'half-time', 'tape-stop', 'tempo-anchor', _,
    // Row 5 — Feel (7) + 1 empty
    'feel-chill', 'feel-drive', 'feel-ambient', 'feel-euphoric', 'feel-build', 'feel-wind-down', 'feel-reset', _,
    // Row 6 — empty buffer
    _, _, _, _, _, _, _, _,
    // Row 7 (top) — Hits (4) + Tighten/Loosen/Pulse (3) + 1 empty
    'hit1', 'hit2', 'hit3', 'hit4', 'tighten', 'loosen', 'pulse', _,
];

// Section precedence (mirrors the mixer's section ordering) — the row of red
// track buttons reflects whichever of these the loaded track actually uses.
const SECTION_ORDER = [
    'drums', 'percussion', 'bass', 'chords', 'harmony',
    'lead', 'melody', 'arp', 'pad', 'texture', 'stinger',
];

// --- Public entry point ---

// Called on every MIDI connect / statechange. Idempotent: installs the layout
// + starts the LED loop the first time an APC appears, tears down when it
// leaves, and refreshes the output-port handle if it changed.
export function apcSync(el) {
    if (!el?._midiAccess) return;

    let inputPresent = false, outPort = null;
    for (const inp of el._midiAccess.inputs.values()) {
        if (APC_RE.test(inp.name || '')) { inputPresent = true; break; }
    }
    for (const op of el._midiAccess.outputs.values()) {
        if (APC_RE.test(op.name || '')) { outPort = op; break; }
    }
    const present = inputPresent && !!outPort;

    if (present && !el._apcActive) {
        el._apcOut = outPort;
        el._apcLed = new Map();              // note → last-sent (status<<8|vel)
        el._apcMacroFired = el._apcMacroFired || new Map(); // macroId → ts
        el._apcSectionsSig = null;
        wrapFireMacro(el);
        installLayout(el);
        el._apcActive = true;
        el._apcTimer = setInterval(() => {
            try { syncSections(el); paint(el); } catch {}
        }, 50);
        console.info('[apc] APC mini mk2 connected — default layout installed');
    } else if (!present && el._apcActive) {
        apcTeardown(el);
        console.info('[apc] APC mini mk2 disconnected');
    } else if (present && el._apcActive) {
        el._apcOut = outPort;                // handle may change across statechange
    }
}

// --- Input layout ---

function installLayout(el) {
    el._ccBindings = new Map();
    FADER_FX.forEach((fx, i) => {
        el._ccBindings.set(FADER_CC_LO + i, {
            key: `fx:${fx}`,
            selector: `.pn-fx-slider[data-fx="${fx}"]`,
        });
    });

    el._padBindings = new Map();
    // Grid pads → macros, per PAD_LAYOUT (see comment above). Empty
    // slots are skipped so the LED stays dark and the pad is a no-op.
    PAD_LAYOUT.forEach((macroId, i) => {
        const note = PAD_LO + i;
        if (macroId && note <= PAD_HI) el._padBindings.set(note, macroId);
    });
    // Scene-launch buttons → global actions.
    SCENE_ACTIONS.forEach((selector, i) => {
        el._padBindings.set(SCENE_LO + i, { type: 'click', selector });
    });
    // Track buttons (section mutes) are bound dynamically in syncSections().

    el._savePadBindings?.();
    el._renderMidiPanel?.();
}

// Re-derive the present sections and (re)bind the red track-button row to
// toggle them. Only rewrites when the section set actually changes, so a user
// hover-rebind of an unrelated pad survives.
function syncSections(el) {
    const sections = presentSections(el);
    const sig = sections.join('|');
    if (sig === el._apcSectionsSig) return;
    el._apcSectionsSig = sig;
    el._apcSections = sections;
    for (let i = 0; i < 8; i++) {
        const note = TRACK_LO + i;
        if (i < sections.length) el._padBindings.set(note, { type: 'mute', target: sections[i] });
        else el._padBindings.delete(note);
    }
}

function presentSections(el) {
    const nets = el?._project?.nets || {};
    const groups = new Set();
    for (const net of Object.values(nets)) {
        const g = net?.track?.group;
        if (g) groups.add(g);
    }
    const ordered = SECTION_ORDER.filter(g => groups.has(g));
    for (const g of [...groups].sort()) {
        if (!SECTION_ORDER.includes(g)) ordered.push(g);
    }
    return ordered.slice(0, 8);
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

// Stamp macro-fire timestamps so the loop can flash the pad. el._fireMacro is
// the funnel for UI clicks, MIDI pads and most internal fires; wrapping the
// instance method shadows the prototype wrapper without touching the hot path.
function wrapFireMacro(el) {
    if (el._apcFireWrapped) return;
    const orig = el._fireMacro.bind(el);
    el._fireMacro = (id, opts) => {
        try { el._apcMacroFired.set(id, performance.now()); } catch {}
        return orig(id, opts);
    };
    el._apcFireWrapped = true;
}

// --- LED output ---

function paint(el) {
    if (!el._apcOut) return;
    const now = performance.now();

    // Grid pads — lit per bound macro, flashing to full brightness briefly
    // after the macro fires; off where no macro is mapped.
    for (let note = PAD_LO; note <= PAD_HI; note++) {
        const b = el._padBindings.get(note);
        if (typeof b === 'string') {
            const color = GROUP_COLOR[MACRO_GROUP.get(b)] ?? C_WHITE;
            const fired = el._apcMacroFired.get(b) || 0;
            const status = (now - fired < MACRO_FLASH_MS) ? PAD_FULL : PAD_DIM;
            sendLed(el, note, status, color);
        } else {
            sendLed(el, note, 0x90, C_OFF);
        }
    }

    // Track buttons (red) — section mutes: solid = playing, blink = muted,
    // off = no such section in this track.
    const sections = el._apcSections || [];
    for (let i = 0; i < 8; i++) {
        const st = sections[i] ? sectionState(el, sections[i]) : 'absent';
        const vel = st === 'muted' ? LED_BLINK : st === 'active' ? LED_ON : LED_OFF;
        sendLed(el, TRACK_LO + i, 0x90, vel);
    }

    // Scene buttons (green) — lit to show they're mapped; play button blinks
    // while the transport is running.
    for (let i = 0; i < 8; i++) {
        const note = SCENE_LO + i;
        const vel = (i === 0 && el._playing) ? LED_BLINK : LED_ON;
        sendLed(el, note, 0x90, vel);
    }
}

// Send a Note On only when the (status, velocity) for that note changed —
// keeps the loop's MIDI traffic to actual deltas.
function sendLed(el, note, status, vel) {
    const sig = (status << 8) | vel;
    if (el._apcLed.get(note) === sig) return;
    el._apcLed.set(note, sig);
    try { el._apcOut.send([status, note, vel]); } catch {}
}

function apcTeardown(el) {
    if (el._apcTimer) { clearInterval(el._apcTimer); el._apcTimer = null; }
    if (el._apcOut) {
        for (let n = PAD_LO; n <= PAD_HI; n++) safeSend(el, [0x90, n, C_OFF]);
        for (let n = TRACK_LO; n < TRACK_LO + 8; n++) safeSend(el, [0x90, n, LED_OFF]);
        for (let n = SCENE_LO; n < SCENE_LO + 8; n++) safeSend(el, [0x90, n, LED_OFF]);
    }
    el._apcOut = null;
    el._apcActive = false;
    el._apcLed?.clear?.();
}

function safeSend(el, bytes) {
    try { el._apcOut.send(bytes); } catch {}
}

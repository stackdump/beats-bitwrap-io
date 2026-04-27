// Audio + MIDI I/O — Tone.js bootstrap, Web MIDI input/output, MIDI CC
// slider bindings + pad macro bindings, mute + debounced mixer render,
// per-channel routing + output device selection, and the viz particle
// stream + rolling-timeline painter that draws under the Petri ring.
//
// Extracted from petri-note.js. Functions take the custom element as
// first arg; petri-note.js keeps one-line class-method wrappers.

import { toneEngine } from '../../audio/tone-engine.js';

// --- Init + MIDI input ---

export async function initAudio(el) {
    // Audio state already initialized in constructor.
    // Tone.js requires user gesture to start — handled in ensureToneStarted.
    connectMidiInputs(el);
}

export async function connectMidiInputs(el) {
    if (el._midiInputConnected || !navigator.requestMIDIAccess) return;
    try {
        const midi = await navigator.requestMIDIAccess({ sysex: false });
        el._midiAccess = el._midiAccess || midi;
        const wireInputs = () => {
            for (const input of midi.inputs.values()) {
                if (!input.onmidimessage) {
                    input.onmidimessage = (e) => handleMidiMessage(el, e);
                }
            }
            detectAndStorePreset(el);
            el._renderMidiPanel?.();
        };
        wireInputs();
        midi.onstatechange = wireInputs;
        el._midiInputConnected = true;
    } catch (e) {
        console.warn('MIDI input access denied:', e);
    }
}

// detectAndStorePreset scans connected MIDI inputs against the
// preset registry and remembers the first match on
// el._detectedMidiPreset. Picks up newly-plugged devices on
// statechange — the user can plug in mid-session and the MIDI panel
// reflects the new device on next render.
import { detectPreset as _detectPreset } from './midi-presets.js';
export { applyPreset as applyMidiPreset } from './midi-presets.js';
function detectAndStorePreset(el) {
    if (!el._midiAccess) return;
    for (const input of el._midiAccess.inputs.values()) {
        const preset = _detectPreset(input.name);
        if (preset) {
            el._detectedMidiPreset = preset;
            el._detectedMidiInputName = input.name;
            return;
        }
    }
    el._detectedMidiPreset = null;
    el._detectedMidiInputName = null;
}

// --- MIDI bindings ---

// Build a logical key and CSS selector for a slider so bindings survive DOM rebuilds.
// Optional `min`/`max` overrides bound the CC scaling range when the
// slider's native range is too wide for usable knob control (e.g. BPM
// natively allows 20-300, but 60-200 is the practical performance band).
export function sliderBindingKey(slider) {
    if (slider.dataset.fx) {
        return { key: `fx:${slider.dataset.fx}`, selector: `.pn-fx-slider[data-fx="${slider.dataset.fx}"]` };
    }
    if (slider.closest('.pn-tempo')) {
        return {
            key: 'tempo',
            selector: '.pn-tempo input[type="number"]',
            min: 60, max: 300,
        };
    }
    const row = slider.closest('.pn-mixer-row');
    if (!row) return null;
    const group = row.dataset.riffGroup || row.dataset.netId;
    const cls = [...slider.classList].find(c => c.startsWith('pn-mixer-') && c !== 'pn-mixer-slider');
    if (!group || !cls) return null;
    return { key: `mix:${group}:${cls}`, selector: `.pn-mixer-row[data-riff-group="${group}"] .${cls}, .pn-mixer-row[data-net-id="${group}"] .${cls}` };
}

export function resolveBinding(el, binding) {
    return el.querySelector(binding.selector);
}

// Flash a green bind-confirm outline on the captured target for
// 300ms. Capturing the element in a closure (vs. checking
// el._hoveredX 300ms later) prevents the outline from sticking
// when the user moves the cursor off before the timer fires.
function flashBindOutline(target) {
    if (!target) return;
    target.style.outline = '2px solid #64ffda';
    setTimeout(() => { target.style.outline = ''; }, 300);
}

export function handleMidiMessage(el, event) {
    // Optional debug tap — when the MIDI Monitor modal is open, every
    // raw message is mirrored to it before normal dispatch so the user
    // can see exactly what their controller is sending without losing
    // bound-action behaviour.
    if (typeof el._midiMonitorTap === 'function') {
        try { el._midiMonitorTap(event.data); } catch {}
    }
    const [status, data1, data2] = event.data;
    const type = status & 0xF0;
    if (type === 0xB0) return handleMidiCC(el, data1, data2);
    if (type === 0x90 && data2 > 0) return handleMidiNoteOn(el, data1);
    // Pitch Bend (0xE0) drives the live Xpose pill when MIDI input
    // is on — the joystick's pitch axis becomes a continuous
    // semitone slider. Standard pitch range: ±8192 → ±12 semitones
    // (1 octave each way). The +0 dead-zone at the rest position
    // (joystick released) re-centres Xpose to 0 so a brief push
    // doesn't leave the loop transposed indefinitely.
    if (type === 0xE0) return handleMidiPitchBend(el, ((data2 << 7) | data1) - 8192);
    // Ignore Note Off (0x80) and velocity-0 Note On.
}

export function handleMidiPitchBend(el, value) {
    if (typeof el._setLiveTranspose !== 'function') return;
    // Map full-range pitch bend (-8192..+8191) to ±12 semitones.
    // Round to nearest semitone for crisp snap; sub-semitone
    // micro-bends would need to feed setMasterPitch instead.
    const semis = Math.max(-12, Math.min(12, Math.round(value / 8192 * 12)));
    el._setLiveTranspose(semis);
}

// Drives the BPM input from a 0-127 CC value mapped to the practical
// performance range 60-200 BPM. Used by the joystick Y-axis default
// binding when CC1 isn't otherwise claimed. Spring-return semantics
// match pitch bend → Xpose: push to drive BPM, release (value 0)
// snaps back to whatever BPM was set before the user grabbed the
// joystick. So the rest position never silently locks BPM to 60.
function setBpmFromCC(el, value) {
    const input = el.querySelector('.pn-tempo input[type="number"]');
    if (!input) return;
    if (value === 0) {
        // Joystick released — restore the pre-grab tempo if we had
        // saved one. No-op when nothing to restore (e.g. user never
        // pushed the joystick this session).
        if (el._bpmBeforeJoystick != null) {
            input.value = el._bpmBeforeJoystick;
            el._bpmBeforeJoystick = null;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return;
    }
    if (el._bpmBeforeJoystick == null) {
        el._bpmBeforeJoystick = parseInt(input.value, 10) || el._tempo || 120;
    }
    // 60..300 covers everything from chillhop to speedcore — release
    // (value 0) snaps back to the track's configured tempo.
    const min = 60, max = 300;
    input.value = Math.round(min + (value / 127) * (max - min));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
}

export function handleMidiCC(el, cc, value) {
    // Default joystick Y-axis (CC1 / modwheel) → BPM unless the user
    // has explicitly bound CC1 to something else. Most controllers
    // (including the MPK Mini) ship the joystick's vertical axis as
    // CC1, so this gives "joystick X bends pitch, joystick Y drives
    // tempo" out of the box. The hover-bind path below still wins
    // if the user wants to remap CC1 — explicit beats default.
    if (cc === 1 && !el._ccBindings?.has(1) && !el._hoveredSlider
        && !el._hoveredMute && !el._hoveredSection) {
        return setBpmFromCC(el, value);
    }
    // Hover-bind paths — slider, mute button, section divider — all
    // overwrite any existing binding so re-binding is a one-touch
    // operation. Mute / section bindings are useful for pads in CC
    // mode (most controllers offer it) where the pad latches between
    // 0 and >0 instead of sending Note On/Off. Suppressed entirely
    // when the user has the MIDI panel's lock toggle on (live-set
    // protection against a stray slider hover rebinding a knob).
    if (el._midiBindingLock) {
        // Skip every hover-bind path; fall through to the dispatch
        // lookup so existing bindings still fire.
    } else if (el._hoveredMute) {
        const target = el._hoveredMute.dataset.riffGroup || el._hoveredMute.dataset.netId;
        if (target) {
            el._ccBindings.set(cc, { type: 'mute', target });
            flashBindOutline(el._hoveredMute);
            el._renderMidiPanel?.();
        }
    } else if (el._hoveredSection) {
        const target = el._hoveredSection.dataset.section;
        if (target) {
            el._ccBindings.set(cc, { type: 'mute', target });
            flashBindOutline(el._hoveredSection);
            el._renderMidiPanel?.();
        }
    } else if (el._hoveredSlider && !el._ccBindings.has(cc)) {
        const b = sliderBindingKey(el._hoveredSlider);
        if (b) {
            el._ccBindings.set(cc, b);
            flashBindOutline(el._hoveredSlider);
            el._renderMidiPanel?.();
        }
    }

    const binding = el._ccBindings.get(cc);
    if (!binding) return;

    // Mute binding (CC-mode pad in latching mode): value > 0 → pad
    // lit → unmute; value 0 → pad off → mute. Refresh panel so the
    // ●/○ indicator flips.
    if (binding.type === 'mute') {
        setMuteGroup(el, binding.target, value === 0);
        el._renderMidiPanel?.();
        return;
    }

    const slider = resolveBinding(el, binding);
    if (!slider) return;

    // Binding-level overrides win over the input's native min/max so
    // tempo (native 20-300) maps usable performance range 60-200 onto
    // the 0-127 CC sweep.
    const min = binding.min != null ? binding.min : parseFloat(slider.min);
    const max = binding.max != null ? binding.max : parseFloat(slider.max);
    slider.value = Math.round(min + (value / 127) * (max - min));
    // Fire BOTH events: FX sliders react to `input` for live updates,
    // BPM input listens for `change` only.
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
}

export function handleMidiNoteOn(el, note) {
    // Hover-bind paths suppressed when the user has the MIDI lock
    // engaged (live-set protection). Existing bindings still fire
    // via the lookup further down.
    if (el._midiBindingLock) {
        const binding = el._padBindings?.get(note);
        if (binding) {
            if (typeof binding === 'string') el._fireMacro(binding);
            else if (binding?.type === 'mute') {
                toggleMuteGroup(el, binding.target);
                el._renderMidiPanel?.();
            }
        }
        if (el._transposeListen && typeof el._setLiveTranspose === 'function') {
            const root = (el._project?.rootNote ?? 60) | 0;
            el._setLiveTranspose(note - root);
        }
        return;
    }
    // Hover-bind: hover intent always overwrites the existing binding
    // for that note (was previously silently no-op on a re-bind).
    if (el._hoveredMacro) {
        const macroId = el._hoveredMacro.dataset.macro;
        el._padBindings.set(note, macroId);
        el._savePadBindings();
        flashBindOutline(el._hoveredMacro);
        el._renderMidiPanel?.();
        return;
    }
    // Mixer mute-button hover + pad press = bind pad to a mute toggle
    // for that track / riff group. Same hover-overwrite semantics.
    if (el._hoveredMute) {
        const target = el._hoveredMute.dataset.riffGroup || el._hoveredMute.dataset.netId;
        if (target) {
            el._padBindings.set(note, { type: 'mute', target });
            el._savePadBindings();
            flashBindOutline(el._hoveredMute);
            el._renderMidiPanel?.();
            return;
        }
    }
    // Section-divider hover (e.g. the "Drums" heading above the drum
    // rows) + pad press = bind the pad to a section-wide mute toggle.
    // Same {type:'mute'} shape — toggleMuteGroup walks the section by
    // riff group, so the existing dispatch already covers it.
    if (el._hoveredSection) {
        const target = el._hoveredSection.dataset.section;
        if (target) {
            el._padBindings.set(note, { type: 'mute', target });
            el._savePadBindings();
            flashBindOutline(el._hoveredSection);
            el._renderMidiPanel?.();
            return;
        }
    }
    const binding = el._padBindings.get(note);
    if (binding) {
        // Two binding shapes:
        //   string         → macroId, fire as a macro
        //   { type, ... }  → action (currently only 'mute')
        if (typeof binding === 'string') {
            el._fireMacro(binding);
        } else if (binding && binding.type === 'mute') {
            // Toggle mute on a riff group. Re-render the MIDI panel
            // so the binding-list reflects the new state.
            toggleMuteGroup(el, binding.target);
            el._renderMidiPanel?.();
        }
        return;
    }
    // Live transpose listen mode: an unbound Note On (i.e. anything
    // that wasn't a pad-binding) sets the transpose offset relative
    // to the project's natural root (C4 fallback). Latched — the
    // offset stays until the user plays another key. The toggle is
    // the .pn-transpose-listen pill in the header.
    if (el._transposeListen && typeof el._setLiveTranspose === 'function') {
        const root = (el._project?.rootNote ?? 60) | 0;
        el._setLiveTranspose(note - root);
    }
}

// --- Tone.js bootstrap ---

export async function ensureToneStarted(el) {
    if (el._toneStarted) return;
    if (el._toneInitPromise) return el._toneInitPromise;
    el._toneInitPromise = (async () => {
        try {
            await toneEngine.init();
            // Apply initial master volume from slider (default 80% = -12 dB).
            const initVol = parseInt(el.querySelector('[data-fx="master-vol"]')?.value || '80');
            const initDb = initVol === 0 ? -60 : -60 + (initVol / 100) * 60;
            toneEngine.setMasterVolume(initDb);
            el._toneStarted = true;
            // Keep banner in sync with context state.
            const ctx = window.Tone?.context?.rawContext;
            if (ctx && !el._ctxListenerBound) {
                el._ctxListenerBound = true;
                ctx.addEventListener('statechange', () => {
                    if (el._playing && ctx.state !== 'running') el._showAudioLockBanner();
                    else el._hideAudioLockBanner();
                });
            }
            // If auto-play triggered init without a user gesture, context stays suspended.
            if (ctx && ctx.state !== 'running' && el._playing) {
                el._showAudioLockBanner();
            }
            const loads = Object.entries(el._channelInstruments).map(
                ([ch, inst]) => toneEngine.loadInstrument(parseInt(ch), inst)
            );
            await Promise.all(loads);
            // Channel strips now exist — push the current mixer state onto them.
            el._applyMixerStateToEngine();
            await reapplyChannelRoutings(el);
            el._populateAudioOutputs();
        } catch (e) {
            console.error('Failed to start Tone.js:', e);
        }
    })();
    return el._toneInitPromise;
}

// --- Audio mode toggle + MIDI outputs ---

export async function toggleAudioMode(el, mode) {
    if (el._audioModes.has(mode)) {
        el._audioModes.delete(mode);
        // Clear per-channel pins of the now-disabled kind.
        const kind = mode === 'web-audio' ? 'audio' : 'midi';
        for (const [ch, routing] of [...el._channelRouting.entries()]) {
            if (routing.kind === kind) {
                await setChannelRouting(el, ch, '');
                sessionStorage.removeItem(`pn-channel-routing-${ch}`);
            }
        }
    } else {
        el._audioModes.add(mode);
    }
    el.querySelectorAll('.pn-audio-mode button').forEach(btn => {
        btn.classList.toggle('active', el._audioModes.has(btn.dataset.mode));
    });
    el.classList.toggle('pn-midi-enabled', el._audioModes.has('web-midi'));

    if (el._audioModes.has('web-midi')) {
        refreshMidiOutputs(el).then(() => el._populateAudioOutputs());
    } else {
        el._populateAudioOutputs();
    }
}

export async function refreshMidiOutputs(el) {
    if (!navigator.requestMIDIAccess) {
        console.warn('Web MIDI not supported');
        return;
    }

    try {
        el._midiAccess = await navigator.requestMIDIAccess();
    } catch (e) {
        console.error('MIDI access error:', e);
    }
}

// --- Mute ---

export function toggleMute(el, netId) {
    const muted = !el._mutedNets.has(netId);
    if (muted) el._mutedNets.add(netId);
    else       el._mutedNets.delete(netId);
    el._sendWs({ type: 'mute', netId, muted });
    debouncedRenderMixer(el);
}

export function toggleMuteGroup(el, riffGroup) {
    const netIds = [];
    for (const [id, net] of Object.entries(el._project.nets)) {
        if (net.riffGroup === riffGroup) netIds.push(id);
    }
    if (netIds.length === 0) return;

    const allMuted = netIds.every(nid => el._mutedNets.has(nid));
    const muted = !allMuted;

    // Let the server handle riff group logic (only unmutes the active slot).
    el._sendWs({ type: 'mute-group', riffGroup, muted });
}

// Explicit mute setter. Handles three target shapes so the same
// binding works regardless of where in the UI the user hovered:
//
//   1. target matches a net's riffGroup
//      (per-row mute button hover where the row has an explicit
//      riff group like "kick-A" / "bass-B"). Sends `mute-group`
//      so the worker can pick the active variant on unmute.
//   2. target matches a track.group (section)
//      (section-divider hover-bind, e.g. "drums" → all the
//      kick/snare/hihat nets). Sends one `mute` per net.
//   3. target matches a net id directly
//      (per-row mute button hover where the project has no
//      riffGroup set at all — composer output uses netIds like
//      "kick" / "snare" without a riffGroup). Sends one `mute`.
//
// Always sends — the worker is idempotent, and the previous
// in-process "already in state, skip" check could miss when
// _mutedNets hadn't received its first mute-state broadcast yet.
export function setMuteGroup(el, target, muted) {
    if (!el._project?.nets) return;
    const nets = el._project.nets;
    const directGroup = [];
    for (const [id, net] of Object.entries(nets)) {
        if (net.riffGroup === target) directGroup.push(id);
    }
    if (directGroup.length > 0) {
        el._sendWs({ type: 'mute-group', riffGroup: target, muted });
        return;
    }
    const sectionMatches = [];
    for (const [id, net] of Object.entries(nets)) {
        if (net?.track?.group === target) sectionMatches.push(id);
    }
    if (sectionMatches.length > 0) {
        for (const nid of sectionMatches) {
            el._sendWs({ type: 'mute', netId: nid, muted });
        }
        return;
    }
    if (nets[target]) {
        el._sendWs({ type: 'mute', netId: target, muted });
    }
}

export function debouncedRenderMixer(el) {
    if (el._renderMixerTimeout) return;
    el._renderMixerTimeout = setTimeout(() => {
        el._renderMixerTimeout = null;
        el._renderMixer();
    }, 100);
}

// --- Playback routing ---

export async function playNote(el, midi, netId, playAt) {
    const channel = midi.channel || 1;
    if (netId && (el._mutedNets.has(netId) || el._manualMutedNets.has(netId))) return;
    if (el._mutedChannels.has(channel)) return;
    // Drop notes while AudioContext is suspended.
    if (el._toneStarted && !toneEngine.isContextRunning()) return;

    const routing = el._channelRouting.get(channel);
    if (routing?.kind === 'midi') {
        await playWebMidi(el, midi, routing.id);
        return;
    }
    if (routing?.kind === 'audio') {
        await playTone(el, midi, playAt);
        return;
    }

    // Global fallback: honor whichever modes are enabled.
    if (el._audioModes.has('web-audio')) {
        await playTone(el, midi, playAt);
    } else if (el._audioModes.has('web-midi')) {
        await playWebMidi(el, midi);
    }
}

export async function reapplyChannelRoutings(el) {
    if (!el._toneStarted) return;
    for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        const m = key && key.match(/^pn-channel-routing-(\d+)$/);
        if (!m) continue;
        const ch = parseInt(m[1], 10);
        const val = sessionStorage.getItem(key);
        if (val) await setChannelRouting(el, ch, val);
    }
}

export async function setChannelRouting(el, channel, value) {
    // value: '' | 'audio:<deviceId>' | 'midi:<portId>'
    if (!value) {
        el._channelRouting.delete(channel);
        try { await toneEngine.setChannelOutputDevice(channel, ''); } catch (err) { console.warn(err); }
        return;
    }
    const sep = value.indexOf(':');
    const kind = value.slice(0, sep);
    const id = value.slice(sep + 1);

    if (kind === 'audio') {
        el._channelRouting.set(channel, { kind, id });
        try { await toneEngine.setChannelOutputDevice(channel, id); }
        catch (err) { console.warn('setChannelOutputDevice failed:', err); }
    } else if (kind === 'midi') {
        if (!el._midiAccess) await refreshMidiOutputs(el);
        el._channelRouting.set(channel, { kind, id });
        // Release any audio-sink routing for this channel.
        try { await toneEngine.setChannelOutputDevice(channel, ''); } catch {}
    }
}

export async function playTone(el, midi, playAt) {
    if (!el._toneStarted) await ensureToneStarted(el);
    toneEngine.playNote(midi, playAt);
}

export async function playWebMidi(el, midi, portIdOverride) {
    if (!el._midiAccess) await refreshMidiOutputs(el);

    const portId = portIdOverride || el._midiOutputId;
    if (!el._midiAccess || !portId) {
        console.warn('No MIDI output selected');
        return;
    }

    const output = el._midiAccess.outputs.get(portId);
    if (!output) {
        console.warn('MIDI output not found:', portId);
        return;
    }

    const noteOn = [0x90 | ((midi.channel || 1) - 1), midi.note, midi.velocity || 100];
    const noteOff = [0x80 | ((midi.channel || 1) - 1), midi.note, 0];

    output.send(noteOn);
    setTimeout(() => output.send(noteOff), midi.duration || 100);
}

export async function setChannelInstrument(el, channel, instrumentType) {
    el._channelInstruments[channel] = instrumentType;
    if (el._toneStarted) {
        await toneEngine.loadInstrument(channel, instrumentType);
    }
}

// --- Visualization ---

const VIZ_COLORS = {
    kick:    '#e94560',
    snare:   '#f5a623',
    hihat:   '#f8e71c',
    clap:    '#ff6b6b',
    bass:    '#4a90d9',
    melody:  '#2ecc71',
    harmony: '#9b59b6',
    arp:     '#00d2ff',
};
const VIZ_DEFAULT_COLOR = '#888';

export function vizColorForNet(netId) {
    if (VIZ_COLORS[netId]) return VIZ_COLORS[netId];
    // Match riff group prefix: "kick-0" -> "kick".
    const base = netId.replace(/-\d+$/, '');
    return VIZ_COLORS[base] || VIZ_DEFAULT_COLOR;
}

export function vizSpawnParticle(el, netId, midi) {
    el._vizHistory.push({ time: Date.now(), netId, note: midi?.note });
    if (el._vizHistory.length > 200) el._vizHistory.shift();
}

export function vizStartLoop(el) {
    if (el._vizRafId) return;
    const loop = () => {
        el._vizRafId = requestAnimationFrame(loop);
        vizDrawFrame(el);
    };
    el._vizRafId = requestAnimationFrame(loop);
}

export function vizStopLoop(el) {
    if (el._vizRafId) {
        cancelAnimationFrame(el._vizRafId);
        el._vizRafId = null;
    }
}

export function vizDrawFrame(el) {
    el._renderFrame();
    // Smooth playhead interpolation — DOM side, not canvas.
    el._updatePlayhead();
}

export function vizDrawTimeline(el, ctx, w, h) {
    const now = Date.now();
    // Adaptive window: shrinks to fit available dots, grows to max 4 bars.
    // At 120bpm, 4 bars = 8s. Use elapsed since first dot as the window.
    const maxWindowMs = (240 / Math.max(60, el._tempo)) * 1000;
    const elapsed = el._vizHistory.length > 0 ? now - el._vizHistory[0].time : 0;
    const windowMs = Math.max(2000, Math.min(maxWindowMs, elapsed + 500));

    for (const evt of el._vizHistory) {
        const age = now - evt.time;
        if (age > windowMs) continue;
        const x = w - (age / windowMs) * w;
        const color = vizColorForNet(evt.netId);
        // Stay visible across the full screen: fade only in the last 15%.
        const pct = age / windowMs;
        const alpha = pct < 0.85 ? 0.7 : 0.7 * (1 - (pct - 0.85) / 0.15);

        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        // Short streak trailing behind the dot.
        const streakLen = Math.min(20, (w / windowMs) * 120);
        const grad = ctx.createLinearGradient(x - streakLen, 0, x, 0);
        grad.addColorStop(0, 'transparent');
        grad.addColorStop(1, color);
        ctx.fillStyle = grad;
        ctx.fillRect(x - streakLen, 27, streakLen, 6);
        // Dot head.
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, 30, 4, 0, Math.PI * 2);
        ctx.fill();
    }

    // Prune old events.
    while (el._vizHistory.length > 0 && now - el._vizHistory[0].time > windowMs) {
        el._vizHistory.shift();
    }
    ctx.globalAlpha = 1;
}

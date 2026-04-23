// MIDI-binding editor, transition fire (manual), quickstart + help modals.
// All three are self-contained overlay builders — consume element state
// but don't mutate anything besides a couple of history/project calls
// at Save time.

import { noteToName, nameToNote } from '../audio/note-name.js';
import { renderCurrentCard } from '../share/card.js';
import { openAiPromptModal } from './ai-prompt.js';

export function openMidiEditor(el, transitionId) {
    const net = el._getActiveNet();
    const trans = net.transitions[transitionId];
    const trackCh = net.track?.channel || 1;
    const trackVel = net.track?.defaultVelocity || 100;
    const src = trans.midi || {};
    const midi = {
        note: Number.isFinite(src.note) ? src.note : 60,
        channel: Number.isFinite(src.channel) ? src.channel : trackCh,
        velocity: Number.isFinite(src.velocity) ? src.velocity : trackVel,
        duration: Number.isFinite(src.duration) ? src.duration : 100,
    };

    const overlay = document.createElement('div');
    overlay.className = 'pn-modal-overlay';
    overlay.innerHTML = `
        <div class="pn-modal">
            <h2>MIDI Binding: ${trans.label || transitionId}</h2>
            <div class="pn-modal-row">
                <label>Note</label>
                <input type="number" name="note" value="${midi.note}" min="0" max="127"/>
                <input type="text" name="noteName" value="${noteToName(midi.note)}" size="4" title="Note name (e.g. C4, F#3, Bb5)"/>
            </div>
            <div class="pn-modal-row">
                <label>Channel</label>
                <input type="number" name="channel" value="${midi.channel}" min="1" max="16"/>
            </div>
            <div class="pn-modal-row">
                <label>Velocity</label>
                <input type="number" name="velocity" value="${midi.velocity}" min="0" max="127"/>
            </div>
            <div class="pn-modal-row">
                <label>Duration</label>
                <input type="number" name="duration" value="${midi.duration}" min="10" max="10000"/>
                <span>ms</span>
            </div>
            <div class="pn-modal-actions">
                <button class="cancel">Cancel</button>
                <button class="test">Test</button>
                <button class="save">Save</button>
            </div>
        </div>
    `;

    el.appendChild(overlay);

    // Bidirectional sync between note number and name.
    const noteInput = overlay.querySelector('input[name="note"]');
    const noteNameEl = overlay.querySelector('input[name="noteName"]');
    noteInput.addEventListener('input', () => {
        const n = parseInt(noteInput.value, 10);
        if (Number.isFinite(n)) noteNameEl.value = noteToName(n);
    });
    noteNameEl.addEventListener('input', () => {
        const n = nameToNote(noteNameEl.value);
        if (n !== null) {
            noteInput.value = n;
            noteNameEl.classList.remove('pn-invalid');
        } else {
            noteNameEl.classList.add('pn-invalid');
        }
    });
    noteNameEl.addEventListener('blur', () => {
        const n = parseInt(noteInput.value, 10);
        if (Number.isFinite(n)) {
            noteNameEl.value = noteToName(n);
            noteNameEl.classList.remove('pn-invalid');
        }
    });

    // Wheel on any value field bumps the value up/down.
    overlay.addEventListener('wheel', (e) => {
        const target = e.target;
        let numInput = null;
        if (target === noteNameEl) numInput = noteInput;
        else if (target.tagName === 'INPUT' && target.type === 'number') numInput = target;
        if (!numInput) return;
        e.preventDefault();
        const step = e.deltaY < 0 ? 1 : -1;
        const min = parseInt(numInput.min, 10);
        const max = parseInt(numInput.max, 10);
        let v = parseInt(numInput.value, 10);
        if (!Number.isFinite(v)) v = Number.isFinite(min) ? min : 0;
        v += step;
        if (Number.isFinite(min) && v < min) v = min;
        if (Number.isFinite(max) && v > max) v = max;
        numInput.value = v;
        numInput.dispatchEvent(new Event('input', { bubbles: true }));
    }, { passive: false });

    overlay.querySelector('.cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.test').addEventListener('click', () => {
        const testMidi = {
            note: parseInt(overlay.querySelector('input[name="note"]').value, 10),
            channel: parseInt(overlay.querySelector('input[name="channel"]').value, 10),
            velocity: parseInt(overlay.querySelector('input[name="velocity"]').value, 10),
            duration: parseInt(overlay.querySelector('input[name="duration"]').value, 10),
        };
        el._playNote(testMidi);
    });
    const save = () => {
        el._pushHistory();
        trans.midi = {
            note: parseInt(overlay.querySelector('input[name="note"]').value, 10),
            channel: parseInt(overlay.querySelector('input[name="channel"]').value, 10),
            velocity: parseInt(overlay.querySelector('input[name="velocity"]').value, 10),
            duration: parseInt(overlay.querySelector('input[name="duration"]').value, 10),
        };
        overlay.remove();
        el._renderNet();
        el._syncProject();
        el._sendWs({ type: 'project-load', project: el._project });
    };
    overlay.querySelector('.save').addEventListener('click', save);

    overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
        else if (e.key === 'Escape') { e.preventDefault(); overlay.remove(); }
    });
    noteInput.focus();
    noteInput.select();

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });
}

// Manual transition fire — used by test pads + the MIDI editor's Test
// button. Checks enablement, consumes input tokens, produces output
// tokens, plays the bound note, and echoes the fire to the server.
export function fireTransition(el, transitionId) {
    const net = el._getActiveNet();
    const trans = net.transitions[transitionId];

    const inputArcs = net.arcs.filter(a => a.target === transitionId);
    const outputArcs = net.arcs.filter(a => a.source === transitionId);

    for (const arc of inputArcs) {
        const place = net.places[arc.source];
        if (!place || (place.tokens[0] || 0) < arc.weight[0]) {
            return false;
        }
    }

    for (const arc of inputArcs) {
        const place = net.places[arc.source];
        place.tokens[0] = (place.tokens[0] || 0) - arc.weight[0];
    }

    for (const arc of outputArcs) {
        const place = net.places[arc.target];
        if (place) {
            place.tokens[0] = (place.tokens[0] || 0) + arc.weight[0];
        }
    }

    const node = el._nodes[transitionId];
    if (node) {
        node.classList.add('firing');
        setTimeout(() => node.classList.remove('firing'), 100);
    }

    if (trans.midi) el._playNote(trans.midi);

    el._renderNet();
    el._sendWs({ type: 'transition-fire', netId: el._activeNetId, transitionId });

    return true;
}

// Quickstart on first visit — a compact 5-step guide. Dismissed state
// persists to localStorage. Attached to document.body so the element's
// innerHTML reset during _buildUI() doesn't wipe it.
export function showQuickstartModal(el) {
    el.querySelector('.pn-help-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'pn-help-overlay pn-quickstart-overlay';
    overlay.innerHTML = `
        <div class="pn-help-modal">
            <button class="pn-help-close">&times;</button>
            <h2>Welcome to Petri Note</h2>
            <p style="color:#ccc;margin:0 0 14px">
                A deterministic beat generator. Every note is a Petri net transition firing — tokens circulate, rhythms emerge.
            </p>
            <ol style="line-height:1.7">
                <li>Pick a <b>Genre</b> and hit <b>Generate</b></li>
                <li>Press <b>Play</b> (Space) to listen</li>
                <li>Open the <b>Macros</b> panel next to FX for live tricks: Drop, Sweep LP, Reverb Wash, Tape Stop &hellip;</li>
                <li>Every slider and dropdown: hover + scroll to fine-tune</li>
                <li>Click <b>?</b> any time for the full guide</li>
            </ol>
            <div style="display:flex;gap:10px;margin-top:18px">
                <button class="pn-quickstart-start" style="flex:1;padding:10px;background:#e94560;border:none;color:#fff;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600">Get Started</button>
                <button class="pn-quickstart-guide" style="flex:1;padding:10px;background:#1a1a2e;border:1px solid #0f3460;color:#eee;border-radius:6px;cursor:pointer;font-size:14px">Open Full Guide</button>
            </div>
        </div>
    `;
    const dismiss = () => {
        localStorage.setItem('pn-quickstart-seen', '1');
        overlay.remove();
    };
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target.closest('.pn-help-close') || e.target.closest('.pn-quickstart-start')) {
            dismiss();
        } else if (e.target.closest('.pn-quickstart-guide')) {
            dismiss();
            showHelpModal(el);
        }
    });
    document.body.appendChild(overlay);
}

// Welcome overlay shown on a user's first project-sync. Uses the
// client-side card twin (lib/share/card.js) so the preview renders
// without sealing the payload to the store first — no CID required.
// Dismisses on click anywhere; persists a flag so it only fires once.
export function showWelcomeCard(el) {
    // Pull ?title=… from the URL — on shared links the title is the
    // sender's projection label and should ride into the card. Clamp
    // to 60 chars to mirror the server's sanitizeTitle cap.
    const urlTitle = (new URLSearchParams(location.search).get('title') || '')
        .replace(/[\x00-\x1f\x7f]/g, '')
        .trim()
        .slice(0, 60);
    // Shared links with a title re-show the card every visit — the
    // title is the whole point, and return visitors following a link
    // still want that preview. Plain (no-title) first-visit behaves
    // as before: one-shot, gated by pn-welcome-seen.
    if (!urlTitle && localStorage.getItem('pn-welcome-seen')) return;
    el.querySelector('.pn-welcome-overlay')?.remove();
    const svg = renderCurrentCard(el, urlTitle);
    const overlay = document.createElement('div');
    overlay.className = 'pn-help-overlay pn-welcome-overlay';
    overlay.innerHTML = `
        <div class="pn-welcome-modal" style="max-width:760px;width:92%;background:#0d0d0d;border:1px solid #222;border-radius:12px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.6)">
            <div class="pn-welcome-card" style="display:block;line-height:0;cursor:pointer" title="Click to start">${svg}</div>
            <div style="padding:18px 22px;color:#ccc;font-family:system-ui,sans-serif">
                <p style="margin:0 0 12px;font-size:14px;line-height:1.55">
                    Deterministic beat generator. Each card is a fingerprint: genre + seed + tempo reproduce the exact track.
                    Share any mix and the card you see here travels with the link.
                </p>
                <div style="display:flex;gap:10px">
                    <button class="pn-welcome-start" style="flex:1;padding:10px;background:#e94560;border:none;color:#fff;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600">Start playing</button>
                    <button class="pn-welcome-guide" style="flex:1;padding:10px;background:#1a1a2e;border:1px solid #0f3460;color:#eee;border-radius:6px;cursor:pointer;font-size:14px">Open full guide</button>
                </div>
            </div>
        </div>
    `;
    const dismiss = () => {
        localStorage.setItem('pn-welcome-seen', '1');
        localStorage.setItem('pn-quickstart-seen', '1');
        overlay.remove();
    };
    overlay.addEventListener('click', (e) => {
        if (e.target.closest('.pn-welcome-guide')) {
            dismiss();
            showHelpModal(el);
            return;
        }
        if (e.target === overlay
            || e.target.closest('.pn-welcome-card')
            || e.target.closest('.pn-welcome-start')) {
            dismiss();
        }
    });
    document.body.appendChild(overlay);
}

export function showHelpModal(el) {
    el.querySelector('.pn-help-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'pn-help-overlay';
    overlay.tabIndex = -1;
    overlay.innerHTML = `
        <div class="pn-help-modal">
            <button class="pn-help-close" title="Close (Esc)">&times;</button>
            <h2>Performance Guide <span class="pn-help-version" style="font-size:0.55em;color:#777;font-weight:400;letter-spacing:0.04em;margin-left:6px">loading…</span></h2>

            <h3>Getting Started</h3>
            <ul>
                <li><b>Generate</b> a track, then hit <b>Play</b></li>
                <li>Click the arrow next to Play to cycle playback modes: once &rarr; repeat &rarr; shuffle</li>
                <li>Pick a <b>Structure</b> (Standard, Drop, etc.) for tracks with sections and a timeline</li>
                <li><b>&star;</b> on any mixer row opens its Preset Manager to save / apply / delete tone presets (pan, vol, filters, decay) &mdash; saved to browser storage, scoped by channel</li>
            </ul>

            <h3>Keyboard Shortcuts</h3>
            <ul>
                <li><b>Space</b> &mdash; play / stop</li>
                <li><b>G</b> &mdash; generate new track &middot; <b>S</b> &mdash; shuffle instruments</li>
                <li><b>F</b> &mdash; open Feel modal &middot; <b>M</b> &mdash; toggle Stage</li>
                <li><b>J</b> &mdash; Auto-DJ Run &middot; <b>A</b> &mdash; Auto-DJ Animate only</li>
                <li><b>P</b> &mdash; Panic (cancel all macros) &middot; <b>B</b> &mdash; FX Bypass &middot; <b>R</b> &mdash; FX Reset</li>
                <li><b>T</b> &mdash; tap tempo (3+ taps sets BPM; pause 2s to reset) &middot; <b>,</b> / <b>.</b> &mdash; nudge BPM &minus;1 / +1</li>
                <li><b>1</b>&ndash;<b>4</b> &mdash; toggle hit1&ndash;hit4 stinger tracks on/off (steady pulse when on)</li>
                <li><b>[</b> / <b>]</b> &mdash; previous / next track</li>
                <li><b>&larr;</b> / <b>&rarr;</b> / <b>&uarr;</b> / <b>&darr;</b> &mdash; nudge the hovered slider by 1</li>
                <li><b>?</b> &mdash; open this help &middot; <b>Esc</b> &mdash; close modal</li>
            </ul>

            <h3>Tabs</h3>
            <p style="margin:0 0 8px;color:#aaa;font-size:0.92em">The four toggle buttons above the mixer &mdash; <b>FX</b>, <b>Macros</b>, <b>Beats</b>, <b>Auto-DJ</b> &mdash; each open independently. Stacked top-to-bottom in that order.</p>

            <h3>Macros (live tricks)</h3>
            <p style="margin:0 0 8px;color:#aaa;font-size:0.92em">Macros queue serially &mdash; tapping while another runs adds it to the queue (orange badge shows depth). Click the same one to extend. Every macro pulses the UI element it touches in a chase pattern and returns that element to its pre-macro value on release.</p>
            <ul>
                <li><b>Mute</b>: Drop, Breakdown, Solo Drums, Cut, Beat Repeat, Double Drop</li>
                <li><b>FX</b>: Sweep LP / HP, Reverb Wash, Delay Throw, Riser, Bit Crush, Phaser Drone, <b>Cathedral</b> (long bright reverb), <b>Dub Delay</b> (longer/heavier feedback), <b>Res Ping</b> (LP+drive slam)</li>
                <li><b>Pitch</b>: Octave Up / Down, Pitch Bend, Vinyl Brake</li>
                <li><b>Tempo</b>: Half Time, Tape Stop</li>
                <li><b>Pan</b>: <b>Ping-Pong</b> (hard L/R every beat, non-drum tracks), <b>Hard Left / Right</b> (hold to one side, non-drum tracks), <b>Auto-Pan</b> (slow sinusoidal LFO on the whole mix), <b>Mono</b> (collapse everything to center). Each track restores to the pan you had set before firing.</li>
                <li><b>Shape</b> (per-channel decay): <b>Tighten</b> snaps tails shut, <b>Loosen</b> blooms them out, <b>Pulse</b> breathes decay in/out on a 2-beat sine. All restore per-channel to the user's pre-macro decay on release.</li>
            </ul>

            <h3>Beats (stinger fire pads)</h3>
            <p style="margin:0 0 8px;color:#aaa;font-size:0.92em">The <b>Beats</b> tab exposes four reserved stinger slots (<code>hit1</code>&ndash;<code>hit4</code>) that also exist as real muted tracks below a <b>Stingers</b> divider in the main mixer when the tab is open. Each fires on every beat via its own Petri net, so unmuting the track produces a steady stinger pulse.</p>
            <ul>
                <li>Pick any instrument on the hit row &mdash; curated set of airhorn / laser / subdrop / booj stingers, plus percussion, stabs, bells, bass hits, short leads</li>
                <li>Pick <b>Unbound</b> to silence the slot while keeping the net running (useful for pairing macros without sound)</li>
                <li><b>Fire</b> is an N-bar macro: unmutes the track for the selected bar count (default 2) so it pulses every beat, then re-mutes. Re-firing resets the window</li>
                <li><b>bars</b> dropdown (1 / 2 / 4 / 8) sets the Fire window length</li>
                <li><b>Pit</b> dropdown transposes the track in semitones &mdash; active whenever the track is unmuted (Fire, hotkey <b>1</b>&ndash;<b>4</b>, or the mixer mute button), read live on every beat</li>
                <li><b>FX</b> dropdown pairs any macro with the Fire click &mdash; runs for the same N bars as the Fire window (not the macro's own default)</li>
                <li><b>&raquo;</b> on a hit's mixer row cycles through non-percussion instruments</li>
                <li>Press <b>1</b>&ndash;<b>4</b> anywhere to toggle hit1&ndash;hit4 mute directly &mdash; same behavior as clicking the mixer row's mute button</li>
            </ul>

            <h3>Feel modal</h3>
            <p style="margin:0 0 8px;color:#aaa;font-size:0.92em">Click the &#9672; next to the genre select (or press <b>F</b>). XY morph pad with four corner snapshots &mdash; Chill (bottom-left), Drive (bottom-right), Ambient (top-left), Euphoric (top-right). Drag the puck to bilinearly blend tempo / master FX / Auto-DJ / swing / humanize in real time.</p>
            <ul>
                <li><b>Genre constellation</b>: all 19 presets plotted on the pad by their natural vibe. Hover a star to preview with a dashed ghost puck (no commit); click to snap the puck there and engage Feel</li>
                <li><b>Engage / disengage</b>: Feel overrides the genre defaults only while engaged. <b>Cancel</b> fully restores the pre-open state</li>
                <li>The current genre's star glows gold so you can see where you are on the map at a glance</li>
            </ul>

            <h3>Stage mode</h3>
            <p style="margin:0 0 8px;color:#aaa;font-size:0.92em">Click the <b>&#9635; Stage</b> pill (or press <b>M</b>) for a full-page animated view. Every unmuted music net renders as its own live sub-Petri ring; they're arranged as a meta-Petri-net with connector place-circles + arrows between panels. Read-only; audio keeps playing.</p>
            <ul>
                <li><b>Flow</b> &mdash; each panel drifts slowly around its own center (on by default)</li>
                <li><b>Pulse</b> &mdash; beat particles fly from each panel to the composition center; the panel rings sit in front so particles appear to emerge from behind them</li>
                <li><b>Flame</b> &mdash; per-panel radial beam aimed at each panel's exact angle, heat decays between fires</li>
                <li><b>Tilt</b> &mdash; 3D perspective rotation of the whole grid</li>
                <li>All four modes stack independently. <b>Esc</b> closes</li>
            </ul>

            <h3>Auto-DJ</h3>
            <p style="margin:0 0 8px;color:#aaa;font-size:0.92em">Hands-free performer. Arm with <b>Run</b>; every N bars it picks a random macro from the checked pools and fires it. The petri-net ring swings ±90&deg; on every fire (arrowheads flip on CCW passes so tokens visually follow the spin).</p>
            <ul>
                <li><b>Every</b> — cadence of fires (1 / 2 / 4 / 8 / 16 / 32 / 64 / 128 / 256 / 512 / 1024 bars, each label shows its beat count)</li>
                <li><b>Animate only</b> — spin the ring on cadence without firing any macros (works even while another macro is running)</li>
                <li><b>Pools</b> checkboxes — Mute / FX / Pan / Shape / Pitch / Tempo / Beats / <span style="border-left:3px solid #64ffda;padding-left:6px"><b>Transition</b></span>. If every rate-pool is unchecked the ring still spins with <code>(no candidates)</code> in the status line</li>
                <li><b>Transition</b> pool is special — it fires only on <i>track-boundary events</i> (Auto-DJ regen, shuffle-next, repeat-restart), independent of the rate cadence. Pulls from a curated set of sweeps / washes / risers (Sweep LP/HP, Reverb Wash, Cathedral, Delay Throw, Dub Delay, Riser, Phaser Drone, Tape Stop) chosen to resolve on a downbeat. Tiles eligible for this pool carry a <span style="border-left:3px solid #64ffda;padding-left:6px">teal left stripe</span> in the Macros panel</li>
                <li><b>Stack</b> 1 / 2 / 3 — fires that many simultaneously each cycle (stack members bypass the serial queue; cycles are skipped entirely if a user-fired macro is already running)</li>
                <li><b>Regen</b> — every N bars (off / 8 / 16 / 32 / 64 / 128 / 256 / 512 / 1024) Auto-DJ kicks off a new Generate. The next project is pre-rendered one bar early for a seamless swap, with Tone.js synths pre-warmed into a side pool so the swap is a pointer flip — no audio stutter</li>
                <li>Status line shows the last picks (→ for rate fires, ⟳ for transitions), pre-load activity, or why a cycle was skipped</li>
                <li><b>Right-click any macro tile</b> to mark it disabled (long-press on touch, or toggle <b>Edit Excludes</b> in the Macros panel then tap tiles) — Auto-DJ and Transition both skip disabled macros (line-through mark, persisted)</li>
            </ul>

            <h3>MIDI Pad &amp; CC Learn</h3>
            <ul>
                <li>Toggle <b>MIDI</b> (top right) to enable Web MIDI and per-track audio-output routing</li>
                <li><b>CC</b>: hover a slider, move a MIDI CC knob &rarr; binds it. Use <b>CC Reset</b> to clear</li>
                <li><b>Pads</b>: hover a Macro button, press a pad (Note On) &rarr; binds it. Subsequent presses fire the macro</li>
            </ul>

            <h3>Per-Track Controls</h3>
            <ul>
                <li><b>Size / Hits</b> dropdowns (2&ndash;32) live-regenerate the Petri subnet for that track. Change on the active variant only.</li>
                <li><b>Instrument</b> dropdown swaps the synth mid-loop</li>
                <li><b>&raquo;</b> rotates through the current genre's instrument set</li>
                <li>Slider group: Pan / Vol / HP / HPR / LP / LPR / Dec &mdash; hover and scroll to fine-tune (1% per tick)</li>
                <li><b>&#9835;</b> test note, <b>&#8634;</b> reset, <b>&lsaquo; &rsaquo;</b> prev/next tone variation</li>
            </ul>

            <h3>Filter &amp; FX</h3>
            <ul>
                <li><b>LP sweep down</b> / <b>HP sweep up</b> &mdash; darken or thin the mix; release for impact</li>
                <li><b>Reverb wash</b> / <b>Delay throw</b> &mdash; crank wet Mix, then cut for freeze/echo tail</li>
                <li><b>Distortion rise</b> &mdash; slowly bring up Drive, kill for release</li>
                <li><b>Bypass</b> &mdash; instant wet/dry comparison</li>
                <li><b>Phaser / Bit crush</b> &mdash; motion and lo-fi degradation</li>
            </ul>

            <h3>Loop &amp; Timeline</h3>
            <ul>
                <li><b>Click</b> the timeline to seek</li>
                <li><b>Right-click</b> to snap the nearest loop marker</li>
                <li><b>Drag</b> the orange markers (snaps to bars)</li>
                <li><b>Crop</b> (scissors) &mdash; trim the track to just the loop</li>
            </ul>

            <h3>Traits &amp; Genre</h3>
            <ul>
                <li>Click any genre trait chip (Fills, Syncopation, Ghosts, etc.) to open its editor &mdash; toggle on/off or tune percentages</li>
                <li>Traits reshape the next Generate</li>
            </ul>

            <h3>MIDI Note Editor</h3>
            <ul>
                <li>Click any note badge on a transition (the small <b>C4</b>-style chip) to open the binding editor</li>
                <li>Edit note as integer <i>or</i> name (C4, F#3, Bb5) &mdash; they stay in sync</li>
                <li>Scroll over any field to nudge by 1</li>
            </ul>

            <h3>Keyboard</h3>
            <ul>
                <li><b>Space</b> &mdash; Play / Stop</li>
                <li><b>Esc</b> &mdash; close any open modal</li>
                <li><b>Arrow keys</b> &mdash; nudge sliders when focused</li>
                <li><b>Scroll</b> &mdash; fine-tune any slider, number, or dropdown under the cursor</li>
            </ul>

            <h3>Using with AI</h3>
            <p style="margin:0 0 8px;color:#aaa;font-size:0.92em">The share-v1 format is a deterministic IR &mdash; any producer, including an LLM, can emit valid JSON and get byte-identical playback. <button class="pn-help-ai pn-link-btn">Copy a ready-made prompt</button> and paste it into Claude, ChatGPT, or any chat model to compose tracks from text.</p>

            <h3>Found a bug?</h3>
            <p style="margin:0 0 8px;color:#aaa;font-size:0.92em">Open Share, copy the <code>?cid=…</code> URL, and paste it in the report &mdash; the CID carries the exact track state so we can reproduce in one click.</p>
            <p style="margin:0 0 16px"><a href="https://github.com/stackdump/beats-bitwrap-io/issues/new?template=bug_report.yml" target="_blank" rel="noopener" style="color:#0af">Report a bug on GitHub &rarr;</a></p>

            <h3>Built With</h3>
            <p style="margin:0 0 8px;color:#aaa;font-size:0.92em">The sequencer is a <b>Petri net</b> executor &mdash; every note is a transition firing, every rhythm is tokens circulating. Macros inject transient control nets that fire their restore action on a tick-locked terminal transition.</p>
            <ul>
                <li><b><a href="https://tonejs.github.io/" target="_blank" rel="noopener" style="color:#0af">Tone.js</a></b> &mdash; turns transition firings into sound</li>
                <li><b>Bjorklund's algorithm</b> &mdash; generates Euclidean rhythms as token rings</li>
            </ul>
        </div>
    `;
    overlay.addEventListener('click', (e) => {
        if (e.target.closest('.pn-help-ai')) { openAiPromptModal(); return; }
        if (e.target === overlay || e.target.closest('.pn-help-close')) {
            overlay.remove();
        }
    });
    overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); overlay.remove(); }
    });
    el.appendChild(overlay);
    overlay.focus();

    // Populate the version chip next to the title. Cached between
    // opens so the Help modal doesn't refetch every time. Failure
    // (offline / air-gapped) just drops the chip silently.
    const versionEl = overlay.querySelector('.pn-help-version');
    if (versionEl) {
        (async () => {
            try {
                if (!el._cachedVersion) {
                    const res = await fetch('/version', { cache: 'no-store' });
                    if (!res.ok) throw new Error(String(res.status));
                    el._cachedVersion = (await res.text()).trim();
                }
                versionEl.textContent = el._cachedVersion || '';
            } catch {
                versionEl.remove();
            }
        })();
    }
}

// Top-level UI builder — constructs the header, mixer container, FX/macros/
// beats/auto-DJ panels, traits row, timeline, canvas wrapper, and modal
// spots. Pure DOM construction plus a few small wire-ups (tab toggles,
// panel visibility). All behavior-wiring happens in _setupEventListeners
// after this runs.
//
// Extracted from petri-note.js (last refactor pass). `buildUI(el)` is a
// one-line wrapper away from the original `el._buildUI()` entry point so
// every call site stays unchanged.

import { toneEngine } from '../../audio/tone-engine.js';
import { prettifyInstrumentName, oneShotSpec, ONESHOT_INSTRUMENTS } from '../audio/oneshots.js';
import { MACROS, TRANSITION_MACRO_IDS } from '../macros/catalog.js';
import { hpFreq, lpFreq, qCurve } from './mixer-sliders.js';
import { isStingerTrack } from './mixer.js';
import { showSliderTip, hideSliderTip, syncSliderTip } from './slider-tip.js';
import { sanitizeNote, liveScrubNote } from '../note/note.js';
import { applyMidiPreset } from '../backend/audio-io.js';

// Footer metadata cache — these GETs are server-global, idempotent,
// and stable for the page's lifetime. We fetch them once at first
// _buildUI call and reuse the results to repaint the footer on every
// subsequent project-sync, instead of refetching and tripping
// nginx's per-IP rate limit on rapid Generate cycles.
let _footerVersion = null;
let _footerLatestCid = null;
let _footerFeedHasRows = null;
let _footerFetchStarted = false;

function populateFooterMetadata(footer) {
    const apply = () => {
        if (_footerVersion) {
            const slot = footer.querySelector('.pn-footer-version');
            if (slot) slot.textContent = _footerVersion;
        }
        if (_footerLatestCid) {
            const link = footer.querySelector('.pn-footer-latest');
            const sep  = footer.querySelector('.pn-footer-latest-sep');
            if (link) { link.href = `/?cid=${_footerLatestCid}`; link.hidden = false; }
            if (sep) sep.hidden = false;
        }
        if (_footerFeedHasRows) {
            for (const cls of ['.pn-footer-feed', '.pn-footer-feed-sep',
                               '.pn-footer-rss', '.pn-footer-rss-sep']) {
                const node = footer.querySelector(cls);
                if (node) node.hidden = false;
            }
        }
    };
    apply(); // paint cached values immediately on every call
    if (_footerFetchStarted) return;
    _footerFetchStarted = true;
    fetch('/version').then(r => r.ok ? r.text() : '').then(v => {
        _footerVersion = (v || '').trim() || null;
        apply();
    }).catch(() => {});
    fetch('/api/audio-latest').then(r => r.ok ? r.json() : null).then(data => {
        _footerLatestCid = data?.cid || null;
        apply();
    }).catch(() => {});
    fetch('/api/feed?limit=1').then(r => r.ok ? r.json() : []).then(rows => {
        _footerFeedHasRows = Array.isArray(rows) && rows.length > 0;
        apply();
    }).catch(() => {});
}

// Live label for a master-FX slider. Mirrors the inline-span formats
// the panel used to show, now surfaced via the floating cursor tip
// so the panel itself stays narrow.
function formatFxValue(fxName, val) {
    const n = Number.isFinite(val) ? val : 0;
    switch (fxName) {
        case 'delay-time':   return (n / 100).toFixed(2) + 's';
        case 'master-pitch': return (n > 0 ? '+' : '') + n + ' st';
        case 'hp-freq':
        case 'lp-freq': {
            const f = fxName === 'hp-freq' ? hpFreq(n) : lpFreq(n);
            return f < 1000 ? Math.round(f) + 'Hz' : (f / 1000).toFixed(1) + 'kHz';
        }
        case 'phaser-freq': {
            if (n === 0) return 'Off';
            const rate = 0.1 + (n / 100) * 9.9;
            return rate.toFixed(1) + 'Hz';
        }
        case 'crush-bits':
            return n === 0 ? 'Off' : Math.max(1, Math.round(16 - (n / 100) * 15)) + '-bit';
        default: return n + '%';
    }
}

// Curve presets surfaced from the Arrange tab. Each preset maps a known
// section name → XY puck / fire-macro + bars. Only applied sections that
// actually appear in the current track's blueprint take effect —
// `injectFeelCurve` / `injectMacroCurve` silently skip unknown names.
const FEEL_PRESETS = {
    'edm-arc': [
        { section: 'intro',    x: 0.2,  y: 0.7  },
        { section: 'buildup',  x: 0.75, y: 0.35 },
        { section: 'drop',     x: 0.95, y: 0.15 },
        { section: 'breakdown',x: 0.15, y: 0.3  },
        { section: 'chorus',   x: 0.85, y: 0.3  },
        { section: 'outro',    x: 0.3,  y: 0.75 },
    ],
    'chill-wave': [
        { section: 'intro',    x: 0.15, y: 0.85 },
        { section: 'verse',    x: 0.3,  y: 0.7  },
        { section: 'chorus',   x: 0.5,  y: 0.55 },
        { section: 'breakdown',x: 0.2,  y: 0.4  },
        { section: 'outro',    x: 0.1,  y: 0.85 },
    ],
    'euphoric': [
        { section: 'intro',    x: 0.4,  y: 0.5  },
        { section: 'buildup',  x: 0.8,  y: 0.3  },
        { section: 'drop',     x: 0.95, y: 0.1  },
        { section: 'chorus',   x: 0.9,  y: 0.2  },
        { section: 'outro',    x: 0.55, y: 0.55 },
    ],
};

const MACRO_PRESETS = {
    'edm-classic': [
        { section: 'intro',    macro: 'reverb-wash', bars: 2 },
        { section: 'buildup',  macro: 'riser',       bars: 4 },
        { section: 'drop',     macro: 'beat-repeat', bars: 1 },
        { section: 'breakdown',macro: 'dub-delay',   bars: 2 },
        { section: 'outro',    macro: 'cathedral',   bars: 4 },
    ],
    'drop-heavy': [
        { section: 'buildup',  macro: 'riser',       bars: 4 },
        { section: 'drop',     macro: 'beat-repeat', bars: 1 },
        { section: 'chorus',   macro: 'sweep-lp',    bars: 4 },
        { section: 'drop',     macro: 'delay-throw', bars: 1 },
    ],
    'downtempo': [
        { section: 'intro',    macro: 'cathedral',   bars: 4 },
        { section: 'verse',    macro: 'phaser-drone',bars: 4 },
        { section: 'breakdown',macro: 'dub-delay',   bars: 2 },
        { section: 'outro',    macro: 'reverb-wash', bars: 4 },
    ],
};

function applyArrangeFromPanel(el, panel) {
    const status = panel.querySelector('.pn-arrange-status');
    if (!el._project || !Object.keys(el._project.nets || {}).length) {
        if (status) status.textContent = '(no project loaded)';
        return;
    }
    const structure = panel.querySelector('.pn-arrange-structure').value;
    const fadeIn = [...panel.querySelectorAll('.pn-arrange-fade:checked')].map(cb => cb.value);
    const drumBreak = parseInt(panel.querySelector('.pn-arrange-drumbreak').value, 10) || 0;
    const feelPreset = panel.querySelector('.pn-arrange-feelcurve').value;
    const macroPreset = panel.querySelector('.pn-arrange-macrocurve').value;

    // Overlay mode only works when the loaded project already has a
    // structure (from composer generate or a prior arrange). Otherwise
    // run a full arrange — the user picked a structure, that's the
    // directive they want applied.
    const hasStructure = Array.isArray(el._project.structure) && el._project.structure.length > 0;
    const body = {
        overlay: hasStructure,
        genre: el._project.name?.split(' ')[0] || 'wrapped',
    };
    if (structure && structure !== 'loop') body.structure = structure;
    if (fadeIn.length > 0) body.fadeIn = fadeIn;
    if (drumBreak > 0)     body.drumBreak = drumBreak;
    if (feelPreset && FEEL_PRESETS[feelPreset])   body.feelCurve  = FEEL_PRESETS[feelPreset];
    if (macroPreset && MACRO_PRESETS[macroPreset]) body.macroCurve = MACRO_PRESETS[macroPreset];

    if (status) status.textContent = '…applying';
    // Run the arrange via the in-process JS port — no HTTP round-trip
    // needed; works on production hosts without `-authoring` mode.
    import('../generator/arrange.js').then(mod => {
        try {
            const proj = JSON.parse(JSON.stringify(el._project));
            mod.arrangeWithOpts(proj, body.genre, body.structure || 'standard', {
                overlayOnly: !!body.overlay,
                seed: 0,
                fadeIn: body.fadeIn,
                drumBreak: body.drumBreak,
                feelCurve: body.feelCurve,
                macroCurve: body.macroCurve,
            });
            proj.name = el._project?.name || proj.name;
            el._sendWs({ type: 'project-load', project: proj });
            if (status) status.textContent = `✓ ${Object.keys(proj.nets).length} nets`;
        } catch (err) {
            console.warn('arrange panel failed:', err);
            if (status) status.textContent = '(failed — see console)';
        }
    });
}

// Bug + feature links route through the GitHub Issue Forms templates
// without auto-injecting page state — the user fills the form. Avoids
// accidentally leaking private hand-authored share URLs or environment
// detail into a public issue.

export function buildUI(el) {
    el.innerHTML = '';
    el.classList.toggle('pn-midi-enabled', el._audioModes.has('web-midi'));

    // Header
    const header = document.createElement('div');
    header.className = 'pn-header';
    header.innerHTML = `
        <h1>beats-btw</h1>
        <span class="pn-project-name">${el._project.name}</span>
        <div class="pn-track-nav">
            <button class="pn-track-prev" title="Previous track">&#9664;</button>
            <span class="pn-track-label"></span>
            <button class="pn-track-next" title="Next track">&#9654;</button>
        </div>
        <div class="pn-transport">
            <button class="pn-play" title="Play/Stop">&#9654;</button>
            <button class="pn-playback-mode${el._playbackMode !== 'single' ? ' active' : ''}" title="${{single:'Single play',repeat:'Repeat track',shuffle:'Shuffle — new track on end'}[el._playbackMode]}">${{single:'1x',repeat:'🔁',shuffle:'🔀'}[el._playbackMode]}</button>
            <div class="pn-tempo">
                <input type="number" value="${el._tempo}" min="20" max="300" step="1"/>
                <span>BPM</span>
                <button class="pn-tap-tempo" title="Tap tempo (T) — 3+ taps sets BPM">Tap</button>
                <button class="pn-reset-tempo" title="Reset to genre default BPM">&#8634;</button>
            </div>
        </div>
        <div class="pn-generate">
            <select class="pn-structure-select" title="Song structure">
                <option value="">Loop</option>
                <option value="ab">A/B</option>
                <option value="drop">Drop</option>
                <option value="build">Build</option>
                <option value="jam">Jam</option>
                <option value="minimal">Minimal</option>
                <option value="standard">Standard</option>
                <option value="extended">Extended</option>
            </select>
            <select class="pn-genre-select">
                <option value="ambient">Ambient</option>
                <option value="blues">Blues</option>
                <option value="bossa">Bossa Nova</option>
                <option value="country">Country</option>
                <option value="dnb">DnB</option>
                <option value="dubstep">Dubstep</option>
                <option value="edm">EDM</option>
                <option value="funk">Funk</option>
                <option value="garage">Garage</option>
                <option value="house">House</option>
                <option value="jazz">Jazz</option>
                <option value="lofi">Lo-fi</option>
                <option value="metal">Metal</option>
                <option value="reggae">Reggae</option>
                <option value="speedcore">Speedcore</option>
                <option value="synthwave">Synthwave</option>
                <option value="techno" selected>Techno</option>
                <option value="trance">Trance</option>
                <option value="trap">Trap</option>
            </select>
            <button class="pn-feel-open" title="Feel — abstract performance sliders">&#9672;</button>
            <button class="pn-generate-btn" title="Generate new track">Generate</button>
            <button class="pn-shuffle-btn" title="Shuffle instruments">Shuffle</button>
            <button class="pn-stage-btn" title="Stage — full-page visualizer (M)" aria-label="Open Stage">&#9635; Stage</button>
            <a class="pn-stage-btn pn-player-link" href="/feed" title="Open the feed player" aria-label="Open feed player">&#9658; Player</a>
            <button class="pn-save-btn" title="Save to server" style="display:none">&#x1F4BE;</button>
            <button class="pn-leaderboard-btn" title="Leaderboard" style="display:none">&#x1F3C6;</button>
            <button class="pn-download-btn" title="Download track as JSON-LD">&#x2B07;</button>
            <button class="pn-upload-btn" title="Upload JSON-LD track">&#x2B06;</button>
            <button class="pn-share-btn" title="Share this track"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="11.49"/></svg></button>
            <input type="file" class="pn-upload-input" accept=".jsonld,.json" style="display:none">
        </div>
        <div class="pn-audio-mode">
            <button class="${el._audioModes.has('web-midi') ? 'active' : ''}" data-mode="web-midi">MIDI</button>
            <button class="pn-wakelock-btn ${el._wakeLock ? 'active' : ''}" title="Keep screen awake during playback (screen wake lock)" aria-pressed="${el._wakeLock ? 'true' : 'false'}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></button>
            <button class="pn-help-btn" title="Performance tips">?</button>
            <button class="pn-gh-link pn-category-btn" title="Control category map — how beat fans out through generators, instruments, macros, controls">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><circle cx="5" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><line x1="12" y1="12" x2="5" y2="5"/><line x1="12" y1="12" x2="19" y2="5"/><line x1="12" y1="12" x2="5" y2="19"/><line x1="12" y1="12" x2="19" y2="19"/></svg>
            </button>
            <a class="pn-gh-link" href="https://github.com/stackdump/beats-bitwrap-io" target="_blank" rel="noopener" title="View source on GitHub">
                <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
            </a>
        </div>
    `;
    el.appendChild(header);

    // Player link tooltip + click hook. If the page is on a CID URL,
    // honour the "open in player" promise by appending that CID to
    // the playlist before navigating — otherwise just go.
    const playerLink = header.querySelector('.pn-player-link');
    if (playerLink) {
        const cidParam = new URLSearchParams(location.search).get('cid');
        playerLink.title = cidParam ? 'Open this track in player' : 'Go to player';
        playerLink.addEventListener('click', (e) => {
            if (!cidParam) return; // default href="/feed" navigation
            e.preventDefault();
            try {
                const list = JSON.parse(localStorage.getItem('pn-playlist') || '[]');
                if (Array.isArray(list) && !list.some(p => p.cid === cidParam)) {
                    list.push({
                        cid: cidParam,
                        name:  el._project?.name  || '',
                        genre: el._project?.genre || '',
                        tempo: el._project?.tempo || 0,
                        seed:  el._currentGen?.params?.seed || 0,
                    });
                    localStorage.setItem('pn-playlist', JSON.stringify(list));
                    localStorage.setItem('pn-playlist-open', '1');
                }
            } catch {}
            // Pass the CID along so the feed page can pop the same
            // share-card SVG as a confirmation modal — the listener
            // gets visual continuity that they landed on what they
            // came for.
            location.href = `/feed?cid=${encodeURIComponent(cidParam)}`;
        });
    }

    el._genOptsEl = null;

    // Genre traits display
    const traits = document.createElement('div');
    traits.className = 'pn-genre-traits';
    el.appendChild(traits);
    el._traitsEl = traits;
    el._genreData = {};
    // Genre traits loaded locally (no server) — camelCase keys to match original /api/genres format
    el._genreData = {
        techno:    { name: 'techno',    bpm: 128, swing: 0,  humanize: 10, syncopation: 0.1,  ghostNotes: 0.3 },
        house:     { name: 'house',     bpm: 124, swing: 20, humanize: 15, syncopation: 0.2,  ghostNotes: 0.4 },
        jazz:      { name: 'jazz',      bpm: 110, swing: 60, humanize: 40, drumFills: true, walkingBass: true, syncopation: 0.5, callResponse: true, tensionCurve: true, modalInterchange: 0.3, ghostNotes: 0.6 },
        ambient:   { name: 'ambient',   bpm: 72,  swing: 0,  humanize: 25, tensionCurve: true, modalInterchange: 0.2 },
        dnb:       { name: 'dnb',       bpm: 174, swing: 10, humanize: 15, drumFills: true, polyrhythm: 6, syncopation: 0.3, tensionCurve: true, ghostNotes: 0.5 },
        edm:       { name: 'edm',       bpm: 138, swing: 0,  humanize: 8,  drumFills: true, syncopation: 0.15, tensionCurve: true, modalInterchange: 0.1, ghostNotes: 0.3 },
        speedcore: { name: 'speedcore', bpm: 220, swing: 0,  humanize: 5,  syncopation: 0.05, ghostNotes: 0.2 },
        dubstep:   { name: 'dubstep',   bpm: 140, swing: 15, humanize: 12, drumFills: true, syncopation: 0.3, tensionCurve: true, modalInterchange: 0.15, ghostNotes: 0.4 },
        country:   { name: 'country',   bpm: 110, swing: 15, humanize: 20, walkingBass: true, syncopation: 0.2, callResponse: true, modalInterchange: 0.1, ghostNotes: 0.3 },
        blues:     { name: 'blues',     bpm: 95,  swing: 50, humanize: 35, drumFills: true, walkingBass: true, syncopation: 0.4, callResponse: true, tensionCurve: true, modalInterchange: 0.2, ghostNotes: 0.5 },
        synthwave: { name: 'synthwave', bpm: 108, swing: 0,  humanize: 5,  syncopation: 0.05, ghostNotes: 0.15, tensionCurve: true, modalInterchange: 0.1 },
        trance:    { name: 'trance',    bpm: 140, swing: 0,  humanize: 5,  tensionCurve: true, syncopation: 0.1, ghostNotes: 0.2, modalInterchange: 0.15 },
        lofi:      { name: 'lofi',      bpm: 82,  swing: 35, humanize: 40, syncopation: 0.2, ghostNotes: 0.6, modalInterchange: 0.15 },
        reggae:    { name: 'reggae',    bpm: 75,  swing: 25, humanize: 25, syncopation: 0.4, ghostNotes: 0.3, walkingBass: true },
        funk:      { name: 'funk',      bpm: 108, swing: 30, humanize: 25, syncopation: 0.5, ghostNotes: 0.6, walkingBass: true, callResponse: true, drumFills: true },
        bossa:     { name: 'bossa',     bpm: 88,  swing: 40, humanize: 30, syncopation: 0.35, ghostNotes: 0.5, walkingBass: true, callResponse: true, modalInterchange: 0.25 },
        trap:      { name: 'trap',      bpm: 140, swing: 10, humanize: 8,  syncopation: 0.3, ghostNotes: 0.4, drumFills: true, tensionCurve: true },
        garage:    { name: 'garage',    bpm: 130, swing: 30, humanize: 18, syncopation: 0.35, ghostNotes: 0.45, drumFills: true },
        metal:     { name: 'metal',     bpm: 180, swing: 0,  humanize: 8,  syncopation: 0.15, ghostNotes: 0.2, drumFills: true, tensionCurve: true },
    };
    el._updateTraits();
    el.querySelector('.pn-genre-select').addEventListener('change', () => {
        el._traitOverrides = {}; // Reset overrides when genre changes
        el._updateTraits();
    });
    el._initTraitClicks();

    // Mixer panel (replaces tabs + track settings)
    const mixer = document.createElement('div');
    mixer.className = 'pn-mixer';
    el.appendChild(mixer);
    el._mixerEl = mixer;
    el._mixerEventsBound = false; // Reset so events bind to new element
    el._renderMixer();

    // Effects panel
    if (el._showFx === undefined) el._showFx = true;
    if (el._showOneShots === undefined) el._showOneShots = false;
    // Beats tab is hidden when the project has no stinger tracks at all —
    // the Fire pads need a real target net to unmute. Same predicate as
    // `sectionGroupForNet` in mixer.js, so the tab visibility matches the
    // mixer row hide/show exactly.
    const hasStingers = Object.entries(el._project?.nets || {}).some(
        ([id, nb]) => nb.role !== 'control' && isStingerTrack(id, nb)
    );
    if (!hasStingers) el._showOneShots = false;
    const fx = document.createElement('div');
    fx.className = 'pn-effects';
    fx.innerHTML = `
        <div class="pn-effects-toggle">
            <button class="pn-effects-btn ${el._showFx ? 'active' : ''}">FX</button>
            <button class="pn-macros-btn ${el._showMacros ? 'active' : ''}" title="Live performance macros">Macros</button>
            <button class="pn-oneshots-btn ${el._showOneShots ? 'active' : ''}" title="Beat fire pads" ${hasStingers ? '' : 'style="display:none"'}>Beats</button>
            <button class="pn-autodj-btn ${el._showAutoDj ? 'active' : ''}" title="Auto-DJ: fires random macros on a cadence">Auto-DJ</button>
            <button class="pn-arrange-btn ${el._showArrange ? 'active' : ''}" title="Arrange: drive the composer with structure, fades, breaks, feel/macro curves">Arrange</button>
            <button class="pn-note-btn ${el._showNote ? 'active' : ''}" title="Note — short plain-text annotation attached to the share envelope">Note</button>
            <button class="pn-midi-btn ${el._showMidi ? 'active' : ''}" title="MIDI — input bindings, live transpose, pad / CC learn">MIDI</button>
            <button class="pn-fx-bypass" title="Bypass all effects">Bypass</button>
            <button class="pn-fx-reset" title="Reset all effects to defaults">Reset</button>
            <button class="pn-macro-panic" title="Cancel all queued/running macros and animations">Panic</button>
            <button class="pn-crop-bar-btn" title="Crop track to loop region" style="display:none">✂ Crop</button>
            <select class="pn-loop-mode-select" title="Loop conflict resolution mode">
                <option value="drift">Drift</option>
                <option value="deterministic">Deterministic</option>
            </select>
        </div>
        <div class="pn-oneshots-panel" style="display:${el._showOneShots ? 'flex' : 'none'}">
            ${(() => {
                const opt = (v, label, def) => `<option value="${v}"${v===def?' selected':''}>${label}</option>`;
                // Only show Fire pads for one-shot macros whose target
                // stinger track actually exists in the current project.
                // Hand-authored tracks without hit1..hit4 (or without any
                // stinger-group tracks) end up with an empty Beats panel
                // instead of dead Fire buttons.
                const nets = el._project?.nets || {};
                const oneShots = MACROS.filter(m => m.kind === 'one-shot' && nets[m.id]);
                if (oneShots.length === 0) {
                    return `<div class="pn-os-empty">No stinger tracks in this project. Add a track with <code>track.group = "stinger"</code> to populate the Beats tab.</div>`;
                }
                const osCat = new Map();
                for (const inst of ONESHOT_INSTRUMENTS) {
                    const g = inst.group || 'Other';
                    if (!osCat.has(g)) osCat.set(g, []);
                    osCat.get(g).push(inst);
                }
                const osInstOpts = [...osCat.entries()].map(([g, items]) =>
                    `<optgroup label="${g}">${items.map(s => opt(s.id, s.label, '')).join('')}</optgroup>`
                ).join('');
                // Stingers are real tracks now (see composer.addStingerTracks);
                // the tab's rows are just manual Fire pads. Filter, vol, pan, and
                // preset controls live on the track's mixer row above.
                // Paired-macro dropdown: clicking Fire plays the sound AND
                // triggers the chosen macro simultaneously (duration comes
                // from the macro's defaultDuration). Auto-fires from the
                // stinger Petri track are sound-only — macros would be too
                // noisy if they ran every beat.
                const pairableMacros = MACROS.filter(m => m.kind !== 'one-shot');
                const pairByGroup = new Map();
                for (const m of pairableMacros) {
                    const g = m.group || 'Other';
                    if (!pairByGroup.has(g)) pairByGroup.set(g, []);
                    pairByGroup.get(g).push(m);
                }
                const pairOpts = `<option value="">No FX</option>` +
                    [...pairByGroup.entries()].map(([g, items]) =>
                        `<optgroup label="${g}">${items.map(x => `<option value="${x.id}">${x.label}</option>`).join('')}</optgroup>`
                    ).join('');
                const oneShotRows = oneShots.map(m => {
                    const pitchHtml = `<select class="pn-mixer-slider pn-os-pitch" data-macro="${m.id}" title="Pitch (semitones) — transposes the stinger track during the unmute window">
                        ${m.pitchOpts.map(v => opt(v, v > 0 ? '+'+v : ''+v, m.defaultPitch ?? 0)).join('')}
                    </select>`;
                    const fxHtml = `<select class="pn-os-pair" data-macro="${m.id}" title="Fire this macro together with the stinger — matches the Fire bar length">${pairOpts}</select>`;
                    const barOpts = [1, 2, 4, 8];
                    const barHtml = `<select class="pn-os-bars" data-macro="${m.id}" title="Fire duration — track stays unmuted for this many bars">
                        ${barOpts.map(v => `<option value="${v}"${v === 2 ? ' selected' : ''}>${v} bar${v === 1 ? '' : 's'}</option>`).join('')}
                    </select>`;
                    // Label reflects the current track.instrument (may differ from
                    // the macro's default sound after the user rotates / picks a
                    // new instrument on the mixer row). 'unbound' falls back to
                    // the slot's own id ("Hit1" / "Hit2" / …) so the button stays
                    // meaningful when no sound is loaded.
                    const currentInst = el._project?.nets?.[m.id]?.track?.instrument || m.sound;
                    const defaultLabel = currentInst === 'unbound'
                        ? prettifyInstrumentName(m.id)
                        : (oneShotSpec(currentInst)?.label || prettifyInstrumentName(currentInst));
                    return `<div class="pn-os-pad">
                        <button class="pn-macro-btn pn-os-fire" data-macro="${m.id}" title="Fire">Fire ${defaultLabel}</button>
                        ${barHtml}
                        <div class="pn-mixer-slider-group"><span>Pit</span>${pitchHtml}</div>
                        <div class="pn-mixer-slider-group"><span>FX</span>${fxHtml}</div>
                    </div>`;
                }).join('');

                return `<div class="pn-os-rows">${oneShotRows}</div>`;
            })()}
        </div>
        <div class="pn-autodj-panel" style="display:${el._showAutoDj ? 'flex' : 'none'}">
            <label class="pn-autodj-toggle">
                <input type="checkbox" class="pn-autodj-enable">
                <span>Run</span>
            </label>
            <label class="pn-autodj-toggle" title="Spin the ring on cadence without firing any macros">
                <input type="checkbox" class="pn-autodj-animate-only">
                <span>Animate only</span>
            </label>
            <label class="pn-autodj-field">
                <span>Every</span>
                <select class="pn-autodj-rate">
                    ${[1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024].map(v =>
                        `<option value="${v}"${v === 2 ? ' selected' : ''}>${v} bars · ${v * 4} beats</option>`
                    ).join('')}
                </select>
            </label>
            <fieldset class="pn-autodj-pools">
                <legend>Pools</legend>
                <label><input type="checkbox" class="pn-autodj-pool" value="Mute"  checked>Mute</label>
                <label><input type="checkbox" class="pn-autodj-pool" value="FX"    checked>FX</label>
                <label><input type="checkbox" class="pn-autodj-pool" value="Pan"   checked>Pan</label>
                <label><input type="checkbox" class="pn-autodj-pool" value="Shape" checked>Shape</label>
                <label><input type="checkbox" class="pn-autodj-pool" value="Pitch">Pitch</label>
                <label><input type="checkbox" class="pn-autodj-pool" value="Feel">Feel</label>
                <label><input type="checkbox" class="pn-autodj-pool" value="Tempo">Tempo</label>
                <label><input type="checkbox" class="pn-autodj-pool" value="Beats">Beats</label>
                <label title="Only fires on regen boundaries — curated sweeps/washes/risers for track transitions"><input type="checkbox" class="pn-autodj-pool" value="Transition" checked>Transition</label>
            </fieldset>
            <label class="pn-autodj-field">
                <span>Stack</span>
                <select class="pn-autodj-stack">
                    <option value="1" selected>1</option>
                    <option value="2">2</option>
                    <option value="3">3</option>
                </select>
            </label>
            <label class="pn-autodj-field">
                <span>Regen</span>
                <select class="pn-autodj-regen" title="Regenerate the whole track every N bars (off = never)">
                    <option value="0" selected>Off</option>
                    ${[8, 16, 32, 64, 128, 256, 512, 1024].map(v =>
                        `<option value="${v}">${v} bars · ${v * 4} beats</option>`
                    ).join('')}
                </select>
            </label>
            <button class="pn-autodj-test-transition" title="Fire a random Transition-pool macro now. Ignores Auto-DJ arm state.">Transition ⟳</button>
            <span class="pn-autodj-status">idle</span>
        </div>
        <div class="pn-arrange-panel" style="display:${el._showArrange ? 'flex' : 'none'}">
            <label class="pn-autodj-field">
                <span>Structure</span>
                <select class="pn-arrange-structure" title="Section blueprint size">
                    ${['loop','ab','minimal','standard','extended','drop','build','jam']
                        .map(v => `<option value="${v}"${v==='standard'?' selected':''}>${v}</option>`).join('')}
                </select>
            </label>
            <fieldset class="pn-autodj-pools pn-arrange-fades" title="Roles that start muted and unmute through the intro">
                <legend>Fade In</legend>
                <label><input type="checkbox" class="pn-arrange-fade" value="pad">pad</label>
                <label><input type="checkbox" class="pn-arrange-fade" value="melody">melody</label>
                <label><input type="checkbox" class="pn-arrange-fade" value="arp">arp</label>
                <label><input type="checkbox" class="pn-arrange-fade" value="lead">lead</label>
                <label><input type="checkbox" class="pn-arrange-fade" value="bass">bass</label>
            </fieldset>
            <label class="pn-autodj-field" title="Bars of drum-only break at the midpoint (0 disables)">
                <span>Drum Break</span>
                <select class="pn-arrange-drumbreak">
                    ${[0,2,4,8].map(v => `<option value="${v}"${v===0?' selected':''}>${v===0?'off':v+' bars'}</option>`).join('')}
                </select>
            </label>
            <label class="pn-autodj-field" title="Preset XY puck curve morphing tempo/FX across sections">
                <span>Feel Curve</span>
                <select class="pn-arrange-feelcurve">
                    <option value="" selected>off</option>
                    <option value="edm-arc">EDM arc</option>
                    <option value="chill-wave">Chill wave</option>
                    <option value="euphoric">Euphoric</option>
                </select>
            </label>
            <label class="pn-autodj-field" title="Preset macro schedule fired at section boundaries">
                <span>Macro Curve</span>
                <select class="pn-arrange-macrocurve">
                    <option value="" selected>off</option>
                    <option value="edm-classic">EDM classic</option>
                    <option value="drop-heavy">Drop heavy</option>
                    <option value="downtempo">Downtempo</option>
                </select>
            </label>
            <button class="pn-arrange-apply" title="Apply the selected arrangement as an overlay on the current track">Arrange ⟳</button>
            <span class="pn-arrange-status">idle</span>
        </div>
        <div class="pn-note-panel" style="display:${el._showNote ? 'flex' : 'none'}">
            <label class="pn-note-field" title="Plain-text note attached to this track. No HTML, no URLs. Travels in the share envelope and influences the CID.">
                <textarea class="pn-note-text" maxlength="280" rows="3"
                          placeholder="A short note about this track — plain text only.">${el._project?.note ? String(el._project.note).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : ''}</textarea>
                <div class="pn-note-meta">
                    <span class="pn-note-counter">0 / 280</span>
                    <span class="pn-note-hint">Tags, links and URLs are stripped on save.</span>
                </div>
            </label>
        </div>
        <div class="pn-midi-panel" style="display:${el._showMidi ? 'flex' : 'none'}">
            <div class="pn-midi-row">
                <span class="pn-midi-label">Status</span>
                <span class="pn-midi-status">Enable MIDI in the top-right toolbar to start binding.</span>
                <button type="button" class="pn-midi-monitor" title="Open the MIDI Monitor — logs every incoming message so you can identify pad / note / CC numbers your controller is sending">Monitor</button>
                <button type="button" class="pn-midi-reset-all" title="Clear every MIDI input binding (CC + pads + keyboard notes) and reset live transpose to +0">Reset MIDI</button>
            </div>
            <div class="pn-midi-row pn-midi-preset-row" hidden>
                <span class="pn-midi-label">Preset</span>
                <span class="pn-midi-preset-status"></span>
                <button type="button" class="pn-midi-preset-apply" title="Replace current bindings with the preset's defaults">Apply</button>
            </div>
            <div class="pn-midi-row" title="Live transpose — applied to all non-drum channels at fire time. The 🎹 toggle arms 'listen' mode: the next MIDI Note On from your keybed snaps the transpose to that key (relative to the project root or C4 fallback). Latched.">
                <span class="pn-midi-label">Xpose</span>
                <span class="pn-transpose">
                    <button type="button" class="pn-transpose-down" title="Transpose down 1 semitone">&minus;</button>
                    <span class="pn-transpose-val" title="Current transpose (semitones from project root). Double-click to reset.">+0</span>
                    <button type="button" class="pn-transpose-up" title="Transpose up 1 semitone">+</button>
                    <button type="button" class="pn-transpose-listen" title="When ON, the next MIDI note from your keybed sets the transpose. Latched — press another key to change again." aria-pressed="false">&#127929;</button>
                </span>
            </div>
            <div class="pn-midi-row pn-midi-bindings-row">
                <span class="pn-midi-label" title="Hover an FX or mixer slider, then move a MIDI CC knob — binds them. List clears on Reset.">CC</span>
                <span class="pn-midi-bindings pn-midi-cc-list">none — hover a slider then move a CC knob</span>
                <button type="button" class="pn-cc-reset" title="Clear all MIDI CC bindings">Reset</button>
            </div>
            <div class="pn-midi-row pn-midi-bindings-row">
                <span class="pn-midi-label" title="Hover a macro tile, then press a pad or keyboard key — binds them. Covers both MPK pads and keybed notes (anything that sends Note On). List clears on Reset.">Notes</span>
                <span class="pn-midi-bindings pn-midi-pad-list">none — hover a macro then press a pad / key</span>
                <button type="button" class="pn-pad-reset" title="Clear all MIDI note bindings (pads + keybed keys)">Reset</button>
            </div>
        </div>
        <div class="pn-macros-panel" style="display:${el._showMacros ? 'flex' : 'none'}">
            <div class="pn-macro-group pn-macro-edit-group">
                <div class="pn-macro-group-label">Auto-DJ</div>
                <button class="pn-macros-edit" title="Toggle edit mode — tap tiles to exclude them from Auto-DJ (right-click / long-press also works)">Edit Excludes</button>
                <div class="pn-macro-edit-hint">Tap tiles to toggle</div>
            </div>
            ${(() => {
                const others = MACROS.filter(m => m.kind !== 'one-shot');
                const byGroup = new Map();
                for (const m of others) {
                    const g = m.group || 'Other';
                    if (!byGroup.has(g)) byGroup.set(g, []);
                    byGroup.get(g).push(m);
                }
                return [...byGroup.entries()].map(([label, items]) => `
                    <div class="pn-macro-group">
                        <div class="pn-macro-group-label">${label}</div>
                        ${items.map(m => {
                            const needsDuration = m.durationOpts.length > 1 || (m.durationLabel && m.durationLabel.length > 0);
                            // Kinds where "∞" (permanent — fire and don't auto-restore) is meaningful.
                            const permKinds = new Set(['mute', 'fx-sweep', 'fx-hold', 'pan-move', 'decay-move', 'tempo-hold', 'tempo-anchor', 'feel-snap']);
                            const opts = permKinds.has(m.kind) && !m.durationOpts.includes(0)
                                ? [...m.durationOpts, 0]
                                : m.durationOpts;
                            const renderOpt = (v) => v === 0
                                ? `<option value="0" title="Permanent — apply and do not auto-restore">∞</option>`
                                : `<option value="${v}"${v===m.defaultDuration?' selected':''}>${v} ${m.durationLabel}${v===1?'':'s'}</option>`;
                            const selectHtml = needsDuration
                                ? `<select class="pn-macro-bars" data-macro="${m.id}" title="Duration">
                                       ${opts.map(renderOpt).join('')}
                                   </select>`
                                : '';
                            const pitchHtml = m.pitchOpts
                                ? `<select class="pn-macro-pitch" data-macro="${m.id}" title="Pitch (semitones)">
                                       ${m.pitchOpts.map(v => `<option value="${v}"${v===(m.defaultPitch ?? 0)?' selected':''}>${v > 0 ? '+'+v : v} st</option>`).join('')}
                                   </select>`
                                : '';
                            const isTransition = TRANSITION_MACRO_IDS.has(m.id);
                            const transClass = isTransition ? ' pn-macro-transition' : '';
                            const transTitle = isTransition ? ` — also fires on Auto-DJ track transitions` : '';
                            return `<div class="pn-macro-item">
                                        <button class="pn-macro-btn${transClass}" data-macro="${m.id}" title="${m.label}${transTitle}">${m.label}</button>
                                        ${selectHtml}
                                        ${pitchHtml}
                                    </div>`;
                        }).join('')}
                    </div>
                `).join('');
            })()}
        </div>
        <div class="pn-effects-panel" style="display:${el._showFx ? 'flex' : 'none'}">
            <div class="pn-fx-group">
                <span class="pn-fx-label">Master</span>
                <div class="pn-fx-control">
                    <span>Vol</span>
                    <input type="range" class="pn-fx-slider" data-fx="master-vol" data-default="80" min="0" max="100" value="80">
                </div>
            </div>
            <div class="pn-fx-group">
                <span class="pn-fx-label">Reverb</span>
                <div class="pn-fx-control">
                    <span>Size</span>
                    <input type="range" class="pn-fx-slider" data-fx="reverb-size" data-default="50" min="0" max="100" value="50">
                </div>
                <div class="pn-fx-control">
                    <span>Damp</span>
                    <input type="range" class="pn-fx-slider" data-fx="reverb-damp" data-default="30" min="0" max="100" value="30">
                </div>
                <div class="pn-fx-control">
                    <span>Mix</span>
                    <input type="range" class="pn-fx-slider" data-fx="reverb-wet" data-default="20" min="0" max="100" value="20">
                </div>
            </div>
            <div class="pn-fx-group">
                <span class="pn-fx-label">Delay</span>
                <div class="pn-fx-control">
                    <span>Time</span>
                    <input type="range" class="pn-fx-slider" data-fx="delay-time" data-default="25" min="1" max="100" value="25">
                </div>
                <div class="pn-fx-control">
                    <span>Feedback</span>
                    <input type="range" class="pn-fx-slider" data-fx="delay-feedback" data-default="25" min="0" max="90" value="25">
                </div>
                <div class="pn-fx-control">
                    <span>Mix</span>
                    <input type="range" class="pn-fx-slider" data-fx="delay-wet" data-default="15" min="0" max="100" value="15">
                </div>
            </div>
            <div class="pn-fx-group">
                <span class="pn-fx-label">Distort</span>
                <div class="pn-fx-control">
                    <span>Drive</span>
                    <input type="range" class="pn-fx-slider" data-fx="distortion" data-default="0" min="0" max="100" value="0">
                </div>
            </div>
            <div class="pn-fx-group">
                <span class="pn-fx-label">Pitch</span>
                <div class="pn-fx-control">
                    <span>Semi</span>
                    <input type="range" class="pn-fx-slider" data-fx="master-pitch" data-default="0" min="-12" max="12" step="1" value="0">
                </div>
            </div>
            <div class="pn-fx-group">
                <span class="pn-fx-label">Filter</span>
                <div class="pn-fx-control">
                    <span>Lo Cut</span>
                    <input type="range" class="pn-fx-slider" data-fx="hp-freq" data-default="0" min="0" max="100" value="0">
                </div>
                <div class="pn-fx-control">
                    <span>Hi Cut</span>
                    <input type="range" class="pn-fx-slider" data-fx="lp-freq" data-default="100" min="0" max="100" value="100">
                </div>
            </div>
            <div class="pn-fx-group">
                <span class="pn-fx-label">Phaser</span>
                <div class="pn-fx-control">
                    <span>Rate</span>
                    <input type="range" class="pn-fx-slider" data-fx="phaser-freq" data-default="0" min="0" max="100" value="0">
                </div>
                <div class="pn-fx-control">
                    <span>Depth</span>
                    <input type="range" class="pn-fx-slider" data-fx="phaser-depth" data-default="50" min="0" max="100" value="50">
                </div>
                <div class="pn-fx-control">
                    <span>Mix</span>
                    <input type="range" class="pn-fx-slider" data-fx="phaser-wet" data-default="0" min="0" max="100" value="0">
                </div>
            </div>
            <div class="pn-fx-group">
                <span class="pn-fx-label">Crush</span>
                <div class="pn-fx-control">
                    <span>Bits</span>
                    <input type="range" class="pn-fx-slider" data-fx="crush-bits" data-default="0" min="0" max="100" value="0">
                </div>
            </div>
        </div>
    `;
    el.appendChild(fx);
    el._fxEl = fx;
    el._fxNotchesAdded = true;
    requestAnimationFrame(() => el._addDefaultNotches(fx));

    // Live transpose pill — lives inside the new MIDI panel. Wiring
    // runs AFTER fx is appended so the querySelectors actually find
    // the elements.
    if (el._liveTranspose == null) el._liveTranspose = 0;
    if (el._transposeListen == null) el._transposeListen = false;
    const tVal    = fx.querySelector('.pn-transpose-val');
    const tDown   = fx.querySelector('.pn-transpose-down');
    const tUp     = fx.querySelector('.pn-transpose-up');
    const tListen = fx.querySelector('.pn-transpose-listen');
    if (tVal && tDown && tUp && tListen) {
        const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const renderTranspose = () => {
            const n = el._liveTranspose | 0;
            const sign = n > 0 ? '+' : (n < 0 ? '−' : '+');
            tVal.textContent = `${sign}${Math.abs(n)}`;
            tVal.dataset.lit = n !== 0 ? 'true' : 'false';
            const root = (el._project?.rootNote ?? 60) | 0;
            const key  = NOTE_NAMES[(((root + n) % 12) + 12) % 12];
            tVal.title = `Live transpose: ${sign}${Math.abs(n)} semitones (current key ≈ ${key}). Double-click to reset.`;
            tListen.dataset.on = el._transposeListen ? 'true' : 'false';
            tListen.setAttribute('aria-pressed', el._transposeListen ? 'true' : 'false');
        };
        el._renderTranspose = renderTranspose;
        el._setLiveTranspose = (n) => {
            // ±48 semitones = 4 octaves up + down. Beyond that the
            // post-transpose MIDI note clamp at fire time (0..127)
            // starts swallowing notes — most synth voices already
            // hit their natural range limit by 4 octaves anyway.
            el._liveTranspose = Math.max(-48, Math.min(48, n | 0));
            renderTranspose();
        };
        tDown.addEventListener('click',   () => el._setLiveTranspose(el._liveTranspose - 1));
        tUp.addEventListener('click',     () => el._setLiveTranspose(el._liveTranspose + 1));
        tVal.addEventListener('dblclick', () => el._setLiveTranspose(0));
        tListen.addEventListener('click', () => {
            el._transposeListen = !el._transposeListen;
            renderTranspose();
        });
        renderTranspose();
    }

    // MIDI tab — bindings list refreshes from el._ccBindings /
    // el._padBindings; status text reflects whether MIDI input has
    // been authorised. Reset Pads / Reset CC clear the maps in place.
    const midiBtn   = fx.querySelector('.pn-midi-btn');
    const midiPanel = fx.querySelector('.pn-midi-panel');
    if (midiBtn && midiPanel) {
        const ccList     = midiPanel.querySelector('.pn-midi-cc-list');
        const padList    = midiPanel.querySelector('.pn-midi-pad-list');
        const statusEl   = midiPanel.querySelector('.pn-midi-status');
        const padResetBtn = midiPanel.querySelector('.pn-pad-reset');
        const presetRow    = midiPanel.querySelector('.pn-midi-preset-row');
        const presetStatus = midiPanel.querySelector('.pn-midi-preset-status');
        const presetApply  = midiPanel.querySelector('.pn-midi-preset-apply');
        const formatCC = () => {
            if (!el._ccBindings || el._ccBindings.size === 0) {
                return 'none — hover a slider then move a CC knob';
            }
            // Build per-group muted-set so mute-bound CC entries can
            // show the same ●/○ live indicator as note bindings.
            const mutedGroups = new Set();
            const mutedNets = new Set(el._project?.initialMutes || []);
            for (const [id, net] of Object.entries(el._project?.nets || {})) {
                if (mutedNets.has(id) && net?.riffGroup) mutedGroups.add(net.riffGroup);
            }
            return [...el._ccBindings.entries()]
                .map(([cc, b]) => {
                    if (b?.type === 'mute') {
                        const dot = mutedGroups.has(b.target) ? '○' : '●';
                        return `CC${cc} ${dot} ${b.target} (mute)`;
                    }
                    return `CC${cc} → ${b.key}`;
                })
                .join('  ·  ');
        };
        const formatPads = () => {
            if (!el._padBindings || el._padBindings.size === 0) {
                return 'none — hover a macro then press a pad / key';
            }
            // Compute current per-group mute state once so the binding
            // list can show MUTED indicators inline. Looks at the
            // shared sequencer mute state mirrored on _project.
            const mutedGroups = new Set();
            const mutedNets = new Set(el._project?.initialMutes || []);
            for (const [id, net] of Object.entries(el._project?.nets || {})) {
                if (mutedNets.has(id) && net?.riffGroup) mutedGroups.add(net.riffGroup);
            }
            return [...el._padBindings.entries()]
                .map(([note, b]) => {
                    if (typeof b === 'string') return `n${note} → ${b}`;
                    if (b?.type === 'mute') {
                        const lit = !mutedGroups.has(b.target);
                        const dot = lit ? '●' : '○';
                        return `n${note} ${dot} ${b.target}`;
                    }
                    return `n${note} → ?`;
                })
                .join('  ·  ');
        };
        const formatStatus = () => {
            if (!el._midiInputConnected) {
                return 'MIDI input not enabled — click MIDI in the top toolbar.';
            }
            const inputs = el._midiAccess
                ? [...el._midiAccess.inputs.values()].map(i => i.name).filter(Boolean)
                : [];
            if (!inputs.length) return 'MIDI ON — no input devices detected.';
            return `MIDI ON — ${inputs.join(', ')}`;
        };
        const renderMidi = () => {
            ccList.textContent = formatCC();
            padList.textContent = formatPads();
            statusEl.textContent = formatStatus();
            // Preset row: only shown when a known controller has been
            // detected and we have a recommended preset for it.
            const preset = el._detectedMidiPreset;
            if (preset) {
                presetRow.hidden = false;
                presetStatus.textContent = `${preset.label} (detected as “${el._detectedMidiInputName}”). ${preset.notes}`;
                presetApply.title = `Apply ${preset.label}: ${Object.keys(preset.pads||{}).length} pad mappings + ${Object.keys(preset.ccs||{}).length} CC mappings. Replaces existing bindings.`;
            } else {
                presetRow.hidden = true;
            }
        };
        el._renderMidiPanel = renderMidi;
        midiBtn.addEventListener('click', () => {
            el._showMidi = !el._showMidi;
            midiPanel.style.display = el._showMidi ? 'flex' : 'none';
            midiBtn.classList.toggle('active', el._showMidi);
            if (el._showMidi) renderMidi();
        });
        padResetBtn.addEventListener('click', () => {
            el._padBindings?.clear();
            el._savePadBindings?.();
            renderMidi();
        });
        // Apply detected preset — overwrites current CC + pad bindings
        // with the registry's defaults for the detected controller.
        presetApply.addEventListener('click', () => {
            const preset = el._detectedMidiPreset;
            if (!preset) return;
            applyMidiPreset(el, preset);
            renderMidi();
        });
        // Monitor — pops the MIDI Monitor modal so the user can
        // identify pad / note / CC numbers without binding anything.
        midiPanel.querySelector('.pn-midi-monitor').addEventListener('click', () => {
            el._showMidiMonitor?.();
        });
        // Master "Reset MIDI" — wipes every input binding (CC + pad
        // + keybed-note) and resets live transpose to +0. Useful when
        // a previous performance left the surface bound up and the
        // user wants a clean slate without hunting two buttons.
        midiPanel.querySelector('.pn-midi-reset-all').addEventListener('click', () => {
            el._ccBindings?.clear();
            el._padBindings?.clear();
            el._savePadBindings?.();
            el._transposeListen = false;
            el._setLiveTranspose?.(0);
            renderMidi();
        });
        renderMidi();
    }

    // FX, One-Shots and Macros each toggle independently. Stacking order
    // is controlled via CSS `order` on the .pn-effects flex container.
    const macrosBtn   = fx.querySelector('.pn-macros-btn');
    const fxBtn       = fx.querySelector('.pn-effects-btn');
    const oneShotsBtn = fx.querySelector('.pn-oneshots-btn');
    const fxPanel     = fx.querySelector('.pn-effects-panel');
    const mxPanel     = fx.querySelector('.pn-macros-panel');
    const osPanel     = fx.querySelector('.pn-oneshots-panel');
    macrosBtn.addEventListener('click', () => {
        el._showMacros = !el._showMacros;
        mxPanel.style.display = el._showMacros ? 'flex' : 'none';
        macrosBtn.classList.toggle('active', el._showMacros);
    });
    fxBtn.addEventListener('click', () => {
        el._showFx = !el._showFx;
        fxPanel.style.display = el._showFx ? 'flex' : 'none';
        fxBtn.classList.toggle('active', el._showFx);
    });
    oneShotsBtn.addEventListener('click', () => {
        el._showOneShots = !el._showOneShots;
        osPanel.style.display = el._showOneShots ? 'flex' : 'none';
        oneShotsBtn.classList.toggle('active', el._showOneShots);
        // hit* rows in the main mixer are gated on this flag; re-render
        // so they appear/disappear alongside the Beats panel.
        el._renderMixer();
    });
    // Auto-DJ toggle — panel visibility only; the enable checkbox inside
    // drives whether the engine actually fires macros, so users can leave
    // the panel open while the DJ is paused.
    const autoDjBtn   = fx.querySelector('.pn-autodj-btn');
    const autoDjPanel = fx.querySelector('.pn-autodj-panel');
    autoDjBtn.addEventListener('click', () => {
        el._showAutoDj = !el._showAutoDj;
        autoDjPanel.style.display = el._showAutoDj ? 'flex' : 'none';
        autoDjBtn.classList.toggle('active', el._showAutoDj);
        el._saveAutoDjSettings();
    });
    // Persist every panel change so settings survive reload, auto-advance
    // to shuffled / extended next tracks, Auto-DJ regens, etc.
    autoDjPanel.addEventListener('change', () => el._saveAutoDjSettings());
    // Test Transition button: fires a random transition-pool macro
    // immediately, bypassing the Auto-DJ arm/Transition-pool gates so
    // users can audition the sound without arming.
    autoDjPanel.querySelector('.pn-autodj-test-transition')?.addEventListener('click', () => {
        el._disabledMacros = el._disabledMacros || el._loadDisabledMacros();
        const ids = [...TRANSITION_MACRO_IDS].filter(id => !el._disabledMacros.has(id));
        if (ids.length === 0) {
            const statusEl = el.querySelector('.pn-autodj-status');
            if (statusEl) statusEl.textContent = '(no candidates — all disabled)';
            return;
        }
        const id = ids[Math.floor(Math.random() * ids.length)];
        const macro = MACROS.find(m => m.id === id);
        el._fireMacro(id);
        const statusEl = el.querySelector('.pn-autodj-status');
        if (statusEl) statusEl.textContent = `⟳ ${macro?.label || id}`;
    });
    // Hydrate the panel from the last-saved settings (if any)
    el._restoreAutoDjSettings(autoDjBtn, autoDjPanel);

    // Arrange tab — live-driven arrangement overlays. The panel collects
    // a small DSL (structure / fadeIn / drumBreak / feelCurve preset /
    // macroCurve preset) and POSTs it to /api/arrange with overlay=true
    // against the currently loaded project. Server returns the expanded
    // project; we project-load it back into the worker.
    const arrangeBtn   = fx.querySelector('.pn-arrange-btn');
    const arrangePanel = fx.querySelector('.pn-arrange-panel');
    arrangeBtn.addEventListener('click', () => {
        el._showArrange = !el._showArrange;
        arrangePanel.style.display = el._showArrange ? 'flex' : 'none';
        arrangeBtn.classList.toggle('active', el._showArrange);
    });
    arrangePanel.querySelector('.pn-arrange-apply')?.addEventListener('click', () => {
        applyArrangeFromPanel(el, arrangePanel);
    });

    // Note tab: textarea bound to el._project.note. Sanitises on every
    // input event so a paste of "<a href=...>x</a>" or
    // "https://evil.example" becomes plain text immediately. The Go
    // sanitiser (internal/share/note.go::SanitizeNote) is the
    // authority and rejects mismatched envelopes at seal time — this
    // is just for live UX.
    const noteBtn   = fx.querySelector('.pn-note-btn');
    const notePanel = fx.querySelector('.pn-note-panel');
    const noteText  = notePanel.querySelector('.pn-note-text');
    const noteCount = notePanel.querySelector('.pn-note-counter');
    const updateNoteCount = () => {
        const n = [...noteText.value].length; // rune-ish count via spread
        noteCount.textContent = `${n} / 280`;
        noteCount.style.color = n > 260 ? '#f5a623' : '#888';
    };
    noteBtn.addEventListener('click', () => {
        el._showNote = !el._showNote;
        notePanel.style.display = el._showNote ? 'flex' : 'none';
        noteBtn.classList.toggle('active', el._showNote);
        if (el._showNote) {
            updateNoteCount();
            noteText.focus();
        }
    });
    noteText.addEventListener('input', () => {
        // liveScrub strips dangerous shapes (tags / URLs /
        // non-printables) but preserves whitespace so the user can
        // type "hello world" without the trailing space being eaten
        // before they reach the next word. Full sanitiseNote (with
        // per-line trim + collapse) runs at Share time.
        const cleaned = liveScrubNote(noteText.value);
        if (cleaned !== noteText.value) {
            const pos = Math.min(noteText.selectionStart, cleaned.length);
            noteText.value = cleaned;
            noteText.setSelectionRange(pos, pos);
        }
        if (el._project) el._project.note = noteText.value;
        updateNoteCount();
    });
    // On paste, scrub the pasted slice up front (still preserving
    // whitespace) so the visible state is clean.
    noteText.addEventListener('paste', (e) => {
        const data = (e.clipboardData || window.clipboardData)?.getData('text');
        if (data == null) return;
        e.preventDefault();
        const cleaned = liveScrubNote(data);
        document.execCommand('insertText', false, cleaned);
    });
    // On blur, run the full sanitiser so the textarea reflects what
    // would be sealed (trimmed lines, collapsed blank-line runs).
    noteText.addEventListener('blur', () => {
        const cleaned = sanitizeNote(noteText.value);
        if (cleaned !== noteText.value) {
            noteText.value = cleaned;
            if (el._project) el._project.note = cleaned;
            updateNoteCount();
        }
    });
    updateNoteCount();

    // Feel icon (inside the traits row) opens a modal with the 4 sliders.
    // Slider positions are persisted so even without opening the modal
    // the last-saved feel is applied on boot.
    el.addEventListener('click', (e) => {
        if (e.target.closest('.pn-feel-open')) el._openFeelModal();
    });
    el._restoreFeelSettings();
    // Restore persisted "macro disabled" marks after the panels are built
    el._disabledMacros = el._loadDisabledMacros();
    el._refreshMacroDisabledMarks();
    // One-shot panel forwards clicks and keeps Fire button labels synced
    osPanel.addEventListener('click', (e) => {
        const save = e.target.closest('.pn-os-save');
        if (save)  { el._oneShotFavorite(save.dataset.macro, e); return; }
        const reset = e.target.closest('.pn-os-tone-reset');
        if (reset) { el._oneShotToneReset(reset.dataset.macro); return; }
        const prev = e.target.closest('.pn-os-tone-prev');
        if (prev)  { el._oneShotToneStep(prev.dataset.macro, -1); return; }
        const next = e.target.closest('.pn-os-tone-next');
        if (next)  { el._oneShotToneStep(next.dataset.macro, +1); return; }
        const btn = e.target.closest('.pn-macro-btn');
        if (!btn) return;
        el._fireMacro(btn.dataset.macro);
    });
    osPanel.addEventListener('contextmenu', (e) => {
        const btn = e.target.closest('.pn-macro-btn');
        if (!btn) return;
        e.preventDefault();
        el._toggleMacroDisabled(btn.dataset.macro);
    });
    el._bindLongPressToggle(osPanel);
    osPanel.addEventListener('change', (e) => {
        const sel = e.target.closest('.pn-os-inst');
        if (!sel) return;
        const macroId = sel.dataset.macro;
        const btn = osPanel.querySelector(`.pn-os-fire[data-macro="${macroId}"]`);
        if (!btn) return;
        const label = oneShotSpec(sel.value)?.label || sel.value;
        btn.textContent = `Fire ${label}`;
    });

    // Edit-mode toggle: when active, tile taps toggle disabled instead of
    // firing. Gives touch devices (iPad) a reliable way to exclude macros
    // from Auto-DJ without relying on long-press, which is flaky under iOS
    // Safari's native callout gesture.
    const macrosEditBtn = mxPanel.querySelector('.pn-macros-edit');
    macrosEditBtn?.addEventListener('click', () => {
        const active = mxPanel.classList.toggle('pn-edit-mode');
        macrosEditBtn.classList.toggle('active', active);
    });
    // Macro button clicks → fire the macro, unless we're in edit mode.
    mxPanel.addEventListener('click', (e) => {
        const btn = e.target.closest('.pn-macro-btn');
        if (!btn) return;
        if (mxPanel.classList.contains('pn-edit-mode')) {
            el._toggleMacroDisabled(btn.dataset.macro);
            return;
        }
        el._fireMacro(btn.dataset.macro);
    });
    // Right-click toggles a macro's "disabled" flag — Auto-DJ skips
    // disabled macros when picking random candidates. Persists to
    // localStorage so the choice survives reload.
    mxPanel.addEventListener('contextmenu', (e) => {
        const btn = e.target.closest('.pn-macro-btn');
        if (!btn) return;
        e.preventDefault();
        el._toggleMacroDisabled(btn.dataset.macro);
    });
    el._bindLongPressToggle(mxPanel);
    // Track hovered macro button for MIDI pad binding
    mxPanel.addEventListener('mouseover', (e) => {
        const btn = e.target.closest('.pn-macro-btn');
        if (btn) el._hoveredMacro = btn;
    });
    mxPanel.addEventListener('mouseout', (e) => {
        const btn = e.target.closest('.pn-macro-btn');
        if (btn && btn === el._hoveredMacro) el._hoveredMacro = null;
    });

    // FX bypass toggle
    el._fxBypassed = false;
    el._fxSavedValues = null;
    fx.querySelector('.pn-fx-bypass').addEventListener('click', () => {
        const btn = fx.querySelector('.pn-fx-bypass');
        el._fxBypassed = !el._fxBypassed;
        btn.classList.toggle('active', el._fxBypassed);
        btn.textContent = el._fxBypassed ? 'Bypassed' : 'Bypass';
        if (el._fxBypassed) {
            // Save current values (except master-vol) and zero out wet/mix sends
            el._fxSavedValues = {};
            fx.querySelectorAll('.pn-fx-slider').forEach(s => {
                if (s.dataset.fx !== 'master-vol') {
                    el._fxSavedValues[s.dataset.fx] = s.value;
                }
            });
            toneEngine.setReverbWet(0);
            toneEngine.setDelayWet(0);
            toneEngine.setDistortion(0);
            toneEngine.setHighpassFreq(20);
            toneEngine.setLowpassFreq(20000);
            toneEngine.setPhaserWet(0);
            toneEngine.setCrush(0);
        } else {
            // Restore saved values — skip reverb size/damp (they weren't changed,
            // and setting dampening triggers unstable IIR filter rebuilds)
            if (el._fxSavedValues) {
                const skipOnRestore = new Set(['reverb-size', 'reverb-damp']);
                for (const [fxName, val] of Object.entries(el._fxSavedValues)) {
                    const slider = fx.querySelector(`.pn-fx-slider[data-fx="${fxName}"]`);
                    if (slider) slider.value = val;
                    if (!skipOnRestore.has(fxName)) {
                        applyFx(fxName, parseInt(val));
                    }
                }
                el._fxSavedValues = null;
            }
        }
    });

    // FX reset
    const fxDefaults = {
        'reverb-size': 50, 'reverb-damp': 30, 'reverb-wet': 20,
        'delay-time': 25, 'delay-feedback': 25, 'delay-wet': 15,
        'master-vol': 80, 'distortion': 0, 'hp-freq': 0, 'lp-freq': 100,
        'phaser-freq': 0, 'phaser-depth': 50, 'phaser-wet': 0,
        'crush-bits': 0, 'master-pitch': 0,
    };
    fx.querySelector('.pn-fx-reset').addEventListener('click', () => {
        el._fxBypassed = false;
        el._fxSavedValues = null;
        const bypassBtn = fx.querySelector('.pn-fx-bypass');
        bypassBtn.classList.remove('active');
        bypassBtn.textContent = 'Bypass';
        for (const [fxName, def] of Object.entries(fxDefaults)) {
            const slider = fx.querySelector(`.pn-fx-slider[data-fx="${fxName}"]`);
            if (slider) slider.value = def;
            applyFx(fxName, def);
        }
        // FX sliders are back to defaults — Feel's live-half is no longer
        // reflected on the master chain, so flip the engagement flag and
        // drop the · feels genre marker. Slider positions in _feelState
        // stay so re-engaging is a single nudge away.
        el._disengageFeel();
    });

    fx.querySelector('.pn-cc-reset').addEventListener('click', () => {
        el._ccBindings.clear();
        el._renderMidiPanel?.();
    });

    // Panic: drop the macro queue, cancel every live animation token,
    // strip the chase-pulse CSS everywhere, and nudge worker-side macro
    // nets so any muted-by-macro tracks come back ASAP. Leaves user-held
    // mutes, tempo changes, and manually-set FX values alone — only
    // tears down macro side effects that were in flight.
    fx.querySelector('.pn-macro-panic').addEventListener('click', () => el._panicMacros());

    fx.querySelector('.pn-crop-bar-btn').addEventListener('click', () => {
        if (el._loopStart >= 0 && el._loopEnd > el._loopStart) {
            el._sendWs({ type: 'crop', startTick: el._loopStart, endTick: el._loopEnd });
        }
    });

    fx.querySelector('.pn-loop-mode-select').addEventListener('change', (e) => {
        el._sendWs({ type: 'deterministic-loop', enabled: e.target.value === 'deterministic' });
    });

    // FX slider events - throttled to avoid audio thread overload
    let _fxThrottleId = null;
    const _fxPending = new Map();   // fxKey -> latest value awaiting engine dispatch
    const applyFx = (fxName, val) => {
        switch (fxName) {
            case 'reverb-size':    toneEngine.setReverbSize(val / 100); break;
            case 'reverb-damp':    toneEngine.setReverbDampening(10000 - (val / 100) * 9800); break;
            case 'reverb-wet':     toneEngine.setReverbWet(val / 100); break;
            case 'delay-time':     toneEngine.setDelayTime(val / 100); break;
            case 'delay-feedback': toneEngine.setDelayFeedback(val / 100); break;
            case 'delay-wet':      toneEngine.setDelayWet(val / 100); break;
            case 'master-vol':     toneEngine.setMasterVolume(val === 0 ? -60 : -60 + (val / 100) * 60); break;
            case 'distortion':     toneEngine.setDistortion(val / 100); break;
            case 'master-pitch':   toneEngine.setMasterPitch(val); break;
            case 'hp-freq':        toneEngine.setHighpassFreq(hpFreq(val)); break;
            case 'lp-freq':        toneEngine.setLowpassFreq(lpFreq(val)); break;
            case 'phaser-freq':    toneEngine.setPhaserFreq(val === 0 ? 0 : 0.1 + (val / 100) * 9.9); break;
            case 'phaser-depth':   toneEngine.setPhaserDepth(val / 100); break;
            case 'phaser-wet':     toneEngine.setPhaserWet(val / 100); break;
            case 'crush-bits':     toneEngine.setCrush(val / 100); break;
        }
    };
    fx.addEventListener('input', (e) => {
        const slider = e.target.closest('.pn-fx-slider');
        if (!slider) return;
        const key = slider.dataset.fx;
        const val = parseInt(slider.value);
        // Queue this key's latest value; other keys stay pending independently
        // so a multi-slider dispatch (e.g. a macro touching wet + size in the
        // same rAF tick) can't silently drop one value by overwriting another.
        _fxPending.set(key, val);
        // Keep the floating cursor tip in sync when the user drags the
        // currently-hovered FX slider.
        syncSliderTip(slider, formatFxValue(key, val));
        // Throttle engine calls to ~30fps — but flush every pending key
        if (!_fxThrottleId) {
            _fxThrottleId = setTimeout(() => {
                for (const [k, v] of _fxPending) applyFx(k, v);
                _fxPending.clear();
                _fxThrottleId = null;
            }, 33);
        }
    });

    // Cursor-anchored tip for FX sliders — same pattern as the mixer.
    // No inline value spans, so the row stays compact and hover state
    // never affects layout.
    fx.addEventListener('mousemove', (e) => {
        const control = e.target.closest('.pn-fx-control');
        if (!control) { hideSliderTip(); return; }
        const slider = control.querySelector('.pn-fx-slider');
        if (!slider) return;
        showSliderTip(slider, formatFxValue(slider.dataset.fx, parseInt(slider.value)), e.clientX, e.clientY);
    });
    fx.addEventListener('mouseleave', () => hideSliderTip());

    // Track hovered FX slider for MIDI CC binding
    fx.addEventListener('mouseover', (e) => {
        const slider = e.target.closest('.pn-fx-slider');
        if (slider) el._hoveredSlider = slider;
    });
    fx.addEventListener('mouseout', (e) => {
        const slider = e.target.closest('.pn-fx-slider');
        if (slider && slider === el._hoveredSlider) el._hoveredSlider = null;
    });

    // BPM input — hover tracking so a CC twist while hovering binds
    // the knob to live tempo control. Lives on el (not fx) since the
    // .pn-tempo input is in the header.
    el.addEventListener('mouseover', (e) => {
        const bpm = e.target.closest('.pn-tempo');
        if (bpm) {
            const input = bpm.querySelector('input[type="number"]');
            if (input) el._hoveredSlider = input;
        }
    });
    el.addEventListener('mouseout', (e) => {
        const bpm = e.target.closest('.pn-tempo');
        if (bpm) {
            const input = bpm.querySelector('input[type="number"]');
            if (input && input === el._hoveredSlider) el._hoveredSlider = null;
        }
    });

    // FX scroll wheel support (1% per tick)
    fx.addEventListener('wheel', (e) => {
        const control = e.target.closest('.pn-fx-control');
        if (!control) return;
        e.preventDefault();
        const slider = control.querySelector('.pn-fx-slider');
        if (!slider) return;
        const min = parseInt(slider.min);
        const max = parseInt(slider.max);
        const step = e.deltaY < 0 ? 1 : -1;
        slider.value = Math.max(min, Math.min(max, parseInt(slider.value) + step));
        slider.dispatchEvent(new Event('input', { bubbles: true }));
    }, { passive: false });

    // Timeline (structure mode only)
    const timeline = document.createElement('div');
    timeline.className = 'pn-timeline';
    timeline.style.display = el._structure ? 'flex' : 'none';
    el.appendChild(timeline);
    el._timelineEl = timeline;
    el._renderTimeline();

    // Timeline: click to seek, drag markers to set loop region
    timeline.addEventListener('mousedown', (e) => {
        if (e.button === 2) return; // right-click handled by contextmenu
        if (!el._totalSteps || !el._structure) return;
        const rect = timeline.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;

        // Check if clicking on a loop marker (within 10px)
        const startX = (el._loopStart / el._totalSteps) * rect.width;
        const endX = (el._loopEnd / el._totalSteps) * rect.width;
        const clickX = e.clientX - rect.left;

        if (el._loopStart >= 0 && Math.abs(clickX - startX) < 10) {
            el._draggingMarker = 'start';
            e.preventDefault();
            return;
        }
        if (el._loopEnd >= 0 && Math.abs(clickX - endX) < 10) {
            el._draggingMarker = 'end';
            e.preventDefault();
            return;
        }

        // Plain click: seek
        const targetTick = Math.floor(pct * el._totalSteps);
        el._sendWs({ type: 'seek', tick: targetTick });
        el._tick = targetTick;
        el._lastPlayheadPct = null;
        el._updatePlayhead();
    });

    timeline.addEventListener('mousemove', (e) => {
        if (!el._draggingMarker || !el._totalSteps) return;
        e.preventDefault();
        const rect = timeline.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const tick = Math.round(pct * el._totalSteps / 16) * 16; // snap to bar
        if (el._draggingMarker === 'start') el._loopStart = tick;
        else el._loopEnd = tick;
        el._updateLoopMarkers();
    });

    const endDrag = () => {
        if (!el._draggingMarker) return;
        // Swap if start > end
        if (el._loopStart > el._loopEnd) {
            [el._loopStart, el._loopEnd] = [el._loopEnd, el._loopStart];
        }
        // Send loop to server (only active when markers are moved from default positions)
        const isFullRange = el._loopStart === 0 && el._loopEnd === el._totalSteps;
        if (isFullRange) {
            el._sendWs({ type: 'loop', startTick: -1, endTick: -1 });
        } else {
            el._sendWs({ type: 'loop', startTick: el._loopStart, endTick: el._loopEnd });
        }
        el._updateLoopMarkers();
        el._draggingMarker = null;
    };
    timeline.addEventListener('mouseup', endDrag);
    timeline.addEventListener('mouseleave', endDrag);

    // Right-click: move nearest marker (start or end) to clicked position
    timeline.addEventListener('contextmenu', (e) => {
        if (!el._totalSteps || !el._structure) return;
        e.preventDefault();
        const rect = timeline.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        const tick = Math.round(pct * el._totalSteps / 16) * 16;
        // Move whichever marker is closer
        const distStart = Math.abs(tick - el._loopStart);
        const distEnd = Math.abs(tick - el._loopEnd);
        if (distStart <= distEnd) {
            el._loopStart = tick;
        } else {
            el._loopEnd = tick;
        }
        // Swap if needed
        if (el._loopStart > el._loopEnd) {
            [el._loopStart, el._loopEnd] = [el._loopEnd, el._loopStart];
        }
        const isFullRange = el._loopStart === 0 && el._loopEnd === el._totalSteps;
        el._sendWs({ type: 'loop', startTick: isFullRange ? -1 : el._loopStart, endTick: isFullRange ? -1 : el._loopEnd });
        el._updateLoopMarkers();
    });

    // Workspace (read-only visualization)
    const workspace = document.createElement('div');
    workspace.className = 'pn-workspace';

    // Canvas for arcs
    const canvasContainer = document.createElement('div');
    canvasContainer.className = 'pn-canvas-container';

    el._canvas = document.createElement('canvas');
    el._canvas.className = 'pn-canvas';
    canvasContainer.appendChild(el._canvas);

    // Stage for nodes
    el._stage = document.createElement('div');
    el._stage.className = 'pn-stage';
    canvasContainer.appendChild(el._stage);

    workspace.appendChild(canvasContainer);
    el.appendChild(workspace);

    // Status bar (WebSocket mode only)
    if (el.dataset.backend === 'ws') {
        const status = document.createElement('div');
        status.className = 'pn-status';
        status.innerHTML = '<span class="pn-ws-status disconnected">&#9679; Disconnected</span>';
        el.appendChild(status);
    }

    // Footer — license + project pointers. Sits below the canvas as
    // ambient context; doesn't compete with the transport for vertical
    // attention. CC BY 4.0 is the authoritative statement for every
    // track this app produces (also baked into share-page meta and
    // .webm tags).
    const footer = document.createElement('div');
    footer.className = 'pn-footer';
    footer.innerHTML = `
        <span class="pn-footer-license">
            Tracks
            <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener" title="Creative Commons Attribution 4.0">CC BY 4.0</a>
            — reuse with attribution to beats.bitwrap.io
        </span>
        <span class="pn-footer-sep">·</span>
        <a class="pn-footer-link" href="https://github.com/stackdump/beats-bitwrap-io" target="_blank" rel="noopener">source</a>
        <span class="pn-footer-sep">·</span>
        <a class="pn-footer-link" href="/schema/beats-share" target="_blank" rel="noopener" title="JSON-LD context + JSON-Schema for the share envelope">schema</a>
        <span class="pn-footer-sep">·</span>
        <a class="pn-footer-link pn-footer-card" href="#" title="Show the track card again">card</a>
        <span class="pn-footer-sep pn-footer-feed-sep" hidden>·</span>
        <a class="pn-footer-link pn-footer-feed" href="/feed" hidden title="Browse all rendered tracks">feed</a>
        <span class="pn-footer-sep pn-footer-rss-sep" hidden>·</span>
        <a class="pn-footer-link pn-footer-rss" href="/feed.rss" hidden title="RSS / podcast feed">rss</a>
        <span class="pn-footer-sep pn-footer-history-sep" hidden>·</span>
        <a class="pn-footer-link pn-footer-history" href="#" hidden title="Tracks remembered in this browser">history</a>
        <span class="pn-footer-sep">·</span>
        <a class="pn-footer-link" href="https://github.com/stackdump/beats-bitwrap-io/issues/new?template=bug_report.yml" target="_blank" rel="noopener" title="Report a bug">bug</a>
        <span class="pn-footer-sep">·</span>
        <a class="pn-footer-link" href="https://github.com/stackdump/beats-bitwrap-io/issues/new?template=feature_request.yml" target="_blank" rel="noopener" title="Suggest a feature">feature</a>
        <span class="pn-footer-sep pn-footer-latest-sep" hidden>·</span>
        <a class="pn-footer-link pn-footer-latest" href="#" title="Most recently rendered track" hidden>latest</a>
        <span class="pn-footer-version" title="Server build">…</span>
    `;
    el.appendChild(footer);
    // Footer metadata: version, "latest" link, feed/rss visibility.
    // None of this depends on the loaded project — the values are
    // server-global and stable for the page's lifetime. _buildUI runs
    // on every project-sync (Generate, share-load, worker echo), so
    // refetching here would burn 3 GETs per regen and trip nginx's
    // per-IP rate limit on rapid sessions. Cache the results once and
    // only repaint the DOM on subsequent calls.
    populateFooterMetadata(footer);
    // "history" — only show when the user has at least one entry.
    // Click opens the standalone modal (lazy-imported to avoid
    // bloating the dialogs.js initial parse).
    try {
        const histRaw = localStorage.getItem('pn-history');
        const histLen = histRaw ? (JSON.parse(histRaw) || []).length : 0;
        if (histLen > 0) {
            const link = footer.querySelector('.pn-footer-history');
            const sep = footer.querySelector('.pn-footer-history-sep');
            if (link) link.hidden = false;
            if (sep) sep.hidden = false;
        }
    } catch {}
    footer.querySelector('.pn-footer-history')?.addEventListener('click', (e) => {
        e.preventDefault();
        import('./dialogs.js').then(m => m.showHistoryModal(el));
    });
    // "card" — pop the welcome modal again. Force=true bypasses the
    // first-visit-only gate; users want this on demand, not just
    // once per browser. Re-uses the same modal so the SVG art and
    // CC BY footer stay consistent across surfaces.
    footer.querySelector('.pn-footer-card')?.addEventListener('click', (e) => {
        e.preventDefault();
        import('./dialogs.js').then(m => m.showWelcomeCard(el, true));
    });

    // Setup canvas size
    el._resizeCanvas();
}

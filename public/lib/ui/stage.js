// Full-page "Stage" animation mode: every unmuted music net gets its own
// live-animated Petri-net panel — transitions pulse on fire, each panel
// drifts at its own slow rotation. Read-only view; audio keeps playing
// through the normal pipeline.
//
// State is module-scoped (not on `el`) so it can't collide with the
// single-net renderer in canvas.js, which owns el._stage/_nodes/_view.

import { renderCurrentCard } from '../share/card.js';
import { buildShareUrlForms } from '../share/url.js';
import { openAiPromptModal } from './ai-prompt.js';
import { toneEngine } from '../../audio/tone-engine.js';

const BG = '#0a0a1a';
const ARC_COLOR = '#4a90d9';
const PAD = 40;

let session = null; // { overlay, panels, rafId, onKey, onResize, vizMode, pulses, tiltAngle, transitionByPanel }

export function toggleStage(el) {
    if (session) closeStage(el);
    else openStage(el);
}

export function openStage(el) {
    if (session) return;
    if (!el._project || !el._project.nets) return;

    const overlay = document.createElement('div');
    overlay.className = 'pn-stage-overlay hide-backs hide-labels menu-collapsed';
    overlay.dataset.pnStage = '1';
    overlay.innerHTML = `
        <button class="pn-stage-burger" title="Menu" aria-label="Open stage menu" aria-expanded="false">&#8226;</button>
        <div class="pn-stage-menu" role="group" aria-label="Stage viz modes">
            <select class="pn-stage-visualizer" title="Visualizer">
                <option value="mandala" selected>Constellation</option>
                <option value="corona">Corona</option>
                <option value="sonar">Sonar</option>
                <option value="petal">Petal</option>
                <option value="shuffle">&#x1F500; Shuffle</option>
            </select>
            <button data-viz="flow" class="active" aria-pressed="true" title="Flow — panels drift">&#9676;</button>
            <button data-viz="pulse" class="active" aria-pressed="true" title="Pulse — beats fade toward center">&#9678;</button>
            <button data-viz="flame" class="active" aria-pressed="true" title="Flame — radial equalizer from center">&#9660;</button>
            <button data-viz="tilt" aria-pressed="false" title="Tilt — 3D perspective rotation">&#8861;</button>
            <button class="pn-stage-feel" title="Feel (F)">&#9672;</button>
            <button class="pn-stage-expand" aria-pressed="false" title="Show all slot variants (A+B+…)">&#8646;</button>
            <button class="pn-stage-backs" aria-pressed="false" title="Show/hide panel backgrounds">&#9632;</button>
            <button class="pn-stage-labels" aria-pressed="false" title="Show/hide track labels">A</button>
            <button class="pn-stage-cardflash" aria-pressed="false" title="Flash the share card on every track change (T)">&#x2710;</button>
            <button class="pn-stage-bolts active" aria-pressed="true" title="Lightning during macros (flame mode)">&#9889;&#xFE0E;</button>
            <button class="pn-stage-help" title="What am I looking at?">?</button>
            <select class="pn-stage-bgmode" title="Background">
                <option value="void" selected>Void</option>
                <option value="stars">Stars</option>
                <option value="aurora">Aurora</option>
            </select>
            <select class="pn-stage-structure" title="Track structure (bars)">
                <option value="">Loop</option>
                <option value="ab">A/B</option>
                <option value="drop">Drop</option>
                <option value="build">Build</option>
                <option value="jam">Jam</option>
                <option value="minimal">Minimal</option>
                <option value="standard">Standard</option>
                <option value="extended">Extended</option>
            </select>
            <select class="pn-stage-scale" title="Panel scale">
                <option value="loop" selected>Fit</option>
                <option value="s">S</option>
                <option value="m">M</option>
                <option value="l">L</option>
                <option value="xl">XL</option>
            </select>
        </div>
        <div class="pn-stage-stats" aria-live="polite"></div>
        <button class="pn-stage-fullscreen" aria-pressed="false" title="Fullscreen">&#9974;</button>
        <button class="pn-stage-close" title="Close (Esc)">&times;</button>
        <canvas class="pn-stage-bg" aria-hidden="true"></canvas>
        <canvas class="pn-stage-scope" aria-hidden="true"></canvas>
        <canvas class="pn-stage-flame" aria-hidden="true"></canvas>
        <div class="pn-stage-grid">
            <svg class="pn-stage-meta" aria-hidden="true"></svg>
        </div>
    `;
    // Append to document.body, not el. `buildUI()` wipes el.innerHTML
    // on every project-sync (Auto-DJ "next" fires that path), which
    // would otherwise take the overlay with it and break fullscreen.
    document.body.appendChild(overlay);

    const grid = overlay.querySelector('.pn-stage-grid');
    const panels = [];

    for (const entry of buildPanels(el, grid)) panels.push(entry);

    session = {
        el, overlay, panels, rafId: 0, onKey: null, onResize: null,
        // Multi-select viz modes. Flow is on by default; pulse and tilt
        // layer on top independently.
        vizModes: new Set(['flow', 'pulse', 'flame']),
        pulses: [],           // { x0, y0, cx, cy, born, life }  for pulse mode
        tiltAngle: 0,         // accumulator for tilt mode
        ringCenter: { x: 0, y: 0 },
        flameEnergy: new Map(), // netId -> energy (0..1) for flame mode
        flameCanvas: null,
        flameCtx: null,
        scale: 'loop',        // panel-size scale: loop (default) / s / m / l / xl
        expandVariants: false, // false = collapse riffGroup → one panel; true = one panel per variant
        metaRotation: 0,      // current in-plane rotation of the whole meta-diagram (degrees)
        metaRotationTarget: 0,// bumped by 90° on every genuine track change
        bolts: [],            // electric-bolt flashes spawned by macro-driven firings
        boltsEnabled: true,   // toolbar toggle — disable to silence lightning during macros
        seeds: [],            // seed-sparks dropped where a bolt strikes the dark planet
        cardOnChange: false,  // when true, flash the share card for a few seconds at each track change
        bgMode: 'void',       // 'void' | 'stars' | 'aurora' — background layer behind the meta-diagram
        bgCanvas: null,
        bgCtx: null,
        bgStars: [],
        bgPlanets: [],
        bgAuroraPhase: 0,
    };

    session.onKey = (e) => {
        if (e.key === 'Escape') {
            const help = overlay.querySelector('.pn-stage-help-modal');
            if (help) { help.remove(); return; }
            closeStage(el);
            return;
        }
        // Skip key handling when focus is in an input/select so the user
        // can still type freely.
        const tgt = e.target;
        const tag = tgt?.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
        // T toggles the share-card flash on every track change — same as
        // clicking the ✎ button. Useful while recording so the camera
        // captures genre/seed/QR for each new track. Capture-phase +
        // stopImmediatePropagation so the petri-note element's global T
        // (tap tempo) doesn't also fire.
        if (e.key === 't' || e.key === 'T') {
            overlay.querySelector('.pn-stage-cardflash')?.click();
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
        }
        // Arrow keys cycle the visualizer while Stage is open. Same
        // capture-phase guard so they never reach the slider-nudge path.
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            const order = ['mandala', 'corona', 'sonar', 'petal'];
            // Map shuffle's currently-running viz back into the cycle so
            // the keys still feel responsive while shuffling is on.
            const cur = session.visualizer || 'mandala';
            const i = Math.max(0, order.indexOf(cur));
            const di = e.key === 'ArrowRight' ? 1 : -1;
            const next = order[(i + di + order.length) % order.length];
            applyVisualizer(next);
            const sel = overlay.querySelector('.pn-stage-visualizer');
            if (sel) sel.value = next;
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    };
    document.addEventListener('keydown', session.onKey, true);

    session.onResize = () => {
        sizeBgCanvas();
        sizeScopeCanvas();
        layoutRing(session);
        for (const p of session.panels) layoutPanel(p);
    };
    window.addEventListener('resize', session.onResize);
    layoutRing(session);

    overlay.querySelector('.pn-stage-close').addEventListener('click', () => closeStage(el));
    const burger = overlay.querySelector('.pn-stage-burger');
    burger.addEventListener('click', () => {
        const collapsed = overlay.classList.toggle('menu-collapsed');
        burger.setAttribute('aria-expanded', String(!collapsed));
    });
    // Clicking outside the menu (but still on the overlay) collapses it again.
    overlay.addEventListener('click', (e) => {
        if (overlay.classList.contains('menu-collapsed')) return;
        if (e.target.closest('.pn-stage-menu, .pn-stage-burger')) return;
        overlay.classList.add('menu-collapsed');
        burger.setAttribute('aria-expanded', 'false');
    });
    const fsBtn = overlay.querySelector('.pn-stage-fullscreen');
    // Cross-browser entry + exit. Safari < 16.4 and iOS Safari need
    // the webkit prefix; iPad touch-devices also land here. Mobile
    // Safari on iPhone doesn't support div fullscreen at all, so
    // fall back to a CSS class that simulates it (hides everything
    // outside the overlay) rather than doing nothing visibly.
    const reqFullscreen = (el) => {
        if (el.requestFullscreen) return el.requestFullscreen();
        if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
        if (el.webkitEnterFullscreen) return el.webkitEnterFullscreen();
        return Promise.reject(new Error('Fullscreen API not supported'));
    };
    const exitFullscreen = () =>
        document.exitFullscreen?.() ||
        document.webkitExitFullscreen?.() ||
        Promise.resolve();
    const currentFsEl = () =>
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        null;
    fsBtn.addEventListener('click', async () => {
        const isOn = overlay.classList.contains('pn-stage-pseudo-fs') || !!currentFsEl();
        try {
            if (!isOn) {
                await reqFullscreen(overlay);
            } else {
                await exitFullscreen();
                overlay.classList.remove('pn-stage-pseudo-fs');
                fsBtn.classList.remove('active');
                fsBtn.setAttribute('aria-pressed', 'false');
            }
        } catch (err) {
            // Real fullscreen refused (iOS Safari on iPhone, sandboxed
            // iframes, kiosk windows). Emulate with a CSS class so the
            // user at least gets the chrome-free view they wanted.
            overlay.classList.add('pn-stage-pseudo-fs');
            fsBtn.classList.add('active');
            fsBtn.setAttribute('aria-pressed', 'true');
        }
    });
    session.onFsChange = () => {
        const on = currentFsEl() === overlay || overlay.classList.contains('pn-stage-pseudo-fs');
        fsBtn.classList.toggle('active', on);
        fsBtn.setAttribute('aria-pressed', String(on));
    };
    document.addEventListener('fullscreenchange', session.onFsChange);
    document.addEventListener('webkitfullscreenchange', session.onFsChange);
    overlay.querySelector('.pn-stage-help').addEventListener('click', () => openHelp(overlay));
    overlay.querySelector('.pn-stage-cardflash').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        session.cardOnChange = !session.cardOnChange;
        btn.classList.toggle('active', session.cardOnChange);
        btn.setAttribute('aria-pressed', String(session.cardOnChange));
        // Preview the card immediately on first enable so the user
        // knows what they opted into.
        if (session.cardOnChange) flashShareCard(el);
    });
    overlay.querySelector('.pn-stage-feel').addEventListener('click', () => {
        el._openFeelModal();
    });
    overlay.querySelector('.pn-stage-expand').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        session.expandVariants = !session.expandVariants;
        btn.classList.toggle('active', session.expandVariants);
        btn.setAttribute('aria-pressed', String(session.expandVariants));
        // Rebuild panels without bumping the meta-rotation — toggling the
        // view is not a track change.
        rebuildStagePanels(el);
    });
    overlay.querySelector('.pn-stage-backs').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        const on = overlay.classList.toggle('hide-backs');
        btn.classList.toggle('active', !on);
        btn.setAttribute('aria-pressed', String(!on));
    });
    overlay.querySelector('.pn-stage-bolts').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        session.boltsEnabled = !session.boltsEnabled;
        btn.classList.toggle('active', session.boltsEnabled);
        btn.setAttribute('aria-pressed', String(session.boltsEnabled));
        // Drain any in-flight bolts/seeds so disabling reads as "off now".
        if (!session.boltsEnabled) { session.bolts.length = 0; session.seeds.length = 0; }
    });
    overlay.querySelector('.pn-stage-labels').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        const on = overlay.classList.toggle('hide-labels');
        btn.classList.toggle('active', !on);
        btn.setAttribute('aria-pressed', String(!on));
    });
    // Background canvas sizes itself to match the overlay; re-sized on
    // resize. The bg renderer runs every frame regardless of mode so
    // switching is instant (no stale pixels left on screen).
    const bg = overlay.querySelector('.pn-stage-bg');
    session.bgCanvas = bg;
    session.bgCtx = bg.getContext('2d');
    sizeBgCanvas();
    // Scope canvas — shared by wave (oscilloscope) + spectrum (FFT bars). Sized
    // to overlay; lazy analyser tap on the master chain (post-FX so the bars
    // mirror exactly what the speakers hear).
    const scope = overlay.querySelector('.pn-stage-scope');
    session.scopeCanvas = scope;
    session.scopeCtx = scope.getContext('2d');
    sizeScopeCanvas();
    overlay.querySelector('.pn-stage-bgmode').addEventListener('change', (e) => {
        session.bgMode = e.target.value;
        // Clear on switch so the prior mode's pixels don't linger one
        // frame into the next.
        if (session.bgCtx) session.bgCtx.clearRect(0, 0, session.bgCanvas.width, session.bgCanvas.height);
        if (session.bgMode === 'stars' && session.bgStars.length === 0) spawnStars();
    });
    overlay.querySelector('.pn-stage-visualizer').addEventListener('change', (e) => {
        applyVisualizer(e.target.value);
    });
    overlay.querySelector('.pn-stage-scale').addEventListener('change', (e) => {
        session.scale = e.target.value;
        layoutRing(session);
        for (const p of session.panels) layoutPanel(p);
    });
    const structSel = overlay.querySelector('.pn-stage-structure');
    const headerStruct = el.querySelector('.pn-structure-select');
    if (headerStruct) structSel.value = headerStruct.value || '';
    structSel.addEventListener('change', (e) => {
        const hs = el.querySelector('.pn-structure-select');
        if (!hs) return;
        hs.value = e.target.value;
        hs.dispatchEvent(new Event('change', { bubbles: true }));
    });
    overlay.querySelector('.pn-stage-menu').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-viz]');
        if (!btn) return;
        const mode = btn.dataset.viz;
        const on = session.vizModes.has(mode);
        if (on) session.vizModes.delete(mode);
        else session.vizModes.add(mode);
        btn.classList.toggle('active', !on);
        btn.setAttribute('aria-pressed', String(!on));
        // Clear mode-owned state when a mode turns off so stale
        // transforms don't linger. Pulse particles are *not* cleared
        // here — we stop spawning new ones, but existing particles
        // finish their fade so the mode "trails off" gracefully.
        if (mode === 'tilt') {
            // Toggle the preserve-3d guard on the overlay so it's only
            // engaged while Tilt is on — keeps iOS Safari from blanking
            // the flame canvas in default (non-tilt) mode.
            overlay.classList.toggle('tilt-active', !on);
            if (on) {
                const grid = overlay.querySelector('.pn-stage-grid');
                grid.style.transform = '';
                session.tiltAngle = 0;
            }
        }
        if (mode === 'flame' && on) {
            session.flameEnergy.clear();
            if (session.flameCtx && session.flameCanvas) {
                session.flameCtx.clearRect(0, 0, session.flameCanvas.width, session.flameCanvas.height);
            }
        }
    });

    renderStats();

    // Size panels immediately (getBoundingClientRect inside layoutPanel
    // forces a synchronous layout pass) so the first rendered frame has
    // a correct scale/center for every panel — no "scale(1) → correct"
    // pop on the first tick.
    for (const p of panels) layoutPanel(p);
    // Re-layout once more after the next paint to settle any final
    // grid-track sizing (aspect-ratio squares need the row to round to
    // an integer height).
    requestAnimationFrame(() => { for (const p of panels) layoutPanel(p); });

    startLoop();
}

export function closeStage(el) {
    if (!session) return;
    if (session.rafId) cancelAnimationFrame(session.rafId);
    if (session.onKey) document.removeEventListener('keydown', session.onKey, true);
    if (session.onResize) window.removeEventListener('resize', session.onResize);
    if (session.onFsChange) document.removeEventListener('fullscreenchange', session.onFsChange);
    if (document.fullscreenElement === session.overlay) {
        // Exit fullscreen so closing Stage also exits fullscreen mode.
        document.exitFullscreen?.().catch(() => {});
    }
    session.overlay.querySelector('.pn-stage-cardbox')?._killTimers?.();
    session.overlay.remove();
    session = null;
}

// Transition-fired hook — called from backend/index.js on every
// transition-fired message. No-op when Stage is closed.
export function stageOnTransitionFired(el, netId, transitionId) {
    if (!session) return;
    const panel = session.panels.find(p => p.netId === netId);
    const node = panel?.nodes[transitionId];
    if (node) {
        node.classList.add('firing');
        setTimeout(() => node.classList.remove('firing'), 100);
    }
    // Pulse mode: spawn a particle at the fired transition's actual
    // position on its sub-ring (not just the panel center), and let it
    // fade toward the ring center — "beat flying into the void". Cap
    // the pulse list so a flurry of transitions doesn't accumulate
    // unbounded SVG nodes.
    if (session.vizModes.has('pulse') && panel?.ringX != null) {
        const origin = nodeCenterInStage(session, panel, transitionId) || { x: panel.ringX, y: panel.ringY };
        if (session.pulses.length > 64) session.pulses.shift();
        session.pulses.push({
            x0: origin.x, y0: origin.y,
            cx: session.ringCenter.x, cy: session.ringCenter.y,
            born: performance.now(),
            life: 700,
        });
    }
    // Beat-driven visualizers: each captures the same fire event from a
    // different angle. All cap their internal lists so a flurry of
    // transitions can't accumulate unbounded state.
    const ch = netChannel(el, netId);
    const hue = channelHue(ch);
    const now = performance.now();
    // Shuffle: count transitions and rotate the visualizer every
    // SHUFFLE_FIRES beats. Using transition count instead of wall-clock
    // ties the swap rhythm to the actual song density.
    if (session.shuffling) {
        session.shuffleFireCount = (session.shuffleFireCount || 0) + 1;
        if (session.shuffleFireCount >= SHUFFLE_FIRES) {
            session.shuffleFireCount = 0;
            const next = pickShuffleNext();
            setVisualizer(next);
            const sel = session.overlay.querySelector('.pn-stage-visualizer');
            if (sel) sel.value = 'shuffle';
        }
    }
    if (session.visualizer === 'sonar') {
        // Two-stage rate limit so dense polyphony doesn't carpet the
        // screen. Per-channel: at most one ring per 250ms (the older
        // ring is still visibly expanding). Global: at most one new
        // ring per 80ms regardless of channel. Cap at 8 visible rings.
        if (!session.sonarLastByCh) session.sonarLastByCh = new Map();
        const lastChFire = session.sonarLastByCh.get(ch) || 0;
        const lastAnyFire = session.sonarLastAny || 0;
        if (now - lastChFire >= 250 && now - lastAnyFire >= 80) {
            session.sonarLastByCh.set(ch, now);
            session.sonarLastAny = now;
            if (session.sonarRings.length > 8) session.sonarRings.shift();
            session.sonarRings.push({ born: now, hue, life: 900 });
        }
    } else if (session.visualizer === 'petal') {
        // Smaller bump + faster decay below: the petal spikes briefly on
        // each fire and visibly relaxes between hits, instead of pinning
        // at full size whenever the track is active.
        const prev = session.petalEnergy.get(netId) || 0;
        session.petalEnergy.set(netId, Math.min(1, prev + 0.45));
    }
    // Flame: bump this panel's radial beam. One beam per panel, aimed
    // exactly at the panel's angle, so firings line up with visible
    // panel positions regardless of how many are on stage.
    if (session.vizModes.has('flame') && panel?.ringX != null) {
        const prev = session.flameEnergy.get(panel.netId) || 0;
        session.flameEnergy.set(panel.netId, Math.min(1, prev + 0.9));
        const origin = nodeCenterInStage(session, panel, transitionId);
        if (origin) panel.flameOrigin = origin;
        // While a macro is running, also spawn a white-blue electric
        // bolt from the same origin toward the ring center. Bolts are
        // rendered on top of the flame gradient and live ~500 ms so a
        // macro reads as crackling arcs across the meta-diagram.
        if (el._runningMacro && origin && session.boltsEnabled) {
            session.bolts.push({
                origin: { x: origin.x, y: origin.y },
                born: performance.now(),
                life: 480,
                seed: Math.random() * 1000,
            });
            if (session.bolts.length > 32) session.bolts.shift();
        }
    }
}

// Mute-state reconcile — called when `mute-state` message arrives.
// Panels are *not* torn down on mute: the ring geometry stays stable
// (no reflow flash) and muted panels just dim via a `.muted` class.
// Auto-DJ section boundaries flip mutes often, so any rebuild here
// would strobe the whole composition.
// Rebuild panels + refresh stats when a new project is applied — otherwise
// panels point at stale nets after a structure change / regenerate.
export function stageOnProjectSync(el) {
    if (!session) return;
    // External entry: a genuine track change just landed (structure
    // change, regenerate, Auto-DJ swap). Quarter-turn the whole
    // meta-diagram so the viewer can feel that a new section started
    // without any text cue. The rAF loop eases metaRotation toward this
    // target over ~half a second.
    session.metaRotationTarget += 90;
    rebuildStagePanels(el);
    if (session.cardOnChange) flashShareCard(el);
}

// Rebuild panels in place without signaling a track change. Used by
// stageOnProjectSync (after it bumps the rotation) and by the ⇄ expand
// toggle (which must NOT rotate).
function rebuildStagePanels(el) {
    if (!session) return;
    const grid = session.overlay.querySelector('.pn-stage-grid');
    // Preserve the canvas + svg overlays; only wipe panel divs.
    for (const p of session.panels) p.root.remove();
    session.panels.length = 0;
    session.pulses.length = 0;
    session.bolts.length = 0;
    if (session.seeds) session.seeds.length = 0;
    session.flameEnergy.clear();
    for (const entry of buildPanels(el, grid)) session.panels.push(entry);
    const structSel = session.overlay.querySelector('.pn-stage-structure');
    const headerStruct = el.querySelector('.pn-structure-select');
    if (structSel && headerStruct) structSel.value = headerStruct.value || '';
    layoutRing(session);
    for (const p of session.panels) layoutPanel(p);
    renderStats();
}

export function stageOnMuteStateChange(el) {
    if (!session) return;
    const nets = el._project?.nets || {};
    for (const p of session.panels) {
        // Collapsed mode: each riffGroup has exactly one panel, so swap
        // its displayed net to the currently-active variant at section
        // boundaries (A→B slot flip). Expanded mandala mode: every
        // variant already owns its own panel — swapping would collapse
        // the whole group back onto the active variant's netId, leaving
        // all sibling panels as duplicates of the same net.
        if (p.riffGroup && !session.expandVariants) {
            const groupIds = Object.keys(nets).filter(id => nets[id]?.riffGroup === p.riffGroup);
            const active = groupIds.find(id =>
                !el._mutedNets?.has(id) && !el._manualMutedNets?.has(id));
            if (active && active !== p.netId) repanel(p, active);
        }
        const muted = el._mutedNets?.has(p.netId) || el._manualMutedNets?.has(p.netId);
        p.root.classList.toggle('muted', !!muted);
    }
    renderStats();
}

function renderStats() {
    if (!session) return;
    const out = session.overlay.querySelector('.pn-stage-stats');
    if (!out) return;
    const el = session.el;
    const nets = el?._project?.nets || {};
    let netCount = 0, placeCount = 0, transCount = 0, arcCount = 0, mutedCount = 0;
    let bindingCount = 0;
    for (const [id, net] of Object.entries(nets)) {
        if (!net || net.role === 'control') continue;
        const pc = Object.keys(net.places || {}).length;
        const tc = Object.keys(net.transitions || {}).length;
        if (pc === 0 || tc === 0) continue;
        netCount++;
        placeCount += pc;
        transCount += tc;
        arcCount += (net.arcs || []).length;
        if (el._mutedNets?.has(id) || el._manualMutedNets?.has(id)) mutedCount++;
        for (const t of Object.values(net.transitions || {})) if (t && t.midi) bindingCount++;
    }
    const active = netCount - mutedCount;
    const bars = el?._project?.bars || 0;
    out.textContent =
        `${bars} bars · ${active}/${netCount} nets · ${placeCount} places · ${transCount} transitions · ${arcCount} arcs · ${bindingCount} notes`;
}

// Arrange sub-panels as squares (transitions) alternating with small
// circles (places) around a big ring — the whole Stage reads as one
// meta-Petri-net: N square transitions (each a live sub-ring) + N
// place circles between them + 2N arcs closing the loop.
function layoutRing(s) {
    const grid = s.overlay.querySelector('.pn-stage-grid');
    const meta = s.overlay.querySelector('.pn-stage-meta');
    if (!grid) return;
    // Tilt mode applies a 3D transform to the grid, which warps
    // getBoundingClientRect into projected screen dims. Strip it for
    // the measurement and restore — the rAF loop re-applies it next
    // frame, so no visible flash.
    const savedTransform = grid.style.transform;
    if (savedTransform) grid.style.transform = '';
    const rect = grid.getBoundingClientRect();
    if (savedTransform) grid.style.transform = savedTransform;
    const w = rect.width, h = rect.height;
    const n = s.panels.length;
    if (n === 0) return;

    if (n === 1) {
        const side = Math.min(w, h) * 0.68;
        const p = s.panels[0];
        p.root.style.width = `${side}px`;
        p.root.style.height = `${side}px`;
        p.root.style.left = `${(w - side) / 2}px`;
        p.root.style.top = `${(h - side) / 2}px`;
        if (meta) meta.innerHTML = '';
        return;
    }

    // Size each panel so a ring of N squares fits comfortably. The
    // fraction is tuned so 2 panels pair naturally, 3–5 form a tight
    // pentagon, and 6+ still leave visible ring negative space.
    const baseFrac = n <= 3 ? 0.42 : n <= 5 ? 0.30 : n <= 8 ? 0.24 : 0.20;
    const baseSide = Math.min(w, h) * baseFrac;
    const scaleMult = { loop: 1, s: 0.45, m: 0.75, l: 1.6, xl: 2.4 }[s.scale] ?? 1;
    // Panels are intentionally allowed to overlap at high N — the
    // interleaved sub-nets form a mandala.
    const maxSide = Math.min(w, h) * 0.65;
    const side = Math.max(60, Math.min(maxSide, baseSide * scaleMult));
    const radius = Math.min(w, h) / 2 - side / 2 - 24;
    const cx = w / 2, cy = h / 2;

    s.ringCenter = { x: cx, y: cy };
    // Size the flame canvas to match the grid — drawn from center out.
    const flame = s.overlay.querySelector('.pn-stage-flame');
    if (flame) {
        const dpr = window.devicePixelRatio || 1;
        flame.width = Math.round(w * dpr);
        flame.height = Math.round(h * dpr);
        flame.style.width = `${w}px`;
        flame.style.height = `${h}px`;
        s.flameCanvas = flame;
        s.flameCtx = flame.getContext('2d');
        s.flameCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    const transitionCenters = [];
    for (let i = 0; i < n; i++) {
        const theta = (i / n) * Math.PI * 2 - Math.PI / 2;
        const tx = cx + radius * Math.cos(theta);
        const ty = cy + radius * Math.sin(theta);
        transitionCenters.push({ x: tx, y: ty });
        const p = s.panels[i];
        p.ringX = tx;
        p.ringY = ty;
        p.root.style.width = `${side}px`;
        p.root.style.height = `${side}px`;
        p.root.style.left = `${tx - side / 2}px`;
        p.root.style.top = `${ty - side / 2}px`;
    }

    // Inner-place ring: each place sits at the midpoint angle between
    // two adjacent transitions, pulled toward the stage center so the
    // composition reads as classic Petri net geometry (transitions on
    // the outer ring, places on an inner ring).
    const placeR = Math.max(22, side * 0.12);
    const placeRadius = radius * 0.35;
    // Dark-planet radius — the implied center object. Bolts and
    // pulses terminate on its perimeter so they spell the planet's
    // shape out by implication (Yoneda: the object is what all
    // morphisms into it say it is). Kept just inside the inner
    // place ring so the dark planet reads as a gravitational body
    // sitting between the place circles and the void.
    s.darkPlanetRadius = Math.max(18, placeRadius - Math.max(22, placeR) - 4);
    const placeCenters = [];
    for (let i = 0; i < n; i++) {
        const theta = ((i + 0.5) / n) * Math.PI * 2 - Math.PI / 2;
        placeCenters.push({
            x: cx + placeRadius * Math.cos(theta),
            y: cy + placeRadius * Math.sin(theta),
        });
    }

    // The meta-net (inner place ring + radial arcs) only reads as a
    // Petri-net at low N. Beyond ~16 panels the place circles overlap
    // into a thick blue band and the radial arrows dominate the view,
    // drowning out the panels themselves. Skip rendering it at high N
    // and let the panels carry the composition on their own.
    if (meta) {
        if (n > 16) meta.innerHTML = '';
        else renderMetaNet(meta, w, h, transitionCenters, placeCenters, side, placeR);
    }
}

function renderMetaNet(svg, w, h, transitions, places, side, placeR) {
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    const arcColor = '#4a90d9';
    const arcOpacity = 0.35;
    const halfTransition = side / 2;

    // Build arcs: for each place i, arc from transitions[i] → places[i]
    // and from places[i] → transitions[i+1] (wrap). Arrowhead lands
    // just shy of each target shape's edge so the line visually
    // terminates inside the square/circle outline.
    const lines = [];
    for (let i = 0; i < places.length; i++) {
        const a = transitions[i];
        const p = places[i];
        const b = transitions[(i + 1) % transitions.length];
        lines.push(edge(a, p, halfTransition, placeR));
        lines.push(edge(p, b, placeR, halfTransition));
    }

    const placeSvg = places.map(pc =>
        `<circle cx="${pc.x.toFixed(1)}" cy="${pc.y.toFixed(1)}" r="${placeR.toFixed(1)}" fill="rgba(74,144,217,0.06)" stroke="${arcColor}" stroke-width="2" stroke-opacity="${arcOpacity + 0.1}"/>`,
    ).join('');
    svg.innerHTML =
        `<g stroke="${arcColor}" stroke-width="2" fill="none" stroke-opacity="${arcOpacity}">${lines.join('')}</g>` +
        placeSvg;
}

// Emit a single arrow-terminated line from (a) to (b), with a and b
// insets equal to each shape's "radius" (halfSide for squares, r for
// circles) so lines start and end on the shape's outline, not at its
// center.
function edge(a, b, aInset, bInset) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const x1 = a.x + ux * aInset;
    const y1 = a.y + uy * aInset;
    const x2 = b.x - ux * bInset;
    const y2 = b.y - uy * bInset;
    const headLen = 12;
    const ang = Math.atan2(uy, ux);
    const hx1 = x2 - headLen * Math.cos(ang - Math.PI / 6);
    const hy1 = y2 - headLen * Math.sin(ang - Math.PI / 6);
    const hx2 = x2 - headLen * Math.cos(ang + Math.PI / 6);
    const hy2 = y2 - headLen * Math.sin(ang + Math.PI / 6);
    return (
        `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>` +
        `<line x1="${x2.toFixed(1)}" y1="${y2.toFixed(1)}" x2="${hx1.toFixed(1)}" y2="${hy1.toFixed(1)}"/>` +
        `<line x1="${x2.toFixed(1)}" y1="${y2.toFixed(1)}" x2="${hx2.toFixed(1)}" y2="${hy2.toFixed(1)}"/>`
    );
}

// --- internals ---

// All music nets with real content. Muted music panels stay in the
// ring (dimmed) so the composition doesn't reflow when Auto-DJ flips
// mutes mid-section. `hit*` Beats tracks are excluded unless they're
// unmuted at open time — muted by default they'd just be dead dimmed
// squares cluttering the composition.
function eligibleNetIds(el) {
    const nets = el._project?.nets || {};
    const ids = [];
    for (const [id, net] of Object.entries(nets)) {
        if (!net || net.role === 'control') continue;
        const placeCount = Object.keys(net.places || {}).length;
        const transCount = Object.keys(net.transitions || {}).length;
        if (placeCount === 0 || transCount === 0) continue;
        if (id.startsWith('hit')) {
            const muted = el._mutedNets?.has(id) || el._manualMutedNets?.has(id);
            if (muted) continue;
        }
        ids.push(id);
    }
    // Collapse riffGroup variants (A/B/C slot alternates) to a single
    // panel per logical track, matching the mixer's collapsed view.
    // Toolbar ⇄ button disables this and shows every variant.
    let picked;
    if (session?.expandVariants) {
        picked = ids.slice();
    } else {
        picked = [];
        const seenGroup = new Set();
        for (const id of ids) {
            const group = nets[id]?.riffGroup;
            if (!group) { picked.push(id); continue; }
            if (seenGroup.has(group)) continue;
            seenGroup.add(group);
            const groupIds = ids.filter(x => nets[x]?.riffGroup === group);
            const active = groupIds.find(x =>
                !el._mutedNets?.has(x) && !el._manualMutedNets?.has(x));
            picked.push(active || groupIds[0]);
        }
    }
    picked.sort((a, b) => {
        const ca = nets[a]?.track?.channel ?? 0;
        const cb = nets[b]?.track?.channel ?? 0;
        return ca - cb;
    });
    return distributeEvenly(picked);
}

// Deterministic golden-ratio stride permutation. Panels arriving in
// channel order cluster (all BASS riffGroup slots adjacent, etc.),
// which makes the ring animate unevenly — one slice pulses while the
// rest sits idle. Re-index by i ↦ (i * stride) mod N where stride is
// coprime to N and near N/φ, so adjacent-in-order items land on
// opposite sides of the ring. Same input always produces same output.
function distributeEvenly(ids) {
    const n = ids.length;
    if (n < 4) return ids;
    // Pick the coprime-to-n integer closest to n/φ² (≈ n · 0.381966).
    // The previous version only walked UP from round(n · 0.381966), so on
    // composite n where the nearest coprime sits below the ideal, stride
    // drifted upward and same-channel variants could clump on one arc.
    // Ties prefer the smaller stride.
    const ideal = n * 0.381966;
    let stride = n - 1;
    let bestDist = Infinity;
    // Skip k=1 (identity) and prefer the coprime-to-n closest to ideal.
    for (let k = 2; k < n; k++) {
        if (gcd(k, n) !== 1) continue;
        const d = Math.abs(k - ideal);
        if (d < bestDist) { bestDist = d; stride = k; }
    }
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[(i * stride) % n] = ids[i];
    return out;
}

function gcd(a, b) { while (b) { const t = b; b = a % b; a = t; } return a; }

function* buildPanels(el, grid) {
    for (const id of eligibleNetIds(el)) {
        const entry = buildOnePanel(el, grid, id);
        if (entry) yield entry;
    }
}

function buildOnePanel(el, grid, netId) {
    const net = el._project?.nets?.[netId];
    if (!net) return null;

    const root = document.createElement('div');
    root.className = 'pn-stage-panel';
    root.dataset.netId = netId;

    const label = net.riffGroup || net.track?.instrument || netId;
    root.innerHTML = `
        <canvas class="pn-stage-canvas"></canvas>
        <div class="pn-stage-stage"></div>
        <div class="pn-stage-label">${escapeHtml(String(label))}</div>
    `;
    grid.appendChild(root);

    const canvas = root.querySelector('.pn-stage-canvas');
    const ctx = canvas.getContext('2d');
    const stage = root.querySelector('.pn-stage-stage');

    const nodes = {};
    for (const [id, place] of Object.entries(net.places)) createPlaceNode(stage, nodes, id, place);
    for (const [id, trans] of Object.entries(net.transitions)) createTransitionNode(stage, nodes, id, trans);

    const sign = Math.random() < 0.5 ? -1 : 1;
    const angleVelDps = sign * (3 + Math.random() * 6); // 3–9 °/s drift

    const entry = {
        netId, riffGroup: net.riffGroup || '', root, canvas, ctx, stage, nodes,
        dpr: window.devicePixelRatio || 1,
        view: { scale: 1, tx: 0, ty: 0 },
        angle: 0,
        angleVelDps,
    };
    return entry;
}

// Swap a panel's displayed net (riffGroup slot flip) in-place: wipe
// stage DOM + nodes and rebuild from the new net so activate-slot at a
// section boundary updates the ring without a full panel tear-down.
function repanel(entry, newNetId) {
    const net = session?.el?._project?.nets?.[newNetId];
    if (!net) return;
    entry.netId = newNetId;
    entry.root.dataset.netId = newNetId;
    entry.stage.innerHTML = '';
    const nodes = {};
    for (const [id, place] of Object.entries(net.places)) createPlaceNode(entry.stage, nodes, id, place);
    for (const [id, trans] of Object.entries(net.transitions)) createTransitionNode(entry.stage, nodes, id, trans);
    entry.nodes = nodes;
    const label = net.riffGroup || net.track?.instrument || newNetId;
    const labelEl = entry.root.querySelector('.pn-stage-label');
    if (labelEl) labelEl.textContent = String(label);
    layoutPanel(entry);
}

// Compute a transition node's grid-local center by replaying the same
// affine the rAF loop applies to `.pn-stage-stage` — no
// getBoundingClientRect. Tilt sets a 3D transform on `.pn-stage-grid`,
// so rect-based capture would return post-projection screen coords and
// then get re-projected on paint (the flame canvas + meta svg are
// children of the rotated grid), which is how beams + pulses drifted
// more and more as tiltAngle accumulated.
function nodeCenterInStage(s, panel, transitionId) {
    const net = s?.el?._project?.nets?.[panel?.netId];
    const t = net?.transitions?.[transitionId];
    if (!t || !panel?.view) return null;
    const { tx, ty, scale, cx, cy } = panel.view;
    if (!Number.isFinite(scale) || !Number.isFinite(cx) || !Number.isFinite(cy)) return null;
    const a = (panel.angle || 0) * Math.PI / 180;
    const dx = t.x - cx, dy = t.y - cy;
    const rx = dx * Math.cos(a) - dy * Math.sin(a) + cx;
    const ry = dx * Math.sin(a) + dy * Math.cos(a) + cy;
    return {
        x: panel.root.offsetLeft + rx * scale + tx,
        y: panel.root.offsetTop + ry * scale + ty,
    };
}

function createPlaceNode(stage, nodes, id, place) {
    const node = document.createElement('div');
    node.className = 'pn-node pn-place';
    node.dataset.id = id;
    node.dataset.type = 'place';
    node.style.left = `${place.x - 30}px`;
    node.style.top = `${place.y - 30}px`;
    node.innerHTML = `<div class="pn-place-circle"></div>`;
    stage.appendChild(node);
    nodes[id] = node;
}

function createTransitionNode(stage, nodes, id, trans) {
    const node = document.createElement('div');
    node.className = 'pn-node pn-transition';
    if (trans.midi) node.classList.add('has-midi');
    node.dataset.id = id;
    node.dataset.type = 'transition';
    node.style.left = `${trans.x - 25}px`;
    node.style.top = `${trans.y - 25}px`;
    node.innerHTML = `<div class="pn-transition-rect"></div>`;
    stage.appendChild(node);
    nodes[id] = node;
}

function layoutPanel(entry) {
    const net = currentNet(entry);
    if (!net) return;
    const { canvas, root } = entry;

    // Same tilt guard as layoutRing: root is inside .pn-stage-grid, so
    // an active 3D transform on the grid warps its getBoundingClientRect.
    const grid = session?.overlay?.querySelector('.pn-stage-grid');
    const savedTransform = grid?.style.transform;
    if (grid && savedTransform) grid.style.transform = '';
    const rect = root.getBoundingClientRect();
    if (grid && savedTransform) grid.style.transform = savedTransform;
    const w = Math.max(120, rect.width);
    const h = Math.max(120, rect.height);
    entry.dpr = window.devicePixelRatio || 1;
    canvas.width = w * entry.dpr;
    canvas.height = h * entry.dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    entry.ctx.setTransform(entry.dpr, 0, 0, entry.dpr, 0, 0);

    // Bounding box + fit scale (mirrors canvas.js::centerNet).
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of Object.values(net.places)) {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    for (const t of Object.values(net.transitions)) {
        if (t.x < minX) minX = t.x; if (t.x > maxX) maxX = t.x;
        if (t.y < minY) minY = t.y; if (t.y > maxY) maxY = t.y;
    }
    if (!isFinite(minX)) return;
    const netW = maxX - minX + PAD * 2;
    const netH = maxY - minY + PAD * 2;
    const scale = Math.min(1, w / netW, h / netH);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    entry.view = { scale, tx: w / 2 - cx * scale, ty: h / 2 - cy * scale, cx, cy };
    // transform-origin stays at 0 0 so translate + scale behave like the
    // canvas ctx.translate/scale pair in canvas.js::centerNet. Rotation is
    // added by the rAF loop as an *inner* transform triplet
    // (translate(cx,cy) rotate(angle) translate(-cx,-cy)) so the ring
    // spins around its own centroid instead of the stage's corner.
    entry.stage.style.transformOrigin = '0 0';
    entry.stage.style.transform =
        `translate(${entry.view.tx}px, ${entry.view.ty}px) scale(${scale})`;
    drawPanel(entry);
}

function currentNet(entry) {
    // Resolve the net fresh each paint — project can be rebuilt between
    // frames (Auto-DJ regen, "next", manual generate). session.el is the
    // durable handle; the overlay now lives on document.body so it can
    // no longer reach the element via closest('petri-note').
    return session?.el?._project?.nets?.[entry.netId] || null;
}

function drawPanel(entry) {
    const net = currentNet(entry);
    if (!net || !entry.ctx) return;
    const { ctx, view } = entry;
    const w = entry.canvas.width / entry.dpr;
    const h = entry.canvas.height / entry.dpr;

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(view.tx, view.ty);
    ctx.scale(view.scale, view.scale);

    // Rotation: spin around the same point the DOM stage transform
    // uses (view.cx/cy = bounding-box center). Using a different pivot
    // here (e.g. places centroid) would make the canvas arcs drift
    // relative to the DOM nodes over time.
    if (Number.isFinite(view.cx) && Number.isFinite(view.cy)) {
        ctx.translate(view.cx, view.cy);
        ctx.rotate(entry.angle * Math.PI / 180);
        ctx.translate(-view.cx, -view.cy);
    }

    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = ARC_COLOR;
    ctx.lineWidth = 2 / view.scale;

    for (const arc of net.arcs || []) {
        const src = net.places[arc.source] || net.transitions[arc.source];
        const trg = net.places[arc.target] || net.transitions[arc.target];
        if (!src || !trg) continue;
        ctx.beginPath();
        ctx.moveTo(src.x, src.y);
        ctx.lineTo(trg.x, trg.y);
        ctx.stroke();
        drawArrowhead(ctx, src.x, src.y, trg.x, trg.y);
    }
    ctx.restore();
}

function drawArrowhead(ctx, x1, y1, x2, y2) {
    const headLen = 12;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const offset = 25;
    const tx = x2 - Math.cos(angle) * offset;
    const ty = y2 - Math.sin(angle) * offset;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - headLen * Math.cos(angle - Math.PI / 6), ty - headLen * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - headLen * Math.cos(angle + Math.PI / 6), ty - headLen * Math.sin(angle + Math.PI / 6));
    ctx.stroke();
}

let lastTime = 0;
function startLoop() {
    lastTime = performance.now();
    const tick = (now) => {
        if (!session) return;
        const dt = Math.min(100, now - lastTime) / 1000;
        lastTime = now;
        const flowOn = session.vizModes.has('flow');
        const tiltOn = session.vizModes.has('tilt');
        const pulseOn = session.vizModes.has('pulse');
        // Background layer (void/stars/aurora) renders first — it sits
        // behind the meta-diagram and all viz overlays. Void skips the
        // draw entirely since the overlay's CSS background is already
        // the right color.
        if (session.bgMode === 'stars') renderStars(dt);
        else if (session.bgMode === 'aurora') renderAurora(dt);
        // Ease the meta-diagram's in-plane rotation toward its target.
        // stageOnProjectSync bumps the target by 90° on every genuine
        // track change; this loop walks metaRotation toward target over
        // ~0.5 s with exponential approach.
        {
            const delta = session.metaRotationTarget - session.metaRotation;
            if (Math.abs(delta) > 0.05) {
                session.metaRotation += delta * Math.min(1, dt * 4);
            } else if (session.metaRotation !== session.metaRotationTarget) {
                session.metaRotation = session.metaRotationTarget;
            }
            // Wrap both values once we've caught up so they don't drift
            // to big numbers after many track changes. Normalizing to
            // [0, 360) keeps the CSS transform string compact.
            if (session.metaRotation === session.metaRotationTarget &&
                (session.metaRotation >= 360 || session.metaRotation < 0)) {
                const wrapped = ((session.metaRotation % 360) + 360) % 360;
                session.metaRotation = wrapped;
                session.metaRotationTarget = wrapped;
            }
        }
        // Tilt: accumulate a slow rotation around X and drift Y so the
        // whole composition feels 3D without becoming seasick. Tilt and
        // metaRotation compose into a single transform string so the
        // rAF loop is the single writer of grid.style.transform.
        if (tiltOn) session.tiltAngle += dt * 12; // deg/sec
        {
            const grid = session.overlay.querySelector('.pn-stage-grid');
            const rotZ = session.metaRotation;
            if (tiltOn) {
                const rx = 18 * Math.sin(session.tiltAngle * Math.PI / 180 * 0.6);
                const ry = 22 * Math.cos(session.tiltAngle * Math.PI / 180 * 0.4);
                grid.style.transform =
                    `perspective(1400px) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rotZ}deg)`;
            } else if (Math.abs(rotZ) > 0.01 || session._hadTransform) {
                grid.style.transform = rotZ ? `rotateZ(${rotZ}deg)` : '';
                session._hadTransform = !!rotZ;
            }
            // Flame canvas lives outside the grid (iPad WebKit blanks
            // 2D canvases under preserve-3d), so it doesn't auto-inherit
            // the grid's rotation. Mirror the grid transform verbatim so
            // tilt + metaRotation tracks identically — applying
            // perspective+rotateX/Y/Z to a single flat canvas projects
            // it as a flat plane in 3D, which is exactly the visual we
            // want (beams tilting forward with the panels).
            if (session.flameCanvas) {
                session.flameCanvas.style.transform = grid.style.transform;
            }
        }
        // Pulse: update the pulse-particle SVG layer. Keep rendering
        // after the mode is toggled off so in-flight particles drain
        // instead of freezing mid-flight on the screen.
        if (pulseOn || session.pulses.length) renderPulses(now);
        // Flame: decay buckets + draw the radial equalizer.
        if (session.vizModes.has('flame')) renderFlame(dt);
        else if (session.flameCtx && session.flameCanvas && session.flameEnergy.size > 0) {
            // One-shot clear when the mode is toggled off.
            session.flameCtx.clearRect(0, 0, session.flameCanvas.width, session.flameCanvas.height);
            session.flameEnergy.clear();
        }
        // Solo visualizers (everything that owns the scope canvas):
        // corona / sonar / petal. Cleared every frame so switching
        // between them doesn't leave stale pixels.
        const v = session.visualizer;
        const soloOn = v === 'corona' || v === 'sonar' || v === 'petal';
        if (soloOn) {
            session.scopeCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
            if (v === 'corona') renderCorona();
            else if (v === 'sonar') renderSonar();
            else if (v === 'petal') renderPetal(dt);
        } else if (session._scopeWasOn) {
            session.scopeCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
        }
        session._scopeWasOn = soloOn;
        // Electric bolts draw on top of the flame canvas when they're
        // alive — whether or not flame mode is on. They only spawn
        // during macros (see stageOnTransitionFired), so there's no
        // per-frame cost outside of those moments. Seeds may outlive
        // their parent bolt by a fraction of a second, so we give
        // them their own drain path once bolts are gone.
        if (session.bolts.length) renderBolts(now);
        else if (session.seeds && session.seeds.length) {
            if (!session.vizModes.has('flame')) {
                session.flameCtx?.clearRect(0, 0, session.flameCanvas.width, session.flameCanvas.height);
            }
            renderSeeds(now, session.ringCenter.x, session.ringCenter.y, session.darkPlanetRadius || 48);
        }
        for (const p of session.panels) {
            if (flowOn) p.angle += p.angleVelDps * dt;
            if (p.angle > 360) p.angle -= 360;
            if (p.angle < -360) p.angle += 360;
            // Keep transform-origin at 0,0 — same convention as canvas.js
            // — and rotate around the net centroid via an inner
            // translate/rotate/translate so the DOM nodes follow the
            // canvas arcs perfectly (arrowheads stay seated on their
            // transitions at every angle).
            const { tx, ty, scale, cx, cy } = p.view;
            p.stage.style.transform =
                `translate(${tx}px, ${ty}px) scale(${scale})` +
                ` translate(${cx}px, ${cy}px) rotate(${p.angle}deg) translate(${-cx}px, ${-cy}px)`;
            drawPanel(p);
        }
        session.rafId = requestAnimationFrame(tick);
    };
    session.rafId = requestAnimationFrame(tick);
}

// Flame mode: a radial equalizer anchored at the ring center. Each
// bucket is a bar shot outward at its angle, color gradient from hot
// orange at the base to transparent at the tip. Energy decays every
// frame so the flame "breathes".
function renderFlame(dt) {
    const ctx = session.flameCtx;
    if (!ctx || !session.flameCanvas) return;
    const w = session.flameCanvas.width / (window.devicePixelRatio || 1);
    const h = session.flameCanvas.height / (window.devicePixelRatio || 1);
    ctx.clearRect(0, 0, w, h);
    const cx = session.ringCenter.x;
    const cy = session.ringCenter.y;
    // Exponential decay — half-life ~180ms. Tweak if the flame is too
    // twitchy or too sticky.
    const decay = Math.exp(-dt * 4);
    const n = session.panels.length;
    // Narrow, fixed beam width — scaling to (π/n) made flames fan out
    // to ~40° when n was small. Cap at ~6° half-angle regardless of N.
    const halfAng = Math.min(0.10, n > 0 ? (Math.PI / n) * 0.15 : 0.10);
    const innerR = Math.min(cx, cy) * 0.10;
    for (const p of session.panels) {
        const v = (session.flameEnergy.get(p.netId) || 0) * decay;
        if (v < 0.01) { session.flameEnergy.delete(p.netId); continue; }
        session.flameEnergy.set(p.netId, v);
        if (p.ringX == null) continue;
        // Prefer the last fired transition node's position so the beam
        // emerges from a point on the sub-ring, not the panel center.
        const tx = p.flameOrigin?.x ?? p.ringX;
        const ty = p.flameOrigin?.y ?? p.ringY;
        const dx = tx - cx;
        const dy = ty - cy;
        const dist = Math.hypot(dx, dy) || 1;
        const theta = Math.atan2(dy, dx);
        // Beam reaches almost to the panel edge so the flame visibly
        // terminates at the panel that fired.
        const barLen = Math.max(innerR + 4, dist * (0.55 + 0.4 * v));
        const x1 = cx + innerR * Math.cos(theta - halfAng);
        const y1 = cy + innerR * Math.sin(theta - halfAng);
        const x2 = cx + innerR * Math.cos(theta + halfAng);
        const y2 = cy + innerR * Math.sin(theta + halfAng);
        const x3 = cx + barLen * Math.cos(theta + halfAng * 0.25);
        const y3 = cy + barLen * Math.sin(theta + halfAng * 0.25);
        const x4 = cx + barLen * Math.cos(theta - halfAng * 0.25);
        const y4 = cy + barLen * Math.sin(theta - halfAng * 0.25);
        const tipX = cx + barLen * Math.cos(theta);
        const tipY = cy + barLen * Math.sin(theta);
        const grad = ctx.createLinearGradient(cx, cy, tipX, tipY);
        grad.addColorStop(0.0, `rgba(255, 200, 64, ${(0.85 * v).toFixed(3)})`);
        grad.addColorStop(0.5, `rgba(233, 69, 96, ${(0.7 * v).toFixed(3)})`);
        grad.addColorStop(1.0, `rgba(74, 144, 217, 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.lineTo(x3, y3);
        ctx.lineTo(x4, y4);
        ctx.closePath();
        ctx.fill();
    }
}

// Background canvas sizing + initial star pool. Called at open, on
// resize, and when switching to Stars for the first time.
function sizeBgCanvas() {
    if (!session?.bgCanvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth, h = window.innerHeight;
    session.bgCanvas.width = Math.round(w * dpr);
    session.bgCanvas.height = Math.round(h * dpr);
    session.bgCanvas.style.width = `${w}px`;
    session.bgCanvas.style.height = `${h}px`;
    session.bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// Switch the top-level visualizer:
//   mandala  — Constellation: ring-of-rings (default)
//   corona   — radial FFT halo (audio-driven)
//   sonar    — expanding ring per beat (beat-driven)
//   petal    — flower whose petals pulse with their track (beat-driven)
//   shuffle  — auto-rotates through the four real visualizers every
//              SHUFFLE_FIRES transitions (beat-driven, not timer-driven,
//              so the swap respects the song's actual pulse).
const HIDE_NETS_VISUALIZERS = new Set(['corona', 'sonar', 'petal']);
const REAL_VISUALIZERS = ['mandala', 'corona', 'sonar', 'petal'];
const SHUFFLE_FIRES = 64; // swap viz every N transition fires while shuffling

function applyVisualizer(name) {
    if (!session) return;
    if (name === 'shuffle') {
        session.shuffling = true;
        session.shuffleFireCount = 0;
        // Pick a random first viz so user sees the swap immediately.
        setVisualizer(pickShuffleNext());
        const sel = session.overlay.querySelector('.pn-stage-visualizer');
        if (sel) sel.value = 'shuffle';
        return;
    }
    session.shuffling = false;
    setVisualizer(name);
}

function setVisualizer(name) {
    session.visualizer = name;
    // The non-Constellation visualizers all want the rings hidden so
    // their geometry reads cleanly. One CSS class controls the swap.
    const hideNets = HIDE_NETS_VISUALIZERS.has(name);
    session.overlay.classList.toggle('viz-solo', hideNets);
    session.overlay.classList.toggle('corona-mode', name === 'corona');
    // Reset per-visualizer state so leaving and returning starts fresh.
    session.sonarRings = [];
    session.sonarLastByCh = new Map();
    session.sonarLastAny = 0;
    session.petalEnergy = new Map();
    // Clear the scope canvas on every visualizer switch so the prior
    // mode's last frame doesn't linger.
    session.scopeCtx?.clearRect(0, 0, window.innerWidth, window.innerHeight);
}

function pickShuffleNext() {
    const choices = REAL_VISUALIZERS.filter(v => v !== session.visualizer);
    return choices[Math.floor(Math.random() * choices.length)];
}

// Public entry point for the `set-visualizer` control action — drives
// the same path as the dropdown, syncs the dropdown UI, and is a no-op
// when Stage isn't open.
export function stageSetVisualizer(name) {
    if (!session) return;
    const allowed = name === 'shuffle' || REAL_VISUALIZERS.includes(name);
    if (!allowed) return;
    applyVisualizer(name);
    const sel = session.overlay.querySelector('.pn-stage-visualizer');
    if (sel) sel.value = name;
}

// Color for a track based on its channel — drums warm, bass cool blues,
// lead golden, melody/lead-y stuff in the cyan→violet range. Hash so any
// channel gets a stable color even if the map doesn't cover it.
function channelHue(ch) {
    if (ch == null) return 200;
    const known = { 1: 50, 2: 220, 3: 200, 4: 280, 5: 320, 6: 180, 7: 140, 8: 30, 9: 100,
                    10: 0, 11: 12, 12: 24, 13: 35, 14: 350,
                    20: 50, 21: 60, 22: 40, 23: 30 };
    return known[ch] ?? ((ch * 47) % 360);
}

// Look up a track's channel by net id.
function netChannel(el, netId) {
    const t = el?._project?.nets?.[netId]?.track;
    return t?.channel ?? null;
}

function sizeScopeCanvas() {
    if (!session?.scopeCanvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth, h = window.innerHeight;
    session.scopeCanvas.width = Math.round(w * dpr);
    session.scopeCanvas.height = Math.round(h * dpr);
    session.scopeCanvas.style.width = `${w}px`;
    session.scopeCanvas.style.height = `${h}px`;
    session.scopeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// Sonar — every fired transition spawns a ring expanding from center.
// Channel determines color so drum hits, bass notes, and lead notes all
// read distinctly. At dense beat rates the rings interfere visibly.
function renderSonar() {
    if (!session?.scopeCtx) return;
    const ctx = session.scopeCtx;
    const w = window.innerWidth, h = window.innerHeight;
    const cx = session.ringCenter?.x ?? w / 2;
    const cy = session.ringCenter?.y ?? h / 2;
    const maxR = Math.hypot(w, h) * 0.55;
    const now = performance.now();
    const rings = session.sonarRings;
    for (let i = rings.length - 1; i >= 0; i--) {
        if (now - rings[i].born > rings[i].life) rings.splice(i, 1);
    }
    ctx.save();
    for (const r of rings) {
        const t = (now - r.born) / r.life;     // 0 → 1
        const radius = t * maxR;
        const alpha = (1 - t) * 0.85;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.strokeStyle = `hsla(${r.hue}, 95%, 60%, ${alpha})`;
        ctx.lineWidth = 1 + (1 - t) * 4;
        ctx.shadowColor = `hsla(${r.hue}, 95%, 55%, ${alpha * 0.5})`;
        ctx.shadowBlur = 8;
        ctx.stroke();
    }
    ctx.restore();
}

// Petal — each track is one petal at a fixed angle around the center.
// Every fire on that track spikes its energy; energy decays smoothly.
// Petal length pulses with energy so the whole image is a flower whose
// breathing pattern is the arrangement.
function renderPetal(dt) {
    if (!session?.scopeCtx) return;
    const ctx = session.scopeCtx;
    const w = window.innerWidth, h = window.innerHeight;
    const cx = session.ringCenter?.x ?? w / 2;
    const cy = session.ringCenter?.y ?? h / 2;
    const baseR = Math.min(w, h) * 0.08;
    const maxR  = Math.min(w, h) * 0.42;
    // Decay petal energies fast enough that individual fires read as
    // distinct pulses. dt is in SECONDS; coefficient 2.3 makes energy
    // halve every ~300ms, so a fire visibly drops between hits.
    const decay = Math.exp(-dt * 2.3);
    for (const [k, v] of session.petalEnergy) {
        const next = v * decay;
        if (next < 0.005) session.petalEnergy.delete(k);
        else session.petalEnergy.set(k, next);
    }
    const panels = session.panels || [];
    if (panels.length === 0) return;
    ctx.save();
    panels.forEach((panel, i) => {
        const angle = (i / panels.length) * Math.PI * 2 - Math.PI / 2;
        const ch = netChannel(session.el, panel.netId);
        const hue = channelHue(ch);
        // sqrt mapping so a small fresh fire reads as a big pulse — without
        // it, the perceptual difference between energy 0.3 and energy 0.6
        // is visually negligible.
        const raw = session.petalEnergy.get(panel.netId) || 0;
        const energy = Math.sqrt(raw);
        const len = baseR + (maxR - baseR) * (0.18 + energy * 0.95);
        const halfWidth = (Math.PI / panels.length) * (0.45 + energy * 0.5);
        // Petal as a quadratic: tip at length, base at center, curving sides.
        const tipX = cx + Math.cos(angle) * len;
        const tipY = cy + Math.sin(angle) * len;
        const leftAng = angle - halfWidth;
        const rightAng = angle + halfWidth;
        const ctrlR = (baseR + len) * 0.55;
        const lx = cx + Math.cos(leftAng) * ctrlR;
        const ly = cy + Math.sin(leftAng) * ctrlR;
        const rx = cx + Math.cos(rightAng) * ctrlR;
        const ry = cy + Math.sin(rightAng) * ctrlR;
        const grad = ctx.createRadialGradient(cx, cy, baseR * 0.5, tipX, tipY, len);
        grad.addColorStop(0, `hsla(${hue}, 80%, 55%, ${0.25 + energy * 0.55})`);
        grad.addColorStop(1, `hsla(${hue}, 95%, 65%, ${0.05 + energy * 0.25})`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.quadraticCurveTo(lx, ly, tipX, tipY);
        ctx.quadraticCurveTo(rx, ry, cx, cy);
        ctx.fill();
        // Outline so the petal still reads when energy is low.
        ctx.strokeStyle = `hsla(${hue}, 95%, 70%, ${0.4 + energy * 0.5})`;
        ctx.lineWidth = 1 + energy * 2.5;
        ctx.shadowColor = `hsla(${hue}, 95%, 60%, ${energy * 0.6})`;
        ctx.shadowBlur = 4 + energy * 14;
        ctx.stroke();
    });
    ctx.restore();
}

// Ring-centric FFT visualizer: 128 bars radiating outward from the meta-
// net center, length keyed to bin energy, hue cool→warm. The corona owns
// the scope canvas in this mode and the underlying ring panels are
// hidden via .corona-mode CSS so the halo reads cleanly.
function renderCorona() {
    if (!session?.scopeCtx) return;
    const ctx = session.scopeCtx;
    const w = window.innerWidth, h = window.innerHeight;
    const a = toneEngine.getMasterAnalyser?.('fft', 128);
    if (!a) return;
    let data;
    try { data = a.getValue(); } catch { return; }
    const cx = session.ringCenter?.x ?? w / 2;
    const cy = session.ringCenter?.y ?? h / 2;
    const inner = session.darkPlanetRadius || Math.min(w, h) * 0.08;
    const innerR = inner + 18;          // gap so the corona doesn't kiss the planet
    const maxLen = Math.min(w, h) * 0.32;
    const n = data.length;
    ctx.save();
    ctx.lineCap = 'round';
    for (let i = 0; i < n; i++) {
        const db = Math.max(-100, Math.min(0, data[i]));
        const norm = (db + 100) / 100;
        const len = norm * maxLen;
        const angle = (i / n) * Math.PI * 2 - Math.PI / 2; // start at top
        const x0 = cx + Math.cos(angle) * innerR;
        const y0 = cy + Math.sin(angle) * innerR;
        const x1 = cx + Math.cos(angle) * (innerR + len);
        const y1 = cy + Math.sin(angle) * (innerR + len);
        const hue = 200 - norm * 160;
        ctx.strokeStyle = `hsla(${hue}, 90%, 60%, ${0.35 + norm * 0.55})`;
        ctx.lineWidth = 2 + norm * 3.5;
        ctx.shadowColor = `hsla(${hue}, 90%, 55%, 0.6)`;
        ctx.shadowBlur = 6 + norm * 10;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
    }
    ctx.restore();
}

function spawnStars() {
    // Stationary sparse starfield — inspired by pilot.pflow.xyz.
    // No motion; each star just twinkles at its own slow rate.
    const count = 150;
    const stars = [];
    for (let i = 0; i < count; i++) {
        stars.push({
            x: Math.random(),
            y: Math.random(),
            size: 0.6 + Math.random() * 1.4,
            bright: 0.25 + Math.random() * 0.55,
            twinkleRate: 0.3 + Math.random() * 1.1,
            phase: Math.random() * Math.PI * 2,
        });
    }
    session.bgStars = stars;
    spawnPlanets();
}

// A few ringed planets tucked into the corners — atmosphere for the
// `stars` background. Kept small, off-center, and desaturated so they
// read as scenery; the meta-diagram stays the subject. Rings tilt
// slowly over time via a per-planet tiltRate. Colors are the
// muted-dark palette from renderAurora.
function spawnPlanets() {
    const palette = [
        { body: '#5a3e8c', ring: 'rgba(200, 180, 240,' },  // dusty violet
        { body: '#3e5a8c', ring: 'rgba(170, 200, 240,' },  // cool slate blue
        { body: '#8c5a3e', ring: 'rgba(240, 200, 170,' },  // dim rust
        { body: '#3e8c6d', ring: 'rgba(170, 240, 210,' },  // sea-foam
    ];
    // Two or three planets; tucked away from the center. Biased toward
    // corners (x & y near 0 or 1) so they don't crowd the meta-ring.
    const slots = [
        { x: 0.12, y: 0.18 },
        { x: 0.88, y: 0.22 },
        { x: 0.18, y: 0.82 },
        { x: 0.84, y: 0.78 },
    ];
    const shuffled = slots.slice().sort(() => Math.random() - 0.5);
    const count = 2 + (Math.random() < 0.5 ? 0 : 1);
    const planets = [];
    for (let i = 0; i < count; i++) {
        const slot = shuffled[i];
        const pal = palette[Math.floor(Math.random() * palette.length)];
        planets.push({
            x: slot.x + (Math.random() - 0.5) * 0.05,
            y: slot.y + (Math.random() - 0.5) * 0.05,
            r: 22 + Math.random() * 26,           // body radius in px
            ringRatio: 1.8 + Math.random() * 0.6, // ring outer = r * ratio
            ringWidth: 0.18 + Math.random() * 0.12,
            tilt: Math.random() * Math.PI,        // rings rotate about planet
            tiltRate: (Math.random() < 0.5 ? -1 : 1) * (0.03 + Math.random() * 0.04),
            body: pal.body,
            ring: pal.ring,
        });
    }
    session.bgPlanets = planets;
}

// Night-sky starfield. Palette borrowed from pilot.pflow.xyz: deep
// indigo base with a slight upper-center glow, tiny faint stars that
// twinkle independently. Strictly a mood layer — no streaking, no
// parallax — so the meta-diagram always wins the viewer's attention.
function renderStars(dt) {
    const ctx = session.bgCtx;
    const canvas = session.bgCanvas;
    if (!ctx || !canvas) return;
    if (session.bgStars.length === 0) spawnStars();
    const w = canvas.width / (window.devicePixelRatio || 1);
    const h = canvas.height / (window.devicePixelRatio || 1);
    // Dark indigo gradient — lighter toward upper-center, fading to
    // near-black at the edges.
    const grad = ctx.createRadialGradient(w * 0.5, h * 0.32, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.85);
    grad.addColorStop(0, '#161530');
    grad.addColorStop(0.6, '#0c0b20');
    grad.addColorStop(1, '#05041a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    session.bgAuroraPhase = (session.bgAuroraPhase || 0) + dt;
    const t = session.bgAuroraPhase;
    // Planets sit under the stars so twinkles are foreground.
    renderPlanets(ctx, w, h, t);
    for (const s of session.bgStars) {
        const twinkle = 0.55 + 0.45 * Math.sin(t * s.twinkleRate + s.phase);
        const alpha = (s.bright * twinkle).toFixed(3);
        ctx.fillStyle = `rgba(210, 220, 250, ${alpha})`;
        ctx.beginPath();
        ctx.arc(s.x * w, s.y * h, s.size, 0, Math.PI * 2);
        ctx.fill();
    }
}

function renderPlanets(ctx, w, h, t) {
    if (!session.bgPlanets || session.bgPlanets.length === 0) return;
    for (const p of session.bgPlanets) {
        const cx = p.x * w;
        const cy = p.y * h;
        // Planet body: radial gradient for a bit of terminator shading —
        // lit side on the upper-left, deep shadow on the lower-right.
        const bodyGrad = ctx.createRadialGradient(
            cx - p.r * 0.35, cy - p.r * 0.35, p.r * 0.1,
            cx, cy, p.r
        );
        bodyGrad.addColorStop(0, p.body);
        bodyGrad.addColorStop(1, '#05041a');
        ctx.fillStyle = bodyGrad;
        ctx.beginPath();
        ctx.arc(cx, cy, p.r, 0, Math.PI * 2);
        ctx.fill();
        // Ring: a thin tilted annulus drawn as a stroked ellipse. Split
        // into back-half (behind the planet) and front-half (in front)
        // so the ring appears to wrap the planet. Slow rotation via
        // tiltRate so the planets feel "ringing" rather than static.
        const tilt = p.tilt + t * p.tiltRate;
        const outer = p.r * p.ringRatio;
        const inner = outer * (1 - p.ringWidth);
        const ringMid = (outer + inner) * 0.5;
        const ringThickness = (outer - inner);
        const ringY = ringMid * 0.22;   // flatten into an ellipse
        // Back half — behind the planet body; dimmer so it reads as occluded.
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(tilt);
        ctx.strokeStyle = p.ring + '0.18)';
        ctx.lineWidth = ringThickness;
        ctx.beginPath();
        ctx.ellipse(0, 0, ringMid, ringY, 0, Math.PI, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        // Re-draw the planet on top to cover the back half where it
        // passes behind the body (cheap occlusion without clipping).
        ctx.fillStyle = bodyGrad;
        ctx.beginPath();
        ctx.arc(cx, cy, p.r, 0, Math.PI * 2);
        ctx.fill();
        // Front half — brighter than the back so the ring reads as a solid band.
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(tilt);
        ctx.strokeStyle = p.ring + '0.42)';
        ctx.lineWidth = ringThickness;
        ctx.beginPath();
        ctx.ellipse(0, 0, ringMid, ringY, 0, 0, Math.PI);
        ctx.stroke();
        ctx.restore();
    }
}

// Aurora: slow interference pattern of large colored blobs drifting
// across the screen — deep blues and magentas, very low contrast so
// the ring reads cleanly on top. Implemented as additive radial
// gradients whose centers orbit independently.
function renderAurora(dt) {
    const ctx = session.bgCtx;
    const canvas = session.bgCanvas;
    if (!ctx || !canvas) return;
    session.bgAuroraPhase = (session.bgAuroraPhase || 0) + dt;
    const w = canvas.width / (window.devicePixelRatio || 1);
    const h = canvas.height / (window.devicePixelRatio || 1);
    // Solid base fill so switching from stars doesn't leave speckle.
    ctx.fillStyle = '#07061a';
    ctx.fillRect(0, 0, w, h);
    const p = session.bgAuroraPhase;
    // Dark palette — the meta-diagram is the subject; aurora is a
    // barely-there mood wash, not scenery. Opacities kept low and the
    // colors muted-dark so the viewer sees hue shifts, not brightness.
    const blobs = [
        { cx: 0.25 + 0.12 * Math.sin(p * 0.09),       cy: 0.30 + 0.15 * Math.cos(p * 0.07),    r: 0.55, color: 'rgba(30, 22, 90, 0.18)'  },
        { cx: 0.78 + 0.10 * Math.sin(p * 0.11 + 1.5), cy: 0.40 + 0.12 * Math.cos(p * 0.06 + 2), r: 0.50, color: 'rgba(90, 18, 60, 0.14)'  },
        { cx: 0.50 + 0.18 * Math.sin(p * 0.05 + 3),   cy: 0.80 + 0.10 * Math.cos(p * 0.08 + 1), r: 0.60, color: 'rgba(12, 45, 90, 0.18)'  },
        { cx: 0.65 + 0.14 * Math.sin(p * 0.075 + 4),  cy: 0.15 + 0.10 * Math.cos(p * 0.095),    r: 0.45, color: 'rgba(70, 30, 10, 0.10)'  },
    ];
    ctx.globalCompositeOperation = 'lighter';
    for (const b of blobs) {
        const x = b.cx * w, y = b.cy * h;
        const rad = b.r * Math.max(w, h);
        const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
        g.addColorStop(0, b.color);
        g.addColorStop(1, 'rgba(7, 6, 26, 0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
    }
    ctx.globalCompositeOperation = 'source-over';
}

// Jagged bolt overlay. Shares the flame canvas so bolts render above
// the gradient beams. Each bolt is a polyline from the fired
// transition's position toward the ring center, with perpendicular
// sinusoidal jitter that reshuffles each frame so the line "crackles".
function renderBolts(now) {
    const ctx = session.flameCtx;
    const canvas = session.flameCanvas;
    if (!ctx || !canvas) return;
    // If flame mode is off, renderFlame didn't clear the canvas this
    // frame — clear it here so bolts don't leave trails.
    if (!session.vizModes.has('flame')) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    const cx = session.ringCenter.x;
    const cy = session.ringCenter.y;
    const darkPlanetR = session.darkPlanetRadius || 48;
    const alive = [];
    // Aggregate bolt energy so the dark planet's halo brightens with
    // how hard the macros are firing — the center object "condenses"
    // into view out of the live arrows and dims back into the void
    // once the burst ends.
    let boltEnergy = 0;
    for (const b of session.bolts) {
        const t = (now - b.born) / b.life;
        if (t >= 1) continue;
        alive.push(b);
        const alpha = Math.max(0, 1 - t);
        boltEnergy += alpha;
        const ox = b.origin.x, oy = b.origin.y;
        // Bolt points from origin toward center; stop short of the
        // center on the dark planet's surface so the planet itself
        // is never crossed by an arrow. If the origin is *inside*
        // the planet (shouldn't happen with real panel positions,
        // but guard) just skip drawing so we don't invert direction.
        const dxAll = cx - ox, dyAll = cy - oy;
        const distOrigin = Math.hypot(dxAll, dyAll);
        if (distOrigin <= darkPlanetR + 2) continue;
        const ux = dxAll / distOrigin, uy = dyAll / distOrigin;
        const endX = cx - ux * darkPlanetR;
        const endY = cy - uy * darkPlanetR;
        const dx = endX - ox, dy = endY - oy;
        const len = Math.hypot(dx, dy);
        if (len < 2) continue;
        const nx = -uy, ny = ux;
        const segs = 12;
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = `rgba(200, 225, 255, ${(0.85 * alpha).toFixed(3)})`;
        ctx.shadowColor = `rgba(120, 180, 255, ${(0.9 * alpha).toFixed(3)})`;
        ctx.shadowBlur = 10;
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        for (let i = 1; i < segs; i++) {
            const f = i / segs;
            const taper = 1 - Math.abs(f - 0.5) * 2;        // 0..1..0
            const amp = 26 * taper;
            const jitter = Math.sin(b.seed + i * 11.3 + now * 0.035) * amp
                         + Math.sin(b.seed * 0.7 + i * 3.1 + now * 0.07) * amp * 0.35;
            const x = ox + dx * f + nx * jitter;
            const y = oy + dy * f + ny * jitter;
            ctx.lineTo(x, y);
        }
        ctx.lineTo(endX, endY);
        ctx.stroke();
        // Hot core — draw a second thinner, whiter pass.
        ctx.strokeStyle = `rgba(255, 255, 255, ${(0.9 * alpha).toFixed(3)})`;
        ctx.shadowBlur = 4;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
        // Seed: once per bolt, drop a spark at the strike point the
        // first time we render it. The spark lingers briefly after
        // the bolt fades, drifting inward — the "hole drilled into
        // the planet to seed a note" reading the user gave us.
        if (!b.seeded) {
            b.seeded = true;
            if (!session.seeds) session.seeds = [];
            session.seeds.push({
                x: endX, y: endY,
                ux, uy,                 // inward direction
                born: now,
                life: 1100,
            });
            if (session.seeds.length > 48) session.seeds.shift();
        }
    }
    session.bolts = alive;
    renderSeeds(now, cx, cy, darkPlanetR);

    // The dark planet: a soft luminous body the bolts are all
    // pointing at. Only rendered while bolts exist; intensity
    // scales with aggregate bolt energy so the center object
    // visibly condenses out of the crackling arrows and dissolves
    // once the macro burst ends.
    if (boltEnergy > 0) {
        const glow = Math.min(1, boltEnergy * 0.55);
        ctx.save();
        // Soft halo only — no perimeter stroke. Two radial washes:
        // a warm inner glow that fades to transparent, and a cooler
        // atmospheric rim that peaks right at the dark planet's
        // surface so its boundary reads without a hard line.
        const inner = ctx.createRadialGradient(cx, cy, 0, cx, cy, darkPlanetR);
        inner.addColorStop(0, `rgba(150, 190, 255, ${(0.22 * glow).toFixed(3)})`);
        inner.addColorStop(1, 'rgba(120, 180, 255, 0)');
        ctx.fillStyle = inner;
        ctx.beginPath();
        ctx.arc(cx, cy, darkPlanetR, 0, Math.PI * 2);
        ctx.fill();
        const rim = ctx.createRadialGradient(cx, cy, darkPlanetR * 0.6, cx, cy, darkPlanetR * 1.25);
        rim.addColorStop(0, 'rgba(120, 180, 255, 0)');
        rim.addColorStop(0.55, `rgba(180, 210, 255, ${(0.18 * glow).toFixed(3)})`);
        rim.addColorStop(1, 'rgba(120, 180, 255, 0)');
        ctx.fillStyle = rim;
        ctx.beginPath();
        ctx.arc(cx, cy, darkPlanetR * 1.25, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
}

// Seeds: tiny sparks left on the dark planet's surface where a bolt
// struck, then drifting slowly inward before fading. They give the
// impression the lightning drilled a hole into the planet and is
// depositing a note there. Safe no-op when session.seeds is empty.
function renderSeeds(now, cx, cy, planetR) {
    if (!session || !session.seeds || session.seeds.length === 0) return;
    const ctx = session.flameCtx;
    if (!ctx) return;
    const alive = [];
    ctx.save();
    for (const s of session.seeds) {
        const t = (now - s.born) / s.life;
        if (t >= 1) continue;
        alive.push(s);
        // Drift inward: a small amount of the planet radius over the
        // seed's lifetime, easing out so the motion feels settled.
        const inward = planetR * 0.35 * (1 - Math.pow(1 - t, 2));
        const x = s.x + s.ux * inward;
        const y = s.y + s.uy * inward;
        const alpha = Math.max(0, 1 - t);
        // Core spark — warm white, bright at strike then fading.
        const core = Math.max(0.8, 2.2 * (1 - t) + 0.5);
        ctx.shadowColor = `rgba(255, 220, 150, ${(0.8 * alpha).toFixed(3)})`;
        ctx.shadowBlur = 10;
        ctx.fillStyle = `rgba(255, 240, 210, ${(0.95 * alpha).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(x, y, core, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.restore();
    session.seeds = alive;
}

// Repaint active pulse particles as a top-layer overlay on the meta svg.
// Reuses the same <svg> node; we just rewrite a dedicated <g class="pulses">
// each frame so dead particles drop cleanly.
function renderPulses(now) {
    const meta = session.overlay.querySelector('.pn-stage-meta');
    if (!meta) return;
    // Evict dead particles first so the visible count matches state.
    const alive = [];
    const parts = [];
    for (const q of session.pulses) {
        const t = (now - q.born) / q.life;
        if (t >= 1) continue;
        alive.push(q);
        // ease-in on position, linear fade on opacity, shrink toward center.
        const e = 1 - Math.pow(1 - t, 2);
        const x = q.x0 + (q.cx - q.x0) * e;
        const y = q.y0 + (q.cy - q.y0) * e;
        const r = Math.max(1.5, 10 * (1 - t));
        const alpha = 0.7 * (1 - t);
        parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="#e94560" fill-opacity="${alpha.toFixed(3)}"/>`);
    }
    session.pulses = alive;
    let layer = meta.querySelector('.pulses');
    if (!layer) {
        layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        layer.classList.add('pulses');
        meta.appendChild(layer);
    }
    layer.innerHTML = parts.join('');
}

// Stage is aimed at a passive listener treating the app like a
// screensaver — they might tweak a knob every few minutes but mostly
// want to watch it breathe. The help modal explains what each symbol
// on the toolbar does and how to read the composition as a Petri net.
// Flash the share card for ~6 seconds as a corner overlay. Used at
// track change when the toolbar toggle is on — lets a recording
// capture the genre/seed/key/tempo plus a scannable QR so someone
// watching later can reopen the exact track. The QR is only accurate
// after upload, so we seal the payload first; if sealing fails we
// fall back to the inline ?cid=…&z=… URL which always works.
function flashShareCard(el) {
    if (!session) return;
    const overlay = session.overlay;
    // Remove any in-flight card — only one at a time; if track changes
    // come faster than 6 s (Auto-DJ bursts), the newest wins.
    overlay.querySelector('.pn-stage-cardbox')?.remove();
    const box = document.createElement('div');
    box.className = 'pn-stage-cardbox';
    overlay.appendChild(box);
    // Kick off the seal + URL build; the card re-renders with the real
    // cid once that resolves. Show a temporary placeholder so the user
    // sees something immediately.
    try {
        box.innerHTML = renderCurrentCard(el, '');
    } catch (err) { box.innerHTML = ''; }
    buildShareUrlForms(el).then(({ shortUrl, fullUrl, stored }) => {
        if (!session || !box.isConnected) return;
        // Sync URL bar so the cid from the freshly-sealed payload is
        // the one the QR reflects (renderCurrentCard reads the cid
        // from location.search).
        try {
            const url = stored ? shortUrl : fullUrl;
            history.replaceState(null, '', url);
            box.innerHTML = renderCurrentCard(el, '');
        } catch (err) { /* swallow; placeholder stays */ }
    }).catch(() => { /* placeholder is fine */ });
    // Auto-dismiss after 6 s with a short fade so it doesn't feel abrupt.
    const fadeAt = setTimeout(() => box.classList.add('fading'), 5400);
    const killAt = setTimeout(() => { clearTimeout(fadeAt); box.remove(); }, 6000);
    // If Stage closes first, clean up the timers.
    box._killTimers = () => { clearTimeout(fadeAt); clearTimeout(killAt); };
}

function openHelp(overlay) {
    if (overlay.querySelector('.pn-stage-help-modal')) return;
    const modal = document.createElement('div');
    modal.className = 'pn-stage-help-modal';
    modal.innerHTML = `
        <div class="pn-stage-help-box">
            <button class="pn-stage-help-close" title="Close (Esc)">&times;</button>
            <h2>Stage — what you're watching</h2>
            <p class="pn-stage-help-lede">
                Every shape on screen is part of one big Petri net — a visual
                grammar for rhythm. Tokens circulate; each firing is a note.
                The piece plays itself while you watch.
            </p>

            <h3>Reading the composition</h3>
            <ul>
                <li><b>Sub-rings (panels)</b> — each is one track's one-bar
                    pattern. Squares <span class="pn-help-sym square"></span>
                    are <i>transitions</i> (the notes that fire); circles
                    <span class="pn-help-sym circle"></span> are <i>places</i>
                    (state between firings). Arrows are the flow of tokens.</li>
                <li><b>Meta-ring</b> — the larger geometry connecting the
                    panels (inner blue circles + radial arrows) is itself a
                    Petri net: the whole Stage reads as N transitions ↔ N
                    places around one giant loop.</li>
                <li><b>Playhead glow</b> — the last transition to fire stays
                    softly lit so you can see the beat travel around each ring.</li>
                <li><b>Dimmed panels</b> — muted tracks. Arrangement control
                    nets unmute variants over time; that's how a one-bar ring
                    becomes a multi-bar song.</li>
                <li><b>Mandala view</b> — with <b>⇄</b> on, every riffGroup
                    variant (bass-0, bass-1, …) is visible at once. A 48-bar
                    song is built from many one-bar riffs; arrangement picks
                    which ones are live at each moment.</li>
            </ul>

            <h3>Viz layers (stackable)</h3>
            <ul>
                <li><b>◌ Flow</b> — each sub-ring spins at its own slow drift
                    rate. Ambient motion; clockwise or counter per panel.</li>
                <li><b>◎ Pulse</b> — every fired transition spawns a particle
                    that falls toward the composition center. Traffic of the
                    beat, fading as it converges.</li>
                <li><b>▼ Flame</b> — a narrow radial beam per panel, brightened
                    by recent firings, decaying each frame. The louder a track
                    is playing, the longer its beam.</li>
                <li><b>⊝ Tilt</b> — slow 3D perspective orbit of the whole
                    Stage. Pair with Flow for a maximum-drift screensaver.</li>
            </ul>

            <h3>Tools</h3>
            <ul>
                <li><b>◈ Feel</b> — opens the 4-corner performance pad (Chill,
                    Drive, Ambient, Euphoric). Drag the puck to blend tempo,
                    FX, Auto-DJ, swing, and humanize into a mood.</li>
                <li><b>⇄ Expand</b> — toggles mandala mode (all variants
                    shown) vs. collapsed (one panel per logical track).</li>
                <li><b>■ Backs</b> — toggle panel background fills. Off is
                    cleaner; on gives each sub-ring its own window.</li>
                <li><b>A Labels</b> — show/hide track names.</li>
                <li><b>Structure</b> — Loop / A-B / Drop / Build / Jam /
                    Minimal / Standard / Extended. Triggers a fresh
                    arrangement with that form.</li>
                <li><b>Scale</b> — Fit auto-sizes panels to the ring; S/M/L/XL
                    forces a size if you want denser overlap (mandala) or
                    fewer, bigger rings.</li>
                <li><b>Background</b> — Void (solid), Stars (warp-speed
                    starfield streaming outward from the composition
                    center), Aurora (slow drifting blue-magenta light).</li>
                <li><b>✐ Card on change</b> — flash the share card (title,
                    seed, tempo, key, QR) for a few seconds on every track
                    change. Good for recording a session — the QR in the
                    video lets a viewer reopen the exact track.</li>
                <li><b>Macro bolts</b> — while a macro is running, every
                    firing also spawns a jagged white-blue electric bolt
                    from the panel toward the center. No toggle — it
                    follows the Macros panel automatically.</li>
                <li><b>Track-change spin</b> — the whole meta-diagram spins
                    a quarter-turn on every genuine track change so the
                    new arrangement feels distinct from the previous one.</li>
                <li><b>×</b> or <kbd>Esc</kbd> — close Stage.</li>
            </ul>

            <h3>Hotkeys</h3>
            <p>
                All of the app's keyboard shortcuts still work while
                Stage is open — try them without closing:
            </p>
            <ul>
                <li><kbd>Space</kbd> play / stop · <kbd>M</kbd> close Stage · <kbd>Esc</kbd> close modal or Stage</li>
                <li><kbd>G</kbd> generate · <kbd>S</kbd> shuffle instruments · <kbd>F</kbd> Feel pad</li>
                <li><kbd>J</kbd> Auto-DJ run · <kbd>P</kbd> panic (cancel macros)</li>
                <li><kbd>B</kbd> FX bypass · <kbd>R</kbd> FX reset · <kbd>T</kbd> tap tempo · <kbd>,</kbd> / <kbd>.</kbd> BPM ∓1</li>
                <li><kbd>1</kbd>–<kbd>4</kbd> toggle hit tracks · <kbd>[</kbd> / <kbd>]</kbd> prev / next track</li>
                <li><kbd>←</kbd> <kbd>↑</kbd> <kbd>→</kbd> <kbd>↓</kbd> nudge hovered slider (works on any control under the cursor)</li>
                <li><kbd>?</kbd> open main app help</li>
            </ul>

            <h3>Theory</h3>
            <p>
                The <b>dark planet</b> at the center of the meta-diagram
                is on purpose. It's the <i>center object</i> — the piece
                itself — and the panels around it are all the ways that
                object reveals itself in play. Each sub-ring is a
                different morphism <i>into</i> the dark planet: kick
                says "hit the one," bass says "walk the low end,"
                melody says "climb the scale." Read together, the panels
                specify the planet by implication, not by drawing it.
            </p>
            <p>
                That's the <b>Yoneda lemma</b> as ambient music: an
                object is fully determined by how every other object
                maps to it. The dark planet is left un-drawn because
                the sum of the ways-notes-can-play already determines
                what's playing; a literal rendering would be redundant.
                During macro bursts the bolt arrows pile up until the
                planet's soft halo visibly condenses out of them, then
                fades as the burst ends.
            </p>
            <p>
                Related reading on <b>blog.stackdump.com</b>:
            </p>
            <ul>
                <li><a href="https://blog.stackdump.com/posts/petri-net-sequencer" target="_blank" rel="noopener">Petri Nets as a Music Sequencer</a> — the architecture this Stage visualizes.</li>
                <li><a href="https://blog.stackdump.com/posts/tense-type-theory" target="_blank" rel="noopener">The Zipper Whose Hole Is a Universe</a> — the hole in a data structure points outward at everything that could fill it; same idea, different shape as our dark planet.</li>
            </ul>

            <h3>Using with AI</h3>
            <p>
                Share-v1 is a deterministic IR — any producer, including
                an LLM, can emit valid JSON and get byte-identical
                playback. <button class="pn-stage-help-ai pn-link-btn">Copy the prompt</button>
                and paste it into any chat model to compose tracks from
                text.
            </p>

            <p class="pn-stage-help-foot">
                The audio never stops while you browse tools — Stage is a
                read-only window over the same sequencer that's playing.
            </p>
        </div>
    `;
    overlay.appendChild(modal);
    modal.querySelector('.pn-stage-help-close').addEventListener('click', () => modal.remove());
    modal.querySelector('.pn-stage-help-ai').addEventListener('click', () => openAiPromptModal());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

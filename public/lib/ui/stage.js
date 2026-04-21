// Full-page "Stage" animation mode: every unmuted music net gets its own
// live-animated Petri-net panel — transitions pulse on fire, each panel
// drifts at its own slow rotation. Read-only view; audio keeps playing
// through the normal pipeline.
//
// State is module-scoped (not on `el`) so it can't collide with the
// single-net renderer in canvas.js, which owns el._stage/_nodes/_view.

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
    overlay.className = 'pn-stage-overlay hide-backs hide-labels';
    overlay.dataset.pnStage = '1';
    overlay.innerHTML = `
        <div class="pn-stage-menu" role="group" aria-label="Stage viz modes">
            <button data-viz="flow" class="active" aria-pressed="true" title="Flow — panels drift">&#9676;</button>
            <button data-viz="pulse" aria-pressed="false" title="Pulse — beats fade toward center">&#9678;</button>
            <button data-viz="flame" aria-pressed="false" title="Flame — radial equalizer from center">&#9660;</button>
            <button data-viz="tilt" aria-pressed="false" title="Tilt — 3D perspective rotation">&#8861;</button>
            <button class="pn-stage-feel" title="Feel (F)">&#9672;</button>
            <button class="pn-stage-expand" aria-pressed="false" title="Show all slot variants (A+B+…)">&#8646;</button>
            <button class="pn-stage-backs" aria-pressed="false" title="Show/hide panel backgrounds">&#9632;</button>
            <button class="pn-stage-labels" aria-pressed="false" title="Show/hide track labels">A</button>
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
        <button class="pn-stage-close" title="Close (Esc)">&times;</button>
        <div class="pn-stage-grid">
            <canvas class="pn-stage-flame" aria-hidden="true"></canvas>
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
        vizModes: new Set(['flow']),
        pulses: [],           // { x0, y0, cx, cy, born, life }  for pulse mode
        tiltAngle: 0,         // accumulator for tilt mode
        ringCenter: { x: 0, y: 0 },
        flameEnergy: new Map(), // netId -> energy (0..1) for flame mode
        flameCanvas: null,
        flameCtx: null,
        scale: 'loop',        // panel-size scale: loop (default) / s / m / l / xl
        expandVariants: false, // false = collapse riffGroup → one panel; true = one panel per variant
    };

    session.onKey = (e) => { if (e.key === 'Escape') closeStage(el); };
    document.addEventListener('keydown', session.onKey);

    session.onResize = () => {
        layoutRing(session);
        for (const p of session.panels) layoutPanel(p);
    };
    window.addEventListener('resize', session.onResize);
    layoutRing(session);

    overlay.querySelector('.pn-stage-close').addEventListener('click', () => closeStage(el));
    overlay.querySelector('.pn-stage-feel').addEventListener('click', () => {
        el._openFeelModal();
    });
    overlay.querySelector('.pn-stage-expand').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        session.expandVariants = !session.expandVariants;
        btn.classList.toggle('active', session.expandVariants);
        btn.setAttribute('aria-pressed', String(session.expandVariants));
        stageOnProjectSync(el);
    });
    overlay.querySelector('.pn-stage-backs').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        const on = overlay.classList.toggle('hide-backs');
        btn.classList.toggle('active', !on);
        btn.setAttribute('aria-pressed', String(!on));
    });
    overlay.querySelector('.pn-stage-labels').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        const on = overlay.classList.toggle('hide-labels');
        btn.classList.toggle('active', !on);
        btn.setAttribute('aria-pressed', String(!on));
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
        if (mode === 'tilt' && on) {
            const grid = overlay.querySelector('.pn-stage-grid');
            grid.style.transform = '';
            session.tiltAngle = 0;
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
    if (session.onKey) document.removeEventListener('keydown', session.onKey);
    if (session.onResize) window.removeEventListener('resize', session.onResize);
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
        const origin = nodeCenterInStage(session, node) || { x: panel.ringX, y: panel.ringY };
        if (session.pulses.length > 64) session.pulses.shift();
        session.pulses.push({
            x0: origin.x, y0: origin.y,
            cx: session.ringCenter.x, cy: session.ringCenter.y,
            born: performance.now(),
            life: 700,
        });
    }
    // Flame: bump this panel's radial beam. One beam per panel, aimed
    // exactly at the panel's angle, so firings line up with visible
    // panel positions regardless of how many are on stage.
    if (session.vizModes.has('flame') && panel?.ringX != null) {
        const prev = session.flameEnergy.get(panel.netId) || 0;
        session.flameEnergy.set(panel.netId, Math.min(1, prev + 0.9));
        const origin = nodeCenterInStage(session, node);
        if (origin) panel.flameOrigin = origin;
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
    const grid = session.overlay.querySelector('.pn-stage-grid');
    // Preserve the canvas + svg overlays; only wipe panel divs.
    for (const p of session.panels) p.root.remove();
    session.panels.length = 0;
    session.pulses.length = 0;
    session.flameEnergy.clear();
    for (const entry of buildPanels(el, grid)) session.panels.push(entry);
    // Sync structure dropdown to whatever the header now shows.
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
        // If this panel represents a riffGroup and a *different* variant
        // is now the unmuted one, swap the displayed net (A→B slot flip
        // at a section boundary). Skip for panels with no riffGroup.
        if (p.riffGroup) {
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
    const rect = grid.getBoundingClientRect();
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
    let stride = Math.max(1, Math.round(n * 0.381966));
    while (gcd(stride, n) !== 1) {
        stride++;
        if (stride >= n) { stride = 1; break; }
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

// Translate a panel sub-node's screen position into coordinates used by
// the stage-level canvas/svg overlays (which are children of
// `.pn-stage-grid`). Used by pulse/flame to originate effects from the
// actual fired transition rather than the panel center.
function nodeCenterInStage(s, node) {
    if (!node) return null;
    const grid = s.overlay?.querySelector('.pn-stage-grid');
    if (!grid) return null;
    const nr = node.getBoundingClientRect();
    const gr = grid.getBoundingClientRect();
    return { x: nr.left + nr.width / 2 - gr.left, y: nr.top + nr.height / 2 - gr.top };
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

    const rect = root.getBoundingClientRect();
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
        // Tilt: accumulate a slow rotation around X and drift Y so the
        // whole composition feels 3D without becoming seasick.
        if (tiltOn) {
            session.tiltAngle += dt * 12; // deg/sec
            const grid = session.overlay.querySelector('.pn-stage-grid');
            const rx = 18 * Math.sin(session.tiltAngle * Math.PI / 180 * 0.6);
            const ry = 22 * Math.cos(session.tiltAngle * Math.PI / 180 * 0.4);
            grid.style.transform =
                `perspective(1400px) rotateX(${rx}deg) rotateY(${ry}deg)`;
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

function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

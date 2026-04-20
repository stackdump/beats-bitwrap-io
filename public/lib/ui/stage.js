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

let session = null; // { overlay, panels, rafId, onKey, onResize }

export function toggleStage(el) {
    if (session) closeStage(el);
    else openStage(el);
}

export function openStage(el) {
    if (session) return;
    if (!el._project || !el._project.nets) return;

    const overlay = document.createElement('div');
    overlay.className = 'pn-stage-overlay';
    overlay.innerHTML = `
        <button class="pn-stage-close" title="Close (Esc)">&times;</button>
        <div class="pn-stage-grid"></div>
    `;
    el.appendChild(overlay);

    const grid = overlay.querySelector('.pn-stage-grid');
    const panels = [];

    for (const entry of buildPanels(el, grid)) panels.push(entry);

    session = { overlay, panels, rafId: 0, onKey: null, onResize: null };

    session.onKey = (e) => { if (e.key === 'Escape') closeStage(el); };
    document.addEventListener('keydown', session.onKey);

    session.onResize = () => { for (const p of panels) layoutPanel(p); };
    window.addEventListener('resize', session.onResize);

    overlay.querySelector('.pn-stage-close').addEventListener('click', () => closeStage(el));

    // Relayout once after the grid has actually sized (needs a paint).
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
    if (!node) return;
    node.classList.add('firing');
    setTimeout(() => node.classList.remove('firing'), 100);
}

// Mute-state reconcile — called when `mute-state` message arrives.
// Add/remove panels without disturbing ones that stayed.
export function stageOnMuteStateChange(el) {
    if (!session) return;
    const wanted = eligibleNetIds(el);
    const have = new Set(session.panels.map(p => p.netId));

    // Remove panels for tracks that got muted.
    for (const p of [...session.panels]) {
        if (!wanted.includes(p.netId)) {
            p.root.remove();
            session.panels = session.panels.filter(x => x !== p);
        }
    }

    // Add panels for tracks that became unmuted.
    const grid = session.overlay.querySelector('.pn-stage-grid');
    for (const id of wanted) {
        if (have.has(id)) continue;
        const entry = buildOnePanel(el, grid, id);
        if (entry) {
            session.panels.push(entry);
            requestAnimationFrame(() => layoutPanel(entry));
        }
    }
}

// --- internals ---

function eligibleNetIds(el) {
    const nets = el._project?.nets || {};
    const ids = [];
    for (const [id, net] of Object.entries(nets)) {
        if (!net || net.role === 'control') continue;
        if (el._mutedNets?.has(id) || el._manualMutedNets?.has(id)) continue;
        const placeCount = Object.keys(net.places || {}).length;
        const transCount = Object.keys(net.transitions || {}).length;
        if (placeCount === 0 || transCount === 0) continue;
        ids.push(id);
    }
    ids.sort((a, b) => {
        const ca = nets[a]?.track?.channel ?? 0;
        const cb = nets[b]?.track?.channel ?? 0;
        return ca - cb;
    });
    return ids;
}

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
        netId, root, canvas, ctx, stage, nodes,
        dpr: window.devicePixelRatio || 1,
        view: { scale: 1, tx: 0, ty: 0 },
        angle: 0,
        angleVelDps,
    };
    return entry;
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
    entry.stage.style.transform = `translate(${entry.view.tx}px, ${entry.view.ty}px) scale(${scale})`;
    entry.stage.style.transformOrigin = '0 0';
    drawPanel(entry);
}

function currentNet(entry) {
    // Resolve the net fresh each paint — project can be rebuilt between frames.
    const el = entry.root.closest('petri-note') || entry.root.getRootNode()?.host;
    return el?._project?.nets?.[entry.netId] || null;
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

    // Rotation: drift around the places centroid.
    let sx = 0, sy = 0, n = 0;
    for (const p of Object.values(net.places || {})) { sx += p.x; sy += p.y; n++; }
    if (n > 0) {
        const rx = sx / n, ry = sy / n;
        ctx.translate(rx, ry);
        ctx.rotate(entry.angle * Math.PI / 180);
        ctx.translate(-rx, -ry);
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
        for (const p of session.panels) {
            p.angle += p.angleVelDps * dt;
            if (p.angle > 360) p.angle -= 360;
            if (p.angle < -360) p.angle += 360;
            // Also apply rotation to the DOM stage so place/transition
            // nodes follow the arcs — keeps rings visually coherent.
            p.stage.style.transform =
                `translate(${p.view.tx}px, ${p.view.ty}px) scale(${p.view.scale}) rotate(${p.angle}deg)`;
            p.stage.style.transformOrigin = `${p.view.cx}px ${p.view.cy}px`;
            drawPanel(p);
        }
        session.rafId = requestAnimationFrame(tick);
    };
    session.rafId = requestAnimationFrame(tick);
}

function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Compose page entry point. Wires the static form in compose.html to:
//   1. /api/feed                 — populate the ingredient picker
//   2. CID computation            — same canonical JSON + base58 path
//                                   the studio uses when sealing shares
//   3. PUT /c/{cid}               — seal the composition (auto-enqueues
//                                   the worker via OnSeal)
//   4. /api/composition-status    — poll until masters land
//   5. <audio src=/audio-master/>  — inline player when ready
//
// State is held in a single `state.tracks` array. Each track is one
// `tracks[i]` entry on the wire — same shape the schema validates.
// Generative inserts (riser/drone/impact/texture/counterMelody) are
// added with sensible defaults that the user can edit inline.

import { computeCidForJsonLd, canonicalizeJSON } from '/lib/share/codec.js';

const state = {
    feed: [],     // [{cid, name, genre, ...}]
    tracks: [],   // [{kind, source, in, len, fadeIn, fadeOut, soloRoles?, mute?, transposeSemis?, tempoMatch?, gain?, id?}]
    sealedCid: null,
};

const $ = (id) => document.getElementById(id);
const fmtCid = (cid) => cid.slice(0, 14) + '…';

async function loadFeed() {
    try {
        const resp = await fetch('/api/feed?limit=200');
        const data = await resp.json();
        state.feed = data.filter(d => d.cid && d.cid.startsWith('z'));
        renderIngredients();
    } catch (err) {
        renderIngredients();
        console.error('feed load failed', err);
    }
}

function renderIngredients() {
    const host = $('ingredients');
    host.innerHTML = '';
    if (state.feed.length === 0) {
        host.innerHTML = '<p style="color:#666;font-size:12px">No shares in the local feed yet. Visit the studio to render some, then come back.</p>';
        return;
    }
    for (const item of state.feed) {
        const div = document.createElement('div');
        div.className = 'ing';
        const left = document.createElement('span');
        left.innerHTML = `<strong>${item.name || item.genre || '(untitled)'}</strong> <span class="cid">${fmtCid(item.cid)}</span>`;
        const btn = document.createElement('button');
        btn.textContent = '+ add';
        btn.onclick = () => addCidTrack(item);
        div.appendChild(left);
        div.appendChild(btn);
        host.appendChild(div);
    }
}

function addCidTrack(item) {
    state.tracks.push({
        kind: 'cid',
        cid: item.cid,
        name: item.name || item.genre || '',
        in: nextBarOffset(),
        len: 8,
        fadeIn: 1.0,
        fadeOut: 1.0,
        id: 'track' + (state.tracks.length + 1),
    });
    renderTracks();
}

function addInsertTrack(type) {
    const defaults = {
        riser:   {},
        drone:   { rootHz: 220 },
        impact:  { variant: 'sub-boom' },
        texture: { kind: 'vinyl-crackle' },
        counterMelody: { mode: 'answer', density: 0.5, register: 'above', of: pickFirstId() },
    }[type] || {};
    state.tracks.push({
        kind: 'gen',
        type,
        spec: { ...defaults },
        in: nextBarOffset(),
        len: 4,
        fadeIn: 0,
        fadeOut: 0,
    });
    renderTracks();
}

function pickFirstId() {
    const t = state.tracks.find(t => t.kind === 'cid' && t.id);
    return t ? t.id : '';
}

function nextBarOffset() {
    if (state.tracks.length === 0) return 0;
    return state.tracks.reduce((m, t) => Math.max(m, (t.in || 0) + (t.len || 0)), 0);
}

// renderBarGrid visualises the timeline as a horizontal grid of bars,
// one row per track. Clips span [in, in+len] in 24px-per-bar units.
// Read-only in PR-5.2; drag/drop interactivity is a later iteration.
function renderBarGrid() {
    const host = $('bar-grid');
    if (!host) return;
    host.innerHTML = '';
    if (state.tracks.length === 0) {
        host.innerHTML = '<div style="color:#666;padding:8px;font-size:12px">No tracks yet — pick an ingredient or add an insert above.</div>';
        return;
    }
    const totalBars = Math.max(16, ...state.tracks.map(t => (t.in || 0) + (t.len || 0)));
    const barPx = 24;
    // Header with bar numbers (every 4 bars labelled).
    const head = document.createElement('div');
    head.className = 'bar-grid-header';
    for (let i = 0; i < totalBars; i++) {
        const tick = document.createElement('div');
        tick.className = 'tick' + (i % 4 === 0 ? ' major' : '');
        tick.textContent = (i % 4 === 0) ? String(i) : '';
        head.appendChild(tick);
    }
    host.appendChild(head);
    state.tracks.forEach((t, i) => {
        const row = document.createElement('div');
        row.className = 'bar-row';
        row.style.width = (totalBars * barPx) + 'px';
        const clip = document.createElement('div');
        clip.className = 'clip ' + t.kind + (t.fadeIn > 0 ? ' fade-in' : '') + (t.fadeOut > 0 ? ' fade-out' : '');
        clip.style.left = ((t.in || 0) * barPx) + 'px';
        clip.style.width = ((t.len || 1) * barPx - 2) + 'px';
        clip.title = (t.kind === 'cid')
            ? `${t.name || ''}\nbars ${t.in}–${t.in + t.len} (len ${t.len})\n— drag body to move, drag right edge to resize, click body to focus form row`
            : `${t.type}\nbars ${t.in}–${t.in + t.len} (len ${t.len})\n— drag body to move, drag right edge to resize, click body to focus form row`;
        clip.textContent = (t.kind === 'cid')
            ? (t.name?.split('·').pop()?.trim() || t.cid.slice(0, 10))
            : '⚡ ' + t.type;
        // PR-5.3: drag clip body to change `in` (move); drag the
        // right-edge handle to change `len` (resize). Snap to bar
        // gridlines (24 px = 1 bar). Pointer events so a stray
        // touchstart doesn't escape and select text on iPad.
        const handle = document.createElement('div');
        handle.className = 'clip-resize';
        handle.title = 'Drag to resize length';
        handle.addEventListener('pointerdown', (e) => startDrag(e, i, 'resize'));
        clip.addEventListener('pointerdown', (e) => {
            // Distinguish click vs drag at pointerup.
            if (e.target === handle) return;
            startDrag(e, i, 'move');
        });
        clip.appendChild(handle);
        row.appendChild(clip);
        host.appendChild(row);
    });
}

const _dragState = { active: false, idx: -1, mode: '', startX: 0, origIn: 0, origLen: 0, moved: false };

function startDrag(e, idx, mode) {
    e.preventDefault();
    const t = state.tracks[idx];
    if (!t) return;
    _dragState.active = true;
    _dragState.idx = idx;
    _dragState.mode = mode;
    _dragState.startX = e.clientX;
    _dragState.origIn = t.in;
    _dragState.origLen = t.len;
    _dragState.moved = false;
    document.body.style.cursor = (mode === 'resize') ? 'ew-resize' : 'grabbing';
    e.target.setPointerCapture && e.target.setPointerCapture(e.pointerId);
    document.addEventListener('pointermove', onDragMove);
    document.addEventListener('pointerup', onDragEnd, { once: true });
}

function onDragMove(e) {
    if (!_dragState.active) return;
    const barPx = 24;
    const dx = e.clientX - _dragState.startX;
    const barDelta = Math.round(dx / barPx);
    if (barDelta === 0 && !_dragState.moved) return;
    _dragState.moved = true;
    const t = state.tracks[_dragState.idx];
    if (!t) return;
    if (_dragState.mode === 'resize') {
        t.len = Math.max(1, _dragState.origLen + barDelta);
    } else {
        t.in = Math.max(0, _dragState.origIn + barDelta);
    }
    renderBarGrid();
}

function onDragEnd() {
    document.removeEventListener('pointermove', onDragMove);
    document.body.style.cursor = '';
    if (_dragState.moved) {
        // Drag committed — re-render the form so the number inputs
        // reflect the new in/len. (renderBarGrid already updated the
        // visual during move.)
        renderTracks();
    } else {
        // Plain click: scroll the form row into focus, same as the
        // original onclick handler.
        const formRow = $('tracks').children[_dragState.idx];
        if (formRow) formRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    _dragState.active = false;
    _dragState.mode = '';
}

function renderTracks() {
    renderBarGrid();
    const host = $('tracks');
    host.innerHTML = '';
    state.tracks.forEach((t, i) => {
        const row = document.createElement('div');
        row.className = 'track-row';

        const idx = document.createElement('span');
        idx.style.color = '#666';
        idx.textContent = String(i + 1);

        const label = document.createElement('span');
        label.className = 'label';
        if (t.kind === 'cid') {
            label.textContent = (t.name || '') + ' · ' + fmtCid(t.cid);
            label.title = t.cid;
        } else {
            label.textContent = '⚡ ' + t.type;
            label.title = 'generative insert';
        }

        const idIn = document.createElement('input');
        idIn.value = t.id || '';
        idIn.placeholder = '(no id)';
        idIn.onchange = (e) => { t.id = e.target.value || undefined; renderTracks(); };

        const inB = mkNum(t.in, 0, 1024, 1, (v) => { t.in = v; renderBarGrid(); });
        const lenB = mkNum(t.len, 1, 1024, 1, (v) => { t.len = v; renderBarGrid(); });
        const fIn = mkNum(t.fadeIn, 0, 60, 0.5, (v) => { t.fadeIn = v; renderBarGrid(); });
        const fOut = mkNum(t.fadeOut, 0, 60, 0.5, (v) => { t.fadeOut = v; renderBarGrid(); });

        const ops = document.createElement('span');
        if (t.kind === 'cid') {
            const sel = document.createElement('select');
            sel.innerHTML = '<option value="">(plain)</option><option value="solo-drums">solo drums</option><option value="transpose-down">−2 semis</option><option value="stretch">tempoMatch</option>';
            sel.value = opsKey(t);
            sel.onchange = (e) => applyOps(t, e.target.value);
            ops.appendChild(sel);
        } else {
            const btn = document.createElement('button');
            btn.style.cssText = 'all:unset;cursor:pointer;color:#aaa;font-size:11px;padding:2px 6px;border:1px solid #2a2a2a;border-radius:3px;';
            btn.textContent = 'edit spec';
            btn.onclick = () => editInsertSpec(t);
            ops.appendChild(btn);
        }

        const del = document.createElement('button');
        del.className = 'del';
        del.textContent = '×';
        del.onclick = () => { state.tracks.splice(i, 1); renderTracks(); };

        row.append(idx, label, idIn, inB, lenB, fIn, fOut, ops, del);
        host.appendChild(row);
    });
}

function mkNum(value, min, max, step, onchange) {
    const el = document.createElement('input');
    el.type = 'number';
    el.min = min; el.max = max; el.step = step;
    el.value = value;
    el.onchange = (e) => onchange(parseFloat(e.target.value) || 0);
    return el;
}

function opsKey(t) {
    if (t.soloRoles?.includes('drums')) return 'solo-drums';
    if (t.transposeSemis === -2) return 'transpose-down';
    if (t.tempoMatch === 'stretch') return 'stretch';
    return '';
}

function applyOps(t, key) {
    delete t.soloRoles; delete t.transposeSemis; delete t.tempoMatch;
    switch (key) {
        case 'solo-drums':    t.soloRoles = ['drums']; break;
        case 'transpose-down': t.transposeSemis = -2; break;
        case 'stretch':       t.tempoMatch = 'stretch'; break;
    }
}

function editInsertSpec(t) {
    const cur = JSON.stringify(t.spec, null, 2);
    const next = prompt('Edit insert spec (JSON):', cur);
    if (next == null) return;
    try {
        t.spec = JSON.parse(next);
        renderTracks();
    } catch (err) {
        alert('Invalid JSON: ' + err.message);
    }
}

function buildEnvelope() {
    const env = {
        '@context': 'https://beats.bitwrap.io/schema/beats-composition.context.jsonld',
        '@type': 'BeatsComposition',
        v: 1,
    };
    const title = $('m-title').value.trim();
    if (title) env.title = title;
    const tempo = parseInt($('m-tempo').value, 10);
    if (tempo > 0) env.tempo = tempo;

    env.tracks = state.tracks.map((t) => {
        const out = {
            in: t.in | 0,
            len: t.len | 0,
        };
        if (t.id) out.id = t.id;
        if (t.fadeIn > 0) out.fadeIn = t.fadeIn;
        if (t.fadeOut > 0) out.fadeOut = t.fadeOut;
        if (t.kind === 'cid') {
            out.source = { cid: t.cid };
            if (t.soloRoles?.length) out.soloRoles = t.soloRoles;
            if (t.mute?.length) out.mute = t.mute;
            if (t.transposeSemis) out.transposeSemis = t.transposeSemis;
            if (t.tempoMatch) out.tempoMatch = t.tempoMatch;
            if (t.gain) out.gain = t.gain;
        } else {
            out.source = { generate: { type: t.type, ...t.spec } };
        }
        return out;
    });

    const lufs = parseFloat($('m-lufs').value);
    const preset = $('m-preset').value;
    const formats = $('m-formats').value.split(',').map(s => s.trim()).filter(Boolean);
    const master = {};
    if (!Number.isNaN(lufs)) master.lufs = lufs;
    if (preset) master.preset = preset;
    if (formats.length > 0) master.format = formats;
    if (Object.keys(master).length > 0) env.master = master;

    return env;
}

async function previewEnvelope() {
    const env = buildEnvelope();
    if (!env.tracks || env.tracks.length === 0) {
        showStatus('error', 'No tracks yet — pick an ingredient or add an insert.');
        return;
    }
    const cid = await computeCidForJsonLd(env);
    const pre = $('envelope-preview');
    pre.style.display = 'block';
    pre.textContent = 'CID: ' + cid + '\n\n' + JSON.stringify(env, null, 2);
    showStatus('info', 'CID computed — click Seal + Render when ready.');
    return cid;
}

async function sealAndRender() {
    const env = buildEnvelope();
    if (!env.tracks || env.tracks.length === 0) {
        showStatus('error', 'No tracks yet.');
        return;
    }
    const canonical = canonicalizeJSON(env);
    const cid = await computeCidForJsonLd(env);
    showStatus('info', `Sealing ${cid}…`);
    const resp = await fetch('/c/' + cid, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/ld+json' },
        body: canonical,
    });
    if (!resp.ok) {
        const txt = await resp.text();
        showStatus('error', `seal failed: HTTP ${resp.status} — ${txt}`);
        return;
    }
    state.sealedCid = cid;
    showStatus('info', `Sealed ${cid}. Worker is rendering — polling…`);
    pollStatus(cid);
}

async function pollStatus(cid) {
    const expectFmts = $('m-formats').value.split(',').map(s => s.trim()).filter(Boolean);
    let attempt = 0;
    while (attempt++ < 600) { // 600 × 2s = 20 min cap
        try {
            const resp = await fetch('/api/composition-status/' + cid);
            const st = await resp.json();
            const have = (st.formats || []).length;
            if (have >= expectFmts.length) {
                showStatus('success', `Master ready (${have}/${expectFmts.length} formats). Click Listen.`);
                $('btn-listen').disabled = false;
                return;
            }
            const queued = st.queued ? ' (queued)' : '';
            showStatus('info', `rendering: ${have}/${expectFmts.length} formats ready${queued}…`);
        } catch (err) {
            console.warn('status poll', err);
        }
        await sleep(2000);
    }
    showStatus('error', 'render timeout (20 min). Check server logs.');
}

function listen() {
    if (!state.sealedCid) return;
    const player = $('player');
    player.src = '/audio-master/' + state.sealedCid + '.webm';
    player.style.display = 'block';
    player.play().catch(() => {/* user gesture required on some browsers */});
}

function showStatus(kind, msg) {
    const el = $('status');
    el.className = 'status ' + kind;
    el.textContent = msg;
    el.style.display = 'block';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// preloadFromUrl: if /compose.html was opened with ?seed={cid},
// fetch that share's metadata from /api/feed and pre-populate the
// timeline with it as the first track. Lets the "→ Compose" button
// on feed cards open this page already partway through authoring.
async function preloadFromUrl() {
    const params = new URLSearchParams(location.search);
    const seed = params.get('seed');
    if (!seed || !seed.startsWith('z')) return;
    // Wait until the feed has loaded so we can find the share's
    // canonical name.
    await loadFeed();
    const item = state.feed.find((d) => d.cid === seed)
        || { cid: seed, name: '', genre: '' };
    addCidTrack(item);
}

// Wire up.
$('add-insert').onclick = () => {
    const type = $('add-insert-type').value;
    if (!type) return;
    addInsertTrack(type);
    $('add-insert-type').value = '';
};
$('btn-preview').onclick = previewEnvelope;
$('btn-seal').onclick = sealAndRender;
$('btn-listen').onclick = listen;

// preloadFromUrl handles ?seed=… pre-population AND calls loadFeed
// internally; if there's no seed, fall back to a plain feed load.
if (location.search.includes('seed=')) {
    preloadFromUrl();
} else {
    loadFeed();
}

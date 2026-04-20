// Canvas + DOM-stage rendering for the Petri net diagram. Builds the
// place/transition DOM nodes into el._stage, draws arcs + arrowheads
// on the canvas, and handles the Auto-DJ ring rotation.
//
// Extracted from petri-note.js (Phase A.6). Read-only diagram —
// pointer handlers stay on the class as stubs since they're empty.

import { noteToName } from '../audio/note-name.js';

export function renderNet(el) {
    const net = el._getActiveNet();
    if (!net) return;

    // Clear stage.
    el._stage.innerHTML = '';
    el._nodes = {};

    // Render places.
    for (const [id, place] of Object.entries(net.places)) {
        createPlaceElement(el, id, place);
    }

    // Render transitions.
    for (const [id, trans] of Object.entries(net.transitions)) {
        createTransitionElement(el, id, trans);
    }

    centerNet(el);
    draw(el);
}

export function centerNet(el) {
    const net = el._getActiveNet();
    if (!net || !el._canvas) return;

    // Compute bounding box of all nodes.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const place of Object.values(net.places)) {
        minX = Math.min(minX, place.x);
        minY = Math.min(minY, place.y);
        maxX = Math.max(maxX, place.x);
        maxY = Math.max(maxY, place.y);
    }
    for (const trans of Object.values(net.transitions)) {
        minX = Math.min(minX, trans.x);
        minY = Math.min(minY, trans.y);
        maxX = Math.max(maxX, trans.x);
        maxY = Math.max(maxY, trans.y);
    }
    if (!isFinite(minX)) return;

    const pad = 60;
    const netW = maxX - minX + pad * 2;
    const netH = maxY - minY + pad * 2;
    const vpW = el._canvas.width / el._dpr;
    const vpH = el._canvas.height / el._dpr;

    // Scale to fit, capped at 1x (don't upscale small nets).
    const scale = Math.min(1, vpW / netW, vpH / netH);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const tx = vpW / 2 - cx * scale;
    const ty = vpH / 2 - cy * scale;

    el._view = { scale, tx, ty };

    // Apply transform to stage (DOM nodes).
    el._stage.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    el._stage.style.transformOrigin = '0 0';
}

export function createPlaceElement(el, id, place) {
    const node = document.createElement('div');
    node.className = 'pn-node pn-place';
    node.dataset.id = id;
    node.dataset.type = 'place';
    node.style.left = `${place.x - 30}px`;
    node.style.top = `${place.y - 30}px`;

    const label = place.label && !/^(p|deg)\d+/.test(place.label) ? place.label : '';
    node.innerHTML = `
        <div class="pn-place-circle"></div>
        ${label ? `<div class="pn-label">${label}</div>` : ''}
    `;

    el._stage.appendChild(node);
    el._nodes[id] = node;
}

export function createTransitionElement(el, id, trans) {
    const node = document.createElement('div');
    node.className = 'pn-node pn-transition';
    if (trans.midi) node.classList.add('has-midi');
    node.dataset.id = id;
    node.dataset.type = 'transition';
    node.style.left = `${trans.x - 25}px`;
    node.style.top = `${trans.y - 25}px`;

    const tLabel = trans.label && !/^t\d+/.test(trans.label) ? trans.label : '';
    const isControl = !!trans.control && !trans.midi;
    let badge = '';
    if (trans.midi) {
        badge = `<div class="pn-midi-badge" title="Click to edit note (${trans.midi.note})">${noteToName(trans.midi.note)}</div>`;
    } else if (!isControl) {
        badge = `<div class="pn-midi-badge pn-midi-badge--empty" title="Click to add MIDI note">+</div>`;
    }
    node.innerHTML = `
        <div class="pn-transition-rect"></div>
        ${badge}
        ${tLabel ? `<div class="pn-label">${tLabel}</div>` : ''}
    `;

    const badgeEl = node.querySelector('.pn-midi-badge');
    if (badgeEl) {
        badgeEl.addEventListener('click', (e) => {
            e.stopPropagation();
            el._openMidiEditor(id);
        });
    }

    el._stage.appendChild(node);
    el._nodes[id] = node;
}

// Single canvas-paint pipeline. Called by both the viz rAF loop (during
// playback) and one-shot static paints (e.g. resize, initial render,
// Auto-DJ spin when viz is idle). Layers:
//   1. clear
//   2. timeline rolling dots  — only when viz loop is active
//   3. ring layer (arcs + arrowheads + optional weight labels), with
//      the Auto-DJ rotation applied around the ring centroid
export function renderFrame(el) {
    const ctx = el._ctx;
    if (!ctx) return;
    const w = el._canvas.width / el._dpr;
    const h = el._canvas.height / el._dpr;
    ctx.clearRect(0, 0, w, h);

    const playing = !!el._vizRafId;
    if (playing) el._vizDrawTimeline(ctx, w, h);
    drawRing(el, ctx, playing);
}

export function drawRing(el, ctx, playing) {
    const net = el._getActiveNet();
    if (!net) return;

    ctx.save();
    ctx.translate(el._view.tx, el._view.ty);
    ctx.scale(el._view.scale, el._view.scale);

    // Auto-DJ spin: rotate arcs + arrowheads around the ring centroid.
    // DOM place/transition nodes in el._stage stay put — only the
    // canvas arc layer rotates under them.
    const spin = el._autoDjAngleDeg || 0;
    if (spin !== 0) {
        let sx = 0, sy = 0, n = 0;
        for (const p of Object.values(net.places || {})) { sx += p.x; sy += p.y; n++; }
        if (n > 0) {
            const cx = sx / n, cy = sy / n;
            ctx.translate(cx, cy);
            ctx.rotate(spin * Math.PI / 180);
            ctx.translate(-cx, -cy);
        }
    }

    // Dim the ring during playback so the rolling timeline reads as
    // primary; full-strength in the static/editor view.
    ctx.globalAlpha = playing ? 0.3 : 1;
    ctx.strokeStyle = '#4a90d9';
    ctx.lineWidth = (playing ? 1 : 2) / el._view.scale;

    const reverseArrows = !!el._autoDjReverse;
    for (const arc of net.arcs) {
        const srcNode = net.places[arc.source] || net.transitions[arc.source];
        const trgNode = net.places[arc.target] || net.transitions[arc.target];
        if (!srcNode || !trgNode) continue;

        ctx.beginPath();
        ctx.moveTo(srcNode.x, srcNode.y);
        ctx.lineTo(trgNode.x, trgNode.y);
        ctx.stroke();

        if (reverseArrows) {
            drawArrowhead(ctx, trgNode.x, trgNode.y, srcNode.x, srcNode.y);
        } else {
            drawArrowhead(ctx, srcNode.x, srcNode.y, trgNode.x, trgNode.y);
        }

        // Weight labels only in static view — they clutter the dimmed
        // playback ring and rarely carry info during performance.
        if (!playing) {
            const weight = arc.weight[0];
            if (weight > 1) {
                const mx = (srcNode.x + trgNode.x) / 2;
                const my = (srcNode.y + trgNode.y) / 2;
                ctx.fillStyle = '#1a1a2e';
                ctx.beginPath();
                ctx.arc(mx, my, 12, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#4a90d9';
                ctx.font = '12px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(weight.toString(), mx, my);
            }
        }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
}

// Back-compat entry used by non-rAF callers (resize, one-shot paints,
// editor interactions). Delegates to the unified pipeline.
export function draw(el) { renderFrame(el); }

export function drawArrowhead(ctx, x1, y1, x2, y2) {
    const headLen = 12;
    const angle = Math.atan2(y2 - y1, x2 - x1);

    // Offset to edge of target node.
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

// Convert viewport coordinates to model coordinates.
export function viewToModel(el, vx, vy) {
    return {
        x: (vx - el._view.tx) / el._view.scale,
        y: (vy - el._view.ty) / el._view.scale,
    };
}

// --- Timeline / playhead / loop markers ---

export function renderTimeline(el) {
    if (!el._timelineEl || !el._structure) return;
    const sections = el._structure;
    const totalSteps = sections.reduce((s, sec) => s + sec.steps, 0);

    el._timelineEl.innerHTML = '';

    const sectionColors = {
        intro: '#4a90d9', verse: '#2ecc71', chorus: '#e94560',
        bridge: '#9b59b6', outro: '#f5a623',
    };

    let stepOffset = 0;
    for (const sec of sections) {
        const pct = (sec.steps / totalSteps) * 100;
        const color = sectionColors[sec.name] || '#888';
        const block = document.createElement('div');
        block.className = 'pn-timeline-section';
        block.style.width = `${pct}%`;
        block.style.background = color;
        block.dataset.start = stepOffset;
        block.dataset.end = stepOffset + sec.steps;

        const phrases = sec.phrases;
        if (phrases) {
            const phraseLists = Object.values(phrases);
            const phraseCount = phraseLists.length > 0 ? Math.max(...phraseLists.map(p => p.length)) : 1;

            if (phraseCount > 1) {
                const firstRole = Object.keys(phrases)[0];
                const pattern = phrases[firstRole] || ['A'];

                block.innerHTML = `<span>${sec.name}</span><span class="pn-timeline-phrases">${pattern.join('')}</span>`;

                for (let pi = 1; pi < phraseCount; pi++) {
                    const divider = document.createElement('div');
                    divider.className = 'pn-timeline-phrase-divider';
                    divider.style.left = `${(pi / phraseCount) * 100}%`;
                    block.appendChild(divider);
                }
            } else {
                block.innerHTML = `<span>${sec.name}</span>`;
            }
        } else {
            block.innerHTML = `<span>${sec.name}</span>`;
        }

        el._timelineEl.appendChild(block);
        stepOffset += sec.steps;
    }

    const loopRegion = document.createElement('div');
    loopRegion.className = 'pn-loop-region';
    el._timelineEl.appendChild(loopRegion);
    el._loopRegionEl = loopRegion;

    const loopStartEl = document.createElement('div');
    loopStartEl.className = 'pn-loop-marker pn-loop-start';
    el._timelineEl.appendChild(loopStartEl);
    el._loopStartEl = loopStartEl;

    const loopEndEl = document.createElement('div');
    loopEndEl.className = 'pn-loop-marker pn-loop-end';
    el._timelineEl.appendChild(loopEndEl);
    el._loopEndEl = loopEndEl;

    el._cropBtnEl = el.querySelector('.pn-crop-bar-btn');

    const playhead = document.createElement('div');
    playhead.className = 'pn-timeline-playhead';
    el._timelineEl.appendChild(playhead);
    el._playheadEl = playhead;

    el._totalSteps = totalSteps;
    el._loopStart = 0;
    el._loopEnd = totalSteps;
    updateLoopMarkers(el);
}

export function updatePlayhead(el) {
    if (!el._playheadEl || !el._structure || !el._totalSteps) return;

    // Interpolate between server ticks for smooth movement.
    let tickEstimate = el._tick;
    if (el._playing && el._tickTimestamp > 0) {
        const elapsed = performance.now() - el._tickTimestamp;
        const tickMs = 60000 / (el._tempo * 4);
        // Cap interpolation to 6 ticks to avoid overshoot.
        const interpolated = Math.min(elapsed / tickMs, 6);
        tickEstimate = el._tick + interpolated;
    }

    const pct = Math.min(100, (tickEstimate / el._totalSteps) * 100);
    // Only move forward (prevent jitter) unless looping.
    if (!el._lastPlayheadPct || pct >= el._lastPlayheadPct || pct < 1 || el._loopStart >= 0) {
        el._lastPlayheadPct = pct;
        el._playheadEl.style.left = `${pct}%`;
    }
}

export function updateLoopMarkers(el) {
    if (!el._loopStartEl || !el._totalSteps) return;
    el._loopStartEl.style.left = `${(el._loopStart / el._totalSteps) * 100}%`;
    el._loopEndEl.style.left = `${(el._loopEnd / el._totalSteps) * 100}%`;
    const isFullRange = el._loopStart === 0 && el._loopEnd === el._totalSteps;
    if (!isFullRange && el._loopRegionEl) {
        const left = (el._loopStart / el._totalSteps) * 100;
        const width = ((el._loopEnd - el._loopStart) / el._totalSteps) * 100;
        el._loopRegionEl.style.left = `${left}%`;
        el._loopRegionEl.style.width = `${width}%`;
        el._loopRegionEl.style.display = '';
    } else if (el._loopRegionEl) {
        el._loopRegionEl.style.display = 'none';
    }
    if (el._cropBtnEl) {
        el._cropBtnEl.style.display = isFullRange ? 'none' : '';
    }
}

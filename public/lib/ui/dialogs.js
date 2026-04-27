// MIDI-binding editor, transition fire (manual), quickstart + help modals.
// All three are self-contained overlay builders — consume element state
// but don't mutate anything besides a couple of history/project calls
// at Save time.

import { noteToName, nameToNote } from '../audio/note-name.js';
import { renderCurrentCard } from '../share/card.js';
import { openAiPromptModal } from './ai-prompt.js';
import { listHistory, clearHistory } from '../share/history.js';
import { renderToBlob, downloadBlob, uploadBlob, isClientRenderSupported } from '../share/client-render.js';

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
export function showWelcomeCard(el, force = false) {
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
    // as before: one-shot, gated by pn-welcome-seen. The footer's
    // "card" link passes force=true so users can re-open the card
    // without having to dig through the share modal.
    // Mobile / narrow-touch devices: the synth view's mixer + macros
    // panel doesn't shrink gracefully. Re-aim the welcome card's CTA
    // at /feed (the playlist player) so phone visitors land on the
    // surface that actually fits their screen. Desktop unchanged.
    const isTouch = ('ontouchstart' in window)
        || (navigator.maxTouchPoints > 0)
        || !!navigator.userAgentData?.mobile;
    const isNarrow = window.innerWidth < 820;
    const isMobile = isTouch && isNarrow;
    // Visibility gating differs by surface:
    //   - Mobile: per-session dismissal (sessionStorage). A return
    //     visit in a fresh tab re-prompts because the editor still
    //     won't fit. Always shows even if the desktop "seen" flag
    //     is set — they're on a different device class now.
    //   - Desktop: one-shot localStorage as before, plus title-bearing
    //     share links always re-show (the title is the whole point).
    if (!force) {
        if (isMobile) {
            if (sessionStorage.getItem('pn-welcome-mobile-seen')) return;
        } else if (!urlTitle && localStorage.getItem('pn-welcome-seen')) {
            return;
        }
    }
    el.querySelector('.pn-welcome-overlay')?.remove();
    const svg = renderCurrentCard(el, urlTitle);
    const primaryLabel  = isMobile ? 'Open in player' : 'Start playing';
    const secondaryLabel = isMobile ? 'Stay on this page' : 'Open full guide';
    const mobileNote = isMobile
        ? `<p style="margin:0 0 12px;font-size:12px;line-height:1.5;color:#fbbf24">
              Phone detected — the player surface fits small screens better.
              The full studio is built for desktop.
           </p>`
        : '';
    const overlay = document.createElement('div');
    overlay.className = 'pn-help-overlay pn-welcome-overlay';
    overlay.innerHTML = `
        <div class="pn-welcome-modal" style="max-width:760px;width:92%;background:#0d0d0d;border:1px solid #222;border-radius:12px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.6)">
            <div class="pn-welcome-card" style="display:block;line-height:0;cursor:pointer" title="Click to start">${svg}</div>
            <div style="padding:18px 22px;color:#ccc;font-family:system-ui,sans-serif">
                ${mobileNote}
                <p style="margin:0 0 12px;font-size:14px;line-height:1.55">
                    Deterministic beat generator. Each card is a fingerprint: genre + seed + tempo reproduce the exact track.
                    Share any mix and the card you see here travels with the link.
                </p>
                <div style="display:flex;gap:10px">
                    <button class="pn-welcome-start" style="flex:1;padding:10px;background:#e94560;border:none;color:#fff;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600">${primaryLabel}</button>
                    <button class="pn-welcome-guide" style="flex:1;padding:10px;background:#1a1a2e;border:1px solid #0f3460;color:#eee;border-radius:6px;cursor:pointer;font-size:14px">${secondaryLabel}</button>
                </div>
                <p class="pn-welcome-license" style="margin:14px 0 0;font-size:11px;color:#777;letter-spacing:0.04em">
                    Tracks are licensed
                    <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener" style="color:#9ad;text-decoration:none">CC BY 4.0</a>
                    — reuse with attribution to beats.bitwrap.io.
                </p>
            </div>
        </div>
    `;
    const dismiss = () => {
        if (isMobile) {
            // Don't burn the desktop one-shot flag from a phone — a
            // user on a tablet today, on their laptop tomorrow, still
            // deserves the desktop welcome card.
            try { sessionStorage.setItem('pn-welcome-mobile-seen', '1'); } catch {}
        } else {
            localStorage.setItem('pn-welcome-seen', '1');
            localStorage.setItem('pn-quickstart-seen', '1');
        }
        overlay.remove();
    };
    // Mobile: clicking primary "Open in player" appends current CID
    // to the playlist (so the phone listener lands on their track,
    // not just a generic feed) and navigates to /feed. The card
    // tile and overlay click also dismiss into the player so any
    // "click anywhere to continue" instinct sends them to the
    // surface that works.
    const goToPlayer = () => {
        const cid = new URLSearchParams(location.search).get('cid');
        if (cid) {
            try {
                const list = JSON.parse(localStorage.getItem('pn-playlist') || '[]');
                if (Array.isArray(list) && !list.some(p => p.cid === cid)) {
                    list.push({
                        cid,
                        name:  el?._project?.name  || '',
                        genre: el?._project?.genre || '',
                        tempo: el?._project?.tempo || 0,
                        seed:  el?._currentGen?.params?.seed || 0,
                    });
                    localStorage.setItem('pn-playlist', JSON.stringify(list));
                    localStorage.setItem('pn-playlist-open', '1');
                }
            } catch {}
        }
        dismiss();
        // Carry the CID so the feed surfaces the same card as a
        // confirmation modal on arrival.
        location.href = cid ? `/feed?cid=${encodeURIComponent(cid)}` : '/feed';
    };
    overlay.addEventListener('click', (e) => {
        // Audio block interactions don't dismiss.
        if (e.target.closest('.pn-welcome-audio')) return;
        if (e.target.closest('.pn-welcome-guide')) {
            dismiss();
            if (!isMobile) showHelpModal(el);
            return;
        }
        if (e.target.closest('.pn-welcome-start')) {
            if (isMobile) goToPlayer();
            else dismiss();
            return;
        }
        // Backdrop / card-art click: on mobile, route to player
        // (the user came for the track, not the editor); on desktop,
        // dismiss into the synth as before.
        if (e.target === overlay || e.target.closest('.pn-welcome-card')) {
            if (isMobile) goToPlayer();
            else dismiss();
        }
    });
    document.body.appendChild(overlay);
    // Auto-restore notice: parseShareFromUrl already pulled this CID
    // back from a snapshot. Inform the user — non-blocking, just so
    // they know the link wasn't actually broken and where their copy
    // came from.
    if (el._restoredFromSnapshot) {
        attachRestoredBlock(overlay, el._restoredFromSnapshot);
        el._restoredFromSnapshot = null;
    }
    // Recovery prompt fallback: archive lookup said the CID is in a
    // snapshot but auto-restore didn't land. Offer the manual one-click
    // path so the user can retry / debug.
    if (el._missingArchivedCid) {
        attachRecoveryBlock(overlay, el._missingArchivedCid);
        el._missingArchivedCid = null;
    }
    // If the share has a CID and the server has a pre-rendered .webm
    // cached, surface Play + Download. HEAD probes the audio handler
    // cache-only (never triggers a render). Auto-enqueue on the seal
    // path means in practice the file is usually warm by the time a
    // recipient opens the link.
    const cid = (new URLSearchParams(location.search).get('cid') || '')
        .replace(/[^a-zA-Z0-9]/g, '');
    if (cid) {
        const audioUrl = `${location.origin}/audio/${cid}.webm`;
        const fname = (urlTitle || `beats-${cid.slice(0, 12)}`)
            .replace(/[^\w\-. ]+/g, '_').slice(0, 60) + '.webm';
        const slot = overlay.querySelector('.pn-welcome-modal > div:last-child');
        fetch(audioUrl, { method: 'HEAD' }).then(r => {
            if (r.ok) {
                // Server has a cached render — surface play + download.
                const block = document.createElement('div');
                block.className = 'pn-welcome-audio';
                block.style.cssText = 'margin-top:14px;padding-top:14px;border-top:1px solid #1f1f1f';
                block.innerHTML = `
                    <div style="font-size:11px;color:#777;margin-bottom:8px;letter-spacing:0.08em;text-transform:uppercase">Pre-rendered audio</div>
                    <audio controls preload="none" src="${audioUrl}" style="width:100%;height:36px"></audio>
                    <a href="${audioUrl}" download="${fname}" style="display:inline-block;margin-top:8px;font-size:13px;color:#9ad;text-decoration:none">⬇ Download .webm</a>
                `;
                // Stop the Tone.js engine if the user starts the
                // pre-rendered audio — same track played twice over
                // each other otherwise.
                block.querySelector('audio').addEventListener('play', () => {
                    if (el._playing) el._togglePlay();
                });
                slot?.appendChild(block);
            } else if (isClientRenderSupported()) {
                // No server-side render available (queue saturated, just
                // sealed, or this build has -audio-render off). Offer to
                // render locally — same MediaRecorder pipeline the
                // headless renderer uses, just running in the user's
                // tab. Wall-clock = track duration, requires the tab to
                // stay foreground.
                attachClientRenderBlock(slot, el, fname, cid);
            }
        }).catch(() => {
            if (isClientRenderSupported()) attachClientRenderBlock(slot, el, fname, cid);
        });
    }
}

// Persistent ?cid handoff pill — surfaces the paired .webm recording
// after the welcome card is dismissed, so a returning visitor still
// sees that the *frozen* recording is one click away. The studio plays
// the live regenerator; the pill plays the cached capture. Different
// listening experiences under the same CID — the pill makes the
// duality visible instead of hiding it behind the Share modal.
//
// Survives welcome-card dismissal. Per-CID dismiss via sessionStorage
// (so reload re-shows it but a manual × hides it for the session).
export function attachCidHandoffPill(el) {
    const cid = (new URLSearchParams(location.search).get('cid') || '')
        .replace(/[^a-zA-Z0-9]/g, '');
    if (!cid) return;
    const dismissKey = `pn-handoff-dismissed-${cid}`;
    try { if (sessionStorage.getItem(dismissKey)) return; } catch {}
    if (document.querySelector('.pn-cid-handoff')) return; // idempotent
    const audioUrl = `${location.origin}/audio/${cid}.webm`;
    fetch(audioUrl, { method: 'HEAD' }).then(r => {
        if (!r.ok) return;
        const pill = document.createElement('div');
        pill.className = 'pn-cid-handoff';
        pill.style.cssText = [
            'position:fixed', 'top:14px', 'right:14px', 'z-index:9000',
            'background:#0d0d0d', 'border:1px solid #2a2a2a',
            'border-radius:24px', 'padding:6px 10px 6px 14px',
            'display:flex', 'align-items:center', 'gap:8px',
            'font:12px system-ui,-apple-system,"Segoe UI",sans-serif',
            'color:#ddd', 'box-shadow:0 4px 14px rgba(0,0,0,0.45)',
            'max-width:calc(100vw - 28px)',
        ].join(';');
        pill.innerHTML = `
            <span style="color:#fbbf24;font-size:13px">♫</span>
            <span class="pn-cid-handoff-label" style="color:#ccc">Original recording</span>
            <button class="pn-cid-handoff-play" title="Play the frozen recording (pauses live)"
                    style="background:#1a1a2e;border:1px solid #0f3460;color:#9ad;border-radius:14px;padding:3px 10px;font-size:12px;cursor:pointer">▶</button>
            <a class="pn-cid-handoff-feed" href="/feed" title="Open the public feed"
                    style="color:#9ad;text-decoration:none;font-size:12px;padding:3px 8px">feed →</a>
            <button class="pn-cid-handoff-dismiss" title="Dismiss for this session"
                    style="background:transparent;border:none;color:#666;cursor:pointer;font-size:14px;padding:0 4px;line-height:1">×</button>
        `;
        document.body.appendChild(pill);

        const playBtn = pill.querySelector('.pn-cid-handoff-play');
        const label = pill.querySelector('.pn-cid-handoff-label');
        let audio = null;

        playBtn.addEventListener('click', () => {
            if (!audio) {
                // First click: pause live engine, mount inline player,
                // start playback. Same audio element used for pause /
                // resume on subsequent clicks.
                if (el._playing) el._togglePlay?.();
                audio = document.createElement('audio');
                audio.src = audioUrl;
                audio.preload = 'auto';
                audio.controls = false;
                document.body.appendChild(audio);
                audio.addEventListener('ended', () => {
                    playBtn.textContent = '▶';
                    label.textContent = 'Original recording';
                });
                audio.addEventListener('pause', () => {
                    if (!audio.ended) playBtn.textContent = '▶';
                });
                audio.addEventListener('play', () => {
                    playBtn.textContent = '❚❚';
                    label.textContent = 'Playing recording';
                    if (el._playing) el._togglePlay?.();
                });
            }
            if (audio.paused) audio.play().catch(() => {});
            else audio.pause();
        });

        pill.querySelector('.pn-cid-handoff-dismiss').addEventListener('click', () => {
            try { sessionStorage.setItem(dismissKey, '1'); } catch {}
            if (audio) { audio.pause(); audio.remove(); }
            pill.remove();
        });

        // If the user starts the live engine while the recording is
        // playing, stop the recording (avoid double-playback). The
        // welcome-card audio block has the same coupling; this mirrors it.
        const liveStartHook = () => {
            if (audio && !audio.paused) audio.pause();
        };
        el.addEventListener?.('pn-play', liveStartHook);
    }).catch(() => {});
}

// "Restored from snapshot X" — informational. The auto-restore path
// has already re-sealed the envelope into the live store, so the rest
// of the boot is identical to a normal share. Surface enough detail
// (snapshot filename) that the user knows where their copy came from.
function attachRestoredBlock(overlay, source) {
    const slot = overlay.querySelector('.pn-welcome-modal > div:last-child');
    if (!slot) return;
    const block = document.createElement('div');
    block.style.cssText = 'margin-top:14px;padding:10px 12px;background:#0a1a0a;border:1px solid #1a4a1a;border-radius:6px;font-size:12px;color:#9ad';
    block.innerHTML = `
        <span style="color:#4ade80">✓</span>
        Restored from archived snapshot
        <code style="color:#bbb;background:#000;padding:1px 6px;border-radius:3px;font-size:11px">${source}</code>
        — share is live again.
    `;
    slot.appendChild(block);
}

// Surface a "this share has been archived — recover it?" banner inside
// the welcome card when the live share store no longer has the CID but
// at least one persisted snapshot does. One-click restore PUTs the
// envelope from the snapshot back into the live store and reloads.
function attachRecoveryBlock(overlay, info) {
    const slot = overlay.querySelector('.pn-welcome-modal > div:last-child');
    if (!slot) return;
    const { cid, snapshots } = info;
    const newest = snapshots[0] || {};
    const label = newest.label ? ` · <span style="color:#9ad">${newest.label}</span>` : '';
    const created = newest.createdAt
        ? new Date(newest.createdAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
        : '';
    const block = document.createElement('div');
    block.className = 'pn-welcome-recover';
    block.style.cssText = 'margin-top:14px;padding:12px 14px;background:#2a1a0a;border:1px solid #5a3a1a;border-radius:6px';
    block.innerHTML = `
        <div style="font-size:11px;color:#fbbf24;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:6px">Archived share</div>
        <div style="font-size:13px;color:#ddd;line-height:1.5">
            This track is no longer in the live store, but it was preserved in
            <strong>${snapshots.length}</strong> snapshot${snapshots.length === 1 ? '' : 's'}.
            <span style="color:#888">${created}${label}</span>
        </div>
        <div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <button class="pn-recover-btn" style="padding:6px 14px;background:#1a1a2e;border:1px solid #0f3460;color:#eee;border-radius:4px;cursor:pointer;font-size:13px">Recover from snapshot</button>
            <span class="pn-recover-status" style="font-size:11px;color:#888"></span>
        </div>
    `;
    const btn = block.querySelector('.pn-recover-btn');
    const status = block.querySelector('.pn-recover-status');
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.style.opacity = '0.5';
        status.textContent = 'restoring…';
        try {
            const r = await fetch(`/api/archive-restore?cid=${encodeURIComponent(cid)}`, { method: 'POST' });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const j = await r.json();
            if (!j.restored && !j.live) throw new Error('not restored');
            status.textContent = '✓ restored — reloading';
            setTimeout(() => location.reload(), 600);
        } catch (err) {
            status.style.color = '#e94560';
            status.textContent = `failed: ${err.message || err}`;
            btn.disabled = false;
            btn.style.opacity = '1';
        }
    });
    slot.appendChild(block);
}

// Builds the "Render in this tab" block surfaced by the welcome modal
// when the server doesn't have a pre-rendered .webm cached. Click →
// disable button + show progress → run the in-tab render → trigger a
// download. Wall-clock cost = track duration; the tab must stay in
// the foreground (Chromium throttles backgrounded timers, same issue
// we hit on the server before adding the audio-grid scheduler).
function attachClientRenderBlock(slot, el, fname, cid) { // cid optional — enables background upload when provided
    if (!slot) return;
    const block = document.createElement('div');
    block.className = 'pn-welcome-audio pn-client-render';
    block.style.cssText = 'margin-top:14px;padding-top:14px;border-top:1px solid #1f1f1f';
    block.innerHTML = `
        <div style="font-size:11px;color:#777;margin-bottom:8px;letter-spacing:0.08em;text-transform:uppercase">Render audio</div>
        <button class="pn-client-render-btn" style="background:#222;border:1px solid #333;color:#9ad;padding:8px 14px;border-radius:4px;cursor:pointer;font-size:13px">⬇ Render &amp; download in this tab</button>
        <div style="font-size:11px;color:#666;margin-top:6px">Records the playback in real time. Keep this tab visible until it finishes.</div>
        <div class="pn-client-render-status" style="font-size:12px;color:#9ad;margin-top:8px;display:none"></div>
    `;
    const btn    = block.querySelector('.pn-client-render-btn');
    const status = block.querySelector('.pn-client-render-status');
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.style.opacity = '0.5';
        btn.style.cursor = 'default';
        status.style.display = 'block';
        status.textContent = 'preparing…';
        try {
            const { blob } = await renderToBlob(el, {
                onProgress(ms, totalMs) {
                    const pct = Math.floor(100 * ms / totalMs);
                    status.textContent = `rendering ${fmtSec(ms)} / ${fmtSec(totalMs)} (${pct}%)`;
                },
            });
            status.textContent = `done — ${(blob.size / 1024).toFixed(0)} KB`;
            downloadBlob(blob, fname);
            // Background upload so the server cache picks up this render.
            uploadBlob(cid, blob);
            btn.textContent = '⬇ Download again';
            btn.disabled = false;
            btn.style.opacity = '1';
            btn.style.cursor = 'pointer';
            btn.onclick = () => downloadBlob(blob, fname);
        } catch (err) {
            status.textContent = `failed: ${err.message || err}`;
            btn.disabled = false;
            btn.style.opacity = '1';
            btn.style.cursor = 'pointer';
        }
    });
    slot.appendChild(block);
}

function fmtSec(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
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
            <p style="margin:0 0 8px;color:#aaa;font-size:0.92em">Five toggle buttons above the mixer &mdash; <b>FX</b>, <b>Macros</b>, <b>Beats</b>, <b>Auto-DJ</b>, <b>Arrange</b> &mdash; each open independently. Stacked top-to-bottom in that order. <b>Beats</b> only appears when the current project has stinger tracks (<code>hit1</code>&ndash;<code>hit4</code> or any track tagged <code>group: "stinger"</code>).</p>

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

            <h3>Arrange (structure DSL)</h3>
            <p style="margin:0 0 8px;color:#aaa;font-size:0.92em">Drive the composer's arrangement directly: pick a structure size, choose which roles tape-fade in, schedule a drum-only break, and overlay curve presets that morph the Feel puck and schedule macro fires at section boundaries. Everything runs in-process &mdash; no server round-trip &mdash; via the JS port of <code>ArrangeWithOpts</code>.</p>
            <ul>
                <li><b>Structure</b> &mdash; loop / ab / minimal / standard / extended / drop / build / jam. Overlay mode preserves an existing structure; otherwise a fresh blueprint runs</li>
                <li><b>Fade In</b> &mdash; checkbox per role (<code>pad</code> / <code>melody</code> / <code>arp</code> / <code>lead</code> / <code>bass</code>). Those roles start muted, inject a control net that unmutes mid-intro</li>
                <li><b>Drum Break</b> &mdash; bars of drum-only break at the track midpoint (off / 2 / 4 / 8). Stingers are excluded from the break; they stay muted per the usual rule</li>
                <li><b>Feel Curve</b> &mdash; preset XY puck path across sections (<i>EDM arc</i>, <i>Chill wave</i>, <i>Euphoric</i>). At each section start the puck snaps, morphing tempo/FX/swing/humanize</li>
                <li><b>Macro Curve</b> &mdash; preset macro schedule (<i>EDM classic</i>, <i>Drop heavy</i>, <i>Downtempo</i>). Fires <code>reverb-wash</code>/<code>riser</code>/<code>beat-repeat</code>/etc. at section boundaries without needing the Macros panel</li>
                <li><b>Arrange &#8635;</b> applies the selection. Runs overlay mode when the track already has a structure; otherwise does a full expansion</li>
            </ul>

            <h3>MIDI Tab</h3>
            <ul>
                <li>Toggle <b>MIDI</b> (top right) to enable Web MIDI input + per-track audio-output routing. The <b>MIDI</b> tab in the panel row collects everything: device status, live transpose (Xpose), CC and Note bindings, plus a debug Monitor.</li>
                <li><b>Hover-bind</b> &mdash; works for every binding type. Hover the target, then move the controller:
                    <ul>
                        <li>Hover an FX or mixer slider + move a CC knob &rarr; CC controls that slider</li>
                        <li>Hover a mixer mute button + press a pad (or twist a CC-mode pad) &rarr; toggles that track's mute</li>
                        <li>Hover a section divider (e.g. <i>Drums</i>) + press a pad &rarr; toggles the whole section</li>
                        <li>Hover the <b>BPM</b> number + twist a CC knob &rarr; CC drives tempo (60&ndash;300 BPM range)</li>
                        <li>Hover any macro tile + press a pad / keybed key &rarr; pad fires the macro</li>
                    </ul>
                </li>
                <li><b>Xpose</b> pill: <code>[&minus;] +0 [+] [&#127929;]</code> &mdash; ±48 semitones live transpose for non-drum channels. The 🎹 toggle arms <i>listen</i> mode: the next MIDI Note On from your keybed snaps the transpose to that key (latched).</li>
                <li><b>Pitch bend</b> (joystick X axis on most controllers) drives Xpose continuously, ±12 semitones, snap-to-semitone, releases to +0. <b>Modwheel / CC1</b> (joystick Y axis) is unbound by default — hover BPM (or any other slider) and twist the joystick Y to bind it your way.</li>
                <li><b>Monitor</b>: opens a debug overlay logging every incoming MIDI message (type / channel / note name / value). Use it to identify what your pads / knobs actually send. Copy button dumps the log to clipboard.</li>
                <li><b>Reset MIDI</b> wipes every binding (CC + pad + keybed) and resets transpose to +0.</li>
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

            <h3>On mobile</h3>
            <p style="margin:0 0 8px;color:#aaa;font-size:0.92em">Mobile browsers throttle background tabs, so playback can stutter or pause when you switch apps. To get the best uninterrupted experience:</p>
            <ul>
                <li><b>Add to Home Screen</b> &mdash; tap your browser's share/menu icon, then "Add to Home Screen" / "Install app". The installed PWA gets significantly more leeway from Android &amp; iOS background-throttling, and runs without the URL bar.</li>
                <li><b>Keep the screen on</b> &mdash; tap the small <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> wake-lock button next to MIDI in the header. While playing, the screen won't dim and the OS is much less likely to suspend the tab.</li>
                <li><b>Coming back from background</b> &mdash; the app auto-resumes the audio engine and re-syncs the worker timer when the tab returns to foreground. If you ever hear a stutter on return, tap Stop &amp; Play once to reset.</li>
            </ul>

            <h3>Using with AI</h3>
            <p style="margin:0 0 8px;color:#aaa;font-size:0.92em">The share-v1 format is a deterministic IR &mdash; any producer, including an LLM, can emit valid JSON and get byte-identical playback. <button class="pn-help-ai pn-link-btn">Copy a ready-made prompt</button> and paste it into Claude, ChatGPT, or any chat model to compose tracks from text.</p>

            <h3>Archive policy</h3>
            <p style="margin:0 0 8px;color:#aaa;font-size:0.92em">Tracks live in a content-addressed share store and are <b>preserved</b> via periodic snapshots at <a href="/archive" style="color:#0af">/archive</a>. We may archive (purge from the live store) at any time and for any reason &mdash; usually because we're rolling forward with changes that would need older shares to be up-converted or re-rendered against newer versions of the software. Archived shares stay downloadable from snapshot tarballs, and visiting an archived <code>?cid=…</code> URL surfaces a one-click recovery prompt that re-seals it from the latest snapshot.</p>

            <h3>Found a bug?</h3>
            <p style="margin:0 0 8px;color:#aaa;font-size:0.92em">Open Share, copy the <code>?cid=…</code> URL, and paste it in the report &mdash; the CID carries the exact track state so we can reproduce in one click.</p>
            <p style="margin:0 0 16px"><a href="https://github.com/stackdump/beats-bitwrap-io/issues/new?template=bug_report.yml" target="_blank" rel="noopener" style="color:#0af">Report a bug on GitHub &rarr;</a></p>

            <h3>Built With</h3>
            <p style="margin:0 0 8px;color:#aaa;font-size:0.92em">The sequencer is a <b>Petri net</b> executor &mdash; every note is a transition firing, every rhythm is tokens circulating. Macros inject transient control nets that fire their restore action on a tick-locked terminal transition.</p>
            <ul>
                <li><b><a href="https://tonejs.github.io/" target="_blank" rel="noopener" style="color:#0af">Tone.js</a></b> &mdash; turns transition firings into sound</li>
                <li><b>Bjorklund's algorithm</b> &mdash; generates Euclidean rhythms as token rings</li>
                <li><b><button class="pn-help-category pn-link-btn" style="color:#0af">Control category map &rarr;</button></b> &mdash; diagram of how <code>beat</code> fans out through generators, instruments, macros, and control actions</li>
            </ul>
        </div>
    `;
    overlay.addEventListener('click', (e) => {
        if (e.target.closest('.pn-help-ai')) { openAiPromptModal(); return; }
        if (e.target.closest('.pn-help-category')) {
            overlay.remove();
            showCategoryModal(el);
            return;
        }
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

// Live MIDI monitor — pops a modal that prints every incoming MIDI
// message verbatim so the user can identify pad/note numbers and CC
// numbers their controller is actually sending. The normal binding
// dispatch still runs (so they see both the raw message AND any
// already-bound action firing).
export function showMidiMonitorModal(el) {
    el.querySelector('.pn-midi-monitor-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'pn-help-overlay pn-midi-monitor-overlay';
    overlay.tabIndex = -1;
    overlay.innerHTML = `
        <div class="pn-help-modal" style="max-width:640px;width:96vw">
            <button class="pn-help-close">&times;</button>
            <h2>MIDI Monitor</h2>
            <p style="color:#aaa;margin:0 0 12px;font-size:13px">
                Logs every incoming MIDI message. Press a pad or twist a knob — the type, channel, and number show below. Bindings still fire as normal so you can verify what's wired.
            </p>
            <div class="pn-midi-monitor-last">Waiting for MIDI…</div>
            <div class="pn-midi-monitor-meta">
                <span class="pn-midi-monitor-status">Hint: enable MIDI in the top-right toolbar first.</span>
                <span style="display:flex;gap:6px">
                    <button class="pn-midi-monitor-copy" type="button" title="Copy the full log to the clipboard">Copy</button>
                    <button class="pn-midi-monitor-clear" type="button">Clear</button>
                </span>
            </div>
            <pre class="pn-midi-monitor-log" aria-live="polite"></pre>
        </div>
    `;
    el.appendChild(overlay);
    overlay.focus();

    const lastEl   = overlay.querySelector('.pn-midi-monitor-last');
    const logEl    = overlay.querySelector('.pn-midi-monitor-log');
    const statusEl = overlay.querySelector('.pn-midi-monitor-status');
    const updateStatus = () => {
        if (!el._midiInputConnected) {
            statusEl.textContent = 'MIDI not enabled — click MIDI in the top-right toolbar.';
            return;
        }
        const inputs = el._midiAccess
            ? [...el._midiAccess.inputs.values()].map(i => i.name).filter(Boolean)
            : [];
        statusEl.textContent = inputs.length
            ? `Listening on: ${inputs.join(', ')}`
            : 'MIDI ON — no input devices detected.';
    };
    updateStatus();

    // Sentinel: presence of this function on the element activates
    // the logging hook in handleMidiMessage. Cleared on close.
    el._midiMonitorTap = (data) => {
        const [status, d1, d2 = 0] = data;
        const ch = (status & 0x0F) + 1;
        const type = status & 0xF0;
        let label;
        if      (type === 0x80) label = `NOTE OFF  ch${ch}  note ${d1} (${noteName(d1)})  vel ${d2}`;
        else if (type === 0x90) label = (d2 === 0
                                        ? `NOTE OFF  ch${ch}  note ${d1} (${noteName(d1)})`
                                        : `NOTE ON   ch${ch}  note ${d1} (${noteName(d1)})  vel ${d2}`);
        else if (type === 0xA0) label = `AFT TOUCH ch${ch}  note ${d1}  pres ${d2}`;
        else if (type === 0xB0) label = `CC        ch${ch}  CC${d1}  val ${d2}`;
        else if (type === 0xC0) label = `PROG CHG  ch${ch}  prog ${d1}`;
        else if (type === 0xD0) label = `CH PRES   ch${ch}  pres ${d1}`;
        else if (type === 0xE0) label = `PITCH     ch${ch}  ${(d2<<7|d1) - 8192}`;
        else                    label = `0x${status.toString(16).toUpperCase()}  ${d1}  ${d2}`;
        const ts = new Date().toLocaleTimeString([], { hour12: false });
        lastEl.textContent = label;
        // Prepend so the newest line is on top — keeps the cursor
        // glued to where new data lands. Cap at 200 lines.
        const next = `[${ts}] ${label}\n${logEl.textContent}`;
        const lines = next.split('\n');
        logEl.textContent = lines.slice(0, 200).join('\n');
    };
    overlay.querySelector('.pn-midi-monitor-clear').addEventListener('click', () => {
        logEl.textContent = '';
        lastEl.textContent = 'Waiting for MIDI…';
    });
    const copyBtn = overlay.querySelector('.pn-midi-monitor-copy');
    copyBtn.addEventListener('click', async () => {
        const text = logEl.textContent;
        if (!text) return;
        const original = copyBtn.textContent;
        try {
            await navigator.clipboard.writeText(text);
            copyBtn.textContent = 'Copied';
        } catch {
            // Clipboard API can fail under non-https / sandboxed
            // contexts — fall back to a hidden textarea + execCommand.
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); copyBtn.textContent = 'Copied'; }
            catch { copyBtn.textContent = 'Copy failed'; }
            ta.remove();
        }
        setTimeout(() => { copyBtn.textContent = original; }, 1200);
    });
    const close = () => {
        delete el._midiMonitorTap;
        overlay.remove();
    };
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target.closest('.pn-help-close')) close();
    });
    overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
}

function noteName(n) {
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    return `${names[n % 12]}${Math.floor(n / 12) - 1}`;
}

export function showCategoryModal(el) {
    el.querySelector('.pn-help-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'pn-help-overlay pn-category-overlay';
    overlay.tabIndex = -1;
    overlay.innerHTML = `
        <div class="pn-help-modal" style="max-width:1200px;width:96vw">
            <button class="pn-help-close" title="Close (Esc)">&times;</button>
            <h2 style="margin:0 0 4px">Control category map</h2>
            <p style="margin:0 0 12px;color:#aaa;font-size:0.9em">Every beat is a transition firing; branches fan out through deterministic functors and rejoin through macros and control actions.</p>
            <div style="background:#0a0f1e;border:1px solid #334155;border-radius:8px;padding:8px">
                <object type="image/svg+xml" data="/docs/control-category.svg" style="width:100%;height:auto;display:block" aria-label="control category diagram"></object>
            </div>
            <p style="margin:10px 0 0;color:#64748b;font-size:0.82em">Source: <code>docs/control-category.svg</code> · Index: <code>docs/categorical-index.md</code></p>

            <h3 style="margin:24px 0 8px;color:#e2e8f0;font-size:1.05em;border-top:1px solid #334155;padding-top:18px">Reading the ring — Petri net notation</h3>
            <p style="margin:0 0 12px;color:#aaa;font-size:0.9em">The track visualization is a real Petri net. Here's the alphabet, so the ring stops being decorative and starts being inspectable.</p>
            <div style="display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap">
                <svg viewBox="0 0 420 200" style="flex:0 0 420px;max-width:100%;background:#0a0f1e;border:1px solid #334155;border-radius:8px" font-family="system-ui, sans-serif">
                    <defs>
                        <marker id="pn-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                            <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
                        </marker>
                        <marker id="pn-arr-faded" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                            <path d="M0,0 L10,5 L0,10 z" fill="#475569"/>
                        </marker>
                    </defs>
                    <!-- p0 (marked) -->
                    <circle cx="60" cy="105" r="22" fill="#0b1020" stroke="#67e8f9" stroke-width="2"/>
                    <circle cx="60" cy="105" r="5" fill="#67e8f9"/>
                    <text x="60" y="150" text-anchor="middle" font-size="11" fill="#94a3b8">place (marked)</text>
                    <text x="60" y="164" text-anchor="middle" font-size="10" fill="#64748b">holds tokens</text>
                    <!-- arc p0 → main transition -->
                    <line x1="85" y1="105" x2="145" y2="105" stroke="#94a3b8" stroke-width="1.8" marker-end="url(#pn-arr)"/>
                    <text x="115" y="95" text-anchor="middle" font-size="10" fill="#64748b">arc</text>
                    <!-- main transition (audible beat) -->
                    <rect x="150" y="85" width="18" height="40" fill="#f59e0b"/>
                    <text x="159" y="150" text-anchor="middle" font-size="11" fill="#94a3b8">transition</text>
                    <text x="159" y="164" text-anchor="middle" font-size="10" fill="#64748b">fires a beat</text>
                    <!-- arc main → p1 -->
                    <line x1="170" y1="105" x2="230" y2="105" stroke="#94a3b8" stroke-width="1.8" marker-end="url(#pn-arr)"/>
                    <!-- p1 (empty) -->
                    <circle cx="255" cy="105" r="22" fill="#0b1020" stroke="#475569" stroke-width="2"/>
                    <text x="255" y="150" text-anchor="middle" font-size="11" fill="#94a3b8">place (empty)</text>
                    <text x="255" y="164" text-anchor="middle" font-size="10" fill="#64748b">no token yet</text>
                    <!-- arc p1 → loop transition (faded) -->
                    <path d="M 255 83 C 255 50, 220 35, 170 35" fill="none" stroke="#475569" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#pn-arr-faded)"/>
                    <!-- loop transition (faded — closes the ring) -->
                    <rect x="150" y="15" width="18" height="40" fill="none" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.7"/>
                    <text x="159" y="9" text-anchor="middle" font-size="9" fill="#64748b" font-style="italic">loop transition</text>
                    <!-- arc loop → p0 (faded) -->
                    <path d="M 150 35 C 100 35, 60 50, 60 83" fill="none" stroke="#475569" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#pn-arr-faded)"/>
                    <!-- caption -->
                    <text x="365" y="100" text-anchor="middle" font-size="11" fill="#cbd5e1">= one</text>
                    <text x="365" y="115" text-anchor="middle" font-size="11" fill="#cbd5e1">beat</text>
                </svg>
                <div style="flex:1 1 260px;min-width:260px;color:#cbd5e1;font-size:0.9em;line-height:1.6">
                    <ul style="margin:0;padding-left:18px">
                        <li><b style="color:#67e8f9">Place</b> (circle) — a slot that holds tokens. A <b>token</b> (filled dot) marks the place as active.</li>
                        <li><b style="color:#f59e0b">Transition</b> (rectangle) — fires when every input place has a token. Firing consumes one token from each input and deposits one into each output. Each firing is one audible <b>beat</b>.</li>
                        <li><b>Arc</b> (arrow) — connects places to transitions and back. Direction = flow of tokens. Petri nets are bipartite: places only connect to transitions, never directly to other places.</li>
                        <li><b>Loop transition</b> (dashed) — even closing the ring goes through a transition. The dashed one above completes the cycle from <i>p1</i> back to <i>p0</i>; in a real track it might be silent (no MIDI) so the bar feels like one continuous loop, but topologically it's still a firing.</li>
                        <li><b>Token ring</b> — the drum / melody pattern shape. One token circulates through N places and N transitions; each pass around the ring = one bar.</li>
                    </ul>
                </div>
            </div>
            <p style="margin:14px 0 0;color:#aaa;font-size:0.88em">Euclidean drum patterns are just rings with transitions tagged at the hit positions; Markov melodies extend the same idea with branching transitions that compete for the token (conflict resolved randomly). Macros and control actions inject small linear-chain nets whose terminal transition carries a restore action.</p>
        </div>
    `;
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target.closest('.pn-help-close')) {
            overlay.remove();
        }
    });
    overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); overlay.remove(); }
    });
    el.appendChild(overlay);
    overlay.focus();
}

// Personal track-history modal. Reads localStorage['pn-history'] and
// renders one card per remembered CID with the existing share-card
// SVG as artwork. Click → navigate to /?cid=…. Clear button wipes
// the entire history (with confirm).
export function showHistoryModal(el) {
    el.querySelector('.pn-history-overlay')?.remove();
    const entries = listHistory();
    const overlay = document.createElement('div');
    overlay.className = 'pn-help-overlay pn-history-overlay';
    overlay.tabIndex = -1;
    const fmtTime = (ms) => {
        const diff = Date.now() - ms;
        if (diff < 60_000) return 'just now';
        if (diff < 3_600_000) return Math.round(diff / 60_000) + 'm ago';
        if (diff < 86_400_000) return Math.round(diff / 3_600_000) + 'h ago';
        if (diff < 7 * 86_400_000) return Math.round(diff / 86_400_000) + 'd ago';
        return new Date(ms).toLocaleDateString();
    };
    const items = entries.length === 0
        ? `<p style="color:#888;text-align:center;padding:32px 0">No history yet. Tracks you share, render, or open via a link will land here.</p>`
        : entries.map(e => {
            const title = (e.name || `${e.genre || 'track'} · ${e.seed ?? ''}`).trim();
            const sub = [
                e.genre,
                e.tempo ? e.tempo + ' BPM' : '',
                fmtTime(e.seenAt || 0),
            ].filter(Boolean).join(' · ');
            const badges = (e.actions || []).map(a =>
                `<span class="pn-history-badge">${a}</span>`
            ).join('');
            return `
                <a class="pn-history-item" href="/?cid=${encodeURIComponent(e.cid)}">
                    <img class="pn-history-art" src="/share-card/${encodeURIComponent(e.cid)}.svg" alt="" loading="lazy">
                    <div class="pn-history-meta">
                        <div class="pn-history-title">${escapeHTML(title)}</div>
                        <div class="pn-history-sub">${escapeHTML(sub)}</div>
                        <div class="pn-history-badges">${badges}</div>
                    </div>
                </a>
            `;
        }).join('');
    overlay.innerHTML = `
        <div class="pn-history-modal">
            <button class="pn-help-close" title="Close (Esc)">&times;</button>
            <h2>Your tracks <span style="color:#777;font-weight:400;font-size:13px;letter-spacing:0.04em">${entries.length} remembered</span></h2>
            <p style="color:#888;font-size:12px;margin:0 0 16px">Stored in this browser only. Tracks you've shared, rendered, or opened from a link.</p>
            <div class="pn-history-list">${items}</div>
            ${entries.length ? '<div style="text-align:right;margin-top:18px"><button class="pn-history-clear" style="background:transparent;color:#a55;border:1px solid #532;padding:6px 14px;border-radius:4px;font-size:12px;cursor:pointer">Clear history</button></div>' : ''}
        </div>
    `;
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target.closest('.pn-help-close')) {
            overlay.remove();
            return;
        }
        if (e.target.closest('.pn-history-clear')) {
            if (confirm('Clear all remembered tracks? This only affects this browser.')) {
                clearHistory();
                overlay.remove();
            }
            return;
        }
    });
    overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); overlay.remove(); }
    });
    el.appendChild(overlay);
    overlay.focus();
}

function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
}


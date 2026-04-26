// Backend — transport (play/pause, tempo, wake-lock, media session) plus
// the Worker / WebSocket message plumbing + `_handleWsMessage` dispatch,
// remote-transition fire, humanize/swing timing, and state-sync apply.
//
// Extracted from petri-note.js as the first pass of the 4-piece split.
// Every function takes the custom element (`el`) as its first arg;
// petri-note.js keeps one-line wrapper methods so call sites are
// unchanged (`el._togglePlay()`, `el._sendWs(msg)`, etc.).

import { toneEngine } from '../../audio/tone-engine.js';
import { MACROS } from '../macros/catalog.js';
import { stageOnTransitionFired, stageOnMuteStateChange, stageSetVisualizer } from '../ui/stage.js';

// Audio-clock lookahead window. Worker stamps every transition fire
// with `playAtOffsetMs` + `tickEpochMs`; we convert to an absolute
// AudioContext time on receipt and let Tone.js schedule the note.
// 80 ms is small enough to stay under the AV-sync perception threshold
// for music, large enough to absorb main-thread stalls (Auto-DJ regen,
// macro fires, GC pauses) without dropping beats. Mirrored in
// sequencer-worker.js — keep in sync.
const LOOKAHEAD_MS = 80;

// --- Transport ---

export function cyclePlaybackMode(el) {
    const modes = ['single', 'repeat', 'shuffle'];
    const labels = { single: '1x', repeat: '🔁', shuffle: '🔀' };
    const titles = { single: 'Single play', repeat: 'Repeat track', shuffle: 'Shuffle — new track on end' };
    const idx = modes.indexOf(el._playbackMode);
    el._playbackMode = modes[(idx + 1) % modes.length];
    el._pendingNextTrack = null;
    el._prefetchSent = false;
    const btn = el.querySelector('.pn-playback-mode');
    btn.textContent = labels[el._playbackMode];
    btn.title = titles[el._playbackMode];
    btn.className = 'pn-playback-mode' + (el._playbackMode !== 'single' ? ' active' : '');
}

export function togglePlay(el) {
    // Resume AudioContext immediately in user gesture (Chrome autoplay policy).
    toneEngine.resumeContext();

    el._playing = !el._playing;

    // Drop the audio grid anchor. The next worker fire after a fresh
    // play (or the silence after a stop) re-anchors against Tone.now().
    el._audioGridStartTone = null;

    // After resume() settles, check if the context actually unlocked.
    if (el._playing) {
        setTimeout(() => {
            if (el._playing && !toneEngine.isContextRunning()) {
                showAudioLockBanner(el);
            } else {
                hideAudioLockBanner(el);
            }
        }, 150);
    } else {
        hideAudioLockBanner(el);
    }
    const btn = el.querySelector('.pn-play');
    btn.classList.toggle('playing', el._playing);
    btn.innerHTML = el._playing ? '&#9632;' : '&#9654;';

    if (el._playing) {
        el._ensureToneStarted();
        el._vizStartLoop();
        acquireWakeLock(el);
        setupMediaSession(el);
        installVisibilityRecovery(el);
    } else {
        el._vizStopLoop();
        // Cancel any pending macro restores — worker will reset mute state anyway.
        el._cancelAllMacros();
        // Reset playhead to loop start (or beginning if no loop).
        el._tick = el._loopStart > 0 ? el._loopStart : 0;
        el._lastPlayheadPct = null;
        el._updatePlayhead();
        el._draw(); // restore static view
        releaseWakeLock(el);
    }

    sendWs(el, { type: 'transport', action: el._playing ? 'play' : 'stop' });
    updateMediaSessionState(el);
}

export function showAudioLockBanner(el) {
    if (el._audioLockBanner) return;
    const banner = document.createElement('div');
    banner.className = 'pn-audio-lock-banner';
    banner.innerHTML = '<span>Audio is blocked by the browser.</span><button>Click to enable</button>';
    banner.querySelector('button').addEventListener('click', async () => {
        toneEngine.resumeContext();
        await el._ensureToneStarted();
        // Clear any notes that may have been scheduled pre-resume.
        try { toneEngine.panic?.(); } catch {}
        if (toneEngine.isContextRunning()) hideAudioLockBanner(el);
    });
    el.appendChild(banner);
    el._audioLockBanner = banner;
}

export function hideAudioLockBanner(el) {
    if (!el._audioLockBanner) return;
    el._audioLockBanner.remove();
    el._audioLockBanner = null;
}

export async function acquireWakeLock(el) {
    if (!('wakeLock' in navigator)) return;
    try {
        el._wakeLock = await navigator.wakeLock.request('screen');
        el._wakeLock.addEventListener('release', () => { el._wakeLock = null; });
    } catch (e) { /* user denied or not supported */ }
    // Re-acquire when tab becomes visible again (browser auto-releases on hide).
    if (!el._wakeLockVisHandler) {
        el._wakeLockVisHandler = () => {
            if (document.visibilityState === 'visible' && el._playing) {
                acquireWakeLock(el);
            }
        };
        document.addEventListener('visibilitychange', el._wakeLockVisHandler);
    }
}

// Background handling — default: stop on hide, fresh on return.
//   Detect tab-switch / screen-lock via visibilitychange and pause
//   playback cleanly. User taps Play to resume from the current state.
//   Cleaner UX than fighting OS suspension (worker throttling, audio
//   element drops, AV drift on resume).
//
// AFK opt-in: set localStorage 'pn-afk-mode' = '1' to keep the world
//   running through background — the worker keeps ticking and silent
//   catch-up advances Petri-net state without replaying audio. On
//   return, AudioContext resumes and the worker timer bounces back to
//   the right rate. Same model as a multiplayer game tolerating an
//   AFK player. Toggle is intentionally hidden — most users want the
//   default stop-on-hide; AFK is for live-listening / recording rigs.
export function installVisibilityRecovery(el) {
    if (el._visRecoveryHandler) return;
    el._visRecoveryHandler = () => {
        const afk = (() => { try { return localStorage.getItem('pn-afk-mode') === '1'; } catch { return false; } })();
        if (document.visibilityState === 'hidden' && el._playing && !afk) {
            // Stop playback. Same path as tapping Play so all cleanup
            // runs (wake-lock release, viz loop stop, worker stop).
            el._togglePlay();
            return;
        }
        if (document.visibilityState === 'visible' && el._playing) {
            // Catch-up path (AFK mode only — non-AFK already stopped).
            try { toneEngine.resumeContext(); } catch {}
            if (el._worker && typeof el._tempo === 'number') {
                el._worker.postMessage({ type: 'tempo', tempo: el._tempo });
            }
        } else if (document.visibilityState === 'visible') {
            // Pre-resume context so the next user-tap on Play has a
            // hot context (cheap; harmless if it was never suspended).
            try { toneEngine.resumeContext(); } catch {}
        }
    };
    document.addEventListener('visibilitychange', el._visRecoveryHandler);
}

export function releaseWakeLock(el) {
    if (el._wakeLock) { el._wakeLock.release(); el._wakeLock = null; }
}

export function setupMediaSession(el) {
    if (!('mediaSession' in navigator)) return;
    // Claim media session from macOS (steals media keys from Apple Music).
    if (!el._silentAudio) {
        // Generate 2 seconds of near-silent WAV (not zero — browsers skip truly silent audio).
        const sampleRate = 8000, seconds = 2, numSamples = sampleRate * seconds;
        const buf = new ArrayBuffer(44 + numSamples * 2);
        const view = new DataView(buf);
        const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
        writeStr(0, 'RIFF'); view.setUint32(4, 36 + numSamples * 2, true);
        writeStr(8, 'WAVE'); writeStr(12, 'fmt ');
        view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
        view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
        view.setUint16(32, 2, true); view.setUint16(34, 16, true);
        writeStr(36, 'data'); view.setUint32(40, numSamples * 2, true);
        for (let i = 0; i < numSamples; i++) view.setInt16(44 + i * 2, (i % 2) ? 1 : -1, true); // ±1 out of 32767
        const blob = new Blob([buf], { type: 'audio/wav' });
        const audio = document.createElement('audio');
        audio.src = URL.createObjectURL(blob);
        audio.loop = true;
        document.body.appendChild(audio); // must be in DOM for macOS Now Playing
        el._silentAudio = audio;
    }
    // Set handlers BEFORE play so Chrome registers them with macOS.
    navigator.mediaSession.metadata = new MediaMetadata({
        title: el._project?.name || 'beats-btw',
        artist: 'beats-btw',
    });
    navigator.mediaSession.setActionHandler('play', () => {
        if (!el._playing) togglePlay(el);
    });
    navigator.mediaSession.setActionHandler('pause', () => {
        if (el._playing) togglePlay(el);
    });
    navigator.mediaSession.setActionHandler('nexttrack', () => {
        const genre = el.querySelector('.pn-genre-select')?.value || 'techno';
        const structure = el.querySelector('.pn-structure-select')?.value || '';
        const params = {};
        if (structure) params.structure = structure;
        sendWs(el, { type: 'generate', genre, params });
    });
    navigator.mediaSession.setActionHandler('previoustrack', () => {
        el._navTrack(-1);
    });
    // Start silent audio AFTER handlers are registered.
    if (el._playing) {
        el._silentAudio.play().catch(() => {});
    }
}

export function updateMediaSessionState(el) {
    if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = el._playing ? 'playing' : 'paused';
    }
    if (el._silentAudio) {
        if (el._playing) {
            el._silentAudio.play().catch(() => {});
        } else {
            el._silentAudio.pause();
        }
    }
}

export function setTempo(el, bpm) {
    el._tempo = Math.max(20, Math.min(300, bpm));
    el._project.tempo = el._tempo;
    el.querySelector('.pn-tempo input').value = el._tempo;
    sendWs(el, { type: 'tempo', bpm: el._tempo });
    el._syncProject();
}

// --- Backend: Worker (default) or WebSocket (data-backend="ws") ---
//
// The WS path is a client-side stub for a planned feature: a remote
// conductor (separate service / repo) driving the front-end by streaming
// sequencer messages over `/ws`. All worker message types
// (`generate`, `project-load`, `transport`, `tempo`, `mute`, `mute-group`,
// `fire-macro`, `update-track-pattern`, `cancel-macros`, `transition-fire`,
// `loop`, `seek`, `crop`, `deterministic-loop`, `shuffle-instruments`) must
// be proxied verbatim by any WS implementation so the client needs no
// backend-specific branches beyond connection management.

export function connectBackend(el) {
    if (el.dataset.backend === 'ws') {
        connectWebSocket(el);
    } else {
        connectWorker(el);
    }
}

export function connectWorker(el) {
    el._worker = new Worker('./sequencer-worker.js?v=11', { type: 'module' });
    el._workerReady = false;

    // The very first worker spawned during connectedCallback fails
    // reproducibly in production — likely a service-worker activation
    // race intercepting the worker module fetch. Workers spawned a
    // second or two later come up cleanly. Without recovery, `?cid=…`
    // share URLs never apply because _bootGenerate is gated on `ready`.
    // Respawn once after a 1500ms delay (long enough to clear the SW
    // activation window, short enough to feel instant on the loading UI).
    const respawnIfNeeded = () => {
        if (el._workerReady || el._workerRespawned) return;
        el._workerRespawned = true;
        try { el._worker.terminate(); } catch {}
        setTimeout(() => connectWorker(el), 1500);
    };

    el._worker.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === 'ready') {
            el._workerReady = true;
            updateWsStatus(el, true);
            // Generate a techno track on first connect, otherwise reload current project.
            if (!el._hasInitialProject) {
                el._hasInitialProject = true;
                el._bootGenerate();
            } else {
                sendWs(el, { type: 'project-load', project: el._project });
            }
            return;
        }
        if (msg.type === 'preview-ready') {
            // Drop stale previews — if the boundary already fell back to
            // a cold generate (or a newer prefetch superseded this one),
            // the reqId won't match and we skip the project entirely.
            if (msg.reqId !== undefined && msg.reqId !== el._previewReqId) return;
            el._pendingNextTrack = msg.project;
            el._prewarmPreviewInstruments(msg.project);
            return;
        }
        handleWsMessage(el, msg);
    };

    el._worker.onerror = (err) => {
        // Older handler logged just `err`, which serializes to "[object Event]"
        // because Worker error events are plain Events without a parsed Error.
        // Pull every field that might exist so a real failure leaves a trail.
        const detail = [
            err.message || '(no message)',
            err.filename ? `at ${err.filename}:${err.lineno}:${err.colno}` : '',
            err.error?.stack || '',
        ].filter(Boolean).join(' ');
        // First-spawn errors are expected (documented service-worker
        // activation race — the workaround above respawns cleanly).
        // Log them quietly so users don't think the page is broken;
        // only escalate to console.error if the respawn ALSO fails.
        if (!el._workerRespawned) {
            console.info('Worker first-spawn failed (will respawn):', detail);
        } else {
            console.error('Worker error after respawn:', detail);
        }
        respawnIfNeeded();
    };

    if (!el._workerRespawned) {
        setTimeout(respawnIfNeeded, 3000);
    }
}

export function connectWebSocket(el) {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws`;

    try {
        el._ws = new WebSocket(wsUrl);

        el._ws.onopen = () => {
            updateWsStatus(el, true);
            if (!el._hasInitialProject) {
                el._hasInitialProject = true;
                el._bootGenerate();
            } else {
                sendWs(el, { type: 'project-load', project: el._project });
            }
        };

        el._ws.onmessage = (event) => {
            handleWsMessage(el, JSON.parse(event.data));
        };

        el._ws.onclose = () => {
            updateWsStatus(el, false);
            scheduleReconnect(el);
        };

        el._ws.onerror = (err) => {
            console.error('WebSocket error:', err);
        };
    } catch (e) {
        console.warn('WebSocket connection failed:', e);
        updateWsStatus(el, false);
    }
}

export function scheduleReconnect(el) {
    if (el._wsReconnectTimer) return;
    el._wsReconnectTimer = setTimeout(() => {
        el._wsReconnectTimer = null;
        connectWebSocket(el);
    }, 3000);
}

export function updateWsStatus(el, connected) {
    // Infer from actual state when called with no args (e.g. after UI rebuild).
    if (connected === undefined) {
        connected = el._ws?.readyState === WebSocket.OPEN;
    }
    const target = el.querySelector('.pn-ws-status');
    if (!target) return;
    target.className = `pn-ws-status ${connected ? 'connected' : 'disconnected'}`;
    target.innerHTML = connected ? '&#9679; Connected' : '&#9679; Disconnected';
}

export function sendWs(el, msg) {
    if (el._ws?.readyState === WebSocket.OPEN) {
        el._ws.send(JSON.stringify(msg));
    } else if (el._worker) {
        el._worker.postMessage(msg);
    }
}

export function handleWsMessage(el, msg) {
    switch (msg.type) {
        case 'transition-fired':
            onRemoteTransitionFired(el, msg.netId, msg.transitionId, msg.midi,
                                    msg.playAtOffsetMs, msg.tickEpochMs,
                                    msg.playbackTicks, msg.tickIntervalMs);
            break;
        case 'state-sync': {
            const prevTick = el._tick;
            el._tick = msg.tick || 0;
            el._tickTimestamp = performance.now();
            // Detect loop wrap (tick jumped backward) — cut lingering notes.
            if (el._tick < prevTick && el._playing) {
                toneEngine.panic();
            }
            el._fireRepeatingOneShots(prevTick, el._tick);
            el._autoDjTick(prevTick, el._tick);
            onStateSync(el, msg.state);
            // Apply pending instrument changes at bar boundary.
            if (el._pendingInstruments && el._tick >= el._pendingBarTarget) {
                toneEngine.panic();
                el._onInstrumentsChanged(el._pendingInstruments);
                el._pendingInstruments = null;
            }
            // Prefetch next track for shuffle mode at ~80% progress.
            if (el._playbackMode === 'shuffle' && !el._prefetchSent && el._totalSteps > 0) {
                const pct = el._tick / el._totalSteps;
                if (pct >= 0.8) {
                    el._prefetchSent = true;
                    const genre = el.querySelector('.pn-genre-select')?.value || 'techno';
                    const structure = el.querySelector('.pn-structure-select')?.value || '';
                    const body = { genre, params: {}, instruments: el._getCurrentInstruments() };
                    if (structure) body.params.structure = structure;
                    const reqId = ++el._previewReqId;
                    sendWs(el, { type: 'generate-preview', genre: body.genre, params: body.params, reqId });
                }
            }
            break;
        }
        case 'tempo-changed':
            el._tempo = msg.tempo;
            el.querySelector('.pn-tempo input').value = msg.tempo;
            // Tempo change invalidates the audio grid (interval changed).
            // Next fire re-anchors against the new tickIntervalMs.
            el._audioGridStartTone = null;
            break;
        case 'project-sync':
            // Worker swapped projects (or just synced state) — drop
            // the audio grid anchor so the next fire re-establishes
            // it at Tone.now() + LOOKAHEAD against the new project.
            el._audioGridStartTone = null;
            if (el._playing) {
                // Server swapped at bar boundary — apply seamlessly.
                toneEngine.panic();
                el._applyProjectSync(msg.project, true);
            } else {
                el._applyProjectSync(msg.project, false);
            }
            // Fire any pending arrange overlay now that the composer's
            // generate has produced a project. One-shot per share load.
            // Runs in-process via the JS port of ArrangeWithOpts so
            // production hosts without `-authoring` still render the
            // overlay DSL. The call mutates el._project in place, then
            // we project-load it back into the worker.
            if (el._pendingOverlay) {
                const overlay = el._pendingOverlay;
                el._pendingOverlay = null;
                console.log('[overlay] firing with', overlay);
                import('../generator/arrange.js').then(mod => {
                    try {
                        mod.arrangeWithOpts(el._project, overlay.genre, '', {
                            overlayOnly: true,
                            fadeIn: overlay.fadeIn,
                            drumBreak: overlay.drumBreak,
                            feelCurve: overlay.feelCurve,
                            macroCurve: overlay.macroCurve,
                        });
                        console.log('[overlay] post-arrange netCount', Object.keys(el._project.nets).length);
                        el._sendWs({ type: 'project-load', project: el._project });
                    } catch (err) {
                        console.warn('overlay arrange failed:', err);
                    }
                });
            }
            break;
        case 'track-pattern-updated':
            if (el._project && el._project.nets && msg.netId && msg.net) {
                el._project.nets[msg.netId] = msg.net;
                el._normalizeNet(msg.net);
                el._renderMixer();
                if (msg.netId === el._activeNetId) el._renderNet();
            }
            break;
        case 'track-pattern-error':
            console.warn('[petri-note] track-pattern-error', msg.netId, msg.error);
            break;
        case 'instruments-changed':
            if (el._playing) {
                el._pendingInstruments = msg.instruments;
                el._pendingBarTarget = (Math.floor(el._tick / 16) + 1) * 16;
            } else {
                el._onInstrumentsChanged(msg.instruments);
            }
            break;
        case 'control-fired':
            // Transition-fire control net triggered — dispatch the
            // baked-in macro through the main-thread queue. Canonical
            // field is `macro` (per schema); `targetNet` is accepted as
            // a legacy fallback.
            if (msg.control?.action === 'fire-macro') {
                const macroId = msg.control.macro || msg.control.targetNet;
                if (macroId) {
                    const opts = {};
                    if (msg.control.macroBars) opts.duration = msg.control.macroBars;
                    el._fireMacro(macroId, opts);
                    const label = MACROS.find(m => m.id === macroId)?.label || macroId;
                    const statusEl = el.querySelector('.pn-autodj-status');
                    if (statusEl) statusEl.textContent = `⟳ ${label}`;
                }
            }
            // Arrangement feelCurve — snap the Feel XY puck at section
            // boundaries. macroParams carries {x, y} in [0,1]².
            if (msg.control?.action === 'set-feel' && el._applyFeel) {
                const params = msg.control.macroParams || {};
                const x = typeof params.x === 'number' ? params.x : 0.5;
                const y = typeof params.y === 'number' ? params.y : 0.5;
                el._applyFeel([x, y]);
            }
            // Authored Stage visualizer changes — control net can drive
            // which visualizer the Stage shows. Param: { visualizer: name }.
            // Names: mandala (Constellation) · corona · sonar · petal ·
            // shuffle. No-op when Stage isn't open.
            if (msg.control?.action === 'set-visualizer') {
                const target = msg.control.macroParams?.visualizer;
                if (target) stageSetVisualizer(target);
            }
            // Visual feedback for control events.
            if (msg.netId === el._activeNetId) {
                const node = el._nodes[msg.transitionId];
                if (node) {
                    node.classList.add('firing');
                    setTimeout(() => node.classList.remove('firing'), 100);
                }
            }
            // Auto-rotate view at phrase boundaries (structured tracks only).
            if (el._structure && msg.control) {
                const action = msg.control.action;
                if (action === 'activate-slot' || action === 'unmute-track') {
                    const targetNet = msg.control.targetNet;
                    const target = el._project?.nets?.[targetNet];
                    const targetRole = target?.riffGroup || targetNet;
                    const melodicRoles = ['bass', 'melody', 'harmony', 'arp'];
                    if (melodicRoles.includes(targetRole) && targetNet !== el._activeNetId) {
                        el._switchNet(targetNet);
                    }
                }
            }
            break;
        case 'mute-state':
            el._mutedNets = new Set(Object.entries(msg.mutedNets || {}).filter(([,v]) => v).map(([k]) => k));
            // Re-apply manual mutes to server (manual overrides auto).
            for (const nid of el._manualMutedNets) {
                if (!el._mutedNets.has(nid)) {
                    sendWs(el, { type: 'mute', netId: nid, muted: true });
                }
            }
            el._renderMixer();
            stageOnMuteStateChange(el);
            break;
        case 'playback-complete':
            // Sequencer has stopped — mark as not playing so project-sync
            // goes through the cold-load path (sends project-load + play).
            el._playing = false;
            if (el._playbackMode === 'repeat') {
                // Replay the same track from the beginning.
                el._tick = 0; el._lastPlayheadPct = 0;
                el._vizHistory = [];
                el._updatePlayhead();
                sendWs(el, { type: 'transport', action: 'play' });
                el._playing = true;
                el._vizStartLoop();
                el._fireTransitionMacro();
            } else if (el._playbackMode === 'shuffle') {
                el._prefetchSent = false;
                if (el._pendingNextTrack) {
                    // Use pre-fetched track — bake transition into its
                    // control layer so the macro fires at tick 1 of the
                    // new project instead of racing project-load.
                    const proj = el._pendingNextTrack;
                    el._pendingNextTrack = null;
                    const label = el._injectTransitionNet(proj);
                    toneEngine.panic();
                    el._applyProjectSync(proj, false);
                    const statusEl = el.querySelector('.pn-autodj-status');
                    if (statusEl && label) statusEl.textContent = `⟳ ${label}`;
                } else {
                    // Fallback: generate on demand with current instruments.
                    // Transition fires after the new project lands.
                    el._tick = 0; el._lastPlayheadPct = 0;
                    el._updatePlayhead();
                    const genre = el.querySelector('.pn-genre-select').value;
                    const structure = el.querySelector('.pn-structure-select').value;
                    const params = { ...(el._traitOverrides || {}), instruments: el._getCurrentInstruments() };
                    if (structure) params.structure = structure;
                    // Mirror doGenerate's transition-injection shape so
                    // the shuffle-pool fallback feels like Auto-DJ regen.
                    let injectTransitionNet = null;
                    const macroId = el._pickTransitionMacroId();
                    if (macroId) {
                        injectTransitionNet = {
                            netId: `macro:transition:${macroId}:${Date.now().toString(36)}`,
                            net: el._transitionNetJson(macroId),
                        };
                    }
                    sendWs(el, { type: 'generate', genre, params, injectTransitionNet });
                }
            } else {
                // Single: stop.
                el._playing = false;
                el._tick = 0; el._lastPlayheadPct = 0;
                el._vizStopLoop();
                el._draw();
                el._updatePlayhead();
                const playBtn2 = el.querySelector('.pn-play');
                if (playBtn2) {
                    playBtn2.classList.remove('playing');
                    playBtn2.innerHTML = '&#9654;';
                }
            }
            break;
        case 'loop-changed':
            el._loopStart = msg.startTick < 0 ? 0 : msg.startTick;
            el._loopEnd = msg.endTick < 0 ? (el._totalSteps || 0) : msg.endTick;
            el._updateLoopMarkers();
            break;
    }
}

// --- Remote-fire + humanize/swing ---

export function onRemoteTransitionFired(el, netId, transitionId, midi, playAtOffsetMs, tickEpochMs, playbackTicks, tickIntervalMs) {
    // Visual feedback — match by exact ID or riff group.
    const activeNet = el._project?.nets?.[el._activeNetId];
    const firedNet = el._project?.nets?.[netId];
    const sameGroup = activeNet?.riffGroup && activeNet.riffGroup === firedNet?.riffGroup;
    if (netId === el._activeNetId || sameGroup) {
        const node = el._nodes[transitionId];
        if (node) {
            node.classList.add('firing');
            setTimeout(() => node.classList.remove('firing'), 100);
            // Persistent playhead — keep one "you are here" highlight on
            // the last-fired transition until the next one fires, so
            // beats are readable at a glance during performance.
            if (el._playheadTransitionNode && el._playheadTransitionNode !== node) {
                el._playheadTransitionNode.classList.remove('playhead');
            }
            node.classList.add('playhead');
            el._playheadTransitionNode = node;
        }
    }

    // Visualization particles.
    if (midi) {
        el._vizSpawnParticle(netId, midi);
    }

    // Full-page Stage: pulse the matching transition in its panel.
    stageOnTransitionFired(el, netId, transitionId);

    // Play sound locally.
    if (midi) {
        // Apply client-side humanization.
        let m = humanizeNote(el, midi);
        // Hit-pad live pitch: the .pn-os-pitch dropdown in the Beats
        // panel acts as a transpose for the stinger track whenever it's
        // unmuted — via Fire, the 1–4 hotkey, or the mixer mute button.
        // Reading the DOM every fire keeps the dropdown as the single
        // source of truth, no timer reconciliation needed.
        if (typeof netId === 'string' && netId.startsWith('hit')) {
            const pitchSel = el.querySelector(`.pn-os-pitch[data-macro="${netId}"]`);
            const semi = parseInt(pitchSel?.value, 10);
            if (Number.isFinite(semi) && semi !== 0) {
                m = { ...m, note: Math.max(0, Math.min(127, (m.note || 0) + semi)) };
            }
        }
        // Three playback paths, picked in order of preference:
        //  - Audio-grid path (playbackTicks + tickIntervalMs defined):
        //    anchor `_audioGridStartTone` to a `Tone.now()` baseline
        //    on the first fire of a playback session, then schedule
        //    every subsequent fire at `anchor + n * tickIntervalSec`.
        //    Audio onsets land on the AudioContext-clock grid no
        //    matter when the worker fire arrives — immune to
        //    setInterval jitter / Chromium throttling under load.
        //    Re-anchors when `_audioGridStartTone` is null (set by
        //    tempo-changed, transport stop, project swap), or when
        //    `playbackTicks` regresses (new playback session), or when
        //    `tickIntervalMs` changes (tempo change).
        //  - Per-burst anchor (playAtOffsetMs only): legacy fallback
        //    for the WS backend, which doesn't emit playbackTicks.
        //  - Plain (no fields): legacy setTimeout-based delay.
        if (typeof playbackTicks === 'number' && typeof tickIntervalMs === 'number') {
            // Re-anchor when:
            //   - first fire of a session (anchor is null);
            //   - playbackTicks regressed (worker reset, new playback);
            //   - tempo changed (interval changed → grid changed);
            //   - the anchor is stale and would schedule audio in the
            //     past. The classic case is the first Play after a fresh
            //     page load: togglePlay calls resumeContext() async but
            //     doesn't await it, so the very first transition-fired
            //     can land while Tone.now() is still 0 (or a tiny
            //     pre-unlock value). We anchor to that bogus baseline
            //     and every scheduled note ends up "in the past" — Tone
            //     silently drops them, no audio. Detect by checking
            //     whether the computed playAt < Tone.now(), and if so
            //     reset against fresh Tone.now() so subsequent fires
            //     stay on the grid relative to the corrected anchor.
            const candidatePlayAt = el._audioGridStartTone != null
                ? el._audioGridStartTone
                  + (playbackTicks - el._audioGridStartPlaybackTicks) * (tickIntervalMs / 1000)
                : -Infinity;
            const stale = candidatePlayAt < toneEngine.now();
            if (el._audioGridStartTone == null
                || playbackTicks < (el._audioGridStartPlaybackTicks ?? 0)
                || el._audioGridTickIntervalMs !== tickIntervalMs
                || stale) {
                el._audioGridStartTone = toneEngine.now() + LOOKAHEAD_MS / 1000;
                el._audioGridStartPlaybackTicks = playbackTicks;
                el._audioGridTickIntervalMs = tickIntervalMs;
            }
            const playAt = el._audioGridStartTone
                + (playbackTicks - el._audioGridStartPlaybackTicks) * (tickIntervalMs / 1000)
                + swingDelay(el) / 1000;
            el._playNote(m, netId, playAt);
        } else if (typeof playAtOffsetMs === 'number' && typeof tickEpochMs === 'number') {
            if (el._lastTickEpochMs !== tickEpochMs) {
                el._lastTickEpochMs = tickEpochMs;
                el._burstAnchorAudio = toneEngine.now() + LOOKAHEAD_MS / 1000;
                el._burstAnchorOffsetMs = playAtOffsetMs;
            }
            const playAt = el._burstAnchorAudio
                + (playAtOffsetMs - el._burstAnchorOffsetMs) / 1000
                + swingDelay(el) / 1000;
            el._playNote(m, netId, playAt);
        } else {
            const delay = swingDelay(el);
            if (delay > 0) {
                setTimeout(() => el._playNote(m, netId), delay);
            } else {
                el._playNote(m, netId);
            }
        }
    }
}

// Apply humanize: timing jitter (via caller) and velocity jitter.
// Returns a new midi object with jittered velocity.
export function humanizeNote(el, midi) {
    if (el._humanize <= 0) return midi;

    const amount = el._humanize / 100; // 0-1
    // Velocity jitter: ±(amount * 15) from original.
    const velJitter = (Math.random() * 2 - 1) * amount * 15;
    const newVel = Math.max(1, Math.min(127, Math.round((midi.velocity || 100) + velJitter)));

    return { ...midi, velocity: newVel };
}

// Calculate swing delay for current tick.
// Swing offsets even 8th-note positions by swing/100 * tickDuration * 0.5.
// Returns delay in ms (0 for on-beat ticks).
export function swingDelay(el) {
    if (el._swing <= 0) return 0;

    // PPQ=4: ticks 0,1,2,3 per beat. Even 8th notes = every 2 ticks.
    // Odd 8th-note positions (tick % 2 === 1) get swing offset.
    const tickInBeat = el._tick % 4;
    if (tickInBeat === 1 || tickInBeat === 3) {
        // Duration of one tick in ms.
        const tickMs = (60000 / el._tempo) / 4;
        // Swing: push the off-beat tick later.
        const swingAmount = (el._swing / 100) * tickMs * 0.5;
        // Add humanize timing jitter on top.
        const humanizeJitter = el._humanize > 0
            ? (Math.random() * 2 - 1) * (el._humanize / 100) * 30
            : 0;
        return Math.max(0, swingAmount + humanizeJitter);
    }

    // On-beat ticks: only humanize jitter.
    if (el._humanize > 0) {
        return Math.max(0, (Math.random() * 2 - 1) * (el._humanize / 100) * 15);
    }
    return 0;
}

export function onStateSync(el, state) {
    // Update token counts from server.
    for (const [netId, netState] of Object.entries(state)) {
        const net = el._project.nets[netId];
        if (!net) continue;
        for (const [placeId, tokens] of Object.entries(netState)) {
            if (net.places[placeId]) {
                net.places[placeId].tokens = [tokens];
            }
        }
    }
    if (el._activeNetId in state) {
        el._renderNet();
    }
    el._updatePlayhead();
}

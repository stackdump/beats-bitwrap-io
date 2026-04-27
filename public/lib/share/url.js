// Share-URL build + parse. Orchestrates the full share pipeline:
// collect state → canonicalize → CID → optional PUT to store →
// URL with `?cid=…` (short) or `?cid=…&z=…` (self-contained).
// Also parses incoming URLs (with legacy `?p=`/`?g=&s=&t=` fallbacks)
// and renders the Share modal with the Server/URL storage dropdown.
//
// Extracted from petri-note.js (Phase A.4).

import {
    b64urlDecode, canonicalizeJSON, computeCidForJsonLd,
    gzipToB64Url, b64UrlToGunzip,
} from './codec.js';
import { buildSharePayload } from './collect.js';
import { recordShared, recordRendered } from './history.js';
import { renderToBlob, downloadBlob, uploadBlob, isClientRenderSupported } from './client-render.js';

// --- URL parsing ---

// URL: `?cid=z<base58>&z=<base64url-gzip>`. Self-contained — no
// server lookup when `z` is present. Legacy `?p=` / `?g/s/structure/t`
// links still parse.
export async function parseShareFromUrl(el) {
    const q = new URLSearchParams(location.search);
    const cid = q.get('cid');
    const z = q.get('z');
    if (cid) {
        try {
            let json = null;
            if (z) {
                json = await b64UrlToGunzip(z);
            } else {
                // cid-only link — pull payload from the content-addressed
                // server store. Never trust what the server returns
                // blindly; re-hash it and match against the URL's CID.
                json = await fetchShare(cid);
            }
            if (json) {
                const payload = JSON.parse(json);
                const expectedCid = await computeCidForJsonLd(payload);
                if (expectedCid !== cid) {
                    console.warn('share CID mismatch', { url: cid, computed: expectedCid });
                } else {
                    return shareFromPayload(payload, cid);
                }
            } else if (!z) {
                // Live store said 404. Auto-restore from a persisted
                // snapshot if one still has this CID — the user clicked
                // an archived link, they want it loaded, no prompt
                // needed. Re-fetch + re-validate after the restore so
                // the rest of this function returns a real share like
                // any other path. If restore fails (no snapshot has it,
                // or transient error), fall back to the recovery prompt.
                try {
                    const restore = await fetch(`/api/archive-restore?cid=${encodeURIComponent(cid)}`,
                                                { method: 'POST' });
                    if (restore.ok) {
                        const j = await restore.json();
                        if (j.live) {
                            const refetch = await fetchShare(cid);
                            if (refetch) {
                                const payload = JSON.parse(refetch);
                                const expectedCid = await computeCidForJsonLd(payload);
                                if (expectedCid === cid) {
                                    // Stash for the welcome card to show
                                    // a brief "restored from snapshot X"
                                    // banner — non-blocking, informational.
                                    el._restoredFromSnapshot = j.source || null;
                                    el._showWelcomeOnSync = true;
                                    return shareFromPayload(payload, cid);
                                }
                            }
                        }
                    }
                    // Restore didn't yield a live envelope. Surface the
                    // prompt as a fallback so the user knows their link
                    // is at least findable in an archive.
                    const lookup = await fetch(`/api/archive-lookup?cid=${encodeURIComponent(cid)}`);
                    if (lookup.ok) {
                        const j = await lookup.json();
                        if (j.snapshots?.length) {
                            el._missingArchivedCid = { cid, snapshots: j.snapshots };
                            el._showWelcomeOnSync = true;
                        }
                    }
                } catch {}
            }
        } catch (err) {
            console.warn('share decode failed:', err);
        }
    }
    // Legacy full-project payload.
    const p = q.get('p');
    if (p) {
        const decoded = b64urlDecode(p);
        if (decoded && decoded.genre) return decoded;
    }
    const g = q.get('g');
    if (!g) return null;
    const out = { genre: g, params: {} };
    const s = q.get('s');
    if (s !== null && !Number.isNaN(parseInt(s, 10))) out.params.seed = parseInt(s, 10);
    const st = q.get('structure');
    if (st) out.params.structure = st;
    const t = q.get('t');
    if (t) {
        const traits = b64urlDecode(t);
        if (traits && typeof traits === 'object') Object.assign(out.params, traits);
    }
    return out;
}

// Lower a `share-v1` payload to the `{ genre, params, overrides }`
// shape the boot path already consumes. Overrides are stashed and
// applied after the worker returns project-sync.
export function shareFromPayload(payload, cid) {
    const params = {};
    if (typeof payload.seed === 'number') params.seed = payload.seed;
    if (payload.structure) params.structure = payload.structure;
    if (payload.traits && typeof payload.traits === 'object') Object.assign(params, payload.traits);
    const overrides = {};
    if (payload.tracks) overrides.tracks = payload.tracks;
    if (payload.fx) overrides.fx = payload.fx;
    if (payload.feel) overrides.feel = payload.feel;
    if (payload.autoDj) overrides.autoDj = payload.autoDj;
    if (payload.macrosDisabled) overrides.macrosDisabled = payload.macrosDisabled;
    if (payload.initialMutes) overrides.initialMutes = payload.initialMutes;
    if (typeof payload.tempo === 'number') overrides.tempo = payload.tempo;
    if (typeof payload.swing === 'number') overrides.swing = payload.swing;
    if (typeof payload.humanize === 'number') overrides.humanize = payload.humanize;
    if (typeof payload.note === 'string') overrides.note = payload.note;
    return {
        genre: payload.genre,
        name: payload.name || null,
        params,
        overrides: Object.keys(overrides).length ? overrides : null,
        // Raw nets escape hatch — present only when the payload author
        // couldn't reduce the project to (genre, seed) + overrides.
        // The boot path skips `generate` and goes straight to
        // `project-load` when this is set.
        nets: payload.nets || null,
        // Arrangement directive — when set (and not "loop"), the boot
        // path calls /api/arrange after loading raw nets to expand the
        // track into structured sections. Deterministic via arrangeSeed.
        structure: payload.structure || null,
        arrangeSeed: typeof payload.arrangeSeed === 'number' ? payload.arrangeSeed : null,
        velocityDeltas: payload.velocityDeltas || null,
        maxVariants: typeof payload.maxVariants === 'number' ? payload.maxVariants : null,
        fadeIn: Array.isArray(payload.fadeIn) ? payload.fadeIn : null,
        drumBreak: typeof payload.drumBreak === 'number' ? payload.drumBreak : null,
        sections: Array.isArray(payload.sections) ? payload.sections : null,
        feelCurve: Array.isArray(payload.feelCurve) ? payload.feelCurve : null,
        macroCurve: Array.isArray(payload.macroCurve) ? payload.macroCurve : null,
        // CID is threaded through so hand-authored payloads without
        // an explicit `name` can derive a deterministic one from it.
        cid: cid || null,
        // Provenance chain — list of CIDs this payload was derived
        // from. Carried forward by the Share collector when the user
        // re-shares so the parent CID isn't lost.
        parents: Array.isArray(payload.parents) ? payload.parents : null,
    };
}

// --- URL build + upload ---

// Returns both URL forms so the share modal can let the user toggle.
// `stored` reflects whether the canonical bytes were accepted by the
// server store — if false, only `fullUrl` actually resolves (shortUrl
// would 404 from a fresh tab).
export async function buildShareUrlForms(el) {
    const base = `${location.origin}${location.pathname}`;
    const payload = buildSharePayload(el);
    if (!payload.genre || payload.seed == null) {
        const u = `${base}?g=${encodeURIComponent(payload.genre || 'techno')}`;
        return { shortUrl: u, fullUrl: u, stored: false, fallback: true };
    }
    const canonical = canonicalizeJSON(payload);
    const cid = await computeCidForJsonLd(payload);
    const stored = await uploadShare(cid, canonical);
    const shortUrl = `${base}?cid=${cid}`;
    const z = await gzipToB64Url(canonical);
    const fullUrl = `${base}?cid=${cid}&z=${z}`;
    if (stored) recordShared(cid, payload);
    return { shortUrl, fullUrl, stored, fallback: false };
}

// Back-compat: keep the original return-a-string entry point for
// callers that don't need the modal's toggle UX.
export async function buildShareUrl(el) {
    const { shortUrl, fullUrl, stored } = await buildShareUrlForms(el);
    return stored ? shortUrl : fullUrl;
}

export async function uploadShare(cid, canonical) {
    try {
        const res = await fetch(`/o/${cid}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/ld+json' },
            body: canonical,
        });
        return res.ok;
    } catch (err) {
        console.warn('share upload failed:', err);
        return false;
    }
}

export async function fetchShare(cid) {
    try {
        const res = await fetch(`/o/${cid}`, { headers: { Accept: 'application/ld+json' } });
        if (!res.ok) return null;
        return await res.text();
    } catch (err) {
        console.warn('share fetch failed:', err);
        return null;
    }
}

// --- Share modal ---

export async function onShareClick(el) {
    const forms = await buildShareUrlForms(el);
    const { shortUrl, fullUrl, stored, fallback } = forms;
    // If the server store accepted the upload we default to the short
    // CID-only URL; if not, the inline form is forced (and the toggle
    // is hidden) because the short URL would 404 elsewhere.
    const hasInlineChoice = stored && !fallback;
    // CID for the share-card / og:image endpoint. Only non-empty when
    // the payload actually made it to the server store — otherwise the
    // SVG endpoint would 404.
    const cid = stored ? new URL(shortUrl).searchParams.get('cid') : '';
    const overlay = document.createElement('div');
    overlay.className = 'pn-modal-overlay';
    const inlineSize = Math.round(fullUrl.length / 1024 * 10) / 10;
    overlay.innerHTML = `
        <div class="pn-modal pn-share-modal">
            <h2>Share track</h2>
            <p class="pn-modal-desc">Anyone opening this link gets the same track — genre, seed, mix, instruments, FX, Feel, Auto-DJ and macro toggles all reproduce exactly.</p>
            <label class="pn-share-title-row">
                <span>Title (optional):</span>
                <input type="text" class="pn-share-title" maxlength="60" placeholder="e.g. Friday Night Drop">
            </label>
            <div class="pn-modal-row">
                <input type="text" class="pn-share-url" readonly value="">
            </div>
            ${hasInlineChoice ? `
            <label class="pn-share-inline-toggle">
                <span>Store:</span>
                <select class="pn-share-storage">
                    <option value="server" selected>Server (short link)</option>
                    <option value="url">URL (self-contained, ~${inlineSize} KB)</option>
                </select>
            </label>
            <p class="pn-modal-hint pn-share-inline-why">
                <strong>Server</strong> (default): short link, the track lives in this site's share store. Best for chat, QR codes, and most everyday sharing.<br>
                <strong>URL</strong>: self-contained — every byte of the track travels in the URL itself. Opens offline, from a local copy of the page, or if the share store is ever purged. Good for archives and long-term preservation.
            </p>
            ` : (fallback ? '' : `
            <p class="pn-modal-hint">
                Server store upload failed, so the track data is embedded in the link itself. It's long but self-contained — anyone opening it gets the exact track, no lookup required.
            </p>
            `)}
            ${cid ? `
            <div class="pn-share-preview" title="Social-media preview card. Link unfurlers (Slack, Twitter, iMessage) render this image and the title/description above the link.">
                <img class="pn-share-preview-img" alt="Share card preview" src="/share-card/${cid}.svg" loading="lazy">
            </div>
            <div class="pn-share-audio" data-state="probing" style="margin-top:12px;padding:10px 12px;background:#0a0a0a;border:1px solid #1a1a1a;border-radius:6px;font-size:13px;color:#aaa">
                <span class="pn-share-audio-status">Checking pre-rendered audio…</span>
            </div>
            ` : ''}
            <p class="pn-share-license" style="margin:10px 0 0;font-size:11px;color:#777;letter-spacing:0.04em">
                Tracks are licensed
                <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener" style="color:#9ad;text-decoration:none">CC BY 4.0</a>
                — recipients may reuse with attribution to beats.bitwrap.io.
            </p>
            <div class="pn-modal-actions">
                <button class="cancel close">Close</button>
                <button class="save copy">Copy link</button>
            </div>
        </div>
    `;
    el.appendChild(overlay);
    const input = overlay.querySelector('.pn-share-url');
    const sel = overlay.querySelector('.pn-share-storage');
    const titleInput = overlay.querySelector('.pn-share-title');
    const preview = overlay.querySelector('.pn-share-preview-img');
    // If the user opened a `?title=…` link, prefill the modal title
    // so it round-trips when they re-share. Mirrors the server's
    // sanitizeTitle (60-char cap, control chars stripped).
    const incomingTitle = (new URLSearchParams(location.search).get('title') || '')
        .replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 60);
    if (incomingTitle) titleInput.value = incomingTitle;
    if (cid) {
        wireShareAudioStatus(el, overlay, cid, titleInput);
    }

    // Append `&title=…` (on short URL) or `?title=…` (on the card SVG)
    // so the title rides along but doesn't affect the CID — it's pure
    // presentation, consumed by the decorated-index handler + the SVG
    // renderer on the server.
    const withTitle = (url, title) => {
        if (!title) return url;
        const sep = url.includes('?') ? '&' : '?';
        return `${url}${sep}title=${encodeURIComponent(title)}`;
    };
    const render = () => {
        const wantInline = sel?.value === 'url';
        const baseUrl = (hasInlineChoice && wantInline) ? fullUrl : (stored ? shortUrl : fullUrl);
        const title = (titleInput?.value || '').trim();
        const url = withTitle(baseUrl, title);
        input.value = url;
        if (preview && cid) {
            preview.src = title
                ? `/share-card/${cid}.svg?title=${encodeURIComponent(title)}`
                : `/share-card/${cid}.svg`;
        }
        return url;
    };
    let currentUrl = render();
    sel?.addEventListener('change', () => { currentUrl = render(); });
    // Debounce the preview reload so fast typing doesn't spam the SVG
    // endpoint (each keystroke would otherwise issue a new GET).
    let titleDebounce = null;
    titleInput?.addEventListener('input', () => {
        if (titleDebounce) clearTimeout(titleDebounce);
        titleDebounce = setTimeout(() => { currentUrl = render(); }, 250);
    });
    input.focus();
    input.select();
    const copyBtn = overlay.querySelector('.copy');
    const flash = (ok) => {
        const prev = copyBtn.textContent;
        copyBtn.textContent = ok ? 'Copied ✓' : 'Copy failed';
        setTimeout(() => { copyBtn.textContent = prev; }, 1200);
    };
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target.classList.contains('close')) {
            overlay.remove();
            return;
        }
        if (e.target.classList.contains('copy')) {
            if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(currentUrl).then(() => flash(true), () => flash(false));
            } else {
                input.select();
                try { document.execCommand('copy'); flash(true); }
                catch { flash(false); }
            }
        }
    });
    overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); overlay.remove(); }
    });
}

// Track length ≈ render wall-clock (capture is realtime). Mirrors the
// renderer formula in render-mode.js: PPQ=4, fall back to 1024 ticks
// (≈ 64 bars @ PPQ 4) for loop-only payloads. Browser-boot + flush
// overhead (~10-15s on the 2-CPU prod host) pads the estimate.
function expectedRenderMs(el) {
    const PPQ = 4, LOOP_FALLBACK_TICKS = 1024, OVERHEAD_MS = 15000;
    const tempo = el._tempo || el._project?.tempo || 120;
    const totalSteps = el._totalSteps > 0 ? el._totalSteps : LOOP_FALLBACK_TICKS;
    return totalSteps * (60000 / (tempo * PPQ)) + OVERHEAD_MS;
}

// Drives the share modal's audio status block. Runs a state machine
// off /api/audio-status (cheap server-side; no disk IO beyond a Stat
// for the ready case, no render side-effect). Distinguishes:
//   - ready: cached file exists → embed player + download
//   - rendering: a sem slot is held → progress bar from elapsed/expected
//   - queued: waiting for a slot → "queued behind N, ~Ms wait"
//   - missing: nothing in flight → "Render now" button
function wireShareAudioStatus(el, overlay, cid, titleInput) {
    const audioBlock = overlay.querySelector('.pn-share-audio');
    const audioUrl = `${location.origin}/audio/${cid}.webm`;
    const statusUrl = `/api/audio-status?cid=${cid}`;
    const expectedMs = expectedRenderMs(el);
    let pollTimer = null, tickTimer = null;
    const stop = () => {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    };
    const obs = new MutationObserver(() => {
        if (!document.body.contains(overlay)) { stop(); obs.disconnect(); }
    });
    obs.observe(document.body, { childList: true, subtree: true });

    const fmtSec = (ms) => `${Math.max(0, Math.round(ms / 1000))}s`;
    const sizeKbStr = (bytes) => bytes ? ` · ${Math.round(bytes / 1024)} KB` : '';

    const showReady = (sizeBytes) => {
        stop();
        const fname = (titleInput?.value?.trim() || `beats-${cid.slice(0, 12)}`)
            .replace(/[^\w\-. ]+/g, '_').slice(0, 60) + '.webm';
        audioBlock.dataset.state = 'ready';
        audioBlock.innerHTML = `
            <div style="font-size:11px;color:#777;margin-bottom:6px;letter-spacing:0.06em;text-transform:uppercase">Pre-rendered audio${sizeKbStr(sizeBytes)}</div>
            <audio controls preload="none" src="${audioUrl}" style="width:100%;height:32px"></audio>
            <a href="${audioUrl}" download="${fname}" style="display:inline-block;margin-top:6px;font-size:12px;color:#9ad;text-decoration:none">⬇ Download .webm</a>
        `;
        // Stop the live Tone.js engine before pre-rendered audio
        // starts — otherwise the user hears both at once. The webm
        // is the canonical audio for an already-rendered share.
        audioBlock.querySelector('audio').addEventListener('play', () => {
            if (el._playing) el._togglePlay();
        });
        // Tag local history with the rendered action so the user
        // can find tracks they've successfully rendered later.
        recordRendered(cid, buildSharePayload(el));
    };

    const showMissing = () => {
        stop();
        // Production runs without server-side rendering — opening the
        // Share modal is the trigger to render in-tab and PUT the .webm
        // back. Until that upload lands, the track does NOT appear on
        // the feed (the index is populated by the audio ingest hook).
        // So: if MediaRecorder is available, auto-start the local render
        // immediately. If not, fall back to a static notice — the user
        // will need a desktop browser to publish.
        if (isClientRenderSupported()) {
            runLocalRender();
            return;
        }
        audioBlock.dataset.state = 'missing-unsupported';
        audioBlock.innerHTML = `
            <div style="color:#aaa;font-size:13px">Audio rendering isn't supported in this browser.</div>
            <div style="font-size:11px;color:#777;margin-top:4px">Open the share link in a desktop Chrome/Firefox tab and the track will render + publish to the feed automatically.</div>
        `;
    };

    // Inline "or render in this tab" affordance for the queued / rendering
    // states — lets the user skip the server queue entirely instead of
    // staring at a wait timer. Returns empty when MediaRecorder isn't
    // available so Safari iOS doesn't see a dead link.
    const localRenderLink = () => {
        if (!isClientRenderSupported()) return '';
        return `
            <div style="margin-top:8px;font-size:11px;color:#777">
                Or
                <a href="#" class="pn-share-local-link" style="color:#9ad;text-decoration:none">render in this tab now</a>
                — keeps the server queue free.
            </div>
        `;
    };
    const wireLocalRenderLink = () => {
        const link = audioBlock.querySelector('.pn-share-local-link');
        if (!link) return;
        link.addEventListener('click', (e) => {
            e.preventDefault();
            stop(); // we own the block now; halt server polling/timers
            runLocalRender();
        });
    };

    // Run an in-tab render of the currently-loaded project and trigger
    // a download. Same MediaRecorder pipeline the server uses
    // (lib/share/client-render.js). Identifies the file by the SAME
    // CID the share modal computed for the in-memory project, so what
    // the user downloads matches what they'd get from the server (modulo
    // any humanize/drift non-determinism between renders).
    function runLocalRender() {
        const fname = (titleInput?.value?.trim() || `beats-${cid.slice(0, 12)}`)
            .replace(/[^\w\-. ]+/g, '_').slice(0, 60) + '.webm';
        audioBlock.dataset.state = 'local-rendering';
        audioBlock.innerHTML = `
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
                <span style="font-size:11px;color:#888;letter-spacing:0.06em;text-transform:uppercase">Rendering in this tab</span>
                <span class="pn-share-local-eta" style="flex:1;color:#aaa;font-size:12px;font-variant-numeric:tabular-nums">starting…</span>
            </div>
            <div style="position:relative;height:6px;background:#1a1a1a;border-radius:3px;overflow:hidden">
                <div class="pn-share-local-bar" style="position:absolute;left:0;top:0;bottom:0;width:0%;background:linear-gradient(90deg,#0f3460,#9ad);transition:width 0.3s linear"></div>
            </div>
            <div style="font-size:11px;color:#666;margin-top:6px">Keep this tab visible until it finishes — backgrounded tabs throttle.</div>
            <div style="font-size:11px;color:#fbbf24;margin-top:6px">This track will only appear on the feed after the audio upload succeeds.</div>
        `;
        const bar = audioBlock.querySelector('.pn-share-local-bar');
        const eta = audioBlock.querySelector('.pn-share-local-eta');
        renderToBlob(el, {
            onProgress(ms, totalMs) {
                const pct = Math.min(99, 100 * ms / totalMs);
                bar.style.width = `${pct.toFixed(1)}%`;
                const remaining = Math.max(0, totalMs - ms);
                eta.textContent = remaining > 0
                    ? `~${fmtSec(remaining)} remaining`
                    : 'finishing up…';
            },
        }).then(async ({ blob }) => {
            bar.style.width = '100%';
            audioBlock.dataset.state = 'local-ready';
            audioBlock.innerHTML = `
                <div style="font-size:11px;color:#777;margin-bottom:6px;letter-spacing:0.06em;text-transform:uppercase">Local render${sizeKbStr(blob.size)}</div>
                <audio controls preload="none" style="width:100%;height:32px"></audio>
                <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
                    <a class="pn-share-local-dl" href="#" style="font-size:12px;color:#9ad;text-decoration:none">⬇ Download .webm</a>
                    <span style="color:#555;font-size:11px">·</span>
                    <span class="pn-share-upload-status" style="font-size:11px;color:#aaa">uploading to feed…</span>
                </div>
            `;
            const url = URL.createObjectURL(blob);
            audioBlock.querySelector('audio').src = url;
            audioBlock.querySelector('audio').addEventListener('play', () => {
                if (el._playing) el._togglePlay();
            });
            const dl = audioBlock.querySelector('.pn-share-local-dl');
            dl.addEventListener('click', (e) => {
                e.preventDefault();
                downloadBlob(blob, fname);
            });
            // Upload to /audio/{cid}.webm so the server's audio ingest
            // hook projects the share envelope into the index — the
            // track appears on the feed only after this PUT succeeds.
            const statusEl = audioBlock.querySelector('.pn-share-upload-status');
            try {
                const r = await uploadBlob(cid, blob);
                if (r.uploaded) {
                    statusEl.style.color = '#4ade80';
                    statusEl.textContent = '✓ Published to feed';
                    recordRendered(cid, buildSharePayload(el));
                } else if (r.status === 200) {
                    statusEl.style.color = '#9ad';
                    statusEl.textContent = '✓ Already on feed';
                    recordRendered(cid, buildSharePayload(el));
                } else if (r.status) {
                    statusEl.style.color = '#e94560';
                    statusEl.textContent = `Upload failed (HTTP ${r.status}) — track won't appear on feed`;
                } else {
                    statusEl.style.color = '#e94560';
                    statusEl.textContent = `Upload failed — track won't appear on feed`;
                }
            } catch (err) {
                statusEl.style.color = '#e94560';
                statusEl.textContent = `Upload failed — track won't appear on feed`;
            }
        }).catch((err) => {
            audioBlock.dataset.state = 'local-error';
            audioBlock.innerHTML = `
                <div style="color:#e94560;font-size:13px">Local render failed: ${(err && err.message) || err}</div>
                <div style="font-size:11px;color:#666;margin-top:4px">Try the server queue instead.</div>
            `;
        });
    }

    const showQueued = (st) => {
        audioBlock.dataset.state = 'queued';
        const pos = st.queuePosition || 1;
        const ahead = pos > 1 ? ` (${pos - 1} ahead)` : '';
        // "queued ~0s until rendering" reads like a glitch — when the
        // wait is sub-second the slot is just about to free. Show
        // "starting…" for the (usually brief) gap until the next
        // poll catches the queued→rendering transition.
        const waitMs = st.waitMs || 0;
        const waitText = waitMs < 1000 ? 'starting…' : `~${fmtSec(waitMs)} until rendering`;
        audioBlock.innerHTML = `
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
                <span style="font-size:11px;color:#888;letter-spacing:0.06em;text-transform:uppercase">Queued${ahead}</span>
                <span class="pn-share-audio-eta" style="flex:1;color:#aaa;font-size:12px;font-variant-numeric:tabular-nums">${waitText}</span>
            </div>
            <div style="position:relative;height:6px;background:#1a1a1a;border-radius:3px;overflow:hidden">
                <div style="position:absolute;left:0;top:0;bottom:0;width:100%;background:repeating-linear-gradient(45deg,#1a1a2e 0,#1a1a2e 6px,#0f3460 6px,#0f3460 12px);opacity:0.6"></div>
            </div>
            ${localRenderLink()}
        `;
        wireLocalRenderLink();
    };

    // Once Status returns "rendering" we get a server-authoritative
    // start time (ElapsedMs) and switch to a determinate progress bar.
    // Local tickTimer interpolates between server polls so the bar
    // doesn't visibly jump every 5 seconds.
    const showRendering = (st) => {
        const renderingStartedAt = Date.now() - (st.elapsedMs || 0);
        const trackExpected = st.expectedMs > 0 ? st.expectedMs : expectedMs;
        audioBlock.dataset.state = 'rendering';
        audioBlock.innerHTML = `
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
                <span style="font-size:11px;color:#888;letter-spacing:0.06em;text-transform:uppercase">Rendering</span>
                <span class="pn-share-audio-eta" style="flex:1;color:#aaa;font-size:12px;font-variant-numeric:tabular-nums"></span>
            </div>
            <div style="position:relative;height:6px;background:#1a1a1a;border-radius:3px;overflow:hidden">
                <div class="pn-share-audio-bar" style="position:absolute;left:0;top:0;bottom:0;width:0%;background:linear-gradient(90deg,#0f3460,#e94560);transition:width 0.5s linear"></div>
            </div>
            ${localRenderLink()}
        `;
        wireLocalRenderLink();
        const bar = audioBlock.querySelector('.pn-share-audio-bar');
        const eta = audioBlock.querySelector('.pn-share-audio-eta');
        if (tickTimer) clearInterval(tickTimer);
        const tick = () => {
            const elapsed = Date.now() - renderingStartedAt;
            const pct = Math.min(95, (elapsed / trackExpected) * 95);
            bar.style.width = `${pct.toFixed(1)}%`;
            const remaining = trackExpected - elapsed;
            eta.textContent = remaining > 0
                ? `~${fmtSec(remaining)} remaining`
                : 'finishing up…';
        };
        tick();
        tickTimer = setInterval(tick, 500);
    };

    const handleStatus = (st) => {
        switch (st.state) {
            case 'ready':
                if (audioBlock.dataset.state === 'rendering') {
                    const bar = audioBlock.querySelector('.pn-share-audio-bar');
                    if (bar) bar.style.width = '100%';
                }
                setTimeout(() => showReady(st.sizeBytes || 0), audioBlock.dataset.state === 'rendering' ? 400 : 0);
                break;
            case 'rendering':
                if (audioBlock.dataset.state !== 'rendering') showRendering(st);
                break;
            case 'queued':
                showQueued(st);
                break;
            case 'missing':
                if (audioBlock.dataset.state !== 'missing') showMissing();
                break;
        }
    };

    const poll = async () => {
        try {
            const r = await fetch(statusUrl);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const st = await r.json();
            handleStatus(st);
        } catch (err) {
            // Don't kill polling on transient errors.
        }
    };
    const startPolling = () => {
        if (pollTimer) return;
        // Faster initial cadence right after a queue action so the
        // user sees the queued→rendering transition without a 5s lag.
        pollTimer = setInterval(poll, 3000);
    };

    // Initial probe — poll() is the single source of truth, so we just
    // start polling immediately and let the first response render.
    audioBlock.querySelector('.pn-share-audio-status').textContent =
        'Checking pre-rendered audio…';
    poll().then(() => {
        // Only keep polling if not already in a terminal state.
        if (audioBlock.dataset.state !== 'ready') startPolling();
    });
}

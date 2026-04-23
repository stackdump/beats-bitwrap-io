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
                    return shareFromPayload(payload);
                }
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
export function shareFromPayload(payload) {
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
    return {
        genre: payload.genre,
        params,
        overrides: Object.keys(overrides).length ? overrides : null,
        // Raw nets escape hatch — present only when the payload author
        // couldn't reduce the project to (genre, seed) + overrides.
        // The boot path skips `generate` and goes straight to
        // `project-load` when this is set.
        nets: payload.nets || null,
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
            ` : ''}
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

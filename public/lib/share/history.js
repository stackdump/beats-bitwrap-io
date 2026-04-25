// Personal track history. localStorage-backed, capped at MAX_ENTRIES
// (LRU on seenAt). Records share / render / seen events on the
// current device only — never reaches the server.

const KEY = 'pn-history';
const MAX_ENTRIES = 200;

// Read the history list, newest first. Returns [] on empty / parse
// failure (treats a corrupt blob as "no history" rather than
// throwing — this surface should never block the rest of the app).
export function listHistory() {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}

export function clearHistory() {
    localStorage.removeItem(KEY);
}

// Upsert helper used by the three record* functions. Given a CID and
// a partial entry, merges into the existing row (preserving fields
// not provided), bumps seenAt, and adds the action tag if any.
function upsert(cid, fields, action) {
    if (!cid || typeof cid !== 'string') return;
    const list = listHistory();
    const now = Date.now();
    const i = list.findIndex(e => e.cid === cid);
    let entry;
    if (i >= 0) {
        entry = list[i];
        list.splice(i, 1);
        // Don't overwrite a non-empty existing field with an empty
        // incoming one. Keeps the first-known title, etc.
        for (const [k, v] of Object.entries(fields)) {
            if (v != null && v !== '') entry[k] = v;
        }
    } else {
        entry = { cid, ...fields };
    }
    entry.seenAt = now;
    if (action) {
        const set = new Set(entry.actions || []);
        set.add(action);
        entry.actions = [...set];
    }
    list.unshift(entry);
    if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES;
    try {
        localStorage.setItem(KEY, JSON.stringify(list));
    } catch {
        // Quota exceeded? Trim aggressively and retry once.
        list.length = Math.max(50, Math.floor(list.length / 2));
        try { localStorage.setItem(KEY, JSON.stringify(list)); } catch {}
    }
}

// Called from the share modal once a CID is sealed to the server
// store. payload is the BeatsShare envelope; pull the displayable
// fields off it.
export function recordShared(cid, payload) {
    upsert(cid, projectPayload(payload), 'shared');
}

// Called when the share modal's audio status flips to 'ready' for
// the current page's CID — i.e. an audio render exists for it.
export function recordRendered(cid, payload) {
    upsert(cid, projectPayload(payload), 'rendered');
}

// Called from the boot path when a ?cid= URL loads — covers "I
// followed a link, now I want to find it again". No action tag; just
// bumps seenAt + captures the current payload fields.
export function recordSeen(cid, payload) {
    upsert(cid, projectPayload(payload), null);
}

// Explicit bookmark — fired from the feed-card ★ button. Distinct
// action tag so the history view can badge it differently from
// shared / rendered / seen.
export function recordBookmarked(cid, payload) {
    upsert(cid, projectPayload(payload), 'bookmarked');
}

// Remove the bookmarked tag (and the entry entirely if it was the
// only action). The toggle counterpart to recordBookmarked.
export function unrecordBookmarked(cid) {
    if (!cid) return;
    const list = listHistory();
    const i = list.findIndex(e => e.cid === cid);
    if (i < 0) return;
    const entry = list[i];
    const actions = (entry.actions || []).filter(a => a !== 'bookmarked');
    list.splice(i, 1);
    if (actions.length > 0) {
        entry.actions = actions;
        list.unshift(entry);
    }
    // else: drop the row entirely
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch {}
}

// Quick lookup — used by the feed card to render the ★ in the
// correct state on first paint.
export function isBookmarked(cid) {
    const list = listHistory();
    const e = list.find(x => x.cid === cid);
    return !!(e && (e.actions || []).includes('bookmarked'));
}

function projectPayload(p) {
    if (!p || typeof p !== 'object') return {};
    return {
        name:  p.name || '',
        genre: p.genre || '',
        tempo: typeof p.tempo === 'number' ? p.tempo : null,
        seed:  typeof p.seed === 'number' ? p.seed : null,
    };
}

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

function projectPayload(p) {
    if (!p || typeof p !== 'object') return {};
    return {
        name:  p.name || '',
        genre: p.genre || '',
        tempo: typeof p.tempo === 'number' ? p.tempo : null,
        seed:  typeof p.seed === 'number' ? p.seed : null,
    };
}

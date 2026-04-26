// Per-track note sanitiser. Mirrors internal/share/note.go::SanitizeNote
// rule-for-rule so the Go server's seal-time check rejects nothing the
// browser produced. Edit BOTH files in lock-step.
//
// Filtering rules (applied in order):
//   1. Strip HTML tags / angle-bracket markup.
//   2. Strip URLs (scheme-prefixed and bare www.).
//   3. Strip control chars except newline / tab.
//   4. Drop runes that aren't printable (zero-width joiners,
//      RTL overrides, etc.).
//   5. Trim each line; collapse runs of >=2 newlines to one.
//   6. Trim leading / trailing whitespace overall.
//   7. Hard cap at 280 runes (= NoteMaxRunes).

export const NOTE_MAX_RUNES = 280;

// HTML-ish tags. Greedy enough to strip "<a href=...>" + "</a>" and
// "<script>...</script>"; doesn't try to parse HTML.
const TAG_RE = /<[^>]*>/g;
// Scheme-prefixed URLs.
const URL_SCHEME_RE = /\b(?:https?|ftp|data|javascript|mailto):\S+/gi;
// Bare www.-prefixed URLs.
const URL_WWW_RE = /\bwww\.\S+/gi;
// Multiple consecutive blank lines → collapse to one.
const COLLAPSE_BLANKS_RE = /\n{2,}/g;

// Runes considered "non-printable" for our purposes. We can't easily
// reach the Unicode category tables from JS without ICU, so we rely on
// a property regex (\p{C} covers Cc/Cf/Cs/Co/Cn — control / format /
// surrogate / private-use / unassigned). Newline + tab are added back.
const NON_PRINTABLE_RE = /[\p{C}]/gu;

// liveScrubNote strips the dangerous shapes (tags / URLs / non-printables)
// but DOES NOT trim whitespace — used by the textarea on every input
// event so the user can type "hello world" without the trailing space
// being eaten before they reach the second word. The full sanitiseNote
// runs again at Share time to bring the canonical form into alignment
// with the Go server's SanitizeNote.
export function liveScrubNote(s) {
    if (!s) return '';
    s = s.replace(TAG_RE, '');
    s = s.replace(URL_SCHEME_RE, '').replace(URL_WWW_RE, '');
    s = s.replace(NON_PRINTABLE_RE, (ch) => (ch === '\n' || ch === '\t' ? ch : ''));
    // Hard cap by runes — keep as a hard stop even live.
    if ([...s].length > NOTE_MAX_RUNES) {
        s = [...s].slice(0, NOTE_MAX_RUNES).join('');
    }
    return s;
}

export function sanitizeNote(s) {
    if (!s) return '';
    s = liveScrubNote(s);
    // Trim each line, collapse blank-line runs, overall trim.
    s = s.split('\n').map((line) => line.trim()).join('\n');
    s = s.replace(COLLAPSE_BLANKS_RE, '\n');
    s = s.trim();
    if ([...s].length > NOTE_MAX_RUNES) {
        s = [...s].slice(0, NOTE_MAX_RUNES).join('').trim();
    }
    return s;
}

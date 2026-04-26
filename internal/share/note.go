package share

// SanitizeNote is the authoritative server-side sanitiser for the
// per-track `note` field on share-v1 envelopes. The frontend
// (`public/lib/note/note.js`) mirrors these rules so the textarea
// scrubs paste in real time, but this Go function is the single
// source of truth — the server canonicalises the post-sanitised
// text into the share envelope, and that's what the CID hashes.
//
// Filtering rules, applied in order:
//
//  1. Strip HTML tags / angle-bracket markup ("<...>").
//  2. Strip URLs (scheme-prefixed and www.-prefixed shapes).
//  3. Strip control chars except newline / tab.
//  4. Drop runes that aren't printable per unicode.IsPrint
//     (keeps newlines, tabs, plain whitespace) — blocks zero-width
//     joiners / RTL overrides commonly used for spoofing.
//  5. Collapse runs of >=2 newlines down to one.
//  6. Trim trailing/leading whitespace per line and overall.
//  7. Hard length cap (post-trim) at NoteMaxRunes runes.
//
// Returns the cleaned string. Empty string means "no note" — the
// envelope omits the field entirely so two tracks with identical
// music and only-whitespace notes share the same CID.

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// NoteMaxRunes is the hard cap on the sanitised note length.
// Mirrored on the frontend as the textarea's maxlength attribute.
const NoteMaxRunes = 280

var (
	noteTagRE = regexp.MustCompile(`<[^>]*>`)
	// Scheme-prefixed URLs: http(s), ftp, data:, javascript:, mailto:.
	noteURLRE = regexp.MustCompile(`(?i)\b(?:https?|ftp|data|javascript|mailto):\S+`)
	// Bare www.-prefixed URLs without a scheme.
	noteWWWRE = regexp.MustCompile(`(?i)\bwww\.\S+`)
	// Multiple consecutive blank lines → collapse to one.
	noteCollapseRE = regexp.MustCompile(`\n{2,}`)
)

func SanitizeNote(s string) string {
	if s == "" {
		return ""
	}
	s = noteTagRE.ReplaceAllString(s, "")
	s = noteURLRE.ReplaceAllString(s, "")
	s = noteWWWRE.ReplaceAllString(s, "")

	// Filter runes: keep printable + newline + tab; drop everything else.
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if r == '\n' || r == '\t' {
			b.WriteRune(r)
			continue
		}
		if unicode.IsPrint(r) {
			b.WriteRune(r)
		}
	}
	s = b.String()

	// Trim each line, then collapse runs of blank lines.
	lines := strings.Split(s, "\n")
	for i, line := range lines {
		lines[i] = strings.TrimSpace(line)
	}
	s = strings.Join(lines, "\n")
	s = noteCollapseRE.ReplaceAllString(s, "\n")
	s = strings.TrimSpace(s)

	if utf8.RuneCountInString(s) > NoteMaxRunes {
		// Trim by rune count, not bytes — protects against splitting
		// multi-byte sequences and exceeding the cap on a downstream
		// consumer that counts runes (the schema validator does).
		runes := []rune(s)
		s = string(runes[:NoteMaxRunes])
		s = strings.TrimSpace(s)
	}
	return s
}

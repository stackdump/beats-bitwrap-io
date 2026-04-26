package share

import (
	"strings"
	"testing"
)

func TestSanitizeNote(t *testing.T) {
	cases := []struct {
		name, in, want string
	}{
		{"empty", "", ""},
		{"plain", "a chill bossa loop", "a chill bossa loop"},
		{"strip script tag",
			`<script>alert(1)</script>chill`,
			"alert(1)chill"},
		{"strip anchor and url",
			`<a href="https://evil.example">click</a>`,
			"click"},
		{"strip bare https url",
			"check out https://evil.example/path?q=1 nice",
			"check out  nice"},
		{"strip http url",
			"http://example.com/x is fine",
			"is fine"},
		{"strip www-prefixed url",
			"see www.example.com/x for more",
			"see  for more"},
		{"strip mailto",
			"hit me up at mailto:nobody@example.com",
			"hit me up at"},
		{"strip javascript scheme",
			"javascript:alert(1) hi",
			"hi"},
		{"strip data url",
			"data:text/html,<h1>x</h1> bye",
			"bye"},
		{"strip control chars",
			"line1\x00\x07line2",
			"line1line2"},
		{"strip leading tab via per-line trim",
			"line1\n\tindented",
			"line1\nindented"},
		{"strip zero-width joiner",
			"a‍b",
			"ab"},
		{"strip RTL override",
			"safe‮text",
			"safetext"},
		{"collapse blank lines",
			"a\n\n\n\nb",
			"a\nb"},
		{"trim per line",
			"  hi  \n   bye   ",
			"hi\nbye"},
		{"hard cap at 280 runes",
			strings.Repeat("x", 400),
			strings.Repeat("x", 280)},
		{"hard cap counts runes not bytes",
			strings.Repeat("é", 400),
			strings.Repeat("é", 280)},
		{"only-whitespace becomes empty",
			"   \n\t  \n   ",
			""},
		{"mixed everything",
			`Visit <a href="https://evil.example">us</a>! Mail mailto:x@y.example Use www.spam.test bye`,
			"Visit us! Mail  Use  bye"},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			got := SanitizeNote(c.in)
			if got != c.want {
				t.Errorf("SanitizeNote(%q)\n got: %q\nwant: %q", c.in, got, c.want)
			}
		})
	}
}

func TestSanitizeNoteIsIdempotent(t *testing.T) {
	// Sanitising a sanitised note must be a no-op — if it weren't,
	// re-canonicalising a stored payload would produce a different CID.
	for _, in := range []string{
		"",
		"plain text",
		`<script>x</script> https://x.example chunky bass`,
		strings.Repeat("y", 500),
		"line one\n\nline two\n\n\nline three",
	} {
		first := SanitizeNote(in)
		second := SanitizeNote(first)
		if first != second {
			t.Errorf("SanitizeNote not idempotent for %q\nfirst:  %q\nsecond: %q",
				in, first, second)
		}
	}
}

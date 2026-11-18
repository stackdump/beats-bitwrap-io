package card

import (
	"strings"
	"testing"
)

func lines(s string) []string { return strings.Split(strings.TrimRight(s, "\n"), "\n") }

func texts(r []rline) []string {
	var o []string
	for _, l := range r {
		o = append(o, l.text)
	}
	return o
}

const progDrop = `tempo 120
key am
let k = x ~ ~ ~ x ~ ~ ~
let b = a1 ~ a1 ~
def groove(deck) {
  deck $deck: kick k | bass b
}
section intro 4 bars {
  deck A: kick k
}
section drop 8 bars {
  groove(A)
  master: filter off
}
arrange intro drop
`

func TestRegionPrefersDrop(t *testing.T) {
	r, sec := pickRegion(lines(progDrop))
	if sec != "drop" {
		t.Fatalf("section = %q", sec)
	}
	got := strings.Join(texts(r), "\n")
	if !strings.Contains(got, "section drop 8 bars {") || strings.Contains(got, "section intro") {
		t.Fatalf("region is not the drop section:\n%s", got)
	}
	// a short section is padded with what it calls: the def and its lets
	if !strings.Contains(got, "def groove(deck) {") || !strings.Contains(got, "let k = ") {
		t.Fatalf("short drop was not padded with the def and let it uses:\n%s", got)
	}
	if len(r) > MaxLines {
		t.Fatalf("%d lines", len(r))
	}
}

const progMostParts = `tempo 120
section a 4 bars {
  deck A: kick x ~ x ~
}
section b 4 bars {
  deck A: kick x ~ x ~ | snare ~ x ~ x
  deck B: bass a1 ~ a1 ~ | pad c3
}
section c 4 bars {
  deck A: kick x
}
`

func TestRegionMostParts(t *testing.T) {
	r, sec := pickRegion(lines(progMostParts))
	if sec != "b" {
		t.Fatalf("picked %q, want the section with the most parts (b)", sec)
	}
	if got := strings.Join(texts(r), "\n"); !strings.Contains(got, "section b 4 bars {") {
		t.Fatalf("%s", got)
	}
}

func TestRegionFirstDefThenFirstLines(t *testing.T) {
	r, sec := pickRegion(lines("tempo 100\nlet k = x ~ x ~\ndef g(a) {\n  deck $a: kick k\n}\ndeck A: kick k\n"))
	if sec != "" || !strings.HasPrefix(texts(r)[0], "def g(a)") && !strings.Contains(strings.Join(texts(r), "\n"), "def g(a) {") {
		t.Fatalf("no sections: want the first def, got %q", texts(r))
	}
	// no section, no def: the first lines
	var b strings.Builder
	for i := 0; i < 30; i++ {
		b.WriteString("deck A: kick x ~ x ~\n")
	}
	r, _ = pickRegion(lines(b.String()))
	if len(r) != MaxLines || r[0].idx != 0 || r[MaxLines-1].idx != MaxLines-1 {
		t.Fatalf("first-lines region: %d lines, idx %d..%d", len(r), r[0].idx, r[len(r)-1].idx)
	}
}

func TestRegionNeverOverTwelve(t *testing.T) {
	var b strings.Builder
	b.WriteString("section drop 8 bars {\n")
	for i := 0; i < 40; i++ {
		b.WriteString("  deck A: kick x ~ x ~\n")
	}
	b.WriteString("}\n")
	r, _ := pickRegion(lines(b.String()))
	if len(r) > MaxLines {
		t.Fatalf("%d lines", len(r))
	}
	if r[0].text != "section drop 8 bars {" || r[len(r)-1].text != "}" {
		t.Fatalf("a long block keeps its header and its closing brace: %q ... %q", r[0].text, r[len(r)-1].text)
	}
}

func TestScanBlocksNested(t *testing.T) {
	bl := scanBlocks(lines("section s 4 bars {\n  evolve every 4 bars {\n    stop when gen == 2\n  }\n  deck A: kick x\n}\nlet a = x\n"))
	if len(bl) != 2 || bl[0].kind != "section" || bl[0].end != 5 || bl[1].kind != "let" || bl[1].name != "a" {
		t.Fatalf("%+v", bl)
	}
}

func TestHitTokens(t *testing.T) {
	got := hitTokens("let w = f1! ~ g#1^ [c4 d#4] <chord(fm) x*2> inst=pwm-lead vel=70..100 # x a1")
	var toks []string
	rs := []rune("let w = f1! ~ g#1^ [c4 d#4] <chord(fm) x*2> inst=pwm-lead vel=70..100 # x a1")
	for _, h := range got {
		toks = append(toks, string(rs[h.col:h.col+h.n]))
	}
	want := "f1! g#1^ c4 d#4 chord(fm) x*2"
	if strings.Join(toks, " ") != want {
		t.Fatalf("hit tokens = %q, want %q", strings.Join(toks, " "), want)
	}
	if len(hitTokens(`wheel sequence notes="C5 Ab4 x"`)) != 0 {
		t.Fatal("tokens inside a quoted string are not hits")
	}
}

func TestRampAndPartLines(t *testing.T) {
	if !isRampLine("  master: filter lp 300 -> 2800 over 8 bars") || isRampLine("master: reverb 0.3") {
		t.Fatal("ramp line detection")
	}
	for _, l := range []string{"  deck A: kick x", "  groove(A, 16)", "riser(8, drop)"} {
		if !isPartLine(l) {
			t.Fatalf("%q is a part line", l)
		}
	}
	for _, l := range []string{"def groove(deck, bars) {", "  master: filter off", "repeat 4 every 1 bars {"} {
		if isPartLine(l) {
			t.Fatalf("%q is not a part line", l)
		}
	}
}

func TestSmallHelpers(t *testing.T) {
	if got := shortCID("z4EBG9jB3vwMeCJNSp8WJLWDRM7ADEWxi23HyNSij5cHBL94r7v"); got != "z4EBG9…7v" {
		t.Fatalf("shortCID = %q", got)
	}
	for in, want := range map[string]string{"fm": "F minor", "c": "C major", "d#": "D♯ major", "d:dorian": "D dorian", "a#m": "A♯ minor", "": "", "weird": "weird"} {
		if got := keyLabel(in); got != want {
			t.Errorf("keyLabel(%q) = %q, want %q", in, got, want)
		}
	}
	if got := truncRunes("héllo wörld", 6); got != "héllo…" {
		t.Fatalf("truncRunes = %q", got)
	}
	if got := cleanText("  a\n\tb\x00c  ", 10); got != "a b c" {
		t.Fatalf("cleanText = %q", got)
	}
	if clock(116.571) != "1:57" || fmtBPM(140) != "140" || fmtBPM(87.5) != "87.5" {
		t.Fatal("clock / fmtBPM")
	}
	for in, want := range map[string]string{"": "CC0", "CC0-1.0": "CC0", "CC-BY-4.0": "CC BY 4.0", "MIT": "MIT"} {
		if got := licenseBadge(in); got != want {
			t.Errorf("licenseBadge(%q) = %q, want %q", in, got, want)
		}
	}
	m := headerMeta("#! btw 1\n#! name: my track\n#! license: CC-BY-4.0\n#! visibility: private\n# a comment\ntempo 120\n#! name: late\n")
	if m.Name != "my track" || m.License != "CC-BY-4.0" || m.Visibility != "private" {
		t.Fatalf("headerMeta = %+v", m)
	}
	if got := firstComment("#! name: x\n# the first line\n# the second\ntempo 1\n"); got != "the first line" {
		t.Fatalf("firstComment = %q", got)
	}
}

func TestSeededMarkersAreStable(t *testing.T) {
	a, b := newRNG("z4EBG9"), newRNG("z4EBG9")
	c := newRNG("z4EBG8")
	same, diff := true, false
	for i := 0; i < 8; i++ {
		x, y, z := a.next(), b.next(), c.next()
		same = same && x == y
		diff = diff || x != z
	}
	if !same || !diff {
		t.Fatalf("rng: same seed same stream=%v, different seed differs=%v", same, diff)
	}
}

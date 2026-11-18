package card

import (
	"fmt"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"beats-bitwrap-io/internal/btwsite/api"
)

// A tiny lexer for two jobs: colouring a program when the checker gave no highlight spans (the fake in tests,
// or btwd failing), and finding the hit tokens the card lights. It is not the language: btwd's spans are
// preferred whenever there are any.

var keywords = map[string]bool{
	"deck": true, "master": true, "every": true, "on": true, "at": true, "bar": true, "bars": true, "phrase": true,
	"over": true, "tempo": true, "key": true, "swing": true, "with": true, "pairs": true, "pair": true, "group": true,
	"bpm": true, "section": true, "def": true, "let": true, "repeat": true, "arrange": true, "end": true, "after": true,
	"evolve": true, "before": true, "stop": true, "when": true, "import": true, "use": true, "sample": true,
	"loop": true, "now": true, "for": true, "in": true,
}

var roles = map[string]bool{
	"kick": true, "snare": true, "hihat": true, "hat": true, "clap": true, "rim": true, "tom": true, "perc": true,
	"ride": true, "crash": true, "bass": true, "sub": true, "melody": true, "harmony": true, "lead": true,
	"pad": true, "arp": true, "chords": true, "stab": true, "drums": true, "fx": true,
}

var actions = map[string]bool{
	"filter": true, "reverb": true, "level": true, "resonance": true, "move": true, "wheel": true, "swap": true,
	"delay": true, "pan": true, "volume": true, "mute": true, "unmute": true, "solo": true, "load": true,
	"play": true, "pause": true, "rotate": true, "transpose": true, "reverse": true, "octave": true,
	"slow": true, "fast": true, "degrade": true, "humanize": true, "lp": true, "hp": true, "bp": true, "off": true,
}

var (
	reWord = regexp.MustCompile(`^[A-Za-z_$][A-Za-z0-9_$#-]*`)
	reNum  = regexp.MustCompile(`^[0-9]+(\.[0-9]+)?[k%]?`)
	// a hit: x, x*2, x!, a note with its octave and optional accent/slide marks (f1!, g#1^, c4), a chord(...)
	reHit = regexp.MustCompile(`^(x|[a-g][#b]?-?[0-9])[!^*.0-9]*$`)
)

func isHitToken(tok string) bool {
	if strings.HasPrefix(tok, "chord(") && strings.HasSuffix(tok, ")") {
		return true
	}
	return reHit.MatchString(tok)
}

// basicSpans colours text coarsely; offsets are UTF-8 bytes into text.
func basicSpans(text string) []api.Span {
	var out []api.Span
	off := 0
	for _, line := range strings.SplitAfter(text, "\n") {
		out = append(out, lineSpans(strings.TrimRight(line, "\r\n"), off)...)
		off += len(line)
	}
	return out
}

func lineSpans(l string, base int) []api.Span {
	var out []api.Span
	add := func(a, b int, c string) { out = append(out, api.Span{Start: base + a, End: base + b, Class: c}) }
	i := 0
	prev := ""
	for i < len(l) {
		c := l[i]
		switch {
		case c == ' ' || c == '\t':
			i++
		case c == '#' && (i == 0 || l[i-1] == ' ' || l[i-1] == '\t'):
			add(i, len(l), "comment")
			return out
		case c == '~':
			add(i, i+1, "rest")
			i++
		case c == '"':
			j := strings.IndexByte(l[i+1:], '"')
			end := len(l)
			if j >= 0 {
				end = i + 1 + j + 1
			}
			add(i, end, "string")
			i = end
		case strings.HasPrefix(l[i:], "->"):
			add(i, i+2, "operator")
			i += 2
		case strings.HasPrefix(l[i:], ".."):
			add(i, i+2, "operator")
			i += 2
		case c == '(' || c == ')' || c == '[' || c == ']' || c == '<' || c == '>' || c == '{' || c == '}' || c == '|' || c == ',' || c == ':' || c == '=' || c == '*':
			add(i, i+1, "operator")
			i++
		case c >= '0' && c <= '9':
			// a note like 1... is lexed as a number; a note starts with a letter so this is a plain number.
			m := reNum.FindString(l[i:])
			add(i, i+len(m), "number")
			i += len(m)
		default:
			w := reWord.FindString(l[i:])
			if w == "" {
				_, n := utf8.DecodeRuneInString(l[i:])
				add(i, i+n, "word")
				i += n
				continue
			}
			end := i + len(w)
			// a trailing `!` or `^` belongs to a step token
			for end < len(l) && (l[end] == '!' || l[end] == '^') {
				end++
			}
			tok := l[i:end]
			class := "word"
			next := byte(0)
			if end < len(l) {
				next = l[end]
			}
			switch {
			case next == '(':
				class = "generator"
			case next == '=' && !strings.HasPrefix(l[end:], "=="):
				class = "param"
			case prev == "deck" && (w == "A" || w == "B"):
				class = "deck"
			case keywords[w]:
				class = "keyword"
			case roles[w]:
				class = "role"
			case actions[w]:
				class = "action"
			case isHitToken(tok):
				class = "step"
			}
			add(i, end, class)
			prev = w
			i = end
		}
	}
	return out
}

// classAt maps every byte of text to a class name ("" = unclassified) from spans (later spans win).
func classAt(text string, spans []api.Span) []string {
	cls := make([]string, len(text))
	for _, s := range spans {
		if s.Start < 0 || s.End > len(text) || s.Start >= s.End {
			continue
		}
		for i := s.Start; i < s.End; i++ {
			cls[i] = s.Class
		}
	}
	return cls
}

// cleanLine makes one line safe to draw: tabs to two spaces, control characters to a space.
func cleanLine(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == '\t':
			b.WriteString("  ")
		case r == utf8.RuneError || unicode.IsControl(r) || r == ' ' || r == ' ':
			b.WriteByte(' ')
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// cleanText makes a program-supplied label (a name, a description) safe to show: no control characters or
// newlines, spaces collapsed, at most max runes (with an ellipsis).
func cleanText(s string, max int) string {
	s = strings.Join(strings.Fields(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == ' ' || r == ' ' || r == utf8.RuneError || isBidiControl(r) {
			return ' '
		}
		return r
	}, s)), " ")
	return truncRunes(s, max)
}

// isBidiControl: the marks, embeddings, overrides and isolates that reorder the text around them. A name with an
// override in it shows reversed in a link preview (a title can push the real words out of sight); a name has no
// use for them.
func isBidiControl(r rune) bool {
	switch {
	case r == 0x061C, r == 0x200E, r == 0x200F: // Arabic letter mark, LRM, RLM
		return true
	case r >= 0x202A && r <= 0x202E: // LRE RLE PDF LRO RLO
		return true
	case r >= 0x2066 && r <= 0x2069: // LRI RLI FSI PDI
		return true
	}
	return false
}

func truncRunes(s string, max int) string {
	if max <= 0 {
		return ""
	}
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	r := []rune(s)
	return strings.TrimRight(string(r[:max-1]), " ") + "…"
}

// shortCID is the first 6 and last 2 characters around an ellipsis: z4EBG9…7v.
func shortCID(cid string) string {
	r := []rune(cid)
	if len(r) <= 9 {
		return cid
	}
	return string(r[:6]) + "…" + string(r[len(r)-2:])
}

// keyLabel turns the language's key spelling into words: fm -> F minor, c -> C major, d:dorian -> D dorian.
func keyLabel(k string) string {
	k = strings.TrimSpace(k)
	if k == "" {
		return ""
	}
	root, mode, hasMode := strings.Cut(k, ":")
	name := func(r string) string {
		if r == "" {
			return ""
		}
		out := strings.ToUpper(r[:1])
		if len(r) > 1 {
			out += strings.ReplaceAll(r[1:], "#", "♯")
		}
		return out
	}
	if hasMode {
		return name(root) + " " + mode
	}
	if len(root) >= 2 && strings.HasSuffix(root, "m") && strings.IndexByte("abcdefg", root[0]) >= 0 {
		return name(strings.TrimSuffix(root, "m")) + " minor"
	}
	if len(root) >= 1 && len(root) <= 2 && strings.IndexByte("abcdefg", root[0]) >= 0 {
		return name(root) + " major"
	}
	return k
}

func clock(seconds float64) string {
	s := int(seconds + 0.5)
	return fmt.Sprintf("%d:%02d", s/60, s%60)
}

func fmtBPM(t float64) string {
	if t == float64(int(t)) {
		return fmt.Sprintf("%d", int(t))
	}
	return strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.2f", t), "0"), ".")
}

// licenseBadge is the short form shown in the badge: CC0-1.0 -> CC0, CC-BY-4.0 -> CC BY 4.0.
func licenseBadge(l string) string {
	l = strings.TrimSpace(l)
	switch strings.ToUpper(l) {
	case "", "CC0", "CC0-1.0":
		return "CC0"
	}
	u := strings.ToUpper(l)
	if strings.HasPrefix(u, "CC-") {
		return truncRunes(strings.ReplaceAll(u, "-", " "), 12)
	}
	return truncRunes(l, 12)
}

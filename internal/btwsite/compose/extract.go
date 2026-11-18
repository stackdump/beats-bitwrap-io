package compose

import (
	"regexp"
	"strings"
)

// ExtractProgram takes the reply of a model and returns the btw program in it. The model is told to reply
// with the program and nothing else; this is the defence for when it does not:
//
//   - a fenced block (``` or ```btw) is the program, the rest of the reply is dropped;
//   - otherwise sentences before the first statement ("Here is your track:") and paragraphs of explanation
//     after the last one are dropped;
//   - a line that merely looks wrong (a typo of a keyword, a stray word) is NOT touched: that is for the
//     checker to report and the model to repair.
//
// The result ends with one newline, or is "" for a reply with nothing in it.
func ExtractProgram(raw string) string {
	s := strings.ReplaceAll(raw, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	s = strings.TrimPrefix(s, "\xef\xbb\xbf")
	if blk, ok := fencedBlock(s); ok {
		s = blk
	}
	lines := strings.Split(s, "\n")
	lines = dropProse(lines)
	// trim blank edges
	for len(lines) > 0 && strings.TrimSpace(lines[0]) == "" {
		lines = lines[1:]
	}
	for len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) == "" {
		lines = lines[:len(lines)-1]
	}
	if len(lines) == 0 {
		return ""
	}
	for i := range lines {
		lines[i] = strings.TrimRight(lines[i], " \t")
	}
	return strings.Join(lines, "\n") + "\n"
}

// fencedBlock returns the contents of the first fenced block that has a statement in it (else the first
// fenced block). An unterminated fence runs to the end of the reply.
func fencedBlock(s string) (string, bool) {
	lines := strings.Split(s, "\n")
	var blocks []string
	var cur []string
	in := false
	for _, l := range lines {
		t := strings.TrimSpace(l)
		if strings.HasPrefix(t, "```") || strings.HasPrefix(t, "~~~") {
			if in {
				blocks = append(blocks, strings.Join(cur, "\n"))
				cur, in = nil, false
			} else {
				in = true
			}
			continue
		}
		if in {
			cur = append(cur, l)
		}
	}
	if in {
		blocks = append(blocks, strings.Join(cur, "\n"))
	}
	if len(blocks) == 0 {
		return "", false
	}
	for _, b := range blocks {
		for _, l := range strings.Split(b, "\n") {
			if looksBtw(l) {
				return b, true
			}
		}
	}
	return blocks[0], true
}

var statementWords = map[string]bool{
	"tempo": true, "swing": true, "key": true, "let": true, "def": true, "repeat": true, "section": true,
	"arrange": true, "import": true, "end": true, "loop": true, "evolve": true, "deck": true, "master": true,
	"every": true, "on": true, "at": true, "after": true, "before": true, "for": true, "do": true,
	"swap": true, "move": true, "load": true, "queue": true, "play": true, "stop": true, "sync": true,
	"mute": true, "unmute": true, "filter": true, "delay": true, "reverb": true, "crush": true,
	"level": true, "low": true, "mid": true, "high": true, "crossfader": true, "resonance": true,
	"sample": true, "use": true, "kick": true, "snare": true, "hihat": true, "clap": true, "bass": true,
	"melody": true, "harmony": true, "arp": true, "rotate": true, "transpose": true, "octave": true,
	"invert": true, "reverse": true, "thin": true,
}

var callLine = regexp.MustCompile(`^[a-z_][a-z0-9_-]*\(`)

// looksBtw: could this line be part of a btw program (not: is it valid)?
func looksBtw(l string) bool {
	t := strings.TrimSpace(l)
	if t == "" {
		return false
	}
	switch t[0] {
	case '#', '|', '}', '{':
		return true
	}
	if strings.HasSuffix(t, "{") || strings.HasSuffix(t, "}") {
		return true
	}
	first := t
	if i := strings.IndexAny(t, " \t:(="); i >= 0 {
		first = t[:i]
	}
	if statementWords[first] {
		return true
	}
	return callLine.MatchString(t)
}

var bulletLine = regexp.MustCompile(`^(\*|-|>|\d+[.)])\s`)

// isProseLine: a sentence (ends with . ! ? or :), a bullet, a markdown heading or emphasis. Deliberately
// strict: a line with a typo in it ("kik x ~ x ~") is not prose, it is a mistake the model must be told about.
func isProseLine(l string) bool {
	t := strings.TrimSpace(l)
	if t == "" || looksBtw(t) {
		return false
	}
	if strings.HasPrefix(t, "**") || strings.HasPrefix(t, "##") || bulletLine.MatchString(t) {
		return true
	}
	switch t[len(t)-1] {
	case '.', '!', '?', ':':
		return true
	}
	return false
}

// dropProse removes leading sentences and leading/trailing paragraphs that are explanation. A paragraph
// is prose when it has no btw-looking line and at least one prose line, and it is not inside a block.
func dropProse(lines []string) []string {
	// paragraphs: [start,end) of non-blank runs
	type para struct{ s, e int }
	var ps []para
	for i := 0; i < len(lines); {
		if strings.TrimSpace(lines[i]) == "" {
			i++
			continue
		}
		j := i
		for j < len(lines) && strings.TrimSpace(lines[j]) != "" {
			j++
		}
		ps = append(ps, para{i, j})
		i = j
	}
	if len(ps) == 0 {
		return lines
	}
	isProsePara := func(p para) bool {
		prose := false
		for _, l := range lines[p.s:p.e] {
			if looksBtw(l) {
				return false
			}
			if isProseLine(l) {
				prose = true
			}
		}
		return prose
	}
	hasBtw := false
	for _, l := range lines {
		if looksBtw(l) {
			hasBtw = true
			break
		}
	}
	if !hasBtw {
		return lines // nothing to anchor on: let the checker say what is wrong
	}
	lo, hi := 0, len(ps)
	for lo < hi && isProsePara(ps[lo]) {
		lo++
	}
	for hi > lo && isProsePara(ps[hi-1]) {
		hi--
	}
	if lo >= hi {
		return lines
	}
	out := lines[ps[lo].s:ps[hi-1].e]
	// leading sentence lines glued to the first statement ("Here is the track:\ntempo 120")
	k := 0
	for k < len(out) && isProseLine(out[k]) {
		k++
	}
	out = out[k:]
	// trailing sentence lines glued to the last statement, after the program's last line
	m := len(out)
	for m > 0 && isProseLine(out[m-1]) {
		m--
	}
	return out[:m]
}

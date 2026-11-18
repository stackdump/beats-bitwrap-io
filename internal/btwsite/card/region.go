package card

import (
	"regexp"
	"sort"
	"strings"
)

// MaxLines is the most code lines a card shows.
const MaxLines = 12

// minRegion: a region shorter than this is padded with the definitions it uses.
const minRegion = 8

// block is a top-level statement of the canonical text: a `let` (one line), or a `{ ... }` block (section, def,
// repeat, evolve...). Lines are indexes into the canonical text's lines.
type block struct {
	kind       string // "let" | "section" | "def" | "block" | "line"
	name       string
	start, end int // inclusive
}

var (
	reIdent   = regexp.MustCompile(`[A-Za-z_][A-Za-z0-9_]*`)
	reLetName = regexp.MustCompile(`^let\s+([A-Za-z_][A-Za-z0-9_]*)\s*=`)
	reCall    = regexp.MustCompile(`^([A-Za-z_][A-Za-z0-9_]*)\s*\(`)
)

func indentOf(l string) int { return len(l) - len(strings.TrimLeft(l, " ")) }

// scanBlocks finds the top-level statements. Canonical text indents block bodies by two spaces and closes a
// block with a lone `}` at the statement's indentation.
func scanBlocks(lines []string) []block {
	var out []block
	for i := 0; i < len(lines); i++ {
		l := lines[i]
		t := strings.TrimSpace(l)
		if t == "" || indentOf(l) != 0 {
			continue
		}
		b := block{kind: "line", start: i, end: i}
		f := strings.Fields(t)
		switch {
		case f[0] == "let":
			b.kind = "let"
			if m := reLetName.FindStringSubmatch(t); m != nil {
				b.name = m[1]
			}
		case strings.HasSuffix(t, "{"):
			b.kind = "block"
			switch f[0] {
			case "section":
				b.kind = "section"
				if len(f) > 1 {
					b.name = f[1]
				}
			case "def":
				b.kind = "def"
				if m := reIdent.FindString(strings.TrimSpace(strings.TrimPrefix(t, "def"))); m != "" {
					b.name = m
				}
			}
			depth := 0
			for j := i; j < len(lines); j++ {
				tj := strings.TrimSpace(lines[j])
				if strings.HasSuffix(tj, "{") {
					depth++
				}
				if tj == "}" || strings.HasPrefix(tj, "}") {
					depth--
				}
				if depth <= 0 {
					b.end = j
					break
				}
				if j == len(lines)-1 {
					b.end = j // unterminated: take the rest
				}
			}
			i = b.end
		}
		out = append(out, b)
	}
	return out
}

// partsIn counts the parts (the `|`-separated segments of deck lines) in lines[from..to], following one level of
// calls into the defs.
func partsIn(lines []string, from, to int, defs map[string]block, follow bool) int {
	n := 0
	for i := from; i <= to && i < len(lines); i++ {
		t := strings.TrimSpace(lines[i])
		switch {
		case strings.HasPrefix(t, "deck "):
			if _, rest, ok := strings.Cut(t, ":"); ok {
				n += strings.Count(rest, " | ") + 1
			}
		case follow:
			if m := reCall.FindStringSubmatch(t); m != nil {
				if d, ok := defs[m[1]]; ok {
					n += partsIn(lines, d.start+1, d.end-1, defs, false)
				}
			}
		}
	}
	return n
}

// rline is one line of the card's code: its index in the canonical text (-1 for the "…" that marks an
// elided tail), the text, and whether a gap (lines left out) comes before it.
type rline struct {
	idx    int
	text   string
	gapTop bool
}

// pickRegion also answers the name of the section it chose ("" when the region is not a section).
// pickRegion chooses the program's most characteristic lines, at most MaxLines: the section named drop, else
// the section with the most parts, else the first def, else the first lines. A short block is padded with the
// lets and defs it uses (left in program order, with a gap mark where lines were left out).
func pickRegion(lines []string) ([]rline, string) {
	blocks := scanBlocks(lines)
	defs := map[string]block{}
	lets := map[string]block{}
	for _, b := range blocks {
		switch b.kind {
		case "def":
			if _, dup := defs[b.name]; !dup {
				defs[b.name] = b
			}
		case "let":
			if _, dup := lets[b.name]; !dup {
				lets[b.name] = b
			}
		}
	}

	var primary *block
	best := -1
	for i := range blocks {
		b := &blocks[i]
		if b.kind != "section" {
			continue
		}
		if b.name == "drop" {
			primary = b
			best = 1 << 30
			break
		}
		if p := partsIn(lines, b.start+1, b.end-1, defs, true); p > best {
			best, primary = p, b
		}
	}
	if primary == nil {
		for i := range blocks {
			if blocks[i].kind == "def" {
				primary = &blocks[i]
				break
			}
		}
	}
	if primary == nil {
		var out []rline
		for i := 0; i < len(lines) && len(out) < MaxLines; i++ {
			if strings.TrimSpace(lines[i]) == "" {
				continue
			}
			out = append(out, rline{idx: i, text: lines[i]})
		}
		return out, ""
	}

	idx := map[int]bool{}
	if n := primary.end - primary.start + 1; n > MaxLines {
		// too long: its header and closing brace, then the lines that say most (parts, ramps, patterns)
		idx[primary.start], idx[primary.end] = true, true
		type sc struct{ i, score int }
		var rest []sc
		for i := primary.start + 1; i < primary.end; i++ {
			l := lines[i]
			score := 5
			switch {
			case isPartLine(l):
				score = 30
			case isRampLine(l):
				score = 25
			case len(hitTokens(l)) > 0:
				score = 10
			}
			rest = append(rest, sc{i, score})
		}
		sort.SliceStable(rest, func(a, b int) bool { return rest[a].score > rest[b].score })
		for _, r := range rest {
			if len(idx) >= MaxLines {
				break
			}
			idx[r.i] = true
		}
	} else {
		for i := primary.start; i <= primary.end; i++ {
			idx[i] = true
		}
	}

	hasHit := false
	for i := range idx {
		if len(hitTokens(lines[i])) > 0 {
			hasHit = true
		}
	}
	if (len(idx) < minRegion || !hasHit) && len(idx) < MaxLines {
		// pad with what it uses: the defs it calls (in order of appearance, if they fit) and the lets used by
		// it and by those defs. A region with nothing to light gets its patterns first.
		used := func(from, to int) []string {
			return reIdent.FindAllString(strings.Join(lines[from:to+1], "\n"), -1)
		}
		room := MaxLines - len(idx)
		var wantLets []string
		seen := map[string]bool{}
		noteLets := func(names []string) {
			for _, w := range names {
				if _, ok := lets[w]; ok && !seen[w] {
					seen[w] = true
					wantLets = append(wantLets, w)
				}
			}
		}
		var chosenDefs []block
		pickDefs := func() {
			for _, w := range used(primary.start, primary.end) {
				d, ok := defs[w]
				if !ok || seen["def:"+w] || d.start == primary.start {
					continue
				}
				seen["def:"+w] = true
				if size := d.end - d.start + 1; size <= room && size <= 6 {
					chosenDefs = append(chosenDefs, d)
					room -= size
				}
			}
		}
		noteLets(used(primary.start, primary.end))
		if hasHit {
			pickDefs()
		} else {
			// reserve the lets, then see what else fits
			room -= len(wantLets)
			pickDefs()
			room += len(wantLets)
		}
		for _, d := range chosenDefs {
			noteLets(used(d.start, d.end))
		}
		for _, d := range chosenDefs {
			for i := d.start; i <= d.end; i++ {
				idx[i] = true
			}
		}
		for _, w := range wantLets {
			if len(idx) >= MaxLines {
				break
			}
			idx[lets[w].start] = true
		}
	}

	var order []int
	for i := range idx {
		order = append(order, i)
	}
	sort.Ints(order)
	var out []rline
	for k, i := range order {
		out = append(out, rline{idx: i, text: lines[i], gapTop: k > 0 && i != order[k-1]+1})
	}
	section := ""
	if primary.kind == "section" {
		section = primary.name
	}
	return out, section
}

// hitToken is one step token on a line: rune column and length.
type hitToken struct{ col, n int }

// hitTokens finds the hit tokens (x, notes, chord(..)) of a line, outside quotes, comments and the `inst=` style
// params.
func hitTokens(line string) []hitToken {
	rs := []rune(line)
	var out []hitToken
	inQuote := false
	i := 0
	isSep := func(r rune) bool {
		switch r {
		case ' ', '[', ']', '<', '>', '|', ',', ':', '=', '{', '}':
			return true
		}
		return false
	}
	for i < len(rs) {
		r := rs[i]
		if r == '"' {
			inQuote = !inQuote
			i++
			continue
		}
		if inQuote || isSep(r) {
			i++
			continue
		}
		if r == '#' && (i == 0 || rs[i-1] == ' ') {
			break
		}
		j := i
		depth := 0
		for j < len(rs) {
			if rs[j] == '(' {
				depth++
			} else if rs[j] == ')' {
				if depth > 0 {
					depth--
				}
			} else if depth == 0 && isSep(rs[j]) {
				break
			}
			j++
		}
		// a token directly after `=` or `..` is a param value, not a hit; isSep treated '=' as a separator, so
		// look at what came before.
		tok := string(rs[i:j])
		prevEq := i > 0 && (rs[i-1] == '=')
		if !prevEq && isHitToken(tok) {
			out = append(out, hitToken{col: i, n: j - i})
		}
		i = j
	}
	return out
}

func isRampLine(l string) bool {
	return strings.Contains(l, "->") && strings.Contains(l, "over") && strings.Contains(l, "bar")
}

func isPartLine(l string) bool {
	t := strings.TrimSpace(l)
	if strings.HasPrefix(t, "deck ") {
		return true
	}
	return reCall.MatchString(t) && !strings.HasPrefix(t, "def ")
}

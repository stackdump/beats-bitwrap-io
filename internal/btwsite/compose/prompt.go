package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"

	"beats-bitwrap-io/internal/btwsite/api"
)

// roleStatement is the part of the system prompt that is ours: what the model is, and what it must send back.
// The grammar itself comes from Checker.Cheatsheet() (generated from the language doc), the sounds from
// Checker.Instruments(), and the examples from the site's own CC0 programs.
const roleStatement = `You are a composer who writes music as programs in btw, a small text language for whole tracks. Your reply is read by a program, not a person.

OUTPUT CONTRACT
- Reply with ONLY the btw program. No prose before or after it, no explanation, no markdown, no code fences.
- Start with the "tempo" line and the "key" line.
- Use only instruments, kits and sounds named in the INSTRUMENTS list below. Never invent a name.
- A bar is 16 steps: write patterns that divide 16 evenly (16, 8, 4, 2 terms, or x*N with N dividing 16).
- For a song, write "section NAME N bars { ... }" blocks and an "arrange" line that puts them in order; a short sketch or loop may be a few lines with no sections. Name common parts once with "let" and reuse them.
- Keep within the requested length. If no length is given, make something of 32 to 64 bars. A smaller correct program is better than a larger broken one.
- Write comments only as "# ..." lines. Do not write lines that start with "#!".
- Everything you write is public domain (CC0). Never use "use restricted", "sample" or "loop" asset statements: only the sounds in the instruments list.
- If the checker sends back errors, fix every one of them and reply with the complete corrected program, again with no prose.`

var headerLine = regexp.MustCompile(`^\s*#!`)

// exampleCand is an example that passed every check for being shown to the model.
type exampleCand struct {
	name     string
	text     string // as shown: the program without its #! header lines
	bytes    int
	sections int
	ramp     bool
}

var rampRe = regexp.MustCompile(`->.*\bover\s+\d+\s+bars\b`)

// restrictedLine matches the statements that bring in assets or mark a program private. Examples with such
// a line never reach a prompt, whatever the checker says.
var restrictedLine = regexp.MustCompile(`(?m)^\s*(use\s+restricted\b|sample\b|loop\s+\S)`)
var visibilityLine = regexp.MustCompile(`(?m)^\s*#!\s*visibility:\s*(\S+)`)
var licenseLine = regexp.MustCompile(`(?m)^\s*#!\s*license:\s*(\S+)`)

// VetPublicProgram is the one rule for what may be put in front of the model (examples, and the base of an
// edit): CC0 and public by its own header, no assets, not restricted, no errors, and when strict no
// warnings either. It returns "" when the program is fine, else the reason.
func VetPublicProgram(text string, rep *api.CheckReport, strict bool) string {
	if m := licenseLine.FindStringSubmatch(text); m != nil && !strings.EqualFold(m[1], "CC0-1.0") {
		return "licence is " + m[1] + ", not CC0-1.0"
	}
	if m := visibilityLine.FindStringSubmatch(text); m != nil && !strings.EqualFold(m[1], "public") {
		return "visibility is " + m[1]
	}
	if restrictedLine.MatchString(text) {
		return "uses restricted or asset statements"
	}
	if rep == nil || !rep.OK {
		return "does not check"
	}
	if rep.Restricted {
		return "restricted"
	}
	if rep.UsesAssets {
		return "uses assets"
	}
	if strict && rep.Warnings > 0 {
		return fmt.Sprintf("has %d warnings", rep.Warnings)
	}
	return ""
}

// headerClaim is the part of VetPublicProgram that reads the program's own "#!" header: why it says it is
// not public CC0, or "".
func headerClaim(text string) string {
	if m := licenseLine.FindStringSubmatch(text); m != nil && !strings.EqualFold(m[1], "CC0-1.0") {
		return "licensed " + m[1]
	}
	if m := visibilityLine.FindStringSubmatch(text); m != nil && !strings.EqualFold(m[1], "public") {
		return m[1]
	}
	return ""
}

func stripHeader(text string) string {
	var out []string
	for _, l := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		if headerLine.MatchString(l) {
			continue
		}
		out = append(out, l)
	}
	return strings.TrimSpace(strings.Join(out, "\n")) + "\n"
}

// pickExamples chooses up to three of the candidates: a short one, a sectioned song and one with ramps
// (smallest first, to keep the prompt small), never more than maxTotal bytes together.
func pickExamples(c []exampleCand, maxTotal int) []exampleCand {
	sort.Slice(c, func(i, j int) bool {
		if c[i].bytes != c[j].bytes {
			return c[i].bytes < c[j].bytes
		}
		return c[i].name < c[j].name
	})
	var out []exampleCand
	used := map[string]bool{}
	total := 0
	take := func(ok func(exampleCand) bool) {
		for _, e := range c {
			if used[e.name] || !ok(e) || total+e.bytes > maxTotal {
				continue
			}
			used[e.name] = true
			total += e.bytes
			out = append(out, e)
			return
		}
	}
	take(func(e exampleCand) bool { return e.sections == 0 }) // a short one
	n := len(out)
	take(func(e exampleCand) bool { return e.sections >= 4 }) // a whole song in sections (intro, build, drop ...)
	if len(out) == n {
		take(func(e exampleCand) bool { return e.sections >= 2 }) // or the biggest thing there is
	}
	take(func(e exampleCand) bool { return e.ramp })       // one with ramps
	take(func(e exampleCand) bool { return len(out) < 2 }) // fewer than two found: any other will do
	return out
}

// promptCache holds the built system prompt until the examples change.
type promptCache struct {
	mu     sync.Mutex
	key    string
	system string
	names  []string
}

// systemPrompt builds (or returns the cached) system prompt and the names of the examples in it.
func (s *Service) systemPrompt(ctx context.Context) (string, []string, error) {
	var exs []api.Example
	if s.opt.Examples != nil {
		exs = s.opt.Examples()
	}
	var ids []string
	for _, e := range exs {
		ids = append(ids, e.Name+"="+e.CID+"="+e.License)
	}
	sort.Strings(ids)
	key := strings.Join(ids, ",")

	s.pc.mu.Lock()
	defer s.pc.mu.Unlock()
	if s.pc.system != "" && s.pc.key == key {
		return s.pc.system, s.pc.names, nil
	}

	sheet, err := s.opt.Checker.Cheatsheet(ctx)
	if err != nil {
		return "", nil, passThrough(err, "the grammar cheat-sheet is not available")
	}
	instr, err := s.opt.Checker.Instruments(ctx)
	if err != nil {
		return "", nil, passThrough(err, "the instrument list is not available")
	}

	var cands []exampleCand
	for _, e := range exs {
		if !strings.EqualFold(e.License, "CC0-1.0") || s.opt.ExampleText == nil {
			continue
		}
		text, ok := s.opt.ExampleText(e.Name)
		if !ok || len(text) > s.opt.MaxProgramBytes {
			continue
		}
		rep, err := s.opt.Checker.Check(ctx, text)
		if err != nil {
			continue
		}
		if why := VetPublicProgram(text, rep, true); why != "" {
			s.logf("compose: example %q left out of the prompt: %s", e.Name, why)
			continue
		}
		shown := stripHeader(text)
		cands = append(cands, exampleCand{name: e.Name, text: shown, bytes: len(shown), sections: len(rep.Sections), ramp: rampRe.MatchString(shown)})
	}
	chosen := pickExamples(cands, 9000)

	var b strings.Builder
	b.WriteString(roleStatement)
	b.WriteString("\n\nGRAMMAR AND CHEAT-SHEET\n")
	b.WriteString(strings.TrimSpace(sheet))
	b.WriteString("\n\nINSTRUMENTS (the only sound names you may use)\n")
	b.WriteString(compactInstruments(instr))
	var names []string
	if len(chosen) > 0 {
		b.WriteString("\n\nEXAMPLES (public-domain programs that pass the checker; study their shape, do not copy them)\n")
		for _, e := range chosen {
			names = append(names, e.name)
			fmt.Fprintf(&b, "\n--- example: %s ---\n%s", e.name, e.text)
		}
		b.WriteString("--- end of examples ---\n")
	}
	s.pc.key, s.pc.system, s.pc.names = key, b.String(), names
	return s.pc.system, names, nil
}

// compactInstruments turns the instruments JSON ({"voices":[…],"families":[…],"kits":[…],"palettes":[…]})
// into short lines. Names may be plain strings or objects with a "name" or "id"; anything else is kept as
// compact JSON so nothing is lost.
func compactInstruments(raw json.RawMessage) string {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return strings.TrimSpace(string(raw))
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	order := map[string]int{"voices": 0, "families": 1, "kits": 2, "palettes": 3}
	sort.Slice(keys, func(i, j int) bool {
		oi, iok := order[keys[i]]
		oj, jok := order[keys[j]]
		switch {
		case iok && jok:
			return oi < oj
		case iok != jok:
			return iok
		}
		return keys[i] < keys[j]
	})
	var b strings.Builder
	for _, k := range keys {
		var names []string
		var arr []json.RawMessage
		if err := json.Unmarshal(m[k], &arr); err == nil {
			for _, el := range arr {
				var s string
				if json.Unmarshal(el, &s) == nil {
					names = append(names, s)
					continue
				}
				var o map[string]any
				if json.Unmarshal(el, &o) == nil {
					if v, ok := o["name"].(string); ok {
						names = append(names, v)
						continue
					}
					if v, ok := o["id"].(string); ok {
						names = append(names, v)
						continue
					}
				}
				names = append(names, strings.TrimSpace(string(el)))
			}
		} else {
			names = []string{strings.TrimSpace(string(m[k]))}
		}
		fmt.Fprintf(&b, "%s: %s\n", k, strings.Join(names, ", "))
	}
	return strings.TrimRight(b.String(), "\n")
}

// ---------- the user turn ----------

var lengthWords = map[string]string{
	"short":  "short: about 16 to 24 bars in total",
	"medium": "medium: about 48 to 64 bars in total",
	"long":   "long: about 96 to 128 bars in total",
}

// constraintLines renders the optional hints as constraints.
func constraintLines(r api.ComposeRequest) string {
	var b strings.Builder
	if r.Genre != "" {
		fmt.Fprintf(&b, "- genre: %s\n", r.Genre)
	}
	if r.BPM > 0 {
		fmt.Fprintf(&b, "- tempo: %s BPM (write \"tempo %s\")\n", fmtNum(r.BPM), fmtNum(r.BPM))
	}
	if r.Key != "" {
		fmt.Fprintf(&b, "- key: %s (write \"key %s\")\n", r.Key, r.Key)
	}
	if r.Length != "" {
		if w, ok := lengthWords[r.Length]; ok {
			fmt.Fprintf(&b, "- length: %s\n", w)
		} else {
			fmt.Fprintf(&b, "- length: about %s bars in total\n", r.Length)
		}
	}
	return b.String()
}

func fmtNum(f float64) string {
	if f == float64(int64(f)) {
		return fmt.Sprintf("%d", int64(f))
	}
	return strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.2f", f), "0"), ".")
}

// userMessage is the first user turn: the request, the hints as constraints and, for an edit, the program
// to modify.
func userMessage(r api.ComposeRequest, base string, maxBytes int) string {
	var b strings.Builder
	if base != "" {
		b.WriteString("Here is a btw program. Modify it as the request below says, keeping what the request does not mention, and reply with the COMPLETE modified program (not a diff).\n\n--- the program to modify ---\n")
		b.WriteString(strings.TrimSpace(base))
		b.WriteString("\n--- end of the program ---\n\nRequested change: ")
	} else {
		b.WriteString("Write a btw program for this request: ")
	}
	b.WriteString(r.Prompt)
	b.WriteString("\n")
	if c := constraintLines(r); c != "" {
		b.WriteString("\nConstraints:\n" + c)
	}
	fmt.Fprintf(&b, "\nThe program must be under %d bytes. Reply with the program only.", maxBytes)
	return b.String()
}

// repairMessage is the next user turn after a failed attempt: the diagnostics, in the caret form the checker
// renders plus where they are and what to do.
func repairMessage(diags []api.Diagnostic) string {
	var errs []api.Diagnostic
	for _, d := range diags {
		if d.Severity == "" || d.Severity == "error" {
			errs = append(errs, d)
		}
	}
	if len(errs) == 0 {
		errs = diags
	}
	var b strings.Builder
	n := len(errs)
	if n == 1 {
		b.WriteString("The checker refused your program with 1 error. ")
	} else {
		fmt.Fprintf(&b, "The checker refused your program with %d errors. ", n)
	}
	b.WriteString("Fix every one and reply with the complete corrected program only: no prose, no code fences, no \"#!\" lines.\n")
	const maxShown = 10
	for i, d := range errs {
		if i == maxShown {
			fmt.Fprintf(&b, "\n(%d more errors not shown)\n", n-maxShown)
			break
		}
		b.WriteString("\n")
		if d.Line > 0 {
			fmt.Fprintf(&b, "[%d] line %d, col %d:\n", i+1, d.Line, d.Col)
		} else {
			fmt.Fprintf(&b, "[%d]\n", i+1)
		}
		if d.Render != "" {
			b.WriteString(strings.TrimRight(d.Render, "\n") + "\n")
		} else {
			fmt.Fprintf(&b, "error: %s\n", d.Message)
		}
		if d.Help != "" && !strings.Contains(d.Render, d.Help) {
			fmt.Fprintf(&b, "help: %s\n", d.Help)
		}
	}
	return b.String()
}

// syntheticDiag is an error the service itself found (too big, empty, cut off, uses assets).
func syntheticDiag(msg, help string) api.Diagnostic {
	return api.Diagnostic{Severity: "error", Line: 1, Col: 1, EndCol: 1, Message: msg, Help: help, Render: "error: " + msg}
}

func estimateTokens(system string, msgs []Message) int {
	n := len(system)
	for _, m := range msgs {
		n += len(m.Text)
	}
	return n/3 + 1 // btw is symbols and short words: count a token per three bytes, an over-estimate
}

// Package fakecheck is a test double for api.Checker: a tiny stand-in for the Rust `btwd` so the Go
// packages (compose, card, mcpsrv, server) can be tested without the binary. It is NOT the language:
//
//   - a program is "bad" if any line is exactly `BAD` or starts with `deck Z`, or if it has no statement
//     at all; the error is at that line, col 1, with a `help`;
//   - the canonical text drops comments and blank lines and collapses runs of spaces;
//   - the CID is internal/btw.ProgramCID of the canonical text (the real algorithm over the fake canonical form);
//   - `tempo N`, `key K`, `section NAME N bars` lines fill the report; `use restricted` and `sample ` set
//     Restricted / UsesAssets.
//
// Real-binary tests use btwd.Client with BTWD_BIN instead.
package fakecheck

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"beats-bitwrap-io/internal/btw"
	"beats-bitwrap-io/internal/btwsite/api"
)

type Checker struct{}

var (
	reTempo   = regexp.MustCompile(`^tempo\s+([0-9.]+)\s*$`)
	reKey     = regexp.MustCompile(`^key\s+(\S+)\s*$`)
	reSection = regexp.MustCompile(`^section\s+(\S+)\s+(\d+)\s+bars\s*\{?\s*$`)
	reSpaces  = regexp.MustCompile(`[ \t]+`)
)

// Canonical is the fake canonical form.
func Canonical(text string) string {
	var out []string
	for _, l := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		if i := strings.Index(l, "#"); i >= 0 && (i == 0 || l[i-1] == ' ' || l[i-1] == '\t') {
			l = l[:i]
		}
		l = strings.TrimSpace(reSpaces.ReplaceAllString(l, " "))
		if l != "" {
			out = append(out, l)
		}
	}
	return strings.Join(out, "\n") + "\n"
}

func (Checker) Check(_ context.Context, text string) (*api.CheckReport, error) {
	r := &api.CheckReport{Diagnostics: []api.Diagnostic{}}
	canon := Canonical(text)
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	stmts := 0
	bars := 0
	start := 0
	for i, l := range lines {
		t := strings.TrimSpace(l)
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		stmts++
		if t == "BAD" || strings.HasPrefix(t, "deck Z") {
			r.Errors++
			off := 0
			for _, p := range lines[:i] {
				off += len(p) + 1
			}
			r.Diagnostics = append(r.Diagnostics, api.Diagnostic{Severity: "error", Line: i + 1, Col: 1, EndCol: 1 + len(t), Start: off, End: off + len(t),
				Message: fmt.Sprintf("unknown statement `%s`", t), Help: "decks are A and B: `deck A: kick x ~ x ~`",
				Render: fmt.Sprintf("error: unknown statement `%s`\n  --> %d:1", t, i+1)})
			continue
		}
		if m := reTempo.FindStringSubmatch(t); m != nil {
			v, _ := strconv.ParseFloat(m[1], 64)
			r.Tempo = &v
		}
		if m := reKey.FindStringSubmatch(t); m != nil {
			r.Key = m[1]
		}
		if m := reSection.FindStringSubmatch(t); m != nil {
			n, _ := strconv.Atoi(m[2])
			r.Sections = append(r.Sections, api.Section{Name: m[1], Start: start, Bars: n})
			start += n
			bars += n
			r.Arranged = true
		}
		if t == "use restricted" {
			r.Restricted = true
		}
		if strings.HasPrefix(t, "sample ") || strings.HasPrefix(t, "loop ") {
			r.UsesAssets = true
		}
	}
	if stmts == 0 {
		r.Errors++
		r.Diagnostics = append(r.Diagnostics, api.Diagnostic{Severity: "error", Line: 1, Col: 1, EndCol: 1, Message: "empty program", Help: "start with `tempo 120`", Render: "error: empty program"})
	}
	r.OK = r.Errors == 0
	if r.OK {
		r.CID, _ = btw.ProgramCID(canon)
		r.Canonical = canon
		r.Decks = []string{"A"}
		r.SongBars = bars
		r.Ends = r.Arranged
		if r.Tempo != nil && bars > 0 {
			s := float64(bars) * 4 * 60 / *r.Tempo
			r.Seconds = &s
		}
		r.Nets = map[string]string{"A": r.CID}
	}
	return r, nil
}

func (c Checker) Fmt(ctx context.Context, text string) (*api.FmtReport, error) {
	r, _ := c.Check(ctx, text)
	return &api.FmtReport{OK: r.OK, Canonical: r.Canonical, CID: r.CID, Diagnostics: r.Diagnostics}, nil
}

func (c Checker) Open(_ context.Context, s string) (*api.OpenReport, error) {
	res, err := btw.Open(s)
	if err != nil {
		return &api.OpenReport{Error: err.Error()}, nil
	}
	return &api.OpenReport{OK: res.Verified, CID: res.CID, Canonical: res.Text, Verified: res.Verified, Warnings: res.Warnings, NotesUnverified: res.Notes}, nil
}

func (c Checker) Share(ctx context.Context, text string) (*api.ShareReport, error) {
	r, _ := c.Check(ctx, text)
	if !r.OK {
		return &api.ShareReport{}, nil
	}
	packed := btw.Pack(r.Canonical)
	frag := r.CID + "." + packed
	return &api.ShareReport{OK: true, URL: "https://btw.bitwrap.io/#" + frag, SocialURL: "https://btw.bitwrap.io/c/" + frag, BeatsURL: "https://beats.bitwrap.io/p#" + frag,
		CID: r.CID, Chars: len(frag), Canonical: r.Canonical}, nil
}

func (Checker) Highlight(_ context.Context, text string) ([]api.Span, error) {
	var out []api.Span
	off := 0
	for _, l := range strings.SplitAfter(text, "\n") {
		if i := strings.Index(l, "#"); i >= 0 {
			out = append(out, api.Span{Start: off + i, End: off + len(strings.TrimRight(l, "\n")), Class: "comment"})
		}
		off += len(l)
	}
	return out, nil
}

func (Checker) Instruments(context.Context) (json.RawMessage, error) {
	return json.RawMessage(`{"voices":["wobble-lead","detuned-saw","pwm-lead","warm-pad","sub-bass","bright-pluck"],"families":["bass","reese","acid","sub","pad"],"kits":["drums-808","drums-909"],"palettes":["default"]}`), nil
}

func (Checker) Cheatsheet(context.Context) (string, error) {
	return "# btw cheat-sheet (fake)\n\ntempo 120\nkey am\ndeck A: kick x ~ x ~ | snare ~ x ~ x\n", nil
}

var _ api.Checker = Checker{}

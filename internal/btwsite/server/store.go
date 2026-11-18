package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"beats-bitwrap-io/internal/btw"
	"beats-bitwrap-io/internal/btwsite/api"
)

// reCID is what a CID looks like in a path: base58btc, "z" first. Anything else never touches the disk.
var reCID = regexp.MustCompile(`^z[1-9A-HJ-NP-Za-km-z]{20,80}$`)

// programStore is the content-addressed store of public, unrestricted programs: -data/programs/<cid>.json.
// It implements api.ProgramStore.
type programStore struct {
	dir      string
	checker  api.Checker
	maxBytes int   // per program
	capBytes int64 // whole store
	total    atomic.Int64
	now      func() time.Time
}

var _ api.ProgramStore = (*programStore)(nil)

func newProgramStore(dir string, c api.Checker, maxProgram int, capBytes int64, now func() time.Time) (*programStore, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	s := &programStore{dir: dir, checker: c, maxBytes: maxProgram, capBytes: capBytes, now: now}
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), ".tmp-") {
			_ = os.Remove(filepath.Join(dir, e.Name())) // a crashed write
			continue
		}
		if info, err := e.Info(); err == nil {
			s.total.Add(info.Size())
		}
	}
	return s, nil
}

func (s *programStore) path(cid string) string { return filepath.Join(s.dir, cid+".json") }

// Get returns a stored program.
func (s *programStore) Get(cid string) (*api.Program, bool) {
	if !reCID.MatchString(cid) {
		return nil, false
	}
	b, err := os.ReadFile(s.path(cid))
	if err != nil {
		return nil, false
	}
	var p api.Program
	if json.Unmarshal(b, &p) != nil || p.CID != cid || p.Text == "" {
		return nil, false
	}
	return &p, true
}

// Put stores text under its canonical CID (see api.ProgramStore). It never overwrites: a second Put of the
// same program returns the stored one, with its first meta.
func (s *programStore) Put(ctx context.Context, text string, meta api.Meta) (*api.Program, *api.CheckReport, error) {
	p, rep, _, err := s.put(ctx, text, meta, "")
	return p, rep, err
}

// put is Put plus the "must be <expect>" check of PUT /api/programs/<cid>, and whether it was new.
func (s *programStore) put(ctx context.Context, text string, meta api.Meta, expect string) (*api.Program, *api.CheckReport, bool, error) {
	if len(text) > s.maxBytes {
		return nil, nil, false, api.Errf(413, api.CodeTooLarge, "program is %d bytes; the limit is %d", len(text), s.maxBytes)
	}
	if strings.TrimSpace(text) == "" {
		return nil, nil, false, api.Errf(400, api.CodeBadRequest, "program text is empty")
	}
	if !utf8.ValidString(text) {
		return nil, nil, false, api.Errf(400, api.CodeBadRequest, "program text must be UTF-8")
	}
	if declaresNotPublic(text) {
		return nil, nil, false, api.Errf(422, api.CodeRestricted, "a program that says it is not public (`#! visibility:`) is not stored on this site")
	}
	rep, err := s.checker.Check(ctx, text)
	if err != nil {
		return nil, nil, false, err
	}
	if !rep.OK {
		e := api.Errf(422, api.CodeBadRequest, "the program has %d error(s): %s", rep.Errors, firstDiagnostic(rep))
		e.Details = map[string]any{"check": rep}
		return nil, rep, false, e
	}
	if rep.Restricted || rep.UsesAssets {
		return nil, rep, false, api.Errf(422, api.CodeRestricted, "programs that use restricted sounds or sample/loop assets are not stored on this site")
	}
	if rep.CID == "" || rep.Canonical == "" || !reCID.MatchString(rep.CID) {
		return nil, rep, false, fmt.Errorf("checker returned no usable CID")
	}
	// content addressing is the store's whole promise: what is kept under a CID must hash to it, whatever the
	// checker says (one SHA-256, microseconds)
	if want, err := btw.ProgramCID(rep.Canonical); err != nil || want != rep.CID {
		return nil, rep, false, fmt.Errorf("checker answered a CID (%s) that is not the hash of its canonical text (%s)", rep.CID, want)
	}
	if expect != "" && rep.CID != expect {
		return nil, rep, false, api.Errf(422, api.CodeCIDMismatch, "that text is program %s, not %s", rep.CID, expect)
	}
	if p, ok := s.Get(rep.CID); ok {
		return p, rep, false, nil
	}
	if meta.License == "" {
		meta.License = "CC0-1.0"
	}
	if meta.Visibility == "" {
		meta.Visibility = "public"
	}
	if meta.Created == "" {
		meta.Created = s.now().UTC().Format(time.RFC3339)
	}
	if meta.Source == "" {
		meta.Source = "put"
	}
	if meta.Name == "" {
		meta.Name = headerName(text)
	}
	prog := &api.Program{CID: rep.CID, Text: rep.Canonical, Meta: meta}
	b, err := json.Marshal(prog)
	if err != nil {
		return nil, rep, false, err
	}
	if s.total.Load()+int64(len(b)) > s.capBytes {
		e := api.Errf(507, "store_full", "the programs store is full")
		e.RetryAfter = 3600
		return nil, rep, false, e
	}
	tmp, err := os.CreateTemp(s.dir, ".tmp-*")
	if err != nil {
		return nil, rep, false, err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return nil, rep, false, err
	}
	if err := tmp.Close(); err != nil {
		return nil, rep, false, err
	}
	_ = os.Chmod(tmp.Name(), 0o644)
	// Link, not rename: if another request stored the same program a moment ago, theirs stays.
	if err := os.Link(tmp.Name(), s.path(rep.CID)); err != nil {
		if errors.Is(err, os.ErrExist) {
			if p, ok := s.Get(rep.CID); ok {
				return p, rep, false, nil
			}
		}
		return nil, rep, false, err
	}
	s.total.Add(int64(len(b)))
	return prog, rep, true, nil
}

// declaresNotPublic reports a `#! visibility:` header line whose value is anything but "public". btwd's own
// rule is the one spelling `#! visibility: private` (case and spaces between words aside), so `#!visibility:private`
// or `#! visibility: restricted` would reach the store as public programs; whoever wrote them meant them private,
// and this site never keeps, renders or sends to a model a program that says so. Stricter than btwd, never looser.
func declaresNotPublic(text string) bool {
	for _, l := range strings.Split(text, "\n") {
		t := strings.TrimSpace(l)
		rest, ok := strings.CutPrefix(t, "#!")
		if !ok {
			continue
		}
		squeezed := strings.ToLower(strings.Join(strings.Fields(rest), ""))
		if v, ok := strings.CutPrefix(squeezed, "visibility:"); ok && v != "public" {
			return true
		}
	}
	return false
}

func firstDiagnostic(r *api.CheckReport) string {
	for _, d := range r.Diagnostics {
		if d.Severity == "error" {
			return fmt.Sprintf("%d:%d %s", d.Line, d.Col, d.Message)
		}
	}
	return "see the diagnostics"
}

// headerName reads `#! name: X` from the text as submitted (comments are not in the canonical form).
func headerName(text string) string {
	for _, l := range strings.Split(text, "\n") {
		l = strings.TrimSpace(l)
		if rest, ok := strings.CutPrefix(l, "#!"); ok {
			if v, ok := strings.CutPrefix(strings.TrimSpace(rest), "name:"); ok {
				v = strings.TrimSpace(v)
				if len(v) > 80 {
					v = v[:80]
				}
				return strings.Map(func(r rune) rune {
					if r < 0x20 || r == 0x7f {
						return -1
					}
					return r
				}, v)
			}
		}
	}
	return ""
}

// btwFile is the `.btw` download: the text with the `#!` header lines (rights, provenance) in front.
// The header is comments, so it is not part of the CID.
func btwFile(p *api.Program) string {
	var b strings.Builder
	line := func(k, v string) {
		if v != "" {
			b.WriteString("#! " + k + ": " + oneLine(v) + "\n")
		}
	}
	line("name", p.Meta.Name)
	line("license", p.Meta.License)
	line("composed-by", p.Meta.ComposedBy)
	line("forked-from", p.Meta.ForkedFrom)
	line("cid", p.CID)
	b.WriteString(p.Text)
	if !strings.HasSuffix(p.Text, "\n") {
		b.WriteString("\n")
	}
	return b.String()
}

func oneLine(s string) string {
	return strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' {
			return ' '
		}
		return r
	}, s)
}

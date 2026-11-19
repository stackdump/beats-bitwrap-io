// Package card makes btw.bitwrap.io's share cards: a PNG per program (1200x630 and 1080x1080) and the small
// HTML page at /c/<cid> whose og: / twitter: tags make a link unfurl with that PNG. See btwsite/DESIGN.md
// "Cards".
//
// The look is code first: the program's most characteristic lines in Go Mono on a dark stage, frozen mid-play
// like the desktop's firing markers, over a strip with the section timeline and the track's facts. A card is a
// pure function of the program's canonical text (and its name): same CID, same bytes. Nothing but a public,
// unrestricted program ever reaches an image or a page; every other request gets the generic card.
package card

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"beats-bitwrap-io/internal/btw"
	"beats-bitwrap-io/internal/btwsite/api"
)

// version is part of every cached file's name: bump it when the look changes.
const version = "1"

// Options configures a Service.
type Options struct {
	Checker api.Checker
	// Store is the content-addressed store of public programs (may be nil: only examples and links then).
	Store api.ProgramStore
	// Examples / ExampleText are the public CC0 examples (as in compose.Options); either may be nil.
	Examples    func() []api.Example
	ExampleText func(name string) (string, bool)
	// PublicURL is the site's origin, https://btw.bitwrap.io (no trailing slash needed). Empty: taken from the request.
	PublicURL string
	// CacheDir holds rendered PNGs by (cid, variant). Empty: a small in-memory cache.
	CacheDir string
	// WebDir is the site's static directory. Reserved: the cards do not read it today.
	WebDir string

	// MaxTextBytes caps the program text a card will draw (default 32 KiB); longer gets the generic card.
	MaxTextBytes int
	// RenderConcurrency is how many cards render at once (default 2).
	RenderConcurrency int
	// CheckTimeout bounds one checker call (default 15 s).
	CheckTimeout time.Duration

	// CacheMaxBytes caps CacheDir (default 256 MiB): past it the least recently used cards are deleted. A stateless
	// link makes a card for any program anyone cares to write, so without a cap the cache is a way to fill the disk.
	CacheMaxBytes int64
	// WorkPerMinute is how many requests per address and minute may make the service work (a check of a link's
	// text that is not remembered, a card that is not cached); the rest get 429. Default 120; negative: no limit.
	// A card or page that is served from memory or disk costs nothing.
	WorkPerMinute int
	// CheckConcurrency is how many checker calls the cards may have running at once (default 2), so a flood of
	// distinct links cannot use every checker slot the rest of the site needs.
	CheckConcurrency int
}

// Service renders cards and answers /c/ and /card/.
type Service struct {
	o    Options
	site string // the host drawn on cards and named as og:site_name
	sem  chan struct{}

	mu      sync.Mutex
	flights map[string]*flight
	mem     map[string][]byte // in-memory PNGs when there is no CacheDir
	memKeys []string
	checks  map[string]*checked // by sha256 of the text
	spans   map[string][]api.Span
	generic [2][]byte
	genOnce [2]sync.Once
	genErr  [2]error

	csem   chan struct{} // checker calls in flight
	work   *workLimiter
	cfiles map[string]cacheFile // what is in CacheDir (the cap's books)
	ctotal int64
	cindex sync.Once
}

// cacheFile is one card on disk.
type cacheFile struct {
	size int64
	used time.Time
}

type flight struct {
	done chan struct{}
	data []byte
	err  error
}

type checked struct {
	report *api.CheckReport
}

// New builds a Service.
func New(o Options) (*Service, error) {
	if o.Checker == nil {
		return nil, errors.New("card: Options.Checker is required")
	}
	if o.MaxTextBytes <= 0 {
		o.MaxTextBytes = 32 << 10
	}
	if o.RenderConcurrency <= 0 {
		o.RenderConcurrency = 2
	}
	if o.CheckTimeout <= 0 {
		o.CheckTimeout = 15 * time.Second
	}
	if o.CacheMaxBytes <= 0 {
		o.CacheMaxBytes = 256 << 20
	}
	if o.WorkPerMinute == 0 {
		o.WorkPerMinute = 120
	}
	if o.CheckConcurrency <= 0 {
		o.CheckConcurrency = 2
	}
	o.PublicURL = strings.TrimRight(o.PublicURL, "/")
	if o.CacheDir != "" {
		if err := os.MkdirAll(o.CacheDir, 0o755); err != nil {
			return nil, fmt.Errorf("card: cache dir: %w", err)
		}
	}
	return &Service{
		o:       o,
		site:    siteOf(o.PublicURL),
		sem:     make(chan struct{}, o.RenderConcurrency),
		flights: map[string]*flight{},
		mem:     map[string][]byte{},
		checks:  map[string]*checked{},
		spans:   map[string][]api.Span{},
		csem:    make(chan struct{}, o.CheckConcurrency),
		work:    newWorkLimiter(o.WorkPerMinute, time.Now),
		cfiles:  map[string]cacheFile{},
	}, nil
}

// ---- the pure renderers ---------------------------------------------------------------------------------------

// Render draws the card for a program text. The text may be anything the language accepts (a header with
// `#! name:` / `#! license:` is read for the card's name and badge); the card is drawn from its canonical form,
// so the same program always gives the same bytes. A program with errors, a restricted or asset-using program
// and one marked `#! visibility: private` are refused (an *api.Error): use Generic for those.
func (s *Service) Render(text string, v Variant) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 4*s.o.CheckTimeout)
	defer cancel()
	meta := headerMeta(text)
	p, err := s.program(ctx, text, meta)
	if err != nil {
		return nil, err
	}
	if st := p.state(); st != stOK {
		return nil, refusal(st)
	}
	return s.renderPNG(ctx, p, v)
}

// Generic is the generic card (the one /card/default.png serves): a fixed sample program, nothing of any user's.
func (s *Service) Generic(v Variant) ([]byte, error) {
	i := 0
	if v == Square {
		i = 1
	}
	s.genOnce[i].Do(func() { s.generic[i], s.genErr[i] = drawCard(genericContent(s.site), v) })
	return s.generic[i], s.genErr[i]
}

func refusal(st state) *api.Error {
	switch st {
	case stRestricted:
		return api.Errf(http.StatusUnprocessableEntity, api.CodeRestricted, "this program uses assets or is restricted: it has no share card")
	case stPrivate:
		return api.Errf(http.StatusUnprocessableEntity, api.CodeRestricted, "this program is private: it has no share card")
	case stMismatch:
		return api.Errf(http.StatusUnprocessableEntity, api.CodeCIDMismatch, "the text is not the program the CID names")
	}
	return api.Errf(http.StatusBadRequest, api.CodeBadRequest, "the program does not check: it has no share card")
}

// ---- programs ----------------------------------------------------------------------------------------------------

type state int

const (
	stOK state = iota
	stUnknown
	stMismatch
	stRestricted
	stPrivate
	stInvalid
)

// prog is a program ready to be drawn or described.
type prog struct {
	cid       string
	canonical string
	report    *api.CheckReport
	meta      api.Meta
	desc      string // first comment line of the original text, when known
	exName    string // the example's name
	exDesc    string // the example's description
	st        state
	known     bool   // the program is an example or in the store
	packed    string // the link's own packed text, when it is the canonical text
}

func (p *prog) state() state {
	switch {
	case p.st != stOK:
		return p.st
	case p.report == nil || !p.report.OK || p.report.CID == "":
		return stInvalid
	case p.report.Restricted || p.report.UsesAssets:
		return stRestricted
	case isPrivate(p.meta):
		return stPrivate
	}
	return stOK
}

func isPrivate(m api.Meta) bool {
	v := strings.ToLower(strings.TrimSpace(m.Visibility))
	return v == "private" || v == "restricted" || v == "unlisted-private"
}

// headerMeta reads the `#! key: value` header of an original text.
func headerMeta(text string) api.Meta {
	var m api.Meta
	for _, l := range strings.Split(text, "\n") {
		t := strings.TrimSpace(l)
		if t == "" {
			continue
		}
		if !strings.HasPrefix(t, "#!") {
			if strings.HasPrefix(t, "#") {
				continue
			}
			break
		}
		k, v, ok := strings.Cut(strings.TrimSpace(strings.TrimPrefix(t, "#!")), ":")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		switch strings.ToLower(strings.TrimSpace(k)) {
		case "name":
			m.Name = v
		case "license":
			m.License = v
		case "visibility":
			m.Visibility = v
		}
	}
	return m
}

// firstComment is the first plain comment line (not a `#!` header line) of an original text.
func firstComment(text string) string {
	for _, l := range strings.Split(text, "\n") {
		t := strings.TrimSpace(l)
		if strings.HasPrefix(t, "#") && !strings.HasPrefix(t, "#!") {
			if c := cleanText(strings.TrimSpace(strings.TrimLeft(t, "#")), 200); c != "" {
				return c
			}
		}
	}
	return ""
}

func textKey(text string) string {
	h := sha256.Sum256([]byte(text))
	return hex.EncodeToString(h[:])
}

// check runs the checker on text (memoised: bots ask for the same link again and again). A call that is not
// memoised is work: it is charged to the requesting address and takes one of the cards' checker slots.
func (s *Service) check(ctx context.Context, text string) (*checked, error) {
	k := textKey(text)
	s.mu.Lock()
	if c, ok := s.checks[k]; ok {
		s.mu.Unlock()
		return c, nil
	}
	s.mu.Unlock()
	if err := s.allowWork(ctx); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, s.o.CheckTimeout)
	defer cancel()
	select {
	case s.csem <- struct{}{}:
		defer func() { <-s.csem }()
	case <-cctx.Done():
		return nil, api.Errf(http.StatusServiceUnavailable, "busy", "the checker is busy; try again in a moment")
	}
	rep, err := s.o.Checker.Check(cctx, text)
	if err != nil {
		return nil, err
	}
	// Keep what a card is drawn from, not the checker's whole answer: a hostile program can make that megabytes,
	// and 256 of them are remembered.
	slim := *rep
	slim.Diagnostics, slim.Lineage, slim.Nets, slim.SongNets, slim.Evolve = nil, nil, nil, nil, nil
	c := &checked{report: &slim}
	s.mu.Lock()
	if len(s.checks) >= 256 {
		s.checks = map[string]*checked{}
	}
	s.checks[k] = c
	s.mu.Unlock()
	return c, nil
}

// highlight is the colouring of text (memoised like checks are).
func (s *Service) highlight(ctx context.Context, text string) []api.Span {
	k := textKey(text)
	s.mu.Lock()
	if sp, ok := s.spans[k]; ok {
		s.mu.Unlock()
		return sp
	}
	s.mu.Unlock()
	cctx, cancel := context.WithTimeout(ctx, s.o.CheckTimeout)
	defer cancel()
	var sp []api.Span
	var err error
	select {
	case s.csem <- struct{}{}:
		sp, err = s.o.Checker.Highlight(cctx, text)
		<-s.csem
	case <-cctx.Done():
		err = cctx.Err()
	}
	if err != nil || len(sp) == 0 || !hasCode(sp) {
		sp = basicSpans(text) // btwd is down, or the checker gave nothing to colour by: a coarse lexer
	}
	s.mu.Lock()
	if len(s.spans) >= 64 {
		s.spans = map[string][]api.Span{}
	}
	s.spans[k] = sp
	s.mu.Unlock()
	return sp
}

// hasCode: the spans colour more than comments (the canonical text has none).
func hasCode(sp []api.Span) bool {
	for _, s := range sp {
		if s.Class != "comment" {
			return true
		}
	}
	return false
}

// program checks text and returns it ready to draw. The error is an *api.Error for a text that is too large.
func (s *Service) program(ctx context.Context, text string, meta api.Meta) (*prog, error) {
	if len(text) > s.o.MaxTextBytes {
		return nil, api.Errf(http.StatusRequestEntityTooLarge, api.CodeTooLarge, "program text is over %d bytes: no card", s.o.MaxTextBytes)
	}
	c, err := s.check(ctx, text)
	if err != nil {
		return nil, err
	}
	p := &prog{report: c.report, meta: meta, canonical: c.report.Canonical, cid: c.report.CID, desc: firstComment(text)}
	return p, nil
}

var cidRe = regexp.MustCompile(`^z[1-9A-HJ-NP-Za-km-z]{20,120}$`)

func validCID(c string) bool { return cidRe.MatchString(c) }

// known looks a CID up in the examples and the store: the original text when it is an example (with its
// comments), the canonical text from the store, and the meta.
func (s *Service) known(cid string) (text string, meta api.Meta, ex *api.Example, ok bool) {
	if s.o.Examples != nil {
		for _, e := range s.o.Examples() {
			if e.CID != cid {
				continue
			}
			e := e
			if s.o.ExampleText != nil {
				if t, found := s.o.ExampleText(e.Name); found {
					m := headerMeta(t)
					if m.Name == "" {
						m.Name = e.Name
					}
					if m.License == "" {
						m.License = e.License
					}
					return t, m, &e, true
				}
			}
		}
	}
	if s.o.Store != nil {
		if p, found := s.o.Store.Get(cid); found && p != nil {
			return p.Text, p.Meta, nil, true
		}
	}
	return "", api.Meta{}, nil, false
}

// resolve turns a request (a CID, with the program text when the link carries it) into a program or the reason
// it must get the generic card. err is set only for infrastructure failures (the checker is down).
func (s *Service) resolve(ctx context.Context, cid, packed string) (*prog, error) {
	if !validCID(cid) {
		return &prog{cid: cid, st: stInvalid}, nil
	}
	ktext, kmeta, kex, known := s.known(cid)
	var p *prog
	switch {
	case packed != "":
		if len(packed) > s.o.MaxTextBytes {
			return &prog{cid: cid, st: stInvalid}, nil
		}
		link, err := btw.Parse(cid + "." + packed)
		if err != nil || link.Text == "" || link.CID != cid {
			return &prog{cid: cid, st: stInvalid}, nil
		}
		if len(link.Text) > s.o.MaxTextBytes {
			return &prog{cid: cid, st: stInvalid}, nil
		}
		var meta api.Meta
		if known {
			meta = kmeta
		}
		q, err := s.program(ctx, link.Text, meta)
		if err != nil {
			if isBadProgram(err) {
				return &prog{cid: cid, st: stInvalid}, nil
			}
			return nil, err
		}
		p = q
	case known:
		q, err := s.program(ctx, ktext, kmeta)
		if err != nil {
			if isBadProgram(err) {
				return &prog{cid: cid, st: stInvalid}, nil
			}
			return nil, err
		}
		p = q
	default:
		return &prog{cid: cid, st: stUnknown}, nil
	}
	if packed != "" && p.canonical != "" {
		if link, err := btw.Parse(cid + "." + packed); err == nil && link.Text == p.canonical {
			p.packed = packed
		}
	}
	p.known = known
	if known {
		p.meta = kmeta
		if kex != nil {
			p.exName, p.exDesc = kex.Name, kex.Description
		}
		if d := firstComment(ktext); d != "" {
			p.desc = d
		}
	}
	if p.report == nil || !p.report.OK {
		p.st = stInvalid
		return p, nil
	}
	if p.report.CID != cid {
		p.st = stMismatch
		return p, nil
	}
	return p, nil
}

// isBadProgram: the error says the program itself cannot be drawn (too long, too many problems to list), as
// opposed to the service being busy, rate limited or down: those must not turn a good program's page into a
// cached "invalid" card.
func isBadProgram(err error) bool {
	var ae *api.Error
	return errors.As(err, &ae) && (ae.Status == http.StatusRequestEntityTooLarge || ae.Status == http.StatusUnprocessableEntity)
}

// name is what the program is called on its card and page.
func (p *prog) name() string {
	n := cleanText(p.meta.Name, 60)
	if n == "" {
		n = cleanText(p.exName, 60)
	}
	if n == "" {
		n = "btw " + shortCID(p.cid)
	}
	return n
}

// ---- drawing with the cache, the flights and the semaphore ---------------------------------------------------

func nameHash(p *prog) string {
	n := cleanText(p.meta.Name, 60)
	if n == "" {
		n = cleanText(p.exName, 60)
	}
	if n == "" {
		return ""
	}
	h := sha256.Sum256([]byte(n))
	return hex.EncodeToString(h[:4])
}

func (s *Service) cacheName(p *prog, v Variant) string {
	n := p.cid + "." + v.String() + ".v" + version
	if s.site != "btw" { // the host is drawn on the card, so a card made under another name is another file
		h := sha256.Sum256([]byte(s.site))
		n += ".s" + hex.EncodeToString(h[:3])
	}
	if h := nameHash(p) + licenseHash(p); h != "" {
		n += "." + h
	}
	return n + ".png"
}

func licenseHash(p *prog) string {
	l := licenseBadge(p.meta.License)
	if l == "CC0" {
		return ""
	}
	h := sha256.Sum256([]byte(l))
	return hex.EncodeToString(h[:2])
}

// etag is the CID and variant (plus what else shaped the pixels: the name and a non-default licence).
func (s *Service) etag(p *prog, v Variant) string {
	n := p.cid + "-" + v.String()
	if h := nameHash(p) + licenseHash(p); h != "" {
		n += "-" + h
	}
	return `"` + n + `"`
}

func (s *Service) draw(ctx context.Context, p *prog, v Variant) ([]byte, error) {
	key := s.cacheName(p, v)
	if b := s.cacheGet(key); b != nil {
		return b, nil
	}
	s.mu.Lock()
	if f, ok := s.flights[key]; ok {
		s.mu.Unlock()
		select {
		case <-f.done:
			return f.data, f.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	f := &flight{done: make(chan struct{})}
	s.flights[key] = f
	s.mu.Unlock()

	if err := s.allowWork(ctx); err != nil {
		f.err = err
	} else {
		f.data, f.err = s.renderPNG(ctx, p, v)
	}
	if f.err == nil {
		s.cachePut(key, f.data)
	}
	s.mu.Lock()
	delete(s.flights, key)
	s.mu.Unlock()
	close(f.done)
	return f.data, f.err
}

// renderPNG draws p, under the render semaphore and without the cache: the pure function Render is.
func (s *Service) renderPNG(ctx context.Context, p *prog, v Variant) ([]byte, error) {
	select {
	case s.sem <- struct{}{}:
		defer func() { <-s.sem }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	text := p.canonical
	spans := s.highlight(ctx, text)
	rep := p.report
	ct := &content{
		Seed: p.cid, CID: p.cid, Name: p.name(), License: p.meta.License, Canonical: text, Spans: spans,
		Key: rep.Key, Bars: rep.SongBars, Sections: rep.Sections, Site: s.site,
	}
	if rep.Tempo != nil {
		ct.Tempo = *rep.Tempo
	}
	if rep.Seconds != nil {
		ct.Seconds = *rep.Seconds
	} else if rep.Tempo != nil && *rep.Tempo > 0 && rep.SongBars > 0 {
		ct.Seconds = float64(rep.SongBars) * 4 * 60 / *rep.Tempo
	}
	return drawCard(ct, v)
}

func (s *Service) cacheGet(key string) []byte {
	if s.o.CacheDir == "" {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.mem[key]
	}
	b, err := os.ReadFile(filepath.Join(s.o.CacheDir, key))
	if err != nil || len(b) == 0 {
		return nil
	}
	s.mu.Lock()
	if f, ok := s.cfiles[key]; ok {
		f.used = time.Now()
		s.cfiles[key] = f
	}
	s.mu.Unlock()
	return b
}

// indexCache reads CacheDir once: the books the cap is kept by. Leftover temp files of a crash go.
func (s *Service) indexCache() {
	s.cindex.Do(func() {
		ents, err := os.ReadDir(s.o.CacheDir)
		if err != nil {
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		for _, e := range ents {
			if strings.HasPrefix(e.Name(), ".card-") {
				_ = os.Remove(filepath.Join(s.o.CacheDir, e.Name()))
				continue
			}
			if info, err := e.Info(); err == nil && info.Mode().IsRegular() {
				s.cfiles[e.Name()] = cacheFile{size: info.Size(), used: info.ModTime()}
				s.ctotal += info.Size()
			}
		}
	})
}

// evictLocked deletes the least recently used cards until the cache fits its cap (keep is never deleted).
func (s *Service) evictLocked(keep string) {
	if s.ctotal <= s.o.CacheMaxBytes {
		return
	}
	names := make([]string, 0, len(s.cfiles))
	for n := range s.cfiles {
		if n != keep {
			names = append(names, n)
		}
	}
	sort.Slice(names, func(i, j int) bool { return s.cfiles[names[i]].used.Before(s.cfiles[names[j]].used) })
	for _, n := range names {
		if s.ctotal <= s.o.CacheMaxBytes {
			break
		}
		_ = os.Remove(filepath.Join(s.o.CacheDir, n))
		s.ctotal -= s.cfiles[n].size
		delete(s.cfiles, n)
	}
}

func (s *Service) cachePut(key string, b []byte) {
	if s.o.CacheDir == "" {
		s.mu.Lock()
		defer s.mu.Unlock()
		if _, ok := s.mem[key]; !ok {
			s.memKeys = append(s.memKeys, key)
			if len(s.memKeys) > 64 {
				delete(s.mem, s.memKeys[0])
				s.memKeys = s.memKeys[1:]
			}
		}
		s.mem[key] = b
		return
	}
	s.indexCache()
	// write beside, then rename: a reader never sees half a file
	tmp, err := os.CreateTemp(s.o.CacheDir, ".card-*.tmp")
	if err != nil {
		return
	}
	_, werr := tmp.Write(b)
	cerr := tmp.Close()
	if werr != nil || cerr != nil {
		_ = os.Remove(tmp.Name())
		return
	}
	if err := os.Rename(tmp.Name(), filepath.Join(s.o.CacheDir, key)); err != nil {
		_ = os.Remove(tmp.Name())
		return
	}
	s.mu.Lock()
	if old, ok := s.cfiles[key]; ok {
		s.ctotal -= old.size
	}
	s.cfiles[key] = cacheFile{size: int64(len(b)), used: time.Now()}
	s.ctotal += int64(len(b))
	s.evictLocked(key)
	s.mu.Unlock()
}

// pngBytes is a helper for tests: whether b is a PNG.
func isPNG(b []byte) bool { return bytes.HasPrefix(b, []byte("\x89PNG\r\n\x1a\n")) }

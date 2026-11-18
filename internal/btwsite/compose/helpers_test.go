package compose

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
	"beats-bitwrap-io/internal/btwsite/fakecheck"
	"beats-bitwrap-io/internal/btwsite/limits"
)

// ---------- clock ----------

type testClock struct {
	mu sync.Mutex
	t  time.Time
}

func newTestClock(s string) *testClock {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return &testClock{t: t}
}
func (c *testClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *testClock) Add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

// ---------- checker: fakecheck, plus a warning on "WARN" and a record of what it was asked ----------

type spyChecker struct {
	fakecheck.Checker
	mu     sync.Mutex
	checks []string
}

func (c *spyChecker) Check(ctx context.Context, text string) (*api.CheckReport, error) {
	c.mu.Lock()
	c.checks = append(c.checks, text)
	c.mu.Unlock()
	r, err := c.Checker.Check(ctx, text)
	if err == nil && strings.Contains(text, "WARN") {
		r.Warnings++
		r.Diagnostics = append(r.Diagnostics, api.Diagnostic{Severity: "warning", Line: 1, Col: 1, Message: "a warning"})
	}
	return r, err
}

func (c *spyChecker) Checked() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.checks...)
}

// ---------- store ----------

type memStore struct {
	mu   sync.Mutex
	c    api.Checker
	m    map[string]api.Program
	puts []api.Program
}

func newMemStore(c api.Checker) *memStore { return &memStore{c: c, m: map[string]api.Program{}} }

func (s *memStore) Put(ctx context.Context, text string, meta api.Meta) (*api.Program, *api.CheckReport, error) {
	r, err := s.c.Check(ctx, text)
	if err != nil {
		return nil, nil, err
	}
	if !r.OK {
		return nil, r, api.Errf(422, "check_failed", "the program has errors")
	}
	if r.Restricted || r.UsesAssets {
		return nil, r, api.Errf(422, api.CodeRestricted, "restricted")
	}
	if meta.License == "" {
		meta.License = "CC0-1.0"
	}
	p := api.Program{CID: r.CID, Text: r.Canonical, Meta: meta}
	s.mu.Lock()
	s.m[p.CID] = p
	s.puts = append(s.puts, p)
	s.mu.Unlock()
	return &p, r, nil
}

func (s *memStore) Get(cid string) (*api.Program, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.m[cid]
	return &p, ok
}

// insert puts a program in directly, past the checks (for restricted / private bases).
func (s *memStore) insert(cid, text string, meta api.Meta) {
	s.mu.Lock()
	s.m[cid] = api.Program{CID: cid, Text: text, Meta: meta}
	s.mu.Unlock()
}

// ---------- auth ----------

// testAuth: the user is named by the X-Test-User header; X-Test-Bad is a credential that is present but invalid.
type testAuth struct{}

func (testAuth) UserFrom(r *http.Request) (*api.User, error) {
	if r.Header.Get("X-Test-Bad") != "" {
		return nil, api.Errf(401, api.CodeBadSignature, "bad credential")
	}
	if id := r.Header.Get("X-Test-User"); id != "" {
		return &api.User{ID: id, Kind: "eth", Address: id, Via: "cookie"}, nil
	}
	return nil, nil
}
func (testAuth) UserFromToken(string) *api.User { return nil }

// ---------- examples ----------

const exShort = "# a short one\ntempo 120\nkey am\ndeck A: kick x ~ x ~ | snare ~ x ~ x\n"
const exSong = "#! name: song\n#! license: CC0-1.0\n#! visibility: public\ntempo 130\nkey am\nsection intro 8 bars {\n  deck A: kick x ~ x ~\n}\nsection drop 16 bars {\n  deck A: kick x ~ x ~ | snare ~ x ~ x\n}\narrange intro drop\n"
const exRamp = "tempo 124\nkey am\ndeck A: kick x ~ x ~\nmaster: filter lp 300 -> 2800 over 8 bars\n"

type exSet struct {
	list  []api.Example
	texts map[string]string
}

func (e *exSet) add(name, license, text string) *exSet {
	rep, _ := fakecheck.Checker{}.Check(context.Background(), text)
	e.list = append(e.list, api.Example{Name: name, Title: name, CID: rep.CID, License: license})
	if e.texts == nil {
		e.texts = map[string]string{}
	}
	e.texts[name] = text
	return e
}
func (e *exSet) Examples() []api.Example { return e.list }
func (e *exSet) Text(n string) (string, bool) {
	t, ok := e.texts[n]
	return t, ok
}

func goodExamples() *exSet {
	e := &exSet{}
	return e.add("short", "CC0-1.0", exShort).add("song", "CC0-1.0", exSong).add("ramp", "CC0-1.0", exRamp)
}

// ---------- the service under test ----------

type rig struct {
	t     *testing.T
	svc   *Service
	chk   *spyChecker
	store *memStore
	clock *testClock
	fake  *FakeModel
	ex    *exSet
	dir   string
}

type rigOpts struct {
	mutate    func(*Options)
	noFake    bool // no model at all (not configured)
	dir       string
	clock     *testClock
	examples  *exSet
	skipClose bool
}

func newRig(t *testing.T, ro rigOpts) *rig {
	t.Helper()
	r := &rig{t: t, chk: &spyChecker{}, ex: ro.examples, clock: ro.clock, dir: ro.dir}
	if r.ex == nil {
		r.ex = goodExamples()
	}
	if r.clock == nil {
		r.clock = newTestClock("2026-11-17T10:00:00Z")
	}
	if r.dir == "" {
		r.dir = t.TempDir()
	}
	r.store = newMemStore(r.chk)
	opt := Options{
		Checker: r.chk, Store: r.store, Examples: r.ex.Examples, ExampleText: r.ex.Text,
		DataDir: r.dir, PublicURL: "https://btw.example.test", Now: r.clock.Now,
		Limits:          limits.Config{UserHour: 100, UserDay: 100, IPDay: 100, DailySpendUSD: 100},
		MaxOutputTokens: 1000,
	}
	if !ro.noFake {
		fm, err := DefaultFakeModel()
		if err != nil {
			t.Fatal(err)
		}
		r.fake = fm
		opt.FakeModel = fm
	}
	if ro.mutate != nil {
		ro.mutate(&opt)
	}
	svc, err := New(opt)
	if err != nil {
		t.Fatal(err)
	}
	r.svc = svc
	if !ro.skipClose {
		t.Cleanup(func() { svc.Close() })
	}
	return r
}

// call posts body to the compose handler as user ("" = no credentials).
func call(h http.Handler, user, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/compose", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if user != "" {
		req.Header.Set("X-Test-User", user)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}

func (r *rig) post(user, body string) *httptest.ResponseRecorder {
	return call(r.svc.Handler(testAuth{}), user, body)
}

func jbody(prompt string) string {
	b, _ := json.Marshal(map[string]any{"prompt": prompt})
	return string(b)
}

type errBody struct {
	Error struct {
		Code       string          `json:"code"`
		Message    string          `json:"message"`
		RetryAfter int             `json:"retry_after"`
		Details    json.RawMessage `json:"details"`
	} `json:"error"`
}

func decodeErr(t *testing.T, w *httptest.ResponseRecorder) errBody {
	t.Helper()
	var e errBody
	if err := json.Unmarshal(w.Body.Bytes(), &e); err != nil {
		t.Fatalf("not an error body: %v: %s", err, w.Body.String())
	}
	return e
}

func mustOK(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	var m map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatal(err)
	}
	return m
}

// allFiles returns the contents of every file under dir, concatenated, for "never in the logs" scans.
func allFiles(t *testing.T, dir string) string {
	t.Helper()
	var b bytes.Buffer
	_ = filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		f, err := os.Open(p)
		if err != nil {
			return nil
		}
		defer f.Close()
		b.WriteString("\n== " + p + "\n")
		_, _ = io.Copy(&b, f)
		return nil
	})
	return b.String()
}

// gateModel wraps a Model so a test can hold calls inside Generate.
type gateModel struct {
	inner   Model
	entered chan struct{}
	release chan struct{}
}

func (g *gateModel) Generate(ctx context.Context, system string, msgs []Message) (string, Usage, error) {
	g.entered <- struct{}{}
	select {
	case <-g.release:
	case <-ctx.Done():
	}
	return g.inner.Generate(ctx, system, msgs)
}

// scriptModel answers with the given steps, one per call (the last repeats), and records what it was sent.
type scriptModel struct {
	mu    sync.Mutex
	steps []scriptStep
	calls []FakeCall
}
type scriptStep struct {
	text string
	use  Usage
	err  error
}

func (m *scriptModel) Generate(_ context.Context, system string, msgs []Message) (string, Usage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls = append(m.calls, FakeCall{System: system, Messages: append([]Message(nil), msgs...)})
	i := len(m.calls) - 1
	if i >= len(m.steps) {
		i = len(m.steps) - 1
	}
	s := m.steps[i]
	return s.text, s.use, s.err
}

func newLogger(w io.Writer) *log.Logger { return log.New(w, "", 0) }

var licenseHeader = regexp.MustCompile(`(?m)^#!\s*license:\s*(\S+)`)

// loadExamplesDir reads *.btw from dir the way the site's example loader does: name from the file, CID from
// the checker, licence from the "#! license:" header (an example with none is not offered).
func loadExamplesDir(t *testing.T, c api.Checker, dir string) ([]api.Example, map[string]string) {
	t.Helper()
	files, _ := filepath.Glob(filepath.Join(dir, "*.btw"))
	var exs []api.Example
	texts := map[string]string{}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		name := strings.TrimSuffix(filepath.Base(f), ".btw")
		rep, err := c.Check(context.Background(), string(b))
		if err != nil || !rep.OK {
			continue
		}
		lic := ""
		if m := licenseHeader.FindStringSubmatch(string(b)); m != nil {
			lic = m[1]
		}
		exs = append(exs, api.Example{Name: name, Title: name, CID: rep.CID, License: lic})
		texts[name] = string(b)
	}
	return exs, texts
}

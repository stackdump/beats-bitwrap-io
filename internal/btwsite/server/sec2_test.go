package server

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"beats-bitwrap-io/internal/btwsite/api"
	"beats-bitwrap-io/internal/btwsite/btwd"
	"beats-bitwrap-io/internal/btwsite/fakecheck"
)

// ownerChecker is the fake checker that remembers who each call was charged to.
type ownerChecker struct {
	fakecheck.Checker
	mu     sync.Mutex
	owners map[string]bool
}

func (o *ownerChecker) Check(ctx context.Context, text string) (*api.CheckReport, error) {
	o.mu.Lock()
	o.owners[btwd.OwnerFrom(ctx)] = true
	o.mu.Unlock()
	return o.Checker.Check(ctx, text)
}

// Everything the checker does for a request is charged to the client's address (the btwd client limits what one
// address may hold and spend), whichever door the request came in by.
func TestCheckerIsChargedToTheClientAddress(t *testing.T) {
	oc := &ownerChecker{owners: map[string]bool{}}
	e := newEnv(t, func(c *Config) { c.Checker = oc })
	const who = "203.0.113.77"
	cid := e.put(progA)
	asked := 0
	var askedPaths []string
	for _, req := range []struct{ method, path, body string }{
		{"POST", "/api/check", `{"text":"` + strings.ReplaceAll(progB, "\n", `\n`) + `"}`},
		{"PUT", "/api/programs/" + e.put(progC), progC},
		{"GET", "/c/" + cid, ""},
		{"GET", "/card/" + cid + ".png", ""},
		{"GET", "/api/render/" + cid + "/status", ""},
		{"POST", "/mcp", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check","arguments":{"text":"` + strings.ReplaceAll(progB, "\n", `\n`) + `"}}}`},
	} {
		oc.mu.Lock()
		oc.owners = map[string]bool{}
		oc.mu.Unlock()
		var body *strings.Reader
		if req.body != "" {
			body = strings.NewReader(req.body)
		} else {
			body = strings.NewReader("")
		}
		ct := "application/json"
		if req.method == "PUT" {
			ct = "text/plain"
		}
		resp := e.do(req.method, req.path, body, hdr("Content-Type", ct), hdr("Accept", "application/json, text/event-stream"), ip(who))
		resp.Body.Close()
		oc.mu.Lock()
		got := oc.owners
		oc.mu.Unlock()
		if len(got) == 0 {
			continue // answered from a cache: nothing was asked of the checker
		}
		asked++
		askedPaths = append(askedPaths, req.path)
		if len(got) != 1 || !got[who] {
			t.Errorf("%s %s: the checker was asked for owners %v, want only %q", req.method, req.path, got, who)
		}
	}
	if asked < 4 || !strings.Contains(strings.Join(askedPaths, " "), "/mcp") || !strings.Contains(strings.Join(askedPaths, " "), "/api/check") {
		t.Fatalf("only %v of the requests reached the checker (need /api/check and /mcp among them): the test proves little", askedPaths)
	}
}

// PUT of text that is not UTF-8 is a 400 about the text, not a 502 about the checker.
func TestPutRefusesInvalidUTF8(t *testing.T) {
	e := newEnv(t, nil)
	cid := e.put(progA)
	resp := e.do("PUT", "/api/programs/"+cid, strings.NewReader("tempo 120\n\xff\xfe\x00\x80\n"), hdr("Content-Type", "text/plain"), ip("192.0.2.9"))
	if st, code := errCode(t, resp); st != http.StatusBadRequest || code != api.CodeBadRequest {
		t.Fatalf("invalid UTF-8: %d %s, want 400 bad_request", st, code)
	}
}

// A program that says it is not public is never stored, however it spells the header: btwd only knows
// `#! visibility: private`, so `#!visibility:private` would otherwise be kept (and rendered, carded) as public.
func TestPutRefusesProgramsThatSayTheyAreNotPublic(t *testing.T) {
	e := newEnv(t, nil)
	for _, h := range []string{"#!visibility:private", "#! Visibility :  PRIVATE", "#!   visibility: restricted", "#! visibility: unlisted-private", "#! visibility: team"} {
		text := h + "\n" + progA
		var rep api.CheckReport
		decode(t, e.post("/api/check", map[string]string{"text": text}, ip("192.0.2.30")), &rep)
		cid := rep.CID
		if cid == "" {
			t.Fatalf("%q: the fake checker gave no CID", h)
		}
		resp := e.do("PUT", "/api/programs/"+cid, strings.NewReader(text), hdr("Content-Type", "text/plain"), ip("192.0.2.31"))
		if st, code := errCode(t, resp); st != http.StatusUnprocessableEntity || code != api.CodeRestricted {
			t.Errorf("%q: %d %s, want 422 restricted", h, st, code)
		}
	}
	// `public` (any spacing) still goes in
	text := "#!visibility:public\n" + progB
	var rep api.CheckReport
	decode(t, e.post("/api/check", map[string]string{"text": text}, ip("192.0.2.30")), &rep)
	resp := e.do("PUT", "/api/programs/"+rep.CID, strings.NewReader(text), hdr("Content-Type", "text/plain"), ip("192.0.2.31"))
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("a public program: %d %s", resp.StatusCode, readAll(t, resp))
	}
	resp.Body.Close()
}

// An example that says it is not public stops the server, spelled however it likes.
func TestExampleThatSaysItIsNotPublicStopsTheServer(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "sneaky.btw"), []byte("#!visibility:private\ntempo 120\nkey am\ndeck A: kick x ~ x ~\nsection intro 2 bars\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "index.json"), []byte(`[{"name":"sneaky","title":"sneaky"}]`), 0o644)
	cfg := DefaultConfig()
	cfg.DataDir, cfg.ExamplesDir, cfg.Checker, cfg.Logf = filepath.Join(dir, "data"), dir, fakeChecker(), t.Logf
	if srv, err := New(cfg); err == nil {
		srv.Close()
		t.Fatal("the server started with an example that says it is private")
	} else if !strings.Contains(err.Error(), "sneaky") {
		t.Fatalf("the error should name the example: %v", err)
	}
}

// Anyone can PUT an example's text first (its CID is public) and the first meta in the store wins: the example's
// name, licence and source must still be the example's.
func TestStoredCopyDoesNotRenameAnExample(t *testing.T) {
	e := newEnv(t, nil)
	ex := e.srv.Examples()[0]
	text, _ := e.srv.Example(ex.Name)
	squat := "#! name: free crypto at example.test\n" + text
	var rep api.CheckReport
	decode(t, e.post("/api/check", map[string]string{"text": squat}, ip("192.0.2.40")), &rep)
	if rep.CID != ex.CID {
		t.Fatalf("test setup: the squatting copy is %s, the example %s", rep.CID, ex.CID)
	}
	resp := e.do("PUT", "/api/programs/"+rep.CID, strings.NewReader(squat), hdr("Content-Type", "text/plain"), ip("192.0.2.41"))
	resp.Body.Close()
	var got api.Program
	if st := decode(t, e.get("/api/programs/"+ex.CID), &got); st != 200 {
		t.Fatalf("get: %d", st)
	}
	if got.Meta.Source != "example" || strings.Contains(got.Meta.Name, "crypto") {
		t.Fatalf("the example now says %+v", got.Meta)
	}
	if p, _ := e.srv.Get(ex.CID); p.Meta.Source != "example" {
		t.Fatalf("Backend.Get: %+v", p.Meta)
	}
}

// A flood of cheap requests must not make the access log grow without limit (retention is by age only).
func TestAccessLogHasADailyCap(t *testing.T) {
	old := maxLogDayBytes
	maxLogDayBytes = 4096
	defer func() { maxLogDayBytes = old }()
	e := newEnv(t, nil)
	for i := 0; i < 200; i++ {
		e.get("/healthz").Body.Close()
	}
	e.srv.log.Close()
	files, _ := filepath.Glob(filepath.Join(e.cfg.DataDir, "log", "access-*.jsonl"))
	if len(files) != 1 {
		t.Fatalf("log files: %v", files)
	}
	b, _ := os.ReadFile(files[0])
	if len(b) > 4096+512 {
		t.Fatalf("the day's log is %d bytes, cap 4096", len(b))
	}
	if !strings.Contains(string(b), "daily log cap reached") {
		t.Fatalf("the cap is not announced in the file:\n%s", b[len(b)-300:])
	}
}

// liar is a checker whose CID is not the hash of the canonical text it returns.
type liar struct{ fakecheck.Checker }

func (l liar) Check(ctx context.Context, text string) (*api.CheckReport, error) {
	r, err := l.Checker.Check(ctx, text)
	if err == nil && r.OK {
		r.Canonical += "# smuggled\n" // the stored text would no longer be the program the CID names
	}
	return r, err
}

// The store keeps under a CID only text that hashes to it, whatever the checker answers.
func TestStoreKeepsOnlyTextThatHashesToItsCID(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.Checker = liar{} })
	var rep api.CheckReport
	decode(t, e.post("/api/check", map[string]string{"text": progB}, ip("192.0.2.60")), &rep)
	resp := e.do("PUT", "/api/programs/"+rep.CID, strings.NewReader(progB), hdr("Content-Type", "text/plain"), ip("192.0.2.61"))
	if resp.StatusCode < 500 {
		t.Fatalf("a checker answer that does not hash to its CID was accepted: %d", resp.StatusCode)
	}
	resp.Body.Close()
	if _, ok := e.srv.Get(rep.CID); ok {
		t.Fatal("it was stored")
	}
}

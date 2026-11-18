package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
	"beats-bitwrap-io/internal/btwsite/fakecheck"
)

func TestStatic(t *testing.T) {
	e := newEnv(t, nil)
	resp := e.get("/")
	body := string(readAll(t, resp))
	if resp.StatusCode != 200 || !strings.Contains(body, "<p>index") || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/html") {
		t.Fatalf("/: %d %q %v", resp.StatusCode, body, resp.Header)
	}
	if resp.Header.Get("Cache-Control") != "no-cache" || resp.Header.Get("ETag") == "" {
		t.Fatalf("validators: %v", resp.Header)
	}
	tag := resp.Header.Get("ETag")
	if r := e.get("/", hdr("If-None-Match", tag)); r.StatusCode != 304 {
		t.Fatalf("conditional GET: %d", r.StatusCode)
	}
	// /p is the same page; so is /index.html
	for _, p := range []string{"/p", "/index.html"} {
		if r := e.get(p); r.StatusCode != 200 || readAll(t, r) == nil {
			t.Fatalf("%s: %d", p, r.StatusCode)
		}
	}
	// a changed file gets a new ETag
	os.WriteFile(filepath.Join(e.web, "index.html"), []byte("<!doctype html><p>index v2 with more bytes"), 0o644)
	if r := e.get("/", hdr("If-None-Match", tag)); r.StatusCode != 200 || r.Header.Get("ETag") == tag {
		t.Fatalf("after a change: %d %v", r.StatusCode, r.Header.Get("ETag"))
	}
	js := e.get("/js/app.js")
	readAll(t, js)
	if ct := js.Header.Get("Content-Type"); !strings.Contains(ct, "javascript") {
		t.Fatalf("js type %q", ct)
	}
	wasm := e.get("/wasm/btw_bg.wasm")
	readAll(t, wasm)
	if wasm.Header.Get("Content-Type") != "application/wasm" {
		t.Fatalf("wasm type %q", wasm.Header.Get("Content-Type"))
	}
	if r := e.do("HEAD", "/js/app.js", nil); r.StatusCode != 200 || r.Header.Get("ETag") == "" {
		t.Fatalf("HEAD: %d", r.StatusCode)
	}
	// range
	if r := e.get("/js/app.js", hdr("Range", "bytes=0-5")); r.StatusCode != 206 || len(readAll(t, r)) != 6 {
		t.Fatalf("range: %d", r.StatusCode)
	}

	// not found, dotfiles, traversal, wrong method: all straight from the handler so the path stays raw
	h := e.srv.Handler()
	for _, p := range []string{"/nope", "/.secret", "/js/../.secret", "/%2e%2e/outside.txt", "/..%2foutside.txt", "/js/%2e%2e/%2e%2e/outside.txt", "/.git/config", "/wasm/.hidden/x"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", p, nil))
		if rec.Code == 200 || strings.Contains(rec.Body.String(), "outside") || strings.Contains(rec.Body.String(), "nope") && rec.Code == 200 {
			t.Errorf("%s -> %d %q", p, rec.Code, rec.Body.String())
		}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/index.html", nil))
	if rec.Code != 405 {
		t.Errorf("POST static: %d", rec.Code)
	}
	if st, code := errCode(t, e.get("/nope")); st != 404 || code != api.CodeNotFound {
		t.Fatalf("404 shape: %d %s", st, code)
	}
}

func TestHealthInfoExamplesInstruments(t *testing.T) {
	e := newEnv(t, nil)
	var hz map[string]any
	if st := decode(t, e.get("/healthz"), &hz); st != 200 || hz["ok"] != true {
		t.Fatalf("healthz: %d %v", st, hz)
	}
	var info map[string]any
	if st := decode(t, e.get("/api/info"), &info); st != 200 {
		t.Fatalf("info: %d", st)
	}
	if info["name"] != "btw" || info["public_url"] != "https://btw.test" {
		t.Fatalf("info: %v", info)
	}
	for _, k := range []string{"compose", "render", "auth", "limits", "version"} {
		if info[k] == nil {
			t.Errorf("info lacks %q", k)
		}
	}
	render := info["render"].(map[string]any)
	if render["max_bars"].(float64) != 256 || render["concurrency"].(float64) != 2 {
		t.Fatalf("render info: %v", render)
	}
	if auth := info["auth"].(map[string]any); len(auth["kinds"].([]any)) != 2 {
		t.Fatalf("auth info: %v", auth)
	}

	var list []api.Example
	if st := decode(t, e.get("/api/examples"), &list); st != 200 {
		t.Fatal(st)
	}
	// index.json order; a .btw that is not listed in it is not an example
	if len(list) != 2 || list[0].Name != "second" || list[1].Name != "first-beat" {
		t.Fatalf("examples: %+v", list)
	}
	if list[1].CID == "" || list[1].BPM != 120 || list[1].Bars != 2 || list[1].License != "CC0-1.0" || list[0].Title != "Second" {
		t.Fatalf("example fields: %+v", list)
	}
	if len(e.srv.Warnings()) != 0 {
		t.Fatalf("warnings: %v", e.srv.Warnings())
	}
	resp := e.get("/examples/first-beat.btw")
	if txt := string(readAll(t, resp)); resp.StatusCode != 200 || !strings.HasPrefix(txt, "# first\n") || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/plain") {
		t.Fatalf("example file: %d %q", resp.StatusCode, txt)
	}
	for _, p := range []string{"/examples/unlisted-sample.btw", "/examples/nope.btw", "/examples/first-beat", "/examples/..%2findex.json"} {
		if r := e.get(p); r.StatusCode != 404 {
			t.Errorf("%s: %d", p, r.StatusCode)
		}
	}
	// Backend view of the same
	if txt, ok := e.srv.Example("second"); !ok || !strings.Contains(txt, "tempo 140") {
		t.Fatal("Backend.Example")
	}
	if len(e.srv.Examples()) != 2 {
		t.Fatal("Backend.Examples")
	}
	// an example is a program the store knows too
	if p, ok := e.srv.Get(list[1].CID); !ok || p.Meta.Source != "example" || !strings.HasPrefix(p.Text, "tempo 120") {
		t.Fatalf("Get(example): %+v %v", p, ok)
	}

	var ins map[string]any
	if st := decode(t, e.get("/api/instruments"), &ins); st != 200 || ins["voices"] == nil {
		t.Fatalf("instruments: %d %v", st, ins)
	}
}

func TestCheckFmtShareOpen(t *testing.T) {
	e := newEnv(t, nil)
	var rep api.CheckReport
	if st := decode(t, e.post("/api/check", map[string]string{"text": progA}), &rep); st != 200 || !rep.OK || rep.CID == "" || rep.SongBars != 2 {
		t.Fatalf("check: %d %+v", st, rep)
	}
	var bad api.CheckReport
	if st := decode(t, e.post("/api/check", map[string]string{"text": "tempo 120\nBAD\n"}), &bad); st != 200 || bad.OK || bad.Errors != 1 || bad.Diagnostics[0].Line != 2 {
		t.Fatalf("bad check must be a 200 with ok:false: %d %+v", st, bad)
	}
	var f api.FmtReport
	if st := decode(t, e.post("/api/fmt", map[string]string{"text": "tempo   120  # c\n\ndeck A: kick x\n"}), &f); st != 200 || !f.OK || f.Canonical != "tempo 120\ndeck A: kick x\n" {
		t.Fatalf("fmt: %d %+v", st, f)
	}

	var sh struct {
		api.ShareReport
		Diagnostics []api.Diagnostic `json:"diagnostics"`
		Error       string           `json:"error"`
	}
	if st := decode(t, e.post("/api/share", map[string]string{"text": progA}), &sh); st != 200 || !sh.OK {
		t.Fatalf("share: %d %+v", st, sh)
	}
	frag := rep.CID + "." // the sealed part
	if !strings.HasPrefix(sh.URL, "https://btw.test/#"+frag) || !strings.HasPrefix(sh.SocialURL, "https://btw.test/c/"+frag) ||
		!strings.HasPrefix(sh.BeatsURL, "https://beats.bitwrap.io/p#"+frag) || sh.CID != rep.CID {
		t.Fatalf("share links: %+v", sh)
	}
	if strings.Contains(sh.SocialURL, "#") || strings.Contains(sh.SocialURL, "~") {
		t.Fatalf("social url must carry the sealed part in the path only: %s", sh.SocialURL)
	}
	// a program that does not check says why instead of a bare ok:false
	var shBad struct {
		OK          bool             `json:"ok"`
		Diagnostics []api.Diagnostic `json:"diagnostics"`
		Error       string           `json:"error"`
	}
	decode(t, e.post("/api/share", map[string]string{"text": "BAD\n"}), &shBad)
	if shBad.OK || len(shBad.Diagnostics) == 0 || shBad.Error == "" {
		t.Fatalf("share of a bad program: %+v", shBad)
	}

	var op api.OpenReport
	if st := decode(t, e.post("/api/open", map[string]string{"url": sh.URL}), &op); st != 200 || !op.OK || !op.Verified || op.CID != rep.CID {
		t.Fatalf("open: %d %+v", st, op)
	}
	if st, code := errCode(t, e.post("/api/open", map[string]string{})); st != 400 || code != api.CodeBadRequest {
		t.Fatalf("open nothing: %d %s", st, code)
	}
	if st, code := errCode(t, e.post("/api/check", "not json at all")); st != 400 || code != api.CodeBadRequest {
		t.Fatalf("bad body: %d %s", st, code)
	}
	// wrong method
	if r := e.get("/api/check"); r.StatusCode != 405 && r.StatusCode != 404 {
		t.Fatalf("GET /api/check: %d", r.StatusCode)
	}
}

func TestBodyCapsAndRateLimitsPerIP(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.CheckIPMin = 3 })
	big := strings.Repeat("x", maxCheckBody+10)
	if st, code := errCode(t, e.post("/api/check", map[string]string{"text": big}, ip("192.0.2.1"))); st != 413 || code != api.CodeTooLarge {
		t.Fatalf("oversized check body: %d %s", st, code)
	}
	// that burned one of 192.0.2.1's 3; two more are fine, the fourth is refused with Retry-After
	for i := 0; i < 2; i++ {
		if r := e.post("/api/check", map[string]string{"text": progA}, ip("192.0.2.1")); r.StatusCode != 200 {
			t.Fatalf("request %d: %d", i, r.StatusCode)
		} else {
			r.Body.Close()
		}
	}
	r := e.post("/api/check", map[string]string{"text": progA}, ip("192.0.2.1"))
	if r.Header.Get("Retry-After") == "" {
		t.Fatalf("no Retry-After: %v", r.Header)
	}
	if st, code := errCode(t, r); st != 429 || code != api.CodeRateLimited {
		t.Fatalf("limit: %d %s", st, code)
	}
	// a different X-Real-IP (via the loopback proxy) has its own bucket
	if r := e.post("/api/check", map[string]string{"text": progA}, ip("192.0.2.2")); r.StatusCode != 200 {
		t.Fatalf("other address: %d", r.StatusCode)
	} else {
		r.Body.Close()
	}
	// ... and fmt/share/open/instruments draw on the same one
	for _, p := range []string{"/api/fmt", "/api/share", "/api/open"} {
		if st, _ := errCode(t, e.post(p, map[string]string{"text": progA, "url": "z"}, ip("192.0.2.1"))); st != 429 {
			t.Errorf("%s was not limited: %d", p, st)
		}
	}
	if r := e.get("/api/instruments", ip("192.0.2.1")); r.StatusCode != 429 {
		t.Errorf("instruments: %d", r.StatusCode)
	}
	// the window moves: a minute later the address is free again
	e.clk.Advance(61 * time.Second)
	if r := e.post("/api/check", map[string]string{"text": progA}, ip("192.0.2.1")); r.StatusCode != 200 {
		t.Fatalf("after the window: %d", r.StatusCode)
	} else {
		r.Body.Close()
	}
}

// A direct client cannot buy itself a bucket by spoofing X-Real-IP; behind the proxy each address has its own.
func TestLimiterBucketsFollowClientIP(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.CheckIPMin = 2 })
	h := e.srv.Handler()
	call := func(remote string, hdrs map[string]string) int {
		body, _ := json.Marshal(map[string]string{"text": progA})
		r := httptest.NewRequest("POST", "/api/check", bytes.NewReader(body))
		r.RemoteAddr = remote
		for k, v := range hdrs {
			r.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	// non-loopback peer rotating a spoofed X-Real-IP: still one bucket (its own address)
	var codes []int
	for i := 0; i < 4; i++ {
		codes = append(codes, call("198.51.100.7:4000", map[string]string{"X-Real-IP": "10.9.9." + string(rune('1'+i))}))
	}
	if codes[0] != 200 || codes[1] != 200 || codes[2] != 429 || codes[3] != 429 {
		t.Fatalf("spoofed headers from a direct client: %v", codes)
	}
	// loopback peer (nginx): X-Real-IP is honoured, so two clients behind it do not share
	if a, b, c := call("127.0.0.1:1", map[string]string{"X-Real-IP": "203.0.113.1"}), call("127.0.0.1:2", map[string]string{"X-Real-IP": "203.0.113.2"}),
		call("127.0.0.1:3", map[string]string{"X-Real-IP": "203.0.113.1"}); a != 200 || b != 200 || c != 200 {
		t.Fatalf("two proxied clients: %d %d %d", a, b, c)
	}
	if got := call("127.0.0.1:4", map[string]string{"X-Real-IP": "203.0.113.1"}); got != 429 {
		t.Fatalf("third from the same proxied client: %d", got)
	}
	// the last X-Forwarded-For entry is used when there is no X-Real-IP
	call("127.0.0.1:5", map[string]string{"X-Forwarded-For": "1.1.1.1, 203.0.113.50"})
	call("127.0.0.1:5", map[string]string{"X-Forwarded-For": "2.2.2.2, 203.0.113.50"})
	if got := call("127.0.0.1:5", map[string]string{"X-Forwarded-For": "3.3.3.3, 203.0.113.50"}); got != 429 {
		t.Fatalf("XFF fallback: %d", got)
	}
	// an IPv6 host's addresses share a /64 bucket
	call("127.0.0.1:6", map[string]string{"X-Real-IP": "2001:db8:5:5::1"})
	call("127.0.0.1:6", map[string]string{"X-Real-IP": "2001:db8:5:5::2"})
	if got := call("127.0.0.1:6", map[string]string{"X-Real-IP": "2001:db8:5:5::3"}); got != 429 {
		t.Fatalf("v6 /64 bucket: %d", got)
	}
}

func TestProgramsStore(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.MaxProgramBytes = 600; c.PutIPHour = 20 })
	// not progA: that one is the first-beat example, and the examples answer for their own CIDs (see
	// TestStoredCopyDoesNotRenameAnExample)
	const progS = "tempo 121\nkey am\ndeck A: kick x ~ x ~\nsection intro 2 bars\n"
	var rep api.CheckReport
	decode(t, e.post("/api/check", map[string]string{"text": progS}), &rep)
	put := func(cid, text string, o ...opt) *http.Response {
		return e.do("PUT", "/api/programs/"+cid, strings.NewReader(text), append([]opt{hdr("Content-Type", "text/plain"), ip("192.0.2.50")}, o...)...)
	}
	// first put: 201 and the meta
	var out struct {
		CID     string
		Created bool
		Meta    api.Meta
	}
	if st := decode(t, put(rep.CID, "# a comment\n#! name: my beat\n"+progS), &out); st != 201 || !out.Created || out.CID != rep.CID || out.Meta.License != "CC0-1.0" ||
		out.Meta.Visibility != "public" || out.Meta.Source != "put" || out.Meta.Name != "my beat" || out.Meta.Created == "" {
		t.Fatalf("put: %d %+v", st, out)
	}
	// idempotent: the same program (even reformatted) is 200 and the first meta stays
	if st := decode(t, put(rep.CID, "tempo   121\nkey am\ndeck A: kick x ~ x ~\nsection intro 2 bars\n"), &out); st != 200 || out.Created || out.Meta.Name != "my beat" {
		t.Fatalf("second put: %d %+v", st, out)
	}
	// GET json
	var p api.Program
	if st := decode(t, e.get("/api/programs/"+rep.CID), &p); st != 200 || p.CID != rep.CID || p.Text != rep.Canonical || p.Meta.Name != "my beat" {
		t.Fatalf("get: %d %+v", st, p)
	}
	r := e.get("/api/programs/" + rep.CID)
	readAll(t, r)
	if r.Header.Get("Cache-Control") != "public, max-age=31536000, immutable" || r.Header.Get("ETag") == "" {
		t.Fatalf("content addressed means immutable: %v", r.Header)
	}
	if r := e.get("/api/programs/"+rep.CID, hdr("If-None-Match", r.Header.Get("ETag"))); r.StatusCode != 304 {
		t.Fatalf("etag: %d", r.StatusCode)
	}
	// GET .btw: the #! header, then the canonical text
	r = e.get("/api/programs/" + rep.CID + ".btw")
	txt := string(readAll(t, r))
	if r.StatusCode != 200 || !strings.HasPrefix(r.Header.Get("Content-Type"), "text/plain") ||
		!strings.HasPrefix(txt, "#! name: my beat\n#! license: CC0-1.0\n#! cid: "+rep.CID+"\n") || !strings.HasSuffix(txt, rep.Canonical) {
		t.Fatalf(".btw: %d\n%s", r.StatusCode, txt)
	}
	// the header is comments: the downloaded file is the same program
	var again api.CheckReport
	decode(t, e.post("/api/check", map[string]string{"text": txt}), &again)
	if again.CID != rep.CID {
		t.Fatalf("a .btw download must check to the same CID: %s vs %s", again.CID, rep.CID)
	}
	// on disk, content addressed
	if _, err := os.Stat(filepath.Join(e.cfg.DataDir, "programs", rep.CID+".json")); err != nil {
		t.Fatal(err)
	}

	// refusals
	var other api.CheckReport
	decode(t, e.post("/api/check", map[string]string{"text": progB}), &other)
	if st, code := errCode(t, put(other.CID, progS)); st != 422 || code != api.CodeCIDMismatch {
		t.Fatalf("wrong cid: %d %s", st, code)
	}
	if st, code := errCode(t, put(rep.CID, "tempo 120\nBAD\n")); st != 422 || code != api.CodeBadRequest {
		t.Fatalf("errors: %d %s", st, code)
	}
	var bad struct{ Error api.Error }
	decode(t, put(rep.CID, "tempo 120\nBAD\n"), &bad)
	if !strings.Contains(bad.Error.Message, "2:1") {
		t.Fatalf("the refusal should name line:col: %q", bad.Error.Message)
	}
	for name, text := range map[string]string{"restricted": "tempo 120\nuse restricted\ndeck A: kick x\n", "sample": "tempo 120\nsample kick.wav\n", "loop": "tempo 120\nloop a.wav\n"} {
		var rr api.CheckReport
		decode(t, e.post("/api/check", map[string]string{"text": text}), &rr)
		if st, code := errCode(t, put(rr.CID, text)); st != 422 || code != api.CodeRestricted {
			t.Errorf("%s: %d %s", name, st, code)
		}
		if _, ok := e.srv.Get(rr.CID); ok {
			t.Errorf("%s program was stored", name)
		}
	}
	if st, code := errCode(t, put(rep.CID, strings.Repeat("deck A: kick x\n", 100))); st != 413 || code != api.CodeTooLarge {
		t.Fatalf("too large: %d %s", st, code)
	}
	if st, code := errCode(t, put(rep.CID, "   \n")); st != 400 || code != api.CodeBadRequest {
		t.Fatalf("empty: %d %s", st, code)
	}
	if st, _ := errCode(t, e.do("PUT", "/api/programs/"+rep.CID, strings.NewReader(`{"text":"x"}`), hdr("Content-Type", "application/json"))); st != 415 {
		t.Fatalf("json body: %d", st)
	}
	// not CIDs at all never reach the disk
	for _, c := range []string{"abc", "z", "../../etc/passwd", "z" + strings.Repeat("1", 200), "zOO0lI"} {
		if r := put(c, progS); r.StatusCode != 400 && r.StatusCode != 404 && r.StatusCode != 405 {
			t.Errorf("PUT %q: %d", c, r.StatusCode)
		}
		if r := e.get("/api/programs/" + c); r.StatusCode != 404 {
			t.Errorf("GET %q: %d", c, r.StatusCode)
		}
	}
	if r := e.get("/api/programs/" + other.CID); r.StatusCode != 404 {
		t.Fatalf("unknown program: %d", r.StatusCode)
	}

	// Backend.Put (what compose uses): meta kept, header lines in the download
	prog, _, err := e.srv.Put(context.Background(), progB, api.Meta{ComposedBy: "gemini-3.8-flash", ForkedFrom: rep.CID, Source: "compose"})
	if err != nil || prog.CID != other.CID || prog.Meta.ComposedBy != "gemini-3.8-flash" {
		t.Fatalf("Backend.Put: %+v %v", prog, err)
	}
	txt = string(readAll(t, e.get("/api/programs/"+other.CID+".btw")))
	if !strings.Contains(txt, "#! composed-by: gemini-3.8-flash\n#! forked-from: "+rep.CID+"\n") {
		t.Fatalf("provenance header: %s", txt)
	}

	// it survives a restart
	e2 := e.restart()
	var p2 api.Program
	if st := decode(t, e2.get("/api/programs/"+rep.CID), &p2); st != 200 || p2.Text != rep.Canonical {
		t.Fatalf("after restart: %d", st)
	}
}

func TestProgramsPutRateLimitAndStoreCap(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.PutIPHour = 2 })
	var rep api.CheckReport
	decode(t, e.post("/api/check", map[string]string{"text": progA}), &rep)
	put := func(a string) int {
		r := e.do("PUT", "/api/programs/"+rep.CID, strings.NewReader(progA), ip(a))
		r.Body.Close()
		return r.StatusCode
	}
	if a, b, c := put("192.0.2.9"), put("192.0.2.9"), put("192.0.2.9"); a != 201 || b != 200 || c != 429 {
		t.Fatalf("per-IP PUT limit: %d %d %d", a, b, c)
	}
	if put("192.0.2.10") != 200 {
		t.Fatal("another address has its own allowance")
	}
	// store cap
	e2 := newEnv(t, func(c *Config) { c.StoreMaxMB = 1 })
	e2.srv.store.capBytes = 200 // bytes: smaller than one program record
	r := e2.do("PUT", "/api/programs/"+rep.CID, strings.NewReader(progA))
	if st, code := errCode(t, r); st != 507 || code != "store_full" {
		t.Fatalf("store cap: %d %s", st, code)
	}
}

func TestProgramsConcurrentPutIsOneFile(t *testing.T) {
	e := newEnv(t, nil)
	var rep api.CheckReport
	decode(t, e.post("/api/check", map[string]string{"text": progA}), &rep)
	var wg sync.WaitGroup
	var mu sync.Mutex
	created := 0
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var out struct{ Created bool }
			r := e.do("PUT", "/api/programs/"+rep.CID, strings.NewReader(progA), ip("192.0.2.77"))
			decode(t, r, &out)
			if out.Created {
				mu.Lock()
				created++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if created != 1 {
		t.Fatalf("%d requests report having created it", created)
	}
	ents, _ := os.ReadDir(filepath.Join(e.cfg.DataDir, "programs"))
	if len(ents) != 1 {
		t.Fatalf("directory has %d entries (temp files left behind?)", len(ents))
	}
}

func TestSecurityHeadersAndCORS(t *testing.T) {
	e := newEnv(t, nil)
	r := e.get("/")
	readAll(t, r)
	csp := r.Header.Get("Content-Security-Policy")
	for _, want := range []string{"frame-ancestors 'none'", "'wasm-unsafe-eval'", "worker-src 'self';", "script-src 'self' 'wasm-unsafe-eval';", "style-src 'self';", "object-src 'none'", "default-src 'self'"} {
		if !strings.Contains(csp, want) {
			t.Errorf("CSP lacks %q: %s", want, csp)
		}
	}
	if strings.Contains(csp, "blob:") || strings.Contains(csp, "'unsafe-inline'") {
		t.Errorf("CSP allows blob: or inline (SEC-3 tightened it): %s", csp)
	}
	if r.Header.Get("Cross-Origin-Opener-Policy") != "same-origin" {
		t.Errorf("missing COOP same-origin")
	}
	if strings.Contains(csp, "script-src 'self' 'unsafe-inline'") || strings.Contains(csp, "unsafe-eval'") && !strings.Contains(csp, "wasm-unsafe-eval") {
		t.Errorf("CSP lets inline script or eval through: %s", csp)
	}
	if r.Header.Get("X-Content-Type-Options") != "nosniff" || r.Header.Get("X-Frame-Options") != "DENY" || r.Header.Get("Strict-Transport-Security") == "" {
		t.Fatalf("headers: %v", r.Header)
	}
	// every response has them, errors included
	if r := e.get("/nope"); r.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("404 without nosniff")
	}

	// CORS only on the read-only public GETs
	cors := func(method, path string) string {
		r := e.do(method, path, nil, hdr("Origin", "https://elsewhere.example"))
		r.Body.Close()
		return r.Header.Get("Access-Control-Allow-Origin")
	}
	for _, p := range []string{"/api/examples", "/api/instruments", "/api/info", "/healthz", "/examples/first-beat.btw"} {
		if cors("GET", p) != "*" {
			t.Errorf("GET %s should be readable cross-origin", p)
		}
	}
	for _, c := range []struct{ m, p string }{{"POST", "/api/check"}, {"POST", "/api/compose"}, {"GET", "/api/auth/me"}, {"POST", "/api/auth/login"},
		{"GET", "/api/session/abc/events"}, {"POST", "/api/session"}, {"POST", "/api/share"}, {"GET", "/"}, {"GET", "/js/app.js"}, {"PUT", "/api/programs/zzz"}} {
		if got := cors(c.m, c.p); got != "" {
			t.Errorf("%s %s must not be CORS-enabled, got %q", c.m, c.p, got)
		}
	}
	pre := e.do("OPTIONS", "/api/examples", nil, hdr("Origin", "https://x.example"), hdr("Access-Control-Request-Method", "GET"))
	pre.Body.Close()
	if pre.StatusCode != 204 || !strings.Contains(pre.Header.Get("Access-Control-Allow-Methods"), "GET") || strings.Contains(pre.Header.Get("Access-Control-Allow-Methods"), "POST") {
		t.Fatalf("preflight: %d %v", pre.StatusCode, pre.Header)
	}
	pre = e.do("OPTIONS", "/api/check", nil, hdr("Origin", "https://x.example"), hdr("Access-Control-Request-Method", "POST"))
	pre.Body.Close()
	if pre.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("preflight for a write must not be answered: %v", pre.Header)
	}
	// no credentials with the wildcard
	r = e.do("GET", "/api/examples", nil, hdr("Origin", "https://x.example"))
	r.Body.Close()
	if r.Header.Get("Access-Control-Allow-Credentials") != "" {
		t.Fatal("wildcard CORS must not allow credentials")
	}
}

func TestAccessLogNeverHoldsSecrets(t *testing.T) {
	e := newEnv(t, nil)
	u := e.newUser()
	tok := e.token(u)
	sid := func() string {
		var out struct{ ID string }
		decode(t, e.post("/api/session", nil, cookie(u.cookie)), &out)
		return out.ID
	}()
	e.get("/api/examples", ip("203.0.113.77")).Body.Close()
	e.get("/api/auth/me", cookie(u.cookie), bearer(tok)).Body.Close()
	e.get("/healthz?prompt=a+secret+prompt+about+cats&key=SEKRIT", bearer(tok)).Body.Close()
	e.post("/api/compose", map[string]string{"prompt": "write a very private prompt"}, bearer(tok)).Body.Close()
	e.post("/api/session/"+sid+"/report", map[string]any{"text": progA}, cookie(u.cookie)).Body.Close()
	e.get("/nope").Body.Close()
	e.srv.log.Close() // flush

	files, _ := filepath.Glob(filepath.Join(e.cfg.DataDir, "log", "access-*.jsonl"))
	if len(files) != 1 {
		t.Fatalf("log files: %v", files)
	}
	b, _ := os.ReadFile(files[0])
	log := string(b)
	for _, bad := range []string{u.cookie.Value, tok, "private prompt", "secret prompt", "SEKRIT", sid, "btw_session", "Authorization", "203.0.113.77", "127.0.0.1", u.pub[:8] + "zzz"} {
		if strings.Contains(log, bad) {
			t.Errorf("the log holds %q", bad)
		}
	}
	lines := strings.Split(strings.TrimSpace(log), "\n")
	if len(lines) < 7 {
		t.Fatalf("expected a line per request, got %d:\n%s", len(lines), log)
	}
	var sawUser, sawSession, sawExamples bool
	for _, l := range lines {
		var rec map[string]any
		if err := json.Unmarshal([]byte(l), &rec); err != nil {
			t.Fatalf("not JSONL: %q", l)
		}
		for _, k := range []string{"time", "method", "path", "status", "ms", "bytes", "ip"} {
			if _, ok := rec[k]; !ok {
				t.Errorf("line lacks %q: %s", k, l)
			}
		}
		if ip, _ := rec["ip"].(string); len(ip) != 16 {
			t.Errorf("ip should be a 16-hex hash: %q", ip)
		}
		if rec["user"] == u.id {
			sawUser = true
		}
		if rec["path"] == "/api/session/:id/report" {
			sawSession = true
		}
		if rec["path"] == "/api/examples" && rec["status"].(float64) == 200 {
			sawExamples = true
		}
	}
	if !sawUser || !sawSession || !sawExamples {
		t.Fatalf("user=%v session=%v examples=%v\n%s", sawUser, sawSession, sawExamples, log)
	}
	// distinct clients get distinct hashes, the same client the same one
	hashes := map[string]bool{}
	for _, l := range lines {
		var rec map[string]any
		json.Unmarshal([]byte(l), &rec)
		hashes[rec["ip"].(string)] = true
	}
	if len(hashes) < 2 {
		t.Fatalf("the x-real-ip client and the others should hash differently: %v", hashes)
	}
}

func TestConfigFlagsAndEnv(t *testing.T) {
	env := map[string]string{"BTW_ADDR": ":9999", "BTW_RENDER_IP_HOUR": "7", "BTW_MODEL": "gemini-x", "GEMINI_API_KEY": "k-secret", "BTW_ADMIN_TOKEN": "adm",
		"BTW_COMPOSE_ENABLED": "0", "BTW_SESSION_SECRET": "0123456789abcdef-secret", "BTW_PRICE_IN_PER_M": "0.5"}
	get := func(k string) string { return env[k] }
	c, err := ParseConfig([]string{"-addr", ":1234", "-data", "/tmp/x"}, get, nil)
	if err != nil {
		t.Fatal(err)
	}
	if c.Addr != ":1234" { // a flag beats the environment
		t.Fatalf("addr %q", c.Addr)
	}
	if c.RenderIPHour != 7 || c.Model != "gemini-x" || c.PriceInPerM != 0.5 || c.ComposeEnabled || c.DataDir != "/tmp/x" {
		t.Fatalf("env not applied: %+v", c)
	}
	if c.GeminiKey != "k-secret" || c.AdminToken != "adm" || c.SessionSecret != "0123456789abcdef-secret" {
		t.Fatalf("secrets: %+v", c)
	}
	// defaults are the ones DESIGN.md names
	d, err := ParseConfig(nil, func(string) string { return "" }, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := Config{Addr: ":18097", ComposeUserHour: 10, ComposeUserDay: 50, ComposeIPDay: 40, DailySpendUSD: 2, PriceInPerM: 1.5, PriceOutPerM: 7.5,
		MaxPromptChars: 800, MaxProgramBytes: 16384, MaxRepair: 3, RenderIPHour: 30, RenderConcurrency: 2, RenderMaxBars: 256}
	if d.Addr != want.Addr || d.ComposeUserHour != 10 || d.ComposeUserDay != 50 || d.ComposeIPDay != 40 || d.DailySpendUSD != 2 || d.PriceInPerM != 1.5 ||
		d.PriceOutPerM != 7.5 || d.MaxPromptChars != 800 || d.MaxProgramBytes != 16384 || d.MaxRepair != 3 || d.RenderIPHour != 30 ||
		d.RenderConcurrency != 2 || d.RenderMaxBars != 256 || d.Model != "gemini-3.8-flash" || d.WebDir != "btwsite/web" || d.ExamplesDir != "btwsite/examples" ||
		d.DataDir != "./data" || d.PublicURL != "https://btw.bitwrap.io" || !d.ComposeEnabled || d.GeminiKey != "" {
		t.Fatalf("defaults: %+v", d)
	}
	if !d.secureCookie() {
		t.Fatal("an https public URL means a Secure cookie")
	}
	if _, err := ParseConfig(nil, func(k string) string {
		if k == "BTW_RENDER_CONCURRENCY" {
			return "many"
		}
		return ""
	}, nil); err == nil {
		t.Fatal("a bad env value must be an error")
	}
	if _, err := ParseConfig([]string{"-render-concurrency", "0"}, nil, nil); err == nil {
		t.Fatal("zero render slots must be refused")
	}
	// the key is never a flag
	var usage bytes.Buffer
	ParseConfig([]string{"-h"}, nil, &usage)
	if strings.Contains(usage.String(), "gemini") && strings.Contains(strings.ToLower(usage.String()), "-gemini") {
		t.Fatal("the API key must not be a flag")
	}
	if !strings.Contains(usage.String(), "BTW_RENDER_IP_HOUR") {
		t.Fatalf("usage should name the env vars:\n%s", usage.String())
	}
	if _, err := ParseConfig([]string{"-compose-user-hour", "3"}, func(string) string { return "" }, nil); err != nil {
		t.Fatal(err)
	}
}

func TestGracefulShutdown(t *testing.T) {
	e := newEnv(t, nil)
	var out struct{ ID string }
	decode(t, e.post("/api/session", nil), &out)
	c := e.sse("/api/session/" + out.ID + "/events")
	c.next(t, "ping", 2*time.Second)
	done := make(chan struct{})
	go func() {
		e.srv.Close()
		e.ts.Config.Shutdown(context.Background()) // would wait forever on a live SSE stream
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown hung on an open SSE stream")
	}
	if _, ok := <-c.ch; ok {
		for range c.ch { // drain
		}
	}
}

func TestExamplesThatAreNotPublicStopTheServer(t *testing.T) {
	for name, body := range map[string]string{"restricted": "tempo 120\nuse restricted\ndeck A: kick x\n", "sample": "tempo 120\nsample kick.wav\n", "broken": "BAD\n"} {
		dir := t.TempDir()
		os.WriteFile(filepath.Join(dir, "bad.btw"), []byte(body), 0o644)
		os.WriteFile(filepath.Join(dir, "index.json"), []byte(`[{"name":"bad","title":"bad"}]`), 0o644)
		cfg := DefaultConfig()
		cfg.DataDir, cfg.ExamplesDir, cfg.Checker, cfg.Logf = filepath.Join(dir, "data"), dir, fakeChecker(), t.Logf
		if srv, err := New(cfg); err == nil {
			srv.Close()
			t.Errorf("%s example: the server started", name)
		} else if !strings.Contains(err.Error(), "bad") {
			t.Errorf("%s: the error should name the example: %v", name, err)
		}
	}
	// no examples directory at all: an empty list and a warning, not an error
	cfg := DefaultConfig()
	cfg.DataDir, cfg.ExamplesDir, cfg.Checker, cfg.Logf = filepath.Join(t.TempDir(), "data"), "/nonexistent/examples", fakeChecker(), t.Logf
	srv, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	if len(srv.Examples()) != 0 || len(srv.Warnings()) != 1 {
		t.Fatalf("%v %v", srv.Examples(), srv.Warnings())
	}
}

func fakeChecker() api.Checker { return fakecheck.Checker{} }

func TestAccessLogKeepsThirtyDays(t *testing.T) {
	e := newEnv(t, nil)
	dir := filepath.Join(e.cfg.DataDir, "log")
	old := e.clk.Now().UTC().AddDate(0, 0, -31).Format("20060102")
	recent := e.clk.Now().UTC().AddDate(0, 0, -5).Format("20060102")
	os.WriteFile(filepath.Join(dir, "access-"+old+".jsonl"), []byte("{}\n"), 0o640)
	os.WriteFile(filepath.Join(dir, "access-"+recent+".jsonl"), []byte("{}\n"), 0o640)
	os.WriteFile(filepath.Join(dir, "compose-"+old+".jsonl"), []byte("{}\n"), 0o640) // not ours to prune
	e.get("/healthz").Body.Close()                                                   // the first line of the day opens the file and prunes
	e.srv.log.Close()
	for name, want := range map[string]bool{"access-" + old + ".jsonl": false, "access-" + recent + ".jsonl": true, "compose-" + old + ".jsonl": true} {
		_, err := os.Stat(filepath.Join(dir, name))
		if (err == nil) != want {
			t.Errorf("%s exists=%v, want %v", name, err == nil, want)
		}
	}
}

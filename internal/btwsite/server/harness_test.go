package server

import (
	"bufio"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
	"beats-bitwrap-io/internal/btwsite/btwd"
	"beats-bitwrap-io/internal/btwsite/btwd/fakebtwd"
)

var fakeBin string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "fakebtwd")
	if err != nil {
		panic(err)
	}
	fakeBin, err = fakebtwd.Build(dir)
	if err != nil {
		os.RemoveAll(dir)
		panic(err)
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

// programs (the fake language: `section NAME N bars` makes N bars at `tempo T`: 2 bars at 120 = 4 s)
const (
	progA = "tempo 120\nkey am\ndeck A: kick x ~ x ~\nsection intro 2 bars\n"
	progB = "tempo 100\nkey am\ndeck A: kick x ~ x ~\nsection intro 2 bars\n"
	progC = "tempo 90\ndeck A: kick x ~ x ~\nsection intro 2 bars\n"
)

// a clock the tests can move
type clock struct{ off atomic.Int64 }

func (c *clock) Now() time.Time          { return time.Now().Add(time.Duration(c.off.Load())) }
func (c *clock) Advance(d time.Duration) { c.off.Add(int64(d)) }

type tenv struct {
	t     *testing.T
	srv   *Server
	ts    *httptest.Server
	dir   string
	web   string
	calls string
	clk   *clock
	cfg   Config
}

// newEnv starts a server over httptest with the fake btwd (extra: BTW_FAKE_* knobs).
func newEnv(t *testing.T, mod func(*Config), fakeEnv ...string) *tenv {
	t.Helper()
	dir := t.TempDir()
	web := filepath.Join(dir, "web")
	ex := filepath.Join(dir, "examples")
	for _, d := range []string{web + "/js", web + "/wasm", ex} {
		os.MkdirAll(d, 0o755)
	}
	os.WriteFile(filepath.Join(web, "index.html"), []byte("<!doctype html><html><head><title>btw</title><!-- btw:card-meta --></head><body><p>index</body></html>"), 0o644)
	os.WriteFile(filepath.Join(web, "js", "app.js"), []byte("export const x = 1;\n"), 0o644)
	os.WriteFile(filepath.Join(web, "wasm", "btw_bg.wasm"), []byte("\x00asm\x01\x00\x00\x00"), 0o644)
	os.WriteFile(filepath.Join(web, ".secret"), []byte("nope"), 0o644)
	os.WriteFile(filepath.Join(dir, "outside.txt"), []byte("outside"), 0o644)
	os.WriteFile(filepath.Join(ex, "first-beat.btw"), []byte("# first\ntempo 120\nkey am\ndeck A: kick x ~ x ~\nsection intro 2 bars\n"), 0o644)
	os.WriteFile(filepath.Join(ex, "second.btw"), []byte("tempo 140\ndeck A: kick x\nsection a 4 bars\n"), 0o644)
	os.WriteFile(filepath.Join(ex, "unlisted-sample.btw"), []byte("tempo 140\nsample kick.wav\n"), 0o644) // not in index.json: not an example
	os.WriteFile(filepath.Join(ex, "index.json"), []byte(`[{"name":"second","title":"Second","description":"d2","license":"CC0-1.0"},{"name":"first-beat","title":"First beat","description":"d1","bpm":120,"bars":2}]`), 0o644)

	calls := filepath.Join(dir, "calls.log")
	clk := &clock{}
	cfg := DefaultConfig()
	cfg.DataDir = filepath.Join(dir, "data")
	cfg.WebDir, cfg.ExamplesDir = web, ex
	cfg.PublicURL = "https://btw.test"
	cfg.Now = clk.Now
	cfg.SSEPing = 80 * time.Millisecond
	cfg.Model = "fake"
	cfg.Logf = t.Logf
	if mod != nil {
		mod(&cfg)
	}
	env := append([]string{"BTW_FAKE_CALLS=" + calls}, fakeEnv...)
	c, err := btwd.New(fakeBin, btwd.Options{Env: env, MaxConcurrent: 8})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Checker == nil {
		cfg.Checker = c
	}
	if cfg.Renderer == nil {
		cfg.Renderer = c
	}
	srv, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	e := &tenv{t: t, srv: srv, ts: ts, dir: dir, web: web, calls: calls, clk: clk, cfg: cfg}
	t.Cleanup(func() {
		srv.Close()
		ts.CloseClientConnections()
		ts.Close()
	})
	return e
}

// restart builds a second server over the same data dir (a process restart).
func (e *tenv) restart() *tenv {
	e.t.Helper()
	e.srv.Close()
	e.ts.CloseClientConnections()
	e.ts.Close()
	c, err := btwd.New(fakeBin, btwd.Options{Env: []string{"BTW_FAKE_CALLS=" + e.calls}})
	if err != nil {
		e.t.Fatal(err)
	}
	cfg := e.cfg
	cfg.Checker, cfg.Renderer = c, c
	srv, err := New(cfg)
	if err != nil {
		e.t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	e2 := *e
	e2.srv, e2.ts = srv, ts
	e.t.Cleanup(func() { srv.Close(); ts.CloseClientConnections(); ts.Close() })
	return &e2
}

func (e *tenv) renderCalls() int {
	b, _ := os.ReadFile(e.calls)
	return strings.Count(string(b), "render\n")
}

type opt func(*http.Request)

func hdr(k, v string) opt { return func(r *http.Request) { r.Header.Set(k, v) } }
func cookie(c *http.Cookie) opt {
	return func(r *http.Request) { r.AddCookie(&http.Cookie{Name: c.Name, Value: c.Value}) }
}
func bearer(tok string) opt { return hdr("Authorization", "Bearer "+tok) }
func ip(a string) opt       { return hdr("X-Real-IP", a) } // honoured: httptest's peer is loopback

func (e *tenv) do(method, path string, body io.Reader, opts ...opt) *http.Response {
	e.t.Helper()
	r, err := http.NewRequest(method, e.ts.URL+path, body)
	if err != nil {
		e.t.Fatal(err)
	}
	for _, o := range opts {
		o(r)
	}
	resp, err := http.DefaultClient.Do(r)
	if err != nil {
		e.t.Fatalf("%s %s: %v", method, path, err)
	}
	return resp
}

func (e *tenv) get(path string, opts ...opt) *http.Response { return e.do("GET", path, nil, opts...) }

func jsonBody(v any) io.Reader {
	b, _ := json.Marshal(v)
	return bytes.NewReader(b)
}

func (e *tenv) post(path string, v any, opts ...opt) *http.Response {
	return e.do("POST", path, jsonBody(v), append([]opt{hdr("Content-Type", "application/json")}, opts...)...)
}

func readAll(t *testing.T, resp *http.Response) []byte {
	t.Helper()
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// decode reads a JSON body into v and returns the status.
func decode(t *testing.T, resp *http.Response, v any) int {
	t.Helper()
	b := readAll(t, resp)
	if v != nil {
		if err := json.Unmarshal(b, v); err != nil {
			t.Fatalf("not JSON (%d): %s", resp.StatusCode, b)
		}
	}
	return resp.StatusCode
}

func errCode(t *testing.T, resp *http.Response) (int, string) {
	t.Helper()
	var e struct{ Error api.Error }
	st := decode(t, resp, &e)
	return st, e.Error.Code
}

// put stores text and returns its CID.
func (e *tenv) put(text string) string {
	e.t.Helper()
	var rep api.CheckReport
	if st := decode(e.t, e.post("/api/check", map[string]string{"text": text}, ip("192.0.2.200")), &rep); st != 200 || !rep.OK {
		e.t.Fatalf("check: %d %+v", st, rep)
	}
	resp := e.do("PUT", "/api/programs/"+rep.CID, strings.NewReader(text), hdr("Content-Type", "text/plain"), ip("192.0.2.201"))
	if st := resp.StatusCode; st != 200 && st != 201 {
		e.t.Fatalf("put: %d %s", st, readAll(e.t, resp))
	}
	resp.Body.Close()
	return rep.CID
}

// ---- wallet-less sign-in (ed25519) ----

type edUser struct {
	priv   ed25519.PrivateKey
	pub    string
	id     string
	cookie *http.Cookie
}

func (e *tenv) newUser() *edUser {
	e.t.Helper()
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	u := &edUser{priv: priv, pub: hex.EncodeToString(pub)}
	var ch struct{ Nonce, Message string }
	decode(e.t, e.get("/api/auth/challenge"), &ch)
	resp := e.post("/api/auth/login", map[string]string{"type": "ed25519", "address": u.pub,
		"signature": hex.EncodeToString(ed25519.Sign(priv, []byte(ch.Message))), "nonce": ch.Nonce})
	for _, c := range resp.Cookies() {
		if c.Name == "btw_session" {
			u.cookie = c
		}
	}
	if st := decode(e.t, resp, nil); st != 200 || u.cookie == nil {
		e.t.Fatalf("login: %d", st)
	}
	u.id = "ed25519:" + u.pub
	return u
}

func (e *tenv) token(u *edUser) string {
	e.t.Helper()
	var out struct{ Token string }
	if st := decode(e.t, e.post("/api/auth/token", nil, cookie(u.cookie)), &out); st != 200 {
		e.t.Fatalf("token: %d", st)
	}
	return out.Token
}

func (u *edUser) user() *api.User {
	return &api.User{ID: u.id, Kind: "ed25519", Address: u.pub, Via: "token"}
}

// ---- SSE ----

type sseMsg struct{ event, data string }

type sseConn struct {
	resp *http.Response
	ch   chan sseMsg
}

func (e *tenv) sse(path string, opts ...opt) *sseConn {
	e.t.Helper()
	resp := e.get(path, opts...)
	if resp.StatusCode != 200 {
		e.t.Fatalf("sse %s: %d %s", path, resp.StatusCode, readAll(e.t, resp))
	}
	c := &sseConn{resp: resp, ch: make(chan sseMsg, 64)}
	go func() {
		defer close(c.ch)
		sc := bufio.NewScanner(resp.Body)
		var m sseMsg
		for sc.Scan() {
			l := sc.Text()
			switch {
			case l == "":
				if m.event != "" {
					c.ch <- m
				}
				m = sseMsg{}
			case strings.HasPrefix(l, "event: "):
				m.event = l[7:]
			case strings.HasPrefix(l, "data: "):
				m.data = l[6:]
			}
		}
	}()
	e.t.Cleanup(func() { resp.Body.Close() })
	return c
}

// next returns the next event that is not a ping (unless want is "ping").
func (c *sseConn) next(t *testing.T, want string, within time.Duration) sseMsg {
	t.Helper()
	deadline := time.After(within)
	for {
		select {
		case m, ok := <-c.ch:
			if !ok {
				t.Fatalf("stream closed while waiting for %q", want)
			}
			if m.event == "ping" && want != "ping" {
				continue
			}
			return m
		case <-deadline:
			t.Fatalf("no %q event within %s", want, within)
		}
	}
}

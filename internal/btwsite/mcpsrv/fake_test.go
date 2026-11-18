package mcpsrv_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"beats-bitwrap-io/internal/btwsite/api"
	"beats-bitwrap-io/internal/btwsite/fakecheck"
	"beats-bitwrap-io/internal/btwsite/mcpsrv"
)

const siteURL = "https://btw.bitwrap.io"

const goodProgram = "#! btw 1\ntempo 140\nkey fm\nsection drop 8 bars {\n  deck A: kick x ~ x ~\n}\n"

// ---------- the fake backend ----------

type push struct {
	User    *api.User
	Session string
	Event   api.SessionEvent
}

type composeCall struct {
	User *api.User
	IP   string
	Req  api.ComposeRequest
}

type fakeBackend struct {
	api.Checker // Check, Fmt, Open, Share, Highlight, Instruments, Cheatsheet: fakecheck, or the real btwd

	mu       sync.Mutex
	pushes   []push
	pushN    int // delivered; default 1
	pushErr  error
	sessions []api.SessionInfo
	state    *api.SessionState
	stateErr error
	store    map[string]*api.Program
	puts     int
	composes []composeCall
	composeR *api.ComposeResult
	composeE error
	noHelp   bool // AuthHelp answers nothing
}

func newBackend() *fakeBackend {
	return &fakeBackend{Checker: fakecheck.Checker{}, pushN: 1, store: map[string]*api.Program{}}
}

func (f *fakeBackend) Push(u *api.User, session string, ev api.SessionEvent) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pushes = append(f.pushes, push{u, session, ev})
	return f.pushN, f.pushErr
}
func (f *fakeBackend) State(_ context.Context, u *api.User, session string) (*api.SessionState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.stateErr != nil {
		return nil, f.stateErr
	}
	if f.state != nil {
		st := *f.state
		st.ID = session
		return &st, nil
	}
	return nil, api.Errf(404, api.CodeNoSession, "no such session")
}
func (f *fakeBackend) Sessions(u *api.User) []api.SessionInfo {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sessions
}
func (f *fakeBackend) Put(ctx context.Context, text string, meta api.Meta) (*api.Program, *api.CheckReport, error) {
	rep, _ := f.Check(ctx, text)
	if !rep.OK {
		return nil, rep, api.Errf(422, api.CodeBadRequest, "does not check")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.puts++
	p := &api.Program{CID: rep.CID, Text: rep.Canonical, Meta: meta}
	f.store[rep.CID] = p
	return p, rep, nil
}
func (f *fakeBackend) Get(cid string) (*api.Program, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	p, ok := f.store[cid]
	return p, ok
}
func (f *fakeBackend) Compose(_ context.Context, u *api.User, ip string, req api.ComposeRequest) (*api.ComposeResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.composes = append(f.composes, composeCall{u, ip, req})
	if f.composeE != nil {
		return nil, f.composeE
	}
	return f.composeR, nil
}
func (f *fakeBackend) Status() api.ComposeStatus {
	return api.ComposeStatus{Enabled: true, Configured: true, Model: "fake", UserHour: 10, UserDay: 50, IPDay: 40}
}
func (f *fakeBackend) Examples() []api.Example {
	rep, _ := f.Check(context.Background(), goodProgram)
	return []api.Example{{Name: "demo", Title: "Demo", Description: "a demo", CID: rep.CID, BPM: 140, Bars: 8, License: "CC0-1.0"}}
}
func (f *fakeBackend) Example(name string) (string, bool) {
	if name == "demo" {
		return goodProgram, true
	}
	return "", false
}
func (f *fakeBackend) RenderInfo(cid, format string) (string, string, float64) {
	return "/api/render/" + cid + "?format=" + format, "/api/render/" + cid + "/status", 15.4
}
func (f *fakeBackend) PublicURL() string { return siteURL }
func (f *fakeBackend) AuthHelp() string {
	if f.noHelp {
		return ""
	}
	return "Sign in at https://btw.bitwrap.io and press the MCP token button; send it as Authorization: Bearer btw_..."
}

func (f *fakeBackend) lastPush(t *testing.T) push {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.pushes) == 0 {
		t.Fatal("the backend got no Push")
	}
	return f.pushes[len(f.pushes)-1]
}

var _ api.Backend = (*fakeBackend)(nil)

// ---------- the fake authenticator ----------

type fakeAuth struct{ users map[string]*api.User }

// UserFrom resolves a bearer token like the real service (cookies are not modelled).
func (a fakeAuth) UserFrom(r *http.Request) (*api.User, error) {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		if u := a.users[strings.TrimPrefix(h, "Bearer ")]; u != nil {
			return u, nil
		}
		return nil, api.Errf(401, api.CodeAuthRequired, "unknown or revoked token")
	}
	return nil, nil
}
func (a fakeAuth) UserFromToken(tok string) *api.User { return a.users[tok] }

var alice = &api.User{ID: "eip155:0xabc", Kind: "eth", Address: "0xabc", Via: "token"}

func newAuth() fakeAuth { return fakeAuth{users: map[string]*api.User{"btw_alice": alice}} }

// ---------- an httptest server and a tiny MCP client ----------

type env struct {
	t   *testing.T
	b   *fakeBackend
	srv *httptest.Server
}

func newEnv(t *testing.T, opts ...mcpsrv.Option) *env {
	t.Helper()
	return newEnvWith(t, newBackend(), opts...)
}

func newEnvWith(t *testing.T, b *fakeBackend, opts ...mcpsrv.Option) *env {
	t.Helper()
	h := mcpsrv.Handler(b, newAuth(), siteURL, opts...)
	mux := http.NewServeMux()
	mux.Handle("/mcp", h)
	mux.Handle("/mcp/", h)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return &env{t: t, b: b, srv: srv}
}

type rpcMsg struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// rpc posts one JSON-RPC request and returns the decoded answer (JSON or one SSE event).
func (e *env) rpc(token, method string, params any, hdr map[string]string) rpcMsg {
	e.t.Helper()
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	req, _ := http.NewRequest("POST", e.srv.URL+"/mcp", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		sc := bufio.NewScanner(bytes.NewReader(raw))
		sc.Buffer(make([]byte, 1<<20), 1<<24)
		for sc.Scan() {
			if d, ok := strings.CutPrefix(sc.Text(), "data:"); ok {
				raw = []byte(strings.TrimSpace(d))
				break
			}
		}
	}
	var m rpcMsg
	if err := json.Unmarshal(raw, &m); err != nil {
		e.t.Fatalf("%s: HTTP %d, not JSON-RPC: %q", method, resp.StatusCode, raw)
	}
	return m
}

// result is a tool call's answer.
type result struct {
	IsError bool
	Text    string
}

// body decodes the text as JSON.
func (r result) body(t *testing.T) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(r.Text), &m); err != nil {
		t.Fatalf("tool text is not a JSON object: %q", r.Text)
	}
	return m
}

// errBody is the {"error":{...}} object of a failed call.
func (r result) errBody(t *testing.T) map[string]any {
	t.Helper()
	if !r.IsError {
		t.Fatalf("expected a tool error, got success: %s", r.Text)
	}
	em, ok := r.body(t)["error"].(map[string]any)
	if !ok {
		t.Fatalf("tool error has no error object: %s", r.Text)
	}
	return em
}

func (e *env) call(token, tool string, args map[string]any) result {
	e.t.Helper()
	if args == nil {
		args = map[string]any{}
	}
	m := e.rpc(token, "tools/call", map[string]any{"name": tool, "arguments": args}, nil)
	if m.Error != nil {
		e.t.Fatalf("%s: protocol error %d %s", tool, m.Error.Code, m.Error.Message)
	}
	var res struct {
		IsError bool `json:"isError"`
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(m.Result, &res); err != nil {
		e.t.Fatal(err)
	}
	var sb strings.Builder
	for _, c := range res.Content {
		sb.WriteString(c.Text)
	}
	return result{res.IsError, sb.String()}
}

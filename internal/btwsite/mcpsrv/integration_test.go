package mcpsrv_test

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
	"beats-bitwrap-io/internal/btwsite/docs"
	"beats-bitwrap-io/internal/btwsite/fakecheck"
	"beats-bitwrap-io/internal/btwsite/mcpsrv"
	"beats-bitwrap-io/internal/btwsite/server"
)

// sseEvent is one server-sent event from the sessions stream.
type sseEvent struct {
	Name string
	Data json.RawMessage
}

// A browser tab and an MCP client against the real server package (G1's hub, programs store and examples),
// with mcpsrv and docs mounted in front of it exactly as the wiring will: eval, load and stop reach the tab
// over its SSE stream, and get reads what the tab reported.
func TestEndToEndWithTheRealServer(t *testing.T) {
	dir := t.TempDir()
	web := filepath.Join(dir, "web")
	if err := os.MkdirAll(web, 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(web, "index.html"), []byte("<!doctype html><title>btw</title>"), 0o644)

	var handler http.Handler
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handler.ServeHTTP(w, r) }))
	defer ts.Close()

	cfg := server.DefaultConfig()
	cfg.DataDir = filepath.Join(dir, "data")
	cfg.WebDir = web
	cfg.ExamplesDir = filepath.Join("..", "..", "..", "btwsite", "examples")
	cfg.PublicURL = ts.URL
	cfg.Checker = fakecheck.Checker{}
	cfg.Authenticator = newAuth()
	cfg.Logf = func(string, ...any) {}
	srv, err := server.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	mux := http.NewServeMux()
	mcp := mcpsrv.Handler(srv, cfg.Authenticator, ts.URL)
	mux.Handle("/mcp", mcp)
	mux.Handle("/mcp/", mcp)
	docsDir := filepath.Join("..", "..", "..", "btwsite", "testdata", "docs")
	if err := docs.Mount(mux, docs.Options{DocsDir: docsDir, Checker: fakecheck.Checker{}, Examples: srv.Examples, ExampleText: srv.Example, PublicURL: ts.URL}); err != nil {
		t.Fatal(err)
	}
	mux.Handle("/", srv.Handler())
	handler = mux

	bearer := func(req *http.Request) { req.Header.Set("Authorization", "Bearer btw_alice") }
	do := func(method, path, body string, auth bool) (*http.Response, string) {
		req, _ := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		if auth {
			bearer(req)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp, string(b)
	}

	// the tab: a session owned by alice, and its event stream
	resp, body := do("POST", "/api/session", "", true)
	var sess struct{ ID string }
	if resp.StatusCode != 200 || json.Unmarshal([]byte(body), &sess) != nil || sess.ID == "" {
		t.Fatalf("POST /api/session: %d %s", resp.StatusCode, body)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", ts.URL+"/api/session/"+sess.ID+"/events", nil)
	bearer(req)
	sse, err := http.DefaultClient.Do(req)
	if err != nil || sse.StatusCode != 200 {
		t.Fatalf("events: %v %v", err, sse)
	}
	defer sse.Body.Close()
	events := make(chan sseEvent, 16)
	go func() {
		sc := bufio.NewScanner(sse.Body)
		var name string
		for sc.Scan() {
			l := sc.Text()
			if v, ok := strings.CutPrefix(l, "event: "); ok {
				name = v
			} else if v, ok := strings.CutPrefix(l, "data: "); ok && name != "ping" {
				events <- sseEvent{name, json.RawMessage(v)}
			}
		}
	}()
	next := func() sseEvent {
		t.Helper()
		select {
		case ev := <-events:
			return ev
		case <-time.After(5 * time.Second):
			t.Fatal("the tab got no event")
			return sseEvent{}
		}
	}
	// wait until the hub sees the subscriber (a push before that has nobody to deliver to)
	e := &env{t: t, b: nil, srv: ts}
	var evalRes result
	for i := 0; ; i++ {
		evalRes = e.call("btw_alice", "eval", map[string]any{"text": goodProgram, "play": true})
		if !evalRes.IsError || i > 50 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if evalRes.IsError || evalRes.body(t)["delivered"] != float64(1) {
		t.Fatalf("eval: %s", evalRes.Text)
	}
	ev := next()
	var got api.SessionEvent
	json.Unmarshal(ev.Data, &got)
	if ev.Name != "eval" || got.Type != "eval" || got.Text != goodProgram || !got.Play || got.CID == "" {
		t.Fatalf("the tab got %s %s", ev.Name, ev.Data)
	}

	// load an example, then stop
	r := e.call("btw_alice", "load", map[string]any{"example": "first-beat"})
	if r.IsError {
		t.Fatalf("load: %s", r.Text)
	}
	ev = next()
	json.Unmarshal(ev.Data, &got)
	want, _ := os.ReadFile(filepath.Join("..", "..", "..", "btwsite", "examples", "first-beat.btw"))
	if ev.Name != "load" || got.Text != string(want) || got.CID == "" {
		t.Fatalf("the tab got %s %.200s", ev.Name, ev.Data)
	}
	if r := e.call("btw_alice", "stop", nil); r.IsError {
		t.Fatalf("stop: %s", r.Text)
	}
	if ev = next(); ev.Name != "stop" {
		t.Fatalf("the tab got %s", ev.Name)
	}
	// somebody else's token cannot drive alice's tab by id; an unknown token is refused outright
	if r := e.call("btw_alice", "stop", map[string]any{"session": "nosuchsession1"}); r.errBody(t)["code"] != "no_session" {
		t.Errorf("stop(unknown session) = %s", r.Text)
	}

	// the tab reports; get reads it
	report := api.SessionState{Text: goodProgram, CID: "zcid", Playing: true, Source: "engine", Section: "drop", SectionNum: 1, SectionsAll: 1,
		Bar: 3, BarsInSect: 8, Phase: 2, Marks: json.RawMessage(`{"active_lines":[5]}`), Diagnostics: json.RawMessage(`[]`), TS: time.Now().UTC().Format(time.RFC3339)}
	rb, _ := json.Marshal(report)
	if resp, body := do("POST", "/api/session/"+sess.ID+"/report", string(rb), true); resp.StatusCode != 204 {
		t.Fatalf("report: %d %s", resp.StatusCode, body)
	}
	r = e.call("btw_alice", "get", nil)
	g := r.body(t)
	if r.IsError || g["id"] != sess.ID || g["section"] != "drop" || g["bar"] != float64(3) || g["bars_in_section"] != float64(8) ||
		g["phase"] != float64(2) || g["playing"] != true || g["sessions_connected"] != float64(1) {
		t.Fatalf("get: %s", r.Text)
	}
	if g := e.call("btw_alice", "get", map[string]any{"session": sess.ID}).body(t); g["marks"].(map[string]any)["active_lines"] == nil {
		t.Errorf("get(session) lost the marks: %v", g)
	}

	// render stores the program in the real store and the URLs are absolute and answer
	rr := e.call("", "render", map[string]any{"text": goodProgram})
	rb2 := rr.body(t)
	cid, _ := rb2["cid"].(string)
	if rr.IsError || cid == "" || !strings.HasPrefix(rb2["stream_url"].(string), ts.URL+"/api/render/"+cid) || rb2["seconds"].(float64) <= 0 {
		t.Fatalf("render: %s", rr.Text)
	}
	if resp, body := do("GET", "/api/programs/"+cid, "", false); resp.StatusCode != 200 || !strings.Contains(body, "CC0-1.0") {
		t.Errorf("the rendered program is not stored: %d %s", resp.StatusCode, body)
	}
	statusURL := strings.TrimPrefix(rb2["status_url"].(string), ts.URL)
	if resp, body := do("GET", statusURL, "", false); resp.StatusCode != 200 {
		t.Errorf("status_url: %d %s", resp.StatusCode, body)
	}
	// ... and render by the cid it just stored, and load it into the tab by cid
	if r := e.call("", "render", map[string]any{"cid": cid, "format": "wav"}); r.IsError {
		t.Errorf("render(cid): %s", r.Text)
	}
	if r := e.call("btw_alice", "load", map[string]any{"cid": cid}); r.IsError || r.body(t)["source"] != "store" {
		t.Errorf("load(cid): %s", r.Text)
	}
	next()

	// compose through MCP: the server has no model configured, and says so as a tool error
	if cr := e.call("btw_alice", "compose", map[string]any{"prompt": "x"}); cr.errBody(t)["code"] != "not_configured" {
		t.Errorf("compose: %s", cr.Text)
	}
	// the tools see the server's examples
	if le := e.call("", "list_examples", nil).body(t); len(le["examples"].([]any)) != len(srv.Examples()) {
		t.Errorf("list_examples: %v", le)
	}

	// every link in llms.txt answers 200 against the real routes (/api/examples, /examples/*, /api/instruments, /mcp)
	_, ll := do("GET", "/llms.txt", "", false)
	reLink := regexp.MustCompile(`\]\((` + regexp.QuoteMeta(ts.URL) + `[^)#\s]*)`)
	links := reLink.FindAllStringSubmatch(ll, -1)
	if len(links) < 14 {
		t.Fatalf("llms.txt has %d site links", len(links))
	}
	for _, m := range links {
		if resp, _ := do("GET", strings.TrimPrefix(m[1], ts.URL), "", false); resp.StatusCode != 200 {
			t.Errorf("%s answered %d", m[1], resp.StatusCode)
		}
	}
}

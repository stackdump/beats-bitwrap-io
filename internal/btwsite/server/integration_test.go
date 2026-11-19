package server

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
	"beats-bitwrap-io/internal/btwsite/mcpsrv"
)

// withDocs gives the env a docs directory with the two generated files.
func withDocs(c *Config) {
	d := filepath.Join(filepath.Dir(c.WebDir), "docs")
	os.MkdirAll(d, 0o755)
	os.WriteFile(filepath.Join(d, "BTW.md"), []byte("# btw\n\n## Grammar\n\nA program is lines.\n"), 0o644)
	os.WriteFile(filepath.Join(d, "cheatsheet.md"), []byte("# cheat sheet\n"), 0o644)
	c.DocsDir = d
}

func composeBody(prompt string) map[string]any { return map[string]any{"prompt": prompt} }

type composeOut struct {
	Program, Text, CID string
	Check              *api.CheckReport
	Attempts           []api.Attempt
	Model, License     string
	ComposedBy         string `json:"composedBy"`
	RenderURL          string `json:"render_url"`
	ShareURL           string `json:"share_url"`
	Header             []string
}

// The whole HTTP surface in one flow: sign in, compose with the fake model, the result is stored with its
// provenance, renders as a stream, is shared, and is a card; limits apply per client address; the admin kill
// switch works.
func TestIntegrationSignInComposeStoreRender(t *testing.T) {
	e := newEnv(t, func(c *Config) {
		withDocs(c)
		c.ComposeUserHour = 3
		c.ComposeIPDay = 3
		c.AdminToken = "admin-secret-token"
	}, "BTW_FAKE_CHUNK_DELAY_MS=2", "BTW_FAKE_SECONDS=2")

	var info struct {
		Compose struct {
			Enabled, Configured bool
			Limits              map[string]any
		}
		Model string
	}
	decode(t, e.get("/api/info"), &info)
	if !info.Compose.Enabled || !info.Compose.Configured || info.Model != "fake" || info.Compose.Limits["user_per_hour"].(float64) != 3 {
		t.Fatalf("info: %+v", info)
	}

	// anonymous: 401, and nothing about the service
	if st, code := errCode(t, e.post("/api/compose", composeBody("dark techno"), ip("192.0.2.5"))); st != 401 || code != api.CodeAuthRequired {
		t.Fatalf("anonymous compose: %d %s", st, code)
	}

	alice := e.newUser()
	var out composeOut
	if st := decode(t, e.post("/api/compose", composeBody("dark techno 128 with an acid line"), cookie(alice.cookie), ip("192.0.2.5")), &out); st != 200 {
		t.Fatalf("compose: %d", st)
	}
	if out.CID == "" || out.Check == nil || !out.Check.OK || out.License != "CC0-1.0" || len(out.Attempts) != 1 || !strings.Contains(out.ComposedBy, "fake") ||
		!strings.HasPrefix(out.RenderURL, "/api/render/"+out.CID) || !strings.HasPrefix(out.ShareURL, "https://btw.test/#"+out.CID+".") {
		t.Fatalf("compose result: %+v", out)
	}
	// stored through the real store, with provenance in the download header
	var prog api.Program
	if st := decode(t, e.get("/api/programs/"+out.CID), &prog); st != 200 || prog.Meta.ComposedBy == "" || prog.Meta.License != "CC0-1.0" || prog.Meta.Source != "compose" {
		t.Fatalf("stored: %d %+v", st, prog.Meta)
	}
	dl := string(readAll(t, e.get("/api/programs/"+out.CID+".btw")))
	if !strings.Contains(dl, "#! license: CC0-1.0\n") || !strings.Contains(dl, "#! composed-by: ") {
		t.Fatalf("download header:\n%s", dl)
	}
	// ... and renders straight away (the stream), first byte fast, no PUT needed
	start := time.Now()
	resp := e.get(out.RenderURL+"&format=wav", ip("192.0.2.5"))
	if resp.StatusCode != 200 {
		t.Fatalf("render: %d %s", resp.StatusCode, readAll(t, resp))
	}
	fb, _ := firstByte(t, resp, start)
	resp.Body.Close()
	if fb > time.Second {
		t.Errorf("first byte %s", fb)
	}
	// a token works as the cookie does
	tok := e.token(alice)
	if st := decode(t, e.post("/api/compose", composeBody("again"), bearer(tok), ip("192.0.2.5")), &out); st != 200 {
		t.Fatalf("compose by token: %d", st)
	}

	// per-user limit: 3 an hour (two used)
	e.post("/api/compose", composeBody("third"), cookie(alice.cookie), ip("192.0.2.6")).Body.Close()
	r := e.post("/api/compose", composeBody("fourth"), cookie(alice.cookie), ip("192.0.2.7"))
	if r.Header.Get("Retry-After") == "" {
		t.Fatalf("no Retry-After: %v", r.Header)
	}
	if st, code := errCode(t, r); st != 429 || code != api.CodeRateLimited {
		t.Fatalf("user limit: %d %s", st, code)
	}
	// per-IP limit is per CLIENT address (X-Real-IP behind the proxy), not one bucket for the proxy: three
	// users from 192.0.2.50 exhaust its 3, a fourth user from there is refused, one from elsewhere is not
	for i := 0; i < 3; i++ {
		u := e.newUser()
		if r := e.post("/api/compose", composeBody("x"), cookie(u.cookie), ip("192.0.2.50")); r.StatusCode != 200 {
			t.Fatalf("compose %d from .50: %d %s", i, r.StatusCode, readAll(t, r))
		} else {
			r.Body.Close()
		}
	}
	u4 := e.newUser()
	if st, code := errCode(t, e.post("/api/compose", composeBody("x"), cookie(u4.cookie), ip("192.0.2.50"))); st != 429 || code != api.CodeRateLimited {
		t.Fatalf("ip limit: %d %s", st, code)
	}
	if r := e.post("/api/compose", composeBody("x"), cookie(u4.cookie), ip("192.0.2.51")); r.StatusCode != 200 {
		t.Fatalf("a different client address should not be limited: %d", r.StatusCode)
	} else {
		r.Body.Close()
	}

	// admin: closed without the token, kill switch with it
	if st, _ := errCode(t, e.do("POST", "/api/admin/compose", strings.NewReader(`{"enabled":false}`), hdr("Content-Type", "application/json"))); st != 401 {
		t.Fatalf("admin without a token: %d", st)
	}
	if st, _ := errCode(t, e.do("POST", "/api/admin/compose", strings.NewReader(`{"enabled":false}`), hdr("Content-Type", "application/json"), bearer("wrong"))); st != 401 {
		t.Fatalf("admin with a wrong token: %d", st)
	}
	adm := bearer("admin-secret-token")
	var sw map[string]any
	if st := decode(t, e.do("POST", "/api/admin/compose", strings.NewReader(`{"enabled":false}`), hdr("Content-Type", "application/json"), adm), &sw); st != 200 || sw["enabled"] != false {
		t.Fatalf("kill switch: %d %v", st, sw)
	}
	u5 := e.newUser()
	if st, code := errCode(t, e.post("/api/compose", composeBody("x"), cookie(u5.cookie), ip("192.0.2.60"))); st != 503 || code != api.CodeDisabled {
		t.Fatalf("compose while switched off: %d %s", st, code)
	}
	// ... and the anonymous still gets 401, not 503: nothing is revealed to them
	if st, code := errCode(t, e.post("/api/compose", composeBody("x"), ip("192.0.2.60"))); st != 401 || code != api.CodeAuthRequired {
		t.Fatalf("anonymous while switched off: %d %s", st, code)
	}
	var stats map[string]any
	if st := decode(t, e.get("/api/admin/stats", adm), &stats); st != 200 || stats["enabled"] != false {
		t.Fatalf("stats: %d %v", st, stats)
	}
	decode(t, e.do("POST", "/api/admin/compose", strings.NewReader(`{"enabled":true}`), hdr("Content-Type", "application/json"), adm), &sw)
	if sw["enabled"] != true {
		t.Fatal("switch back on")
	}
	if r := e.post("/api/compose", composeBody("x"), cookie(u5.cookie), ip("192.0.2.60")); r.StatusCode != 200 {
		t.Fatalf("after switching back on: %d", r.StatusCode)
	} else {
		r.Body.Close()
	}
	// the response never carries a key, and the compose log has no prompt text
	logs, _ := filepath.Glob(filepath.Join(e.cfg.DataDir, "log", "compose-*.jsonl"))
	if len(logs) == 0 {
		t.Fatal("no compose log")
	}
	lb, _ := os.ReadFile(logs[0])
	if strings.Contains(string(lb), "dark techno 128 with an acid line, but a very long tail") || strings.Contains(string(lb), "admin-secret-token") {
		t.Fatal("the log holds something it must not")
	}
}

// POST /api/compose without credentials is 401 in every configuration, whatever else is wrong with the request.
func TestComposeWithoutCredentialsIs401EverywhereAndNeverReveals(t *testing.T) {
	type cfgCase struct {
		name string
		mod  func(*Config)
	}
	cases := []cfgCase{
		{"fake model", func(c *Config) { c.Model = "fake" }},
		{"no model, no key (not configured)", func(c *Config) { c.Model = ""; c.GeminiKey = "" }},
		{"switched off by the flag", func(c *Config) { c.ComposeEnabled = false }},
		{"a key but no model name", func(c *Config) { c.Model = "gemini-3.8-flash"; c.GeminiKey = "AIza-not-a-real-key" }},
		{"admin token set", func(c *Config) { c.AdminToken = "adm" }},
		{"tiny limits", func(c *Config) { c.ComposeUserHour, c.ComposeUserDay, c.ComposeIPDay = 1, 1, 1 }},
		{"zero prompt cap", func(c *Config) { c.MaxPromptChars = 1 }},
	}
	for _, cc := range cases {
		t.Run(cc.name, func(t *testing.T) {
			e := newEnv(t, cc.mod)
			good := e.newUser()
			forged := &http.Cookie{Name: "btw_session", Value: "eyJ1IjoiZWlwMTU1OjB4MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCJlIjo5OTk5OTk5OTk5fQ.AAAA"}
			creds := map[string][]opt{
				"none":                 nil,
				"junk cookie":          {cookie(&http.Cookie{Name: "btw_session", Value: "junk"})},
				"forged cookie":        {cookie(forged)},
				"truncated cookie":     {cookie(&http.Cookie{Name: "btw_session", Value: good.cookie.Value[:len(good.cookie.Value)-3]})},
				"unknown token":        {bearer("btw_" + strings.Repeat("A", 43))},
				"revoked-looking":      {bearer("btw_")},
				"the admin token":      {bearer("adm")},
				"basic auth":           {hdr("Authorization", "Basic YWRtaW46YWRtaW4=")},
				"x-real-ip as a user":  {ip("127.0.0.1")},
				"cookie on wrong name": {func(r *http.Request) { r.AddCookie(&http.Cookie{Name: "session", Value: good.cookie.Value}) }},
			}
			for name, os_ := range creds {
				for _, body := range []any{composeBody("dark techno"), map[string]any{}, "not json", nil} {
					var r *http.Response
					if body == nil {
						r = e.do("POST", "/api/compose", nil, os_...)
					} else {
						r = e.post("/api/compose", body, os_...)
					}
					st, code := errCode(t, r)
					if st != 401 || code != api.CodeAuthRequired {
						t.Errorf("%s / %v: got %d %s, want 401 auth_required", name, body, st, code)
					}
				}
			}
			// other methods never reach compose either
			for _, m := range []string{"GET", "PUT", "DELETE"} {
				if r := e.do(m, "/api/compose", nil); r.StatusCode == 200 {
					t.Errorf("%s /api/compose: 200", m)
				} else {
					r.Body.Close()
				}
			}
			// a signed-in user gets past the door (to whatever that configuration says)
			r := e.post("/api/compose", composeBody("dark techno"), cookie(good.cookie), ip("192.0.2.1"))
			if r.StatusCode == 401 {
				t.Errorf("a signed-in user was refused with 401")
			}
			r.Body.Close()
		})
	}
}

func TestComposeIsNeverMountedWithoutAnAuthenticator(t *testing.T) {
	e := newEnv(t, nil)
	if err := mountCompose(e.srv, http.NewServeMux(), http.NotFoundHandler(), nil); err == nil {
		t.Fatal("mountCompose accepted a nil Authenticator")
	}
	// and the server as built has one: the cookie it issues is what opens the door
	if e.srv.authn == nil {
		t.Fatal("server built without an authenticator")
	}
	// the Backend's Compose refuses anonymous callers too (the MCP path)
	if _, err := e.srv.Compose(nil, nil, "192.0.2.1", api.ComposeRequest{Prompt: "x"}); err == nil || err.(*api.Error).Code != api.CodeAuthRequired {
		t.Fatalf("Backend.Compose(nil user): %v", err)
	}
}

func TestComposeNotConfiguredIsA503ForSignedInUsers(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.Model = ""; c.GeminiKey = "" })
	u := e.newUser()
	if st, code := errCode(t, e.post("/api/compose", composeBody("x"), cookie(u.cookie))); st != 503 || code != api.CodeNotConfigured {
		t.Fatalf("%d %s", st, code)
	}
	var info struct{ Compose struct{ Configured bool } }
	decode(t, e.get("/api/info"), &info)
	if info.Compose.Configured {
		t.Fatal("info says configured")
	}
}

func TestComposeSwitchedOffByFlag(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.ComposeEnabled = false })
	u := e.newUser()
	if st, code := errCode(t, e.post("/api/compose", composeBody("x"), cookie(u.cookie))); st != 503 || code != api.CodeDisabled {
		t.Fatalf("%d %s", st, code)
	}
}

func TestAdminClosedWithoutToken(t *testing.T) {
	e := newEnv(t, nil)
	for _, tok := range []string{"", "x", "Bearer"} {
		var opts []opt
		if tok != "" {
			opts = append(opts, bearer(tok))
		}
		r := e.do("POST", "/api/admin/compose", strings.NewReader(`{"enabled":false}`), append(opts, hdr("Content-Type", "application/json"))...)
		if r.StatusCode != 503 && r.StatusCode != 401 {
			t.Errorf("admin with no configured token and %q: %d", tok, r.StatusCode)
		}
		r.Body.Close()
	}
	if st, code := errCode(t, e.get("/api/admin/stats")); st == 200 {
		t.Fatalf("stats open: %d %s", st, code)
	}
}

// ---- MCP through the real server ----

func mcp(t *testing.T, e *tenv, token, method string, params any) map[string]any {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	opts := []opt{hdr("Content-Type", "application/json"), hdr("Accept", "application/json, text/event-stream")}
	if token != "" {
		opts = append(opts, bearer(token))
	}
	resp := e.do("POST", "/mcp", bytes.NewReader(body), opts...)
	raw := readAll(t, resp)
	if resp.StatusCode != 200 {
		t.Fatalf("mcp %s: %d %s", method, resp.StatusCode, raw)
	}
	var payload []byte = raw
	if strings.Contains(resp.Header.Get("Content-Type"), "event-stream") {
		sc := bufio.NewScanner(bytes.NewReader(raw))
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		for sc.Scan() {
			if v, ok := strings.CutPrefix(sc.Text(), "data: "); ok {
				payload = []byte(v)
			}
		}
	}
	var out map[string]any
	if err := json.Unmarshal(payload, &out); err != nil {
		t.Fatalf("mcp %s: %v: %s", method, err, raw)
	}
	return out
}

func toolResult(t *testing.T, res map[string]any) (map[string]any, bool) {
	t.Helper()
	r, _ := res["result"].(map[string]any)
	if r == nil {
		t.Fatalf("no result: %v", res)
	}
	isErr, _ := r["isError"].(bool)
	content, _ := r["content"].([]any)
	if len(content) == 0 {
		t.Fatalf("no content: %v", r)
	}
	text, _ := content[0].(map[string]any)["text"].(string)
	var out map[string]any
	if err := json.Unmarshal([]byte(text), &out); err != nil {
		out = map[string]any{"text": text}
	}
	return out, isErr
}

func TestIntegrationMCPThroughTheRealServer(t *testing.T) {
	e := newEnv(t, withDocs, "BTW_FAKE_SECONDS=2")
	alice := e.newUser()
	tok := e.token(alice)

	list := mcp(t, e, "", "tools/list", map[string]any{})
	tools, _ := list["result"].(map[string]any)["tools"].([]any)
	var names []string
	for _, x := range tools {
		names = append(names, x.(map[string]any)["name"].(string))
	}
	want := append([]string(nil), mcpsrv.ToolNames...)
	sort.Strings(want)
	sort.Strings(names)
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("tools/list: %v, want %v", names, want)
	}
	// a read tool needs no token
	res, isErr := toolResult(t, mcp(t, e, "", "tools/call", map[string]any{"name": "check", "arguments": map[string]any{"text": progA}}))
	if isErr || res["ok"] != true {
		t.Fatalf("check: %v", res)
	}
	// a write tool without a token: a tool error that says how to get one
	res, isErr = toolResult(t, mcp(t, e, "", "tools/call", map[string]any{"name": "eval", "arguments": map[string]any{"text": progA}}))
	if !isErr || !strings.Contains(strings.ToLower(jsonString(res)), "auth_required") {
		t.Fatalf("eval without a token: %v", res)
	}
	// compose through MCP needs the token, and uses the real compose service
	res, isErr = toolResult(t, mcp(t, e, "", "tools/call", map[string]any{"name": "compose", "arguments": map[string]any{"prompt": "x"}}))
	if !isErr {
		t.Fatalf("anonymous compose over MCP: %v", res)
	}
	res, isErr = toolResult(t, mcp(t, e, tok, "tools/call", map[string]any{"name": "compose", "arguments": map[string]any{"prompt": "dark techno"}}))
	if isErr || res["cid"] == nil {
		t.Fatalf("compose over MCP: %v", res)
	}
	// eval reaches the browser tab over SSE; get reads what the tab reported
	sess := e.newSession(bearer(tok))
	tab := e.sse("/api/session/"+sess.ID+"/events", bearer(tok))
	tab.next(t, "ping", 2*time.Second)
	res, isErr = toolResult(t, mcp(t, e, tok, "tools/call", map[string]any{"name": "eval", "arguments": map[string]any{"text": progA, "play": true}}))
	if isErr || res["delivered"] != float64(1) {
		t.Fatalf("eval: %v", res)
	}
	m := tab.next(t, "eval", 2*time.Second)
	if !strings.Contains(m.data, "tempo 120") {
		t.Fatalf("the tab got %s", m.data)
	}
	e.post("/api/session/"+sess.ID+"/report", map[string]any{"text": progA, "cid": "zx", "playing": true, "section": "intro", "bar": 2}, bearer(tok)).Body.Close()
	res, isErr = toolResult(t, mcp(t, e, tok, "tools/call", map[string]any{"name": "get", "arguments": map[string]any{}}))
	if isErr || res["section"] != "intro" || res["bar"] != float64(2) {
		t.Fatalf("get: %v", res)
	}
	// MCP is not readable cross-origin, and a browser GET is the landing page
	r := e.get("/mcp", hdr("Accept", "text/html"), hdr("Origin", "https://evil.example"))
	body := string(readAll(t, r))
	if r.StatusCode != 200 || !strings.Contains(strings.ToLower(body), "mcp") || r.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("landing: %d cors=%q", r.StatusCode, r.Header.Get("Access-Control-Allow-Origin"))
	}
	if strings.Contains(strings.ToLower(body), "<script") {
		t.Errorf("the MCP landing page has an inline script, which the CSP blocks")
	}
}

func jsonString(v any) string { b, _ := json.Marshal(v); return string(b) }

// ---- docs and cards through the real server ----

var reMDLink = regexp.MustCompile(`\]\(([^)]+)\)`)

func TestIntegrationLlmsTxtLinksAnswer200(t *testing.T) {
	e := newEnv(t, withDocs)
	r := e.get("/llms.txt")
	body := string(readAll(t, r))
	if r.StatusCode != 200 || !strings.HasPrefix(body, "# btw") {
		t.Fatalf("llms.txt: %d %.100s", r.StatusCode, body)
	}
	links := reMDLink.FindAllStringSubmatch(body, -1)
	if len(links) < 4 {
		t.Fatalf("only %d links:\n%s", len(links), body)
	}
	for _, m := range links {
		u := m[1]
		if !strings.HasPrefix(u, "https://btw.test") {
			continue // off-site
		}
		path := strings.TrimPrefix(u, "https://btw.test")
		if rr := e.get(path); rr.StatusCode != 200 {
			t.Errorf("llms.txt links to %s which answers %d", u, rr.StatusCode)
		} else {
			rr.Body.Close()
		}
	}
	for _, p := range []string{"/llms-full.txt", "/docs/BTW.md", "/docs/cheatsheet.md", "/docs/api.md"} {
		if rr := e.get(p); rr.StatusCode != 200 {
			t.Errorf("%s: %d", p, rr.StatusCode)
		} else {
			rr.Body.Close()
		}
	}
}

func TestIntegrationCardsAndIndexMeta(t *testing.T) {
	e := newEnv(t, nil)
	var ex []api.Example
	decode(t, e.get("/api/examples"), &ex)
	cid := ex[1].CID

	// the static page carries the generic share card; /p too, with its own canonical URL
	for path, canon := range map[string]string{"/": "https://btw.test/", "/p": "https://btw.test/p"} {
		r := e.get(path)
		page := string(readAll(t, r))
		if !strings.Contains(page, `property="og:image" content="https://btw.test/card/default.png"`) || !strings.Contains(page, `rel="canonical" href="`+canon+`"`) {
			t.Errorf("%s lacks the generic card meta:\n%s", path, page)
		}
	}
	// /c/<cid>: og tags for a known program
	r := e.get("/c/" + cid)
	page := string(readAll(t, r))
	if r.StatusCode != 200 || !strings.Contains(page, `og:image`) || !strings.Contains(page, `twitter:card`) || !strings.Contains(page, "/card/"+cid+".png") {
		t.Fatalf("/c/<cid>: %d\n%s", r.StatusCode, page)
	}
	// CSP: the page's one script is /card/go.js, same origin; no inline script
	if strings.Contains(r.Header.Get("Content-Security-Policy"), "'unsafe-inline'") && strings.Contains(r.Header.Get("Content-Security-Policy"), "script-src 'self' 'unsafe-inline'") {
		t.Error("the card page needs no inline script")
	}
	if inline := regexp.MustCompile(`<script(?:\s[^>]*)?>[^<]`).FindString(page); inline != "" && !strings.Contains(inline, "src=") && !strings.Contains(inline, "application/ld+json") { // a JSON-LD data block is not a script
		t.Errorf("inline script on a card page: %q", inline)
	}
	// the PNG
	png := e.get("/card/" + cid + ".png")
	b := readAll(t, png)
	if png.StatusCode != 200 || png.Header.Get("Content-Type") != "image/png" || !bytes.HasPrefix(b, []byte("\x89PNG")) {
		t.Fatalf("card png: %d %v", png.StatusCode, png.Header)
	}
	if png.Header.Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Errorf("card cache: %q", png.Header.Get("Cache-Control"))
	}
	// the default card
	if d := e.get("/card/default.png"); d.StatusCode != 200 {
		t.Errorf("default card: %d", d.StatusCode)
	} else {
		d.Body.Close()
	}
	// a CID this site does not know: a generic card page, 200 (unfurlers must not cache an error)
	unk := e.get("/c/z" + strings.Repeat("3", 40))
	readAll(t, unk)
	if unk.StatusCode != 200 {
		t.Errorf("unknown cid page: %d", unk.StatusCode)
	}
	// a composed program has a card too (the store is shared)
	u := e.newUser()
	var out composeOut
	decode(t, e.post("/api/compose", composeBody("x"), cookie(u.cookie)), &out)
	if c := e.get("/card/" + out.CID + ".png"); c.StatusCode != 200 || !bytes.HasPrefix(readAll(t, c), []byte("\x89PNG")) {
		t.Errorf("card of a composed program: %d", c.StatusCode)
	}
}

func TestIntegrationWholeSurfaceSmoke(t *testing.T) {
	e := newEnv(t, withDocs)
	for _, p := range []string{"/", "/p", "/healthz", "/api/info", "/api/examples", "/api/instruments", "/examples/first-beat.btw", "/llms.txt", "/docs/api.md", "/card/default.png", "/api/auth/me", "/api/auth/challenge"} {
		r := e.get(p)
		io.Copy(io.Discard, r.Body)
		r.Body.Close()
		if r.StatusCode != 200 {
			t.Errorf("GET %s: %d", p, r.StatusCode)
		}
		if r.Header.Get("X-Content-Type-Options") != "nosniff" || r.Header.Get("Content-Security-Policy") == "" {
			t.Errorf("GET %s lacks security headers", p)
		}
	}
}

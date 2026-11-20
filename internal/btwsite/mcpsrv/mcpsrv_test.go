package mcpsrv_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/mark3labs/mcp-go/client"
	"github.com/mark3labs/mcp-go/client/transport"
	"github.com/mark3labs/mcp-go/mcp"

	"beats-bitwrap-io/internal/btwsite/api"
	"beats-bitwrap-io/internal/btwsite/mcpsrv"
)

// The tool names are the contract (btwsite/DESIGN.md "MCP"): tools/list answers exactly these.
var contractTools = []string{"check", "fmt", "eval", "load", "get", "share", "open", "render", "record", "list_examples", "instruments", "stop", "devices", "queue"}

func TestToolNamesAreTheContract(t *testing.T) {
	got := append([]string(nil), mcpsrv.ToolNames...)
	want := append([]string(nil), contractTools...)
	sort.Strings(got)
	sort.Strings(want)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("ToolNames = %v, want %v", got, want)
	}

	e := newEnv(t)
	m := e.rpc("", "tools/list", map[string]any{}, nil)
	var res struct {
		Tools []struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			InputSchema struct {
				Type                 string         `json:"type"`
				Properties           map[string]any `json:"properties"`
				Required             []string       `json:"required"`
				AdditionalProperties any            `json:"additionalProperties"`
			} `json:"inputSchema"`
			Annotations struct {
				ReadOnlyHint *bool `json:"readOnlyHint"`
			} `json:"annotations"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(m.Result, &res); err != nil {
		t.Fatal(err)
	}
	var names []string
	byName := map[string]int{}
	for i, tl := range res.Tools {
		names = append(names, tl.Name)
		byName[tl.Name] = i
		if len(tl.Description) < 150 {
			t.Errorf("%s: description is %d chars; write it for an LLM", tl.Name, len(tl.Description))
		}
		if tl.InputSchema.Type != "object" {
			t.Errorf("%s: inputSchema type %q", tl.Name, tl.InputSchema.Type)
		}
		if tl.InputSchema.AdditionalProperties != false {
			t.Errorf("%s: additionalProperties = %v, want false", tl.Name, tl.InputSchema.AdditionalProperties)
		}
	}
	sort.Strings(names)
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("tools/list = %v, want %v", names, want)
	}

	tool := func(n string) (desc string, props map[string]any, required []string) {
		tl := res.Tools[byName[n]]
		return tl.Description, tl.InputSchema.Properties, tl.InputSchema.Required
	}
	mustContain := func(n string, words ...string) {
		d, _, _ := tool(n)
		for _, w := range words {
			if !strings.Contains(d, w) {
				t.Errorf("%s description does not say %q", n, w)
			}
		}
	}
	// what the descriptions must tell a model
	mustContain("check", "ALWAYS", "line:col", "before eval")
	mustContain("eval", "https://btw.bitwrap.io", "session", "MCP", "check first", "next bar", "bearer token")
	// check carries the authoring loop (there is no compose tool) and the leading-digit gotcha
	mustContain("check", "no compose tool", "cheatsheet.md", "list_examples", "instruments", "eval", "share", "808-bass", "inst=sub-bass")
	mustContain("render", "CC0", "stream_url", "status_url", "limited")
	mustContain("get", "section", "marks", "diagnostics", "session", "bearer token")
	mustContain("share", "CID", "CC0")
	mustContain("list_examples", "CC0")
	mustContain("instruments", "voices", "kits")

	// schemas: enums and limits
	_, rp, _ := tool("render")
	fmtProp := rp["format"].(map[string]any)
	if enum, _ := fmtProp["enum"].([]any); len(enum) != 2 || enum[0] != "opus" || enum[1] != "wav" {
		t.Errorf("render.format enum = %v", fmtProp["enum"])
	}
	_, kp, kreq := tool("check")
	if v := kp["text"].(map[string]any)["maxLength"]; v != float64(16384) {
		t.Errorf("check.text maxLength = %v, want 16384", v)
	}
	if len(kreq) != 1 || kreq[0] != "text" {
		t.Errorf("check required = %v", kreq)
	}
	if _, _, req := tool("open"); len(req) != 1 || req[0] != "url" {
		t.Errorf("open required = %v", req)
	}
	for _, n := range []string{"check", "fmt", "get", "open", "list_examples", "instruments"} { // (get needs a token but changes nothing)
		if h := res.Tools[byName[n]].Annotations.ReadOnlyHint; h == nil || !*h {
			t.Errorf("%s should be annotated read-only", n)
		}
	}
	for _, n := range []string{"eval", "load", "stop", "share"} { // share stores the program when signed in (idempotent, additive)
		if h := res.Tools[byName[n]].Annotations.ReadOnlyHint; h != nil && *h {
			t.Errorf("%s writes and must not be read-only", n)
		}
	}
}

func TestReadToolsWorkAnonymously(t *testing.T) {
	e := newEnv(t)

	t.Run("check ok", func(t *testing.T) {
		r := e.call("", "check", map[string]any{"text": goodProgram})
		if r.IsError {
			t.Fatal(r.Text)
		}
		b := r.body(t)
		if b["ok"] != true || b["cid"] == "" || b["cid"] == nil {
			t.Fatalf("check = %s", r.Text)
		}
	})
	t.Run("check with errors is an answer with line and col", func(t *testing.T) {
		r := e.call("", "check", map[string]any{"text": "tempo 120\nBAD\n"})
		if r.IsError {
			t.Fatalf("diagnostics are the product, not a tool error: %s", r.Text)
		}
		b := r.body(t)
		d := b["diagnostics"].([]any)[0].(map[string]any)
		if b["ok"] != false || d["line"] != float64(2) || d["col"] != float64(1) || d["help"] == "" {
			t.Fatalf("check = %s", r.Text)
		}
	})
	t.Run("fmt", func(t *testing.T) {
		r := e.call("", "fmt", map[string]any{"text": "tempo   140\n\n# c\nkey fm\ndeck A: kick x ~ x ~\n"})
		b := r.body(t)
		if b["ok"] != true || !strings.HasPrefix(b["canonical"].(string), "tempo 140\nkey fm\n") {
			t.Fatalf("fmt = %s", r.Text)
		}
	})
	t.Run("instruments", func(t *testing.T) {
		r := e.call("", "instruments", nil)
		b := r.body(t)
		if r.IsError || len(b["voices"].([]any)) == 0 || b["kits"] == nil {
			t.Fatalf("instruments = %s", r.Text)
		}
	})
	t.Run("list_examples", func(t *testing.T) {
		r := e.call("", "list_examples", nil)
		ex := r.body(t)["examples"].([]any)[0].(map[string]any)
		if ex["name"] != "demo" || ex["url"] != siteURL+"/examples/demo.btw" || ex["license"] != "CC0-1.0" || ex["cid"] == "" {
			t.Fatalf("list_examples = %s", r.Text)
		}
		r = e.call("", "list_examples", map[string]any{"name": "demo"})
		if r.body(t)["text"] != goodProgram {
			t.Fatalf("list_examples name=demo = %s", r.Text)
		}
		r = e.call("", "list_examples", map[string]any{"name": "nope"})
		if r.errBody(t)["code"] != "not_found" {
			t.Fatalf("unknown example = %s", r.Text)
		}
	})
	t.Run("share and open round trip", func(t *testing.T) {
		r := e.call("", "share", map[string]any{"text": goodProgram})
		b := r.body(t)
		url, _ := b["url"].(string)
		if r.IsError || !strings.HasPrefix(url, siteURL+"/#z") || b["social_url"] == "" || b["cid"] == "" {
			t.Fatalf("share = %s", r.Text)
		}
		o := e.call("", "open", map[string]any{"url": url})
		ob := o.body(t)
		if o.IsError || ob["verified"] != true || ob["cid"] != b["cid"] || ob["canonical"] != b["canonical"] {
			t.Fatalf("open = %s", o.Text)
		}
	})
	t.Run("share refuses a program that does not check, with diagnostics", func(t *testing.T) {
		r := e.call("", "share", map[string]any{"text": "BAD\n"})
		em := r.errBody(t)
		det := em["details"].(map[string]any)
		if len(det["diagnostics"].([]any)) == 0 || !strings.Contains(em["message"].(string), "line:col") {
			t.Fatalf("share = %s", r.Text)
		}
	})
	t.Run("share refuses a restricted program", func(t *testing.T) {
		r := e.call("", "share", map[string]any{"text": "tempo 120\nuse restricted\ndeck A: kick x\n"})
		if r.errBody(t)["code"] != "restricted" {
			t.Fatalf("share = %s", r.Text)
		}
	})
	t.Run("open a forged link", func(t *testing.T) {
		r := e.call("", "open", map[string]any{"url": "not a link"})
		if !r.IsError {
			t.Fatalf("open(garbage) = %s", r.Text)
		}
	})
	t.Run("render stores the program and answers the stream", func(t *testing.T) {
		r := e.call("", "render", map[string]any{"text": goodProgram})
		b := r.body(t)
		cid, _ := b["cid"].(string)
		if r.IsError || cid == "" || b["stream_url"] != siteURL+"/api/render/"+cid+"?format=opus" ||
			b["status_url"] != siteURL+"/api/render/"+cid+"/status" || b["seconds"] != 15.4 || b["license"] != "CC0-1.0" {
			t.Fatalf("render = %s", r.Text)
		}
		if _, ok := e.b.Get(cid); !ok {
			t.Fatal("render did not store the program first")
		}
		// by cid, as compose would hand it over, and as wav
		r = e.call("", "render", map[string]any{"cid": cid, "format": "wav"})
		b = r.body(t)
		if r.IsError || b["stream_url"] != siteURL+"/api/render/"+cid+"?format=wav" {
			t.Fatalf("render(cid) = %s", r.Text)
		}
		// by example name
		r = e.call("", "render", map[string]any{"example": "demo"})
		if r.IsError {
			t.Fatalf("render(example) = %s", r.Text)
		}
		// an unknown cid, a bad format, none or two sources
		if c := e.call("", "render", map[string]any{"cid": "z" + strings.Repeat("2", 30)}).errBody(t)["code"]; c != "not_found" {
			t.Errorf("unknown cid code = %v", c)
		}
		if c := e.call("", "render", map[string]any{"cid": cid, "format": "mp3"}).errBody(t)["code"]; c != "bad_request" {
			t.Errorf("bad format code = %v", c)
		}
		if c := e.call("", "render", nil).errBody(t)["code"]; c != "bad_request" {
			t.Errorf("no source code = %v", c)
		}
		if c := e.call("", "render", map[string]any{"cid": cid, "example": "demo"}).errBody(t)["code"]; c != "bad_request" {
			t.Errorf("two sources code = %v", c)
		}
	})
	t.Run("render refuses what does not check or is private", func(t *testing.T) {
		r := e.call("", "render", map[string]any{"text": "BAD\n"})
		if r.errBody(t)["details"] == nil {
			t.Fatalf("render(BAD) = %s", r.Text)
		}
		r = e.call("", "render", map[string]any{"text": "tempo 120\nsample harp from \"x\"\ndeck A: kick x\n"})
		if r.errBody(t)["code"] != "restricted" {
			t.Fatalf("render(sample) = %s", r.Text)
		}
	})
	t.Run("open a bare CID the site stored", func(t *testing.T) {
		rep, _ := e.b.Check(context.Background(), goodProgram)
		r := e.call("", "open", map[string]any{"url": rep.CID})
		b := r.body(t)
		if r.IsError || b["verified"] != true || b["canonical"] != rep.Canonical {
			t.Fatalf("open(cid) = %s", r.Text)
		}
	})
}

func TestGetAndSessions(t *testing.T) {
	e := newEnv(t)
	e.b.state = &api.SessionState{CID: "zq", Playing: false, Section: "intro"}

	// get reads a browser tab, which only its owner may do: no token, no answer, and the words say how to get one
	em := e.call("", "get", nil).errBody(t)
	if em["code"] != "auth_required" || !strings.Contains(em["message"].(string), "MCP token") {
		t.Fatalf("anonymous get = %v", em)
	}
	// a token with no sessions: no_session that says how to connect one
	r := e.call("btw_alice", "get", nil)
	em = r.errBody(t)
	if em["code"] != "no_session" || !strings.Contains(em["message"].(string), "https://btw.bitwrap.io") {
		t.Fatalf("get without sessions = %s", r.Text)
	}
	// an explicit session, as the page's MCP panel shows it
	e.b.state = &api.SessionState{Text: goodProgram, CID: "zabc", Playing: true, Source: "engine", Section: "drop",
		SectionNum: 2, SectionsAll: 5, Bar: 11, BarsInSect: 8, Phase: 3, Marks: json.RawMessage(`{"active_lines":[5]}`),
		Diagnostics: json.RawMessage(`[]`)}
	r = e.call("btw_alice", "get", map[string]any{"session": "abcdefABCDEF123456"})
	b := r.body(t)
	if r.IsError || b["id"] != "abcdefABCDEF123456" || b["section"] != "drop" || b["section_num"] != float64(2) ||
		b["sections_total"] != float64(5) || b["bar"] != float64(11) || b["bars_in_section"] != float64(8) || b["phase"] != float64(3) ||
		b["marks"].(map[string]any)["active_lines"] == nil || b["playing"] != true || b["cid"] != "zabc" || b["text"] != goodProgram {
		t.Fatalf("get = %s", r.Text)
	}
	// several sessions: the most recently seen one
	e.b.sessions = []api.SessionInfo{
		{ID: "oldsession0001", LastSeen: "2026-11-17T10:00:00Z"},
		{ID: "newsession0002", LastSeen: "2026-11-17T10:00:09Z"},
		{ID: "midsession0003", LastSeen: "2026-11-17T10:00:05Z"},
	}
	r = e.call("btw_alice", "get", nil)
	b = r.body(t)
	if r.IsError || b["id"] != "newsession0002" || b["sessions_connected"] != float64(3) {
		t.Fatalf("get picks the latest: %s", r.Text)
	}
	// the picked session does not answer: the hub's words come first
	e.b.stateErr = api.Errf(409, api.CodeNoSession, "the browser did not answer (is the page still open?)")
	em = e.call("btw_alice", "get", nil).errBody(t)
	if em["code"] != "no_session" || !strings.Contains(em["message"].(string), "did not answer") || !strings.Contains(em["message"].(string), "session id") {
		t.Fatalf("get(unanswered) = %v", em)
	}
	// a stale explicit session names the id
	e.b.stateErr = api.Errf(404, api.CodeNoSession, "gone")
	r = e.call("btw_alice", "get", map[string]any{"session": "gonesession01"})
	em = r.errBody(t)
	if em["code"] != "no_session" || !strings.Contains(em["message"].(string), "gonesession01") {
		t.Fatalf("get(stale) = %s", r.Text)
	}
	// a malformed session id
	r = e.call("btw_alice", "get", map[string]any{"session": "no spaces allowed!"})
	if r.errBody(t)["code"] != "bad_request" {
		t.Fatalf("get(bad id) = %s", r.Text)
	}
}

func TestWriteToolsRefuseAnonymous(t *testing.T) {
	e := newEnv(t)
	cases := map[string]map[string]any{
		"eval": {"text": goodProgram},
		"load": {"example": "demo"},
		"stop": {},
		"get":  {},
	}
	for _, token := range []string{"", "btw_not_a_real_token"} {
		for tool, args := range cases {
			r := e.call(token, tool, args)
			em := r.errBody(t)
			if em["code"] != "auth_required" {
				t.Errorf("%s (token %q) code = %v", tool, token, em["code"])
			}
			msg, _ := em["message"].(string)
			if !strings.Contains(msg, "MCP token") || !strings.Contains(msg, "Authorization: Bearer") {
				t.Errorf("%s: the error does not carry Backend.AuthHelp(): %q", tool, msg)
			}
		}
	}
	if len(e.b.pushes) != 0 {
		t.Fatalf("a refused call reached the backend: %d pushes", len(e.b.pushes))
	}
	// AuthHelp empty: the default words still say how to get a token
	e.b.noHelp = true
	em := e.call("", "eval", map[string]any{"text": goodProgram}).errBody(t)
	if msg := em["message"].(string); !strings.Contains(msg, "MCP token") || !strings.Contains(msg, "https://btw.bitwrap.io") {
		t.Errorf("default auth words = %q", msg)
	}
}

func TestWriteToolsAcceptTokenUser(t *testing.T) {
	e := newEnv(t)

	t.Run("eval", func(t *testing.T) {
		r := e.call("btw_alice", "eval", map[string]any{"text": goodProgram, "play": true, "session": "tab1tab1tab1"})
		b := r.body(t)
		if r.IsError || b["sent"] != true || b["delivered"] != float64(1) || b["play"] != true {
			t.Fatalf("eval = %s", r.Text)
		}
		p := e.b.lastPush(t)
		if p.User == nil || p.User.ID != alice.ID || p.Session != "tab1tab1tab1" ||
			p.Event.Type != "eval" || p.Event.Text != goodProgram || !p.Event.Play || p.Event.CID == "" {
			t.Fatalf("push = %+v", p)
		}
	})
	t.Run("eval without a session targets the account's tabs", func(t *testing.T) {
		e.call("btw_alice", "eval", map[string]any{"text": goodProgram})
		p := e.b.lastPush(t)
		if p.Session != "" || p.Event.Play {
			t.Fatalf("push = %+v", p)
		}
	})
	t.Run("load by example, cid and link", func(t *testing.T) {
		r := e.call("btw_alice", "load", map[string]any{"example": "demo", "play": true})
		if r.IsError || r.body(t)["source"] != "example" {
			t.Fatalf("load(example) = %s", r.Text)
		}
		p := e.b.lastPush(t)
		if p.Event.Type != "load" || p.Event.Text != goodProgram || p.Event.CID == "" || !p.Event.Play {
			t.Fatalf("push = %+v", p)
		}
		cid := p.Event.CID

		r = e.call("btw_alice", "load", map[string]any{"cid": cid})
		if r.IsError || r.body(t)["source"] != "example" { // an example's CID resolves through the examples
			t.Fatalf("load(cid) = %s", r.Text)
		}
		// a stored program
		e.call("", "render", map[string]any{"text": "tempo 100\ndeck A: kick x ~ x ~\n"})
		var stored string
		for c := range e.b.store {
			if c != cid {
				stored = c
			}
		}
		r = e.call("btw_alice", "load", map[string]any{"cid": stored})
		if r.IsError || r.body(t)["source"] != "store" {
			t.Fatalf("load(stored) = %s", r.Text)
		}

		sh := e.call("", "share", map[string]any{"text": goodProgram}).body(t)["url"].(string)
		r = e.call("btw_alice", "load", map[string]any{"url": sh})
		if r.IsError || r.body(t)["source"] != "link" || e.b.lastPush(t).Event.Text == "" {
			t.Fatalf("load(url) = %s", r.Text)
		}

		// exactly one source; unknown ones
		if c := e.call("btw_alice", "load", nil).errBody(t)["code"]; c != "bad_request" {
			t.Errorf("load() code = %v", c)
		}
		if c := e.call("btw_alice", "load", map[string]any{"example": "demo", "cid": cid}).errBody(t)["code"]; c != "bad_request" {
			t.Errorf("load(two) code = %v", c)
		}
		if c := e.call("btw_alice", "load", map[string]any{"example": "nope"}).errBody(t)["code"]; c != "not_found" {
			t.Errorf("load(unknown example) code = %v", c)
		}
		if c := e.call("btw_alice", "load", map[string]any{"cid": "z" + strings.Repeat("3", 30)}).errBody(t)["code"]; c != "not_found" {
			t.Errorf("load(unknown cid) code = %v", c)
		}
	})
	t.Run("stop", func(t *testing.T) {
		r := e.call("btw_alice", "stop", nil)
		if r.IsError || r.body(t)["sent"] != true {
			t.Fatalf("stop = %s", r.Text)
		}
		if p := e.b.lastPush(t); p.Event.Type != "stop" || p.User.ID != alice.ID {
			t.Fatalf("push = %+v", p)
		}
	})
}

// compose is a web-app feature only: an MCP caller writes the program itself, so the site's model budget is not
// spent on a client that is already a model. The tool must not exist, and nothing an MCP call does reaches Compose.
func TestComposeIsNotAnMCPTool(t *testing.T) {
	e := newEnv(t)
	tools := mcpsrv.New(newBackend(), newAuth(), siteURL).Tools()
	if _, ok := tools["compose"]; ok {
		t.Fatal("compose is registered as an MCP tool")
	}
	for _, token := range []string{"", "btw_alice"} {
		m := e.rpc(token, "tools/call", map[string]any{"name": "compose", "arguments": map[string]any{"prompt": "dark techno"}}, nil)
		if m.Error == nil || !strings.Contains(m.Error.Message, "not found") {
			t.Errorf("tools/call compose (token %q) = %+v, want tool not found", token, m)
		}
	}
	if len(e.b.composes) != 0 {
		t.Fatalf("an MCP call reached Backend.Compose %d times", len(e.b.composes))
	}
	// the instructions teach the loop instead, and point at nothing that is gone
	m := e.rpc("", "initialize", map[string]any{"protocolVersion": "2025-03-26", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "t", "version": "0"}}, nil)
	var init struct {
		Instructions string `json:"instructions"`
	}
	if err := json.Unmarshal(m.Result, &init); err != nil {
		t.Fatal(err)
	}
	for _, w := range []string{"no compose tool", "cheatsheet.md", "list_examples", "instruments", "check", "line:col", "eval", "load", "share", "808-bass", "inst=sub-bass"} {
		if !strings.Contains(init.Instructions, w) {
			t.Errorf("instructions do not say %q", w)
		}
	}
	// the button on the page reads "Create an MCP token", and the language is BeatScript, not btw
	if !strings.Contains(init.Instructions, `press "Create an MCP token"`) {
		t.Errorf("instructions do not name the page's button as it reads: %s", init.Instructions)
	}
	if strings.Contains(init.Instructions, "btw is its") {
		t.Errorf("instructions call the language btw: %s", init.Instructions)
	}
	if strings.Contains(init.Instructions, "compose writes") || strings.Contains(init.Instructions, "(compose,") {
		t.Errorf("instructions still point at compose: %s", init.Instructions)
	}
	for name, tl := range tools {
		if d := tl.Tool.Description; strings.Contains(d, "compose and") || strings.Contains(d, "compose returned") || strings.Contains(d, "call compose") {
			t.Errorf("%s description still points at compose: %s", name, d)
		}
	}
}

func TestEvalWithNoSession(t *testing.T) {
	e := newEnv(t)

	check := func(label string, em map[string]any, want ...string) {
		t.Helper()
		if em["code"] != "no_session" {
			t.Fatalf("%s: code = %v", label, em["code"])
		}
		msg := em["message"].(string)
		for _, w := range append([]string{"https://btw.bitwrap.io", "browser", "MCP", "session"}, want...) {
			if !strings.Contains(msg, w) {
				t.Errorf("%s: the words do not say %q: %s", label, w, msg)
			}
		}
	}
	// the hub delivers to nobody
	e.b.pushN = 0
	check("n=0", e.call("btw_alice", "eval", map[string]any{"text": goodProgram}).errBody(t))
	// the hub says no_session itself
	e.b.pushN, e.b.pushErr = 1, api.Errf(404, api.CodeNoSession, "no live session")
	check("typed", e.call("btw_alice", "eval", map[string]any{"text": goodProgram, "play": true}).errBody(t))
	// an explicit id that is not live names the id
	check("explicit", e.call("btw_alice", "stop", map[string]any{"session": "deadbeef1234"}).errBody(t), "deadbeef1234")
	// another error from the hub passes through
	e.b.pushErr = api.Errf(403, "forbidden", "that session belongs to someone else")
	if c := e.call("btw_alice", "eval", map[string]any{"text": goodProgram}).errBody(t)["code"]; c != "forbidden" {
		t.Errorf("hub error code = %v", c)
	}
}

func TestEvalRefusesBadPrograms(t *testing.T) {
	e := newEnv(t)
	r := e.call("btw_alice", "eval", map[string]any{"text": "tempo 120\nBAD\n"})
	em := r.errBody(t)
	det := em["details"].(map[string]any)
	if em["code"] != "bad_request" || det["errors"] != float64(1) || len(det["diagnostics"].([]any)) != 1 || !strings.Contains(em["message"].(string), "nothing was sent") {
		t.Fatalf("eval(bad) = %s", r.Text)
	}
	r = e.call("btw_alice", "eval", map[string]any{"text": "tempo 120\nuse restricted\ndeck A: kick x\n"})
	if r.errBody(t)["code"] != "restricted" {
		t.Fatalf("eval(restricted) = %s", r.Text)
	}
	if len(e.b.pushes) != 0 {
		t.Fatal("a program that does not check was pushed to a browser")
	}
}

func TestOversizeAndBadInputsAreRefused(t *testing.T) {
	e := newEnv(t)
	big := "tempo 120\n" + strings.Repeat("deck A: kick x ~ x ~\n", 1000) // > 16384 bytes
	if len(big) <= 16384 {
		t.Fatalf("test program is only %d bytes", len(big))
	}
	for _, tool := range []string{"check", "fmt", "share", "render"} {
		r := e.call("btw_alice", tool, map[string]any{"text": big})
		em := r.errBody(t)
		if em["code"] != "too_large" || !strings.Contains(em["message"].(string), "16384") {
			t.Errorf("%s(big) = %s", tool, r.Text)
		}
	}
	if c := e.call("btw_alice", "eval", map[string]any{"text": big}).errBody(t)["code"]; c != "too_large" {
		t.Errorf("eval(big) code = %v", c)
	}
	if c := e.call("btw_alice", "open", map[string]any{"url": strings.Repeat("a", 40000)}).errBody(t)["code"]; c != "too_large" {
		t.Errorf("open(huge) code = %v", c)
	}
	// an unknown argument names the right ones; a mistyped session must not mean "every tab"
	r := e.call("btw_alice", "eval", map[string]any{"text": goodProgram, "sesion": "abcdefgh"})
	em := r.errBody(t)
	if em["code"] != "bad_request" || !strings.Contains(em["message"].(string), "session") {
		t.Errorf("typo = %s", r.Text)
	}
	if len(e.b.pushes) != 0 {
		t.Error("eval with a typo was pushed")
	}
	// wrong types
	for tool, args := range map[string]map[string]any{
		"check": {"text": 12}, "eval": {"text": goodProgram, "play": "yes"}, "check ": {},
	} {
		tool = strings.TrimSpace(tool)
		if r := e.call("btw_alice", tool, args); r.errBody(t)["code"] != "bad_request" {
			t.Errorf("%s(%v) = %s", tool, args, r.Text)
		}
	}
	// a request body far past any program is refused at the protocol level, without a panic
	huge := strings.Repeat("x", 1<<20)
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check","arguments":{"text":"` + huge + `"}}}`
	req, _ := http.NewRequest("POST", e.srv.URL+"/mcp", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if strings.Contains(string(raw), `"ok":true`) {
		t.Fatalf("a 1 MiB body was accepted: %.200s", raw)
	}
}

// The resolved client address is what an anonymous caller's allowance is counted by (it was checked through
// compose before compose left MCP).
func TestClientIPKeysAnonymousLimits(t *testing.T) {
	check := func(e *env, hdr map[string]string) bool {
		m := e.rpc("", "tools/call", map[string]any{"name": "check", "arguments": map[string]any{"text": goodProgram}}, hdr)
		var r struct {
			IsError bool `json:"isError"`
		}
		_ = json.Unmarshal(m.Result, &r)
		return m.Error == nil && !r.IsError
	}
	// default: api.ClientIP; the test client is on loopback, like nginx, so X-Real-IP counts
	e := newEnv(t, mcpsrv.WithCheckPerMin(1))
	if !check(e, map[string]string{"X-Real-IP": "203.0.113.9"}) || check(e, map[string]string{"X-Real-IP": "203.0.113.9"}) {
		t.Error("one address did not get exactly one check")
	}
	if !check(e, map[string]string{"X-Real-IP": "198.51.100.1"}) {
		t.Error("a second address shares the first one's allowance")
	}
	// a resolver the server passes in wins: every request is one address
	e2 := newEnv(t, mcpsrv.WithCheckPerMin(1), mcpsrv.WithClientIP(func(r *http.Request) string { return "198.51.100.7" }))
	if !check(e2, map[string]string{"X-Real-IP": "203.0.113.9"}) || check(e2, map[string]string{"X-Real-IP": "203.0.113.10"}) {
		t.Error("the custom resolver was not used")
	}
}

func TestCheckerToolsAreRateLimitedPerClient(t *testing.T) {
	now := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	e := newEnv(t, mcpsrv.WithCheckPerMin(3), mcpsrv.WithRenderPerHour(2), mcpsrv.WithNow(func() time.Time { return now }))
	for i := 0; i < 3; i++ {
		if r := e.call("", "check", map[string]any{"text": goodProgram}); r.IsError {
			t.Fatalf("call %d: %s", i, r.Text)
		}
	}
	r := e.call("", "check", map[string]any{"text": goodProgram})
	em := r.errBody(t)
	if em["code"] != "rate_limited" || em["retry_after"].(float64) < 1 || em["retry_after"].(float64) > 60 {
		t.Fatalf("4th check = %s", r.Text)
	}
	// fmt, share and open share the allowance; a signed-in caller has their own
	if c := e.call("", "fmt", map[string]any{"text": goodProgram}).errBody(t)["code"]; c != "rate_limited" {
		t.Errorf("fmt not limited: %v", c)
	}
	if r := e.call("btw_alice", "check", map[string]any{"text": goodProgram}); r.IsError {
		t.Errorf("another client was limited: %s", r.Text)
	}
	// the minute passes
	now = now.Add(61 * time.Second)
	if r := e.call("", "check", map[string]any{"text": goodProgram}); r.IsError {
		t.Errorf("not released after the window: %s", r.Text)
	}
	// render: 2 stores an hour per client
	progs := []string{"tempo 90\ndeck A: kick x\n", "tempo 91\ndeck A: kick x\n", "tempo 92\ndeck A: kick x\n"}
	now = now.Add(2 * time.Minute)
	for i, p := range progs {
		r := e.call("btw_alice", "render", map[string]any{"text": p})
		if i < 2 && r.IsError {
			t.Fatalf("render %d: %s", i, r.Text)
		}
		if i == 2 {
			em := r.errBody(t)
			if em["code"] != "rate_limited" || em["retry_after"].(float64) < 1 {
				t.Fatalf("3rd render = %s", r.Text)
			}
		}
	}
	// rendering a cid that is already stored costs nothing
	for cid := range e.b.store {
		if r := e.call("btw_alice", "render", map[string]any{"cid": cid}); r.IsError {
			t.Fatalf("render(cid) was limited: %s", r.Text)
		}
		break
	}
}

func TestLandingPage(t *testing.T) {
	e := newEnv(t)
	for _, path := range []string{"/mcp", "/mcp/"} {
		req, _ := http.NewRequest("GET", e.srv.URL+path, nil)
		req.Header.Set("Accept", "text/html")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		body := string(raw)
		if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/html") {
			t.Fatalf("GET %s: %d %s", path, resp.StatusCode, resp.Header.Get("Content-Type"))
		}
		for _, name := range contractTools {
			if !strings.Contains(body, `<span class="name">`+name+`</span>`) {
				t.Errorf("GET %s: the landing page does not list %q", path, name)
			}
		}
		for _, want := range []string{
			"claude mcp add --transport http btw https://btw.bitwrap.io/mcp --header &#39;Authorization: Bearer btw_...&#39;",
			"Tools (14)", "/llms.txt", `<meta name="author" content="Matt York">`,
		} {
			if !strings.Contains(body, want) && !strings.Contains(body, strings.ReplaceAll(want, "&#39;", "'")) {
				t.Errorf("GET %s: the landing page lacks %q", path, want)
			}
		}
		if strings.Count(body, `<link rel="me" href="https://github.com/stackdump">`) != 1 {
			t.Errorf("author identity lines missing or repeated")
		}
	}
}

// The real client library speaks to the handler: initialize, list, call, with the bearer header.
func TestRealMCPClient(t *testing.T) {
	e := newEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	c, err := client.NewStreamableHttpClient(e.srv.URL+"/mcp", transport.WithHTTPHeaders(map[string]string{"Authorization": "Bearer btw_alice"}))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.Start(ctx); err != nil {
		t.Fatal(err)
	}
	init, err := c.Initialize(ctx, mcp.InitializeRequest{Params: mcp.InitializeParams{
		ProtocolVersion: mcp.LATEST_PROTOCOL_VERSION, ClientInfo: mcp.Implementation{Name: "test", Version: "1"}}})
	if err != nil {
		t.Fatal(err)
	}
	if init.ServerInfo.Name != "beatscript" || !strings.Contains(init.Instructions, "check") || !strings.Contains(init.Instructions, "MCP token") {
		t.Fatalf("initialize = %+v", init)
	}
	tools, err := c.ListTools(ctx, mcp.ListToolsRequest{})
	if err != nil || len(tools.Tools) != 14 {
		t.Fatalf("ListTools = %v, %v", len(tools.Tools), err)
	}
	res, err := c.CallTool(ctx, mcp.CallToolRequest{Params: mcp.CallToolParams{Name: "eval", Arguments: map[string]any{"text": goodProgram, "play": true}}})
	if err != nil || res.IsError {
		t.Fatalf("eval = %+v, %v", res, err)
	}
	if p := e.b.lastPush(t); p.User == nil || p.User.ID != alice.ID {
		t.Fatalf("the bearer header did not reach the authenticator: %+v", p)
	}
	res, err = c.CallTool(ctx, mcp.CallToolRequest{Params: mcp.CallToolParams{Name: "check", Arguments: map[string]any{"text": "BAD"}}})
	if err != nil || res.IsError || !strings.Contains(res.Content[0].(mcp.TextContent).Text, `"ok":false`) {
		t.Fatalf("check = %+v, %v", res, err)
	}
}

func TestInstrumentsAreCached(t *testing.T) {
	now := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	e := newEnv(t, mcpsrv.WithNow(func() time.Time { return now }))
	a := e.call("", "instruments", nil).Text
	b := e.call("", "instruments", nil).Text
	if a == "" || a != b {
		t.Fatalf("instruments differ: %q vs %q", a, b)
	}
	now = now.Add(6 * time.Minute) // past the TTL: still answers
	if e.call("", "instruments", nil).IsError {
		t.Fatal("instruments failed after the TTL")
	}
}

// The whole tools/list answer (names, descriptions, input schemas) is kept in testdata/mcp/tools-list.json so a
// change to what a model sees shows up in review. UPDATE_GOLDEN=1 go test ./internal/btwsite/mcpsrv rewrites it.
func TestToolsListGolden(t *testing.T) {
	e := newEnv(t)
	m := e.rpc("", "tools/list", map[string]any{}, nil)
	var res struct {
		Tools []map[string]any `json:"tools"`
	}
	if err := json.Unmarshal(m.Result, &res); err != nil {
		t.Fatal(err)
	}
	sort.Slice(res.Tools, func(i, j int) bool { return res.Tools[i]["name"].(string) < res.Tools[j]["name"].(string) })
	got, err := json.MarshalIndent(map[string]any{"tools": res.Tools}, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	got = append(got, '\n')
	path := filepath.Join("..", "..", "..", "btwsite", "testdata", "mcp", "tools-list.json")
	if os.Getenv("UPDATE_GOLDEN") != "" {
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (UPDATE_GOLDEN=1 creates it)", err)
	}
	if string(want) != string(got) {
		t.Fatalf("tools/list differs from %s; review the change and run with UPDATE_GOLDEN=1", path)
	}
}

// A client that asks for the notification stream (GET with Accept: text/event-stream) is told there is none,
// as the transport spec allows, instead of being handed an idle stream that holds a connection open.
func TestEventStreamGetIsRefused(t *testing.T) {
	e := newEnv(t)
	req, _ := http.NewRequest("GET", e.srv.URL+"/mcp", nil)
	req.Header.Set("Accept", "text/event-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 405 || resp.Header.Get("Allow") != "POST" {
		t.Fatalf("GET text/event-stream: %d Allow %q", resp.StatusCode, resp.Header.Get("Allow"))
	}
	// other verbs are not the transport's either
	req, _ = http.NewRequest("PUT", e.srv.URL+"/mcp", strings.NewReader("{}"))
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 404 && resp.StatusCode != 405 {
		t.Fatalf("PUT: %d", resp.StatusCode)
	}
	// a POST with the wrong content type is a client error, not a crash
	req, _ = http.NewRequest("POST", e.srv.URL+"/mcp", strings.NewReader("hello"))
	req.Header.Set("Content-Type", "text/plain")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("POST text/plain: %d", resp.StatusCode)
	}
}

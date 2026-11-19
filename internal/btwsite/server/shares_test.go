package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"beats-bitwrap-io/internal/btwsite/api"
)

// not an example's text (the fixtures' examples are progA's program): the store, not the examples, answers for it
const progX = "tempo 111\nkey am\ndeck A: kick x ~ x ~\nsection intro 2 bars\n"

func (e *tenv) cidOf(text string) string {
	e.t.Helper()
	var rep api.CheckReport
	if st := decode(e.t, e.post("/api/check", map[string]string{"text": text}, ip("192.0.2.150")), &rep); st != 200 || !rep.OK {
		e.t.Fatalf("check: %d %+v", st, rep)
	}
	return rep.CID
}

// putShare is PUT /api/shares/<cid> with a JSON body.
func (e *tenv) putShare(cid string, body any, opts ...opt) *http.Response {
	return e.do("PUT", "/api/shares/"+cid, jsonBody(body), append([]opt{hdr("Content-Type", "application/json")}, opts...)...)
}

type shareOut struct {
	CID      string   `json:"cid"`
	Created  bool     `json:"created"`
	Meta     api.Meta `json:"meta"`
	Short    string   `json:"short_url"`
	Social   string   `json:"short_social_url"`
	Beats    string   `json:"short_beats_url"`
	FetchURL string   `json:"fetch_url"`
	Warnings int      `json:"warnings"`
}

// A signed-in share stores the public program with its rights; the CID-only forms are built from the CID; a public
// GET by CID returns the canonical text and the rights; the first share's rights stay.
func TestShareStoreAndFetch(t *testing.T) {
	e := newEnv(t, nil)
	u := e.newUser()
	tok := e.token(u)
	cid := e.cidOf(progX)

	body := map[string]any{"text": progX, "license": "CC-BY-4.0", "forked_from": e.cidOf(progB), "credits": []string{"Matt", "a friend"}, "name": "first light"}
	var out shareOut
	if st := decode(t, e.putShare(cid, body, bearer(tok)), &out); st != 201 {
		t.Fatalf("share: %d", st)
	}
	if !out.Created || out.CID != cid || out.Short != "https://btw.test/p/"+cid || out.Social != "https://btw.test/c/"+cid ||
		out.Beats != "https://beats.bitwrap.io/p/"+cid || out.FetchURL != "https://btw.test/api/programs/"+cid {
		t.Fatalf("share answer: %+v", out)
	}
	if m := out.Meta; m.License != "CC-BY-4.0" || m.Visibility != "public" || m.Name != "first light" || m.ForkedFrom != e.cidOf(progB) || len(m.Credits) != 2 || m.Source != "share" {
		t.Fatalf("rights: %+v", m)
	}

	// fetch by CID: public (no credentials), cross-origin readable, immutable
	var got api.Program
	resp := e.get("/api/programs/"+cid, hdr("Origin", "https://beats.bitwrap.io"))
	if resp.Header.Get("Access-Control-Allow-Origin") != "*" || !strings.Contains(resp.Header.Get("Cache-Control"), "immutable") {
		t.Fatalf("fetch headers: %v", resp.Header)
	}
	if st := decode(t, resp, &got); st != 200 || got.CID != cid || got.Text == "" || got.Meta.License != "CC-BY-4.0" || got.Meta.Credits[1] != "a friend" || got.Meta.ForkedFrom == "" {
		t.Fatalf("fetch: %d %+v", st, got)
	}

	// the first share's rights stay; the answer says so
	body["license"], body["credits"] = "CC0-1.0", []string{"someone else"}
	var again shareOut
	if st := decode(t, e.putShare(cid, body, bearer(tok)), &again); st != 200 || again.Created || again.Meta.License != "CC-BY-4.0" {
		t.Fatalf("second share: %d %+v", st, again)
	}

	// the short page: a card for the CID, a person is sent to /#<CID> (the page fetches and checks it)
	page := string(readAll(t, e.get("/p/"+cid)))
	if !strings.Contains(page, `og:url`) || !strings.Contains(page, "https://btw.test/p/"+cid) || !strings.Contains(page, `"/#`+cid+`"`) && !strings.Contains(page, "/#"+cid) {
		t.Fatalf("short page:\n%s", page)
	}
	if strings.Contains(page, "/#"+cid+".") {
		t.Fatalf("the short page must not carry the packed program:\n%s", page)
	}
	// a /p/<CID>.<packed> is not a short link; /p alone is still the app page
	if st := e.get("/p/" + cid + ".abc").StatusCode; st != 404 {
		t.Fatalf("/p/<cid>.<packed>: %d", st)
	}
	if st := e.get("/p").StatusCode; st != 200 {
		t.Fatalf("/p: %d", st)
	}
}

func TestShareRefusals(t *testing.T) {
	e := newEnv(t, nil)
	u := e.newUser()
	tok := e.token(u)
	cid := e.cidOf(progX)
	ok := map[string]any{"text": progX}

	// no credential: 401, and nothing stored
	if st, code := errCode(t, e.putShare(cid, ok)); st != 401 || code != api.CodeAuthRequired {
		t.Fatalf("anonymous: %d %s", st, code)
	}
	if _, found := e.srv.Get(cid); found {
		t.Fatal("an anonymous share stored a program")
	}
	// a cookie is a credential too
	if st := decode(t, e.putShare(cid, ok, cookie(u.cookie)), nil); st != 201 {
		t.Fatalf("cookie share: %d", st)
	}
	// text that is another program than the CID says
	if st, code := errCode(t, e.putShare(e.cidOf(progC), ok, bearer(tok))); st != 422 || code != api.CodeCIDMismatch {
		t.Fatalf("mismatch: %d %s", st, code)
	}
	// private: by header, by the body's visibility, and the restricted/asset kinds
	priv := "#! visibility: private\n" + progB
	if st, code := errCode(t, e.putShare(e.cidOf(priv), map[string]any{"text": priv}, bearer(tok))); st != 422 || code != api.CodeRestricted {
		t.Fatalf("private header: %d %s", st, code)
	}
	if st, code := errCode(t, e.putShare(e.cidOf(progC), map[string]any{"text": progC, "visibility": "private"}, bearer(tok))); st != 422 || code != api.CodeRestricted {
		t.Fatalf("private body: %d %s", st, code)
	}
	for name, text := range map[string]string{"restricted": "tempo 120\nuse restricted\ndeck A: kick x\n", "sample": "tempo 120\nsample kick.wav\n"} {
		if st, code := errCode(t, e.putShare(e.cidOf(text), map[string]any{"text": text}, bearer(tok))); st != 422 || code != api.CodeRestricted {
			t.Errorf("%s: %d %s", name, st, code)
		}
	}
	if _, found := e.srv.Get(e.cidOf(progC)); found {
		t.Fatal("a refused share was stored")
	}
	// malformed rights and bodies
	cidC := e.cidOf(progC)
	for name, b := range map[string]any{
		"empty":      map[string]any{"text": "  "},
		"unknown":    map[string]any{"text": progC, "model": "x"},
		"license":    map[string]any{"text": progC, "license": "not a licence!"},
		"forked":     map[string]any{"text": progC, "forked_from": "nope"},
		"credits":    map[string]any{"text": progC, "credits": []string{"1", "2", "3", "4", "5", "6", "7", "8", "9"}},
		"credit-nl":  map[string]any{"text": progC, "credits": []string{"a\nb"}},
		"credit-len": map[string]any{"text": progC, "credits": []string{strings.Repeat("x", 81)}},
		"name":       map[string]any{"text": progC, "name": "a\nb"},
	} {
		if st, code := errCode(t, e.putShare(cidC, b, bearer(tok))); st != 400 || code != api.CodeBadRequest {
			t.Errorf("%s: %d %s", name, st, code)
		}
	}
	if st, _ := errCode(t, e.putShare("nope", ok, bearer(tok))); st != 400 {
		t.Fatalf("bad cid: %d", st)
	}
}

// A paired phone writes as the account that paired it; the signature covers the body.
func TestShareByPairedPhone(t *testing.T) {
	e := newEnv(t, nil)
	u := e.newUser()
	p := newPhone(21)
	e.pairPhone(u, p)
	cid := e.cidOf(progB)
	body, _ := json.Marshal(map[string]any{"text": progB, "credits": []string{"from the phone"}})
	var out shareOut
	if st := decode(t, e.signed(p, "PUT", "/api/shares/"+cid, body), &out); st != 201 || !out.Created || out.Short != "https://btw.test/p/"+cid {
		t.Fatalf("phone share: %d %+v", st, out)
	}
	// the phone's fetch needs no signature
	var got api.Program
	if st := decode(t, e.get("/api/programs/"+cid), &got); st != 200 || got.Meta.Credits[0] != "from the phone" {
		t.Fatalf("fetch: %d %+v", st, got)
	}
	// a stranger's cookie on the device-signed form is not enough, and a tampered body fails its signature
	if st, _ := errCode(t, e.putShare(e.cidOf(progC), map[string]any{"text": progC}, hdr("Authorization", "BtwDevice nope.1.abc"))); st != 401 {
		t.Fatalf("bad device credential: %d", st)
	}
	e.srv.unpair(p.device, "", "test")
	if st, code := errCode(t, e.signed(p, "PUT", "/api/shares/"+e.cidOf(progC), []byte(`{"text":"x"}`))); st != 410 || code != "unpaired" {
		t.Fatalf("unpaired phone: %d %s", st, code)
	}
}

func TestShareRateLimit(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.ShareHour = 2 })
	a, b := e.newUser(), e.newUser()
	ta, tb := e.token(a), e.token(b)
	for i, text := range []string{progX, progB} {
		if st := decode(t, e.putShare(e.cidOf(text), map[string]any{"text": text}, bearer(ta), ip("192.0.2.31")), nil); st != 201 {
			t.Fatalf("share %d: %d", i, st)
		}
	}
	resp := e.putShare(e.cidOf(progC), map[string]any{"text": progC}, bearer(ta), ip("192.0.2.31"))
	if resp.Header.Get("Retry-After") == "" {
		t.Fatal("no Retry-After")
	}
	if st, code := errCode(t, resp); st != 429 || code != api.CodeRateLimited {
		t.Fatalf("third share: %d %s", st, code)
	}
	// the limit is per account: another account on the same address still writes
	if st := decode(t, e.putShare(e.cidOf(progC), map[string]any{"text": progC}, bearer(tb), ip("192.0.2.31")), nil); st != 201 {
		t.Fatalf("other account: %d", st)
	}
	// and a refused (unauthenticated) call costs the account nothing
	e.putShare(e.cidOf(progC), map[string]any{"text": progC}).Body.Close()
}

// What the store keeps must hash to its name: a file edited on disk is not served, and not opened over MCP.
func TestStoredTextMustHashToItsCID(t *testing.T) {
	e := newEnv(t, nil)
	tok := e.token(e.newUser())
	cid := e.cidOf(progX)
	if st := decode(t, e.putShare(cid, map[string]any{"text": progX}, bearer(tok)), nil); st != 201 {
		t.Fatal("share")
	}
	path := filepath.Join(e.cfg.DataDir, "programs", cid+".json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var p api.Program
	json.Unmarshal(raw, &p)
	p.Text = e.canonical(progB) // another program under this CID
	raw, _ = json.Marshal(p)
	os.WriteFile(path, raw, 0o644)

	if st, code := errCode(t, e.get("/api/programs/"+cid)); st != 404 || code != api.CodeNotFound {
		t.Fatalf("fetch of a tampered file: %d %s", st, code)
	}
	out, isErr := toolResult(t, mcp(t, e, "", "tools/call", map[string]any{"name": "open", "arguments": map[string]any{"url": "https://btw.test/p/" + cid}}))
	if !isErr || !strings.Contains(toJSON(out), "not_found") {
		t.Fatalf("mcp open of a tampered file: %v %v", isErr, out)
	}
}

func (e *tenv) canonical(text string) string {
	e.t.Helper()
	var rep api.CheckReport
	decode(e.t, e.post("/api/check", map[string]string{"text": text}, ip("192.0.2.151")), &rep)
	return rep.Canonical
}

func toJSON(v any) string { b, _ := json.Marshal(v); return string(b) }

// MCP: share returns both forms for a signed-in caller (and only the self-sealing links to an anonymous one);
// open takes either, answers the rights, and refuses what is not stored.
func TestMCPShareAndOpenBothForms(t *testing.T) {
	e := newEnv(t, nil)
	tok := e.token(e.newUser())
	call := func(token, name string, args map[string]any) (map[string]any, bool) {
		return toolResult(t, mcp(t, e, token, "tools/call", map[string]any{"name": name, "arguments": args}))
	}
	cid := e.cidOf(progX)

	// anonymous: the sealed links, no short ones, and nothing stored
	out, isErr := call("", "share", map[string]any{"text": progX})
	if isErr || out["short_url"] != nil || out["stored"] != false || !strings.Contains(out["url"].(string), "#"+cid+".") || !strings.Contains(out["short_note"].(string), "signed-in") {
		t.Fatalf("anonymous share: %v %v", isErr, out)
	}
	if _, found := e.srv.Get(cid); found {
		t.Fatal("an anonymous share stored a program")
	}

	// signed in: both forms, stored with the rights
	out, isErr = call(tok, "share", map[string]any{"text": progX, "credits": []any{"Matt"}, "license": "CC-BY-4.0", "name": "demo"})
	if isErr || out["stored"] != true || out["short_url"] != "https://btw.test/p/"+cid || out["short_beats_url"] != "https://beats.bitwrap.io/p/"+cid ||
		out["short_social_url"] != "https://btw.test/c/"+cid || !strings.Contains(out["url"].(string), "#"+cid+".") || out["cid"] != cid {
		t.Fatalf("signed-in share: %v %v", isErr, out)
	}
	if m := out["meta"].(map[string]any); m["license"] != "CC-BY-4.0" || m["name"] != "demo" || m["credits"].([]any)[0] != "Matt" {
		t.Fatalf("meta: %v", m)
	}
	// private programs are never shared or stored, signed in or not
	if out, isErr = call(tok, "share", map[string]any{"text": "#! visibility: private\n" + progB}); !isErr {
		t.Fatalf("private share answered: %v", out)
	}
	// bad rights are refused before any work
	if out, isErr = call(tok, "share", map[string]any{"text": progX, "forked_from": "nope"}); !isErr {
		t.Fatalf("bad forked_from: %v", out)
	}

	// open takes either form and answers the same program
	sealed := out0(t, call, "", "open", map[string]any{"url": firstURL(t, e, tok, progX)})
	for _, u := range []string{cid, "https://btw.test/p/" + cid, "https://beats.bitwrap.io/p/" + cid, "https://btw.test/c/" + cid, "https://btw.test/#" + cid, "#" + cid} {
		got, isErr := call("", "open", map[string]any{"url": u})
		if isErr || got["verified"] != true || got["cid"] != cid || got["canonical"] != sealed["canonical"] || got["source"] != "store" {
			t.Fatalf("open %s: %v %v", u, isErr, got)
		}
		if m := got["meta"].(map[string]any); m["license"] != "CC-BY-4.0" {
			t.Fatalf("open %s: meta %v", u, m)
		}
	}
	// an unknown CID is not_found, not a crash
	unknown := e.cidOf(progC)
	if got, isErr := call("", "open", map[string]any{"url": "https://btw.test/p/" + unknown}); !isErr || !strings.Contains(toJSON(got), "not_found") {
		t.Fatalf("open unknown: %v %v", isErr, got)
	}
	// load accepts a short link too (to a connected tab; here it only has to resolve the program: no_session is its answer)
	if got, isErr := call(tok, "load", map[string]any{"url": "https://btw.test/p/" + cid}); !isErr || !strings.Contains(toJSON(got), "no_session") {
		t.Fatalf("load short link: %v %v", isErr, got)
	}
}

func out0(t *testing.T, call func(string, string, map[string]any) (map[string]any, bool), token, name string, args map[string]any) map[string]any {
	t.Helper()
	out, isErr := call(token, name, args)
	if isErr {
		t.Fatalf("%s: %v", name, out)
	}
	return out
}

func firstURL(t *testing.T, e *tenv, tok, text string) string {
	t.Helper()
	out, _ := toolResult(t, mcp(t, e, tok, "tools/call", map[string]any{"name": "share", "arguments": map[string]any{"text": text}}))
	return out["url"].(string)
}

package docs_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"testing"

	"beats-bitwrap-io/internal/btwsite/api"
	"beats-bitwrap-io/internal/btwsite/docs"
	"beats-bitwrap-io/internal/btwsite/fakecheck"
)

func repoRoot(t *testing.T) string {
	t.Helper()
	_, f, _, _ := runtime.Caller(0)
	return filepath.Clean(filepath.Join(filepath.Dir(f), "..", "..", ".."))
}

// docsDir is the generated btwsite/web/docs when both files are there (they are built from the private
// repo and never committed), else the small stand-ins in btwsite/testdata/docs (always, with BTW_DOCS_FIXTURES=1).
func docsDir(t *testing.T) (dir string, real bool) {
	t.Helper()
	gen := filepath.Join(repoRoot(t), "btwsite", "web", "docs")
	if os.Getenv("BTW_DOCS_FIXTURES") == "" && fileExists(filepath.Join(gen, "BTW.md")) && fileExists(filepath.Join(gen, "cheatsheet.md")) {
		return gen, true
	}
	return filepath.Join(repoRoot(t), "btwsite", "testdata", "docs"), false
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

func examplesDir(t *testing.T) string { return filepath.Join(repoRoot(t), "btwsite", "examples") }

type site struct {
	srv *httptest.Server
	set *docs.ExampleSet
	dir string
}

// newSite is the service as far as G3 owns it: the docs, plus fake versions of the routes llms.txt links to
// that belong to the server package (/api/instruments, /mcp).
func newSite(t *testing.T, dir string) *site {
	t.Helper()
	set, err := docs.LoadExampleSet(examplesDir(t), fakecheck.Checker{})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	if err := docs.Mount(mux, docs.Options{DocsDir: dir, Checker: fakecheck.Checker{}, Examples: set.List, ExampleText: set.Text, PublicURL: srv.URL}); err != nil {
		t.Fatal(err)
	}
	docs.MountExamples(mux, set.List, set.Text)
	mux.HandleFunc("GET /api/instruments", func(w http.ResponseWriter, r *http.Request) { // the fake backend's
		raw, _ := fakecheck.Checker{}.Instruments(r.Context())
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(raw)
	})
	mux.HandleFunc("/mcp", func(w http.ResponseWriter, r *http.Request) { // mcpsrv's landing page
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte("<html><body>btw MCP server</body></html>"))
	})
	return &site{srv, set, dir}
}

func get(t *testing.T, url string, hdr ...string) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest("GET", url, nil)
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, string(b)
}

var reLink = regexp.MustCompile(`\[([^\]]+)\]\(([^)\s]+)\)`)

// ---------- llms.txt ----------

func TestLlmsTxtIsLlmstxtOrgShaped(t *testing.T) {
	dir, _ := docsDir(t)
	s := newSite(t, dir)
	resp, body := get(t, s.srv.URL+"/llms.txt")
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	lines := strings.Split(body, "\n")
	if lines[0] != "# btw" {
		t.Errorf("first line %q, want the H1 `# btw`", lines[0])
	}
	// the summary blockquote comes right after the H1
	var summary string
	for _, l := range lines[1:] {
		if strings.TrimSpace(l) != "" {
			summary = l
			break
		}
	}
	if !strings.HasPrefix(summary, "> ") || !strings.Contains(summary, "CID") || !strings.Contains(summary, "CC0") {
		t.Errorf("no summary blockquote after the H1: %q", summary)
	}
	if !strings.Contains(body, "Key facts:") || !strings.Contains(body, "fix every line:column error") {
		t.Error("the key facts (and the advice to check and fix line:column errors) are missing")
	}
	// the H2 sections, in order
	var h2 []string
	for _, l := range lines {
		if strings.HasPrefix(l, "## ") {
			h2 = append(h2, strings.TrimPrefix(l, "## "))
		}
	}
	if strings.Join(h2, ",") != "Docs,Examples,API,Optional" {
		t.Errorf("sections = %v, want Docs, Examples, API, Optional", h2)
	}
	// every list line under a section is "- [name](url): note" with an absolute URL
	reItem := regexp.MustCompile(`^- \[[^\]]+\]\((https?://[^)\s]+)\): \S.*$`)
	inSection := false
	items := 0
	for _, l := range lines {
		if strings.HasPrefix(l, "## ") {
			inSection = true
			continue
		}
		if inSection && strings.TrimSpace(l) != "" {
			if !reItem.MatchString(l) {
				t.Errorf("not a `- [name](url): note` line: %q", l)
			}
			items++
		}
	}
	if items < 14 {
		t.Errorf("only %d links", items)
	}
	// every example, by name, with its facts
	for _, e := range s.set.List() {
		want := "- [" + e.Name + "](" + s.srv.URL + "/examples/" + e.Name + ".btw): "
		if !strings.Contains(body, want) {
			t.Errorf("llms.txt has no line starting %q", want)
		}
	}
	if !strings.Contains(body, "CC0-1.0, 140 BPM") {
		t.Error("the example notes do not carry license and BPM")
	}
	// the three named in the design are there
	for _, n := range []string{"hand-dubstep-140-v4", "matrix-130", "trance-138"} {
		if !strings.Contains(body, "/examples/"+n+".btw") {
			t.Errorf("llms.txt does not list %s", n)
		}
	}
}

// Every link in llms.txt that points at the site answers 200, and every #fragment names a heading.
func TestEveryLinkInLlmsTxtIs200(t *testing.T) {
	dir, _ := docsDir(t)
	s := newSite(t, dir)
	for _, path := range []string{"/llms.txt", "/llms-full.txt"} {
		_, body := get(t, s.srv.URL+path)
		seen := map[string]bool{}
		fetched, external := 0, 0
		for _, m := range reLink.FindAllStringSubmatch(body, -1) {
			link := m[2]
			if seen[link] {
				continue
			}
			seen[link] = true
			if !strings.HasPrefix(link, s.srv.URL) {
				external++
				ok := false
				for _, x := range docs.ExternalLinks {
					if link == x {
						ok = true
					}
				}
				if !ok {
					t.Errorf("%s: %q points off the site and is not in docs.ExternalLinks", path, link)
				}
				continue
			}
			url, frag, _ := strings.Cut(link, "#")
			resp, page := get(t, url)
			fetched++
			if resp.StatusCode != 200 {
				t.Errorf("%s: %s answered %d", path, link, resp.StatusCode)
				continue
			}
			if resp.Header.Get("Content-Type") == "" {
				t.Errorf("%s: %s has no content type", path, link)
			}
			if frag != "" && !hasAnchor(page, frag) {
				t.Errorf("%s: %s: no heading makes the anchor #%s", path, link, frag)
			}
		}
		if fetched < 12 || external != len(docs.ExternalLinks) {
			t.Errorf("%s: fetched %d site links and saw %d external (want >=12 and %d)", path, fetched, external, len(docs.ExternalLinks))
		}
	}
}

var reSlugStrip = regexp.MustCompile(`[^a-z0-9 _-]`)

func hasAnchor(md, frag string) bool {
	fence := false
	for _, l := range strings.Split(md, "\n") {
		if strings.HasPrefix(l, "```") {
			fence = !fence
		}
		if fence || !strings.HasPrefix(l, "#") {
			continue
		}
		h := strings.ToLower(strings.TrimSpace(strings.TrimLeft(l, "#")))
		if strings.ReplaceAll(reSlugStrip.ReplaceAllString(h, ""), " ", "-") == frag {
			return true
		}
	}
	return false
}

// llms.txt rendered for the production origin carries only production links: rewritten to a test server,
// every one of them still answers 200.
func TestLlmsTxtForTheProductionOrigin(t *testing.T) {
	dir, _ := docsDir(t)
	s := newSite(t, dir)
	const prod = "https://btw.bitwrap.io"
	mux := http.NewServeMux()
	if err := docs.Mount(mux, docs.Options{DocsDir: dir, Checker: fakecheck.Checker{}, Examples: s.set.List, ExampleText: s.set.Text, PublicURL: prod + "/"}); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("GET", "/llms.txt", nil))
	body := rec.Body.String()
	if rec.Code != 200 || strings.Contains(body, "127.0.0.1") || strings.Contains(body, "//btw.bitwrap.io//") {
		t.Fatalf("llms.txt for prod: %d\n%s", rec.Code, body)
	}
	n := 0
	for _, m := range reLink.FindAllStringSubmatch(body, -1) {
		link := m[2]
		if strings.HasPrefix(link, "https://btw.bitwrap.io") {
			n++
			url, _, _ := strings.Cut(strings.Replace(link, prod, s.srv.URL, 1), "#")
			if resp, _ := get(t, url); resp.StatusCode != 200 {
				t.Errorf("%s answered %d", link, resp.StatusCode)
			}
		}
	}
	if n < 12 {
		t.Errorf("only %d production links", n)
	}
}

func TestMountRefusesABadOrigin(t *testing.T) {
	for _, u := range []string{"", "btw.bitwrap.io", "ftp://x", "https://"} {
		if err := docs.Mount(http.NewServeMux(), docs.Options{PublicURL: u}); err == nil {
			t.Errorf("Mount accepted PublicURL %q", u)
		}
	}
}

// ---------- the five documents ----------

func TestDocumentsHaveTypesETagsAndConditionalGets(t *testing.T) {
	dir, _ := docsDir(t)
	s := newSite(t, dir)
	cases := []struct{ path, ctype string }{
		{"/llms.txt", "text/plain; charset=utf-8"},
		{"/llms-full.txt", "text/plain; charset=utf-8"},
		{"/docs/BTW.md", "text/markdown; charset=utf-8"},
		{"/docs/cheatsheet.md", "text/markdown; charset=utf-8"},
		{"/docs/api.md", "text/markdown; charset=utf-8"},
	}
	for _, c := range cases {
		resp, body := get(t, s.srv.URL+c.path)
		if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != c.ctype {
			t.Errorf("%s: %d %q, want 200 %q", c.path, resp.StatusCode, resp.Header.Get("Content-Type"), c.ctype)
			continue
		}
		etag := resp.Header.Get("ETag")
		if !regexp.MustCompile(`^"[0-9a-f]{16}"$`).MatchString(etag) {
			t.Errorf("%s: ETag %q", c.path, etag)
		}
		if resp.Header.Get("Cache-Control") == "" || resp.Header.Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s: cache/nosniff headers missing", c.path)
		}
		if len(body) < 100 {
			t.Errorf("%s: only %d bytes", c.path, len(body))
		}
		// a conditional get is a 304 with no body; a different tag is a 200
		r2, b2 := get(t, s.srv.URL+c.path, "If-None-Match", etag)
		if r2.StatusCode != 304 || b2 != "" {
			t.Errorf("%s: If-None-Match gave %d with %d bytes", c.path, r2.StatusCode, len(b2))
		}
		if r3, _ := get(t, s.srv.URL+c.path, "If-None-Match", `"0000000000000000"`); r3.StatusCode != 200 {
			t.Errorf("%s: a stale tag gave %d", c.path, r3.StatusCode)
		}
		// HEAD: headers, no body; other methods are refused
		head, _ := http.NewRequest("HEAD", s.srv.URL+c.path, nil)
		hr, err := http.DefaultClient.Do(head)
		if err != nil {
			t.Fatal(err)
		}
		hb, _ := io.ReadAll(hr.Body)
		hr.Body.Close()
		if hr.StatusCode != 200 || len(hb) != 0 || hr.Header.Get("ETag") != etag {
			t.Errorf("%s: HEAD gave %d, %d bytes, etag %q", c.path, hr.StatusCode, len(hb), hr.Header.Get("ETag"))
		}
		pr, err := http.Post(s.srv.URL+c.path, "text/plain", strings.NewReader("x"))
		if err != nil {
			t.Fatal(err)
		}
		pr.Body.Close()
		if pr.StatusCode != 405 || pr.Header.Get("Allow") == "" {
			t.Errorf("%s: POST gave %d", c.path, pr.StatusCode)
		}
	}
}

func TestApiDocCoversEveryRouteAndTool(t *testing.T) {
	dir, _ := docsDir(t)
	s := newSite(t, dir)
	_, md := get(t, s.srv.URL+"/docs/api.md")
	if strings.Contains(md, "https://btw.bitwrap.io") {
		t.Error("api.md still names the production origin when served under another")
	}
	for _, want := range []string{
		// routes of btwsite/DESIGN.md "HTTP API"
		"/healthz", "/api/info", "/api/examples", "/examples/<name>.btw", "/api/instruments", "/api/check", "/api/fmt", "/api/share", "/api/open",
		"/api/programs/<cid>", "/api/render/<cid>", "/api/session", "/api/session/<id>/events", "/api/session/<id>/report", "/api/session/<id>/reply",
		"/api/auth/challenge", "/api/auth/login", "/api/auth/logout", "/api/auth/me", "/api/auth/token", "/api/compose", "/mcp",
		"/c/<cid>", "/card/<cid>.png", "/llms.txt", "/llms-full.txt", "/docs/BTW.md", "/docs/cheatsheet.md", "/docs/api.md",
		// the flows
		"personal_sign", "btw_session", "Authorization: Bearer", "claude mcp add --transport http btw " + s.srv.URL + "/mcp --header 'Authorization: Bearer",
		"unrepairable", "retry_after", "X-Btw-Cache", "immutable", "private",
	} {
		if !strings.Contains(md, want) {
			t.Errorf("api.md does not mention %q", want)
		}
	}
	for _, tool := range []string{"compose", "check", "fmt", "eval", "load", "get", "share", "open", "render", "list_examples", "instruments", "stop"} {
		if !strings.Contains(md, "| `"+tool+"` |") {
			t.Errorf("api.md has no table row for the MCP tool %s", tool)
		}
	}
	// every error code of api.go is documented
	for _, code := range []string{api.CodeAuthRequired, api.CodeRateLimited, api.CodeSpendCap, api.CodeDisabled, api.CodeNotConfigured, api.CodeBadRequest,
		api.CodePromptTooLong, api.CodeModelError, api.CodeUnrepairable, api.CodeNotFound, api.CodeRestricted, api.CodeTooLarge, api.CodeBusy,
		api.CodeCIDMismatch, api.CodeNoSession, api.CodeBadSignature, api.CodeChallengeStale} {
		if !strings.Contains(md, "`"+code+"`") {
			t.Errorf("api.md does not document the error code %s", code)
		}
	}
}

// ---------- llms-full.txt, sections ----------

func TestLlmsFullInlinesCheatsheetGrammarAndAnExample(t *testing.T) {
	dir, isReal := docsDir(t)
	s := newSite(t, dir)
	_, short := get(t, s.srv.URL+"/llms.txt")
	_, full := get(t, s.srv.URL+"/llms-full.txt")
	if !strings.HasPrefix(full, short) {
		t.Error("llms-full.txt does not start with llms.txt")
	}
	cs, _ := os.ReadFile(filepath.Join(dir, "cheatsheet.md"))
	if !strings.Contains(full, strings.TrimSpace(string(cs))) {
		t.Error("llms-full.txt does not inline the cheat-sheet")
	}
	md, _ := os.ReadFile(filepath.Join(dir, "BTW.md"))
	grammar := docs.Section(string(md), "## Grammar (EBNF)")
	if grammar == "" || !strings.Contains(full, grammar) {
		t.Errorf("llms-full.txt does not inline the whole of `## Grammar (EBNF)` (%d bytes)", len(grammar))
	}
	if !strings.Contains(grammar, "```ebnf") || !strings.Contains(grammar, "### Grammar: the additions") {
		t.Error("the grammar section lacks its EBNF block or its additions")
	}
	if rules := docs.Section(string(md), "## The rules in one screen"); rules == "" || !strings.Contains(full, rules) {
		t.Error("llms-full.txt does not inline `## The rules in one screen`")
	}
	if !isReal && strings.Contains(full, "## Patterns: mini-notation") { // (the real cheat-sheet has its own copy of that heading)
		t.Error("llms-full.txt inlined more than the grammar sections")
	}
	// one example program, whole
	text, _ := s.set.Text("markers-demo")
	if !strings.Contains(full, "```btw\n"+strings.TrimRight(text, "\n")+"\n```") {
		t.Error("llms-full.txt does not inline the example program")
	}
	if isReal && !strings.Contains(full, "program     = { line } ;") {
		t.Error("the real grammar is not in llms-full.txt")
	}
}

func TestSection(t *testing.T) {
	md := "# T\n\nintro\n\n## A\nbody a\n```text\n## not a heading\n# nor this\n```\n### A.1\nsub\n## B\nbody b\n"
	if got, want := docs.Section(md, "## A"), "## A\nbody a\n```text\n## not a heading\n# nor this\n```\n### A.1\nsub"; got != want {
		t.Errorf("Section(## A) = %q, want %q", got, want)
	}
	if got := docs.Section(md, "### A.1"); got != "### A.1\nsub" {
		t.Errorf("Section(### A.1) = %q", got)
	}
	if got := docs.Section(md, "## B"); got != "## B\nbody b" {
		t.Errorf("Section(## B) = %q (the last section runs to the end)", got)
	}
	if got := docs.Section(md, "## C"); got != "" {
		t.Errorf("Section(## C) = %q, want empty", got)
	}
	if got := docs.Section(md, "## not a heading"); got != "" {
		t.Errorf("a line inside a fence matched: %q", got)
	}
}

// Without the generated files nothing breaks: the docs that are not installed are 404 and are not linked.
func TestMissingGeneratedFiles(t *testing.T) {
	set, _ := docs.LoadExampleSet(examplesDir(t), fakecheck.Checker{})
	empty := t.TempDir()

	mux := http.NewServeMux()
	if err := docs.Mount(mux, docs.Options{DocsDir: empty, Examples: set.List, ExampleText: set.Text, PublicURL: "https://btw.bitwrap.io"}); err != nil {
		t.Fatal(err)
	}
	do := func(m *http.ServeMux, path string) (int, string) {
		rec := httptest.NewRecorder()
		m.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		return rec.Code, rec.Body.String()
	}
	for _, p := range []string{"/docs/BTW.md", "/docs/cheatsheet.md"} {
		if code, _ := do(mux, p); code != 404 {
			t.Errorf("%s with nothing installed: %d, want 404", p, code)
		}
	}
	_, ll := do(mux, "/llms.txt")
	if strings.Contains(ll, "/docs/BTW.md") || strings.Contains(ll, "/docs/cheatsheet.md") {
		t.Error("llms.txt links documents that are not installed")
	}
	if !strings.Contains(ll, "/docs/api.md") || !strings.Contains(ll, "/examples/trance-138.btw") {
		t.Error("llms.txt lost the documents that are there")
	}
	if code, full := do(mux, "/llms-full.txt"); code != 200 || !strings.Contains(full, "```btw\n") || strings.Contains(full, "Cheat-sheet") {
		t.Errorf("llms-full.txt without the generated files: %d", code)
	}

	// the live checker's cheat-sheet stands in for a missing file
	mux2 := http.NewServeMux()
	if err := docs.Mount(mux2, docs.Options{DocsDir: empty, Checker: fakecheck.Checker{}, Examples: set.List, PublicURL: "https://btw.bitwrap.io"}); err != nil {
		t.Fatal(err)
	}
	code, cs := do(mux2, "/docs/cheatsheet.md")
	want, _ := fakecheck.Checker{}.Cheatsheet(context.Background())
	if code != 200 || cs != want {
		t.Errorf("cheatsheet from the checker: %d %q", code, cs)
	}
	if _, ll := do(mux2, "/llms.txt"); !strings.Contains(ll, "/docs/cheatsheet.md") {
		t.Error("llms.txt does not link the cheat-sheet the checker provides")
	}
	// no example text: llms-full.txt just has no example
	if code, full := do(mux2, "/llms-full.txt"); code != 200 || strings.Contains(full, "```btw") {
		t.Errorf("llms-full.txt without example text: %d", code)
	}
}

// ---------- generated files vs their sources ----------

// With BTWD_BIN set, the generated cheatsheet.md is what `btwd cheatsheet` prints now.
func TestCheatsheetMatchesAFreshBtwd(t *testing.T) {
	bin := os.Getenv("BTWD_BIN")
	if bin == "" {
		t.Skip("BTWD_BIN is not set")
	}
	gen := filepath.Join(repoRoot(t), "btwsite", "web", "docs", "cheatsheet.md")
	have, err := os.ReadFile(gen)
	if err != nil {
		t.Skipf("%s is not generated (scripts/btw-gen-docs.sh): %v", gen, err)
	}
	fresh, err := exec.Command(bin, "cheatsheet").Output()
	if err != nil {
		t.Fatalf("%s cheatsheet: %v", bin, err)
	}
	if string(fresh) != string(have) {
		t.Fatalf("btwsite/web/docs/cheatsheet.md is stale: it differs from `%s cheatsheet`. Run BTWD_BIN=%s scripts/btw-gen-docs.sh", bin, bin)
	}
	if len(fresh) < 500 {
		t.Errorf("the cheat-sheet is only %d bytes", len(fresh))
	}
}

// With BTW_MD_SRC (the docs/BTW.md of the djrust worktree) set, the generated BTW.md is a verbatim copy.
func TestBTWMdIsVerbatim(t *testing.T) {
	src := os.Getenv("BTW_MD_SRC")
	if src == "" {
		t.Skip("BTW_MD_SRC is not set")
	}
	gen := filepath.Join(repoRoot(t), "btwsite", "web", "docs", "BTW.md")
	a, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(gen)
	if err != nil {
		t.Skipf("%s is not generated: %v", gen, err)
	}
	if string(a) != string(b) {
		t.Fatalf("%s differs from %s: run scripts/btw-gen-docs.sh", gen, src)
	}
}

// The generator script, against a stand-in source tree and a fake btwd (no private files involved).
func TestGenDocsScript(t *testing.T) {
	root := repoRoot(t)
	script := filepath.Join(root, "scripts", "btw-gen-docs.sh")
	tmp := t.TempDir()
	src := filepath.Join(tmp, "djrust")
	out := filepath.Join(tmp, "out")
	if err := os.MkdirAll(filepath.Join(src, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	btwmd := "# btw\n\nstand-in\n\n```text\n# not a heading\n```\n"
	os.WriteFile(filepath.Join(src, "docs", "BTW.md"), []byte(btwmd), 0o644)
	fakeBtwd := filepath.Join(tmp, "btwd")
	os.WriteFile(fakeBtwd, []byte("#!/bin/sh\n[ \"$1\" = cheatsheet ] && printf '# cheat v1\\n'\n"), 0o755)

	run := func(env []string, args ...string) (string, error) {
		cmd := exec.Command("bash", append([]string{script}, args...)...)
		cmd.Env = append(os.Environ(), append([]string{"DJRUST_DIR=" + src, "OUT_DIR=" + out, "BTWD_BIN="}, env...)...)
		b, err := cmd.CombinedOutput()
		return string(b), err
	}
	read := func(name string) string { b, _ := os.ReadFile(filepath.Join(out, name)); return string(b) }

	// without BTWD_BIN: BTW.md is copied, no cheatsheet, a warning that says what happens instead
	msg, err := run(nil)
	if err != nil || read("BTW.md") != btwmd || !fileExists(filepath.Join(out, "BTW.md")) || fileExists(filepath.Join(out, "cheatsheet.md")) ||
		!strings.Contains(msg, "answer /docs/cheatsheet.md from btwd") {
		t.Fatalf("plain run: %v\n%s", err, msg)
	}
	// with it: the cheatsheet is btwd's output
	if msg, err = run([]string{"BTWD_BIN=" + fakeBtwd}); err != nil || read("cheatsheet.md") != "# cheat v1\n" {
		t.Fatalf("run with BTWD_BIN: %v\n%s", err, msg)
	}
	// --check passes while fresh, and fails when either is stale
	if msg, err = run([]string{"BTWD_BIN=" + fakeBtwd}, "--check"); err != nil {
		t.Fatalf("--check on fresh files: %v\n%s", err, msg)
	}
	os.WriteFile(filepath.Join(out, "cheatsheet.md"), []byte("# cheat v0\n"), 0o644)
	if msg, err = run([]string{"BTWD_BIN=" + fakeBtwd}, "--check"); err == nil || !strings.Contains(msg, "cheatsheet.md differs") {
		t.Fatalf("--check missed a stale cheatsheet: %v\n%s", err, msg)
	}
	// --check changes nothing
	if read("cheatsheet.md") != "# cheat v0\n" {
		t.Error("--check rewrote a file")
	}
	// a plain run keeps an existing cheatsheet when BTWD_BIN is not set
	if msg, err = run(nil); err != nil || read("cheatsheet.md") != "# cheat v0\n" || !strings.Contains(msg, "kept the existing cheatsheet.md") {
		t.Fatalf("keep: %v\n%s", err, msg)
	}
	os.WriteFile(filepath.Join(src, "docs", "BTW.md"), []byte(btwmd+"more\n"), 0o644)
	if _, err = run(nil, "--check"); err == nil {
		t.Error("--check missed a stale BTW.md")
	}
	// no source: a clear failure
	if msg, err = run([]string{"DJRUST_DIR=" + filepath.Join(tmp, "nowhere")}); err == nil || !strings.Contains(msg, "not found") {
		t.Errorf("missing source: %v\n%s", err, msg)
	}
	// the repo's own ignore rules cover what the script writes
	gi, _ := os.ReadFile(filepath.Join(root, ".gitignore"))
	for _, p := range []string{"/btwsite/web/docs/BTW.md", "/btwsite/web/docs/cheatsheet.md"} {
		if !strings.Contains(string(gi), p+"\n") {
			t.Errorf(".gitignore does not list %s", p)
		}
	}
}

// ---------- the examples ----------

var wantExamples = []string{"hand-dubstep-140-v4", "matrix-130", "trance-138", "hand-dubstep-140-v2", "markers-demo", "first-beat", "acid-line", "evolve-demo", "pattern-sugar"}

func TestExamplesAreThePublicCC0Programs(t *testing.T) {
	dir := examplesDir(t)
	list, err := docs.LoadExamples(dir, fakecheck.Checker{})
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	cids := map[string]string{}
	for _, e := range list {
		names = append(names, e.Name)
		if first, _, _ := strings.Cut(e.Description, ". "); len(first) > 150 {
			t.Errorf("%s: the first sentence of the description is %d characters; llms.txt cuts it at 150", e.Name, len(first))
		}
		if e.License != "CC0-1.0" || e.Title == "" || len(e.Description) < 40 || e.BPM < 40 || e.Bars < 1 {
			t.Errorf("%s: incomplete or not CC0: %+v", e.Name, e)
		}
		if !strings.HasPrefix(e.CID, "z") || len(e.CID) < 40 {
			t.Errorf("%s: CID %q was not filled in", e.Name, e.CID)
		}
		if other, dup := cids[e.CID]; dup {
			t.Errorf("%s and %s have the same CID", e.Name, other)
		}
		cids[e.CID] = e.Name
	}
	sort.Strings(names)
	want := append([]string(nil), wantExamples...)
	sort.Strings(want)
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Errorf("examples = %v, want %v", names, want)
	}

	// index.json and the .btw files are the same set, and each file is a public, header-carrying, CC0 program
	ents, _ := os.ReadDir(dir)
	var files []string
	for _, ent := range ents {
		if n, ok := strings.CutSuffix(ent.Name(), ".btw"); ok {
			files = append(files, n)
		}
	}
	sort.Strings(files)
	if strings.Join(files, ",") != strings.Join(want, ",") {
		t.Errorf("btwsite/examples/*.btw = %v, want %v", files, want)
	}
	reRestricted := regexp.MustCompile(`(?m)^\s*(use restricted|sample\s|loop\s+\S)`)
	for _, n := range files {
		b, _ := os.ReadFile(filepath.Join(dir, n+".btw"))
		text := string(b)
		for _, h := range []string{"#! btw 1\n", "#! name: " + n + "\n", "#! license: CC0-1.0\n", "#! visibility: public\n"} {
			if !strings.Contains(text, h) {
				t.Errorf("%s.btw lacks the header line %q", n, strings.TrimSpace(h))
			}
		}
		if reRestricted.MatchString(text) || strings.Contains(text, "visibility: private") {
			t.Errorf("%s.btw is not a public program", n)
		}
	}
}

func TestLoadExamplesRefusesBadOnes(t *testing.T) {
	write := func(dir, name, text string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	good := "tempo 120\ndeck A: kick x ~ x ~\n"
	cases := map[string]struct {
		index, file string
		want        string
	}{
		"does not check": {`[{"name":"bad"}]`, "tempo 120\nBAD\n", "bad does not check: 2:1"},
		"restricted":     {`[{"name":"priv"}]`, "tempo 120\nuse restricted\ndeck A: kick x\n", "priv uses samples or `use restricted`"},
		"uses a sample":  {`[{"name":"smp"}]`, "tempo 120\nsample harp from \"x\"\ndeck A: kick x\n", "smp uses samples"},
		"missing file":   {`[{"name":"ghost"}]`, "", "ghost.btw"},
		"bad name":       {`[{"name":"../etc"}]`, good, "not a usable example name"},
		"duplicate":      {`[{"name":"a"},{"name":"a"}]`, good, "listed twice"},
		"index not json": {`nope`, good, "index.json"},
	}
	for label, c := range cases {
		dir := t.TempDir()
		write(dir, "index.json", c.index)
		if c.file != "" {
			write(dir, "bad.btw", c.file)
			write(dir, "priv.btw", c.file)
			write(dir, "smp.btw", c.file)
			write(dir, "a.btw", c.file)
		}
		_, err := docs.LoadExamples(dir, fakecheck.Checker{})
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: error %v, want one containing %q", label, err, c.want)
		}
	}
	// no index.json at all
	if _, err := docs.LoadExamples(t.TempDir(), fakecheck.Checker{}); err == nil {
		t.Error("a directory without index.json loaded")
	}
	// a good one: the program's own tempo wins over a wrong index, defaults fill title and license
	dir := t.TempDir()
	write(dir, "index.json", `[{"name":"ok","bpm":99,"bars":5}]`)
	write(dir, "ok.btw", "tempo 120\nsection a 4 bars {\n  deck A: kick x ~ x ~\n}\n")
	list, err := docs.LoadExamples(dir, fakecheck.Checker{})
	if err != nil || len(list) != 1 || list[0].BPM != 120 || list[0].Bars != 4 || list[0].Title != "ok" || list[0].License != "CC0-1.0" || list[0].CID == "" {
		t.Errorf("good example: %+v, %v", list, err)
	}
}

func TestExamplesRoutes(t *testing.T) {
	dir, _ := docsDir(t)
	s := newSite(t, dir)
	resp, body := get(t, s.srv.URL+"/api/examples")
	var list []api.Example
	if resp.StatusCode != 200 || json.Unmarshal([]byte(body), &list) != nil || len(list) != len(wantExamples) {
		t.Fatalf("/api/examples: %d %.200s", resp.StatusCode, body)
	}
	if !strings.HasPrefix(resp.Header.Get("Content-Type"), "application/json") {
		t.Errorf("content type %q", resp.Header.Get("Content-Type"))
	}
	for _, e := range list {
		resp, text := get(t, s.srv.URL+"/examples/"+e.Name+".btw")
		onDisk, _ := os.ReadFile(filepath.Join(examplesDir(t), e.Name+".btw"))
		if resp.StatusCode != 200 || text != string(onDisk) || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/plain") {
			t.Errorf("/examples/%s.btw: %d, %d bytes", e.Name, resp.StatusCode, len(text))
		}
	}
	for _, bad := range []string{"/examples/nope.btw", "/examples/trance-138", "/examples/..%2Findex.json", "/examples/.btw"} {
		if resp, _ := get(t, s.srv.URL+bad); resp.StatusCode != 404 {
			t.Errorf("%s: %d, want 404", bad, resp.StatusCode)
		}
	}
}

// With BTWD_BIN set the examples check clean in the real checker, with the CIDs pinned in testdata.
func TestExamplesCheckWithTheRealBtwd(t *testing.T) {
	bin := os.Getenv("BTWD_BIN")
	if bin == "" {
		t.Skip("BTWD_BIN is not set")
	}
	raw, err := os.ReadFile(filepath.Join(repoRoot(t), "btwsite", "testdata", "docs", "example-cids.json"))
	if err != nil {
		t.Fatal(err)
	}
	var pinned map[string]string
	if err := json.Unmarshal(raw, &pinned); err != nil {
		t.Fatal(err)
	}
	set, err := docs.LoadExampleSet(examplesDir(t), realChecker{bin: bin})
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range set.List() {
		if pinned[e.Name] != e.CID {
			t.Errorf("%s: CID %s, pinned %s", e.Name, e.CID, pinned[e.Name])
		}
		text, _ := set.Text(e.Name)
		rep, _ := realChecker{bin: bin}.Check(context.Background(), text)
		switch e.Name {
		case "first-beat", "acid-line", "evolve-demo": // ours: no warnings
			if rep.Warnings != 0 {
				t.Errorf("%s: %d warnings: %+v", e.Name, rep.Warnings, rep.Diagnostics)
			}
		}
		if e.BPM < 40 || e.Bars < 1 {
			t.Errorf("%s: bpm %v bars %d", e.Name, e.BPM, e.Bars)
		}
	}
	if len(pinned) != len(set.List()) {
		t.Errorf("pinned %d CIDs for %d examples", len(pinned), len(set.List()))
	}
}

// realChecker is a Checker that runs `btwd check` (only Check is needed).
type realChecker struct {
	fakecheck.Checker
	bin string
}

func (r realChecker) Check(ctx context.Context, text string) (*api.CheckReport, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	cmd := exec.CommandContext(ctx, r.bin, "check", "-")
	cmd.Stdin = strings.NewReader(text)
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	var rep api.CheckReport
	if err := json.Unmarshal(out, &rep); err != nil {
		return nil, fmt.Errorf("btwd check: %w: %.200s", err, out)
	}
	return &rep, nil
}

// a checker that is down is asked once, then left alone for a while: llms.txt does not wait for it each time
type flakyChecker struct {
	fakecheck.Checker
	calls int
}

func (f *flakyChecker) Cheatsheet(context.Context) (string, error) {
	f.calls++
	return "", fmt.Errorf("btwd is down")
}

func TestADownCheckerIsNotAskedOnEveryRequest(t *testing.T) {
	fc := &flakyChecker{}
	mux := http.NewServeMux()
	if err := docs.Mount(mux, docs.Options{DocsDir: t.TempDir(), Checker: fc, PublicURL: "https://btw.bitwrap.io"}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		for _, p := range []string{"/llms.txt", "/docs/cheatsheet.md", "/llms-full.txt"} {
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, httptest.NewRequest("GET", p, nil))
			want := 200
			if p == "/docs/cheatsheet.md" {
				want = 404
			}
			if rec.Code != want {
				t.Fatalf("%s: %d, want %d", p, rec.Code, want)
			}
		}
	}
	if fc.calls != 1 {
		t.Errorf("the failing checker was asked %d times, want 1", fc.calls)
	}
}

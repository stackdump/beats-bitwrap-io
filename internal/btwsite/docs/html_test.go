package docs_test

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var htmlRoutes = []struct{ slug, raw, file string }{
	{"cheatsheet", "/docs/cheatsheet.md", "cheatsheet.md"},
	{"language", "/docs/BTW.md", "BTW.md"},
	{"api", "/docs/api.md", ""},
}

var (
	reHTag    = regexp.MustCompile(`<h([1-6])( id="([^"]*)")?>(<a class="anchor" href="#([^"]*)" aria-label="[^"]*">#</a>)?`)
	reTocLink = regexp.MustCompile(`<li class="l[23]"><a href="#([^"]*)">`)
	reMDHead  = regexp.MustCompile(`^#{1,6}\s+\S`)
)

// mdHeadings counts the headings of a markdown file, not counting "#" lines inside code fences.
func mdHeadings(md string) int {
	n, fence := 0, false
	for _, l := range strings.Split(md, "\n") {
		if strings.HasPrefix(l, "```") || strings.HasPrefix(l, "~~~") {
			fence = !fence
			continue
		}
		if !fence && reMDHead.MatchString(l) {
			n++
		}
	}
	return n
}

// TestHTMLPagesRenderWithAnchors: every doc renders, and every heading has an id and an anchor link to it.
func TestHTMLPagesRenderWithAnchors(t *testing.T) {
	dir, _ := docsDir(t)
	s := newSite(t, dir)
	for _, r := range htmlRoutes {
		t.Run(r.slug, func(t *testing.T) {
			resp, body := get(t, s.srv.URL+"/docs/"+r.slug)
			if resp.StatusCode != 200 {
				t.Fatalf("status %d", resp.StatusCode)
			}
			if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
				t.Errorf("Content-Type %q", ct)
			}
			_, rawBody := get(t, s.srv.URL+r.raw)
			want := mdHeadings(rawBody)
			if want == 0 {
				t.Fatalf("%s has no headings: nothing to check", r.raw)
			}
			tags := reHTag.FindAllStringSubmatch(body, -1)
			if len(tags) != want {
				t.Errorf("%d headings in %s, %d <hN> in the page", want, r.raw, len(tags))
			}
			seen := map[string]bool{}
			for _, m := range tags {
				id := m[3]
				if id == "" || m[5] != id {
					t.Errorf("heading without a matching id and anchor: %q", m[0])
				}
				if seen[id] {
					t.Errorf("duplicate heading id %q", id)
				}
				seen[id] = true
			}
			for _, m := range reTocLink.FindAllStringSubmatch(body, -1) {
				if !seen[m[1]] {
					t.Errorf("the contents link #%s points at no heading", m[1])
				}
			}
			// the page's own chrome
			for _, w := range []string{`<title>`, `BeatScript`, `href="/"`, `rel="stylesheet" href="/docs/assets/docs.css"`, `src="/docs/assets/docs.js"`,
				`<link rel="alternate" type="text/markdown" href="` + r.raw + `"`, `>View source</a>`} {
				if !strings.Contains(body, w) {
					t.Errorf("page lacks %q", w)
				}
			}
			if strings.Contains(body, "<h2") && !strings.Contains(body, `<nav class="toc"`) {
				t.Error("a page with sections has no table of contents")
			}
			// CSP-safe: no inline script, no inline handler, no style attribute
			if regexp.MustCompile(`<script(?:\s[^>]*)?>\s*[^<\s]`).MatchString(body) || regexp.MustCompile(`\son[a-z]+="`).MatchString(body) || strings.Contains(body, ` style="`) {
				t.Error("the page has inline script or style, which the site's CSP refuses")
			}
		})
	}
}

func TestHTMLIndexListsEveryDoc(t *testing.T) {
	dir, _ := docsDir(t)
	s := newSite(t, dir)
	resp, body := get(t, s.srv.URL+"/docs/")
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	for _, r := range htmlRoutes {
		if !strings.Contains(body, `href="/docs/`+r.slug+`"`) || !strings.Contains(body, `href="`+r.raw+`"`) {
			t.Errorf("index lacks %s or its raw file %s", r.slug, r.raw)
		}
	}
	if !strings.Contains(body, `href="/"`) {
		t.Error("index has no link back to the editor")
	}
	// the product name is BeatScript in the chrome
	if strings.Contains(body, "<title>btw") || !strings.Contains(body, "BeatScript") {
		t.Error("page chrome must say BeatScript")
	}
}

// TestRawMarkdownRoutesUnchanged: the .md files are what they were, as text/markdown, byte for byte the source.
func TestRawMarkdownRoutesUnchanged(t *testing.T) {
	dir, _ := docsDir(t)
	s := newSite(t, dir)
	for _, r := range htmlRoutes {
		resp, body := get(t, s.srv.URL+r.raw)
		if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/markdown") {
			t.Errorf("%s: status %d type %q", r.raw, resp.StatusCode, resp.Header.Get("Content-Type"))
		}
		if r.file != "" {
			src, err := os.ReadFile(filepath.Join(dir, r.file))
			if err != nil {
				t.Fatal(err)
			}
			if body != string(src) {
				t.Errorf("%s is not the file's bytes any more", r.raw)
			}
		}
	}
}

func TestHTMLConditionalGet(t *testing.T) {
	dir, _ := docsDir(t)
	s := newSite(t, dir)
	resp, _ := get(t, s.srv.URL+"/docs/cheatsheet")
	etag := resp.Header.Get("ETag")
	if etag == "" {
		t.Fatal("no ETag")
	}
	resp2, body := get(t, s.srv.URL+"/docs/cheatsheet", "If-None-Match", etag)
	if resp2.StatusCode != 304 || body != "" {
		t.Errorf("conditional GET: status %d, %d bytes", resp2.StatusCode, len(body))
	}
}

// TestDocsCSSVariablesMatchTheEditor: the docs stylesheet repeats the editor's variables (a page of its own
// cannot load btw.css, which locks the body to the viewport); this fails when one drifts.
func TestDocsCSSVariablesMatchTheEditor(t *testing.T) {
	root := repoRoot(t)
	editor, err := os.ReadFile(filepath.Join(root, "btwsite", "web", "css", "btw.css"))
	if err != nil {
		t.Fatal(err)
	}
	mine, err := os.ReadFile(filepath.Join(root, "internal", "btwsite", "docs", "assets", "docs.css"))
	if err != nil {
		t.Fatal(err)
	}
	re := regexp.MustCompile(`(?m)^\s*(--[a-z0-9-]+):\s*([^;]+);`)
	ed := map[string]string{}
	for _, m := range re.FindAllStringSubmatch(string(editor), -1) {
		if _, dup := ed[m[1]]; !dup {
			ed[m[1]] = strings.TrimSpace(m[2])
		}
	}
	n := 0
	for _, m := range re.FindAllStringSubmatch(string(mine), -1) {
		n++
		if want, ok := ed[m[1]]; !ok || want != strings.TrimSpace(m[2]) {
			t.Errorf("docs.css %s: %q, the editor has %q", m[1], strings.TrimSpace(m[2]), want)
		}
	}
	if n < 10 {
		t.Errorf("only %d variables found in docs.css", n)
	}
}

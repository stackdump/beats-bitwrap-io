package docs

import (
	"strings"
	"testing"
)

func TestRenderEscapesRawHTMLAndBadLinks(t *testing.T) {
	src := "# T\n\n<script>alert(1)</script>\n\ntext <img src=x onerror=alert(2)> more\n\n[bad](javascript:alert(3)) [ok](https://example.com/a)\n\n`<b>`\n"
	r, err := renderMarkdown([]byte(src))
	if err != nil {
		t.Fatal(err)
	}
	b := string(r.Body)
	for _, bad := range []string{"<script", "<img", "onerror=", "javascript:"} {
		if strings.Contains(b, bad) {
			t.Errorf("rendered output contains %q:\n%s", bad, b)
		}
	}
	if !strings.Contains(b, `href="https://example.com/a"`) {
		t.Error("an https link was lost")
	}
	if !strings.Contains(b, "&lt;b&gt;") {
		t.Error("inline code is not escaped")
	}
}

func TestRenderCodeBlocksAndTables(t *testing.T) {
	src := "# T\n\n## Same\n\n## Same\n\n```btw\ntempo 120 # <hi>\ndeck A: kick x ~ x ~\n```\n\n```text\nkick x ~ x ~\n```\n\n```text\ntoy tempo 120\ntoy deck A: kick x\n```\n\n```json\n{\"a\": 1}\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nSee [the cheat sheet](https://btw.bitwrap.io/docs/cheatsheet.md#x) and [the API](/docs/api.md).\n"
	r, err := renderMarkdown([]byte(src))
	if err != nil {
		t.Fatal(err)
	}
	b := string(r.Body)
	if n := strings.Count(b, `data-try="1"`); n != 2 { // the btw block and the whole-program text block, not the fragment or the JSON
		t.Errorf("%d Try-it blocks, want 2:\n%s", n, b)
	}
	if strings.Count(b, `class="cp"`) != 4 {
		t.Error("every code block needs a Copy button")
	}
	if !strings.Contains(b, "# &lt;hi&gt;") {
		t.Error("code text is not escaped")
	}
	if !strings.Contains(b, "<table>") {
		t.Error("table not rendered")
	}
	if !strings.Contains(b, `href="/docs/cheatsheet#x"`) || !strings.Contains(b, `href="/docs/api"`) {
		t.Errorf("links to the raw docs are not pointed at the pages:\n%s", b)
	}
	if !strings.Contains(b, `id="same"`) || !strings.Contains(b, `id="same-1"`) {
		t.Error("duplicate headings need distinct ids")
	}
	if r.Title != "T" || len(r.TOC) != 2 {
		t.Errorf("title %q, toc %v", r.Title, r.TOC)
	}
}

func TestRenderedPagesAreCachedByHash(t *testing.T) {
	s := &server{public: "https://x.test", apiBytes: []byte("# API\n\n## One\n")}
	p := pages[2]
	a, ok, err := s.renderPage(p)
	if !ok || err != nil {
		t.Fatal(ok, err)
	}
	b, _, _ := s.renderPage(p)
	if &a.body[0] != &b.body[0] {
		t.Error("an unchanged source was rendered again")
	}
	s.apiBytes = []byte("# API\n\n## Two\n")
	c, _, _ := s.renderPage(p)
	if string(c.body) == string(a.body) || c.etag == a.etag {
		t.Error("a changed source was served from the cache")
	}
}

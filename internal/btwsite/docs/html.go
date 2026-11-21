package docs

// The HTML form of the docs: /docs/ (index), /docs/cheatsheet, /docs/language, /docs/api.
//
// Why server-side Go (goldmark, github.com/yuin/goldmark, MIT, no dependencies of its own): the pages read
// without JavaScript, crawlers and `curl` see the whole text, and the table of contents, heading anchors and
// code-block markup come out of the same pass that parses the markdown. The client script (assets/docs.js) only
// adds what needs a browser: the highlighter (the editor's own wasm), copy buttons and "Try it".
//
// The raw .md routes in docs.go are untouched and every HTML page links to its raw file. Raw HTML inside a
// markdown file is not rendered (goldmark without WithUnsafe replaces it with a comment), and link destinations
// with javascript:, vbscript: and file: schemes are dropped by goldmark. The page itself carries no inline
// script or style, so the site-wide Content-Security-Policy (server.securityHeaders) applies unchanged.

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"fmt"
	"html"
	"html/template"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/renderer"
	htmlr "github.com/yuin/goldmark/renderer/html"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

//go:embed assets/docs.css
var docsCSS []byte

//go:embed assets/docs.js
var docsJS []byte

// page is one HTML document of the docs.
type page struct {
	Slug  string // /docs/<slug>
	Raw   string // the raw markdown route, /docs/<file>
	Title string // user-facing
	Blurb string
	// get is the markdown source; ok is false when the document is not installed.
	get func(*server) ([]byte, bool)
}

var pages = []page{
	{"cheatsheet", "/docs/cheatsheet.md", "Cheat sheet", "The language on one page: the compact grammar, the same text the compose prompt uses. Read this first.",
		func(s *server) ([]byte, bool) { return s.cheatsheet() }},
	{"language", "/docs/BTW.md", "Language reference", "Grammar (EBNF), mini-notation, control lines, evolve, canonical form and share links.",
		func(s *server) ([]byte, bool) { return s.readDoc("BTW.md") }},
	{"api", "/docs/api.md", "API reference", "Every HTTP route, sign-in and tokens, compose, render streaming, sessions and the MCP tools, with examples.",
		func(s *server) ([]byte, bool) { return s.apiBytes, true }},
}

type tocItem struct {
	Level int
	ID    string
	Text  string
}

type rendered struct {
	Body  template.HTML
	TOC   []tocItem
	Title string // the first h1, else the page's own title
}

// htmlCache keeps rendered pages by the hash of their source and origin: a changed file renders again, an
// unchanged one never does.
type htmlCache struct {
	mu sync.Mutex
	m  map[string]cached
}

type cached struct {
	key  string
	body []byte
	etag string
}

func (c *htmlCache) get(slug, key string) (cached, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[slug]
	return e, ok && e.key == key
}

func (c *htmlCache) put(slug string, e cached) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.m == nil {
		c.m = map[string]cached{}
	}
	c.m[slug] = e
}

// ---------- markdown -> HTML ----------

var (
	reDocLink = regexp.MustCompile(`^(?:https?://[^/#?]+)?/docs/(BTW|cheatsheet|api)\.md(#[^\s]*)?$`)
	// a block of text that is a whole program (not a fragment): a deck line or a tempo line
	reProgram = regexp.MustCompile(`(?m)^\s*(?:[^\s#]+\s+)?(?:deck\s+[A-Za-z0-9_]+\s*:|tempo\s+\d)`)
)

var slugOfFile = map[string]string{"BTW": "language", "cheatsheet": "cheatsheet", "api": "api"}

// isBTW is whether a code block is BeatScript (highlighted by the editor's highlighter) and whether it is a
// whole program (gets "Try it").
func isBTW(lang, code string) (highlight, try bool) {
	switch strings.ToLower(lang) {
	case "btw", "beatscript":
		return true, true
	case "", "text", "txt":
		p := reProgram.MatchString(code)
		return p, p
	}
	return false, false
}

type blockRenderer struct{}

func (blockRenderer) RegisterFuncs(r renderer.NodeRendererFuncRegisterer) {
	r.Register(ast.KindHeading, renderHeading)
	r.Register(ast.KindFencedCodeBlock, renderCode)
	r.Register(ast.KindCodeBlock, renderCode)
}

func renderHeading(w util.BufWriter, src []byte, n ast.Node, entering bool) (ast.WalkStatus, error) {
	h := n.(*ast.Heading)
	if entering {
		_, _ = fmt.Fprintf(w, "<h%d", h.Level)
		id, ok := n.AttributeString("id")
		if ok {
			_, _ = fmt.Fprintf(w, ` id="%s"`, util.EscapeHTML(attrBytes(id)))
		}
		_ = w.WriteByte('>')
		if ok {
			_, _ = fmt.Fprintf(w, `<a class="anchor" href="#%s" aria-label="Link to this section">#</a>`, util.EscapeHTML(attrBytes(id)))
		}
	} else {
		_, _ = fmt.Fprintf(w, "</h%d>\n", h.Level)
	}
	return ast.WalkContinue, nil
}

func attrBytes(v any) []byte {
	switch x := v.(type) {
	case []byte:
		return x
	case string:
		return []byte(x)
	}
	return nil
}

func renderCode(w util.BufWriter, src []byte, n ast.Node, entering bool) (ast.WalkStatus, error) {
	if !entering {
		return ast.WalkContinue, nil
	}
	var lang string
	var lines *text.Segments
	switch c := n.(type) {
	case *ast.FencedCodeBlock:
		lang = string(c.Language(src))
		lines = c.Lines()
	case *ast.CodeBlock:
		lines = c.Lines()
	}
	var code bytes.Buffer
	for i := 0; i < lines.Len(); i++ {
		seg := lines.At(i)
		code.Write(seg.Value(src))
	}
	hl, try := isBTW(lang, code.String())
	label := lang
	if hl && (lang == "" || strings.EqualFold(lang, "btw") || strings.EqualFold(lang, "text") || strings.EqualFold(lang, "txt") || strings.EqualFold(lang, "beatscript")) {
		label = "BeatScript"
	}
	attrs := ""
	if hl {
		attrs += ` data-btw="1"`
	}
	if try {
		attrs += ` data-try="1"`
	}
	cls := ""
	if lang != "" {
		cls = fmt.Sprintf(` class="language-%s"`, html.EscapeString(lang))
	}
	_, _ = fmt.Fprintf(w, `<figure class="code"%s><figcaption><span class="lang">%s</span><span class="acts"><button type="button" class="cp" hidden>Copy</button>`,
		attrs, html.EscapeString(label))
	if try {
		_, _ = w.WriteString(`<button type="button" class="try" hidden>Try it</button>`)
	}
	_, _ = fmt.Fprintf(w, `</span></figcaption><pre><code%s>%s</code></pre></figure>`+"\n", cls, util.EscapeHTML(code.Bytes()))
	return ast.WalkSkipChildren, nil
}

var md = goldmark.New(
	goldmark.WithExtensions(extension.Table, extension.Strikethrough),
	goldmark.WithParserOptions(parser.WithAutoHeadingID()),
	goldmark.WithRendererOptions(
		htmlr.WithHardWraps(), // the docs break lines on purpose; a soft newline is a break, as in the raw text
		renderer.WithNodeRenderers(util.Prioritized(blockRenderer{}, 100)),
	),
)

// renderMarkdown turns markdown into the body HTML, the table of contents (h2 and h3) and the title.
func renderMarkdown(src []byte) (rendered, error) {
	doc := md.Parser().Parse(text.NewReader(src))
	var out rendered
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		switch v := n.(type) {
		case *ast.Heading:
			t := strings.TrimSpace(string(v.Text(src)))
			id, _ := v.AttributeString("id")
			if v.Level == 1 && out.Title == "" {
				out.Title = t
			}
			if v.Level == 2 || v.Level == 3 {
				out.TOC = append(out.TOC, tocItem{v.Level, string(attrBytes(id)), t})
			}
		case *ast.Link:
			if m := reDocLink.FindSubmatch(v.Destination); m != nil {
				v.Destination = []byte("/docs/" + slugOfFile[string(m[1])] + string(m[2]))
			}
		}
		return ast.WalkContinue, nil
	})
	var buf bytes.Buffer
	if err := md.Renderer().Render(&buf, src, doc); err != nil {
		return rendered{}, err
	}
	out.Body = template.HTML(buf.String()) //nolint:gosec // goldmark output without WithUnsafe: raw HTML is already dropped
	return out, nil
}

// ---------- the page shell ----------

var shell = template.Must(template.New("page").Parse(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#16213e">
<meta name="color-scheme" content="dark">
<title>{{.Title}} · BeatScript docs</title>
<meta name="description" content="{{.Blurb}}">
<link rel="canonical" href="{{.Canonical}}">
{{if .Raw}}<link rel="alternate" type="text/markdown" href="{{.Raw}}" title="{{.Title}} (markdown)">
{{end}}<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="stylesheet" href="/docs/assets/docs.css">
</head>
<body>
<a class="skip" href="#main">Skip to the content</a>
<header class="top">
  <a class="brand" href="/" aria-label="BeatScript editor"><span class="brand-mark" aria-hidden="true"></span><span class="brand-name">BeatScript</span></a>
  <nav class="crumbs" aria-label="Docs">
    <a href="/docs/"{{if eq .Slug ""}} aria-current="page"{{end}}>Docs</a>
    {{range .Nav}}<a href="/docs/{{.Slug}}"{{if eq .Slug $.Slug}} aria-current="page"{{end}}>{{.Title}}</a>
    {{end}}
  </nav>
  <span class="spacer"></span>
  <a class="tb" href="/" title="Back to the editor"><span class="gl-ic" aria-hidden="true">←</span><span class="lbl">Editor</span></a>
</header>
<div class="layout">
{{if .TOC}}<nav class="toc" aria-label="On this page"><p class="toc-title">On this page</p>
<ul>
{{range .TOC}}<li class="l{{.Level}}"><a href="#{{.ID}}">{{.Text}}</a></li>
{{end}}</ul>
</nav>
{{end}}<main id="main" class="doc">
{{.Body}}
{{if .Raw}}<p class="src"><a href="{{.Raw}}" rel="alternate" type="text/markdown">View source</a> (the raw markdown of this page, for models and scripts)</p>{{end}}
</main>
</div>
<script type="module" src="/docs/assets/docs.js"></script>
</body>
</html>
`))

type shellData struct {
	Title, Blurb, Canonical, Raw, Slug string
	Nav                                []page
	TOC                                []tocItem
	Body                               template.HTML
}

// installedPages are the pages whose markdown exists on this server.
func (s *server) installedPages() []page {
	var out []page
	for _, p := range pages {
		if _, ok := p.get(s); ok {
			out = append(out, p)
		}
	}
	return out
}

func (s *server) renderPage(p page) (cached, bool, error) {
	src, ok := p.get(s)
	if !ok {
		return cached{}, false, nil
	}
	h := sha256.Sum256(append([]byte(p.Slug+"\x00"+s.public+"\x00"), src...))
	key := hex.EncodeToString(h[:])
	if c, ok := s.cache.get(p.Slug, key); ok {
		return c, true, nil
	}
	r, err := renderMarkdown(src)
	if err != nil {
		return cached{}, true, err
	}
	title := p.Title
	var buf bytes.Buffer
	d := shellData{Title: title, Blurb: p.Blurb, Canonical: s.public + "/docs/" + p.Slug, Raw: p.Raw, Slug: p.Slug, Nav: s.installedPages(), TOC: r.TOC, Body: r.Body}
	if err := shell.Execute(&buf, d); err != nil {
		return cached{}, true, err
	}
	c := cached{key: key, body: buf.Bytes(), etag: `"` + key[:16] + `"`}
	s.cache.put(p.Slug, c)
	return c, true, nil
}

func (s *server) renderIndex() []byte {
	var b strings.Builder
	b.WriteString("<h1>BeatScript docs</h1>\n<p>BeatScript is a small, total, deterministic language for writing whole music tracks as text. These are the pages that teach it. Every page has a raw markdown file for models and scripts.</p>\n<ul class=\"cards\">\n")
	for _, p := range s.installedPages() {
		fmt.Fprintf(&b, "<li><a href=\"/docs/%s\"><strong>%s</strong></a><span>%s</span> <a class=\"raw\" href=\"%s\">markdown</a></li>\n",
			p.Slug, html.EscapeString(p.Title), html.EscapeString(p.Blurb), p.Raw)
	}
	b.WriteString("</ul>\n<h2 id=\"more\"><a class=\"anchor\" href=\"#more\" aria-label=\"Link to this section\">#</a>More</h2>\n<ul>\n")
	b.WriteString("<li><a href=\"/api/instruments\">Instruments</a>: the voices a program may name (JSON)</li>\n")
	b.WriteString("<li><a href=\"/api/examples\">Examples</a>: the public example programs (JSON); open one from the editor's examples menu</li>\n")
	b.WriteString("<li><a href=\"/llms.txt\">llms.txt</a>: this site, indexed for a language model</li>\n")
	b.WriteString("<li><a href=\"/\">The editor</a></li>\n</ul>\n")
	var buf bytes.Buffer
	_ = shell.Execute(&buf, shellData{Title: "Docs", Blurb: "BeatScript docs: the cheat sheet, the language reference and the API reference.", Canonical: s.public + "/docs/",
		Slug: "", Nav: s.installedPages(), Body: template.HTML(b.String())}) //nolint:gosec // built above from escaped parts
	return buf.Bytes()
}

// ---------- handlers ----------

func (s *server) mountHTML(mux *http.ServeMux) {
	const htmlType = "text/html; charset=utf-8"
	// "/docs/{$}" is exactly the index: other paths under /docs/ (generated files the static site serves) are not taken.
	mux.Handle("/docs/{$}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.serveHTML(w, r, htmlType, s.renderIndex())
	}))
	for _, p := range pages {
		p := p
		mux.Handle("/docs/"+p.Slug, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !methodOK(w, r) {
				return
			}
			c, ok, err := s.renderPage(p)
			if !ok {
				http.Error(w, "this document is not installed on this server", http.StatusNotFound)
				return
			}
			if err != nil {
				http.Error(w, "could not render this document", http.StatusInternalServerError)
				return
			}
			writeCached(w, r, htmlType, c.body, c.etag)
		}))
	}
	mux.Handle("/docs/assets/docs.css", s.serve("text/css; charset=utf-8", func() ([]byte, bool) { return docsCSS, true }))
	mux.Handle("/docs/assets/docs.js", s.serve("text/javascript; charset=utf-8", func() ([]byte, bool) { return docsJS, true }))
}

func methodOK(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return false
	}
	return true
}

func (s *server) serveHTML(w http.ResponseWriter, r *http.Request, ct string, body []byte) {
	if !methodOK(w, r) {
		return
	}
	sum := sha256.Sum256(body)
	writeCached(w, r, ct, body, `"`+hex.EncodeToString(sum[:8])+`"`)
}

func writeCached(w http.ResponseWriter, r *http.Request, ct string, body []byte, etag string) {
	h := w.Header()
	h.Set("ETag", etag)
	h.Set("Content-Type", ct)
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, "", zeroTime, bytes.NewReader(body))
}

var zeroTime time.Time

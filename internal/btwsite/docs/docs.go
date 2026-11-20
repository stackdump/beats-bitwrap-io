// Package docs serves what a model (or a person) reads to learn btw.bitwrap.io: /llms.txt, /llms-full.txt,
// /docs/BTW.md, /docs/cheatsheet.md and /docs/api.md (btwsite/DESIGN.md "docs and llms.txt"), and loads the
// public example programs.
//
// Where each text comes from:
//
//   - /docs/BTW.md       DocsDir/BTW.md, a verbatim copy of docs/BTW.md of the private djrust repo, made by
//     scripts/btw-gen-docs.sh. It is built into the working tree and deployed, never committed (the repo is public).
//   - /docs/cheatsheet.md DocsDir/cheatsheet.md, the output of `btwd cheatsheet` (the text the compose
//     prompt uses), made by the same script; if the file is absent the live Checker.Cheatsheet answers.
//   - /docs/api.md       api.md in this package (hand-written, embedded), with the site's origin filled in.
//   - /llms.txt          built from PublicURL and the example list; a doc that is not installed is left out
//     of its Docs section, so every link in it answers 200.
//   - /llms-full.txt     llms.txt plus the cheat-sheet, the grammar sections of BTW.md and one example program,
//     built at request time. Without the generated files it is llms.txt plus whatever of them exists
//     (at the minimum llms.txt and the example): it never fails because a generated file is missing.
//
// Mount registers exact paths only (no "/docs/" subtree, no "/examples/"), so it cannot collide with the
// static file server's "/" or with the routes the server package owns. MountExamples is the optional
// handler pair for /api/examples and /examples/<name>.btw for a server that wants them from here.
package docs

import (
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
)

//go:embed api.md
var apiMD string

// Options is what Mount needs.
type Options struct {
	// DocsDir holds the generated BTW.md and cheatsheet.md (btwsite/web/docs). Either may be absent.
	DocsDir string
	// Checker is the fallback source of the cheat-sheet (Checker.Cheatsheet) when DocsDir has none. May be nil.
	Checker api.Checker
	// Examples lists the public example programs (name, title, description, cid, ...). May be nil.
	Examples func() []api.Example
	// ExampleText returns the text of one example. May be nil (llms-full.txt then has no example).
	ExampleText func(name string) (string, bool)
	// PublicURL is the site's origin, e.g. https://btw.bitwrap.io. Required.
	PublicURL string
	// FullExample names the program llms-full.txt inlines. Default "markers-demo", else the first example.
	FullExample string
}

// ExternalLinks are the links of llms.txt that point off the site (the link test does not fetch them).
var ExternalLinks = []string{
	"https://blog.stackdump.com/posts/generator-you-can-read",
	"https://ontology.bitwrap.io",
}

type server struct {
	o      Options
	public string

	mu       sync.Mutex
	csCache  string
	csAt     time.Time // when csCache was fetched
	csFailAt time.Time // when the checker last failed: not asked again for a while
	apiBytes []byte
}

// Mount registers the docs routes on mux.
func Mount(mux *http.ServeMux, o Options) error {
	if mux == nil {
		return fmt.Errorf("docs.Mount: nil mux")
	}
	u, err := url.Parse(o.PublicURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("docs.Mount: PublicURL %q is not an http(s) origin", o.PublicURL)
	}
	s := &server{o: o, public: strings.TrimRight(o.PublicURL, "/")}
	s.apiBytes = []byte(strings.ReplaceAll(apiMD, "https://btw.bitwrap.io", s.public))

	const txt, md = "text/plain; charset=utf-8", "text/markdown; charset=utf-8"
	mux.Handle("/llms.txt", s.serve(txt, func() ([]byte, bool) { return []byte(s.llmsTxt()), true }))
	mux.Handle("/llms-full.txt", s.serve(txt, func() ([]byte, bool) { return []byte(s.llmsFull()), true }))
	mux.Handle("/docs/BTW.md", s.serve(md, func() ([]byte, bool) { return s.readDoc("BTW.md") }))
	mux.Handle("/docs/cheatsheet.md", s.serve(md, func() ([]byte, bool) { return s.cheatsheet() }))
	mux.Handle("/docs/api.md", s.serve(md, func() ([]byte, bool) { return s.apiBytes, true }))
	return nil
}

// serve answers GET and HEAD with ETag validation; body returns (nil, false) for "not installed".
func (s *server) serve(contentType string, body func() ([]byte, bool)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		b, ok := body()
		if !ok {
			http.Error(w, "this document is not installed on this server", http.StatusNotFound)
			return
		}
		writeBody(w, r, contentType, b)
	})
}

func writeBody(w http.ResponseWriter, r *http.Request, contentType string, b []byte) {
	sum := sha256.Sum256(b)
	h := w.Header()
	h.Set("ETag", `"`+hex.EncodeToString(sum[:8])+`"`)
	h.Set("Content-Type", contentType)
	h.Set("Cache-Control", "no-cache") // revalidate: a deploy shows at once, an unchanged file is a 304
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Access-Control-Allow-Origin", "*")
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(b)) // If-None-Match, Range, HEAD
}

// ---------- the generated documents ----------

func (s *server) readDoc(name string) ([]byte, bool) {
	if s.o.DocsDir == "" {
		return nil, false
	}
	b, err := os.ReadFile(filepath.Join(s.o.DocsDir, name))
	if err != nil || len(bytes.TrimSpace(b)) == 0 {
		return nil, false
	}
	return b, true
}

// cheatsheet is DocsDir/cheatsheet.md, else the live Checker's (cached ten minutes).
func (s *server) cheatsheet() ([]byte, bool) {
	if b, ok := s.readDoc("cheatsheet.md"); ok {
		return b, true
	}
	if s.o.Checker == nil {
		return nil, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.csCache != "" && time.Since(s.csAt) < 10*time.Minute {
		return []byte(s.csCache), true
	}
	if !s.csFailAt.IsZero() && time.Since(s.csFailAt) < 30*time.Second {
		return nil, false // a checker that is down must not make every llms.txt request wait for it
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cs, err := s.o.Checker.Cheatsheet(ctx)
	if err != nil || strings.TrimSpace(cs) == "" {
		s.csFailAt = time.Now()
		return nil, false
	}
	s.csFailAt = time.Time{}
	s.csCache, s.csAt = cs, time.Now()
	return []byte(cs), true
}

// ---------- llms.txt ----------

func (s *server) examples() []api.Example {
	if s.o.Examples == nil {
		return nil
	}
	return s.o.Examples()
}

// firstSentence is the part of a description up to its first ". " (at most 150 characters).
func firstSentence(d string) string {
	d = strings.TrimSpace(strings.ReplaceAll(d, "\n", " "))
	if i := strings.Index(d, ". "); i > 0 {
		d = d[:i+1]
	}
	if r := []rune(d); len(r) > 150 {
		d = strings.TrimRight(string(r[:147]), " ,;:") + "..."
	}
	return d
}

func (s *server) llmsTxt() string {
	p := s.public
	var b strings.Builder
	w := func(format string, a ...any) { fmt.Fprintf(&b, format, a...) }

	w("# btw\n\n")
	w("> btw (bitwrap) is a small, total, deterministic language for writing whole music tracks as text. Programs compile to Petri nets, play in the browser and in the djrust desktop app, and are content-addressed: the same canonical text always has the same CID. Programs are CC0 by default and remixable by fork.\n\n")
	w("Key facts:\n")
	w("- Everything generated here is public: programs, share links, cards and rendered audio are stored publicly under CC0-1.0, and a compose prompt goes to a third-party model. Never put anything private in a prompt. Terms: %s/privacy.\n", p)
	w("- One line per deck (`deck A: kick x ~ x ~ | snare ~ x ~ x`), parts joined with `|`, 16 steps a bar. Mini-notation: `x` hit, `~` rest, `[..]` group, `<..>` per-bar alternation, `c2!` accent, `e2^` slide, `chord(am)`, `e(5,8)` euclid.\n")
	w("- Structure: `let`, `def` (no recursion), `repeat N`, `section NAME N bars { ... }`, `arrange`, `end after`, `loop`.\n")
	w("- Control lines: ramps `a -> b over N bars`, `at bar N:`, `every N bars:`, `before <section> N bars:`, `do <noun> <verb>`. Seeded transforms (`rotate`, `transpose`, `degrade`, `humanize`); `evolve every N bars { ... }` with a reported tail and period.\n")
	w("- Only instruments from %s/api/instruments. Always run check (the MCP tool, or POST %s/api/check) and fix every line:column error before playing: a program with an error is refused whole.\n", p, p)
	w("- Share link: %s/#<CID>.<base64url(deflate(canonical text))>. The CID is of the canonical text, so formatting and comments never change it.\n\n", p)

	w("## Docs\n")
	if _, ok := s.readDoc("BTW.md"); ok {
		w("- [BTW.md](%s/docs/BTW.md): the language reference: grammar (EBNF), mini-notation, control lines, evolve, canonical form, share links\n", p)
	}
	if _, ok := s.cheatsheet(); ok {
		w("- [cheatsheet.md](%s/docs/cheatsheet.md): the compact grammar, the same text the compose prompt uses; read this first\n", p)
	}
	w("- [Instruments](%s/api/instruments): the voices, families, drum kits and palettes a program may name (JSON)\n", p)
	w("- [API reference](%s/docs/api.md): every HTTP route, sign-in and tokens, compose, render streaming, sessions, the MCP tools with examples\n", p)
	w("- [llms-full.txt](%s/llms-full.txt): this file with the cheat-sheet, the grammar and an example program inlined\n\n", p)

	w("## Examples\n")
	for _, e := range s.examples() {
		note := firstSentence(e.Description)
		var facts []string
		if e.License != "" {
			facts = append(facts, e.License)
		}
		if e.BPM > 0 {
			facts = append(facts, fmt.Sprintf("%g BPM", e.BPM))
		}
		if e.Bars > 0 {
			facts = append(facts, fmt.Sprintf("%d bars", e.Bars))
		}
		if len(facts) > 0 {
			note += " (" + strings.Join(facts, ", ") + ")"
		}
		w("- [%s](%s/examples/%s.btw): %s\n", e.Name, p, e.Name, note)
	}
	w("- [All examples as JSON](%s/api/examples): name, title, description, cid, bpm, bars, license\n\n", p)

	w("## API\n")
	w("- [MCP server](%s/mcp): streamable HTTP; tools compose, check, fmt, eval, load, get, share, open, render, record, list_examples, instruments, stop, devices, queue (an up-next list that never composes); writes need a bearer token\n", p)
	w("- [Compose](%s/docs/api.md#compose): POST %s/api/compose writes a program from a prompt (signed in, rate limited, capped)\n", p, p)
	w("- [Render](%s/docs/api.md#render): GET %s/api/render/<CID>?format=opus|wav streams the offline render as it renders\n", p, p)
	w("- [Linked data](%s/docs/api.md#linked-data-json-ld): the versioned JSON-LD @context (%s/context/v1.jsonld) and a program's JSON-LD document (%s/c/<CID>.jsonld)\n", p, p, p)
	w("- [Share links](%s/docs/api.md#share-links): the link format, and how to open one safely\n", p)
	w("- [Sign-in and tokens](%s/docs/api.md#sign-in-and-tokens): wallet or browser-key challenge, cookie, bearer tokens for MCP\n\n", p)

	w("## Optional\n")
	w("- [Generator you can read](%s): the post behind the language: a generator whose output is text you can read and edit\n", ExternalLinks[0])
	w("- [Ontology](%s): the bitwrap music-genre ontology (genres, scales, grooves, instruments) as linked data\n", ExternalLinks[1])
	return b.String()
}

// ---------- llms-full.txt ----------

// sections of BTW.md that make up "the grammar" (each runs to the next heading of its own level, so
// the ### subsections of "Grammar (EBNF)" come with it).
var grammarSections = []string{"## The rules in one screen", "## Grammar (EBNF)"}

func (s *server) llmsFull() string {
	p := s.public
	var b strings.Builder
	b.WriteString(s.llmsTxt())

	if cs, ok := s.cheatsheet(); ok {
		fmt.Fprintf(&b, "\n---\n\nCheat-sheet (also at %s/docs/cheatsheet.md):\n\n%s\n", p, strings.TrimSpace(string(cs)))
	}
	if md, ok := s.readDoc("BTW.md"); ok {
		var parts []string
		for _, h := range grammarSections {
			if sec := Section(string(md), h); sec != "" {
				parts = append(parts, sec)
			}
		}
		if len(parts) > 0 {
			fmt.Fprintf(&b, "\n---\n\nGrammar, from the language reference (%s/docs/BTW.md):\n\n%s\n", p, strings.Join(parts, "\n\n"))
		}
	}
	if name, text, ok := s.fullExample(); ok {
		fmt.Fprintf(&b, "\n---\n\nExample program %q (CC0-1.0, %s/examples/%s.btw):\n\n```btw\n%s\n```\n", name, p, name, strings.TrimRight(text, "\n"))
	}
	return b.String()
}

func (s *server) fullExample() (name, text string, ok bool) {
	if s.o.ExampleText == nil {
		return "", "", false
	}
	want := s.o.FullExample
	if want == "" {
		want = "markers-demo"
	}
	if t, found := s.o.ExampleText(want); found {
		return want, t, true
	}
	for _, e := range s.examples() {
		if t, found := s.o.ExampleText(e.Name); found {
			return e.Name, t, true
		}
	}
	return "", "", false
}

var reHeading = regexp.MustCompile(`^(#{1,6})\s`)

// Section returns the markdown from the line equal to heading up to (not including) the next heading of
// the same or a higher level, ignoring "#" lines inside code fences. "" when heading is not there.
func Section(md, heading string) string {
	m := reHeading.FindStringSubmatch(heading + " ")
	if m == nil {
		return ""
	}
	level := len(m[1])
	lines := strings.Split(md, "\n")
	fence := false
	start := -1
	for i, l := range lines {
		if strings.HasPrefix(l, "```") {
			fence = !fence
			continue
		}
		if fence {
			continue
		}
		if start < 0 {
			if strings.TrimRight(l, " \t") == heading {
				start = i
			}
			continue
		}
		if hm := reHeading.FindStringSubmatch(l); hm != nil && len(hm[1]) <= level {
			return strings.TrimRight(strings.Join(lines[start:i], "\n"), "\n")
		}
	}
	if start < 0 {
		return ""
	}
	return strings.TrimRight(strings.Join(lines[start:], "\n"), "\n")
}

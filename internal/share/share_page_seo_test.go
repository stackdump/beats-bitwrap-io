package share

import (
	"bytes"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStripDefaultSEORemovesOnlyTheMarkedBlock(t *testing.T) {
	doc := []byte("<head><title>x</title>\n<!-- default seo -->\n<meta name=\"description\" content=\"d\"/>\n<!-- /default seo -->\n<link rel=\"stylesheet\" href=\"a.css\"/></head>")
	got := stripDefaultSEO(doc)
	if bytes.Contains(got, []byte("description")) || !bytes.Contains(got, []byte("a.css")) || !bytes.Contains(got, []byte("<title>x</title>")) {
		t.Fatalf("got %q", got)
	}
	if plain := []byte("<head></head>"); !bytes.Equal(stripDefaultSEO(plain), plain) {
		t.Fatal("unmarked document must be untouched")
	}
}

// The three author-identity lines every HTML page this site serves carries,
// byte-identical across the sibling properties (pflow.xyz, book, sim, cdn,
// blog) so the rel="me" identity chain and <meta name="author"> agree.
var authorIdentityLines = []string{
	`<meta name="author" content="Matt York">`,
	`<link rel="me" href="https://github.com/stackdump">`,
	`<link rel="me" href="https://blog.stackdump.com/">`,
}

// assertAuthorIdentity fails unless doc carries each author-identity line
// exactly once, inside <head>, in the canonical order.
func assertAuthorIdentity(t *testing.T, name, doc string) {
	t.Helper()
	headEnd := strings.Index(doc, "</head>")
	if headEnd < 0 {
		t.Errorf("%s: no </head>", name)
		return
	}
	prev := -1
	for _, line := range authorIdentityLines {
		if n := strings.Count(doc, line); n != 1 {
			t.Errorf("%s: %q appears %d times, want exactly 1", name, line, n)
			continue
		}
		at := strings.Index(doc, line)
		if at > headEnd {
			t.Errorf("%s: %q is outside <head>", name, line)
		}
		if at < prev {
			t.Errorf("%s: %q is out of order", name, line)
		}
		prev = at
	}
}

// Every static page under public/ is embedded into the binary and served, so
// every one needs the author-identity lines. A new page that forgets them
// fails here instead of shipping without an author.
func TestAuthorIdentityOnEveryStaticPage(t *testing.T) {
	pub := filepath.Join(repoRoot(t), "public")
	pages := 0
	err := filepath.WalkDir(pub, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".html") {
			return err
		}
		pages++
		rel, _ := filepath.Rel(pub, path)
		assertAuthorIdentity(t, rel, readFile(t, path))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if pages == 0 {
		t.Fatalf("no .html pages found under %s", pub)
	}
}

// The studio shell is served three ways: plain, decorated as a share card
// (which strips the shell's "default seo" block and injects its own head),
// and plain again when the CID is unknown. All three must carry the lines
// exactly once, so the card template and the shell cannot drift apart.
func TestAuthorIdentityOnShellAndShareCard(t *testing.T) {
	store, _ := newTestStore(t)
	cid := computeCid([]byte(fixturePayload))
	if err := store.SealDirect(cid, []byte(fixturePayload)); err != nil {
		t.Fatalf("SealDirect: %v", err)
	}
	unknown := computeCid([]byte("not in the store"))
	h := DecoratedIndex(store, os.DirFS(filepath.Join(repoRoot(t), "public")), "")

	for _, tc := range []struct{ name, target, marker string }{
		{"shell", "/", ""},
		{"share card", "/?cid=" + cid, `content="music.song"`},
		{"unknown cid", "/?cid=" + unknown, ""},
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tc.target, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d", tc.name, rec.Code)
		}
		body := rec.Body.String()
		if tc.marker != "" && !strings.Contains(body, tc.marker) {
			t.Fatalf("%s: response is not the decorated share card", tc.name)
		}
		assertAuthorIdentity(t, tc.name, body)
	}
}

// The /schema/* glossary pages are HTML rendered from a Go template.
func TestAuthorIdentityOnSchemaGlossaries(t *testing.T) {
	for name, h := range map[string]http.HandlerFunc{
		"beats-share":          HandleBeatsShareSchema,
		"snapshot-manifest":    HandleSnapshotManifestSchema,
		"beats-audio-analysis": HandleBeatsAudioAnalysisSchema,
		"beats-composition":    HandleBeatsCompositionSchema,
	} {
		req := httptest.NewRequest(http.MethodGet, "/schema/"+name, nil)
		req.Header.Set("Accept", "text/html")
		rec := httptest.NewRecorder()
		h(rec, req)
		if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
			t.Fatalf("%s: content-type %q, want text/html", name, ct)
		}
		assertAuthorIdentity(t, name, rec.Body.String())
	}
}

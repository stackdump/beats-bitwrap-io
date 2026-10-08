package mcp

import (
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
)

// The public MCP server (mounted at /mcp on production beats.bitwrap.io) must
// expose only stateless generate/read tools — never sequencer control or
// rebuild/archive tools. This guards that security property against accidental
// additions to NewPublicServer.
func TestPublicServerToolset(t *testing.T) {
	tools := NewPublicServer().ListTools()

	got := make([]string, 0, len(tools))
	for name := range tools {
		got = append(got, name)
	}
	sort.Strings(got)

	want := []string{"generate_share", "get_render_status", "get_song", "list_genres"}
	if len(got) != len(want) {
		t.Fatalf("public tool set = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("public tool set = %v, want %v", got, want)
		}
	}

	forbidden := []string{
		"transport", "set_tempo", "mute_track", "set_instrument",
		"generate", "load_project", "get_project", "shuffle_instruments",
		"get_midi_routing", "rebuild_mark", "rebuild_clear", "rebuild_queue",
		"archive_lookup", "archive_missing", "collection_status",
	}
	for _, f := range forbidden {
		if _, ok := tools[f]; ok {
			t.Errorf("control/admin tool %q must NOT be exposed in the public MCP set", f)
		}
	}
}

// The full server (stdio + authoring HTTP) keeps the control tools and also
// gains generate_share.
func TestFullServerHasControlAndShare(t *testing.T) {
	tools := NewServer().ListTools()
	for _, name := range []string{"transport", "generate", "generate_share", "list_genres"} {
		if _, ok := tools[name]; !ok {
			t.Errorf("full server missing expected tool %q", name)
		}
	}
}

// The browser landing page at GET /mcp is served HTML like any other page on
// the site, so it carries the same author-identity lines as the static pages
// (see internal/share/share_page_seo_test.go).
func TestLandingPageAuthorIdentity(t *testing.T) {
	rec := httptest.NewRecorder()
	landingPageHandler(NewPublicServer())(rec, httptest.NewRequest(http.MethodGet, "/mcp", nil))
	body := rec.Body.String()
	headEnd := strings.Index(body, "</head>")
	if headEnd < 0 {
		t.Fatal("landing page has no </head>")
	}
	for _, line := range []string{
		`<meta name="author" content="Matt York">`,
		`<link rel="me" href="https://github.com/stackdump">`,
		`<link rel="me" href="https://blog.stackdump.com/">`,
	} {
		if n := strings.Count(body, line); n != 1 {
			t.Errorf("%q appears %d times, want exactly 1", line, n)
		} else if strings.Index(body, line) > headEnd {
			t.Errorf("%q is outside <head>", line)
		}
	}
}

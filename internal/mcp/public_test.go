package mcp

import (
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"beats-bitwrap-io/internal/generator"

	"github.com/mark3labs/mcp-go/mcp"
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

	want := []string{"generate_share", "get_btw", "get_render_status", "get_song", "list_genres"}
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

func TestGenerateToolsShareGenreAndStructureLists(t *testing.T) {
	for _, tool := range []mcp.Tool{generateTool(), generateShareTool()} {
		props := tool.InputSchema.Properties
		g, _ := props["genre"].(map[string]any)["description"].(string)
		st, _ := props["structure"].(map[string]any)["description"].(string)
		for name := range generator.Genres {
			if !strings.Contains(g, name) {
				t.Errorf("%s genre description missing %q", tool.Name, name)
			}
		}
		for _, name := range structureNames {
			if !strings.Contains(st, name) {
				t.Errorf("%s structure description missing %q", tool.Name, name)
			}
		}
	}
}

// get_btw opens a link made by the language itself (djctl btw share), and refuses a forged one.
func TestGetBtwVerifiesAndRefuses(t *testing.T) {
	const link = "https://beats.bitwrap.io/p#z4EBG9jD5z7Kk3J1PeAG7PmE1hTNikEv1rNXWTdpYux1EDAEmMR.5VJRasMwDP3PKR7kZ_sYxDSMErZAd41RRhbbSYgdBzuMBkrPPs0ubrqUXqAY9J6kJwlbnoQeDVieJb2YIXXCRd1jV6DvCA84rc4ydoQbKivuaoKu7dpquspd48HjEd-Vc3j7lMxHz9Ck7OKcwL1bk9kjKGOqTiNjUentvkQ3uOndCuFEuOVHAS2U4TMN9CW5n7U5d5CBNJtLlOZFIU_zODRfVS-Vj9Wy_Nt2ZbUZ6F3r1lj-JPUz_rM6XbPmBuNLVia6cpOwBWSnCKFG5FmGlxJsmxExPxTc0i-yLhHEZ7BX79GqKQdlzPhljVIwA3ZBzoL8Fw"
	call := func(l string) string {
		req := mcp.CallToolRequest{}
		req.Params.Arguments = map[string]any{"link": l}
		res, err := handleGetBtw(nil, req)
		if err != nil || res == nil || len(res.Content) == 0 {
			t.Fatalf("no result: %v", err)
		}
		return res.Content[0].(mcp.TextContent).Text
	}
	out := call(link)
	if !strings.Contains(out, `"verified": true`) || !strings.Contains(out, "tempo 140") || !strings.Contains(out, `"computed_cid"`) {
		t.Fatalf("a real link did not verify:\n%s", out)
	}
	forged := strings.Replace(link, "z4EBG9jD5z7K", "z4EBG9jD5z7J", 1)
	out = call(forged)
	if strings.Contains(out, "tempo 140") || !strings.Contains(out, `"verified": false`) || !strings.Contains(out, "REFUSED") {
		t.Fatalf("a forged link was handed back:\n%s", out)
	}
}

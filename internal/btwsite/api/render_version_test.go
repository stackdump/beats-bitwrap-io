package api

import (
	"os"
	"regexp"
	"testing"
)

// The page builds its own render URLs (web/js/api.js RENDER_VERSION): it must name the same render version as the server,
// or a browser keeps serving itself a render the server no longer makes (renders are cached immutable for a year).
func TestRenderVersionMatchesThePage(t *testing.T) {
	b, err := os.ReadFile("../../../btwsite/web/js/api.js")
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`export const RENDER_VERSION = '([^']+)'`).FindSubmatch(b)
	if m == nil {
		t.Fatal("api.js has no RENDER_VERSION")
	}
	if string(m[1]) != RenderVersion {
		t.Fatalf("api.js RENDER_VERSION %q, api.RenderVersion %q: bump both", m[1], RenderVersion)
	}
}

package mcpsrv_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"beats-bitwrap-io/internal/btwsite/mcpsrv"
)

// The engine builds share links on its default origin; the share tool answers with the site's own, as the web's
// share does, so a site moved to another origin (beatscript.app) never hands out the old one.
func TestShareLinksUseTheSitesOrigin(t *testing.T) {
	const site = "https://beatscript.app"
	b := newBackend()
	h := mcpsrv.Handler(b, newAuth(), site)
	mux := http.NewServeMux()
	mux.Handle("/mcp", h)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	e := &env{t: t, b: b, srv: srv}

	body := e.call("", "share", map[string]any{"text": goodProgram}).body(t)
	cid, _ := body["cid"].(string)
	if cid == "" {
		t.Fatalf("share answered no cid: %v", body)
	}
	if u, _ := body["url"].(string); !strings.HasPrefix(u, site+"/#"+cid+".") {
		t.Errorf("url = %q, want %s/#%s.<packed>", u, site, cid)
	}
	social, _ := body["social_url"].(string)
	if !strings.HasPrefix(social, site+"/c/"+cid+".") || strings.Contains(social, "~") {
		t.Errorf("social_url = %q, want %s/c/%s.<packed> without notes", social, site, cid)
	}
	if j, _ := body["jsonld_url"].(string); j != social+".jsonld" {
		t.Errorf("jsonld_url = %q, want %q", j, social+".jsonld")
	}
	for k, v := range body {
		if s, ok := v.(string); ok && strings.Contains(s, "btw.bitwrap.io") {
			t.Errorf("%s still names btw.bitwrap.io: %q", k, s)
		}
	}
}

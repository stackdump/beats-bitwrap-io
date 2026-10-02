package staticcache

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func serve(t *testing.T, h http.Handler, path string, hdr map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestHeaders(t *testing.T) {
	fsys := fstest.MapFS{
		"index.html":             {Data: []byte("<html>v2</html>")},
		"petri-note.js":          {Data: []byte("export const v = 2;")},
		"wave-engine/bench.html": {Data: []byte("<html>bench</html>")},
		"lib/a.js":               {Data: []byte("a")},
	}
	h := Wrap(fsys, http.FileServer(http.FS(fsys)))

	// (Go's FileServer strips Cache-Control from error responses, so a
	// 404 for a missing path carries none — fine, nothing to restore.)
	if rec := serve(t, h, "/nope", nil); rec.Code != 404 || rec.Header().Get("ETag") != "" {
		t.Errorf("/nope: %d %v", rec.Code, rec.Header())
	}
	for _, p := range []string{"/", "/wave-engine/bench.html"} {
		rec := serve(t, h, p, nil)
		if got := rec.Header().Get("Cache-Control"); got != "no-store" {
			t.Errorf("%s: Cache-Control = %q, want no-store", p, got)
		}
		if rec.Header().Get("ETag") != "" {
			t.Errorf("%s: documents carry no ETag", p)
		}
	}

	rec := serve(t, h, "/petri-note.js", nil)
	tag := rec.Header().Get("ETag")
	if rec.Code != 200 || rec.Header().Get("Cache-Control") != "no-cache" || len(tag) < 10 {
		t.Fatalf("js: %d %v", rec.Code, rec.Header())
	}
	// Revalidation with the current tag is a 304 with no body.
	rec = serve(t, h, "/petri-note.js", map[string]string{"If-None-Match": tag})
	if rec.Code != http.StatusNotModified || rec.Body.Len() != 0 {
		t.Fatalf("revalidate = %d (%d bytes)", rec.Code, rec.Body.Len())
	}
	// A stale tag gets the new bytes.
	rec = serve(t, h, "/petri-note.js", map[string]string{"If-None-Match": `"old"`})
	if rec.Code != 200 || rec.Body.String() != "export const v = 2;" {
		t.Fatalf("stale tag = %d %q", rec.Code, rec.Body.String())
	}
	// Different content, different tag.
	if t2 := serve(t, h, "/lib/a.js", nil).Header().Get("ETag"); t2 == tag || t2 == "" {
		t.Fatalf("lib/a.js tag %q vs %q", t2, tag)
	}
}

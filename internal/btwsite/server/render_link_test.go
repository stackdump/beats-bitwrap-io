package server

import (
	"io"
	"strings"
	"testing"

	"beats-bitwrap-io/internal/btwsite/api"
)

// sealed is the <cid>.<packed> part of text's share link.
func (e *tenv) sealed(text string) string {
	e.t.Helper()
	var out struct{ URL string }
	if st := decode(e.t, e.post("/api/share", map[string]any{"text": text}), &out); st != 200 {
		e.t.Fatalf("share: %d", st)
	}
	_, frag, ok := strings.Cut(out.URL, "#")
	if !ok || !strings.Contains(frag, ".") {
		e.t.Fatalf("share url: %s", out.URL)
	}
	return frag
}

// GET /api/render/<cid>.<packed>: the program travels in the URL; nothing was stored before.
func TestRenderFromLink(t *testing.T) {
	e := newEnv(t, nil)
	fresh := "tempo 133\ndeck A: kick x ~ ~ x ~ ~ x ~\nsection intro 2 bars\n" // not an example, not stored
	link := e.sealed(fresh)
	cid, _, _ := strings.Cut(link, ".")
	if _, ok := e.srv.Get(cid); ok {
		t.Fatal("stored before the render")
	}
	resp := e.get("/api/render/"+link+"?format=wav", ip("192.0.2.9"))
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("X-Btw-Cid") != cid || len(body) < 44 || string(body[:4]) != "RIFF" {
		t.Fatalf("render from link: %d cid=%q %d bytes", resp.StatusCode, resp.Header.Get("X-Btw-Cid"), len(body))
	}
	if _, ok := e.srv.Get(cid); !ok {
		t.Fatal("the program was not stored")
	}
	// the bare CID now works too
	if r := e.get("/api/render/"+cid+"?format=wav", ip("192.0.2.9")); r.StatusCode != 200 {
		t.Fatalf("bare cid after: %d", r.StatusCode)
	} else {
		r.Body.Close()
	}

	// a CID that does not name the packed text is refused, and nothing is stored
	other := e.sealed(progB)
	_, packedB, _ := strings.Cut(other, ".")
	cidC, _, _ := strings.Cut(e.sealed("tempo 77\ndeck A: kick x ~ ~ ~\nsection intro 2 bars\n"), ".")
	if st, code := errCode(t, e.get("/api/render/"+cidC+"."+packedB+"?format=wav", ip("192.0.2.9"))); st != 422 || code != api.CodeCIDMismatch {
		t.Fatalf("mismatch: %d %s", st, code)
	}
	if _, ok := e.srv.Get(cidC); ok {
		t.Fatal("a mismatched link was stored")
	}
	// garbage after the dot
	if st, _ := errCode(t, e.get("/api/render/"+cidC+".!!!?format=wav", ip("192.0.2.9"))); st != 422 && st != 400 {
		t.Fatalf("garbage packed: %d", st)
	}
}

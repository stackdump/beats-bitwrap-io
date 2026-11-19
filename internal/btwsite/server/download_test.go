package server

import (
	"encoding/binary"
	"strings"
	"testing"

	"beats-bitwrap-io/internal/btwsite/api"
)

// ?download=1 hands the render over as a file: an attachment named after the program, a WAV with the real sizes in
// its header (not the stream's "unknown length"), and the same bar limit as the player's stream.
func TestRenderDownload(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.RenderMaxBars = 3 })
	cid := e.put("#! name: My Song!\ntempo 97\ndeck A: kick x ~ ~ x\nsection a 2 bars\n")

	for _, round := range []string{"cold", "cached"} {
		r := e.get("/api/render/" + cid + "?format=wav&download=1")
		if r.StatusCode != 200 {
			t.Fatalf("%s: %d %s", round, r.StatusCode, readAll(t, r))
		}
		cd := r.Header.Get("Content-Disposition")
		if want := `attachment; filename=my-song-` + cid[:12] + `.wav`; cd != want {
			t.Fatalf("%s: Content-Disposition %q, want %q", round, cd, want)
		}
		b := readAll(t, r)
		if len(b) <= 44 || string(b[:4]) != "RIFF" {
			t.Fatalf("%s: not a WAV (%d bytes)", round, len(b))
		}
		if riff, data := binary.LittleEndian.Uint32(b[4:]), binary.LittleEndian.Uint32(b[40:]); int(riff) != len(b)-8 || int(data) != len(b)-44 {
			t.Fatalf("%s: header sizes %d/%d for %d bytes (a stream header is 0xFFFFFFFF)", round, riff, data, len(b))
		}
		if cl := r.Header.Get("Content-Length"); round == "cached" && cl == "" {
			t.Fatalf("cached: no Content-Length")
		}
	}

	// the player's own request stays inline
	if r := e.get("/api/render/" + cid + "?format=wav"); !strings.HasPrefix(r.Header.Get("Content-Disposition"), "inline;") {
		t.Fatalf("inline: %q", r.Header.Get("Content-Disposition"))
	} else {
		readAll(t, r)
	}

	// over the limit: refused before anything renders, with the reason
	bigText := "tempo 120\ndeck A: kick x\nsection a 8 bars\n"
	var big api.CheckReport
	decode(t, e.post("/api/check", map[string]string{"text": bigText}), &big)
	e.do("PUT", "/api/programs/"+big.CID, strings.NewReader(bigText)).Body.Close()
	if st, code := errCode(t, e.get("/api/render/"+big.CID+"?format=wav&download=1")); st != 422 || code != api.CodeTooLarge {
		t.Fatalf("too many bars: %d %s", st, code)
	}
}

func TestFileSlug(t *testing.T) {
	for in, want := range map[string]string{"trance-138": "trance-138", "My Song!": "my-song", "  ": "", "ÄÖ x": "x", `a"b/c`: "a-b-c"} {
		if got := fileSlug(in); got != want {
			t.Errorf("fileSlug(%q) = %q, want %q", in, got, want)
		}
	}
}

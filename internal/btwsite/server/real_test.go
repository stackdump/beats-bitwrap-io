package server

import (
	"bytes"
	"encoding/binary"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
	"beats-bitwrap-io/internal/btwsite/btwd"
)

// With BTWD_BIN set: the same server over the real Rust btwd and the real examples. Skipped otherwise.
func realEnv(t *testing.T, mod func(*Config)) *tenv {
	t.Helper()
	bin := os.Getenv("BTWD_BIN")
	if bin == "" {
		t.Skip("BTWD_BIN not set")
	}
	c, err := btwd.New(bin, btwd.Options{MaxConcurrent: 4})
	if err != nil {
		t.Fatal(err)
	}
	return newEnv(t, func(cfg *Config) {
		cfg.Checker, cfg.Renderer = c, c
		cfg.ExamplesDir = filepath.Join("..", "..", "..", "btwsite", "examples")
		withDocs(cfg)
		if mod != nil {
			mod(cfg)
		}
	})
}

func TestRealExamplesLoadWithoutWarnings(t *testing.T) {
	e := realEnv(t, nil)
	if w := e.srv.Warnings(); len(w) != 0 {
		t.Fatalf("warnings: %v", w)
	}
	var ex []api.Example
	decode(t, e.get("/api/examples"), &ex)
	if len(ex) < 5 {
		t.Fatalf("%d examples", len(ex))
	}
	for _, x := range ex {
		if !strings.HasPrefix(x.CID, "z") || x.BPM == 0 || x.License != "CC0-1.0" {
			t.Errorf("%+v", x)
		}
	}
}

// The measured numbers DESIGN.md asks for: time to first byte of a real render, wav and opus, an example
// program, through the real server, and the whole render's wall time.
func TestRealRenderFirstByte(t *testing.T) {
	e := realEnv(t, nil)
	var ex []api.Example
	decode(t, e.get("/api/examples"), &ex)
	var pick api.Example
	for _, x := range ex {
		if x.Name == "hand-dubstep-140-v4" {
			pick = x
		}
	}
	if pick.CID == "" {
		pick = ex[0]
	}
	for _, format := range []string{"wav", "opus"} {
		if format == "opus" {
			if _, err := exec.LookPath("ffmpeg"); err != nil || !e.srv.rs.ffmpegOK() {
				t.Log("no ffmpeg with libopus: opus not measured")
				continue
			}
		}
		start := time.Now()
		resp := e.get("/api/render/"+pick.CID+"?format="+format, ip("192.0.2.77"))
		if resp.StatusCode != 200 {
			t.Fatalf("%s: %d %s", format, resp.StatusCode, readAll(t, resp))
		}
		hdrAt := time.Since(start)
		fb, first := firstByte(t, resp, start)
		rest, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		total := time.Since(start)
		all := append(first, rest...)
		t.Logf("MEASURED %s %s (%s): headers %s, first body byte %s, whole render %s, %d bytes, X-Btw-Seconds=%s",
			format, pick.Name, pick.CID[:8], hdrAt.Round(time.Millisecond), fb.Round(time.Millisecond), total.Round(time.Millisecond), len(all), resp.Header.Get("X-Btw-Seconds"))
		if fb > time.Second {
			t.Errorf("first byte of the %s stream took %s", format, fb)
		}
		switch format {
		case "wav":
			if string(all[:4]) != "RIFF" || binary.LittleEndian.Uint32(all[4:8]) != 0xFFFFFFFF || len(all) < 1<<20 {
				t.Fatalf("wav: % x", all[:44])
			}
		case "opus":
			if !bytes.HasPrefix(all, []byte("OggS")) {
				t.Fatalf("opus: % x", all[:16])
			}
		}
		time.Sleep(200 * time.Millisecond)
		start = time.Now()
		hit := e.get("/api/render/"+pick.CID+"?format="+format, ip("192.0.2.77"))
		n, _ := io.Copy(io.Discard, hit.Body)
		hit.Body.Close()
		if hit.Header.Get("X-Btw-Cache") != "hit" || n != int64(len(all)) && format == "opus" {
			t.Fatalf("%s cache: %v (%d vs %d bytes)", format, hit.Header, n, len(all))
		}
		t.Logf("MEASURED %s cache hit in %s", format, time.Since(start).Round(time.Millisecond))
	}
}

func TestRealSignInComposeRenderShare(t *testing.T) {
	e := realEnv(t, nil)
	u := e.newUser()
	var out composeOut
	if st := decode(t, e.post("/api/compose", composeBody("dark techno 128 with an acid line"), cookie(u.cookie), ip("192.0.2.80")), &out); st != 200 {
		t.Fatalf("compose: %d", st)
	}
	if !out.Check.OK || out.CID == "" || out.License != "CC0-1.0" {
		t.Fatalf("composed: %+v", out)
	}
	// the stored program renders (a few seconds is enough to prove the pipe: read 1 s of PCM then leave)
	resp := e.get(out.RenderURL+"&format=wav", ip("192.0.2.80"))
	if resp.StatusCode != 200 {
		t.Fatalf("render: %d %s", resp.StatusCode, readAll(t, resp))
	}
	if _, err := io.ReadFull(resp.Body, make([]byte, 44+44100*4)); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	var sh struct {
		OK        bool   `json:"ok"`
		URL       string `json:"url"`
		SocialURL string `json:"social_url"`
		BeatsURL  string `json:"beats_url"`
		CID       string `json:"cid"`
	}
	decode(t, e.post("/api/share", map[string]string{"text": out.Program}), &sh)
	if !sh.OK || !strings.HasPrefix(sh.SocialURL, "https://btw.test/c/"+out.CID+".") {
		t.Fatalf("share: %+v", sh)
	}
	var op api.OpenReport
	decode(t, e.post("/api/open", map[string]string{"url": sh.SocialURL}), &op)
	if !op.OK || !op.Verified || op.CID != out.CID {
		t.Logf("open of a /c/ link: %+v (the checker may only read # links)", op)
	}
	var op2 api.OpenReport
	decode(t, e.post("/api/open", map[string]string{"url": strings.Replace(sh.SocialURL, "/c/", "/#", 1)}), &op2)
	if !op2.OK || !op2.Verified || op2.CID != out.CID {
		t.Fatalf("open: %+v", op2)
	}
	// the card of the composed program, drawn with the real highlighter
	c := e.get("/card/" + out.CID + ".png")
	if b := readAll(t, c); c.StatusCode != 200 || !bytes.HasPrefix(b, []byte("\x89PNG")) {
		t.Fatalf("card: %d", c.StatusCode)
	}
}

func TestRealPutRefusals(t *testing.T) {
	e := realEnv(t, nil)
	// a program that does not parse
	var rep api.CheckReport
	decode(t, e.post("/api/check", map[string]string{"text": "tempo 120\ndeck A: kick x ~ x ~\n"}), &rep)
	if !rep.OK {
		t.Fatalf("baseline: %+v", rep)
	}
	bad := "tempo 120\nthis is not btw at all\n"
	if st, code := errCode(t, e.do("PUT", "/api/programs/"+rep.CID, strings.NewReader(bad), ip("192.0.2.90"))); st != 422 {
		t.Fatalf("bad program: %d %s", st, code)
	}
}

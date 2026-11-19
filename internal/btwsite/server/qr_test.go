package server

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"beats-bitwrap-io/internal/btwsite/api"
)

const qrFrag = "zdpuAyGqNP8rmqxhRGzVeEyNKqjFbCpaXaR3yD6nQvZ5z5wdN.eJwrKUotyc9LUShKTUtMTVRIy8xJLVYoSMwrSUtNU0jLTE4tVkjKT0nNTE_RK0gtysvMT1WwVQAAcPoQ_g"

func TestQRAllowList(t *testing.T) {
	e := newEnv(t, nil) // public URL https://btw.test
	good := []string{
		"https://btw.test/p#" + qrFrag,
		"https://btw.test/p/zdpuAyGqNP8rmqxhRGzVeEyNKqjFbCpaXaR3yD6nQvZ5z5wdN",
	}
	for _, link := range good {
		var out struct {
			QR      string `json:"qr"`
			URL     string `json:"url"`
			Modules int    `json:"modules"`
		}
		if st := decode(t, e.post("/api/qr", map[string]string{"text": link}), &out); st != 200 {
			t.Fatalf("%s: %d", link, st)
		}
		raw, ok := strings.CutPrefix(out.QR, "data:image/svg+xml;base64,")
		if !ok || out.URL != link || out.Modules < 21 {
			t.Fatalf("reply: %+v", out)
		}
		svg, err := base64.StdEncoding.DecodeString(raw)
		if err != nil || !strings.HasPrefix(string(svg), "<svg ") || !strings.Contains(string(svg), `fill="#fff"`) {
			t.Fatalf("not an svg: %v %.60s", err, svg)
		}
	}
	bad := []string{
		"", "hello", "https://evil.example/p#" + qrFrag, "http://btw.test/p#" + qrFrag,
		"https://btw.test/p#" + qrFrag + "~notes", // notes are never in the app's form
		"https://btw.test/#" + qrFrag,             // the page form, not the app's
		"https://btw.test/p?x=1#" + qrFrag, "https://btw.test/p/", "https://btw.test/p/abc",
		"https://btw.test/p/" + strings.Repeat("a", 20) + "/x", "https://btw.test/c/" + qrFrag,
		"https://btw.test/pair#abcdefgh.ijklmnop", "https://btw.test.evil.example/p#" + qrFrag,
		"https://btw.test/p#" + qrFrag + " ", "WIFI:S:x;T:WPA;P:y;;",
	}
	for _, link := range bad {
		if st, code := errCode(t, e.post("/api/qr", map[string]string{"text": link})); st != 400 || code != api.CodeBadRequest {
			t.Errorf("%q: %d %s, want 400 bad_request", link, st, code)
		}
	}
	if st, _ := errCode(t, e.post("/api/qr", map[string]string{"text": "https://btw.test/p#" + qrFrag[:20] + "." + strings.Repeat("A", maxQRLink)})); st != 400 {
		t.Errorf("over the cap: %d", st)
	}
	// the longest allowed link still draws (a QR code at the lowest error correction holds 2953 bytes)
	long := "https://btw.test/p#" + qrFrag[:20] + "." + strings.Repeat("A", maxQRLink-len("https://btw.test/p#")-21)
	if len(long) != maxQRLink {
		t.Fatalf("test link is %d", len(long))
	}
	if st := decode(t, e.post("/api/qr", map[string]string{"text": long}), &map[string]any{}); st != 200 {
		t.Errorf("at the cap: %d", st)
	}
	if st, _ := errCode(t, e.do("GET", "/api/qr", nil)); st != 405 && st != 404 {
		t.Errorf("GET /api/qr: %d", st)
	}
}

func TestQRRateLimitedLikeCheck(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.CheckIPMin = 3 })
	link := map[string]string{"text": "https://btw.test/p#" + qrFrag}
	var codes []int
	for i := 0; i < 5; i++ {
		codes = append(codes, e.post("/api/qr", link, ip("192.0.2.77")).StatusCode)
	}
	if codes[0] != 200 || codes[2] != 200 || codes[3] != 429 || codes[4] != 429 {
		t.Fatalf("codes: %v", codes)
	}
	if r := e.post("/api/qr", link, ip("192.0.2.78")); r.StatusCode != 200 {
		t.Fatalf("another address: %d", r.StatusCode)
	}
}

func TestAssetLinks(t *testing.T) {
	// no file: 404 as before
	e := newEnv(t, nil)
	if st, code := errCode(t, e.get("/.well-known/assetlinks.json")); st != 404 || code != api.CodeNotFound {
		t.Fatalf("unset: %d %s", st, code)
	}
	// a file: served as JSON, byte for byte, no redirect; edits show without a restart
	f := filepath.Join(t.TempDir(), "assetlinks.json")
	v1 := `[{"relation":["delegate_permission/common.handle_all_urls"],"target":{"namespace":"android_app","package_name":"app.beatscript","sha256_cert_fingerprints":["AA:BB"]}}]`
	os.WriteFile(f, []byte(v1), 0o644)
	e = newEnv(t, func(c *Config) { c.AssetLinksFile = f })
	r := e.get("/.well-known/assetlinks.json")
	if r.StatusCode != 200 || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") || r.Header.Get("Location") != "" {
		t.Fatalf("served: %d %q", r.StatusCode, r.Header.Get("Content-Type"))
	}
	if got := string(readAll(t, r)); got != v1 {
		t.Fatalf("body: %s", got)
	}
	v2 := strings.Replace(v1, "AA:BB", "CC:DD", 1)
	os.WriteFile(f, []byte(v2), 0o644)
	if got := string(readAll(t, e.get("/.well-known/assetlinks.json"))); got != v2 {
		t.Fatalf("edit not picked up: %s", got)
	}
	// the file vanishing is a 500, never a 200 of nothing
	os.Remove(f)
	if r := e.get("/.well-known/assetlinks.json"); r.StatusCode != 500 {
		t.Fatalf("missing file: %d", r.StatusCode)
	}
}

func TestAssetLinksFlag(t *testing.T) {
	f := filepath.Join(t.TempDir(), "al.json")
	os.WriteFile(f, []byte("[]"), 0o644)
	c, err := ParseConfig([]string{"-assetlinks-file", f}, func(string) string { return "" }, nil)
	if err != nil || c.AssetLinksFile != f {
		t.Fatalf("flag: %v %q", err, c.AssetLinksFile)
	}
	c, err = ParseConfig(nil, func(k string) string {
		if k == "BTW_ASSETLINKS_FILE" {
			return f
		}
		return ""
	}, nil)
	if err != nil || c.AssetLinksFile != f {
		t.Fatalf("env: %v %q", err, c.AssetLinksFile)
	}
	os.WriteFile(f, []byte("{nope"), 0o644)
	if _, err := ParseConfig([]string{"-assetlinks-file", f}, func(string) string { return "" }, nil); err == nil {
		t.Fatal("invalid JSON accepted")
	}
	if _, err := ParseConfig([]string{"-assetlinks-file", f + ".missing"}, func(string) string { return "" }, nil); err == nil {
		t.Fatal("missing file accepted")
	}
}

// The QR holds <public>/p#CID.packed: a camera without the app opens that URL in the browser, so /p must serve the
// page (the page reads the fragment, as it does at /#...).
func TestPageServedAtP(t *testing.T) {
	e := newEnv(t, nil)
	for _, p := range []string{"/p", "/"} {
		r := e.get(p)
		b := string(readAll(t, r))
		if r.StatusCode != 200 || !strings.Contains(r.Header.Get("Content-Type"), "text/html") || !strings.Contains(b, "<p>index") {
			t.Errorf("%s: %d %q", p, r.StatusCode, r.Header.Get("Content-Type"))
		}
	}
}

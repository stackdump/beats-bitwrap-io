package server

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func (e *tenv) siteID() string {
	e.t.Helper()
	var d map[string]any
	if st := decode(e.t, e.get("/.well-known/btw-site"), &d); st != 200 {
		e.t.Fatalf("well-known: %d", st)
	}
	return d["site_id"].(string)
}

func (e *tenv) signedWith(p *phone, text func(ts int64) string, method, path string, body []byte) *http.Response {
	e.t.Helper()
	ts := e.clk.Now().UnixMilli()
	sig := ed25519.Sign(p.priv, []byte(text(ts)))
	auth := fmt.Sprintf("BtwDevice %s.%d.%s", p.device, ts, base64.RawURLEncoding.EncodeToString(sig))
	return e.do(method, path, bytes.NewReader(body), hdr("Authorization", auth), hdr("Content-Type", "application/json"))
}

func TestSiteDocAndStableID(t *testing.T) {
	e := newEnv(t, nil)
	id := e.siteID()
	if len(id) < 16 {
		t.Fatalf("id %q", id)
	}
	var d map[string]any
	decode(t, e.get("/.well-known/btw-site"), &d)
	if d["proto"] != "btw-site/1" || d["origin"] != "https://btw.test" || d["license"] != "CC0-1.0" || d["moved_to"] != nil {
		t.Fatalf("doc: %v", d)
	}
	if e2 := e.restart(); e2.siteID() != id {
		t.Fatal("the site id changed across a restart")
	}
	if b, _ := os.ReadFile(filepath.Join(e.cfg.DataDir, "site.json")); !strings.Contains(string(b), id) {
		t.Fatalf("site.json: %s", b)
	}
}

func TestPairV2SurvivesAMoveOfDomain(t *testing.T) {
	e := newEnv(t, nil)
	u := e.newUser()
	p := newPhone(21)
	site := e.siteID()

	// pair with btw-pair/2: the claim names the site, not the host
	o := e.offer(u)
	var off map[string]any
	decode(t, e.post("/api/pair", nil, cookie(u.cookie), hdr("Origin", "https://btw.test")), &off)
	if off["site_id"] != site || off["protocol"] != "btw-pair/2" {
		t.Fatalf("offer: %v", off)
	}
	ts := e.clk.Now().UnixMilli()
	tok := tokenOf(t, o)
	sig := ed25519.Sign(p.priv, []byte(ClaimMessage2(site, o.PairID, tok, p.key, "Pixel 9", ts)))
	var hello map[string]any
	st := decode(t, e.post("/api/pair/claim", map[string]any{"proto": pairProto2, "pair_id": o.PairID, "token": tok, "key": p.key,
		"name": "Pixel 9", "ts": ts, "sig": base64.RawURLEncoding.EncodeToString(sig)}), &hello)
	if st != 200 || hello["site_id"] != site {
		t.Fatalf("claim: %d %v", st, hello)
	}
	p.device = hello["device_id"].(string)
	v2 := func(ts int64) string { return RequestMessage2(site, p.device, "GET", "/api/device", ts, nil) }
	if r := e.signedWith(p, v2, "GET", "/api/device", nil); r.StatusCode != 200 {
		t.Fatalf("v2 request: %d", r.StatusCode)
	}

	// the move: same data dir, a new name; the old name stays an alias
	e.cfg.PublicURL = "https://beatscript.test"
	e.cfg.AltOrigins = "https://btw.test"
	e2 := e.restart()
	if e2.siteID() != site {
		t.Fatal("site id differs after the move")
	}
	if r := e2.signedWith(p, v2, "GET", "/api/device", nil); r.StatusCode != 200 {
		t.Fatalf("v2 request after the move: %d", r.StatusCode)
	}
	// a v2 signature for another site is refused
	other := func(ts int64) string {
		return RequestMessage2("someOtherSite0123456789", p.device, "GET", "/api/device", ts, nil)
	}
	if r := e2.signedWith(p, other, "GET", "/api/device", nil); r.StatusCode != 401 {
		t.Fatalf("other site: %d", r.StatusCode)
	}
}

func TestPairV1HostBoundNeedsTheOldNameAsAlias(t *testing.T) {
	e := newEnv(t, nil)
	p := newPhone(22)
	e.pairPhone(e.newUser(), p) // v1, signed for btw.test
	if r := e.signed(p, "GET", "/api/device", nil); r.StatusCode != 200 {
		t.Fatalf("before: %d", r.StatusCode)
	}
	e.cfg.PublicURL = "https://beatscript.test"
	e2 := e.restart()
	if r := e2.signed(p, "GET", "/api/device", nil); r.StatusCode != 401 {
		t.Fatalf("a v1 pairing without the old name as an alias must fail: %d", r.StatusCode)
	}
	e.cfg.AltOrigins = "https://btw.test"
	e3 := e.restart()
	if r := e3.signed(p, "GET", "/api/device", nil); r.StatusCode != 200 {
		t.Fatalf("with -alt-origins: %d", r.StatusCode)
	}
	var hello map[string]any
	decode(t, e3.signed(p, "GET", "/api/device", nil), &hello)
	if hello["origin"] != "https://beatscript.test" || hello["site_id"] == nil {
		t.Fatalf("hello does not give the phone the new origin and the site id: %v", hello)
	}
}

func TestMovedNoticeOnTheStream(t *testing.T) {
	e := newEnv(t, nil)
	p := newPhone(23)
	e.pairPhone(e.newUser(), p)
	e.cfg.MovedTo = "https://beatscript.test/"
	e2 := e.restart()
	var d map[string]any
	decode(t, e2.get("/.well-known/btw-site"), &d)
	if d["moved_to"] != "https://beatscript.test" {
		t.Fatalf("doc: %v", d)
	}
	c := e2.sse("/api/device/events", func(r *http.Request) {
		ts := e2.clk.Now().UnixMilli()
		sig := ed25519.Sign(p.priv, []byte(RequestMessage("btw.test", p.device, "GET", "/api/device/events", ts, nil)))
		r.Header.Set("Authorization", fmt.Sprintf("BtwDevice %s.%d.%s", p.device, ts, base64.RawURLEncoding.EncodeToString(sig)))
	})
	c.next(t, "hello", 2*time.Second)
	m := c.next(t, "moved", 2*time.Second)
	var ev struct {
		Extra struct {
			MovedTo string `json:"moved_to"`
			SiteID  string `json:"site_id"`
		} `json:"extra"`
	}
	if err := json.Unmarshal([]byte(m.data), &ev); err != nil || ev.Extra.MovedTo != "https://beatscript.test" || ev.Extra.SiteID != e2.siteID() {
		t.Fatalf("moved: %s %v", m.data, err)
	}
}

func TestSiteIDOverrideMustMatch(t *testing.T) {
	dir := t.TempDir()
	id, err := loadSite(dir, "A1234567890abcdefGHIJ")
	if err != nil || id != "A1234567890abcdefGHIJ" {
		t.Fatal(id, err)
	}
	if _, err := loadSite(dir, "B1234567890abcdefGHIJ"); err == nil {
		t.Fatal("a site keeps one id")
	}
	if _, err := loadSite(t.TempDir(), "short"); err == nil {
		t.Fatal("bad id accepted")
	}
}

func TestAltOriginsValidated(t *testing.T) {
	c := DefaultConfig()
	c.AltOrigins = "not a url"
	if err := c.validate(); err == nil {
		t.Fatal("bad alt origin accepted")
	}
}

func TestPrivacyNoticeEverywhereGeneratedWorkIsServed(t *testing.T) {
	e := newEnv(t, nil)
	var info map[string]any
	decode(t, e.get("/api/info"), &info)
	if s, _ := info["notice"].(string); !strings.Contains(s, "CC0-1.0") || info["license"] != "CC0-1.0" {
		t.Fatalf("info: %v", info)
	}
	resp := e.get("/privacy")
	body := string(readAll(t, resp))
	if resp.StatusCode != 200 || !strings.Contains(body, "CC0") || !strings.Contains(body, "audio") {
		t.Fatalf("privacy: %d %s", resp.StatusCode, body)
	}
	cid := e.put("tempo 120\nkick: x...x...x...x...\n")
	r := e.get("/api/programs/" + cid)
	if r.Header.Get("X-Content-License") != "CC0-1.0" || !strings.Contains(strings.Join(r.Header.Values("Link"), ","), "/privacy") {
		t.Fatalf("headers: %v", r.Header)
	}
	r2 := e.get("/api/render/" + cid + "?format=wav")
	if r2.Header.Get("X-Content-License") != "CC0-1.0" {
		t.Fatalf("render headers: %v", r2.Header)
	}
}

// TestPairVectorsV2 pins the btw-pair/2 texts for the phone's Rust side (btwsite/testdata/pair/vectors-v2.json).
func TestPairVectorsV2(t *testing.T) {
	p := newPhone(1)
	claim := ClaimMessage2("siteSITEsiteSITEsite01", "pairPAIRpairPAIRpair01", "tokenTOKENtokenTOKEN01", p.key, "Pixel 9", 1795000000000)
	req := RequestMessage2("siteSITEsiteSITEsite01", "devDEVdevDEVdevDEVdev1", "POST", "/api/device/report", 1795000000123, []byte(`{"playing":true}`))
	v := map[string]string{
		"seed_hex": strings.Repeat("01", 32), "site_id": "siteSITEsiteSITEsite01", "key": p.key, "fingerprint": KeyFingerprint(p.key),
		"claim_message": claim, "claim_sig": base64.RawURLEncoding.EncodeToString(ed25519.Sign(p.priv, []byte(claim))),
		"request_message": req, "request_sig": base64.RawURLEncoding.EncodeToString(ed25519.Sign(p.priv, []byte(req))),
	}
	got, _ := json.MarshalIndent(v, "", "  ")
	path := filepath.Join("..", "..", "..", "btwsite", "testdata", "pair", "vectors-v2.json")
	if os.Getenv("BTW_PAIR_VECTORS_WRITE") == "1" {
		os.WriteFile(path, append(got, '\n'), 0o644)
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(want)) != strings.TrimSpace(string(got)) {
		t.Fatalf("vectors changed:\n%s", got)
	}
}

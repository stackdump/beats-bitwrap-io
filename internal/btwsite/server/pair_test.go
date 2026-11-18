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

	"beats-bitwrap-io/internal/btwsite/api"
)

// phone is a test djandroid: an Ed25519 device key and, once paired, its device id.
type phone struct {
	priv   ed25519.PrivateKey
	key    string
	device string
}

func newPhone(seed byte) *phone {
	s := bytes.Repeat([]byte{seed}, ed25519.SeedSize)
	priv := ed25519.NewKeyFromSeed(s)
	return &phone{priv: priv, key: base64.RawURLEncoding.EncodeToString(priv.Public().(ed25519.PublicKey))}
}

type offer struct {
	PairID    string `json:"pair_id"`
	URL       string `json:"url"`
	QR        string `json:"qr"`
	ExpiresIn int    `json:"expires_in"`
}

func (e *tenv) offer(u *edUser) offer {
	e.t.Helper()
	var o offer
	if st := decode(e.t, e.post("/api/pair", nil, cookie(u.cookie), hdr("Origin", "https://btw.test")), &o); st != 200 {
		e.t.Fatalf("pair: %d", st)
	}
	return o
}

// tokenOf reads the token out of the QR's link (https://<host>/pair#<pair id>.<token>).
func tokenOf(t *testing.T, o offer) string {
	t.Helper()
	i := strings.Index(o.URL, "#")
	parts := strings.Split(o.URL[i+1:], ".")
	if i < 0 || len(parts) != 2 || parts[0] != o.PairID {
		t.Fatalf("link: %s", o.URL)
	}
	return parts[1]
}

func (e *tenv) claimBody(p *phone, pairID, token, name string, ts int64) map[string]any {
	msg := ClaimMessage("btw.test", pairID, token, p.key, name, ts)
	return map[string]any{"proto": pairProto, "pair_id": pairID, "token": token, "key": p.key, "name": name, "ts": ts,
		"sig": base64.RawURLEncoding.EncodeToString(ed25519.Sign(p.priv, []byte(msg)))}
}

func (e *tenv) claim(p *phone, o offer) *http.Response {
	return e.post("/api/pair/claim", e.claimBody(p, o.PairID, tokenOf(e.t, o), "Pixel 9", e.clk.Now().UnixMilli()))
}

// signed is a request from a paired phone.
func (e *tenv) signed(p *phone, method, path string, body []byte) *http.Response {
	e.t.Helper()
	ts := e.clk.Now().UnixMilli()
	sig := ed25519.Sign(p.priv, []byte(RequestMessage("btw.test", p.device, method, path, ts, body)))
	auth := fmt.Sprintf("BtwDevice %s.%d.%s", p.device, ts, base64.RawURLEncoding.EncodeToString(sig))
	var rd *bytes.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	} else {
		rd = bytes.NewReader(nil)
	}
	return e.do(method, path, rd, hdr("Authorization", auth), hdr("Content-Type", "application/json"))
}

func (e *tenv) pairPhone(u *edUser, p *phone) map[string]any {
	e.t.Helper()
	o := e.offer(u)
	var hello map[string]any
	if st := decode(e.t, e.claim(p, o), &hello); st != 200 {
		e.t.Fatalf("claim: %d %v", st, hello)
	}
	p.device = hello["device_id"].(string)
	return hello
}

func TestPairFlow(t *testing.T) {
	e := newEnv(t, nil)
	u := e.newUser()
	p := newPhone(7)

	o := e.offer(u)
	if !strings.HasPrefix(o.URL, "https://btw.test/pair#") || !strings.HasPrefix(o.QR, "data:image/png;base64,") || o.ExpiresIn != 120 {
		t.Fatalf("offer: %+v", o)
	}
	var st struct{ State string }
	decode(t, e.get("/api/pair/"+o.PairID, cookie(u.cookie)), &st)
	if st.State != "waiting" {
		t.Fatalf("state: %+v", st)
	}
	// another user cannot read the offer
	if code, _ := errCode(t, e.get("/api/pair/"+o.PairID, cookie(e.newUser().cookie))); code != 404 {
		t.Fatalf("other user reads offer: %d", code)
	}

	var hello map[string]any
	if code := decode(t, e.claim(p, o), &hello); code != 200 {
		t.Fatalf("claim: %d %v", code, hello)
	}
	p.device = hello["device_id"].(string)
	if hello["user"] != u.id || hello["fingerprint"] != KeyFingerprint(p.key) || hello["name"] != "Pixel 9" {
		t.Fatalf("hello: %v", hello)
	}
	var st2 struct {
		State  string
		Device map[string]any
	}
	decode(t, e.get("/api/pair/"+o.PairID, cookie(u.cookie)), &st2)
	if st2.State != "paired" || st2.Device["id"] != p.device {
		t.Fatalf("after claim: %+v", st2)
	}
	// single use
	if code, kind := errCode(t, e.claim(newPhone(8), o)); code != 410 || kind != "pair_used" {
		t.Fatalf("second claim: %d %s", code, kind)
	}

	// the phone's stream: hello first, then what the page and MCP push
	c := e.sse("/api/device/events", func(r *http.Request) {
		ts := e.clk.Now().UnixMilli()
		sig := ed25519.Sign(p.priv, []byte(RequestMessage("btw.test", p.device, "GET", "/api/device/events", ts, nil)))
		r.Header.Set("Authorization", fmt.Sprintf("BtwDevice %s.%d.%s", p.device, ts, base64.RawURLEncoding.EncodeToString(sig)))
	})
	if m := c.next(t, "hello", 2*time.Second); m.event != "hello" || !strings.Contains(m.data, p.device) {
		t.Fatalf("hello: %+v", m)
	}
	resp := e.post("/api/devices/"+p.device+"/push", map[string]any{"type": "eval", "text": progA, "play": true},
		cookie(u.cookie), hdr("Origin", "https://btw.test"))
	if code := decode(t, resp, nil); code != 200 {
		t.Fatalf("push: %d", code)
	}
	m := c.next(t, "eval", 2*time.Second)
	var ev api.SessionEvent
	json.Unmarshal([]byte(m.data), &ev)
	if ev.Type != "eval" || ev.Text != progA || !ev.Play || ev.CID == "" {
		t.Fatalf("eval on the phone: %+v", ev)
	}
	// MCP's "every session I own" reaches the phone too
	if n, err := e.srv.Push(u.user(), "", api.SessionEvent{Type: "stop"}); err != nil || n != 1 {
		t.Fatalf("mcp push: %d %v", n, err)
	}
	c.next(t, "stop", 2*time.Second)
	if ss := e.srv.Sessions(u.user()); len(ss) != 1 || ss[0].Device != p.device {
		t.Fatalf("sessions: %+v", ss)
	}

	// the phone reports; the page sees it
	rep, _ := json.Marshal(api.SessionState{CID: ev.CID, Playing: true, Section: "intro", Bar: 3})
	if code := decode(t, e.signed(p, "POST", "/api/device/report", rep), nil); code != 204 {
		t.Fatalf("report: %d", code)
	}
	var devs struct{ Devices []map[string]any }
	decode(t, e.get("/api/devices", cookie(u.cookie)), &devs)
	if len(devs.Devices) != 1 || devs.Devices[0]["connected"] != true {
		t.Fatalf("devices: %+v", devs)
	}
	if s := devs.Devices[0]["state"].(map[string]any); s["playing"] != true || s["section"] != "intro" {
		t.Fatalf("device state: %+v", s)
	}

	// unpair from the page: the stream is told, then ends; the key no longer works
	resp = e.do("DELETE", "/api/devices/"+p.device, nil, cookie(u.cookie), hdr("Origin", "https://btw.test"))
	if resp.StatusCode != 204 {
		t.Fatalf("unpair: %d", resp.StatusCode)
	}
	resp.Body.Close()
	if m := c.next(t, "unpaired", 2*time.Second); m.event != "unpaired" {
		t.Fatalf("unpaired: %+v", m)
	}
	if code, kind := errCode(t, e.signed(p, "GET", "/api/device", nil)); code != 410 || kind != "unpaired" {
		t.Fatalf("after unpair: %d %s", code, kind)
	}
}

func TestPairRefusals(t *testing.T) {
	e := newEnv(t, nil)
	u := e.newUser()
	p := newPhone(9)

	// signed in only, and never from another site
	if code, _ := errCode(t, e.post("/api/pair", nil)); code != 401 {
		t.Fatalf("anonymous offer: %d", code)
	}
	if code, kind := errCode(t, e.post("/api/pair", nil, cookie(u.cookie), hdr("Origin", "https://evil.example"))); code != 403 || kind != "cross_site" {
		t.Fatalf("cross-site offer: %d %s", code, kind)
	}

	// a wrong token burns the code
	o := e.offer(u)
	if code, _ := errCode(t, e.post("/api/pair/claim", e.claimBody(p, o.PairID, "AAAAAAAAAAAAAAAAAAAAAA", "x", e.clk.Now().UnixMilli()))); code != 401 {
		t.Fatalf("wrong token: %d", code)
	}
	if code, kind := errCode(t, e.claim(p, o)); code != 410 || kind != "pair_used" {
		t.Fatalf("after a wrong token: %d %s", code, kind)
	}

	// a signature by another key than the one claimed
	o = e.offer(u)
	b := e.claimBody(p, o.PairID, tokenOf(t, o), "x", e.clk.Now().UnixMilli())
	b["key"] = newPhone(10).key
	if code, kind := errCode(t, e.post("/api/pair/claim", b)); code != 401 || kind != api.CodeBadSignature {
		t.Fatalf("forged claim: %d %s", code, kind)
	}

	// a stale clock
	o = e.offer(u)
	if code, _ := errCode(t, e.post("/api/pair/claim", e.claimBody(p, o.PairID, tokenOf(t, o), "x", e.clk.Now().Add(-10*time.Minute).UnixMilli()))); code != 401 {
		t.Fatalf("stale claim: %d", code)
	}

	// expiry
	o = e.offer(u)
	e.clk.Advance(pairTTL + time.Second)
	if code, kind := errCode(t, e.claim(p, o)); code != 410 || kind != "pair_expired" {
		t.Fatalf("expired: %d %s", code, kind)
	}
	var st struct{ State string }
	decode(t, e.get("/api/pair/"+o.PairID, cookie(u.cookie)), &st)
	if st.State != "expired" {
		t.Fatalf("state: %s", st.State)
	}

	// signed requests: a replay and a tampered body are refused
	e.pairPhone(u, p)
	ts := e.clk.Now().UnixMilli()
	sig := ed25519.Sign(p.priv, []byte(RequestMessage("btw.test", p.device, "GET", "/api/device", ts, nil)))
	auth := fmt.Sprintf("BtwDevice %s.%d.%s", p.device, ts, base64.RawURLEncoding.EncodeToString(sig))
	if r := e.do("GET", "/api/device", nil, hdr("Authorization", auth)); r.StatusCode != 200 {
		t.Fatalf("signed: %d", r.StatusCode)
	} else {
		r.Body.Close()
	}
	if code, _ := errCode(t, e.do("GET", "/api/device", nil, hdr("Authorization", auth))); code != 401 {
		t.Fatalf("replay: %d", code)
	}
	ts++
	sig = ed25519.Sign(p.priv, []byte(RequestMessage("btw.test", p.device, "POST", "/api/device/report", ts, []byte(`{"playing":true}`))))
	auth = fmt.Sprintf("BtwDevice %s.%d.%s", p.device, ts, base64.RawURLEncoding.EncodeToString(sig))
	if code, _ := errCode(t, e.do("POST", "/api/device/report", strings.NewReader(`{"playing":false}`), hdr("Authorization", auth))); code != 401 {
		t.Fatalf("tampered body: %d", code)
	}

	// pushing an erroring or private program sends nothing
	other := e.newUser()
	if code, _ := errCode(t, e.post("/api/devices/"+p.device+"/push", map[string]any{"type": "stop"}, cookie(other.cookie), hdr("Origin", "https://btw.test"))); code != 404 {
		t.Fatalf("someone else's phone: %d", code)
	}
	if code, _ := errCode(t, e.post("/api/devices/"+p.device+"/push", map[string]any{"type": "stop"}, cookie(u.cookie), hdr("Origin", "https://btw.test"))); code != 409 {
		t.Fatalf("not connected: %d", code)
	}

	// re-pair: the same key replaces its old record; the phone unpairs itself
	old := p.device
	e.pairPhone(u, p)
	if p.device == old {
		t.Fatal("re-pair keeps the old device id")
	}
	var devs struct{ Devices []map[string]any }
	decode(t, e.get("/api/devices", cookie(u.cookie)), &devs)
	if len(devs.Devices) != 1 {
		t.Fatalf("one record per key: %+v", devs)
	}
	if r := e.signed(p, "DELETE", "/api/device", nil); r.StatusCode != 204 {
		t.Fatalf("forget: %d", r.StatusCode)
	}
	decode(t, e.get("/api/devices", cookie(u.cookie)), &devs)
	if len(devs.Devices) != 0 {
		t.Fatalf("after forget: %+v", devs)
	}
}

func TestPairDevicesPersist(t *testing.T) {
	e := newEnv(t, nil)
	u := e.newUser()
	p := newPhone(11)
	e.pairPhone(u, p)
	b, err := os.ReadFile(filepath.Join(e.cfg.DataDir, "devices.json"))
	if err != nil || !strings.Contains(string(b), p.key) {
		t.Fatalf("devices.json: %v %s", err, b)
	}
	if fi, _ := os.Stat(filepath.Join(e.cfg.DataDir, "devices.json")); fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", fi.Mode())
	}
	e2 := e.restart()
	if r := e2.signed(p, "GET", "/api/device", nil); r.StatusCode != 200 {
		t.Fatalf("after restart: %d", r.StatusCode)
	}
}

// TestPairVectors pins the signed texts and signatures for a fixed key: the phone's Rust side
// (djandroid rust/src/btwpair.rs) reproduces the same file (btwsite/testdata/pair/vectors.json).
func TestPairVectors(t *testing.T) {
	p := newPhone(1)
	claim := ClaimMessage("btw.bitwrap.io", "pairPAIRpairPAIRpair01", "tokenTOKENtokenTOKEN01", p.key, "Pixel 9", 1795000000000)
	req := RequestMessage("btw.bitwrap.io", "devDEVdevDEVdevDEVdev1", "POST", "/api/device/report", 1795000000123, []byte(`{"playing":true}`))
	v := map[string]string{
		"seed_hex":        strings.Repeat("01", 32),
		"key":             p.key,
		"fingerprint":     KeyFingerprint(p.key),
		"claim_message":   claim,
		"claim_sig":       base64.RawURLEncoding.EncodeToString(ed25519.Sign(p.priv, []byte(claim))),
		"request_message": req,
		"request_sig":     base64.RawURLEncoding.EncodeToString(ed25519.Sign(p.priv, []byte(req))),
	}
	got, _ := json.MarshalIndent(v, "", "  ")
	path := filepath.Join("..", "..", "..", "btwsite", "testdata", "pair", "vectors.json")
	if os.Getenv("BTW_PAIR_VECTORS_WRITE") == "1" {
		os.MkdirAll(filepath.Dir(path), 0o755)
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

package server

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// What a pairing QR code holds, exactly: the phone's parser (beatscript-app rust/src/btwpair.rs `parse`)
// accepts https://<host>/pair#<6..64 base64url>.<16..64 base64url>; the site always makes 22.22.
var pairLinkRE = regexp.MustCompile(`^https://[a-z0-9.-]+(:[0-9]+)?/pair#[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$`)

const goldenOrigin = "https://beatscript.app"

// TestPairQRGolden pins one web-made pairing QR payload and the claim a phone signs for it
// (btwsite/testdata/pair/qr-golden.json). beatscript-app copies the file to rust/tests/ and its
// `golden_web_qr_parses_and_claims` test parses the payload with the app's own parser and
// reproduces claim_message and claim_sig byte for byte. BTW_PAIR_VECTORS_WRITE=1 rewrites it.
func TestPairQRGolden(t *testing.T) {
	id := base64.RawURLEncoding.EncodeToString([]byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15})
	tokB := make([]byte, 16)
	for i := range tokB {
		tokB[i] = byte(0xf0 + i)
	}
	token := base64.RawURLEncoding.EncodeToString(tokB) // has '-' and '_': the parser must take both
	qr := PairLink(goldenOrigin, id, token)
	if !pairLinkRE.MatchString(qr) {
		t.Fatalf("golden link is not the phone's form: %s", qr)
	}
	p := newPhone(1)
	const name, ts = "Pixel 9", int64(1795000000000)
	host := "beatscript.app"
	claim := ClaimMessage(host, id, token, p.key, name, ts)
	sig := base64.RawURLEncoding.EncodeToString(ed25519.Sign(p.priv, []byte(claim)))
	v := map[string]any{
		"qr":            qr,
		"origin":        goldenOrigin,
		"host":          host,
		"pair_id":       id,
		"token":         token,
		"seed_hex":      strings.Repeat("01", 32),
		"key":           p.key,
		"name":          name,
		"ts":            ts,
		"proto":         pairProto,
		"claim_message": claim,
		"claim_sig":     sig,
	}
	got, _ := json.MarshalIndent(v, "", "  ")
	path := filepath.Join("..", "..", "..", "btwsite", "testdata", "pair", "qr-golden.json")
	if os.Getenv("BTW_PAIR_VECTORS_WRITE") == "1" {
		os.WriteFile(path, append(got, '\n'), 0o644)
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(want)) != strings.TrimSpace(string(got)) {
		t.Fatalf("qr-golden.json changed (the phone pins it too):\n%s", got)
	}
}

// phoneParse is what the phone does with a scanned link (btwpair.rs parse): origin, host, pair id, token.
func phoneParse(t *testing.T, link string) (origin, host, pairID, token string) {
	t.Helper()
	if !pairLinkRE.MatchString(link) {
		t.Fatalf("the QR link is not what the phone reads: %s", link)
	}
	u, err := url.Parse(link)
	if err != nil {
		t.Fatal(err)
	}
	pairID, token, _ = strings.Cut(u.Fragment, ".")
	return u.Scheme + "://" + u.Host, u.Host, pairID, token
}

// TestPairQRScanSingleUseExpiry runs the scan as the phone does on a site served as beatscript.app: the
// page's QR link, read by the phone's rules, gives a claim the server accepts; the same claim again is
// refused (single use), and a code past its two minutes is refused as expired. Each refusal says what to do.
func TestPairQRScanSingleUseExpiry(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.PublicURL = goldenOrigin })
	u := e.newUser()
	p := newPhone(7)
	offerNow := func() offer {
		var o offer
		if st := decode(t, e.post("/api/pair", nil, cookie(u.cookie), hdr("Origin", goldenOrigin)), &o); st != 200 {
			t.Fatalf("pair: %d", st)
		}
		return o
	}
	claimFor := func(o offer) []byte {
		origin, host, id, tok := phoneParse(t, o.URL)
		if origin != goldenOrigin || host != "beatscript.app" || id != o.PairID {
			t.Fatalf("parsed %s %s %s from %s", origin, host, id, o.URL)
		}
		ts := e.clk.Now().UnixMilli()
		msg := ClaimMessage(host, id, tok, p.key, "Pixel 9", ts)
		b, _ := json.Marshal(map[string]any{"proto": pairProto, "pair_id": id, "token": tok, "key": p.key, "name": "Pixel 9", "ts": ts,
			"sig": base64.RawURLEncoding.EncodeToString(ed25519.Sign(p.priv, []byte(msg)))})
		return b
	}
	postRaw := func(b []byte) (int, string, string) {
		r := e.do("POST", "/api/pair/claim", bytes.NewReader(b), hdr("Content-Type", "application/json"))
		defer r.Body.Close()
		var env struct {
			Error struct{ Code, Message string }
		}
		json.NewDecoder(r.Body).Decode(&env)
		return r.StatusCode, env.Error.Code, env.Error.Message
	}

	o := offerNow()
	if o.URL != PairLink(goldenOrigin, o.PairID, tokenOf(t, o)) {
		t.Fatalf("the offer's link is not PairLink's: %s", o.URL)
	}
	if !strings.HasPrefix(o.QR, "data:image/png;base64,") {
		t.Fatalf("qr: %.40s", o.QR)
	}
	b := claimFor(o)
	if st, code, msg := postRaw(b); st != 200 {
		t.Fatalf("a fresh scan: %d %s %s", st, code, msg)
	}
	// replay: the very same signed claim, again
	if st, code, msg := postRaw(b); st != 410 || code != "pair_used" || !strings.Contains(msg, "show a new one") {
		t.Fatalf("replayed claim: %d %s %q", st, code, msg)
	}

	o = offerNow()
	e.clk.Advance(pairTTL + time.Second)
	if st, code, msg := postRaw(claimFor(o)); st != 410 || code != "pair_expired" || !strings.Contains(msg, "show a new one") {
		t.Fatalf("expired code: %d %s %q", st, code, msg)
	}
}

package auth

import (
	"crypto/ed25519"
	"encoding/hex"
	"net/http"
	"testing"
)

// Login CSRF: a page on another origin makes the visitor's browser POST a sign-in it signed itself
// (a form with enctype text/plain carries a JSON body, and no preflight asks the server first). The visitor
// is then signed in as the page's author, and their open tab, which reports its editor to an anonymous
// session, hands that session to the author. Cross-origin requests to the cookie-setting and cookie-using
// auth routes are refused; a request with no browser headers (curl, scripts, MCP clients) still works.
func TestCrossSiteRequestsToAuthRoutesAreRefused(t *testing.T) {
	h := newHarness(t, nil)
	evil := func(r *http.Request) {
		r.Header.Set("Origin", "https://evil.example")
		r.Header.Set("Content-Type", "text/plain")
	}
	// a good sign-in by the attacker's own key, posted from the attacker's page
	k := newEd(t)
	c := h.challenge()
	w := h.do("POST", "/api/auth/login", login("ed25519", k.pub, k.sign(c.Message), c.Nonce), evil)
	if w.Code != http.StatusForbidden || sessionCookie(w) != nil {
		t.Fatalf("cross-origin login: %d, cookie %v: %s", w.Code, sessionCookie(w), w.Body)
	}
	// the nonce is not burned by a refused request (the refusal comes first), so the same sign-in works from the page itself
	w = h.do("POST", "/api/auth/login", login("ed25519", k.pub, k.sign(c.Message), c.Nonce), func(r *http.Request) {
		r.Header.Set("Origin", "https://btw.bitwrap.io")
	})
	if w.Code != 200 || sessionCookie(w) == nil {
		t.Fatalf("same-origin login: %d %s", w.Code, w.Body)
	}
	ck := sessionCookie(w)

	// every other way a browser says "not this origin"
	for name, mod := range map[string]func(*http.Request){
		"null origin":          func(r *http.Request) { r.Header.Set("Origin", "null") },
		"sibling origin":       func(r *http.Request) { r.Header.Set("Origin", "https://beats.bitwrap.io") },
		"same host other port": func(r *http.Request) { r.Header.Set("Origin", "https://btw.bitwrap.io:8443") },
		"cross-site":           func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") },
		"same-site":            func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "same-site") },
		"junk origin":          func(r *http.Request) { r.Header.Set("Origin", "::::") },
	} {
		c := h.challenge()
		for _, tc := range []struct {
			method, path string
			body         any
		}{
			{"POST", "/api/auth/login", login("ed25519", k.pub, k.sign(c.Message), c.Nonce)},
			{"POST", "/api/auth/logout", nil},
			{"POST", "/api/auth/token", map[string]string{}},
			{"DELETE", "/api/auth/token", nil},
		} {
			w := h.do(tc.method, tc.path, tc.body, withCookie(ck), mod)
			if w.Code != http.StatusForbidden {
				t.Errorf("%s: %s %s = %d, want 403: %s", name, tc.method, tc.path, w.Code, w.Body)
			}
			if tc.path != "/api/auth/logout" && len(w.Result().Cookies()) != 0 {
				t.Errorf("%s: %s %s set a cookie", name, tc.method, tc.path)
			}
		}
	}
	if n := h.svc.TokenCount("ed25519:" + k.pub); n != 0 {
		t.Fatalf("a cross-site request minted %d token(s)", n)
	}

	// what must keep working: the page itself (Origin = this site, Sec-Fetch-Site same-origin), and a client with no browser headers at all
	for name, mod := range map[string]func(*http.Request){
		"origin":      func(r *http.Request) { r.Header.Set("Origin", "https://btw.bitwrap.io") },
		"origin host": func(r *http.Request) { r.Header.Set("Origin", "http://"+r.Host) },
		"same-origin": func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "same-origin") },
		"none":        func(r *http.Request) {},
		"fetch none":  func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "none") },
	} {
		w := h.do("POST", "/api/auth/token", map[string]string{}, withCookie(ck), mod)
		if w.Code != 200 {
			t.Errorf("%s: token = %d: %s", name, w.Code, w.Body)
		}
	}
	if w := h.do("DELETE", "/api/auth/token", nil, withCookie(ck)); w.Code != 200 {
		t.Errorf("revoke without browser headers: %d", w.Code)
	}
}

// An ed25519 public key of small order verifies a message-independent signature (the identity point with
// R = identity, S = 0 verifies for every message under Go's ed25519.Verify), so it must not be an identity.
func TestSmallOrderEd25519KeysAreNotIdentities(t *testing.T) {
	identity := "01" + "0000000000000000000000000000000000000000000000000000000000000000"[2:]
	zeroSig := hex.EncodeToString(append([]byte{1}, make([]byte, 63)...))
	if !ed25519.Verify(mustHex(t, identity), []byte("any message at all"), mustHex(t, zeroSig)) {
		t.Fatal("premise: the stdlib no longer accepts the identity key's universal signature; revisit smallOrderKeys")
	}

	h := newHarness(t, nil)
	c := h.challenge()
	w := h.do("POST", "/api/auth/login", login("ed25519", identity, zeroSig, c.Nonce))
	if w.Code == 200 || sessionCookie(w) != nil {
		t.Fatalf("anyone could sign in as the identity point: %d %s", w.Code, w.Body)
	}
	// every encoding on the list, with and without the sign bit, with and without a 0x prefix, in capitals
	for _, k := range smallOrderKeys {
		raw := mustHex(t, k)
		for _, top := range []byte{0, 0x80} {
			b := append([]byte{}, raw...)
			b[31] |= top
			for _, form := range []string{hex.EncodeToString(b), "0x" + hex.EncodeToString(b)} {
				if _, err := Identity("ed25519", form); err == nil {
					t.Errorf("%s accepted as an identity", form)
				}
			}
		}
	}
	// ordinary keys are untouched
	for i := 0; i < 50; i++ {
		if _, err := Identity("ed25519", newEd(t).pub); err != nil {
			t.Fatal(err)
		}
	}
}

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

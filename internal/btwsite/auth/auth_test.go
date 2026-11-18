package auth

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
	"golang.org/x/crypto/sha3"

	"beats-bitwrap-io/internal/btwsite/api"
)

// ---- a wallet, without a wallet ----

type ethKey struct {
	priv *secp256k1.PrivateKey
	addr string
}

func keccak(b []byte) []byte {
	h := sha3.NewLegacyKeccak256()
	h.Write(b)
	return h.Sum(nil)
}

func newEth(t testing.TB) ethKey {
	t.Helper()
	priv, err := secp256k1.GeneratePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	pub := priv.PubKey().SerializeUncompressed()
	return ethKey{priv, "0x" + hex.EncodeToString(keccak(pub[1:])[12:])}
}

// personalSign is MetaMask's personal_sign: EIP-191 prefix, keccak, recoverable secp256k1 -> R||S||v.
func (k ethKey) personalSign(msg string) string {
	prefix := "\x19Ethereum Signed Message:\n" + strconv.Itoa(len(msg))
	hash := keccak(append([]byte(prefix), msg...))
	compact := ecdsa.SignCompact(k.priv, hash, false) // [27+recid | R | S]
	sig := append(append([]byte{}, compact[1:]...), compact[0])
	return "0x" + hex.EncodeToString(sig)
}

type edKey struct {
	priv ed25519.PrivateKey
	pub  string
}

func newEd(t testing.TB) edKey {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return edKey{priv, hex.EncodeToString(pub)}
}

func (k edKey) sign(msg string) string { return hex.EncodeToString(ed25519.Sign(k.priv, []byte(msg))) }

// ---- harness ----

type harness struct {
	t    *testing.T
	svc  *Service
	mux  *http.ServeMux
	now  time.Time
	mu   sync.Mutex
	dir  string
	opts Options
}

func newHarness(t *testing.T, mod func(*Options)) *harness {
	t.Helper()
	h := &harness{t: t, now: time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC), dir: t.TempDir()}
	o := Options{DataDir: h.dir, Secret: []byte("0123456789abcdef0123456789abcdef"), Secure: true, Origin: "https://btw.bitwrap.io",
		Now: func() time.Time { h.mu.Lock(); defer h.mu.Unlock(); return h.now }}
	if mod != nil {
		mod(&o)
	}
	h.opts = o
	svc, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	h.svc = svc
	h.mux = http.NewServeMux()
	svc.Mount(h.mux)
	return h
}

func (h *harness) advance(d time.Duration) { h.mu.Lock(); h.now = h.now.Add(d); h.mu.Unlock() }

func (h *harness) do(method, path string, body any, mod ...func(*http.Request)) *httptest.ResponseRecorder {
	var rd *bytes.Reader
	switch b := body.(type) {
	case nil:
		rd = bytes.NewReader(nil)
	case string:
		rd = bytes.NewReader([]byte(b))
	default:
		j, _ := json.Marshal(b)
		rd = bytes.NewReader(j)
	}
	r := httptest.NewRequest(method, path, rd)
	for _, m := range mod {
		m(r)
	}
	w := httptest.NewRecorder()
	h.mux.ServeHTTP(w, r)
	return w
}

type chal struct{ Nonce, Message, Expires string }

func (h *harness) challenge() chal {
	h.t.Helper()
	w := h.do("GET", "/api/auth/challenge", nil)
	if w.Code != 200 {
		h.t.Fatalf("challenge: %d %s", w.Code, w.Body)
	}
	var c chal
	var raw map[string]string
	json.Unmarshal(w.Body.Bytes(), &raw)
	c.Nonce, c.Message, c.Expires = raw["nonce"], raw["message"], raw["expires"]
	return c
}

func login(typ, addr, sig, nonce string) map[string]string {
	return map[string]string{"type": typ, "address": addr, "signature": sig, "nonce": nonce}
}

func sessionCookie(w *httptest.ResponseRecorder) *http.Cookie {
	for _, c := range w.Result().Cookies() {
		if c.Name == CookieName {
			return c
		}
	}
	return nil
}

func withCookie(c *http.Cookie) func(*http.Request) {
	return func(r *http.Request) { r.AddCookie(&http.Cookie{Name: c.Name, Value: c.Value}) }
}
func withBearer(tok string) func(*http.Request) {
	return func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+tok) }
}

func (h *harness) loginEth(k ethKey) (*httptest.ResponseRecorder, *http.Cookie) {
	c := h.challenge()
	w := h.do("POST", "/api/auth/login", login("eth", k.addr, k.personalSign(c.Message), c.Nonce))
	return w, sessionCookie(w)
}

func errCode(w *httptest.ResponseRecorder) string {
	var e struct{ Error api.Error }
	json.Unmarshal(w.Body.Bytes(), &e)
	return e.Error.Code
}

// ---- tests ----

func TestChallengeShape(t *testing.T) {
	h := newHarness(t, nil)
	c := h.challenge()
	lines := strings.Split(c.Message, "\n")
	if len(lines) != 4 || lines[0] != "btw.bitwrap.io sign-in" || lines[1] != "nonce: "+c.Nonce ||
		!strings.HasPrefix(lines[2], "issued: 2026-11-17T12:00:00Z") || lines[3] != "expires: 2026-11-17T12:05:00Z" {
		t.Fatalf("message: %q", c.Message)
	}
	if c.Expires != "2026-11-17T12:05:00Z" || len(c.Nonce) < 24 {
		t.Fatalf("%+v", c)
	}
	if c2 := h.challenge(); c2.Nonce == c.Nonce {
		t.Fatal("nonces repeat")
	}
	w := h.do("GET", "/api/auth/challenge", nil)
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("challenge must not be cached")
	}
	// the domain follows the configured origin
	h2 := newHarness(t, func(o *Options) { o.Origin = "http://127.0.0.1:18097" })
	if m := h2.challenge().Message; !strings.HasPrefix(m, "127.0.0.1:18097 sign-in\n") {
		t.Fatalf("%q", m)
	}
}

func TestLoginEthAndCookie(t *testing.T) {
	h := newHarness(t, nil)
	k := newEth(t)
	w, ck := h.loginEth(k)
	if w.Code != 200 || ck == nil {
		t.Fatalf("login: %d %s", w.Code, w.Body)
	}
	if !ck.HttpOnly || !ck.Secure || ck.SameSite != http.SameSiteLaxMode || ck.Path != "/" || ck.MaxAge != 7*24*3600 {
		t.Fatalf("cookie attributes: %+v", ck)
	}
	var out struct{ User api.User }
	json.Unmarshal(w.Body.Bytes(), &out)
	if out.User.ID != "eip155:"+k.addr || out.User.Kind != "eth" || out.User.Address != k.addr {
		t.Fatalf("user: %+v", out.User)
	}
	// me
	me := h.do("GET", "/api/auth/me", nil, withCookie(ck))
	var mj struct{ User *api.User }
	json.Unmarshal(me.Body.Bytes(), &mj)
	if mj.User == nil || mj.User.ID != out.User.ID || mj.User.Via != "cookie" {
		t.Fatalf("me: %s", me.Body)
	}
	anon := h.do("GET", "/api/auth/me", nil)
	if strings.TrimSpace(anon.Body.String()) != `{"user":null}` {
		t.Fatalf("anon me: %s", anon.Body)
	}
	// UserFrom
	r := httptest.NewRequest("GET", "/x", nil)
	r.AddCookie(&http.Cookie{Name: CookieName, Value: ck.Value})
	u, err := h.svc.UserFrom(r)
	if err != nil || u == nil || u.ID != out.User.ID || u.Via != "cookie" {
		t.Fatalf("UserFrom: %+v %v", u, err)
	}
	// mixed-case address is the same user
	_, ck2 := func() (*httptest.ResponseRecorder, *http.Cookie) {
		c := h.challenge()
		w := h.do("POST", "/api/auth/login", login("eth", "0x"+strings.ToUpper(k.addr[2:]), k.personalSign(c.Message), c.Nonce))
		return w, sessionCookie(w)
	}()
	r2 := httptest.NewRequest("GET", "/x", nil)
	r2.AddCookie(&http.Cookie{Name: CookieName, Value: ck2.Value})
	if u2, _ := h.svc.UserFrom(r2); u2 == nil || u2.ID != u.ID {
		t.Fatalf("case-insensitive address: %+v", u2)
	}
	// not Secure over plain http (dev)
	h3 := newHarness(t, func(o *Options) { o.Secure = false })
	if _, c := h3.loginEth(k); c == nil || c.Secure {
		t.Fatalf("dev cookie: %+v", c)
	}
}

func TestLoginEd25519(t *testing.T) {
	h := newHarness(t, nil)
	k := newEd(t)
	c := h.challenge()
	w := h.do("POST", "/api/auth/login", login("ed25519", k.pub, k.sign(c.Message), c.Nonce))
	ck := sessionCookie(w)
	if w.Code != 200 || ck == nil {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	var out struct{ User api.User }
	json.Unmarshal(w.Body.Bytes(), &out)
	if out.User.ID != "ed25519:"+k.pub || out.User.Kind != "ed25519" || out.User.Address != k.pub {
		t.Fatalf("%+v", out.User)
	}
	// with 0x and signature 0x
	c = h.challenge()
	w = h.do("POST", "/api/auth/login", login("ed25519", "0x"+strings.ToUpper(k.pub), "0x"+k.sign(c.Message), c.Nonce))
	if w.Code != 200 {
		t.Fatalf("0x forms: %d %s", w.Code, w.Body)
	}
}

// Every way of failing a login must leave no cookie behind.
func TestLoginFailuresSetNoCookie(t *testing.T) {
	h := newHarness(t, nil)
	victim, attacker := newEth(t), newEth(t)
	ed, ed2 := newEd(t), newEd(t)

	type attempt struct {
		name string
		do   func() *httptest.ResponseRecorder
		code int
		err  string
	}
	attempts := []attempt{
		{"signed by someone else, victim's address", func() *httptest.ResponseRecorder {
			c := h.challenge()
			return h.do("POST", "/api/auth/login", login("eth", victim.addr, attacker.personalSign(c.Message), c.Nonce))
		}, 401, api.CodeBadSignature},
		{"signed a different message", func() *httptest.ResponseRecorder {
			c := h.challenge()
			return h.do("POST", "/api/auth/login", login("eth", victim.addr, victim.personalSign(c.Message+"x"), c.Nonce))
		}, 401, api.CodeBadSignature},
		{"signature from another challenge", func() *httptest.ResponseRecorder {
			c1, c2 := h.challenge(), h.challenge()
			return h.do("POST", "/api/auth/login", login("eth", victim.addr, victim.personalSign(c1.Message), c2.Nonce))
		}, 401, api.CodeBadSignature},
		{"unknown nonce", func() *httptest.ResponseRecorder {
			return h.do("POST", "/api/auth/login", login("eth", victim.addr, victim.personalSign("x"), "AAAAAAAAAAAAAAAAAAAAAAAA"))
		}, 401, api.CodeChallengeStale},
		{"ed25519 signature claimed as eth", func() *httptest.ResponseRecorder {
			c := h.challenge()
			return h.do("POST", "/api/auth/login", login("eth", victim.addr, ed.sign(c.Message), c.Nonce))
		}, 401, api.CodeBadSignature},
		{"ed25519 wrong key", func() *httptest.ResponseRecorder {
			c := h.challenge()
			return h.do("POST", "/api/auth/login", login("ed25519", ed.pub, ed2.sign(c.Message), c.Nonce))
		}, 401, api.CodeBadSignature},
		{"eth signature claimed as ed25519", func() *httptest.ResponseRecorder {
			c := h.challenge()
			return h.do("POST", "/api/auth/login", login("ed25519", ed.pub, victim.personalSign(c.Message), c.Nonce))
		}, 401, api.CodeBadSignature},
		{"unknown type", func() *httptest.ResponseRecorder {
			c := h.challenge()
			return h.do("POST", "/api/auth/login", login("rsa", victim.addr, victim.personalSign(c.Message), c.Nonce))
		}, 400, api.CodeBadRequest},
		{"short address", func() *httptest.ResponseRecorder {
			c := h.challenge()
			return h.do("POST", "/api/auth/login", login("eth", "0x1234", victim.personalSign(c.Message), c.Nonce))
		}, 400, api.CodeBadRequest},
		{"non-hex signature", func() *httptest.ResponseRecorder {
			c := h.challenge()
			return h.do("POST", "/api/auth/login", login("eth", victim.addr, "0x"+strings.Repeat("zz", 65), c.Nonce))
		}, 400, api.CodeBadRequest},
		{"empty body", func() *httptest.ResponseRecorder { return h.do("POST", "/api/auth/login", "") }, 400, api.CodeBadRequest},
		{"not json", func() *httptest.ResponseRecorder { return h.do("POST", "/api/auth/login", "nonce=1") }, 400, api.CodeBadRequest},
		{"huge body", func() *httptest.ResponseRecorder {
			return h.do("POST", "/api/auth/login", `{"nonce":"`+strings.Repeat("a", 10000)+`"}`)
		}, 413, api.CodeTooLarge},
	}
	for _, a := range attempts {
		w := a.do()
		if w.Code != a.code || errCode(w) != a.err {
			t.Errorf("%s: got %d %s, want %d %s", a.name, w.Code, w.Body.String(), a.code, a.err)
		}
		if len(w.Result().Cookies()) != 0 {
			t.Errorf("%s: a failed login set a cookie", a.name)
		}
	}

	// replay: a good login's nonce is dead afterwards
	c := h.challenge()
	body := login("eth", victim.addr, victim.personalSign(c.Message), c.Nonce)
	if w := h.do("POST", "/api/auth/login", body); w.Code != 200 {
		t.Fatalf("first use: %d", w.Code)
	}
	w := h.do("POST", "/api/auth/login", body)
	if w.Code != 401 || errCode(w) != api.CodeChallengeStale || len(w.Result().Cookies()) != 0 {
		t.Fatalf("replay: %d %s", w.Code, w.Body)
	}
	// a failed attempt also burns the nonce (no guessing against one challenge)
	c = h.challenge()
	h.do("POST", "/api/auth/login", login("eth", victim.addr, attacker.personalSign(c.Message), c.Nonce))
	w = h.do("POST", "/api/auth/login", login("eth", victim.addr, victim.personalSign(c.Message), c.Nonce))
	if w.Code != 401 || errCode(w) != api.CodeChallengeStale {
		t.Fatalf("nonce survived a failed attempt: %d %s", w.Code, w.Body)
	}
}

func TestChallengeExpires(t *testing.T) {
	h := newHarness(t, nil)
	k := newEth(t)
	c := h.challenge()
	h.advance(5*time.Minute + time.Second)
	w := h.do("POST", "/api/auth/login", login("eth", k.addr, k.personalSign(c.Message), c.Nonce))
	if w.Code != 401 || errCode(w) != api.CodeChallengeStale || sessionCookie(w) != nil {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	// still fine just inside the window
	c = h.challenge()
	h.advance(4*time.Minute + 59*time.Second)
	if w := h.do("POST", "/api/auth/login", login("eth", k.addr, k.personalSign(c.Message), c.Nonce)); w.Code != 200 {
		t.Fatalf("inside window: %d %s", w.Code, w.Body)
	}
}

func TestCookieTampering(t *testing.T) {
	h := newHarness(t, nil)
	k, other := newEth(t), newEth(t)
	_, ck := h.loginEth(k)
	userFor := func(val string) (*api.User, error) {
		r := httptest.NewRequest("GET", "/x", nil)
		r.AddCookie(&http.Cookie{Name: CookieName, Value: val})
		return h.svc.UserFrom(r)
	}
	if u, err := userFor(ck.Value); err != nil || u == nil {
		t.Fatalf("genuine cookie: %v", err)
	}
	payload, sig, _ := strings.Cut(ck.Value, ".")

	forge := func(uid string, secret []byte) string {
		other := &Service{o: Options{Secret: secret}}
		return other.makeCookieValue(uid, h.now.Add(time.Hour))
	}
	bad := map[string]string{
		"empty":             "",
		"no dot":            payload,
		"no signature":      payload + ".",
		"garbage":           "!!!.???",
		"signature flipped": payload + "." + flip(sig),
		"payload flipped":   flip(payload) + "." + sig,
		"payload of another user, original signature": swapUID(t, payload, "eip155:"+other.addr) + "." + sig,
		"forged with another secret":                  forge("eip155:"+other.addr, []byte("a-completely-different-secret!!")),
		"forged with an empty secret":                 forge("eip155:"+other.addr, []byte{0}),
		"valid HMAC over a malformed uid":             forge("root", h.opts.Secret),
		"valid HMAC over an uppercase address":        forge("eip155:0x"+strings.Repeat("A", 40), h.opts.Secret),
		"valid HMAC over a short ed25519 key":         forge("ed25519:abcd", h.opts.Secret),
		"payload and signature swapped":               sig + "." + payload,
	}
	for name, val := range bad {
		u, err := userFor(val)
		if val == "" {
			if u != nil || err != nil { // an empty cookie is no credential at all
				t.Errorf("%s: %+v %v", name, u, err)
			}
			continue
		}
		if u != nil {
			t.Errorf("%s: cookie accepted for %+v", name, u)
		}
		if err == nil {
			t.Errorf("%s: no error for an invalid cookie", name)
		} else if ae, ok := err.(*api.Error); !ok || ae.Status != 401 {
			t.Errorf("%s: error %v is not a 401", name, err)
		}
	}
	// the secret really is what protects it: the same service with the same secret accepts a forgery
	if u, err := userFor(forge("eip155:"+other.addr, h.opts.Secret)); err != nil || u == nil {
		t.Fatalf("sanity: a cookie made with the right secret should verify: %v", err)
	}
	// and /me treats a bad cookie as signed out (and clears it)
	me := h.do("GET", "/api/auth/me", nil, func(r *http.Request) { r.AddCookie(&http.Cookie{Name: CookieName, Value: payload + "." + flip(sig)}) })
	if strings.TrimSpace(me.Body.String()) != `{"user":null}` {
		t.Fatalf("me with a forged cookie: %s", me.Body)
	}
	if c := sessionCookie(me); c == nil || c.MaxAge >= 0 {
		t.Fatal("a forged cookie should be cleared")
	}
}

func flip(s string) string {
	b := []byte(s)
	if b[len(b)/2] == 'A' {
		b[len(b)/2] = 'B'
	} else {
		b[len(b)/2] = 'A'
	}
	return string(b)
}

func swapUID(t *testing.T, payloadB64, uid string) string {
	t.Helper()
	raw, err := decodeB64(payloadB64)
	if err != nil {
		t.Fatal(err)
	}
	var cp cookiePayload
	json.Unmarshal(raw, &cp)
	cp.U = uid
	out, _ := json.Marshal(cp)
	return encodeB64(out)
}

func TestCookieExpiry(t *testing.T) {
	h := newHarness(t, nil)
	_, ck := h.loginEth(newEth(t))
	r := httptest.NewRequest("GET", "/x", nil)
	r.AddCookie(&http.Cookie{Name: CookieName, Value: ck.Value})
	h.advance(7*24*time.Hour - time.Minute)
	if u, err := h.svc.UserFrom(r); err != nil || u == nil {
		t.Fatalf("just before expiry: %v", err)
	}
	h.advance(2 * time.Minute)
	u, err := h.svc.UserFrom(r)
	if u != nil || err == nil || !strings.Contains(err.Error(), "expired") {
		t.Fatalf("after expiry: %+v %v", u, err)
	}
}

func TestSecretMatters(t *testing.T) {
	a := newHarness(t, nil)
	_, ck := a.loginEth(newEth(t))
	b := newHarness(t, func(o *Options) { o.Secret = []byte("fedcba9876543210fedcba9876543210") })
	r := httptest.NewRequest("GET", "/x", nil)
	r.AddCookie(&http.Cookie{Name: CookieName, Value: ck.Value})
	if u, err := b.svc.UserFrom(r); u != nil || err == nil {
		t.Fatalf("a cookie from another secret was accepted: %+v", u)
	}
	if _, err := New(Options{Secret: []byte("short")}); err == nil {
		t.Fatal("a short secret must be refused")
	}
}

func TestLogout(t *testing.T) {
	h := newHarness(t, nil)
	w := h.do("POST", "/api/auth/logout", nil)
	c := sessionCookie(w)
	if w.Code != 200 || c == nil || c.MaxAge >= 0 || c.Value != "" {
		t.Fatalf("logout: %d %+v", w.Code, c)
	}
}

func TestTokens(t *testing.T) {
	h := newHarness(t, nil)
	k, other := newEth(t), newEth(t)
	_, ck := h.loginEth(k)
	_, ck2 := h.loginEth(other)

	// anonymous cannot mint; a bearer token cannot mint more
	if w := h.do("POST", "/api/auth/token", nil); w.Code != 401 || errCode(w) != api.CodeAuthRequired {
		t.Fatalf("anon mint: %d %s", w.Code, w.Body)
	}
	mint := func(c *http.Cookie) string {
		w := h.do("POST", "/api/auth/token", nil, withCookie(c))
		if w.Code != 200 {
			t.Fatalf("mint: %d %s", w.Code, w.Body)
		}
		var out struct{ Token string }
		json.Unmarshal(w.Body.Bytes(), &out)
		return out.Token
	}
	tok := mint(ck)
	if !strings.HasPrefix(tok, "btw_") || len(tok) != 4+43 {
		t.Fatalf("token shape %q (%d)", tok, len(tok))
	}
	if w := h.do("POST", "/api/auth/token", nil, withBearer(tok)); w.Code != 401 {
		t.Fatalf("a token minted a token: %d", w.Code)
	}

	// accepted wherever the cookie is
	r := httptest.NewRequest("GET", "/x", nil)
	r.Header.Set("Authorization", "Bearer "+tok)
	u, err := h.svc.UserFrom(r)
	if err != nil || u == nil || u.ID != "eip155:"+k.addr || u.Via != "token" {
		t.Fatalf("bearer: %+v %v", u, err)
	}
	if u := h.svc.UserFromToken(tok); u == nil || u.ID != "eip155:"+k.addr {
		t.Fatalf("UserFromToken: %+v", u)
	}
	me := h.do("GET", "/api/auth/me", nil, withBearer(tok))
	if !strings.Contains(me.Body.String(), k.addr) {
		t.Fatalf("me via token: %s", me.Body)
	}

	// unknown / malformed tokens
	for _, bad := range []string{"btw_" + strings.Repeat("A", 43), "btw_", tok + "x", tok[:len(tok)-1]} {
		r := httptest.NewRequest("GET", "/x", nil)
		r.Header.Set("Authorization", "Bearer "+bad)
		if u, err := h.svc.UserFrom(r); u != nil || err == nil {
			t.Errorf("token %q: %+v %v", bad, u, err)
		}
		if h.svc.UserFromToken(bad) != nil {
			t.Errorf("UserFromToken accepted %q", bad)
		}
	}
	// another scheme's bearer (the admin token) is not ours: anonymous, no error
	r = httptest.NewRequest("GET", "/x", nil)
	r.Header.Set("Authorization", "Bearer some-admin-token")
	if u, err := h.svc.UserFrom(r); u != nil || err != nil {
		t.Fatalf("foreign bearer: %+v %v", u, err)
	}
	// a bad cookie beside a good bearer: the bearer wins
	r = httptest.NewRequest("GET", "/x", nil)
	r.AddCookie(&http.Cookie{Name: CookieName, Value: "x.y"})
	r.Header.Set("Authorization", "Bearer "+tok)
	if u, err := h.svc.UserFrom(r); err != nil || u == nil || u.Via != "token" {
		t.Fatalf("bad cookie + good bearer: %+v %v", u, err)
	}

	// only the hash is stored, in a 0600 file
	b, err := os.ReadFile(filepath.Join(h.dir, "tokens.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), tok) || strings.Contains(string(b), tok[4:]) || !strings.Contains(string(b), hashToken(tok)) {
		t.Fatalf("tokens.json should hold the SHA-256 only: %s", b)
	}
	if st, _ := os.Stat(filepath.Join(h.dir, "tokens.json")); st.Mode().Perm() != 0o600 {
		t.Fatalf("tokens.json mode %v", st.Mode())
	}

	// restart: the token survives
	svc2, err := New(h.opts)
	if err != nil {
		t.Fatal(err)
	}
	if svc2.UserFromToken(tok) == nil {
		t.Fatal("token lost over a restart")
	}

	// max 5 per user: the sixth mint drops the oldest
	toks := []string{tok}
	for i := 0; i < 5; i++ {
		h.advance(time.Second)
		toks = append(toks, mint(ck))
	}
	if h.svc.TokenCount("eip155:"+k.addr) != 5 {
		t.Fatalf("count %d", h.svc.TokenCount("eip155:"+k.addr))
	}
	if h.svc.UserFromToken(toks[0]) != nil {
		t.Fatal("the oldest token should have been dropped")
	}
	for _, tk := range toks[1:] {
		if h.svc.UserFromToken(tk) == nil {
			t.Fatal("a newer token was dropped")
		}
	}

	// the other user's token is untouched by this user's revoke-all
	otherTok := mint(ck2)
	w := h.do("DELETE", "/api/auth/token", nil, withBearer(toks[1]))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"revoked":5`) {
		t.Fatalf("revoke: %d %s", w.Code, w.Body)
	}
	for _, tk := range toks[1:] {
		if h.svc.UserFromToken(tk) != nil {
			t.Fatal("a revoked token still works")
		}
	}
	if h.svc.UserFromToken(otherTok) == nil {
		t.Fatal("revoking one user's tokens revoked another's")
	}
	if w := h.do("DELETE", "/api/auth/token", nil); w.Code != 401 {
		t.Fatalf("anonymous revoke: %d", w.Code)
	}
}

func TestRateLimitHook(t *testing.T) {
	var buckets []string
	h := newHarness(t, func(o *Options) {
		o.Allow = func(r *http.Request, bucket string) (bool, int) {
			buckets = append(buckets, bucket)
			return bucket != "login", 17
		}
	})
	if w := h.do("GET", "/api/auth/challenge", nil); w.Code != 200 {
		t.Fatal(w.Code)
	}
	w := h.do("POST", "/api/auth/login", login("eth", "0x", "0x", "x"))
	if w.Code != 429 || w.Header().Get("Retry-After") != "17" || errCode(w) != api.CodeRateLimited {
		t.Fatalf("%d %v %s", w.Code, w.Header(), w.Body)
	}
	if strings.Join(buckets, ",") != "challenge,login" {
		t.Fatalf("buckets %v", buckets)
	}
}

func TestChallengeFloodIsBounded(t *testing.T) {
	h := newHarness(t, nil)
	for i := 0; i < maxChallenges; i++ {
		h.svc.challenges[randB64(6)] = challenge{expires: h.now.Add(time.Hour)}
	}
	w := h.do("GET", "/api/auth/challenge", nil)
	if w.Code != 503 {
		t.Fatalf("flood: %d", w.Code)
	}
	h.advance(2 * time.Hour) // all expired: the sweep frees room
	if w := h.do("GET", "/api/auth/challenge", nil); w.Code != 200 {
		t.Fatalf("after expiry: %d", w.Code)
	}
}

func TestConcurrentLogins(t *testing.T) {
	h := newHarness(t, nil)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			k := newEth(t)
			c := h.challenge()
			w := h.do("POST", "/api/auth/login", login("eth", k.addr, k.personalSign(c.Message), c.Nonce))
			if w.Code != 200 {
				t.Errorf("%d %s", w.Code, w.Body)
			}
			ck := sessionCookie(w)
			if w := h.do("POST", "/api/auth/token", nil, withCookie(ck)); w.Code != 200 {
				t.Errorf("mint %d", w.Code)
			}
		}()
	}
	wg.Wait()
}

func TestLoadSecret(t *testing.T) {
	dir := t.TempDir()
	a, err := LoadSecret(dir, "")
	if err != nil || len(a) != 32 {
		t.Fatalf("%v %d", err, len(a))
	}
	b, _ := LoadSecret(dir, "")
	if !bytes.Equal(a, b) {
		t.Fatal("the generated secret must persist")
	}
	if st, _ := os.Stat(filepath.Join(dir, "session.secret")); st.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", st.Mode())
	}
	e, err := LoadSecret(dir, "an-env-secret-of-length")
	if err != nil || string(e) != "an-env-secret-of-length" {
		t.Fatalf("env wins: %q %v", e, err)
	}
	if _, err := LoadSecret(dir, "short"); err == nil {
		t.Fatal("short env secret")
	}
	os.WriteFile(filepath.Join(dir, "session.secret"), []byte("not hex"), 0o600)
	if _, err := LoadSecret(dir, ""); err == nil {
		t.Fatal("corrupt secret file must be an error, not silently replaced")
	}
}

var base64RawURL = base64.RawURLEncoding

func decodeB64(s string) ([]byte, error) { return base64RawURL.DecodeString(s) }
func encodeB64(b []byte) string          { return base64RawURL.EncodeToString(b) }

// Package auth is btw.bitwrap.io's sign-in: the wallet identity beats.bitwrap.io already has (an eth
// wallet's EIP-191 personal_sign, or a browser-local Ed25519 key), as a challenge-response that ends in an
// HMAC-signed cookie, plus bearer tokens for MCP and scripts. See btwsite/DESIGN.md "Auth".
//
// Nothing here invents a scheme: signatures are verified by internal/share's verifySignature through the
// one exported wrapper share.VerifyPersonal. A cookie is only ever issued after that verification, and
// is an HMAC-SHA256 over {uid, exp}, so a cookie for a user who did not sign cannot be made without the
// server's secret.
package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
	"beats-bitwrap-io/internal/share"
)

// CookieName is the session cookie.
const CookieName = "btw_session"

// TokenPrefix starts every bearer token.
const TokenPrefix = "btw_"

// Options configures the Service.
type Options struct {
	DataDir string // tokens.json lives here ("" = tokens are kept in memory only)
	Secret  []byte // HMAC key for the cookie; at least 16 bytes
	Secure  bool   // set the Secure cookie attribute (true behind https)
	Origin  string // https://btw.bitwrap.io: the host is named in the challenge message

	CookieTTL        time.Duration // default 7 days
	ChallengeTTL     time.Duration // default 5 minutes
	MaxTokensPerUser int           // default 5; minting one more drops the oldest
	Now              func() time.Time

	// Allow is the per-IP rate limit hook: bucket is "challenge", "login" or "token". When it says no,
	// the request is answered 429 with Retry-After. nil = unlimited.
	Allow func(r *http.Request, bucket string) (ok bool, retryAfterSeconds int)
	// Verify overrides the signature check (default share.VerifyPersonal). Tests only.
	Verify func(msg []byte, typ, address, sigHex string) error
}

// Service is the Authenticator and the /api/auth/* handlers.
type Service struct {
	o      Options
	domain string

	mu         sync.Mutex
	challenges map[string]challenge
	tokens     map[string]tokenRec // sha256 hex -> record
	tokPath    string
}

var _ api.Authenticator = (*Service)(nil)

type challenge struct {
	message string
	expires time.Time
}

type tokenRec struct {
	Hash    string    `json:"hash"`
	User    string    `json:"user"`
	Created time.Time `json:"created"`
}

const maxChallenges = 20000

// New builds the Service. Secret must be set (the server generates and stores one when none is given).
func New(o Options) (*Service, error) {
	if len(o.Secret) < 16 {
		return nil, errors.New("auth: Secret must be at least 16 bytes")
	}
	if o.CookieTTL <= 0 {
		o.CookieTTL = 7 * 24 * time.Hour
	}
	if o.ChallengeTTL <= 0 {
		o.ChallengeTTL = 5 * time.Minute
	}
	if o.MaxTokensPerUser <= 0 {
		o.MaxTokensPerUser = 5
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Verify == nil {
		o.Verify = share.VerifyPersonal
	}
	s := &Service{o: o, domain: "btw.bitwrap.io", challenges: map[string]challenge{}, tokens: map[string]tokenRec{}}
	if u, err := url.Parse(o.Origin); err == nil && u.Host != "" {
		s.domain = u.Host
	}
	if o.DataDir != "" {
		if err := os.MkdirAll(o.DataDir, 0o755); err != nil {
			return nil, err
		}
		s.tokPath = filepath.Join(o.DataDir, "tokens.json")
		if b, err := os.ReadFile(s.tokPath); err == nil {
			var recs []tokenRec
			if err := json.Unmarshal(b, &recs); err != nil {
				return nil, fmt.Errorf("auth: %s is not valid JSON: %v", s.tokPath, err)
			}
			for _, r := range recs {
				s.tokens[r.Hash] = r
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	return s, nil
}

// Mount registers /api/auth/*.
func (s *Service) Mount(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/auth/challenge", s.handleChallenge)
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/auth/logout", s.handleLogout)
	mux.HandleFunc("GET /api/auth/me", s.handleMe)
	mux.HandleFunc("POST /api/auth/token", s.handleTokenCreate)
	mux.HandleFunc("DELETE /api/auth/token", s.handleTokenRevoke)
}

// ---------- identities ----------

var (
	reEth     = regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`)
	reEd      = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)
	reUID     = regexp.MustCompile(`^(eip155:0x[0-9a-f]{40}|ed25519:[0-9a-f]{64})$`)
	reNonce   = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)
	reSigHex  = regexp.MustCompile(`^(0x)?[0-9a-fA-F]+$`)
	errBadKey = errors.New("bad address")
)

// Identity validates typ+address and returns the canonical user: id "eip155:0xabc…" (lower case) or
// "ed25519:<hex>".
func Identity(typ, address string) (*api.User, error) {
	switch typ {
	case "eth":
		if !reEth.MatchString(address) {
			return nil, fmt.Errorf("%w: an eth address is 0x and 40 hex digits", errBadKey)
		}
		a := strings.ToLower(address)
		return &api.User{ID: "eip155:" + a, Kind: "eth", Address: a}, nil
	case "ed25519":
		a := strings.TrimPrefix(strings.TrimPrefix(address, "0x"), "0X")
		if !reEd.MatchString(a) {
			return nil, fmt.Errorf("%w: an ed25519 public key is 64 hex digits", errBadKey)
		}
		a = strings.ToLower(a)
		if smallOrderEd25519(a) {
			return nil, fmt.Errorf("%w: that is not a usable ed25519 public key", errBadKey)
		}
		return &api.User{ID: "ed25519:" + a, Kind: "ed25519", Address: a}, nil
	}
	return nil, fmt.Errorf("%w: type must be eth or ed25519", errBadKey)
}

// smallOrderKeys are the encodings (top bit cleared: it only picks the sign of x) of the points of order
// dividing 8 on edwards25519 and the non-canonical aliases of two of them: libsodium's blocklist. Go's
// ed25519.Verify, like RFC 8032, accepts such a public key, and for one of them a signature that does not
// depend on the message (for the identity point, R = identity and S = 0 verifies for every message), so
// "the owner of that key signed the challenge" would be true of anyone. The key is the user's identity here,
// so those keys are refused: an identity must be somebody's.
var smallOrderKeys = [...]string{
	"0000000000000000000000000000000000000000000000000000000000000000", // order 4
	"0100000000000000000000000000000000000000000000000000000000000000", // the identity
	"26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05", // order 8
	"c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a", // order 8
	"ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", // p-1, order 2
	"edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", // p, an alias of 0
	"eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", // p+1, an alias of 1
}

// smallOrderEd25519 says whether the 64 lower-case hex digits are one of smallOrderKeys.
func smallOrderEd25519(hexKey string) bool {
	raw, err := hex.DecodeString(hexKey)
	if err != nil || len(raw) != 32 {
		return true
	}
	raw[31] &= 0x7f
	k := hex.EncodeToString(raw)
	for _, bad := range smallOrderKeys {
		if k == bad {
			return true
		}
	}
	return false
}

// userFromID rebuilds a User from a validated uid.
func userFromID(id, via string) *api.User {
	if !reUID.MatchString(id) {
		return nil
	}
	if strings.HasPrefix(id, "eip155:") {
		return &api.User{ID: id, Kind: "eth", Address: strings.TrimPrefix(id, "eip155:"), Via: via}
	}
	return &api.User{ID: id, Kind: "ed25519", Address: strings.TrimPrefix(id, "ed25519:"), Via: via}
}

// ---------- cookie ----------

type cookiePayload struct {
	U string `json:"u"`
	E int64  `json:"e"`
}

func (s *Service) sign(payload []byte) []byte {
	m := hmac.New(sha256.New, s.o.Secret)
	m.Write([]byte("btw-session-v1\n"))
	m.Write(payload)
	return m.Sum(nil)
}

// MakeCookieValue is the signed cookie value for uid expiring at exp. Exported for tests that forge
// cookies; the only production caller is login, after verification.
func (s *Service) makeCookieValue(uid string, exp time.Time) string {
	p, _ := json.Marshal(cookiePayload{U: uid, E: exp.Unix()})
	return base64.RawURLEncoding.EncodeToString(p) + "." + base64.RawURLEncoding.EncodeToString(s.sign(p))
}

var errCookie = errors.New("invalid session cookie")

func (s *Service) parseCookieValue(v string) (*api.User, error) {
	a, b, ok := strings.Cut(v, ".")
	if !ok {
		return nil, errCookie
	}
	p, err := base64.RawURLEncoding.DecodeString(a)
	if err != nil {
		return nil, errCookie
	}
	sig, err := base64.RawURLEncoding.DecodeString(b)
	if err != nil || subtle.ConstantTimeCompare(sig, s.sign(p)) != 1 {
		return nil, errCookie
	}
	var cp cookiePayload
	if json.Unmarshal(p, &cp) != nil {
		return nil, errCookie
	}
	if s.o.Now().Unix() >= cp.E {
		return nil, fmt.Errorf("%w: expired", errCookie)
	}
	u := userFromID(cp.U, "cookie")
	if u == nil {
		return nil, errCookie
	}
	return u, nil
}

func (s *Service) setCookie(w http.ResponseWriter, uid string) {
	exp := s.o.Now().Add(s.o.CookieTTL)
	http.SetCookie(w, &http.Cookie{
		Name: CookieName, Value: s.makeCookieValue(uid, exp), Path: "/", Expires: exp,
		MaxAge: int(s.o.CookieTTL.Seconds()), HttpOnly: true, Secure: s.o.Secure, SameSite: http.SameSiteLaxMode,
	})
}

func (s *Service) clearCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: CookieName, Value: "", Path: "/", MaxAge: -1, Expires: time.Unix(0, 0),
		HttpOnly: true, Secure: s.o.Secure, SameSite: http.SameSiteLaxMode})
}

// ---------- api.Authenticator ----------

func authErr(format string, args ...any) *api.Error {
	return api.Errf(http.StatusUnauthorized, api.CodeAuthRequired, format, args...)
}

// UserFrom resolves the caller: the session cookie first, then `Authorization: Bearer btw_…`.
// (nil, nil) is anonymous. An error means a credential of ours was presented and is not good: a
// cookie that fails its HMAC or is expired (and no valid bearer beside it), or an unknown token.
func (s *Service) UserFrom(r *http.Request) (*api.User, error) {
	var cookieErr error
	if c, err := r.Cookie(CookieName); err == nil && c.Value != "" {
		u, err := s.parseCookieValue(c.Value)
		if err == nil {
			return u, nil
		}
		cookieErr = authErr("%v: sign in again", err)
	}
	if h := r.Header.Get("Authorization"); h != "" {
		scheme, tok, _ := strings.Cut(h, " ")
		tok = strings.TrimSpace(tok)
		if strings.EqualFold(scheme, "Bearer") && strings.HasPrefix(tok, TokenPrefix) {
			if u := s.UserFromToken(tok); u != nil {
				return u, nil
			}
			return nil, authErr("unknown or revoked token")
		}
	}
	if cookieErr != nil {
		return nil, cookieErr
	}
	return nil, nil
}

func hashToken(tok string) string {
	h := sha256.Sum256([]byte(tok))
	return hex.EncodeToString(h[:])
}

// UserFromToken resolves a bearer token ("btw_…").
func (s *Service) UserFromToken(token string) *api.User {
	if !strings.HasPrefix(token, TokenPrefix) || len(token) > 200 {
		return nil
	}
	s.mu.Lock()
	rec, ok := s.tokens[hashToken(token)]
	s.mu.Unlock()
	if !ok {
		return nil
	}
	return userFromID(rec.User, "token")
}

// ---------- handlers ----------

func noStore(w http.ResponseWriter) { w.Header().Set("Cache-Control", "no-store") }

func writeJSON(w http.ResponseWriter, status int, v any) {
	noStore(w)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// crossSite says whether a browser started this request from another origin. The session cookie is
// SameSite=Lax, which keeps it off cross-site POSTs but not off requests from a sibling subdomain, and
// sign-in itself sets a cookie, so a page on any other origin could otherwise make a visitor's browser sign
// in as the page's author (login CSRF) and from then on report its editor to sessions that author owns.
// Browsers always send Origin on a POST and DELETE (and Sec-Fetch-Site everywhere current); a client with
// neither (curl, the MCP clients, scripts) is not a browser acting for somebody else and passes.
func (s *Service) crossSite(r *http.Request) bool {
	if o := r.Header.Get("Origin"); o != "" {
		u, err := url.Parse(o)
		if err != nil || u.Host == "" {
			return true // "null" (a sandboxed frame, a no-referrer form post) and anything unreadable
		}
		h := strings.ToLower(u.Host)
		return h != strings.ToLower(r.Host) && h != strings.ToLower(s.domain)
	}
	switch r.Header.Get("Sec-Fetch-Site") {
	case "cross-site", "same-site":
		return true
	}
	return false
}

// refuseCrossSite answers 403 for a request a browser started from another origin.
func (s *Service) refuseCrossSite(w http.ResponseWriter, r *http.Request) bool {
	if !s.crossSite(r) {
		return false
	}
	api.WriteError(w, api.Errf(http.StatusForbidden, "cross_site", "this request came from another site; sign-in and tokens are only for this site's own page"))
	return true
}

func (s *Service) allow(w http.ResponseWriter, r *http.Request, bucket string) bool {
	if s.o.Allow == nil {
		return true
	}
	ok, retry := s.o.Allow(r, bucket)
	if ok {
		return true
	}
	e := api.Errf(http.StatusTooManyRequests, api.CodeRateLimited, "too many %s requests; slow down", bucket)
	e.RetryAfter = max(retry, 1)
	api.WriteError(w, e)
	return false
}

func randB64(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err) // the OS has no entropy: nothing sane to do
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func (s *Service) handleChallenge(w http.ResponseWriter, r *http.Request) {
	if !s.allow(w, r, "challenge") {
		return
	}
	now := s.o.Now().UTC()
	exp := now.Add(s.o.ChallengeTTL)
	nonce := randB64(24)
	msg := fmt.Sprintf("%s sign-in\nnonce: %s\nissued: %s\nexpires: %s", s.domain, nonce, now.Format(time.RFC3339), exp.Format(time.RFC3339))
	s.mu.Lock()
	if len(s.challenges) >= maxChallenges {
		for k, c := range s.challenges {
			if now.After(c.expires) {
				delete(s.challenges, k)
			}
		}
		if len(s.challenges) >= maxChallenges { // under a flood, refuse rather than grow
			s.mu.Unlock()
			e := api.Errf(http.StatusServiceUnavailable, "busy", "too many sign-ins in flight; try again shortly")
			e.RetryAfter = 30
			api.WriteError(w, e)
			return
		}
	}
	s.challenges[nonce] = challenge{message: msg, expires: exp}
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"nonce": nonce, "message": msg, "expires": exp.Format(time.RFC3339)})
}

type loginReq struct {
	Type      string `json:"type"`
	Address   string `json:"address"`
	Signature string `json:"signature"`
	Nonce     string `json:"nonce"`
}

func readJSON(w http.ResponseWriter, r *http.Request, max int64, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, max)
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(v); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			api.WriteError(w, api.Errf(http.StatusRequestEntityTooLarge, api.CodeTooLarge, "request body over %d bytes", max))
		} else {
			api.WriteError(w, api.Errf(http.StatusBadRequest, api.CodeBadRequest, "body must be JSON: %v", err))
		}
		return false
	}
	return true
}

func (s *Service) handleLogin(w http.ResponseWriter, r *http.Request) {
	if s.refuseCrossSite(w, r) {
		return
	}
	if !s.allow(w, r, "login") {
		return
	}
	var req loginReq
	if !readJSON(w, r, 4096, &req) {
		return
	}
	user, err := Identity(req.Type, req.Address)
	if err != nil {
		api.WriteError(w, api.Errf(http.StatusBadRequest, api.CodeBadRequest, "%v", err))
		return
	}
	if !reNonce.MatchString(req.Nonce) {
		api.WriteError(w, api.Errf(http.StatusBadRequest, api.CodeBadRequest, "nonce is missing or malformed"))
		return
	}
	if len(req.Signature) < 100 || len(req.Signature) > 140 || !reSigHex.MatchString(req.Signature) {
		api.WriteError(w, api.Errf(http.StatusBadRequest, api.CodeBadRequest, "signature must be hex (eth: 65 bytes, ed25519: 64)"))
		return
	}
	// single use: the nonce is gone whether or not the signature turns out good
	s.mu.Lock()
	ch, ok := s.challenges[req.Nonce]
	delete(s.challenges, req.Nonce)
	s.mu.Unlock()
	if !ok || s.o.Now().After(ch.expires) {
		api.WriteError(w, api.Errf(http.StatusUnauthorized, api.CodeChallengeStale, "that challenge is unknown, used or expired; ask for a new one"))
		return
	}
	if err := s.o.Verify([]byte(ch.message), req.Type, user.Address, req.Signature); err != nil {
		api.WriteError(w, api.Errf(http.StatusUnauthorized, api.CodeBadSignature, "the signature does not verify for that address"))
		return
	}
	s.setCookie(w, user.ID)
	user.Via = "cookie"
	writeJSON(w, http.StatusOK, map[string]any{"user": user})
}

func (s *Service) handleLogout(w http.ResponseWriter, r *http.Request) {
	if s.refuseCrossSite(w, r) {
		return
	}
	s.clearCookie(w)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Service) handleMe(w http.ResponseWriter, r *http.Request) {
	u, err := s.UserFrom(r)
	if err != nil { // a stale or forged credential is just "not signed in" here
		if _, cerr := r.Cookie(CookieName); cerr == nil {
			s.clearCookie(w)
		}
		u = nil
	}
	if u == nil {
		writeJSON(w, http.StatusOK, map[string]any{"user": nil})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": u})
}

func (s *Service) handleTokenCreate(w http.ResponseWriter, r *http.Request) {
	if s.refuseCrossSite(w, r) {
		return
	}
	if !s.allow(w, r, "token") {
		return
	}
	// the cookie is required: a token cannot be used to mint more tokens
	var u *api.User
	if c, err := r.Cookie(CookieName); err == nil {
		u, _ = s.parseCookieValue(c.Value)
	}
	if u == nil {
		api.WriteError(w, authErr("sign in (with the session cookie) to create a token"))
		return
	}
	tok := TokenPrefix + randB64(32) // 32 bytes -> 43 base64url characters
	rec := tokenRec{Hash: hashToken(tok), User: u.ID, Created: s.o.Now().UTC()}
	s.mu.Lock()
	s.tokens[rec.Hash] = rec
	var mine []tokenRec
	for _, t := range s.tokens {
		if t.User == u.ID {
			mine = append(mine, t)
		}
	}
	for len(mine) > s.o.MaxTokensPerUser { // drop the oldest
		oldest := 0
		for i, t := range mine {
			if t.Created.Before(mine[oldest].Created) {
				oldest = i
			}
		}
		delete(s.tokens, mine[oldest].Hash)
		mine = append(mine[:oldest], mine[oldest+1:]...)
	}
	err := s.saveLocked()
	s.mu.Unlock()
	if err != nil {
		api.WriteError(w, fmt.Errorf("could not store the token: %v", err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"token": tok, "max_per_user": s.o.MaxTokensPerUser})
}

func (s *Service) handleTokenRevoke(w http.ResponseWriter, r *http.Request) {
	if s.refuseCrossSite(w, r) {
		return
	}
	u, err := s.UserFrom(r)
	if err != nil || u == nil {
		api.WriteError(w, authErr("sign in to revoke your tokens"))
		return
	}
	s.mu.Lock()
	n := 0
	for h, t := range s.tokens {
		if t.User == u.ID {
			delete(s.tokens, h)
			n++
		}
	}
	err = s.saveLocked()
	s.mu.Unlock()
	if err != nil {
		api.WriteError(w, fmt.Errorf("could not store the change: %v", err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"revoked": n})
}

// saveLocked writes tokens.json atomically (0600). Callers hold s.mu.
func (s *Service) saveLocked() error {
	if s.tokPath == "" {
		return nil
	}
	recs := make([]tokenRec, 0, len(s.tokens))
	for _, t := range s.tokens {
		recs = append(recs, t)
	}
	b, err := json.MarshalIndent(recs, "", " ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.tokPath), ".tokens-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), s.tokPath)
}

// TokenCount reports how many tokens a user has (tests, /api/info never exposes it).
func (s *Service) TokenCount(uid string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, t := range s.tokens {
		if t.User == uid {
			n++
		}
	}
	return n
}

// LoadSecret returns the cookie HMAC key: fromEnv (BTW_SESSION_SECRET) when set, else the key kept in
// dataDir/session.secret (0600), generated on first use.
func LoadSecret(dataDir, fromEnv string) ([]byte, error) {
	if fromEnv != "" {
		if len(fromEnv) < 16 {
			return nil, errors.New("BTW_SESSION_SECRET must be at least 16 characters")
		}
		return []byte(fromEnv), nil
	}
	if dataDir == "" {
		b := make([]byte, 32)
		_, err := rand.Read(b)
		return b, err // process-lifetime key: sessions end with the process
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, err
	}
	p := filepath.Join(dataDir, "session.secret")
	if b, err := os.ReadFile(p); err == nil {
		raw, err := hex.DecodeString(strings.TrimSpace(string(b)))
		if err == nil && len(raw) >= 16 {
			return raw, nil
		}
		return nil, fmt.Errorf("%s is not a hex key of 16+ bytes; delete it to generate a new one", p)
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return nil, err
	}
	if err := os.WriteFile(p, []byte(hex.EncodeToString(raw)+"\n"), 0o600); err != nil {
		return nil, err
	}
	return raw, nil
}

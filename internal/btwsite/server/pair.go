package server

// Pairing a phone (djandroid, se.vevr.djandroid) with btw.bitwrap.io by scanning a QR code.
// The protocol, its threat model and the phone's side are in btwsite/PAIRING.md; keep the two in step.
//
// In short: a signed-in page asks for an offer (POST /api/pair) and shows its QR, which holds only
// https://<host>/pair#<pair id>.<token>: a single-use token that lives two minutes. The phone makes (once)
// an Ed25519 device key, and claims the offer by signing the claim with it (POST /api/pair/claim). The
// server then records the device's PUBLIC key under the page's user (the wallet or browser-key identity
// that signed in), and from then on every request from the phone is signed with that key
// (`Authorization: BtwDevice <device>.<ts>.<sig>`). Nothing secret is ever stored on the server or carried
// in the QR beyond the one-shot token; the phone's secret key never leaves the phone.
//
// A paired phone is a session of the hub (sessions.go) owned by the user, so everything that drives a
// browser session (MCP eval / load / stop / get, the page's "Play on phone") drives the phone too.

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	qrcode "github.com/skip2/go-qrcode"

	"beats-bitwrap-io/internal/btwsite/api"
)

const (
	pairProto         = "btw-pair/1"
	pairTTL           = 2 * time.Minute
	maxOffersPerUser  = 3
	maxDevicesPerUser = 8
	maxDevices        = 10000
	deviceSkew        = 2 * time.Minute // how far a signed request's ts may be from the server's clock
	maxDeviceName     = 64
	maxClaimBytes     = 4 << 10
)

// pairOffer is one QR code: waiting for a phone, then paired (or used up).
type pairOffer struct {
	id        string
	owner     string
	tokenHash [32]byte
	created   time.Time
	expires   time.Time
	state     string // waiting | paired | used
	device    string
}

// device is a paired phone. Key is its Ed25519 public key (base64url, 32 bytes): the only credential, and
// not a secret.
type device struct {
	ID     string `json:"id"`
	Owner  string `json:"owner"`
	Name   string `json:"name"`
	Key    string `json:"key"`
	Paired string `json:"paired"`
}

// pairing holds the open offers (memory only) and the paired devices (<data>/devices.json).
type pairing struct {
	mu      sync.Mutex
	path    string
	now     func() time.Time
	offers  map[string]*pairOffer
	devices map[string]*device
	seen    map[string]time.Time // request signatures used in the skew window: a replayed request is refused
}

func newPairing(dataDir string, now func() time.Time) (*pairing, error) {
	p := &pairing{path: filepath.Join(dataDir, "devices.json"), now: now,
		offers: map[string]*pairOffer{}, devices: map[string]*device{}, seen: map[string]time.Time{}}
	b, err := os.ReadFile(p.path)
	switch {
	case errors.Is(err, os.ErrNotExist):
		return p, nil
	case err != nil:
		return nil, err
	}
	var list []*device
	if err := json.Unmarshal(b, &list); err != nil {
		return nil, fmt.Errorf("%s: %v", p.path, err)
	}
	for _, d := range list {
		if _, err := decodeKey(d.Key); err == nil && d.ID != "" && d.Owner != "" {
			p.devices[d.ID] = d
		}
	}
	return p, nil
}

// saveLocked writes devices.json atomically (0600: it says who owns which phone).
func (p *pairing) saveLocked() error {
	list := make([]*device, 0, len(p.devices))
	for _, d := range p.devices {
		list = append(list, d)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
	b, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}
	tmp := p.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p.path)
}

func (p *pairing) sweepLocked(now time.Time) {
	for id, o := range p.offers {
		if now.After(o.expires.Add(pairTTL)) { // keep a while after expiry, so the page can still read "expired"
			delete(p.offers, id)
		}
	}
	for sig, at := range p.seen {
		if now.Sub(at) > 2*deviceSkew {
			delete(p.seen, sig)
		}
	}
}

func decodeKey(s string) (ed25519.PublicKey, error) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil, errors.New("key must be a base64url Ed25519 public key (32 bytes)")
	}
	return ed25519.PublicKey(b), nil
}

// KeyFingerprint is what both ends show so a person can see they paired the same phone: the first 8 hex
// digits of sha256(public key), as "ab12 cd34".
func KeyFingerprint(key string) string {
	b, err := base64.RawURLEncoding.DecodeString(key)
	if err != nil {
		return ""
	}
	h := sha256.Sum256(b)
	x := hex.EncodeToString(h[:4])
	return x[:4] + " " + x[4:]
}

func sha256Hex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// ClaimMessage is the text a phone signs to claim an offer. host is the server's public host; token is
// hashed into it, so the signature is useless without the token and the token alone cannot pair a key.
func ClaimMessage(host, pairID, token, key, name string, ts int64) string {
	return fmt.Sprintf("%s claim\nhost: %s\npair: %s\ntoken: %s\nkey: %s\nname: %s\nts: %d",
		pairProto, host, pairID, sha256Hex([]byte(token)), key, name, ts)
}

// RequestMessage is the text a paired phone signs for every request.
func RequestMessage(host, deviceID, method, path string, ts int64, body []byte) string {
	return fmt.Sprintf("%s request\nhost: %s\ndevice: %s\nmethod: %s\npath: %s\nts: %d\nbody: %s",
		pairProto, host, deviceID, method, path, ts, sha256Hex(body))
}

func (s *Server) publicHost() string {
	if u, err := url.Parse(s.cfg.PublicURL); err == nil && u.Host != "" {
		return strings.ToLower(u.Host)
	}
	return "btw.bitwrap.io"
}

// crossSite: a browser request started from another origin (the same rule as auth's, for the cookie routes
// that change who may drive what).
func (s *Server) crossSite(r *http.Request) bool {
	if o := r.Header.Get("Origin"); o != "" {
		u, err := url.Parse(o)
		if err != nil || u.Host == "" {
			return true
		}
		h := strings.ToLower(u.Host)
		return h != strings.ToLower(r.Host) && h != s.publicHost()
	}
	switch r.Header.Get("Sec-Fetch-Site") {
	case "cross-site", "same-site":
		return true
	}
	return false
}

func (s *Server) refuseCrossSite(w http.ResponseWriter, r *http.Request) bool {
	if !s.crossSite(r) {
		return false
	}
	api.WriteError(w, api.Errf(http.StatusForbidden, "cross_site", "this request came from another site; pairing is only for this site's own page"))
	return true
}

func (s *Server) pairRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /pair", s.handlePairPage)
	mux.HandleFunc("POST /api/pair", s.handlePairNew)
	mux.HandleFunc("GET /api/pair/{id}", s.handlePairState)
	mux.HandleFunc("POST /api/pair/claim", s.handlePairClaim)
	mux.HandleFunc("GET /api/devices", s.handleDevices)
	mux.HandleFunc("DELETE /api/devices/{id}", s.handleDeviceUnpair)
	mux.HandleFunc("POST /api/devices/{id}/push", s.handleDevicePush)
	mux.HandleFunc("GET /api/device", s.handleDeviceMe)
	mux.HandleFunc("DELETE /api/device", s.handleDeviceForget)
	mux.HandleFunc("GET /api/device/events", s.handleDeviceEvents)
	mux.HandleFunc("POST /api/device/report", s.handleDeviceReport)
	mux.HandleFunc("POST /api/device/reply", s.handleDeviceReply)
	mux.HandleFunc("POST /api/device/compose", s.handleDeviceCompose)
}

// handlePairPage answers a pairing QR code opened in a browser (a phone's camera app follows the link):
// the code is for djrust's own scanner. The token is in the fragment, so it never reaches this server.
func (s *Server) handlePairPage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	_, _ = io.WriteString(w, pairPageHTML)
}

const pairPageHTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Pair a phone with btw</title><link rel="stylesheet" href="/css/btw.css"></head>
<body><main class="pair-page">
<h1>This is a pairing code for djrust</h1>
<p>Open <b>djrust</b> on your Android phone, tap the menu, then <b>btw.bitwrap.io</b> and <b>Scan to connect</b>, and scan the code again from there.</p>
<p>A phone camera app cannot pair: the code is only for djrust's own scanner, and it works once, for two minutes.</p>
<p><a href="/">Back to btw.bitwrap.io</a></p>
</main></body></html>
`

// ---------- the page: make an offer, watch it, list and unpair devices, push to one ----------

func (s *Server) handlePairNew(w http.ResponseWriter, r *http.Request) {
	if s.refuseCrossSite(w, r) {
		return
	}
	u, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	if ok, retry := s.pairIP.Allow(ClientIP(r)); !limited(w, ok, retry, "pair") {
		return
	}
	p := s.pair
	now := s.now()
	tokenB := make([]byte, 16)
	if _, err := rand.Read(tokenB); err != nil {
		panic(err)
	}
	token := base64.RawURLEncoding.EncodeToString(tokenB)
	o := &pairOffer{id: newID(), owner: u.ID, tokenHash: sha256.Sum256([]byte(token)), created: now,
		expires: now.Add(pairTTL), state: "waiting"}
	p.mu.Lock()
	p.sweepLocked(now)
	var open []*pairOffer
	for _, x := range p.offers {
		if x.owner == u.ID && x.state == "waiting" && now.Before(x.expires) {
			open = append(open, x)
		}
	}
	sort.Slice(open, func(i, j int) bool { return open[i].created.Before(open[j].created) })
	for len(open) >= maxOffersPerUser { // a page that asks again: the oldest QR stops working
		open[0].state = "used"
		open = open[1:]
	}
	p.offers[o.id] = o
	p.mu.Unlock()

	link := s.cfg.PublicURL + "/pair#" + o.id + "." + token
	png, err := qrcode.Encode(link, qrcode.Medium, 320)
	if err != nil {
		api.WriteError(w, api.Errf(http.StatusInternalServerError, "internal", "could not draw the QR code: %v", err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"pair_id":    o.id,
		"url":        link,
		"qr":         "data:image/png;base64," + base64.StdEncoding.EncodeToString(png),
		"expires":    o.expires.UTC().Format(time.RFC3339),
		"expires_in": int(pairTTL / time.Second),
		"protocol":   pairProto,
	})
}

func (s *Server) handlePairState(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	p := s.pair
	now := s.now()
	p.mu.Lock()
	o, found := p.offers[r.PathValue("id")]
	if !found || o.owner != u.ID {
		p.mu.Unlock()
		api.WriteError(w, api.Errf(http.StatusNotFound, api.CodeNotFound, "no such pairing code (or it is not yours)"))
		return
	}
	state := o.state
	if state == "waiting" && !now.Before(o.expires) {
		state = "expired"
	}
	out := map[string]any{"pair_id": o.id, "state": state, "expires": o.expires.UTC().Format(time.RFC3339)}
	if d := p.devices[o.device]; d != nil && state == "paired" {
		out["device"] = s.deviceView(d)
	}
	p.mu.Unlock()
	writeJSON(w, http.StatusOK, out)
}

// deviceView is what the page sees of a device (p.mu held or not: it reads only d and the hub).
func (s *Server) deviceView(d *device) map[string]any {
	v := map[string]any{"id": d.ID, "name": d.Name, "fingerprint": KeyFingerprint(d.Key), "paired": d.Paired}
	connected, last, st := s.hub.deviceStatus(d.ID)
	v["connected"] = connected
	if !last.IsZero() {
		v["last_seen"] = last.UTC().Format(time.RFC3339)
	}
	if st != nil {
		v["state"] = map[string]any{"cid": st.CID, "playing": st.Playing, "section": st.Section, "bar": st.Bar, "ts": st.TS}
	}
	return v
}

func (s *Server) handleDevices(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	p := s.pair
	p.mu.Lock()
	var list []*device
	for _, d := range p.devices {
		if d.Owner == u.ID {
			list = append(list, d)
		}
	}
	p.mu.Unlock()
	sort.Slice(list, func(i, j int) bool { return list[i].Paired > list[j].Paired })
	out := make([]map[string]any, 0, len(list))
	for _, d := range list {
		out = append(out, s.deviceView(d))
	}
	writeJSON(w, http.StatusOK, map[string]any{"devices": out})
}

func (s *Server) handleDeviceUnpair(w http.ResponseWriter, r *http.Request) {
	if s.refuseCrossSite(w, r) {
		return
	}
	u, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	if !s.unpair(r.PathValue("id"), u.ID, "unpaired on "+s.publicHost()) {
		api.WriteError(w, api.Errf(http.StatusNotFound, api.CodeNotFound, "no such device (or it is not yours)"))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// unpair forgets a device (owner "" = any owner) and tells its open stream.
func (s *Server) unpair(id, owner, why string) bool {
	p := s.pair
	p.mu.Lock()
	d, ok := p.devices[id]
	if !ok || (owner != "" && d.Owner != owner) {
		p.mu.Unlock()
		return false
	}
	delete(p.devices, id)
	err := p.saveLocked()
	p.mu.Unlock()
	if err != nil {
		s.cfg.Logf("pair: saving devices: %v", err)
	}
	s.hub.dropDevice(id, why)
	return true
}

// handleDevicePush is the page's "Play on phone" / "Stop the phone": the same checks MCP's eval makes.
func (s *Server) handleDevicePush(w http.ResponseWriter, r *http.Request) {
	if s.refuseCrossSite(w, r) {
		return
	}
	u, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	var body struct {
		Type string `json:"type"` // eval | load | stop
		Text string `json:"text"`
		Play bool   `json:"play"`
	}
	if !decodeBody(w, r, int64(s.cfg.MaxProgramBytes)+4096, &body) {
		return
	}
	p := s.pair
	p.mu.Lock()
	d, found := p.devices[r.PathValue("id")]
	p.mu.Unlock()
	if !found || d.Owner != u.ID {
		api.WriteError(w, api.Errf(http.StatusNotFound, api.CodeNotFound, "no such device (or it is not yours)"))
		return
	}
	ev := api.SessionEvent{Type: body.Type, Play: body.Play}
	switch body.Type {
	case "stop":
	case "eval", "load":
		if strings.TrimSpace(body.Text) == "" {
			api.WriteError(w, api.Errf(http.StatusBadRequest, api.CodeBadRequest, "text is required"))
			return
		}
		if len(body.Text) > s.cfg.MaxProgramBytes {
			api.WriteError(w, api.Errf(http.StatusRequestEntityTooLarge, api.CodeTooLarge, "the program is over %d bytes", s.cfg.MaxProgramBytes))
			return
		}
		rep, err := s.checker.Check(r.Context(), body.Text)
		if err != nil {
			api.WriteError(w, err)
			return
		}
		switch {
		case !rep.OK:
			api.WriteError(w, api.Errf(http.StatusUnprocessableEntity, api.CodeBadRequest, "the program has errors; nothing was sent to the phone"))
			return
		case rep.Restricted || rep.UsesAssets:
			api.WriteError(w, api.Errf(http.StatusUnprocessableEntity, api.CodeRestricted, "a private or asset-using program is not sent to a phone"))
			return
		}
		ev.CID = rep.CID
		ev.Text = body.Text
		if body.Type == "load" {
			ev.Text = rep.Canonical
		}
	default:
		api.WriteError(w, api.Errf(http.StatusBadRequest, api.CodeBadRequest, "type must be eval, load or stop"))
		return
	}
	if !s.hub.pushDevice(d.ID, ev) {
		api.WriteError(w, api.Errf(http.StatusConflict, api.CodeNoSession, "%s is paired but not connected: open djrust on the phone", d.Name))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"delivered": 1, "cid": ev.CID})
}

// ---------- the phone: claim, then signed requests ----------

type claimBody struct {
	Proto  string `json:"proto"`
	PairID string `json:"pair_id"`
	Token  string `json:"token"`
	Key    string `json:"key"`
	Name   string `json:"name"`
	TS     int64  `json:"ts"` // unix milliseconds
	Sig    string `json:"sig"`
}

func validDeviceName(n string) bool {
	if n == "" || len(n) > maxDeviceName || !utf8.ValidString(n) {
		return false
	}
	for _, r := range n {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

func (s *Server) handlePairClaim(w http.ResponseWriter, r *http.Request) {
	if ok, retry := s.claimIP.Allow(ClientIP(r)); !limited(w, ok, retry, "pair claim") {
		return
	}
	var c claimBody
	if !decodeBody(w, r, maxClaimBytes, &c) {
		return
	}
	bad := func(code int, kind, msg string) { api.WriteError(w, api.Errf(code, kind, "%s", msg)) }
	if c.Proto != pairProto {
		bad(http.StatusBadRequest, api.CodeBadRequest, "proto must be "+pairProto)
		return
	}
	key, err := decodeKey(c.Key)
	if err != nil {
		bad(http.StatusBadRequest, api.CodeBadRequest, err.Error())
		return
	}
	if !validDeviceName(c.Name) {
		bad(http.StatusBadRequest, api.CodeBadRequest, fmt.Sprintf("name must be 1..%d printable characters", maxDeviceName))
		return
	}
	now := s.now()
	if d := time.UnixMilli(c.TS).Sub(now); d > deviceSkew || d < -deviceSkew {
		bad(http.StatusUnauthorized, api.CodeChallengeStale, "the phone's clock is too far from the server's (set it automatically and scan again)")
		return
	}
	sig, err := base64.RawURLEncoding.DecodeString(c.Sig)
	if err != nil || !ed25519.Verify(key, []byte(ClaimMessage(s.publicHost(), c.PairID, c.Token, c.Key, c.Name, c.TS)), sig) {
		bad(http.StatusUnauthorized, api.CodeBadSignature, "the claim's signature does not verify")
		return
	}

	p := s.pair
	p.mu.Lock()
	p.sweepLocked(now)
	o, found := p.offers[c.PairID]
	if !found {
		p.mu.Unlock()
		bad(http.StatusNotFound, api.CodeNotFound, "this QR code is unknown or too old: show a new one and scan again")
		return
	}
	th := sha256.Sum256([]byte(c.Token))
	switch {
	case o.state != "waiting":
		p.mu.Unlock()
		bad(http.StatusGone, "pair_used", "this QR code was already used: show a new one and scan again")
		return
	case !now.Before(o.expires):
		p.mu.Unlock()
		bad(http.StatusGone, "pair_expired", "this QR code expired: show a new one and scan again")
		return
	case subtle.ConstantTimeCompare(th[:], o.tokenHash[:]) != 1:
		o.state = "used" // any wrong token burns the code
		p.mu.Unlock()
		bad(http.StatusUnauthorized, api.CodeBadSignature, "the QR code's token does not match: show a new one and scan again")
		return
	}
	// One device record per key: a phone that pairs again (re-pair, or with another account) replaces it.
	var replaced []string
	for id, d := range p.devices {
		if d.Key == c.Key {
			replaced = append(replaced, id)
			delete(p.devices, id)
		}
	}
	n := 0
	var oldest *device
	for _, d := range p.devices {
		if d.Owner == o.owner {
			n++
			if oldest == nil || d.Paired < oldest.Paired {
				oldest = d
			}
		}
	}
	if n >= maxDevicesPerUser {
		replaced = append(replaced, oldest.ID)
		delete(p.devices, oldest.ID)
	}
	if len(p.devices) >= maxDevices {
		p.mu.Unlock()
		bad(http.StatusServiceUnavailable, api.CodeBusy, "too many paired devices on this server")
		return
	}
	d := &device{ID: newID(), Owner: o.owner, Name: c.Name, Key: c.Key, Paired: now.UTC().Format(time.RFC3339)}
	p.devices[d.ID] = d
	o.state, o.device = "paired", d.ID
	err = p.saveLocked()
	p.mu.Unlock()
	if err != nil {
		s.cfg.Logf("pair: saving devices: %v", err)
	}
	for _, id := range replaced {
		s.hub.dropDevice(id, "paired again")
	}
	writeJSON(w, http.StatusOK, s.deviceHello(d))
}

// deviceHello is what the phone learns of its pairing: also the first event of its stream.
func (s *Server) deviceHello(d *device) map[string]any {
	owner := d.Owner
	addr := owner
	if i := strings.IndexByte(owner, ':'); i >= 0 {
		addr = owner[i+1:]
	}
	return map[string]any{
		"proto":       pairProto,
		"device_id":   d.ID,
		"name":        d.Name,
		"fingerprint": KeyFingerprint(d.Key),
		"user":        owner,
		"address":     addr,
		"server":      s.cfg.PublicURL,
		"events":      "/api/device/events",
	}
}

// deviceFrom authenticates a phone's request: `Authorization: BtwDevice <device>.<ts>.<sig>`, sig an Ed25519
// signature of RequestMessage. The body (if any) is read, hashed and given back.
func (s *Server) deviceFrom(w http.ResponseWriter, r *http.Request, maxBody int64) (*device, []byte, bool) {
	fail := func(msg string) (*device, []byte, bool) {
		api.WriteError(w, api.Errf(http.StatusUnauthorized, "device_auth", "%s", msg))
		return nil, nil, false
	}
	h := r.Header.Get("Authorization")
	const scheme = "BtwDevice "
	if !strings.HasPrefix(h, scheme) {
		return fail("this route is for a paired phone (Authorization: BtwDevice …)")
	}
	parts := strings.Split(strings.TrimSpace(h[len(scheme):]), ".")
	if len(parts) != 3 {
		return fail("malformed BtwDevice credential")
	}
	ts, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return fail("malformed BtwDevice credential")
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(sig) != ed25519.SignatureSize {
		return fail("malformed BtwDevice credential")
	}
	var body []byte
	if r.Body != nil && maxBody > 0 {
		body, err = io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
		if err != nil {
			api.WriteError(w, api.Errf(http.StatusRequestEntityTooLarge, api.CodeTooLarge, "request body is over %d bytes", maxBody))
			return nil, nil, false
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
	}
	now := s.now()
	if d := time.UnixMilli(ts).Sub(now); d > deviceSkew || d < -deviceSkew {
		return fail("the phone's clock is too far from the server's")
	}
	p := s.pair
	p.mu.Lock()
	defer p.mu.Unlock()
	d, ok := p.devices[parts[0]]
	if !ok {
		api.WriteError(w, api.Errf(http.StatusGone, "unpaired", "this phone is not paired (any more): scan a new code"))
		return nil, nil, false
	}
	key, _ := decodeKey(d.Key)
	if !ed25519.Verify(key, []byte(RequestMessage(s.publicHost(), d.ID, r.Method, r.URL.Path, ts, body)), sig) {
		return fail("the request's signature does not verify")
	}
	p.sweepLocked(now)
	if _, dup := p.seen[parts[2]]; dup {
		return fail("this request was already made (replay)")
	}
	p.seen[parts[2]] = now
	if ri := infoOf(r); ri != nil {
		ri.user = d.Owner
	}
	cp := *d
	return &cp, body, true
}

func (s *Server) handleDeviceMe(w http.ResponseWriter, r *http.Request) {
	d, _, ok := s.deviceFrom(w, r, 0)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, s.deviceHello(d))
}

func (s *Server) handleDeviceForget(w http.ResponseWriter, r *http.Request) {
	d, _, ok := s.deviceFrom(w, r, 0)
	if !ok {
		return
	}
	s.unpair(d.ID, "", "unpaired on the phone")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleDeviceEvents(w http.ResponseWriter, r *http.Request) {
	d, _, ok := s.deviceFrom(w, r, 0)
	if !ok {
		return
	}
	ipKey := api.IPKey(ClientIP(r))
	if !s.hub.streams.acquire(ipKey, maxStreamsPerIP) {
		e := api.Errf(http.StatusTooManyRequests, api.CodeRateLimited, "too many open streams from your address")
		e.RetryAfter = 30
		api.WriteError(w, e)
		return
	}
	defer s.hub.streams.release(ipKey)
	sid, sub, err := s.hub.subscribeDevice(d.Owner, d.ID)
	if err != nil {
		api.WriteError(w, err)
		return
	}
	defer s.hub.unsubscribe(sid, sub)
	extra, _ := json.Marshal(s.deviceHello(d))
	s.streamEvents(w, r, sub, &api.SessionEvent{Type: "hello", Extra: extra})
}

func (s *Server) handleDeviceReport(w http.ResponseWriter, r *http.Request) {
	d, body, ok := s.deviceFrom(w, r, maxReportBytes)
	if !ok {
		return
	}
	var st api.SessionState
	if err := json.Unmarshal(body, &st); err != nil {
		api.WriteError(w, api.Errf(http.StatusBadRequest, api.CodeBadRequest, "the body must be JSON: %v", err))
		return
	}
	sid := s.hub.deviceSessionID(d.Owner, d.ID)
	if sid == "" {
		api.WriteError(w, api.Errf(http.StatusConflict, api.CodeNoSession, "open the event stream first"))
		return
	}
	ok, lim := s.hub.report(sid, &api.User{ID: d.Owner}, st)
	switch {
	case !ok:
		api.WriteError(w, errNoSession())
	case lim:
		e := api.Errf(http.StatusTooManyRequests, api.CodeRateLimited, "reporting too fast")
		e.RetryAfter = 1
		api.WriteError(w, e)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

func (s *Server) handleDeviceReply(w http.ResponseWriter, r *http.Request) {
	d, body, ok := s.deviceFrom(w, r, maxReportBytes)
	if !ok {
		return
	}
	var rb struct {
		RequestID string           `json:"request_id"`
		State     api.SessionState `json:"state"`
	}
	if err := json.Unmarshal(body, &rb); err != nil || rb.RequestID == "" {
		api.WriteError(w, api.Errf(http.StatusBadRequest, api.CodeBadRequest, "body must be {request_id, state}"))
		return
	}
	sid := s.hub.deviceSessionID(d.Owner, d.ID)
	if sid == "" || !s.hub.reply(sid, &api.User{ID: d.Owner}, rb.RequestID, rb.State) {
		api.WriteError(w, errNoSession())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---------- the hub's side of a device ----------

// deviceSessionID is the hub session of a device, or "".
func (h *hub) deviceSessionID(owner, dev string) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	if s := h.deviceLocked(dev); s != nil && s.owner == owner {
		return s.id
	}
	return ""
}

func (h *hub) deviceLocked(dev string) *session {
	for _, s := range h.sessions {
		if s.device == dev {
			return s
		}
	}
	return nil
}

// subscribeDevice finds or makes the device's session (owned by owner) and attaches a stream to it.
func (h *hub) subscribeDevice(owner, dev string) (string, *subscriber, *api.Error) {
	h.mu.Lock()
	s := h.deviceLocked(dev)
	if s != nil && s.owner != owner { // paired again with someone else: start clean
		h.dropLocked(s)
		s = nil
	}
	h.mu.Unlock()
	var id string
	if s != nil {
		id = s.id
	} else {
		var err error
		id, err = h.create(owner)
		if err != nil {
			var ae *api.Error
			if errors.As(err, &ae) {
				return "", nil, ae
			}
			return "", nil, api.Errf(http.StatusServiceUnavailable, api.CodeBusy, "%v", err)
		}
		h.mu.Lock()
		if ns := h.sessions[id]; ns != nil {
			ns.device = dev
		}
		h.mu.Unlock()
	}
	sub, err := h.subscribe(id, &api.User{ID: owner})
	if err != nil {
		return "", nil, err
	}
	return id, sub, nil
}

// pushDevice sends ev to the device's open stream; false when it has none.
func (h *hub) pushDevice(dev string, ev api.SessionEvent) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.deviceLocked(dev)
	if s == nil {
		return false
	}
	return h.deliverLocked(s, ev)
}

// dropDevice tells the device's stream it is unpaired and ends its session.
func (h *hub) dropDevice(dev, why string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.deviceLocked(dev)
	if s == nil {
		return
	}
	extra, _ := json.Marshal(map[string]string{"reason": why})
	h.deliverLocked(s, api.SessionEvent{Type: "unpaired", Extra: extra})
	h.dropLocked(s)
}

// deviceStatus: whether the device has a live stream, when it was last seen, its last report.
func (h *hub) deviceStatus(dev string) (bool, time.Time, *api.SessionState) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.deviceLocked(dev)
	if s == nil {
		return false, time.Time{}, nil
	}
	var st *api.SessionState
	if s.state != nil {
		cp := *s.state
		st = &cp
	}
	return len(s.subs) > 0, s.lastSeen, st
}

// ---------- api.Devices: MCP's view of the paired phones ----------

var _ api.Devices = (*Server)(nil)

// ownedDevices is u's devices, most recently paired first.
func (s *Server) ownedDevices(owner string) []*device {
	p := s.pair
	p.mu.Lock()
	var list []*device
	for _, d := range p.devices {
		if d.Owner == owner {
			cp := *d
			list = append(list, &cp)
		}
	}
	p.mu.Unlock()
	sort.Slice(list, func(i, j int) bool { return list[i].Paired > list[j].Paired })
	return list
}

// Devices implements api.Devices.
func (s *Server) Devices(u *api.User) []api.DeviceInfo {
	if u == nil {
		return nil
	}
	out := []api.DeviceInfo{}
	for _, d := range s.ownedDevices(u.ID) {
		di := api.DeviceInfo{ID: d.ID, Name: d.Name, Fingerprint: KeyFingerprint(d.Key), Paired: d.Paired}
		connected, last, st := s.hub.deviceStatus(d.ID)
		di.Connected, di.State = connected, st
		if !last.IsZero() {
			di.LastSeen = last.UTC().Format(time.RFC3339)
		}
		if connected {
			di.Session = s.hub.deviceSessionID(d.Owner, d.ID)
		}
		out = append(out, di)
	}
	return out
}

// DeviceSession implements api.Devices.
func (s *Server) DeviceSession(u *api.User, deviceID string) (string, error) {
	if u == nil {
		return "", api.Errf(http.StatusUnauthorized, api.CodeAuthRequired, "driving a paired phone needs a signed-in caller")
	}
	p := s.pair
	p.mu.Lock()
	d, ok := p.devices[deviceID]
	var name, owner string
	if ok {
		name, owner = d.Name, d.Owner
	}
	p.mu.Unlock()
	if !ok || owner != u.ID {
		return "", api.Errf(http.StatusNotFound, api.CodeNotFound, "no paired phone has id %q on this account; call devices", deviceID)
	}
	if connected, _, _ := s.hub.deviceStatus(deviceID); !connected {
		return "", api.Errf(http.StatusConflict, api.CodeNoSession, "%s is paired but not connected: open djrust on the phone", name)
	}
	sid := s.hub.deviceSessionID(owner, deviceID)
	if sid == "" {
		return "", api.Errf(http.StatusConflict, api.CodeNoSession, "%s is paired but not connected: open djrust on the phone", name)
	}
	return sid, nil
}

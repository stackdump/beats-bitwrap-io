package share

// Content-addressed store for share-v1 payloads. A `PUT /o/{cid}` accepts
// canonical-JSON bytes, re-hashes them to a CIDv1 (dag-json / sha2-256 /
// base58btc), and writes the file only when the computed CID matches the
// path. `GET /o/{cid}` serves whatever was stored. Same CID algorithm as
// the browser client (public/petri-note.js) so either side can address
// a payload by hash without trusting the other.

import (
	"archive/tar"
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v5"
)

const (
	maxShareBytes = 256 * 1024  // defensive cap — typical payload < 10kB
	base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
)

var cidPattern = regexp.MustCompile(`^z[1-9A-HJ-NP-Za-km-z]{40,80}$`)

// encodeBase58 matches the browser client path in petri-note.js.
func encodeBase58(in []byte) string {
	num := new(big.Int).SetBytes(in)
	zero := big.NewInt(0)
	base := big.NewInt(58)
	mod := new(big.Int)
	var out []byte
	for num.Cmp(zero) > 0 {
		num.DivMod(num, base, mod)
		out = append([]byte{base58Alphabet[mod.Int64()]}, out...)
	}
	for i := 0; i < len(in) && in[i] == 0; i++ {
		out = append([]byte{'1'}, out...)
	}
	return string(out)
}

// computeCid: SHA-256 → CIDv1 (version 0x01, dag-json varint 0xa9 0x02,
// mh 0x12 len 0x20) → base58btc with 'z' multibase prefix.
func computeCid(body []byte) string {
	h := sha256.Sum256(body)
	buf := make([]byte, 0, 4+len(h))
	buf = append(buf, 0x01)         // CIDv1
	buf = append(buf, 0xa9, 0x02)   // dag-json (0x0129) varint
	buf = append(buf, 0x12, 0x20)   // sha2-256 multihash prefix (len 32)
	buf = append(buf, h[:]...)
	return "z" + encodeBase58(buf)
}

type Store struct {
	// contentType pins the URL prefix, disk subdir, and schema for this
	// store instance. Set once at construction; never mutated. Defaults
	// to ShareType for backward compat (NewStore preserves the original
	// /o/{cid} signature); use NewStoreForType to mount a /c/{cid}
	// composition store.
	contentType *ContentType

	dir            string
	maxBytes       int64
	putPerMin      int
	globalPerMin   int

	// ipKey is a process-lifetime random HMAC key used to anonymize client
	// IPs before they enter the rate-limit map. We never store raw IPs —
	// the map key is HMAC-SHA256(ipKey, rawIP) truncated to 16 bytes. The
	// key is regenerated every process start, so even a memory dump of a
	// running instance can't be correlated to other services or back to a
	// subscriber once the process has been restarted.
	ipKey [32]byte

	mu       sync.Mutex
	curBytes int64                // total bytes currently on disk under dir/o/
	ipHits   map[string]*ipBucket // hashed-IP → fixed 1-min PUT counter
	global   ipBucket             // all-IP fixed 1-min PUT counter
	index    map[string]string    // cid → absolute file path (rebuilt at startup)

	// onSeal callbacks run after a successful new write (HTTP PUT or
	// in-process Seal). Idempotent re-PUTs of an already-stored CID do
	// NOT fire callbacks. Use for side effects like background audio
	// rendering. Callbacks run synchronously on the seal path — keep
	// them non-blocking (spawn a goroutine if needed).
	onSeal []func(cid string)

	// rebuildSecret gates `source: "official"` claims on the PUT path.
	// An envelope claiming source=official without an X-Rebuild-Secret
	// header that constant-time-compares to this value is rejected
	// (403). Empty disables operator-source attestations entirely
	// (server still admits anonymous + signed envelopes). Set via
	// SetRebuildSecret after construction so the constructor signature
	// stays stable.
	rebuildSecret string
}

// SetRebuildSecret enables operator-source validation. Call once at
// startup after NewStore. Empty value (default) disables source claims:
// any envelope with source=official will be rejected unconditionally.
func (s *Store) SetRebuildSecret(secret string) { s.rebuildSecret = secret }

// OnSeal registers a callback that fires after a NEW canonical-JSON
// payload is sealed under cid. Re-PUTs of an already-stored CID don't
// fire — only first writes do. Callbacks run on the seal goroutine, so
// they should be cheap (e.g. hand off to a worker pool).
func (s *Store) OnSeal(cb func(cid string)) {
	s.mu.Lock()
	s.onSeal = append(s.onSeal, cb)
	s.mu.Unlock()
}

// AllCIDs returns a snapshot of every CID currently in the store, in
// arbitrary order. Used by the archive endpoint to enumerate the
// catalogue for offline rendering — small enough to return inline
// (CID strings are ~62 bytes; even 100k CIDs is ~6 MB which the worker
// can paginate through).
func (s *Store) AllCIDs() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.index))
	for cid := range s.index {
		out = append(out, cid)
	}
	return out
}

// Snapshot streams a tar archive of every envelope in the store to
// the writer. Each entry is named "o/{cid}.json" so a snapshot can be
// extended with sibling trees (e.g. audio/) without ambiguity.
// Suitable to be wrapped in gzip on the way out.
//
// Returns (count, totalBytes, error). Partial-write errors abort
// mid-stream — the client sees a truncated tar and should retry.
func (s *Store) Snapshot(tw *tar.Writer) (int, int64, error) {
	s.mu.Lock()
	paths := make(map[string]string, len(s.index))
	for cid, p := range s.index {
		paths[cid] = p
	}
	s.mu.Unlock()
	var (
		count int
		total int64
	)
	for cid, p := range paths {
		body, err := os.ReadFile(p)
		if err != nil {
			// Skip files that vanished between snapshot start and now
			// (a delete races a snapshot). Don't abort — finishing the
			// rest of the catalogue matters more than perfect parity.
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return count, total, fmt.Errorf("snapshot read %s: %w", cid, err)
		}
		hdr := &tar.Header{
			Name:    s.contentType.DiskSub + "/" + cid + ".json",
			Mode:    0o644,
			Size:    int64(len(body)),
			ModTime: time.Now(),
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return count, total, fmt.Errorf("snapshot tar header %s: %w", cid, err)
		}
		if _, err := tw.Write(body); err != nil {
			return count, total, fmt.Errorf("snapshot tar body %s: %w", cid, err)
		}
		count++
		total += int64(len(body))
	}
	return count, total, nil
}

// Delete removes the on-disk envelope for cid and drops it from the
// in-memory index. Idempotent — returns nil if the CID was already
// absent. Caller is responsible for cascading cleanup (audio cache,
// rendered-track index row, rebuild_queue rows). Auth is the caller's
// problem too: this method has no built-in gate.
func (s *Store) Delete(cid string) error {
	s.mu.Lock()
	path, ok := s.index[cid]
	if !ok {
		s.mu.Unlock()
		return nil
	}
	delete(s.index, cid)
	s.mu.Unlock()
	if info, err := os.Stat(path); err == nil {
		s.mu.Lock()
		s.curBytes -= info.Size()
		if s.curBytes < 0 {
			s.curBytes = 0
		}
		s.mu.Unlock()
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		// Path was indexed but file is gone or permissions broken —
		// reinstate the index entry so a subsequent retry can resolve.
		s.mu.Lock()
		s.index[cid] = path
		s.mu.Unlock()
		return fmt.Errorf("share: delete %s: %w", cid, err)
	}
	return nil
}

// fireOnSeal invokes registered callbacks. Caller must NOT hold s.mu.
func (s *Store) fireOnSeal(cid string) {
	s.mu.Lock()
	cbs := append([]func(string){}, s.onSeal...)
	s.mu.Unlock()
	for _, cb := range cbs {
		cb(cid)
	}
}

type ipBucket struct {
	windowStart time.Time
	count       int
}

// NewStore constructs a content-addressed store for BeatsShare envelopes
// at /o/{cid}. Preserves the original signature so existing callers
// (main.go, tests) keep working unchanged. Use NewStoreForType to mount
// other content types (e.g. BeatsComposition at /c/{cid}).
func NewStore(dir string, maxBytes int64, putPerMin, globalPerMin int) (*Store, error) {
	return NewStoreForType(ShareType, dir, maxBytes, putPerMin, globalPerMin)
}

// NewStoreForType constructs a Store pinned to a specific ContentType.
// Each type lives under its own subdirectory (ct.DiskSub) of the shared
// data root, so two stores can safely share the same dir without colliding.
func NewStoreForType(ct *ContentType, dir string, maxBytes int64, putPerMin, globalPerMin int) (*Store, error) {
	if ct == nil {
		return nil, errors.New("share: nil content type")
	}
	if dir == "" {
		return nil, errors.New("empty store dir")
	}
	if err := os.MkdirAll(filepath.Join(dir, ct.DiskSub), 0o755); err != nil {
		return nil, err
	}
	s := &Store{
		contentType:  ct,
		dir:          dir,
		maxBytes:     maxBytes,
		putPerMin:    putPerMin,
		globalPerMin: globalPerMin,
		ipHits:       map[string]*ipBucket{},
		index:        map[string]string{},
	}
	if _, err := rand.Read(s.ipKey[:]); err != nil {
		return nil, fmt.Errorf("seed ip-anon key: %w", err)
	}
	// Prime curBytes + CID→path index by walking the store once at startup.
	// Filenames are bare CIDs (no extension) regardless of bucket depth, so
	// the base name is authoritative — we don't need to reconstruct dates.
	root := filepath.Join(dir, ct.DiskSub)
	_ = filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil || info == nil || info.IsDir() {
			return nil
		}
		name := filepath.Base(p)
		if strings.HasSuffix(name, ".tmp") || !cidPattern.MatchString(name) {
			return nil
		}
		s.curBytes += info.Size()
		s.index[name] = p
		return nil
	})
	return s, nil
}

// bucketPath returns the on-disk location for a CID — bucketed by the
// current year/month so no single directory accumulates more than a
// month's worth of writes. Only used for NEW writes; reads go through
// the CID→path index so historical payloads in any bucket still resolve.
func (s *Store) bucketPath(cid string) string {
	now := time.Now().UTC()
	return filepath.Join(s.dir, s.contentType.DiskSub,
		fmt.Sprintf("%04d", now.Year()),
		fmt.Sprintf("%02d", int(now.Month())),
		cid)
}

// anonIP hashes a raw client IP under the process-lifetime HMAC key so the
// rate-limit map never holds identifiable addresses. 16 hex bytes of output
// is ample collision resistance for a 512-entry bucket set.
func (s *Store) anonIP(ip string) string {
	m := hmac.New(sha256.New, s.ipKey[:])
	m.Write([]byte(ip))
	sum := m.Sum(nil)
	return hex.EncodeToString(sum[:16])
}

// rateLimitOK: two-tier fixed-window counter — reject when either the
// per-IP or the global 1-minute PUT budget is exhausted. Good enough for
// a low-traffic share store; not a DDoS defence. Returns a reason string
// when rejected so the caller can surface it in the 429 body. `ip` must
// already be the anonymized key from anonIP.
func (s *Store) rateLimitOK(ip string) (bool, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()

	// Global budget — rolls every minute, caps aggregate write rate regardless
	// of source IP so a distributed flood can't bypass the per-IP cap.
	if s.globalPerMin > 0 {
		if now.Sub(s.global.windowStart) >= time.Minute {
			s.global = ipBucket{windowStart: now, count: 0}
		}
		if s.global.count >= s.globalPerMin {
			return false, "global rate limit exceeded"
		}
	}

	// Per-IP budget.
	b := s.ipHits[ip]
	if b == nil || now.Sub(b.windowStart) >= time.Minute {
		s.ipHits[ip] = &ipBucket{windowStart: now, count: 1}
		// Opportunistic GC: wipe stale buckets so the map can't grow unboundedly.
		if len(s.ipHits) > 512 {
			for k, v := range s.ipHits {
				if now.Sub(v.windowStart) >= time.Minute {
					delete(s.ipHits, k)
				}
			}
		}
		s.global.count++
		return true, ""
	}
	if b.count >= s.putPerMin {
		return false, "rate limit exceeded"
	}
	b.count++
	s.global.count++
	return true, ""
}

// RateLimitPUT consumes one PUT slot from the same two-tier budget that
// gates /o/{cid} writes. Used by adjacent write paths (e.g. /audio/{cid}.webm
// uploads) so abuse caps are unified across content types. Returns false +
// reason when the per-IP or global window is exhausted.
func (s *Store) RateLimitPUT(r *http.Request) (bool, string) {
	return s.rateLimitOK(s.anonIP(clientIP(r)))
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.Index(xff, ","); i > 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (s *Store) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	cid := strings.TrimPrefix(r.URL.Path, s.contentType.URLPrefix)
	if !cidPattern.MatchString(cid) {
		http.Error(w, "invalid cid", http.StatusBadRequest)
		return
	}
	switch r.Method {
	case http.MethodGet:
		s.get(w, cid)
	case http.MethodPut:
		s.put(w, r, cid)
	case http.MethodOptions:
		return
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Store) get(w http.ResponseWriter, cid string) {
	data, err := s.lookup(cid)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		log.Printf("share store read %s: %v", cid, err)
		http.Error(w, "read failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/ld+json")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Write(data)
}

// lookup returns the raw canonical-JSON bytes for a stored CID, or
// os.ErrNotExist if the CID isn't in the index. Shared by the HTTP GET
// path and the server-side share-card / decorated-index renderer.
func (s *Store) lookup(cid string) ([]byte, error) {
	s.mu.Lock()
	path, ok := s.index[cid]
	s.mu.Unlock()
	if !ok {
		return nil, os.ErrNotExist
	}
	return os.ReadFile(path)
}

func (s *Store) put(w http.ResponseWriter, r *http.Request, cid string) {
	if ok, reason := s.rateLimitOK(s.anonIP(clientIP(r))); !ok {
		w.Header().Set("Retry-After", "60")
		http.Error(w, reason, http.StatusTooManyRequests)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxShareBytes+1))
	if err != nil {
		http.Error(w, "read failed", http.StatusBadRequest)
		return
	}
	if len(body) > maxShareBytes {
		http.Error(w, "payload too large", http.StatusRequestEntityTooLarge)
		return
	}
	computed := computeCid(body)
	if computed != cid {
		http.Error(w, "cid mismatch", http.StatusBadRequest)
		return
	}
	if err := s.validatePayload(body); err != nil {
		http.Error(w, "invalid payload: "+err.Error(), http.StatusBadRequest)
		return
	}
	// Provenance (source / signer / signature) is BeatsShare-specific.
	// Composition envelopes don't carry those fields.
	if s.contentType == ShareType {
		if err := s.validateProvenance(body, r.Header.Get("X-Rebuild-Secret")); err != nil {
			http.Error(w, "provenance: "+err.Error(), http.StatusForbidden)
			return
		}
	}
	// Idempotent: if the index already has the CID, skip the write entirely.
	// Also enforce the global disk cap — content-addressed writes are
	// immutable, so we only admit new payloads while there's headroom.
	s.mu.Lock()
	if _, exists := s.index[cid]; exists {
		s.mu.Unlock()
		w.WriteHeader(http.StatusOK)
		return
	}
	if s.curBytes+int64(len(body)) > s.maxBytes {
		s.mu.Unlock()
		http.Error(w, "share store full", http.StatusInsufficientStorage)
		return
	}
	s.mu.Unlock()
	// New writes land in the current year/month bucket.
	path := s.bucketPath(cid)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		log.Printf("share store mkdir %s: %v", cid, err)
		http.Error(w, "write failed", http.StatusInternalServerError)
		return
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		log.Printf("share store write %s: %v", cid, err)
		http.Error(w, "write failed", http.StatusInternalServerError)
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		log.Printf("share store rename %s: %v", cid, err)
		http.Error(w, "write failed", http.StatusInternalServerError)
		return
	}
	s.mu.Lock()
	s.curBytes += int64(len(body))
	s.index[cid] = path
	s.mu.Unlock()
	s.fireOnSeal(cid)
	w.WriteHeader(http.StatusCreated)
}

// SealDirect is the exported in-process write path. Same validation
// (CID + schema + size cap) as the HTTP PUT, no rate limit. Used by
// the archive-restore endpoint to replay envelopes pulled out of a
// persisted snapshot tarball.
func (s *Store) SealDirect(cid string, body []byte) error {
	return s.sealDirect(cid, body)
}

// sealDirect writes canonical bytes under cid, bypassing HTTP + rate
// limits. Used by in-process callers (the /api/project-share route)
// that already hold authenticated authoring context. Idempotent on
// repeat CIDs. Still validates the payload against the share schema
// and respects the disk cap. In-process callers are responsible for
// gating source=official claims themselves (the route handler should
// check X-Rebuild-Secret before passing source through). Signature
// verification still runs because envelopes can be hand-authored
// before sealDirect is called.
func (s *Store) sealDirect(cid string, body []byte) error {
	if !cidPattern.MatchString(cid) {
		return fmt.Errorf("invalid cid")
	}
	if len(body) > maxShareBytes {
		return fmt.Errorf("payload too large (%d > %d)", len(body), maxShareBytes)
	}
	if computed := computeCid(body); computed != cid {
		return fmt.Errorf("cid mismatch: got %s want %s", computed, cid)
	}
	if err := s.validatePayload(body); err != nil {
		return fmt.Errorf("invalid payload: %w", err)
	}
	// In-process path: source claims are caller-gated (see comment
	// above). Signature verification still runs unconditionally so a
	// hand-authored signed envelope is verified before storage.
	// Provenance fields are BeatsShare-only.
	if s.contentType == ShareType {
		if err := s.validateProvenance(body, s.rebuildSecret); err != nil {
			return fmt.Errorf("provenance: %w", err)
		}
	}
	s.mu.Lock()
	if _, exists := s.index[cid]; exists {
		s.mu.Unlock()
		return nil
	}
	if s.curBytes+int64(len(body)) > s.maxBytes {
		s.mu.Unlock()
		return fmt.Errorf("share store full")
	}
	s.mu.Unlock()
	path := s.bucketPath(cid)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("mkdir: %w", err)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return fmt.Errorf("write tmp: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("rename: %w", err)
	}
	s.mu.Lock()
	s.curBytes += int64(len(body))
	s.index[cid] = path
	s.mu.Unlock()
	s.fireOnSeal(cid)
	return nil
}

// JSON-Schema-driven validation for share-v1 payloads. The schema document
// (public/schema/beats-share.schema.json) is the single source of truth —
// the client can fetch it at /schema/beats-share for docs/validation, and
// the server compiles it once at startup to enforce on every PUT.
//
// Keep in sync with _buildSharePayload in public/petri-note.js.

//go:embed beats-share.schema.json
var shareSchemaBytes []byte

var compiledShareSchema = mustCompileShareSchema()

func mustCompileShareSchema() *jsonschema.Schema {
	c := jsonschema.NewCompiler()
	c.Draft = jsonschema.Draft2020
	const id = "https://beats.bitwrap.io/schema/beats-share.schema.json"
	if err := c.AddResource(id, bytes.NewReader(shareSchemaBytes)); err != nil {
		panic(fmt.Sprintf("compile beats-share schema (add): %v", err))
	}
	s, err := c.Compile(id)
	if err != nil {
		panic(fmt.Sprintf("compile beats-share schema: %v", err))
	}
	return s
}

func validateSharePayload(body []byte) error {
	return validatePayloadFor(ShareType, body)
}

// validatePayload is the type-aware entry point used by HTTP PUT and
// SealDirect on a Store: it validates body against s.contentType.Schema
// and runs any post-decode checks specific to that type.
func (s *Store) validatePayload(body []byte) error {
	return validatePayloadFor(s.contentType, body)
}

func validatePayloadFor(ct *ContentType, body []byte) error {
	var v any
	dec := json.NewDecoder(bytes.NewReader(body))
	if err := dec.Decode(&v); err != nil {
		return fmt.Errorf("not valid JSON: %w", err)
	}
	if err := ct.Schema.Validate(v); err != nil {
		return errors.New(schemaErrorString(err))
	}
	// Per-type post-decode checks. Today only BeatsShare has one
	// (the `note` sanitiser); compositions inherit no post-checks.
	if ct == ShareType {
		if m, ok := v.(map[string]any); ok {
			if raw, ok := m["note"].(string); ok {
				if SanitizeNote(raw) != raw {
					return errors.New("note: must be pre-sanitised (no tags / urls / control chars / leading-trailing space; see SanitizeNote rules)")
				}
			}
		}
	}
	return nil
}

// schemaErrorString flattens a jsonschema ValidationError into a single
// line that still mentions each failing field/property name, so tests and
// error responses remain greppable (e.g. contains "tempo", "seed", etc.).
func schemaErrorString(err error) string {
	ve, ok := err.(*jsonschema.ValidationError)
	if !ok {
		return err.Error()
	}
	var parts []string
	var walk func(*jsonschema.ValidationError)
	walk = func(n *jsonschema.ValidationError) {
		if n.Message != "" {
			loc := n.InstanceLocation
			if loc == "" {
				loc = "/"
			}
			parts = append(parts, fmt.Sprintf("%s: %s", loc, n.Message))
		}
		for _, c := range n.Causes {
			walk(c)
		}
	}
	walk(ve)
	if len(parts) == 0 {
		return ve.Error()
	}
	return strings.Join(parts, "; ")
}

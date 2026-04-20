package main

// Content-addressed store for share-v1 payloads. A `PUT /o/{cid}` accepts
// canonical-JSON bytes, re-hashes them to a CIDv1 (dag-json / sha2-256 /
// base58btc), and writes the file only when the computed CID matches the
// path. `GET /o/{cid}` serves whatever was stored. Same CID algorithm as
// the browser client (public/petri-note.js) so either side can address
// a payload by hash without trusting the other.

import (
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

type shareStore struct {
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
}

type ipBucket struct {
	windowStart time.Time
	count       int
}

func newShareStore(dir string, maxBytes int64, putPerMin, globalPerMin int) (*shareStore, error) {
	if dir == "" {
		return nil, errors.New("empty store dir")
	}
	if err := os.MkdirAll(filepath.Join(dir, "o"), 0o755); err != nil {
		return nil, err
	}
	s := &shareStore{
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
	root := filepath.Join(dir, "o")
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
func (s *shareStore) bucketPath(cid string) string {
	now := time.Now().UTC()
	return filepath.Join(s.dir, "o",
		fmt.Sprintf("%04d", now.Year()),
		fmt.Sprintf("%02d", int(now.Month())),
		cid)
}

// anonIP hashes a raw client IP under the process-lifetime HMAC key so the
// rate-limit map never holds identifiable addresses. 16 hex bytes of output
// is ample collision resistance for a 512-entry bucket set.
func (s *shareStore) anonIP(ip string) string {
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
func (s *shareStore) rateLimitOK(ip string) (bool, string) {
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

func (s *shareStore) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	cid := strings.TrimPrefix(r.URL.Path, "/o/")
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

func (s *shareStore) get(w http.ResponseWriter, cid string) {
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
func (s *shareStore) lookup(cid string) ([]byte, error) {
	s.mu.Lock()
	path, ok := s.index[cid]
	s.mu.Unlock()
	if !ok {
		return nil, os.ErrNotExist
	}
	return os.ReadFile(path)
}

func (s *shareStore) put(w http.ResponseWriter, r *http.Request, cid string) {
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
	if err := validateSharePayload(body); err != nil {
		http.Error(w, "invalid payload: "+err.Error(), http.StatusBadRequest)
		return
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
	w.WriteHeader(http.StatusCreated)
}

// JSON-Schema-driven validation for share-v1 payloads. The schema document
// (public/schema/beats-share.schema.json) is the single source of truth —
// the client can fetch it at /schema/beats-share for docs/validation, and
// the server compiles it once at startup to enforce on every PUT.
//
// Keep in sync with _buildSharePayload in public/petri-note.js.

//go:embed public/schema/beats-share.schema.json
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
	var v any
	dec := json.NewDecoder(bytes.NewReader(body))
	if err := dec.Decode(&v); err != nil {
		return fmt.Errorf("not valid JSON: %w", err)
	}
	if err := compiledShareSchema.Validate(v); err != nil {
		return errors.New(schemaErrorString(err))
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

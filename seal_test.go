package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fixturePayload mirrors a realistic share-v1 payload from the browser.
// Keys are already sorted so the bytes equal what the JS canonicalizer
// would emit — any drift between this fixture and real client output
// will surface as a CID mismatch, which is exactly what we want to test.
const fixturePayload = `{"@context":"https://beats.bitwrap.io/schema/beats-share.context.jsonld","@type":"BeatsShare","fx":{"master-vol":100,"reverb-wet":40},"genre":"techno","humanize":0,"seed":12345,"structure":"classic","swing":14,"tempo":124,"v":1}`

func newTestStore(t *testing.T) (*shareStore, string) {
	t.Helper()
	dir := t.TempDir()
	s, err := newShareStore(dir, 1<<20, 100, 0)
	if err != nil {
		t.Fatalf("newShareStore: %v", err)
	}
	return s, dir
}

// CID computation must be stable across calls — the whole
// content-addressing contract rides on this being deterministic.
func TestComputeCidDeterministic(t *testing.T) {
	a := computeCid([]byte(fixturePayload))
	b := computeCid([]byte(fixturePayload))
	if a != b {
		t.Fatalf("computeCid not deterministic: %s vs %s", a, b)
	}
	if !strings.HasPrefix(a, "z") {
		t.Fatalf("expected base58btc 'z' multibase prefix, got %s", a)
	}
	if !cidPattern.MatchString(a) {
		t.Fatalf("computed CID %q does not match cidPattern", a)
	}
}

// Canonical JSON round-trip: feeding the decoded fixture object through
// canonicalJSON must re-emit the exact fixture bytes, and canonicalCid
// must match computeCid(fixtureBytes). This is the bridge that lets a
// Go-side producer mint CIDs identical to the browser client — if the
// two ever drift, this test fails before a single payload hits the wire.
func TestCanonicalJSONRoundTrip(t *testing.T) {
	var v any
	if err := json.Unmarshal([]byte(fixturePayload), &v); err != nil {
		t.Fatalf("unmarshal fixture: %v", err)
	}
	got, err := canonicalJSON(v)
	if err != nil {
		t.Fatalf("canonicalJSON: %v", err)
	}
	if string(got) != fixturePayload {
		t.Fatalf("canonicalJSON drift:\n got=%s\nwant=%s", got, fixturePayload)
	}
	cidA, _, err := canonicalCid(v)
	if err != nil {
		t.Fatalf("canonicalCid: %v", err)
	}
	cidB := computeCid([]byte(fixturePayload))
	if cidA != cidB {
		t.Fatalf("CID mismatch: canonicalCid=%s computeCid=%s", cidA, cidB)
	}
}

// End-to-end happy path: PUT stores, GET returns the same bytes, a
// second PUT is idempotent, the file lands in the expected YYYY/MM
// bucket, and curBytes is accounted correctly.
func TestPutGetRoundTrip(t *testing.T) {
	s, dir := newTestStore(t)
	cid := computeCid([]byte(fixturePayload))

	// PUT — expect 201.
	putReq := httptest.NewRequest(http.MethodPut, "/o/"+cid, strings.NewReader(fixturePayload))
	putReq.Header.Set("Content-Type", "application/ld+json")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, putReq)
	if rec.Code != http.StatusCreated {
		t.Fatalf("first PUT: got %d, want 201. body=%s", rec.Code, rec.Body)
	}

	// Bucket path must include year/month.
	now := time.Now().UTC()
	wantPath := filepath.Join(dir, "o",
		fmt.Sprintf("%04d", now.Year()),
		fmt.Sprintf("%02d", int(now.Month())),
		cid)
	if _, err := os.Stat(wantPath); err != nil {
		t.Fatalf("expected bucket path %s to exist: %v", wantPath, err)
	}

	// GET — expect 200 and identical bytes.
	getReq := httptest.NewRequest(http.MethodGet, "/o/"+cid, nil)
	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, getReq)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET: got %d, want 200", rec.Code)
	}
	if rec.Body.String() != fixturePayload {
		t.Fatalf("GET body mismatch.\n got=%q\nwant=%q", rec.Body.String(), fixturePayload)
	}

	// Second PUT of the same payload — expect 200 (idempotent short-circuit),
	// not 201, and curBytes must not double-count.
	before := s.curBytes
	putReq = httptest.NewRequest(http.MethodPut, "/o/"+cid, strings.NewReader(fixturePayload))
	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, putReq)
	if rec.Code != http.StatusOK {
		t.Fatalf("second PUT: got %d, want 200 (idempotent). body=%s", rec.Code, rec.Body)
	}
	if s.curBytes != before {
		t.Fatalf("curBytes grew on idempotent PUT: %d → %d", before, s.curBytes)
	}
}

// Schema must accept a payload that carries the new rootNote/scaleName/
// bars key-BARS fields — guards against the card renderer reading blank
// because the envelope was silently rejected.
func TestPutAcceptsKeyAndBarsFields(t *testing.T) {
	s, _ := newTestStore(t)
	body := `{"@context":"https://beats.bitwrap.io/schema/beats-share.context.jsonld","@type":"BeatsShare","bars":60,"genre":"edm","humanize":0,"rootNote":45,"scaleName":"Minor","seed":42,"swing":0,"tempo":138,"v":1}`
	cid := computeCid([]byte(body))
	req := httptest.NewRequest(http.MethodPut, "/o/"+cid, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/ld+json")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("PUT with KEY/BARS fields: got %d, want 201. body=%s", rec.Code, rec.Body)
	}
}

// CID verification: a PUT whose body does not hash to the path CID must
// be rejected. Otherwise the server would happily store anything under
// any name and the content-addressing guarantee evaporates.
func TestPutCidMismatchRejected(t *testing.T) {
	s, _ := newTestStore(t)
	realCid := computeCid([]byte(fixturePayload))
	// Flip one byte in the path's CID so it no longer matches the body hash.
	badCid := realCid[:len(realCid)-1] + flipChar(realCid[len(realCid)-1])
	if badCid == realCid {
		t.Fatalf("test bug: badCid == realCid")
	}
	putReq := httptest.NewRequest(http.MethodPut, "/o/"+badCid, strings.NewReader(fixturePayload))
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, putReq)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got %d, want 400 cid mismatch", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "cid mismatch") {
		t.Fatalf("expected cid mismatch message, got %q", rec.Body.String())
	}
}

// Schema validation: CID matches but payload is not a BeatsShare envelope.
// Server must refuse — otherwise any JSON object could squat on a CID and
// later GETs would return junk the client can't apply.
func TestPutInvalidSchemaRejected(t *testing.T) {
	s, _ := newTestStore(t)
	cases := []struct {
		name string
		body string
		want string // substring that must appear in the error body
	}{
		{"wrong type", `{"@type":"Other","v":1,"genre":"x","seed":1}`, `@type`},
		{"missing seed", `{"@type":"BeatsShare","v":1,"genre":"x"}`, `seed`},
		{"empty genre", `{"@type":"BeatsShare","v":1,"genre":"","seed":1}`, `genre`},
		{"bad version", `{"@type":"BeatsShare","v":2,"genre":"x","seed":1}`, `/v`},
		{"unknown field", `{"@type":"BeatsShare","v":1,"genre":"x","seed":1,"malicious":true}`, `malicious`},
		{"tempo out of range", `{"@type":"BeatsShare","v":1,"genre":"x","seed":1,"tempo":9999}`, `tempo`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cid := computeCid([]byte(tc.body))
			putReq := httptest.NewRequest(http.MethodPut, "/o/"+cid, strings.NewReader(tc.body))
			rec := httptest.NewRecorder()
			s.ServeHTTP(rec, putReq)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("got %d, want 400", rec.Code)
			}
			if !strings.Contains(rec.Body.String(), tc.want) {
				t.Fatalf("expected %q in error, got %q", tc.want, rec.Body.String())
			}
		})
	}
}

// Rate limit: N PUTs/minute from the same IP must succeed, N+1 must 429.
func TestPutRateLimit(t *testing.T) {
	dir := t.TempDir()
	s, err := newShareStore(dir, 1<<20, 3, 0) // 3 PUT/min cap for fast test
	if err != nil {
		t.Fatalf("newShareStore: %v", err)
	}
	bodies := []string{
		`{"@type":"BeatsShare","v":1,"genre":"a","seed":1}`,
		`{"@type":"BeatsShare","v":1,"genre":"b","seed":2}`,
		`{"@type":"BeatsShare","v":1,"genre":"c","seed":3}`,
		`{"@type":"BeatsShare","v":1,"genre":"d","seed":4}`,
	}
	for i, body := range bodies {
		cid := computeCid([]byte(body))
		putReq := httptest.NewRequest(http.MethodPut, "/o/"+cid, strings.NewReader(body))
		putReq.RemoteAddr = "10.0.0.1:1234"
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, putReq)
		if i < 3 && rec.Code != http.StatusCreated {
			t.Fatalf("PUT %d: got %d, want 201", i, rec.Code)
		}
		if i == 3 && rec.Code != http.StatusTooManyRequests {
			t.Fatalf("PUT %d: got %d, want 429", i, rec.Code)
		}
	}
}

// Global rate limit: per-IP budget is high, but the aggregate cap across
// IPs still kicks in. Protects against a distributed burst that would slip
// past per-IP limits.
func TestPutGlobalRateLimit(t *testing.T) {
	dir := t.TempDir()
	s, err := newShareStore(dir, 1<<20, 100, 3) // per-IP 100, global 3
	if err != nil {
		t.Fatalf("newShareStore: %v", err)
	}
	bodies := []string{
		`{"@type":"BeatsShare","v":1,"genre":"a","seed":1}`,
		`{"@type":"BeatsShare","v":1,"genre":"b","seed":2}`,
		`{"@type":"BeatsShare","v":1,"genre":"c","seed":3}`,
		`{"@type":"BeatsShare","v":1,"genre":"d","seed":4}`,
	}
	for i, body := range bodies {
		cid := computeCid([]byte(body))
		putReq := httptest.NewRequest(http.MethodPut, "/o/"+cid, strings.NewReader(body))
		// Each request from a distinct IP so per-IP limit cannot be the one tripping.
		putReq.RemoteAddr = fmt.Sprintf("10.0.0.%d:1234", i+1)
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, putReq)
		if i < 3 && rec.Code != http.StatusCreated {
			t.Fatalf("PUT %d: got %d, want 201", i, rec.Code)
		}
		if i == 3 {
			if rec.Code != http.StatusTooManyRequests {
				t.Fatalf("PUT %d: got %d, want 429", i, rec.Code)
			}
			if !strings.Contains(rec.Body.String(), "global") {
				t.Fatalf("expected global rate-limit message, got %q", rec.Body.String())
			}
		}
	}
}

// Disk cap: when curBytes + body > maxBytes, reject with 507. The
// content-addressed store is append-only — this keeps the filesystem
// from growing without bound on a public deploy.
func TestPutDiskCap(t *testing.T) {
	dir := t.TempDir()
	s, err := newShareStore(dir, 80, 100, 0) // 80-byte cap — first body fits, second pushes over
	if err != nil {
		t.Fatalf("newShareStore: %v", err)
	}
	body := `{"@type":"BeatsShare","v":1,"genre":"techno","seed":1,"tempo":124}`
	cid := computeCid([]byte(body))
	putReq := httptest.NewRequest(http.MethodPut, "/o/"+cid, strings.NewReader(body))
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, putReq)
	if rec.Code != http.StatusCreated {
		t.Fatalf("first PUT: got %d, want 201. body=%s", rec.Code, rec.Body)
	}
	// Second distinct payload — current total is already most of the budget,
	// so another write should push over the cap.
	body2 := `{"@type":"BeatsShare","v":1,"genre":"house","seed":2,"tempo":120}`
	cid2 := computeCid([]byte(body2))
	putReq = httptest.NewRequest(http.MethodPut, "/o/"+cid2, strings.NewReader(body2))
	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, putReq)
	if rec.Code != http.StatusInsufficientStorage {
		t.Fatalf("second PUT: got %d, want 507", rec.Code)
	}
}

// Startup rebuild: the CID→path index must reconstruct from disk so
// payloads written before a restart still resolve on GET.
func TestIndexRebuildOnStartup(t *testing.T) {
	dir := t.TempDir()
	s1, err := newShareStore(dir, 1<<20, 100, 0)
	if err != nil {
		t.Fatalf("newShareStore: %v", err)
	}
	cid := computeCid([]byte(fixturePayload))
	putReq := httptest.NewRequest(http.MethodPut, "/o/"+cid, strings.NewReader(fixturePayload))
	rec := httptest.NewRecorder()
	s1.ServeHTTP(rec, putReq)
	if rec.Code != http.StatusCreated {
		t.Fatalf("seed PUT: got %d, body=%s", rec.Code, rec.Body)
	}

	// Fresh store pointing at the same dir — should re-index the bucketed file.
	s2, err := newShareStore(dir, 1<<20, 100, 0)
	if err != nil {
		t.Fatalf("second newShareStore: %v", err)
	}
	if _, ok := s2.index[cid]; !ok {
		t.Fatalf("CID %s not rebuilt into index", cid)
	}
	if s2.curBytes != int64(len(fixturePayload)) {
		t.Fatalf("curBytes after rebuild: got %d, want %d", s2.curBytes, len(fixturePayload))
	}
	// And GET must work against the re-indexed file.
	getReq := httptest.NewRequest(http.MethodGet, "/o/"+cid, nil)
	rec = httptest.NewRecorder()
	s2.ServeHTTP(rec, getReq)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET after rebuild: got %d, want 200", rec.Code)
	}
}

// Malformed CIDs in the URL path must be rejected early — before we
// touch the filesystem or the schema validator.
func TestInvalidCidRejected(t *testing.T) {
	s, _ := newTestStore(t)
	for _, bad := range []string{"", "zshort", "NotBase58PrefixedValidCidThatPassesRegex1234567", "../etc/passwd"} {
		req := httptest.NewRequest(http.MethodGet, "/o/"+bad, nil)
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest && rec.Code != http.StatusNotFound {
			t.Fatalf("bad cid %q: got %d, want 400 or 404", bad, rec.Code)
		}
	}
}

// Payload > body cap must be rejected; the limit reader stops us
// before we allocate unbounded memory.
func TestPutPayloadTooLarge(t *testing.T) {
	s, _ := newTestStore(t)
	big := bytes.Repeat([]byte("x"), maxShareBytes+1000)
	req := httptest.NewRequest(http.MethodPut, "/o/zZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ", io.NopCloser(bytes.NewReader(big)))
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge && rec.Code != http.StatusBadRequest {
		t.Fatalf("got %d, want 413 or 400", rec.Code)
	}
}

func flipChar(c byte) string {
	if c == 'a' {
		return "b"
	}
	return "a"
}

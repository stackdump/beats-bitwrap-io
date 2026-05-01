package share

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fixtureCompositionPayload mirrors a realistic minimal BeatsComposition
// envelope. Keys sorted so the bytes equal what a JS canonicalizer would
// emit. Source CIDs are placeholder valid-looking values — the schema
// only checks the regex shape, not whether the referenced share exists
// (existence is a render-time concern).
const fixtureCompositionPayload = `{"@context":"https://beats.bitwrap.io/schema/beats-composition.context.jsonld","@type":"BeatsComposition","master":{"format":["wav","webm"],"lufs":-16},"tracks":[{"in":0,"len":16,"source":{"cid":"z3K9vP6jQwHr5sMzLnDfTbXwYpAcEhRgVuKjBsWqMxNyZdJgC"}},{"in":16,"len":16,"source":{"cid":"z9XkFmRtSnPbVcQwYrJzAhDgEuKvLpMxNyZ7TcWqBsHfGjAbX"}}],"v":1}`

func TestCompositionCanonicalJSONRoundTrip(t *testing.T) {
	var v any
	if err := json.Unmarshal([]byte(fixtureCompositionPayload), &v); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	got, err := canonicalJSON(v)
	if err != nil {
		t.Fatalf("canonicalJSON: %v", err)
	}
	if string(got) != fixtureCompositionPayload {
		t.Fatalf("canonical drift:\n got: %s\nwant: %s", got, fixtureCompositionPayload)
	}
	if cidA, cidB := computeCid([]byte(fixtureCompositionPayload)), computeCid(got); cidA != cidB {
		t.Fatalf("CID mismatch on round-trip: %s vs %s", cidA, cidB)
	}
}

func TestCompositionSchemaAccepts(t *testing.T) {
	if err := validatePayloadFor(CompositionType, []byte(fixtureCompositionPayload)); err != nil {
		t.Fatalf("valid composition payload rejected: %v", err)
	}
}

func TestCompositionSchemaRejectsWrongType(t *testing.T) {
	bad := strings.Replace(fixtureCompositionPayload, `"@type":"BeatsComposition"`, `"@type":"BeatsShare"`, 1)
	if err := validatePayloadFor(CompositionType, []byte(bad)); err == nil {
		t.Fatalf("composition validator accepted @type=BeatsShare")
	}
}

func TestCompositionSchemaRejectsExtraField(t *testing.T) {
	bad := strings.Replace(fixtureCompositionPayload, `"v":1`, `"unknown":true,"v":1`, 1)
	if err := validatePayloadFor(CompositionType, []byte(bad)); err == nil {
		t.Fatalf("composition validator accepted unknown field")
	}
}

func TestCompositionSchemaRejectsEmptyTracks(t *testing.T) {
	bad := `{"@type":"BeatsComposition","tracks":[],"v":1}`
	if err := validatePayloadFor(CompositionType, []byte(bad)); err == nil {
		t.Fatalf("composition validator accepted empty tracks array")
	}
}

// Cross-type rejection: a BeatsShare envelope PUT to /c/{cid} (a
// composition store) must be refused at the schema layer, not silently
// stored. Same in reverse: a composition envelope PUT to /o/{cid} fails.
func TestRegistryDispatch_CrossTypeRejected(t *testing.T) {
	if err := validatePayloadFor(CompositionType, []byte(fixturePayload)); err == nil {
		t.Fatalf("composition store accepted BeatsShare payload")
	}
	if err := validatePayloadFor(ShareType, []byte(fixtureCompositionPayload)); err == nil {
		t.Fatalf("share store accepted BeatsComposition payload")
	}
}

// End-to-end: PUT a composition envelope to /c/{cid} on a fresh store,
// verify CID re-verification, then GET it back and compare bytes.
func TestCompositionStore_PUTGetRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStoreForType(CompositionType, dir, 1<<20, 100, 0)
	if err != nil {
		t.Fatalf("NewStoreForType: %v", err)
	}
	body := []byte(fixtureCompositionPayload)
	cid := computeCid(body)

	req := httptest.NewRequest(http.MethodPut, CompositionType.URLPrefix+cid, bytes.NewReader(body))
	rr := httptest.NewRecorder()
	s.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("PUT /c/{cid}: got %d, body=%s", rr.Code, rr.Body.String())
	}

	rr2 := httptest.NewRecorder()
	getReq := httptest.NewRequest(http.MethodGet, CompositionType.URLPrefix+cid, nil)
	s.ServeHTTP(rr2, getReq)
	if rr2.Code != http.StatusOK {
		t.Fatalf("GET /c/{cid}: got %d", rr2.Code)
	}
	if !bytes.Equal(rr2.Body.Bytes(), body) {
		t.Fatalf("GET returned different bytes than PUT")
	}
	if got := rr2.Header().Get("Content-Type"); got != "application/ld+json" {
		t.Fatalf("Content-Type: got %q want application/ld+json", got)
	}
}

// CID-mismatch path: a composition PUT whose URL CID doesn't match the
// hashed bytes must be rejected with 400, just like the BeatsShare path.
func TestCompositionStore_CIDMismatchRejected(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStoreForType(CompositionType, dir, 1<<20, 100, 0)
	if err != nil {
		t.Fatalf("NewStoreForType: %v", err)
	}
	body := []byte(fixtureCompositionPayload)
	bogus := "z" + strings.Repeat("1", 50) // valid pattern, wrong hash
	req := httptest.NewRequest(http.MethodPut, CompositionType.URLPrefix+bogus, bytes.NewReader(body))
	rr := httptest.NewRecorder()
	s.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 on CID mismatch; got %d (%s)", rr.Code, rr.Body.String())
	}
}

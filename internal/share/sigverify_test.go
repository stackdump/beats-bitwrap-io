package share

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
)

// Sanity: a fresh Ed25519 keypair signs the pre-signature CID and
// verifySignature accepts it. Tampering with the envelope content
// (which changes the CID) makes verification fail.
func TestEd25519RoundTrip(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	envelope := map[string]any{
		"@context": "https://beats.bitwrap.io/schema/beats-share.context.jsonld",
		"@type":    "BeatsShare",
		"v":        1,
		"genre":    "techno",
		"seed":     int64(42),
		"signer": map[string]any{
			"type":    "ed25519",
			"address": hex.EncodeToString(pub),
		},
	}
	body, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	cidBytes, err := signedBytes(body)
	if err != nil {
		t.Fatal(err)
	}
	// The signed bytes should be the CID string, not the JSON.
	if len(cidBytes) > 100 || cidBytes[0] != 'z' {
		t.Fatalf("expected CID-shaped signed bytes, got %d bytes starting with %q", len(cidBytes), cidBytes[:1])
	}
	sig := ed25519.Sign(priv, cidBytes)
	if err := verifySignature(cidBytes, "ed25519", hex.EncodeToString(pub),
		hex.EncodeToString(sig)); err != nil {
		t.Fatalf("verify: %v", err)
	}
	// Tamper detection: change the envelope -> different CID -> verify fails.
	envelope["seed"] = int64(99)
	body2, _ := json.Marshal(envelope)
	cidBytes2, _ := signedBytes(body2)
	if err := verifySignature(cidBytes2, "ed25519", hex.EncodeToString(pub),
		hex.EncodeToString(sig)); err == nil {
		t.Fatal("expected verify failure on tampered envelope (different CID)")
	}
}

// Verify the validateProvenance gate: source=official requires the
// rebuild secret; mismatched secret is rejected; absent source is fine.
func TestProvenanceSourceGate(t *testing.T) {
	s := &Store{rebuildSecret: "topsecret"}
	mk := func(src string) []byte {
		m := map[string]any{
			"@context": "x", "@type": "BeatsShare", "v": 1,
			"genre": "techno", "seed": int64(1),
		}
		if src != "" {
			m["source"] = src
		}
		b, _ := json.Marshal(m)
		return b
	}
	// Anonymous body, no header — accepted.
	if err := s.validateProvenance(mk(""), ""); err != nil {
		t.Fatalf("anonymous: %v", err)
	}
	// source=official without secret — rejected.
	if err := s.validateProvenance(mk("official"), ""); err == nil {
		t.Fatal("expected rejection without secret")
	}
	// source=official with wrong secret — rejected.
	if err := s.validateProvenance(mk("official"), "wrong"); err == nil {
		t.Fatal("expected rejection on wrong secret")
	}
	// source=official with right secret — accepted.
	if err := s.validateProvenance(mk("official"), "topsecret"); err != nil {
		t.Fatalf("expected accept: %v", err)
	}
	// Unknown source value — rejected even with secret.
	if err := s.validateProvenance(mk("dubious"), "topsecret"); err == nil {
		t.Fatal("expected rejection on unknown source")
	}
	// Empty server-side secret with bogus source claim — rejected
	// (operator hasn't enabled source attestation).
	s2 := &Store{rebuildSecret: ""}
	if err := s2.validateProvenance(mk("official"), "anything"); err == nil ||
		!strings.Contains(err.Error(), "X-Rebuild-Secret") {
		t.Fatalf("expected rebuild-secret rejection, got %v", err)
	}
}

// signer + signature must both be present together; one without the
// other is malformed.
func TestProvenanceSignerSignaturePaired(t *testing.T) {
	s := &Store{}
	half := func(field string) []byte {
		m := map[string]any{
			"@context": "x", "@type": "BeatsShare", "v": 1,
			"genre": "techno", "seed": int64(1),
		}
		if field == "signer" {
			m["signer"] = map[string]any{"type": "ed25519", "address": "00"}
		}
		if field == "signature" {
			m["signature"] = "00"
		}
		b, _ := json.Marshal(m)
		return b
	}
	if err := s.validateProvenance(half("signer"), ""); err == nil {
		t.Fatal("expected rejection: signer without signature")
	}
	if err := s.validateProvenance(half("signature"), ""); err == nil {
		t.Fatal("expected rejection: signature without signer")
	}
}

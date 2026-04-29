package share

// Operator-key management. Officials get an in-band Ed25519 signature
// from a long-lived server keypair so "◆ Official" isn't just an
// unverifiable claim — anyone can fetch /api/operator-pubkey and
// independently verify any official envelope's signature against the
// published key.
//
// Key lifecycle:
//   - On first startup the server generates a fresh keypair and
//     persists the seed to data/.operator-key (mode 0600).
//   - Subsequent startups load the existing key. Rotation = delete
//     the file (operator decision; old officials stay signed under
//     the old key, you'd publish both pubkeys side-by-side or accept
//     that old officials become un-verifiable until re-seeded).
//   - The seed never leaves the server; the public key is exposed
//     via the public-key endpoint.

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"sync"
)

// OperatorKey holds the loaded Ed25519 keypair plus its hex-encoded
// public key (used as the `signer.address` field on official
// envelopes). Read-only after LoadOrCreate.
type OperatorKey struct {
	mu        sync.RWMutex
	priv      ed25519.PrivateKey
	publicHex string
}

// LoadOrCreateOperatorKey loads the keypair from `path` or generates
// a fresh one if the file doesn't exist. The file is JSON-encoded
// (`{"seed":"..."}`) for forward-compat — future fields (rotation
// metadata, key id) can be added without breaking the loader.
func LoadOrCreateOperatorKey(path string) (*OperatorKey, error) {
	data, err := os.ReadFile(path)
	if err == nil {
		var blob struct {
			Seed string `json:"seed"`
		}
		if err := json.Unmarshal(data, &blob); err != nil {
			return nil, fmt.Errorf("parse operator key: %w", err)
		}
		seed, err := hex.DecodeString(blob.Seed)
		if err != nil || len(seed) != ed25519.SeedSize {
			return nil, fmt.Errorf("operator key seed: bad length or hex")
		}
		priv := ed25519.NewKeyFromSeed(seed)
		return &OperatorKey{
			priv:      priv,
			publicHex: hex.EncodeToString(priv.Public().(ed25519.PublicKey)),
		}, nil
	}
	if !os.IsNotExist(err) {
		return nil, fmt.Errorf("read operator key: %w", err)
	}
	// Generate fresh.
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate operator key: %w", err)
	}
	seed := priv.Seed()
	blob := map[string]string{"seed": hex.EncodeToString(seed)}
	out, _ := json.MarshalIndent(blob, "", "  ")
	if err := os.WriteFile(path, out, 0o600); err != nil {
		return nil, fmt.Errorf("write operator key: %w", err)
	}
	return &OperatorKey{
		priv:      priv,
		publicHex: hex.EncodeToString(pub),
	}, nil
}

// PublicKeyHex returns the hex-encoded 32-byte Ed25519 public key.
// Used as `signer.address` on official envelopes and exposed at
// /api/operator-pubkey for independent verification.
func (k *OperatorKey) PublicKeyHex() string {
	if k == nil {
		return ""
	}
	k.mu.RLock()
	defer k.mu.RUnlock()
	return k.publicHex
}

// Sign signs the given message with the operator key. Returns the
// hex-encoded 64-byte raw Ed25519 signature.
func (k *OperatorKey) Sign(message []byte) string {
	k.mu.RLock()
	defer k.mu.RUnlock()
	sig := ed25519.Sign(k.priv, message)
	return hex.EncodeToString(sig)
}

// SignEnvelope stamps `signer` + `signature` onto the envelope map
// in-place. Computes the pre-signature CID (matches client-side
// signedBytes) and signs it. After this call the envelope's CID
// will differ from before — callers re-canonicalize and recompute.
func (k *OperatorKey) SignEnvelope(envelope map[string]any) error {
	envelope["signer"] = map[string]any{
		"type":    "ed25519",
		"address": k.PublicKeyHex(),
	}
	// Build the bytes-to-sign: the pre-CID of envelope-without-sig
	// (mirrors signedBytes in sigverify.go). signer is now stamped,
	// so the signature commits to the operator key.
	clone := make(map[string]any, len(envelope))
	for k2, v := range envelope {
		clone[k2] = v
	}
	delete(clone, "signature")
	canonical, err := canonicalJSON(clone)
	if err != nil {
		return err
	}
	cidStr := computeCid(canonical)
	envelope["signature"] = k.Sign([]byte(cidStr))
	return nil
}

// SignManifest stamps `signer` + `signature` onto a snapshot
// manifest map in-place. Unlike SignEnvelope, manifests are not
// content-addressed (no CID), so the signature is over the
// canonical-JSON of the manifest itself with `signature` stripped.
// The verifier reproduces the canonical bytes the same way and
// checks the signature against the operator pubkey. Pair with
// archiveSha256 to bind the manifest to a specific .tgz file.
func (k *OperatorKey) SignManifest(manifest map[string]any) error {
	manifest["signer"] = map[string]any{
		"type":    "ed25519",
		"address": k.PublicKeyHex(),
	}
	clone := make(map[string]any, len(manifest))
	for k2, v := range manifest {
		clone[k2] = v
	}
	delete(clone, "signature")
	canonical, err := canonicalJSON(clone)
	if err != nil {
		return err
	}
	manifest["signature"] = k.Sign(canonical)
	return nil
}

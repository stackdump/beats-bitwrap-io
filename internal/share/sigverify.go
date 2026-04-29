package share

// Signature verification for the optional `signer`/`signature` envelope
// fields. Two key types are supported:
//
//   - eth (EIP-191 personal_sign over the canonical-without-sig bytes;
//     signer.address is the 0x-prefixed 20-byte Ethereum address recovered
//     from the signature)
//   - ed25519 (raw 64-byte Ed25519 signature; signer.address is the
//     32-byte hex-encoded public key)
//
// The signed bytes are the canonical-JSON encoding of the envelope with
// the `signature` field stripped — but `signer` IS retained, so the
// signature commits to the public key being claimed. This avoids an
// attacker swapping `signer` to a different valid key while keeping
// the same signature bytes.
//
// Verification failures here are 403/400 in the HTTP layer; the HTTP
// caller decides whether to admit anonymous (no signer) traffic.

import (
	"crypto/ed25519"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
	"golang.org/x/crypto/sha3"
)

// validateProvenance enforces two rules on incoming envelopes:
//
//  1. If `source` is set, only "official" is currently allowed; the
//     request must carry a valid X-Rebuild-Secret. Without the secret
//     the upload is rejected so a user cannot mint a fake official
//     track. (Empty Store.rebuildSecret = always reject source claims.)
//
//  2. If `signer` and `signature` are both set, verify the signature
//     against the canonical-without-sig bytes. Mismatched signer
//     (signature recovers a different address, or Ed25519 verify
//     fails) → reject. `signer` without `signature` (or vice versa)
//     → reject; the envelope is malformed.
//
// Anonymous envelopes (no source, no signer) bypass both checks.
func (s *Store) validateProvenance(body []byte, headerSecret string) error {
	var probe struct {
		Source    string `json:"source"`
		Signer    *struct {
			Type    string `json:"type"`
			Address string `json:"address"`
		} `json:"signer"`
		Signature string `json:"signature"`
	}
	if err := json.Unmarshal(body, &probe); err != nil {
		return fmt.Errorf("envelope parse: %w", err)
	}
	// Rule 1: source claim requires X-Rebuild-Secret.
	if probe.Source != "" {
		if probe.Source != "official" {
			return fmt.Errorf("unknown source value %q", probe.Source)
		}
		if s.rebuildSecret == "" || subtle.ConstantTimeCompare(
			[]byte(headerSecret), []byte(s.rebuildSecret)) != 1 {
			return fmt.Errorf("source=official requires X-Rebuild-Secret")
		}
	}
	// Rule 2: signer + signature must be consistent and verify.
	if probe.Signer != nil || probe.Signature != "" {
		if probe.Signer == nil || probe.Signature == "" {
			return fmt.Errorf("signer and signature must both be set or both absent")
		}
		signed, err := signedBytes(body)
		if err != nil {
			return err
		}
		if err := verifySignature(signed, probe.Signer.Type,
			probe.Signer.Address, probe.Signature); err != nil {
			return err
		}
	}
	return nil
}

// signedBytes returns what was signed: the **pre-signature CID** of
// the envelope (UTF-8 bytes of the base58btc CID string). Computed
// by stripping `signature`, canonicalizing the rest, and running the
// same CID hash the share store would. `signer` is retained in the
// canonicalized bytes so the signature commits to the claimed key.
//
// Why the CID and not the canonical bytes themselves: the CID is the
// content hash, so signing it is cryptographically equivalent — the
// verifier independently recomputes the CID from canonical bytes and
// compares. Signing the CID gives the wallet popup a short, readable
// string instead of a multi-kB JSON blob.
//
// Both producer (signing client) and verifier (server) MUST compute
// this identically; any drift in canonicalization or CID encoding
// breaks every signature.
func signedBytes(envelope []byte) ([]byte, error) {
	var v map[string]any
	if err := json.Unmarshal(envelope, &v); err != nil {
		return nil, fmt.Errorf("envelope parse: %w", err)
	}
	delete(v, "signature")
	canonical, err := canonicalJSON(v)
	if err != nil {
		return nil, err
	}
	return []byte(computeCid(canonical)), nil
}

// verifySignature checks the signature over signedBytes using the
// signer's address + key type. Returns nil on success; a non-nil error
// describes which check failed (used for log lines, not surfaced to
// the client).
func verifySignature(signedBytes []byte, signerType, address, sigHex string) error {
	sig, err := hex.DecodeString(strings.TrimPrefix(sigHex, "0x"))
	if err != nil {
		return fmt.Errorf("signature hex: %w", err)
	}
	switch signerType {
	case "eth":
		if len(sig) != 65 {
			return fmt.Errorf("eth signature must be 65 bytes, got %d", len(sig))
		}
		recovered, err := ethRecover(signedBytes, sig)
		if err != nil {
			return err
		}
		if !strings.EqualFold(recovered, address) {
			return fmt.Errorf("eth signer mismatch: signature recovers %s, claimed %s", recovered, address)
		}
		return nil
	case "ed25519":
		if len(sig) != ed25519.SignatureSize {
			return fmt.Errorf("ed25519 signature must be %d bytes, got %d",
				ed25519.SignatureSize, len(sig))
		}
		pub, err := hex.DecodeString(strings.TrimPrefix(address, "0x"))
		if err != nil {
			return fmt.Errorf("ed25519 pubkey hex: %w", err)
		}
		if len(pub) != ed25519.PublicKeySize {
			return fmt.Errorf("ed25519 pubkey must be %d bytes, got %d",
				ed25519.PublicKeySize, len(pub))
		}
		if !ed25519.Verify(pub, signedBytes, sig) {
			return fmt.Errorf("ed25519 verify failed")
		}
		return nil
	default:
		return fmt.Errorf("unknown signer type %q", signerType)
	}
}

// ethRecover hashes signedBytes with the EIP-191 personal_sign prefix
// and recovers the lowercase 0x-prefixed signer address. Mirrors
// internal/routes/eth.go::verifyPersonalSign but reads bytes (not a
// string) and is duplicated to avoid an import cycle (routes imports
// share, not the other way).
func ethRecover(signedBytes []byte, sig []byte) (string, error) {
	prefix := fmt.Sprintf("\x19Ethereum Signed Message:\n%d", len(signedBytes))
	hash := keccak256(append([]byte(prefix), signedBytes...))
	v := sig[64]
	if v >= 27 {
		v -= 27
	}
	if v > 1 {
		return "", fmt.Errorf("invalid recovery id: %d", v)
	}
	// secp256k1 ecdsa.RecoverCompact expects a 65-byte input where the
	// first byte is the recovery id (0/1) — but reordered as v||R||S.
	compact := make([]byte, 65)
	compact[0] = v + 27
	copy(compact[1:], sig[:64])
	pubKey, _, err := ecdsa.RecoverCompact(compact, hash)
	if err != nil {
		return "", fmt.Errorf("ecrecover: %w", err)
	}
	pubBytes := pubKey.SerializeUncompressed()
	addrHash := keccak256(pubBytes[1:])
	return "0x" + hex.EncodeToString(addrHash[12:]), nil
}

func keccak256(data []byte) []byte {
	h := sha3.NewLegacyKeccak256()
	h.Write(data)
	return h.Sum(nil)
}

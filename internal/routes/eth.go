package routes

import (
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
	"golang.org/x/crypto/sha3"
)

// verifyPersonalSign recovers the Ethereum address from a personal_sign signature.
// Returns the lowercase hex address (0x-prefixed).
func verifyPersonalSign(message string, sigHex string) (string, error) {
	sig, err := hex.DecodeString(strings.TrimPrefix(sigHex, "0x"))
	if err != nil {
		return "", fmt.Errorf("invalid signature hex: %w", err)
	}
	if len(sig) != 65 {
		return "", fmt.Errorf("signature must be 65 bytes, got %d", len(sig))
	}

	// Ethereum personal_sign prefixes the message
	prefix := fmt.Sprintf("\x19Ethereum Signed Message:\n%d", len(message))
	hash := keccak256([]byte(prefix + message))

	// Adjust V: MetaMask uses 27/28, secp256k1 expects 0/1
	v := sig[64]
	if v >= 27 {
		v -= 27
	}
	if v > 1 {
		return "", fmt.Errorf("invalid recovery ID: %d", v)
	}

	// Recover compact signature (R || S, 64 bytes) with recovery flag
	pubKey, _, err := ecdsa.RecoverCompact(sig[:64], hash)
	if err != nil {
		// Try with adjusted V
		return "", fmt.Errorf("ecrecover failed: %w", err)
	}

	// Derive address: keccak256(uncompressed_pubkey[1:])[-20:]
	pubBytes := pubKey.SerializeUncompressed()
	addrHash := keccak256(pubBytes[1:]) // skip 0x04 prefix
	addr := hex.EncodeToString(addrHash[12:])

	return "0x" + addr, nil
}

func keccak256(data []byte) []byte {
	h := sha3.NewLegacyKeccak256()
	h.Write(data)
	return h.Sum(nil)
}

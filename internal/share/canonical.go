package share

// Canonical JSON for share-v1 payloads. Mirrors public/petri-note.js
// `_canonicalizeJSON` byte-for-byte: object keys sorted lexicographically,
// arrays preserve order, leaves emitted via the standard JSON encoder.
// Any Go-side producer (tests, future services) that feeds a value through
// canonicalJSON then computeCid gets the same CID the browser would mint
// from the equivalent object.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"time"
)

// canonicalJSON serializes v with sorted object keys. Numbers are emitted
// by encoding/json, which matches JS `JSON.stringify` for the integer
// range used by share payloads (seed, tempo, swing, humanize, channel).
func canonicalJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	if err := writeCanonical(&buf, v); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func writeCanonical(buf *bytes.Buffer, v any) error {
	switch x := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		buf.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			kb, err := json.Marshal(k)
			if err != nil {
				return err
			}
			buf.Write(kb)
			buf.WriteByte(':')
			if err := writeCanonical(buf, x[k]); err != nil {
				return err
			}
		}
		buf.WriteByte('}')
	case []any:
		buf.WriteByte('[')
		for i, el := range x {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := writeCanonical(buf, el); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
	default:
		// Strings, numbers, booleans, null — delegate to encoding/json.
		// json.Number passes through via its MarshalJSON.
		b, err := json.Marshal(x)
		if err != nil {
			return fmt.Errorf("canonicalJSON leaf: %w", err)
		}
		buf.Write(b)
	}
	return nil
}

// canonicalCid: convenience — round-trips v through canonicalJSON and
// hands the bytes to computeCid. Go-side mirror of
// `_computeCidForJsonLd` in public/petri-note.js.
func canonicalCid(v any) (string, []byte, error) {
	b, err := canonicalJSON(v)
	if err != nil {
		return "", nil, err
	}
	return computeCid(b), b, nil
}

// CanonicalCID is the exported form for callers outside this package
// (e.g. the /api/project-share convenience route) that need to mint a
// CID for a composed share payload and hand the canonical bytes to a
// Store for sealing.
func CanonicalCID(v any) (cid string, canonical []byte, err error) {
	return canonicalCid(v)
}

// Seal writes `canonical` under `cid` in the store, bypassing the HTTP
// layer. The caller is responsible for producing the canonical bytes +
// CID via CanonicalCID so the content-address invariant holds.
// Returns nil if the CID is already stored (idempotent).
func (s *Store) Seal(cid string, canonical []byte) error {
	return s.sealDirect(cid, canonical)
}

// Lookup returns the stored bytes for cid. Exported so in-process
// callers (e.g. the mirror helper) can replay a local seal upstream
// without going through the HTTP layer.
func (s *Store) Lookup(cid string) ([]byte, error) {
	return s.lookup(cid)
}

// SealedAt returns the on-disk mtime of the share envelope for cid,
// which is the moment the seal landed (we always write fresh files;
// duplicates short-circuit before touching the disk). Used by the audio
// upload path to enforce a "no faster than realtime" rule. Returns the
// zero Time + os.ErrNotExist if the cid isn't stored.
func (s *Store) SealedAt(cid string) (time.Time, error) {
	s.mu.Lock()
	path, ok := s.index[cid]
	s.mu.Unlock()
	if !ok {
		return time.Time{}, os.ErrNotExist
	}
	info, err := os.Stat(path)
	if err != nil {
		return time.Time{}, err
	}
	return info.ModTime(), nil
}

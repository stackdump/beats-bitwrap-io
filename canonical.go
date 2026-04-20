package main

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
	"sort"
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

package share

import (
	"encoding/json"
	"testing"
)

// TestCounterMelody_EnvelopeRoundTrip: an envelope with a
// counterMelody directive parses without canonical-JSON drift and the
// CID computed from the unmarshalled map matches the CID computed
// from the canonical bytes (no field gets dropped or reordered).
func TestCounterMelody_EnvelopeRoundTrip(t *testing.T) {
	env := map[string]any{
		"@context": "https://beats.bitwrap.io/schema/beats-share.context.jsonld",
		"@type":    "BeatsShare",
		"v":        1,
		"genre":    "techno",
		"seed":     float64(12345),
		"counterMelody": []any{
			map[string]any{
				"section":  "chorus",
				"mode":     "answer",
				"density":  0.5,
				"register": "above",
			},
		},
	}
	cid1, canon1, err := CanonicalCID(env)
	if err != nil {
		t.Fatalf("CID 1: %v", err)
	}

	var roundtripped map[string]any
	if err := json.Unmarshal(canon1, &roundtripped); err != nil {
		t.Fatalf("unmarshal canonical: %v", err)
	}
	cid2, _, err := CanonicalCID(roundtripped)
	if err != nil {
		t.Fatalf("CID 2: %v", err)
	}
	if cid1 != cid2 {
		t.Fatalf("CID drift across round-trip: %s != %s", cid1, cid2)
	}

	// Confirm the counterMelody field survives the canonical round-trip.
	cm, ok := roundtripped["counterMelody"].([]any)
	if !ok || len(cm) != 1 {
		t.Fatalf("counterMelody missing or wrong shape after round-trip: %T %v",
			roundtripped["counterMelody"], roundtripped["counterMelody"])
	}
	entry, _ := cm[0].(map[string]any)
	if entry["section"] != "chorus" || entry["mode"] != "answer" {
		t.Fatalf("counterMelody entry fields lost: %v", entry)
	}
}

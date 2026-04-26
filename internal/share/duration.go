package share

import (
	"encoding/json"
	"strings"
)

// minLoopFloorMs is the lower bound for any envelope, even a tiny loop.
// Honest in-tab renders run for the full track wall-clock; an upload
// arriving in under 15s on a loop envelope is a strong signal the user
// fabricated the .webm offline rather than recording playback.
const minLoopFloorMs = 15_000

// EstimateMinRenderMs returns a conservative lower bound on how long an
// honest client render of this share envelope must take, expressed in
// milliseconds of wall-clock. The audio upload path uses this to detect
// faster-than-realtime uploads (a user fabricating a .webm offline,
// uploading something they didn't actually record from playback).
//
// The estimate is intentionally lenient — 90% of the structurally
// computed duration, with a hard floor for short loops — so legitimate
// renders that finish slightly early due to MediaRecorder cutoff still
// pass. Returns the floor on parse error rather than failing closed,
// because envelopes pre-validated by the share schema rarely fail here
// and a fail-open default keeps the route forgiving.
func EstimateMinRenderMs(envelope []byte) int64 {
	var p struct {
		Tempo     float64 `json:"tempo"`
		Structure string  `json:"structure"`
	}
	_ = json.Unmarshal(envelope, &p)
	tempo := p.Tempo
	if tempo <= 0 {
		tempo = 120
	}
	const ppq = 4
	tickMs := 60_000.0 / (tempo * ppq)
	steps := totalStepsForStructure(p.Structure)
	estimated := int64(float64(steps) * tickMs * 0.9)
	if estimated < minLoopFloorMs {
		return minLoopFloorMs
	}
	return estimated
}

// totalStepsForStructure approximates the worst-case-shortest total step
// count for a given arrangement structure. Mirrors internal/generator's
// section-step table at the "standard" size class. Returns 0 for loops
// (or absent / unknown structures) — caller falls back to the loop floor.
func totalStepsForStructure(structure string) int {
	switch strings.ToLower(strings.TrimSpace(structure)) {
	case "", "loop":
		// 256-step ring is the typical composer default; the runtime can
		// shorten this for some genres, so we don't enforce it here.
		return 0
	case "ab":
		return 512 // 2 sections × ~256
	case "minimal":
		return 416 // intro 32 + 3 × 128 ≈ 416
	case "drop":
		return 768 // intro + buildup + drop + outro at standard sizing
	case "build":
		return 768
	case "jam":
		return 1024
	case "standard":
		return 1280 // ~5 sections × 256
	case "extended":
		return 1408 // ~6+ sections × 192–256
	default:
		// Unknown structure — still apply a modest minimum so unknown
		// future structures don't bypass the check entirely.
		return 256
	}
}

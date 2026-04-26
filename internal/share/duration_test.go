package share

import "testing"

func TestEstimateMinRenderMs(t *testing.T) {
	cases := []struct {
		name     string
		envelope string
		atLeast  int64 // estimate must be >= this many ms
		atMost   int64 // and <= this many ms
	}{
		// Loops have no structural lower bound — the floor (15s) applies.
		{"loop_default_tempo", `{"genre":"techno","seed":1}`, 15_000, 15_000},
		{"loop_explicit", `{"genre":"techno","seed":1,"structure":"loop"}`, 15_000, 15_000},

		// Structured renders compute from steps × tickInterval × 0.9 slack.
		// Standard at 120 bpm ≈ 1280 × 125 × 0.9 = 144000 ms.
		{"standard_120bpm", `{"genre":"techno","seed":1,"tempo":120,"structure":"standard"}`, 130_000, 160_000},

		// Tempo scales the estimate inversely.
		{"standard_60bpm", `{"genre":"techno","seed":1,"tempo":60,"structure":"standard"}`, 260_000, 320_000},

		// Extended is longer than standard.
		{"extended_120bpm", `{"genre":"techno","seed":1,"tempo":120,"structure":"extended"}`, 140_000, 175_000},

		// Garbage envelope falls back to the floor (fail-open).
		{"junk", `not json at all`, 15_000, 15_000},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := EstimateMinRenderMs([]byte(tc.envelope))
			if got < tc.atLeast || got > tc.atMost {
				t.Fatalf("got %d ms, want %d–%d ms", got, tc.atLeast, tc.atMost)
			}
		})
	}
}

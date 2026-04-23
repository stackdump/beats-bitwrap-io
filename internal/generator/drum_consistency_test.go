package generator

import (
	"testing"
)

// TestDrumConsistency verifies that drum patterns are identical
// across multiple regenerations of the same genre.
func TestDrumConsistency(t *testing.T) {
	for _, genre := range []string{"techno", "edm", "jazz", "blues", "house", "dnb"} {
		t.Run(genre, func(t *testing.T) {
			// Generate twice with no seed (time-based)
			proj1 := Compose(genre, nil)
			proj2 := Compose(genre, nil)

			for _, role := range []string{"kick", "snare", "hihat"} {
				b1, ok1 := proj1.Nets[role]
				b2, ok2 := proj2.Nets[role]
				if !ok1 || !ok2 {
					continue
				}

				// Compare MIDI bindings
				if len(b1.Bindings) != len(b2.Bindings) {
					t.Errorf("%s: %s binding count differs: %d vs %d",
						genre, role, len(b1.Bindings), len(b2.Bindings))
					continue
				}

				for tLabel, midi1 := range b1.Bindings {
					midi2, ok := b2.Bindings[tLabel]
					if !ok {
						t.Errorf("%s: %s transition %s missing in second generation", genre, role, tLabel)
						continue
					}
					if midi1.Note != midi2.Note || midi1.Velocity != midi2.Velocity {
						t.Errorf("%s: %s %s note/vel differs: %d/%d vs %d/%d",
							genre, role, tLabel,
							midi1.Note, midi1.Velocity,
							midi2.Note, midi2.Velocity)
					}
				}
			}
		})
	}
}

// TestDrumConsistencyStructureMode verifies drum variants are consistent
// in structure mode across regenerations with the same seed.
func TestDrumConsistencyStructureMode(t *testing.T) {
	overrides := map[string]interface{}{
		"structure": "standard",
		"seed":      float64(42),
	}

	proj1 := Compose("edm", overrides)
	proj2 := Compose("edm", overrides)

	// Check all drum variant nets (kick-A, kick-B, snare-A, etc.)
	for netId, b1 := range proj1.Nets {
		b2, ok := proj2.Nets[netId]
		if !ok {
			continue
		}
		// Only check drum nets (channel 10)
		if b1.Track.Channel != 10 {
			continue
		}

		if len(b1.Bindings) != len(b2.Bindings) {
			t.Errorf("%s binding count differs: %d vs %d",
				netId, len(b1.Bindings), len(b2.Bindings))
			continue
		}

		for tLabel, midi1 := range b1.Bindings {
			midi2, ok := b2.Bindings[tLabel]
			if !ok {
				t.Errorf("%s transition %s missing in second generation", netId, tLabel)
				continue
			}
			if midi1.Note != midi2.Note || midi1.Velocity != midi2.Velocity {
				t.Errorf("%s %s note/vel differs: %d/%d vs %d/%d",
					netId, tLabel,
					midi1.Note, midi1.Velocity,
					midi2.Note, midi2.Velocity)
			}
		}
	}
}

package generator

import (
	"math/rand"

	"beats-bitwrap-io/internal/pflow"
)

// DrumRiff generates a drum pattern variant.
// variant "A" = base pattern, "B" = same pattern with more energy (velocity/duration),
// "C" = same pattern, quieter/shorter.
// Drums keep the same hits/rotation across all variants for musical consistency.
// If style is non-nil, it overrides the hardcoded A/B/C adjustments.
func DrumRiff(variant string, hits, steps, rotation, note int, params Params, style *DrumVariant) *pflow.NetBundle {
	if style != nil && variant != "A" {
		hits = hits + style.HitsAdd
		if style.HitsMul != 0 && style.HitsMul != 1.0 {
			hits = int(float64(hits) * style.HitsMul)
		}
		rotation = (rotation + style.RotationAdd) % steps
		if hits < 1 {
			hits = 1
		}
		if hits > steps {
			hits = steps
		}
	} else {
		// Same pattern, vary velocity/duration for feel
		switch variant {
		case "B":
			params.Velocity = min(127, params.Velocity+15)
			params.Duration = int(float64(params.Duration) * 1.4)
		case "C":
			params.Velocity = max(40, params.Velocity-20)
			params.Duration = int(float64(params.Duration) * 0.6)
		}
	}

	result := Euclidean(hits, steps, rotation, note, params)
	return result.Bundle
}

// MelodyRiff generates a melody pattern variant.
// variant "A" = base, "B" = higher density, "C" = sparse/chord-focused.
func MelodyRiff(variant string, params Params) *pflow.NetBundle {
	rng := rand.New(rand.NewSource(params.Seed))

	switch variant {
	case "B":
		// Higher density, slight seed variation
		params.Density = params.Density * 1.4
		if params.Density > 1.0 {
			params.Density = 1.0
		}
		params.Seed = params.Seed + 1000 + rng.Int63n(1000)
	case "C":
		// Sparse, longer notes
		params.Density = params.Density * 0.5
		params.Duration = int(float64(params.Duration) * 1.5)
		params.Seed = params.Seed + 2000 + rng.Int63n(1000)
	}

	result := MarkovMelody(params)
	return result.Bundle
}

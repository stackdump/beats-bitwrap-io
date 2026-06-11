package generator

// Cohesion v2 — GrooveLock derives the bass hit-mask from the kick hit-mask.
// Today the composer generates bass independently of the kick (a separate
// Markov walk), so the two parts share no rhythmic DNA. Producers think
// about the bass-kick relationship as one of a few archetypes — bass on
// the kick (four-on-floor), bass between kicks (sidechained), bass on the
// off-beats (reggae), and so on. GrooveLock makes those archetypes the
// engine's first-class vocabulary.
//
// Pitches still come from the motif + harmonic map; only rhythm is tied
// to the kick.

import "math/rand"

// GrooveTemplate enumerates how the bass hit-mask relates to the kick mask.
type GrooveTemplate int

const (
	GrooveFourOnFloor GrooveTemplate = iota // bass plays exactly when kick plays
	GrooveOffbeat                            // bass plays exactly when kick doesn't
	GrooveSidechained                        // bass plays everywhere except kick hits
	GrooveSyncoPocket                        // bass plays kick hits + offbeats of 2 and 4
	GrooveBreakbeat                          // bass independent of kick
)

// defaultGrooveFor picks the default groove template per genre. Slice 0 only
// uses techno, but the table is filled out so future genres slot in by
// reading this one map.
func defaultGrooveFor(genreName string, g Genre) GrooveTemplate {
	switch genreName {
	case "techno", "edm", "trance":
		return GrooveFourOnFloor
	case "house":
		return GrooveSyncoPocket
	case "dubstep", "trap":
		return GrooveSidechained
	case "reggae":
		return GrooveOffbeat
	case "dnb":
		return GrooveBreakbeat
	}
	return GrooveFourOnFloor
}

// GrooveLock returns a hit mask of the same length as kickMask, with hits
// placed according to the template. Pure function of (kickMask, template,
// rng) — rng is only used by GrooveBreakbeat where the bass is intentionally
// independent.
//
// kickMask is a Euclidean-style rhythm mask (true = hit). The returned mask
// has the same length so the bass can be expressed as a sister Euclidean ring.
func GrooveLock(kickMask []bool, template GrooveTemplate, rng *rand.Rand) []bool {
	n := len(kickMask)
	out := make([]bool, n)
	switch template {
	case GrooveFourOnFloor:
		copy(out, kickMask)
	case GrooveOffbeat:
		// One step before each kick hit (the "&" of the kick). Wraps.
		for i, k := range kickMask {
			if k {
				out[(i-1+n)%n] = true
			}
		}
	case GrooveSidechained:
		for i, k := range kickMask {
			out[i] = !k
		}
	case GrooveSyncoPocket:
		// Kick hits + offbeats of beat 2 and 4 (steps 6 and 14 in a
		// 16-step bar). For 8-step bars the offbeats collapse to steps
		// 3 and 7.
		copy(out, kickMask)
		off1, off2 := 6, 14
		if n == 8 {
			off1, off2 = 3, 7
		}
		if off1 < n {
			out[off1] = true
		}
		if off2 < n {
			out[off2] = true
		}
	case GrooveBreakbeat:
		// Independent: a 3-of-8 Bjorklund-ish sparse pattern, randomly
		// rotated. Not tied to the kick — the genre that uses this
		// (DnB) wants the bass to do its own thing.
		hits := n * 3 / 8
		if hits < 1 {
			hits = 1
		}
		rot := 0
		if rng != nil {
			rot = rng.Intn(n)
		}
		for i := 0; i < hits; i++ {
			pos := (i * n / hits) + rot
			out[pos%n] = true
		}
	}
	return out
}

package generator

import (
	"fmt"
	"math"
	"math/rand"

	"beats-bitwrap-io/internal/pflow"

	"github.com/pflow-xyz/go-pflow/petri"
)

// MarkovMelody generates a deterministic melody ring net.
// Pre-composes a note sequence using chord-aware rules, then encodes it
// as a ring where each step has exactly one transition — no runtime conflicts.
func MarkovMelody(params Params) *Result {
	notes := params.Scale
	if len(notes) == 0 {
		notes = MajorScale(params.RootNote)
	}
	n := len(notes)
	if n > 12 {
		n = 12
		notes = notes[:n]
	}

	steps := params.Steps
	if steps <= 0 {
		steps = 16
	}

	rng := rand.New(rand.NewSource(params.Seed))

	// Build chord tone set (scale degree indices)
	chordToneSet := make(map[int]bool)
	if params.Chords != nil {
		for _, chord := range params.Chords.Chords {
			for _, t := range chord.Tones {
				if t < n {
					chordToneSet[t] = true
				}
			}
		}
	}
	// If no chords provided, treat root, 3rd, 5th as chord tones
	if len(chordToneSet) == 0 {
		for _, deg := range []int{0, 2, 4} {
			if deg < n {
				chordToneSet[deg] = true
			}
		}
	}

	isBass := params.RootNote < 48

	// Pre-compose the note sequence as scale degree indices
	seq := composeSequence(steps, n, chordToneSet, isBass, params.Density, rng)

	// Apply syncopation: shift some notes one step earlier
	if params.Syncopation > 0 {
		applySyncopation(seq, params.Syncopation, rng)
	}

	// Build the ring net (same topology as Euclidean)
	net := petri.NewPetriNet()
	bindings := make(map[string]*pflow.MidiBinding)

	cx, cy, radius := ringLayout(steps)

	for i := 0; i < steps; i++ {
		// Place
		initial := 0.0
		if i == 0 {
			initial = 1
		}
		angle := float64(i) / float64(steps) * 2 * math.Pi
		px := cx + radius*0.7*math.Cos(angle)
		py := cy + radius*0.7*math.Sin(angle)
		pLabel := fmt.Sprintf("p%d", i)
		net.AddPlace(pLabel, initial, nil, px, py, nil)

		// Transition (offset by half-step so it sits between places)
		tLabel := fmt.Sprintf("t%d", i)
		tAngle := (float64(i) + 0.5) / float64(steps) * 2 * math.Pi
		tx := cx + radius*math.Cos(tAngle)
		ty := cy + radius*math.Sin(tAngle)
		net.AddTransition(tLabel, "", tx, ty, nil)

		// Arcs: pi -> ti -> p(i+1 mod steps)
		net.AddArc(pLabel, tLabel, 1.0, false)
		nextP := fmt.Sprintf("p%d", (i+1)%steps)
		net.AddArc(tLabel, nextP, 1.0, false)

		// MIDI binding: rest steps get no binding (silent transition)
		deg := seq[i]
		if deg < 0 {
			continue // rest
		}

		vel := computeVelocity(i, deg, params.Velocity, chordToneSet)
		dur := computeDuration(deg, params.Duration, params.DurationVariation, chordToneSet, rng)

		bindings[tLabel] = &pflow.MidiBinding{
			Note:     notes[deg],
			Channel:  params.Channel,
			Velocity: clampVelocity(vel),
			Duration: dur,
		}
	}

	track := pflow.Track{
		Channel:         params.Channel,
		DefaultVelocity: params.Velocity,
	}

	return &Result{
		Bundle: pflow.NewNetBundle(net, track, bindings),
		NetID:  "melody",
	}
}

// composeSequence builds a slice of scale degree indices (or -1 for rests).
func composeSequence(steps, scaleLen int, chordTones map[int]bool, isBass bool, density float64, rng *rand.Rand) []int {
	seq := make([]int, steps)

	// Start on root (or fifth for bass variety)
	current := 0
	seq[0] = current

	for i := 1; i < steps; i++ {
		beatPos := i % 4

		if isBass {
			current = composeBassStep(current, beatPos, scaleLen, rng)
		} else {
			current = composeMelodyStep(current, beatPos, scaleLen, chordTones, rng)
		}
		seq[i] = current
	}

	// Apply rests based on density
	noteCount := int(density * float64(steps))
	if noteCount < 1 {
		noteCount = 1
	}
	if noteCount >= steps {
		return seq // no rests needed
	}

	// Mark weakest beats as rests first
	restsNeeded := steps - noteCount
	// Score each step: strong beats get high scores (protected from rests)
	type scored struct {
		idx   int
		score int
	}
	candidates := make([]scored, 0, steps)
	for i := 0; i < steps; i++ {
		s := 0
		switch i % 4 {
		case 0:
			s = 100 // strong beat — protect
		case 2:
			s = 50 // medium beat
		default:
			s = 0 // weak beat — rest candidate
		}
		// Protect beat 0 always
		if i == 0 {
			s = 200
		}
		candidates = append(candidates, scored{i, s})
	}

	// Sort by score ascending (weakest first) using simple insertion sort
	for i := 1; i < len(candidates); i++ {
		for j := i; j > 0 && candidates[j].score < candidates[j-1].score; j-- {
			candidates[j], candidates[j-1] = candidates[j-1], candidates[j]
		}
	}

	// Apply rests to weakest positions
	for i := 0; i < restsNeeded && i < len(candidates); i++ {
		idx := candidates[i].idx
		if idx == 0 {
			continue // never rest on beat 0
		}
		seq[idx] = -1
	}

	return seq
}

// composeMelodyStep picks the next scale degree based on beat strength.
func composeMelodyStep(current, beatPos, scaleLen int, chordTones map[int]bool, rng *rand.Rand) int {
	switch beatPos {
	case 0: // strong beat: land on nearest chord tone
		return nearestChordTone(current, scaleLen, chordTones)
	case 2: // medium beat: 70% chord tone, 30% stepwise
		if rng.Float64() < 0.7 {
			return nearestChordTone(current, scaleLen, chordTones)
		}
		return stepwise(current, scaleLen, 1, rng)
	default: // weak beat: stepwise motion
		r := rng.Float64()
		switch {
		case r < 0.60: // step of 1
			return stepwise(current, scaleLen, 1, rng)
		case r < 0.85: // step of 2
			return stepwise(current, scaleLen, 2, rng)
		default: // repeat
			return current
		}
	}
}

// composeBassStep picks bass notes emphasizing root and fifth.
func composeBassStep(current, beatPos, scaleLen int, rng *rand.Rand) int {
	switch beatPos {
	case 0: // strong beat: root
		return 0
	case 2: // medium beat: fifth (degree 4) or root
		if scaleLen > 4 && rng.Float64() < 0.6 {
			return 4
		}
		return 0
	default: // weak beat: stepwise from current or repeat
		if rng.Float64() < 0.5 {
			return current
		}
		return stepwise(current, scaleLen, 1, rng)
	}
}

// nearestChordTone finds the closest chord tone to the current degree.
func nearestChordTone(current, scaleLen int, chordTones map[int]bool) int {
	if chordTones[current] {
		return current
	}
	for dist := 1; dist < scaleLen; dist++ {
		up := current + dist
		down := current - dist
		if up < scaleLen && chordTones[up] {
			return up
		}
		if down >= 0 && chordTones[down] {
			return down
		}
	}
	return 0 // fallback to root
}

// stepwise moves current by the given interval up or down.
func stepwise(current, scaleLen, interval int, rng *rand.Rand) int {
	if rng.Float64() < 0.5 {
		next := current + interval
		if next >= scaleLen {
			next = current - interval
		}
		if next < 0 {
			next = 0
		}
		return next
	}
	next := current - interval
	if next < 0 {
		next = current + interval
	}
	if next >= scaleLen {
		next = scaleLen - 1
	}
	return next
}

// computeVelocity applies beat-based accents.
func computeVelocity(step, deg, baseVel int, chordTones map[int]bool) int {
	vel := baseVel
	switch step % 4 {
	case 0:
		vel += 15 // beat 1 accent
	case 2:
		vel += 5 // beat 3 accent
	default:
		vel -= 10 // weak beat
	}
	if chordTones[deg] {
		vel += 5
	}
	return vel
}

// computeDuration adjusts note length: chord tones longer, passing tones shorter.
func computeDuration(deg, baseDur int, variation float64, chordTones map[int]bool, rng *rand.Rand) int {
	if variation <= 0 {
		return baseDur
	}
	dur := baseDur
	if chordTones[deg] {
		dur = int(float64(dur) * (1.2 + rng.Float64()*0.8*variation))
	} else {
		dur = int(float64(dur) * (0.3 + rng.Float64()*0.5*variation))
	}
	if dur < 20 {
		dur = 20
	}
	return dur
}

// applySyncopation shifts some notes one step earlier (anticipation).
// Notes on strong beats (positions divisible by 4 or 2) are candidates
// to be moved to the preceding step, creating an ahead-of-the-beat feel.
func applySyncopation(seq []int, probability float64, rng *rand.Rand) {
	for i := 2; i < len(seq); i++ {
		// Only syncopate notes on strong or medium beats
		if i%2 != 0 {
			continue
		}
		// Skip if this step is a rest or preceding step has a note
		if seq[i] < 0 || seq[i-1] >= 0 {
			continue
		}
		if rng.Float64() < probability {
			// Move note one step earlier
			seq[i-1] = seq[i]
			seq[i] = -1 // rest where the note was
		}
	}
}

package generator

import (
	"fmt"
	"math"
	"math/rand"

	"beats-bitwrap-io/internal/pflow"

	"github.com/pflow-xyz/go-pflow/petri"
)

// TensionLevel defines energy scaling for a riff variant.
type TensionLevel struct {
	DensityMul    float64 // multiplier on note density
	VelocityAdd   int     // added to base velocity
	RegisterShift int     // semitones to shift register
}

// tensionForVariant returns the tension level for a given riff variant letter.
// A = baseline, B = higher energy, C = lower energy.
func tensionForVariant(variant string) TensionLevel {
	switch variant {
	case "B":
		return TensionLevel{DensityMul: 1.3, VelocityAdd: 10, RegisterShift: 2}
	case "C":
		return TensionLevel{DensityMul: 0.6, VelocityAdd: -10, RegisterShift: -3}
	default: // "A"
		return TensionLevel{DensityMul: 1.0, VelocityAdd: 0, RegisterShift: 0}
	}
}

// GhostNoteHihat generates a hihat ring with ghost notes (low velocity hits)
// filling gaps between the main Euclidean pattern.
func GhostNoteHihat(hits, steps, rotation, note int, params Params, ghostDensity float64) *Result {
	pattern := bjorklund(hits, steps)

	// Apply rotation
	if rotation != 0 {
		rotation = rotation % steps
		if rotation < 0 {
			rotation += steps
		}
		rotated := make([]int, steps)
		for i := range pattern {
			rotated[i] = pattern[(i+rotation)%steps]
		}
		pattern = rotated
	}

	rng := rand.New(rand.NewSource(params.Seed))
	net := petri.NewPetriNet()
	bindings := make(map[string]*pflow.MidiBinding)

	cx, cy, radius := ringLayout(steps)

	for i := 0; i < steps; i++ {
		initial := 0.0
		if i == 0 {
			initial = 1
		}
		angle := float64(i) / float64(steps) * 2 * math.Pi
		x := cx + radius*0.7*math.Cos(angle)
		y := cy + radius*0.7*math.Sin(angle)
		pLabel := fmt.Sprintf("p%d", i)
		net.AddPlace(pLabel, initial, nil, x, y, nil)

		tLabel := fmt.Sprintf("t%d", i)
		tAngle := (float64(i) + 0.5) / float64(steps) * 2 * math.Pi
		tx := cx + radius*math.Cos(tAngle)
		ty := cy + radius*math.Sin(tAngle)
		net.AddTransition(tLabel, "", tx, ty, nil)

		net.AddArc(pLabel, tLabel, 1.0, false)
		nextP := fmt.Sprintf("p%d", (i+1)%steps)
		net.AddArc(tLabel, nextP, 1.0, false)

		if pattern[i] == 1 {
			// Main hit with accent
			vel := accentVelocity(i, steps, params.Velocity, params.Accent)
			bindings[tLabel] = &pflow.MidiBinding{
				Note:     note,
				Channel:  params.Channel,
				Velocity: clampVelocity(vel),
				Duration: params.Duration,
			}
		} else if rng.Float64() < ghostDensity {
			// Ghost note: very low velocity
			ghostVel := 30 + rng.Intn(20) // 30-50
			bindings[tLabel] = &pflow.MidiBinding{
				Note:     note,
				Channel:  params.Channel,
				Velocity: clampVelocity(ghostVel),
				Duration: params.Duration,
			}
		}
	}

	track := pflow.Track{
		Channel:         params.Channel,
		DefaultVelocity: params.Velocity,
	}

	return &Result{
		Bundle: pflow.NewNetBundle(net, track, bindings),
		NetID:  "hihat",
	}
}

// WalkingBassLine generates a bass line with chromatic passing tones between
// chord roots. Instead of Markov random walk, it targets each chord's root
// and fills gaps with chromatic approach notes.
func WalkingBassLine(params Params) *Result {
	notes := params.Scale
	if len(notes) == 0 {
		notes = MajorScale(params.RootNote)
	}

	steps := params.Steps
	if steps <= 0 {
		steps = 16
	}

	rng := rand.New(rand.NewSource(params.Seed))

	// Build the chord root sequence in MIDI notes
	chordRoots := make([]int, steps)
	if params.Chords != nil && len(params.Chords.Chords) > 0 {
		stepsPer := params.Chords.StepsPer
		if stepsPer <= 0 {
			stepsPer = 4
		}
		for i := 0; i < steps; i++ {
			chordIdx := (i / stepsPer) % len(params.Chords.Chords)
			rootDeg := params.Chords.Chords[chordIdx].Root
			if rootDeg < len(notes) {
				chordRoots[i] = notes[rootDeg]
			} else {
				chordRoots[i] = params.RootNote
			}
		}
	} else {
		for i := range chordRoots {
			chordRoots[i] = params.RootNote
		}
	}

	// Build the walking bass sequence as MIDI note numbers
	seq := make([]int, steps)
	seq[0] = chordRoots[0]

	for i := 1; i < steps; i++ {
		beatPos := i % 4
		currentNote := seq[i-1]
		targetRoot := chordRoots[i]

		if beatPos == 0 {
			// Strong beat: land on chord root
			seq[i] = targetRoot
		} else {
			// Find the next strong beat target
			nextTarget := targetRoot
			for j := i + 1; j < steps && j%4 != 0; j++ {
				// skip
			}
			nextStrongBeat := ((i / 4) + 1) * 4
			if nextStrongBeat < steps {
				nextTarget = chordRoots[nextStrongBeat]
			}

			// Chromatic approach: move toward the target
			diff := nextTarget - currentNote
			if diff == 0 {
				// On target already — add neighbor tone
				if rng.Float64() < 0.5 {
					seq[i] = currentNote + 1
				} else {
					seq[i] = currentNote - 1
				}
			} else {
				// Steps remaining to next strong beat
				stepsLeft := 4 - beatPos
				stepSize := diff / stepsLeft
				if stepSize == 0 {
					if diff > 0 {
						stepSize = 1
					} else {
						stepSize = -1
					}
				}
				// Add some randomness
				if rng.Float64() < 0.3 {
					// Chromatic half-step approach
					if diff > 0 {
						seq[i] = currentNote + 1
					} else {
						seq[i] = currentNote - 1
					}
				} else {
					seq[i] = currentNote + stepSize
				}
			}
		}

		// Clamp to MIDI range
		if seq[i] < 24 {
			seq[i] = 24
		}
		if seq[i] > 72 {
			seq[i] = 72
		}
	}

	// Apply density-based rests
	noteCount := int(params.Density * float64(steps))
	if noteCount < 1 {
		noteCount = 1
	}

	restPositions := make(map[int]bool)
	if noteCount < steps {
		// Mark weakest beats as rests
		restsNeeded := steps - noteCount
		for r := 0; r < restsNeeded; r++ {
			// Find weakest unprotected position
			bestIdx := -1
			bestScore := 1000
			for j := 1; j < steps; j++ { // never rest on beat 0
				if restPositions[j] {
					continue
				}
				score := 100
				switch j % 4 {
				case 0:
					score = 100
				case 2:
					score = 50
				default:
					score = 0
				}
				if score < bestScore {
					bestScore = score
					bestIdx = j
				}
			}
			if bestIdx >= 0 {
				restPositions[bestIdx] = true
			}
		}
	}

	// Build the ring net
	net := petri.NewPetriNet()
	bindings := make(map[string]*pflow.MidiBinding)

	cx, cy, radius := ringLayout(steps)

	for i := 0; i < steps; i++ {
		initial := 0.0
		if i == 0 {
			initial = 1
		}
		angle := float64(i) / float64(steps) * 2 * math.Pi
		px := cx + radius*0.7*math.Cos(angle)
		py := cy + radius*0.7*math.Sin(angle)
		pLabel := fmt.Sprintf("p%d", i)
		net.AddPlace(pLabel, initial, nil, px, py, nil)

		tLabel := fmt.Sprintf("t%d", i)
		tAngle := (float64(i) + 0.5) / float64(steps) * 2 * math.Pi
		tx := cx + radius*math.Cos(tAngle)
		ty := cy + radius*math.Sin(tAngle)
		net.AddTransition(tLabel, "", tx, ty, nil)

		net.AddArc(pLabel, tLabel, 1.0, false)
		nextP := fmt.Sprintf("p%d", (i+1)%steps)
		net.AddArc(tLabel, nextP, 1.0, false)

		if restPositions[i] {
			continue
		}

		dur := params.Duration
		if params.DurationVariation > 0 {
			dur = int(float64(dur) * (0.8 + rng.Float64()*0.4*params.DurationVariation))
			if dur < 20 {
				dur = 20
			}
		}

		vel := params.Velocity
		switch i % 4 {
		case 0:
			vel += 15
		case 2:
			vel += 5
		default:
			vel -= 10
		}

		bindings[tLabel] = &pflow.MidiBinding{
			Note:     seq[i],
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
		NetID:  "bass",
	}
}

// CallResponseMelody generates a 32-step ring with a 16-step call phrase
// followed by a 16-step response phrase. The response reuses the call's
// rhythm but resolves to the tonic.
func CallResponseMelody(params Params) *Result {
	notes := params.Scale
	if len(notes) == 0 {
		notes = MajorScale(params.RootNote)
	}
	n := len(notes)
	if n > 12 {
		n = 12
		notes = notes[:n]
	}

	rng := rand.New(rand.NewSource(params.Seed))

	// Build chord tone set
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
	if len(chordToneSet) == 0 {
		for _, deg := range []int{0, 2, 4} {
			if deg < n {
				chordToneSet[deg] = true
			}
		}
	}

	// Generate call phrase (16 steps)
	callSeq := composeSequence(16, n, chordToneSet, false, params.Density, rng)

	// Generate response: same rhythm (rest positions), different notes resolving to tonic
	responseSeq := make([]int, 16)
	current := callSeq[0] // start from same place
	for i := 0; i < 16; i++ {
		if callSeq[i] < 0 {
			responseSeq[i] = -1 // preserve rest positions
			continue
		}

		if i >= 12 {
			// Last 4 steps: resolve toward root
			dist := current
			if dist > 0 {
				current--
			} else if dist < 0 {
				current++
			}
			responseSeq[i] = current
		} else {
			// Mirror call rhythm but with different notes
			current = composeMelodyStep(current, i%4, n, chordToneSet, rng)
			responseSeq[i] = current
		}
	}
	// Final note is always root
	if responseSeq[15] != -1 {
		responseSeq[15] = 0
	}

	// Combine into 32-step sequence
	totalSteps := 32
	seq := make([]int, totalSteps)
	copy(seq[:16], callSeq)
	copy(seq[16:], responseSeq)

	// Build the ring net
	net := petri.NewPetriNet()
	bindings := make(map[string]*pflow.MidiBinding)

	cx, cy, radius := ringLayout(totalSteps)

	for i := 0; i < totalSteps; i++ {
		initial := 0.0
		if i == 0 {
			initial = 1
		}
		angle := float64(i) / float64(totalSteps) * 2 * math.Pi
		px := cx + radius*0.7*math.Cos(angle)
		py := cy + radius*0.7*math.Sin(angle)
		pLabel := fmt.Sprintf("p%d", i)
		net.AddPlace(pLabel, initial, nil, px, py, nil)

		tLabel := fmt.Sprintf("t%d", i)
		tAngle := (float64(i) + 0.5) / float64(totalSteps) * 2 * math.Pi
		tx := cx + radius*math.Cos(tAngle)
		ty := cy + radius*math.Sin(tAngle)
		net.AddTransition(tLabel, "", tx, ty, nil)

		net.AddArc(pLabel, tLabel, 1.0, false)
		nextP := fmt.Sprintf("p%d", (i+1)%totalSteps)
		net.AddArc(tLabel, nextP, 1.0, false)

		deg := seq[i]
		if deg < 0 {
			continue
		}

		vel := computeVelocity(i%16, deg, params.Velocity, chordToneSet)
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

// ApplyModalInterchange probabilistically substitutes chords from the parallel key.
// For minor keys it borrows from major, and vice versa.
func ApplyModalInterchange(chordProg *ChordProg, scale []int, probability float64, rng *rand.Rand) *ChordProg {
	if probability <= 0 || chordProg == nil {
		return chordProg
	}

	// Determine if scale is major or minor by checking the 3rd
	isMajor := false
	if len(scale) >= 3 {
		interval := scale[2] - scale[0]
		if interval == 4 { // major 3rd
			isMajor = true
		}
	}

	// Parallel key: major <-> minor
	// Borrowed chords change quality (major third vs minor third)
	result := &ChordProg{
		Chords:   make([]ChordDegree, len(chordProg.Chords)),
		StepsPer: chordProg.StepsPer,
	}
	copy(result.Chords, chordProg.Chords)

	for i := range result.Chords {
		if i == 0 {
			continue // never borrow the tonic
		}
		if rng.Float64() < probability {
			// Shift chord tones to suggest borrowed quality
			chord := result.Chords[i]
			newTones := make([]int, len(chord.Tones))
			copy(newTones, chord.Tones)

			// Alter the 3rd of the chord (second tone) by ±1 scale degree
			if len(newTones) >= 2 {
				if isMajor {
					// Borrowing from minor: flatten the 3rd
					if newTones[1] > 0 {
						newTones[1] = newTones[1] - 1
					}
				} else {
					// Borrowing from major: raise the 3rd
					newTones[1] = newTones[1] + 1
				}
			}
			result.Chords[i] = ChordDegree{Root: chord.Root, Tones: newTones}
		}
	}

	return result
}

// DrumFillNet creates a drum fill net that fires at a section boundary.
// It produces a burst of snare/tom hits with a crescendo in the last
// fillLength steps before the boundary.
func DrumFillNet(boundaryStep, fillLength int, rng *rand.Rand) *pflow.NetBundle {
	if fillLength < 2 {
		fillLength = 4
	}

	// Fill MIDI notes: mix of snare and toms
	fillNotes := []int{38, 45, 48, 43, 38, 48} // snare, low tom, high tom, floor tom

	net := petri.NewPetriNet()
	bindings := make(map[string]*pflow.MidiBinding)
	controlBindings := make(map[string]*pflow.ControlBinding)

	totalSteps := boundaryStep
	if totalSteps < 1 {
		totalSteps = 1
	}

	cx, cy, radius := ringLayout(totalSteps + 1)

	// Linear chain
	for i := 0; i <= totalSteps; i++ {
		initial := 0.0
		if i == 0 {
			initial = 1
		}
		angle := float64(i) / float64(totalSteps+1) * 2 * math.Pi
		x := cx + radius*0.7*math.Cos(angle)
		y := cy + radius*0.7*math.Sin(angle)
		pLabel := fmt.Sprintf("p%d", i)
		net.AddPlace(pLabel, initial, nil, x, y, nil)
	}

	for i := 0; i < totalSteps; i++ {
		tLabel := fmt.Sprintf("t%d", i)
		angle := (float64(i) + 0.5) / float64(totalSteps+1) * 2 * math.Pi
		tx := cx + radius*math.Cos(angle)
		ty := cy + radius*math.Sin(angle)
		net.AddTransition(tLabel, "", tx, ty, nil)

		net.AddArc(fmt.Sprintf("p%d", i), tLabel, 1.0, false)
		net.AddArc(tLabel, fmt.Sprintf("p%d", i+1), 1.0, false)

		// Fill in the last fillLength steps before boundary
		fillStart := totalSteps - fillLength
		if i >= fillStart {
			fillPos := i - fillStart
			// Crescendo velocity
			vel := 60 + (fillPos * 50 / fillLength)
			if vel > 127 {
				vel = 127
			}
			note := fillNotes[fillPos%len(fillNotes)]
			bindings[tLabel] = &pflow.MidiBinding{
				Note:     note,
				Channel:  10,
				Velocity: clampVelocity(vel),
				Duration: 40,
			}
		}
	}

	track := pflow.Track{Channel: 10}
	nb := pflow.NewNetBundle(net, track, bindings)
	nb.Role = "control"
	nb.ControlBindings = controlBindings
	return nb
}

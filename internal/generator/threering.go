package generator

import (
	"fmt"
	"math"
	"math/rand"

	"beats-bitwrap-io/internal/pflow"

	"github.com/pflow-xyz/go-pflow/petri"
)

// ThreeRingMelody generates a melody net with 2 interlocking circular loops.
// Ring A is the theme, Ring B is a transposed variation. At the midpoint of
// each ring, a crossover transition lets the token jump to the other ring,
// creating melodic phrases that alternate between theme and variation.
//
// With even-length rings (8 or 16 steps), crossovers always land on beat
// boundaries, keeping the rhythm tight.
func ThreeRingMelody(params Params) *Result {
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

	// Each ring has this many steps (keep even for beat alignment)
	stepsPerRing := params.Steps
	if stepsPerRing <= 0 {
		stepsPerRing = 8
	}
	if stepsPerRing%2 != 0 {
		stepsPerRing++ // force even
	}

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

	isBass := params.RootNote < 48

	// Compose base melody (Ring A = theme)
	seqA := composeSequence(stepsPerRing, n, chordToneSet, isBass, params.Density, rng)
	if params.Syncopation > 0 {
		applySyncopation(seqA, params.Syncopation, rng)
	}

	// Ring B = transposition: shift up by a 3rd (2 scale degrees)
	// keeps the same rhythm and contour but in a different register
	seqB := make([]int, stepsPerRing)
	for i, deg := range seqA {
		if deg < 0 {
			seqB[i] = -1
		} else {
			seqB[i] = (deg + 2) % n
		}
	}

	seqs := [2][]int{seqA, seqB}
	ringNames := [2]string{"a", "b"}

	net := petri.NewPetriNet()
	bindings := make(map[string]*pflow.MidiBinding)

	// Layout: 2 circles side by side
	ringRadius := float64(stepsPerRing) * 60.0 / (2 * math.Pi * 0.7)
	if ringRadius < 120 {
		ringRadius = 120
	}

	spacing := ringRadius * 2.6
	ringCenters := [2][2]float64{
		{ringRadius + 60, ringRadius + 60},           // A: left
		{ringRadius + 60 + spacing, ringRadius + 60}, // B: right
	}

	// Crossover at the midpoint of each ring
	crossoverStep := stepsPerRing / 2

	for ring := 0; ring < 2; ring++ {
		cx := ringCenters[ring][0]
		cy := ringCenters[ring][1]
		prefix := ringNames[ring]
		seq := seqs[ring]

		for i := 0; i < stepsPerRing; i++ {
			// Place
			initial := 0.0
			if ring == 0 && i == 0 {
				initial = 1 // single token starts in ring A
			}
			angle := float64(i) / float64(stepsPerRing) * 2 * math.Pi
			px := cx + ringRadius*0.7*math.Cos(angle)
			py := cy + ringRadius*0.7*math.Sin(angle)
			pLabel := fmt.Sprintf("%s_p%d", prefix, i)
			net.AddPlace(pLabel, initial, nil, px, py, nil)

			// Main transition (stays in this ring)
			tLabel := fmt.Sprintf("%s_t%d", prefix, i)
			tAngle := (float64(i) + 0.5) / float64(stepsPerRing) * 2 * math.Pi
			tx := cx + ringRadius*math.Cos(tAngle)
			ty := cy + ringRadius*math.Sin(tAngle)
			net.AddTransition(tLabel, "", tx, ty, nil)

			// Arcs: place -> transition -> next place
			net.AddArc(pLabel, tLabel, 1.0, false)
			nextP := fmt.Sprintf("%s_p%d", prefix, (i+1)%stepsPerRing)
			net.AddArc(tLabel, nextP, 1.0, false)

			// MIDI binding
			deg := seq[i]
			if deg >= 0 {
				vel := computeVelocity(i, deg, params.Velocity, chordToneSet)
				dur := computeDuration(deg, params.Duration, params.DurationVariation, chordToneSet, rng)
				bindings[tLabel] = &pflow.MidiBinding{
					Note:     notes[deg],
					Channel:  params.Channel,
					Velocity: clampVelocity(vel),
					Duration: dur,
				}
			}

			// At crossover step, add a transition that jumps to the other ring
			if i == crossoverStep {
				otherRing := 1 - ring
				otherPrefix := ringNames[otherRing]

				// Crossover transition: positioned between the two ring centers
				crossLabel := fmt.Sprintf("x_%s_%s", prefix, otherPrefix)
				ocx := ringCenters[otherRing][0]
				ocy := ringCenters[otherRing][1]
				crossX := (cx + ocx) / 2
				crossY := (cy + ocy) / 2
				net.AddTransition(crossLabel, "", crossX, crossY, nil)

				// Arc: source place -> crossover transition -> other ring's entry
				net.AddArc(pLabel, crossLabel, 1.0, false)
				entryP := fmt.Sprintf("%s_p0", otherPrefix)
				net.AddArc(crossLabel, entryP, 1.0, false)

				// Crossover binding: play the destination ring's first note
				crossDeg := seqs[otherRing][0]
				if crossDeg >= 0 {
					bindings[crossLabel] = &pflow.MidiBinding{
						Note:     notes[crossDeg],
						Channel:  params.Channel,
						Velocity: clampVelocity(params.Velocity + 10),
						Duration: params.Duration,
					}
				}
			}
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

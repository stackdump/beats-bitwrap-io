package generator

import (
	"fmt"
	"math"

	"beats-bitwrap-io/internal/pflow"

	"github.com/pflow-xyz/go-pflow/petri"
)

// Euclidean generates a Petri net ring from a Euclidean rhythm pattern.
// K hits distributed across N steps using the Bjorklund algorithm.
// The net is a cycle of N places with 1 circulating token.
// Transitions at hit positions get MIDI bindings; others are silent.
func Euclidean(k, n, rotation int, note int, params Params) *Result {
	pattern := bjorklund(k, n)

	// Apply rotation
	if rotation != 0 {
		rotation = rotation % n
		if rotation < 0 {
			rotation += n
		}
		rotated := make([]int, n)
		for i := range pattern {
			rotated[i] = pattern[(i+rotation)%n]
		}
		pattern = rotated
	}

	net := petri.NewPetriNet()
	bindings := make(map[string]*pflow.MidiBinding)

	// Layout in a circle — scale radius so nodes don't overlap
	cx, cy, radius := ringLayout(n)

	// Create N places in a ring, token starts at p0
	for i := 0; i < n; i++ {
		initial := 0.0
		if i == 0 {
			initial = 1
		}
		angle := float64(i) / float64(n) * 2 * math.Pi // 2*pi
		x := cx + radius*0.7*math.Cos(angle)
		y := cy + radius*0.7*math.Sin(angle)
		label := fmt.Sprintf("p%d", i)
		net.AddPlace(label, initial, nil, x, y, nil)
	}

	// Create N transitions, connecting pi -> ti -> p(i+1 mod n)
	for i := 0; i < n; i++ {
		tLabel := fmt.Sprintf("t%d", i)
		angle := (float64(i) + 0.5) / float64(n) * 2 * math.Pi
		x := cx + radius*math.Cos(angle)
		y := cy + radius*math.Sin(angle)
		net.AddTransition(tLabel, "", x, y, nil)

		// Arc: pi -> ti (consume)
		pLabel := fmt.Sprintf("p%d", i)
		net.AddArc(pLabel, tLabel, 1.0, false)

		// Arc: ti -> p(i+1 mod n) (produce)
		nextP := fmt.Sprintf("p%d", (i+1)%n)
		net.AddArc(tLabel, nextP, 1.0, false)

		// MIDI binding only at hit positions
		if pattern[i] == 1 {
			vel := accentVelocity(i, n, params.Velocity, params.Accent)
			bindings[tLabel] = &pflow.MidiBinding{
				Note:     note,
				Channel:  params.Channel,
				Velocity: clampVelocity(vel),
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
		NetID:  fmt.Sprintf("euclidean_%d_%d", k, n),
	}
}

// EuclideanMelodic generates a ring where every step has a MIDI binding,
// cycling through the provided notes. This creates an arpeggio pattern.
func EuclideanMelodic(notes []int, steps int, seed int64, params Params) *Result {
	if len(notes) == 0 {
		notes = []int{60}
	}

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

		// Cycle through notes
		note := notes[i%len(notes)]
		bindings[tLabel] = &pflow.MidiBinding{
			Note:     note,
			Channel:  params.Channel,
			Velocity: params.Velocity,
			Duration: params.Duration,
		}
	}

	track := pflow.Track{
		Channel:         params.Channel,
		DefaultVelocity: params.Velocity,
	}

	return &Result{
		Bundle: pflow.NewNetBundle(net, track, bindings),
		NetID:  "arp",
	}
}

// bjorklund distributes K pulses across N steps as evenly as possible.
func bjorklund(k, n int) []int {
	if k >= n {
		result := make([]int, n)
		for i := range result {
			result[i] = 1
		}
		return result
	}
	if k == 0 {
		return make([]int, n)
	}

	// Build groups
	groups := make([][]int, n)
	for i := 0; i < n; i++ {
		if i < k {
			groups[i] = []int{1}
		} else {
			groups[i] = []int{0}
		}
	}

	// Iteratively merge
	for {
		remainder := len(groups) - k
		if remainder <= 1 {
			break
		}
		merges := k
		if remainder < merges {
			merges = remainder
		}
		newGroups := make([][]int, 0, len(groups)-merges)
		for i := 0; i < merges; i++ {
			newGroups = append(newGroups, append(groups[i], groups[len(groups)-1-i]...))
		}
		for i := merges; i < len(groups)-merges; i++ {
			newGroups = append(newGroups, groups[i])
		}
		groups = newGroups
		k = merges
		if len(groups)-k <= 1 {
			break
		}
	}

	// Flatten
	result := make([]int, 0, n)
	for _, g := range groups {
		result = append(result, g...)
	}
	return result
}

// ringLayout returns center and radius for a ring of n nodes.
// Places sit at 0.7*radius, so we size based on that inner ring.
// Each place needs ~70px spacing: innerCircumference = 2*pi*0.7*r >= n*70
func ringLayout(n int) (cx, cy, radius float64) {
	radius = float64(n) * 70.0 / (2 * math.Pi * 0.7)
	if radius < 150 {
		radius = 150
	}
	cx = radius + 80
	cy = radius + 80
	return
}

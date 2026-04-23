package generator

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"time"

	"beats-bitwrap-io/internal/pflow"

	"github.com/pflow-xyz/go-pflow/petri"
)

// Arrange takes an existing project of looping music nets and wraps them
// with song structure (control nets, variants, sections). This allows
// hand-composed Petri nets to become full tracks with intro/verse/drop/etc.
func Arrange(proj *pflow.Project, genre, size string) {
	rng := rand.New(rand.NewSource(time.Now().UnixNano()))

	// Collect music net IDs (skip any existing control nets)
	var musicRoles []string
	for netId, nb := range proj.Nets {
		if nb.Role == "control" {
			continue
		}
		musicRoles = append(musicRoles, netId)
	}

	// Generate structure template, scoped to the roles we actually have
	tmpl := generateArrangeStructure(genre, size, musicRoles, rng)

	// Create variants: clone each music net as A, tweak copies for B/C
	expandArrangeVariants(proj, tmpl, musicRoles, rng)

	// Collect all net IDs after variant expansion
	var allNets []string
	for netId, nb := range proj.Nets {
		if nb.Role != "control" {
			allNets = append(allNets, netId)
		}
	}

	// Build control nets and get initial mutes
	initialMutes := SongStructure(proj, tmpl, allNets)
	proj.InitialMutes = initialMutes
}

// generateArrangeStructure creates a SongTemplate scoped to the roles present.
func generateArrangeStructure(genreName, size string, roles []string, rng *rand.Rand) *SongTemplate {
	roleSet := make(map[string]bool, len(roles))
	for _, r := range roles {
		roleSet[r] = true
	}

	family := genreFamilies[genreName]
	blueprints, ok := structureBlueprints[family][size]
	if !ok {
		blueprints = structureBlueprints[familySong]["standard"]
	}
	blueprint := blueprints[rng.Intn(len(blueprints))]

	sections := make([]Section, len(blueprint))
	for i, name := range blueprint {
		// Start from archetype, intersect with actual roles
		active := make(map[string]bool)
		if archetype, ok := sectionArchetypes[name]; ok {
			for k := range archetype {
				if roleSet[k] {
					active[k] = true
				}
			}
		}
		// For custom roles not in archetypes, use section-based heuristics
		for _, r := range roles {
			if active[r] {
				continue // already included
			}
			if _, isArchetype := sectionArchetypes[name][r]; isArchetype {
				continue // archetype says no
			}
			// Custom role: include based on section energy
			switch name {
			case "intro", "outro":
				// Skip custom roles in intro/outro for sparse feel
			case "breakdown", "bridge":
				// Include pad/synth-like custom roles
				active[r] = true
			default:
				// verse, chorus, drop, buildup, etc: include everything
				active[r] = true
			}
		}
		if len(active) == 0 {
			for _, r := range roles {
				active[r] = true
			}
		}

		steps := sectionSteps(name, size)
		sections[i] = sectionWithPhrases(name, steps, active)
	}

	return &SongTemplate{Name: size, Sections: sections}
}

// expandArrangeVariants clones existing music nets into A/B/C variants.
func expandArrangeVariants(proj *pflow.Project, tmpl *SongTemplate, roles []string, rng *rand.Rand) {
	tmpl.SlotMap = make(map[string][][]int)

	rolesInPhrases := make(map[string]bool)
	for _, sec := range tmpl.Sections {
		for role := range sec.Phrases {
			rolesInPhrases[role] = true
		}
	}

	for _, role := range roles {
		if !rolesInPhrases[role] {
			continue
		}
		baseBundle, ok := proj.Nets[role]
		if !ok {
			continue
		}

		// Build slot map — reuse same slot for same letter
		slotMap := make([][]int, len(tmpl.Sections))
		slotIdx := 0
		letterSlots := make(map[string]int)

		for si, sec := range tmpl.Sections {
			phrases := sec.Phrases[role]
			if len(phrases) == 0 {
				phrases = []string{"A"}
			}
			sectionSlots := make([]int, len(phrases))
			if sec.Active[role] {
				for pi, letter := range phrases {
					if existing, ok := letterSlots[letter]; ok {
						sectionSlots[pi] = existing
					} else {
						letterSlots[letter] = slotIdx
						sectionSlots[pi] = slotIdx
						slotIdx++
					}
				}
			} else {
				for pi := range phrases {
					sectionSlots[pi] = -1
				}
			}
			slotMap[si] = sectionSlots
		}
		tmpl.SlotMap[role] = slotMap

		if slotIdx <= 1 {
			baseBundle.RiffGroup = role
			baseBundle.RiffVariant = "A"
			continue
		}

		// Create variant nets by cloning and tweaking velocity
		for letter, idx := range letterSlots {
			slotNetId := fmt.Sprintf("%s-%d", role, idx)
			clone := cloneBundle(baseBundle)
			clone.RiffGroup = role
			clone.RiffVariant = letter

			switch letter {
			case "B":
				tweakVelocity(clone, 15)
			case "C":
				tweakVelocity(clone, -15)
			}
			proj.Nets[slotNetId] = clone
		}
		delete(proj.Nets, role)
	}
}

// cloneBundle deep-copies a NetBundle via JSON round-trip.
func cloneBundle(nb *pflow.NetBundle) *pflow.NetBundle {
	data := pflow.BundleToJSON(nb)
	raw, _ := json.Marshal(data)
	var parsed map[string]interface{}
	json.Unmarshal(raw, &parsed)
	return pflow.ParseBundle(parsed)
}

// tweakVelocity adjusts all MIDI binding velocities by delta.
func tweakVelocity(nb *pflow.NetBundle, delta int) {
	for _, binding := range nb.Bindings {
		if binding == nil {
			continue
		}
		v := binding.Velocity + delta
		if v < 1 {
			v = 1
		}
		if v > 127 {
			v = 127
		}
		binding.Velocity = v
	}
}

// FadeIn adds control nets that sequentially unmute targets over time.
// Each target gets a long-cycle control net that fires an unmute action
// after a staggered offset. Targets should start muted.
func FadeIn(proj *pflow.Project, targets []string, steps int, seed int64) []string {
	if steps < 8 {
		steps = 32
	}
	rng := rand.New(rand.NewSource(seed))
	_ = rng

	var mutedNets []string
	for i, target := range targets {
		if _, ok := proj.Nets[target]; !ok {
			continue
		}
		mutedNets = append(mutedNets, target)

		// Stagger: each target unmutes at a different offset in the cycle
		offset := (i + 1) * (steps / (len(targets) + 1))
		netId := fmt.Sprintf("fade-in-%s", target)
		ctrl := fadeControlNet(target, "unmute-track", steps, offset)
		proj.Nets[netId] = ctrl
	}
	return mutedNets
}

// FadeOut adds control nets that sequentially mute targets toward end of cycle.
// Targets are muted in order with staggered offsets.
func FadeOut(proj *pflow.Project, targets []string, steps int, seed int64) {
	if steps < 8 {
		steps = 32
	}
	rng := rand.New(rand.NewSource(seed))
	_ = rng

	for i, target := range targets {
		if _, ok := proj.Nets[target]; !ok {
			continue
		}
		// Stagger from end: first target mutes earliest
		offset := steps - (len(targets)-i)*(steps/(len(targets)+1))
		netId := fmt.Sprintf("fade-out-%s", target)
		ctrl := fadeControlNet(target, "mute-track", steps, offset)
		proj.Nets[netId] = ctrl
	}
}

// fadeControlNet creates a single-hit control net in a ring of `steps` places.
// The control binding fires at position `hitPos`.
func fadeControlNet(targetNet, action string, steps, hitPos int) *pflow.NetBundle {
	if hitPos >= steps {
		hitPos = steps - 1
	}

	net := petri.NewPetriNet()
	controlBindings := make(map[string]*pflow.ControlBinding)

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

		if i == hitPos {
			controlBindings[tLabel] = &pflow.ControlBinding{
				Action:    action,
				TargetNet: targetNet,
			}
		}
	}

	track := pflow.Track{Channel: 1}
	nb := pflow.NewNetBundle(net, track, make(map[string]*pflow.MidiBinding))
	nb.Role = "control"
	nb.ControlBindings = controlBindings
	return nb
}

// DrumBreak adds a control net that toggles targets off together for a break,
// then brings them back. Two control transitions: one mutes, one unmutes,
// in a long cycle with rotation offset.
func DrumBreak(proj *pflow.Project, targets []string, cycleLen, breakLen int, seed int64) {
	if cycleLen < 16 {
		cycleLen = 64
	}
	if breakLen < 4 {
		breakLen = 8
	}
	if breakLen >= cycleLen {
		breakLen = cycleLen / 4
	}

	for _, target := range targets {
		if _, ok := proj.Nets[target]; !ok {
			continue
		}

		net := petri.NewPetriNet()
		controlBindings := make(map[string]*pflow.ControlBinding)

		cx, cy, radius := ringLayout(cycleLen)

		// Mute position and unmute position
		mutePos := cycleLen / 2
		unmutePos := mutePos + breakLen

		for i := 0; i < cycleLen; i++ {
			initial := 0.0
			if i == 0 {
				initial = 1
			}
			angle := float64(i) / float64(cycleLen) * 2 * math.Pi
			x := cx + radius*0.7*math.Cos(angle)
			y := cy + radius*0.7*math.Sin(angle)
			pLabel := fmt.Sprintf("p%d", i)
			net.AddPlace(pLabel, initial, nil, x, y, nil)

			tLabel := fmt.Sprintf("t%d", i)
			tAngle := (float64(i) + 0.5) / float64(cycleLen) * 2 * math.Pi
			tx := cx + radius*math.Cos(tAngle)
			ty := cy + radius*math.Sin(tAngle)
			net.AddTransition(tLabel, "", tx, ty, nil)

			net.AddArc(pLabel, tLabel, 1.0, false)
			nextP := fmt.Sprintf("p%d", (i+1)%cycleLen)
			net.AddArc(tLabel, nextP, 1.0, false)

			if i == mutePos {
				controlBindings[tLabel] = &pflow.ControlBinding{
					Action:    "mute-track",
					TargetNet: target,
				}
			} else if i == unmutePos%cycleLen {
				controlBindings[tLabel] = &pflow.ControlBinding{
					Action:    "unmute-track",
					TargetNet: target,
				}
			}
		}

		track := pflow.Track{Channel: 1}
		nb := pflow.NewNetBundle(net, track, make(map[string]*pflow.MidiBinding))
		nb.Role = "control"
		nb.ControlBindings = controlBindings

		netId := fmt.Sprintf("break-%s", target)
		proj.Nets[netId] = nb
	}
}

// Chorus adds a harmony net — duplicates the melody Markov net on a different
// channel, transposed up a 5th (7 semitones).
func Chorus(proj *pflow.Project, genre Genre, rng *rand.Rand) {
	melodyRoot := genre.RootNote + 12 + 7 // one octave up + perfect 5th
	harmonyParams := Params{
		Scale:    genre.Scale(melodyRoot),
		RootNote: melodyRoot,
		Channel:  7, // harmony on channel 7
		Velocity: 75,
		Duration: genre.MelodyDuration,
		Density:  genre.MelodyDensity * 0.8,
		Seed:     rng.Int63(),
	}
	harmony := MarkovMelody(harmonyParams)
	proj.Nets["harmony"] = harmony.Bundle

	// Assign instrument set from genre if available
	if sets, ok := GenreInstrumentSets[genre.Name]; ok {
		if instruments, ok := sets["melody"]; ok && len(instruments) > 0 {
			proj.Nets["harmony"].Track.InstrumentSet = instruments
			proj.Nets["harmony"].Track.Instrument = instruments[rng.Intn(len(instruments))]
		}
	}
}

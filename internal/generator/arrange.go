package generator

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"sort"
	"time"

	"beats-bitwrap-io/internal/pflow"

	"github.com/pflow-xyz/go-pflow/petri"
)

// Arrange takes an existing project of looping music nets and wraps them
// with song structure (control nets, variants, sections). This allows
// hand-composed Petri nets to become full tracks with intro/verse/drop/etc.
func Arrange(proj *pflow.Project, genre, size string) {
	ArrangeSeeded(proj, genre, size, time.Now().UnixNano())
}

// ArrangeSeeded is the deterministic form — shares carrying a structure
// directive pass a fixed seed so the same (nets, structure, seed) tuple
// always expands to the same full track byte-for-byte.
func ArrangeSeeded(proj *pflow.Project, genre, size string, seed int64) {
	ArrangeWithOpts(proj, genre, size, ArrangeOpts{Seed: seed})
}

// ArrangeOpts carries the extensible arrange vocabulary. New knobs get
// added as fields here without breaking signatures of existing callers.
type ArrangeOpts struct {
	// Seed controls RNG-driven choices (blueprint pick, phrase variety,
	// velocity humanization). Fixed seed = deterministic expansion.
	Seed int64

	// VelocityDeltas overrides per-variant velocity offsets. Keyed by
	// riff-variant letter: {"A":0, "B":15, "C":-15} is the default.
	// Lets authors make the drop hit harder or the breakdown sit further
	// back without changing the blueprint.
	VelocityDeltas map[string]int

	// MaxVariants caps the number of distinct riff-variant letters per
	// role. 0 = no cap (use whatever the blueprint asks for). Useful for
	// wrapped tracks that only want A/B and never a third variant.
	MaxVariants int

	// FadeIn lists roles that should start muted and unmute mid-intro.
	// Uses the existing FadeIn helper to inject a control net that fires
	// unmute-track at a hit position inside the first section.
	FadeIn []string

	// DrumBreak injects a fixed-length drum-only break at the midpoint
	// of the track. BreakBars = 0 disables. Non-drum roles are muted
	// for BreakBars, drums keep playing, then everyone returns.
	DrumBreak int

	// Sections, when non-empty, bypasses the built-in blueprint pick
	// and uses the supplied section list directly. Each entry names
	// the section, duration in ticks, and which roles should play.
	Sections []AuthorSection

	// FeelCurve snaps the Feel XY puck to a point at the start of each
	// listed section. Each entry carries the section name and a puck
	// in [0,1]² ([x, y] for Chill/Drive/Ambient/Euphoric blending).
	// Fires via a control net → frontend applyFeel on set-feel events.
	FeelCurve []FeelPoint

	// MacroCurve schedules `fire-macro` control events at section starts.
	// Each entry names the macro id (from the frontend catalog — e.g.
	// "riser", "beat-repeat", "reverb-wash") plus the duration in bars.
	// Resolves via a dedicated "macro-curve" control net, same mechanism
	// as feel-curve but dispatching fire-macro.
	MacroCurve []MacroPoint

	// OverlayOnly skips blueprint pick + variant expansion + section
	// control-net generation, using the project's existing `Structure`
	// field as the section map. Only runs the overlay passes
	// (fadeIn/drumBreak/feelCurve/macroCurve). This is how composer-
	// generated tracks get arrange-time curves layered on top of their
	// already-expanded structure without a destructive re-arrange.
	OverlayOnly bool
}

// AuthorSection is an author-supplied entry for ArrangeOpts.Sections.
// When provided, these replace the blueprint-derived sections entirely.
type AuthorSection struct {
	Name   string   `json:"name"`
	Steps  int      `json:"steps"`
	Active []string `json:"active"`
}

// FeelPoint is one entry in a FeelCurve — which section to snap on,
// and the target puck [x, y] (each in [0,1]).
type FeelPoint struct {
	Section string  `json:"section"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
}

// MacroPoint is one entry in a MacroCurve — which section to fire at,
// the macro id (looked up in public/lib/macros/catalog.js on the client),
// and the auto-release duration in bars. Matches the ControlBinding
// shape the runtime already consumes.
type MacroPoint struct {
	Section string  `json:"section"`
	Macro   string  `json:"macro"`
	Bars    float64 `json:"bars,omitempty"`
}

// ArrangeWithOpts is the canonical entry point — other forms wrap it.
func ArrangeWithOpts(proj *pflow.Project, genre, size string, opts ArrangeOpts) {
	// Overlay mode: skip structure + variant expansion, only run the
	// overlay passes against the project's existing Structure. This is
	// how composer-generated tracks receive arrange-time curves layered
	// on top of their already-expanded structure.
	if opts.OverlayOnly {
		tmpl := projectStructureToTemplate(proj)
		if tmpl == nil {
			return
		}
		applyArrangeOverlays(proj, tmpl, sortedMusicNetIDs(proj), opts)
		return
	}

	rng := rand.New(rand.NewSource(opts.Seed))

	// Collect music net IDs in sorted order — Go map iteration is
	// intentionally randomised, but `seed` is a determinism contract
	// with share-envelope callers, so we sort before touching rng.
	musicRoles := sortedMusicNetIDs(proj)

	// Generate structure template, scoped to the roles we actually have
	var tmpl *SongTemplate
	if len(opts.Sections) > 0 {
		tmpl = authorSectionsToTemplate(opts.Sections, musicRoles)
	} else {
		tmpl = generateArrangeStructure(genre, size, musicRoles, rng)
	}

	// Apply MaxVariants cap by collapsing late letters back to "A".
	if opts.MaxVariants > 0 {
		capVariantLetters(tmpl, opts.MaxVariants)
	}

	// Create variants: clone each music net as A, tweak copies for B/C
	expandArrangeVariantsOpts(proj, tmpl, musicRoles, rng, opts)

	// Collect all net IDs after variant expansion (also sorted).
	allNets := sortedMusicNetIDs(proj)

	// Build control nets and get initial mutes
	initialMutes := SongStructure(proj, tmpl, allNets)
	proj.InitialMutes = initialMutes

	applyArrangeOverlays(proj, tmpl, allNets, opts)
}

// applyArrangeOverlays runs the non-structural passes — fadeIn,
// drumBreak, feelCurve, macroCurve — shared between the full-arrange
// path and the overlay-only path.
func applyArrangeOverlays(proj *pflow.Project, tmpl *SongTemplate, allNets []string, opts ArrangeOpts) {
	if len(opts.FadeIn) > 0 {
		introSteps := 128
		if len(tmpl.Sections) > 0 {
			introSteps = tmpl.Sections[0].Steps
		}
		var variantTargets []string
		for _, role := range opts.FadeIn {
			for _, id := range allNets {
				if id == role || (len(id) > len(role) && id[:len(role)+1] == role+"-") {
					variantTargets = append(variantTargets, id)
				}
			}
		}
		if len(variantTargets) > 0 {
			fadeMutes := FadeIn(proj, variantTargets, introSteps, opts.Seed)
			proj.InitialMutes = append(proj.InitialMutes, fadeMutes...)
		}
	}

	if opts.DrumBreak > 0 {
		var drumTargets []string
		for _, id := range allNets {
			nb := proj.Nets[id]
			if nb == nil {
				continue
			}
			if isDrumRoleName(id) {
				continue
			}
			// Stinger tracks stay muted at all times — the Beats-tab
			// Fire pads are the only legitimate way to unmute them.
			// Excluding from drum-break so the break-end unmute doesn't
			// secretly turn every hit* voice on.
			if pflow.IsStingerNet(id, nb) {
				continue
			}
			drumTargets = append(drumTargets, id)
		}
		totalSteps := 0
		for _, sec := range tmpl.Sections {
			totalSteps += sec.Steps
		}
		if totalSteps > 0 {
			DrumBreak(proj, drumTargets, totalSteps, opts.DrumBreak*16, opts.Seed)
		}
	}

	if len(opts.FeelCurve) > 0 {
		injectFeelCurve(proj, tmpl, opts.FeelCurve)
	}

	if len(opts.MacroCurve) > 0 {
		injectMacroCurve(proj, tmpl, opts.MacroCurve)
	}
}

// projectStructureToTemplate rebuilds a SongTemplate from proj.Structure
// so overlay-mode arrange can reuse the same tick-position math the full
// arrange path uses. Returns nil when the project has no structure set.
func projectStructureToTemplate(proj *pflow.Project) *SongTemplate {
	if len(proj.Structure) == 0 {
		return nil
	}
	sections := make([]Section, len(proj.Structure))
	for i, s := range proj.Structure {
		sections[i] = Section{Name: s.Name, Steps: s.Steps, Phrases: s.Phrases}
	}
	return &SongTemplate{Name: "overlay", Sections: sections}
}

// authorSectionsToTemplate builds a SongTemplate from a user-supplied
// sections list. Any role not listed in Active is marked inactive for
// that section (i.e. muted there).
func authorSectionsToTemplate(authored []AuthorSection, roles []string) *SongTemplate {
	sections := make([]Section, len(authored))
	for i, a := range authored {
		active := make(map[string]bool)
		activeSet := make(map[string]bool, len(a.Active))
		for _, r := range a.Active {
			activeSet[r] = true
		}
		for _, r := range roles {
			if activeSet[r] {
				active[r] = true
			}
		}
		steps := a.Steps
		if steps <= 0 {
			steps = 128
		}
		sections[i] = sectionWithPhrases(a.Name, steps, active)
	}
	return &SongTemplate{Name: "authored", Sections: sections}
}

// isDrumRoleName matches net IDs that look like drum tracks. Matches the
// frontend convention (kick/snare/hat/hihat/clap/cymbal/drum prefixes).
func isDrumRoleName(id string) bool {
	for _, prefix := range []string{"kick", "snare", "hat", "hihat", "clap", "cymbal", "tom", "drum", "perc"} {
		if len(id) >= len(prefix) && id[:len(prefix)] == prefix {
			return true
		}
	}
	return false
}

// injectFeelCurve adds a single control net named "feel-curve" whose
// transitions fire set-feel actions at the tick boundaries of the
// named sections. The worker broadcasts control-fired; the frontend
// applyFeel handler snaps the puck.
func injectFeelCurve(proj *pflow.Project, tmpl *SongTemplate, curve []FeelPoint) {
	// Map section name → start tick.
	startTicks := make(map[string]int, len(tmpl.Sections))
	cum := 0
	for _, sec := range tmpl.Sections {
		if _, seen := startTicks[sec.Name]; !seen {
			startTicks[sec.Name] = cum
		}
		cum += sec.Steps
	}
	totalSteps := cum
	if totalSteps == 0 {
		return
	}

	// Filter curve entries to those whose section exists; compute ticks.
	type resolved struct {
		tick int
		x, y float64
	}
	var points []resolved
	for _, fp := range curve {
		if t, ok := startTicks[fp.Section]; ok {
			points = append(points, resolved{tick: t, x: fp.X, y: fp.Y})
		}
	}
	if len(points) == 0 {
		return
	}
	// Sort by tick ascending.
	sort.Slice(points, func(i, j int) bool { return points[i].tick < points[j].tick })

	// Build a linear-chain control net of length totalSteps. Place an
	// initial token at p0, token advances one step per tick. At each
	// resolved tick, the transition fires set-feel{x,y}.
	net := petri.NewPetriNet()
	bindings := make(map[string]*pflow.MidiBinding)
	controlBindings := make(map[string]*pflow.ControlBinding)

	for i := 0; i < totalSteps; i++ {
		var initial any
		if i == 0 {
			initial = []float64{1}
		}
		net.AddPlace(fmt.Sprintf("fp%d", i), initial, nil, 0, 0, nil)
		net.AddTransition(fmt.Sprintf("ft%d", i), "", 0, 0, nil)
		net.AddArc(fmt.Sprintf("fp%d", i), fmt.Sprintf("ft%d", i), []float64{1}, false)
		next := (i + 1) % totalSteps
		net.AddArc(fmt.Sprintf("ft%d", i), fmt.Sprintf("fp%d", next), []float64{1}, false)
	}
	for _, p := range points {
		controlBindings[fmt.Sprintf("ft%d", p.tick)] = &pflow.ControlBinding{
			Action: "set-feel",
			MacroParams: map[string]any{
				"x": p.x,
				"y": p.y,
			},
		}
	}

	nb := pflow.NewNetBundle(net, pflow.Track{Channel: 16}, bindings)
	nb.Role = "control"
	nb.ControlBindings = controlBindings
	proj.Nets["feel-curve"] = nb
}

// injectMacroCurve adds a single control net "macro-curve" whose
// transitions fire fire-macro actions at the tick boundaries of the
// named sections. Runtime dispatches through the frontend's existing
// fire-macro handler, so any macro id the client catalog knows about
// is valid ("riser", "beat-repeat", "reverb-wash", etc.).
func injectMacroCurve(proj *pflow.Project, tmpl *SongTemplate, curve []MacroPoint) {
	startTicks := make(map[string]int, len(tmpl.Sections))
	cum := 0
	for _, sec := range tmpl.Sections {
		if _, seen := startTicks[sec.Name]; !seen {
			startTicks[sec.Name] = cum
		}
		cum += sec.Steps
	}
	totalSteps := cum
	if totalSteps == 0 {
		return
	}

	type resolved struct {
		tick  int
		macro string
		bars  float64
	}
	var points []resolved
	for _, mp := range curve {
		if mp.Macro == "" {
			continue
		}
		if t, ok := startTicks[mp.Section]; ok {
			points = append(points, resolved{tick: t, macro: mp.Macro, bars: mp.Bars})
		}
	}
	if len(points) == 0 {
		return
	}
	sort.Slice(points, func(i, j int) bool { return points[i].tick < points[j].tick })

	net := petri.NewPetriNet()
	bindings := make(map[string]*pflow.MidiBinding)
	controlBindings := make(map[string]*pflow.ControlBinding)

	for i := 0; i < totalSteps; i++ {
		var initial any
		if i == 0 {
			initial = []float64{1}
		}
		net.AddPlace(fmt.Sprintf("mp%d", i), initial, nil, 0, 0, nil)
		net.AddTransition(fmt.Sprintf("mt%d", i), "", 0, 0, nil)
		net.AddArc(fmt.Sprintf("mp%d", i), fmt.Sprintf("mt%d", i), []float64{1}, false)
		next := (i + 1) % totalSteps
		net.AddArc(fmt.Sprintf("mt%d", i), fmt.Sprintf("mp%d", next), []float64{1}, false)
	}
	for _, p := range points {
		cb := &pflow.ControlBinding{
			Action: "fire-macro",
			Macro:  p.macro,
		}
		if p.bars > 0 {
			cb.MacroBars = p.bars
		}
		controlBindings[fmt.Sprintf("mt%d", p.tick)] = cb
	}

	nb := pflow.NewNetBundle(net, pflow.Track{Channel: 16}, bindings)
	nb.Role = "control"
	nb.ControlBindings = controlBindings
	proj.Nets["macro-curve"] = nb
}

// capVariantLetters rewrites any phrase letter beyond the first N of
// the alphabet back to "A". E.g. MaxVariants=2 collapses C/D→A so only
// A and B ever spawn as distinct variants.
func capVariantLetters(tmpl *SongTemplate, max int) {
	if max <= 0 {
		return
	}
	allowed := make(map[string]bool, max)
	for i := 0; i < max; i++ {
		allowed[string(rune('A'+i))] = true
	}
	for _, sec := range tmpl.Sections {
		for role, phrases := range sec.Phrases {
			for i, letter := range phrases {
				if !allowed[letter] {
					phrases[i] = "A"
				}
			}
			sec.Phrases[role] = phrases
		}
	}
}

func sortedMusicNetIDs(proj *pflow.Project) []string {
	ids := make([]string, 0, len(proj.Nets))
	for netID, nb := range proj.Nets {
		if nb.Role == "control" {
			continue
		}
		ids = append(ids, netID)
	}
	sort.Strings(ids)
	return ids
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

// expandArrangeVariantsOpts is the opts-aware form. Thin wrapper:
// resolves velocity deltas from opts, then calls the core expander.
func expandArrangeVariantsOpts(proj *pflow.Project, tmpl *SongTemplate, roles []string, rng *rand.Rand, opts ArrangeOpts) {
	deltas := opts.VelocityDeltas
	if deltas == nil {
		deltas = map[string]int{"A": 0, "B": 15, "C": -15}
	}
	expandArrangeVariants(proj, tmpl, roles, rng, deltas)
}

// expandArrangeVariants clones existing music nets into A/B/C variants.
func expandArrangeVariants(proj *pflow.Project, tmpl *SongTemplate, roles []string, rng *rand.Rand, deltas map[string]int) {
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
		// Stingers never get variant-expanded. The Beats-tab Fire pads
		// look up `hit1`/`hit2`/... by exact ID, so cloning them into
		// hit1-0/hit1-1/hit1-2 would leave those pads targetless.
		if pflow.IsStingerNet(role, baseBundle) {
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

			if d, ok := deltas[letter]; ok && d != 0 {
				tweakVelocity(clone, d)
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

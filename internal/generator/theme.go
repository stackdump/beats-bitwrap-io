package generator

// Cohesion v2 — TrackTheme is the track-wide musical state that makes a
// section feel like part of one song instead of a stitched pastiche.
//
// Three pieces:
//   - Motif:       a 16-step scale-degree sequence that returns across sections,
//                  transposed / fragmented / augmented per SectionProfile.MotifMode.
//   - HarmonicMap: section name -> chord-rotation offset, so drop2 can land on
//                  IV instead of I while reusing the same motif degrees.
//   - Groove:      how bass note-onsets relate to kick hits (FourOnFloor,
//                  Sidechained, …). The bass rhythm is a deterministic function
//                  of the kick mask, not an independent Markov walk.
//
// All three are derived from (genre, seed) and stored on Project.Theme. They
// are NOT carried in the share envelope — the envelope's `cohesion: "v2"` flag
// re-runs BuildTrackTheme on load, so the envelope stays small and existing
// CIDs (no flag) keep their byte-identical canonical form.

import (
	"fmt"
	"math"
	"os"

	"beats-bitwrap-io/internal/pflow"

	"github.com/pflow-xyz/go-pflow/petri"
)

// MotifMode is the grammar of motif recall — how a section consumes the
// canonical motif. Small enumerated palette so the engine stays rule-based.
type MotifMode int

const (
	MotifIgnore     MotifMode = iota // role doesn't sing the motif (drums, bass usually)
	MotifPlay                        // play motif verbatim (chorus / drop)
	MotifTransposed                  // shift degrees by HarmonicMap offset
	MotifFragment                    // first half only, rest as silence (buildup tease)
	MotifAugmented                   // each step held 2x (breakdown: motif slowed)
	MotifInverted                    // contour flipped
	MotifLayered                     // motif + countermelody overlay
)

// MotifCell is the canonical motif as scale degrees + rhythm mask.
// Degrees use scale-degree indices (0 = tonic, 1 = supertonic, …) not MIDI
// numbers, so the same cell transposes when the harmony moves.
//
// Mask[i] == false means "rest" — emitted as a silent transition in the net,
// regardless of Degrees[i].
type MotifCell struct {
	Degrees []int // scale degree per step; len = motif length
	Mask    []bool
	Contour int8 // -1 down, 0 flat, +1 up — used by MotifInverted
}

// ChordPlan is the track's harmonic clock: the progression (picked
// deterministically from the genre's theory table) paced at one chord per
// bar. Slice 2 makes this drive three things at once — the pad voicing,
// the bass root walk, and the motif's strong-beat chord-tone targets —
// which is what gives the track harmonic motion instead of a static
// one-chord drone.
type ChordPlan struct {
	Chords        []ChordDegree
	StepsPerChord int // 16 = one bar per chord at 16 steps/bar
}

// CycleSteps is the full harmonic cycle length in steps.
func (cp ChordPlan) CycleSteps() int {
	return len(cp.Chords) * cp.StepsPerChord
}

// ChordAt returns the chord sounding at the given step (wrapping).
func (cp ChordPlan) ChordAt(step int) ChordDegree {
	if len(cp.Chords) == 0 {
		return ChordDegree{Root: 0, Tones: []int{0, 2, 4}}
	}
	idx := (step / cp.StepsPerChord) % len(cp.Chords)
	return cp.Chords[idx]
}

// TrackTheme bundles the track-wide musical state. Attached to Project.Theme
// when cohesion: "v2".
type TrackTheme struct {
	Motif       MotifCell
	Plan        ChordPlan
	HarmonicMap map[string]int // section name -> chord-rotation offset (scale degrees)
	Groove      GrooveTemplate
	Energy      map[string]SectionProfile // section name -> profile (see energy.go)
}

// DefaultCohesion is the generator pipeline used when a request doesn't
// specify params.cohesion. "v2" (harmonic motion + phrase-grammar motif)
// since slice 2 was validated by listening. Two escape hatches back to
// legacy:
//   - per request: params.cohesion = "v1" (API / envelope / URL)
//   - server-wide: BEATS_COHESION_DEFAULT=v1 in the environment
//
// Old sealed envelopes (no cohesion field) are NOT affected by this
// default — the share boot path pins them to "v1" explicitly so existing
// ?cid= links keep reproducing their original sound (see
// public/lib/share/url.js::shareFromPayload).
var DefaultCohesion = func() string {
	if v := os.Getenv("BEATS_COHESION_DEFAULT"); v == "v1" || v == "v2" {
		return v
	}
	return "v2"
}()

// cohesionGenreSupported gates which genres opt into v2. Adding a genre
// here requires the corresponding family's role-profile table to exist
// in energy.go (roleProfilesEDM / roleProfilesSong / …) — without that,
// MotifMode defaults to Ignore everywhere and the v2 melody slot falls
// through to the v1 Markov path, which defeats the recall mechanism.
func cohesionGenreSupported(name string) bool {
	switch name {
	case "techno", "synthwave", "trance":
		return true
	}
	return false
}

// BuildTrackTheme derives the track-wide theme from (genre, seed). Pure
// function of its inputs — identical inputs produce byte-identical theme,
// which is what makes shared cohesion: "v2" envelopes reproducible.
//
// RNG note: this function uses mulberry32 (composer.go::mulberry32Intn) with
// state-init = uint32(seed) ^ hashStr("theme/"+genre). The same formula
// runs in public/lib/generator/theme.js; the parity tests in
// theme_parity_test.go pin a fixture vector both sides must reproduce.
// Using math/rand here instead would silently break Go/JS share-link
// playback equivalence.
func BuildTrackTheme(genreName string, seed int64) *TrackTheme {
	g, ok := Genres[genreName]
	if !ok {
		g = Genres["techno"]
	}

	state := uint32(seed) ^ hashStr("theme/"+genreName)

	// Draw #1: pick the chord progression from the genre's theory table.
	// MUST be the first draw — JS replays the identical stream and any
	// reordering desynchronizes every draw after it.
	plan := ChordPlan{StepsPerChord: 16}
	if g.Theory != nil && len(g.Theory.ChordProgs) > 0 {
		prog := g.Theory.ChordProgs[mulberry32Intn(&state, len(g.Theory.ChordProgs))]
		plan.Chords = append(plan.Chords, prog.Chords...)
	} else {
		// Defensive fallback (cohesionGenreSupported genres all have
		// theory entries) — still burn the draw so the stream stays
		// aligned if this branch is ever hit.
		_ = mulberry32Intn(&state, 1)
		plan.Chords = []ChordDegree{
			{Root: 0, Tones: []int{0, 2, 4}},
			{Root: 5, Tones: []int{5, 0, 2}},
			{Root: 3, Tones: []int{3, 5, 0}},
			{Root: 6, Tones: []int{6, 1, 3}},
		}
	}

	scaleLen := 7 // diatonic
	motif := generateMotif(&state, scaleLen, plan)

	// HarmonicMap: most sections sit on I; drop2 lands on IV (offset +3
	// in diatonic degrees), bridge on vi (+5). Keeps the motif degrees
	// the same — RenderMotif shifts by the section's offset.
	harmonic := map[string]int{
		"intro":     0,
		"verse":     0,
		"buildup":   0,
		"drop":      0,
		"breakdown": 0,
		"bridge":    5,
		"chorus":    0,
		"outro":     0,
		"solo":      4,
	}

	family := genreFamilies[genreName]
	groove := defaultGrooveFor(genreName, g)
	energy := energyProfilesFor(family, genreName)

	return &TrackTheme{
		Motif:       motif,
		Plan:        plan,
		HarmonicMap: harmonic,
		Groove:      groove,
		Energy:      energy,
	}
}

// generateMotif draws a 4-bar (64-step) scale-degree sequence with phrase
// grammar — the slice-2 rewrite of the old bounded-random-walk motif:
//
//   - Bars 0-1 are the QUESTION: a melodic gesture that ends away from the
//     tonic (on the third of bar 1's chord), leaving tension hanging.
//   - Bars 2-3 are the ANSWER: a parallel gesture that resolves — the last
//     active step is forced to the tonic.
//   - Strong beats (every 4th step) snap to a chord tone of the bar's
//     active chord, so the motif moves WITH the harmony instead of
//     noodling around one scale.
//
// All RNG draws must use mulberry32Intn for JS parity — Go's math/rand
// stream would diverge from the browser side and silently change shared
// playback. Draw order is part of the parity contract: per-bar hit counts
// first (4 draws), then per-bar mask fills (variable), then one walk draw
// per active weak step. theme.js replays the identical sequence.
func generateMotif(state *uint32, scaleLen int, plan ChordPlan) MotifCell {
	const bars = 4
	const barSteps = 16
	motifLen := bars * barSteps
	degrees := make([]int, motifLen)
	mask := make([]bool, motifLen)

	// Rhythm: per bar — strong beats always on, then fill to 6-8 active
	// steps with random off-positions. Sparser than the old 9-11/16 so
	// each gesture breathes.
	for b := 0; b < bars; b++ {
		hits := 6 + mulberry32Intn(state, 3) // 6..8 per bar
		base := b * barSteps
		have := 0
		for i := 0; i < barSteps; i += 4 {
			mask[base+i] = true
			have++
		}
		for have < hits {
			i := mulberry32Intn(state, barSteps)
			if !mask[base+i] {
				mask[base+i] = true
				have++
			}
		}
	}

	// Degrees: chord-aware walk. Strong beats land on the nearest chord
	// tone of the bar's chord (no draw); weak beats walk by -2..+2 (one
	// draw each). Rests draw nothing — keeps the stream replayable.
	cur := 0
	for i := 0; i < motifLen; i++ {
		if !mask[i] {
			degrees[i] = -1
			continue
		}
		bar := i / barSteps
		chord := plan.ChordAt(bar * plan.StepsPerChord)
		if i%4 == 0 {
			cur = nearestToneOf(cur, scaleLen, chord.Tones)
		} else {
			delta := mulberry32Intn(state, 5) - 2
			cur += delta
			if cur < 0 {
				cur = 0
			}
			if cur > scaleLen-1 {
				cur = scaleLen - 1
			}
		}
		degrees[i] = cur
	}

	// Question end: last active step of bar 1 lands on the THIRD of bar
	// 1's chord — a stable-but-unresolved tone that says "to be
	// continued". Answer end: last active step of bar 3 resolves to the
	// tonic. Both deterministic (no draws).
	if li := lastActiveIn(degrees, 1*barSteps, 2*barSteps); li >= 0 {
		c := plan.ChordAt(1 * plan.StepsPerChord)
		if len(c.Tones) > 1 {
			degrees[li] = clampDegree(c.Tones[1])
		}
	}
	if li := lastActiveIn(degrees, 3*barSteps, 4*barSteps); li >= 0 {
		degrees[li] = 0
	}

	// Contour: net direction (last hit minus first hit). Lets MotifInverted
	// flip the contour symmetrically.
	first, last := -1, -1
	for _, d := range degrees {
		if d >= 0 {
			if first < 0 {
				first = d
			}
			last = d
		}
	}
	var contour int8 = 0
	if first >= 0 && last >= 0 {
		if last > first {
			contour = 1
		} else if last < first {
			contour = -1
		}
	}

	return MotifCell{Degrees: degrees, Mask: mask, Contour: contour}
}

// RenderMotif applies a MotifMode + harmonic offset to a MotifCell, returning a
// fresh cell. Pure function. Augmented mode doubles the cell length;
// Fragment zeros out the back half; Inverted flips contour; Transposed shifts
// every active degree by harmonicOffset (modulo scale length 7).
//
// Note: MotifLayered is treated as MotifPlay here — the overlay is handled
// at the net-generation level, not at the cell level. (Slice 0 doesn't ship
// MotifLayered, but the case is included for completeness.)
func RenderMotif(cell MotifCell, mode MotifMode, harmonicOffset int) MotifCell {
	switch mode {
	case MotifIgnore:
		return MotifCell{}
	case MotifPlay, MotifLayered, MotifTransposed:
		out := cloneCell(cell)
		if mode == MotifTransposed || harmonicOffset != 0 {
			for i, d := range out.Degrees {
				if d >= 0 {
					out.Degrees[i] = clampDegree(d + harmonicOffset)
				}
			}
		}
		return out
	case MotifFragment:
		out := cloneCell(cell)
		half := len(out.Degrees) / 2
		for i := half; i < len(out.Degrees); i++ {
			out.Degrees[i] = -1
			out.Mask[i] = false
		}
		return out
	case MotifAugmented:
		// Each step held 2x: insert a rest after every hit so duration
		// per emitted note doubles in tick terms.
		dl, ml := len(cell.Degrees)*2, len(cell.Mask)*2
		out := MotifCell{
			Degrees: make([]int, dl),
			Mask:    make([]bool, ml),
			Contour: cell.Contour,
		}
		for i := 0; i < len(cell.Degrees); i++ {
			out.Degrees[i*2] = cell.Degrees[i]
			out.Mask[i*2] = cell.Mask[i]
			out.Degrees[i*2+1] = -1
			out.Mask[i*2+1] = false
		}
		return out
	case MotifInverted:
		out := cloneCell(cell)
		const scaleLen = 7
		for i, d := range out.Degrees {
			if d >= 0 {
				out.Degrees[i] = clampDegree((scaleLen - 1) - d + harmonicOffset)
			}
		}
		out.Contour = -cell.Contour
		return out
	}
	return cloneCell(cell)
}

func cloneCell(c MotifCell) MotifCell {
	out := MotifCell{
		Degrees: make([]int, len(c.Degrees)),
		Mask:    make([]bool, len(c.Mask)),
		Contour: c.Contour,
	}
	copy(out.Degrees, c.Degrees)
	copy(out.Mask, c.Mask)
	return out
}

func clampDegree(d int) int {
	const scaleLen = 7
	for d < 0 {
		d += scaleLen
	}
	for d >= scaleLen {
		d -= scaleLen
	}
	return d
}

// nearestToneOf finds the chord tone closest to cur. Deterministic (ties
// resolve upward first), draw-free — used by the motif's strong-beat snap.
func nearestToneOf(cur, scaleLen int, tones []int) int {
	for _, t := range tones {
		if t == cur {
			return cur
		}
	}
	for dist := 1; dist < scaleLen; dist++ {
		for _, t := range tones {
			if t == cur+dist && t < scaleLen {
				return t
			}
		}
		for _, t := range tones {
			if t == cur-dist && t >= 0 {
				return t
			}
		}
	}
	if len(tones) > 0 {
		return clampDegree(tones[0])
	}
	return 0
}

// lastActiveIn returns the index of the last non-rest step in [from, to),
// or -1 if the range is all rests.
func lastActiveIn(degrees []int, from, to int) int {
	for i := to - 1; i >= from; i-- {
		if degrees[i] >= 0 {
			return i
		}
	}
	return -1
}

// MotifNet builds a Petri-net ring from a rendered MotifCell. The ring has
// one place per step; transitions at unmasked positions carry a MIDI binding
// at the scale-degree pitch (RootNote + scale[degree]). Rests get silent
// transitions, mirroring how Euclidean handles non-hit steps.
//
// scale is the MIDI scale notes (e.g. genre.Scale(rootNote)). degree indices
// wrap around the scale modulo len(scale).
func MotifNet(cell MotifCell, scale []int, params Params) *pflow.NetBundle {
	n := len(cell.Degrees)
	if n == 0 {
		// Degenerate: build a 16-step silent ring so the slot is non-empty.
		n = 16
		cell.Degrees = make([]int, n)
		cell.Mask = make([]bool, n)
		for i := range cell.Degrees {
			cell.Degrees[i] = -1
		}
	}

	net := petri.NewPetriNet()
	bindings := make(map[string]*pflow.MidiBinding)
	cx, cy, radius := ringLayout(n)

	for i := 0; i < n; i++ {
		initial := 0.0
		if i == 0 {
			initial = 1
		}
		angle := float64(i) / float64(n) * 2 * math.Pi
		x := cx + radius*0.7*math.Cos(angle)
		y := cy + radius*0.7*math.Sin(angle)
		net.AddPlace(fmt.Sprintf("p%d", i), initial, nil, x, y, nil)
	}

	for i := 0; i < n; i++ {
		tLabel := fmt.Sprintf("t%d", i)
		angle := (float64(i) + 0.5) / float64(n) * 2 * math.Pi
		tx := cx + radius*math.Cos(angle)
		ty := cy + radius*math.Sin(angle)
		net.AddTransition(tLabel, "", tx, ty, nil)
		net.AddArc(fmt.Sprintf("p%d", i), tLabel, 1.0, false)
		net.AddArc(tLabel, fmt.Sprintf("p%d", (i+1)%n), 1.0, false)

		if cell.Mask[i] && cell.Degrees[i] >= 0 {
			note := degreeToMidi(cell.Degrees[i], scale)
			bindings[tLabel] = &pflow.MidiBinding{
				Note:     note,
				Channel:  params.Channel,
				Velocity: clampVelocity(params.Velocity),
				Duration: params.Duration,
			}
		}
	}

	track := pflow.Track{
		Channel:         params.Channel,
		DefaultVelocity: params.Velocity,
	}
	return pflow.NewNetBundle(net, track, bindings)
}

// degreeToMidi maps a scale-degree index to a MIDI note via the scale array.
// Degrees beyond len(scale) wrap by octave so a motif that walks above the
// diatonic-octave still produces a valid pitch.
func degreeToMidi(degree int, scale []int) int {
	if len(scale) == 0 {
		return 60
	}
	if degree < 0 {
		return 0
	}
	if degree < len(scale) {
		return scale[degree]
	}
	octaves := degree / len(scale)
	idx := degree % len(scale)
	return scale[idx] + 12*octaves
}

// MaskedRing builds a Euclidean-style ring where every step plays note iff
// mask[i] is true. Same shape as Euclidean() but takes the hit pattern
// literally instead of computing it from (k, n). Used by the v2 bass path
// where the rhythm is GrooveLock(kickMask) rather than a Bjorklund draw.
func MaskedRing(mask []bool, note int, params Params) *pflow.NetBundle {
	n := len(mask)
	if n == 0 {
		n = 16
		mask = make([]bool, n)
	}
	net := petri.NewPetriNet()
	bindings := make(map[string]*pflow.MidiBinding)
	cx, cy, radius := ringLayout(n)

	for i := 0; i < n; i++ {
		initial := 0.0
		if i == 0 {
			initial = 1
		}
		angle := float64(i) / float64(n) * 2 * math.Pi
		x := cx + radius*0.7*math.Cos(angle)
		y := cy + radius*0.7*math.Sin(angle)
		net.AddPlace(fmt.Sprintf("p%d", i), initial, nil, x, y, nil)
	}
	for i := 0; i < n; i++ {
		tLabel := fmt.Sprintf("t%d", i)
		angle := (float64(i) + 0.5) / float64(n) * 2 * math.Pi
		tx := cx + radius*math.Cos(angle)
		ty := cy + radius*math.Sin(angle)
		net.AddTransition(tLabel, "", tx, ty, nil)
		net.AddArc(fmt.Sprintf("p%d", i), tLabel, 1.0, false)
		net.AddArc(tLabel, fmt.Sprintf("p%d", (i+1)%n), 1.0, false)
		if mask[i] {
			bindings[tLabel] = &pflow.MidiBinding{
				Note:     note,
				Channel:  params.Channel,
				Velocity: clampVelocity(params.Velocity),
				Duration: params.Duration,
			}
		}
	}
	track := pflow.Track{
		Channel:         params.Channel,
		DefaultVelocity: params.Velocity,
	}
	return pflow.NewNetBundle(net, track, bindings)
}

// NotedRing builds a ring like MaskedRing but with a per-step pitch —
// notes[i] plays at step i iff mask[i]. The slice-2 bass uses this to walk
// the chord roots while keeping the groove-locked rhythm: mask repeats the
// kick-derived bar pattern, notes change at each chord boundary.
func NotedRing(notes []int, mask []bool, params Params) *pflow.NetBundle {
	n := len(mask)
	if n == 0 {
		n = 16
		mask = make([]bool, n)
		notes = make([]int, n)
	}
	net := petri.NewPetriNet()
	bindings := make(map[string]*pflow.MidiBinding)
	cx, cy, radius := ringLayout(n)

	for i := 0; i < n; i++ {
		initial := 0.0
		if i == 0 {
			initial = 1
		}
		angle := float64(i) / float64(n) * 2 * math.Pi
		net.AddPlace(fmt.Sprintf("p%d", i), initial, nil,
			cx+radius*0.7*math.Cos(angle), cy+radius*0.7*math.Sin(angle), nil)
	}
	for i := 0; i < n; i++ {
		tLabel := fmt.Sprintf("t%d", i)
		angle := (float64(i) + 0.5) / float64(n) * 2 * math.Pi
		net.AddTransition(tLabel, "", cx+radius*math.Cos(angle), cy+radius*math.Sin(angle), nil)
		net.AddArc(fmt.Sprintf("p%d", i), tLabel, 1.0, false)
		net.AddArc(tLabel, fmt.Sprintf("p%d", (i+1)%n), 1.0, false)
		if mask[i] && i < len(notes) {
			bindings[tLabel] = &pflow.MidiBinding{
				Note:     notes[i],
				Channel:  params.Channel,
				Velocity: clampVelocity(params.Velocity),
				Duration: params.Duration,
			}
		}
	}
	track := pflow.Track{
		Channel:         params.Channel,
		DefaultVelocity: params.Velocity,
	}
	return pflow.NewNetBundle(net, track, bindings)
}

// ChordPadNet voices the ChordPlan as a sustained pad — the harmonic bed
// that was entirely missing from v2 slice 1 ("nothing plays chords").
//
// One ring spanning the full chord cycle; at each chord boundary the first
// three steps strum the triad (root, third, fifth — one note per
// transition, ~1 step apart) with bar-length sustain so the notes overlap
// into a held chord. The slight strum is idiomatic for synthwave and keeps
// the engine's one-binding-per-transition invariant — no polyphonic
// binding shape needed.
func ChordPadNet(plan ChordPlan, scale []int, params Params) *pflow.NetBundle {
	n := plan.CycleSteps()
	if n == 0 {
		n = 64
	}
	net := petri.NewPetriNet()
	bindings := make(map[string]*pflow.MidiBinding)
	cx, cy, radius := ringLayout(n)

	for i := 0; i < n; i++ {
		initial := 0.0
		if i == 0 {
			initial = 1
		}
		angle := float64(i) / float64(n) * 2 * math.Pi
		net.AddPlace(fmt.Sprintf("p%d", i), initial, nil,
			cx+radius*0.7*math.Cos(angle), cy+radius*0.7*math.Sin(angle), nil)
	}
	for i := 0; i < n; i++ {
		tLabel := fmt.Sprintf("t%d", i)
		angle := (float64(i) + 0.5) / float64(n) * 2 * math.Pi
		net.AddTransition(tLabel, "", cx+radius*math.Cos(angle), cy+radius*math.Sin(angle), nil)
		net.AddArc(fmt.Sprintf("p%d", i), tLabel, 1.0, false)
		net.AddArc(tLabel, fmt.Sprintf("p%d", (i+1)%n), 1.0, false)
	}
	for c := 0; c < len(plan.Chords); c++ {
		chord := plan.Chords[c]
		base := c * plan.StepsPerChord
		for v := 0; v < len(chord.Tones) && v < 3; v++ {
			step := base + v
			if step >= n {
				break
			}
			bindings[fmt.Sprintf("t%d", step)] = &pflow.MidiBinding{
				Note:     degreeToMidi(clampDegree(chord.Tones[v]), scale),
				Channel:  params.Channel,
				Velocity: clampVelocity(params.Velocity),
				Duration: params.Duration,
			}
		}
	}
	track := pflow.Track{
		Channel:         params.Channel,
		DefaultVelocity: params.Velocity,
	}
	return pflow.NewNetBundle(net, track, bindings)
}

// chordBassRing expands a one-bar groove mask across the full chord cycle,
// with each bar's hits pitched at that bar's chord root (+ registerShift
// semitones). The bass keeps its kick-locked rhythm AND follows the
// harmony — both halves of "the low end is one instrument with the kick,
// and it's playing the song's chords".
func chordBassRing(plan ChordPlan, barMask []bool, scale []int, params Params) *pflow.NetBundle {
	return chordBassRingShifted(plan, barMask, scale, params, 0)
}

func chordBassRingShifted(plan ChordPlan, barMask []bool, scale []int, params Params, registerShift int) *pflow.NetBundle {
	barSteps := len(barMask)
	if barSteps == 0 {
		barSteps = 16
		barMask = make([]bool, barSteps)
	}
	bars := len(plan.Chords)
	if bars == 0 {
		bars = 4
	}
	n := bars * barSteps
	mask := make([]bool, n)
	notes := make([]int, n)
	for b := 0; b < bars; b++ {
		chord := plan.ChordAt(b * plan.StepsPerChord)
		root := degreeToMidi(clampDegree(chord.Root), scale) + registerShift
		for i := 0; i < barSteps; i++ {
			idx := b*barSteps + i
			mask[idx] = barMask[i]
			notes[idx] = root
		}
	}
	return NotedRing(notes, mask, params)
}

// KickHitMask returns the kick's hit mask as a []bool, applying the same
// (k, n, rotation) recipe Compose uses for the kick net. Used by GrooveLock
// to derive the bass rhythm from the kick rhythm.
func KickHitMask(genre Genre) []bool {
	k, n, rot := genre.Kick[0], genre.Kick[1], genre.Kick[2]
	pattern := bjorklund(k, n)
	if rot != 0 {
		rot = ((rot % n) + n) % n
		rotated := make([]int, n)
		for i := range pattern {
			rotated[i] = pattern[(i+rot)%n]
		}
		pattern = rotated
	}
	mask := make([]bool, n)
	for i, h := range pattern {
		mask[i] = h == 1
	}
	return mask
}

// hashStr is a tiny FNV-32 over a string, used to derive salt-mixed seeds for
// the theme RNG without colliding with composer-internal seeds.
func hashStr(s string) uint32 {
	var h uint32 = 2166136261
	for i := 0; i < len(s); i++ {
		h ^= uint32(s[i])
		h *= 16777619
	}
	return h
}

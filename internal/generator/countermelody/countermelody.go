// Package countermelody contains the rule-based note-selection kernel
// shared between the composition-layer insert renderer
// (internal/audiorender) and the share-layer arrange directive
// (internal/generator/arrange.go). Both call sites need the same
// deterministic note list from the same source material; this package
// is the single source of truth for that algorithm.
//
// Determinism: all RNG draws go through Mulberry32, the Go port of
// public/lib/generator/core.js::mulberry32. Same seed + same source
// material → byte-identical note list across Go and JS.
//
// Manifesto: rule-based only. Answer mode places notes in rest runs,
// harmony mode emits parallel 3rds, shadow mode emits late echoes. No
// ML, no model, no inference.
package countermelody

import (
	"hash/fnv"
	"sort"

	"beats-bitwrap-io/internal/pflow"
)

// PPQ is the pulses-per-quarter used by music nets. Mirrors
// sequencer-worker.js's constant.
const PPQ = 4

// NoteEvent is one note placement in a counter-melody's bar grid. The
// audiorender package adds a Frequency field downstream for ffmpeg
// sine synthesis; consumers that build Petri-net transitions use
// (Note, Velocity, Duration) directly.
type NoteEvent struct {
	StartTick int
	Note      int // MIDI 0..127
	Velocity  int // MIDI 0..127
	Duration  int // ticks (4 = quarter note at PPQ=4)
}

// SourceNote captures one MIDI firing observed during source
// simulation. Harmony and shadow modes transform individual source
// notes; answer mode only needs the rhythm mask + pitch set.
type SourceNote struct {
	Tick     int
	Note     int
	Velocity int
}

// Opts configures GenerateCounterMelody. Mode/Density/Register
// defaults mirror the existing composition-layer insert
// (mode=answer, density=0.5, register=above) so both call sites
// behave identically when fed identical material.
type Opts struct {
	Mode       string // "answer" | "harmony" | "shadow"; default "answer"
	Density    float64
	Register   string // "above" | "below"; default "above"
	Seed       uint32 // mulberry32 seed
	TotalTicks int    // simulation length in ticks
	// SourceNetID optionally scopes simulation to a single music net.
	// Empty walks every music net in proj (matches the existing
	// insert-renderer behavior).
	SourceNetID string
}

// GenerateCounterMelody is the main entry point. Simulates the source
// project to extract its rhythm mask, pitch set, and ordered source
// notes; dispatches to the requested mode; returns the generated note
// list.
//
// Return contract:
//   - nil   → no source material (project has no music transitions);
//     caller should error or silently skip.
//   - empty → source material exists but the mode produced no notes
//     (every rest run too short for answer, density gated everything,
//     etc.); caller typically renders silence / skips injection.
//   - non-empty → notes to render or to materialize as a music net.
func GenerateCounterMelody(proj *pflow.Project, opts Opts) []NoteEvent {
	mode := opts.Mode
	if mode == "" {
		mode = "answer"
	}
	register := opts.Register
	if register == "" {
		register = "above"
	}
	density := opts.Density
	if density <= 0 {
		density = 0.5
	}
	if density > 1 {
		density = 1
	}
	totalTicks := opts.TotalTicks
	if totalTicks < 4 {
		totalTicks = 4
	}

	hits, pitchSet, sourceNotes := SimulateMusicNotes(proj, totalTicks, opts.SourceNetID)
	if len(pitchSet) == 0 {
		return nil
	}

	rng := NewMulberry32(opts.Seed)
	switch mode {
	case "harmony":
		return HarmonyMode(sourceNotes, register, density, rng)
	case "shadow":
		return ShadowMode(sourceNotes, totalTicks, register, density, rng)
	default:
		// "answer" is the default for any unrecognized mode; callers
		// that need strict validation should check Mode themselves.
		return AnswerMode(hits, pitchSet, register, density, rng)
	}
}

// SimulateMusicNotes walks music nets in proj for totalTicks ticks,
// returning per-tick hits, sorted unique pitch set, and ordered
// source notes. When scopeNetID is non-empty, only that net is
// simulated; otherwise every net is walked (control nets are skipped).
//
// Net state is reset at the end so the caller can boot the project
// cleanly afterwards.
func SimulateMusicNotes(proj *pflow.Project, totalTicks int, scopeNetID string) ([]bool, []int, []SourceNote) {
	hits := make([]bool, totalTicks)
	pitchSet := map[int]struct{}{}
	var notes []SourceNote
	netIDs := make([]string, 0, len(proj.Nets))
	for id := range proj.Nets {
		netIDs = append(netIDs, id)
	}
	sort.Strings(netIDs)
	for _, id := range netIDs {
		if scopeNetID != "" && id != scopeNetID {
			continue
		}
		nb := proj.Nets[id]
		if nb == nil {
			continue
		}
		if nb.Role == "control" {
			continue
		}
		nb.ResetState()
		transLabels := make([]string, 0, len(nb.Bindings))
		for label := range nb.Bindings {
			transLabels = append(transLabels, label)
		}
		sort.Strings(transLabels)
		for tick := 0; tick < totalTicks; tick++ {
			fired := false
			for _, label := range transLabels {
				if !nb.IsEnabled(label) {
					continue
				}
				res := nb.Fire(label)
				fired = true
				if res != nil && res.Midi != nil && res.Midi.Note > 0 {
					hits[tick] = true
					pitchSet[res.Midi.Note] = struct{}{}
					vel := res.Midi.Velocity
					if vel <= 0 {
						vel = 90
					}
					notes = append(notes, SourceNote{
						Tick: tick, Note: res.Midi.Note, Velocity: vel,
					})
				}
				break
			}
			if !fired {
				nb.ResetState()
			}
		}
		nb.ResetState()
	}
	out := make([]int, 0, len(pitchSet))
	for n := range pitchSet {
		out = append(out, n)
	}
	sort.Ints(out)
	return hits, out, notes
}

// AnswerMode finds rest runs in the source rhythm and places
// complementary notes there. Density gates which runs get filled;
// pitch is sampled from the source's pitch set, transposed ±12
// semitones based on register.
func AnswerMode(hits []bool, pitchSet []int, register string, density float64, rng *Mulberry32) []NoteEvent {
	transpose := 12
	if register == "below" {
		transpose = -12
	}
	notes := []NoteEvent{}
	totalTicks := len(hits)
	t := 0
	for t < totalTicks {
		if hits[t] {
			t++
			continue
		}
		runStart := t
		for t < totalTicks && !hits[t] {
			t++
		}
		runLen := t - runStart
		if runLen < 2 {
			continue
		}
		if rng.Float64() > density {
			continue
		}
		basePitch := pitchSet[rng.Intn(len(pitchSet))] + transpose
		for basePitch < 24 {
			basePitch += 12
		}
		for basePitch > 108 {
			basePitch -= 12
		}
		startTick := runStart + runLen/2
		dur := runLen / 2
		if dur > 8 {
			dur = 8
		}
		if dur < 1 {
			dur = 1
		}
		notes = append(notes, NoteEvent{
			StartTick: startTick,
			Note:      basePitch,
			Velocity:  90,
			Duration:  dur,
		})
	}
	return notes
}

// HarmonyMode emits a parallel-motion line: every source note becomes
// srcNote ± interval (major 3rd above or minor 3rd below). Density
// thins source notes deterministically.
func HarmonyMode(src []SourceNote, register string, density float64, rng *Mulberry32) []NoteEvent {
	interval := 4
	if register == "below" {
		interval = -3
	}
	out := []NoteEvent{}
	for _, n := range src {
		if rng.Float64() > density {
			continue
		}
		pitch := n.Note + interval
		for pitch < 24 {
			pitch += 12
		}
		for pitch > 108 {
			pitch -= 12
		}
		out = append(out, NoteEvent{
			StartTick: n.Tick,
			Note:      pitch,
			Velocity:  n.Velocity,
			Duration:  4,
		})
	}
	return out
}

// ShadowMode emits sparse 16th-late echoes of the source line at half
// velocity, transposed by register. Echoes past totalTicks are dropped.
func ShadowMode(src []SourceNote, totalTicks int, register string, density float64, rng *Mulberry32) []NoteEvent {
	transpose := 12
	if register == "below" {
		transpose = -12
	}
	out := []NoteEvent{}
	for _, n := range src {
		if rng.Float64() > density {
			continue
		}
		echoTick := n.Tick + 1
		if echoTick >= totalTicks {
			continue
		}
		pitch := n.Note + transpose
		for pitch < 24 {
			pitch += 12
		}
		for pitch > 108 {
			pitch -= 12
		}
		velocity := n.Velocity / 2
		if velocity < 30 {
			velocity = 30
		}
		out = append(out, NoteEvent{
			StartTick: echoTick,
			Note:      pitch,
			Velocity:  velocity,
			Duration:  3,
		})
	}
	return out
}

// Mulberry32 is the Go port of public/lib/generator/core.js::mulberry32.
// Same seed → same sequence across Go and JS.
type Mulberry32 struct {
	state uint32
}

// NewMulberry32 constructs a fresh PRNG from a 32-bit seed.
func NewMulberry32(seed uint32) *Mulberry32 {
	return &Mulberry32{state: seed}
}

// SeedFromBytes computes a fnv32a hash of the concatenated byte
// slices. Callers that don't have a fixed seed but want determinism
// derived from envelope bytes (the existing insert-renderer pattern)
// use this.
func SeedFromBytes(parts ...[]byte) uint32 {
	h := fnv.New32a()
	for _, p := range parts {
		h.Write(p)
	}
	return h.Sum32()
}

// Next advances the state and returns the raw 32-bit output.
func (m *Mulberry32) Next() uint32 {
	m.state += 0x6D2B79F5
	t := m.state
	t = (t ^ (t >> 15)) * (1 | t)
	t = t + ((t ^ (t >> 7)) * (61 | t)) ^ t
	return (t ^ (t >> 14))
}

// Float64 returns a value in [0, 1).
func (m *Mulberry32) Float64() float64 {
	return float64(m.Next()) / 4294967296.0
}

// Intn returns a non-negative int in [0, n). Returns 0 when n <= 0.
func (m *Mulberry32) Intn(n int) int {
	if n <= 0 {
		return 0
	}
	return int(m.Next()) % n
}

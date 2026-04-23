// Package generator creates musically interesting Petri nets.
package generator

import (
	"beats-bitwrap-io/internal/pflow"
)

// AccentType controls velocity accent patterns for drum parts.
type AccentType int

const (
	AccentNone  AccentType = iota
	AccentKick             // Strong downbeats (1, 5, 9, 13 in 16-step)
	AccentSnare            // Backbeat emphasis
	AccentHihat            // Alternating strong/weak (open/closed feel)
)

// ChordDegree represents a chord as scale degree intervals from root.
type ChordDegree struct {
	Root  int   // Scale degree index (0-based)
	Tones []int // Scale degree indices that make up this chord
}

// ChordProg is a chord progression as a sequence of chords, each lasting N steps.
type ChordProg struct {
	Chords   []ChordDegree
	StepsPer int // Steps per chord (e.g., 4 = 1 bar in 16-step)
}

// Params controls generation behavior.
type Params struct {
	Scale             []int   // MIDI note numbers in scale
	RootNote          int     // Root MIDI note (e.g., 60 = C4)
	Channel           int     // MIDI channel
	Velocity          int     // Default velocity
	Duration          int     // Note duration ms
	Density           float64 // 0.0-1.0, controls note density
	Steps             int     // Pattern length in steps
	BPM               float64
	Seed              int64      // For reproducibility (0 = random)
	Accent            AccentType // Velocity accent pattern for drums
	Chords            *ChordProg // Chord progression for melodic parts
	DurationVariation float64    // 0.0-1.0, random factor applied to note durations
	Syncopation       float64    // 0.0-1.0, probability of shifting notes to offbeat
}

// DefaultParams returns sensible defaults.
func DefaultParams() Params {
	return Params{
		Scale:    MajorScale(60), // C major
		RootNote: 60,
		Channel:  1,
		Velocity: 100,
		Duration: 100,
		Density:  0.5,
		Steps:    16,
		BPM:      120,
	}
}

// Common scales as semitone offsets from root.
var (
	Major         = []int{0, 2, 4, 5, 7, 9, 11}
	Minor         = []int{0, 2, 3, 5, 7, 8, 10}
	Dorian        = []int{0, 2, 3, 5, 7, 9, 10}
	Mixolydian    = []int{0, 2, 4, 5, 7, 9, 10}
	Phrygian      = []int{0, 1, 3, 5, 7, 8, 10}
	HarmonicMin   = []int{0, 2, 3, 5, 7, 8, 11}
	Pentatonic    = []int{0, 2, 4, 7, 9}
	MinPentatonic = []int{0, 3, 5, 7, 10}
	Blues         = []int{0, 3, 5, 6, 7, 10}
	Chromatic     = []int{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11}
)

// MajorScale returns MIDI notes for a major scale starting at root.
func MajorScale(root int) []int {
	return scaleNotes(root, Major, 2)
}

// MinorScale returns MIDI notes for a minor scale starting at root.
func MinorScale(root int) []int {
	return scaleNotes(root, Minor, 2)
}

// PentatonicScale returns MIDI notes for a pentatonic scale.
func PentatonicScale(root int) []int {
	return scaleNotes(root, Pentatonic, 2)
}

// scaleNotes generates MIDI note numbers spanning multiple octaves.
func scaleNotes(root int, intervals []int, octaves int) []int {
	notes := make([]int, 0, len(intervals)*octaves)
	for oct := 0; oct < octaves; oct++ {
		for _, interval := range intervals {
			note := root + oct*12 + interval
			if note <= 127 {
				notes = append(notes, note)
			}
		}
	}
	return notes
}

// Common chord progressions (scale degree indices, 0-based).
// Minor key: i-VI-III-VII (Am-F-C-G in A minor)
var MinorChordProg = &ChordProg{
	Chords: []ChordDegree{
		{Root: 0, Tones: []int{0, 2, 4}}, // i   (root, 3rd, 5th)
		{Root: 5, Tones: []int{5, 0, 2}}, // VI  (6th, root, 2nd)
		{Root: 2, Tones: []int{2, 4, 6}}, // III (3rd, 5th, 7th)
		{Root: 4, Tones: []int{4, 6, 1}}, // VII (5th, 7th, 2nd)
	},
	StepsPer: 4,
}

// Major key: I-V-vi-IV
var MajorChordProg = &ChordProg{
	Chords: []ChordDegree{
		{Root: 0, Tones: []int{0, 2, 4}}, // I
		{Root: 4, Tones: []int{4, 6, 1}}, // V
		{Root: 5, Tones: []int{5, 0, 2}}, // vi
		{Root: 3, Tones: []int{3, 5, 0}}, // IV
	},
	StepsPer: 4,
}

// accentVelocity returns the velocity for a given step position and accent type.
// Uses wider offsets and deterministic jitter via step hash for natural feel.
func accentVelocity(step, totalSteps int, baseVelocity int, accent AccentType) int {
	// Deterministic jitter: hash step position for ±5 variation
	jitter := ((step*7 + 13) % 11) - 5

	switch accent {
	case AccentKick:
		// Downbeat emphasis: beats 1 and 3 strong
		beat := step % 4
		switch beat {
		case 0: // downbeat
			return baseVelocity + 20 + jitter
		case 2: // beat 3
			return baseVelocity + 8 + jitter
		default:
			return baseVelocity - 15 + jitter
		}
	case AccentSnare:
		// Snare hits are already placed by Euclidean — just add slight jitter
		return baseVelocity + jitter
	case AccentHihat:
		// Alternating strong/weak for groove — ghost notes on off-beats
		if step%2 == 0 {
			return baseVelocity + 10 + jitter
		}
		return baseVelocity - 30 + jitter // ghost notes
	}
	return baseVelocity + jitter
}

// clampVelocity ensures velocity stays in MIDI range.
func clampVelocity(v int) int {
	if v < 1 {
		return 1
	}
	if v > 127 {
		return 127
	}
	return v
}

// Result is what a generator produces.
type Result struct {
	Bundle *pflow.NetBundle
	NetID  string // Suggested net ID
}

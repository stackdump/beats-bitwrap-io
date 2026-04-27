package generator

import (
	"fmt"
	"hash/fnv"
	"math"
	"math/rand"
	"time"

	"beats-bitwrap-io/internal/pflow"

	"github.com/pflow-xyz/go-pflow/petri"
)

// drumSeed returns a deterministic seed for drum patterns based on genre name.
// This ensures drums are consistent across regenerations of the same genre.
func drumSeed(genre string) int64 {
	h := fnv.New64a()
	h.Write([]byte(genre))
	return int64(h.Sum64())
}

// Genre defines a preset for full track generation.
type Genre struct {
	Name     string
	BPM      float64
	Scale    func(int) []int
	RootNote int
	// Drum patterns: (hits, steps, rotation, midiNote)
	Kick  [4]int
	Snare [4]int
	Hihat [4]int
	// Melody
	MelodyChannel  int
	MelodyDensity  float64
	MelodyDuration int
	// Bass
	BassChannel  int
	BassDensity  float64
	BassDuration int
	// Feel
	Swing             float64 // 0-100 swing percentage
	Humanize          float64 // 0-100 humanize amount
	DurationVariation float64 // 0.0-1.0 per-genre duration variation
	// Music theory
	Theory *GenreTheory
	// Variety features
	DrumFills        bool    // Enable drum fills at section boundaries
	WalkingBass      bool    // Chromatic passing tones between chord roots
	Polyrhythm       int     // Odd-length hihat loop (0=disabled, e.g. 6 for 6-over-4)
	Syncopation      float64 // 0.0-1.0 probability of shifting notes to offbeat
	CallResponse     bool    // Call-and-response melody structure
	TensionCurve     bool    // Per-section energy scaling (structure mode)
	ModalInterchange float64 // 0.0-1.0 probability of borrowing chords from parallel key
	GhostNotes       float64 // 0.0-1.0 density of ghost notes between hihat hits
}

// BluesScale returns MIDI notes for a blues scale starting at root.
func BluesScale(root int) []int {
	return scaleNotes(root, Blues, 2)
}

// MixolydianScale returns MIDI notes for a mixolydian scale starting at root.
func MixolydianScale(root int) []int {
	return scaleNotes(root, Mixolydian, 2)
}

// PhrygianScale returns MIDI notes for a phrygian scale starting at root.
func PhrygianScale(root int) []int {
	return scaleNotes(root, Phrygian, 2)
}

// HarmonicMinScale returns MIDI notes for a harmonic minor scale starting at root.
func HarmonicMinScale(root int) []int {
	return scaleNotes(root, HarmonicMin, 2)
}

// MinPentatonicScale returns MIDI notes for a minor pentatonic scale starting at root.
func MinPentatonicScale(root int) []int {
	return scaleNotes(root, MinPentatonic, 2)
}

var Genres = map[string]Genre{
	"techno": {
		Name: "techno", BPM: 128, Scale: MajorScale, RootNote: 48,
		Kick: [4]int{4, 16, 0, 36}, Snare: [4]int{2, 16, 4, 38}, Hihat: [4]int{5, 8, 0, 42},
		MelodyChannel: 4, MelodyDensity: 0.4, MelodyDuration: 150,
		BassChannel: 6, BassDensity: 0.5, BassDuration: 200,
		Swing: 0, Humanize: 10, DurationVariation: 0.2,
		Theory:      GenreTheories["techno"],
		Syncopation: 0.1, GhostNotes: 0.3,
	},
	"house": {
		Name: "house", BPM: 124, Scale: MinorScale, RootNote: 48,
		Kick: [4]int{4, 16, 0, 36}, Snare: [4]int{3, 8, 0, 38}, Hihat: [4]int{6, 8, 0, 42},
		MelodyChannel: 4, MelodyDensity: 0.5, MelodyDuration: 120,
		BassChannel: 6, BassDensity: 0.6, BassDuration: 180,
		Swing: 20, Humanize: 15, DurationVariation: 0.25,
		Theory:      GenreTheories["house"],
		Syncopation: 0.2, GhostNotes: 0.4,
	},
	"jazz": {
		Name: "jazz", BPM: 110, Scale: func(root int) []int { return scaleNotes(root, Dorian, 2) }, RootNote: 55,
		Kick: [4]int{3, 12, 0, 36}, Snare: [4]int{2, 12, 3, 38}, Hihat: [4]int{5, 12, 0, 42},
		MelodyChannel: 4, MelodyDensity: 0.6, MelodyDuration: 100,
		BassChannel: 6, BassDensity: 0.4, BassDuration: 250,
		Swing: 60, Humanize: 40, DurationVariation: 0.6,
		Theory:    GenreTheories["jazz"],
		DrumFills: true, WalkingBass: true, Syncopation: 0.5,
		CallResponse: true, TensionCurve: true, ModalInterchange: 0.3, GhostNotes: 0.6,
	},
	"ambient": {
		Name: "ambient", BPM: 72, Scale: PentatonicScale, RootNote: 60,
		Kick: [4]int{2, 16, 0, 36}, Snare: [4]int{1, 16, 8, 38}, Hihat: [4]int{3, 16, 0, 42},
		MelodyChannel: 4, MelodyDensity: 0.3, MelodyDuration: 400,
		BassChannel: 6, BassDensity: 0.2, BassDuration: 500,
		Swing: 0, Humanize: 25, DurationVariation: 0.4,
		Theory:       GenreTheories["ambient"],
		TensionCurve: true, ModalInterchange: 0.2,
	},
	"dnb": {
		Name: "dnb", BPM: 174, Scale: MinorScale, RootNote: 43,
		Kick: [4]int{3, 16, 0, 36}, Snare: [4]int{2, 8, 2, 38}, Hihat: [4]int{7, 8, 0, 42},
		MelodyChannel: 4, MelodyDensity: 0.5, MelodyDuration: 80,
		BassChannel: 6, BassDensity: 0.7, BassDuration: 120,
		Swing: 10, Humanize: 15, DurationVariation: 0.3,
		Theory:    GenreTheories["dnb"],
		DrumFills: true, Polyrhythm: 6, Syncopation: 0.3, TensionCurve: true, GhostNotes: 0.5,
	},
	"edm": {
		Name: "edm", BPM: 138, Scale: MinorScale, RootNote: 45, // A minor
		Kick: [4]int{4, 16, 0, 36}, Snare: [4]int{2, 16, 4, 40}, Hihat: [4]int{8, 16, 0, 42},
		MelodyChannel: 4, MelodyDensity: 0.6, MelodyDuration: 100,
		BassChannel: 6, BassDensity: 0.5, BassDuration: 150,
		Swing: 0, Humanize: 8, DurationVariation: 0.15,
		Theory:    GenreTheories["edm"],
		DrumFills: true, Syncopation: 0.15, TensionCurve: true, ModalInterchange: 0.1, GhostNotes: 0.3,
	},
	"speedcore": {
		Name: "speedcore", BPM: 220, Scale: MinorScale, RootNote: 40, // E minor, low and dark
		Kick: [4]int{8, 16, 0, 36}, Snare: [4]int{4, 16, 2, 40}, Hihat: [4]int{12, 16, 0, 42},
		MelodyChannel: 4, MelodyDensity: 0.7, MelodyDuration: 50,
		BassChannel: 6, BassDensity: 0.8, BassDuration: 60,
		Swing: 0, Humanize: 5, DurationVariation: 0.1,
		Theory:      GenreTheories["speedcore"],
		Syncopation: 0.05, GhostNotes: 0.2,
	},
	"dubstep": {
		Name: "dubstep", BPM: 140, Scale: MinorScale, RootNote: 38, // D minor, half-time feel
		Kick: [4]int{3, 16, 0, 36}, Snare: [4]int{2, 16, 4, 38}, Hihat: [4]int{5, 16, 0, 42},
		MelodyChannel: 4, MelodyDensity: 0.4, MelodyDuration: 120,
		BassChannel: 6, BassDensity: 0.6, BassDuration: 200,
		Swing: 15, Humanize: 12, DurationVariation: 0.3,
		Theory:    GenreTheories["dubstep"],
		DrumFills: true, Syncopation: 0.3, TensionCurve: true, ModalInterchange: 0.15, GhostNotes: 0.4,
	},
	"country": {
		Name: "country", BPM: 110, Scale: MajorScale, RootNote: 48, // C3
		Kick: [4]int{4, 16, 0, 36}, Snare: [4]int{4, 16, 4, 38}, Hihat: [4]int{8, 16, 0, 42},
		MelodyChannel: 4, MelodyDensity: 0.5, MelodyDuration: 140,
		BassChannel: 6, BassDensity: 0.5, BassDuration: 200,
		Swing: 15, Humanize: 20, DurationVariation: 0.3,
		Theory:      GenreTheories["country"],
		WalkingBass: true, Syncopation: 0.2, CallResponse: true, ModalInterchange: 0.1, GhostNotes: 0.3,
	},
	"blues": {
		Name: "blues", BPM: 95, Scale: BluesScale, RootNote: 48, // C3
		Kick: [4]int{3, 16, 0, 36}, Snare: [4]int{2, 16, 4, 38}, Hihat: [4]int{6, 16, 0, 42},
		MelodyChannel: 4, MelodyDensity: 0.5, MelodyDuration: 160,
		BassChannel: 6, BassDensity: 0.4, BassDuration: 250,
		Swing: 50, Humanize: 35, DurationVariation: 0.5,
		Theory:    GenreTheories["blues"],
		DrumFills: true, WalkingBass: true, Syncopation: 0.4,
		CallResponse: true, TensionCurve: true, ModalInterchange: 0.2, GhostNotes: 0.5,
	},
	"synthwave": {
		Name: "synthwave", BPM: 108, Scale: MinorScale, RootNote: 48, // C3
		Kick:          [4]int{4, 16, 0, 36}, // four-on-the-floor
		Snare:         [4]int{2, 16, 4, 38}, // backbeat
		Hihat:         [4]int{4, 8, 0, 42},  // sparse hihats
		MelodyChannel: 4, MelodyDensity: 0.4, MelodyDuration: 200,
		BassChannel: 6, BassDensity: 0.6, BassDuration: 300,
		Swing: 0, Humanize: 5, DurationVariation: 0.2,
		Theory:      GenreTheories["synthwave"],
		Syncopation: 0.05, GhostNotes: 0.15, TensionCurve: true, ModalInterchange: 0.1,
	},
	"trance": {
		Name: "trance", BPM: 140, Scale: MinorScale, RootNote: 45, // A2
		Kick:          [4]int{4, 16, 0, 36}, // four-on-the-floor
		Snare:         [4]int{2, 16, 4, 40}, // clap on backbeat
		Hihat:         [4]int{8, 16, 0, 42}, // driving hihats
		MelodyChannel: 4, MelodyDensity: 0.5, MelodyDuration: 150,
		BassChannel: 6, BassDensity: 0.6, BassDuration: 180,
		Swing: 0, Humanize: 5, DurationVariation: 0.15,
		Theory:       GenreTheories["trance"],
		TensionCurve: true, Syncopation: 0.1, GhostNotes: 0.2, ModalInterchange: 0.15,
	},
	"lofi": {
		Name: "lofi", BPM: 82, Scale: MinPentatonicScale, RootNote: 55, // G3
		Kick:          [4]int{3, 16, 0, 36}, // lazy kick
		Snare:         [4]int{2, 16, 4, 38}, // backbeat snare
		Hihat:         [4]int{5, 8, 0, 42},  // swung hihats
		MelodyChannel: 4, MelodyDensity: 0.35, MelodyDuration: 250,
		BassChannel: 6, BassDensity: 0.3, BassDuration: 350,
		Swing: 35, Humanize: 40, DurationVariation: 0.5,
		Theory:      GenreTheories["lofi"],
		Syncopation: 0.2, GhostNotes: 0.6, ModalInterchange: 0.15,
	},
	"reggae": {
		Name: "reggae", BPM: 75, Scale: MajorScale, RootNote: 48, // C3
		Kick:          [4]int{3, 16, 0, 36}, // one-drop style
		Snare:         [4]int{2, 16, 6, 37}, // rimshot on 3
		Hihat:         [4]int{8, 16, 0, 42}, // steady offbeat
		MelodyChannel: 4, MelodyDensity: 0.4, MelodyDuration: 180,
		BassChannel: 6, BassDensity: 0.5, BassDuration: 250,
		Swing: 25, Humanize: 25, DurationVariation: 0.35,
		Theory:      GenreTheories["reggae"],
		Syncopation: 0.4, GhostNotes: 0.3, WalkingBass: true,
	},
	"funk": {
		Name: "funk", BPM: 108, Scale: func(root int) []int { return scaleNotes(root, Mixolydian, 2) }, RootNote: 48, // C3
		Kick:          [4]int{5, 16, 0, 36}, // syncopated kick
		Snare:         [4]int{4, 16, 4, 38}, // heavy backbeat
		Hihat:         [4]int{8, 16, 0, 42}, // 16th-note hihats
		MelodyChannel: 4, MelodyDensity: 0.55, MelodyDuration: 100,
		BassChannel: 6, BassDensity: 0.6, BassDuration: 150,
		Swing: 30, Humanize: 25, DurationVariation: 0.4,
		Theory:      GenreTheories["funk"],
		Syncopation: 0.5, GhostNotes: 0.6, WalkingBass: true,
		CallResponse: true, DrumFills: true,
	},
	"bossa": {
		Name: "bossa", BPM: 88, Scale: func(root int) []int { return scaleNotes(root, Dorian, 2) }, RootNote: 53, // F3
		Kick:          [4]int{3, 16, 0, 36}, // sparse kick
		Snare:         [4]int{5, 16, 3, 37}, // rimshot clave pattern
		Hihat:         [4]int{6, 8, 0, 42},  // soft hihats
		MelodyChannel: 4, MelodyDensity: 0.45, MelodyDuration: 160,
		BassChannel: 6, BassDensity: 0.5, BassDuration: 220,
		Swing: 40, Humanize: 30, DurationVariation: 0.45,
		Theory:      GenreTheories["bossa"],
		Syncopation: 0.35, GhostNotes: 0.5, WalkingBass: true,
		CallResponse: true, ModalInterchange: 0.25,
	},
	"trap": {
		Name: "trap", BPM: 140, Scale: MinorScale, RootNote: 38, // D2 — deep 808
		Kick:          [4]int{3, 16, 0, 36},  // sparse hard-hitting kick
		Snare:         [4]int{2, 16, 4, 40},  // clap on backbeat
		Hihat:         [4]int{10, 16, 0, 42}, // rolling hihats
		MelodyChannel: 4, MelodyDensity: 0.35, MelodyDuration: 120,
		BassChannel: 6, BassDensity: 0.5, BassDuration: 250,
		Swing: 10, Humanize: 8, DurationVariation: 0.2,
		Theory:      GenreTheories["trap"],
		Syncopation: 0.3, GhostNotes: 0.4, DrumFills: true, TensionCurve: true,
	},
	"garage": {
		Name: "garage", BPM: 130, Scale: MinorScale, RootNote: 45, // A2
		Kick:          [4]int{3, 16, 0, 36}, // syncopated kick
		Snare:         [4]int{3, 16, 2, 38}, // shuffled snare
		Hihat:         [4]int{7, 8, 0, 42},  // swung hihats
		MelodyChannel: 4, MelodyDensity: 0.45, MelodyDuration: 110,
		BassChannel: 6, BassDensity: 0.6, BassDuration: 160,
		Swing: 30, Humanize: 18, DurationVariation: 0.3,
		Theory:      GenreTheories["garage"],
		Syncopation: 0.35, GhostNotes: 0.45, DrumFills: true,
	},
	"metal": {
		Name: "metal", BPM: 180, Scale: func(root int) []int { return scaleNotes(root, Phrygian, 2) }, RootNote: 40, // E2
		Kick:          [4]int{8, 16, 0, 36}, // double kick
		Snare:         [4]int{4, 16, 4, 38}, // heavy backbeat
		Hihat:         [4]int{8, 8, 0, 42},  // fast hihats
		MelodyChannel: 4, MelodyDensity: 0.6, MelodyDuration: 70,
		BassChannel: 6, BassDensity: 0.7, BassDuration: 80,
		Swing: 0, Humanize: 8, DurationVariation: 0.15,
		Theory:      GenreTheories["metal"],
		Syncopation: 0.15, GhostNotes: 0.2, DrumFills: true, TensionCurve: true,
	},
}

// GenreInstrumentSets maps genre -> track role -> available instruments.
var GenreInstrumentSets = map[string]map[string][]string{
	"techno": {
		"kick":   {"drums", "drums-v8"},
		"snare":  {"drums", "drums-v8"},
		"hihat":  {"drums", "drums-v8"},
		"bass":   {"acid", "reese", "sub-bass", "fm-bass", "drop-bass"},
		"melody": {"supersaw", "square-lead", "pwm-lead", "sync-lead", "trance-lead", "big-saw"},
	},
	"house": {
		"kick":   {"drums", "drums-v8"},
		"snare":  {"drums", "drums-v8"},
		"hihat":  {"drums", "drums-v8"},
		"bass":   {"bass", "sub-bass", "acid", "duo-bass"},
		"melody": {"electric-piano", "piano", "organ", "brass", "sax", "rave-organ"},
	},
	"jazz": {
		"kick":   {"drums-cr78", "drums"},
		"snare":  {"drums-cr78", "drums"},
		"hihat":  {"drums-cr78", "drums"},
		"bass":   {"sub-bass", "bass", "reese"},
		"melody": {"vibes", "electric-piano", "piano", "marimba", "trumpet", "sax", "flute"},
	},
	"ambient": {
		"kick":   {"drums", "drums-v8"},
		"snare":  {"drums", "drums-v8"},
		"hihat":  {"drums", "drums-v8"},
		"bass":   {"sub-bass", "dark-pad", "bass", "reese"},
		"melody": {"warm-pad", "pad", "fm-bell", "strings", "glass-pad", "choir", "music-box", "kalimba", "sitar", "flute", "am-bell", "am-pad"},
	},
	"dnb": {
		"kick":   {"drums-breakbeat", "drums"},
		"snare":  {"drums-breakbeat", "drums"},
		"hihat":  {"drums-breakbeat", "drums"},
		"bass":   {"reese", "acid", "sub-bass", "rubber-bass", "drop-bass"},
		"melody": {"square-lead", "supersaw", "bright-pluck", "pwm-lead", "sync-lead", "lead", "duo-lead", "edm-pluck"},
	},
	"edm": {
		"kick":   {"drums", "drums-v8"},
		"snare":  {"drums", "drums-v8"},
		"hihat":  {"drums", "drums-v8"},
		"clap":   {"drums", "drums-v8"},
		"arp":    {"bright-pluck", "pluck", "muted-pluck", "edm-pluck"},
		"bass":   {"acid", "reese", "sub-bass", "drop-bass", "fm-bass"},
		"melody": {"supersaw", "hoover", "pwm-lead", "lead", "sync-lead", "big-saw", "trance-lead", "edm-stab"},
	},
	"speedcore": {
		"kick":   {"drums-v8", "drums"},
		"snare":  {"drums-v8", "drums"},
		"hihat":  {"drums-v8", "drums"},
		"bass":   {"acid", "reese", "sub-bass", "rubber-bass", "drop-bass"},
		"melody": {"scream-lead", "distorted-lead", "hoover", "distorted-guitar", "screech", "laser"},
	},
	"dubstep": {
		"kick":   {"drums-v8", "drums"},
		"snare":  {"drums-v8", "drums"},
		"hihat":  {"drums-v8", "drums"},
		"bass":   {"wobble-bass", "reese", "acid", "808-bass", "rubber-bass", "drop-bass", "fm-bass"},
		"melody": {"detuned-saw", "distorted-lead", "rave-stab", "supersaw", "hoover", "wobble-lead", "screech"},
	},
	"country": {
		"kick":   {"drums", "drums-cr78"},
		"snare":  {"drums", "drums-cr78"},
		"hihat":  {"drums", "drums-cr78"},
		"bass":   {"bass", "sub-bass", "acoustic-guitar", "reese"},
		"melody": {"piano", "electric-piano", "bright-pluck", "acoustic-guitar", "electric-guitar", "steel-drum", "harpsichord"},
	},
	"blues": {
		"kick":   {"drums-cr78", "drums"},
		"snare":  {"drums-cr78", "drums"},
		"hihat":  {"drums-cr78", "drums"},
		"bass":   {"bass", "sub-bass", "reese", "acid"},
		"melody": {"electric-guitar", "acoustic-guitar", "electric-piano", "piano", "organ", "trumpet", "sax", "brass"},
	},
	"synthwave": {
		"kick":   {"drums-v8", "drums"},
		"snare":  {"drums-v8", "drums"},
		"hihat":  {"drums-v8", "drums"},
		"arp":    {"pluck", "bright-pluck", "muted-pluck", "edm-pluck"},
		"bass":   {"sub-bass", "dark-pad", "reese", "duo-bass"},
		"melody": {"warm-pad", "dark-pad", "pad", "strings", "tape-lead", "glass-pad", "am-pad", "duo-lead"},
	},
	"trance": {
		"kick":   {"drums-v8", "drums"},
		"snare":  {"drums-v8", "drums"},
		"hihat":  {"drums-v8", "drums"},
		"arp":    {"bright-pluck", "pluck", "muted-pluck", "edm-pluck"},
		"bass":   {"acid", "sub-bass", "reese", "fm-bass"},
		"melody": {"supersaw", "pad", "warm-pad", "lead", "glass-pad", "choir", "sync-lead", "trance-lead", "big-saw"},
	},
	"lofi": {
		"kick":   {"drums-lofi", "drums-cr78", "drums"},
		"snare":  {"drums-lofi", "drums-cr78", "drums"},
		"hihat":  {"drums-lofi", "drums-cr78", "drums"},
		"bass":   {"sub-bass", "bass", "reese", "dark-pad"},
		"melody": {"electric-piano", "piano", "vibes", "fm-bell", "music-box", "kalimba", "tape-lead", "acoustic-guitar"},
	},
	"reggae": {
		"kick":   {"drums", "drums-cr78"},
		"snare":  {"drums", "drums-cr78"},
		"hihat":  {"drums", "drums-cr78"},
		"bass":   {"bass", "sub-bass", "reese", "acid"},
		"melody": {"organ", "electric-piano", "clavinet", "piano", "acoustic-guitar", "steel-drum", "brass", "sax", "kalimba"},
	},
	"funk": {
		"kick":   {"drums", "drums-breakbeat"},
		"snare":  {"drums", "drums-breakbeat"},
		"hihat":  {"drums", "drums-breakbeat"},
		"bass":   {"bass", "acid", "sub-bass"},
		"melody": {"clavinet", "organ", "electric-piano", "electric-guitar", "bright-pluck", "talkbox", "trumpet", "sax", "brass"},
	},
	"bossa": {
		"kick":   {"drums-cr78", "drums"},
		"snare":  {"drums-cr78", "drums"},
		"hihat":  {"drums-cr78", "drums"},
		"bass":   {"bass", "sub-bass", "reese", "acoustic-guitar"},
		"melody": {"vibes", "electric-piano", "piano", "marimba", "flute", "sax", "kalimba", "acoustic-guitar", "trumpet", "steel-drum"},
	},
	"trap": {
		"kick":   {"drums-808", "drums-v8", "drums"},
		"snare":  {"drums-808", "drums-v8", "drums"},
		"hihat":  {"drums-808", "drums-v8", "drums"},
		"bass":   {"808-bass", "sub-bass", "reese", "wobble-bass", "drop-bass"},
		"melody": {"dark-pad", "detuned-saw", "pluck", "fm-bell", "sync-lead", "chiptune", "laser"},
	},
	"garage": {
		"kick":   {"drums", "drums-v8"},
		"snare":  {"drums", "drums-v8"},
		"hihat":  {"drums", "drums-v8"},
		"bass":   {"sub-bass", "reese", "bass", "rubber-bass", "duo-bass"},
		"melody": {"bright-pluck", "pluck", "electric-piano", "lead", "brass", "edm-pluck"},
	},
	"metal": {
		"kick":   {"drums-v8", "drums"},
		"snare":  {"drums-v8", "drums"},
		"hihat":  {"drums-v8", "drums"},
		"bass":   {"reese", "acid", "distorted-lead", "rubber-bass", "drop-bass"},
		"melody": {"distorted-guitar", "distorted-lead", "scream-lead", "hoover", "supersaw", "screech"},
	},
}

// Compose generates a full multi-track project from a genre template.
func Compose(genreName string, overrides map[string]interface{}) *pflow.Project {
	genre, ok := Genres[genreName]
	if !ok {
		genre = Genres["techno"]
	}

	seed := time.Now().UnixNano()
	if s, ok := overrides["seed"].(float64); ok {
		seed = int64(s)
	}
	rng := rand.New(rand.NewSource(seed))

	bpm := genre.BPM
	if b, ok := overrides["bpm"].(float64); ok {
		bpm = b
	}

	// === Parse variety overrides (genre defaults as fallback) ===
	drumFills := genre.DrumFills
	if v, ok := overrides["drum-fills"].(bool); ok {
		drumFills = v
	}
	walkingBass := genre.WalkingBass
	if v, ok := overrides["walking-bass"].(bool); ok {
		walkingBass = v
	}
	polyrhythmSteps := genre.Polyrhythm
	if v, ok := overrides["polyrhythm"].(float64); ok {
		polyrhythmSteps = int(v)
	}
	syncopation := genre.Syncopation
	if v, ok := overrides["syncopation"].(float64); ok {
		syncopation = v
	}
	callResponse := genre.CallResponse
	if v, ok := overrides["call-response"].(bool); ok {
		callResponse = v
	}
	tensionCurve := genre.TensionCurve
	if v, ok := overrides["tension-curve"].(bool); ok {
		tensionCurve = v
	}
	modalInterchange := genre.ModalInterchange
	if v, ok := overrides["modal-interchange"].(float64); ok {
		modalInterchange = v
	}
	ghostNotes := genre.GhostNotes
	if v, ok := overrides["ghost-notes"].(float64); ok {
		ghostNotes = v
	}

	proj := &pflow.Project{
		Name:     generateTrackName(genre.Name, seed),
		Seed:     seed,
		Tempo:    bpm,
		Swing:    genre.Swing,
		Humanize: genre.Humanize,
		Nets:     make(map[string]*pflow.NetBundle),
	}

	// === Drums (deterministic seed from genre for consistent patterns) ===
	dSeed := drumSeed(genreName)
	kickParams := Params{
		Channel:  10,
		Velocity: 100,
		Duration: 50,
		Seed:     dSeed,
		Accent:   AccentKick,
	}
	kick := Euclidean(genre.Kick[0], genre.Kick[1], genre.Kick[2], genre.Kick[3], kickParams)
	proj.Nets["kick"] = kick.Bundle

	snareParams := Params{
		Channel:  10,
		Velocity: 100,
		Duration: 50,
		Seed:     dSeed + 1,
		Accent:   AccentSnare,
	}
	snare := Euclidean(genre.Snare[0], genre.Snare[1], genre.Snare[2], genre.Snare[3], snareParams)
	proj.Nets["snare"] = snare.Bundle

	// === Hihat (with ghost notes and polyrhythm support) ===
	hihatHits := genre.Hihat[0]
	hihatSteps := genre.Hihat[1]
	hihatRotation := genre.Hihat[2]
	hihatNote := genre.Hihat[3]

	// Polyrhythm: use odd-length loop for hihat
	if polyrhythmSteps > 0 {
		hihatSteps = polyrhythmSteps
		// Adjust hits proportionally
		hihatHits = hihatHits * polyrhythmSteps / genre.Hihat[1]
		if hihatHits < 1 {
			hihatHits = 1
		}
	}

	hihatParams := Params{
		Channel:  10,
		Velocity: 100,
		Duration: 50,
		Seed:     dSeed + 2,
		Accent:   AccentHihat,
	}

	if ghostNotes > 0 {
		hihat := GhostNoteHihat(hihatHits, hihatSteps, hihatRotation, hihatNote, hihatParams, ghostNotes)
		proj.Nets["hihat"] = hihat.Bundle
	} else {
		hihat := Euclidean(hihatHits, hihatSteps, hihatRotation, hihatNote, hihatParams)
		proj.Nets["hihat"] = hihat.Bundle
	}

	// === Pick chord progression based on genre theory ===
	var chordProg *ChordProg
	if genre.Theory != nil && len(genre.Theory.ChordProgs) > 0 {
		chordProg = genre.Theory.ChordProgs[rng.Intn(len(genre.Theory.ChordProgs))]
	} else {
		// Fallback: auto-detect from scale
		chordProg = MinorChordProg
		testScale := genre.Scale(60)
		if len(testScale) >= 7 && testScale[2]-testScale[0] == 4 {
			chordProg = MajorChordProg
		}
	}

	// === Modal interchange: borrow chords from parallel key ===
	if modalInterchange > 0 {
		testScale := genre.Scale(60)
		chordProg = ApplyModalInterchange(chordProg, testScale, modalInterchange, rng)
	}

	// === Bass (walking bass or Markov) ===
	bassScale := genre.Scale(genre.RootNote)
	// Bass uses first octave only
	if len(bassScale) > len(Major) {
		bassScale = bassScale[:len(Major)]
	}
	bassParams := Params{
		Scale:             bassScale,
		RootNote:          genre.RootNote,
		Channel:           genre.BassChannel,
		Velocity:          90,
		Duration:          genre.BassDuration,
		Density:           genre.BassDensity,
		Seed:              rng.Int63(),
		Chords:            chordProg,
		DurationVariation: genre.DurationVariation,
		Syncopation:       syncopation,
	}

	if walkingBass {
		bass := WalkingBassLine(bassParams)
		proj.Nets["bass"] = bass.Bundle
	} else {
		bass := MarkovMelody(bassParams)
		proj.Nets["bass"] = bass.Bundle
	}

	// === Melody (call-response or Markov) ===
	melodyRoot := genre.RootNote + 12 // one octave up
	melodyParams := Params{
		Scale:             genre.Scale(melodyRoot),
		RootNote:          melodyRoot,
		Channel:           genre.MelodyChannel,
		Velocity:          85,
		Duration:          genre.MelodyDuration,
		Density:           genre.MelodyDensity,
		Seed:              rng.Int63(),
		Chords:            chordProg,
		DurationVariation: genre.DurationVariation,
		Syncopation:       syncopation,
	}

	if callResponse {
		melody := CallResponseMelody(melodyParams)
		proj.Nets["melody"] = melody.Bundle
	} else {
		melody := MarkovMelody(melodyParams)
		proj.Nets["melody"] = melody.Bundle
	}

	// === Genre-specific extras ===
	if genreName == "edm" || genreName == "synthwave" || genreName == "trance" {
		// Clap on beats 2 and 4 (EDM only)
		if genreName == "edm" {
			clap := Euclidean(2, 16, 4, 39, snareParams) // 39 = hand clap, backbeat accent
			proj.Nets["clap"] = clap.Bundle
		}

		// Arp: fast Euclidean pattern on pluck channel
		arpScale := genre.Scale(genre.RootNote + 24) // two octaves up
		if len(arpScale) > 5 {
			arpScale = arpScale[:5] // pentatonic subset
		}
		arpNotes := make([]int, 0)
		for _, n := range arpScale {
			arpNotes = append(arpNotes, n)
		}
		// Create an arp ring that cycles through scale notes
		arp := EuclideanMelodic(arpNotes, 16, rng.Int63(), Params{
			Channel:  5, // pluck
			Velocity: 80,
			Duration: 60,
		})
		proj.Nets["arp"] = arp.Bundle
	}

	// Assign instrument sets from genre definition (randomize initial pick)
	if sets, ok := GenreInstrumentSets[genreName]; ok {
		// Pick one random instrument per role so all slots in a group share the same instrument
		roleInstrument := make(map[string]string)
		for role, instruments := range sets {
			roleInstrument[role] = instruments[rng.Intn(len(instruments))]
		}

		for netId, bundle := range proj.Nets {
			lookupKey := netId
			if bundle.RiffGroup != "" {
				lookupKey = bundle.RiffGroup
			}
			if instruments, ok := sets[lookupKey]; ok && len(instruments) > 0 {
				bundle.Track.InstrumentSet = instruments
				if inst, ok := roleInstrument[lookupKey]; ok {
					bundle.Track.Instrument = inst
				} else {
					bundle.Track.Instrument = instruments[0]
				}
			}
		}
	}

	// Override instruments if provided (preserve user's instrument choices across regeneration)
	if instMap, ok := overrides["instruments"].(map[string]interface{}); ok {
		for netId, bundle := range proj.Nets {
			// Check by exact net ID first, then by RiffGroup
			if instName, ok := instMap[netId].(string); ok && instName != "" {
				bundle.Track.Instrument = instName
			} else if bundle.RiffGroup != "" {
				if instName, ok := instMap[bundle.RiffGroup].(string); ok && instName != "" {
					bundle.Track.Instrument = instName
				}
			}
		}
	}

	// Tag every music net with its mixer-section group so the frontend
	// can draw explicit section dividers. Rules: `hitN` → "stinger",
	// drum roles → "drums", then bass/melody/harmony/arp map literally.
	// Anything unrecognized is left ungrouped (shows up under "main").
	for netId, bundle := range proj.Nets {
		if bundle == nil || bundle.Role == "control" {
			continue
		}
		group := groupForRole(netId, bundle.RiffGroup)
		if group != "" {
			bundle.Track.Group = group
		}
		// Fallback instrumentSet when the genre preset didn't populate one
		// (Chorus-added harmony, custom roles, etc.) so the mixer's `»`
		// rotate button renders on every music row.
		if len(bundle.Track.InstrumentSet) < 2 {
			key := group
			if key == "" {
				key = bundle.RiffGroup
				if key == "" {
					key = netId
				}
			}
			bundle.Track.InstrumentSet = fallbackInstrumentSet(key, bundle.Track.Instrument)
			if bundle.Track.Instrument == "" && len(bundle.Track.InstrumentSet) > 0 {
				bundle.Track.Instrument = bundle.Track.InstrumentSet[0]
			}
		}
	}

	// === Arrangement options ===

	// Chorus applies in both structure and loop modes (it adds a music track)
	if getBoolOverride(overrides, "chorus") {
		Chorus(proj, genre, rng)
	}

	// Structure mode: linear song with sections and auto-stop
	if structName, ok := overrides["structure"].(string); ok && structName != "" {
		// Generate a randomized structure appropriate for the genre
		tmpl := GenerateStructure(genreName, structName, rng)
		if tmpl != nil {
			// Apply genre-specific phrase patterns before expanding variants
			if genre.Theory != nil {
				for i := range tmpl.Sections {
					sec := &tmpl.Sections[i]
					for role := range sec.Phrases {
						sec.Phrases[role] = GenrePhrases(genre.Theory, sec.Name)
					}
				}
			}

			// Expand music nets into riff variants (with tension curve support)
			expandVariants(proj, tmpl, genre, rng, tensionCurve)

			// Add drum fills at section boundaries
			if drumFills {
				pos := 0
				fillIdx := 0
				for _, sec := range tmpl.Sections {
					pos += sec.Steps
					if pos > 4 { // need at least 4 steps for a fill
						fillLen := 4
						if sec.Steps >= 128 {
							fillLen = 8
						}
						fillNet := DrumFillNet(pos, fillLen, rng)
						proj.Nets[fmt.Sprintf("fill-%d", fillIdx)] = fillNet
						fillIdx++
					}
				}
			}

			// Collect all music net IDs
			var musicNets []string
			for netId := range proj.Nets {
				musicNets = append(musicNets, netId)
			}
			initialMutes := SongStructure(proj, tmpl, musicNets)
			proj.InitialMutes = initialMutes
			AddStingerTracks(proj, rng.Int63())
			return proj
		}
	}

	// Loop mode: fade-in/fade-out/drum-break options
	melodicTargets := []string{"bass", "melody"}
	if _, ok := proj.Nets["arp"]; ok {
		melodicTargets = append(melodicTargets, "arp")
	}
	if _, ok := proj.Nets["harmony"]; ok {
		melodicTargets = append(melodicTargets, "harmony")
	}

	if getBoolOverride(overrides, "fade-in") {
		mutedNets := FadeIn(proj, melodicTargets, 32, rng.Int63())
		proj.InitialMutes = mutedNets
	}

	if getBoolOverride(overrides, "fade-out") {
		FadeOut(proj, melodicTargets, 32, rng.Int63())
	}

	if getBoolOverride(overrides, "drum-break") {
		breakTargets := []string{"bass", "melody"}
		if _, ok := proj.Nets["harmony"]; ok {
			breakTargets = append(breakTargets, "harmony")
		}
		DrumBreak(proj, breakTargets, 64, 8, rng.Int63())
	}

	AddStingerTracks(proj, rng.Int63())
	return proj
}

// expandVariants replaces base music nets with per-slot riff variants.
// Each phrase slot across all sections gets a unique net with its own seed,
// while the letter (A/B/C) controls tension parameters (density, velocity, register).
// This produces unique patterns at every phrase position in the song.
// When tensionCurve is true, variant params are scaled by section energy.
func expandVariants(proj *pflow.Project, tmpl *SongTemplate, genre Genre, rng *rand.Rand, tensionCurve bool) {
	// Count total slots per role and build SlotMap
	tmpl.SlotMap = make(map[string][][]int)

	// Collect roles that appear in phrase patterns
	rolesInPhrases := make(map[string]bool)
	for _, sec := range tmpl.Sections {
		for role := range sec.Phrases {
			rolesInPhrases[role] = true
		}
	}

	for role := range rolesInPhrases {
		baseBundle, ok := proj.Nets[role]
		if !ok {
			continue
		}

		isDrum := drumRoles[role]

		// Build SlotMap for this role.
		// Drums: reuse the same slot for all phrases with the same letter
		// (pattern is identical, only velocity/duration differ — no need to swap nets).
		// Melodic: unique slot per phrase for distinct sequences.
		slotMap := make([][]int, len(tmpl.Sections))
		slotIdx := 0
		totalSlots := 0
		letterSlots := make(map[string]int) // letter -> slot index (drums only)

		for si, sec := range tmpl.Sections {
			phrases := sec.Phrases[role]
			if len(phrases) == 0 {
				phrases = []string{"A"}
			}
			sectionSlots := make([]int, len(phrases))

			if sec.Active[role] {
				for pi, letter := range phrases {
					if isDrum {
						// Reuse slot for same letter
						if existing, ok := letterSlots[letter]; ok {
							sectionSlots[pi] = existing
						} else {
							letterSlots[letter] = slotIdx
							sectionSlots[pi] = slotIdx
							slotIdx++
							totalSlots++
						}
					} else {
						sectionSlots[pi] = slotIdx
						slotIdx++
						totalSlots++
					}
				}
			} else {
				for pi := range phrases {
					sectionSlots[pi] = -1 // inactive
				}
			}
			slotMap[si] = sectionSlots
		}

		tmpl.SlotMap[role] = slotMap

		if totalSlots <= 1 {
			continue // only one slot, keep the base net as-is
		}

		// Generate one net per slot
		for si, sec := range tmpl.Sections {
			phrases := sec.Phrases[role]
			if len(phrases) == 0 {
				phrases = []string{"A"}
			}

			for pi, letter := range phrases {
				idx := slotMap[si][pi]
				if idx < 0 {
					continue // inactive
				}

				slotNetId := fmt.Sprintf("%s-%d", role, idx)

				if isDrum {
					var hits, steps, rotation, note int
					switch role {
					case "kick":
						hits, steps, rotation, note = genre.Kick[0], genre.Kick[1], genre.Kick[2], genre.Kick[3]
					case "snare":
						hits, steps, rotation, note = genre.Snare[0], genre.Snare[1], genre.Snare[2], genre.Snare[3]
					case "hihat":
						hits, steps, rotation, note = genre.Hihat[0], genre.Hihat[1], genre.Hihat[2], genre.Hihat[3]
					default:
						hits, steps, rotation, note = genre.Snare[0], genre.Snare[1], genre.Snare[2], genre.Snare[3]
					}

					// Seed by letter so all "A" drums sound the same across sections
					dSeed := drumSeed(fmt.Sprintf("%s:%s:%s", genre.Name, role, letter))
					params := Params{
						Channel:  baseBundle.Track.Channel,
						Velocity: baseBundle.Track.DefaultVelocity,
						Duration: 50,
						Seed:     dSeed,
						Accent:   AccentNone,
					}
					switch role {
					case "kick":
						params.Accent = AccentKick
					case "snare":
						params.Accent = AccentSnare
					case "hihat":
						params.Accent = AccentHihat
					}

					// Genre-specific drum style based on the letter (A/B/C)
					var drumStyle *DrumVariant
					if genre.Theory != nil && genre.Theory.DrumStyles != nil {
						if roleStyles, ok := genre.Theory.DrumStyles[role]; ok {
							if s, ok := roleStyles[letter]; ok {
								drumStyle = &s
							}
						}
					}

					nb := DrumRiff(letter, hits, steps, rotation, note, params, drumStyle)
					nb.RiffGroup = role
					nb.RiffVariant = letter
					nb.Track = baseBundle.Track
					proj.Nets[slotNetId] = nb
				} else {
					var scale []int
					var rootNote int
					var density float64
					var duration int

					switch role {
					case "bass":
						scale = genre.Scale(genre.RootNote)
						if len(scale) > len(Major) {
							scale = scale[:len(Major)]
						}
						rootNote = genre.RootNote
						density = genre.BassDensity
						duration = genre.BassDuration
					case "melody":
						rootNote = genre.RootNote + 12
						scale = genre.Scale(rootNote)
						density = genre.MelodyDensity
						duration = genre.MelodyDuration
					default:
						rootNote = genre.RootNote + 12
						scale = genre.Scale(rootNote)
						density = genre.MelodyDensity
						duration = genre.MelodyDuration
					}

					vel := baseBundle.Track.DefaultVelocity

					// Apply tension curve based on the letter (A/B/C)
					if tensionCurve {
						tension := tensionForVariant(letter)
						density *= tension.DensityMul
						if density > 1.0 {
							density = 1.0
						}
						vel += tension.VelocityAdd
						rootNote += tension.RegisterShift
						scale = genre.Scale(rootNote)
						if role == "bass" && len(scale) > len(Major) {
							scale = scale[:len(Major)]
						}
					}

					params := Params{
						Scale:             scale,
						RootNote:          rootNote,
						Channel:           baseBundle.Track.Channel,
						Velocity:          vel,
						Duration:          duration,
						Density:           density,
						Seed:              rng.Int63(),
						DurationVariation: genre.DurationVariation,
					}

					nb := MelodyRiff(letter, params)
					nb.RiffGroup = role
					nb.RiffVariant = letter
					nb.Track = baseBundle.Track
					proj.Nets[slotNetId] = nb
				}
			}
		}

		// Remove the base net — it's been replaced by slot variants
		delete(proj.Nets, role)
	}
}

func getBoolOverride(overrides map[string]interface{}, key string) bool {
	if v, ok := overrides[key].(bool); ok {
		return v
	}
	return false
}

// ControlTrack creates a control net that toggles another track on/off
// using an Euclidean pattern. This creates rhythmic muting effects.
func ControlTrack(targetNet string, hits, steps int, seed int64) *Result {
	rng := rand.New(rand.NewSource(seed))
	_ = rng // reserved for future randomization

	pattern := bjorklund(hits, steps)

	net := petri.NewPetriNet()
	bindings := make(map[string]*pflow.MidiBinding)
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

		if pattern[i] == 1 {
			controlBindings[tLabel] = &pflow.ControlBinding{
				Action:    "toggle-track",
				TargetNet: targetNet,
			}
		}
	}

	track := pflow.Track{Channel: 1}
	nb := pflow.NewNetBundle(net, track, bindings)
	nb.Role = "control"
	nb.ControlBindings = controlBindings

	return &Result{
		Bundle: nb,
		NetID:  "ctrl-" + targetNet,
	}
}

// fallbackInstrumentSet mirrors public/lib/generator/composer.js —
// returns a pool of candidate voices per mixer-section group so the `»`
// rotate button always has ≥2 entries to cycle through on the mixer row.
func fallbackInstrumentSet(groupOrRole, current string) []string {
	var set []string
	switch groupOrRole {
	case "drums":
		set = []string{"drums", "drums-v8", "drums-808", "drums-cr78", "drums-breakbeat", "drums-lofi"}
	case "bass":
		set = []string{"sub-bass", "fm-bass", "reese", "acid", "wobble-bass", "rubber-bass", "drop-bass", "808-bass"}
	case "melody", "lead":
		set = []string{"sync-lead", "square-lead", "supersaw", "pwm-lead", "tape-lead", "bright-pluck", "distorted-lead", "scream-lead"}
	case "arp":
		set = []string{"bright-pluck", "pluck", "muted-pluck", "edm-pluck", "chiptune", "kalimba", "music-box"}
	case "harmony", "chords", "chord":
		set = []string{"warm-pad", "dark-pad", "strings", "pad", "glass-pad", "choir", "organ", "rave-stab", "rave-organ"}
	case "pad":
		set = []string{"warm-pad", "dark-pad", "strings", "pad", "glass-pad", "choir"}
	case "stinger":
		return append([]string(nil), StingerInstrumentSet...)
	}
	if len(set) < 2 {
		// Generic fallback — keeps the rotate button visible on any role.
		set = []string{"piano", "electric-piano", "bass", "sub-bass", "lead", "sync-lead", "pad", "warm-pad", "strings", "organ", "fm-bell", "marimba"}
	}
	if current != "" {
		// Keep the current instrument at the front so it stays selected.
		found := false
		for _, s := range set {
			if s == current {
				found = true
				break
			}
		}
		if !found {
			set = append([]string{current}, set...)
		}
	}
	return set
}

// groupForRole maps a composer-generated net id (or its riffGroup tag)
// to the mixer-section group that should own it. Keeps the convention
// of drum tracks under "drums", melodic roles under their literal
// names, and hit1..hitN pads under "stinger" so the Beats tab still
// filters correctly when nothing else is set.
func groupForRole(netId, riffGroup string) string {
	key := riffGroup
	if key == "" {
		key = netId
	}
	switch key {
	case "kick", "snare", "hihat", "clap", "tom", "perc":
		return "drums"
	case "bass":
		return "bass"
	case "melody", "lead":
		return "melody"
	case "arp":
		return "arp"
	case "pad", "chord", "chords", "harmony":
		return "harmony"
	}
	if len(key) >= 4 && key[:3] == "hit" {
		return "stinger"
	}
	return ""
}

// NameForSeed returns the canonical track name for a (genre, seed)
// pair — byte-identical to what the JS-side generateTrackName emits in
// public/lib/generator/composer.js. Both sides use a dedicated
// mulberry32 sub-RNG keyed only on the seed so the name is independent
// of any other composer draws and stays stable across refactors.
func NameForSeed(genre string, seed int64) string {
	g, ok := Genres[genre]
	if !ok {
		g = Genres["techno"]
	}
	return generateTrackName(g.Name, seed)
}

// nameAdjectives / nameNouns must stay in lockstep with the lists in
// public/lib/generator/composer.js::generateTrackName. Order matters —
// indices are picked from a deterministic mulberry32 stream and a
// reorder would silently change every track name.
var nameAdjectives = []string{
	"Neon", "Velvet", "Crystal", "Midnight", "Golden",
	"Electric", "Cosmic", "Faded", "Phantom", "Solar",
	"Liquid", "Frozen", "Burning", "Silent", "Digital",
	"Hollow", "Iron", "Violet", "Crimson", "Silver",
	"Amber", "Azure", "Jade", "Obsidian", "Ivory",
	"Rusted", "Wired", "Broken", "Floating", "Endless",
	"Petri", "Yoneda", "Meseguer", "Montanari", "Murata",
	"Baez", "Fong", "Spivak", "Best", "Baccelli",
	"Noether", "Lawvere", "Brouwer",
}

var nameNouns = []string{
	"Drift", "Pulse", "Echo", "Haze", "Bloom",
	"Wave", "Storm", "Glow", "Shade", "Vibe",
	"Circuit", "Signal", "Mirage", "Orbit", "Tide",
	"Vapor", "Ember", "Fracture", "Horizon", "Spine",
	"Flicker", "Reverb", "Cipher", "Arc", "Lattice",
	"Prism", "Rust", "Grain", "Thread", "Void",
	"Functor", "Morphism", "Colimit", "Sheaf", "Topos",
	"Monad", "Adjoint", "Fibration", "Operad", "Stalk",
	"Cone", "Simplex", "Quiver",
}

// mulberry32Intn matches the JS rng pattern in public/lib/generator/core.js:
//
//	s |= 0; s = s + 0x6D2B79F5 | 0
//	t = Math.imul(s ^ s>>>15, 1 | s)
//	t = t + Math.imul(t ^ t>>>7, 61 | t) ^ t
//	next() = ((t ^ t>>>14) >>> 0) / 2^32
//	intn(n) = floor(next() * n)
//
// uint32 wrap-around arithmetic is bit-equivalent to Math.imul +
// `|0` int32 truncation, so this returns the same index sequence JS
// produces from the same seed.
func mulberry32Intn(s *uint32, n int) int {
	*s = *s + 0x6D2B79F5
	t := (*s ^ (*s >> 15)) * (1 | *s)
	t = (t + (t^(t>>7))*(61|t)) ^ t
	v := t ^ (t >> 14)
	return int(float64(v) / 4294967296.0 * float64(n))
}

// generateTrackName creates a random creative name like "ambient · Neon Drift".
// Uses mulberry32 keyed only on `seed` so Go and JS produce identical names.
func generateTrackName(genre string, seed int64) string {
	// Match JS `s = seed | 0` — int32 truncation, then reinterpret as uint32.
	s := uint32(int32(seed))
	adj := nameAdjectives[mulberry32Intn(&s, len(nameAdjectives))]
	noun := nameNouns[mulberry32Intn(&s, len(nameNouns))]
	return fmt.Sprintf("%s · %s %s", genre, adj, noun)
}

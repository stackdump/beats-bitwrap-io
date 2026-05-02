package generator

// GenreTheory holds genre-specific music theory: chord progressions,
// drum variant styles, and phrase patterns.
type GenreTheory struct {
	ChordProgs     []*ChordProg
	DrumStyles     map[string]map[string]DrumVariant // role -> variant -> style
	PhrasePatterns map[string][]string               // sectionName -> phrase pattern
}

// DrumVariant defines how a drum riff variant differs from the base pattern.
type DrumVariant struct {
	HitsAdd     int     // Added to base hit count
	HitsMul     float64 // Multiplied with base hit count (applied after HitsAdd)
	RotationAdd int     // Added to base rotation
}

// GenreTheories maps genre name to its theory definition.
var GenreTheories = map[string]*GenreTheory{
	"country": {
		ChordProgs: []*ChordProg{
			// I-IV-V-I
			{Chords: []ChordDegree{
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 3, Tones: []int{3, 5, 0}},
				{Root: 4, Tones: []int{4, 6, 1}},
				{Root: 0, Tones: []int{0, 2, 4}},
			}, StepsPer: 4},
			// I-vi-IV-V
			{Chords: []ChordDegree{
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 5, Tones: []int{5, 0, 2}},
				{Root: 3, Tones: []int{3, 5, 0}},
				{Root: 4, Tones: []int{4, 6, 1}},
			}, StepsPer: 4},
		},
		DrumStyles: map[string]map[string]DrumVariant{
			"kick":  {"B": {HitsAdd: 1, HitsMul: 1.0, RotationAdd: 2}, "C": {HitsAdd: -1, HitsMul: 1.0, RotationAdd: 4}},
			"snare": {"B": {HitsAdd: 1, HitsMul: 1.0, RotationAdd: 3}, "C": {HitsAdd: 0, HitsMul: 0.5, RotationAdd: 2}},
			"hihat": {"B": {HitsAdd: 2, HitsMul: 1.0, RotationAdd: 1}, "C": {HitsAdd: -1, HitsMul: 1.0, RotationAdd: 3}},
		},
		PhrasePatterns: map[string][]string{
			"intro":      {"A", "A"},
			"verse":      {"A", "A", "B", "A"},
			"pre-chorus": {"A", "B"},
			"chorus":     {"A", "B", "A", "B"},
			"breakdown":  {"C", "D"},
			"bridge":     {"C", "C"},
			"solo":       {"A", "B", "C", "A"},
			"outro":      {"A", "A"},
		},
	},
	"blues": {
		ChordProgs: []*ChordProg{
			// 12-bar blues: I×4, IV×2, I×2, V, IV, I, V
			{Chords: []ChordDegree{
				{Root: 0, Tones: []int{0, 2, 4}}, // I
				{Root: 0, Tones: []int{0, 2, 4}}, // I
				{Root: 0, Tones: []int{0, 2, 4}}, // I
				{Root: 0, Tones: []int{0, 2, 4}}, // I
				{Root: 3, Tones: []int{3, 5, 0}}, // IV
				{Root: 3, Tones: []int{3, 5, 0}}, // IV
				{Root: 0, Tones: []int{0, 2, 4}}, // I
				{Root: 0, Tones: []int{0, 2, 4}}, // I
				{Root: 4, Tones: []int{4, 6, 1}}, // V
				{Root: 3, Tones: []int{3, 5, 0}}, // IV
				{Root: 0, Tones: []int{0, 2, 4}}, // I
				{Root: 4, Tones: []int{4, 6, 1}}, // V (turnaround)
			}, StepsPer: 4},
		},
		DrumStyles: map[string]map[string]DrumVariant{
			"kick":  {"B": {HitsAdd: 0, HitsMul: 1.0, RotationAdd: 3}, "C": {HitsAdd: -1, HitsMul: 1.0, RotationAdd: 5}},
			"snare": {"B": {HitsAdd: 1, HitsMul: 1.0, RotationAdd: 2}, "C": {HitsAdd: 0, HitsMul: 0.5, RotationAdd: 3}},
			"hihat": {"B": {HitsAdd: 1, HitsMul: 1.0, RotationAdd: 2}, "C": {HitsAdd: -2, HitsMul: 1.0, RotationAdd: 4}},
		},
		PhrasePatterns: map[string][]string{
			"intro":      {"A", "A"},
			"verse":      {"A", "A", "A", "B"},
			"pre-chorus": {"A", "B"},
			"chorus":     {"A", "B", "A", "B"},
			"breakdown":  {"C", "D"},
			"bridge":     {"C", "C"},
			"solo":       {"A", "B", "A", "C"},
			"outro":      {"A", "A"},
		},
	},
	"jazz": {
		ChordProgs: []*ChordProg{
			// ii-V-I-vi
			{Chords: []ChordDegree{
				{Root: 1, Tones: []int{1, 3, 5}},
				{Root: 4, Tones: []int{4, 6, 1}},
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 5, Tones: []int{5, 0, 2}},
			}, StepsPer: 4},
			// iii-VI-ii-V
			{Chords: []ChordDegree{
				{Root: 2, Tones: []int{2, 4, 6}},
				{Root: 5, Tones: []int{5, 0, 2}},
				{Root: 1, Tones: []int{1, 3, 5}},
				{Root: 4, Tones: []int{4, 6, 1}},
			}, StepsPer: 4},
		},
		DrumStyles: map[string]map[string]DrumVariant{
			"kick":  {"B": {HitsAdd: 1, HitsMul: 1.0, RotationAdd: 2}, "C": {HitsAdd: -1, HitsMul: 1.0, RotationAdd: 3}},
			"snare": {"B": {HitsAdd: 1, HitsMul: 1.0, RotationAdd: 1}, "C": {HitsAdd: 0, HitsMul: 0.5, RotationAdd: 4}},
			"hihat": {"B": {HitsAdd: 2, HitsMul: 1.0, RotationAdd: 2}, "C": {HitsAdd: -1, HitsMul: 1.0, RotationAdd: 3}},
		},
		PhrasePatterns: map[string][]string{
			"intro":  {"A", "A"},
			"verse":  {"A", "B", "A", "B"},
			"chorus": {"A", "B", "B", "A"},
			"bridge": {"C", "D"},
			"solo":   {"A", "B", "C", "D"},
			"outro":  {"A", "A"},
		},
	},
	"house": {
		ChordProgs: []*ChordProg{
			// i-VII-VI-VII
			{Chords: []ChordDegree{
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 6, Tones: []int{6, 1, 3}},
				{Root: 5, Tones: []int{5, 0, 2}},
				{Root: 6, Tones: []int{6, 1, 3}},
			}, StepsPer: 4},
			// i-iv-VI-VII
			{Chords: []ChordDegree{
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 3, Tones: []int{3, 5, 0}},
				{Root: 5, Tones: []int{5, 0, 2}},
				{Root: 6, Tones: []int{6, 1, 3}},
			}, StepsPer: 4},
		},
		DrumStyles: map[string]map[string]DrumVariant{
			"kick":  {"B": {HitsAdd: 0, HitsMul: 1.0, RotationAdd: 4}, "C": {HitsAdd: -2, HitsMul: 1.0, RotationAdd: 2}},
			"snare": {"B": {HitsAdd: 1, HitsMul: 1.0, RotationAdd: 2}, "C": {HitsAdd: -1, HitsMul: 1.0, RotationAdd: 3}},
			"hihat": {"B": {HitsAdd: 2, HitsMul: 1.0, RotationAdd: 1}, "C": {HitsAdd: -2, HitsMul: 1.0, RotationAdd: 4}},
		},
		PhrasePatterns: map[string][]string{
			"intro":      {"A", "A"},
			"verse":      {"A", "A", "B", "A"},
			"pre-chorus": {"A", "B"},
			"chorus":     {"A", "B", "A", "B"},
			"buildup":    {"A", "B"},
			"drop":       {"A", "B", "A", "B"},
			"breakdown":  {"C", "C"},
			"bridge":     {"C", "C"},
			"outro":      {"A", "A"},
		},
	},
	"edm": {
		ChordProgs: []*ChordProg{
			// i-VI-III-VII (existing minor)
			MinorChordProg,
			// i-VII-vi-V
			{Chords: []ChordDegree{
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 6, Tones: []int{6, 1, 3}},
				{Root: 5, Tones: []int{5, 0, 2}},
				{Root: 4, Tones: []int{4, 6, 1}},
			}, StepsPer: 4},
		},
		DrumStyles: map[string]map[string]DrumVariant{
			"kick":  {"B": {HitsAdd: 0, HitsMul: 1.0, RotationAdd: 4}, "C": {HitsAdd: -2, HitsMul: 1.0, RotationAdd: 2}},
			"snare": {"B": {HitsAdd: 1, HitsMul: 1.0, RotationAdd: 2}, "C": {HitsAdd: -1, HitsMul: 1.0, RotationAdd: 4}},
			"hihat": {"B": {HitsAdd: 2, HitsMul: 1.0, RotationAdd: 1}, "C": {HitsAdd: -3, HitsMul: 1.0, RotationAdd: 3}},
			"clap":  {"B": {HitsAdd: 1, HitsMul: 1.0, RotationAdd: 2}, "C": {HitsAdd: -1, HitsMul: 1.0, RotationAdd: 4}},
		},
		PhrasePatterns: map[string][]string{
			"intro":      {"A", "A"},
			"verse":      {"A", "B", "A", "B"},
			"pre-chorus": {"A", "B"},
			"chorus":     {"A", "B", "A", "B"},
			"buildup":    {"A", "B"},
			"drop":       {"A", "B", "A", "C"},
			"breakdown":  {"C", "C"},
			"bridge":     {"C", "D"},
			"outro":      {"A", "A"},
		},
	},
	"techno": {
		ChordProgs: []*ChordProg{
			// i-VII-i-VII (minimal)
			{Chords: []ChordDegree{
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 6, Tones: []int{6, 1, 3}},
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 6, Tones: []int{6, 1, 3}},
			}, StepsPer: 4},
		},
		DrumStyles: map[string]map[string]DrumVariant{
			"kick":  {"B": {HitsAdd: 0, HitsMul: 1.0, RotationAdd: 4}, "C": {HitsAdd: -2, HitsMul: 1.0, RotationAdd: 2}},
			"snare": {"B": {HitsAdd: 1, HitsMul: 1.0, RotationAdd: 4}, "C": {HitsAdd: -1, HitsMul: 1.0, RotationAdd: 2}},
			"hihat": {"B": {HitsAdd: 2, HitsMul: 1.0, RotationAdd: 2}, "C": {HitsAdd: -3, HitsMul: 1.0, RotationAdd: 4}},
		},
		PhrasePatterns: map[string][]string{
			"intro":      {"A", "A"},
			"verse":      {"A", "A", "A", "B"},
			"pre-chorus": {"A", "B"},
			"chorus":     {"A", "B", "A", "B"},
			"buildup":    {"A", "B"},
			"drop":       {"A", "A", "B", "B"},
			"breakdown":  {"C", "C"},
			"bridge":     {"C", "C"},
			"outro":      {"A", "A"},
		},
	},
	"ambient": {
		ChordProgs: []*ChordProg{
			// I-iii-vi-IV
			{Chords: []ChordDegree{
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 2, Tones: []int{2, 4, 6}},
				{Root: 5, Tones: []int{5, 0, 2}},
				{Root: 3, Tones: []int{3, 5, 0}},
			}, StepsPer: 4},
		},
		DrumStyles: map[string]map[string]DrumVariant{
			"kick":  {"B": {HitsAdd: 0, HitsMul: 1.0, RotationAdd: 4}, "C": {HitsAdd: -1, HitsMul: 1.0, RotationAdd: 6}},
			"snare": {"B": {HitsAdd: 0, HitsMul: 1.0, RotationAdd: 4}, "C": {HitsAdd: -1, HitsMul: 1.0, RotationAdd: 6}},
			"hihat": {"B": {HitsAdd: 1, HitsMul: 1.0, RotationAdd: 3}, "C": {HitsAdd: -1, HitsMul: 1.0, RotationAdd: 5}},
		},
		PhrasePatterns: map[string][]string{
			"intro":     {"A", "B"},
			"verse":     {"A", "B", "C", "D"},
			"chorus":    {"A", "B", "C", "D"},
			"breakdown": {"C", "D"},
			"bridge":    {"C", "D"},
			"outro":     {"A", "B"},
		},
	},
	"dnb": {
		ChordProgs: []*ChordProg{
			// i-VI-III-VII
			MinorChordProg,
		},
		DrumStyles: map[string]map[string]DrumVariant{
			"kick":  {"B": {HitsAdd: 1, HitsMul: 1.0, RotationAdd: 3}, "C": {HitsAdd: -1, HitsMul: 1.0, RotationAdd: 5}},
			"snare": {"B": {HitsAdd: 1, HitsMul: 1.0, RotationAdd: 2}, "C": {HitsAdd: 0, HitsMul: 0.5, RotationAdd: 3}},
			"hihat": {"B": {HitsAdd: 2, HitsMul: 1.0, RotationAdd: 1}, "C": {HitsAdd: -2, HitsMul: 1.0, RotationAdd: 4}},
		},
		PhrasePatterns: map[string][]string{
			"intro":      {"A", "A"},
			"verse":      {"A", "B", "A", "C"},
			"pre-chorus": {"A", "B"},
			"chorus":     {"A", "B", "A", "B"},
			"buildup":    {"A", "B"},
			"drop":       {"A", "B", "C", "A"},
			"breakdown":  {"C", "C"},
			"bridge":     {"C", "D"},
			"outro":      {"A", "A"},
		},
	},
	"speedcore": {
		ChordProgs: []*ChordProg{
			// i-VII (two-chord)
			{Chords: []ChordDegree{
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 6, Tones: []int{6, 1, 3}},
			}, StepsPer: 8},
		},
		DrumStyles: map[string]map[string]DrumVariant{
			"kick":  {"B": {HitsAdd: 2, HitsMul: 1.0, RotationAdd: 2}, "C": {HitsAdd: -2, HitsMul: 1.0, RotationAdd: 4}},
			"snare": {"B": {HitsAdd: 2, HitsMul: 1.0, RotationAdd: 1}, "C": {HitsAdd: -2, HitsMul: 1.0, RotationAdd: 3}},
			"hihat": {"B": {HitsAdd: 3, HitsMul: 1.0, RotationAdd: 1}, "C": {HitsAdd: -4, HitsMul: 1.0, RotationAdd: 5}},
		},
		PhrasePatterns: map[string][]string{
			"intro":     {"A", "A"},
			"verse":     {"A", "A", "A", "A"},
			"chorus":    {"A", "B", "A", "B"},
			"buildup":   {"A", "B"},
			"drop":      {"A", "A", "A", "B"},
			"breakdown": {"C", "C"},
			"outro":     {"A", "A"},
		},
	},
	"dubstep": {
		ChordProgs: []*ChordProg{
			// i-VII-VI-v
			{Chords: []ChordDegree{
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 6, Tones: []int{6, 1, 3}},
				{Root: 5, Tones: []int{5, 0, 2}},
				{Root: 4, Tones: []int{4, 6, 1}},
			}, StepsPer: 4},
		},
		DrumStyles: map[string]map[string]DrumVariant{
			"kick":  {"B": {HitsAdd: 1, HitsMul: 1.0, RotationAdd: 3}, "C": {HitsAdd: -1, HitsMul: 1.0, RotationAdd: 5}},
			"snare": {"B": {HitsAdd: 1, HitsMul: 1.0, RotationAdd: 2}, "C": {HitsAdd: 0, HitsMul: 0.5, RotationAdd: 4}},
			"hihat": {"B": {HitsAdd: 2, HitsMul: 1.0, RotationAdd: 1}, "C": {HitsAdd: -2, HitsMul: 1.0, RotationAdd: 3}},
		},
		PhrasePatterns: map[string][]string{
			"intro":     {"A", "A"},
			"verse":     {"A", "B", "A", "B"},
			"chorus":    {"A", "B", "A", "B"},
			"buildup":   {"A", "B"},
			"drop":      {"A", "A", "B", "C"},
			"breakdown": {"C", "C"},
			"bridge":    {"C", "D"},
			"outro":     {"A", "A"},
		},
	},
	"synthwave": {
		ChordProgs: []*ChordProg{
			// i-VI-III-VII (dark minor, Stranger Things vibe)
			{Chords: []ChordDegree{
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 5, Tones: []int{5, 0, 2}},
				{Root: 2, Tones: []int{2, 4, 6}},
				{Root: 6, Tones: []int{6, 1, 3}},
			}, StepsPer: 4},
			// i-iv-VII-III (atmospheric)
			{Chords: []ChordDegree{
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 3, Tones: []int{3, 5, 0}},
				{Root: 6, Tones: []int{6, 1, 3}},
				{Root: 2, Tones: []int{2, 4, 6}},
			}, StepsPer: 4},
		},
		DrumStyles: map[string]map[string]DrumVariant{
			"kick":  {"B": {HitsAdd: 0, HitsMul: 1.0, RotationAdd: 4}, "C": {HitsAdd: -2, HitsMul: 1.0, RotationAdd: 2}},
			"snare": {"B": {HitsAdd: 1, HitsMul: 1.0, RotationAdd: 2}, "C": {HitsAdd: -1, HitsMul: 1.0, RotationAdd: 4}},
			"hihat": {"B": {HitsAdd: 1, HitsMul: 1.0, RotationAdd: 2}, "C": {HitsAdd: -2, HitsMul: 1.0, RotationAdd: 3}},
		},
		PhrasePatterns: map[string][]string{
			"intro":      {"A", "B"},
			"verse":      {"A", "A", "B", "A"},
			"pre-chorus": {"A", "B"},
			"chorus":     {"A", "B", "A", "B"},
			"breakdown":  {"C", "D"},
			"bridge":     {"C", "C"},
			"outro":      {"A", "A"},
		},
	},
	"trance": {
		ChordProgs: []*ChordProg{
			// i-VI-VII-i (classic trance)
			{Chords: []ChordDegree{
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 5, Tones: []int{5, 0, 2}},
				{Root: 6, Tones: []int{6, 1, 3}},
				{Root: 0, Tones: []int{0, 2, 4}},
			}, StepsPer: 4},
			// i-iv-VI-VII (euphoric trance)
			{Chords: []ChordDegree{
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 3, Tones: []int{3, 5, 0}},
				{Root: 5, Tones: []int{5, 0, 2}},
				{Root: 6, Tones: []int{6, 1, 3}},
			}, StepsPer: 4},
		},
		DrumStyles: map[string]map[string]DrumVariant{
			"kick":  {"B": {HitsAdd: 0, HitsMul: 1.0, RotationAdd: 4}, "C": {HitsAdd: -2, HitsMul: 1.0, RotationAdd: 2}},
			"snare": {"B": {HitsAdd: 1, HitsMul: 1.0, RotationAdd: 2}, "C": {HitsAdd: -1, HitsMul: 1.0, RotationAdd: 4}},
			"hihat": {"B": {HitsAdd: 2, HitsMul: 1.0, RotationAdd: 1}, "C": {HitsAdd: -3, HitsMul: 1.0, RotationAdd: 3}},
		},
		PhrasePatterns: map[string][]string{
			"intro":      {"A", "B"},
			"verse":      {"A", "A", "B", "A"},
			"pre-chorus": {"A", "B"},
			"chorus":     {"A", "B", "A", "C"},
			"buildup":    {"A", "B"},
			"drop":       {"A", "B", "A", "B"},
			"breakdown":  {"C", "D"},
			"bridge":     {"C", "C"},
			"outro":      {"A", "A"},
		},
	},
	"lofi": {
		ChordProgs: []*ChordProg{
			// ii-V-I-vi (jazz-influenced)
			{Chords: []ChordDegree{
				{Root: 1, Tones: []int{1, 3, 5}},
				{Root: 4, Tones: []int{4, 6, 1}},
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 5, Tones: []int{5, 0, 2}},
			}, StepsPer: 4},
			// I-iii-IV-iv (chromatic mediant)
			{Chords: []ChordDegree{
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 2, Tones: []int{2, 4, 6}},
				{Root: 3, Tones: []int{3, 5, 0}},
				{Root: 3, Tones: []int{3, 5, 0}},
			}, StepsPer: 4},
		},
		DrumStyles: map[string]map[string]DrumVariant{
			"kick":  {"B": {HitsAdd: 0, HitsMul: 1.0, RotationAdd: 3}, "C": {HitsAdd: -1, HitsMul: 1.0, RotationAdd: 5}},
			"snare": {"B": {HitsAdd: 0, HitsMul: 1.0, RotationAdd: 2}, "C": {HitsAdd: -1, HitsMul: 1.0, RotationAdd: 4}},
			"hihat": {"B": {HitsAdd: 1, HitsMul: 1.0, RotationAdd: 2}, "C": {HitsAdd: -2, HitsMul: 1.0, RotationAdd: 3}},
		},
		PhrasePatterns: map[string][]string{
			"intro":     {"A", "A"},
			"verse":     {"A", "A", "B", "A"},
			"chorus":    {"A", "B", "A", "B"},
			"breakdown": {"C", "D"},
			"bridge":    {"C", "C"},
			"outro":     {"A", "A"},
		},
	},
	"reggae": {
		ChordProgs: []*ChordProg{
			// I-IV-V-I (roots reggae)
			{Chords: []ChordDegree{
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 3, Tones: []int{3, 5, 0}},
				{Root: 4, Tones: []int{4, 6, 1}},
				{Root: 0, Tones: []int{0, 2, 4}},
			}, StepsPer: 4},
			// I-vi-IV-V (dub)
			{Chords: []ChordDegree{
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 5, Tones: []int{5, 0, 2}},
				{Root: 3, Tones: []int{3, 5, 0}},
				{Root: 4, Tones: []int{4, 6, 1}},
			}, StepsPer: 4},
		},
		DrumStyles: map[string]map[string]DrumVariant{
			"kick":  {"B": {HitsAdd: 1, HitsMul: 1.0, RotationAdd: 2}, "C": {HitsAdd: -1, HitsMul: 1.0, RotationAdd: 4}},
			"snare": {"B": {HitsAdd: 1, HitsMul: 1.0, RotationAdd: 3}, "C": {HitsAdd: 0, HitsMul: 0.5, RotationAdd: 2}},
			"hihat": {"B": {HitsAdd: 1, HitsMul: 1.0, RotationAdd: 1}, "C": {HitsAdd: -2, HitsMul: 1.0, RotationAdd: 3}},
		},
		PhrasePatterns: map[string][]string{
			"intro":      {"A", "A"},
			"verse":      {"A", "A", "B", "A"},
			"pre-chorus": {"A", "B"},
			"chorus":     {"A", "B", "A", "B"},
			"bridge":     {"C", "C"},
			"solo":       {"A", "B", "C", "A"},
			"outro":      {"A", "A"},
		},
	},
	"funk": {
		ChordProgs: []*ChordProg{
			// I7-IV7 (one-chord funk / two-chord vamp)
			{Chords: []ChordDegree{
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 3, Tones: []int{3, 5, 0}},
				{Root: 0, Tones: []int{0, 2, 4}},
			}, StepsPer: 4},
			// I-IV-I-V (classic funk)
			{Chords: []ChordDegree{
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 3, Tones: []int{3, 5, 0}},
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 4, Tones: []int{4, 6, 1}},
			}, StepsPer: 4},
		},
		DrumStyles: map[string]map[string]DrumVariant{
			"kick":  {"B": {HitsAdd: 2, HitsMul: 1.0, RotationAdd: 1}, "C": {HitsAdd: -1, HitsMul: 1.0, RotationAdd: 3}},
			"snare": {"B": {HitsAdd: 1, HitsMul: 1.0, RotationAdd: 2}, "C": {HitsAdd: 0, HitsMul: 0.5, RotationAdd: 4}},
			"hihat": {"B": {HitsAdd: 2, HitsMul: 1.0, RotationAdd: 1}, "C": {HitsAdd: -2, HitsMul: 1.0, RotationAdd: 3}},
		},
		PhrasePatterns: map[string][]string{
			"intro":      {"A", "A"},
			"verse":      {"A", "B", "A", "B"},
			"pre-chorus": {"A", "B"},
			"chorus":     {"A", "B", "B", "A"},
			"breakdown":  {"C", "D"},
			"bridge":     {"C", "C"},
			"solo":       {"A", "B", "C", "A"},
			"outro":      {"A", "A"},
		},
	},
	"bossa": {
		ChordProgs: []*ChordProg{
			// ii-V-I-vi (bossa standard)
			{Chords: []ChordDegree{
				{Root: 1, Tones: []int{1, 3, 5}},
				{Root: 4, Tones: []int{4, 6, 1}},
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 5, Tones: []int{5, 0, 2}},
			}, StepsPer: 4},
			// I-vi-ii-V (turnaround)
			{Chords: []ChordDegree{
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 5, Tones: []int{5, 0, 2}},
				{Root: 1, Tones: []int{1, 3, 5}},
				{Root: 4, Tones: []int{4, 6, 1}},
			}, StepsPer: 4},
		},
		DrumStyles: map[string]map[string]DrumVariant{
			"kick":  {"B": {HitsAdd: 1, HitsMul: 1.0, RotationAdd: 2}, "C": {HitsAdd: -1, HitsMul: 1.0, RotationAdd: 4}},
			"snare": {"B": {HitsAdd: 1, HitsMul: 1.0, RotationAdd: 1}, "C": {HitsAdd: 0, HitsMul: 0.5, RotationAdd: 3}},
			"hihat": {"B": {HitsAdd: 1, HitsMul: 1.0, RotationAdd: 2}, "C": {HitsAdd: -2, HitsMul: 1.0, RotationAdd: 4}},
		},
		PhrasePatterns: map[string][]string{
			"intro":  {"A", "A"},
			"verse":  {"A", "B", "A", "B"},
			"chorus": {"A", "B", "B", "A"},
			"bridge": {"C", "C"},
			"solo":   {"A", "B", "C", "A"},
			"outro":  {"A", "A"},
		},
	},
	"trap": {
		ChordProgs: []*ChordProg{
			// i-VII-VI-VII (dark minor)
			{Chords: []ChordDegree{
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 6, Tones: []int{6, 1, 3}},
				{Root: 5, Tones: []int{5, 0, 2}},
				{Root: 6, Tones: []int{6, 1, 3}},
			}, StepsPer: 4},
			// i-iv-i-VII (trap minor)
			{Chords: []ChordDegree{
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 3, Tones: []int{3, 5, 0}},
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 6, Tones: []int{6, 1, 3}},
			}, StepsPer: 4},
		},
		DrumStyles: map[string]map[string]DrumVariant{
			"kick":  {"B": {HitsAdd: 1, HitsMul: 1.0, RotationAdd: 3}, "C": {HitsAdd: -1, HitsMul: 1.0, RotationAdd: 5}},
			"snare": {"B": {HitsAdd: 1, HitsMul: 1.0, RotationAdd: 2}, "C": {HitsAdd: -1, HitsMul: 1.0, RotationAdd: 4}},
			"hihat": {"B": {HitsAdd: 2, HitsMul: 1.0, RotationAdd: 1}, "C": {HitsAdd: -3, HitsMul: 1.0, RotationAdd: 3}},
		},
		PhrasePatterns: map[string][]string{
			"intro":     {"A", "A"},
			"verse":     {"A", "A", "B", "A"},
			"chorus":    {"A", "B", "A", "B"},
			"drop":      {"A", "B", "A", "B"},
			"breakdown": {"C", "C"},
			"bridge":    {"C", "C"},
			"outro":     {"A", "A"},
		},
	},
	"garage": {
		ChordProgs: []*ChordProg{
			// i-VII-VI-VII (2-step classic)
			{Chords: []ChordDegree{
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 6, Tones: []int{6, 1, 3}},
				{Root: 5, Tones: []int{5, 0, 2}},
				{Root: 6, Tones: []int{6, 1, 3}},
			}, StepsPer: 4},
			// i-iv-VII-III
			{Chords: []ChordDegree{
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 3, Tones: []int{3, 5, 0}},
				{Root: 6, Tones: []int{6, 1, 3}},
				{Root: 2, Tones: []int{2, 4, 6}},
			}, StepsPer: 4},
		},
		DrumStyles: map[string]map[string]DrumVariant{
			"kick":  {"B": {HitsAdd: 1, HitsMul: 1.0, RotationAdd: 3}, "C": {HitsAdd: -1, HitsMul: 1.0, RotationAdd: 5}},
			"snare": {"B": {HitsAdd: 1, HitsMul: 1.0, RotationAdd: 2}, "C": {HitsAdd: 0, HitsMul: 0.5, RotationAdd: 3}},
			"hihat": {"B": {HitsAdd: 2, HitsMul: 1.0, RotationAdd: 1}, "C": {HitsAdd: -2, HitsMul: 1.0, RotationAdd: 4}},
		},
		PhrasePatterns: map[string][]string{
			"intro":        {"A", "A"},
			"verse":        {"A", "B", "A", "C"},
			"pre-chorus":   {"A", "B"},
			"chorus":       {"A", "B", "A", "B"},
			"buildup":      {"A", "B"},
			"drop":         {"A", "B", "A", "C"},
			"breakdown":    {"C", "C"},
			"bridge":       {"C", "D"},
			"outro":        {"A", "A"},
		},
	},
	"metal": {
		ChordProgs: []*ChordProg{
			// i-II-VII-i (phrygian metal)
			{Chords: []ChordDegree{
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 1, Tones: []int{1, 3, 5}},
				{Root: 6, Tones: []int{6, 1, 3}},
				{Root: 0, Tones: []int{0, 2, 4}},
			}, StepsPer: 4},
			// i-VI-VII-i (power chord)
			{Chords: []ChordDegree{
				{Root: 0, Tones: []int{0, 2, 4}},
				{Root: 5, Tones: []int{5, 0, 2}},
				{Root: 6, Tones: []int{6, 1, 3}},
				{Root: 0, Tones: []int{0, 2, 4}},
			}, StepsPer: 4},
		},
		DrumStyles: map[string]map[string]DrumVariant{
			"kick":  {"B": {HitsAdd: 2, HitsMul: 1.0, RotationAdd: 2}, "C": {HitsAdd: -2, HitsMul: 1.0, RotationAdd: 4}},
			"snare": {"B": {HitsAdd: 2, HitsMul: 1.0, RotationAdd: 1}, "C": {HitsAdd: -1, HitsMul: 1.0, RotationAdd: 3}},
			"hihat": {"B": {HitsAdd: 2, HitsMul: 1.0, RotationAdd: 1}, "C": {HitsAdd: -3, HitsMul: 1.0, RotationAdd: 4}},
		},
		PhrasePatterns: map[string][]string{
			"intro":      {"A", "B"},
			"verse":      {"A", "A", "B", "A"},
			"pre-chorus": {"A", "B"},
			"chorus":     {"A", "B", "A", "B"},
			"breakdown":  {"C", "D"},
			"bridge":     {"C", "C"},
			"solo":       {"A", "B", "C", "D"},
			"outro":      {"A", "A"},
		},
	},
}

// GenrePhrases returns the phrase pattern for a section from the genre theory,
// falling back to DefaultPhrases if the genre has no specific pattern.
func GenrePhrases(theory *GenreTheory, sectionName string) []string {
	if theory != nil && theory.PhrasePatterns != nil {
		if pattern, ok := theory.PhrasePatterns[sectionName]; ok {
			return pattern
		}
	}
	return DefaultPhrases(sectionName)
}

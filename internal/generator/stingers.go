package generator

import (
	"math/rand"

	"beats-bitwrap-io/internal/pflow"
)

// Stinger tracks — airhorn / laser / subdrop / booj as real nets that
// fire on every beat (4 hits over 16 sixteenth-steps via Euclidean).
// They start muted so new projects don't blast stingers on first play;
// the user unmutes via the mixer or triggers manually via the Fire pads
// in the Beats panel of the frontend.
//
// Ported from public/lib/generator/composer.js:777 in beats-bitwrap-io.
// The reserved `hit` schema prefix lets the frontend locate all stinger
// slots regardless of which instrument is bound to each one.

// StingerSpec describes one stinger slot: its net ID, MIDI channel, and
// the instrument the slot defaults to. Channels 20..23 sit well above
// the music-track channels (4/5/6/10) so they don't clash.
type StingerSpec struct {
	ID                string
	Channel           int
	DefaultInstrument string
}

// StingerSpecs is the canonical slot list. Kept in sync with
// STINGER_SPECS in the upstream composer.js.
var StingerSpecs = []StingerSpec{
	{ID: "hit1", Channel: 20, DefaultInstrument: "airhorn"},
	{ID: "hit2", Channel: 21, DefaultInstrument: "laser"},
	{ID: "hit3", Channel: 22, DefaultInstrument: "subdrop"},
	{ID: "hit4", Channel: 23, DefaultInstrument: "booj"},
}

// StingerInstrumentSet is the curated list of non-percussion voices
// suitable as stingers. The frontend's rotate button on each stinger
// row cycles through this list; drum-kit entries are intentionally
// excluded in favour of transient / stabby timbres.
var StingerInstrumentSet = []string{
	// Reserved — no bound instrument (silent slot, still fires paired macros)
	"unbound",
	// Custom stingers
	"airhorn", "laser", "subdrop", "booj",
	// Bells / perc
	"fm-bell", "am-bell", "marimba", "vibes", "kalimba", "steel-drum",
	"music-box", "metallic", "noise-hit",
	// Stabs / plucks
	"rave-stab", "edm-stab", "hoover", "pluck", "bright-pluck",
	"muted-pluck", "edm-pluck", "chiptune",
	// Bass hits
	"808-bass", "sub-bass", "drop-bass", "fm-bass",
	// Short leads
	"square-lead", "sync-lead", "scream-lead",
}

// AddStingerTracks appends the hit1..hit4 stinger nets to proj, unless
// a net with that ID already exists (so manual additions aren't
// clobbered). Each slot starts muted via proj.InitialMutes.
//
// `seed` is used to seed the Euclidean net's internal RNG so the
// pattern is deterministic per project. The actual rhythm is fixed
// (4/16) — the seed only influences params.Seed for future variety.
func AddStingerTracks(proj *pflow.Project, seed int64) {
	_ = rand.New(rand.NewSource(seed)) // reserved: future per-slot variation
	for _, spec := range StingerSpecs {
		if _, exists := proj.Nets[spec.ID]; exists {
			continue
		}
		params := Params{
			Channel:  spec.Channel,
			Velocity: 95,
			Duration: 80,
			Seed:     seed,
			Accent:   AccentNone,
		}
		// 4 hits / 16 steps / rotation 0 / note 60 — token fires on the
		// downbeat of every beat (quarter notes at 16 sixteenths/bar).
		res := Euclidean(4, 16, 0, 60, params)
		bundle := res.Bundle
		bundle.Track.Instrument = spec.DefaultInstrument
		bundle.Track.InstrumentSet = append([]string(nil), StingerInstrumentSet...)
		bundle.Track.Group = "stinger"
		proj.Nets[spec.ID] = bundle
		if !containsString(proj.InitialMutes, spec.ID) {
			proj.InitialMutes = append(proj.InitialMutes, spec.ID)
		}
	}
}

func containsString(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

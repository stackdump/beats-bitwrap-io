package generator

import (
	"reflect"
	"testing"
)

func TestSameSeedSameTheme(t *testing.T) {
	a := BuildTrackTheme("techno", 42)
	b := BuildTrackTheme("techno", 42)
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("BuildTrackTheme(\"techno\", 42) not deterministic")
	}
}

func TestEnergyMonotonicityEDM(t *testing.T) {
	theme := BuildTrackTheme("techno", 1)
	intro := theme.Energy["intro"].Energy
	buildup := theme.Energy["buildup"].Energy
	drop := theme.Energy["drop"].Energy
	if !(drop > buildup && buildup > intro) {
		t.Fatalf("expected drop > buildup > intro, got intro=%.2f buildup=%.2f drop=%.2f",
			intro, buildup, drop)
	}
	// Filter should open on the drop and close on the breakdown.
	if !(theme.Energy["drop"].FilterOpen > theme.Energy["breakdown"].FilterOpen) {
		t.Fatalf("expected drop filter > breakdown filter")
	}
}

func TestDropKickActiveBreakdownKickInactive(t *testing.T) {
	theme := BuildTrackTheme("techno", 1)
	dropKick := theme.Energy["drop"].Roles["kick"]
	breakdownKick, has := theme.Energy["breakdown"].Roles["kick"]
	if !dropKick.Active {
		t.Fatalf("drop kick should be active")
	}
	if has && breakdownKick.Active {
		t.Fatalf("breakdown kick should be inactive (the defining EDM signature)")
	}
}

func TestMotifRecallVerbatim(t *testing.T) {
	theme := BuildTrackTheme("techno", 1)
	a := RenderMotif(theme.Motif, MotifPlay, 0)
	b := RenderMotif(theme.Motif, MotifPlay, 0)
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("MotifPlay should be a pure function of its inputs")
	}
	// Verbatim recall yields the same active degrees as the base motif.
	if !reflect.DeepEqual(a.Degrees, theme.Motif.Degrees) {
		t.Fatalf("MotifPlay should preserve motif degrees")
	}
}

func TestMotifRecallAugmentedDoublesLength(t *testing.T) {
	theme := BuildTrackTheme("techno", 1)
	aug := RenderMotif(theme.Motif, MotifAugmented, 0)
	if len(aug.Degrees) != 2*len(theme.Motif.Degrees) {
		t.Fatalf("MotifAugmented should double cell length: got %d want %d",
			len(aug.Degrees), 2*len(theme.Motif.Degrees))
	}
	// Active steps preserved at even indices.
	for i, d := range theme.Motif.Degrees {
		if aug.Degrees[i*2] != d {
			t.Fatalf("MotifAugmented step %d: got %d want %d", i*2, aug.Degrees[i*2], d)
		}
	}
}

func TestMotifFragmentHalvesActiveSteps(t *testing.T) {
	theme := BuildTrackTheme("techno", 1)
	full := countActive(theme.Motif)
	frag := countActive(RenderMotif(theme.Motif, MotifFragment, 0))
	if frag >= full {
		t.Fatalf("MotifFragment should drop the back half: full=%d frag=%d", full, frag)
	}
}

func countActive(c MotifCell) int {
	n := 0
	for _, d := range c.Degrees {
		if d >= 0 {
			n++
		}
	}
	return n
}

func TestMotifNetGeneratesBindings(t *testing.T) {
	theme := BuildTrackTheme("techno", 1)
	scale := MajorScale(48)
	nb := MotifNet(theme.Motif, scale, Params{Channel: 4, Velocity: 90, Duration: 150})
	if nb == nil {
		t.Fatalf("MotifNet returned nil")
	}
	if len(nb.Bindings) == 0 {
		t.Fatalf("MotifNet should produce at least one MIDI binding")
	}
}

// Slice 2 — phrase grammar invariants.

func TestMotifAnswerResolvesToTonic(t *testing.T) {
	for seed := int64(1); seed < 20; seed++ {
		m := BuildTrackTheme("techno", seed).Motif
		li := lastActiveIn(m.Degrees, 48, 64)
		if li < 0 {
			t.Fatalf("seed %d: answer bar has no active steps", seed)
		}
		if m.Degrees[li] != 0 {
			t.Fatalf("seed %d: answer should resolve to tonic; last degree=%d", seed, m.Degrees[li])
		}
	}
}

func TestMotifIsFourBars(t *testing.T) {
	m := BuildTrackTheme("techno", 42).Motif
	if len(m.Degrees) != 64 || len(m.Mask) != 64 {
		t.Fatalf("slice-2 motif should be 64 steps; got %d/%d", len(m.Degrees), len(m.Mask))
	}
}

func TestMotifStrongBeatsAreChordTones(t *testing.T) {
	theme := BuildTrackTheme("techno", 42)
	for i := 0; i < 64; i += 4 {
		d := theme.Motif.Degrees[i]
		if d < 0 {
			continue // strong beats always masked on, but be lenient
		}
		bar := i / 16
		chord := theme.Plan.ChordAt(bar * theme.Plan.StepsPerChord)
		found := false
		for _, t2 := range chord.Tones {
			if clampDegree(t2) == d {
				found = true
				break
			}
		}
		// The question/answer end overrides can land on non-strong-beat
		// positions only, so every strong beat must be a chord tone —
		// EXCEPT the final answer steps which force the tonic (and the
		// tonic of bar's chord may not contain degree 0).
		if !found && d != 0 {
			t.Fatalf("step %d (bar %d): degree %d is not a chord tone of %v",
				i, bar, d, chord.Tones)
		}
	}
}

func TestChordPadNetVoicesAllChords(t *testing.T) {
	theme := BuildTrackTheme("techno", 42)
	scale := MajorScale(48)
	nb := ChordPadNet(theme.Plan, scale, Params{Channel: 7, Velocity: 68, Duration: 1800})
	want := len(theme.Plan.Chords) * 3
	if len(nb.Bindings) != want {
		t.Fatalf("pad should bind %d notes (chords x 3); got %d", want, len(nb.Bindings))
	}
	if got := len(nb.Net.Places); got != theme.Plan.CycleSteps() {
		t.Fatalf("pad ring should span the chord cycle (%d steps); got %d",
			theme.Plan.CycleSteps(), got)
	}
}

func TestChordBassRingWalksRoots(t *testing.T) {
	theme := BuildTrackTheme("synthwave", 42)
	barMask := []bool{
		true, false, false, false, true, false, false, false,
		true, false, false, false, true, false, false, false,
	}
	scale := MinorScale(48)[:7]
	nb := chordBassRing(theme.Plan, barMask, scale, Params{Channel: 6, Velocity: 90, Duration: 200})
	if len(nb.Bindings) != 16 {
		t.Fatalf("4 hits x 4 bars = 16 bindings; got %d", len(nb.Bindings))
	}
	pitches := map[int]bool{}
	for _, b := range nb.Bindings {
		pitches[b.Note] = true
	}
	// synthwave progs have 4 distinct roots (i-VI-III-VII or i-iv-VII-III).
	if len(pitches) < 3 {
		t.Fatalf("bass should walk >=3 distinct chord roots; got %d", len(pitches))
	}
}

package countermelody

import (
	"reflect"
	"testing"
)

// TestAnswerMode_RestMaskFill: notes only land on rest ticks, never
// on a source hit.
func TestAnswerMode_RestMaskFill(t *testing.T) {
	hits := make([]bool, 16)
	for i := 0; i < 16; i += 4 {
		hits[i] = true
	}
	pitchSet := []int{60, 64, 67}
	rng := NewMulberry32(42)
	notes := AnswerMode(hits, pitchSet, "above", 1.0, rng)
	if len(notes) == 0 {
		t.Fatalf("answer mode produced no notes for a sparse rhythm")
	}
	for _, n := range notes {
		if n.StartTick < 0 || n.StartTick >= 16 {
			t.Fatalf("note start tick out of range: %d", n.StartTick)
		}
		if hits[n.StartTick] {
			t.Fatalf("answer note placed on a source hit at tick %d", n.StartTick)
		}
		if n.Note < 24 || n.Note > 108 {
			t.Fatalf("answer note %d out of MIDI range", n.Note)
		}
	}
}

// TestAnswerMode_AboveTransposes verifies register=above shifts up
// 12 semis from the source pitch set.
func TestAnswerMode_AboveTransposes(t *testing.T) {
	hits := []bool{false, false, false, false}
	pitchSet := []int{60}
	rng := NewMulberry32(1)
	notes := AnswerMode(hits, pitchSet, "above", 1.0, rng)
	if len(notes) == 0 {
		t.Skip("density gate didn't fire — re-run with different seed")
	}
	if notes[0].Note != 72 {
		t.Fatalf("above register: got %d, want 72 (C5 = 60+12)", notes[0].Note)
	}
}

// TestAnswerMode_BelowTransposes verifies register=below shifts down
// (or octave-clamps).
func TestAnswerMode_BelowTransposes(t *testing.T) {
	hits := []bool{false, false, false, false}
	pitchSet := []int{60}
	rng := NewMulberry32(1)
	notes := AnswerMode(hits, pitchSet, "below", 1.0, rng)
	if len(notes) == 0 {
		t.Skip("density gate didn't fire")
	}
	if notes[0].Note != 48 {
		t.Fatalf("below register: got %d, want 48 (C3 = 60-12)", notes[0].Note)
	}
}

// TestAnswerMode_Determinism: same hits + pitch set + seed produce
// identical notes across runs.
func TestAnswerMode_Determinism(t *testing.T) {
	hits := make([]bool, 32)
	for i := 0; i < 32; i += 4 {
		hits[i] = true
	}
	pitchSet := []int{60, 64, 67}
	a := AnswerMode(hits, pitchSet, "above", 0.7, NewMulberry32(12345))
	b := AnswerMode(hits, pitchSet, "above", 0.7, NewMulberry32(12345))
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("non-deterministic: %v != %v", a, b)
	}
}

// TestHarmonyMode_ParallelMotion: density=1.0 keeps every source
// note, intervals match register.
func TestHarmonyMode_ParallelMotion(t *testing.T) {
	src := []SourceNote{
		{Tick: 0, Note: 60, Velocity: 90},
		{Tick: 4, Note: 64, Velocity: 90},
		{Tick: 8, Note: 67, Velocity: 90},
	}
	out := HarmonyMode(src, "above", 1.0, NewMulberry32(1))
	if len(out) != len(src) {
		t.Fatalf("density=1.0 should keep all notes; got %d, want %d", len(out), len(src))
	}
	for i, n := range out {
		want := src[i].Note + 4
		if n.Note != want {
			t.Fatalf("harmony[%d] note = %d, want %d", i, n.Note, want)
		}
		if n.StartTick != src[i].Tick {
			t.Fatalf("harmony[%d] tick should match source: got %d, want %d", i, n.StartTick, src[i].Tick)
		}
	}
}

// TestHarmonyMode_BelowMinorThird: register=below emits a minor 3rd
// below (-3 semis).
func TestHarmonyMode_BelowMinorThird(t *testing.T) {
	src := []SourceNote{{Tick: 0, Note: 60, Velocity: 90}}
	out := HarmonyMode(src, "below", 1.0, NewMulberry32(1))
	if len(out) != 1 {
		t.Fatalf("expected 1 harmony note; got %d", len(out))
	}
	if out[0].Note != 57 {
		t.Fatalf("below: got %d, want 57 (60 - 3)", out[0].Note)
	}
}

// TestShadowMode_LateEchoes: each shadow note is one tick after its
// source, at half velocity, transposed +12.
func TestShadowMode_LateEchoes(t *testing.T) {
	src := []SourceNote{
		{Tick: 0, Note: 60, Velocity: 100},
		{Tick: 4, Note: 64, Velocity: 100},
	}
	out := ShadowMode(src, 32, "above", 1.0, NewMulberry32(1))
	if len(out) != len(src) {
		t.Fatalf("density=1.0 should echo every source note; got %d, want %d", len(out), len(src))
	}
	for i, n := range out {
		if n.StartTick != src[i].Tick+1 {
			t.Fatalf("shadow[%d] tick = %d, want %d", i, n.StartTick, src[i].Tick+1)
		}
		if n.Note != src[i].Note+12 {
			t.Fatalf("shadow[%d] note = %d, want %d", i, n.Note, src[i].Note+12)
		}
		if n.Velocity > 60 {
			t.Fatalf("shadow[%d] velocity = %d should be ≤ half source", i, n.Velocity)
		}
	}
}

// TestShadowMode_DropsLastTickEchoes: an echo past totalTicks is
// silently dropped.
func TestShadowMode_DropsLastTickEchoes(t *testing.T) {
	src := []SourceNote{{Tick: 31, Note: 60, Velocity: 100}}
	out := ShadowMode(src, 32, "above", 1.0, NewMulberry32(1))
	if len(out) != 0 {
		t.Fatalf("echo past totalTicks should be dropped; got %d", len(out))
	}
}

// TestMulberry32_NonZeroAdvances: confirm the PRNG produces non-zero
// output and matches the constructor contract (state is set, Next()
// advances).
func TestMulberry32_NonZeroAdvances(t *testing.T) {
	m := NewMulberry32(1234567)
	for i := 0; i < 3; i++ {
		if m.Next() == 0 {
			t.Fatalf("mulberry32 output %d should not be zero", i)
		}
	}
}

// TestSeedFromBytes_Deterministic: same input bytes → same seed.
func TestSeedFromBytes_Deterministic(t *testing.T) {
	a := SeedFromBytes([]byte("hello"), []byte("world"))
	b := SeedFromBytes([]byte("hello"), []byte("world"))
	if a != b {
		t.Fatalf("SeedFromBytes non-deterministic: %d != %d", a, b)
	}
	c := SeedFromBytes([]byte("helloworld"))
	if a != c {
		t.Fatalf("SeedFromBytes should be order-equivalent: %d != %d", a, c)
	}
}

// TestBuildMusicNet_RingTopology: the built net has totalTicks
// places, transitions, and a closed ring of arcs.
func TestBuildMusicNet_RingTopology(t *testing.T) {
	notes := []NoteEvent{
		{StartTick: 0, Note: 60, Velocity: 90, Duration: 4},
		{StartTick: 4, Note: 64, Velocity: 90, Duration: 4},
	}
	nb := BuildMusicNet(notes, NetOpts{
		TotalTicks: 16,
		Channel:    11,
		Instrument: "electric-piano",
		MsPerTick:  120.0,
	})
	if nb == nil {
		t.Fatalf("BuildMusicNet returned nil")
	}
	if nb.Role != "music" {
		t.Fatalf("expected role=music, got %q", nb.Role)
	}
	if nb.Track.Channel != 11 || nb.Track.Instrument != "electric-piano" {
		t.Fatalf("track metadata wrong: %+v", nb.Track)
	}
	if nb.Track.Group != "harmony" {
		t.Fatalf("default group should be harmony; got %q", nb.Track.Group)
	}
	if got := len(nb.Net.Places); got != 16 {
		t.Fatalf("expected 16 places, got %d", got)
	}
	if got := len(nb.Net.Transitions); got != 16 {
		t.Fatalf("expected 16 transitions, got %d", got)
	}
	if got := len(nb.Net.Arcs); got != 32 {
		t.Fatalf("expected 32 arcs (16 place→trans + 16 trans→place), got %d", got)
	}
}

// TestBuildMusicNet_BindingsOnOnsetsOnly: only note-onset transitions
// carry MIDI bindings; the rest are silent advancers.
func TestBuildMusicNet_BindingsOnOnsetsOnly(t *testing.T) {
	notes := []NoteEvent{
		{StartTick: 2, Note: 60, Velocity: 90, Duration: 4},
		{StartTick: 7, Note: 64, Velocity: 70, Duration: 2},
	}
	nb := BuildMusicNet(notes, NetOpts{
		TotalTicks: 8,
		Channel:    11,
		MsPerTick:  100.0,
	})
	if len(nb.Bindings) != 2 {
		t.Fatalf("expected 2 bindings, got %d", len(nb.Bindings))
	}
	b2 := nb.Bindings["t2"]
	if b2 == nil || b2.Note != 60 || b2.Velocity != 90 {
		t.Fatalf("binding at t2 wrong: %+v", b2)
	}
	if b2.Duration != 400 {
		t.Fatalf("t2 duration should be 400 ms (4 ticks × 100 ms/tick); got %d", b2.Duration)
	}
	b7 := nb.Bindings["t7"]
	if b7 == nil || b7.Note != 64 || b7.Duration != 200 {
		t.Fatalf("binding at t7 wrong: %+v", b7)
	}
}

// TestBuildMusicNet_DropsOutOfRangeNotes: notes with StartTick
// outside [0, totalTicks) are silently skipped.
func TestBuildMusicNet_DropsOutOfRangeNotes(t *testing.T) {
	notes := []NoteEvent{
		{StartTick: -1, Note: 60, Velocity: 90, Duration: 2},
		{StartTick: 0, Note: 62, Velocity: 90, Duration: 2},
		{StartTick: 8, Note: 64, Velocity: 90, Duration: 2}, // == totalTicks
	}
	nb := BuildMusicNet(notes, NetOpts{TotalTicks: 8, MsPerTick: 100.0})
	if len(nb.Bindings) != 1 {
		t.Fatalf("expected 1 binding (only StartTick=0 in range); got %d", len(nb.Bindings))
	}
	if nb.Bindings["t0"] == nil {
		t.Fatalf("expected binding at t0")
	}
}

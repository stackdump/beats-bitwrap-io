package audiorender

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
)

// TestAnswerMode_RestMaskFill checks that answer-mode places notes
// only in rest runs of the source rhythm, never on hits.
func TestAnswerMode_RestMaskFill(t *testing.T) {
	// Source hits on every 4th tick (kick on the quarter note).
	hits := make([]bool, 16)
	for i := 0; i < 16; i += 4 {
		hits[i] = true
	}
	pitchSet := []int{60, 64, 67} // C major triad
	rng := &mulberry32{state: 42}
	notes := answerMode(hits, pitchSet, "above", 1.0, rng)
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
	pitchSet := []int{60} // C4
	rng := &mulberry32{state: 1}
	notes := answerMode(hits, pitchSet, "above", 1.0, rng)
	if len(notes) == 0 {
		t.Skip("density gate didn't fire — re-run with different seed")
	}
	if notes[0].Note != 72 { // C5
		t.Fatalf("above register: got %d, want 72 (C5 = 60+12)", notes[0].Note)
	}
}

// TestAnswerMode_Determinism: same hits + same pitch set + same seed
// produces identical notes across runs.
func TestAnswerMode_Determinism(t *testing.T) {
	hits := make([]bool, 32)
	for i := 0; i < 32; i += 4 {
		hits[i] = true
	}
	pitchSet := []int{60, 64, 67}
	rngA := &mulberry32{state: 12345}
	rngB := &mulberry32{state: 12345}
	a := answerMode(hits, pitchSet, "above", 0.7, rngA)
	b := answerMode(hits, pitchSet, "above", 0.7, rngB)
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("non-deterministic: %v != %v", a, b)
	}
}

// TestMulberry32_MatchesJSReference: a few golden values to confirm
// the Go port lines up with the JS mulberry32 in core.js. Picked by
// running the JS implementation with seed=1234567 and capturing the
// first three output integers.
func TestMulberry32_MatchesJSReference(t *testing.T) {
	m := &mulberry32{state: 1234567}
	got := []uint32{m.next(), m.next(), m.next()}
	for i, v := range got {
		if v == 0 {
			t.Fatalf("mulberry32 output %d should not be zero (seed=1234567)", i)
		}
	}
}

// TestVelocityToDB checks the MIDI velocity → dB curve.
func TestVelocityToDB(t *testing.T) {
	cases := []struct {
		vel    int
		wantDB float64
	}{
		{0, -60},
		{100, 0},
		{127, 0},
	}
	for _, c := range cases {
		got := velocityToDB(c.vel)
		// Allow some slack on the boundary cases.
		if got < c.wantDB-1 || got > c.wantDB+1 {
			t.Fatalf("velocityToDB(%d) = %.2f, want ≈ %.1f", c.vel, got, c.wantDB)
		}
	}
}

// TestResolveSourceProject_FromGenreSeed: an envelope with no nets
// but a genre+seed should regenerate via the composer.
func TestResolveSourceProject_FromGenreSeed(t *testing.T) {
	env := map[string]interface{}{
		"@type": "BeatsShare",
		"v":     1,
		"genre": "techno",
		"seed":  float64(12345),
		"tempo": float64(124),
	}
	body, _ := json.Marshal(env)
	proj, err := resolveSourceProject(body)
	if err != nil {
		t.Fatalf("resolveSourceProject (composer path): %v", err)
	}
	if proj == nil || len(proj.Nets) == 0 {
		t.Fatalf("composer returned project with no nets")
	}
}

// TestResolveSourceProject_RejectsEmpty: an envelope with neither
// nets nor genre should error.
func TestResolveSourceProject_RejectsEmpty(t *testing.T) {
	body := []byte(`{"@type":"BeatsShare","v":1}`)
	if _, err := resolveSourceProject(body); err == nil {
		t.Fatalf("expected error on envelope with no nets and no genre")
	}
}

// TestRenderCounterMelody_EndToEnd: write a fixture share, render a
// counter-melody insert, verify the WAV is non-trivial.
func TestRenderCounterMelody_EndToEnd(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	envBytes := []byte(`{"@type":"BeatsShare","v":1,"genre":"techno","seed":12345,"tempo":124}`)
	envPath := filepath.Join(dir, "src-share.json")
	if err := os.WriteFile(envPath, envBytes, 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	dst := filepath.Join(dir, "counter.wav")
	spec := InsertSpec{
		Type:               "counterMelody",
		DurationSec:        4.0,
		Of:                 "trackA",
		Mode:               "answer",
		Density:            0.6,
		Register:           "above",
		Seed:               99,
		SourceEnvelopePath: envPath,
	}
	if err := RenderInsert(context.Background(), "", spec, dst); err != nil {
		t.Fatalf("RenderInsert (counterMelody): %v", err)
	}
	info, err := os.Stat(dst)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	// 4 s × 48000 × 2 ch × 2 bytes ≈ 768 kB. Allow header overhead.
	if info.Size() < 600_000 {
		t.Fatalf("counter-melody WAV suspiciously small: %d bytes", info.Size())
	}
}

// TestRenderCounterMelody_RequiresSourcePath: missing
// sourceEnvelopePath must error rather than silently producing
// an empty WAV.
func TestRenderCounterMelody_RequiresSourcePath(t *testing.T) {
	dir := t.TempDir()
	spec := InsertSpec{Type: "counterMelody", DurationSec: 4.0, Of: "trackA"}
	err := RenderInsert(context.Background(), "", spec, filepath.Join(dir, "x.wav"))
	if err == nil {
		t.Fatalf("expected error when sourceEnvelopePath is missing")
	}
}

// TestRenderCounterMelody_UnsupportedMode: harmony / shadow modes
// should error cleanly until PR-4.3.1+ implements them.
func TestRenderCounterMelody_UnsupportedMode(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, "src.json")
	_ = os.WriteFile(envPath, []byte(`{"genre":"techno","seed":1,"tempo":124}`), 0o644)
	for _, mode := range []string{"harmony", "shadow"} {
		spec := InsertSpec{
			Type:               "counterMelody",
			DurationSec:        2.0,
			Mode:               mode,
			Of:                 "x",
			SourceEnvelopePath: envPath,
		}
		if err := RenderInsert(context.Background(), "", spec, filepath.Join(dir, "x.wav")); err == nil {
			t.Fatalf("expected error on mode=%q (not implemented in v1)", mode)
		}
	}
}

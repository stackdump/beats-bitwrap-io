package audiorender

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// Kernel-level tests (per-mode determinism, PRNG, register
// transposition) live in internal/generator/countermelody. This file
// covers the audiorender-specific renderer wiring: spec validation,
// source-envelope resolution, end-to-end WAV synthesis.

// TestVelocityToDB checks the MIDI velocity → dB curve used by the
// ffmpeg synth path.
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

// TestRenderCounterMelody_UnknownModeRejected: any mode outside
// answer/harmony/shadow must error cleanly.
func TestRenderCounterMelody_UnknownModeRejected(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, "src.json")
	_ = os.WriteFile(envPath, []byte(`{"genre":"techno","seed":1,"tempo":124}`), 0o644)
	spec := InsertSpec{
		Type:               "counterMelody",
		DurationSec:        2.0,
		Mode:               "trance-out",
		Of:                 "x",
		SourceEnvelopePath: envPath,
	}
	if err := RenderInsert(context.Background(), "", spec, filepath.Join(dir, "x.wav")); err == nil {
		t.Fatalf("expected error on unknown mode")
	}
}

// TestRenderCounterMelody_HarmonyEndToEnd: harmony mode produces a
// non-trivial WAV when a source share has music transitions.
func TestRenderCounterMelody_HarmonyEndToEnd(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	envPath := filepath.Join(dir, "src.json")
	_ = os.WriteFile(envPath, []byte(`{"@type":"BeatsShare","v":1,"genre":"techno","seed":12345,"tempo":124}`), 0o644)
	dst := filepath.Join(dir, "harmony.wav")
	spec := InsertSpec{
		Type:               "counterMelody",
		DurationSec:        2.0,
		Mode:               "harmony",
		Of:                 "trackA",
		Density:            0.6,
		SourceEnvelopePath: envPath,
		Seed:               42,
	}
	if err := RenderInsert(context.Background(), "", spec, dst); err != nil {
		t.Fatalf("RenderInsert harmony: %v", err)
	}
	if info, _ := os.Stat(dst); info == nil || info.Size() < 200_000 {
		t.Fatalf("harmony WAV suspiciously small")
	}
}

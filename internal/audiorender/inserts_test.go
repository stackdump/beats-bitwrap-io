package audiorender

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestRenderRiser_ProducesNonEmptyWav(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	dst := filepath.Join(dir, "riser.wav")
	if err := RenderInsert(context.Background(), "",
		InsertSpec{Type: "riser", DurationSec: 2.0},
		dst,
	); err != nil {
		t.Fatalf("RenderInsert: %v", err)
	}
	info, err := os.Stat(dst)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	// 2 s × 48 kHz × 2 ch × 2 bytes ≈ 384 kB. Allow some header overhead.
	if info.Size() < 300_000 {
		t.Fatalf("riser WAV suspiciously small: %d bytes", info.Size())
	}
}

func TestRenderRiser_RejectsUnknownShape(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	err := RenderInsert(context.Background(), "",
		InsertSpec{Type: "riser", DurationSec: 1.0, Shape: "weird-noise"},
		filepath.Join(dir, "x.wav"),
	)
	if err == nil {
		t.Fatalf("expected error on unknown shape")
	}
}

func TestRenderInsert_RejectsUnknownType(t *testing.T) {
	dir := t.TempDir()
	err := RenderInsert(context.Background(), "",
		InsertSpec{Type: "alien", DurationSec: 1.0},
		filepath.Join(dir, "x.wav"),
	)
	if err == nil {
		t.Fatalf("expected error on unknown insert type")
	}
}

func TestRenderInsert_RejectsZeroDuration(t *testing.T) {
	dir := t.TempDir()
	err := RenderInsert(context.Background(), "",
		InsertSpec{Type: "riser"},
		filepath.Join(dir, "x.wav"),
	)
	if err == nil {
		t.Fatalf("expected error on zero duration")
	}
}

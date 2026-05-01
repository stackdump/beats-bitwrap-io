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

func TestRenderDrone_ProducesNonEmptyWav(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	dst := filepath.Join(dir, "drone.wav")
	if err := RenderInsert(context.Background(), "",
		InsertSpec{Type: "drone", DurationSec: 4.0, RootHz: 220},
		dst,
	); err != nil {
		t.Fatalf("drone: %v", err)
	}
	if info, _ := os.Stat(dst); info == nil || info.Size() < 700_000 {
		t.Fatalf("drone WAV suspiciously small")
	}
}

func TestRenderImpact_AllVariants(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	for _, v := range []string{"sub-boom", "low-thump", "snare-crack"} {
		dst := filepath.Join(dir, "impact-"+v+".wav")
		if err := RenderInsert(context.Background(), "",
			InsertSpec{Type: "impact", DurationSec: 0.6, Variant: v},
			dst,
		); err != nil {
			t.Fatalf("impact %q: %v", v, err)
		}
		if info, _ := os.Stat(dst); info == nil || info.Size() < 100_000 {
			t.Fatalf("impact %q WAV suspiciously small (%d bytes)", v, info.Size())
		}
	}
}

func TestRenderImpact_RejectsUnknownVariant(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	if err := RenderInsert(context.Background(), "",
		InsertSpec{Type: "impact", DurationSec: 0.5, Variant: "loud-bang"},
		filepath.Join(dir, "x.wav"),
	); err == nil {
		t.Fatalf("expected error on unknown impact variant")
	}
}

func TestRenderTexture_AllKinds(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	for _, k := range []string{"vinyl-crackle", "pink-bed", "white-bed"} {
		dst := filepath.Join(dir, "texture-"+k+".wav")
		if err := RenderInsert(context.Background(), "",
			InsertSpec{Type: "texture", DurationSec: 4.0, Kind: k},
			dst,
		); err != nil {
			t.Fatalf("texture %q: %v", k, err)
		}
		if info, _ := os.Stat(dst); info == nil || info.Size() < 700_000 {
			t.Fatalf("texture %q WAV suspiciously small", k)
		}
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

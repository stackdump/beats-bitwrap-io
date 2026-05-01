package audiorender

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestCompileChainStep_Highpass(t *testing.T) {
	got, err := compileChainStep(ChainStep{Type: "highpass", Freq: 30})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if !strings.HasPrefix(got, "highpass=") {
		t.Fatalf("expected highpass= prefix; got %q", got)
	}
	if !strings.Contains(got, "f=30") {
		t.Fatalf("missing freq; got %q", got)
	}
	if !strings.Contains(got, "p=2") {
		t.Fatalf("expected 12 dB/oct (p=2); got %q", got)
	}
}

func TestCompileChainStep_HighpassDefaultFreq(t *testing.T) {
	got, err := compileChainStep(ChainStep{Type: "highpass"})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if !strings.Contains(got, "f=30") {
		t.Fatalf("expected default freq=30; got %q", got)
	}
}

func TestCompileChainStep_Compress(t *testing.T) {
	got, err := compileChainStep(ChainStep{
		Type: "compress", Threshold: -12, Ratio: 2, Attack: 10, Release: 100, Makeup: 2,
	})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	for _, want := range []string{"acompressor=", "ratio=2", "attack=10", "release=100"} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in %q", want, got)
		}
	}
	// makeup is now dB→linear: 2 dB → 10^(2/20) ≈ 1.2589
	if !strings.Contains(got, "makeup=1.25") {
		t.Fatalf("makeup dB→linear conversion off; got %q", got)
	}
	// Threshold -12 dB → 10^(-12/20) ≈ 0.2512. Allow precision slack.
	if !strings.Contains(got, "threshold=0.25") {
		t.Fatalf("threshold dB→linear conversion off; got %q", got)
	}
}

func TestCompileChainStep_EQRequiresParam(t *testing.T) {
	_, err := compileChainStep(ChainStep{Type: "eq"})
	if err == nil {
		t.Fatalf("expected error on eq with zero tilt + presence")
	}
}

func TestCompileChainStep_EQTiltPaired(t *testing.T) {
	got, err := compileChainStep(ChainStep{Type: "eq", Tilt: -1.5})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if !strings.Contains(got, "bass=g=-1.5") || !strings.Contains(got, "treble=g=1.5") {
		t.Fatalf("expected paired bass/treble shelves with inverted gain; got %q", got)
	}
}

func TestCompileChainStep_Limiter(t *testing.T) {
	got, err := compileChainStep(ChainStep{Type: "limiter", Ceiling: -1.0})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if !strings.HasPrefix(got, "alimiter=") {
		t.Fatalf("expected alimiter= prefix; got %q", got)
	}
	// Ceiling -1 dB → 10^(-1/20) ≈ 0.8913.
	if !strings.Contains(got, "limit=0.89") {
		t.Fatalf("ceiling dB→linear conversion off; got %q", got)
	}
}

func TestCompileChainStep_StereoWiden(t *testing.T) {
	got, err := compileChainStep(ChainStep{Type: "stereoWiden", Amount: 0.2})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if !strings.HasPrefix(got, "extrastereo=") || !strings.Contains(got, "m=1.2") {
		t.Fatalf("expected extrastereo m=1+amount; got %q", got)
	}
}

func TestCompileChainStep_UnknownType(t *testing.T) {
	_, err := compileChainStep(ChainStep{Type: "invalidStep"})
	if err == nil {
		t.Fatalf("expected error on unknown step type")
	}
}

func TestPresetChain_Club(t *testing.T) {
	chain := PresetChain("club")
	if len(chain) != 5 {
		t.Fatalf("club preset should have 5 steps; got %d", len(chain))
	}
	want := []string{"highpass", "compress", "eq", "limiter", "stereoWiden"}
	for i, w := range want {
		if chain[i].Type != w {
			t.Fatalf("club[%d].Type = %q, want %q", i, chain[i].Type, w)
		}
	}
}

func TestPresetChain_Unknown(t *testing.T) {
	if chain := PresetChain("alien"); chain != nil {
		t.Fatalf("unknown preset should return nil; got %d steps", len(chain))
	}
}

func TestPresetChain_AllCanonicalOrder(t *testing.T) {
	for _, name := range []string{"club", "broadcast", "ambient", "lofi"} {
		chain := PresetChain(name)
		if !canonicalOrder(chain) {
			t.Fatalf("preset %q is not in canonical order", name)
		}
	}
}

func TestApplyMasterChain_EmptyIsCopy(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "in.wav")
	dst := filepath.Join(dir, "out.wav")
	makeSineWav(t, src, 440, 1.0)
	if err := applyMasterChain(context.Background(), "", src, dst, nil); err != nil {
		t.Fatalf("applyMasterChain (empty): %v", err)
	}
	srcBytes, _ := os.ReadFile(src)
	dstBytes, _ := os.ReadFile(dst)
	if len(dstBytes) != len(srcBytes) {
		t.Fatalf("empty chain should be byte-identical copy; got %d vs %d", len(dstBytes), len(srcBytes))
	}
}

func TestApplyMasterChain_ClubPresetRuns(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "in.wav")
	dst := filepath.Join(dir, "out.wav")
	makeSineWav(t, src, 440, 2.0)
	if err := applyMasterChain(context.Background(), "", src, dst, PresetChain("club")); err != nil {
		t.Fatalf("applyMasterChain (club): %v", err)
	}
	info, err := os.Stat(dst)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Size() < 100_000 {
		t.Fatalf("club-mastered output suspiciously small: %d bytes", info.Size())
	}
}

func TestApplyMasterChain_UnknownStepSkipped(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "in.wav")
	dst := filepath.Join(dir, "out.wav")
	makeSineWav(t, src, 440, 1.0)
	chain := []ChainStep{
		{Type: "alien"},     // unknown — should be skipped
		{Type: "highpass"},  // valid — should run
	}
	if err := applyMasterChain(context.Background(), "", src, dst, chain); err != nil {
		t.Fatalf("applyMasterChain: %v", err)
	}
	if info, _ := os.Stat(dst); info == nil || info.Size() == 0 {
		t.Fatalf("unknown step should be skipped, not fail render")
	}
}

func TestCanonicalOrder(t *testing.T) {
	canonical := []ChainStep{
		{Type: "highpass"}, {Type: "compress"}, {Type: "eq"},
		{Type: "limiter"}, {Type: "stereoWiden"},
	}
	if !canonicalOrder(canonical) {
		t.Fatalf("canonical chain should be detected as canonical")
	}
	scrambled := []ChainStep{
		{Type: "limiter"}, {Type: "highpass"}, {Type: "compress"},
	}
	if canonicalOrder(scrambled) {
		t.Fatalf("limiter-before-highpass should be detected as non-canonical")
	}
}

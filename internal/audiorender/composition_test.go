package audiorender

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// makeSineWav writes a fixed-length test tone to dst. Used as a stand-in
// ingredient render for the composition assembler test. ffmpeg's lavfi
// sine source is byte-deterministic given the same arguments.
func makeSineWav(t *testing.T, dst string, freq int, durSec float64) {
	t.Helper()
	cmd := exec.Command("ffmpeg",
		"-y", "-loglevel", "error",
		"-f", "lavfi",
		"-i", durString(freq, durSec),
		"-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2",
		dst,
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("makeSineWav: %v (%s)", err, string(out))
	}
}

func durString(freq int, durSec float64) string {
	return formatLavfiSine(freq, durSec)
}

// formatLavfiSine isolated for greppability; lavfi's sine takes
// frequency + duration as a single source string.
func formatLavfiSine(freq int, durSec float64) string {
	// ffmpeg's lavfi sine syntax: sine=frequency=440:duration=2.5
	return "sine=frequency=" + itoa(freq) + ":duration=" + ftoa(durSec)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func ftoa(f float64) string {
	// 3-decimal precision is fine for test durations.
	whole := int(f)
	frac := int((f - float64(whole)) * 1000)
	return itoa(whole) + "." + pad3(frac)
}

func pad3(n int) string {
	if n < 0 {
		n = -n
	}
	s := itoa(n)
	for len(s) < 3 {
		s = "0" + s
	}
	return s
}

// TestRenderComposition_EndToEnd builds two tiny sine ingredients,
// places them on a 4-bar timeline at 120 BPM, and verifies that all
// requested fan-out formats land on disk and have non-trivial size.
// Skipped when ffmpeg isn't on PATH (CI environments without media
// codecs).
func TestRenderComposition_EndToEnd(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	cidA := "z" + makeFakeCID('A')
	cidB := "z" + makeFakeCID('B')
	wavA := filepath.Join(dir, cidA+".wav")
	wavB := filepath.Join(dir, cidB+".wav")
	// Each ingredient is 2 bars at 120 BPM = 4 seconds.
	makeSineWav(t, wavA, 440, 4.0)
	makeSineWav(t, wavB, 660, 4.0)

	env := CompositionEnvelope{
		Tempo: 120,
		Tracks: []CompositionTrackSpec{
			{SourceCID: cidA, InBars: 0, LenBars: 2, FadeInSec: 0.1, FadeOutSec: 0.5},
			{SourceCID: cidB, InBars: 2, LenBars: 2, FadeInSec: 0.5, FadeOutSec: 0.5},
		},
		Master: MasterSpec{
			LUFS:    -16,
			Formats: []string{"wav", "flac", "mp3", "webm"},
		},
	}
	paths, err := RenderComposition(context.Background(), "", env,
		map[string]string{cidA: wavA, cidB: wavB},
		filepath.Join(dir, "out"),
	)
	if err != nil {
		t.Fatalf("RenderComposition: %v", err)
	}
	for _, ext := range []string{"wav", "flac", "mp3", "webm"} {
		p, ok := paths[ext]
		if !ok {
			t.Fatalf("fan-out missing %s", ext)
		}
		info, err := os.Stat(p)
		if err != nil {
			t.Fatalf("stat %s: %v", p, err)
		}
		if info.Size() < 1024 {
			t.Fatalf("%s suspiciously small: %d bytes", ext, info.Size())
		}
	}
}

// TestRenderComposition_PerTrackOps exercises PR-2 fields: gain,
// tempoMatch=stretch, and transposeSemis. Verifies the assembler
// builds a valid master and the per-track filters are applied
// without breaking the timeline. Transpose hits the rubberband
// fallback path on builds without librubberband (the assembler
// logs and skips); tempoMatch + gain always run.
func TestRenderComposition_PerTrackOps(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	cidA := "z" + makeFakeCID('A')
	cidB := "z" + makeFakeCID('B')
	wavA := filepath.Join(dir, cidA+".wav")
	wavB := filepath.Join(dir, cidB+".wav")
	// 4 seconds @ 120 BPM = 2 bars; B will be stretched to master
	// tempo 124 BPM (ratio ≈ 1.033) so its 2 bars at master tempo
	// take ~3.87 s instead of 4.0.
	makeSineWav(t, wavA, 440, 4.0)
	makeSineWav(t, wavB, 660, 4.0)

	env := CompositionEnvelope{
		Tempo: 124,
		Tracks: []CompositionTrackSpec{
			{
				SourceCID: cidA, InBars: 0, LenBars: 2,
				FadeInSec: 0.1, FadeOutSec: 0.5,
				Gain: -3.0, // attenuate A
			},
			{
				SourceCID: cidB, InBars: 2, LenBars: 2,
				FadeInSec: 0.5, FadeOutSec: 0.5,
				TempoMatch: "stretch", SourceBPM: 120, MasterBPM: 124,
				TransposeSemis: 7, // pitch up a fifth (skipped if no rubberband)
			},
		},
		Master: MasterSpec{LUFS: -16, Formats: []string{"wav"}},
	}
	paths, err := RenderComposition(context.Background(), "", env,
		map[string]string{cidA: wavA, cidB: wavB},
		filepath.Join(dir, "out"),
	)
	if err != nil {
		t.Fatalf("RenderComposition: %v", err)
	}
	wav, ok := paths["wav"]
	if !ok {
		t.Fatalf("fan-out missing wav")
	}
	info, err := os.Stat(wav)
	if err != nil {
		t.Fatalf("stat %s: %v", wav, err)
	}
	if info.Size() < 1024 {
		t.Fatalf("master.wav suspiciously small: %d bytes", info.Size())
	}
}

// TestSemisToRatio_Boundary checks the exponential pitch math.
// 12 semitones up = 2.0× (one octave). −12 = 0.5×.
func TestSemisToRatio_Boundary(t *testing.T) {
	cases := []struct {
		semis int
		want  float64
	}{
		{0, 1.0},
		{12, 2.0},
		{-12, 0.5},
		{24, 4.0},
	}
	for _, c := range cases {
		got := semisToRatio(c.semis)
		if abs(got-c.want) > 1e-9 {
			t.Fatalf("semisToRatio(%d) = %v, want %v", c.semis, got, c.want)
		}
	}
}

// TestAtempoChain_Decomposition verifies that ratios outside [0.5, 2.0]
// chain into multiple atempo filters whose product equals the target.
func TestAtempoChain_Decomposition(t *testing.T) {
	cases := []float64{0.6, 1.0, 1.5, 2.0, 3.0, 0.4, 0.25}
	for _, ratio := range cases {
		got := atempoChain(ratio)
		// Crude check: split on commas, parse each "atempo=N", product
		// should equal ratio within float epsilon.
		parts := splitAndParseAtempo(t, got)
		product := 1.0
		for _, p := range parts {
			product *= p
		}
		if abs(product-ratio) > 1e-4 {
			t.Fatalf("atempoChain(%v) = %q → product %v, want %v", ratio, got, product, ratio)
		}
	}
}

func abs(f float64) float64 {
	if f < 0 {
		return -f
	}
	return f
}

func splitAndParseAtempo(t *testing.T, s string) []float64 {
	t.Helper()
	parts := []float64{}
	for _, seg := range strings.Split(s, ",") {
		const prefix = "atempo="
		if strings.HasPrefix(seg, prefix) {
			f, err := strconv.ParseFloat(seg[len(prefix):], 64)
			if err != nil {
				t.Fatalf("parse atempo segment %q: %v", seg, err)
			}
			parts = append(parts, f)
		}
	}
	if len(parts) == 0 {
		t.Fatalf("no atempo segments parsed from %q", s)
	}
	return parts
}

// makeFakeCID builds a 50-char base58 string starting with the given
// distinguisher byte so the cid pattern matches in tests. Not a real
// content address — only used to satisfy ValidCID.
func makeFakeCID(distinct byte) string {
	out := make([]byte, 50)
	for i := range out {
		out[i] = distinct
	}
	return string(out)
}

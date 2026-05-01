package audiorender

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
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

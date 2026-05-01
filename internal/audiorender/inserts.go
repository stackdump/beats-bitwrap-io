package audiorender

// Generative inserts. A composition can replace `source.cid` with
// `source.generate.{type, …}`; the worker dispatches each generate
// source to RenderInsert which produces a WAV at the given duration,
// and from that point the assembler treats the result as just another
// ingredient. v1 supports `riser`; later additions slot into the
// switch in RenderInsert without changing the worker or the schema's
// outer shape.
//
// Insert renders are deterministic: same spec + same duration + same
// ffmpeg version → byte-identical WAV. The worker uses the SHA-256 of
// the canonicalised spec as a synthetic ingredient key, so two
// composition tracks asking for "riser, 4 bars, fStart=80" share a
// single rendered WAV inside the same composition.

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

// InsertSpec captures everything an insert renderer needs to produce
// a deterministic WAV. Type is the discriminator; the per-type
// numeric fields are zero-defaulted so a minimal spec like
// `{"type":"riser"}` renders with sensible defaults.
type InsertSpec struct {
	Type string `json:"type"`

	// Duration in seconds. Always set by the caller (worker reads
	// the track's len/master tempo and converts to seconds before
	// invoking RenderInsert).
	DurationSec float64 `json:"durationSec"`

	// Riser params.
	Shape  string  `json:"shape,omitempty"`  // "white-noise" | "pink-noise"
	FStart float64 `json:"fStart,omitempty"` // Hz
	FEnd   float64 `json:"fEnd,omitempty"`   // Hz
	Level  float64 `json:"level,omitempty"`  // dB
}

// RenderInsert dispatches on InsertSpec.Type and writes a WAV at dst
// (48 kHz / 16-bit / stereo, matching the assembler's working rate).
// Empty ffmpegPath uses "ffmpeg" on PATH.
func RenderInsert(ctx context.Context, ffmpegPath string, spec InsertSpec, dst string) error {
	if spec.DurationSec <= 0 {
		return errors.New("audiorender/inserts: durationSec must be > 0")
	}
	switch spec.Type {
	case "riser":
		return renderRiser(ctx, ffmpegPath, spec, dst)
	}
	return fmt.Errorf("audiorender/inserts: unknown insert type %q", spec.Type)
}

// renderRiser produces the classic build-up effect: filtered noise
// whose volume ramps from −∞ → target dB across the full duration,
// with a high-pass tilt that keeps the low rumble out of the mix.
// Pure ffmpeg — no Tone.js, no chromedp — so it's fast and the same
// bytes drop on any host with a compatible ffmpeg.
//
// Riser knobs (all optional, sensible defaults):
//   - shape  "white-noise" | "pink-noise"  (default white)
//   - fStart Hz at t=0 — set high to produce a tighter build
//   - fEnd   Hz at t=duration — irrelevant in this v1 implementation
//            (we don't do a swept filter yet); reserved for v1.1
//   - level  peak dB target at the end of the build (default -6)
//
// The fEnd param is accepted but not used by the static-filter v1.
// Adding a swept high-pass requires ffmpeg's sendcmd machinery; that
// can land in a follow-up without breaking envelope CIDs because the
// new fEnd reading-but-not-using-it doesn't change the canonical
// bytes when omitted.
func renderRiser(ctx context.Context, ffmpegPath string, spec InsertSpec, dst string) error {
	bin := ffmpegPath
	if bin == "" {
		bin = "ffmpeg"
	}
	color := "white"
	switch spec.Shape {
	case "pink-noise":
		color = "pink"
	case "", "white-noise":
		color = "white"
	default:
		return fmt.Errorf("audiorender/inserts: riser shape %q not supported (use white-noise|pink-noise)", spec.Shape)
	}
	fStart := spec.FStart
	if fStart <= 0 {
		fStart = 80
	}
	level := spec.Level
	if level >= 0 {
		level = -6
	}
	src := fmt.Sprintf("anoisesrc=color=%s:duration=%.6f:amplitude=1.0", color, spec.DurationSec)
	// afade-in over the full duration is the build. highpass at
	// fStart keeps the low end clean. volume sets the peak target.
	// aformat ensures the output stays stereo even though the noise
	// source is mono.
	filters := strings.Join([]string{
		fmt.Sprintf("afade=t=in:st=0:d=%.6f", spec.DurationSec),
		fmt.Sprintf("highpass=f=%.0f", fStart),
		fmt.Sprintf("volume=%.2fdB", level),
		"aformat=channel_layouts=stereo",
	}, ",")
	args := []string{
		"-y", "-loglevel", "error",
		"-f", "lavfi", "-i", src,
		"-af", filters,
		"-c:a", "pcm_s16le",
		"-ar", "48000",
		"-ac", "2",
		dst,
	}
	cmd := exec.CommandContext(ctx, bin, args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("ffmpeg riser: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

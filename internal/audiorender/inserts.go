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

	// Shared params across multiple insert types.
	//   - Riser:   Shape, FStart, FEnd, Level
	//   - Drone:   RootHz, Level (with built-in fifth + octave overtones)
	//   - Impact:  Variant ("sub-boom"|"low-thump"|"snare-crack"), Level
	//   - Texture: Kind ("vinyl-crackle"|"pink-bed"|"white-bed"), Level
	Shape   string  `json:"shape,omitempty"`
	FStart  float64 `json:"fStart,omitempty"`
	FEnd    float64 `json:"fEnd,omitempty"`
	Level   float64 `json:"level,omitempty"`
	RootHz  float64 `json:"rootHz,omitempty"`
	Variant string  `json:"variant,omitempty"`
	Kind    string  `json:"kind,omitempty"`

	// counterMelody params.
	Of                 string  `json:"of,omitempty"`                 // sibling track id
	Mode               string  `json:"mode,omitempty"`               // answer | harmony | shadow
	Density            float64 `json:"density,omitempty"`            // 0..1
	Register           string  `json:"register,omitempty"`           // above | below
	Seed               int64   `json:"seed,omitempty"`               // optional explicit seed
	Instrument         string  `json:"instrument,omitempty"`         // optional instrument id (PR-4.3.2 Tone.js path)
	SourceEnvelopePath string  `json:"sourceEnvelopePath,omitempty"` // worker writes the resolved source share JSON here

	// PR-4.3.2 Tone.js synth path. When BaseURL + RebuildSecret are
	// set the counterMelody renderer chromedp-spawns the local server
	// and runs synthesis through the page-side insert-render.js
	// (matching the studio's instrument timbre). Empty values fall
	// back to the ffmpeg-sine path. Worker fills these in before
	// shelling out to `beats-bitwrap-io render-insert`.
	BaseURL          string    `json:"_baseURL,omitempty"`
	RebuildSecret    string    `json:"_rebuildSecret,omitempty"`
	RendererInstance *Renderer `json:"-"`
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
	case "drone":
		return renderDrone(ctx, ffmpegPath, spec, dst)
	case "impact":
		return renderImpact(ctx, ffmpegPath, spec, dst)
	case "texture":
		return renderTexture(ctx, ffmpegPath, spec, dst)
	case "counterMelody":
		return renderCounterMelody(ctx, ffmpegPath, spec, dst)
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

// renderDrone produces a sustained pad: three sine waves at root,
// fifth (1.5×), and octave (2×) summed into a single bus, low-passed
// for warmth, with a slow attack and slow release at the tail. Useful
// under drops, intro builds, and outro fades. Pure ffmpeg — fast and
// deterministic.
//
// Knobs:
//   - rootHz  Hz of the fundamental. Default 220 (A3).
//   - level   peak dB after summing. Default -12 (drone sits *under*
//             the mix; loudnorm later catches up if needed).
func renderDrone(ctx context.Context, ffmpegPath string, spec InsertSpec, dst string) error {
	bin := ffmpegPath
	if bin == "" {
		bin = "ffmpeg"
	}
	rootHz := spec.RootHz
	if rootHz <= 0 {
		rootHz = 220.0
	}
	if rootHz < 20 || rootHz > 4000 {
		return fmt.Errorf("audiorender/inserts: drone rootHz %v out of range [20, 4000]", rootHz)
	}
	level := spec.Level
	if level >= 0 {
		level = -12
	}
	// Three sine sources for root + fifth + octave. amix(normalize=0)
	// preserves levels so the loudnorm pass can take over later.
	// Attack + release fades cover the first/last 25% of the duration
	// (capped at 2s each) so a 1-second drone doesn't fade in for the
	// full second.
	attack := spec.DurationSec * 0.25
	if attack > 2.0 {
		attack = 2.0
	}
	release := attack
	relStart := spec.DurationSec - release
	if relStart < 0 {
		relStart = 0
	}
	srcs := [][]string{
		{"-f", "lavfi", "-i", fmt.Sprintf("sine=frequency=%.4f:duration=%.6f", rootHz, spec.DurationSec)},
		{"-f", "lavfi", "-i", fmt.Sprintf("sine=frequency=%.4f:duration=%.6f", rootHz*1.5, spec.DurationSec)},
		{"-f", "lavfi", "-i", fmt.Sprintf("sine=frequency=%.4f:duration=%.6f", rootHz*2.0, spec.DurationSec)},
	}
	args := []string{"-y", "-loglevel", "error"}
	for _, s := range srcs {
		args = append(args, s...)
	}
	filterChain := fmt.Sprintf(
		"[0:a][1:a][2:a]amix=inputs=3:normalize=0,lowpass=f=2200,"+
			"afade=t=in:st=0:d=%.6f,afade=t=out:st=%.6f:d=%.6f,"+
			"volume=%.2fdB,aformat=channel_layouts=stereo[out]",
		attack, relStart, release, level,
	)
	args = append(args,
		"-filter_complex", filterChain,
		"-map", "[out]",
		"-c:a", "pcm_s16le",
		"-ar", "48000",
		"-ac", "2",
		dst,
	)
	cmd := exec.CommandContext(ctx, bin, args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("ffmpeg drone: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// renderImpact produces a short transient — kick-style sub-boom by
// default. Useful at section boundaries (drop hits) where a riser
// builds tension and the impact resolves it. Three variants:
//
//   - sub-boom    (default): sine at 60 Hz with sharp attack + slow
//                 decay across ~0.4 s; pads to durationSec with silence.
//   - low-thump   sine at 100 Hz, faster decay (~0.2 s).
//   - snare-crack white noise burst with band-pass + fast envelope.
//
// The full duration is honoured (silence padding) so the timeline
// math in the assembler stays simple.
func renderImpact(ctx context.Context, ffmpegPath string, spec InsertSpec, dst string) error {
	bin := ffmpegPath
	if bin == "" {
		bin = "ffmpeg"
	}
	level := spec.Level
	if level >= 0 {
		level = -3
	}
	variant := spec.Variant
	if variant == "" {
		variant = "sub-boom"
	}
	var src string
	var filters string
	switch variant {
	case "sub-boom":
		src = fmt.Sprintf("sine=frequency=60:duration=%.6f", spec.DurationSec)
		// 5 ms attack, decay across 0.4 s, then silence to end.
		decay := 0.4
		if decay > spec.DurationSec*0.8 {
			decay = spec.DurationSec * 0.8
		}
		filters = strings.Join([]string{
			fmt.Sprintf("afade=t=in:st=0:d=0.005"),
			fmt.Sprintf("afade=t=out:st=0.005:d=%.6f", decay),
			fmt.Sprintf("volume=%.2fdB", level),
			"aformat=channel_layouts=stereo",
		}, ",")
	case "low-thump":
		src = fmt.Sprintf("sine=frequency=100:duration=%.6f", spec.DurationSec)
		decay := 0.2
		if decay > spec.DurationSec*0.8 {
			decay = spec.DurationSec * 0.8
		}
		filters = strings.Join([]string{
			"afade=t=in:st=0:d=0.005",
			fmt.Sprintf("afade=t=out:st=0.005:d=%.6f", decay),
			fmt.Sprintf("volume=%.2fdB", level),
			"aformat=channel_layouts=stereo",
		}, ",")
	case "snare-crack":
		src = fmt.Sprintf("anoisesrc=color=white:duration=%.6f:amplitude=1.0", spec.DurationSec)
		decay := 0.15
		if decay > spec.DurationSec*0.8 {
			decay = spec.DurationSec * 0.8
		}
		filters = strings.Join([]string{
			"highpass=f=1500",
			"lowpass=f=8000",
			"afade=t=in:st=0:d=0.002",
			fmt.Sprintf("afade=t=out:st=0.002:d=%.6f", decay),
			fmt.Sprintf("volume=%.2fdB", level),
			"aformat=channel_layouts=stereo",
		}, ",")
	default:
		return fmt.Errorf("audiorender/inserts: impact variant %q not supported (use sub-boom|low-thump|snare-crack)", variant)
	}
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
		return fmt.Errorf("ffmpeg impact (%s): %w (%s)", variant, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// renderTexture produces a sustained noise bed. Sits underneath the
// mix as ambient texture (vinyl crackle, lo-fi hiss). Three kinds:
//
//   - vinyl-crackle (default): pink noise low-passed to ~3 kHz with
//                   light high-pass at 80 Hz; emulates record surface.
//   - pink-bed:     unfiltered pink noise — broader spectrum, useful
//                   under quiet sections.
//   - white-bed:    flat white noise; brightest, most "shh" character.
//
// All three render at low level by default (-30 dB) — texture is meant
// to be subliminal. Author can override via spec.level.
func renderTexture(ctx context.Context, ffmpegPath string, spec InsertSpec, dst string) error {
	bin := ffmpegPath
	if bin == "" {
		bin = "ffmpeg"
	}
	kind := spec.Kind
	if kind == "" {
		kind = "vinyl-crackle"
	}
	level := spec.Level
	if level >= 0 {
		level = -30
	}
	var src, filters string
	switch kind {
	case "vinyl-crackle":
		src = fmt.Sprintf("anoisesrc=color=pink:duration=%.6f:amplitude=1.0", spec.DurationSec)
		filters = strings.Join([]string{
			"highpass=f=80",
			"lowpass=f=3000",
			fmt.Sprintf("afade=t=in:st=0:d=0.5"),
			fmt.Sprintf("afade=t=out:st=%.6f:d=0.5", maxFloat(0, spec.DurationSec-0.5)),
			fmt.Sprintf("volume=%.2fdB", level),
			"aformat=channel_layouts=stereo",
		}, ",")
	case "pink-bed":
		src = fmt.Sprintf("anoisesrc=color=pink:duration=%.6f:amplitude=1.0", spec.DurationSec)
		filters = strings.Join([]string{
			fmt.Sprintf("afade=t=in:st=0:d=0.5"),
			fmt.Sprintf("afade=t=out:st=%.6f:d=0.5", maxFloat(0, spec.DurationSec-0.5)),
			fmt.Sprintf("volume=%.2fdB", level),
			"aformat=channel_layouts=stereo",
		}, ",")
	case "white-bed":
		src = fmt.Sprintf("anoisesrc=color=white:duration=%.6f:amplitude=1.0", spec.DurationSec)
		filters = strings.Join([]string{
			fmt.Sprintf("afade=t=in:st=0:d=0.5"),
			fmt.Sprintf("afade=t=out:st=%.6f:d=0.5", maxFloat(0, spec.DurationSec-0.5)),
			fmt.Sprintf("volume=%.2fdB", level),
			"aformat=channel_layouts=stereo",
		}, ",")
	default:
		return fmt.Errorf("audiorender/inserts: texture kind %q not supported (use vinyl-crackle|pink-bed|white-bed)", kind)
	}
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
		return fmt.Errorf("ffmpeg texture (%s): %w (%s)", kind, err, strings.TrimSpace(string(out)))
	}
	return nil
}

func maxFloat(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

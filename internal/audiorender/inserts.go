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
	"math"
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

// renderRiser produces a build-up tension effect: filtered noise
// whose high-pass cutoff sweeps from fStart Hz → fEnd Hz over the
// duration, with a quarter-sine volume curve so the build feels
// musically natural (soft start → climaxing finish). The frequency
// sweep is what makes a riser perceptually "rise" — without it the
// effect just sounds like static getting louder. Pure ffmpeg —
// no Tone.js, no chromedp — so it's fast and the same bytes drop
// on any host with a compatible ffmpeg.
//
// Riser knobs (all optional, sensible defaults):
//   - shape  "white-noise" | "pink-noise" (default white)
//   - fStart Hz at t=0 (default 200; lower = denser, higher = airier)
//   - fEnd   Hz at t=duration (default 8000; the perceived "top" of
//            the rise — sweeping to 8 kHz puts the energy in the
//            ear's most-sensitive band right before the drop)
//   - level  peak dB target at the end of the build (default -6)
//
// Sweep is implemented via ffmpeg sendcmd: 32 stepped highpass
// frequency commands, log-interpolated between fStart and fEnd.
// Logarithmic spacing matches perceptual pitch (each octave gets
// the same number of steps), avoiding the "bunched at the low end"
// feel of linear interpolation.
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
		fStart = 200
	}
	fEnd := spec.FEnd
	if fEnd <= 0 {
		fEnd = 8000
	}
	if fEnd <= fStart {
		// Sweep must rise; a flat or descending sweep wouldn't be a
		// riser. Coerce to one octave above fStart.
		fEnd = fStart * 2
	}
	level := spec.Level
	if level >= 0 {
		level = -6
	}

	// Build the sendcmd sweep table. 32 steps logarithmically
	// distributed in frequency over the full duration. Commands
	// target the highpass filter by its explicit name `@swp` —
	// without the alias asendcmd silently fails to route the
	// frequency-change commands and the cutoff stays at fStart
	// for the whole duration (riser sounds like static white
	// noise getting louder, not actually rising).
	const steps = 32
	cmds := make([]string, 0, steps+1)
	for i := 0; i <= steps; i++ {
		ratio := float64(i) / float64(steps)
		t := ratio * spec.DurationSec
		f := fStart * math.Pow(fEnd/fStart, ratio)
		cmds = append(cmds, fmt.Sprintf("%.4f @swp f %.0f", t, f))
	}
	sweepExpr := strings.Join(cmds, "; ")

	src := fmt.Sprintf("anoisesrc=color=%s:duration=%.6f:amplitude=1.0", color, spec.DurationSec)
	// Quarter-sine volume curve (curve=qsin) ramps soft → hard:
	// barely audible at the start, full level at the end. Combined
	// with the sweep, this gives the classic "tension build"
	// silhouette. afade ends slightly before the duration boundary
	// so the riser tail doesn't get trimmed by atrim downstream.
	fadeDur := spec.DurationSec * 0.95
	if fadeDur < 0.1 {
		fadeDur = spec.DurationSec
	}
	filters := strings.Join([]string{
		fmt.Sprintf("afade=t=in:st=0:d=%.6f:curve=qsin", fadeDur),
		fmt.Sprintf("asendcmd=c='%s'", sweepExpr),
		fmt.Sprintf("highpass@swp=f=%.0f", fStart),
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

// renderDrone produces a sustained pad — six detuned sawtooth voices
// (root + fifth + octave, each doubled with a slightly-sharp partner
// 2-3 cents above) summed into a single bus, low-passed at 1200 Hz
// for warmth, with a slow tremolo (0.2 Hz amplitude LFO) so the
// drone breathes instead of sitting static. v1 used three pure sine
// waves which sounded like electrical hum at low rootHz — sawtooth
// harmonics + detuning + LFO give the texture a "pad" character that
// doesn't trip listener-pattern-matching for hum.
//
// Knobs:
//   - rootHz  Hz of the fundamental. Default 110 (A2 — typical bass
//             register; previously 220, lowered so drones sit under
//             the mix without competing with vocals/leads).
//   - level   peak dB after summing. Default -14 (subliminal bed).
//
// The detune ratios (1.0017, 1.0021, 1.0029) are small primes
// chosen so the beat frequencies between paired voices don't lock
// to a regular interval — gives the slow chorus/shimmer feel of a
// classic analog pad.
func renderDrone(ctx context.Context, ffmpegPath string, spec InsertSpec, dst string) error {
	bin := ffmpegPath
	if bin == "" {
		bin = "ffmpeg"
	}
	rootHz := spec.RootHz
	if rootHz <= 0 {
		rootHz = 110.0
	}
	if rootHz < 20 || rootHz > 4000 {
		return fmt.Errorf("audiorender/inserts: drone rootHz %v out of range [20, 4000]", rootHz)
	}
	level := spec.Level
	if level >= 0 {
		level = -14
	}
	// Six voices: root + fifth + octave, each with a slightly-sharp
	// detuned partner. Six different small ratios so the beat
	// frequencies don't synchronize.
	voices := []float64{
		rootHz,
		rootHz * 1.0021,
		rootHz * 1.5,
		rootHz * 1.5 * 1.0017,
		rootHz * 2.0,
		rootHz * 2.0 * 1.0029,
	}
	attack := spec.DurationSec * 0.25
	if attack > 4.0 {
		attack = 4.0
	}
	release := attack
	relStart := spec.DurationSec - release
	if relStart < 0 {
		relStart = 0
	}
	args := []string{"-y", "-loglevel", "error"}
	for _, f := range voices {
		// Sawtooth waveform via aevalsrc: 2*(t*f - floor(t*f + 0.5))
		// produces values in [-1, +1] with a bandwidth-rich harmonic
		// series. Lowpass downstream tames the upper harmonics.
		expr := fmt.Sprintf("2*(t*%.4f - floor(t*%.4f + 0.5))", f, f)
		args = append(args, "-f", "lavfi", "-i",
			fmt.Sprintf("aevalsrc=exprs='%s':duration=%.6f:sample_rate=48000",
				expr, spec.DurationSec))
	}
	// amix preserves voice levels (normalize=0); the per-voice
	// amplitude is already 1/6 after summing, so loudnorm later
	// catches up. tremolo at 0.2 Hz with depth 0.05 = a ±0.2 dB
	// LFO swing that gives the drone breath without obvious wobble.
	inputs := make([]string, 0, len(voices))
	for i := range voices {
		inputs = append(inputs, fmt.Sprintf("[%d:a]", i))
	}
	filterChain := strings.Join(inputs, "") +
		fmt.Sprintf("amix=inputs=%d:normalize=0,", len(voices)) +
		"lowpass=f=1200," +
		"tremolo=f=0.2:d=0.05," +
		fmt.Sprintf("afade=t=in:st=0:d=%.6f,", attack) +
		fmt.Sprintf("afade=t=out:st=%.6f:d=%.6f,", relStart, release) +
		fmt.Sprintf("volume=%.2fdB,", level) +
		"aformat=channel_layouts=stereo[out]"
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

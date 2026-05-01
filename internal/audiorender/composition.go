package audiorender

// Composition assembler. Takes a parsed BeatsComposition envelope and
// the local WAV paths for each ingredient share, then emits a master
// WAV (timeline-assembled, faded, loudnormed) and the requested
// fan-out formats (.flac / .mp3 / .webm). Run by the off-host worker
// (scripts/process-composition-queue.py) once it's rendered every
// ingredient via the existing /audio/{cid}.webm path; can also be
// invoked from a server-side handler if we ever decide compositions
// should render in-process (for now they're worker-only).
//
// Design tenets:
//   - Wall-clock determinism: same envelope + same ingredient bytes →
//     bit-identical master WAV. ffmpeg's filter graph is order-stable;
//     loudnorm has a small jitter window that shows up between machines
//     but is byte-identical between runs on the same host.
//   - No tempo stretching in v1. The composition's tempo (or 120 BPM
//     default) maps bars to seconds for slicing + offset; ingredients
//     are taken at their natural rate. Tempo-match is reserved for a
//     later schema field — see plan PR #2 backlog.
//   - Fan-out is parallel-safe: every format is encoded from the SAME
//     loudnormed WAV master, so .webm and .flac differ only in lossy/
//     lossless container, never in mix.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// CompositionEnvelope is the subset of a BeatsComposition envelope the
// assembler needs. Caller (the worker) is responsible for parsing the
// JSON-LD wire format into this struct and resolving each track's
// source CID to a local WAV path before calling RenderComposition.
type CompositionEnvelope struct {
	// Tempo in BPM. <=0 falls back to defaultCompositionTempo (120 BPM).
	Tempo int
	// Tracks ordered by `in` (the assembler does not re-sort — caller
	// MUST pass them in the order they appear in the envelope).
	Tracks []CompositionTrackSpec
	// Master settings. Zero values fall back to defaults
	// (LUFS=-16, Formats=[wav,flac,mp3,webm]).
	Master MasterSpec
}

type CompositionTrackSpec struct {
	SourceCID  string
	InBars     int
	LenBars    int
	FadeInSec  float64
	FadeOutSec float64
}

type MasterSpec struct {
	LUFS    float64
	LRA     float64
	Formats []string
}

const (
	defaultCompositionTempo = 120
	defaultCompositionLUFS  = -16.0
	defaultCompositionLRA   = 11.0
	defaultTruePeakDB       = -1.0
	// 4/4 time. We don't try to infer time signatures from the
	// ingredients today; everything is treated as four beats per bar.
	beatsPerBar = 4
)

var defaultFanOutFormats = []string{"wav", "flac", "mp3", "webm"}

// RenderComposition assembles a master from the envelope + ingredient
// WAVs and writes one file per requested format under workDir. Returns
// a map of ext → absolute output path. Caller is responsible for
// uploading those paths to /audio-master/{cid}.{ext} (typically with
// X-Rebuild-Secret) and cleaning up workDir afterward.
//
// ffmpegPath defaults to "ffmpeg" on PATH when empty.
func RenderComposition(
	ctx context.Context,
	ffmpegPath string,
	env CompositionEnvelope,
	ingredientWavPaths map[string]string,
	workDir string,
) (map[string]string, error) {
	if len(env.Tracks) == 0 {
		return nil, errors.New("audiorender/composition: empty tracks")
	}
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		return nil, fmt.Errorf("audiorender/composition: mkdir workdir: %w", err)
	}
	tempo := env.Tempo
	if tempo <= 0 {
		tempo = defaultCompositionTempo
	}
	// Bars → seconds. 4/4 assumption holds for every preset genre.
	barSec := float64(beatsPerBar) * 60.0 / float64(tempo)

	// Assemble the timeline into mix.wav. We build one filter_complex
	// expression that trims/fades/delays each ingredient, then amixes
	// them down to a single stereo bus. amix(normalize=0) preserves
	// levels — loudnorm in the next step does the final ride.
	mixWav := filepath.Join(workDir, "mix.wav")
	if err := assembleTimeline(ctx, ffmpegPath, env.Tracks, ingredientWavPaths, barSec, mixWav); err != nil {
		return nil, err
	}

	// Mastering pass. Reuses internal/audiorender/loudnorm.go.
	targetLUFS := env.Master.LUFS
	if targetLUFS == 0 {
		targetLUFS = defaultCompositionLUFS
	}
	targetLRA := env.Master.LRA
	if targetLRA <= 0 {
		targetLRA = defaultCompositionLRA
	}
	masterWav := filepath.Join(workDir, "master.wav")
	if err := loudnormToWav(ctx, ffmpegPath, mixWav, masterWav, targetLUFS, defaultTruePeakDB, targetLRA); err != nil {
		return nil, fmt.Errorf("audiorender/composition: loudnorm: %w", err)
	}

	// Fan out. Always include the .wav archive itself so a caller
	// asking only for ["mp3"] still gets the lossless source if they
	// later want it; the registry of allowed formats is enforced by
	// the schema, so any unknown ext here is a programming error.
	formats := env.Master.Formats
	if len(formats) == 0 {
		formats = defaultFanOutFormats
	}
	out := map[string]string{}
	for _, ext := range formats {
		dst := filepath.Join(workDir, "master."+ext)
		switch ext {
		case "wav":
			// loudnorm already produced WAV; just rename/copy.
			if err := copyFile(masterWav, dst); err != nil {
				return nil, fmt.Errorf("audiorender/composition: copy wav: %w", err)
			}
		case "flac":
			if err := transcodeWavToFlac(ctx, ffmpegPath, masterWav, dst); err != nil {
				return nil, fmt.Errorf("audiorender/composition: flac: %w", err)
			}
		case "mp3":
			if err := transcodeWavToMp3(ctx, ffmpegPath, masterWav, dst); err != nil {
				return nil, fmt.Errorf("audiorender/composition: mp3: %w", err)
			}
		case "webm":
			if err := transcodeWavToWebm(ctx, ffmpegPath, masterWav, dst); err != nil {
				return nil, fmt.Errorf("audiorender/composition: webm: %w", err)
			}
		default:
			return nil, fmt.Errorf("audiorender/composition: unknown format %q", ext)
		}
		out[ext] = dst
	}
	return out, nil
}

// assembleTimeline runs one ffmpeg invocation that trims, fades,
// delays, and mixes every track into a single stereo WAV. The filter
// graph is built up programmatically — N tracks → N filter chains
// joined by amix.
func assembleTimeline(
	ctx context.Context,
	ffmpegPath string,
	tracks []CompositionTrackSpec,
	ingredientPaths map[string]string,
	barSec float64,
	dst string,
) error {
	args := []string{"-y", "-loglevel", "error"}
	for _, t := range tracks {
		p, ok := ingredientPaths[t.SourceCID]
		if !ok || p == "" {
			return fmt.Errorf("audiorender/composition: missing ingredient wav for %s", t.SourceCID)
		}
		args = append(args, "-i", p)
	}
	var chains []string
	var labels []string
	for i, t := range tracks {
		lenSec := float64(t.LenBars) * barSec
		// Slice + reset PTS so atrim's offset doesn't bleed into the
		// downstream filters' time math.
		chain := fmt.Sprintf("[%d:a]atrim=0:%.6f,asetpts=PTS-STARTPTS", i, lenSec)
		if t.FadeInSec > 0 {
			chain += fmt.Sprintf(",afade=t=in:st=0:d=%.6f", t.FadeInSec)
		}
		if t.FadeOutSec > 0 {
			startFade := lenSec - t.FadeOutSec
			if startFade < 0 {
				startFade = 0
			}
			chain += fmt.Sprintf(",afade=t=out:st=%.6f:d=%.6f", startFade, t.FadeOutSec)
		}
		// adelay takes ms per channel (stereo = two values, equal).
		// Even when InBars is 0 we add adelay=0|0 so every input is
		// re-timed identically — keeps the filter graph predictable.
		delayMs := int64(float64(t.InBars) * barSec * 1000.0)
		chain += fmt.Sprintf(",adelay=%d|%d", delayMs, delayMs)
		label := fmt.Sprintf("a%d", i)
		chain += fmt.Sprintf("[%s]", label)
		chains = append(chains, chain)
		labels = append(labels, "["+label+"]")
	}
	mix := strings.Join(labels, "") + fmt.Sprintf("amix=inputs=%d:duration=longest:dropout_transition=0:normalize=0[out]", len(tracks))
	filter := strings.Join(chains, ";") + ";" + mix
	args = append(args,
		"-filter_complex", filter,
		"-map", "[out]",
		"-c:a", "pcm_s16le",
		"-ar", "48000",
		"-ac", "2",
		dst,
	)
	bin := ffmpegPath
	if bin == "" {
		bin = "ffmpeg"
	}
	cmd := exec.CommandContext(ctx, bin, args...)
	if outBytes, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("ffmpeg assemble: %w (%s)", err, strings.TrimSpace(string(outBytes)))
	}
	return nil
}

// loudnormToWav runs ffmpeg's loudnorm filter against a WAV source
// and writes a WAV destination. Distinct from the package-private
// loudnorm() helper: that one is wired for the .webm Opus stream
// (96k VBR, MediaRecorder parity); the composition pipeline keeps
// the master in lossless 48 kHz / 16-bit PCM until the fan-out step
// where each format is encoded from the same source.
func loudnormToWav(ctx context.Context, ffmpegPath, src, dst string, lufs, tp, lra float64) error {
	bin := ffmpegPath
	if bin == "" {
		bin = "ffmpeg"
	}
	if tp >= 0 {
		tp = -1.0
	}
	if lra <= 0 {
		lra = 11
	}
	filter := fmt.Sprintf("loudnorm=I=%.2f:TP=%.2f:LRA=%.2f", lufs, tp, lra)
	args := []string{
		"-y", "-loglevel", "error",
		"-i", src,
		"-af", filter,
		"-c:a", "pcm_s16le",
		"-ar", "48000",
		"-ac", "2",
		dst,
	}
	cmd := exec.CommandContext(ctx, bin, args...)
	if outBytes, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("ffmpeg loudnorm: %w (%s)", err, strings.TrimSpace(string(outBytes)))
	}
	return nil
}

// transcodeWavToFlac re-encodes a WAV master as FLAC. Lossless,
// roughly 50% of WAV size for music content. Highest compression
// (level 8) is fast enough on modern hardware.
func transcodeWavToFlac(ctx context.Context, ffmpegPath, src, dst string) error {
	bin := ffmpegPath
	if bin == "" {
		bin = "ffmpeg"
	}
	args := []string{
		"-y", "-loglevel", "error",
		"-i", src,
		"-c:a", "flac",
		"-compression_level", "8",
		dst,
	}
	cmd := exec.CommandContext(ctx, bin, args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("ffmpeg flac: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// transcodeWavToMp3 re-encodes a WAV master as MP3 at 320 kbps CBR.
// Streaming-safe download tier; loud DSP services normalize so a
// CBR 320 sounds identical to lossless on most consumer playback.
func transcodeWavToMp3(ctx context.Context, ffmpegPath, src, dst string) error {
	bin := ffmpegPath
	if bin == "" {
		bin = "ffmpeg"
	}
	args := []string{
		"-y", "-loglevel", "error",
		"-i", src,
		"-c:a", "libmp3lame",
		"-b:a", "320k",
		dst,
	}
	cmd := exec.CommandContext(ctx, bin, args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("ffmpeg mp3: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// copyFile is a small helper used when fan-out includes "wav" — we
// copy the loudnormed master rather than re-encoding through ffmpeg
// (which would lose precision on the sample boundaries). No-op when
// src and dst resolve to the same file (which happens when the
// loudnorm output filename already matches the requested output).
func copyFile(src, dst string) error {
	if filepath.Clean(src) == filepath.Clean(dst) {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := out.ReadFrom(in); err != nil {
		return err
	}
	return out.Sync()
}

package audiorender

// counterMelody insert. Generates a complementary melodic line that
// "answers", harmonises, or shadows an existing track in the
// composition. The rule-based note-selection kernel lives in
// internal/generator/countermelody and is shared with the share-layer
// arrange directive (internal/generator/arrange.go::injectCounterMelody)
// so both call sites produce byte-identical notes from identical
// material.
//
// This file owns:
//   - Project resolution from a source envelope (genre+seed regen or
//     literal nets parse).
//   - WAV synthesis: either ffmpeg additive-sine (fallback) or Tone.js
//     OfflineAudioContext via chromedp (preserves studio timbre).
//   - The InsertSpec → Opts adapter (seed defaulting, mode validation).

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"

	"beats-bitwrap-io/internal/generator"
	"beats-bitwrap-io/internal/generator/countermelody"
	"beats-bitwrap-io/internal/pflow"
)

// renderCounterMelody is dispatched from RenderInsert when
// spec.Type == "counterMelody". Resolves the source envelope from
// spec.SourceEnvelopePath (worker-supplied), generates the note list
// via the countermelody kernel, and renders to WAV.
func renderCounterMelody(ctx context.Context, ffmpegPath string, spec InsertSpec, dst string) error {
	if spec.SourceEnvelopePath == "" {
		return errors.New("audiorender/inserts: counterMelody requires sourceEnvelopePath (worker writes the source share JSON to a tmp file and points the spec at it)")
	}
	if spec.DurationSec <= 0 {
		return errors.New("audiorender/inserts: counterMelody durationSec must be > 0")
	}
	mode := spec.Mode
	if mode == "" {
		mode = "answer"
	}
	switch mode {
	case "answer", "harmony", "shadow":
		// supported
	default:
		return fmt.Errorf("audiorender/inserts: counterMelody mode %q not supported (use answer | harmony | shadow)", mode)
	}

	srcBytes, err := os.ReadFile(spec.SourceEnvelopePath)
	if err != nil {
		return fmt.Errorf("audiorender/inserts: read source envelope: %w", err)
	}
	proj, err := resolveSourceProject(srcBytes)
	if err != nil {
		return fmt.Errorf("audiorender/inserts: resolve source: %w", err)
	}

	// Tempo drives ticks/sec. The source share carries its own tempo;
	// this is the right tempo for sampling its rhythm. The composition
	// asks for spec.DurationSec at the master tempo, so we walk
	// (durationSec × source_tempo / 60 × PPQ) ticks. Source tempo is
	// the project's tempo; default 120.
	sourceTempo := proj.Tempo
	if sourceTempo <= 0 {
		sourceTempo = 120
	}
	tickIntervalSec := 60.0 / (sourceTempo * float64(countermelody.PPQ))
	totalTicks := int(math.Round(spec.DurationSec / tickIntervalSec))
	if totalTicks < 4 {
		totalTicks = 4
	}

	notes := countermelody.GenerateCounterMelody(proj, countermelody.Opts{
		Mode:       mode,
		Density:    spec.Density,
		Register:   spec.Register,
		Seed:       seedForSpec(spec, srcBytes),
		TotalTicks: totalTicks,
		// SourceNetID intentionally empty: the insert renderer answers
		// the whole share, not a specific layer. spec.Of identifies a
		// sibling *composition track*, not a net within the share.
	})
	if notes == nil {
		return errors.New("audiorender/inserts: source share has no music transitions to answer")
	}
	if len(notes) == 0 {
		return renderSilentWav(ctx, ffmpegPath, spec.DurationSec, dst)
	}

	// Synthesis path. Tone.js path when authoring server is reachable;
	// ffmpeg fallback otherwise.
	if spec.BaseURL != "" && spec.RebuildSecret != "" {
		return synthesizeNotesViaTone(ctx, spec, notes, tickIntervalSec, dst)
	}
	return synthesizeNotes(ctx, ffmpegPath, notes, tickIntervalSec, spec.DurationSec, dst)
}

// seedForSpec mirrors the original newMulberry32 default-seed contract:
// explicit spec.Seed wins; otherwise fnv32a of (canonical spec bytes
// + source envelope bytes). Same composition + same source share →
// same seed; any change to either invalidates the cache.
func seedForSpec(spec InsertSpec, srcBytes []byte) uint32 {
	if spec.Seed != 0 {
		return uint32(spec.Seed)
	}
	specBytes, _ := json.Marshal(spec)
	return countermelody.SeedFromBytes(specBytes, srcBytes)
}

// synthesizeNotesViaTone POSTs the note list to the local server's
// /api/insert-notes endpoint, spawns chromedp at
// /?insert=counterMelody&notesId=…, and writes the captured WAV
// blob to dst.
func synthesizeNotesViaTone(ctx context.Context, spec InsertSpec,
	notes []countermelody.NoteEvent, tickSec float64, dst string) error {
	jsonNotes := make([]map[string]any, 0, len(notes))
	for _, n := range notes {
		jsonNotes = append(jsonNotes, map[string]any{
			"tick":          n.StartTick,
			"note":          n.Note,
			"velocity":      n.Velocity,
			"durationTicks": n.Duration,
		})
	}
	durationMs := int64(spec.DurationSec * 1000)
	tempoBpm := 60_000.0 / (tickSec * 1000.0 * float64(countermelody.PPQ))
	payload := map[string]any{
		"notes":      jsonNotes,
		"durationMs": durationMs,
		"tempo":      int(math.Round(tempoBpm)),
		"channel":    5,
		"instrument": defaultInsertInstrument(spec.Instrument),
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("audiorender/insert: marshal: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		spec.BaseURL+"/api/insert-notes", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("audiorender/insert: build req: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Rebuild-Secret", spec.RebuildSecret)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("audiorender/insert: post notes: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("audiorender/insert: post notes HTTP %d: %s",
			resp.StatusCode, strings.TrimSpace(string(respBody)))
	}
	var out struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return fmt.Errorf("audiorender/insert: parse post resp: %w", err)
	}
	if out.ID == "" {
		return errors.New("audiorender/insert: server returned empty id")
	}
	target := spec.BaseURL +
		"/?insert=counterMelody&notesId=" + url.QueryEscape(out.ID) +
		fmt.Sprintf("&durationMs=%d", durationMs)
	if spec.RendererInstance == nil {
		return errors.New("audiorender/insert: no renderer instance for chromedp dispatch")
	}
	wavBytes, err := spec.RendererInstance.CaptureURL(ctx, "insert-counterMelody", target)
	if err != nil {
		return fmt.Errorf("audiorender/insert: chromedp capture: %w", err)
	}
	if err := os.WriteFile(dst, wavBytes, 0o644); err != nil {
		return fmt.Errorf("audiorender/insert: write wav: %w", err)
	}
	return nil
}

func defaultInsertInstrument(provided string) string {
	if provided != "" {
		return provided
	}
	return "supersaw"
}

// dummy reference so base64 import doesn't get pruned by goimports.
var _ = base64.StdEncoding

// resolveSourceProject takes the source share envelope bytes and
// returns a parsed pflow.Project ready for simulation. Two paths:
//   - Envelope has explicit `nets`: parse directly.
//   - Envelope is genre+seed only: regenerate via the composer.
func resolveSourceProject(envBytes []byte) (*pflow.Project, error) {
	var raw map[string]interface{}
	if err := json.Unmarshal(envBytes, &raw); err != nil {
		return nil, fmt.Errorf("parse envelope: %w", err)
	}
	if nets, ok := raw["nets"].(map[string]interface{}); ok && len(nets) > 0 {
		return pflow.ParseProject(raw), nil
	}
	genre, _ := raw["genre"].(string)
	if genre == "" {
		return nil, errors.New("source envelope has no nets and no genre — can't simulate")
	}
	overrides := map[string]interface{}{}
	if seed, ok := raw["seed"].(float64); ok {
		overrides["seed"] = seed
	}
	if tempo, ok := raw["tempo"].(float64); ok {
		overrides["tempo"] = tempo
	}
	proj := generator.Compose(genre, overrides)
	if proj == nil {
		return nil, fmt.Errorf("composer returned nil for genre %q", genre)
	}
	return proj, nil
}

// synthesizeNotes builds an ffmpeg filter graph that creates one sine
// source per note, applies an envelope, delays each to its tick
// position, and amixes them all into a single stereo bus.
func synthesizeNotes(ctx context.Context, ffmpegPath string, notes []countermelody.NoteEvent,
	tickSec, durationSec float64, dst string) error {
	bin := ffmpegPath
	if bin == "" {
		bin = "ffmpeg"
	}
	args := []string{"-y", "-loglevel", "error"}
	chains := make([]string, 0, len(notes))
	labels := make([]string, 0, len(notes))
	for i, n := range notes {
		noteDurSec := float64(n.Duration) * tickSec
		if noteDurSec > durationSec {
			noteDurSec = durationSec
		}
		freq := 440.0 * math.Pow(2.0, float64(n.Note-69)/12.0)
		args = append(args, "-f", "lavfi", "-i",
			fmt.Sprintf("sine=frequency=%.4f:duration=%.6f", freq, noteDurSec))
		velDB := velocityToDB(n.Velocity)
		releaseSec := noteDurSec * 0.3
		if releaseSec < 0.02 {
			releaseSec = 0.02
		}
		releaseStart := noteDurSec - releaseSec
		if releaseStart < 0 {
			releaseStart = 0
		}
		startTickSec := float64(n.StartTick) * tickSec
		delayMs := int64(startTickSec * 1000.0)
		chain := fmt.Sprintf(
			"[%d:a]afade=t=in:st=0:d=0.005,afade=t=out:st=%.6f:d=%.6f,"+
				"volume=%.2fdB,adelay=%d|%d,aformat=channel_layouts=stereo[n%d]",
			i, releaseStart, releaseSec, velDB, delayMs, delayMs, i,
		)
		chains = append(chains, chain)
		labels = append(labels, fmt.Sprintf("[n%d]", i))
	}
	mix := strings.Join(labels, "") + fmt.Sprintf(
		"amix=inputs=%d:duration=longest:dropout_transition=0:normalize=0[out]",
		len(notes),
	)
	filter := strings.Join(chains, ";") + ";" + mix
	args = append(args,
		"-filter_complex", filter,
		"-map", "[out]",
		"-t", fmt.Sprintf("%.6f", durationSec),
		"-c:a", "pcm_s16le",
		"-ar", "48000",
		"-ac", "2",
		dst,
	)
	cmd := exec.CommandContext(ctx, bin, args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("ffmpeg counterMelody synth: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// velocityToDB maps MIDI velocity (0..127) to dB attenuation.
func velocityToDB(v int) float64 {
	if v <= 0 {
		return -60
	}
	if v >= 127 {
		return 0
	}
	return 20 * math.Log10(float64(v)/100.0)
}

// renderSilentWav writes a silent WAV at durationSec. Used when
// counterMelody finds nothing to answer.
func renderSilentWav(ctx context.Context, ffmpegPath string, durationSec float64, dst string) error {
	bin := ffmpegPath
	if bin == "" {
		bin = "ffmpeg"
	}
	args := []string{
		"-y", "-loglevel", "error",
		"-f", "lavfi", "-i", fmt.Sprintf("anullsrc=r=48000:cl=stereo:duration=%.6f", durationSec),
		"-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2",
		dst,
	}
	cmd := exec.CommandContext(ctx, bin, args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("ffmpeg silent: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

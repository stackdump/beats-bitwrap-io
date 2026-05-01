package audiorender

// counterMelody insert. Generates a complementary melodic line that
// "answers" an existing track in the composition by placing notes in
// the rests of its rhythm. v1 ships `mode: "answer"` only; harmony +
// shadow modes follow as PR-4.3.1+ once the plumbing is exercised in
// real compositions.
//
// Synthesis path for v1 is pure-ffmpeg additive synthesis (one sine
// source per note, amix'd into a single bus). The timbre is plainer
// than Tone.js, but the worker doesn't need chromedp for this insert
// — the rendered WAV slots straight into the composition assembler
// like any other ingredient. PR-4.3.2 swaps the synthesis path for a
// Tone.js OfflineAudioContext render via a new page-side entry point
// in public/lib/share/insert-render.js, which preserves the rest of
// the mix's timbre fidelity.
//
// Determinism: all RNG draws use mulberry32 seeded by spec.Seed (or
// fnv32 of the canonical spec when Seed is omitted). Same spec +
// same source envelope bytes → byte-identical WAV.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"sort"
	"strings"

	"beats-bitwrap-io/internal/generator"
	"beats-bitwrap-io/internal/pflow"
)

// noteEvent is one note placement in the counter-melody's bar grid.
// startTick is the source tick the note begins on; duration is in
// ticks. PPQ for music nets is 4 (mirrors sequencer-worker.js).
type noteEvent struct {
	StartTick int
	Note      int     // MIDI 0..127
	Velocity  int     // MIDI 0..127
	Duration  int     // ticks (4 = quarter note at PPQ=4)
	Frequency float64 // Hz, computed from Note for ffmpeg sine
}

const counterMelodyPPQ = 4

// renderCounterMelody is dispatched from RenderInsert when
// spec.Type == "counterMelody". Resolves the source envelope from
// spec.SourceEnvelopePath (worker-supplied), simulates the source
// net to extract its rhythm + pitch material, generates an answering
// note sequence in the requested mode, and renders to WAV.
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
	tickIntervalSec := 60.0 / (sourceTempo * counterMelodyPPQ)
	totalTicks := int(math.Round(spec.DurationSec / tickIntervalSec))
	if totalTicks < 4 {
		totalTicks = 4
	}

	// Pick the source net. spec.Of names the sibling track id, but
	// the spec resolved by the worker also stores the sibling's
	// source CID — for now we walk EVERY music net in the source
	// project, since spec.Of identifies a composition track, not a
	// net within the share. Walking all music nets gives us the full
	// rhythm + pitch picture, which is the right input for an answer
	// line that complements the entire share, not one of its layers.
	hits, pitchSet, sourceNotes := simulateMusicNotes(proj, totalTicks)
	if len(pitchSet) == 0 {
		return errors.New("audiorender/inserts: source share has no music transitions to answer")
	}

	// Mode dispatch.
	rng := newMulberry32(spec.Seed, srcBytes, spec)
	register := spec.Register
	if register == "" {
		register = "above"
	}
	density := spec.Density
	if density <= 0 {
		density = 0.5
	}
	if density > 1 {
		density = 1
	}
	var notes []noteEvent
	switch mode {
	case "answer":
		notes = answerMode(hits, pitchSet, register, density, rng)
	case "harmony":
		notes = harmonyMode(sourceNotes, register, density, rng)
	case "shadow":
		notes = shadowMode(sourceNotes, totalTicks, register, density, rng)
	}
	if len(notes) == 0 {
		// Even with no rest opportunities, render a silent WAV at the
		// requested duration so the assembler's amix has something to
		// chew on. anoisesrc at -inf level via aevalsrc=0 handles
		// this — but a single zero-velocity note is simpler.
		return renderSilentWav(ctx, ffmpegPath, spec.DurationSec, dst)
	}

	// Compute Hz for each note. MIDI → Hz: 440 × 2^((n-69)/12).
	for i := range notes {
		notes[i].Frequency = 440.0 * math.Pow(2.0, float64(notes[i].Note-69)/12.0)
	}

	// Synthesis path. Two options:
	//
	// 1. Tone.js OfflineAudioContext (PR-4.3.2). Preserves the
	//    timbre of the studio's instruments — a counter-melody on
	//    `supersaw` actually sounds like supersaw rather than a
	//    plain sine. Requires a running BaseURL (a local authoring
	//    server with /api/insert-notes + /lib/share/insert-render.js
	//    + chromedp). The worker passes BaseURL via a "_baseURL"
	//    field on the spec.
	//
	// 2. ffmpeg additive sine (fallback). Pure DSP, no chromedp,
	//    no external deps. Audibly plain but unambiguously a melody.
	//
	// Path selection: Tone.js when spec._baseURL + spec._chromePath
	// + spec._rebuildSecret are all set; otherwise the ffmpeg path.
	if spec.BaseURL != "" && spec.RebuildSecret != "" {
		return synthesizeNotesViaTone(ctx, spec, notes, tickIntervalSec, dst)
	}
	return synthesizeNotes(ctx, ffmpegPath, notes, tickIntervalSec, spec.DurationSec, dst)
}

// synthesizeNotesViaTone POSTs the note list to the local server's
// /api/insert-notes endpoint, spawns chromedp at
// /?insert=counterMelody&notesId=…, and writes the captured WAV
// blob to dst. Mirrors the share-render chromedp path but with a
// different page-side module (insert-render.js).
func synthesizeNotesViaTone(ctx context.Context, spec InsertSpec,
	notes []noteEvent, tickSec float64, dst string) error {
	// Build the JSON payload the page-side module fetches.
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
	tempoBpm := 60_000.0 / (tickSec * 1000.0 * float64(counterMelodyPPQ))
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
	// page-side returns base64-encoded WAV bytes via window.__renderBlob;
	// CaptureURL has already done base64.StdEncoding.DecodeString. So
	// wavBytes is the raw RIFF/WAV bytes — write straight to dst.
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

// dummy reference so base64 import doesn't get pruned by goimports
// when the function later adds a code path that needs it.
var _ = base64.StdEncoding

// resolveSourceProject takes the source share envelope bytes and
// returns a parsed pflow.Project ready for simulation. Two paths:
//   - Envelope has explicit `nets`: parse directly.
//   - Envelope is genre+seed only: regenerate via the composer.
// Either way the resulting Project is byte-deterministic across runs.
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

// sourceNote captures one MIDI firing collected during source
// simulation. Used by harmony and shadow modes which transform
// individual source notes rather than placing into rests.
type sourceNote struct {
	Tick     int
	Note     int
	Velocity int
}

// simulateMusicNotes walks every music net in proj for totalTicks
// ticks, returning:
//   - hits:        per-tick boolean, true when any music net fired a
//                  transition with a MIDI binding;
//   - pitchSet:    sorted unique MIDI notes observed across all hits
//                  (used by answer mode for pitch material);
//   - sourceNotes: ordered list of every MIDI firing with its tick,
//                  used by harmony / shadow modes that transform the
//                  source line directly.
func simulateMusicNotes(proj *pflow.Project, totalTicks int) ([]bool, []int, []sourceNote) {
	hits := make([]bool, totalTicks)
	pitchSet := map[int]struct{}{}
	var notes []sourceNote
	// Sort net IDs for stable iteration.
	netIDs := make([]string, 0, len(proj.Nets))
	for id := range proj.Nets {
		netIDs = append(netIDs, id)
	}
	sort.Strings(netIDs)
	for _, id := range netIDs {
		nb := proj.Nets[id]
		if nb == nil {
			continue
		}
		// Walk just music nets; control nets fire actions, not notes.
		// nb.Track.Group of "" is treated as music (legacy fallback).
		nb.ResetState()
		// Sort transition labels for determinism; pick the FIRST
		// enabled transition each tick (mirrors the sequencer's
		// conflict resolution that picks deterministically by
		// transition order in the parsed net).
		transLabels := make([]string, 0, len(nb.Bindings))
		for label := range nb.Bindings {
			transLabels = append(transLabels, label)
		}
		sort.Strings(transLabels)
		for tick := 0; tick < totalTicks; tick++ {
			fired := false
			for _, label := range transLabels {
				if !nb.IsEnabled(label) {
					continue
				}
				res := nb.Fire(label)
				fired = true
				if res != nil && res.Midi != nil && res.Midi.Note > 0 {
					hits[tick] = true
					pitchSet[res.Midi.Note] = struct{}{}
					vel := res.Midi.Velocity
					if vel <= 0 {
						vel = 90
					}
					notes = append(notes, sourceNote{
						Tick: tick, Note: res.Midi.Note, Velocity: vel,
					})
				}
				break
			}
			if !fired {
				// Net is stuck (no enabled transition). Reset to
				// initial marking so a long simulation doesn't dead-end.
				nb.ResetState()
			}
		}
	}
	out := make([]int, 0, len(pitchSet))
	for n := range pitchSet {
		out = append(out, n)
	}
	sort.Ints(out)
	return hits, out, notes
}

// harmonyMode emits a parallel-motion line: every source note
// becomes srcNote ± interval. Density acts as a thinning gate
// (1 − density of source notes are dropped, deterministically via
// RNG). register chooses the major-3rd above (+4) or minor-3rd below
// (−3) — both common, both broadly consonant, no key inference
// required (chromatic). Result clamps to MIDI range, octave-shifting
// if the interval pushes the harmony out of bounds.
func harmonyMode(src []sourceNote, register string, density float64, rng *mulberry32) []noteEvent {
	interval := 4 // major 3rd above
	if register == "below" {
		interval = -3 // minor 3rd below
	}
	var out []noteEvent
	for _, n := range src {
		if rng.float64() > density {
			continue
		}
		pitch := n.Note + interval
		for pitch < 24 {
			pitch += 12
		}
		for pitch > 108 {
			pitch -= 12
		}
		// Same-tick + short duration so the harmony reads as a
		// chord rather than a delayed line. 4 ticks ≈ 1 quarter
		// note at PPQ=4.
		out = append(out, noteEvent{
			StartTick: n.Tick,
			Note:      pitch,
			Velocity:  n.Velocity,
			Duration:  4,
		})
	}
	return out
}

// shadowMode emits sparse 16th-late echoes of the source line. Each
// source note has probability density of triggering an echo on the
// next tick (1/16 note at PPQ=4) at half velocity, transposed by
// register. Subliminal dub-flavoured layer; useful at low density to
// thicken without obscuring.
func shadowMode(src []sourceNote, totalTicks int, register string, density float64, rng *mulberry32) []noteEvent {
	transpose := 12
	if register == "below" {
		transpose = -12
	}
	var out []noteEvent
	for _, n := range src {
		if rng.float64() > density {
			continue
		}
		echoTick := n.Tick + 1
		if echoTick >= totalTicks {
			continue
		}
		pitch := n.Note + transpose
		for pitch < 24 {
			pitch += 12
		}
		for pitch > 108 {
			pitch -= 12
		}
		velocity := n.Velocity / 2
		if velocity < 30 {
			velocity = 30
		}
		out = append(out, noteEvent{
			StartTick: echoTick,
			Note:      pitch,
			Velocity:  velocity,
			Duration:  3,
		})
	}
	return out
}

// answerMode finds rest runs in the source's rhythm and places
// complementary notes there. Density controls how many runs get
// filled and where in the run the note lands. Pitch is sampled from
// the source's pitch set, transposed ±12 semitones based on register.
func answerMode(hits []bool, pitchSet []int, register string, density float64, rng *mulberry32) []noteEvent {
	transpose := 12
	if register == "below" {
		transpose = -12
	}
	var notes []noteEvent
	totalTicks := len(hits)
	t := 0
	for t < totalTicks {
		if hits[t] {
			t++
			continue
		}
		// Find rest run.
		runStart := t
		for t < totalTicks && !hits[t] {
			t++
		}
		runLen := t - runStart
		if runLen < 2 {
			continue
		}
		// Density gate: a fraction of qualifying runs get a note.
		// Using the RNG so the same (seed, hits) pair places notes at
		// the same indices across runs.
		if rng.float64() > density {
			continue
		}
		basePitch := pitchSet[rng.intn(len(pitchSet))] + transpose
		// Clamp into MIDI range, octave-shifting if needed.
		for basePitch < 24 {
			basePitch += 12
		}
		for basePitch > 108 {
			basePitch -= 12
		}
		// Place at the *middle* of the run so it doesn't crowd the
		// next source hit and has room to breathe before the
		// preceding hit's tail decays.
		startTick := runStart + runLen/2
		// Note duration: half the run, capped at 8 ticks (~1/2 bar
		// at PPQ=4) so long rests don't produce held drones.
		dur := runLen / 2
		if dur > 8 {
			dur = 8
		}
		if dur < 1 {
			dur = 1
		}
		notes = append(notes, noteEvent{
			StartTick: startTick,
			Note:      basePitch,
			Velocity:  90,
			Duration:  dur,
		})
	}
	return notes
}

// synthesizeNotes builds an ffmpeg filter graph that creates one sine
// source per note, applies an envelope (afade in/out), delays each
// to its tick position, and amixes them all into a single stereo bus
// at durationSec total. Pure ffmpeg, no chromedp. The synthesis is
// deliberately plain (sine + simple envelope) — PR-4.3.2 swaps this
// for a Tone.js offline render to recover timbre fidelity.
func synthesizeNotes(ctx context.Context, ffmpegPath string, notes []noteEvent,
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
		// Cap the per-note source length so a long-tail note past
		// the composition's durationSec doesn't extend the timeline.
		if noteDurSec > durationSec {
			noteDurSec = durationSec
		}
		args = append(args, "-f", "lavfi", "-i",
			fmt.Sprintf("sine=frequency=%.4f:duration=%.6f", n.Frequency, noteDurSec))
		// Envelope: 5 ms attack, sustain at velocity-scaled level,
		// release covers the last 30% of the note. aformat ensures
		// stereo for amix.
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

// velocityToDB maps MIDI velocity (0..127) to dB attenuation. Velocity
// 100 → 0 dB (full). Each 6 dB step halves perceived loudness; 127
// caps at +0.5 dB so the brightest notes don't clip the bus.
func velocityToDB(v int) float64 {
	if v <= 0 {
		return -60
	}
	if v >= 127 {
		return 0
	}
	// 100 → 0 dB; 50 → ≈ -6 dB; 1 → -40 dB.
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

// mulberry32 mirrors public/lib/generator/core.js::mulberry32 — the
// JS PRNG used everywhere a seed needs to determine output. Same seed
// → same sequence of float64 / int values across Go and JS.
type mulberry32 struct {
	state uint32
}

func newMulberry32(explicitSeed int64, srcBytes []byte, spec InsertSpec) *mulberry32 {
	if explicitSeed != 0 {
		return &mulberry32{state: uint32(explicitSeed)}
	}
	// Default seed: fnv32 of (canonical spec bytes + source share
	// envelope bytes). Same composition + same source share → same
	// seed; any change to either invalidates the cache.
	h := fnv.New32a()
	specBytes, _ := json.Marshal(spec)
	h.Write(specBytes)
	h.Write(srcBytes)
	return &mulberry32{state: h.Sum32()}
}

func (m *mulberry32) next() uint32 {
	m.state += 0x6D2B79F5
	t := m.state
	t = (t ^ (t >> 15)) * (1 | t)
	t = t + ((t ^ (t >> 7)) * (61 | t)) ^ t
	return (t ^ (t >> 14))
}

func (m *mulberry32) float64() float64 {
	return float64(m.next()) / 4294967296.0
}

func (m *mulberry32) intn(n int) int {
	if n <= 0 {
		return 0
	}
	return int(m.next()) % n
}

package main

// CLI subcommand: `beats-bitwrap-io render-composition`. Wraps
// internal/audiorender.RenderComposition so the off-host worker
// (scripts/process-composition-queue.py) can invoke the Go assembler
// directly — keeps the ffmpeg filter graph in one place and avoids
// drift between a Go pipeline and a Python re-implementation.
//
// Usage:
//   beats-bitwrap-io render-composition \
//       --envelope env.json \
//       --ingredients ingest.json \
//       --out /tmp/out [--ffmpeg /usr/bin/ffmpeg]
//
// envelope.json   = the BeatsComposition envelope (raw JSON-LD).
// ingredients.json = {"<sourceCID>": "/abs/path/to/ingredient.wav", …}
// out (dir)        = working directory; the assembler writes
//                    master.<ext> for every requested format here.
//
// Prints a single line of JSON to stdout: {"paths": {"wav":"...", "flac":"...", ...}}.

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"beats-bitwrap-io/internal/audiorender"
)

// decodeMasterChain parses the envelope's `master.chain` array — a
// tagged-union of step types — into a slice of audiorender.ChainStep.
// Sniffs each entry's `type` field and reads only the params that
// step cares about. Unknown types are accepted at the JSON layer
// (the chain compiler will skip them at render time with a logged
// warning, matching the rubberband-fallback pattern).
func decodeMasterChain(raw []json.RawMessage) ([]audiorender.ChainStep, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	out := make([]audiorender.ChainStep, 0, len(raw))
	for i, entry := range raw {
		var head struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(entry, &head); err != nil {
			return nil, fmt.Errorf("chain[%d]: %w", i, err)
		}
		var step audiorender.ChainStep
		step.Type = head.Type
		switch head.Type {
		case "highpass", "lowpass":
			var p struct {
				Freq float64 `json:"freq"`
			}
			_ = json.Unmarshal(entry, &p)
			step.Freq = p.Freq
		case "compress":
			var p struct {
				Threshold float64 `json:"threshold"`
				Ratio     float64 `json:"ratio"`
				Attack    float64 `json:"attack"`
				Release   float64 `json:"release"`
				Makeup    float64 `json:"makeup"`
			}
			_ = json.Unmarshal(entry, &p)
			step.Threshold, step.Ratio = p.Threshold, p.Ratio
			step.Attack, step.Release, step.Makeup = p.Attack, p.Release, p.Makeup
		case "eq":
			var p struct {
				Tilt     float64 `json:"tilt"`
				Presence float64 `json:"presence"`
			}
			_ = json.Unmarshal(entry, &p)
			step.Tilt, step.Presence = p.Tilt, p.Presence
		case "limiter":
			var p struct {
				Ceiling float64 `json:"ceiling"`
			}
			_ = json.Unmarshal(entry, &p)
			step.Ceiling = p.Ceiling
		case "stereoWiden":
			var p struct {
				Amount float64 `json:"amount"`
			}
			_ = json.Unmarshal(entry, &p)
			step.Amount = p.Amount
		}
		out = append(out, step)
	}
	return out, nil
}

func runRenderCompositionCLI(args []string) int {
	fs := flag.NewFlagSet("render-composition", flag.ExitOnError)
	envelopePath := fs.String("envelope", "", "path to BeatsComposition envelope JSON")
	ingredientsPath := fs.String("ingredients", "", "path to JSON map of sourceCID → ingredient WAV path")
	outDir := fs.String("out", "", "working/output directory (created if absent)")
	ffmpegPath := fs.String("ffmpeg", "", "ffmpeg binary path (default: ffmpeg on PATH)")
	_ = fs.Parse(args)

	if *envelopePath == "" || *ingredientsPath == "" || *outDir == "" {
		fmt.Fprintln(os.Stderr, "render-composition: --envelope, --ingredients, --out required")
		return 2
	}

	envBytes, err := os.ReadFile(*envelopePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "read envelope: %v\n", err)
		return 1
	}
	var raw struct {
		Tempo  int `json:"tempo"`
		Tracks []struct {
			ID     string `json:"id"`
			Source struct {
				CID string `json:"cid"`
			} `json:"source"`
			In        int     `json:"in"`
			Len       int     `json:"len"`
			SrcOffset int     `json:"srcOffset"`
			FadeIn    float64 `json:"fadeIn"`
			FadeOut   float64 `json:"fadeOut"`
			// PR-2 per-track ops. SoloRoles + Mute are passed
			// through to the ingredient render and don't affect
			// the assembler chain. Transpose / TempoMatch / Gain
			// drive ffmpeg filters in assembleTimeline.
			SoloRoles      []string `json:"soloRoles"`
			Mute           []string `json:"mute"`
			TransposeSemis int      `json:"transposeSemis"`
			TempoMatch     string   `json:"tempoMatch"`
			Gain           float64  `json:"gain"`
			// Worker passes the ingredient share's tempo here so
			// the assembler can compute the stretch ratio without
			// re-fetching the ingredient envelope.
			SourceBPM int `json:"sourceBpm"`
		} `json:"tracks"`
		Master struct {
			LUFS    float64           `json:"lufs"`
			LRA     float64           `json:"lra"`
			Format  []string          `json:"format"`
			Preset  string            `json:"preset"`
			Chain   []json.RawMessage `json:"chain"`
		} `json:"master"`
	}
	if err := json.Unmarshal(envBytes, &raw); err != nil {
		fmt.Fprintf(os.Stderr, "parse envelope: %v\n", err)
		return 1
	}

	ingredientsBytes, err := os.ReadFile(*ingredientsPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "read ingredients: %v\n", err)
		return 1
	}
	var ingredients map[string]string
	if err := json.Unmarshal(ingredientsBytes, &ingredients); err != nil {
		fmt.Fprintf(os.Stderr, "parse ingredients: %v\n", err)
		return 1
	}

	chain, err := decodeMasterChain(raw.Master.Chain)
	if err != nil {
		fmt.Fprintf(os.Stderr, "parse master.chain: %v\n", err)
		return 1
	}
	env := audiorender.CompositionEnvelope{
		Tempo: raw.Tempo,
		Master: audiorender.MasterSpec{
			LUFS:    raw.Master.LUFS,
			LRA:     raw.Master.LRA,
			Formats: raw.Master.Format,
			Preset:  raw.Master.Preset,
			Chain:   chain,
		},
	}
	for _, t := range raw.Tracks {
		env.Tracks = append(env.Tracks, audiorender.CompositionTrackSpec{
			SourceCID:      t.Source.CID,
			InBars:         t.In,
			LenBars:        t.Len,
			SrcOffsetBars:  t.SrcOffset,
			FadeInSec:      t.FadeIn,
			FadeOutSec:     t.FadeOut,
			SoloRoles:      t.SoloRoles,
			Mute:           t.Mute,
			TransposeSemis: t.TransposeSemis,
			TempoMatch:     t.TempoMatch,
			Gain:           t.Gain,
			SourceBPM:      t.SourceBPM,
			MasterBPM:      raw.Tempo,
		})
	}

	paths, err := audiorender.RenderComposition(context.Background(), *ffmpegPath, env, ingredients, *outDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "render: %v\n", err)
		return 1
	}
	out := map[string]any{"paths": paths}
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(out); err != nil {
		return 1
	}
	return 0
}

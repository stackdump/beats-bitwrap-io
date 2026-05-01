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
			Source struct {
				CID string `json:"cid"`
			} `json:"source"`
			In      int     `json:"in"`
			Len     int     `json:"len"`
			FadeIn  float64 `json:"fadeIn"`
			FadeOut float64 `json:"fadeOut"`
		} `json:"tracks"`
		Master struct {
			LUFS    float64  `json:"lufs"`
			Format  []string `json:"format"`
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

	env := audiorender.CompositionEnvelope{
		Tempo: raw.Tempo,
		Master: audiorender.MasterSpec{
			LUFS:    raw.Master.LUFS,
			Formats: raw.Master.Format,
		},
	}
	for _, t := range raw.Tracks {
		env.Tracks = append(env.Tracks, audiorender.CompositionTrackSpec{
			SourceCID:  t.Source.CID,
			InBars:     t.In,
			LenBars:    t.Len,
			FadeInSec:  t.FadeIn,
			FadeOutSec: t.FadeOut,
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

package main

// CLI subcommand: `beats-bitwrap-io render-insert`. Wraps
// internal/audiorender.RenderInsert so the off-host worker can
// produce generative inserts (riser, etc.) without re-implementing
// the DSP in Python — same single-source-of-truth pattern as
// render-composition.
//
// Usage:
//   beats-bitwrap-io render-insert \
//       --spec spec.json \
//       --out  /path/to/insert.wav [--ffmpeg /usr/bin/ffmpeg]
//
// spec.json mirrors the `generate` object in a BeatsComposition
// envelope, with one extra field — durationSec — that the worker
// derives from the track's len + the composition's tempo:
//
//   { "type": "riser", "durationSec": 4.0, "fStart": 80 }
//
// Prints {"path": "..."} to stdout on success; non-zero exit + stderr
// on failure.

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"beats-bitwrap-io/internal/audiorender"
)

func runRenderInsertCLI(args []string) int {
	fs := flag.NewFlagSet("render-insert", flag.ExitOnError)
	specPath := fs.String("spec", "", "path to insert spec JSON (with type+durationSec)")
	outPath := fs.String("out", "", "destination WAV path")
	ffmpegPath := fs.String("ffmpeg", "", "ffmpeg binary path (default: ffmpeg on PATH)")
	_ = fs.Parse(args)

	if *specPath == "" || *outPath == "" {
		fmt.Fprintln(os.Stderr, "render-insert: --spec and --out required")
		return 2
	}
	body, err := os.ReadFile(*specPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "read spec: %v\n", err)
		return 1
	}
	var spec audiorender.InsertSpec
	if err := json.Unmarshal(body, &spec); err != nil {
		fmt.Fprintf(os.Stderr, "parse spec: %v\n", err)
		return 1
	}
	// counterMelody with a configured base URL + rebuild secret =
	// Tone.js synthesis path. We need a Renderer instance for the
	// chromedp orchestration (CaptureURL). For other insert types
	// (riser/drone/impact/texture) the Renderer is unused.
	if spec.Type == "counterMelody" && spec.BaseURL != "" && spec.RebuildSecret != "" {
		ar, err := audiorender.New(audiorender.Config{
			CacheDir:      os.TempDir(),
			BaseURL:       spec.BaseURL,
			MaxConcurrent: 1,
			RenderMode:    "offline",
		})
		if err != nil {
			fmt.Fprintf(os.Stderr, "renderer init: %v\n", err)
			return 1
		}
		spec.RendererInstance = ar
	}
	if err := audiorender.RenderInsert(context.Background(), *ffmpegPath, spec, *outPath); err != nil {
		fmt.Fprintf(os.Stderr, "render-insert: %v\n", err)
		return 1
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(map[string]any{"path": *outPath}); err != nil {
		return 1
	}
	return 0
}

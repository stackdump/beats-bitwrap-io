package main

import (
	"bytes"
	"fmt"
	"image/png"
	"sync"
	"testing"
)

func TestRenderShareCardPNG(t *testing.T) {
	root := 45
	p := sharePayload{
		Type: "BeatsShare", V: 1,
		Genre: "techno", Seed: 42,
		Tempo: 128, Swing: 15, Humanize: 10,
		RootNote: &root, ScaleName: "Minor", Bars: 60,
	}
	cases := []struct {
		name, title, qr string
	}{
		{"plain", "", ""},
		{"title", "Friday Night Drop", ""},
		{"title+qr", "Friday Night Drop", "https://beats.bitwrap.io/?cid=zTest&title=Friday%20Night%20Drop"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body, err := renderShareCardPNG(p, tc.title, tc.qr)
			if err != nil {
				t.Fatalf("render: %v", err)
			}
			if len(body) < 1000 {
				t.Fatalf("png looks empty: %d bytes", len(body))
			}
			img, err := png.Decode(bytes.NewReader(body))
			if err != nil {
				t.Fatalf("png decode: %v", err)
			}
			if img.Bounds().Dx() != 1200 || img.Bounds().Dy() != 630 {
				t.Fatalf("size: got %dx%d, want 1200x630",
					img.Bounds().Dx(), img.Bounds().Dy())
			}
		})
	}
}

// Reproduces the sfnt glyph-buffer race that crashed prod on
// 2026-04-20 when two share-card requests rendered concurrently.
// Before the fontsOnce fix, this panics with
// "index out of range [3] with length 0" inside sfnt.LoadGlyph.
func TestRenderShareCardPNGConcurrent(t *testing.T) {
	p := sharePayload{
		Type: "BeatsShare", V: 1,
		Genre: "techno", Seed: 42,
		Tempo: 128, Swing: 15, Humanize: 10,
	}
	const N = 16
	var wg sync.WaitGroup
	errs := make(chan error, N)
	for range N {
		wg.Add(1)
		go func() {
			defer wg.Done()
			body, err := renderShareCardPNG(p, "Friday Night Drop",
				"https://beats.bitwrap.io/?cid=zTest")
			if err != nil {
				errs <- err
				return
			}
			if len(body) < 1000 {
				errs <- fmt.Errorf("png too short: %d bytes", len(body))
				return
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent render: %v", err)
		}
	}
}

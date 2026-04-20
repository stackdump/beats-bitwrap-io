package main

import (
	"bytes"
	"image/png"
	"testing"
)

func TestRenderShareCardPNG(t *testing.T) {
	p := sharePayload{
		Type: "BeatsShare", V: 1,
		Genre: "techno", Seed: 42,
		Tempo: 128, Swing: 15, Humanize: 10,
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

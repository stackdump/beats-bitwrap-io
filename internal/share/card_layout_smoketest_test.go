package share

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// TestCardLayoutSmokeWriteSVG renders one sample SVG per layout for
// visual review. Run with `go test -run CardLayoutSmoke -v` and open
// the files under /tmp/beats-card-samples/. Skipped by default unless
// BEATS_CARD_SAMPLES=1 is set so CI doesn't litter the runner.
func TestCardLayoutSmokeWriteSVG(t *testing.T) {
	if os.Getenv("BEATS_CARD_SAMPLES") == "" {
		t.Skip("set BEATS_CARD_SAMPLES=1 to write sample SVGs")
	}
	dir := "/tmp/beats-card-samples"
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		genre string
		seeds []int64
	}{
		{"techno", []int64{641000, 641001, 641002}},
		{"trance", []int64{637000, 637001}},
		{"metal", []int64{531000, 531001}},
		{"trap", []int64{439000, 439001}},
		{"ambient", []int64{736000, 736001}},
		{"jazz", []int64{447000, 447001}},
	}
	for _, c := range cases {
		for _, s := range c.seeds {
			art := cardArtForSeed(c.genre, s)
			t.Logf("%s seed=%d glyphs=%d rings=%d polylines=%d",
				c.genre, s, len(art.Glyphs), len(art.Rings), len(art.Polylines))
			// Render a minimal standalone SVG to inspect.
			svg := renderTestSVG(art, colorForGenre(c.genre), c.genre, s)
			path := filepath.Join(dir, fmt.Sprintf("%s_%d.svg", c.genre, s))
			if err := os.WriteFile(path, []byte(svg), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func renderTestSVG(art cardArt, color, genre string, seed int64) string {
	var s string
	s += `<?xml version="1.0" encoding="UTF-8"?>` + "\n"
	s += `<svg xmlns="http://www.w3.org/2000/svg" viewBox="700 50 600 530" width="600" height="530" style="background:#0d0d0d">` + "\n"
	s += `<text x="720" y="80" fill="` + color + `" font-family="system-ui" font-size="22" font-weight="700">` + genre + ` ` + fmt.Sprintf("%d", seed) + `</text>` + "\n"
	for _, ring := range art.Rings {
		s += fmt.Sprintf(`<circle cx="%.1f" cy="%.1f" r="%.1f" fill="none" stroke="%s" stroke-width="2" opacity="0.4"/>`+"\n",
			ring.Cx, ring.Cy, ring.R, color)
	}
	for _, pl := range art.Polylines {
		s += `<polyline fill="none" stroke="` + color + `" stroke-width="2" opacity="0.55" points="`
		for _, p := range pl.Pts {
			s += fmt.Sprintf("%.1f,%.1f ", p.X, p.Y)
		}
		if pl.Closed && len(pl.Pts) > 0 {
			s += fmt.Sprintf("%.1f,%.1f", pl.Pts[0].X, pl.Pts[0].Y)
		}
		s += `"/>` + "\n"
	}
	for _, g := range art.Glyphs {
		if g.Square {
			if g.Filled {
				s += fmt.Sprintf(`<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="%s"/>`+"\n",
					g.X-g.R, g.Y-g.R, 2*g.R, 2*g.R, color)
			} else {
				s += fmt.Sprintf(`<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="none" stroke="%s" stroke-width="2" opacity="0.5"/>`+"\n",
					g.X-g.R, g.Y-g.R, 2*g.R, 2*g.R, color)
			}
		} else {
			if g.Filled {
				s += fmt.Sprintf(`<circle cx="%.1f" cy="%.1f" r="%.1f" fill="%s"/>`+"\n",
					g.X, g.Y, g.R, color)
			} else {
				s += fmt.Sprintf(`<circle cx="%.1f" cy="%.1f" r="%.1f" fill="none" stroke="%s" stroke-width="2" opacity="0.5"/>`+"\n",
					g.X, g.Y, g.R, color)
			}
		}
	}
	s += `</svg>` + "\n"
	return s
}


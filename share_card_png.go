package main

// PNG share-card renderer. The SVG version (handleShareCard in
// share_page.go) renders beautifully for platforms that accept
// vector (Slack, Discord, iMessage) but Twitter/X, Mastodon,
// Bluesky, and most newsreader unfurlers silently drop SVG
// og:images. This file produces a rasterised PNG twin of the same
// layout so those platforms get a real preview. Both sources draw
// from the same stored payload — same seed picks the same ring,
// same QR target — so the two versions agree byte-for-byte on
// content even though the pixels differ.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"

	"github.com/fogleman/gg"
	"golang.org/x/image/font"
	"golang.org/x/image/font/gofont/gobold"
	"golang.org/x/image/font/gofont/goregular"
	"golang.org/x/image/font/opentype"

	qrcode "github.com/skip2/go-qrcode"
)

// Parsed OpenType fonts are safe to share across goroutines; the
// per-face glyph buffer inside sfnt is not. So we parse each TTF
// exactly once and hand out a *fresh* opentype.Face per loadFace
// call — each render gets its own glyph buffer and there's no race.
var (
	regularFont     *opentype.Font
	boldFont        *opentype.Font
	fontsOnce       sync.Once
	fontsParseError error
)

func parseFonts() {
	regularFont, fontsParseError = opentype.Parse(goregular.TTF)
	if fontsParseError != nil {
		return
	}
	boldFont, fontsParseError = opentype.Parse(gobold.TTF)
}

func loadFace(bold bool, size float64) (font.Face, error) {
	fontsOnce.Do(parseFonts)
	if fontsParseError != nil {
		return nil, fontsParseError
	}
	tt := regularFont
	if bold {
		tt = boldFont
	}
	return opentype.NewFace(tt, &opentype.FaceOptions{
		Size:    size,
		DPI:     72,
		Hinting: font.HintingFull,
	})
}

// parseHexColor accepts "#RRGGBB" → gg float RGB. Falls back to
// opaque white on parse failure; caller picks a slot that reads
// OK if the fallback fires.
func parseHexColor(hex string) (r, g, b float64) {
	s := strings.TrimPrefix(hex, "#")
	if len(s) != 6 {
		return 1, 1, 1
	}
	var rgb [3]uint8
	for i := 0; i < 3; i++ {
		rgb[i] = uint8(hexNibble(s[i*2])<<4 | hexNibble(s[i*2+1]))
	}
	return float64(rgb[0]) / 255, float64(rgb[1]) / 255, float64(rgb[2]) / 255
}

func hexNibble(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	case c >= 'A' && c <= 'F':
		return int(c-'A') + 10
	}
	return 0
}

func renderShareCardPNG(p sharePayload, userTitle, qrTarget string) ([]byte, error) {
	const W, H = 1200, 630
	dc := gg.NewContext(W, H)

	// Background — approximate the SVG linear gradient as a
	// vertical band lerp. gg's fill API doesn't expose a native
	// gradient; the hand-rolled loop is cheap at 630 rows and
	// visually indistinguishable at OG-card DPI.
	for y := 0; y < H; y++ {
		t := float64(y) / float64(H)
		r := 0.051*(1-t) + 0.102*t
		g := 0.051*(1-t) + 0.102*t
		b := 0.051*(1-t) + 0.180*t
		dc.SetRGB(r, g, b)
		dc.DrawRectangle(0, float64(y), W, 1)
		dc.Fill()
	}

	cr, cg, cb := parseHexColor(colorForGenre(p.Genre))
	drawRadialGlow(dc, 1000, 315, 280, cr, cg, cb, 0.35)

	// Left panel — title+genre or genre-only heading.
	if userTitle != "" {
		drawText(dc, true, 56, 70, 120, 0.93, 0.93, 0.93, truncRunes(userTitle, 22))
		drawText(dc, true, 26, 70, 170, cr, cg, cb, strings.ToUpper(p.Genre))
		drawText(dc, false, 16, 70, 205, 0.6, 0.6, 0.6, "BEATS · BITWRAP · IO")
	} else {
		drawText(dc, true, 70, 70, 140, cr, cg, cb, strings.ToUpper(p.Genre))
		drawText(dc, false, 20, 70, 200, 0.6, 0.6, 0.6, "BEATS · BITWRAP · IO")
	}

	// Tempo / seed / swing·humanize strip.
	drawText(dc, false, 24, 70, 290, 0.53, 0.53, 0.53, "TEMPO")
	drawText(dc, true, 52, 70, 340, 0.93, 0.93, 0.93, fmt.Sprintf("%d", p.Tempo))
	face, _ := loadFace(true, 52)
	dc.SetFontFace(face)
	tempoW, _ := dc.MeasureString(fmt.Sprintf("%d", p.Tempo))
	drawText(dc, false, 24, 70+tempoW, 340, 0.53, 0.53, 0.53, " BPM")

	drawText(dc, false, 16, 70, 410, 0.53, 0.53, 0.53, "SEED")
	drawText(dc, false, 24, 70, 440, 0.8, 0.8, 0.8, fmt.Sprintf("%d", p.Seed))

	drawText(dc, false, 16, 340, 410, 0.53, 0.53, 0.53, "SWING · HUMANIZE")
	drawText(dc, false, 24, 340, 440, 0.8, 0.8, 0.8, fmt.Sprintf("%d · %d", p.Swing, p.Humanize))

	// Ring + dots — same geometry as the SVG template.
	dc.SetRGBA(cr, cg, cb, 0.4)
	dc.SetLineWidth(2)
	dc.DrawCircle(1000, 315, 220)
	dc.Stroke()

	for _, d := range ringDotsForSeed(p.Seed, 16) {
		if d.On {
			dc.SetRGB(cr, cg, cb)
			dc.DrawCircle(d.X, d.Y, d.R)
			dc.Fill()
		} else {
			dc.SetRGBA(cr, cg, cb, 0.5)
			dc.SetLineWidth(2)
			dc.DrawCircle(d.X, d.Y, d.R)
			dc.Stroke()
		}
	}

	// QR in the ring centre — 200×200, encodes the exact URL the
	// client renderer uses.
	if qrTarget != "" {
		if qrImg, err := renderQRImage(qrTarget, 200); err == nil && qrImg != nil {
			dc.DrawImage(qrImg, 900, 215)
		}
	}

	// Footer strip + CID + tagline.
	dc.SetRGBA(0, 0, 0, 0.4)
	dc.DrawRectangle(0, 570, W, 60)
	dc.Fill()
	drawText(dc, false, 16, 70, 610, 0.47, 0.47, 0.47, truncRunes(shortFooterCID(qrTarget), 48))
	tag := "open in a browser to play →"
	tagFace, _ := loadFace(false, 16)
	dc.SetFontFace(tagFace)
	tw, _ := dc.MeasureString(tag)
	drawText(dc, false, 16, float64(W)-70-tw, 610, 0.53, 0.53, 0.53, tag)

	var out bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	if err := enc.Encode(&out, dc.Image()); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func drawText(dc *gg.Context, bold bool, size, x, y, r, g, b float64, s string) {
	face, err := loadFace(bold, size)
	if err != nil {
		return
	}
	dc.SetFontFace(face)
	dc.SetRGB(r, g, b)
	dc.DrawString(s, x, y)
}

// drawRadialGlow hand-paints concentric alpha shells. gg has no
// radial-gradient primitive that composites cleanly into an
// existing canvas; the shells are invisible at OG resolution.
func drawRadialGlow(dc *gg.Context, cx, cy, radius, r, g, b, maxAlpha float64) {
	steps := 32
	for i := steps; i > 0; i-- {
		t := float64(i) / float64(steps)
		alpha := maxAlpha * (1 - t) * (1 - t)
		dc.SetRGBA(r, g, b, alpha)
		dc.DrawCircle(cx, cy, radius*t)
		dc.Fill()
	}
}

func renderQRImage(text string, size int) (image.Image, error) {
	qc, err := qrcode.New(text, qrcode.Medium)
	if err != nil {
		return nil, err
	}
	qc.DisableBorder = true
	return qc.Image(size), nil
}

func shortFooterCID(target string) string {
	idx := strings.Index(target, "cid=")
	if idx < 0 {
		return target
	}
	rest := target[idx+4:]
	if amp := strings.Index(rest, "&"); amp >= 0 {
		rest = rest[:amp]
	}
	return rest
}

func truncRunes(s string, n int) string {
	if n <= 0 {
		return ""
	}
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n-1]) + "…"
}

func handleShareCardPNG(store *shareStore) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/share-card/")
		name = strings.TrimSuffix(name, ".png")
		if !cidPattern.MatchString(name) {
			http.Error(w, "invalid cid", http.StatusBadRequest)
			return
		}
		raw, err := store.lookup(name)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				http.Error(w, "not found", http.StatusNotFound)
				return
			}
			http.Error(w, "read failed", http.StatusInternalServerError)
			return
		}
		var p sharePayload
		if err := json.Unmarshal(raw, &p); err != nil || p.Type != "BeatsShare" {
			http.Error(w, "invalid payload", http.StatusBadRequest)
			return
		}
		userTitle := sanitizeTitle(r.URL.Query().Get("title"))
		origin := schemeHost(r)
		qrTarget := fmt.Sprintf("%s/?cid=%s", origin, name)
		if userTitle != "" {
			qrTarget += "&title=" + urlQueryEscape(userTitle)
		}
		body, err := renderShareCardPNG(p, userTitle, qrTarget)
		if err != nil {
			http.Error(w, "render failed", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		_, _ = io.Copy(w, bytes.NewReader(body))
	})
}

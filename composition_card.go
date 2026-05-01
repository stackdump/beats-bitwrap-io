package main

// /composition-card/{cid}.svg — server-rendered cover art for
// BeatsComposition envelopes. Mirrors the /share-card/ shape (1200×630
// canvas, 86400 s cache) but the visual is composition-specific: a
// deterministic gradient seeded by the CID + the composition title +
// the ingredient count from the envelope's tracks array. PR-7.1
// scope: SVG only; PNG rasterisation can follow if a DSP or podcast
// client demands a bitmap (the raster path for shares lives in
// internal/share/share_card_png.go and is reusable).

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"beats-bitwrap-io/internal/share"
)

// cidPattern: same shape the share-store enforces. Defensive on this
// route so a 404 path can't be poked with arbitrary input.
var compositionCardCIDPattern = regexp.MustCompile(`^z[1-9A-HJ-NP-Za-km-z]{40,80}$`)

func compositionCardHandler(compositionStore *share.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/composition-card/")
		path = strings.TrimSuffix(path, ".svg")
		if !compositionCardCIDPattern.MatchString(path) {
			http.Error(w, "invalid cid", http.StatusBadRequest)
			return
		}
		body, err := compositionStore.Lookup(path)
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		var env struct {
			Title  string `json:"title"`
			Tempo  int    `json:"tempo"`
			Tracks []any  `json:"tracks"`
		}
		_ = json.Unmarshal(body, &env)
		title := env.Title
		if title == "" {
			title = "Untitled Composition"
		}
		w.Header().Set("Content-Type", "image/svg+xml; charset=utf-8")
		w.Header().Set("Cache-Control", "public, max-age=86400, immutable")
		_, _ = fmt.Fprint(w, renderCompositionSVG(path, title, env.Tempo, len(env.Tracks)))
	}
}

// renderCompositionSVG emits a deterministic 1200×630 SVG. Color +
// shape are derived from the CID's bytes so the same composition
// always renders the same card without persisting it. No external
// images, no fonts beyond system stack — drop-in across browsers.
func renderCompositionSVG(cid, title string, tempo, trackCount int) string {
	// Hash bytes from the CID drive the visual.
	// CIDs start with 'z' + base58 — convert to a canonical hex digest
	// by hex-encoding the raw multibase prefix + first 8 base58 chars.
	// Same CID → same bytes; different CID → different.
	seed := []byte(cid)
	h := func(i int) byte {
		if i < len(seed) {
			return seed[i]
		}
		return byte(i)
	}
	hueA := int(h(2)) % 360
	hueB := (int(h(7))*7 + 137) % 360
	satA := 50 + int(h(11))%30
	satB := 40 + int(h(17))%30
	lightA := 14 + int(h(3))%10
	lightB := 22 + int(h(5))%12

	// Track-count drives the number of "lane" stripes drawn over the
	// gradient — visual hint at how rich the composition is.
	lanes := trackCount
	if lanes < 1 {
		lanes = 1
	}
	if lanes > 12 {
		lanes = 12
	}
	var laneStripes strings.Builder
	for i := 0; i < lanes; i++ {
		y := 100 + i*40
		opacity := 0.15 + float64(int(h(i*3+1))%30)/200.0
		laneStripes.WriteString(fmt.Sprintf(
			`<rect x="0" y="%d" width="1200" height="20" fill="rgba(255,255,255,%.3f)"/>`,
			y, opacity,
		))
	}

	tempoLabel := ""
	if tempo > 0 {
		tempoLabel = fmt.Sprintf("%d BPM", tempo)
	}
	cidShort := hex.EncodeToString([]byte(cid))[:14]
	if len(cid) > 14 {
		cidShort = cid[:14] + "…"
	}

	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(` + fmt.Sprintf("%d", hueA) + `, ` + fmt.Sprintf("%d%%, %d%%", satA, lightA) + `)"/>
      <stop offset="100%" stop-color="hsl(` + fmt.Sprintf("%d", hueB) + `, ` + fmt.Sprintf("%d%%, %d%%", satB, lightB) + `)"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  ` + laneStripes.String() + `
  <text x="60" y="500" font-family="-apple-system,system-ui,sans-serif" font-size="56" font-weight="700" fill="rgba(255,255,255,0.95)">` + xmlEscapeText(title) + `</text>
  <text x="60" y="555" font-family="ui-monospace,monospace" font-size="24" font-weight="500" fill="rgba(255,255,255,0.65)">🎚 Composition · ` + fmt.Sprintf("%d tracks", trackCount) + xmlIfNonEmpty(tempoLabel, " · ") + `</text>
  <text x="60" y="590" font-family="ui-monospace,monospace" font-size="18" fill="rgba(255,255,255,0.45)">` + xmlEscapeText(cidShort) + `</text>
</svg>`
}

func xmlEscapeText(s string) string {
	r := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		"\"", "&quot;",
		"'", "&apos;",
	)
	return r.Replace(s)
}

func xmlIfNonEmpty(value, sep string) string {
	if value == "" {
		return ""
	}
	return sep + xmlEscapeText(value)
}

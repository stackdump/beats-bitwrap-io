package share

// Server-rendered share page + social card. When the front-end is
// loaded with `?cid=z…`, bots and link-unfurlers hit `/` without ever
// executing JS, so the raw static index.html is useless to them. This
// file intercepts that case:
//
//   1. /?cid=z…                — return index.html decorated with Open
//                                 Graph / Twitter / JSON-LD metadata
//                                 derived from the stored payload.
//   2. /share-card/{cid}.svg   — server-rendered 1200×630 SVG used as
//                                 og:image / twitter:image.
//
// The cid-less path still serves the plain static index.html, so the
// app behaviour is unchanged for everyone who isn't linking a share.

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"html/template"
	"io/fs"
	"log"
	"math"
	"math/rand"
	"net/http"
	"net/url"
	"os"
	"strings"
	texttemplate "text/template"

	"beats-bitwrap-io/internal/generator"

	qrcode "github.com/skip2/go-qrcode"
)

var urlQueryEscapeFn = url.QueryEscape

// sharePayload is the minimum shape we need out of the stored bytes to
// render a card. Fields the JSON schema also guarantees are present.
type sharePayload struct {
	Type      string `json:"@type"`
	V         int    `json:"v"`
	Genre     string `json:"genre"`
	Name      string `json:"name,omitempty"`
	Seed      int64  `json:"seed"`
	Tempo     int    `json:"tempo"`
	Swing     int    `json:"swing"`
	Humanize  int    `json:"humanize"`
	RootNote  *int   `json:"rootNote,omitempty"`
	ScaleName string `json:"scaleName,omitempty"`
	Bars      int    `json:"bars,omitempty"`
	Structure string `json:"structure,omitempty"`
}

// keyLabel renders the musical key for the card. Mirrors the JS
// keyLabel() in public/lib/share/card.js so the SVG/PNG/client cards
// all display the same string for identical payloads.
var noteNames = [12]string{"C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"}
var scaleShort = map[string]string{
	"Major": "MAJ", "Minor": "MIN", "Pentatonic": "PENT",
	"MinPentatonic": "MIN PENT", "Blues": "BLUES",
	"Dorian": "DOR", "Mixolydian": "MIX", "Phrygian": "PHR",
	"HarmonicMin": "H MIN",
}

func keyLabel(rootNote *int, scaleName string) string {
	if rootNote == nil || *rootNote < 0 {
		return ""
	}
	note := noteNames[((*rootNote%12)+12)%12]
	tag, ok := scaleShort[scaleName]
	if !ok {
		tag = strings.ToUpper(scaleName)
	}
	if tag == "" {
		return note
	}
	return note + " " + tag
}

// barLabel mirrors the JS barLabel() — "LOOP" for loop mode, otherwise
// "<MODE> <BARS>" when a structure is picked.
func barLabel(bars int, structureMode string) string {
	mode := strings.ToUpper(strings.TrimSpace(structureMode))
	if bars <= 1 {
		if mode != "" {
			return mode
		}
		return "LOOP"
	}
	if mode != "" {
		return fmt.Sprintf("%s %d", mode, bars)
	}
	return fmt.Sprintf("%d", bars)
}

// Genre → background color for the card. Same palette as the frontend
// so shared cards feel consistent with the live app.
var genreColors = map[string]string{
	"techno":    "#e94560",
	"house":     "#f5a623",
	"jazz":      "#9b59b6",
	"ambient":   "#4a90d9",
	"dnb":       "#2ecc71",
	"edm":       "#00d2ff",
	"speedcore": "#ff2a2a",
	"dubstep":   "#8b00ff",
	"trance":    "#ffaa00",
	"lofi":      "#d4a574",
	"trap":      "#ff6b6b",
	"synthwave": "#ff00aa",
	"reggae":    "#2ecc71",
	"country":   "#d4a574",
	"metal":     "#555555",
	"garage":    "#00aaff",
	"blues":     "#4a90d9",
	"bossa":     "#f5a623",
	"funk":      "#e94560",
}

// GenreColors returns the public read-only genre→hex colour map.
// Exposed so the frontend can color-code genre chips identically to
// the SVG cards without duplicating the palette in JS.
func GenreColors() map[string]string {
	out := make(map[string]string, len(genreColors))
	for k, v := range genreColors {
		out[k] = v
	}
	return out
}

func colorForGenre(g string) string {
	if c, ok := genreColors[g]; ok {
		return c
	}
	return "#4a90d9"
}

// titleCase upper-cases the first rune. Replaces strings.Title (now
// deprecated) — only used for ASCII genre names so we don't need full
// Unicode title-casing semantics.
func titleCase(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// resolveCardTitle picks the best display title in order:
//   1. user-supplied ?title= query param (sanitised)
//   2. payload.Name (set by the composer at seal time on newer envelopes)
//   3. deterministic synthesised name from (genre, seed)
//
// The card layout shows the genre as its own subtitle right below the
// title, so a "{genre} · {name}" prefix on the synthesised form would
// duplicate it — strip the leading "{genre} · " when present.
func resolveCardTitle(userTitle string, p sharePayload) string {
	if t := sanitizeTitle(userTitle); t != "" {
		return t
	}
	if t := sanitizeTitle(p.Name); t != "" {
		return stripGenrePrefix(t, p.Genre)
	}
	return stripGenrePrefix(sanitizeTitle(generator.NameForSeed(p.Genre, p.Seed)), p.Genre)
}

func stripGenrePrefix(name, genre string) string {
	if genre == "" {
		return name
	}
	prefix := genre + " · "
	if strings.HasPrefix(strings.ToLower(name), strings.ToLower(prefix)) {
		return name[len(prefix):]
	}
	return name
}

// sanitizeTitle strips control chars + trims, caps at 60 runes. The
// cap keeps the SVG layout predictable and the og:title reasonable,
// and stripping control chars closes a trivial XML-injection vector
// (even though we also escape on write).
func sanitizeTitle(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	var b strings.Builder
	n := 0
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			continue
		}
		b.WriteRune(r)
		n++
		if n >= 60 {
			break
		}
	}
	return strings.TrimSpace(b.String())
}

// urlQueryEscape is url.QueryEscape under a shorter name so the build
// callsites read cleanly.
func urlQueryEscape(s string) string { return urlQueryEscapeFn(s) }

// svgEscape escapes the five XML entities that can break out of a
// <text> body. Called from the share-card SVG template on user-supplied
// title strings.
func svgEscape(s string) string {
	r := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
		`'`, "&apos;",
	)
	return r.Replace(s)
}

// DecoratedIndex serves the single-page app shell with Open Graph /
// JSON-LD metadata injected into <head>. Falls back to the plain
// static index.html for non-share requests and for share URLs whose
// CID isn't in the store.
func DecoratedIndex(store *Store, publicFS fs.FS, diskDir string) http.Handler {
	tpl := template.Must(template.New("card").Parse(cardHeadTemplate))

	readIndex := func() ([]byte, error) {
		if diskDir != "" {
			return os.ReadFile(diskDir + "/index.html")
		}
		return fs.ReadFile(publicFS, "index.html")
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cid := r.URL.Query().Get("cid")
		if cid == "" || !cidPattern.MatchString(cid) {
			serveIndexBytes(w, readIndex)
			return
		}
		raw, err := store.lookup(cid)
		if err != nil {
			// CID not in our store (maybe from another instance, maybe
			// purged). Serve the plain shell — the client-side `&z=`
			// inline-payload path can still hydrate it.
			serveIndexBytes(w, readIndex)
			return
		}
		var p sharePayload
		if err := json.Unmarshal(raw, &p); err != nil || p.Type != "BeatsShare" {
			serveIndexBytes(w, readIndex)
			return
		}
		indexBytes, err := readIndex()
		if err != nil {
			http.Error(w, "index read failed", http.StatusInternalServerError)
			return
		}
		// Build the injection block from the payload.
		origin := schemeHost(r)
		userTitle := resolveCardTitle(r.URL.Query().Get("title"), p)
		genreCap := titleCase(p.Genre)
		shareURL := fmt.Sprintf("%s/?cid=%s", origin, cid)
		cardPNG := fmt.Sprintf("%s/share-card/%s.png", origin, cid)
		cardSVG := fmt.Sprintf("%s/share-card/%s.svg", origin, cid)
		audioURL := fmt.Sprintf("%s/audio/%s.webm", origin, cid)
		if userTitle != "" {
			shareURL += "&title=" + urlQueryEscape(userTitle)
			cardPNG += "?title=" + urlQueryEscape(userTitle)
			cardSVG += "?title=" + urlQueryEscape(userTitle)
		}
		title := fmt.Sprintf("%s · beats.bitwrap.io", genreCap)
		if userTitle != "" {
			title = userTitle + " · beats.bitwrap.io"
		}
		desc := fmt.Sprintf("%s · %d BPM · seed %d · swing %d · humanize %d",
			genreCap, p.Tempo, p.Seed, p.Swing, p.Humanize)

		// The JSON-LD <script> block re-exposes the full stored payload
		// — not just the summary fields above — so consumers that parse
		// the page can recover the exact track recipe without a second
		// round-trip to /o/{cid}. The bytes are the canonical JSON
		// straight from the store, so the CID still hashes to cid.
		projection, err := buildProjectionJSONLD(shareURL, cid, genreCap, userTitle, desc)
		if err != nil {
			http.Error(w, "projection render error", http.StatusInternalServerError)
			return
		}
		imgAlt := fmt.Sprintf("%s track card · %d BPM · seed %d", genreCap, p.Tempo, p.Seed)
		if userTitle != "" {
			imgAlt = userTitle + " — " + imgAlt
		}
		var buf strings.Builder
		if err := tpl.Execute(&buf, struct {
			Title, Desc, CardPNG, CardSVG, ImgAlt, ShareURL, AudioURL, CID string
			Payload, Projection                                            template.JS
		}{
			Title:      title,
			Desc:       desc,
			CardPNG:    cardPNG,
			CardSVG:    cardSVG,
			ImgAlt:     imgAlt,
			ShareURL:   shareURL,
			AudioURL:   audioURL,
			CID:        cid,
			Payload:    template.JS(escapeJSONForScriptTag(raw)),
			Projection: template.JS(projection),
		}); err != nil {
			http.Error(w, "render error", http.StatusInternalServerError)
			return
		}
		decorated := injectIntoHead(indexBytes, []byte(buf.String()))
		if tag := googleAnalyticsTag(GoogleAnalyticsID); tag != "" {
			decorated = injectIntoHead(decorated, []byte(tag))
		}
		decorated = replaceTitle(decorated, title)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		// Cache briefly so link-unfurl bots don't thrash the store on
		// retries, but not immutably — a re-generated card template
		// should roll out within minutes.
		w.Header().Set("Cache-Control", "public, max-age=300")
		w.Write(decorated)
	})
}

// serveIndexBytes is the plain path — no decoration, no store lookup.
func serveIndexBytes(w http.ResponseWriter, read func() ([]byte, error)) {
	b, err := read()
	if err != nil {
		http.Error(w, "index read failed", http.StatusInternalServerError)
		return
	}
	if tag := googleAnalyticsTag(GoogleAnalyticsID); tag != "" {
		b = injectIntoHead(b, []byte(tag))
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write(b)
}

// GoogleAnalyticsID is set once from $GOOGLE_ANALYTICS_ID in main().
// Empty string = analytics disabled, no snippet injected.
var GoogleAnalyticsID string

func googleAnalyticsTag(id string) string {
	if id == "" {
		return ""
	}
	return fmt.Sprintf(`<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=%s"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '%s');
</script>
`, id, id)
}

// injectIntoHead slides `block` in just before the closing </head> tag.
// If for some reason </head> isn't present (hand-edited index), the
// block is appended to the front.
func injectIntoHead(doc, block []byte) []byte {
	marker := []byte("</head>")
	idx := indexBytes(doc, marker)
	if idx < 0 {
		return append(block, doc...)
	}
	out := make([]byte, 0, len(doc)+len(block))
	out = append(out, doc[:idx]...)
	out = append(out, block...)
	out = append(out, doc[idx:]...)
	return out
}

// qrPngDataURL renders `text` as a medium-ECL QR code PNG and
// returns a `data:image/png;base64,…` URL suitable for embedding
// as the `href` of an SVG <image>. Paired with the client-side
// renderQrGroup() in public/lib/share/qr.js — both encode the same
// URL with medium ECL, so scanners produce the same payload
// regardless of which renderer drew the card. Returns empty string
// + nil on any failure; callers should fall back to a card without
// the QR rather than error out.
func qrPngDataURL(text string, size int) (string, error) {
	if text == "" {
		return "", nil
	}
	qc, err := qrcode.New(text, qrcode.Medium)
	if err != nil {
		return "", err
	}
	qc.DisableBorder = true
	png, err := qc.PNG(size)
	if err != nil {
		return "", err
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(png), nil
}

// HandleQRCode serves /qr?data=…&size=… as a standalone PNG. Not
// used by the share card itself (that embeds a data URL inline) —
// useful for stamping QRs in other places (docs, external tools)
// and for the cross-runtime equivalence test that captures the
// matrix bytes.
func HandleQRCode() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data := r.URL.Query().Get("data")
		if data == "" {
			http.Error(w, "missing data", http.StatusBadRequest)
			return
		}
		if len(data) > 2048 {
			http.Error(w, "data too long", http.StatusRequestEntityTooLarge)
			return
		}
		size := 512
		if s := r.URL.Query().Get("size"); s != "" {
			var n int
			fmt.Sscanf(s, "%d", &n)
			if n >= 64 && n <= 2048 {
				size = n
			}
		}
		qc, err := qrcode.New(data, qrcode.Medium)
		if err != nil {
			http.Error(w, "encode failed", http.StatusBadRequest)
			return
		}
		qc.DisableBorder = true
		png, err := qc.PNG(size)
		if err != nil {
			http.Error(w, "render failed", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		w.Write(png)
	})
}

// escapeJSONForScriptTag makes canonical-JSON bytes safe to embed
// inside <script type="application/ld+json">…</script>. The stored
// bytes are whatever the client PUT (any CID-matching byte sequence
// wins the store), so a crafted payload can contain literal "</"
// sequences inside a JSON string. Replacing <, >, &, U+2028, U+2029
// with their \uXXXX escapes yields an equivalent JSON string value
// (parsers treat them identically) without risk of breaking out of
// the enclosing <script> block. CID verification on lookup still
// operates on the original stored bytes, so nothing downstream
// notices the transform.
func escapeJSONForScriptTag(b []byte) []byte {
	b = bytes.ReplaceAll(b, []byte("<"), []byte(`\u003c`))
	b = bytes.ReplaceAll(b, []byte(">"), []byte(`\u003e`))
	b = bytes.ReplaceAll(b, []byte("&"), []byte(`\u0026`))
	b = bytes.ReplaceAll(b, []byte("\u2028"), []byte(`\u2028`))
	b = bytes.ReplaceAll(b, []byte("\u2029"), []byte(`\u2029`))
	return b
}

// replaceTitle swaps the first <title>…</title> in doc for the
// computed share title. The static shell ships with a generic
// "beats-btw" title; without this, browser tabs and bookmarks of
// `?cid=…` links all show the same generic title even though the
// social-card metadata is correct. Projection layer — never affects
// the CID.
func replaceTitle(doc []byte, title string) []byte {
	open := []byte("<title>")
	close := []byte("</title>")
	i := indexBytes(doc, open)
	if i < 0 {
		return doc
	}
	j := indexBytes(doc[i:], close)
	if j < 0 {
		return doc
	}
	j += i
	escaped := template.HTMLEscapeString(title)
	out := make([]byte, 0, len(doc)+len(escaped))
	out = append(out, doc[:i+len(open)]...)
	out = append(out, escaped...)
	out = append(out, doc[j:]...)
	return out
}

// buildProjectionJSONLD emits a schema.org MusicRecording node keyed
// by the CID. This is the *projection* layer — a human-vocabulary
// view over the canonical BeatsShare bytes. The CID is the stable
// identity (`identifier`); name/url/genre are mutable labels the
// user chose at share time and travel in the query string, not the
// hashed payload.
func buildProjectionJSONLD(shareURL, cid, genre, userTitle, desc string) (string, error) {
	name := userTitle
	if name == "" {
		name = genre + " · beats.bitwrap.io"
	}
	node := map[string]any{
		"@context":    "https://schema.org",
		"@type":       "MusicRecording",
		"name":        name,
		"url":         shareURL,
		"identifier":  cid,
		"genre":       genre,
		"description": desc,
		// All shared tracks are licensed CC BY 4.0 — same license
		// YouTube's "Creative Commons" option uses, so embeds and
		// Content ID systems treat the audio as legitimately reusable.
		"license":   "https://creativecommons.org/licenses/by/4.0/",
		"copyrightNotice": "CC BY 4.0 — beats.bitwrap.io",
	}
	b, err := json.Marshal(node)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// indexBytes is a minimal substring scanner — pulling in `bytes.Index`
// would add another import for a three-line loop.
func indexBytes(hay, needle []byte) int {
	if len(needle) == 0 || len(needle) > len(hay) {
		return -1
	}
	for i := range len(hay) - len(needle) + 1 {
		match := true
		for j := range needle {
			if hay[i+j] != needle[j] {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}

func schemeHost(r *http.Request) string {
	scheme := "https"
	if r.TLS == nil && r.Header.Get("X-Forwarded-Proto") != "https" {
		// nginx in front of the service typically strips TLS but sets
		// X-Forwarded-Proto. For local dev (no proxy, no TLS, plain
		// http), fall back to http.
		if r.Header.Get("X-Forwarded-Proto") == "" {
			scheme = "http"
		}
	}
	host := r.Host
	if xfh := r.Header.Get("X-Forwarded-Host"); xfh != "" {
		host = xfh
	}
	return scheme + "://" + host
}

// --- HTML template for the <head>-inject block ------------------

const cardHeadTemplate = `<!-- beats-bitwrap share card -->
<meta property="og:type" content="music.song"/>
<meta property="og:title" content="{{.Title}}"/>
<meta property="og:description" content="{{.Desc}}"/>
<meta property="og:url" content="{{.ShareURL}}"/>
<meta property="og:image" content="{{.CardPNG}}"/>
<meta property="og:image:secure_url" content="{{.CardPNG}}"/>
<meta property="og:image:type" content="image/png"/>
<meta property="og:image:width" content="1200"/>
<meta property="og:image:height" content="630"/>
<meta property="og:image:alt" content="{{.ImgAlt}}"/>
<meta property="og:site_name" content="beats.bitwrap.io"/>
<meta property="og:audio" content="{{.AudioURL}}"/>
<meta property="og:audio:secure_url" content="{{.AudioURL}}"/>
<meta property="og:audio:type" content="audio/webm"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="{{.Title}}"/>
<meta name="twitter:description" content="{{.Desc}}"/>
<meta name="twitter:image" content="{{.CardPNG}}"/>
<meta name="twitter:image:alt" content="{{.ImgAlt}}"/>
<meta name="twitter:site" content="@bitwrap_io"/>
<meta name="description" content="{{.Desc}}"/>
<link rel="canonical" href="{{.ShareURL}}"/>
<link rel="license" href="https://creativecommons.org/licenses/by/4.0/"/>
<meta name="rights" content="CC BY 4.0 — beats.bitwrap.io"/>
<script type="application/ld+json">{{.Projection}}</script>
<script type="application/ld+json">{{.Payload}}</script>
`

// --- Share-card SVG renderer ------------------------------------

// HandleShareCard answers GET /share-card/{cid}.svg with a
// deterministically-generated 1200×630 SVG derived from the stored
// payload. No fonts needed — uses system-ui via CSS so we don't fight
// with cross-platform font availability.
func HandleShareCard(store *Store) http.Handler {
	// text/template, not html/template — html/template escapes `<?xml`
	// into `&lt;?xml` which breaks the SVG preamble. SVG is XML, not
	// HTML. For interpolated user input (title) we register an explicit
	// svgEscape helper so angle brackets / ampersands / quotes in the
	// user's title can't break out of the <text> element.
	tpl := texttemplate.Must(texttemplate.New("svg").
		Funcs(texttemplate.FuncMap{
			"svgEscape": svgEscape,
			"sub":       func(a, b float64) float64 { return a - b },
			"mul":       func(a, b float64) float64 { return a * b },
		}).
		Parse(shareSvgTemplate))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/share-card/")
		name = strings.TrimSuffix(name, ".svg")
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
		art := cardArtForSeed(p.Genre, p.Seed)
		userTitle := resolveCardTitle(r.URL.Query().Get("title"), p)
		// Short URL identical to the one shortShareUrl() builds on
		// the client — both sides encode the same bytes so a scanner
		// reads the same destination regardless of which renderer drew
		// the card.
		origin := schemeHost(r)
		qrTarget := fmt.Sprintf("%s/?cid=%s", origin, name)
		// QR target only includes &title= when an explicit user-set
		// title was provided. Synthesised names are recoverable from
		// (genre, seed) on the receiving end, so omitting them keeps
		// scanned URLs short.
		if t := sanitizeTitle(r.URL.Query().Get("title")); t != "" {
			qrTarget += "&title=" + urlQueryEscape(t)
		}
		qrDataURL, _ := qrPngDataURL(qrTarget, 512)
		data := struct {
			Genre, GenreUpper, Color, Title string
			HasTitle                        bool
			Tempo                           int
			Seed                            int64
			Key, Mode                       string
			CID                             string
			Art                             cardArt
			QRDataURL                       string
		}{
			Genre:      p.Genre,
			GenreUpper: strings.ToUpper(p.Genre),
			Color:      colorForGenre(p.Genre),
			Title:      userTitle,
			HasTitle:   userTitle != "",
			Tempo:      p.Tempo,
			Seed:       p.Seed,
			Key:        keyLabel(p.RootNote, p.ScaleName),
			Mode:       barLabel(p.Bars, p.Structure),
			CID:        name,
			Art:        art,
			QRDataURL:  qrDataURL,
		}
		w.Header().Set("Content-Type", "image/svg+xml")
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		if err := tpl.Execute(w, data); err != nil {
			log.Printf("svg render: %v", err)
		}
	})
}

// cardGlyph is one shape (circle or square) on the card. Pre-computed
// so the SVG template stays simple.
type cardGlyph struct {
	X, Y, R float64
	Square  bool // false = circle, true = square (R is half-side)
	Filled  bool
}

// cardArt is the assembled hero artwork: a list of glyphs plus
// connecting strokes (rings and polylines). Both the SVG template and
// the PNG renderer consume this same structure so the OG image and
// the gallery thumbnail are visually identical.
type cardArt struct {
	Glyphs    []cardGlyph
	Rings     []cardRing       // stroked circles (concentric backdrops)
	Polylines []cardPolyline   // open or closed point chains
}

type cardRing struct {
	Cx, Cy, R float64
}

type cardPolyline struct {
	Pts    []cardPoint
	Closed bool
}

type cardPoint struct {
	X, Y float64
}

// Art-layout buckets keyed by genre. Each bucket gets a different
// underlying topology so a wall of cards reads as visually distinct
// even at thumbnail size.
var genreLayout = map[string]string{
	"techno":    "concentric",
	"house":     "concentric",
	"edm":       "concentric",
	"dnb":       "concentric",
	"dubstep":   "concentric",
	"trance":    "spiral",
	"synthwave": "spiral",
	"metal":     "polygon",
	"speedcore": "polygon",
	"trap":      "grid",
	"garage":    "grid",
	"ambient":   "orbit",
	"lofi":      "orbit",
	"jazz":      "irregular",
	"blues":     "irregular",
	"bossa":     "irregular",
	"funk":      "irregular",
	"country":   "irregular",
	"reggae":    "irregular",
}

func layoutForGenre(g string) string {
	if l, ok := genreLayout[g]; ok {
		return l
	}
	return "concentric"
}

// cardArtForSeed dispatches to a per-genre layout, seeded so the same
// (genre, seed) pair always renders identically.
func cardArtForSeed(genre string, seed int64) cardArt {
	h := fnv.New64a()
	fmt.Fprintf(h, "%s:%d", genre, seed)
	prng := rand.New(rand.NewSource(int64(h.Sum64()) ^ seed))
	switch layoutForGenre(genre) {
	case "spiral":
		return artSpiral(prng)
	case "polygon":
		return artPolygon(prng)
	case "grid":
		return artGrid(prng)
	case "orbit":
		return artOrbit(prng)
	case "irregular":
		return artIrregular(prng)
	default:
		return artConcentric(prng)
	}
}

// All layouts share a 220-radius bounding circle centered at (1000, 315)
// so they slot into the same panel as the original ring.
const (
	artCx = 1000.0
	artCy = 315.0
	artR  = 220.0
)

// artConcentric: 2-3 nested rings of dots. Used for high-energy
// electronic genres (techno, house, edm, dnb, dubstep) where the music
// itself stacks layered repeating patterns.
func artConcentric(prng *rand.Rand) cardArt {
	rings := 2 + prng.Intn(2) // 2 or 3
	steps := []int{16, 12, 8}
	radii := []float64{artR, artR * 0.66, artR * 0.36}
	out := cardArt{}
	for i := 0; i < rings; i++ {
		out.Rings = append(out.Rings, cardRing{Cx: artCx, Cy: artCy, R: radii[i]})
		n := steps[i]
		for j := 0; j < n; j++ {
			theta := 2*math.Pi*float64(j)/float64(n) - math.Pi/2
			on := prng.Intn(100) < 50
			r := 9.0
			if on {
				r = 14.0
			}
			out.Glyphs = append(out.Glyphs, cardGlyph{
				X: artCx + radii[i]*math.Cos(theta),
				Y: artCy + radii[i]*math.Sin(theta),
				R: r, Filled: on,
			})
		}
	}
	return out
}

// artSpiral: archimedean spiral of dots. Used for trance / synthwave
// where the music has a hypnotic forward-pull quality.
func artSpiral(prng *rand.Rand) cardArt {
	const n = 36
	out := cardArt{}
	turns := 2.5 + prng.Float64()*1.5
	pts := make([]cardPoint, 0, n)
	for i := 0; i < n; i++ {
		t := float64(i) / float64(n-1)
		theta := turns*2*math.Pi*t - math.Pi/2
		r := artR * (0.18 + 0.82*t)
		x := artCx + r*math.Cos(theta)
		y := artCy + r*math.Sin(theta)
		pts = append(pts, cardPoint{X: x, Y: y})
		on := prng.Intn(100) < 55
		gr := 7.0 + 6.0*t
		out.Glyphs = append(out.Glyphs, cardGlyph{
			X: x, Y: y, R: gr, Filled: on,
		})
	}
	out.Polylines = append(out.Polylines, cardPolyline{Pts: pts})
	return out
}

// artPolygon: vertex points of an N-gon with chord edges drawn.
// Used for metal / speedcore — sharp, angular, deliberately aggressive.
func artPolygon(prng *rand.Rand) cardArt {
	n := 5 + prng.Intn(4) // 5..8 sides
	out := cardArt{}
	pts := make([]cardPoint, n)
	for i := 0; i < n; i++ {
		theta := 2*math.Pi*float64(i)/float64(n) - math.Pi/2
		pts[i].X = artCx + artR*math.Cos(theta)
		pts[i].Y = artCy + artR*math.Sin(theta)
		out.Glyphs = append(out.Glyphs, cardGlyph{
			X: pts[i].X, Y: pts[i].Y, R: 16, Filled: true,
		})
	}
	// Outline + inner star (chord skip).
	out.Polylines = append(out.Polylines, cardPolyline{Pts: pts, Closed: true})
	skip := n / 2
	if skip < 2 {
		skip = 2
	}
	for i := 0; i < n; i++ {
		j := (i + skip) % n
		out.Polylines = append(out.Polylines, cardPolyline{
			Pts: []cardPoint{pts[i], pts[j]},
		})
	}
	return out
}

// artGrid: 5×5 grid of squares with a seeded on/off pattern. Used for
// trap / garage — these genres lean on quantised step-grid programming
// so the visual mirrors the underlying production style.
func artGrid(prng *rand.Rand) cardArt {
	const cells = 5
	step := (artR * 1.7) / float64(cells)
	originX := artCx - step*float64(cells-1)/2
	originY := artCy - step*float64(cells-1)/2
	out := cardArt{}
	for i := 0; i < cells; i++ {
		for j := 0; j < cells; j++ {
			on := prng.Intn(100) < 45
			r := 12.0
			if on {
				r = 18.0
			}
			out.Glyphs = append(out.Glyphs, cardGlyph{
				X: originX + step*float64(i),
				Y: originY + step*float64(j),
				R: r, Square: true, Filled: on,
			})
		}
	}
	return out
}

// artOrbit: a central node with N-fold rotationally-symmetric satellite
// clusters. Used for ambient / lofi — sparse, anchored by a long pad.
// Symmetry comes from equal-length spokes at evenly-spaced angles, each
// ending in a same-sized constellation of K dots; only the seed picks
// N (3..6) and K (3..5), so two cards from different seeds look
// distinct without any one card looking off-balance.
func artOrbit(prng *rand.Rand) cardArt {
	out := cardArt{}
	out.Glyphs = append(out.Glyphs, cardGlyph{
		X: artCx, Y: artCy, R: 22, Filled: true,
	})
	clusters := 3 + prng.Intn(4) // 3..6
	dist := artR * 0.78          // fixed spoke length
	clusterR := 28.0             // fixed cluster radius
	k := 3 + prng.Intn(3)        // 3..5 dots per cluster, same for all
	for i := 0; i < clusters; i++ {
		theta := 2*math.Pi*float64(i)/float64(clusters) - math.Pi/2
		ccX := artCx + dist*math.Cos(theta)
		ccY := artCy + dist*math.Sin(theta)
		out.Polylines = append(out.Polylines, cardPolyline{
			Pts: []cardPoint{{X: artCx, Y: artCy}, {X: ccX, Y: ccY}},
		})
		for j := 0; j < k; j++ {
			// Cluster angle aligns one dot with the spoke so the
			// constellation reads as "anchored at the spoke tip"
			// rather than a free-floating ring.
			ang := theta + 2*math.Pi*float64(j)/float64(k)
			out.Glyphs = append(out.Glyphs, cardGlyph{
				X: ccX + clusterR*math.Cos(ang),
				Y: ccY + clusterR*math.Sin(ang),
				R: 7, Filled: true,
			})
		}
	}
	return out
}

// artIrregular: rotationally-symmetric ring with a seeded chord skip.
// Used for swing-driven genres (jazz, blues, bossa, funk, country,
// reggae). All vertices sit on the nominal radius (no jitter) so the
// card reads as patterned; the seed picks the chord skip and the
// on/off mask. The chord network gives the same Petri-net visual cue
// the polygon / orbit layouts have without the lumpy contour the
// previous random-radius version produced.
func artIrregular(prng *rand.Rand) cardArt {
	const n = 12
	out := cardArt{}
	pts := make([]cardPoint, n)
	for i := 0; i < n; i++ {
		theta := 2*math.Pi*float64(i)/float64(n) - math.Pi/2
		pts[i].X = artCx + artR*math.Cos(theta)
		pts[i].Y = artCy + artR*math.Sin(theta)
		on := prng.Intn(100) < 60
		out.Glyphs = append(out.Glyphs, cardGlyph{
			X: pts[i].X, Y: pts[i].Y, R: 13, Filled: on,
		})
	}
	// Chord skip varies the visual texture per seed: skip=2 makes
	// neighbour-pair triangles, skip=3 makes a 4-pointed star,
	// skip=4 a 3-pointed Mercedes star, skip=5 a near-diameter web.
	skip := 2 + prng.Intn(4) // 2..5
	for i := 0; i < n; i++ {
		j := (i + skip) % n
		out.Polylines = append(out.Polylines, cardPolyline{
			Pts: []cardPoint{pts[i], pts[j]},
		})
	}
	return out
}

// 1200×630 is the Twitter/Facebook/LinkedIn OG sweet spot. Two-zone
// layout: left half = big genre name + key params, right half = ring
// of dots. Bottom strip = CID + site name.
const shareSvgTemplate = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0d0d0d"/>
      <stop offset="1" stop-color="#1a1a2e"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="{{.Color}}" stop-opacity="0.35"/>
      <stop offset="1" stop-color="{{.Color}}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <circle cx="1000" cy="315" r="280" fill="url(#glow)"/>

  <!-- Left panel: title / genre + params -->
  <g font-family="system-ui, -apple-system, sans-serif" fill="#eee">
    {{if .HasTitle -}}
    <text x="70" y="120" font-size="60" font-weight="800" fill="#eee" letter-spacing="-1.5">{{svgEscape .Title}}</text>
    <text x="70" y="170" font-size="28" font-weight="700" fill="{{.Color}}" letter-spacing="2">{{svgEscape .GenreUpper}}</text>
    <text x="70" y="205" font-size="18" fill="#999" letter-spacing="4">BEATS · BITWRAP · IO</text>
    {{- else -}}
    <text x="70" y="140" font-size="72" font-weight="800" fill="{{.Color}}" letter-spacing="-2">{{svgEscape .GenreUpper}}</text>
    <text x="70" y="200" font-size="22" fill="#999" letter-spacing="4">BEATS · BITWRAP · IO</text>
    {{- end}}

    <g font-family="ui-monospace, SFMono-Regular, monospace">
      <text x="70" y="290" font-size="28" fill="#888">TEMPO</text>
      <text x="70" y="340" font-size="56" font-weight="700" fill="#eee">{{.Tempo}}<tspan font-size="28" fill="#888"> BPM</tspan></text>

      <text x="70" y="410" font-size="18" fill="#888">SEED</text>
      <text x="70" y="440" font-size="28" fill="#ccc">{{.Seed}}</text>

      <text x="340" y="410" font-size="18" fill="#888">KEY · BARS</text>
      <text x="340" y="440" font-size="28" fill="#ccc">{{if .Key}}{{.Key}}{{else}}&#8212;{{end}} · {{svgEscape .Mode}}</text>
    </g>
  </g>

  <!-- Right panel: per-genre Petri-flavoured artwork -->
  <g stroke="{{.Color}}" stroke-width="2" fill="none" opacity="0.4">
    {{- range .Art.Rings}}
    <circle cx="{{printf "%.1f" .Cx}}" cy="{{printf "%.1f" .Cy}}" r="{{printf "%.1f" .R}}"/>
    {{- end}}
  </g>
  <g stroke="{{.Color}}" stroke-width="2" fill="none" opacity="0.55">
    {{- range .Art.Polylines}}
    <polyline points="{{range .Pts}}{{printf "%.1f,%.1f " .X .Y}}{{end}}{{if .Closed}}{{with index .Pts 0}}{{printf "%.1f,%.1f" .X .Y}}{{end}}{{end}}"/>
    {{- end}}
  </g>
  <g>
    {{- range .Art.Glyphs}}
    {{- if .Square -}}
      {{if .Filled}}<rect x="{{printf "%.1f" (sub .X .R)}}" y="{{printf "%.1f" (sub .Y .R)}}" width="{{printf "%.1f" (mul .R 2.0)}}" height="{{printf "%.1f" (mul .R 2.0)}}" fill="{{$.Color}}"/>
      {{else}}<rect x="{{printf "%.1f" (sub .X .R)}}" y="{{printf "%.1f" (sub .Y .R)}}" width="{{printf "%.1f" (mul .R 2.0)}}" height="{{printf "%.1f" (mul .R 2.0)}}" fill="none" stroke="{{$.Color}}" stroke-width="2" opacity="0.5"/>{{end}}
    {{- else -}}
      {{if .Filled}}<circle cx="{{printf "%.1f" .X}}" cy="{{printf "%.1f" .Y}}" r="{{printf "%.1f" .R}}" fill="{{$.Color}}"/>
      {{else}}<circle cx="{{printf "%.1f" .X}}" cy="{{printf "%.1f" .Y}}" r="{{printf "%.1f" .R}}" fill="none" stroke="{{$.Color}}" stroke-width="2" opacity="0.5"/>{{end}}
    {{- end}}
    {{- end}}
  </g>
  {{if .QRDataURL}}<image href="{{.QRDataURL}}" x="900" y="215" width="200" height="200" preserveAspectRatio="xMidYMid meet"/>{{end}}

  <!-- Footer strip: CID -->
  <rect x="0" y="570" width="1200" height="60" fill="#000" opacity="0.4"/>
  <text x="70" y="610" font-family="ui-monospace, monospace" font-size="18" fill="#777">{{.CID}}</text>
  <text x="1130" y="610" font-family="system-ui, sans-serif" font-size="18" fill="#888" text-anchor="end">open in a browser to play →</text>
</svg>`


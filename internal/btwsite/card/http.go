package card

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"html"
	"html/template"
	"net/http"
	"strings"
	"time"

	"beats-bitwrap-io/internal/btw"
	"beats-bitwrap-io/internal/btwsite/api"
)

// Mount registers the card routes on mux:
//
//	GET /c/<cid>            the link-preview page of a stored program or example (HTML with og:/twitter: tags)
//	GET /c/<cid>.<packed>   the same, stateless: the path carries the program as a share link does
//	GET /p/<cid>            the CID-only short link: the same page and card, and a person is sent to /#<cid>,
//	                        which fetches the program from the store and checks it against the CID
//	GET /card/<cid>.png     1200x630 card            GET /card/<cid>.square.png   1080x1080
//	GET /card/<cid>.<packed>.png (and .square.png): stateless, for the page of a link whose program is not stored
//	GET /card/default.png   the generic card         GET /card/go.js   the one-line redirect script the pages use
func (s *Service) Mount(mux *http.ServeMux) {
	mux.HandleFunc("GET /c/", s.ServePage)
	mux.HandleFunc("GET /p/{cid}", s.ServePage)
	mux.HandleFunc("GET /card/", s.ServeCard)
}

const (
	cacheImmutable = "public, max-age=31536000, immutable"
	cachePage      = "public, max-age=3600"
	cacheShort     = "public, max-age=300"
)

// ---- /card/ ------------------------------------------------------------------------------------------------------

// ServeCard answers /card/....
func (s *Service) ServeCard(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/card/")
	if name == "go.js" {
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = w.Write([]byte(goJS))
		return
	}
	if !strings.HasSuffix(name, ".png") {
		http.NotFound(w, r)
		return
	}
	name = strings.TrimSuffix(name, ".png")
	v := Wide
	if strings.HasSuffix(name, ".square") {
		v, name = Square, strings.TrimSuffix(name, ".square")
	}
	if name == "default" {
		s.serveGenericPNG(w, r, v, "default", "public, max-age=86400", false)
		return
	}
	cid, packed, _ := strings.Cut(name, ".")
	ctx, cancel := context.WithTimeout(withAddr(r.Context(), api.ClientIP(r)), 60*time.Second)
	defer cancel()
	p, err := s.resolve(ctx, cid, packed)
	if err != nil {
		s.unavailable(w, err)
		return
	}
	if st := p.state(); st != stOK {
		s.serveGenericPNG(w, r, v, stateName(st), cacheShort, noIndex(st))
		return
	}
	data, err := s.draw(ctx, p, v)
	if err != nil {
		s.unavailable(w, err)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "image/png")
	h.Set("Cache-Control", cacheImmutable)
	h.Set("ETag", s.etag(p, v))
	h.Set("X-Btw-Card", "program")
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(data))
}

func (s *Service) serveGenericPNG(w http.ResponseWriter, r *http.Request, v Variant, reason, cache string, noidx bool) {
	data, err := s.Generic(v)
	if err != nil {
		http.Error(w, "card unavailable", http.StatusInternalServerError)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "image/png")
	h.Set("Cache-Control", cache)
	h.Set("ETag", `"default-`+v.String()+`-v`+version+`"`)
	h.Set("X-Btw-Card", "generic; reason="+reason)
	if noidx {
		h.Set("X-Robots-Tag", "noindex")
	}
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(data))
}

// unavailable answers an infrastructure failure (the checker is down, the request gave up): 503, never cached.
func (s *Service) unavailable(w http.ResponseWriter, err error) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Retry-After", "30")
	var ae *api.Error
	if errors.As(err, &ae) && ae.Status != 0 {
		if ae.RetryAfter > 0 {
			w.Header().Set("Retry-After", fmt.Sprint(ae.RetryAfter))
		}
		http.Error(w, ae.Message, ae.Status)
		return
	}
	http.Error(w, "card unavailable, try again shortly", http.StatusServiceUnavailable)
}

func stateName(st state) string {
	switch st {
	case stUnknown:
		return "unknown"
	case stMismatch:
		return "mismatch"
	case stRestricted:
		return "restricted"
	case stPrivate:
		return "private"
	case stInvalid:
		return "invalid"
	}
	return "ok"
}

// noIndex: these get a noindex header and tag (an unknown CID may be stored tomorrow, so it does not).
func noIndex(st state) bool { return st != stOK && st != stUnknown }

// goJS sends a human to the link the page names; crawlers never run it.
const goJS = `(function () {
  var a = document.getElementById('open');
  var h = a && a.getAttribute('href');
  if (h) { location.replace(h); }
})();
`

// ---- /c/ ----------------------------------------------------------------------------------------------------------

type pageData struct {
	Title, Desc, URL, Image, Alt, Open string
	OGType                             string
	NoIndex                            bool
	Width, Height                      int
}

const genericTitle = "BeatScript: write a whole track as text"
const genericDesc = "BeatScript is where you write whole music tracks as text, in btw, a small, deterministic music language. A program is its own link: the same text always has the same CID, and it plays in the browser."
const privateTitle = "a private btw program"
const privateDesc = "This btw program is private. BeatScript is where you write whole music tracks as text."

// origin is the site's https origin: Options.PublicURL, else what the request says.
func (s *Service) origin(r *http.Request) string {
	if s.o.PublicURL != "" {
		return s.o.PublicURL
	}
	scheme := "https"
	if r.TLS == nil && r.Header.Get("X-Forwarded-Proto") != "https" {
		scheme = "http"
	}
	return scheme + "://" + r.Host
}

// ServePage answers /c/<cid>, /c/<cid>.<packed> and /p/<cid> (the short link: CID only, nothing packed).
func (s *Service) ServePage(w http.ResponseWriter, r *http.Request) {
	short := strings.HasPrefix(r.URL.Path, "/p/")
	name := strings.TrimSuffix(strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, "/c/"), "/p/"), "/")
	cid, packed, _ := strings.Cut(name, ".")
	if short && (packed != "" || !validCID(cid)) {
		http.NotFound(w, r)
		return
	}
	origin := s.origin(r)
	ctx, cancel := context.WithTimeout(withAddr(r.Context(), api.ClientIP(r)), 60*time.Second)
	defer cancel()
	p, err := s.resolve(ctx, cid, packed)
	if err != nil {
		s.unavailable(w, err)
		return
	}
	d := pageData{OGType: "website", Image: origin + "/card/default.png", Width: 1200, Height: 630, URL: origin + "/", Open: "/",
		Alt: "BeatScript: a few lines of code on a dark stage, over a strip of song sections"}
	cache := cachePage
	switch st := p.state(); st {
	case stOK:
		d.OGType = "music.song"
		s.programPage(&d, p, origin, packed)
		if short { // the address bar keeps the CID: the page opens it by fetching, not from a copy of the text in the URL
			d.URL, d.Open = origin+"/p/"+p.cid, "/#"+p.cid
		}
	case stPrivate, stRestricted:
		d.Title, d.Desc = privateTitle, privateDesc
	case stUnknown:
		d.Title, d.Desc = genericTitle, genericDesc
		if validCID(cid) {
			d.URL, d.Open = origin+"/c/"+cid, "/#"+cid
			if short {
				d.URL = origin + "/p/" + cid
			}
		}
		cache = cacheShort
	default:
		d.Title, d.Desc = genericTitle, genericDesc
	}
	if st := p.state(); noIndex(st) {
		d.NoIndex = true
		w.Header().Set("X-Robots-Tag", "noindex")
	}
	var buf bytes.Buffer
	if err := pageTpl.Execute(&buf, d); err != nil {
		http.Error(w, "page error", http.StatusInternalServerError)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", cache)
	h.Set("X-Btw-Card", stateName(p.state()))
	_, _ = w.Write(buf.Bytes())
}

// programPage fills the page of a public program.
func (s *Service) programPage(d *pageData, p *prog, origin, reqPacked string) {
	rep := p.report
	name := p.name()
	parts := []string{name}
	if rep.Key != "" {
		parts = append(parts, cleanText(rep.Key, 24))
	}
	if rep.Tempo != nil {
		parts = append(parts, fmtBPM(*rep.Tempo)+" BPM")
	}
	if rep.SongBars > 0 {
		parts = append(parts, fmt.Sprintf("%d bars", rep.SongBars))
	}
	d.Title = strings.Join(parts, " · ")

	switch {
	case p.desc != "":
		d.Desc = p.desc
	case cleanText(p.exDesc, 200) != "":
		d.Desc = cleanText(p.exDesc, 200)
	default:
		n := strings.Count(strings.TrimRight(p.canonical, "\n"), "\n") + 1
		d.Desc = fmt.Sprintf("a track in %d lines of btw", n)
	}

	// The image: the stored/example program's card by CID; a link whose program is not ours carries its text.
	img := origin + "/card/" + p.cid
	if !p.known && reqPacked != "" {
		img += "." + reqPacked
	}
	d.Image = img + ".png"
	d.Alt = cleanText(fmt.Sprintf("Share card for %s: code from the program over its section timeline; %s", name, strings.Join(parts[1:], ", ")), 240)

	pk := p.packed
	if pk == "" {
		pk = btw.Pack(p.canonical)
	}
	d.URL = origin + "/#" + p.cid + "." + pk
	d.Open = "/#" + p.cid + "." + pk
}

var pageTpl = template.Must(template.New("page").Parse(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{.Title}}</title>
<meta name="description" content="{{.Desc}}">
{{if .NoIndex}}<meta name="robots" content="noindex">
{{end}}<link rel="canonical" href="{{.URL}}">
<meta property="og:type" content="{{.OGType}}">
<meta property="og:site_name" content="BeatScript">
<meta property="og:title" content="{{.Title}}">
<meta property="og:description" content="{{.Desc}}">
<meta property="og:url" content="{{.URL}}">
<meta property="og:image" content="{{.Image}}">
<meta property="og:image:secure_url" content="{{.Image}}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="{{.Width}}">
<meta property="og:image:height" content="{{.Height}}">
<meta property="og:image:alt" content="{{.Alt}}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{{.Title}}">
<meta name="twitter:description" content="{{.Desc}}">
<meta name="twitter:image" content="{{.Image}}">
<meta name="twitter:image:alt" content="{{.Alt}}">
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#070b12;color:#e6ecf5;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{width:min(92vw,720px);padding:24px 0}
img{display:block;width:100%;height:auto;border-radius:12px;border:1px solid #1d2a42}
h1{font-size:1.25rem;margin:18px 0 4px}
p{margin:4px 0;color:#8d9bb5}
a.open{display:inline-block;margin-top:10px;color:#5eead4;text-decoration:none;font-weight:600}
a.open:hover{text-decoration:underline}
</style>
</head>
<body>
<main>
<a href="{{.Open}}"><img src="{{.Image}}" width="{{.Width}}" height="{{.Height}}" alt="{{.Alt}}"></a>
<h1>{{.Title}}</h1>
<p>{{.Desc}}</p>
<p><a id="open" class="open" href="{{.Open}}">Open in BeatScript &rarr;</a></p>
<noscript><p>JavaScript is off: <a href="{{.Open}}">open this in BeatScript</a>.</p></noscript>
</main>
<script src="/card/go.js" defer></script>
</body>
</html>
`))

// ---- generic tags for the site's own pages -------------------------------------------------------------------------

// GenericMeta is the generic share-card meta tags (og:, twitter:, description, canonical) as an HTML fragment for
// the site's static pages (/ and /p): origin is the site's origin, https://btw.bitwrap.io.
func GenericMeta(origin string) string { return GenericMetaAt(origin, "/") }

// GenericMetaAt is GenericMeta for a page at path (the canonical URL and og:url become origin+path).
func GenericMetaAt(origin, path string) string {
	origin = strings.TrimRight(origin, "/")
	if path == "" {
		path = "/"
	}
	e := html.EscapeString
	img := origin + "/card/default.png"
	var b strings.Builder
	w := func(format string, a ...any) { fmt.Fprintf(&b, format+"\n", a...) }
	w(`<meta name="description" content="%s">`, e(genericDesc))
	w(`<link rel="canonical" href="%s">`, e(origin+path))
	w(`<meta property="og:type" content="website">`)
	w(`<meta property="og:site_name" content="BeatScript">`)
	w(`<meta property="og:title" content="%s">`, e(genericTitle))
	w(`<meta property="og:description" content="%s">`, e(genericDesc))
	w(`<meta property="og:url" content="%s">`, e(origin+path))
	w(`<meta property="og:image" content="%s">`, e(img))
	w(`<meta property="og:image:secure_url" content="%s">`, e(img))
	w(`<meta property="og:image:type" content="image/png">`)
	w(`<meta property="og:image:width" content="1200">`)
	w(`<meta property="og:image:height" content="630">`)
	w(`<meta property="og:image:alt" content="%s">`, e("BeatScript: a few lines of code on a dark stage, over a strip of song sections"))
	w(`<meta name="twitter:card" content="summary_large_image">`)
	w(`<meta name="twitter:title" content="%s">`, e(genericTitle))
	w(`<meta name="twitter:description" content="%s">`, e(genericDesc))
	w(`<meta name="twitter:image" content="%s">`, e(img))
	return b.String()
}

// GenericMeta is GenericMeta for the service's own origin.
func (s *Service) GenericMeta() string { return GenericMeta(s.o.PublicURL) }

// CardMetaMarker is the comment a static page carries where its generic tags go: InjectGeneric replaces it
// (or, without it, inserts them before </head>).
const CardMetaMarker = "<!-- btw:card-meta -->"

// InjectGeneric puts GenericMetaAt(origin, path) into an HTML document: in place of CardMetaMarker when the page
// has it, else before </head>. A document that already has an og:image tag is returned as it is.
func InjectGeneric(doc []byte, origin, path string) []byte {
	frag := []byte(GenericMetaAt(origin, path))
	if i := bytes.Index(doc, []byte(CardMetaMarker)); i >= 0 {
		out := append([]byte{}, doc[:i]...)
		out = append(out, frag...)
		return append(out, doc[i+len(CardMetaMarker):]...)
	}
	if bytes.Contains(doc, []byte(`property="og:image"`)) {
		return doc
	}
	if i := bytes.Index(doc, []byte("</head>")); i >= 0 {
		out := append([]byte{}, doc[:i]...)
		out = append(out, frag...)
		return append(out, doc[i:]...)
	}
	return doc
}

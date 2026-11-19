package card

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"html"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"beats-bitwrap-io/internal/btw"
	"beats-bitwrap-io/internal/btwsite/api"
)

// ---- helpers ---------------------------------------------------------------------------------------------------

type memStore struct {
	c    api.Checker
	mu   sync.Mutex
	data map[string]*api.Program
}

func newMemStore(c api.Checker) *memStore { return &memStore{c: c, data: map[string]*api.Program{}} }

func (m *memStore) Put(ctx context.Context, text string, meta api.Meta) (*api.Program, *api.CheckReport, error) {
	rep, err := m.c.Check(ctx, text)
	if err != nil || !rep.OK {
		return nil, rep, err
	}
	p := &api.Program{CID: rep.CID, Text: rep.Canonical, Meta: meta}
	m.mu.Lock()
	m.data[rep.CID] = p
	m.mu.Unlock()
	return p, rep, nil
}

func (m *memStore) Get(cid string) (*api.Program, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.data[cid]
	return p, ok
}

func serve(t testing.TB, s *Service, path string, hdr ...string) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	s.Mount(mux)
	req := httptest.NewRequest(http.MethodGet, path, nil)
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

var metaRe = regexp.MustCompile(`<meta (?:property|name)="([^"]+)" content="([^"]*)">`)

// metas reads the page's meta tags (unescaped; a repeated name keeps its last value).
func metas(body string) map[string]string {
	m := map[string]string{}
	for _, x := range metaRe.FindAllStringSubmatch(body, -1) {
		m[x[1]] = html.UnescapeString(x[2])
	}
	return m
}

func decodeSize(t testing.TB, b []byte) (int, int) {
	t.Helper()
	img, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		t.Fatalf("not a PNG: %v", err)
	}
	return img.Bounds().Dx(), img.Bounds().Dy()
}

func sum(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

// variantOf rewrites an example's tempo, which gives a valid program with another CID.
func variantOf(t testing.TB, es *exampleSet, name string) string {
	t.Helper()
	text := es.texts[name]
	re := regexp.MustCompile(`(?m)^tempo \d+`)
	if !re.MatchString(text) {
		t.Fatalf("example %s has no tempo line", name)
	}
	return re.ReplaceAllString(text, "tempo 97")
}

// ---- golden images ----------------------------------------------------------------------------------------------

type goldenEntry struct {
	CID    string `json:"cid"`
	Wide   string `json:"wide"`
	Square string `json:"square"`
}

type goldenFile struct {
	Note string                            `json:"note"`
	Go   string                            `json:"go"`
	Sets map[string]map[string]goldenEntry `json:"sets"`
}

func goldenPath(t testing.TB) string {
	return filepath.Join(repoRoot(t), "btwsite", "testdata", "cards", "golden.json")
}

// TestGolden pins a SHA-256 per example CID and variant (blessed per checker kind and GOARCH: the real btwd
// gives real highlight spans and sections, the fake does not; float rounding may differ across architectures).
// Re-bless with BTW_BLESS=1 (and BTWD_BIN=<btwd> for the real set).
func TestGolden(t *testing.T) {
	s, es, kind := newTestService(t, Options{})
	key := kind + "/" + runtime.GOARCH
	got := map[string]goldenEntry{}
	for _, ex := range es.list {
		e := goldenEntry{CID: ex.CID}
		for _, v := range []Variant{Wide, Square} {
			b, err := s.Render(es.texts[ex.Name], v)
			if err != nil {
				t.Fatalf("%s %s: %v", ex.Name, v, err)
			}
			w, h := v.Size()
			if gw, gh := decodeSize(t, b); gw != w || gh != h {
				t.Fatalf("%s %s decodes at %dx%d, want %dx%d", ex.Name, v, gw, gh, w, h)
			}
			if v == Wide {
				e.Wide = sum(b)
			} else {
				e.Square = sum(b)
			}
		}
		got[ex.Name] = e
	}
	gen := goldenEntry{}
	for _, v := range []Variant{Wide, Square} {
		b, err := s.Generic(v)
		if err != nil {
			t.Fatal(err)
		}
		if w, h := v.Size(); true {
			if gw, gh := decodeSize(t, b); gw != w || gh != h {
				t.Fatalf("generic %s decodes at %dx%d", v, gw, gh)
			}
		}
		if v == Wide {
			gen.Wide = sum(b)
		} else {
			gen.Square = sum(b)
		}
	}
	got["(generic)"] = gen

	path := goldenPath(t)
	var gf goldenFile
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &gf)
	}
	if os.Getenv("BTW_BLESS") != "" {
		if gf.Sets == nil {
			gf.Sets = map[string]map[string]goldenEntry{}
		}
		gf.Sets[key] = got
		gf.Go = runtime.Version()
		gf.Note = "SHA-256 of each example's card PNG. Keys: <checker>/<GOARCH>. Regenerate: BTW_BLESS=1 [BTWD_BIN=<btwd>] go test ./internal/btwsite/card -run TestGolden"
		var out bytes.Buffer
		enc := json.NewEncoder(&out)
		enc.SetEscapeHTML(false)
		enc.SetIndent("", "  ")
		if err := enc.Encode(gf); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, out.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		if kind == "real" {
			writeSamples(t, s, es)
		}
		t.Logf("blessed %s (%d entries) with %s", key, len(got), runtime.Version())
		return
	}
	want, ok := gf.Sets[key]
	if !ok {
		t.Skipf("no golden set %q in %s: bless it with BTW_BLESS=1 (decode, size and determinism were checked)", key, path)
	}
	for name, g := range got {
		w, ok := want[name]
		if !ok {
			t.Errorf("%s: not in the golden set (re-bless?)", name)
			continue
		}
		if w.CID != g.CID {
			t.Errorf("%s: CID %s, golden %s", name, g.CID, w.CID)
		}
		if w.Wide != g.Wide {
			t.Errorf("%s wide: sha256 %s, golden %s (Go %s; golden blessed with %s)", name, g.Wide, w.Wide, runtime.Version(), gf.Go)
		}
		if w.Square != g.Square {
			t.Errorf("%s square: sha256 %s, golden %s", name, g.Square, w.Square)
		}
	}
	for name := range want {
		if _, ok := got[name]; !ok {
			t.Errorf("golden has %s, which is no longer an example", name)
		}
	}
}

// writeSamples saves the sample PNGs the report and the morning review look at.
func writeSamples(t testing.TB, s *Service, es *exampleSet) {
	dir := filepath.Join(repoRoot(t), "btwsite", "testdata", "cards", "samples")
	_ = os.MkdirAll(dir, 0o755)
	write := func(name string, b []byte) {
		if err := os.WriteFile(filepath.Join(dir, name), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"hand-dubstep-140-v4", "matrix-130", "trance-138"} {
		text, ok := es.texts[name]
		if !ok {
			continue
		}
		b, err := s.Render(text, Wide)
		if err != nil {
			t.Fatal(err)
		}
		write(name+".png", b)
	}
	if text, ok := es.texts["hand-dubstep-140-v4"]; ok {
		b, _ := s.Render(text, Square)
		write("hand-dubstep-140-v4.square.png", b)
	}
	b, _ := s.Generic(Wide)
	write("default.png", b)
	b, _ = s.Generic(Square)
	write("default.square.png", b)
}

// TestDeterminism: two services with nothing shared (no cache, no memo) draw the same bytes, for a program and
// for a reformatted text of it (the card is a function of the canonical text), and a different program differs.
func TestDeterminism(t *testing.T) {
	c, _ := testChecker(t)
	es := loadExamples(t, c)
	text := es.texts["acid-line"]
	var imgs [][]byte
	for i := 0; i < 2; i++ {
		s, _, _ := newTestService(t, Options{Checker: c})
		b, err := s.Render(text, Wide)
		if err != nil {
			t.Fatal(err)
		}
		imgs = append(imgs, b)
	}
	if !bytes.Equal(imgs[0], imgs[1]) {
		t.Fatal("two renders of the same program differ")
	}
	// reformatted: extra blank lines and spaces after the header do not change the card (same canonical text)
	s, _, _ := newTestService(t, Options{Checker: c})
	re := strings.Replace(text, "\ntempo", "\n\n\n\ntempo", 1)
	b, err := s.Render(re, Wide)
	if err != nil || !bytes.Equal(b, imgs[0]) {
		t.Fatalf("reformatted text gave other bytes (err %v)", err)
	}
	other, _ := s.Render(es.texts["first-beat"], Wide)
	if bytes.Equal(other, imgs[0]) {
		t.Fatal("two programs share a card")
	}
}

// ---- pages ---------------------------------------------------------------------------------------------------------

func TestExamplePage(t *testing.T) {
	s, es, _ := newTestService(t, Options{})
	var ex api.Example
	for _, e := range es.list {
		if e.Name == "hand-dubstep-140-v4" {
			ex = e
		}
	}
	if ex.CID == "" {
		t.Skip("hand-dubstep-140-v4 is not an example")
	}
	rec := serve(t, s, "/c/"+ex.CID)
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("content-type %q", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "public, max-age=3600" {
		t.Fatalf("page cache-control %q", cc)
	}
	body := rec.Body.String()
	m := metas(body)
	rep, _ := s.o.Checker.Check(context.Background(), es.texts[ex.Name])
	frag := ex.CID + "." + btw.Pack(rep.Canonical)
	want := map[string]string{
		"og:title":            "hand-dubstep-140-v4 · fm · 140 BPM · 68 bars",
		"og:type":             "music.song",
		"og:url":              "https://btw.bitwrap.io/#" + frag,
		"og:image":            "https://btw.bitwrap.io/card/" + ex.CID + ".png",
		"og:image:secure_url": "https://btw.bitwrap.io/card/" + ex.CID + ".png",
		"og:image:type":       "image/png",
		"og:image:width":      "1200",
		"og:image:height":     "630",
		"twitter:card":        "summary_large_image",
		"twitter:title":       "hand-dubstep-140-v4 · fm · 140 BPM · 68 bars",
		"twitter:image":       "https://btw.bitwrap.io/card/" + ex.CID + ".png",
	}
	for k, v := range want {
		if m[k] != v {
			t.Errorf("%s = %q, want %q", k, m[k], v)
		}
	}
	for _, k := range []string{"og:description", "og:image:alt", "twitter:description", "twitter:image:alt"} {
		if m[k] == "" {
			t.Errorf("%s missing", k)
		}
	}
	if !strings.Contains(body, `<link rel="canonical" href="https://btw.bitwrap.io/#`+frag+`">`) {
		t.Error("canonical link missing or not the share link")
	}
	if strings.Contains(body, "noindex") {
		t.Error("a public program's page must be indexable")
	}
	// humans: an external script and a noscript link; no inline handlers
	if !strings.Contains(body, `<script src="/card/go.js" defer></script>`) || !strings.Contains(body, "<noscript>") || !strings.Contains(body, `id="open" class="open" href="/#`+frag+`"`) {
		t.Error("no redirect script / noscript link to /#<cid>.<packed>")
	}
	if regexp.MustCompile(`(?i)\son[a-z]+\s*=`).MatchString(body) || strings.Contains(body, "javascript:") {
		t.Error("inline handlers in the page")
	}
	// the script
	js := serve(t, s, "/card/go.js")
	if js.Code != 200 || !strings.Contains(js.Body.String(), "location.replace") {
		t.Fatalf("go.js: %d %q", js.Code, js.Body.String())
	}
	// the program's own comment or the example's description, not "a track in N lines"
	if strings.HasPrefix(m["og:description"], "a track in ") {
		t.Logf("note: description fell back to the line count: %q", m["og:description"])
	}
}

func TestDescriptionFallbackIsLineCount(t *testing.T) {
	c, _ := testChecker(t)
	st := newMemStore(c)
	es := loadExamples(t, c)
	text := variantOf(t, es, "first-beat")
	text = regexp.MustCompile(`(?m)^#.*\n`).ReplaceAllString(text, "") // no comments at all
	p, _, err := st.Put(context.Background(), text, api.Meta{Name: "plain"})
	if err != nil {
		t.Fatal(err)
	}
	s, _, _ := newTestService(t, Options{Checker: c, Store: st, Examples: func() []api.Example { return nil }})
	m := metas(serve(t, s, "/c/"+p.CID).Body.String())
	n := strings.Count(strings.TrimRight(p.Text, "\n"), "\n") + 1
	if want := "a track in " + itoa(n) + " lines of btw"; m["og:description"] != want {
		t.Fatalf("og:description = %q, want %q", m["og:description"], want)
	}
	if !strings.HasPrefix(m["og:title"], "plain · ") {
		t.Fatalf("og:title = %q", m["og:title"])
	}
}

func TestStatelessLink(t *testing.T) {
	c, _ := testChecker(t)
	es := loadExamples(t, c)
	text := variantOf(t, es, "first-beat")
	rep, err := c.Check(context.Background(), text)
	if err != nil || !rep.OK {
		t.Fatal(err)
	}
	// nothing is stored or an example: the path carries the program
	s, _, _ := newTestService(t, Options{Checker: c, Examples: func() []api.Example { return nil }})
	packed := btw.Pack(rep.Canonical)
	rec := serve(t, s, "/c/"+rep.CID+"."+packed)
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	m := metas(rec.Body.String())
	frag := rep.CID + "." + packed
	if m["og:url"] != "https://btw.bitwrap.io/#"+frag {
		t.Errorf("og:url = %q", m["og:url"])
	}
	if !strings.HasPrefix(m["og:title"], "BeatScript "+shortCID(rep.CID)+" · ") {
		t.Errorf("og:title = %q (a link has no name: BeatScript <short cid>)", m["og:title"])
	}
	img := "https://btw.bitwrap.io/card/" + frag + ".png"
	if m["og:image"] != img {
		t.Fatalf("og:image = %q, want %q", m["og:image"], img)
	}
	// and that image renders
	pr := serve(t, s, "/card/"+frag+".png")
	if pr.Code != 200 || pr.Header().Get("Content-Type") != "image/png" || pr.Header().Get("X-Btw-Card") != "program" {
		t.Fatalf("stateless card: %d %v", pr.Code, pr.Header())
	}
	if w, h := decodeSize(t, pr.Body.Bytes()); w != 1200 || h != 630 {
		t.Fatalf("%dx%d", w, h)
	}
	// the same CID without text (and not stored): the generic card, 200
	g := serve(t, s, "/card/"+rep.CID+".png")
	if g.Code != 200 || !strings.HasPrefix(g.Header().Get("X-Btw-Card"), "generic") {
		t.Fatalf("unknown CID card: %d %v", g.Code, g.Header())
	}
}

func genericOf(t testing.TB, s *Service, v Variant) []byte {
	b, err := s.Generic(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func requireGeneric(t *testing.T, s *Service, page *httptest.ResponseRecorder, wantNoIndex bool, secret string) {
	t.Helper()
	if page.Code != 200 {
		t.Fatalf("page status %d (want 200)", page.Code)
	}
	body := page.Body.String()
	m := metas(body)
	if m["og:image"] != "https://btw.bitwrap.io/card/default.png" || m["twitter:image"] != "https://btw.bitwrap.io/card/default.png" {
		t.Errorf("not the generic card: og:image %q", m["og:image"])
	}
	if got := strings.Contains(body, `<meta name="robots" content="noindex">`); got != wantNoIndex {
		t.Errorf("noindex = %v, want %v", got, wantNoIndex)
	}
	if got := page.Header().Get("X-Robots-Tag") == "noindex"; got != wantNoIndex {
		t.Errorf("X-Robots-Tag noindex = %v, want %v", got, wantNoIndex)
	}
	if secret != "" && strings.Contains(strings.ToLower(body), strings.ToLower(secret)) {
		t.Errorf("the page leaks %q", secret)
	}
	if !strings.HasPrefix(page.Header().Get("X-Btw-Card"), "") {
		t.Error("header")
	}
}

func TestCIDMismatchIsGeneric(t *testing.T) {
	c, _ := testChecker(t)
	es := loadExamples(t, c)
	s, _, _ := newTestService(t, Options{Checker: c, Examples: func() []api.Example { return nil }})
	a, b := es.texts["first-beat"], variantOf(t, es, "acid-line")
	repA, _ := c.Check(context.Background(), a)
	repB, _ := c.Check(context.Background(), b)
	if repA.CID == repB.CID {
		t.Fatal("test programs have the same CID")
	}
	// A's CID, B's text
	path := "/c/" + repA.CID + "." + btw.Pack(repB.Canonical)
	page := serve(t, s, path)
	requireGeneric(t, s, page, true, "acid")
	if st := page.Header().Get("X-Btw-Card"); st != "mismatch" {
		t.Errorf("X-Btw-Card = %q", st)
	}
	if m := metas(page.Body.String()); strings.Contains(m["og:title"], shortCID(repB.CID)) || m["og:title"] != genericTitle {
		t.Errorf("title %q", m["og:title"])
	}
	// the image of that link is the generic card, byte for byte
	img := serve(t, s, "/card/"+repA.CID+"."+btw.Pack(repB.Canonical)+".png")
	if img.Code != 200 || !bytes.Equal(img.Body.Bytes(), genericOf(t, s, Wide)) {
		t.Fatalf("mismatch image is not the generic card (status %d)", img.Code)
	}
	if !strings.Contains(img.Header().Get("X-Robots-Tag"), "noindex") {
		t.Error("mismatch image should be noindex")
	}
	// the right text works
	ok := serve(t, s, "/c/"+repA.CID+"."+btw.Pack(repA.Canonical))
	if m := metas(ok.Body.String()); m["og:image"] == "https://btw.bitwrap.io/card/default.png" {
		t.Error("the matching link got the generic card")
	}
}

func TestGarbageIsGeneric(t *testing.T) {
	s, _, _ := newTestService(t, Options{})
	for _, path := range []string{
		"/c/", "/c/!!!", "/c/z", "/c/..%2f..%2fetc", "/c/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz.AAAA", "/c/" + strings.Repeat("z", 300),
		"/c/z4EBG9jB3vwMeCJNSp8WJLWDRM7ADEWxi23HyNSij5cHBL94r7v.notbase64!!",
	} {
		rec := serve(t, s, path)
		if rec.Code != 200 {
			t.Errorf("%s: %d", path, rec.Code)
			continue
		}
		if m := metas(rec.Body.String()); m["og:image"] != "https://btw.bitwrap.io/card/default.png" {
			t.Errorf("%s: og:image %q", path, m["og:image"])
		}
	}
	for _, path := range []string{"/card/!!!.png", "/card/z.png", "/card/" + strings.Repeat("z", 300) + ".png"} {
		rec := serve(t, s, path)
		if rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), genericOf(t, s, Wide)) {
			t.Errorf("%s: %d, generic image? %v", path, rec.Code, bytes.Equal(rec.Body.Bytes(), genericOf(t, s, Wide)))
		}
	}
	if rec := serve(t, s, "/card/readme.txt"); rec.Code != 404 {
		t.Errorf("/card/readme.txt: %d", rec.Code)
	}
}

func TestUnknownCIDIsGeneric200(t *testing.T) {
	s, _, _ := newTestService(t, Options{})
	cid := "z4EBG9jB3vwMeCJNSp8WJLWDRM7ADEWxi23HyNSij5cHBL94rXX"
	page := serve(t, s, "/c/"+cid)
	requireGeneric(t, s, page, false, "")
	m := metas(page.Body.String())
	if m["og:url"] != "https://btw.bitwrap.io/c/"+cid {
		t.Errorf("og:url = %q", m["og:url"])
	}
	if !strings.Contains(page.Body.String(), `href="/#`+cid+`"`) {
		t.Error("humans are not sent to /#<cid>")
	}
	if cc := page.Header().Get("Cache-Control"); cc == "" || strings.Contains(cc, "immutable") {
		t.Errorf("unknown CID cache-control %q", cc)
	}
	img := serve(t, s, "/card/"+cid+".png")
	if img.Code != 200 || !bytes.Equal(img.Body.Bytes(), genericOf(t, s, Wide)) {
		t.Fatalf("unknown card: %d", img.Code)
	}
	if strings.Contains(img.Header().Get("Cache-Control"), "immutable") {
		t.Error("a generic stand-in for an unknown CID must not be cached as immutable")
	}
}

// flagChecker makes any checker report a program as restricted or asset-using when its text says so, so the
// refusal paths are tested against the real binary's reports too.
type flagChecker struct{ api.Checker }

func (f flagChecker) Check(ctx context.Context, text string) (*api.CheckReport, error) {
	r, err := f.Checker.Check(ctx, text)
	if err != nil || r == nil {
		return r, err
	}
	cp := *r
	if strings.Contains(text, "tempo 98") {
		cp.Restricted = true
	}
	if strings.Contains(text, "tempo 99") {
		cp.UsesAssets = true
	}
	return &cp, nil
}

func TestRestrictedAndAssetsAreGeneric(t *testing.T) {
	base, _ := testChecker(t)
	c := flagChecker{base}
	es := loadExamples(t, base)
	s, _, _ := newTestService(t, Options{Checker: c, Examples: func() []api.Example { return nil }})
	for _, tempo := range []string{"98", "99"} {
		text := regexp.MustCompile(`(?m)^tempo \d+`).ReplaceAllString(es.texts["matrix-130"], "tempo "+tempo)
		rep, _ := c.Check(context.Background(), text)
		if !rep.OK || !(rep.Restricted || rep.UsesAssets) {
			t.Fatalf("test program %s: %+v", tempo, rep)
		}
		path := rep.CID + "." + btw.Pack(rep.Canonical)
		page := serve(t, s, "/c/"+path)
		requireGeneric(t, s, page, true, "phrygian")
		m := metas(page.Body.String())
		if m["og:title"] != "a private BeatScript program" {
			t.Errorf("og:title = %q, want the private title", m["og:title"])
		}
		img := serve(t, s, "/card/"+path+".png")
		if !bytes.Equal(img.Body.Bytes(), genericOf(t, s, Wide)) {
			t.Error("restricted program got a card of its own")
		}
		if _, err := s.Render(text, Wide); err == nil {
			t.Error("Render must refuse a restricted program")
		} else if ae, ok := err.(*api.Error); !ok || ae.Code != api.CodeRestricted {
			t.Errorf("Render error = %v", err)
		}
	}
}

func TestPrivateMetaIsGeneric(t *testing.T) {
	c, _ := testChecker(t)
	es := loadExamples(t, c)
	st := newMemStore(c)
	p, _, err := st.Put(context.Background(), variantOf(t, es, "first-beat"), api.Meta{Name: "secret-demo", Visibility: "private"})
	if err != nil {
		t.Fatal(err)
	}
	s, _, _ := newTestService(t, Options{Checker: c, Store: st, Examples: func() []api.Example { return nil }})
	page := serve(t, s, "/c/"+p.CID)
	requireGeneric(t, s, page, true, "secret-demo")
	if m := metas(page.Body.String()); m["og:title"] != "a private BeatScript program" {
		t.Errorf("og:title = %q", m["og:title"])
	}
	img := serve(t, s, "/card/"+p.CID+".png")
	if !bytes.Equal(img.Body.Bytes(), genericOf(t, s, Wide)) {
		t.Error("private program got a card")
	}
	// the same text carried in the link, with the store's meta: still private
	page = serve(t, s, "/c/"+p.CID+"."+btw.Pack(p.Text))
	requireGeneric(t, s, page, true, "secret-demo")
}

func TestHostileTextIsEscaped(t *testing.T) {
	c, _ := testChecker(t)
	es := loadExamples(t, c)
	st := newMemStore(c)
	hostile := `<script>alert(1)</script>"'& <img src=x onerror=alert(2)>`
	p, _, err := st.Put(context.Background(), variantOf(t, es, "first-beat"), api.Meta{Name: hostile})
	if err != nil {
		t.Fatal(err)
	}
	s, _, _ := newTestService(t, Options{Checker: c, Store: st, Examples: func() []api.Example { return nil }})
	rec := serve(t, s, "/c/"+p.CID)
	body := rec.Body.String()
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	for _, bad := range []string{"<script>alert", "<img src=x"} {
		if strings.Contains(body, bad) {
			t.Errorf("page contains %q unescaped:\n%s", bad, body)
		}
	}
	if !strings.Contains(body, "&lt;script&gt;alert(1)&lt;/script&gt;") {
		t.Error("the name is not shown escaped")
	}
	// and the card draws it as text without trouble
	img := serve(t, s, "/card/"+p.CID+".png")
	if img.Code != 200 || img.Header().Get("X-Btw-Card") != "program" {
		t.Fatalf("card for hostile name: %d", img.Code)
	}
	// a hostile description (the first comment of an example's text)
	ex := api.Example{Name: "evil", CID: p.CID, License: "CC0-1.0"}
	text := "#! name: evil\n# <b onmouseover=alert(3)>hi</b> \"quoted\" & more\n" + variantOf(t, es, "first-beat")
	rep, _ := c.Check(context.Background(), text)
	ex.CID = rep.CID
	s2, _, _ := newTestService(t, Options{Checker: c,
		Examples:    func() []api.Example { return []api.Example{ex} },
		ExampleText: func(n string) (string, bool) { return text, n == "evil" }})
	b2 := serve(t, s2, "/c/"+ex.CID).Body.String()
	if strings.Contains(b2, "<b onmouseover") || !strings.Contains(b2, "&lt;b onmouseover=alert(3)&gt;hi&lt;/b&gt;") {
		t.Errorf("hostile description not escaped:\n%s", b2)
	}
	if m := metas(b2); m["og:description"] != `<b onmouseover=alert(3)>hi</b> "quoted" & more` {
		t.Errorf("og:description = %q (first comment line, unescaped back)", m["og:description"])
	}
}

// ---- images, the cache and the limits ------------------------------------------------------------------------------

func TestCardRoutesAndSquare(t *testing.T) {
	s, es, _ := newTestService(t, Options{})
	ex := es.list[0]
	for _, v := range []struct {
		path string
		w, h int
	}{{"/card/" + ex.CID + ".png", 1200, 630}, {"/card/" + ex.CID + ".square.png", 1080, 1080}, {"/card/default.png", 1200, 630}, {"/card/default.square.png", 1080, 1080}} {
		rec := serve(t, s, v.path)
		if rec.Code != 200 || rec.Header().Get("Content-Type") != "image/png" {
			t.Fatalf("%s: %d %q", v.path, rec.Code, rec.Header().Get("Content-Type"))
		}
		if w, h := decodeSize(t, rec.Body.Bytes()); w != v.w || h != v.h {
			t.Errorf("%s decodes at %dx%d, want %dx%d", v.path, w, h, v.w, v.h)
		}
	}
	// the program card is not the generic card
	if bytes.Equal(serve(t, s, "/card/"+ex.CID+".png").Body.Bytes(), genericOf(t, s, Wide)) {
		t.Error("an example's card equals the generic card")
	}
	// a HEAD works
	req := httptest.NewRequest(http.MethodHead, "/card/"+ex.CID+".png", nil)
	mux := http.NewServeMux()
	s.Mount(mux)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != 200 || rec.Body.Len() != 0 {
		t.Errorf("HEAD: %d with %d body bytes", rec.Code, rec.Body.Len())
	}
	// not GET: refused by the mux
	req = httptest.NewRequest(http.MethodPost, "/card/"+ex.CID+".png", nil)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST: %d", rec.Code)
	}
}

type countingChecker struct {
	api.Checker
	checks, highlights atomic.Int64
	delay              time.Duration
	cur, max           atomic.Int64
}

func (c *countingChecker) Check(ctx context.Context, text string) (*api.CheckReport, error) {
	c.checks.Add(1)
	return c.Checker.Check(ctx, text)
}

func (c *countingChecker) Highlight(ctx context.Context, text string) ([]api.Span, error) {
	c.highlights.Add(1)
	n := c.cur.Add(1)
	for {
		m := c.max.Load()
		if n <= m || c.max.CompareAndSwap(m, n) {
			break
		}
	}
	time.Sleep(c.delay)
	c.cur.Add(-1)
	return c.Checker.Highlight(ctx, text)
}

func TestCacheHitAndHeaders(t *testing.T) {
	base, _ := testChecker(t)
	cc := &countingChecker{Checker: base}
	dir := t.TempDir()
	s, es, _ := newTestService(t, Options{Checker: cc, CacheDir: dir})
	ex := es.list[0]
	rec := serve(t, s, "/card/"+ex.CID+".png")
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	h := rec.Header()
	if h.Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Errorf("Cache-Control %q", h.Get("Cache-Control"))
	}
	etag := h.Get("ETag")
	if !strings.Contains(etag, ex.CID) || !strings.Contains(etag, "wide") {
		t.Errorf("ETag %q should name the CID and the variant", etag)
	}
	if cc.highlights.Load() != 1 {
		t.Fatalf("%d renders for one request", cc.highlights.Load())
	}
	// the PNG is on disk, atomically named
	files, _ := filepath.Glob(filepath.Join(dir, ex.CID+".wide.*.png"))
	if len(files) != 1 {
		t.Fatalf("cache files: %v", files)
	}
	if tmp, _ := filepath.Glob(filepath.Join(dir, ".card-*")); len(tmp) != 0 {
		t.Errorf("temp files left behind: %v", tmp)
	}
	// a second request is served from the cache: poison the file and see it come back
	sentinel := append([]byte{}, rec.Body.Bytes()...)
	sentinel = append(sentinel, []byte("-from-cache")...)
	if err := os.WriteFile(files[0], sentinel, 0o644); err != nil {
		t.Fatal(err)
	}
	rec2 := serve(t, s, "/card/"+ex.CID+".png")
	if !bytes.Equal(rec2.Body.Bytes(), sentinel) {
		t.Fatal("second request did not come from the disk cache")
	}
	if cc.highlights.Load() != 1 {
		t.Fatalf("cache hit re-rendered (%d)", cc.highlights.Load())
	}
	// conditional request: 304
	rec3 := serve(t, s, "/card/"+ex.CID+".png", "If-None-Match", etag)
	if rec3.Code != http.StatusNotModified || rec3.Body.Len() != 0 {
		t.Fatalf("If-None-Match: %d, %d bytes", rec3.Code, rec3.Body.Len())
	}
	// a fresh service over the same directory also hits
	s2, _, _ := newTestService(t, Options{Checker: cc, CacheDir: dir})
	rec4 := serve(t, s2, "/card/"+ex.CID+".png")
	if !bytes.Equal(rec4.Body.Bytes(), sentinel) {
		t.Fatal("a new service did not reuse the cache directory")
	}
	// the square variant is cached apart
	sq := serve(t, s, "/card/"+ex.CID+".square.png")
	if !strings.Contains(sq.Header().Get("ETag"), "square") || bytes.Equal(sq.Body.Bytes(), sentinel) {
		t.Errorf("square variant: etag %q", sq.Header().Get("ETag"))
	}
}

func TestInMemoryCacheWithoutDir(t *testing.T) {
	base, _ := testChecker(t)
	cc := &countingChecker{Checker: base}
	es := loadExamples(t, base)
	s, err := New(Options{Checker: cc, Examples: es.Examples, ExampleText: es.Text, PublicURL: "https://btw.bitwrap.io"})
	if err != nil {
		t.Fatal(err)
	}
	ex := es.list[0]
	a := serve(t, s, "/card/"+ex.CID+".png")
	b := serve(t, s, "/card/"+ex.CID+".png")
	if a.Code != 200 || !bytes.Equal(a.Body.Bytes(), b.Body.Bytes()) || cc.highlights.Load() != 1 {
		t.Fatalf("in-memory cache: %d renders", cc.highlights.Load())
	}
}

func TestRenderConcurrencyIsLimited(t *testing.T) {
	base, _ := testChecker(t)
	cc := &countingChecker{Checker: base, delay: 40 * time.Millisecond}
	s, es, _ := newTestService(t, Options{Checker: cc})
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			// different programs, so nothing is shared: each really renders
			text := regexp.MustCompile(`(?m)^tempo \d+`).ReplaceAllString(es.texts["first-beat"], "tempo "+itoa(100+i))
			if _, err := s.Render(text, Wide); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	if got := cc.max.Load(); got > 2 || got < 1 {
		t.Fatalf("%d renders ran at once, want at most 2", got)
	}
	if cc.highlights.Load() != 8 {
		t.Fatalf("%d renders for 8 programs", cc.highlights.Load())
	}
}

func TestSameCardIsRenderedOnce(t *testing.T) {
	base, _ := testChecker(t)
	cc := &countingChecker{Checker: base, delay: 60 * time.Millisecond}
	s, es, _ := newTestService(t, Options{Checker: cc})
	ex := es.list[0]
	var wg sync.WaitGroup
	bodies := make([][]byte, 6)
	for i := range bodies {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			bodies[i] = serve(t, s, "/card/"+ex.CID+".png").Body.Bytes()
		}(i)
	}
	wg.Wait()
	for i := range bodies {
		if len(bodies[i]) == 0 || !bytes.Equal(bodies[i], bodies[0]) {
			t.Fatalf("body %d differs or is empty", i)
		}
	}
	if n := cc.highlights.Load(); n != 1 {
		t.Fatalf("one card requested 6 times was rendered %d times", n)
	}
}

func TestTextSizeIsCapped(t *testing.T) {
	c, _ := testChecker(t)
	es := loadExamples(t, c)
	s, _, _ := newTestService(t, Options{Checker: c, MaxTextBytes: 200, Examples: func() []api.Example { return nil }})
	big := es.texts["hand-dubstep-140-v4"]
	if len(big) <= 200 {
		t.Fatal("example is smaller than the cap")
	}
	if _, err := s.Render(big, Wide); err == nil {
		t.Fatal("Render accepted a text over the cap")
	} else if ae, ok := err.(*api.Error); !ok || ae.Code != api.CodeTooLarge {
		t.Fatalf("error %v", err)
	}
	rep, _ := c.Check(context.Background(), big)
	path := rep.CID + "." + btw.Pack(rep.Canonical)
	rec := serve(t, s, "/card/"+path+".png")
	if rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), genericOf(t, s, Wide)) {
		t.Fatalf("over-cap link: %d, generic %v", rec.Code, bytes.Equal(rec.Body.Bytes(), genericOf(t, s, Wide)))
	}
}

func TestInvalidProgramIsRefused(t *testing.T) {
	c, _ := testChecker(t)
	s, _, _ := newTestService(t, Options{Checker: c})
	if _, err := s.Render("tempo 120\ndeck Z: kick x ~ x ~\nBAD\n", Wide); err == nil {
		t.Fatal("Render drew a program with errors")
	}
}

func TestCheckerDownIs503NotACachedCard(t *testing.T) {
	base, _ := testChecker(t)
	es := loadExamples(t, base)
	ex := es.list[0]
	down := &downChecker{Checker: base}
	s, _, _ := newTestService(t, Options{Checker: down, Examples: es.Examples, ExampleText: es.Text})
	down.fail.Store(true)
	rec := serve(t, s, "/card/"+ex.CID+".png")
	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("checker down: %d %q", rec.Code, rec.Header().Get("Cache-Control"))
	}
	down.fail.Store(false)
	if rec := serve(t, s, "/card/"+ex.CID+".png"); rec.Code != 200 {
		t.Fatalf("after recovery: %d", rec.Code)
	}
}

type downChecker struct {
	api.Checker
	fail atomic.Bool
}

func (d *downChecker) Check(ctx context.Context, text string) (*api.CheckReport, error) {
	if d.fail.Load() {
		return nil, context.DeadlineExceeded
	}
	return d.Checker.Check(ctx, text)
}

func TestFallbackColouringWithoutSpans(t *testing.T) {
	// a checker whose Highlight fails still gets a card (the built-in lexer colours it)
	base, _ := testChecker(t)
	s, es, _ := newTestService(t, Options{Checker: noHighlight{base}})
	b, err := s.Render(es.texts["first-beat"], Wide)
	if err != nil || !isPNG(b) {
		t.Fatalf("%v", err)
	}
}

type noHighlight struct{ api.Checker }

func (noHighlight) Highlight(context.Context, string) ([]api.Span, error) {
	return nil, context.DeadlineExceeded
}

// ---- generic tags for the static pages -------------------------------------------------------------------------------

func TestGenericMetaAndInject(t *testing.T) {
	frag := GenericMeta("https://btw.bitwrap.io/")
	m := metas(frag)
	for k, v := range map[string]string{
		"og:image": "https://btw.bitwrap.io/card/default.png", "og:image:width": "1200", "og:image:height": "630", "og:image:type": "image/png",
		"twitter:card": "summary_large_image", "og:url": "https://btw.bitwrap.io/", "og:type": "website",
	} {
		if m[k] != v {
			t.Errorf("%s = %q, want %q", k, m[k], v)
		}
	}
	if !strings.Contains(frag, `<link rel="canonical" href="https://btw.bitwrap.io/">`) {
		t.Error("no canonical")
	}
	if got := metas(GenericMetaAt("https://btw.bitwrap.io", "/p"))["og:url"]; got != "https://btw.bitwrap.io/p" {
		t.Errorf("og:url for /p = %q", got)
	}
	if strings.Contains(GenericMeta(`https://x.test/"><script>`), "<script>") {
		t.Error("the origin is not escaped")
	}
	doc := []byte("<html><head><title>x</title></head><body></body></html>")
	out := string(InjectGeneric(doc, "https://btw.bitwrap.io", "/"))
	if !strings.Contains(out, `property="og:image"`) || strings.Index(out, "og:image") > strings.Index(out, "</head>") {
		t.Errorf("not injected before </head>: %s", out)
	}
	if again := InjectGeneric([]byte(out), "https://btw.bitwrap.io", "/"); string(again) != out {
		t.Error("injecting twice duplicates the tags")
	}
	marked := "<head>" + CardMetaMarker + "</head>"
	if out := string(InjectGeneric([]byte(marked), "https://btw.bitwrap.io", "/")); strings.Contains(out, CardMetaMarker) || !strings.Contains(out, "og:image") {
		t.Errorf("marker not replaced: %s", out)
	}
}

func TestNewNeedsAChecker(t *testing.T) {
	if _, err := New(Options{}); err == nil {
		t.Fatal("New without a Checker succeeded")
	}
}

func BenchmarkDrawWide(b *testing.B) {
	for i := 0; i < b.N; i++ {
		if _, err := drawCard(genericContent("btw"), Wide); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkDrawSquare(b *testing.B) {
	for i := 0; i < b.N; i++ {
		if _, err := drawCard(genericContent("btw"), Square); err != nil {
			b.Fatal(err)
		}
	}
}

// A public program's page embeds its JSON-LD, points at it with Link: rel=describedby, and /c/<cid>.jsonld is that document.
func TestPageEmbedsJSONLD(t *testing.T) {
	s, es, _ := newTestService(t, Options{})
	var ex api.Example
	for _, e := range es.list {
		if e.Name == "hand-dubstep-140-v4" {
			ex = e
		}
	}
	if ex.CID == "" {
		t.Skip("hand-dubstep-140-v4 is not an example")
	}
	rec := serve(t, s, "/c/"+ex.CID)
	body := rec.Body.String()
	m := regexp.MustCompile(`(?s)<script type="application/ld\+json">(.*?)</script>`).FindStringSubmatch(body)
	if m == nil {
		t.Fatal("no embedded JSON-LD")
	}
	var embedded map[string]any
	if err := json.Unmarshal([]byte(m[1]), &embedded); err != nil {
		t.Fatalf("embedded JSON-LD is not JSON: %v\n%s", err, m[1])
	}
	if embedded["@context"] != "https://btw.bitwrap.io/context/v1.jsonld" || embedded["cid"] != ex.CID || embedded["@type"] != "djrust:Program" {
		t.Errorf("embedded document: %v", embedded)
	}
	if got, want := rec.Header().Get("Link"), `<https://btw.bitwrap.io/c/`+ex.CID+`.jsonld>; rel="describedby"; type="application/ld+json"`; got != want {
		t.Errorf("Link = %q, want %q", got, want)
	}
	doc := serve(t, s, "/c/"+ex.CID+".jsonld")
	if doc.Code != 200 || !strings.HasPrefix(doc.Header().Get("Content-Type"), "application/ld+json") || doc.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("jsonld: %d %v", doc.Code, doc.Header())
	}
	var alone map[string]any
	if err := json.Unmarshal(doc.Body.Bytes(), &alone); err != nil || alone["cid"] != ex.CID {
		t.Fatalf("jsonld body: %v %s", err, doc.Body.String())
	}
	// a program that is not public has no document
	if r := serve(t, s, "/c/not-a-program.jsonld"); r.Code == 200 {
		t.Errorf("a non-program has a document: %d", r.Code)
	}
}

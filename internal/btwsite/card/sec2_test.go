package card

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"beats-bitwrap-io/internal/btw"
	"beats-bitwrap-io/internal/btwsite/api"
)

// distinctLink is the stateless link of a valid program nobody stored: every n makes another program.
func distinctLink(t testing.TB, c api.Checker, n int) (cid, packed string) {
	t.Helper()
	text := fmt.Sprintf("tempo %d\nkey am\ndeck A: kick x ~ x ~\nend at bar %d\n", 60+n%200, 1+n%60)
	rep, err := c.Check(context.Background(), text)
	if err != nil || !rep.OK {
		t.Fatalf("program %d: %v %+v", n, err, rep)
	}
	return rep.CID, btw.Pack(rep.Canonical)
}

func serveFrom(t testing.TB, s *Service, remote, path string) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	s.Mount(mux)
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.RemoteAddr = remote + ":4000"
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func dirSize(t testing.TB, dir string) (n int64, files int) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range ents {
		if info, err := e.Info(); err == nil {
			n += info.Size()
			files++
		}
	}
	return
}

// Every stateless link draws a card for a program of the sender's choosing and writes it to the cache; without a
// cap that is a way to fill the host's disk (170 KB per program, both variants, measured). The cache is capped and
// forgets the least recently used.
func TestCardCacheIsCapped(t *testing.T) {
	c, _ := testChecker(t)
	dir := t.TempDir()
	const capBytes = 300 << 10
	s, _, _ := newTestService(t, Options{Checker: c, CacheDir: dir, CacheMaxBytes: capBytes, WorkPerMinute: -1,
		Examples: func() []api.Example { return nil }})
	var last string
	for i := 0; i < 12; i++ {
		cid, packed := distinctLink(t, c, i)
		last = cid + "." + packed
		if rec := serve(t, s, "/card/"+last+".png"); rec.Code != 200 {
			t.Fatalf("card %d: %d", i, rec.Code)
		}
		if rec := serve(t, s, "/card/"+last+".square.png"); rec.Code != 200 {
			t.Fatalf("square %d: %d", i, rec.Code)
		}
	}
	n, files := dirSize(t, dir)
	biggest := int64(400 << 10)
	if n > capBytes+biggest {
		t.Fatalf("the card cache holds %d bytes in %d files after 24 cards, cap %d", n, files, capBytes)
	}
	if files == 0 {
		t.Fatal("nothing is cached at all")
	}
	// the newest card is still served from the cache (no second render): its file exists
	cidN, _, _ := strings.Cut(last, ".")
	found := false
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), cidN+".square") {
			found = true
		}
	}
	if !found {
		t.Fatal("the most recent card was evicted first")
	}
	// a restart sees the same books: the cap holds across processes
	s2, _, _ := newTestService(t, Options{Checker: c, CacheDir: dir, CacheMaxBytes: capBytes, WorkPerMinute: -1, Examples: func() []api.Example { return nil }})
	cid, packed := distinctLink(t, c, 99)
	if rec := serve(t, s2, "/card/"+cid+"."+packed+".png"); rec.Code != 200 {
		t.Fatal(rec.Code)
	}
	if n2, _ := dirSize(t, dir); n2 > capBytes+biggest {
		t.Fatalf("after a restart the cache grew past its cap: %d", n2)
	}
	_ = filepath.Join
}

// An address that makes the service work (a check of a link nobody has asked about, a card nobody has drawn) is
// limited per minute; pages and cards served from memory or disk are free, and other addresses are untouched.
func TestWorkIsLimitedPerAddress(t *testing.T) {
	c, _ := testChecker(t)
	s, _, _ := newTestService(t, Options{Checker: c, WorkPerMinute: 6, Examples: func() []api.Example { return nil }})
	var refused, served int
	var retry string
	for i := 0; i < 20; i++ {
		cid, packed := distinctLink(t, c, 1000+i)
		rec := serveFrom(t, s, "198.51.100.7", "/c/"+cid+"."+packed)
		switch rec.Code {
		case 200:
			served++
		case http.StatusTooManyRequests:
			refused++
			retry = rec.Header().Get("Retry-After")
			if rec.Header().Get("Cache-Control") != "no-store" {
				t.Errorf("a refusal must not be cached: %q", rec.Header().Get("Cache-Control"))
			}
		default:
			t.Fatalf("link %d: %d %s", i, rec.Code, rec.Body.String())
		}
	}
	if served != 6 || refused != 14 {
		t.Fatalf("served %d refused %d, want 6 and 14 (one check per new link)", served, refused)
	}
	if retry == "" || retry == "0" {
		t.Fatalf("Retry-After = %q", retry)
	}
	// somebody else is not affected
	cid, packed := distinctLink(t, c, 5000)
	if rec := serveFrom(t, s, "198.51.100.8", "/c/"+cid+"."+packed); rec.Code != 200 {
		t.Fatalf("another address: %d", rec.Code)
	}
	// a link already remembered is free for the address that is over its limit
	cid, packed = distinctLink(t, c, 1000)
	if rec := serveFrom(t, s, "198.51.100.7", "/c/"+cid+"."+packed); rec.Code != 200 {
		t.Fatalf("a remembered link costs nothing, got %d", rec.Code)
	}
}

// A checker that is busy or rate limited is the service being unavailable, not a verdict on the program: the
// page must not become a cached "invalid" card for it (5 minutes of noindex on a good link).
func TestBusyCheckerIsNotAnInvalidCard(t *testing.T) {
	base, _ := testChecker(t)
	busy := &busyChecker{Checker: base}
	s, _, _ := newTestService(t, Options{Checker: busy, WorkPerMinute: -1, Examples: func() []api.Example { return nil }})
	cid, packed := distinctLink(t, base, 7)
	busy.on.Store(true)
	for _, path := range []string{"/c/" + cid + "." + packed, "/card/" + cid + "." + packed + ".png"} {
		rec := serve(t, s, path)
		if rec.Code != http.StatusServiceUnavailable && rec.Code != http.StatusTooManyRequests {
			t.Fatalf("%s while the checker is busy: %d (a good program must not look invalid)", path, rec.Code)
		}
		if rec.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("%s: Cache-Control %q", path, rec.Header().Get("Cache-Control"))
		}
	}
	busy.on.Store(false)
	if rec := serve(t, s, "/c/"+cid+"."+packed); rec.Code != 200 || rec.Header().Get("X-Btw-Card") != "ok" {
		t.Fatalf("after the checker recovers: %d %q", rec.Code, rec.Header().Get("X-Btw-Card"))
	}
}

type busyChecker struct {
	api.Checker
	on atomic.Bool
}

func (b *busyChecker) Check(ctx context.Context, text string) (*api.CheckReport, error) {
	if b.on.Load() {
		e := api.Errf(http.StatusServiceUnavailable, "busy", "the checker is busy")
		return nil, e
	}
	return b.Checker.Check(ctx, text)
}

// What is remembered about a checked link is what a card needs, not the checker's whole answer.
func TestMemoDoesNotKeepDiagnostics(t *testing.T) {
	c, _ := testChecker(t)
	s, _, _ := newTestService(t, Options{Checker: c, WorkPerMinute: -1, Examples: func() []api.Example { return nil }})
	got, err := s.check(context.Background(), "tempo 120\ndeck Z: kick x ~ x ~\nBAD\n")
	if err != nil {
		t.Fatal(err)
	}
	if got.report.OK || len(got.report.Diagnostics) != 0 {
		t.Fatalf("memo kept %d diagnostics (ok=%v)", len(got.report.Diagnostics), got.report.OK)
	}
}

// A name or description cannot reorder the text around it in a link preview.
func TestCleanTextDropsBidiControls(t *testing.T) {
	got := cleanText("a‮evil⁦x⁩ ‏b؜c", 60)
	for _, r := range got {
		if isBidiControl(r) {
			t.Fatalf("a bidi control survived: %q", got)
		}
	}
	if got != "a evil x b c" {
		t.Fatalf("got %q", got)
	}
	if cleanText("日本語 𝄞 é", 60) != "日本語 𝄞 é" {
		t.Fatal("ordinary non-ASCII text must pass untouched")
	}
}

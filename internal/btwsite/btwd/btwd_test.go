package btwd

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"beats-bitwrap-io/internal/btw"
	"beats-bitwrap-io/internal/btwsite/api"
	"beats-bitwrap-io/internal/btwsite/btwd/fakebtwd"
	"beats-bitwrap-io/internal/btwsite/fakecheck"
)

var fakeBin string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "fakebtwd")
	if err != nil {
		panic(err)
	}
	fakeBin, err = fakebtwd.Build(dir)
	if err != nil {
		os.RemoveAll(dir)
		panic(err)
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

const prog = "tempo 120\nkey am\ndeck A: kick x ~ x ~\nsection intro 4 bars\nsection drop 4 bars\n"

func fake(t *testing.T, opts Options, extra ...string) *Client {
	t.Helper()
	opts.Env = extra
	c, err := New(fakeBin, opts)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestMissingBinary(t *testing.T) {
	for _, bin := range []string{"", "/nonexistent/btwd", "definitely-not-on-path-btwd"} {
		_, err := New(bin, Options{})
		if err == nil || !errors.Is(err, ErrMissing) {
			t.Fatalf("New(%q) = %v, want ErrMissing", bin, err)
		}
	}
	dir := t.TempDir()
	if _, err := New(dir, Options{}); err == nil {
		t.Fatal("a directory is not a binary")
	}
	f := filepath.Join(dir, "plain")
	os.WriteFile(f, []byte("x"), 0o644)
	if _, err := New(f, Options{}); err == nil || !strings.Contains(err.Error(), "not an executable") {
		t.Fatalf("non-executable: %v", err)
	}
	if !strings.Contains(func() string { _, e := New("", Options{}); return e.Error() }(), "-btwd") {
		t.Fatal("the error should say how to fix it")
	}
}

func TestProtocolMatchesFakeChecker(t *testing.T) {
	c := fake(t, Options{})
	ctx := context.Background()
	want, _ := fakecheck.Checker{}.Check(ctx, prog)
	got, err := c.Check(ctx, prog)
	if err != nil {
		t.Fatal(err)
	}
	if !got.OK || got.CID != want.CID || got.Canonical != want.Canonical || got.SongBars != 8 || len(got.Sections) != 2 {
		t.Fatalf("check: %+v", got)
	}
	if got.CID == "" || got.Tempo == nil || *got.Tempo != 120 || got.Key != "am" || got.Seconds == nil {
		t.Fatalf("check fields: %+v", got)
	}

	bad, err := c.Check(ctx, "BAD\n")
	if err != nil || bad.OK || bad.Errors != 1 || len(bad.Diagnostics) != 1 || bad.Diagnostics[0].Line != 1 {
		t.Fatalf("bad program: %+v %v", bad, err)
	}

	f, err := c.Fmt(ctx, "tempo   120 # hi\n\n\ndeck A: kick x\n")
	if err != nil || !f.OK || f.Canonical != "tempo 120\ndeck A: kick x\n" || f.CID == "" {
		t.Fatalf("fmt: %+v %v", f, err)
	}

	sh, err := c.Share(ctx, prog)
	if err != nil || !sh.OK || !strings.Contains(sh.URL, "#"+got.CID+".") {
		t.Fatalf("share: %+v %v", sh, err)
	}
	op, err := c.Open(ctx, sh.URL)
	if err != nil || !op.OK || !op.Verified || op.CID != got.CID || op.Canonical != got.Canonical {
		t.Fatalf("open: %+v %v", op, err)
	}
	if _, err := c.Open(ctx, ""); err == nil {
		t.Fatal("empty open should be refused")
	}
	if _, err := c.Open(ctx, "--help"); err == nil {
		t.Fatal("an option-looking argument must be refused")
	}

	sp, err := c.Highlight(ctx, "tempo 120 # note\n")
	if err != nil || len(sp) != 1 || sp[0].Class != "comment" || sp[0].Start != 10 {
		t.Fatalf("highlight: %+v %v", sp, err)
	}
	ins, err := c.Instruments(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if json.Unmarshal(ins, &m) != nil || m["voices"] == nil {
		t.Fatalf("instruments: %s", ins)
	}
	cs, err := c.Cheatsheet(ctx)
	if err != nil || !strings.HasPrefix(cs, "# btw cheatsheet") {
		t.Fatalf("cheatsheet: %q %v", cs, err)
	}
	// the real algorithm over the fake canonical form
	if cid, _ := btw.ProgramCID(got.Canonical); cid != got.CID {
		t.Fatal("cid is not ProgramCID(canonical)")
	}
}

func TestInstrumentsAndCheatsheetAreCached(t *testing.T) {
	calls := filepath.Join(t.TempDir(), "calls")
	c := fake(t, Options{}, "BTW_FAKE_CALLS="+calls)
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		if _, err := c.Instruments(ctx); err != nil {
			t.Fatal(err)
		}
		if _, err := c.Cheatsheet(ctx); err != nil {
			t.Fatal(err)
		}
	}
	b, _ := os.ReadFile(calls)
	if n := strings.Count(string(b), "instruments"); n != 1 {
		t.Fatalf("instruments ran %d times: %s", n, b)
	}
	if n := strings.Count(string(b), "cheatsheet"); n != 1 {
		t.Fatalf("cheatsheet ran %d times", n)
	}
}

func TestStdinCapAndTimeout(t *testing.T) {
	c := fake(t, Options{MaxStdin: 100})
	_, err := c.Check(context.Background(), strings.Repeat("x", 101))
	var ae *api.Error
	if !errors.As(err, &ae) || ae.Status != 413 || ae.Code != api.CodeTooLarge {
		t.Fatalf("want 413 too_large, got %v", err)
	}
	slow := fake(t, Options{Timeout: 150 * time.Millisecond}, "BTW_FAKE_CMD_DELAY_MS=3000")
	start := time.Now()
	_, err = slow.Check(context.Background(), prog)
	if !errors.As(err, &ae) || ae.Status != 504 {
		t.Fatalf("want 504, got %v", err)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("timeout took %s", time.Since(start))
	}
}

func TestBoundedConcurrency(t *testing.T) {
	c := fake(t, Options{MaxConcurrent: 2, Timeout: 5 * time.Second}, "BTW_FAKE_CMD_DELAY_MS=250")
	start := time.Now()
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := c.Check(context.Background(), prog); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	// four 250 ms calls through two slots cannot take less than two waves
	if el := time.Since(start); el < 480*time.Millisecond {
		t.Fatalf("4 calls through 2 slots took only %s", el)
	}
	// and when the wait outlasts the timeout the caller gets busy, not a hang
	tight := fake(t, Options{MaxConcurrent: 1, Timeout: 200 * time.Millisecond}, "BTW_FAKE_CMD_DELAY_MS=600")
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() { _, err := tight.Check(context.Background(), prog); errs <- err }()
	}
	var busyN int
	for i := 0; i < 2; i++ {
		var ae *api.Error
		if err := <-errs; errors.As(err, &ae) && (ae.Code == "busy" || ae.Status == 504) {
			busyN++
		}
	}
	if busyN == 0 {
		t.Fatal("expected at least one busy/timeout")
	}
}

func TestChildEnvIsMinimal(t *testing.T) {
	t.Setenv("GEMINI_API_KEY", "secret-should-not-leak")
	c := fake(t, Options{})
	env := c.env()
	for _, e := range env {
		if strings.Contains(e, "GEMINI") || strings.Contains(e, "secret") {
			t.Fatalf("leaked env %q", e)
		}
	}
}

func TestStartRender(t *testing.T) {
	c := fake(t, Options{})
	p, err := c.StartRender(context.Background(), prog, RenderOptions{ChunkMS: 100})
	if err != nil {
		t.Fatal(err)
	}
	if p.Start.SampleRate != 44100 || p.Start.Channels != 2 || p.Start.Format != "s16le" || p.Start.Bars != 8 || p.Start.Seconds < 15 || len(p.Start.Notes) == 0 {
		t.Fatalf("start: %+v", p.Start)
	}
	n, err := io.Copy(io.Discard, p.PCM)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Wait(); err != nil {
		t.Fatal(err)
	}
	want := int64(float64(44100)*p.Start.Seconds) * 4
	if n != want {
		t.Fatalf("pcm bytes %d, want %d", n, want)
	}
}

func TestStartRenderRefusals(t *testing.T) {
	c := fake(t, Options{})
	for name, text := range map[string]string{
		"errors":     "BAD\n",
		"restricted": "tempo 120\nuse restricted\ndeck A: kick x\n",
		"assets":     "tempo 120\nsample kick.wav\n",
	} {
		_, err := c.StartRender(context.Background(), text, RenderOptions{})
		var ae *api.Error
		if !errors.As(err, &ae) || ae.Status != 422 || ae.Code != "render_failed" || ae.Message == "" {
			t.Fatalf("%s: want 422 render_failed, got %v", name, err)
		}
	}
	_, err := c.StartRender(context.Background(), prog, RenderOptions{MaxBars: 4})
	var ae *api.Error
	if !errors.As(err, &ae) || !strings.Contains(ae.Message, "bars") {
		t.Fatalf("max bars: %v", err)
	}
}

func TestRenderFailureMidStream(t *testing.T) {
	c := fake(t, Options{}, "BTW_FAKE_FAIL_AT_CHUNK=3")
	p, err := c.StartRender(context.Background(), prog, RenderOptions{ChunkMS: 100})
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, p.PCM)
	err = p.Wait()
	if err == nil || !strings.Contains(err.Error(), "fake render failure") {
		t.Fatalf("Wait = %v", err)
	}
}

func TestRenderKilledWithContext(t *testing.T) {
	pidfile := filepath.Join(t.TempDir(), "pid")
	c := fake(t, Options{}, "BTW_FAKE_PIDFILE="+pidfile, "BTW_FAKE_CHUNK_DELAY_MS=100", "BTW_FAKE_SECONDS=60")
	ctx, cancel := context.WithCancel(context.Background())
	p, err := c.StartRender(ctx, prog, RenderOptions{ChunkMS: 100})
	if err != nil {
		t.Fatal(err)
	}
	pid := p.Pid()
	buf := make([]byte, 1000)
	if _, err := io.ReadFull(p.PCM, buf); err != nil {
		t.Fatal(err)
	}
	cancel()
	io.Copy(io.Discard, p.PCM)
	_ = p.Wait()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); err != nil {
			return // gone
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("child %d still alive after cancel", pid)
}

func TestProgressEvents(t *testing.T) {
	c := fake(t, Options{}, "BTW_FAKE_CHUNK_DELAY_MS=60", "BTW_FAKE_SECONDS=3")
	p, err := c.StartRender(context.Background(), prog, RenderOptions{ChunkMS: 100})
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, p.PCM)
	if err := p.Wait(); err != nil {
		t.Fatal(err)
	}
	if p.Progress() <= 0 {
		t.Fatal("no progress events seen")
	}
}

// With BTWD_BIN set, the same protocol against the real binary. BTWD_CORPUS (default: the CC0
// corpus in the Rust worktree) names a directory of .btw files.
func TestRealBinary(t *testing.T) {
	bin := os.Getenv("BTWD_BIN")
	if bin == "" {
		t.Skip("BTWD_BIN not set")
	}
	c, err := New(bin, Options{})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := c.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	dir := os.Getenv("BTWD_CORPUS")
	if dir == "" {
		dir = "/Users/myork/Workspace/.val-worktrees/djrust-vevr-se/btw-web/crates/btwapi/tests/corpus"
	}
	files, _ := filepath.Glob(filepath.Join(dir, "*.btw"))
	if len(files) == 0 {
		t.Fatalf("no .btw files in %s", dir)
	}
	for _, f := range files {
		b, _ := os.ReadFile(f)
		name := filepath.Base(f)
		rep, err := c.Check(ctx, string(b))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if !rep.OK || rep.CID == "" || rep.Canonical == "" {
			t.Fatalf("%s: check %+v", name, rep)
		}
		if cid, _ := btw.ProgramCID(rep.Canonical); cid != rep.CID {
			t.Fatalf("%s: btwd cid %s != Go ProgramCID %s", name, rep.CID, cid)
		}
		fm, err := c.Fmt(ctx, string(b))
		if err != nil || fm.Canonical != rep.Canonical || fm.CID != rep.CID {
			t.Fatalf("%s: fmt %+v %v", name, fm, err)
		}
		sh, err := c.Share(ctx, string(b))
		if err != nil || !sh.OK {
			t.Fatalf("%s: share %+v %v", name, sh, err)
		}
		op, err := c.Open(ctx, sh.URL)
		if err != nil || !op.Verified || op.CID != rep.CID {
			t.Fatalf("%s: open %+v %v", name, op, err)
		}
		if _, err := c.Highlight(ctx, string(b)); err != nil {
			t.Fatalf("%s: highlight %v", name, err)
		}
		if rep.UsesAssets || rep.Restricted {
			continue
		}
		rctx, cancel := context.WithTimeout(ctx, 60*time.Second)
		p, err := c.StartRender(rctx, string(b), RenderOptions{MaxBars: 2})
		if err != nil {
			cancel()
			t.Fatalf("%s: render %v", name, err)
		}
		n, _ := io.Copy(io.Discard, p.PCM)
		if err := p.Wait(); err != nil || n == 0 {
			t.Fatalf("%s: render pcm=%d err=%v", name, n, err)
		}
		cancel()
	}
	if cs, err := c.Cheatsheet(ctx); err != nil || len(cs) < 200 {
		t.Fatalf("cheatsheet %d %v", len(cs), err)
	}
}

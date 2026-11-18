package btwd

import (
	"bufio"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
)

// script writes an executable shell script standing in for btwd.
func script(t *testing.T, body string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell script stand-in")
	}
	p := filepath.Join(t.TempDir(), "btwd")
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

// A hostile (or merely huge) answer must not be buffered whole: a 60 KB junk program makes the real btwd print
// 17 MB of diagnostics, and the 4 MiB cap is what keeps that out of memory and off the wire. (limitedBuffer used
// to embed bytes.Buffer, whose ReadFrom io.Copy prefers: the cap in Write was never reached.)
func TestStdoutIsCapped(t *testing.T) {
	bin := script(t, `cat >/dev/null; head -c 20000000 /dev/zero | tr '\0' 'x'`)
	c, err := New(bin, Options{MaxStdout: 1 << 20, Timeout: 20 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	rep, err := c.Check(context.Background(), "tempo 120\n")
	if err == nil {
		t.Fatalf("a 20 MB answer was accepted: %+v", rep)
	}
	var ae *api.Error
	if !errors.As(err, &ae) || ae.Status != 422 {
		t.Fatalf("the answer is over the cap: want a 422 *api.Error (too many problems to list), got %T %v", err, err)
	}
	if time.Since(start) > 10*time.Second {
		t.Fatalf("a capped child must not be left blocked on a full pipe (took %v)", time.Since(start))
	}
}

// stderr is capped too (4 KiB): an error message in the API must never be a megabyte of the child's chatter.
func TestStderrIsCapped(t *testing.T) {
	bin := script(t, `cat >/dev/null; head -c 5000000 /dev/zero | tr '\0' 'e' >&2; exit 3`)
	c, err := New(bin, Options{Timeout: 20 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.Check(context.Background(), "tempo 120\n")
	if err == nil {
		t.Fatal("exit 3 is a failure")
	}
	if len(err.Error()) > 8192 {
		t.Fatalf("the child's stderr reached the error unbounded: %d bytes", len(err.Error()))
	}
}

// One address (one owner) must not be able to hold every checker slot: with a hostile program that runs until
// the timeout, the other slots stay free for everyone else.
func TestOwnerCannotTakeEverySlot(t *testing.T) {
	bin := script(t, `cat >/dev/null; sleep 2; echo '{"ok":true,"errors":0,"warnings":0,"diagnostics":[],"cid":"z","canonical":"x"}'`)
	c, err := New(bin, Options{MaxConcurrent: 4, Timeout: 10 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	attacker := WithOwner(context.Background(), "203.0.113.9")
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ { // eight at once from one owner
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = c.Check(attacker, "tempo 120\n")
		}()
	}
	time.Sleep(300 * time.Millisecond)
	// a different owner still gets a slot at once (it would wait the whole 2 s behind a monopoly)
	t0 := time.Now()
	other := WithOwner(context.Background(), "198.51.100.7")
	done := make(chan error, 1)
	go func() { _, err := c.Check(other, "tempo 120\n"); done <- err }()
	select {
	case err := <-done:
		_ = err
	case <-time.After(5 * time.Second):
		t.Fatal("the other owner never got an answer")
	}
	// the answer takes the script's 2 s, but it must not have queued behind the attacker's 8: two rounds of 2 s
	if d := time.Since(t0); d > 3500*time.Millisecond {
		t.Fatalf("another owner waited %v behind one owner's flood", d)
	}
	wg.Wait()
}

// The checker's time is budgeted per owner: a stream of programs that each burn seconds is refused (429) long before
// it can keep the slots busy, and an honest owner's cheap checks never touch the budget.
func TestOwnerTimeBudget(t *testing.T) {
	bin := script(t, `cat >/dev/null; sleep 1; echo '{"ok":true,"errors":0,"warnings":0,"diagnostics":[],"cid":"z","canonical":"x"}'`)
	c, err := New(bin, Options{MaxConcurrent: 4, Timeout: 10 * time.Second, OwnerSeconds: 3, OwnerRefill: 0.01})
	if err != nil {
		t.Fatal(err)
	}
	ctx := WithOwner(context.Background(), "203.0.113.50")
	var refused *api.Error
	for i := 0; i < 8 && refused == nil; i++ {
		if _, err := c.Check(ctx, "tempo 120\n"); err != nil {
			var ae *api.Error
			if errors.As(err, &ae) && ae.Status == 429 {
				refused = ae
			}
		}
	}
	if refused == nil {
		t.Fatal("eight one-second checks from one owner were all served: no time budget")
	}
	if refused.RetryAfter < 1 || !strings.Contains(refused.Message, "time") {
		t.Fatalf("the refusal should say when to retry and why: %+v", refused)
	}
	// someone else is unaffected, and so is a call with no owner (start-up, tests)
	if _, err := c.Check(WithOwner(context.Background(), "203.0.113.51"), "tempo 120\n"); err != nil {
		t.Fatalf("another owner: %v", err)
	}
	if _, err := c.Check(context.Background(), "tempo 120\n"); err != nil {
		t.Fatalf("no owner: %v", err)
	}
}

// A stderr line with no end must not be kept whole.
func TestReadLineIsCapped(t *testing.T) {
	long := strings.Repeat("e", 300_000) + "\n" + `{"event":"end"}` + "\n"
	br := bufio.NewReaderSize(strings.NewReader(long), 4096)
	l, err := readLine(br, 1000)
	if err != nil || len(l) != 1000 {
		t.Fatalf("first line: len %d err %v, want the first 1000 bytes", len(l), err)
	}
	l, err = readLine(br, 1000)
	if strings.TrimSpace(l) != `{"event":"end"}` || err != nil {
		t.Fatalf("the line after a cut one must come through whole: %q %v", l, err)
	}
	if _, err = readLine(br, 1000); err != io.EOF {
		t.Fatalf("want EOF, got %v", err)
	}
}

// A check's diagnostics are capped, their counts are not.
func TestDiagnosticsAreCapped(t *testing.T) {
	bin := script(t, `cat >/dev/null
printf '{"ok":false,"errors":3000,"warnings":0,"diagnostics":['
i=0; while [ $i -lt 3000 ]; do [ $i -gt 0 ] && printf ','; printf '{"severity":"error","line":%d,"col":1,"end_col":2,"start":0,"end":1,"message":"m"}' $i; i=$((i+1)); done
printf '],"cid":null,"canonical":null}'`)
	c, err := New(bin, Options{})
	if err != nil {
		t.Fatal(err)
	}
	r, err := c.Check(context.Background(), "x\n")
	if err != nil {
		t.Fatal(err)
	}
	if r.Errors != 3000 || len(r.Diagnostics) != MaxDiagnostics {
		t.Fatalf("errors %d, diagnostics %d (want 3000 and %d)", r.Errors, len(r.Diagnostics), MaxDiagnostics)
	}
}

// The caret form of an error repeats its source line: a long line must not make every diagnostic that long.
func TestDiagnosticTextIsClipped(t *testing.T) {
	bin := script(t, `cat >/dev/null
line=$(head -c 30000 /dev/zero | tr '\0' 'x')
printf '{"ok":false,"errors":1,"warnings":0,"diagnostics":[{"severity":"error","line":1,"col":1,"end_col":2,"start":0,"end":1,"message":"m","render":"error: %s"}],"cid":null,"canonical":null}' "$line"`)
	c, err := New(bin, Options{})
	if err != nil {
		t.Fatal(err)
	}
	r, err := c.Check(context.Background(), "x\n")
	if err != nil {
		t.Fatal(err)
	}
	if got := len(r.Diagnostics[0].Render); got > 2100 || !strings.HasSuffix(r.Diagnostics[0].Render, "…") {
		t.Fatalf("render is %d bytes, want it cut at 2000 and marked", got)
	}
	if clip("日本語", 4) != "日…" || clip("abc", 3) != "abc" {
		t.Fatalf("clip must cut on a character boundary: %q", clip("日本語", 4))
	}
}

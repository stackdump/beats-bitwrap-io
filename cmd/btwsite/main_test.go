package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"beats-bitwrap-io/internal/btwsite/btwd/fakebtwd"
)

// The binary's own flow, in process: flags and BTW_* environment in, a listening server, a request, a
// signal's worth of cancellation, a graceful exit with an SSE stream still open.
func TestRunServesAndShutsDownGracefully(t *testing.T) {
	dir := t.TempDir()
	bin, err := fakebtwd.Build(dir)
	if err != nil {
		t.Fatal(err)
	}
	web := filepath.Join(dir, "web")
	os.MkdirAll(web, 0o755)
	os.WriteFile(filepath.Join(web, "index.html"), []byte("<!doctype html><html><head></head><body>hi</body></html>"), 0o644)
	ex := filepath.Join(dir, "ex")
	os.MkdirAll(ex, 0o755)
	os.WriteFile(filepath.Join(ex, "index.json"), []byte("[]"), 0o644)

	env := map[string]string{"BTW_MODEL": "fake", "BTW_RENDER_MAX_BARS": "12"}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	addr := make(chan net.Addr, 1)
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, []string{"-addr", "127.0.0.1:0", "-web", web, "-examples", ex, "-docs", filepath.Join(dir, "docs"), "-data", filepath.Join(dir, "data"),
			"-btwd", bin, "-public-url", "http://btw.test"}, func(k string) string { return env[k] }, io.Discard, func(a net.Addr) { addr <- a })
	}()
	var base string
	select {
	case a := <-addr:
		base = "http://" + a.String()
	case err := <-done:
		t.Fatalf("run exited: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("not listening")
	}

	resp, err := http.Get(base + "/api/info")
	if err != nil {
		t.Fatal(err)
	}
	var info struct {
		Render struct {
			MaxBars int `json:"max_bars"`
		}
		Model string
	}
	json.NewDecoder(resp.Body).Decode(&info)
	resp.Body.Close()
	if info.Render.MaxBars != 12 || info.Model != "fake" { // the environment reached the config
		t.Fatalf("info: %+v", info)
	}

	// open an SSE stream and leave it open
	r, _ := http.Post(base+"/api/session", "application/json", nil)
	var sess struct{ ID string }
	json.NewDecoder(r.Body).Decode(&sess)
	r.Body.Close()
	sse, err := http.Get(base + "/api/session/" + sess.ID + "/events")
	if err != nil {
		t.Fatal(err)
	}
	defer sse.Body.Close()
	line, _ := bufio.NewReader(sse.Body).ReadString('\n')
	if !strings.HasPrefix(line, "retry:") {
		t.Fatalf("sse: %q", line)
	}

	start := time.Now()
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("run did not return after cancel (an SSE stream held the shutdown up?)")
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Fatalf("shutdown took %s", d)
	}
}

func TestRunRefusesBadConfigAndMissingBtwd(t *testing.T) {
	noEnv := func(string) string { return "" }
	err := run(context.Background(), []string{"-render-concurrency", "0"}, noEnv, io.Discard, nil)
	if !errors.Is(err, errUsage) {
		t.Fatalf("bad flag value: %v", err)
	}
	err = run(context.Background(), []string{"-data", t.TempDir(), "-btwd", "/nonexistent/btwd", "-examples", ""}, noEnv, io.Discard, nil)
	if err == nil || !strings.Contains(err.Error(), "btwd") {
		t.Fatalf("missing btwd should be a clear error: %v", err)
	}
	var out bytes.Buffer
	if err := run(context.Background(), []string{"-h"}, noEnv, &out, nil); !errors.Is(err, flag.ErrHelp) {
		t.Fatalf("-h: %v", err)
	}
	if !strings.Contains(out.String(), "BTW_ADDR") || !strings.Contains(out.String(), "-render-ip-hour") {
		t.Fatalf("usage text:\n%s", out.String())
	}
	if strings.Contains(strings.ToLower(out.String()), "gemini_api_key") && strings.Contains(out.String(), "-gemini") {
		t.Fatal("the key must not be a flag")
	}
}

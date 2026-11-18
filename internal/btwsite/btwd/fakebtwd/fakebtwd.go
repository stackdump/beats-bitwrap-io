// Package fakebtwd is a stand-in for the Rust `btwd` binary that speaks its subprocess protocol
// (btwsite/DESIGN.md "crates/btwd"), built on internal/btwsite/fakecheck. Tests build cmd/fakebtwd once
// (Build) and hand its path to btwd.New, with the knobs below in btwd.Options.Env, so streaming, caching,
// joining and cancellation are tested without Rust.
//
// Knobs (environment, all optional):
//
//	BTW_FAKE_CHUNK_DELAY_MS   sleep after each PCM chunk (default 2)
//	BTW_FAKE_START_DELAY_MS   sleep before the start event
//	BTW_FAKE_SECONDS          seconds of audio to render (default: the program's, else 4)
//	BTW_FAKE_FAIL_AT_CHUNK    emit an error event and exit 1 after that many chunks
//	BTW_FAKE_PIDFILE          write the process id here (so a test can see it die)
//	BTW_FAKE_CALLS            append one line per invocation to this file
//	BTW_FAKE_CMD_DELAY_MS     sleep before answering check/fmt/open/share/... (not render)
package fakebtwd

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"time"

	"beats-bitwrap-io/internal/btwsite/fakecheck"
)

const instrumentsJSON = `{"voices":["kick","snare","hat","bass","lead","pad"],"families":["drums","bass","lead"],"kits":["909"],"palettes":["default"]}`

const cheatsheet = "# btw cheatsheet (fake)\n\ntempo 120\ndeck A: kick x ~ x ~\nsection intro 8 bars\n"

func envInt(name string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(name)); err == nil {
		return v
	}
	return def
}

// Run is the whole binary: args exclude the program name. It returns the exit code.
func Run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if f := os.Getenv("BTW_FAKE_PIDFILE"); f != "" {
		_ = os.WriteFile(f, []byte(strconv.Itoa(os.Getpid())), 0o600)
	}
	if f := os.Getenv("BTW_FAKE_CALLS"); f != "" && len(args) > 0 {
		if fh, err := os.OpenFile(f, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
			fmt.Fprintln(fh, args[0])
			fh.Close()
		}
	}
	if len(args) == 0 {
		fmt.Fprintln(stderr, "usage: btwd <check|fmt|instruments|open|share|highlight|nets|cheatsheet|render>")
		return 2
	}
	ctx := context.Background()
	if d := envInt("BTW_FAKE_CMD_DELAY_MS", 0); d > 0 && args[0] != "render" {
		time.Sleep(time.Duration(d) * time.Millisecond)
	}
	c := fakecheck.Checker{}
	readText := func() string {
		b, _ := io.ReadAll(stdin)
		return string(b)
	}
	out := json.NewEncoder(stdout)
	switch args[0] {
	case "check":
		r, _ := c.Check(ctx, readText())
		_ = out.Encode(r)
	case "fmt":
		r, _ := c.Fmt(ctx, readText())
		_ = out.Encode(r)
	case "instruments":
		fmt.Fprintln(stdout, instrumentsJSON)
	case "cheatsheet":
		fmt.Fprint(stdout, cheatsheet)
	case "open":
		if len(args) < 2 {
			fmt.Fprintln(stderr, "usage: btwd open <url|cid>")
			return 2
		}
		r, _ := c.Open(ctx, args[1])
		_ = out.Encode(r)
	case "share":
		r, _ := c.Share(ctx, readText())
		_ = out.Encode(r)
	case "highlight":
		sp, _ := c.Highlight(ctx, readText())
		arr := make([][3]any, 0, len(sp))
		for _, s := range sp {
			arr = append(arr, [3]any{s.Start, s.End, s.Class})
		}
		_ = out.Encode(arr)
	case "render":
		return render(args[1:], readText(), stdout, stderr)
	default:
		fmt.Fprintf(stderr, "btwd: unknown subcommand %q\n", args[0])
		return 2
	}
	return 0
}

func eventLine(w io.Writer, v map[string]any) {
	b, _ := json.Marshal(v)
	b = append(b, '\n')
	_, _ = w.Write(b)
}

func render(args []string, text string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("render", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	sr := fs.Int("sr", 44100, "")
	format := fs.String("format", "s16le", "")
	chunkMS := fs.Int("chunk-ms", 250, "")
	maxBars := fs.Int("max-bars", 256, "")
	fromBar := fs.Int("from-bar", 0, "")
	if err := fs.Parse(args); err != nil {
		eventLine(stderr, map[string]any{"event": "error", "message": err.Error()})
		return 2
	}
	_ = fromBar
	if *format != "s16le" {
		eventLine(stderr, map[string]any{"event": "error", "message": "only s16le here"})
		return 1
	}
	rep, _ := fakecheck.Checker{}.Check(context.Background(), text)
	if !rep.OK {
		msg := "program has errors"
		if len(rep.Diagnostics) > 0 {
			msg = rep.Diagnostics[0].Message
		}
		eventLine(stderr, map[string]any{"event": "error", "message": msg})
		return 1
	}
	if rep.UsesAssets || rep.Restricted {
		eventLine(stderr, map[string]any{"event": "error", "message": "program uses assets or is restricted; refusing to render"})
		return 1
	}
	if rep.SongBars > *maxBars {
		eventLine(stderr, map[string]any{"event": "error", "message": fmt.Sprintf("program is %d bars; the limit is %d", rep.SongBars, *maxBars)})
		return 1
	}
	secs := 4.0
	if rep.Seconds != nil {
		secs = *rep.Seconds
	}
	if v, err := strconv.ParseFloat(os.Getenv("BTW_FAKE_SECONDS"), 64); err == nil {
		secs = v
	}
	bpm := 120.0
	if rep.Tempo != nil {
		bpm = *rep.Tempo
	}
	if d := envInt("BTW_FAKE_START_DELAY_MS", 0); d > 0 {
		time.Sleep(time.Duration(d) * time.Millisecond)
	}
	eventLine(stderr, map[string]any{"event": "start", "sample_rate": *sr, "channels": 2, "format": "s16le",
		"seconds": secs, "bars": rep.SongBars, "bpm": bpm, "notes": []string{"control lines are not rendered"}})

	frames := int(float64(*sr) * secs)
	chunkFrames := *sr * *chunkMS / 1000
	if chunkFrames < 1 {
		chunkFrames = 1
	}
	delay := time.Duration(envInt("BTW_FAKE_CHUNK_DELAY_MS", 2)) * time.Millisecond
	failAt := envInt("BTW_FAKE_FAIL_AT_CHUNK", -1)
	buf := make([]byte, chunkFrames*4)
	done, chunk := 0, 0
	lastProg := time.Now()
	for done < frames {
		n := min(chunkFrames, frames-done)
		for i := 0; i < n; i++ {
			v := int16(8000 * math.Sin(2*math.Pi*440*float64(done+i)/float64(*sr)))
			buf[4*i], buf[4*i+1] = byte(v), byte(v>>8)
			buf[4*i+2], buf[4*i+3] = byte(v), byte(v>>8)
		}
		if _, err := stdout.Write(buf[:n*4]); err != nil {
			return 1
		}
		done += n
		chunk++
		if time.Since(lastProg) > 250*time.Millisecond {
			eventLine(stderr, map[string]any{"event": "progress", "seconds_rendered": float64(done) / float64(*sr)})
			lastProg = time.Now()
		}
		if failAt >= 0 && chunk >= failAt {
			eventLine(stderr, map[string]any{"event": "error", "message": "fake render failure"})
			return 1
		}
		if delay > 0 {
			time.Sleep(delay)
		}
	}
	eventLine(stderr, map[string]any{"event": "end", "seconds": float64(done) / float64(*sr)})
	return 0
}

// Build compiles the fake btwd (cmd/fakebtwd) into dir and returns the path of the executable. Tests call it
// once from TestMain; the Go build cache makes repeat runs cheap. (Re-executing the test binary instead is
// an order of magnitude slower per call under -race.)
func Build(dir string) (string, error) {
	_, file, _, _ := runtime.Caller(0)
	out := filepath.Join(dir, "btwd")
	cmd := exec.Command("go", "build", "-o", out, "beats-bitwrap-io/internal/btwsite/btwd/fakebtwd/cmd/fakebtwd")
	cmd.Dir = filepath.Dir(file)
	if b, err := cmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf("building fakebtwd: %v\n%s", err, b)
	}
	return out, nil
}

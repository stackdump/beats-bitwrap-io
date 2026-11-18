// Package btwd is the Go side of the Rust `btwd` binary (btwsite/DESIGN.md "crates/btwd"): a Client that
// implements api.Checker over the subprocess protocol (program text on stdin, JSON on stdout), and
// StartRender, which runs `btwd render` and hands back the streaming PCM.
//
// The subprocess gets a minimal environment (never the server's: it holds the model API key) and no
// network is expected of it. Concurrency is bounded, every call has a timeout, stdin and stdout are
// size-capped.
package btwd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
	"beats-bitwrap-io/internal/btwsite/fakecheck"
)

// Options configures a Client.
type Options struct {
	Timeout       time.Duration // per check/fmt/open/share call; default 10s
	MaxConcurrent int           // simultaneous short-lived btwd processes; default 4
	MaxStdin      int           // bytes of program text accepted; default 256 KiB
	MaxStdout     int           // bytes of JSON read back; default 4 MiB
	Env           []string      // extra KEY=VALUE for the child (tests point a re-executed test binary at fake mode)
}

func (o *Options) defaults() {
	if o.Timeout <= 0 {
		o.Timeout = 10 * time.Second
	}
	if o.MaxConcurrent <= 0 {
		o.MaxConcurrent = 4
	}
	if o.MaxStdin <= 0 {
		o.MaxStdin = 256 << 10
	}
	if o.MaxStdout <= 0 {
		o.MaxStdout = 4 << 20
	}
}

// Client runs the btwd binary. It implements api.Checker.
type Client struct {
	bin  string
	opts Options
	sem  chan struct{}

	mu          sync.Mutex
	instruments json.RawMessage
	cheatsheet  string
}

var _ api.Checker = (*Client)(nil)

// ErrMissing says the binary is not there; New wraps it with the path.
var ErrMissing = errors.New("btwd binary not found")

// New resolves bin (a path, or a name looked up on PATH) and returns a Client. It does not run the
// binary; use Ping for that.
func New(bin string, opts Options) (*Client, error) {
	if strings.TrimSpace(bin) == "" {
		return nil, fmt.Errorf("%w: no path given (set -btwd or BTW_BTWD to the btwd executable; build it with scripts/build-btwd-linux.sh in djrust-vevr-se)", ErrMissing)
	}
	path := bin
	if !strings.ContainsRune(bin, filepath.Separator) {
		p, err := exec.LookPath(bin)
		if err != nil {
			return nil, fmt.Errorf("%w: %q is not on PATH", ErrMissing, bin)
		}
		path = p
	}
	st, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("%w: %s: %v", ErrMissing, path, err)
	}
	if st.IsDir() || st.Mode()&0o111 == 0 {
		return nil, fmt.Errorf("btwd: %s is not an executable file", path)
	}
	opts.defaults()
	return &Client{bin: path, opts: opts, sem: make(chan struct{}, opts.MaxConcurrent)}, nil
}

// NewFake returns the in-process test double for the checker (no binary needed).
func NewFake() api.Checker { return fakecheck.Checker{} }

// Bin is the resolved path of the binary.
func (c *Client) Bin() string { return c.bin }

func (c *Client) env() []string {
	env := []string{"LANG=C.UTF-8", "RUST_BACKTRACE=0", "NO_COLOR=1"}
	return append(env, c.opts.Env...)
}

func busy() *api.Error {
	e := api.Errf(503, "busy", "the checker is busy; try again in a moment")
	e.RetryAfter = 2
	return e
}

// run executes `btwd args...` with stdin and returns stdout.
func (c *Client) run(ctx context.Context, stdin string, args ...string) ([]byte, error) {
	if len(stdin) > c.opts.MaxStdin {
		return nil, api.Errf(413, api.CodeTooLarge, "program text is %d bytes; the limit is %d", len(stdin), c.opts.MaxStdin)
	}
	ctx, cancel := context.WithTimeout(ctx, c.opts.Timeout)
	defer cancel()
	select {
	case c.sem <- struct{}{}:
		defer func() { <-c.sem }()
	case <-ctx.Done():
		return nil, busy()
	}
	cmd := exec.CommandContext(ctx, c.bin, args...)
	cmd.Env = c.env()
	cmd.Stdin = strings.NewReader(stdin)
	var out, errb limitedBuffer
	out.max = c.opts.MaxStdout
	errb.max = 4096
	cmd.Stdout = &out
	cmd.Stderr = &errb
	cmd.WaitDelay = time.Second
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, api.Errf(504, "checker_timeout", "btwd %s timed out after %s", args[0], c.opts.Timeout)
		}
		return nil, fmt.Errorf("btwd %s: %v: %s", args[0], err, strings.TrimSpace(errb.String()))
	}
	if out.overflow {
		return nil, fmt.Errorf("btwd %s: output over %d bytes", args[0], c.opts.MaxStdout)
	}
	return out.Bytes(), nil
}

// limitedBuffer keeps at most max bytes and notes the overflow (it never fails a Write, so the child is not
// blocked on a full pipe).
type limitedBuffer struct {
	bytes.Buffer
	max      int
	overflow bool
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > b.max {
		b.overflow = true
		p = p[:max(0, b.max-b.Len())]
	}
	b.Buffer.Write(p)
	return len(p), nil
}

func decode(out []byte, v any, what string) error {
	if err := json.Unmarshal(out, v); err != nil {
		return fmt.Errorf("btwd %s: answer is not the expected JSON: %v", what, err)
	}
	return nil
}

func (c *Client) Check(ctx context.Context, text string) (*api.CheckReport, error) {
	out, err := c.run(ctx, text, "check")
	if err != nil {
		return nil, err
	}
	r := &api.CheckReport{}
	if err := decode(out, r, "check"); err != nil {
		return nil, err
	}
	if r.Diagnostics == nil {
		r.Diagnostics = []api.Diagnostic{}
	}
	return r, nil
}

func (c *Client) Fmt(ctx context.Context, text string) (*api.FmtReport, error) {
	out, err := c.run(ctx, text, "fmt")
	if err != nil {
		return nil, err
	}
	r := &api.FmtReport{}
	if err := decode(out, r, "fmt"); err != nil {
		return nil, err
	}
	return r, nil
}

// MaxOpenArg bounds the argument of `btwd open` (argv limits are ~128 KiB per argument on Linux).
const MaxOpenArg = 100 << 10

func (c *Client) Open(ctx context.Context, urlOrCID string) (*api.OpenReport, error) {
	urlOrCID = strings.TrimSpace(urlOrCID)
	if urlOrCID == "" {
		return nil, api.Errf(400, api.CodeBadRequest, "nothing to open: give a link, a fragment or a CID")
	}
	if len(urlOrCID) > MaxOpenArg {
		return nil, api.Errf(413, api.CodeTooLarge, "link is %d bytes; the limit is %d", len(urlOrCID), MaxOpenArg)
	}
	if strings.HasPrefix(urlOrCID, "-") || strings.ContainsRune(urlOrCID, 0) {
		return nil, api.Errf(400, api.CodeBadRequest, "not a btw link or CID")
	}
	out, err := c.run(ctx, "", "open", urlOrCID)
	if err != nil {
		return nil, err
	}
	r := &api.OpenReport{}
	if err := decode(out, r, "open"); err != nil {
		return nil, err
	}
	return r, nil
}

func (c *Client) Share(ctx context.Context, text string) (*api.ShareReport, error) {
	out, err := c.run(ctx, text, "share")
	if err != nil {
		return nil, err
	}
	r := &api.ShareReport{}
	if err := decode(out, r, "share"); err != nil {
		return nil, err
	}
	return r, nil
}

func (c *Client) Highlight(ctx context.Context, text string) ([]api.Span, error) {
	out, err := c.run(ctx, text, "highlight")
	if err != nil {
		return nil, err
	}
	var raw [][]json.RawMessage
	if err := decode(out, &raw, "highlight"); err != nil {
		return nil, err
	}
	spans := make([]api.Span, 0, len(raw))
	for _, t := range raw {
		if len(t) != 3 {
			return nil, fmt.Errorf("btwd highlight: span with %d fields", len(t))
		}
		var s api.Span
		if json.Unmarshal(t[0], &s.Start) != nil || json.Unmarshal(t[1], &s.End) != nil || json.Unmarshal(t[2], &s.Class) != nil {
			return nil, fmt.Errorf("btwd highlight: malformed span %s", t)
		}
		spans = append(spans, s)
	}
	return spans, nil
}

// Instruments and Cheatsheet never change for one binary: the first success is kept.
func (c *Client) Instruments(ctx context.Context) (json.RawMessage, error) {
	c.mu.Lock()
	have := c.instruments
	c.mu.Unlock()
	if have != nil {
		return have, nil
	}
	out, err := c.run(ctx, "", "instruments")
	if err != nil {
		return nil, err
	}
	var probe map[string]json.RawMessage
	if err := decode(out, &probe, "instruments"); err != nil {
		return nil, err
	}
	raw := json.RawMessage(bytes.TrimSpace(out))
	c.mu.Lock()
	c.instruments = raw
	c.mu.Unlock()
	return raw, nil
}

func (c *Client) Cheatsheet(ctx context.Context) (string, error) {
	c.mu.Lock()
	have := c.cheatsheet
	c.mu.Unlock()
	if have != "" {
		return have, nil
	}
	out, err := c.run(ctx, "", "cheatsheet")
	if err != nil {
		return "", err
	}
	s := string(out)
	if strings.TrimSpace(s) == "" {
		return "", errors.New("btwd cheatsheet: empty answer")
	}
	c.mu.Lock()
	c.cheatsheet = s
	c.mu.Unlock()
	return s, nil
}

// Ping runs `btwd instruments` once: a start-up proof the binary runs and speaks the protocol.
func (c *Client) Ping(ctx context.Context) error {
	_, err := c.Instruments(ctx)
	return err
}

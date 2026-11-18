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

	// Per owner (the client address, see WithOwner): one address must not be able to keep every slot busy or
	// to spend all of the host's CPU on programs built to be slow (a 12 KB `evolve` program takes 4 s to check).
	OwnerConcurrent int     // calls in flight per owner; default MaxConcurrent/2 (at least 1)
	OwnerSeconds    float64 // seconds of checker time an owner may bank (and start with); default 30
	OwnerRefill     float64 // seconds of checker time an owner earns back per second; default 0.5
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
	if o.OwnerConcurrent <= 0 {
		o.OwnerConcurrent = max(1, o.MaxConcurrent/2)
	}
	if o.OwnerSeconds <= 0 {
		o.OwnerSeconds = 30
	}
	if o.OwnerRefill <= 0 {
		o.OwnerRefill = 0.5
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

	omu    sync.Mutex
	owners map[string]*ownerState
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
	return &Client{bin: path, opts: opts, sem: make(chan struct{}, opts.MaxConcurrent), owners: map[string]*ownerState{}}, nil
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

// ownerKey is the context key of WithOwner.
type ownerKey struct{}

// WithOwner marks ctx as working for owner (the server passes the client address: api.IPKey(api.ClientIP(r))).
// The checker then limits what one owner can hold at once and how much of its time it can spend; a ctx with no
// owner (start-up, tests, background work) is not limited.
func WithOwner(ctx context.Context, owner string) context.Context {
	if owner == "" {
		return ctx
	}
	return context.WithValue(ctx, ownerKey{}, owner)
}

// OwnerFrom is the owner WithOwner put on ctx ("" for none).
func OwnerFrom(ctx context.Context) string {
	s, _ := ctx.Value(ownerKey{}).(string)
	return s
}

// ownerState is one owner's slots and banked checker time.
type ownerState struct {
	sem  chan struct{} // calls in flight
	bal  float64       // seconds of checker time left; negative after a call that ran past it
	at   time.Time     // when bal was last brought up to date
	refs int           // calls in flight or waiting
}

const maxOwners = 50000

// acquireOwner takes one of the owner's slots (waiting for one until ctx ends) after checking its time budget.
// The returned func releases the slot and charges the time the call took.
func (c *Client) acquireOwner(ctx context.Context, key string) (func(time.Duration), error) {
	now := time.Now()
	c.omu.Lock()
	st := c.owners[key]
	if st == nil {
		if len(c.owners) >= maxOwners { // a flood of distinct owners: forget the idle ones rather than grow without bound
			for k, o := range c.owners {
				if o.refs == 0 {
					delete(c.owners, k)
				}
			}
		}
		st = &ownerState{sem: make(chan struct{}, c.opts.OwnerConcurrent), bal: c.opts.OwnerSeconds, at: now}
		c.owners[key] = st
	}
	st.bal = min(c.opts.OwnerSeconds, st.bal+now.Sub(st.at).Seconds()*c.opts.OwnerRefill)
	st.at = now
	if st.bal <= 0 {
		wait := int((-st.bal)/c.opts.OwnerRefill) + 1
		c.omu.Unlock()
		e := api.Errf(429, api.CodeRateLimited, "your address has used its share of the checker's time (programs that take seconds to check add up); try again in %ds", wait)
		e.RetryAfter = wait
		return nil, e
	}
	st.refs++
	c.omu.Unlock()
	drop := func() {
		c.omu.Lock()
		st.refs--
		c.omu.Unlock()
	}
	select {
	case st.sem <- struct{}{}:
	case <-ctx.Done():
		drop()
		return nil, busy()
	}
	return func(took time.Duration) {
		<-st.sem
		c.omu.Lock()
		st.refs--
		st.bal -= took.Seconds()
		c.omu.Unlock()
	}, nil
}

// run executes `btwd args...` with stdin and returns stdout.
func (c *Client) run(ctx context.Context, stdin string, args ...string) ([]byte, error) {
	if len(stdin) > c.opts.MaxStdin {
		return nil, api.Errf(413, api.CodeTooLarge, "program text is %d bytes; the limit is %d", len(stdin), c.opts.MaxStdin)
	}
	ctx, cancel := context.WithTimeout(ctx, c.opts.Timeout)
	defer cancel()
	var began time.Time // when the process got its slot: what the owner is charged from
	if key := OwnerFrom(ctx); key != "" {
		release, err := c.acquireOwner(ctx, key)
		if err != nil {
			return nil, err
		}
		defer func() {
			var took time.Duration
			if !began.IsZero() {
				took = time.Since(began)
			}
			release(took)
		}()
	}
	select {
	case c.sem <- struct{}{}:
		defer func() { <-c.sem }()
	case <-ctx.Done():
		return nil, busy()
	}
	began = time.Now()
	cmd := exec.CommandContext(ctx, c.bin, args...)
	cmd.Env = c.env()
	cmd.Stdin = strings.NewReader(stdin)
	var out, errb limitedBuffer
	out.max = c.opts.MaxStdout
	out.onOverflow = cancel // a child that has said more than we keep is killed, not left to finish
	errb.max = 4096
	cmd.Stdout = &out
	cmd.Stderr = &errb
	cmd.WaitDelay = time.Second
	err := cmd.Run()
	if out.overflow {
		return nil, api.Errf(422, api.CodeBadRequest, "btwd %s: the answer is over %d bytes: a program or link with that many problems cannot be reported; fix the first ones and try again", args[0], c.opts.MaxStdout)
	}
	if err != nil {
		if ctx.Err() != nil {
			return nil, api.Errf(504, "checker_timeout", "btwd %s timed out after %s", args[0], c.opts.Timeout)
		}
		return nil, fmt.Errorf("btwd %s: %v: %s", args[0], err, strings.TrimSpace(errb.String()))
	}
	return out.Bytes(), nil
}

// limitedBuffer keeps at most max bytes and notes the overflow. It never fails a Write (and says it took all
// of p), so the child is not blocked on a full pipe. It is deliberately not a bytes.Buffer by embedding: that
// would hand io.Copy a ReadFrom that fills the buffer without ever calling Write, and the cap would not exist.
type limitedBuffer struct {
	buf        bytes.Buffer
	max        int
	overflow   bool
	onOverflow func() // called once, the first time something is dropped
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if room := b.max - b.buf.Len(); n > room {
		if !b.overflow && b.onOverflow != nil {
			b.onOverflow()
		}
		b.overflow = true
		p = p[:max(0, room)]
	}
	b.buf.Write(p)
	return n, nil
}

func (b *limitedBuffer) Bytes() []byte  { return b.buf.Bytes() }
func (b *limitedBuffer) String() string { return b.buf.String() }

func decode(out []byte, v any, what string) error {
	if err := json.Unmarshal(out, v); err != nil {
		return fmt.Errorf("btwd %s: answer is not the expected JSON: %v", what, err)
	}
	return nil
}

// MaxDiagnostics is how many diagnostics of one answer are kept. `errors` and `warnings` still count them all;
// a 60 KB text of junk is 30 000 errors and 17 MB of caret-form messages, which nobody can read and which a
// 128 KB request must not be able to turn into a megabyte response (or a model prompt).
const MaxDiagnostics = 200

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
	if len(r.Diagnostics) > MaxDiagnostics {
		r.Diagnostics = r.Diagnostics[:MaxDiagnostics:MaxDiagnostics]
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
	if len(r.Diagnostics) > MaxDiagnostics {
		r.Diagnostics = r.Diagnostics[:MaxDiagnostics:MaxDiagnostics]
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

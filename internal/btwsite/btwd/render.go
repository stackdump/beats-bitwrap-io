package btwd

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
)

// RenderOptions are the flags of `btwd render`.
type RenderOptions struct {
	SampleRate int // default 44100
	ChunkMS    int // default 250
	MaxBars    int // 0 = btwd's own default
	FromBar    int
}

// RenderStart is the `start` event btwd prints on stderr before the first PCM byte.
type RenderStart struct {
	SampleRate int      `json:"sample_rate"`
	Channels   int      `json:"channels"`
	Format     string   `json:"format"`
	Seconds    float64  `json:"seconds"`
	Bars       int      `json:"bars"`
	BPM        float64  `json:"bpm"`
	Notes      []string `json:"notes,omitempty"`
}

// Renderer starts renders. *Client is one; the server takes this interface so tests can supply another.
type Renderer interface {
	StartRender(ctx context.Context, text string, o RenderOptions) (*RenderProc, error)
}

var _ Renderer = (*Client)(nil)

// RenderProc is a running `btwd render`: read PCM until EOF, then call Wait.
type RenderProc struct {
	Start RenderStart
	PCM   io.Reader // raw interleaved stereo s16le

	cmd      *exec.Cmd
	progress atomic.Uint64 // math.Float64bits of seconds rendered
	done     chan struct{} // stderr reader finished
	mu       sync.Mutex
	endSecs  float64
	gotEnd   bool
	errMsg   string
	stderrTl []string
}

// event is one JSON line on btwd's stderr.
type event struct {
	Event           string  `json:"event"`
	Message         string  `json:"message"`
	SecondsRendered float64 `json:"seconds_rendered"`
	RenderStart             // "seconds" is the song length on start and the rendered length on end
}

// Progress is the seconds of audio rendered so far, from the progress events.
func (p *RenderProc) Progress() float64 { return math.Float64frombits(p.progress.Load()) }

// Pid is the child's process id (0 once unknown), for tests and logs.
func (p *RenderProc) Pid() int {
	if p.cmd != nil && p.cmd.Process != nil {
		return p.cmd.Process.Pid
	}
	return 0
}

// Kill stops the child now. Read to EOF / call Wait afterwards as usual.
func (p *RenderProc) Kill() {
	if p.cmd != nil && p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
}

// Wait reaps the child. It returns nil only for exit 0 with no error event. Call it after PCM has hit
// EOF (or after Kill).
func (p *RenderProc) Wait() error {
	// stderr first: it hits EOF when the child exits, and cmd.Wait would close the pipe under the reader
	select {
	case <-p.done:
	case <-time.After(10 * time.Second):
	}
	werr := p.cmd.Wait()
	<-p.done
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.errMsg != "" {
		return fmt.Errorf("render failed: %s", p.errMsg)
	}
	if werr != nil {
		tail := strings.Join(p.stderrTl, "; ")
		return fmt.Errorf("btwd render: %v: %s", werr, tail)
	}
	return nil
}

// StartRender runs `btwd render` on text, waits for the start event and returns the process with its
// PCM stream. An error event before the start (a program with errors, an asset or restricted program,
// too many bars) is returned as a 422 *api.Error. The child dies with ctx.
func (c *Client) StartRender(ctx context.Context, text string, o RenderOptions) (*RenderProc, error) {
	if len(text) > c.opts.MaxStdin {
		return nil, api.Errf(413, api.CodeTooLarge, "program text is %d bytes; the limit is %d", len(text), c.opts.MaxStdin)
	}
	if o.SampleRate <= 0 {
		o.SampleRate = 44100
	}
	if o.ChunkMS <= 0 {
		o.ChunkMS = 250
	}
	args := []string{"render", "--sr", strconv.Itoa(o.SampleRate), "--format", "s16le", "--chunk-ms", strconv.Itoa(o.ChunkMS)}
	if o.MaxBars > 0 {
		args = append(args, "--max-bars", strconv.Itoa(o.MaxBars))
	}
	if o.FromBar > 0 {
		args = append(args, "--from-bar", strconv.Itoa(o.FromBar))
	}
	cmd := exec.CommandContext(ctx, c.bin, args...)
	cmd.Env = c.env()
	cmd.WaitDelay = 2 * time.Second
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("btwd render: %w", err)
	}
	go func() {
		_, _ = io.WriteString(stdin, text)
		_ = stdin.Close()
	}()
	p := &RenderProc{cmd: cmd, PCM: stdout, done: make(chan struct{})}
	first := make(chan event, 1)
	go p.readEvents(stderr, first)

	startTimeout := 30 * time.Second
	select {
	case ev, ok := <-first:
		if !ok {
			// stderr closed with no event at all: the process died or is not btwd
			_ = cmd.Process.Kill()
			werr := p.Wait()
			return nil, fmt.Errorf("btwd render gave no start event: %v", werr)
		}
		switch ev.Event {
		case "start":
			p.Start = ev.RenderStart
			if p.Start.SampleRate <= 0 {
				p.Start.SampleRate = o.SampleRate
			}
			if p.Start.Channels <= 0 {
				p.Start.Channels = 2
			}
			return p, nil
		case "error":
			_ = cmd.Process.Kill()
			_ = p.Wait()
			return nil, api.Errf(422, "render_failed", "%s", ev.Message)
		default:
			_ = cmd.Process.Kill()
			_ = p.Wait()
			return nil, fmt.Errorf("btwd render: unexpected first event %q", ev.Event)
		}
	case <-time.After(startTimeout):
		_ = cmd.Process.Kill()
		_ = p.Wait()
		return nil, api.Errf(504, "checker_timeout", "btwd render did not start within %s", startTimeout)
	case <-ctx.Done():
		_ = cmd.Process.Kill()
		_ = p.Wait()
		return nil, ctx.Err()
	}
}

// readEvents parses stderr lines. The first event goes to first (then it closes the channel after
// handing it over); later ones update progress / end / error state.
func (p *RenderProc) readEvents(r io.Reader, first chan<- event) {
	defer close(p.done)
	br := bufio.NewReaderSize(r, 64<<10)
	sent := false
	for {
		line, err := br.ReadString('\n')
		line = strings.TrimSpace(line)
		if line != "" {
			var ev event
			if json.Unmarshal([]byte(line), &ev) == nil && ev.Event != "" {
				if !sent {
					first <- ev
					sent = true
					if ev.Event == "start" {
						// keep going: progress and end follow
						continue
					}
				}
				switch ev.Event {
				case "progress":
					p.progress.Store(math.Float64bits(ev.SecondsRendered))
				case "end":
					p.mu.Lock()
					p.gotEnd, p.endSecs = true, ev.RenderStart.Seconds
					p.mu.Unlock()
				case "error":
					p.mu.Lock()
					p.errMsg = ev.Message
					p.mu.Unlock()
				}
			} else {
				p.mu.Lock()
				if len(p.stderrTl) < 5 {
					if len(line) > 200 {
						line = line[:200]
					}
					p.stderrTl = append(p.stderrTl, line)
				}
				p.mu.Unlock()
			}
		}
		if err != nil {
			break
		}
	}
	if !sent {
		close(first)
	}
}

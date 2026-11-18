//go:build live

package compose

// The real thing: the real model, the real btwd, three real prompts. Not part of `go test ./...`.
//
//	GEMINI_API_KEY=… BTWD_BIN=/path/to/btwd \
//	  go test -tags live -run TestLiveCompose -v -timeout 15m ./internal/btwsite/compose/
//
// Optional: BTW_MODEL (default gemini-3.8-flash), BTW_THINKING (MINIMAL|LOW|MEDIUM|HIGH, default LOW),
// BTW_LIVE_EXAMPLES (a directory of *.btw, default btwsite/examples), BTW_LIVE_OUT (the file to write,
// default btwsite/testdata/compose/real-<UTC date>.json). Skipped without the key or the binary.
//
// It writes the prompt, the program, the CID, every attempt, tokens, cost and the model to the JSON file. The
// key is never written anywhere: it goes in a request header and error texts are redacted.

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
	"beats-bitwrap-io/internal/btwsite/btwd"
	"beats-bitwrap-io/internal/btwsite/limits"
)

var livePrompts = []string{
	"dark techno 128 with an acid line",
	"happy hardcore 174",
	"ambient piano with evolving arp",
}

type liveRun struct {
	Prompt     string        `json:"prompt"`
	OK         bool          `json:"ok"`
	Error      string        `json:"error,omitempty"`
	Program    string        `json:"program,omitempty"`
	CID        string        `json:"cid,omitempty"`
	Bars       int           `json:"bars,omitempty"`
	Seconds    float64       `json:"seconds,omitempty"`
	Attempts   []api.Attempt `json:"attempts,omitempty"`
	Usage      api.Usage     `json:"usage"`
	CostUSD    float64       `json:"cost_usd"`
	Model      string        `json:"model"`
	WallSecs   float64       `json:"wall_seconds"`
	ShareURL   string        `json:"share_url,omitempty"`
	ComposedBy string        `json:"composed_by,omitempty"`
}

func TestLiveCompose(t *testing.T) {
	key := os.Getenv("GEMINI_API_KEY")
	bin := os.Getenv("BTWD_BIN")
	if key == "" || bin == "" {
		t.Skip("set GEMINI_API_KEY and BTWD_BIN to run the live compose test")
	}
	chk, err := btwd.New(bin, btwd.Options{})
	if err != nil {
		t.Fatal(err)
	}
	exDir := os.Getenv("BTW_LIVE_EXAMPLES")
	if exDir == "" {
		exDir = filepath.Join("..", "..", "..", "btwsite", "examples")
	}
	exs, texts := loadExamplesDir(t, chk, exDir)
	t.Logf("examples available for the prompt: %d", len(exs))

	svc, err := New(Options{
		Checker: chk, Store: newMemStore(chk),
		Examples: func() []api.Example { return exs }, ExampleText: func(n string) (string, bool) { s, ok := texts[n]; return s, ok },
		DataDir: t.TempDir(), PublicURL: "https://btw.bitwrap.io",
		Model: os.Getenv("BTW_MODEL"), APIKey: key, Thinking: os.Getenv("BTW_THINKING"),
		Limits: limits.Config{DailySpendUSD: 1.00, UserHour: 20, UserDay: 20, IPDay: 20},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close()
	st := svc.Status()
	if !st.Configured {
		t.Fatalf("not configured: %s", st.Reason)
	}

	var runs []liveRun
	var total float64
	for _, p := range livePrompts {
		started := time.Now()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		res, err := svc.Compose(ctx, &api.User{ID: "live-test", Kind: "ed25519", Address: "live-test", Via: "token"}, "127.0.0.1", api.ComposeRequest{Prompt: p})
		cancel()
		run := liveRun{Prompt: p, Model: st.Model, WallSecs: time.Since(started).Seconds()}
		if err != nil {
			run.Error = err.Error()
			if ae, ok := err.(*api.Error); ok {
				if d, ok := ae.Details.(map[string]any); ok {
					if at, ok := d["attempts"].([]api.Attempt); ok {
						run.Attempts = at
					}
					if c, ok := d["cost_usd"].(float64); ok {
						run.CostUSD = c
					}
				}
			}
			t.Errorf("%q: %v", p, err)
		} else {
			run.OK = true
			run.Program, run.CID, run.Attempts, run.Usage, run.CostUSD = res.Program, res.CID, res.Attempts, res.Usage, res.CostUSD
			run.ShareURL, run.ComposedBy = res.ShareURL, res.ComposedBy
			run.Bars = res.Check.SongBars
			if res.Check.Seconds != nil {
				run.Seconds = *res.Check.Seconds
			}
			if !res.Check.OK || res.CID == "" || res.Check.Restricted || res.Check.UsesAssets {
				t.Errorf("%q: result is not a clean program: %+v", p, res.Check)
			}
			if strings.Contains(res.Program, "#!") {
				t.Errorf("%q: header in the canonical text", p)
			}
			t.Logf("%q: cid %s, %d attempt(s), %d in / %d out tokens, $%.5f, %.1fs of music, wall %.1fs", p, res.CID, len(res.Attempts), res.Usage.In, res.Usage.Out, res.CostUSD, run.Seconds, run.WallSecs)
		}
		total += run.CostUSD
		runs = append(runs, run)
	}

	out := os.Getenv("BTW_LIVE_OUT")
	if out == "" {
		out = filepath.Join("..", "..", "..", "btwsite", "testdata", "compose", "real-"+time.Now().UTC().Format("2006-01-02")+".json")
	}
	doc := map[string]any{
		"generated": time.Now().UTC().Format(time.RFC3339), "model": st.Model, "thinking": svc.think, "max_output_tokens": svc.opt.MaxOutputTokens,
		"max_repair": svc.opt.MaxRepair, "prompt_examples": svc.exampleNames(), "total_cost_usd": total, "runs": runs,
	}
	b, _ := json.MarshalIndent(doc, "", " ")
	if bytesHasKey(b, key) {
		t.Fatal("the key is in the output: refusing to write it")
	}
	if err := os.WriteFile(out, append(b, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Logf("wrote %s (total $%.5f)", out, total)
}

func bytesHasKey(b []byte, key string) bool { return key != "" && strings.Contains(string(b), key) }

func (s *Service) exampleNames() []string {
	s.pc.mu.Lock()
	defer s.pc.mu.Unlock()
	return append([]string(nil), s.pc.names...)
}

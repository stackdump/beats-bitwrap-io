package server

import (
	"encoding/json"
	"strings"
	"testing"

	"beats-bitwrap-io/internal/btwsite/api"
)

// The phone's Code tab sends the program in its editor ("current") with every prompt after the first. Several
// prompts in a row from one paired phone must all compose: this is the bug where only the first one did.
func TestDeviceComposeSeveralPromptsInARow(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.ComposeUserHour = 20; c.ComposeUserDay = 20 }, "BTW_FAKE_SECONDS=2")
	u := e.newUser()
	p := newPhone(12)
	e.pairPhone(u, p)

	prompts := []string{
		"dark techno 128 with an acid line",
		"make it faster",
		`add a "hi-hat" roll\nand a break`,
		"ünïcödé 🎛 bass, slower",
		"keep it, but end after 32 bars",
	}
	current := ""
	for i, prompt := range prompts {
		req := map[string]any{"prompt": prompt}
		if current != "" {
			req["current"] = current
		}
		body, _ := json.Marshal(req)
		var out composeOut
		if st := decode(t, e.signed(p, "POST", "/api/device/compose", body), &out); st != 200 {
			t.Fatalf("prompt %d (%q, current %d bytes): status %d", i+1, prompt, len(current), st)
		}
		if out.CID == "" || out.Program == "" || out.Check == nil || !out.Check.OK {
			t.Fatalf("prompt %d: %+v", i+1, out)
		}
		current = out.Program // what the editor holds now
	}

	// the same series through the web route
	current = ""
	for i, prompt := range prompts[:3] {
		req := map[string]any{"prompt": prompt}
		if current != "" {
			req["current"] = current
		}
		var out composeOut
		if st := decode(t, e.post("/api/compose", req, cookie(u.cookie)), &out); st != 200 {
			t.Fatalf("web prompt %d: status %d", i+1, st)
		}
		current = out.Program
	}
}

// A current program that cannot go to the model is a clear 400, and an unknown field names itself.
func TestDeviceComposeCurrentRefusals(t *testing.T) {
	e := newEnv(t, nil, "BTW_FAKE_SECONDS=2")
	u := e.newUser()
	p := newPhone(13)
	e.pairPhone(u, p)

	body, _ := json.Marshal(map[string]any{"prompt": "x", "current": "#! visibility: private\ntempo 120\ndeck A: kick x ~ x ~\n"})
	st, code := errCode(t, e.signed(p, "POST", "/api/device/compose", body))
	if st != 400 || code != api.CodeBadRequest {
		t.Fatalf("private current: %d %s", st, code)
	}

	body, _ = json.Marshal(map[string]any{"prompt": "x", "current": strings.Repeat("# long\n", 4000)})
	if st, _ := errCode(t, e.signed(p, "POST", "/api/device/compose", body)); st != 413 {
		t.Fatalf("oversize current: %d", st)
	}

	body, _ = json.Marshal(map[string]any{"prompt": "x", "model": "pro"})
	r := e.signed(p, "POST", "/api/device/compose", body)
	var eb struct {
		Error struct{ Message string } `json:"error"`
	}
	if st := decode(t, r, &eb); st != 400 || !strings.Contains(eb.Error.Message, "unknown field") {
		t.Fatalf("unknown field: %d %q", st, eb.Error.Message)
	}
}

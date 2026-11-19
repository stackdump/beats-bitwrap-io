package server

import (
	"encoding/json"
	"strings"
	"testing"

	"beats-bitwrap-io/internal/btwsite/api"
)

// A paired phone composes as its owner: the result comes back to the phone, stored with provenance, and it
// counts against the owner's per-user allowance shared with the web route.
func TestDeviceCompose(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.ComposeUserHour = 2 }, "BTW_FAKE_SECONDS=2")
	u := e.newUser()
	p := newPhone(11)
	e.pairPhone(u, p)

	body, _ := json.Marshal(map[string]any{"prompt": "dark techno 128 with an acid line", "length": "short"})
	var out composeOut
	if st := decode(t, e.signed(p, "POST", "/api/device/compose", body), &out); st != 200 {
		t.Fatalf("device compose: %d", st)
	}
	if out.CID == "" || out.Program == "" || out.Check == nil || !out.Check.OK || !strings.HasPrefix(out.ShareURL, "https://btw.test/#"+out.CID+".") {
		t.Fatalf("device compose result: %+v", out)
	}
	var prog api.Program
	if st := decode(t, e.get("/api/programs/"+out.CID), &prog); st != 200 || prog.Meta.Source != "compose" {
		t.Fatalf("stored: %d %+v", st, prog.Meta)
	}

	// a numeric length is fine
	body, _ = json.Marshal(map[string]any{"prompt": "ambient", "length": 16})
	if st := decode(t, e.signed(p, "POST", "/api/device/compose", body), nil); st != 200 {
		t.Fatalf("second compose: %d", st)
	}
	// the owner's allowance (2 an hour) is spent: the web route is refused too, and so is the phone
	if st, code := errCode(t, e.post("/api/compose", composeBody("web"), cookie(u.cookie))); st != 429 || code != api.CodeRateLimited {
		t.Fatalf("web after phone: %d %s", st, code)
	}
	body, _ = json.Marshal(map[string]any{"prompt": "third"})
	if st, code := errCode(t, e.signed(p, "POST", "/api/device/compose", body)); st != 429 || code != api.CodeRateLimited {
		t.Fatalf("phone over the limit: %d %s", st, code)
	}

	// refusals: unsigned, an empty prompt, an unknown field, a replay
	if st, _ := errCode(t, e.post("/api/device/compose", map[string]any{"prompt": "x"}, cookie(u.cookie))); st != 401 {
		t.Fatalf("cookie on the device route: %d", st)
	}
	body, _ = json.Marshal(map[string]any{"prompt": "  "})
	if st, _ := errCode(t, e.signed(p, "POST", "/api/device/compose", body)); st != 400 {
		t.Fatalf("empty prompt: %d", st)
	}
	body, _ = json.Marshal(map[string]any{"prompt": "x", "model": "pro"})
	if st, _ := errCode(t, e.signed(p, "POST", "/api/device/compose", body)); st != 400 {
		t.Fatalf("unknown field: %d", st)
	}
	// unpaired: 410
	e.srv.unpair(p.device, "", "test")
	body, _ = json.Marshal(map[string]any{"prompt": "x"})
	if st, code := errCode(t, e.signed(p, "POST", "/api/device/compose", body)); st != 410 || code != "unpaired" {
		t.Fatalf("unpaired: %d %s", st, code)
	}
}

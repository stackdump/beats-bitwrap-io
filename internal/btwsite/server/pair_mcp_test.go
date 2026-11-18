package server

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
)

// Pairing is the MCP grant: the owner's token lists the phone and drives it by device id; nobody else's does.
func TestPairMCPDevices(t *testing.T) {
	e := newEnv(t, nil)
	u := e.newUser()
	tok := e.token(u)
	p := newPhone(9)

	// nothing paired yet
	out, isErr := toolResult(t, mcp(t, e, tok, "tools/call", map[string]any{"name": "devices", "arguments": map[string]any{}}))
	if isErr || len(out["devices"].([]any)) != 0 {
		t.Fatalf("devices before pairing: %v %v", isErr, out)
	}
	// anonymous: refused
	if _, isErr := toolResult(t, mcp(t, e, "", "tools/call", map[string]any{"name": "devices", "arguments": map[string]any{}})); !isErr {
		t.Fatal("devices without a token answered")
	}

	e.pairPhone(u, p)
	out, _ = toolResult(t, mcp(t, e, tok, "tools/call", map[string]any{"name": "devices", "arguments": map[string]any{}}))
	devs := out["devices"].([]any)
	d0 := devs[0].(map[string]any)
	if len(devs) != 1 || d0["id"] != p.device || d0["fingerprint"] != KeyFingerprint(p.key) || d0["connected"] != false {
		t.Fatalf("devices after pairing: %v", out)
	}
	// paired, not connected: eval by device is no_session
	out, isErr = toolResult(t, mcp(t, e, tok, "tools/call", map[string]any{"name": "eval", "arguments": map[string]any{"text": progA, "device": p.device}}))
	if !isErr || !strings.Contains(fmt.Sprint(out), "no_session") {
		t.Fatalf("eval to an unconnected phone: %v %v", isErr, out)
	}

	c := e.sse("/api/device/events", func(r *http.Request) {
		ts := e.clk.Now().UnixMilli()
		sig := ed25519.Sign(p.priv, []byte(RequestMessage("btw.test", p.device, "GET", "/api/device/events", ts, nil)))
		r.Header.Set("Authorization", fmt.Sprintf("BtwDevice %s.%d.%s", p.device, ts, base64.RawURLEncoding.EncodeToString(sig)))
	})
	c.next(t, "hello", 2*time.Second)
	out, _ = toolResult(t, mcp(t, e, tok, "tools/call", map[string]any{"name": "devices", "arguments": map[string]any{}}))
	if d := out["devices"].([]any)[0].(map[string]any); d["connected"] != true || d["session"] == "" || out["connected"].(float64) != 1 {
		t.Fatalf("devices when connected: %v", out)
	}

	out, isErr = toolResult(t, mcp(t, e, tok, "tools/call", map[string]any{"name": "eval", "arguments": map[string]any{"text": progA, "play": true, "device": p.device}}))
	if isErr || out["delivered"].(float64) != 1 {
		t.Fatalf("eval by device: %v %v", isErr, out)
	}
	var ev api.SessionEvent
	json.Unmarshal([]byte(c.next(t, "eval", 2*time.Second).data), &ev)
	if ev.Text != progA || !ev.Play {
		t.Fatalf("phone got %+v", ev)
	}
	if _, isErr = toolResult(t, mcp(t, e, tok, "tools/call", map[string]any{"name": "stop", "arguments": map[string]any{"device": p.device}})); isErr {
		t.Fatal("stop by device failed")
	}
	c.next(t, "stop", 2*time.Second)

	// session and device together: refused
	if _, isErr = toolResult(t, mcp(t, e, tok, "tools/call", map[string]any{"name": "stop", "arguments": map[string]any{"device": p.device, "session": "abcdefgh"}})); !isErr {
		t.Fatal("session+device accepted")
	}
	// another account's token neither lists nor drives the phone
	other := e.token(e.newUser())
	out, _ = toolResult(t, mcp(t, e, other, "tools/call", map[string]any{"name": "devices", "arguments": map[string]any{}}))
	if len(out["devices"].([]any)) != 0 {
		t.Fatalf("other account sees: %v", out)
	}
	out, isErr = toolResult(t, mcp(t, e, other, "tools/call", map[string]any{"name": "stop", "arguments": map[string]any{"device": p.device}}))
	if !isErr || !strings.Contains(fmt.Sprint(out), "not_found") {
		t.Fatalf("other account drives the phone: %v %v", isErr, out)
	}
}

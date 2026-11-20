package mcpsrv_test

import (
	"context"
	"strings"
	"testing"

	"beats-bitwrap-io/internal/btwsite/api"
	"beats-bitwrap-io/internal/btwsite/mcpsrv"
)

const otherProgram = "#! btw 1\ntempo 120\nkey am\nsection a 4 bars {\n  deck A: kick x ~ ~ ~\n}\n"

func TestQueueNeedsAToken(t *testing.T) {
	e := newEnv(t)
	em := e.call("", "queue", map[string]any{"action": "list"}).errBody(t)
	if em["code"] != "auth_required" {
		t.Fatalf("anonymous queue = %v", em)
	}
	if len(e.b.queueOps) != 0 {
		t.Fatal("an anonymous call reached the backend")
	}
}

func TestQueueAddValidatesItems(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	p, _, err := e.b.Put(ctx, goodProgram, api.Meta{Name: "stored one"})
	if err != nil {
		t.Fatal(err)
	}
	demoCID := e.b.Examples()[0].CID
	share, _ := e.b.Share(ctx, otherProgram) // a link to a program the site does not store

	r := e.call("btw_alice", "queue", map[string]any{"action": "add", "session": "abcdefABCDEF123456", "items": []any{
		map[string]any{"cid": p.CID},
		map[string]any{"example": "demo", "bars": 16},
		map[string]any{"url": share.URL, "minutes": 2.5, "title": "from a link"},
		map[string]any{"cid": demoCID},
	}})
	if r.IsError {
		t.Fatalf("add: %s", r.Text)
	}
	if len(e.b.queueOps) != 1 || e.b.queueSess[0] != "abcdefABCDEF123456" || e.b.queueUser[0] == nil {
		t.Fatalf("backend calls: %+v %v", e.b.queueOps, e.b.queueSess)
	}
	it := e.b.queueOps[0].Items
	if len(it) != 4 ||
		it[0].CID != p.CID || it[0].Source != "store" || it[0].Title != "stored one" || it[0].Text != "" ||
		it[1].Source != "example" || it[1].Example != "demo" || it[1].Bars != 16 || it[1].CID != demoCID ||
		it[2].Source != "link" || it[2].CID != share.CID || it[2].Text == "" || it[2].Minutes != 2.5 || it[2].Title != "from a link" ||
		it[3].CID != demoCID {
		t.Fatalf("items: %+v", it)
	}
	if b := r.body(t); !strings.Contains(b["note"].(string), "Nothing is composed") {
		t.Fatalf("add answer: %v", b)
	}

	bad := []struct {
		name string
		item map[string]any
		code string
	}{
		{"unknown cid", map[string]any{"cid": "z" + strings.Repeat("A", 40)}, "not_found"},
		{"unknown example", map[string]any{"example": "nope"}, "not_found"},
		{"two sources", map[string]any{"cid": p.CID, "example": "demo"}, "bad_request"},
		{"no source", map[string]any{"bars": 4}, "bad_request"},
		{"bars and minutes", map[string]any{"cid": p.CID, "bars": 4, "minutes": 1}, "bad_request"},
		{"bars out of range", map[string]any{"cid": p.CID, "bars": 5000}, "bad_request"},
		{"fractional bars", map[string]any{"cid": p.CID, "bars": 2.5}, "bad_request"},
		{"minutes out of range", map[string]any{"cid": p.CID, "minutes": 500}, "bad_request"},
		{"two-line title", map[string]any{"cid": p.CID, "title": "a\nb"}, "bad_request"},
		{"unknown field", map[string]any{"cid": p.CID, "prompt": "compose me something"}, "bad_request"},
		{"a link that does not verify", map[string]any{"url": "https://btw.bitwrap.io/#zNotACid.garbage"}, ""},
	}
	for _, c := range bad {
		em := e.call("btw_alice", "queue", map[string]any{"action": "add", "items": []any{c.item}}).errBody(t)
		if c.code != "" && em["code"] != c.code {
			t.Errorf("%s: %v", c.name, em)
		}
	}
	if len(e.b.queueOps) != 1 {
		t.Fatalf("a refused add reached the backend: %d", len(e.b.queueOps))
	}
	// the call's own shape
	for _, args := range []map[string]any{
		{"action": "add"},
		{"action": "add", "items": []any{}},
		{"action": "list", "items": []any{map[string]any{"cid": p.CID}}},
		{"action": "remove"},
		{"action": "list", "item": "q1"},
		{"action": "play"},
		{"action": "list", "sesion": "abcdefABCDEF123456"},
	} {
		if em := e.call("btw_alice", "queue", args).errBody(t); em["code"] != "bad_request" {
			t.Errorf("%v: %v", args, em)
		}
	}
	// at most 20 items per add
	many := make([]any, 21)
	for i := range many {
		many[i] = map[string]any{"cid": p.CID}
	}
	if em := e.call("btw_alice", "queue", map[string]any{"action": "add", "items": many}).errBody(t); em["code"] != "too_large" && em["code"] != "bad_request" {
		t.Fatalf("21 items: %v", em)
	}
}

func TestQueueNeverComposes(t *testing.T) {
	e := newEnv(t)
	p, _, _ := e.b.Put(context.Background(), goodProgram, api.Meta{})
	for _, a := range []map[string]any{
		{"action": "add", "items": []any{map[string]any{"cid": p.CID}}},
		{"action": "list"}, {"action": "skip"}, {"action": "remove", "item": "q1"}, {"action": "clear"},
	} {
		e.call("btw_alice", "queue", a)
	}
	if len(e.b.composes) != 0 {
		t.Fatalf("the queue called compose: %+v", e.b.composes)
	}
	// and the description says so, to the model
	m := e.rpc("", "tools/list", map[string]any{}, nil)
	if !strings.Contains(string(m.Result), "NEVER COMPOSES") {
		t.Fatal("the queue's description must say it never composes")
	}
}

func TestQueueSkipAndPausedReason(t *testing.T) {
	e := newEnv(t)
	e.b.queueView = &api.QueueView{UpNext: []api.QueueItem{{ID: "q1", CID: "zx"}}, PausedReason: "idle_hidden", Listener: "idle_hidden"}
	b := e.call("btw_alice", "queue", map[string]any{"action": "skip"}).body(t)
	if b["skipped"] != false || !strings.Contains(b["note"].(string), "paused (idle_hidden)") ||
		b["queue"].(map[string]any)["paused_reason"] != "idle_hidden" {
		t.Fatalf("skip while paused: %v", b)
	}
	e.b.queueView = &api.QueueView{UpNext: []api.QueueItem{{ID: "q1", CID: "zx"}}, Listener: "present"}
	e.b.queueSent = true
	if b := e.call("btw_alice", "queue", map[string]any{"action": "skip"}).body(t); b["skipped"] != true {
		t.Fatalf("skip: %v", b)
	}
	// list reports paused_reason
	e.b.queueView = &api.QueueView{UpNext: []api.QueueItem{}, PausedReason: "max_auto_advance", Listener: "present", Position: 8}
	q := e.call("btw_alice", "queue", map[string]any{"action": "list"}).body(t)["queue"].(map[string]any)
	if q["paused_reason"] != "max_auto_advance" || q["position"] != float64(8) {
		t.Fatalf("list: %v", q)
	}
	// get reports up_next and the queue position
	e.b.state = &api.SessionState{CID: "zq", Playing: true}
	e.b.queueView = &api.QueueView{UpNext: []api.QueueItem{{ID: "q3", CID: "zNext", Title: "next one"}}, Position: 2,
		NowPlaying: &api.QueueItem{ID: "q2", CID: "zq"}, PausedReason: "audio_suspended", Listener: "audio_suspended"}
	g := e.call("btw_alice", "get", map[string]any{"session": "abcdefABCDEF123456"}).body(t)
	un, _ := g["up_next"].([]any)
	gq, _ := g["queue"].(map[string]any)
	if len(un) != 1 || un[0].(map[string]any)["cid"] != "zNext" || un[0].(map[string]any)["title"] != "next one" ||
		gq["position"] != float64(2) || gq["paused_reason"] != "audio_suspended" || gq["length"] != float64(1) {
		t.Fatalf("get: %v", g)
	}
}

func TestQueueWritesAreRateLimited(t *testing.T) {
	e := newEnv(t, mcpsrv.WithQueueWritesPerMin(3))
	for i := 0; i < 3; i++ {
		if r := e.call("btw_alice", "queue", map[string]any{"action": "clear"}); r.IsError {
			t.Fatalf("clear %d: %s", i, r.Text)
		}
	}
	if em := e.call("btw_alice", "queue", map[string]any{"action": "clear"}).errBody(t); em["code"] != "rate_limited" {
		t.Fatalf("4th write: %v", em)
	}
	// reads are not writes
	if r := e.call("btw_alice", "queue", map[string]any{"action": "list"}); r.IsError {
		t.Fatalf("list after the limit: %s", r.Text)
	}
}

func TestQueueNoSession(t *testing.T) {
	e := newEnv(t)
	e.b.queueErr = api.Errf(404, api.CodeNoSession, "no such session")
	em := e.call("btw_alice", "queue", map[string]any{"action": "list"}).errBody(t)
	if em["code"] != "no_session" || !strings.Contains(em["message"].(string), "MCP") {
		t.Fatalf("no session: %v", em)
	}
}

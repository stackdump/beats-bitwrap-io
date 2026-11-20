package server

import (
	"strings"
	"testing"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
)

// a hub on a hand-moved clock, with one session owned by alice
type qenv struct {
	t   *testing.T
	now time.Time
	h   *hub
	id  string
	u   *api.User
}

func newQEnv(t *testing.T, cfg QueueConfig) *qenv {
	e := &qenv{t: t, now: time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC), u: &api.User{ID: "alice"}}
	e.h = newHub(func() time.Time { return e.now })
	cfg.defaults()
	e.h.queueCfg = cfg
	id, err := e.h.create("alice")
	if err != nil {
		t.Fatal(err)
	}
	e.id = id
	return e
}

func (e *qenv) add(n int) *api.QueueView {
	e.t.Helper()
	var items []api.QueueItem
	for i := 0; i < n; i++ {
		items = append(items, api.QueueItem{CID: "zCID" + strings.Repeat("x", 20) + string(rune('a'+i%26)), Source: "store"})
	}
	v, _, err := e.h.Queue(e.u, e.id, api.QueueOp{Action: "add", Items: items})
	if err != nil {
		e.t.Fatalf("add %d: %v", n, err)
	}
	return v
}

var listening = &api.Presence{Visible: true, Focused: true, Audio: "running", IdleMS: 1000}

func (e *qenv) next(p *api.Presence) (*api.QueueItem, *api.QueueView) {
	e.t.Helper()
	it, v, ok := e.h.next(e.id, e.u, p)
	if !ok {
		e.t.Fatal("next: no session")
	}
	return it, v
}

func TestQueueAddListRemoveClearAndCaps(t *testing.T) {
	e := newQEnv(t, QueueConfig{MaxItems: 5, MaxPerAdd: 3})
	v := e.add(3)
	if len(v.UpNext) != 3 || v.UpNext[0].ID != "q1" || v.UpNext[2].ID != "q3" || v.MaxItems != 5 {
		t.Fatalf("add: %+v", v)
	}
	if _, _, err := e.h.Queue(e.u, e.id, api.QueueOp{Action: "add", Items: make([]api.QueueItem, 4)}); err == nil || !strings.Contains(err.Error(), "at most 3") {
		t.Fatalf("per-add cap: %v", err)
	}
	e.add(2)
	if _, _, err := e.h.Queue(e.u, e.id, api.QueueOp{Action: "add", Items: make([]api.QueueItem, 1)}); err == nil || !strings.Contains(err.Error(), "at most 5") {
		t.Fatalf("length cap: %v", err)
	}
	v, _, err := e.h.Queue(e.u, e.id, api.QueueOp{Action: "remove", Remove: "q2"})
	if err != nil || len(v.UpNext) != 4 || v.UpNext[1].ID != "q3" {
		t.Fatalf("remove by id: %+v %v", v, err)
	}
	if _, _, err := e.h.Queue(e.u, e.id, api.QueueOp{Action: "remove", Remove: "q99"}); err == nil {
		t.Fatal("removing an unknown item is an error")
	}
	v, _, err = e.h.Queue(e.u, e.id, api.QueueOp{Action: "remove", Remove: v.UpNext[0].CID})
	if err != nil || len(v.UpNext) != 3 {
		t.Fatalf("remove by cid: %+v %v", v, err)
	}
	v, _, _ = e.h.Queue(e.u, e.id, api.QueueOp{Action: "clear"})
	if len(v.UpNext) != 0 {
		t.Fatalf("clear: %+v", v)
	}
	if _, _, err := e.h.Queue(e.u, e.id, api.QueueOp{Action: "bogus"}); err == nil {
		t.Fatal("unknown action")
	}
}

func TestQueueAuth(t *testing.T) {
	e := newQEnv(t, QueueConfig{})
	if _, _, err := e.h.Queue(nil, e.id, api.QueueOp{Action: "list"}); err == nil {
		t.Fatal("anonymous callers cannot touch a queue")
	}
	if _, _, err := e.h.Queue(&api.User{ID: "mallory"}, e.id, api.QueueOp{Action: "list"}); err == nil {
		t.Fatal("another user's session is not reachable")
	}
	if _, _, err := e.h.Queue(&api.User{ID: "mallory"}, "", api.QueueOp{Action: "list"}); err == nil {
		t.Fatal("a user with no session gets no_session")
	}
	// the page side: a different signed-in user than the owner is refused
	if _, _, ok := e.h.next(e.id, &api.User{ID: "mallory"}, listening); ok {
		t.Fatal("next from another user")
	}
}

func TestQueueAdvancesWhileListening(t *testing.T) {
	e := newQEnv(t, QueueConfig{})
	e.add(2)
	it, v := e.next(listening)
	if it == nil || it.ID != "q1" || v.Position != 1 || v.NowPlaying == nil || v.NowPlaying.ID != "q1" || len(v.UpNext) != 1 {
		t.Fatalf("first: %+v %+v", it, v)
	}
	it, v = e.next(listening)
	if it == nil || it.ID != "q2" || v.Position != 2 {
		t.Fatalf("second: %+v %+v", it, v)
	}
	it, v = e.next(listening)
	if it != nil || v.PausedReason != "" {
		t.Fatalf("empty queue: %+v %+v", it, v)
	}
}

func TestQueuePausesWithoutAListener(t *testing.T) {
	cases := []struct {
		name string
		p    *api.Presence
		want string
	}{
		{"no report", nil, PauseNoReport},
		{"audio suspended", &api.Presence{Visible: true, Audio: "suspended"}, PauseAudioSuspended},
		{"no audio context", &api.Presence{Visible: true, Audio: "none"}, PauseAudioSuspended},
		{"hidden and idle 30 min", &api.Presence{Visible: false, Audio: "running", IdleMS: 30 * 60 * 1000}, PauseIdleHidden},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := newQEnv(t, QueueConfig{})
			e.add(2)
			it, v := e.next(c.p)
			if it != nil || v.PausedReason != c.want {
				t.Fatalf("got %+v, paused %q, want %q", it, v.PausedReason, c.want)
			}
			// the list (MCP queue list / get) says so too
			lv, _, _ := e.h.Queue(e.u, e.id, api.QueueOp{Action: "list"})
			if lv.PausedReason != c.want || len(lv.UpNext) != 2 {
				t.Fatalf("list: %+v", lv)
			}
		})
	}
	// hidden but recently touched, or visible and idle for hours: still a listener
	e := newQEnv(t, QueueConfig{})
	e.add(2)
	if it, _ := e.next(&api.Presence{Visible: false, Audio: "running", IdleMS: 29 * 60 * 1000}); it == nil {
		t.Fatal("hidden 29 minutes is still present")
	}
	if it, _ := e.next(&api.Presence{Visible: true, Audio: "running", IdleMS: 5 * 3600 * 1000}); it == nil {
		t.Fatal("visible is present (the max-auto cap covers a visible tab left alone)")
	}
}

func TestQueueIdleMinutesIsConfigurable(t *testing.T) {
	e := newQEnv(t, QueueConfig{IdleMinutes: 5})
	e.add(1)
	if it, v := e.next(&api.Presence{Audio: "running", IdleMS: 5 * 60 * 1000}); it != nil || v.PausedReason != PauseIdleHidden || v.IdleMinutes != 5 {
		t.Fatalf("idle 5 of 5: %+v %+v", it, v)
	}
}

func TestQueueMaxAutoAdvanceAndResume(t *testing.T) {
	e := newQEnv(t, QueueConfig{MaxAuto: 3})
	e.add(6)
	// the user touched the page once, then walked away: the page's idle_ms grows with the clock
	touched := e.now
	idle := func() *api.Presence {
		return &api.Presence{Visible: true, Audio: "running", IdleMS: e.now.Sub(touched).Milliseconds()}
	}
	for i := 1; i <= 3; i++ {
		e.now = e.now.Add(3 * time.Minute)
		if it, v := e.next(idle()); it == nil || v.AutoAdvanced != i {
			t.Fatalf("advance %d: %+v %+v", i, it, v)
		}
	}
	e.now = e.now.Add(3 * time.Minute)
	it, v := e.next(idle())
	if it != nil || v.PausedReason != PauseMaxAuto {
		t.Fatalf("4th in a row: %+v %+v", it, v)
	}
	// MCP skip is refused while paused, and pushes nothing
	sv, sent, err := e.h.Queue(e.u, e.id, api.QueueOp{Action: "skip"})
	if err != nil || sent || sv.PausedReason != PauseMaxAuto {
		t.Fatalf("skip while paused: %+v %v %v", sv, sent, err)
	}
	// a stale presence (the same old interaction) does not lift it
	e.now = e.now.Add(time.Minute)
	if it, v := e.next(idle()); it != nil || v.PausedReason != PauseMaxAuto {
		t.Fatalf("no fresh interaction: %+v %+v", it, v)
	}
	// a person presses play: an interaction newer than the pause lifts it and restarts the count
	touched = e.now
	it, v = e.next(idle())
	if it == nil || v.PausedReason != "" || v.AutoAdvanced != 1 {
		t.Fatalf("resume: %+v %+v", it, v)
	}
}

func TestQueueInteractionResetsTheCount(t *testing.T) {
	e := newQEnv(t, QueueConfig{MaxAuto: 2})
	e.add(5)
	for i := 0; i < 4; i++ {
		e.now = e.now.Add(time.Minute)
		// the listener touches the page during every track
		if it, v := e.next(&api.Presence{Visible: true, Audio: "running", IdleMS: 1000}); it == nil || v.AutoAdvanced != 1 {
			t.Fatalf("advance %d with interaction: %+v %+v", i, it, v)
		}
	}
}

func TestQueuePresenceFromReports(t *testing.T) {
	e := newQEnv(t, QueueConfig{})
	e.add(1)
	lv, _, _ := e.h.Queue(e.u, e.id, api.QueueOp{Action: "list"})
	if lv.Listener != PauseNoReport {
		t.Fatalf("before any report: %q", lv.Listener)
	}
	if ok, _ := e.h.report(e.id, e.u, api.SessionState{Playing: true, Presence: &api.Presence{Visible: true, Audio: "running"}}); !ok {
		t.Fatal("report")
	}
	lv, _, _ = e.h.Queue(e.u, e.id, api.QueueOp{Action: "list"})
	if lv.Listener != "present" {
		t.Fatalf("after a report: %q", lv.Listener)
	}
	e.now = e.now.Add(3 * time.Minute) // the page stopped reporting
	lv, _, _ = e.h.Queue(e.u, e.id, api.QueueOp{Action: "list"})
	if lv.Listener != PauseNoReport {
		t.Fatalf("stale report: %q", lv.Listener)
	}
	// skip with no listener pushes nothing
	if _, sent, _ := e.h.Queue(e.u, e.id, api.QueueOp{Action: "skip"}); sent {
		t.Fatal("skip without a listener")
	}
}

func TestQueueGoesWithTheSessionAndCountsBytes(t *testing.T) {
	e := newQEnv(t, QueueConfig{})
	before := e.h.bytes
	v, _, err := e.h.Queue(e.u, e.id, api.QueueOp{Action: "add", Items: []api.QueueItem{{CID: "zLink", Source: "link", Text: strings.Repeat("a", 1000)}}})
	if err != nil || len(v.UpNext) != 1 {
		t.Fatal(err)
	}
	if e.h.bytes <= before+1000 {
		t.Fatalf("link text is counted: %d -> %d", before, e.h.bytes)
	}
	// too much link text in one queue
	big := []api.QueueItem{{CID: "zBig", Source: "link", Text: strings.Repeat("b", maxQueueTextBytes)}}
	if _, _, err := e.h.Queue(e.u, e.id, api.QueueOp{Action: "add", Items: big}); err == nil {
		t.Fatal("text budget")
	}
	it, _ := e.next(listening)
	if it == nil || len(it.Text) != 1000 {
		t.Fatalf("a link item hands its text to the page: %+v", it)
	}
	e.h.Queue(e.u, e.id, api.QueueOp{Action: "add", Items: []api.QueueItem{{CID: "zLink", Source: "link", Text: "x"}}})
	e.h.mu.Lock()
	e.h.dropLocked(e.h.sessions[e.id])
	e.h.mu.Unlock()
	if e.h.bytes != before {
		t.Fatalf("dropping the session frees its queue: %d, want %d", e.h.bytes, before)
	}
	if _, _, err := e.h.Queue(e.u, e.id, api.QueueOp{Action: "list"}); err == nil {
		t.Fatal("the queue is gone with its session")
	}
}

// The page-side HTTP routes, end to end through the server.
func TestQueueRoutes(t *testing.T) {
	e := newEnv(t, nil)
	u := e.newUser()
	s := e.newSession(cookie(u.cookie))
	c := e.sse("/api/session/"+s.ID+"/events", cookie(u.cookie))
	if _, _, err := e.srv.Queue(u.user(), s.ID, api.QueueOp{Action: "add", Items: []api.QueueItem{{CID: "zSomething", Source: "store"}}}); err != nil {
		t.Fatal(err)
	}
	if m := c.next(t, "queue", 2*time.Second); !strings.Contains(m.data, "zSomething") {
		t.Fatalf("the page is told: %s", m.data)
	}
	var got struct {
		Queue api.QueueView `json:"queue"`
	}
	if st := decode(t, e.get("/api/session/"+s.ID+"/queue", cookie(u.cookie)), &got); st != 200 || len(got.Queue.UpNext) != 1 {
		t.Fatalf("GET queue: %d %+v", st, got)
	}
	var nx struct {
		Item  map[string]any `json:"item"`
		Queue api.QueueView  `json:"queue"`
	}
	if st := decode(t, e.post("/api/session/"+s.ID+"/queue/next", map[string]any{"reason": "ended", "presence": map[string]any{"visible": false, "audio": "suspended"}}, cookie(u.cookie)), &nx); st != 200 || nx.Item != nil || nx.Queue.PausedReason != PauseAudioSuspended {
		t.Fatalf("paused: %d %+v", st, nx)
	}
	nx.Item = nil
	if st := decode(t, e.post("/api/session/"+s.ID+"/queue/next", map[string]any{"reason": "resume", "presence": map[string]any{"visible": true, "audio": "running", "idle_ms": 0}}, cookie(u.cookie)), &nx); st != 200 || nx.Item == nil || nx.Item["cid"] != "zSomething" {
		t.Fatalf("resumed: %d %+v", st, nx)
	}
	if st := decode(t, e.post("/api/session/"+s.ID+"/queue/next", map[string]any{"reason": "because"}, cookie(u.cookie)), nil); st != 400 {
		t.Fatalf("bad reason: %d", st)
	}
	if st := decode(t, e.post("/api/session/nosuchsession0000000000/queue/next", map[string]any{"reason": "ended"}), nil); st != 404 {
		t.Fatalf("unknown session: %d", st)
	}
}

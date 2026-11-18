package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
)

type sessInfo struct {
	ID   string
	User *api.User
}

func (e *tenv) newSession(opts ...opt) sessInfo {
	e.t.Helper()
	var s sessInfo
	if st := decode(e.t, e.post("/api/session", nil, opts...), &s); st != 200 {
		e.t.Fatalf("session: %d", st)
	}
	return s
}

func TestSessionLifecycleAndSSE(t *testing.T) {
	e := newEnv(t, nil)
	u := e.newUser()
	s := e.newSession(cookie(u.cookie))
	if len(s.ID) != 22 || s.User == nil || s.User.ID != u.id {
		t.Fatalf("session: %+v", s)
	}
	anon := e.newSession()
	if len(anon.ID) != 22 || anon.User != nil || anon.ID == s.ID {
		t.Fatalf("anonymous session: %+v", anon)
	}

	c := e.sse("/api/session/"+s.ID+"/events", cookie(u.cookie))
	// keep-alive pings
	c.next(t, "ping", 2*time.Second)
	c.next(t, "ping", 2*time.Second)

	// MCP side: push to every session the user owns
	n, err := e.srv.Push(u.user(), "", api.SessionEvent{Type: "eval", Text: progA, Play: true})
	if err != nil || n != 1 {
		t.Fatalf("push: %d %v", n, err)
	}
	m := c.next(t, "eval", 2*time.Second)
	var ev api.SessionEvent
	json.Unmarshal([]byte(m.data), &ev)
	if m.event != "eval" || ev.Type != "eval" || ev.Text != progA || !ev.Play {
		t.Fatalf("event: %+v %s", m, m.data)
	}
	for _, typ := range []string{"load", "stop"} {
		if n, err := e.srv.Push(u.user(), s.ID, api.SessionEvent{Type: typ, CID: "zabc"}); err != nil || n != 1 {
			t.Fatalf("push %s: %d %v", typ, n, err)
		}
		if m := c.next(t, typ, 2*time.Second); m.event != typ {
			t.Fatalf("got %+v", m)
		}
	}
	if _, err := e.srv.Push(u.user(), s.ID, api.SessionEvent{Type: "bogus"}); err == nil {
		t.Fatal("unknown event types are refused")
	}
	if got := e.srv.Sessions(u.user()); len(got) != 1 || got[0].ID != s.ID || got[0].Owner != u.id {
		t.Fatalf("Sessions: %+v", got)
	}

	// no live browser: delivered 0, not an error
	other := e.newUser()
	if n, err := e.srv.Push(other.user(), "", api.SessionEvent{Type: "stop"}); err != nil || n != 0 {
		t.Fatalf("nobody listening: %d %v", n, err)
	}
	// a session with no stream attached delivers nothing
	if n, err := e.srv.Push(u.user(), anon.ID, api.SessionEvent{Type: "stop"}); err != nil || n != 0 {
		t.Fatalf("no subscriber: %d %v", n, err)
	}
}

func TestSessionOwnership(t *testing.T) {
	e := newEnv(t, nil)
	alice, bob := e.newUser(), e.newUser()
	sa := e.newSession(cookie(alice.cookie))
	anon := e.newSession()
	ca := e.sse("/api/session/"+sa.ID+"/events", cookie(alice.cookie))
	canon := e.sse("/api/session/" + anon.ID + "/events")

	// bob cannot drive alice's session, by id or by "all mine"; he does not even learn it exists
	if _, err := e.srv.Push(bob.user(), sa.ID, api.SessionEvent{Type: "stop"}); err == nil || err.(*api.Error).Code != api.CodeNoSession || err.(*api.Error).Status != 404 {
		t.Fatalf("bob -> alice by id: %v", err)
	}
	if n, _ := e.srv.Push(bob.user(), "", api.SessionEvent{Type: "stop"}); n != 0 {
		t.Fatalf("bob's 'all mine' reached %d sessions", n)
	}
	if _, err := e.srv.State(context.Background(), bob.user(), sa.ID); err == nil {
		t.Fatal("bob read alice's state")
	}
	// an anonymous caller cannot drive anything
	if _, err := e.srv.Push(nil, sa.ID, api.SessionEvent{Type: "stop"}); err == nil || err.(*api.Error).Code != api.CodeAuthRequired {
		t.Fatalf("anonymous push: %v", err)
	}
	if _, err := e.srv.Push(nil, anon.ID, api.SessionEvent{Type: "stop"}); err == nil {
		t.Fatal("anonymous push to an anonymous session needs a caller too")
	}
	// an anonymous session is drivable by an authenticated caller who names it, never by "all mine"
	if n, err := e.srv.Push(bob.user(), anon.ID, api.SessionEvent{Type: "eval", Text: "x"}); err != nil || n != 1 {
		t.Fatalf("explicit anonymous session: %d %v", n, err)
	}
	canon.next(t, "eval", 2*time.Second)
	if n, _ := e.srv.Push(bob.user(), "", api.SessionEvent{Type: "stop"}); n != 0 {
		t.Fatalf("'all mine' must not reach an anonymous session: %d", n)
	}
	// nothing leaked to alice's stream
	select {
	case m := <-ca.ch:
		if m.event != "ping" {
			t.Fatalf("alice saw %+v", m)
		}
	case <-time.After(200 * time.Millisecond):
	}
	// page side: bob (signed in) cannot attach to, report to, or answer for alice's session
	if st, code := errCode(t, e.get("/api/session/"+sa.ID+"/events", cookie(bob.cookie))); st != 404 || code != api.CodeNoSession {
		t.Fatalf("bob's stream: %d %s", st, code)
	}
	if r := e.post("/api/session/"+sa.ID+"/report", map[string]any{"text": "evil"}, cookie(bob.cookie)); r.StatusCode != 404 {
		t.Fatalf("bob's report: %d", r.StatusCode)
	}
	if r := e.post("/api/session/"+sa.ID+"/reply", map[string]any{"request_id": "x", "state": map[string]any{}}, cookie(bob.cookie)); r.StatusCode != 404 {
		t.Fatalf("bob's reply: %d", r.StatusCode)
	}
	// unknown sessions
	if st, _ := errCode(t, e.get("/api/session/doesnotexist/events")); st != 404 {
		t.Fatalf("unknown session stream: %d", st)
	}
	// bad credentials on a stream are just anonymous (the id is the capability)
	if r := e.get("/api/session/"+anon.ID+"/events", cookie(&httpCookie)); r.StatusCode != 200 {
		t.Fatalf("anonymous stream with a junk cookie: %d", r.StatusCode)
	} else {
		r.Body.Close()
	}
}

func TestSessionReportAndGetRoundTrip(t *testing.T) {
	e := newEnv(t, nil)
	u := e.newUser()
	s := e.newSession(cookie(u.cookie))
	c := e.sse("/api/session/"+s.ID+"/events", cookie(u.cookie))

	// nothing reported yet and the page is silent: a clear error after the wait
	st := time.Now()
	if _, err := e.srv.State(context.Background(), u.user(), s.ID); err == nil {
		t.Fatal("state of a silent page")
	} else if err.(*api.Error).Code != api.CodeNoSession {
		t.Fatalf("%v", err)
	}
	if d := time.Since(st); d < 2*time.Second || d > 5*time.Second {
		t.Fatalf("waited %s for the page", d)
	}
	// that sent the page a "get"
	if m := c.next(t, "get", time.Second); m.event != "get" {
		t.Fatalf("%+v", m)
	}

	// the page reports; a fresh report is returned without asking
	rep := map[string]any{"text": progA, "cid": "zcid", "playing": true, "source": "engine", "section": "intro", "section_num": 1, "sections_total": 3, "bar": 5,
		"bars_in_section": 8, "phase": 2, "marks": map[string]any{"fires": []int{1, 2}}, "diagnostics": []any{}, "ts": "client-time-ignored"}
	if r := e.post("/api/session/"+s.ID+"/report", rep, cookie(u.cookie)); r.StatusCode != 204 {
		t.Fatalf("report: %d", r.StatusCode)
	}
	got, err := e.srv.State(context.Background(), u.user(), s.ID)
	if err != nil || got.CID != "zcid" || got.Bar != 5 || got.BarsInSect != 8 || got.Section != "intro" || !got.Playing || got.ID != s.ID || got.Text != progA {
		t.Fatalf("state: %+v %v", got, err)
	}
	if got.TS == "client-time-ignored" || got.TS == "" {
		t.Fatalf("the server stamps ts itself: %q", got.TS)
	}
	if !strings.Contains(string(got.Marks), "fires") {
		t.Fatalf("marks: %s", got.Marks)
	}
	// stale: the hub asks with a get, and the page's reply is what comes back
	e.clk.Advance(2 * time.Second)
	done := make(chan *api.SessionState, 1)
	go func() {
		st, _ := e.srv.State(context.Background(), u.user(), s.ID)
		done <- st
	}()
	m := c.next(t, "get", 2*time.Second)
	var ev api.SessionEvent
	json.Unmarshal([]byte(m.data), &ev)
	if ev.Type != "get" || ev.RequestID == "" {
		t.Fatalf("get event: %s", m.data)
	}
	if r := e.post("/api/session/"+s.ID+"/reply", map[string]any{"request_id": ev.RequestID, "state": map[string]any{"text": "fresh", "cid": "znew", "bar": 9}}, cookie(u.cookie)); r.StatusCode != 204 {
		t.Fatalf("reply: %d", r.StatusCode)
	}
	select {
	case st := <-done:
		if st == nil || st.Text != "fresh" || st.CID != "znew" || st.Bar != 9 {
			t.Fatalf("round trip: %+v", st)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("State did not return the page's answer")
	}
	// an unknown request id is ignored, a missing one refused
	if r := e.post("/api/session/"+s.ID+"/reply", map[string]any{"request_id": "late", "state": map[string]any{}}, cookie(u.cookie)); r.StatusCode != 204 {
		t.Fatalf("late reply: %d", r.StatusCode)
	}
	if r := e.post("/api/session/"+s.ID+"/reply", map[string]any{"state": map[string]any{}}, cookie(u.cookie)); r.StatusCode != 400 {
		t.Fatalf("reply without id: %d", r.StatusCode)
	}
	// State with no id picks the user's most recent session
	if st, err := e.srv.State(context.Background(), u.user(), ""); err != nil || st.ID != s.ID {
		t.Fatalf("State(''): %+v %v", st, err)
	}
	// a user with no session
	if _, err := e.srv.State(context.Background(), e.newUser().user(), ""); err == nil || err.(*api.Error).Code != api.CodeNoSession {
		t.Fatalf("no sessions: %v", err)
	}
	// without a connected page, the last report is returned (with its age in ts)
	c.resp.Body.Close()
	time.Sleep(150 * time.Millisecond)
	e.clk.Advance(3 * time.Second)
	got, err = e.srv.State(context.Background(), u.user(), s.ID)
	if err != nil || got.Text != "fresh" {
		t.Fatalf("last known state: %+v %v", got, err)
	}
}

func TestSessionReportLimitsAndSizes(t *testing.T) {
	e := newEnv(t, nil)
	s := e.newSession()
	// 256 KiB cap
	big := map[string]any{"text": strings.Repeat("x", maxReportBytes)}
	if st, code := errCode(t, e.post("/api/session/"+s.ID+"/report", big)); st != 413 || code != "too_large" {
		t.Fatalf("big report: %d %s", st, code)
	}
	// a burst beyond the bucket is told to slow down
	limited := 0
	for i := 0; i < 60; i++ {
		r := e.post("/api/session/"+s.ID+"/report", map[string]any{"text": "x", "bar": i})
		if r.StatusCode == 429 {
			limited++
			if r.Header.Get("Retry-After") == "" {
				t.Fatal("no Retry-After on a report 429")
			}
		}
		r.Body.Close()
	}
	if limited == 0 {
		t.Fatal("60 reports in a burst should hit the limit")
	}
	if r := e.post("/api/session/nope/report", map[string]any{}); r.StatusCode != 404 {
		t.Fatalf("report to unknown: %d", r.StatusCode)
	}
}

func TestSessionCreateLimitsAndTTL(t *testing.T) {
	e := newEnv(t, nil)
	// 120 an hour per IP
	ok, refused := 0, 0
	for i := 0; i < 123; i++ {
		r := e.post("/api/session", nil, ip("192.0.2.40"))
		if r.StatusCode == 200 {
			ok++
		} else if r.StatusCode == 429 {
			refused++
		}
		r.Body.Close()
	}
	if ok != 120 || refused != 3 {
		t.Fatalf("created %d, refused %d", ok, refused)
	}
	if e.srv.hub.count() != 120 {
		t.Fatalf("count %d", e.srv.hub.count())
	}
	// untouched sessions without a stream expire after 10 minutes
	e.clk.Advance(11 * time.Minute)
	e.srv.hub.mu.Lock()
	e.srv.hub.sweepLocked()
	e.srv.hub.mu.Unlock()
	if e.srv.hub.count() != 0 {
		t.Fatalf("expired sessions remain: %d", e.srv.hub.count())
	}
	// a session with a stream attached does not expire
	s := e.newSession()
	e.sse("/api/session/" + s.ID + "/events")
	e.clk.Advance(30 * time.Minute)
	e.srv.hub.mu.Lock()
	e.srv.hub.sweepLocked()
	e.srv.hub.mu.Unlock()
	if e.srv.hub.count() != 1 {
		t.Fatalf("a connected session was swept: %d", e.srv.hub.count())
	}
}

func TestSessionPerUserCapRetiresTheOldest(t *testing.T) {
	e := newEnv(t, nil)
	u := e.newUser()
	var first string
	for i := 0; i < maxSessionsPerUser+3; i++ {
		id, err := e.srv.hub.create(u.id)
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			first = id
		}
		e.clk.Advance(time.Second)
	}
	if got := len(e.srv.Sessions(u.user())); got != maxSessionsPerUser {
		t.Fatalf("%d sessions", got)
	}
	e.srv.hub.mu.Lock()
	_, stillThere := e.srv.hub.sessions[first]
	e.srv.hub.mu.Unlock()
	if stillThere {
		t.Fatal("the least recently seen session should have been retired")
	}
}

func TestSessionSlowSubscriberIsCutOff(t *testing.T) {
	e := newEnv(t, nil)
	u := e.newUser()
	id, _ := e.srv.hub.create(u.id)
	sub, err := e.srv.hub.subscribe(id, u.user())
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { // never reads
		defer wg.Done()
		for i := 0; i < 40; i++ {
			e.srv.Push(u.user(), id, api.SessionEvent{Type: "stop"})
		}
	}()
	wg.Wait()
	// the buffer (16) overflowed: the subscriber was dropped and its channel closed
	drained := 0
	for range sub.ch {
		drained++
	}
	if drained != 16 {
		t.Fatalf("drained %d", drained)
	}
}

func TestSessionConcurrentPushAndReport(t *testing.T) {
	e := newEnv(t, nil)
	u := e.newUser()
	s := e.newSession(cookie(u.cookie))
	c := e.sse("/api/session/"+s.ID+"/events", cookie(u.cookie))
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			for j := 0; j < 10; j++ {
				e.srv.Push(u.user(), s.ID, api.SessionEvent{Type: "eval", Text: "x"})
			}
		}()
		go func() {
			defer wg.Done()
			for j := 0; j < 10; j++ {
				r := e.post("/api/session/"+s.ID+"/report", map[string]any{"text": "y"}, cookie(u.cookie))
				r.Body.Close()
			}
		}()
	}
	wg.Wait()
	_ = c
}

var httpCookie = http.Cookie{Name: "btw_session", Value: "junk.junk"}

func TestSessionStreamsPerSessionAreBounded(t *testing.T) {
	e := newEnv(t, nil)
	s := e.newSession()
	var conns []*sseConn
	for i := 0; i < maxStreamsPerSession+2; i++ {
		conns = append(conns, e.sse("/api/session/"+s.ID+"/events"))
	}
	// the two oldest streams were closed by the hub; the newest still get events
	for i, c := range conns[:2] {
		deadline := time.After(2 * time.Second)
	drain:
		for {
			select {
			case _, ok := <-c.ch:
				if !ok {
					break drain
				}
			case <-deadline:
				t.Fatalf("stream %d should have been closed", i)
			}
		}
	}
	u := e.newUser()
	id, _ := e.srv.hub.create(u.id)
	_ = id
	e.srv.hub.mu.Lock()
	n := len(e.srv.hub.sessions[s.ID].subs)
	e.srv.hub.mu.Unlock()
	if n != maxStreamsPerSession {
		t.Fatalf("%d streams attached", n)
	}
	if got, _ := e.srv.Push(&api.User{ID: "x"}, s.ID, api.SessionEvent{Type: "stop"}); got != 1 {
		t.Fatalf("push to the live streams: %d", got)
	}
	conns[len(conns)-1].next(t, "stop", 2*time.Second)
}

// A page that loaded anonymously and then signed in: its next report (or stream) with the cookie makes it
// the user's session, so MCP "all my sessions" finds it and nobody else can drive it by id any more.
func TestAnonymousSessionIsClaimedBySignInReport(t *testing.T) {
	e := newEnv(t, nil)
	s := e.newSession() // anonymous
	alice, bob := e.newUser(), e.newUser()
	c := e.sse("/api/session/" + s.ID + "/events")
	if got := e.srv.Sessions(alice.user()); len(got) != 0 {
		t.Fatalf("before: %v", got)
	}
	if n, _ := e.srv.Push(alice.user(), "", api.SessionEvent{Type: "stop"}); n != 0 {
		t.Fatalf("'all mine' reached an unowned session: %d", n)
	}
	// anonymous reports change nothing
	e.post("/api/session/"+s.ID+"/report", map[string]any{"text": "x"}).Body.Close()
	if got := e.srv.Sessions(alice.user()); len(got) != 0 {
		t.Fatalf("an anonymous report claimed it: %v", got)
	}
	// alice's page signs in and reports
	if r := e.post("/api/session/"+s.ID+"/report", map[string]any{"text": progA}, cookie(alice.cookie)); r.StatusCode != 204 {
		t.Fatalf("report: %d", r.StatusCode)
	} else {
		r.Body.Close()
	}
	if got := e.srv.Sessions(alice.user()); len(got) != 1 || got[0].ID != s.ID {
		t.Fatalf("after the signed-in report: %v", got)
	}
	if n, err := e.srv.Push(alice.user(), "", api.SessionEvent{Type: "eval", Text: "t"}); err != nil || n != 1 {
		t.Fatalf("push to all mine: %d %v", n, err)
	}
	c.next(t, "eval", 2*time.Second)
	// now it is hers: bob cannot drive it by id, and cannot take it over by reporting
	if _, err := e.srv.Push(bob.user(), s.ID, api.SessionEvent{Type: "stop"}); err == nil {
		t.Fatal("bob drove alice's claimed session")
	}
	if r := e.post("/api/session/"+s.ID+"/report", map[string]any{"text": "evil"}, cookie(bob.cookie)); r.StatusCode != 404 {
		t.Fatalf("bob's report: %d", r.StatusCode)
	} else {
		r.Body.Close()
	}
	if got := e.srv.Sessions(bob.user()); len(got) != 0 {
		t.Fatalf("bob owns %v", got)
	}
}

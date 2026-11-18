package server

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
)

// One address cannot hold unbounded SSE streams open: each is a goroutine and a socket, and a session that
// has a stream is never swept.
func TestOpenStreamsPerAddressAreBounded(t *testing.T) {
	e := newEnv(t, nil)
	attacker, other := ip("198.51.100.20"), ip("198.51.100.21")
	var conns []*sseConn
	for i := 0; i < maxStreamsPerIP; i++ {
		s := e.newSession(attacker) // 4 streams a session at most: 10 sessions hold 40
		_ = s
		conns = append(conns, e.sse("/api/session/"+s.ID+"/events", attacker))
	}
	s := e.newSession(attacker)
	resp := e.get("/api/session/"+s.ID+"/events", attacker)
	if st, code := errCode(t, resp); st != http.StatusTooManyRequests || code != "rate_limited" {
		t.Fatalf("stream %d from one address: %d %s", maxStreamsPerIP+1, st, code)
	}
	if resp.Header.Get("Retry-After") == "" {
		t.Error("no Retry-After")
	}
	// another address is unaffected, and an IPv6 neighbour of the attacker's /64 would share its count
	so := e.newSession(other)
	e.sse("/api/session/"+so.ID+"/events", other)
	// closing one frees a place
	conns[0].resp.Body.Close()
	deadline := time.Now().Add(3 * time.Second)
	for {
		r := e.get("/api/session/"+s.ID+"/events", attacker)
		if r.StatusCode == 200 {
			r.Body.Close()
			break
		}
		r.Body.Close()
		if time.Now().After(deadline) {
			t.Fatal("a closed stream never freed its place")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// Anyone can make a session and report ~256 KiB into it (measured: about 340 KiB of memory each), and 5000
// sessions are allowed. The reports are kept under one budget; the ones reported longest ago give theirs up.
func TestStoredReportsStayUnderOneBudget(t *testing.T) {
	old := maxStateBytes
	maxStateBytes = 1 << 20
	t.Cleanup(func() { maxStateBytes = old })
	e := newEnv(t, nil)
	h := e.srv.hub
	big := strings.Repeat("x", 200<<10)
	var ids []string
	for i := 0; i < 30; i++ {
		id, err := h.create("")
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
		if ok, lim := h.report(id, nil, api.SessionState{Text: big, Playing: true}); !ok || lim {
			t.Fatalf("report %d: ok=%v limited=%v", i, ok, lim)
		}
		e.clk.Advance(10 * time.Millisecond)
	}
	h.mu.Lock()
	total, held := 0, 0
	for _, s := range h.sessions {
		if s.state != nil {
			total += stateBytes(s.state)
			held++
		}
	}
	tracked := h.bytes
	last := h.sessions[ids[len(ids)-1]].state
	first := h.sessions[ids[0]].state
	h.mu.Unlock()
	if total > maxStateBytes || tracked != total {
		t.Fatalf("held %d bytes in %d reports (tracked %d), budget %d", total, held, tracked, maxStateBytes)
	}
	if held < 3 || held > 5 {
		t.Fatalf("%d reports kept; a 1 MiB budget holds about 5 of 200 KiB", held)
	}
	if last == nil || len(last.Text) != len(big) {
		t.Fatal("the newest report must be the one that is kept")
	}
	if first != nil {
		t.Fatal("the oldest report should have been given up")
	}
	// the sessions themselves live on: an evicted page just reports again
	if ok, _ := h.report(ids[0], nil, api.SessionState{Text: "again"}); !ok {
		t.Fatal("an evicted session was dropped")
	}
	// dropping a session returns its share
	h.mu.Lock()
	for _, id := range ids {
		h.dropLocked(h.sessions[id])
	}
	if h.bytes != 0 {
		t.Fatalf("%d bytes accounted for with no sessions", h.bytes)
	}
	h.mu.Unlock()
}

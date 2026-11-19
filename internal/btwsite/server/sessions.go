package server

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"sync"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
)

// The sessions hub is how MCP drives a browser: a page registers a session, listens on its SSE stream,
// and reports its state; an MCP write tool pushes events to the sessions its caller may drive.
//
// Ownership: a session made with a valid cookie/bearer is owned by that user and only that user can push to
// it. A session made anonymously has no owner; its id (22 random chars, shown in the page's MCP panel) is
// the capability, so it can be pushed to by any authenticated caller who names the id — never by "all my
// sessions". The page side (events, report, reply) is addressed by the id alone, but a different signed-in
// user than the owner is refused.

const (
	maxSessions          = 5000
	maxSessionsPerUser   = 20
	maxStreamsPerSession = 4                // a page that reconnects leaves its old stream to die by itself: the oldest goes
	sessionTTL           = 10 * time.Minute // without a subscriber, a report, or a reply
	stateFresh           = 1500 * time.Millisecond
	getWait              = 3 * time.Second
	maxReportBytes       = 256 << 10
)

// maxStateBytes bounds what the hub keeps of the pages' reports, all sessions together. Each session keeps its
// latest report (up to maxReportBytes, a few hundred KiB in memory), and a session can be made by anyone, so
// without a total the 5000 sessions allowed could hold well over a gigabyte. Over the budget, the sessions
// that reported longest ago lose their stored report (a live page reports again within a second).
var maxStateBytes = 128 << 20

// stateBytes is what a stored report costs, near enough.
func stateBytes(st *api.SessionState) int {
	if st == nil {
		return 0
	}
	return len(st.Text) + len(st.Marks) + len(st.Diagnostics) + len(st.CID) + len(st.Source) + len(st.Section) + 512
}

type subscriber struct {
	ch   chan api.SessionEvent
	once sync.Once
	seq  int
}

func (s *subscriber) close() { s.once.Do(func() { close(s.ch) }) }

type session struct {
	id       string
	owner    string // user id, "" = anonymous
	device   string // a paired phone's device id (pair.go), "" = a page
	created  time.Time
	lastSeen time.Time

	subs    map[*subscriber]struct{}
	state   *api.SessionState
	stateAt time.Time
	pending map[string]chan *api.SessionState
	// report rate limit: a token bucket
	tokens   float64
	tokensAt time.Time
}

type hub struct {
	now func() time.Time

	mu       sync.Mutex
	sessions map[string]*session
	closed   bool
	seq      int
	bytes    int       // stateBytes of every stored report
	streams  ipCounter // open SSE streams per address
}

var _ api.Hub = (*hub)(nil)

func newHub(now func() time.Time) *hub {
	return &hub{now: now, sessions: map[string]*session{}}
}

func newID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b) // 22 characters
}

var errNoSession = func() *api.Error {
	return api.Errf(http.StatusNotFound, api.CodeNoSession, "no such session (or it is not yours to drive)")
}

// create makes a session owned by owner ("" = anonymous).
func (h *hub) create(owner string) (string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sweepLocked()
	if len(h.sessions) >= maxSessions {
		e := api.Errf(http.StatusServiceUnavailable, "busy", "too many open sessions; try again later")
		e.RetryAfter = 60
		return "", e
	}
	if owner != "" {
		n := 0
		var oldest *session
		for _, s := range h.sessions {
			if s.owner == owner {
				n++
				if s.device != "" { // a paired phone is not retired for a page that reloads a lot
					continue
				}
				if oldest == nil || s.lastSeen.Before(oldest.lastSeen) {
					oldest = s
				}
			}
		}
		if n >= maxSessionsPerUser && oldest != nil { // a page that reloads a lot: retire the least recently seen
			h.dropLocked(oldest)
		}
	}
	now := h.now()
	s := &session{id: newID(), owner: owner, created: now, lastSeen: now, subs: map[*subscriber]struct{}{},
		pending: map[string]chan *api.SessionState{}, tokens: 20, tokensAt: now}
	h.sessions[s.id] = s
	return s.id, nil
}

func (h *hub) dropLocked(s *session) {
	for sub := range s.subs {
		sub.close()
	}
	h.bytes -= stateBytes(s.state)
	delete(h.sessions, s.id)
}

// setStateLocked stores a report as s's latest and keeps the total under maxStateBytes.
func (h *hub) setStateLocked(s *session, st *api.SessionState, now time.Time) {
	h.bytes += stateBytes(st) - stateBytes(s.state)
	s.state, s.stateAt, s.lastSeen = st, now, now
	if h.bytes <= maxStateBytes {
		return
	}
	var held []*session
	for _, o := range h.sessions {
		if o != s && o.state != nil {
			held = append(held, o)
		}
	}
	sort.Slice(held, func(i, j int) bool { return held[i].stateAt.Before(held[j].stateAt) })
	for _, o := range held {
		if h.bytes <= maxStateBytes {
			break
		}
		h.bytes -= stateBytes(o.state)
		o.state = nil
	}
}

func (h *hub) sweepLocked() {
	cut := h.now().Add(-sessionTTL)
	for _, s := range h.sessions {
		if len(s.subs) == 0 && s.lastSeen.Before(cut) {
			h.dropLocked(s)
		}
	}
}

// sweeper runs until ctx ends.
func (h *hub) sweeper(ctx context.Context) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			h.mu.Lock()
			h.sweepLocked()
			h.mu.Unlock()
		}
	}
}

// closeAll ends every stream (graceful shutdown).
func (h *hub) closeAll() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.closed = true
	for _, s := range h.sessions {
		for sub := range s.subs {
			sub.close()
		}
		s.subs = map[*subscriber]struct{}{}
	}
}

// claimLocked: a page that loaded anonymously and then signed in keeps its session id, so the first
// report or stream from it that carries a valid cookie makes the signed-in user its owner (otherwise "all my
// sessions" would never find it). The id is the capability that got the caller here.
func (h *hub) claimLocked(s *session, u *api.User) {
	if s.owner == "" && u != nil {
		s.owner = u.ID
	}
}

// pageAccess finds a session for the page-side routes: the id is the capability, but a signed-in user who
// is not the owner is refused.
func (h *hub) pageAccess(id string, u *api.User) (*session, bool) {
	s, ok := h.sessions[id]
	if !ok {
		return nil, false
	}
	if s.owner != "" && u != nil && u.ID != s.owner {
		return nil, false
	}
	return s, true
}

// subscribe attaches an SSE stream to a session.
func (h *hub) subscribe(id string, u *api.User) (*subscriber, *api.Error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil, api.Errf(http.StatusServiceUnavailable, "busy", "the server is shutting down")
	}
	s, ok := h.pageAccess(id, u)
	if !ok {
		return nil, errNoSession()
	}
	h.seq++
	h.claimLocked(s, u)
	sub := &subscriber{ch: make(chan api.SessionEvent, 16), seq: h.seq}
	for len(s.subs) >= maxStreamsPerSession {
		var oldest *subscriber
		for o := range s.subs {
			if oldest == nil || o.seq < oldest.seq {
				oldest = o
			}
		}
		delete(s.subs, oldest)
		oldest.close()
	}
	s.subs[sub] = struct{}{}
	s.lastSeen = h.now()
	return sub, nil
}

func (h *hub) unsubscribe(id string, sub *subscriber) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if s, ok := h.sessions[id]; ok {
		delete(s.subs, sub)
		s.lastSeen = h.now()
	}
	sub.close()
}

// report stores the page's latest state. ok=false: unknown session. limited=true: too many reports.
func (h *hub) report(id string, u *api.User, st api.SessionState) (ok, limited bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s, found := h.pageAccess(id, u)
	if !found {
		return false, false
	}
	h.claimLocked(s, u)
	now := h.now()
	// 20-report burst, refilled at 10/s: the page sends about 2/s
	s.tokens = min(20, s.tokens+now.Sub(s.tokensAt).Seconds()*10)
	s.tokensAt = now
	if s.tokens < 1 {
		return true, true
	}
	s.tokens--
	st.ID = id
	st.TS = now.UTC().Format(time.RFC3339Nano)
	h.setStateLocked(s, &st, now)
	return true, false
}

// reply answers a pending "get". An unknown request id (a late answer, or none was asked) changes nothing.
func (h *hub) reply(id string, u *api.User, requestID string, st api.SessionState) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	s, found := h.pageAccess(id, u)
	if !found {
		return false
	}
	ch, ok := s.pending[requestID]
	if !ok {
		return true
	}
	delete(s.pending, requestID)
	now := h.now()
	st.ID = id
	st.TS = now.UTC().Format(time.RFC3339Nano)
	h.setStateLocked(s, &st, now)
	ch <- &st // buffered 1
	return true
}

// targetLocked is the sessions u may drive: the named one (owned by u or anonymous) or all of u's.
func (h *hub) targetLocked(u *api.User, id string) ([]*session, error) {
	if u == nil {
		return nil, api.Errf(http.StatusUnauthorized, api.CodeAuthRequired, "driving a browser session needs a signed-in caller")
	}
	if id != "" {
		s, ok := h.sessions[id]
		if !ok || (s.owner != "" && s.owner != u.ID) {
			return nil, errNoSession()
		}
		return []*session{s}, nil
	}
	var out []*session
	for _, s := range h.sessions {
		if s.owner == u.ID {
			out = append(out, s)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].lastSeen.After(out[j].lastSeen) })
	return out, nil
}

// Push delivers ev to the sessions u may drive and returns how many had a live browser to deliver to.
func (h *hub) Push(u *api.User, sessionID string, ev api.SessionEvent) (int, error) {
	switch ev.Type {
	case "eval", "load", "stop", "get":
	default:
		return 0, api.Errf(http.StatusBadRequest, api.CodeBadRequest, "unknown session event type %q (eval, load, stop, get)", ev.Type)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	targets, err := h.targetLocked(u, sessionID)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, s := range targets {
		if h.deliverLocked(s, ev) {
			n++
		}
	}
	return n, nil
}

// deliverLocked sends to every subscriber of s; a subscriber whose buffer is full is cut off (the page
// reconnects). True if at least one took it.
func (h *hub) deliverLocked(s *session, ev api.SessionEvent) bool {
	ok := false
	for sub := range s.subs {
		select {
		case sub.ch <- ev:
			ok = true
		default:
			delete(s.subs, sub)
			sub.close()
		}
	}
	return ok
}

// State is the latest report of a session. A report older than a moment makes the hub ask the page with a
// "get" event and wait briefly for its reply; if the page does not answer, the last report is returned (its
// ts says how old it is), or an error when there never was one.
func (h *hub) State(ctx context.Context, u *api.User, sessionID string) (*api.SessionState, error) {
	h.mu.Lock()
	targets, err := h.targetLocked(u, sessionID)
	if err != nil {
		h.mu.Unlock()
		return nil, err
	}
	if len(targets) == 0 {
		h.mu.Unlock()
		return nil, api.Errf(http.StatusConflict, api.CodeNoSession, "no browser session is connected for you: open this site in a browser tab, signed in, then retry")
	}
	s := targets[0] // the most recently seen
	now := h.now()
	if s.state != nil && now.Sub(s.stateAt) < stateFresh {
		st := *s.state
		h.mu.Unlock()
		return &st, nil
	}
	var wait chan *api.SessionState
	var reqID string
	if len(s.subs) > 0 {
		reqID = newID()
		wait = make(chan *api.SessionState, 1)
		s.pending[reqID] = wait
		h.deliverLocked(s, api.SessionEvent{Type: "get", RequestID: reqID})
	}
	var last *api.SessionState
	if s.state != nil && now.Sub(s.stateAt) < sessionTTL {
		cp := *s.state
		last = &cp
	}
	h.mu.Unlock()

	if wait != nil {
		t := time.NewTimer(getWait)
		defer t.Stop()
		select {
		case st := <-wait:
			return st, nil
		case <-t.C:
		case <-ctx.Done():
		}
		h.mu.Lock()
		if cur, ok := h.sessions[s.id]; ok {
			delete(cur.pending, reqID)
		}
		h.mu.Unlock()
	}
	if last != nil {
		return last, nil
	}
	return nil, api.Errf(http.StatusConflict, api.CodeNoSession, "the browser did not answer (is the page still open?)")
}

// Sessions lists the sessions u owns.
func (h *hub) Sessions(u *api.User) []api.SessionInfo {
	if u == nil {
		return nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []api.SessionInfo
	for _, s := range h.sessions {
		if s.owner != u.ID {
			continue
		}
		si := api.SessionInfo{ID: s.id, Owner: s.owner, Device: s.device, LastSeen: s.lastSeen.UTC().Format(time.RFC3339)}
		if s.state != nil {
			si.CID, si.Playing = s.state.CID, s.state.Playing
		}
		out = append(out, si)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LastSeen > out[j].LastSeen })
	return out
}

// count is the number of live sessions (tests, /api/info).
func (h *hub) count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.sessions)
}

// ---------- HTTP ----------

func (s *Server) handleSessionCreate(w http.ResponseWriter, r *http.Request) {
	if ok, retry := s.sessionIP.Allow(ClientIP(r)); !limited(w, ok, retry, "session") {
		return
	}
	u := s.userOrAnon(r)
	owner := ""
	if u != nil {
		owner = u.ID
	}
	id, err := s.hub.create(owner)
	if err != nil {
		api.WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "user": u})
}

// maxStreamsPerIP bounds the open SSE streams one address (the /64 for IPv6) may hold. Creating sessions is
// limited per hour, but a session that has a stream is never swept, so without this one address could pile up
// streams (a goroutine and a socket each) for as long as it likes.
const maxStreamsPerIP = 40

// ipCounter counts something open per address.
type ipCounter struct {
	mu sync.Mutex
	n  map[string]int
}

func (c *ipCounter) acquire(key string, max int) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.n == nil {
		c.n = map[string]int{}
	}
	if c.n[key] >= max {
		return false
	}
	c.n[key]++
	return true
}

func (c *ipCounter) release(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.n[key] <= 1 {
		delete(c.n, key)
		return
	}
	c.n[key]--
}

func (s *Server) handleSessionEvents(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	u := s.userOrAnon(r)
	ipKey := api.IPKey(ClientIP(r))
	if !s.hub.streams.acquire(ipKey, maxStreamsPerIP) {
		e := api.Errf(http.StatusTooManyRequests, api.CodeRateLimited, "too many open streams from your address (%d); close a tab or wait", maxStreamsPerIP)
		e.RetryAfter = 30
		api.WriteError(w, e)
		return
	}
	defer s.hub.streams.release(ipKey)
	sub, err := s.hub.subscribe(id, u)
	if err != nil {
		api.WriteError(w, err)
		return
	}
	defer s.hub.unsubscribe(id, sub)
	s.streamEvents(w, r, sub, nil)
}

// streamEvents writes a subscriber's events as SSE until it closes, the client goes, or the server stops.
// hello, if given, is sent first (event name, JSON data).
func (s *Server) streamEvents(w http.ResponseWriter, r *http.Request, sub *subscriber, hello *api.SessionEvent, after ...*api.SessionEvent) {
	rc := http.NewResponseController(w)
	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache, no-transform")
	h.Set("X-Accel-Buffering", "no") // nginx: do not buffer the stream
	w.WriteHeader(http.StatusOK)
	write := func(format string, args ...any) bool {
		_ = rc.SetWriteDeadline(time.Now().Add(15 * time.Second))
		if _, err := fmt.Fprintf(w, format, args...); err != nil {
			return false
		}
		return rc.Flush() == nil
	}
	if !write("retry: 3000\n: connected\n\n") {
		return
	}
	if hello != nil {
		b, _ := json.Marshal(hello)
		if !write("event: %s\ndata: %s\n\n", hello.Type, b) {
			return
		}
	}
	for _, ev := range after {
		if ev == nil {
			continue
		}
		b, _ := json.Marshal(ev)
		if !write("event: %s\ndata: %s\n\n", ev.Type, b) {
			return
		}
	}
	ping := time.NewTicker(s.cfg.SSEPing)
	defer ping.Stop()
	for {
		select {
		case ev, ok := <-sub.ch:
			if !ok {
				return
			}
			b, _ := json.Marshal(ev)
			if !write("event: %s\ndata: %s\n\n", ev.Type, b) {
				return
			}
		case <-ping.C:
			if !write("event: ping\ndata: {\"type\":\"ping\",\"ts\":%q}\n\n", s.now().UTC().Format(time.RFC3339)) {
				return
			}
		case <-r.Context().Done():
			return
		case <-s.closing:
			return
		}
	}
}

func (s *Server) handleSessionReport(w http.ResponseWriter, r *http.Request) {
	var st api.SessionState
	if !decodeBody(w, r, maxReportBytes, &st) {
		return
	}
	u := s.userOrAnon(r)
	ok, lim := s.hub.report(r.PathValue("id"), u, st)
	switch {
	case !ok:
		api.WriteError(w, errNoSession())
	case lim:
		e := api.Errf(http.StatusTooManyRequests, api.CodeRateLimited, "reporting too fast")
		e.RetryAfter = 1
		api.WriteError(w, e)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

func (s *Server) handleSessionReply(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RequestID string           `json:"request_id"`
		State     api.SessionState `json:"state"`
	}
	if !decodeBody(w, r, maxReportBytes, &body) {
		return
	}
	if body.RequestID == "" {
		api.WriteError(w, api.Errf(http.StatusBadRequest, api.CodeBadRequest, "request_id is required"))
		return
	}
	if !s.hub.reply(r.PathValue("id"), s.userOrAnon(r), body.RequestID, body.State) {
		api.WriteError(w, errNoSession())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

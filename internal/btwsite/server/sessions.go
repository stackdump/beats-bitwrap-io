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
	maxSessions        = 5000
	maxSessionsPerUser = 20
	sessionTTL         = 10 * time.Minute // without a subscriber, a report, or a reply
	stateFresh         = 1500 * time.Millisecond
	getWait            = 3 * time.Second
	maxReportBytes     = 256 << 10
)

type subscriber struct {
	ch   chan api.SessionEvent
	once sync.Once
}

func (s *subscriber) close() { s.once.Do(func() { close(s.ch) }) }

type session struct {
	id       string
	owner    string // user id, "" = anonymous
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
				if oldest == nil || s.lastSeen.Before(oldest.lastSeen) {
					oldest = s
				}
			}
		}
		if n >= maxSessionsPerUser { // a page that reloads a lot: retire the least recently seen
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
	delete(h.sessions, s.id)
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
	sub := &subscriber{ch: make(chan api.SessionEvent, 16)}
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
	s.state, s.stateAt, s.lastSeen = &st, now, now
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
	s.state, s.stateAt, s.lastSeen = &st, now, now
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
		return nil, api.Errf(http.StatusConflict, api.CodeNoSession, "no browser session is connected for you: open https://btw.bitwrap.io signed in, then retry")
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
		si := api.SessionInfo{ID: s.id, Owner: s.owner, LastSeen: s.lastSeen.UTC().Format(time.RFC3339)}
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

func (s *Server) handleSessionEvents(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	u := s.userOrAnon(r)
	sub, err := s.hub.subscribe(id, u)
	if err != nil {
		api.WriteError(w, err)
		return
	}
	defer s.hub.unsubscribe(id, sub)
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

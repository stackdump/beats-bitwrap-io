package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
)

// The up-next queue (btwsite/DESIGN.md "Up next"). It lives on a hub session, in memory, and goes when the session
// goes. MCP's queue tool writes it; the page reads it and, when a track ends, asks POST /api/session/<id>/queue/next
// for the next item. The server decides that answer under the presence rules, so neither an agent nor a page that
// forgets to check can keep a tab playing to an empty room:
//
//   - The page reports presence (visibility, focus, the AudioContext state, ms since the last key/pointer/touch/media
//     key) with every report and with every next request.
//   - The queue advances only while a listener is plausibly present: not when the audio is suspended, not when the tab
//     is hidden and idle for QueueIdleMinutes, and not after QueueMaxAuto advances in a row without an interaction.
//   - A pause is sticky: it clears only when the page reports an interaction newer than the pause. MCP cannot clear
//     it (skip is refused while paused; load still plays one program, as it always has, but does not resume the queue).
//
// The queue holds programs that already exist (a stored CID, an example, a verified share link). Nothing here calls
// compose or a model, starts a render, or runs in the background: every change is a request from MCP or the page.

// QueueConfig is the queue's limits; the zero value of a field means its default.
type QueueConfig struct {
	IdleMinutes int // a hidden tab with no interaction for this long pauses the queue (default 30)
	MaxAuto     int // consecutive advances without an interaction before the queue pauses (default 8)
	MaxItems    int // queue length (default 50)
	MaxPerAdd   int // items one add may carry (default 20)
}

func (c *QueueConfig) defaults() {
	if c.IdleMinutes <= 0 {
		c.IdleMinutes = 30
	}
	if c.MaxAuto <= 0 {
		c.MaxAuto = 8
	}
	if c.MaxItems <= 0 {
		c.MaxItems = 50
	}
	if c.MaxPerAdd <= 0 {
		c.MaxPerAdd = 20
	}
}

// maxQueueTextBytes bounds the link items' texts one queue may hold (stored and example items hold only a CID).
const maxQueueTextBytes = 256 << 10

// presenceStale: a report older than this is no evidence of a listener.
const presenceStale = 2 * time.Minute

// Pause reasons (QueueView.PausedReason, Listener).
const (
	PauseIdleHidden     = "idle_hidden"
	PauseAudioSuspended = "audio_suspended"
	PauseMaxAuto        = "max_auto_advance"
	PauseNoReport       = "no_listener_report"
	listenerPresent     = "present"
)

type queueState struct {
	items      []api.QueueItem
	nowPlaying *api.QueueItem
	position   int
	seq        int
	textBytes  int

	paused   string
	pausedAt time.Time

	auto         int       // advances since the last interaction
	lastAdvance  time.Time // server time of the last advance
	lastInteract time.Time // server time of the newest interaction any report has shown
	presence     *api.Presence
	presenceAt   time.Time
}

func (q *queueState) bytes() int {
	if q == nil {
		return 0
	}
	return q.textBytes + 128*len(q.items)
}

// notePresence takes a presence report made at now: the interaction it shows moves lastInteract forward (never back).
func (q *queueState) notePresence(p *api.Presence, now time.Time) {
	if p == nil {
		return
	}
	cp := *p
	if cp.IdleMS < 0 {
		cp.IdleMS = 0
	}
	q.presence, q.presenceAt = &cp, now
	at := now.Add(-time.Duration(cp.IdleMS) * time.Millisecond)
	if at.After(q.lastInteract) {
		q.lastInteract = at
	}
}

// verdict is what a boundary at now would decide: listenerPresent, or why it would pause.
func (q *queueState) verdict(cfg QueueConfig, now time.Time) string {
	p := q.presence
	if p == nil || now.Sub(q.presenceAt) > presenceStale {
		return PauseNoReport
	}
	if p.Audio != "running" {
		return PauseAudioSuspended
	}
	idle := now.Sub(q.lastInteract)
	if !p.Visible && idle >= time.Duration(cfg.IdleMinutes)*time.Minute {
		return PauseIdleHidden
	}
	if q.auto >= cfg.MaxAuto && !q.lastInteract.After(q.lastAdvance) {
		return PauseMaxAuto
	}
	return listenerPresent
}

// settle applies what the latest interaction does: an interaction after the last advance restarts the count, and one
// after a pause lifts it.
func (q *queueState) settle() {
	if q.lastInteract.After(q.lastAdvance) {
		q.auto = 0
	}
	if q.paused != "" && q.lastInteract.After(q.pausedAt) {
		q.paused = ""
	}
}

func (q *queueState) view(id string, cfg QueueConfig, now time.Time) *api.QueueView {
	v := &api.QueueView{Session: id, UpNext: []api.QueueItem{}, MaxAuto: cfg.MaxAuto, IdleMinutes: cfg.IdleMinutes, MaxItems: cfg.MaxItems, Listener: PauseNoReport}
	if q == nil {
		return v
	}
	q.settle()
	v.UpNext = append(v.UpNext, q.items...)
	if q.nowPlaying != nil {
		np := *q.nowPlaying
		v.NowPlaying = &np
	}
	v.Position, v.PausedReason, v.AutoAdvanced = q.position, q.paused, q.auto
	v.Listener = q.verdict(cfg, now)
	return v
}

// queueEvent is what the page is sent when its queue changes (no texts: the page asks for an item when it plays it).
func queueEvent(v *api.QueueView, extra map[string]any) api.SessionEvent {
	m := map[string]any{"queue": v}
	for k, x := range extra {
		m[k] = x
	}
	b, _ := json.Marshal(m)
	return api.SessionEvent{Type: "queue", Extra: b}
}

// queueTargetLocked is the one session a queue call addresses: the named one (owned by u or anonymous), else u's
// most recently seen (a queue on every tab at once would play every track twice).
func (h *hub) queueTargetLocked(u *api.User, id string) (*session, error) {
	targets, err := h.targetLocked(u, id)
	if err != nil {
		return nil, err
	}
	if len(targets) == 0 {
		return nil, errNoSession()
	}
	return targets[0], nil
}

// Queue implements api.Queuer.
func (h *hub) Queue(u *api.User, sessionID string, op api.QueueOp) (*api.QueueView, bool, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s, err := h.queueTargetLocked(u, sessionID)
	if err != nil {
		return nil, false, err
	}
	cfg := h.queueCfg
	now := h.now()
	if s.queue == nil {
		s.queue = &queueState{}
	}
	q := s.queue
	q.settle()
	changed := false
	switch op.Action {
	case "list":
	case "add":
		if len(op.Items) == 0 {
			return nil, false, api.Errf(http.StatusBadRequest, api.CodeBadRequest, "add needs at least one item")
		}
		if len(op.Items) > cfg.MaxPerAdd {
			return nil, false, api.Errf(http.StatusRequestEntityTooLarge, api.CodeTooLarge, "one add takes at most %d items; this one has %d", cfg.MaxPerAdd, len(op.Items))
		}
		if len(q.items)+len(op.Items) > cfg.MaxItems {
			return nil, false, api.Errf(http.StatusRequestEntityTooLarge, api.CodeTooLarge, "the queue holds at most %d items; it has %d and this add brings %d. Remove or clear some first.", cfg.MaxItems, len(q.items), len(op.Items))
		}
		add := 0
		for _, it := range op.Items {
			add += len(it.Text)
		}
		if q.textBytes+add > maxQueueTextBytes {
			return nil, false, api.Errf(http.StatusRequestEntityTooLarge, api.CodeTooLarge, "the queue's link items may hold at most %d KiB of program text; store the programs (share or render) and queue their CIDs instead", maxQueueTextBytes>>10)
		}
		if h.bytes+add+128*len(op.Items) > maxStateBytes {
			e := api.Errf(http.StatusServiceUnavailable, "busy", "the server is holding too much session state; try again later")
			e.RetryAfter = 60
			return nil, false, e
		}
		before := q.bytes()
		for _, it := range op.Items {
			q.seq++
			it.ID = fmt.Sprintf("q%d", q.seq)
			q.items = append(q.items, it)
			q.textBytes += len(it.Text)
		}
		h.bytes += q.bytes() - before
		changed = true
	case "remove":
		key := strings.TrimSpace(op.Remove)
		idx := -1
		for i, it := range q.items {
			if it.ID == key || it.CID == key {
				idx = i
				break
			}
		}
		if idx < 0 {
			return nil, false, api.Errf(http.StatusNotFound, api.CodeNotFound, "no queued item has id or cid %q; call queue with action list", key)
		}
		before := q.bytes()
		q.textBytes -= len(q.items[idx].Text)
		q.items = append(q.items[:idx:idx], q.items[idx+1:]...)
		h.bytes += q.bytes() - before
		changed = true
	case "clear":
		h.bytes -= q.bytes()
		q.items, q.textBytes = nil, 0
		changed = true
	case "skip":
		v := q.view(s.id, cfg, now)
		if len(q.items) == 0 {
			return v, false, nil
		}
		if v.PausedReason != "" || v.Listener != listenerPresent {
			return v, false, nil
		}
		sent := h.deliverLocked(s, queueEvent(v, map[string]any{"action": "skip"}))
		return v, sent, nil
	default:
		return nil, false, api.Errf(http.StatusBadRequest, api.CodeBadRequest, "unknown queue action %q (add, list, remove, clear, skip)", op.Action)
	}
	v := q.view(s.id, cfg, now)
	if changed {
		h.deliverLocked(s, queueEvent(v, nil))
	}
	return v, false, nil
}

// next is the page asking for the item to play now (reason: ended | length | skip | resume). It answers the item, or
// nil with the view saying why not (an empty queue, or a pause).
func (h *hub) next(id string, u *api.User, p *api.Presence) (*api.QueueItem, *api.QueueView, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s, ok := h.pageAccess(id, u)
	if !ok {
		return nil, nil, false
	}
	h.claimLocked(s, u)
	cfg := h.queueCfg
	now := h.now()
	s.lastSeen = now
	if s.queue == nil {
		s.queue = &queueState{}
	}
	q := s.queue
	q.notePresence(p, now)
	q.settle()
	if q.paused != "" || len(q.items) == 0 {
		return nil, q.view(s.id, cfg, now), true
	}
	if why := q.verdict(cfg, now); why != listenerPresent {
		q.paused, q.pausedAt = why, now
		v := q.view(s.id, cfg, now)
		h.deliverLocked(s, queueEvent(v, nil))
		return nil, v, true
	}
	before := q.bytes()
	it := q.items[0]
	q.items = q.items[1:]
	q.textBytes -= len(it.Text)
	h.bytes += q.bytes() - before
	np := it
	np.Text = ""
	q.nowPlaying = &np
	q.position++
	q.auto++
	q.lastAdvance = now
	v := q.view(s.id, cfg, now)
	h.deliverLocked(s, queueEvent(v, nil))
	return &it, v, true
}

// pageQueue is the page reading its own queue (after a reconnect).
func (h *hub) pageQueue(id string, u *api.User) (*api.QueueView, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s, ok := h.pageAccess(id, u)
	if !ok {
		return nil, false
	}
	return s.queue.view(s.id, h.queueCfg, h.now()), true
}

// ---------- HTTP (page side) ----------

func (s *Server) handleQueueNext(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Reason   string        `json:"reason"`
		Presence *api.Presence `json:"presence"`
	}
	if !decodeBody(w, r, 4<<10, &body) {
		return
	}
	switch body.Reason {
	case "ended", "length", "skip", "resume":
	default:
		api.WriteError(w, api.Errf(http.StatusBadRequest, api.CodeBadRequest, "reason must be ended, length, skip or resume"))
		return
	}
	it, v, ok := s.hub.next(r.PathValue("id"), s.userOrAnon(r), body.Presence)
	if !ok {
		api.WriteError(w, errNoSession())
		return
	}
	out := map[string]any{"queue": v, "item": nil}
	if it != nil {
		item := map[string]any{"id": it.ID, "cid": it.CID, "title": it.Title, "source": it.Source, "bars": it.Bars, "minutes": it.Minutes}
		if it.Example != "" {
			item["example"] = it.Example
		}
		if it.Text != "" {
			item["text"] = it.Text
		}
		out["item"] = item
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleQueueGet(w http.ResponseWriter, r *http.Request) {
	v, ok := s.hub.pageQueue(r.PathValue("id"), s.userOrAnon(r))
	if !ok {
		api.WriteError(w, errNoSession())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"queue": v})
}

// Queue implements api.Queuer for MCP.
func (s *Server) Queue(u *api.User, sessionID string, op api.QueueOp) (*api.QueueView, bool, error) {
	return s.hub.Queue(u, sessionID, op)
}

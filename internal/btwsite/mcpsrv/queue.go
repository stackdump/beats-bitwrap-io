package mcpsrv

import (
	"context"
	"fmt"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"

	"beats-bitwrap-io/internal/btwsite/api"
)

// The queue tool: an up-next list on one browser tab (btwsite/DESIGN.md "Up next"). It never composes: an item is a
// program that already exists (a stored CID, an example, a verified share link), so a tab left open can play the
// queue to its end and cost nothing but its own CPU. The presence rules that stop it are the server's (server/queue.go).

func (s *Server) queueDesc() string {
	return fmt.Sprintf(`An "up next" queue on one browser tab at %[1]s (the same tabs and rules as load: session, or device, else your most recently seen signed-in tab). When the playing program ends the page plays the next item, on the bar line where it can; a looping program (one that never ends) plays for the item's bars or minutes, else one full pass of its arrangement, and then advances. Needs a bearer token.

action is one of: list (the queue, now_playing, position, paused_reason, listener), add (items: up to %[2]d per call, %[3]d in the queue), remove (item: an item id from list, or a CID), clear, skip (play the next item now).

Items must already be programs: {cid} of a stored program (render and a signed-in share store theirs) or an example's CID, {example} by name from list_examples, or {url} a share link (verified exactly as load verifies it; a CID-only link must name a stored program). Optional per item: bars (1-1024) or minutes (0.1-120) to play, title. THE QUEUE NEVER COMPOSES OR CALLS A MODEL, and there is no way to make it: to queue new music, write the programs yourself (check them), store each with render or share, then add the CIDs.

The queue advances only while a listener is plausibly present, as the page reports it: it pauses at the next track boundary when the tab's audio is suspended, when the tab has been hidden with no key, pointer, touch or media key for %[4]d minutes, or after %[5]d tracks in a row without any interaction; the page then shows "Still listening? Press play to continue". Only a person on the page lifts a pause: skip is refused while paused (paused_reason says why), and load still plays one program as it always has but does not resume the queue. Writes are limited to about %[6]d a minute. The queue lives with the tab's session and is gone when the tab is.`,
		s.public, s.queueMaxPerAdd(), s.queueMaxItems(), s.queueIdleMinutes(), s.queueMaxAuto(), s.opt.QueueWritesPerMin)
}

// The queue's limits, as the server is configured (WithQueueLimits); the backend enforces them, these are the words.
func (s *Server) queueMaxPerAdd() int   { return s.opt.QueueMaxPerAdd }
func (s *Server) queueMaxItems() int    { return s.opt.QueueMaxItems }
func (s *Server) queueIdleMinutes() int { return s.opt.QueueIdleMinutes }
func (s *Server) queueMaxAuto() int     { return s.opt.QueueMaxAuto }

func (s *Server) addQueueTool(sessionArg, deviceArg mcp.ToolOption, noExtra mcp.ToolOption) {
	s.add(mcp.NewTool("queue",
		mcp.WithDescription(s.queueDesc()), noExtra,
		mcp.WithTitleAnnotation("Up next: queue programs on a browser tab"), hints(false, true, false, false),
		mcp.WithString("action", mcp.Required(), mcp.Enum("list", "add", "remove", "clear", "skip"), mcp.Description("list, add, remove, clear or skip.")),
		mcp.WithArray("items", mcp.MaxItems(s.queueMaxPerAdd()), mcp.Description("add: the programs to append, each an object with exactly one of cid, example, url, and optionally bars, minutes, title."),
			mcp.Items(map[string]any{
				"type":                 "object",
				"additionalProperties": false,
				"properties": map[string]any{
					"cid":     map[string]any{"type": "string", "maxLength": 100, "pattern": `^z[1-9A-HJ-NP-Za-km-z]{20,100}$`, "description": "CID of a stored program or an example."},
					"example": map[string]any{"type": "string", "maxLength": 64, "pattern": `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, "description": "Name of an example, from list_examples."},
					"url":     map[string]any{"type": "string", "maxLength": 32768, "description": "A share link, verified as load verifies it."},
					"bars":    map[string]any{"type": "integer", "minimum": 1, "maximum": 1024, "description": "Play this many bars, then advance (else until the program ends; a loop: one arrangement pass)."},
					"minutes": map[string]any{"type": "number", "minimum": 0.1, "maximum": 120, "description": "Play this long, then advance at the next bar line. Not with bars."},
					"title":   map[string]any{"type": "string", "maxLength": 80, "description": "What the page shows for it (else the program's name)."},
				},
			})),
		mcp.WithString("item", mcp.MaxLength(100), mcp.Description("remove: an item id from list (q1, q2, ...) or a CID (the first queued item with it).")),
		sessionArg, deviceArg,
	), s.queue)
}

func (s *Server) limitQueue(c caller) *api.Error {
	if ok, retry := s.queueLim.allow(c.key); !ok {
		e := api.Errf(429, api.CodeRateLimited, "too many queue writes; slow down")
		e.RetryAfter = retry
		return e
	}
	if ok, retry := s.ipCeiling(s.queueIP, c); !ok {
		e := api.Errf(429, api.CodeRateLimited, "too many queue writes from your address; slow down")
		e.RetryAfter = retry
		return e
	}
	return nil
}

func (s *Server) queue(ctx context.Context, c caller, a args) (any, *api.Error) {
	if e := a.only("action", "items", "item", "session", "device"); e != nil {
		return nil, e
	}
	action, _, e := a.str("action", 10)
	if e != nil {
		return nil, e
	}
	switch action {
	case "list", "add", "remove", "clear", "skip":
	default:
		return nil, api.Errf(400, api.CodeBadRequest, "argument \"action\" must be one of list, add, remove, clear, skip")
	}
	if _, has := a["items"]; has && action != "add" {
		return nil, api.Errf(400, api.CodeBadRequest, "items is for action add")
	}
	item, hasItem, e := a.str("item", 100)
	if e != nil {
		return nil, e
	}
	if hasItem && action != "remove" {
		return nil, api.Errf(400, api.CodeBadRequest, "item is for action remove")
	}
	if action == "remove" && strings.TrimSpace(item) == "" {
		return nil, api.Errf(400, api.CodeBadRequest, "remove needs item: an item id from list, or a CID")
	}
	qb, ok := s.b.(api.Queuer)
	if !ok {
		return nil, api.Errf(404, api.CodeNotFound, "this server has no up-next queue")
	}
	session, e := s.target(c, a)
	if e != nil {
		return nil, e
	}
	op := api.QueueOp{Action: action, Remove: item}
	if action != "list" {
		if e := s.limitQueue(c); e != nil {
			return nil, e
		}
	}
	if action == "add" {
		items, e := s.queueItems(ctx, c, a)
		if e != nil {
			return nil, e
		}
		op.Items = items
	}
	v, sent, err := qb.Queue(c.user, session, op)
	if err != nil {
		e := fail(err)
		if e.Code == api.CodeNoSession {
			return nil, s.noSession(session)
		}
		return nil, e
	}
	out := map[string]any{"action": action, "queue": v}
	switch action {
	case "skip":
		out["skipped"] = sent
		switch {
		case sent:
			out["note"] = "The tab was asked to play the next item now. Call get to see it."
		case len(v.UpNext) == 0:
			out["note"] = "The queue is empty: nothing to skip to."
		case v.PausedReason != "":
			out["note"] = "Not skipped: the queue is paused (" + v.PausedReason + ") until someone interacts with the page. Only a person on the page can resume it."
		case v.Listener != "present":
			out["note"] = "Not skipped: no listener is present on the tab (" + v.Listener + "). The queue advances only while someone is listening."
		default:
			out["note"] = "Not skipped: the tab has no live connection."
		}
	case "add":
		out["note"] = "Queued. The tab plays them in order after the current program ends (call get to see what is playing). Nothing is composed or rendered for a queue."
	}
	return out, nil
}

// queueItems reads and verifies add's items: each must name a program that exists.
func (s *Server) queueItems(ctx context.Context, c caller, a args) ([]api.QueueItem, *api.Error) {
	raw, ok := a["items"].([]any)
	if !ok || len(raw) == 0 {
		return nil, api.Errf(400, api.CodeBadRequest, "add needs items: a list of {cid}, {example} or {url} objects")
	}
	if len(raw) > s.queueMaxPerAdd() {
		return nil, api.Errf(413, api.CodeTooLarge, "one add takes at most %d items; this one has %d", s.queueMaxPerAdd(), len(raw))
	}
	out := make([]api.QueueItem, 0, len(raw))
	for i, r := range raw {
		m, ok := r.(map[string]any)
		if !ok {
			return nil, api.Errf(400, api.CodeBadRequest, "items[%d] must be an object", i)
		}
		it, e := s.queueItem(ctx, c, args(m))
		if e != nil {
			e.Message = fmt.Sprintf("items[%d]: %s", i, e.Message)
			return nil, e
		}
		out = append(out, it)
	}
	return out, nil
}

func (s *Server) queueItem(ctx context.Context, c caller, a args) (api.QueueItem, *api.Error) {
	var it api.QueueItem
	if e := a.only("cid", "example", "url", "bars", "minutes", "title"); e != nil {
		return it, e
	}
	cid, hasCID, e := a.str("cid", 100)
	if e != nil {
		return it, e
	}
	example, hasEx, e := a.str("example", 64)
	if e != nil {
		return it, e
	}
	url, hasURL, e := a.str("url", 32768)
	if e != nil {
		return it, e
	}
	if hasURL {
		if sc, ok := bareCID(url); ok && !hasCID {
			cid, hasCID, url, hasURL = sc, true, "", false
		}
	}
	n := 0
	for _, b := range []bool{hasCID && cid != "", hasEx && example != "", hasURL && url != ""} {
		if b {
			n++
		}
	}
	if n != 1 {
		return it, api.Errf(400, api.CodeBadRequest, "give exactly one of cid, example, url")
	}
	bars, hasBars, e := a.num("bars", 1, 1024)
	if e != nil {
		return it, e
	}
	if hasBars && bars != float64(int(bars)) {
		return it, api.Errf(400, api.CodeBadRequest, "argument \"bars\" must be a whole number")
	}
	minutes, hasMin, e := a.num("minutes", 0.1, 120)
	if e != nil {
		return it, e
	}
	if hasBars && hasMin {
		return it, api.Errf(400, api.CodeBadRequest, "give bars or minutes, not both")
	}
	title, hasTitle, e := a.str("title", 320)
	if e != nil {
		return it, e
	}
	if hasTitle {
		t, ok := oneLine(title, 80)
		if !ok {
			return it, api.Errf(400, api.CodeBadRequest, "argument \"title\" must be one line of at most 80 characters")
		}
		title = t
	}
	it.Bars, it.Minutes = int(bars), minutes

	switch {
	case cid != "":
		if !reCID.MatchString(cid) {
			return it, api.Errf(400, api.CodeBadRequest, "argument \"cid\" is not a CID (it starts with z)")
		}
		_, src, meta, ok := s.storedProgram(cid)
		if !ok {
			return it, api.Errf(404, api.CodeNotFound, "no stored program has CID %s. The queue plays only programs that exist: store one first (render, or share signed in), then queue its CID.", cid)
		}
		it.CID, it.Source = cid, src
		if title == "" {
			title = meta.Name
		}
		if src == "example" {
			for _, ex := range s.b.Examples() {
				if ex.CID == cid {
					it.Example = ex.Name
					break
				}
			}
		}
	case example != "":
		if !reName.MatchString(example) {
			return it, api.Errf(400, api.CodeBadRequest, "argument \"example\" is an example name, as list_examples gives")
		}
		if _, ok := s.b.Example(example); !ok {
			return it, api.Errf(404, api.CodeNotFound, "no example is named %q; call list_examples", example)
		}
		it.CID, _ = s.exampleCID(example)
		it.Source, it.Example = "example", example
		if title == "" {
			for _, ex := range s.b.Examples() {
				if ex.Name == example {
					title = ex.Title
				}
			}
		}
	default:
		if e := s.limitCPU(c); e != nil {
			return it, e
		}
		rep, err := s.b.Open(ctx, url)
		if err != nil {
			return it, fail(err)
		}
		if rep == nil || !rep.OK || !rep.Verified {
			msg := "the link did not open"
			if rep != nil && rep.Error != "" {
				msg = rep.Error
			}
			code := api.CodeBadRequest
			if rep != nil && rep.Canonical != "" && !rep.Verified {
				code = api.CodeCIDMismatch
			}
			return it, api.Errf(422, code, "%s", msg)
		}
		it.CID, it.Source = rep.CID, "link"
		if _, src, ok := s.storedText(rep.CID); ok {
			it.Source = src // the site has it: the page fetches it by CID like any stored program
		} else {
			it.Text = rep.Canonical // only a link the site does not store carries its text, in memory
		}
	}
	it.Title = title
	return it, nil
}

// upNextOf is get's view of a session's queue (nil without one).
func (s *Server) upNextOf(c caller, session string) *api.QueueView {
	qb, ok := s.b.(api.Queuer)
	if !ok {
		return nil
	}
	v, _, err := qb.Queue(c.user, session, api.QueueOp{Action: "list"})
	if err != nil {
		return nil
	}
	return v
}

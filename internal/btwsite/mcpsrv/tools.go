package mcpsrv

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"beats-bitwrap-io/internal/btwsite/api"
	"beats-bitwrap-io/internal/btwsite/ld"
)

var (
	reCID     = regexp.MustCompile(`^z[1-9A-HJ-NP-Za-km-z]{20,100}$`)
	reSession = regexp.MustCompile(`^[A-Za-z0-9_-]{6,64}$`)
	reDevice  = regexp.MustCompile(`^[A-Za-z0-9_-]{6,64}$`)
	reName    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
	reLength  = regexp.MustCompile(`^(short|medium|long|[0-9]{1,3})$`)
	reKey     = regexp.MustCompile(`^[A-Za-z0-9#:]{1,24}$`)
)

// toolFn is one tool: it gets the caller and the arguments and answers a value (a string is the text, a
// json.RawMessage is used as is, anything else is marshalled) or a typed error.
type toolFn func(ctx context.Context, c caller, a args) (any, *api.Error)

func (s *Server) add(t mcp.Tool, fn toolFn) {
	name := t.Name
	needAuth := authTools[name]
	s.mcp.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		c := s.caller(ctx)
		if needAuth && c.user == nil {
			return errResult(api.Errf(401, api.CodeAuthRequired, "%s needs a signed-in caller. %s", name, s.authHelp())), nil
		}
		var a args
		switch raw := req.GetRawArguments().(type) {
		case nil:
			a = args{}
		case map[string]any:
			a = args(raw)
		default:
			return errResult(api.Errf(400, api.CodeBadRequest, "the arguments of %s must be a JSON object", name)), nil
		}
		v, e := fn(ctx, c, a)
		if e != nil {
			return errResult(e), nil
		}
		return okResult(v), nil
	})
}

func okResult(v any) *mcp.CallToolResult {
	switch t := v.(type) {
	case string:
		return mcp.NewToolResultText(t)
	case json.RawMessage:
		return mcp.NewToolResultText(string(t))
	case []byte:
		return mcp.NewToolResultText(string(t))
	}
	b, err := json.Marshal(v)
	if err != nil {
		return errResult(api.Errf(500, "internal", "could not encode the answer: %v", err))
	}
	return mcp.NewToolResultText(string(b))
}

// errResult is a tool error: isError true, and the text is the site's error body.
func errResult(e *api.Error) *mcp.CallToolResult {
	cp := *e
	if cp.RetryAfter > 0 && !strings.Contains(strings.ToLower(cp.Message), "retry") {
		cp.Message += fmt.Sprintf(" Retry after %d seconds.", cp.RetryAfter)
	}
	b, _ := json.Marshal(map[string]any{"error": &cp})
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{mcp.NewTextContent(string(b))}}
}

// fail turns whatever a backend returned into an *api.Error.
func fail(err error) *api.Error {
	var e *api.Error
	if errors.As(err, &e) && e != nil {
		return e
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return api.Errf(504, "timeout", "the server took too long; try again")
	}
	if errors.Is(err, context.Canceled) {
		return api.Errf(499, "canceled", "the call was canceled")
	}
	// Anything else is the server's own business (a path, a syscall, a subprocess's words): the operator's log
	// gets it, the caller a fixed sentence. (HTTP does the same: asAPIError.)
	log.Printf("btwsite: mcp: internal error: %v", err)
	return api.Errf(500, "internal", "the server could not complete that call; try again")
}

// ---------- arguments ----------

type args map[string]any

// only rejects an argument the tool does not have, naming the ones it has: a mistyped `sesion` must not
// silently become "every session".
func (a args) only(keys ...string) *api.Error {
	for k := range a {
		ok := false
		for _, w := range keys {
			if k == w {
				ok = true
				break
			}
		}
		if !ok {
			sort.Strings(keys)
			return api.Errf(400, api.CodeBadRequest, "unknown argument %q; this tool takes: %s", k, strings.Join(keys, ", "))
		}
	}
	return nil
}

// str reads an optional string argument; a present one must be a string of at most maxBytes bytes.
func (a args) str(key string, maxBytes int) (v string, present bool, e *api.Error) {
	raw, ok := a[key]
	if !ok || raw == nil {
		return "", false, nil
	}
	v, ok = raw.(string)
	if !ok {
		return "", false, api.Errf(400, api.CodeBadRequest, "argument %q must be a string", key)
	}
	if len(v) > maxBytes {
		return "", false, api.Errf(413, api.CodeTooLarge, "argument %q is %d bytes; the limit is %d", key, len(v), maxBytes)
	}
	if strings.ContainsRune(v, 0) {
		return "", false, api.Errf(400, api.CodeBadRequest, "argument %q contains a NUL byte", key)
	}
	return v, true, nil
}

func (a args) num(key string, lo, hi float64) (v float64, present bool, e *api.Error) {
	raw, ok := a[key]
	if !ok || raw == nil {
		return 0, false, nil
	}
	f, ok := raw.(float64)
	if !ok {
		return 0, false, api.Errf(400, api.CodeBadRequest, "argument %q must be a number", key)
	}
	if f < lo || f > hi {
		return 0, false, api.Errf(400, api.CodeBadRequest, "argument %q must be between %v and %v", key, lo, hi)
	}
	return f, true, nil
}

func (a args) boolean(key string) (v bool, e *api.Error) {
	raw, ok := a[key]
	if !ok || raw == nil {
		return false, nil
	}
	v, ok = raw.(bool)
	if !ok {
		return false, api.Errf(400, api.CodeBadRequest, "argument %q must be true or false", key)
	}
	return v, nil
}

// program reads a required program text, limited to MaxProgramBytes.
func (s *Server) program(a args, key string) (string, *api.Error) {
	v, ok, e := a.str(key, s.opt.MaxProgramBytes)
	if e != nil {
		if e.Code == api.CodeTooLarge {
			e.Message = fmt.Sprintf("the program is %d bytes; programs are limited to %d bytes (about %d lines). Shorten it: use let and def to say a pattern once.",
				len(a[key].(string)), s.opt.MaxProgramBytes, s.opt.MaxProgramBytes/40)
		}
		return "", e
	}
	if !ok || strings.TrimSpace(v) == "" {
		return "", api.Errf(400, api.CodeBadRequest, "argument %q is required: the text of a btw program", key)
	}
	return v, nil
}

func (a args) session() (string, *api.Error) {
	v, ok, e := a.str("session", 64)
	if e != nil {
		return "", e
	}
	if ok && !reSession.MatchString(v) {
		return "", api.Errf(400, api.CodeBadRequest, "argument \"session\" is not a session id; copy the id the page's MCP panel shows (letters, digits, - and _)")
	}
	return v, nil
}

// target is the session to drive: the session argument, or the hub session of the paired phone named by
// device (api.Devices), or "" for all of the caller's own. session and device together are refused.
func (s *Server) target(c caller, a args) (string, *api.Error) {
	session, e := a.session()
	if e != nil {
		return "", e
	}
	dev, ok, e := a.str("device", 64)
	if e != nil {
		return "", e
	}
	if !ok || dev == "" {
		return session, nil
	}
	if !reDevice.MatchString(dev) {
		return "", api.Errf(400, api.CodeBadRequest, "argument \"device\" is not a device id; call devices for the ids of your paired phones")
	}
	if session != "" {
		return "", api.Errf(400, api.CodeBadRequest, "give session or device, not both")
	}
	dh, ok := s.b.(api.Devices)
	if !ok {
		return "", api.Errf(404, api.CodeNotFound, "this server has no paired phones")
	}
	sid, err := dh.DeviceSession(c.user, dev)
	if err != nil {
		return "", fail(err)
	}
	return sid, nil
}

// ---------- shared steps ----------

func (s *Server) limitCPU(c caller) *api.Error {
	if ok, retry := s.cpu.allow(c.key); !ok {
		e := api.Errf(429, api.CodeRateLimited, "too many calls to the checker; slow down")
		e.RetryAfter = retry
		return e
	}
	if ok, retry := s.ipCeiling(s.cpuIP, c); !ok {
		e := api.Errf(429, api.CodeRateLimited, "too many calls to the checker from your address; slow down")
		e.RetryAfter = retry
		return e
	}
	return nil
}

// ipCeiling counts a signed-in caller against their address too (anonymous callers' own key is the address).
func (s *Server) ipCeiling(l *limiter, c caller) (bool, int) {
	if c.user == nil {
		return true, 0
	}
	ip := c.ip
	if ip == "" {
		ip = "unknown"
	}
	return l.allow("ip:" + api.IPKey(ip))
}

func (s *Server) checkProgram(ctx context.Context, c caller, text string) (*api.CheckReport, *api.Error) {
	if e := s.limitCPU(c); e != nil {
		return nil, e
	}
	rep, err := s.b.Check(ctx, text)
	if err != nil {
		return nil, fail(err)
	}
	if rep == nil {
		return nil, api.Errf(500, "internal", "the checker answered nothing")
	}
	return rep, nil
}

// needsFixing is the tool error for a program that did not check: the diagnostics travel in details.
func needsFixing(rep *api.CheckReport, what string) *api.Error {
	e := api.Errf(422, api.CodeBadRequest, "the program has %d error(s), so %s. Fix each at its line:col (the help line says how; render is the caret form) and call check again.", rep.Errors, what)
	e.Details = map[string]any{"errors": rep.Errors, "warnings": rep.Warnings, "diagnostics": rep.Diagnostics}
	return e
}

// private is the error for a program the web page cannot play or store: samples and restricted programs.
func private(rep *api.CheckReport, what string) *api.Error {
	switch {
	case rep.Restricted:
		return api.Errf(422, api.CodeRestricted, "the program says `use restricted` or uses a restricted asset, so %s: private programs never leave the machine they were written on.", what)
	case rep.UsesAssets:
		return api.Errf(422, api.CodeRestricted, "the program uses `sample` or `loop` assets, which this site has no files for, so %s. Use the instruments tool's voices instead.", what)
	}
	return nil
}

func (s *Server) abs(u string) string {
	if strings.HasPrefix(u, "/") {
		return s.public + u
	}
	return u
}

func (s *Server) noSession(session string) *api.Error {
	var msg string
	if session != "" {
		msg = fmt.Sprintf("No connected browser has session %q (it expired, was closed, or belongs to another account). "+
			"Open %s in a browser tab, press MCP in the top bar to see its session id, and pass that id as `session`.", session, s.public)
	} else {
		msg = fmt.Sprintf("No browser is connected to drive. Open %s in a browser tab signed in as the account this token belongs to, "+
			"then call again. For an anonymous tab, press MCP in the top bar of the page: it shows a session id; pass it as `session`.", s.public)
	}
	return api.Errf(404, api.CodeNoSession, "%s", msg)
}

func (s *Server) push(c caller, session string, ev api.SessionEvent) (int, *api.Error) {
	n, err := s.b.Push(c.user, session, ev)
	if err != nil {
		e := fail(err)
		if e.Code == api.CodeNoSession {
			return 0, s.noSession(session)
		}
		return 0, e
	}
	if n <= 0 {
		return 0, s.noSession(session)
	}
	return n, nil
}

// exampleCID is the CID of a named example.
func (s *Server) exampleCID(name string) (string, bool) {
	for _, e := range s.b.Examples() {
		if e.Name == name {
			return e.CID, true
		}
	}
	return "", false
}

// storedText finds a program by CID in the store, then among the examples.
func (s *Server) storedText(cid string) (text, source string, ok bool) {
	t, src, _, ok := s.storedProgram(cid)
	return t, src, ok
}

// storedProgram is storedText plus the rights kept with it (an example's: its licence).
func (s *Server) storedProgram(cid string) (text, source string, meta api.Meta, ok bool) {
	if p, found := s.b.Get(cid); found && p != nil {
		return p.Text, "store", p.Meta, true
	}
	for _, e := range s.b.Examples() {
		if e.CID == cid {
			if t, found := s.b.Example(e.Name); found {
				return t, "example", api.Meta{License: e.License, Visibility: "public", Name: e.Title, Source: "example"}, true
			}
		}
	}
	return "", "", api.Meta{}, false
}

// shortLinkRE is a CID-only link: <origin>/p/<CID> (the short link, on btw or on beats), <origin>/c/<CID> (its
// link-preview page) or <origin>/#<CID> (the page opening a bare CID). A /c/ or # link with a packed program is
// not one: the checker opens that, from its own text.
var shortLinkRE = regexp.MustCompile(`^https?://[^/?#\s]+/(?:(?:p|c)/(z[1-9A-HJ-NP-Za-km-z]{20,100})/?|#(z[1-9A-HJ-NP-Za-km-z]{20,100}))(?:[?#][^\s]*)?$`)

// bareCID reads a bare CID out of u: u itself, or a CID-only short link (see shortLinkRE).
func bareCID(u string) (string, bool) {
	u = strings.TrimSpace(u)
	if reCID.MatchString(u) {
		return u, true
	}
	if strings.HasPrefix(u, "#") && reCID.MatchString(u[1:]) {
		return u[1:], true
	}
	if m := shortLinkRE.FindStringSubmatch(u); m != nil {
		if m[1] != "" {
			return m[1], true
		}
		return m[2], true
	}
	return "", false
}

// ---------- the tools ----------

// hints sets all four MCP annotations (mcp-go's defaults claim destructive and open-world for every tool).
func hints(readOnly, destructive, idempotent, openWorld bool) mcp.ToolOption {
	return func(t *mcp.Tool) {
		t.Annotations.ReadOnlyHint = &readOnly
		t.Annotations.DestructiveHint = &destructive
		t.Annotations.IdempotentHint = &idempotent
		t.Annotations.OpenWorldHint = &openWorld
	}
}

func (s *Server) addTools() {
	noExtra := mcp.WithSchemaAdditionalProperties(false)
	maxProg := s.opt.MaxProgramBytes
	sessionArg := mcp.WithString("session",
		mcp.MaxLength(64), mcp.Pattern(`^[A-Za-z0-9_-]{6,64}$`),
		mcp.Description("Session id of one browser tab, from the MCP panel of the page. Leave out to use your own signed-in tabs (every live one for eval/load/stop, the latest for get)."))
	deviceArg := mcp.WithString("device",
		mcp.MaxLength(64), mcp.Pattern(`^[A-Za-z0-9_-]{6,64}$`),
		mcp.Description("Id of one of your paired phones (djrust on Android), from the devices tool. Targets that phone alone; do not combine with session."))
	playArg := mcp.WithBoolean("play", mcp.Description("Start playing too (default false: load it and leave it stopped, or leave a playing tab as it is)."))

	s.add(mcp.NewTool("compose",
		mcp.WithDescription(s.composeDesc()), noExtra,
		mcp.WithTitleAnnotation("Compose a program from a prompt"),
		hints(false, false, false, true), // calls a model, stores a new program
		mcp.WithString("prompt", mcp.Required(), mcp.MaxLength(s.opt.MaxPromptChars),
			mcp.Description(fmt.Sprintf("What to write, in plain words: mood, genre, instruments, structure, e.g. \"dark techno at 128 with an acid line and a long breakdown\". At most %d characters.", s.opt.MaxPromptChars))),
		mcp.WithString("genre", mcp.MaxLength(40), mcp.Description("Optional genre hint, e.g. dubstep, trance, techno, ambient.")),
		mcp.WithNumber("bpm", mcp.Min(40), mcp.Max(300), mcp.Description("Optional tempo, 40 to 300.")),
		mcp.WithString("key", mcp.MaxLength(24), mcp.Pattern(`^[A-Za-z0-9#:]{1,24}$`), mcp.Description("Optional key, as the language writes it: am, c, f#m, d:dorian, d:phrygian.")),
		mcp.WithString("length", mcp.MaxLength(5), mcp.Pattern(`^(short|medium|long|[0-9]{1,3})$`), mcp.Description("Optional: short, medium, long, or a number of bars (at most 256).")),
		mcp.WithString("base_cid", mcp.MaxLength(100), mcp.Pattern(`^z[1-9A-HJ-NP-Za-km-z]{20,100}$`), mcp.Description("Optional CID of a public program (an example or one the site stored) to edit instead of starting fresh; the result records it as forked from.")),
	), s.compose)

	s.add(mcp.NewTool("check",
		mcp.WithDescription(s.checkDesc()), noExtra, hints(true, false, true, false),
		mcp.WithTitleAnnotation("Check a btw program"),
		mcp.WithString("text", mcp.Required(), mcp.MaxLength(maxProg), mcp.Description(fmt.Sprintf("The program text (at most %d bytes). Comments and blank lines are fine.", maxProg))),
		mcp.WithString("same_as", mcp.MaxLength(maxProg), mcp.Description("Optional: another program to compare with, as its CID (stored here, or an example's), a short "+s.public+"/p/<CID> link, or its text. The answer gains same_as: whether the two are the same song by their compiled nets and song-level settings (tempo, key, swing, length, end, loop), not their text: a let/def/repeat refactor or a renamed section is the same song; a changed note is not, and diff says what changed in music (song settings, sections moved or inserted, a part transposed or rotated, notes at bar:step).")),
	), s.check)

	s.add(mcp.NewTool("fmt",
		mcp.WithDescription(s.fmtDesc()), noExtra, hints(true, false, true, false),
		mcp.WithTitleAnnotation("Format a btw program"),
		mcp.WithString("text", mcp.Required(), mcp.MaxLength(maxProg), mcp.Description("The program text.")),
	), s.fmtTool)

	s.add(mcp.NewTool("eval",
		mcp.WithDescription(s.evalDesc()), noExtra,
		mcp.WithTitleAnnotation("Play a program in a browser tab"), hints(false, true, true, false), // replaces the editor's text
		mcp.WithString("text", mcp.Required(), mcp.MaxLength(maxProg), mcp.Description("The program text. It must pass check.")),
		playArg, sessionArg, deviceArg,
	), s.eval)

	s.add(mcp.NewTool("load",
		mcp.WithDescription(s.loadDesc()), noExtra,
		mcp.WithTitleAnnotation("Load a stored program into a browser tab"), hints(false, true, true, false),
		mcp.WithString("cid", mcp.MaxLength(100), mcp.Pattern(`^z[1-9A-HJ-NP-Za-km-z]{20,100}$`), mcp.Description("CID of a program the site has stored (compose and render store theirs) or of an example.")),
		mcp.WithString("example", mcp.MaxLength(64), mcp.Pattern(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`), mcp.Description("Name of an example, from list_examples.")),
		mcp.WithString("url", mcp.MaxLength(32768), mcp.Description("A share link: "+s.public+"/#<CID>.<packed>, a /c/ link, a beats.bitwrap.io/p# link, or a short /p/<CID> link (the program must be stored here).")),
		playArg, sessionArg, deviceArg,
	), s.load)

	s.add(mcp.NewTool("get",
		mcp.WithDescription(s.getDesc()), noExtra, hints(true, false, true, false),
		mcp.WithTitleAnnotation("What a browser tab is playing"),
		sessionArg, deviceArg,
	), s.get)

	s.add(mcp.NewTool("share",
		mcp.WithDescription(s.shareDesc()), noExtra, hints(false, false, true, false), // signed in, it stores the program (idempotent, additive)
		mcp.WithTitleAnnotation("Make share links"),
		mcp.WithString("text", mcp.Required(), mcp.MaxLength(maxProg), mcp.Description("The program text. It must pass check.")),
		mcp.WithString("license", mcp.MaxLength(40), mcp.Description("Rights kept with the stored program, an SPDX-style id (default CC0-1.0). Only used when the program is stored (signed in).")),
		mcp.WithString("forked_from", mcp.MaxLength(100), mcp.Pattern(`^z[1-9A-HJ-NP-Za-km-z]{20,100}$`), mcp.Description("CID of the program this one was forked from. Stored with the rights.")),
		mcp.WithArray("credits", mcp.WithStringItems(mcp.MaxLength(api.MaxCreditChars)), mcp.MaxItems(api.MaxCredits), mcp.Description("Who is credited, one short line each. Stored with the rights.")),
		mcp.WithString("name", mcp.MaxLength(80), mcp.Description("A name for the program (else its `#! name:` line).")),
	), s.share)

	s.add(mcp.NewTool("open",
		mcp.WithDescription(s.openDesc()), noExtra, hints(true, false, true, false),
		mcp.WithTitleAnnotation("Open a share link"),
		mcp.WithString("url", mcp.Required(), mcp.MaxLength(32768), mcp.Description("A share link (self-sealing #<CID>.<packed>, or a short <site>/p/<CID> or /c/<CID> link), a #fragment, <CID>.<packed>, or a bare CID.")),
	), s.open)

	s.add(mcp.NewTool("render",
		mcp.WithDescription(s.renderDesc()), noExtra,
		mcp.WithTitleAnnotation("Render a program to streaming audio"), hints(false, false, true, false), // stores a CC0 program, content-addressed
		mcp.WithString("text", mcp.MaxLength(maxProg), mcp.Description("The program text. It must pass check; it is stored publicly (CC0-1.0).")),
		mcp.WithString("cid", mcp.MaxLength(100), mcp.Pattern(`^z[1-9A-HJ-NP-Za-km-z]{20,100}$`), mcp.Description("CID of a program already stored (for instance the cid compose returned).")),
		mcp.WithString("example", mcp.MaxLength(64), mcp.Pattern(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`), mcp.Description("Name of an example, from list_examples.")),
		mcp.WithString("format", mcp.Enum("opus", "wav"), mcp.DefaultString("opus"), mcp.Description("opus (Ogg Opus, smaller, for download or <audio>) or wav (16-bit stereo, plays chunk by chunk in a web page).")),
	), s.renderTool)

	s.add(mcp.NewTool("record",
		mcp.WithDescription(s.recordDesc()), noExtra,
		mcp.WithTitleAnnotation("Set up a demo recording"), hints(false, false, true, false), // stores a CC0 program, content-addressed
		mcp.WithString("text", mcp.MaxLength(maxProg), mcp.Description("The program text. It must pass check; it is stored publicly (CC0-1.0).")),
		mcp.WithString("cid", mcp.MaxLength(100), mcp.Pattern(`^z[1-9A-HJ-NP-Za-km-z]{20,100}$`), mcp.Description("CID of a program already stored (for instance the cid compose returned).")),
		mcp.WithString("example", mcp.MaxLength(64), mcp.Pattern(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`), mcp.Description("Name of an example, from list_examples.")),
	), s.recordTool)

	s.add(mcp.NewTool("list_examples",
		mcp.WithDescription(s.examplesDesc()), noExtra, hints(true, false, true, false),
		mcp.WithTitleAnnotation("The example programs"),
		mcp.WithString("name", mcp.MaxLength(64), mcp.Pattern(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`), mcp.Description("Optional: also return this example's full text.")),
	), s.listExamples)

	s.add(mcp.NewTool("instruments",
		mcp.WithDescription(s.instrumentsDesc()), noExtra, hints(true, false, true, false),
		mcp.WithTitleAnnotation("Voices, kits and palettes"),
	), s.instruments)

	s.add(mcp.NewTool("stop",
		mcp.WithDescription(s.stopDesc()), noExtra,
		mcp.WithTitleAnnotation("Stop a browser tab"), hints(false, false, true, false),
		sessionArg, deviceArg,
	), s.stop)

	s.add(mcp.NewTool("devices",
		mcp.WithDescription(s.devicesDesc()), noExtra,
		mcp.WithTitleAnnotation("Your paired phones"), hints(true, false, true, false),
	), s.devices)
}

// ---------- compose ----------

func (s *Server) compose(ctx context.Context, c caller, a args) (any, *api.Error) {
	if e := a.only("prompt", "genre", "bpm", "key", "length", "base_cid"); e != nil {
		return nil, e
	}
	// A prompt is counted in characters, not bytes; allow four bytes a character on the wire.
	prompt, ok, e := a.str("prompt", 4*s.opt.MaxPromptChars)
	if e != nil {
		if e.Code == api.CodeTooLarge {
			e = api.Errf(413, api.CodePromptTooLong, "the prompt is too long; the limit is %d characters. Say less: genre, mood, tempo, structure.", s.opt.MaxPromptChars)
		}
		return nil, e
	}
	prompt = strings.TrimSpace(prompt)
	if !ok || prompt == "" {
		return nil, api.Errf(400, api.CodeBadRequest, "argument \"prompt\" is required: what to compose, in plain words")
	}
	if n := utf8.RuneCountInString(prompt); n > s.opt.MaxPromptChars {
		return nil, api.Errf(413, api.CodePromptTooLong, "the prompt is %d characters; the limit is %d. Say less: genre, mood, tempo, structure.", n, s.opt.MaxPromptChars)
	}
	req := api.ComposeRequest{Prompt: prompt}
	if req.Genre, _, e = a.str("genre", 160); e != nil {
		return nil, e
	}
	if utf8.RuneCountInString(req.Genre) > 40 {
		return nil, api.Errf(400, api.CodeBadRequest, "argument \"genre\" is at most 40 characters")
	}
	if v, ok, e := a.num("bpm", 40, 300); e != nil {
		return nil, e
	} else if ok {
		req.BPM = v
	}
	if req.Key, _, e = a.str("key", 24); e != nil {
		return nil, e
	}
	if req.Key != "" && !reKey.MatchString(req.Key) {
		return nil, api.Errf(400, api.CodeBadRequest, "argument \"key\" is a key as the language writes it: am, c, f#m, d:dorian")
	}
	if req.Length, _, e = a.str("length", 8); e != nil {
		return nil, e
	}
	if req.Length != "" && !reLength.MatchString(req.Length) {
		return nil, api.Errf(400, api.CodeBadRequest, "argument \"length\" is short, medium, long or a number of bars")
	}
	if req.BaseCID, _, e = a.str("base_cid", 100); e != nil {
		return nil, e
	}
	if req.BaseCID != "" && !reCID.MatchString(req.BaseCID) {
		return nil, api.Errf(400, api.CodeBadRequest, "argument \"base_cid\" is not a CID (it starts with z)")
	}

	ctx, cancel := context.WithTimeout(ctx, s.opt.ComposeTimeout)
	defer cancel()
	res, err := s.b.Compose(ctx, c.user, c.ip, req)
	if err != nil {
		return nil, fail(err)
	}
	if res == nil {
		return nil, api.Errf(500, "internal", "compose answered nothing")
	}
	type attempt struct {
		N         int  `json:"n"`
		OK        bool `json:"ok"`
		Errors    int  `json:"errors"`
		TokensIn  int  `json:"tokens_in"`
		TokensOut int  `json:"tokens_out"`
	}
	out := struct {
		Program    string         `json:"program"`
		CID        string         `json:"cid"`
		Check      map[string]any `json:"check"`
		Attempts   []attempt      `json:"attempts"`
		Model      string         `json:"model"`
		ForkedFrom string         `json:"forkedFrom"`
		License    string         `json:"license"`
		ComposedBy string         `json:"composedBy"`
		Header     []string       `json:"header,omitempty"`
		RenderURL  string         `json:"render_url"`
		ShareURL   string         `json:"share_url"`
		CostUSD    float64        `json:"cost_usd"`
		Usage      api.Usage      `json:"usage"`
		Next       string         `json:"next"`
	}{
		Program: res.Program, CID: res.CID, Check: trimReport(res.Check),
		Model: res.Model, ForkedFrom: res.ForkedFrom, License: res.License, ComposedBy: res.ComposedBy, Header: res.Header,
		RenderURL: s.abs(res.RenderURL), ShareURL: s.abs(res.ShareURL), CostUSD: res.CostUSD, Usage: res.Usage,
		Next: "The program is stored (CC0-1.0). Listen: open render_url, or call render with this cid, or eval / load it into a browser tab. Edit it: call compose again with base_cid.",
	}
	for _, at := range res.Attempts {
		out.Attempts = append(out.Attempts, attempt{at.N, at.OK, at.Errors, at.TokensIn, at.TokensOut})
	}
	return out, nil
}

// trimReport is a CheckReport as a map without the fields that repeat the program text.
func trimReport(r *api.CheckReport) map[string]any {
	if r == nil {
		return nil
	}
	b, _ := json.Marshal(r)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	for _, k := range []string{"canonical", "nets", "song_nets", "lineage"} {
		delete(m, k)
	}
	return m
}

// ---------- check, fmt ----------

func (s *Server) check(ctx context.Context, c caller, a args) (any, *api.Error) {
	if e := a.only("text", "same_as"); e != nil {
		return nil, e
	}
	text, e := s.program(a, "text")
	if e != nil {
		return nil, e
	}
	other, hasOther, e := s.sameAsArg(a)
	if e != nil {
		return nil, e
	}
	rep, e := s.checkProgram(ctx, c, text)
	if e != nil {
		return nil, e
	}
	if !hasOther {
		return rep, nil // ok:false is an answer, not a tool error: the diagnostics are the product
	}
	cmp, e := s.sameAs(ctx, c, text, other)
	if e != nil {
		return nil, e
	}
	return checkWithSameAs{CheckReport: rep, SameAs: cmp}, nil
}

// checkWithSameAs is check's answer with a same_as argument: the report, plus the comparison.
type checkWithSameAs struct {
	*api.CheckReport
	SameAs json.RawMessage `json:"same_as"`
}

// sameAsArg reads check's optional same_as: a CID (or a CID-only short link) of a program stored here or an
// example, else the text of a program.
func (s *Server) sameAsArg(a args) (text string, present bool, e *api.Error) {
	v, ok, e := a.str("same_as", s.opt.MaxProgramBytes)
	if e != nil || !ok {
		return "", false, e
	}
	if strings.TrimSpace(v) == "" {
		return "", false, api.Errf(400, api.CodeBadRequest, "argument \"same_as\" is empty: give a CID or a program's text")
	}
	if cid, isCID := bareCID(v); isCID {
		t, _, found := s.storedText(cid)
		if !found {
			return "", false, api.Errf(404, api.CodeNotFound, "same_as: no program with CID %s is stored here or among the examples; pass its text instead", cid)
		}
		return t, true, nil
	}
	return v, true, nil
}

// sameAs runs the comparison (a second checker call, charged as one).
func (s *Server) sameAs(ctx context.Context, c caller, a, b string) (json.RawMessage, *api.Error) {
	sa, ok := s.b.(api.SameAser)
	if !ok {
		return nil, api.Errf(503, api.CodeNotConfigured, "this server cannot compare programs (same_as needs the btwd checker)")
	}
	if e := s.limitCPU(c); e != nil {
		return nil, e
	}
	out, err := sa.SameAs(ctx, a, b)
	if err != nil {
		return nil, fail(err)
	}
	return out, nil
}

func (s *Server) fmtTool(ctx context.Context, c caller, a args) (any, *api.Error) {
	if e := a.only("text"); e != nil {
		return nil, e
	}
	text, e := s.program(a, "text")
	if e != nil {
		return nil, e
	}
	if e := s.limitCPU(c); e != nil {
		return nil, e
	}
	rep, err := s.b.Fmt(ctx, text)
	if err != nil {
		return nil, fail(err)
	}
	return rep, nil
}

// ---------- eval, load, stop, get ----------

func (s *Server) eval(ctx context.Context, c caller, a args) (any, *api.Error) {
	if e := a.only("text", "play", "session", "device"); e != nil {
		return nil, e
	}
	text, e := s.program(a, "text")
	if e != nil {
		return nil, e
	}
	play, e := a.boolean("play")
	if e != nil {
		return nil, e
	}
	session, e := s.target(c, a)
	if e != nil {
		return nil, e
	}
	rep, e := s.checkProgram(ctx, c, text)
	if e != nil {
		return nil, e
	}
	if !rep.OK {
		return nil, needsFixing(rep, "nothing was sent to the browser")
	}
	if e := private(rep, "it cannot be played in the browser"); e != nil {
		return nil, e
	}
	n, e := s.push(c, session, api.SessionEvent{Type: "eval", Text: text, CID: rep.CID, Play: play})
	if e != nil {
		return nil, e
	}
	return map[string]any{
		"sent": true, "delivered": n, "cid": rep.CID, "play": play, "warnings": rep.Warnings,
		"warning_diagnostics": warningsOf(rep),
		"note":                "Sent. The tab evaluates it like Cmd+Enter: the change lands on the next bar. Call get to see what is playing and any diagnostics the page reports.",
	}, nil
}

func warningsOf(rep *api.CheckReport) []api.Diagnostic {
	var w []api.Diagnostic
	for _, d := range rep.Diagnostics {
		if d.Severity == "warning" {
			w = append(w, d)
		}
	}
	return w
}

func (s *Server) load(ctx context.Context, c caller, a args) (any, *api.Error) {
	if e := a.only("cid", "example", "url", "play", "session", "device"); e != nil {
		return nil, e
	}
	cid, hasCID, e := a.str("cid", 100)
	if e != nil {
		return nil, e
	}
	example, hasEx, e := a.str("example", 64)
	if e != nil {
		return nil, e
	}
	url, hasURL, e := a.str("url", 32768)
	if e != nil {
		return nil, e
	}
	if hasURL {
		if sc, ok := bareCID(url); ok && !hasCID { // a CID-only link names a stored program: the cid path loads it
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
		return nil, api.Errf(400, api.CodeBadRequest, "give exactly one of cid, example, url")
	}
	play, e := a.boolean("play")
	if e != nil {
		return nil, e
	}
	session, e := s.target(c, a)
	if e != nil {
		return nil, e
	}

	var text, source string
	switch {
	case cid != "":
		if !reCID.MatchString(cid) {
			return nil, api.Errf(400, api.CodeBadRequest, "argument \"cid\" is not a CID (it starts with z)")
		}
		t, src, ok := s.storedText(cid)
		if !ok {
			return nil, api.Errf(404, api.CodeNotFound, "no stored program has CID %s. Programs are stored by compose and render; for any other program pass its text to eval, or a share link as url.", cid)
		}
		text, source = t, src
	case example != "":
		if !reName.MatchString(example) {
			return nil, api.Errf(400, api.CodeBadRequest, "argument \"example\" is an example name, as list_examples gives")
		}
		t, ok := s.b.Example(example)
		if !ok {
			return nil, api.Errf(404, api.CodeNotFound, "no example is named %q; call list_examples", example)
		}
		cid, _ = s.exampleCID(example)
		text, source = t, "example"
	default:
		if e := s.limitCPU(c); e != nil {
			return nil, e
		}
		rep, err := s.b.Open(ctx, url)
		if err != nil {
			return nil, fail(err)
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
			return nil, api.Errf(422, code, "%s", msg)
		}
		cid, text, source = rep.CID, rep.Canonical, "link"
	}
	delivered, e := s.push(c, session, api.SessionEvent{Type: "load", Text: text, CID: cid, Play: play})
	if e != nil {
		return nil, e
	}
	return map[string]any{
		"sent": true, "delivered": delivered, "cid": cid, "source": source, "play": play,
		"note": "Loaded into the tab. Call get to see what is playing.",
	}, nil
}

func (s *Server) stop(_ context.Context, c caller, a args) (any, *api.Error) {
	if e := a.only("session", "device"); e != nil {
		return nil, e
	}
	session, e := s.target(c, a)
	if e != nil {
		return nil, e
	}
	n, e := s.push(c, session, api.SessionEvent{Type: "stop"})
	if e != nil {
		return nil, e
	}
	return map[string]any{"sent": true, "delivered": n, "note": "Stopped: held filters and mutes are put back."}, nil
}

func (s *Server) get(ctx context.Context, c caller, a args) (any, *api.Error) {
	if e := a.only("session", "device"); e != nil {
		return nil, e
	}
	session, e := s.target(c, a)
	if e != nil {
		return nil, e
	}
	connected := 0
	if session == "" {
		list := s.b.Sessions(c.user)
		if len(list) == 0 {
			return nil, s.noSession("")
		}
		session = latestSession(list)
		connected = len(list)
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	st, err := s.b.State(ctx, c.user, session)
	if err != nil {
		e := fail(err)
		if e.Code == api.CodeNoSession {
			if connected > 0 { // we picked the session: the hub's own words say what is wrong with it
				return nil, api.Errf(409, api.CodeNoSession, "%s If the tab was closed, open %s again signed in as this account, or press MCP in its top bar and pass the session id it shows as `session`.", e.Message, s.public)
			}
			return nil, s.noSession(session)
		}
		return nil, e
	}
	if st == nil {
		return nil, s.noSession(session)
	}
	var jsonld, ctxURL string
	if st.CID != "" {
		jsonld, ctxURL = s.public+"/c/"+st.CID+".jsonld", ld.ContextURL(s.public)
	}
	return struct {
		*api.SessionState
		JSONLD    string `json:"jsonld_url,omitempty"` // the program as linked data (only a stored program has one)
		Context   string `json:"context,omitempty"`    // the @context URL that document names
		Connected int    `json:"sessions_connected,omitempty"`
	}{st, jsonld, ctxURL, connected}, nil
}

// devices lists the caller's paired phones.
func (s *Server) devices(_ context.Context, c caller, a args) (any, *api.Error) {
	if e := a.only(); e != nil {
		return nil, e
	}
	list := []api.DeviceInfo{}
	if dh, ok := s.b.(api.Devices); ok {
		if l := dh.Devices(c.user); l != nil {
			list = l
		}
	}
	n := 0
	for _, d := range list {
		if d.Connected {
			n++
		}
	}
	note := "Pass a phone's id as device to eval, load, get or stop to drive that phone alone."
	if len(list) == 0 {
		note = fmt.Sprintf("No phone is paired with this account. Open %s signed in, press Mobile, and scan the code with djrust's btw pairing.", s.public)
	} else if n == 0 {
		note = "No paired phone is connected now: open djrust on the phone (it connects on its own). " + note
	}
	return map[string]any{"devices": list, "connected": n, "note": note}, nil
}

// latestSession picks the session seen most recently.
func latestSession(list []api.SessionInfo) string {
	best, bestT := list[0].ID, time.Time{}
	for i, si := range list {
		t, err := time.Parse(time.RFC3339Nano, si.LastSeen)
		if err != nil {
			t, _ = time.Parse(time.RFC3339, si.LastSeen)
		}
		if i == 0 || t.After(bestT) {
			best, bestT = si.ID, t
		}
	}
	return best
}

// ---------- share, open ----------

// siteLinks makes the engine's share links this site's own, as the web's share does (server.fixShare): the
// engine builds them on its default origin, so url = <public>/#<CID>.<packed> and social_url =
// <public>/c/<CID>.<packed> (the sealed part, without ~notes). Links with no fragment are left as they are.
func (s *Server) siteLinks(url, social string) (string, string) {
	i := strings.Index(url, "#")
	if i < 0 || s.public == "" {
		return url, social
	}
	frag := url[i+1:]
	sealed, _, _ := strings.Cut(frag, "~")
	return s.public + "/#" + frag, s.public + "/c/" + sealed
}

func (s *Server) share(ctx context.Context, c caller, a args) (any, *api.Error) {
	if e := a.only("text", "license", "forked_from", "credits", "name"); e != nil {
		return nil, e
	}
	text, e := s.program(a, "text")
	if e != nil {
		return nil, e
	}
	meta, e := s.rights(a)
	if e != nil {
		return nil, e
	}
	if e := s.limitCPU(c); e != nil {
		return nil, e
	}
	// Check first: it is what says why a program cannot be shared, and "a private program is never
	// shared" must not rest on the shell-out behind Share alone.
	chk, err := s.b.Check(ctx, text)
	if err != nil {
		return nil, fail(err)
	}
	if chk == nil || !chk.OK {
		if chk == nil {
			return nil, api.Errf(500, "internal", "the checker answered nothing")
		}
		return nil, needsFixing(chk, "it cannot be shared")
	}
	if e := private(chk, "it cannot be shared"); e != nil {
		return nil, e
	}
	if api.DeclaresNotPublic(text) {
		return nil, api.Errf(422, api.CodeRestricted, "the program says `#! visibility:` something but public, so it cannot be shared or stored: private programs never leave the machine they were written on.")
	}
	rep, err := s.b.Share(ctx, text)
	if err != nil {
		return nil, fail(err)
	}
	if rep == nil || !rep.OK {
		return nil, api.Errf(422, api.CodeBadRequest, "the program cannot be shared")
	}
	url, social := s.siteLinks(rep.URL, rep.SocialURL)
	out := map[string]any{
		"ok": true, "url": url, "social_url": social, "beats_url": rep.BeatsURL, "cid": rep.CID, "chars": rep.Chars,
		"canonical": rep.Canonical, "warnings": rep.Warnings,
		"jsonld_url": social + ".jsonld", "context": ld.ContextURL(s.public),
		"note": "jsonld_url is the program as linked data (its @context is the context URL). url is the self-sealing link (the program is in the link; opening it checks the CID). Post social_url where a link preview is wanted.",
	}
	// The CID-only forms are for a signed-in caller: the program is kept on the site (public, with its rights) and
	// the link carries only the CID. An anonymous caller gets the self-sealing links alone.
	if c.user == nil {
		out["short_url"], out["short_social_url"], out["short_beats_url"] = nil, nil, nil
		out["stored"] = false
		out["short_note"] = "No short (CID-only) link: that needs a signed-in call, because the program is stored on the site. " + s.authHelp()
		return out, nil
	}
	ok, retry := s.shareLim.allow(c.key)
	if ok {
		ok, retry = s.ipCeiling(s.shareIP, c)
	}
	if !ok {
		e := api.Errf(429, api.CodeRateLimited, "too many programs stored by share; the self-sealing link above still works")
		e.RetryAfter = retry
		return nil, e
	}
	prog, _, err := s.b.Put(ctx, rep.Canonical, meta)
	if err != nil || prog == nil || prog.CID != rep.CID {
		msg := "the program could not be stored"
		if err != nil {
			msg = fail(err).Message
		}
		out["short_url"], out["short_social_url"], out["short_beats_url"] = nil, nil, nil
		out["stored"] = false
		out["short_note"] = msg + ". The self-sealing link above still works."
		return out, nil
	}
	l := api.ShortLinksOf(s.public, prog.CID)
	out["short_url"], out["short_social_url"], out["short_beats_url"] = l.URL, l.SocialURL, l.BeatsURL
	out["stored"] = true
	out["meta"] = prog.Meta
	out["fetch_url"] = s.public + "/api/programs/" + prog.CID
	out["note"] = "url is the self-sealing link (the program is in the link; opening it checks the CID). short_url is the CID-only link: the program is stored on the site (public, " + prog.Meta.License + "; the first share's rights stay), and opening it fetches the text and checks it against the CID. Post social_url or short_social_url where a link preview is wanted."
	return out, nil
}

// rights reads share's optional rights arguments into the Meta the store keeps.
func (s *Server) rights(a args) (api.Meta, *api.Error) {
	m := api.Meta{License: "CC0-1.0", Visibility: "public", Source: "share"}
	if v, ok, e := a.str("license", 40); e != nil {
		return m, e
	} else if ok && strings.TrimSpace(v) != "" {
		if !reLicense.MatchString(strings.TrimSpace(v)) {
			return m, api.Errf(400, api.CodeBadRequest, "argument \"license\" is a short SPDX-style id such as CC0-1.0 or CC-BY-4.0")
		}
		m.License = strings.TrimSpace(v)
	}
	if v, ok, e := a.str("forked_from", 100); e != nil {
		return m, e
	} else if ok && strings.TrimSpace(v) != "" {
		if !reCID.MatchString(strings.TrimSpace(v)) {
			return m, api.Errf(400, api.CodeBadRequest, "argument \"forked_from\" is a CID (it starts with z)")
		}
		m.ForkedFrom = strings.TrimSpace(v)
	}
	if v, ok, e := a.str("name", 80); e != nil {
		return m, e
	} else if ok {
		if n, good := oneLine(v, 80); good {
			m.Name = n
		} else if strings.TrimSpace(v) != "" {
			return m, api.Errf(400, api.CodeBadRequest, "argument \"name\" is one line of at most 80 characters")
		}
	}
	if raw, ok := a["credits"]; ok && raw != nil {
		list, isList := raw.([]any)
		if !isList || len(list) > api.MaxCredits {
			return m, api.Errf(400, api.CodeBadRequest, "argument \"credits\" is a list of at most %d short lines", api.MaxCredits)
		}
		for _, it := range list {
			str, isStr := it.(string)
			line, good := oneLine(str, api.MaxCreditChars)
			if !isStr || !good || line == "" {
				return m, api.Errf(400, api.CodeBadRequest, "each credit is one line of 1 to %d characters", api.MaxCreditChars)
			}
			m.Credits = append(m.Credits, line)
		}
	}
	return m, nil
}

var reLicense = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.+-]{0,39}$`)

// oneLine trims v and reports whether it is a single line of at most max characters with no control characters.
func oneLine(v string, max int) (string, bool) {
	v = strings.TrimSpace(v)
	if !utf8.ValidString(v) || utf8.RuneCountInString(v) > max {
		return "", false
	}
	for _, r := range v {
		if r < 0x20 || r == 0x7f {
			return "", false
		}
	}
	return v, true
}

func (s *Server) open(ctx context.Context, c caller, a args) (any, *api.Error) {
	if e := a.only("url"); e != nil {
		return nil, e
	}
	u, ok, e := a.str("url", 32768)
	if e != nil {
		return nil, e
	}
	u = strings.TrimSpace(u)
	if !ok || u == "" {
		return nil, api.Errf(400, api.CodeBadRequest, "argument \"url\" is required: a share link, a #fragment or a CID")
	}
	if cid, ok := bareCID(u); ok { // a bare CID or a CID-only short link: only the stores can answer
		return s.openStored(ctx, c, cid)
	}
	if e := s.limitCPU(c); e != nil {
		return nil, e
	}
	rep, err := s.b.Open(ctx, u)
	if err != nil {
		return nil, fail(err)
	}
	if rep == nil || !rep.OK {
		msg := "the link did not open"
		code := api.CodeBadRequest
		if rep != nil {
			if rep.Error != "" {
				msg = rep.Error
			}
			if rep.Canonical != "" && !rep.Verified {
				code = api.CodeCIDMismatch
			}
		}
		return nil, api.Errf(422, code, "%s", msg)
	}
	return rep, nil
}

// openStored opens a CID-only link: the text the store keeps under the CID, recompiled by the checker, its CID
// recomputed and compared. A mismatch is refused (cid_mismatch), like a self-sealing link whose text is not its CID's.
func (s *Server) openStored(ctx context.Context, c caller, cid string) (any, *api.Error) {
	text, src, meta, ok := s.storedProgram(cid)
	if !ok {
		return nil, api.Errf(404, api.CodeNotFound, "no program %s is stored here. A CID alone names a program but does not carry it: open the self-sealing link (#<CID>.<packed>) instead, or share the program signed in to store it.", cid)
	}
	if e := s.limitCPU(c); e != nil {
		return nil, e
	}
	chk, err := s.b.Check(ctx, text)
	if err != nil {
		return nil, fail(err)
	}
	if chk == nil || !chk.OK || chk.CID == "" {
		return nil, api.Errf(422, api.CodeBadRequest, "the text stored under %s does not check; it is not loaded", cid)
	}
	if chk.CID != cid {
		return nil, api.Errf(422, api.CodeCIDMismatch, "refused: the text stored under %s is program %s. Do not trust or play it.", cid, chk.CID)
	}
	return map[string]any{
		"ok": true, "cid": cid, "canonical": chk.Canonical, "verified": true, "source": src, "meta": meta,
		"warnings": warningTexts(chk),
	}, nil
}

func warningTexts(rep *api.CheckReport) []string {
	out := []string{}
	for _, d := range warningsOf(rep) {
		out = append(out, fmt.Sprintf("%d:%d %s", d.Line, d.Col, d.Message))
	}
	return out
}

// ---------- render ----------

func (s *Server) renderTool(ctx context.Context, c caller, a args) (any, *api.Error) {
	if e := a.only("text", "cid", "example", "format"); e != nil {
		return nil, e
	}
	text, hasText, e := a.str("text", s.opt.MaxProgramBytes)
	if e != nil {
		return nil, e
	}
	cid, hasCID, e := a.str("cid", 100)
	if e != nil {
		return nil, e
	}
	example, hasEx, e := a.str("example", 64)
	if e != nil {
		return nil, e
	}
	n := 0
	for _, b := range []bool{hasText && strings.TrimSpace(text) != "", hasCID && cid != "", hasEx && example != ""} {
		if b {
			n++
		}
	}
	if n != 1 {
		return nil, api.Errf(400, api.CodeBadRequest, "give exactly one of text, cid, example")
	}
	format, hasFmt, e := a.str("format", 8)
	if e != nil {
		return nil, e
	}
	if !hasFmt || format == "" {
		format = "opus"
	}
	if format != "opus" && format != "wav" {
		return nil, api.Errf(400, api.CodeBadRequest, "argument \"format\" is opus or wav")
	}

	var seconds *float64
	ends := true
	switch {
	case cid != "":
		if !reCID.MatchString(cid) {
			return nil, api.Errf(400, api.CodeBadRequest, "argument \"cid\" is not a CID (it starts with z)")
		}
		if _, _, ok := s.storedText(cid); !ok {
			return nil, api.Errf(404, api.CodeNotFound, "no stored program has CID %s. Pass its text as `text` and render stores it.", cid)
		}
	default:
		source := "put"
		if example != "" {
			if !reName.MatchString(example) {
				return nil, api.Errf(400, api.CodeBadRequest, "argument \"example\" is an example name, as list_examples gives")
			}
			t, ok := s.b.Example(example)
			if !ok {
				return nil, api.Errf(404, api.CodeNotFound, "no example is named %q; call list_examples", example)
			}
			text, source = t, "example"
		}
		rep, e := s.checkProgram(ctx, c, text)
		if e != nil {
			return nil, e
		}
		if !rep.OK {
			return nil, needsFixing(rep, "it cannot be rendered")
		}
		if e := private(rep, "it cannot be rendered or stored"); e != nil {
			return nil, e
		}
		// Only a program that is about to be stored counts: Put has no caller to limit by.
		ok, retry := s.render.allow(c.key)
		if ok {
			ok, retry = s.ipCeiling(s.renderIP, c)
		}
		if !ok {
			e := api.Errf(429, api.CodeRateLimited, "too many programs submitted for rendering")
			e.RetryAfter = retry
			return nil, e
		}
		prog, _, err := s.b.Put(ctx, text, api.Meta{License: "CC0-1.0", Visibility: "public", Source: source})
		if err != nil {
			return nil, fail(err)
		}
		if prog == nil || prog.CID == "" {
			return nil, api.Errf(500, "internal", "the store answered nothing")
		}
		cid = prog.CID
		seconds, ends = rep.Seconds, rep.Ends
	}

	stream, status, secs := s.b.RenderInfo(cid, format)
	out := map[string]any{
		"cid": cid, "format": format, "stream_url": s.abs(stream), "status_url": s.abs(status), "license": "CC0-1.0",
	}
	switch {
	case secs > 0:
		out["seconds"] = secs
	case seconds != nil:
		out["seconds"] = *seconds
	default:
		out["seconds"] = nil
	}
	note := "Open stream_url to listen: the audio streams as it renders (first sound within about a second). status_url says how far the render is."
	if !ends {
		note += " This program does not end by itself (it loops, or has no timeline), so the render is cut at the server's bar limit; add `end at bar N` for a length of your own."
	}
	out["note"] = note + " The offline render plays the notes and sounds, not control lines (filters, reverb, do ...), so it can sound plainer than the browser."
	return out, nil
}

// ---------- record ----------

// recordTool stores the program like render does and answers where to record it: the page in record mode, the
// same page on a fake clock, the audio, and the deterministic recorder's command. It captures nothing itself.
func (s *Server) recordTool(ctx context.Context, c caller, a args) (any, *api.Error) {
	if e := a.only("text", "cid", "example"); e != nil {
		return nil, e
	}
	ra := args{"format": "wav"}
	for _, k := range []string{"text", "cid", "example"} {
		if v, ok := a[k]; ok {
			ra[k] = v
		}
	}
	r, e := s.renderTool(ctx, c, ra)
	if e != nil {
		return nil, e
	}
	m, _ := r.(map[string]any)
	cid, _ := m["cid"].(string)
	if cid == "" {
		return nil, api.Errf(500, "internal", "no CID to record")
	}
	out := map[string]any{
		"cid": cid, "seconds": m["seconds"], "license": "CC0-1.0",
		"record_url":              s.public + "/?record=1&cid=" + cid,
		"record_url_manual_clock": s.public + "/?record=1&clock=manual&cid=" + cid,
		"audio_url":               m["stream_url"],
		"recipe": map[string]any{
			"deterministic": "node btwsite/tools/record-demo.mjs --server " + s.public + " --btwd <path to btwd> --cid " + cid + " --out <dir>",
			"needs":         "Node 22+, ffmpeg and Google Chrome on your machine; the script steps the page's fake clock frame by frame, renders the audio with btwd and muxes them",
			"outputs":       []string{"btw-demo.mp4 (45-60 s, H.264 CRF 20, AAC 192k, 1920x1080, faststart)", "btw-hero-loop.mp4 and .webm (10-15 s, silent, the drop)", "btw-poster.png"},
		},
		"note": "record_url_manual_clock has no audio and no wall clock: it only moves when window.__btw.setTime is called. audio_url is the offline render of the same program (notes and sounds, not control lines such as filter sweeps).",
	}
	return out, nil
}

// ---------- list_examples, instruments ----------

func (s *Server) listExamples(_ context.Context, _ caller, a args) (any, *api.Error) {
	if e := a.only("name"); e != nil {
		return nil, e
	}
	name, has, e := a.str("name", 64)
	if e != nil {
		return nil, e
	}
	type item struct {
		api.Example
		URL string `json:"url"`
	}
	var items []item
	for _, ex := range s.b.Examples() {
		items = append(items, item{ex, s.public + "/examples/" + ex.Name + ".btw"})
	}
	out := map[string]any{"examples": items, "license": "CC0-1.0"}
	if has && name != "" {
		if !reName.MatchString(name) {
			return nil, api.Errf(400, api.CodeBadRequest, "argument \"name\" is an example name")
		}
		t, ok := s.b.Example(name)
		if !ok {
			return nil, api.Errf(404, api.CodeNotFound, "no example is named %q; the names are in the list", name)
		}
		out["name"], out["text"] = name, t
	}
	return out, nil
}

type instrumentsCache struct {
	mu  sync.Mutex
	at  time.Time
	raw json.RawMessage
}

func (s *Server) instruments(ctx context.Context, _ caller, a args) (any, *api.Error) {
	if e := a.only(); e != nil {
		return nil, e
	}
	s.inst.mu.Lock()
	defer s.inst.mu.Unlock()
	if s.inst.raw != nil && s.opt.Now().Sub(s.inst.at) < 5*time.Minute {
		return s.inst.raw, nil
	}
	raw, err := s.b.Instruments(ctx)
	if err != nil {
		return nil, fail(err)
	}
	s.inst.raw, s.inst.at = raw, s.opt.Now()
	return raw, nil
}

// compile-time check that the handler type fits mcp-go.
var _ server.ToolHandlerFunc = func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) { return nil, nil }

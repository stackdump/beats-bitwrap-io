// Package compose is "write me a btw program": a signed-in user's prompt goes to a text model (Gemini
// Flash), the answer goes through the checker, and while it has errors the diagnostics go back to the model
// to repair, a few rounds at most. What comes out is a checked program, stored content-addressed with its
// provenance, or a clean 422 with every attempt in it.
//
// Around that sit the things that keep it cheap and safe: validation, a kill switch, per-user and per-IP
// windows, a daily spend cap that is held in reserve before each model call and settled after it (package
// limits), and a log that never holds the key, a prompt or a program. See btwsite/DESIGN.md "Compose".
package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"beats-bitwrap-io/internal/btwsite/api"
	"beats-bitwrap-io/internal/btwsite/limits"
)

// Options is DESIGN.md "Package entry points", with MaxOutputTokens and Thinking added.
type Options struct {
	Checker api.Checker
	Store   api.ProgramStore
	// Examples and ExampleText are the public CC0 programs for prompts and base_cid lookups.
	Examples    func() []api.Example
	ExampleText func(name string) (string, bool)
	DataDir     string
	PublicURL   string

	Model    string // "" = DefaultModel; "fake" = the recorded-fixture model
	APIKey   string // GEMINI_API_KEY; never logged, never returned
	Endpoint string // "" = Google; tests point at an httptest server

	FakeModel Model // non-nil = used instead of Gemini, whatever Model says

	Limits limits.Config

	MaxPromptChars  int // runes; default 800
	MaxProgramBytes int // default 16384
	MaxRepair       int // repair rounds after the first attempt; default 3, negative = none

	MaxOutputTokens int    // per model call, thinking included; default DefaultMaxOutputTokens
	Thinking        string // MINIMAL | LOW | MEDIUM | HIGH; default LOW (BTW_THINKING)

	Now    func() time.Time // tests
	Logger *log.Logger      // nil = the standard logger
}

// Service implements api.Composer.
type Service struct {
	opt       Options
	lim       *limits.Limiter
	red       *Redactor
	model     Model  // nil = not configured
	modelName string // what is reported and recorded
	by        string // "composed-by" value
	think     string
	pc        promptCache
	now       func() time.Time

	capMu  sync.Mutex
	capDay string // the UTC day a request was last refused for the spend cap
}

var _ api.Composer = (*Service)(nil)

// New makes the service. A missing key is not an error: Compose then answers 503 not_configured and Status
// says what to set.
func New(o Options) (*Service, error) {
	if o.Checker == nil {
		return nil, errors.New("compose: a Checker is required")
	}
	if o.MaxPromptChars <= 0 {
		o.MaxPromptChars = 800
	}
	if o.MaxProgramBytes <= 0 {
		o.MaxProgramBytes = 16384
	}
	if o.MaxRepair == 0 {
		o.MaxRepair = 3
	}
	if o.MaxRepair < 0 {
		o.MaxRepair = 0
	}
	if o.MaxOutputTokens <= 0 {
		o.MaxOutputTokens = DefaultMaxOutputTokens
	}
	th, err := NormalizeThinking(o.Thinking)
	if err != nil {
		return nil, fmt.Errorf("compose: %w", err)
	}
	o.Thinking = th
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Limits.DataDir == "" {
		o.Limits.DataDir = o.DataDir
	}
	lim, err := limits.New(o.Limits, o.Now)
	if err != nil {
		return nil, err
	}
	s := &Service{opt: o, lim: lim, red: NewRedactor(o.APIKey), think: th, now: o.Now}

	name := strings.TrimSpace(o.Model)
	switch {
	case o.FakeModel != nil:
		s.model = o.FakeModel
		if name == "" {
			name = "fake"
		}
	case strings.EqualFold(name, "fake"):
		fm, err := DefaultFakeModel()
		if err != nil {
			return nil, err
		}
		s.model, name = fm, "fake"
	case strings.TrimSpace(o.APIKey) != "":
		g, err := NewGemini(GeminiOptions{APIKey: o.APIKey, Model: name, Endpoint: o.Endpoint,
			MaxOutputTokens: o.MaxOutputTokens, Thinking: th, Redactor: s.red})
		if err != nil {
			return nil, err
		}
		s.model, name = g, g.ModelName()
	default:
		if name == "" {
			name = DefaultModel
		}
	}
	s.modelName = name
	switch {
	case strings.HasPrefix(name, "gemini"):
		s.by = name
	case name == "fake":
		s.by = "fake-model"
	default:
		s.by = "gemini-" + name
	}
	return s, nil
}

// Close releases the log file.
func (s *Service) Close() error { return s.lim.Close() }

// Limiter is the limiter the service uses (the admin handler and tests read it).
func (s *Service) Limiter() *limits.Limiter { return s.lim }

func (s *Service) logf(format string, args ...any) {
	msg := s.red.Redact(fmt.Sprintf(format, args...))
	if s.opt.Logger != nil {
		s.opt.Logger.Print(msg)
		return
	}
	log.Print(msg)
}

// NotConfiguredHelp says exactly what to set.
const NotConfiguredHelp = "compose is not configured: set the GEMINI_API_KEY environment variable of the btw-bitwrap service and restart it (BTW_MODEL=fake runs the recorded fixtures instead of a real model)"

// Status is what /api/info reports about compose.
func (s *Service) Status() api.ComposeStatus {
	k := s.lim.Kill()
	st := s.lim.Stats()
	c := s.lim.Config()
	out := api.ComposeStatus{
		Enabled: !k.Disabled, Configured: s.model != nil, Model: s.modelName,
		UserHour: c.UserHour, UserDay: c.UserDay, IPDay: c.IPDay, SpentUSD: st.SpentUSD, DailyCapUSD: c.DailySpendUSD,
	}
	switch {
	case s.model == nil:
		out.Reason = NotConfiguredHelp
	case k.Disabled:
		out.Reason = killReason(k, s.opt.DataDir)
	case st.SpendClosed != "":
		out.Reason = st.SpendClosed
	case c.DailySpendUSD >= 0 && (st.SpentUSD >= c.DailySpendUSD || s.capHitToday()):
		out.Reason = fmt.Sprintf("today's budget of $%.2f is used up (or too little is left for another request); it resets at 00:00 UTC", c.DailySpendUSD)
	}
	return out
}

func (s *Service) capHitToday() bool {
	s.capMu.Lock()
	defer s.capMu.Unlock()
	return s.capDay == s.now().UTC().Format("2006-01-02")
}

// noteSpend remembers that a request was turned away by the cap, so Status can say why.
func (s *Service) noteSpend(err error) error {
	var ae *api.Error
	if errors.As(err, &ae) && ae.Code == api.CodeSpendCap {
		s.capMu.Lock()
		s.capDay = s.now().UTC().Format("2006-01-02")
		s.capMu.Unlock()
	}
	return err
}

func killReason(k limits.KillState, dataDir string) string {
	var parts []string
	if k.Env {
		parts = append(parts, limits.EnvEnabled+"=0 is set in the service's environment (unset it and restart)")
	}
	if k.File {
		where := limits.FlagFile
		if dataDir != "" {
			where = dataDir + "/" + limits.FlagFile
		}
		parts = append(parts, `the flag file `+where+` exists (delete it, or POST {"enabled":true} to /api/admin/compose)`)
	}
	return "compose is switched off: " + strings.Join(parts, "; ")
}

// ---------- validation ----------

var (
	genreRe  = regexp.MustCompile(`^[\p{L}\p{N} +&/'.\-]{1,40}$`)
	keyRe    = regexp.MustCompile(`(?i)^[a-g][#b]?(m|:[a-z]{3,12})?$`)
	lengthRe = regexp.MustCompile(`^[0-9]{1,3}$`)
)

// cleanRequest validates and normalises a request.
func (s *Service) cleanRequest(r api.ComposeRequest) (api.ComposeRequest, error) {
	r.Prompt = strings.TrimSpace(strings.ReplaceAll(r.Prompt, "\x00", ""))
	if r.Prompt == "" {
		return r, api.Errf(400, api.CodeBadRequest, "prompt is required: say what you want to hear")
	}
	if n := utf8.RuneCountInString(r.Prompt); n > s.opt.MaxPromptChars {
		return r, api.Errf(413, api.CodePromptTooLong, "the prompt is %d characters; the limit is %d", n, s.opt.MaxPromptChars)
	}
	if !utf8.ValidString(r.Prompt) {
		return r, api.Errf(400, api.CodeBadRequest, "the prompt is not valid UTF-8")
	}
	r.Genre = strings.TrimSpace(r.Genre)
	if r.Genre != "" && !genreRe.MatchString(r.Genre) {
		return r, api.Errf(400, api.CodeBadRequest, "genre must be a short plain word or two")
	}
	if r.BPM != 0 && !(r.BPM >= 40 && r.BPM <= 300) {
		return r, api.Errf(400, api.CodeBadRequest, "bpm must be between 40 and 300")
	}
	r.Key = strings.ToLower(strings.TrimSpace(r.Key))
	if r.Key != "" && !keyRe.MatchString(r.Key) {
		return r, api.Errf(400, api.CodeBadRequest, "key must look like am, c, f#m or d:dorian")
	}
	r.Length = strings.ToLower(strings.TrimSpace(r.Length))
	if r.Length != "" {
		switch {
		case lengthWords[r.Length] != "":
		case lengthRe.MatchString(r.Length):
			n, _ := strconv.Atoi(r.Length)
			if n < 4 || n > 256 {
				return r, api.Errf(400, api.CodeBadRequest, "length in bars must be between 4 and 256")
			}
		default:
			return r, api.Errf(400, api.CodeBadRequest, `length must be "short", "medium", "long" or a number of bars`)
		}
	}
	r.BaseCID = strings.TrimSpace(r.BaseCID)
	if r.BaseCID != "" && !regexp.MustCompile(`^z[1-9A-HJ-NP-Za-km-z]{20,80}$`).MatchString(r.BaseCID) {
		return r, api.Errf(400, api.CodeBadRequest, "base_cid is not a program CID")
	}
	return r, nil
}

// baseProgram finds the program an edit starts from: a stored program or an example, public, CC0 and
// unrestricted. Unknown, private and restricted all answer the same, so the answer says nothing about what
// exists.
func (s *Service) baseProgram(ctx context.Context, cid string) (string, error) {
	refuse := func() error {
		return api.Errf(400, api.CodeBadRequest, "base_cid %s is not a public program this site can edit", cid)
	}
	var text string
	if s.opt.Store != nil {
		if p, ok := s.opt.Store.Get(cid); ok && p != nil {
			if (p.Meta.Visibility != "" && p.Meta.Visibility != "public") || (p.Meta.License != "" && p.Meta.License != "CC0-1.0") {
				return "", refuse()
			}
			text = p.Text
		}
	}
	if text == "" && s.opt.Examples != nil && s.opt.ExampleText != nil {
		for _, e := range s.opt.Examples() {
			if e.CID == cid && strings.EqualFold(e.License, "CC0-1.0") {
				if t, ok := s.opt.ExampleText(e.Name); ok {
					text = t
				}
				break
			}
		}
	}
	if text == "" {
		return "", refuse()
	}
	rep, err := s.opt.Checker.Check(ctx, text)
	if err != nil {
		return "", passThrough(err, "the program checker failed")
	}
	if VetPublicProgram(text, rep, false) != "" || rep.CID != cid {
		return "", refuse()
	}
	return stripHeader(rep.Canonical), nil
}

// ---------- compose ----------

// trace is what one request accumulates for the log and the result.
type trace struct {
	tokensIn, tokensOut int
	cost                float64
	attempts            []api.Attempt
	cid, forkedFrom     string
	detail              string
}

// Compose implements api.Composer.
func (s *Service) Compose(ctx context.Context, u *api.User, ip string, req api.ComposeRequest) (*api.ComposeResult, error) {
	if u == nil || u.ID == "" {
		return nil, api.Errf(401, api.CodeAuthRequired, "sign in to compose")
	}
	started := s.now()
	sum, head := limits.PromptHash(req.Prompt)
	ent := limits.Entry{User: u.ID, IPHash: s.lim.HashIP(ip), PromptChars: utf8.RuneCountInString(req.Prompt),
		PromptSHA: sum, PromptHead: s.red.Redact(head), Model: s.modelName}
	var tr trace
	res, err := s.run(ctx, u, ip, req, &tr)

	ent.TokensIn, ent.TokensOut, ent.CostUSD = tr.tokensIn, tr.tokensOut, tr.cost
	ent.Attempts, ent.CID, ent.ForkedFrom = len(tr.attempts), tr.cid, tr.forkedFrom
	ent.Detail = clip(s.red.Redact(tr.detail), 200)
	ent.MS = s.now().Sub(started).Milliseconds()
	ent.Outcome = "ok"
	if err != nil {
		var ae *api.Error
		if errors.As(err, &ae) {
			ent.Outcome = ae.Code
		} else {
			ent.Outcome = "internal"
		}
	}
	s.lim.Record(ent)
	return res, err
}

func (s *Service) run(ctx context.Context, u *api.User, ip string, req api.ComposeRequest, tr *trace) (*api.ComposeResult, error) {
	// 1. validate
	req, err := s.cleanRequest(req)
	if err != nil {
		return nil, err
	}
	var base string
	if req.BaseCID != "" {
		if base, err = s.baseProgram(ctx, req.BaseCID); err != nil {
			return nil, err
		}
		tr.forkedFrom = req.BaseCID
	}
	// 2. kill switch, then configuration
	if k := s.lim.Kill(); k.Disabled {
		return nil, api.Errf(503, api.CodeDisabled, "compose is switched off for now")
	}
	if s.model == nil {
		return nil, api.Errf(503, api.CodeNotConfigured, "compose is not available: the model is not configured on this site")
	}

	ctx, cancel := context.WithTimeout(ctx, 4*time.Minute)
	defer cancel()
	system, _, err := s.systemPrompt(ctx)
	if err != nil {
		return nil, err
	}
	msgs := []Message{{Role: "user", Text: userMessage(req, base, s.opt.MaxProgramBytes)}}

	// 3. windows and the spend cap, in that order, holding the first call's worst case
	rsv, err := s.lim.Begin(u.ID, ip, s.worstCase(system, msgs))
	if err != nil {
		return nil, s.noteSpend(err)
	}

	// 4. the repair loop
	rounds := 1 + s.opt.MaxRepair
	var lastDiags []api.Diagnostic
	var lastText string
	for n := 1; n <= rounds; n++ {
		if rsv == nil { // every attempt after the first holds its own reservation
			if rsv, err = s.lim.Reserve(s.worstCase(system, msgs)); err != nil {
				return nil, s.withAttempts(s.noteSpend(err), tr, lastDiags, lastText)
			}
		}
		text, use, merr := s.model.Generate(ctx, system, msgs)
		cost := s.lim.Cost(use.In, use.Out)
		var me *ModelError
		if merr != nil && !errors.As(merr, &me) {
			me = &ModelError{Kind: KindTransport, Message: "the model call failed"}
		}
		if me != nil && me.Kind == KindTransport && use.In == 0 && use.Out == 0 {
			// the call may or may not have been billed: count what was sent, not the worst case
			use.In = estimateTokens(system, msgs)
			cost = s.lim.Cost(use.In, 0)
		}
		rsv.Settle(cost, use.In, use.Out)
		rsv = nil
		tr.tokensIn += use.In
		tr.tokensOut += use.Out
		tr.cost += cost
		att := api.Attempt{N: n, TokensIn: use.In, TokensOut: use.Out}

		var (
			prog    string
			report  *api.CheckReport
			diags   []api.Diagnostic
			modelTx string // what the model is told it said
		)
		switch {
		case me != nil && me.Kind == KindMaxTokens:
			diags = []api.Diagnostic{syntheticDiag("your reply was cut off because it ran out of output space before the program ended",
				"write a shorter program: fewer bars, fewer sections, fewer parts")}
			modelTx = "[the reply was cut off before the program ended]"
		case me != nil:
			tr.detail = me.Error()
			att.Errors = 1
			tr.attempts = append(tr.attempts, att)
			return nil, s.withAttempts(s.modelAPIError(me), tr, nil, "")
		default:
			prog = ExtractProgram(text)
			switch {
			case prog == "":
				diags = []api.Diagnostic{syntheticDiag("your reply held no program", "reply with the btw program only, starting with tempo and key")}
				modelTx = "[an empty reply]"
			case len(prog) > s.opt.MaxProgramBytes:
				diags = []api.Diagnostic{syntheticDiag(fmt.Sprintf("the program is %d bytes; the limit is %d", len(prog), s.opt.MaxProgramBytes),
					"write a shorter program: fewer bars, sections and parts, fewer comments")}
				modelTx = fmt.Sprintf("[a program of %d bytes, over the limit of %d]", len(prog), s.opt.MaxProgramBytes)
			default:
				report, err = s.opt.Checker.Check(ctx, prog)
				if err != nil {
					return nil, passThrough(err, "the program checker failed")
				}
				modelTx = prog
				switch {
				case !report.OK:
					diags = report.Diagnostics
				case report.Restricted || report.UsesAssets:
					diags = []api.Diagnostic{syntheticDiag("the program uses restricted sounds or asset statements (use restricted / sample / loop), which are not allowed here",
						"use only the instruments and kits in the INSTRUMENTS list")}
				}
			}
		}

		if len(diags) == 0 && report != nil && report.OK {
			att.OK = true
			att.Diagnostics = report.Diagnostics // warnings, if any
			tr.attempts = append(tr.attempts, att)
			return s.finish(ctx, u, req, prog, report, tr)
		}

		for _, d := range diags {
			if d.Severity == "" || d.Severity == "error" {
				att.Errors++
			}
		}
		att.Diagnostics = diags
		tr.attempts = append(tr.attempts, att)
		lastDiags, lastText = diags, prog
		if n < rounds {
			msgs = append(msgs, Message{Role: "model", Text: modelTx}, Message{Role: "user", Text: repairMessage(diags)})
		}
	}

	e := api.Errf(422, api.CodeUnrepairable, "the model could not write a program that passes the checker in %d attempts", len(tr.attempts))
	e.Details = map[string]any{"diagnostics": lastDiags, "attempts": tr.attempts, "last_text": lastText, "cost_usd": tr.cost}
	return nil, e
}

// worstCase is the most one model call can cost: the input as it stands and a full output allowance (thinking
// counts as output, and can eat the whole allowance).
func (s *Service) worstCase(system string, msgs []Message) float64 {
	return s.lim.Cost(estimateTokens(system, msgs), s.opt.MaxOutputTokens)
}

// withAttempts attaches what happened so far to an error that ended the request.
func (s *Service) withAttempts(err error, tr *trace, diags []api.Diagnostic, lastText string) error {
	var ae *api.Error
	if errors.As(err, &ae) && ae.Details == nil && len(tr.attempts) > 0 {
		cp := *ae
		cp.Details = map[string]any{"attempts": tr.attempts, "diagnostics": diags, "last_text": lastText, "cost_usd": tr.cost}
		return &cp
	}
	return err
}

// modelAPIError turns a failed model call into the error the user sees. The upstream's own words never go
// to the user; they are in the log, redacted.
func (s *Service) modelAPIError(me *ModelError) *api.Error {
	var e *api.Error
	switch me.Kind {
	case KindRateLimited:
		e = api.Errf(502, api.CodeModelError, "the model service is busy right now; try again in a minute")
		e.RetryAfter = me.RetryAfter
	case KindBlocked:
		e = api.Errf(502, api.CodeModelError, "the model declined this request; try rewording the prompt")
	case KindAuth:
		e = api.Errf(502, api.CodeModelError, "the model service refused this site's credentials; the operator has been logged an error")
	case KindTransport:
		e = api.Errf(502, api.CodeModelError, "the model service did not answer in time; try again")
	default:
		msg := "the model service returned an error"
		if me.Status != 0 {
			msg += " (HTTP " + strconv.Itoa(me.Status) + ")"
		}
		e = api.Errf(502, api.CodeModelError, "%s; try again", msg)
	}
	return e
}

// passThrough returns an *api.Error as itself (the checker's own busy / limit errors) and wraps anything
// else as a 500 with a fixed message: raw error text of a subprocess does not go to a user.
func passThrough(err error, msg string) error {
	var ae *api.Error
	if errors.As(err, &ae) {
		return ae
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return api.Errf(503, "unavailable", "the request took too long or was cancelled")
	}
	return api.Errf(500, "internal", "%s", msg)
}

// ---------- success ----------

// finish stores the program with its provenance and builds the result.
func (s *Service) finish(ctx context.Context, u *api.User, req api.ComposeRequest, prog string, rep *api.CheckReport, tr *trace) (*api.ComposeResult, error) {
	sum := sha256.Sum256([]byte(req.Prompt))
	meta := api.Meta{
		License: "CC0-1.0", Visibility: "public", ComposedBy: s.by, ForkedFrom: req.BaseCID,
		PromptSHA: hex.EncodeToString(sum[:]), Created: s.now().UTC().Format(time.RFC3339), Source: "compose",
	}
	if s.opt.Store != nil {
		p, _, err := s.opt.Store.Put(ctx, prog, meta)
		if err != nil {
			return nil, passThrough(err, "the program could not be stored")
		}
		if p != nil && p.CID != "" && p.CID != rep.CID {
			s.logf("compose: store CID %s differs from checked CID %s", p.CID, rep.CID)
		}
	}
	tr.cid = rep.CID
	// The header lines belong to the stored object and the .btw download, never to the checked or canonical
	// text: comments are not in the CID, and a program the model wrote with its own "#! composed-by:" line
	// keeps that line in Text as it is.
	header := []string{"#! license: CC0-1.0", "#! composed-by: " + s.by}
	if req.BaseCID != "" {
		header = append(header, "#! forked-from: "+req.BaseCID)
	}
	res := &api.ComposeResult{
		Program: rep.Canonical, Text: prog, CID: rep.CID, Check: rep, Attempts: tr.attempts,
		Model: s.modelName, ForkedFrom: req.BaseCID, License: "CC0-1.0", ComposedBy: s.by, Header: header,
		RenderURL: "/api/render/" + rep.CID + "?format=opus", ShareURL: s.shareURL(ctx, rep),
		CostUSD: tr.cost, Usage: api.Usage{In: tr.tokensIn, Out: tr.tokensOut},
	}
	return res, nil
}

// shareURL is the self-sealing link on this site's origin.
func (s *Service) shareURL(ctx context.Context, rep *api.CheckReport) string {
	origin := strings.TrimRight(s.opt.PublicURL, "/")
	if sr, err := s.opt.Checker.Share(ctx, rep.Canonical); err == nil && sr != nil && sr.OK && sr.URL != "" {
		if i := strings.Index(sr.URL, "#"); i >= 0 && origin != "" {
			return origin + "/" + sr.URL[i:]
		}
		return sr.URL
	}
	if origin != "" {
		return origin + "/#" + rep.CID
	}
	return ""
}

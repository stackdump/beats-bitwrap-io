// Package api holds the types and interfaces the btw.bitwrap.io packages share, so the compose,
// MCP, card and server packages can be written (and tested) against each other without importing
// one another. See btwsite/DESIGN.md. Additive edits only: other packages compile against this.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// Error is the typed error every layer returns; HTTP handlers write it as
// {"error":{"code","message","retry_after"}} with Status, MCP turns it into a tool error.
type Error struct {
	Status     int    `json:"-"`
	Code       string `json:"code"`
	Message    string `json:"message"`
	RetryAfter int    `json:"retry_after,omitempty"` // seconds
	// Details carries structured data for the caller (e.g. the diagnostics and attempts of an
	// unrepairable compose). It is written as "details" when set.
	Details any `json:"details,omitempty"`
}

func (e *Error) Error() string { return fmt.Sprintf("%s: %s", e.Code, e.Message) }

// Errf makes an *Error.
func Errf(status int, code, format string, args ...any) *Error {
	return &Error{Status: status, Code: code, Message: fmt.Sprintf(format, args...)}
}

// WriteError writes err as the JSON error body (an *Error as itself, anything else as 500 internal).
func WriteError(w http.ResponseWriter, err error) {
	e, ok := err.(*Error)
	if !ok {
		e = &Error{Status: http.StatusInternalServerError, Code: "internal", Message: err.Error()}
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if e.RetryAfter > 0 {
		w.Header().Set("Retry-After", fmt.Sprint(e.RetryAfter))
	}
	w.WriteHeader(e.Status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": e})
}

// Well-known error codes.
const (
	CodeAuthRequired   = "auth_required"   // 401
	CodeRateLimited    = "rate_limited"    // 429
	CodeSpendCap       = "spend_cap"       // 503
	CodeDisabled       = "disabled"        // 503 (kill switch)
	CodeNotConfigured  = "not_configured"  // 503 (no model key)
	CodeBadRequest     = "bad_request"     // 400
	CodePromptTooLong  = "prompt_too_long" // 413
	CodeModelError     = "model_error"     // 502
	CodeUnrepairable   = "unrepairable"    // 422
	CodeNotFound       = "not_found"       // 404
	CodeRestricted     = "restricted"      // 422: the program uses private/restricted assets
	CodeTooLarge       = "too_large"       // 413
	CodeBusy           = "busy"            // 429: render slots all taken
	CodeCIDMismatch    = "cid_mismatch"    // 422: a link or body whose CID is not its text's
	CodeNoSession      = "no_session"      // 404/409: no connected browser session to drive
	CodeBadSignature   = "bad_signature"   // 401
	CodeChallengeStale = "challenge_stale" // 401
)

// ---------- what btwd / btwapi answer ----------

// Diagnostic is one error or warning with its place.
type Diagnostic struct {
	Severity string   `json:"severity"` // "error" | "warning"
	Line     int      `json:"line"`
	Col      int      `json:"col"`
	EndCol   int      `json:"end_col"`
	Start    int      `json:"start"`
	End      int      `json:"end"`
	Message  string   `json:"message"`
	Expected []string `json:"expected,omitempty"`
	Found    string   `json:"found,omitempty"`
	Help     string   `json:"help,omitempty"`
	Render   string   `json:"render,omitempty"` // the caret form, for sending back to a model
}

// Section is one part of a song's timeline.
type Section struct {
	Name  string `json:"name"`
	Start int    `json:"start"`
	Bars  int    `json:"bars"`
}

// CheckReport is `btwd check` / `btw_check` (DESIGN.md "JSON shapes").
type CheckReport struct {
	OK          bool              `json:"ok"`
	Errors      int               `json:"errors"`
	Warnings    int               `json:"warnings"`
	Diagnostics []Diagnostic      `json:"diagnostics"`
	CID         string            `json:"cid"`
	Canonical   string            `json:"canonical"`
	Nets        map[string]string `json:"nets,omitempty"`
	SongNets    map[string]string `json:"song_nets,omitempty"`
	Tempo       *float64          `json:"tempo"`
	Key         string            `json:"key,omitempty"`
	Swing       *float64          `json:"swing"`
	Arranged    bool              `json:"arranged"`
	SongBars    int               `json:"song_bars"`
	Ends        bool              `json:"ends"`
	Loops       bool              `json:"loops"`
	Sections    []Section         `json:"sections,omitempty"`
	Decks       []string          `json:"decks,omitempty"`
	Evolve      []string          `json:"evolve,omitempty"`
	Lineage     []json.RawMessage `json:"lineage,omitempty"`
	UsesAssets  bool              `json:"uses_assets"`
	Restricted  bool              `json:"restricted"`
	Seconds     *float64          `json:"seconds"`
}

// FmtReport is `btwd fmt`.
type FmtReport struct {
	OK          bool         `json:"ok"`
	Canonical   string       `json:"canonical"`
	CID         string       `json:"cid"`
	Comments    []string     `json:"comments,omitempty"`
	Diagnostics []Diagnostic `json:"diagnostics,omitempty"`
}

// OpenReport is `btwd open` (a link, a fragment or a bare CID decoded and verified).
type OpenReport struct {
	OK              bool     `json:"ok"`
	CID             string   `json:"cid"`
	Canonical       string   `json:"canonical"`
	Verified        bool     `json:"verified"`
	Warnings        []string `json:"warnings,omitempty"`
	NotesUnverified []string `json:"notes_unverified,omitempty"`
	Error           string   `json:"error,omitempty"`
}

// ShareReport is `btwd share` (+ the site's origin).
type ShareReport struct {
	OK        bool     `json:"ok"`
	URL       string   `json:"url"`        // <origin>/#<CID>.<packed>
	SocialURL string   `json:"social_url"` // <origin>/c/<CID>.<packed>
	BeatsURL  string   `json:"beats_url"`  // https://beats.bitwrap.io/p#<CID>.<packed>
	CID       string   `json:"cid"`
	Chars     int      `json:"chars"`
	Canonical string   `json:"canonical"`
	Warnings  []string `json:"warnings,omitempty"`
}

// Span is one highlighted range (UTF-8 byte offsets) and its class.
type Span struct {
	Start int
	End   int
	Class string
}

// Checker is the Rust side as the Go server sees it: the `btwd` subprocess (or a fake in tests).
type Checker interface {
	Check(ctx context.Context, text string) (*CheckReport, error)
	Fmt(ctx context.Context, text string) (*FmtReport, error)
	Open(ctx context.Context, urlOrCID string) (*OpenReport, error)
	Share(ctx context.Context, text string) (*ShareReport, error)
	Highlight(ctx context.Context, text string) ([]Span, error)
	Instruments(ctx context.Context) (json.RawMessage, error)
	// Cheatsheet is the compact grammar generated from BTW.md (what /docs/cheatsheet.md and the
	// compose system prompt both use).
	Cheatsheet(ctx context.Context) (string, error)
}

// ---------- identity ----------

// User is who a request is from. A nil *User means anonymous.
type User struct {
	ID      string `json:"id"`      // "eip155:0xabc…" | "ed25519:<hex>"
	Kind    string `json:"kind"`    // "eth" | "ed25519"
	Address string `json:"address"` // 0x… | 64 hex
	Via     string `json:"via"`     // "cookie" | "token"
}

// Authenticator resolves the caller of a request (cookie, then bearer token). (nil, nil) is anonymous;
// an error only for a credential that is present but invalid.
type Authenticator interface {
	UserFrom(r *http.Request) (*User, error)
	// UserFromToken resolves a bearer token ("btw_…"), for MCP.
	UserFromToken(token string) *User
}

// ---------- programs ----------

// Meta is what is kept beside a program: the "object" half (text + rights), not part of the CID.
type Meta struct {
	License    string `json:"license"` // "CC0-1.0"
	Visibility string `json:"visibility"`
	Name       string `json:"name,omitempty"`
	ComposedBy string `json:"composed_by,omitempty"` // "gemini-<model>", e.g. "gemini-3.8-flash"
	ForkedFrom string `json:"forked_from,omitempty"`
	// Credits are who is thanked for the program (at most MaxCredits lines of MaxCreditChars). Only a signed-in
	// share (PUT /api/shares/<cid>, the MCP share tool) sets them; like the rest of Meta they are not in the CID.
	Credits   []string `json:"credits,omitempty"`
	PromptSHA string   `json:"prompt_sha256,omitempty"`
	Author    string   `json:"author,omitempty"`
	Created   string   `json:"created,omitempty"` // RFC 3339, informational (never in a CID or a card)
	Source    string   `json:"source,omitempty"`  // "compose" | "put" | "example"
}

// Limits of the rights a share carries.
const (
	MaxCredits     = 8
	MaxCreditChars = 80
	// BeatsOrigin is where the same CID-only link opens in the beat sequencer's page: <BeatsOrigin>/p/<CID>.
	BeatsOrigin = "https://beats.bitwrap.io"
)

// ShortLinks are the CID-only forms of a stored program, next to the self-sealing link that carries the program
// itself. Opening one fetches the canonical text from the store (GET /api/programs/<cid>), recompiles it,
// recomputes the CID and refuses a mismatch, the same check a self-sealing link gets.
type ShortLinks struct {
	URL       string `json:"short_url"`        // <site>/p/<CID>
	SocialURL string `json:"short_social_url"` // <site>/c/<CID>: the link-preview page, for posts
	BeatsURL  string `json:"short_beats_url"`  // https://beats.bitwrap.io/p/<CID>
}

// ShortLinksOf builds them from the site origin.
func ShortLinksOf(site, cid string) ShortLinks {
	site = strings.TrimRight(site, "/")
	return ShortLinks{URL: site + "/p/" + cid, SocialURL: site + "/c/" + cid, BeatsURL: BeatsOrigin + "/p/" + cid}
}

// DeclaresNotPublic reports a `#! visibility:` header line whose value is anything but "public". btwd's own
// rule is the one spelling `#! visibility: private` (case and spaces between words aside), so `#!visibility:private`
// or `#! visibility: restricted` would reach the store as public programs; whoever wrote them meant them private,
// and this site never keeps, renders or sends to a model a program that says so. Stricter than btwd, never looser.
func DeclaresNotPublic(text string) bool {
	for _, l := range strings.Split(text, "\n") {
		t := strings.TrimSpace(l)
		rest, ok := strings.CutPrefix(t, "#!")
		if !ok {
			continue
		}
		squeezed := strings.ToLower(strings.Join(strings.Fields(rest), ""))
		if v, ok := strings.CutPrefix(squeezed, "visibility:"); ok && v != "public" {
			return true
		}
	}
	return false
}

// Program is a stored program: canonical text, its CID and its meta.
type Program struct {
	CID  string `json:"cid"`
	Text string `json:"text"` // canonical
	Meta Meta   `json:"meta"`
}

// ProgramStore is the content-addressed store of public, unrestricted programs.
type ProgramStore interface {
	// Put checks text (via the Checker), refuses errors / restricted / asset-using programs, stores the
	// canonical text under its CID and returns it. Idempotent. meta fills the object half (license defaults CC0-1.0).
	Put(ctx context.Context, text string, meta Meta) (*Program, *CheckReport, error)
	Get(cid string) (*Program, bool)
}

// ---------- examples ----------

type Example struct {
	Name        string  `json:"name"`
	Title       string  `json:"title"`
	Description string  `json:"description"`
	CID         string  `json:"cid"`
	BPM         float64 `json:"bpm,omitempty"`
	Bars        int     `json:"bars,omitempty"`
	License     string  `json:"license"`
}

// ---------- compose ----------

type ComposeRequest struct {
	Prompt  string  `json:"prompt"`
	Genre   string  `json:"genre,omitempty"`
	BPM     float64 `json:"bpm,omitempty"`
	Key     string  `json:"key,omitempty"`
	Length  string  `json:"length,omitempty"` // short | medium | long | "<bars>"
	BaseCID string  `json:"base_cid,omitempty"`
	// Current is the program the caller is editing ("change this"): the phone's Code tab sends what is in its
	// editor with every prompt after the first. It is vetted like a base_cid program (public CC0 by its own
	// header, no assets, checks without errors) and then given to the model as the program to modify.
	// base_cid wins when both are sent.
	Current string `json:"current,omitempty"`
}

type Attempt struct {
	N           int          `json:"n"`
	OK          bool         `json:"ok"`
	Errors      int          `json:"errors"`
	Diagnostics []Diagnostic `json:"diagnostics,omitempty"`
	TokensIn    int          `json:"tokens_in"`
	TokensOut   int          `json:"tokens_out"` // candidates + thoughts
}

type Usage struct {
	In  int `json:"in"`
	Out int `json:"out"`
}

type ComposeResult struct {
	Program    string       `json:"program"` // canonical text
	Text       string       `json:"text"`    // as the model wrote it (after repair)
	CID        string       `json:"cid"`
	Check      *CheckReport `json:"check"`
	Attempts   []Attempt    `json:"attempts"`
	Model      string       `json:"model"`
	ForkedFrom string       `json:"forkedFrom"`
	License    string       `json:"license"`
	Notice     string       `json:"notice"` // PublicNotice: what happens to what was composed
	ComposedBy string       `json:"composedBy"`
	Header     []string     `json:"header"`
	RenderURL  string       `json:"render_url"`
	ShareURL   string       `json:"share_url"`
	CostUSD    float64      `json:"cost_usd"`
	Usage      Usage        `json:"usage"`
}

// PublicNotice is said wherever something is generated: with every compose result, on /privacy, in the
// docs and the MCP tool descriptions. Keep it one sentence and true: a program, its share link and its audio
// are public the moment they exist.
// RenderVersion names what `btwd render` makes of a program (see server/render.go renderVersion, which is this). Every
// render URL the site hands out carries it as `v=`: renders are served immutable for a year, so a renderer that changes the
// audio for the same CID must change the URL too, or a browser keeps the old file. The handler ignores the parameter.
const RenderVersion = "r2"

const PublicNotice = "Everything generated here is published: the program, its CID, share link and rendered audio are stored publicly and released under CC0-1.0 (public domain), and anyone with the link can play, copy and reuse them. The prompt goes to a third-party model provider. Do not put anything private in a prompt."

// Composer is implemented by the compose package. It enforces auth-agnostic rules itself (limits,
// kill switch, spend cap, size caps); the HTTP layer and MCP check authentication first and pass the user.
// u must be non-nil: a nil user returns CodeAuthRequired.
type Composer interface {
	Compose(ctx context.Context, u *User, ip string, req ComposeRequest) (*ComposeResult, error)
	// Status is what /api/info reports about compose.
	Status() ComposeStatus
}

type ComposeStatus struct {
	Enabled     bool    `json:"enabled"`
	Configured  bool    `json:"configured"`
	Model       string  `json:"model"`
	UserHour    int     `json:"user_per_hour"`
	UserDay     int     `json:"user_per_day"`
	IPDay       int     `json:"ip_per_day"`
	SpentUSD    float64 `json:"spent_today_usd"`
	DailyCapUSD float64 `json:"daily_cap_usd"`
	Reason      string  `json:"reason,omitempty"` // why not enabled/configured, in words: for the operator (admin stats), may name paths and settings
	// PublicReason is Reason with nothing in it an anonymous visitor should not read (file paths, environment
	// variable names, the admin endpoint): what /api/info shows.
	PublicReason string `json:"public_reason,omitempty"`
}

// ---------- sessions (the browser <-> MCP bridge) ----------

// SessionEvent is pushed to a browser over SSE. Type: eval | load | stop | get | ping.
type SessionEvent struct {
	Type      string          `json:"type"`
	RequestID string          `json:"request_id,omitempty"` // for "get": the page answers with POST …/reply
	Text      string          `json:"text,omitempty"`
	CID       string          `json:"cid,omitempty"`
	Play      bool            `json:"play,omitempty"`
	Extra     json.RawMessage `json:"extra,omitempty"`
}

type SessionInfo struct {
	ID       string `json:"id"`
	Owner    string `json:"owner,omitempty"`  // user id, "" for anonymous
	Device   string `json:"device,omitempty"` // a paired phone's device id (POST /api/pair), "" for a browser page
	LastSeen string `json:"last_seen"`
	CID      string `json:"cid,omitempty"`
	Playing  bool   `json:"playing"`
}

// SessionState is what the page last reported (or answered to a "get").
type SessionState struct {
	ID          string          `json:"id"`
	Text        string          `json:"text"`
	CID         string          `json:"cid"`
	Playing     bool            `json:"playing"`
	Source      string          `json:"source"` // engine | stream
	Section     string          `json:"section"`
	SectionNum  int             `json:"section_num"`
	SectionsAll int             `json:"sections_total"`
	Bar         int             `json:"bar"`
	BarsInSect  int             `json:"bars_in_section"`
	Phase       int             `json:"phase"`
	Marks       json.RawMessage `json:"marks,omitempty"`
	Diagnostics json.RawMessage `json:"diagnostics,omitempty"`
	// Presence is the page's evidence that someone is listening (the up-next queue advances only while it holds).
	Presence *Presence `json:"presence,omitempty"`
	TS       string    `json:"ts"`
}

// ---------- the up-next queue (MCP's queue tool; btwsite/DESIGN.md "Up next") ----------

// Presence is what a page reports about its listener. idle_ms is measured on the page's own clock (time since the
// last key, pointer, touch or media key), so the server needs no agreement between the two clocks.
type Presence struct {
	Visible bool   `json:"visible"` // document.visibilityState == "visible"
	Focused bool   `json:"focused"` // document.hasFocus()
	Audio   string `json:"audio"`   // the AudioContext state: running | suspended | closed | none
	IdleMS  int64  `json:"idle_ms"` // milliseconds since the last user interaction
}

// QueueItem is one program waiting in a session's queue. Items are always programs that already exist (a stored CID,
// an example, or a verified share link): the queue never composes and never calls a model.
type QueueItem struct {
	ID      string  `json:"id"` // short id, unique within the queue (remove takes it)
	CID     string  `json:"cid"`
	Title   string  `json:"title,omitempty"`
	Source  string  `json:"source"`            // store | example | link
	Example string  `json:"example,omitempty"` // the example's name, for source=example
	Bars    int     `json:"bars,omitempty"`    // play length in bars (0 = until it ends; a loop: one arrangement pass)
	Minutes float64 `json:"minutes,omitempty"` // play length in minutes (0 = as bars says)
	// Text is a link item's verified canonical text (stored and example items are fetched by CID or name). Kept in memory
	// with the session, never written anywhere, never shown in a listing.
	Text string `json:"-"`
}

// QueueView is a session's queue as MCP and the page see it.
type QueueView struct {
	Session    string      `json:"session"`
	UpNext     []QueueItem `json:"up_next"`
	NowPlaying *QueueItem  `json:"now_playing,omitempty"` // the item the queue last advanced to
	Position   int         `json:"position"`              // how many items the queue has advanced through
	// PausedReason is set when the queue stopped at a track boundary for want of a listener: idle_hidden,
	// audio_suspended, max_auto_advance or no_listener_report. It clears only when the page reports a user interaction
	// newer than the pause.
	PausedReason string `json:"paused_reason,omitempty"`
	// Listener is what the next boundary would decide from the latest report: "present", or the reason it would pause.
	Listener     string `json:"listener"`
	AutoAdvanced int    `json:"auto_advanced"` // consecutive advances since the last user interaction
	MaxAuto      int    `json:"max_auto_advance"`
	IdleMinutes  int    `json:"idle_minutes"`
	MaxItems     int    `json:"max_items"`
}

// QueueOp is one queue call. Action: list | add | remove | clear | skip.
type QueueOp struct {
	Action string
	Items  []QueueItem // add
	Remove string      // remove: an item id or a CID (the first item with it)
}

// Queuer is implemented by a backend whose sessions keep an up-next queue (the server package). MCP checks for it with a
// type assertion, so a backend without one still builds; the queue tool then answers not_found.
type Queuer interface {
	// Queue applies op to the queue of one session the caller may drive: sessionID if given, else the caller's most recently
	// seen session. skip pushes an advance request to the page (the page then asks for the next item under the presence
	// rules) and reports sent=true; when the queue is paused or no listener is present nothing is pushed (sent=false) and
	// the view says why.
	Queue(u *User, sessionID string, op QueueOp) (*QueueView, bool, error)
}

// Hub is implemented by the server (internal/btwsite/server).
type Hub interface {
	// Push delivers ev to the sessions the caller may drive: sessionID if given (it must be owned by u
	// or anonymous), else every live session owned by u. Returns the number delivered.
	Push(u *User, sessionID string, ev SessionEvent) (int, error)
	// State is the latest report of one session (asking the page with a "get" when stale and wait>0 ms).
	State(ctx context.Context, u *User, sessionID string) (*SessionState, error)
	Sessions(u *User) []SessionInfo
}

// ---------- the whole backend, as MCP and the HTTP layer use it ----------

// Backend is what the MCP server is built over. The server package implements it.
type Backend interface {
	Checker
	Hub
	ProgramStore
	Composer
	Examples() []Example
	Example(name string) (text string, ok bool)
	// RenderInfo says where the stream is and how long the program is.
	RenderInfo(cid, format string) (streamURL, statusURL string, seconds float64)
	PublicURL() string
	// AuthHelp is the words for an unauthenticated caller of a write tool: how to get a token.
	AuthHelp() string
}

// ---------- paired phones (btwsite/PAIRING.md) ----------

// DeviceInfo is one paired phone of a user, as MCP's devices tool lists it. Pairing is the grant:
// a phone paired by a user is driven over MCP with that user's bearer token, and no other.
type DeviceInfo struct {
	ID          string        `json:"id"`
	Name        string        `json:"name"`
	Fingerprint string        `json:"fingerprint"` // sha256(key)[:4], as both ends showed it at pairing
	Paired      string        `json:"paired"`
	Connected   bool          `json:"connected"`           // djrust has its event stream open now
	LastSeen    string        `json:"last_seen,omitempty"` // RFC 3339
	Session     string        `json:"session,omitempty"`   // its hub session (changes when it reconnects; pass device instead)
	State       *SessionState `json:"state,omitempty"`     // what it last reported
}

// Devices is implemented by a backend with paired phones (the server package). MCP checks for it with a type
// assertion, so a backend without pairing still builds; its devices tool then answers an empty list.
type Devices interface {
	// Devices lists u's paired phones, most recently paired first.
	Devices(u *User) []DeviceInfo
	// DeviceSession is the hub session of u's device id: a not_found *Error when u has no such device, a
	// no_session *Error when it is paired but not connected.
	DeviceSession(u *User, deviceID string) (string, error)
}

// ---------- same song (btwd same-as) ----------

// SameAser is an optional part of a Checker: are two programs the same song, judged by what they compile to
// (their nets and song-level settings), not their text. The answer is btwd's `same-as` JSON, passed through:
// {ok, same, text_same, basis, why, a_cid, b_cid, sections_compared, sections_same, song_nets_same,
// diffs[{section, b_section, deck, start_bar, a_cid, b_cid}], only_in_a, only_in_b, renamed, song, song_nets,
// diff} where diff (null when same) is {basis, summary[], song[], arrangement[], unchanged_sections, parts[]}.
type SameAser interface {
	SameAs(ctx context.Context, a, b string) (json.RawMessage, error)
}

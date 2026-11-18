// Package mcpsrv is the MCP server of btw.bitwrap.io: the btw language, the compose pipeline, the
// renderer and the browser sessions as twelve tools over streamable HTTP at /mcp (btwsite/DESIGN.md "MCP").
//
//	mux.Handle("/mcp", mcpsrv.Handler(backend, auth, "https://btw.bitwrap.io"))
//	mux.Handle("/mcp/", ...the same handler...)
//
// It is stateless (every request stands alone, which is what an nginx in front wants), built on
// github.com/mark3labs/mcp-go, and written against api.Backend only, so it is tested with a fake.
//
// Authentication is the bearer token of the HTTP request ("Authorization: Bearer btw_..."), resolved with
// api.Authenticator.UserFromToken on every call. Read tools work anonymously; the write tools (compose, eval,
// load, stop) answer an MCP tool error with code auth_required and Backend.AuthHelp() without one.
//
// Every tool failure is a tool result with isError true whose text is the site's usual error body,
// {"error":{"code","message","retry_after","details"}}, so a model can read the code and the words.
package mcpsrv

import (
	"context"
	"fmt"
	"html"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/server"

	"beats-bitwrap-io/internal/btwsite/api"
)

// ToolNames is the contract: the names tools/list answers, in this order.
var ToolNames = []string{
	"compose", "check", "fmt", "eval", "load", "get", "share", "open", "render", "list_examples", "instruments", "stop",
}

// Options tunes the handler. The zero value of each field means its default.
type Options struct {
	// ClientIP resolves the address a request came from (behind nginx it must read X-Real-IP or the
	// last X-Forwarded-For). Default api.ClientIP, which does that for a loopback proxy.
	ClientIP func(r *http.Request) string
	// MaxProgramBytes caps every program text an argument may carry. Default 16384 (compose's -max-program-bytes).
	MaxProgramBytes int
	// MaxPromptChars caps compose's prompt. Default 800 (compose's -max-prompt-chars).
	MaxPromptChars int
	// CheckPerMin is how many calls a minute one client (a user, else an address) may make to the tools
	// that run the Rust checker: check, fmt, share, open, and the check inside eval / load / render.
	// Default 60. The compose limits are the backend's own.
	CheckPerMin int
	// RenderPerHour is how many programs one client may have stored for rendering through the render
	// tool per hour (the stream itself has the server's own limits). Default 30.
	RenderPerHour int
	// ComposeTimeout bounds one compose call. Default 150 s.
	ComposeTimeout time.Duration
	// Now is the clock (tests).
	Now func() time.Time
}

// Option sets one Options field.
type Option func(*Options)

func WithClientIP(f func(r *http.Request) string) Option { return func(o *Options) { o.ClientIP = f } }
func WithMaxProgramBytes(n int) Option                   { return func(o *Options) { o.MaxProgramBytes = n } }
func WithMaxPromptChars(n int) Option                    { return func(o *Options) { o.MaxPromptChars = n } }
func WithCheckPerMin(n int) Option                       { return func(o *Options) { o.CheckPerMin = n } }
func WithRenderPerHour(n int) Option                     { return func(o *Options) { o.RenderPerHour = n } }
func WithComposeTimeout(d time.Duration) Option          { return func(o *Options) { o.ComposeTimeout = d } }
func WithNow(f func() time.Time) Option                  { return func(o *Options) { o.Now = f } }

func (o *Options) defaults() {
	if o.ClientIP == nil {
		o.ClientIP = api.ClientIP
	}
	if o.MaxProgramBytes <= 0 {
		o.MaxProgramBytes = 16384
	}
	if o.MaxPromptChars <= 0 {
		o.MaxPromptChars = 800
	}
	if o.CheckPerMin <= 0 {
		o.CheckPerMin = 60
	}
	if o.RenderPerHour <= 0 {
		o.RenderPerHour = 30
	}
	if o.ComposeTimeout <= 0 {
		o.ComposeTimeout = 150 * time.Second
	}
	if o.Now == nil {
		o.Now = time.Now
	}
}

// Server is the built MCP server; Handler wraps one.
type Server struct {
	b      api.Backend
	auth   api.Authenticator
	public string // https://btw.bitwrap.io, no trailing slash
	opt    Options
	mcp    *server.MCPServer
	http   *server.StreamableHTTPServer

	cpu    *limiter // check, fmt, share, open (+ the checks inside eval, load, render)
	render *limiter // programs stored for rendering
	inst   instrumentsCache
}

// Handler is the /mcp handler. publicURL is the site's origin (empty: Backend.PublicURL()).
func Handler(b api.Backend, a api.Authenticator, publicURL string, opts ...Option) http.Handler {
	return New(b, a, publicURL, opts...)
}

// New builds the server; it is an http.Handler.
func New(b api.Backend, a api.Authenticator, publicURL string, opts ...Option) *Server {
	var o Options
	for _, f := range opts {
		f(&o)
	}
	o.defaults()
	if publicURL == "" {
		publicURL = b.PublicURL()
	}
	s := &Server{b: b, auth: a, public: strings.TrimRight(publicURL, "/"), opt: o}
	s.cpu = newLimiter(o.CheckPerMin, time.Minute, o.Now)
	s.render = newLimiter(o.RenderPerHour, time.Hour, o.Now)

	s.mcp = server.NewMCPServer("btw", "0.1.0",
		server.WithToolCapabilities(false),
		server.WithRecovery(),
		server.WithInstructions(s.instructions()),
	)
	s.addTools()
	// Stateless: no session id, so the service sits behind nginx (or restarts) without clients noticing.
	s.http = server.NewStreamableHTTPServer(s.mcp,
		server.WithStateLess(true),
		server.WithHTTPContextFunc(s.httpContext),
	)
	return s
}

// ServeHTTP: a browser GET gets the landing page, everything else is the MCP transport.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && !strings.Contains(r.Header.Get("Accept"), "text/event-stream") {
		s.landing(w, r)
		return
	}
	// Long calls (compose, render info on a busy box) must not be cut by the parent http.Server's deadlines.
	if rc := http.NewResponseController(w); rc != nil {
		_ = rc.SetWriteDeadline(time.Time{})
		_ = rc.SetReadDeadline(time.Time{})
	}
	if r.Body != nil {
		// A program is at most MaxProgramBytes; JSON can spend six bytes on one control character.
		r.Body = http.MaxBytesReader(w, r.Body, int64(8*s.opt.MaxProgramBytes+64<<10))
	}
	s.http.ServeHTTP(w, r)
}

// Tools is what tools/list answers, by name (tests, the landing page).
func (s *Server) Tools() map[string]*server.ServerTool { return s.mcp.ListTools() }

// ---------- request context ----------

type ctxKey struct{}

// callInfo is what the HTTP request contributes to a tool call.
type callInfo struct {
	token string
	ip    string
}

func (s *Server) httpContext(ctx context.Context, r *http.Request) context.Context {
	ci := callInfo{ip: s.opt.ClientIP(r)}
	if h := strings.TrimSpace(r.Header.Get("Authorization")); len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		if t := strings.TrimSpace(h[7:]); len(t) <= 256 {
			ci.token = t
		}
	}
	return context.WithValue(ctx, ctxKey{}, ci)
}

// caller is who is calling: a user (nil: anonymous) and the address.
type caller struct {
	user *api.User
	ip   string
	// key is what a per-client limit counts: the user, else the address (the /64 for IPv6).
	key string
}

func (s *Server) caller(ctx context.Context) caller {
	ci, _ := ctx.Value(ctxKey{}).(callInfo)
	c := caller{ip: ci.ip}
	if ci.token != "" && s.auth != nil {
		c.user = s.auth.UserFromToken(ci.token)
	}
	switch {
	case c.user != nil:
		c.key = "u:" + c.user.ID
	case ci.ip != "":
		c.key = "ip:" + api.IPKey(ci.ip)
	default:
		c.key = "ip:unknown"
	}
	return c
}

func (s *Server) authHelp() string {
	h := strings.TrimSpace(s.b.AuthHelp())
	if h == "" {
		h = "Sign in at " + s.public + " and press the \"MCP token\" button, then send it as the header Authorization: Bearer btw_..."
	}
	return h
}

// ---------- the landing page ----------

func (s *Server) landing(w http.ResponseWriter, r *http.Request) {
	tools := s.mcp.ListTools()
	names := make([]string, 0, len(tools))
	for n := range tools {
		names = append(names, n)
	}
	sort.Strings(names)
	endpoint := s.public + "/mcp"

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	var b strings.Builder
	fmt.Fprintf(&b, `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>btw MCP server</title>
<meta name="author" content="Matt York">
<link rel="me" href="https://github.com/stackdump">
<link rel="me" href="https://blog.stackdump.com/">
<style>
 :root{color-scheme:dark;--bg:#0d1117;--panel:#161b22;--line:#30363d;--fg:#c9d1d9;--dim:#8b949e;--blue:#58a6ff;--green:#7ee787;--violet:#d2a8ff;--red:#f85149}
 body{font-family:system-ui,sans-serif;max-width:860px;margin:2em auto;padding:0 16px;background:var(--bg);color:var(--fg);line-height:1.5}
 h1,h2{color:var(--blue)} a{color:var(--blue)}
 code{background:var(--line);padding:2px 6px;border-radius:3px;font-size:.9em}
 pre{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:12px 16px;overflow:auto}
 pre code{background:none;padding:0}
 .tool{border:1px solid var(--line);border-radius:6px;padding:12px 16px;margin:10px 0;background:var(--panel)}
 .name{font-family:monospace;font-weight:bold;color:var(--green);font-size:1.05em}
 .auth{color:var(--red);font-size:.75em;margin-left:8px}
 .desc{color:var(--dim);margin-top:4px;font-size:.9em;white-space:pre-line}
 .params{margin-top:8px;font-size:.85em;line-height:1.7}
 .param{font-family:monospace;color:var(--violet)}
 .req{color:var(--red);font-size:.75em;margin-left:4px}
</style></head><body>
<h1>btw MCP server</h1>
<p>btw is a small language for writing whole music tracks as text. This endpoint is the
<a href="https://modelcontextprotocol.io">Model Context Protocol</a> over Streamable HTTP at <code>%s</code>:
check, format, compose, share and render programs, and drive a browser tab at <a href="%s">%s</a>.
Programs are CC0. The reading list for a model is <a href="%s/llms.txt">%s/llms.txt</a>.</p>
<h2>Add to Claude Code</h2>
<pre><code>claude mcp add --transport http btw %s --header 'Authorization: Bearer btw_...'</code></pre>
<p>Without the header the read tools still work (check, fmt, share, open, render, list_examples, instruments);
compose, eval, load, get and stop need a token. Sign in on <a href="%s">%s</a> with a wallet or a browser key and press
<b>MCP token</b>. Other clients take the same URL and header:</p>
<pre><code>{ "mcpServers": { "btw": { "type": "http", "url": "%s",
    "headers": { "Authorization": "Bearer btw_..." } } } }</code></pre>
<h2>Tools (%d)</h2>
`, html.EscapeString(endpoint), html.EscapeString(s.public), html.EscapeString(s.public),
		html.EscapeString(s.public), html.EscapeString(s.public), html.EscapeString(endpoint),
		html.EscapeString(s.public), html.EscapeString(s.public), html.EscapeString(endpoint), len(names))

	for _, name := range names {
		t := tools[name].Tool
		fmt.Fprintf(&b, `<div class="tool"><span class="name">%s</span>`, html.EscapeString(name))
		if authTools[name] {
			b.WriteString(`<span class="auth">needs a token</span>`)
		}
		if t.Description != "" {
			fmt.Fprintf(&b, `<div class="desc">%s</div>`, html.EscapeString(t.Description))
		}
		if len(t.InputSchema.Properties) > 0 {
			req := map[string]bool{}
			for _, q := range t.InputSchema.Required {
				req[q] = true
			}
			pn := make([]string, 0, len(t.InputSchema.Properties))
			for p := range t.InputSchema.Properties {
				pn = append(pn, p)
			}
			sort.Strings(pn)
			b.WriteString(`<div class="params">`)
			for _, p := range pn {
				tag := ""
				if req[p] {
					tag = `<span class="req">required</span>`
				}
				desc := ""
				if prop, ok := t.InputSchema.Properties[p].(map[string]any); ok {
					if d, ok := prop["description"].(string); ok && d != "" {
						desc = " - " + html.EscapeString(d)
					}
				}
				fmt.Fprintf(&b, `<span class="param">%s</span>%s%s<br>`, html.EscapeString(p), tag, desc)
			}
			b.WriteString(`</div>`)
		}
		b.WriteString(`</div>`)
	}
	b.WriteString("</body></html>")
	_, _ = w.Write([]byte(b.String()))
}

// authTools are the tools that need a signed-in caller.
// get is one of them: the hub only lets an authenticated caller read a session (btwsite/DESIGN.md "Sessions":
// even an anonymous tab is reached with its id *and* a token).
var authTools = map[string]bool{"compose": true, "eval": true, "load": true, "get": true, "stop": true}

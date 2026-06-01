// HTTP (Streamable HTTP) transport for the MCP server, mirroring the
// petri-pilot pattern (cmd/petri-pilot/serve.go + pkg/mcp/openapi.go). Lets a
// remote Claude client drive a running -authoring server over HTTP at /mcp
// instead of spawning the `beats-bitwrap-io mcp` stdio subprocess.
//
//	claude mcp add --transport http beats-btw http://localhost:8089/mcp
//
// The same in-process MCP server proxies tool calls back to the host's own
// HTTP API (SetBaseURL), so it stays in sync with any connected browser
// clients exactly like the stdio transport does.
package mcp

import (
	"fmt"
	"html"
	"net/http"
	"sort"
	"time"

	"github.com/mark3labs/mcp-go/server"
)

// RegisterHTTP mounts the FULL MCP tool set (all control + share tools) on
// mux at /mcp. baseURL is the address the proxy tools call back into — pass
// the web server's own listen address when embedding ("http://127.0.0.1:8089").
// Use only on an -authoring server: the control tools target /api/*.
func RegisterHTTP(mux *http.ServeMux, baseURL string) {
	if baseURL != "" {
		SetBaseURL(baseURL)
	}
	mount(mux, NewServer())
}

// RegisterHTTPPublic mounts the curated, stateless PUBLIC tool set
// (generate_share, list_genres, get_song) — safe for a production host with
// no sequencer. loopbackURL is where generate_share PUTs (the host's own
// address); publicURL is the origin baked into returned ?cid= links.
func RegisterHTTPPublic(mux *http.ServeMux, loopbackURL, publicURL string) {
	if loopbackURL != "" {
		SetBaseURL(loopbackURL)
	}
	SetPublicURL(publicURL)
	mount(mux, NewPublicServer())
}

// mount wires a built MCP server onto /mcp (+ /mcp/) with a browser-GET
// landing page. Stateless transport: each request is independent (no session
// id) — simplest behind nginx, and these tools need no server-initiated
// notifications.
func mount(mux *http.ServeMux, s *server.MCPServer) {
	httpSrv := server.NewStreamableHTTPServer(s, server.WithStateLess(true))
	landing := landingPageHandler(s)
	mux.HandleFunc("/mcp", func(w http.ResponseWriter, r *http.Request) {
		// A plain browser GET (not an SSE handshake) gets a human-readable
		// page instead of a hung JSON-RPC stream. POST/DELETE and SSE GETs
		// fall through to the transport.
		if r.Method == http.MethodGet && r.Header.Get("Accept") != "text/event-stream" {
			landing(w, r)
			return
		}
		clearDeadlines(w)
		httpSrv.ServeHTTP(w, r)
	})
	mux.Handle("/mcp/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clearDeadlines(w)
		httpSrv.ServeHTTP(w, r)
	}))
}

// clearDeadlines drops the parent http.Server's read/write deadlines for this
// request so tool handlers that long-poll (e.g. generate_share with wait=true
// waiting on an off-host render farm) aren't killed by the 15s WriteTimeout.
// Mirrors the same trick the /audio/{cid}.webm handler uses for cold renders.
func clearDeadlines(w http.ResponseWriter) {
	if rc := http.NewResponseController(w); rc != nil {
		_ = rc.SetWriteDeadline(time.Time{})
		_ = rc.SetReadDeadline(time.Time{})
	}
}

func landingPageHandler(s *server.MCPServer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tools := s.ListTools()
		names := make([]string, 0, len(tools))
		for name := range tools {
			names = append(names, name)
		}
		sort.Strings(names)

		scheme := "http"
		if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
			scheme = "https"
		}
		url := fmt.Sprintf("%s://%s/mcp", scheme, r.Host)

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>beats-btw MCP Server</title>
<style>
 body{font-family:system-ui,sans-serif;max-width:860px;margin:2em auto;padding:0 1em;background:#0d1117;color:#c9d1d9}
 h1,h2{color:#58a6ff} a{color:#58a6ff}
 code{background:#30363d;padding:2px 6px;border-radius:3px;font-size:.9em}
 pre{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:12px 16px;overflow:auto}
 .tool{border:1px solid #30363d;border-radius:6px;padding:12px 16px;margin:10px 0;background:#161b22}
 .tool-name{font-family:monospace;font-weight:bold;color:#7ee787;font-size:1.05em}
 .tool-desc{color:#8b949e;margin-top:4px;font-size:.9em}
 .tool-params{margin-top:8px;font-size:.85em;line-height:1.7}
 .param{font-family:monospace;color:#d2a8ff}
 .required{color:#f85149;font-size:.75em;margin-left:4px}
</style></head><body>
<h1>beats-btw MCP Server</h1>
<p>This endpoint serves the <a href="https://modelcontextprotocol.io">Model Context Protocol</a> over Streamable HTTP at <code>%s</code>. Deterministic beats: a genre + seed regenerates byte-identical playback in the browser.</p>
<h2>Add to Claude Code</h2>
<pre><code>claude mcp add --transport http beats-btw %s</code></pre>
<p>Or add manually in <code>~/.claude.json</code> (user scope) or <code>.mcp.json</code> (project root):</p>
<pre><code>{
  "mcpServers": {
    "beats-btw": { "type": "http", "url": "%s" }
  }
}</code></pre>
<p>Then restart Claude Code. Other MCP clients (Claude Desktop, Cursor) accept the same <code>url</code>.</p>
<h2>Available Tools (%d)</h2>
`, url, url, url, len(names))

		for _, name := range names {
			tool := tools[name].Tool
			fmt.Fprintf(w, `<div class="tool"><span class="tool-name">%s</span>`, html.EscapeString(name))
			if tool.Description != "" {
				fmt.Fprintf(w, `<div class="tool-desc">%s</div>`, html.EscapeString(tool.Description))
			}
			if len(tool.InputSchema.Properties) > 0 {
				required := make(map[string]bool, len(tool.InputSchema.Required))
				for _, rq := range tool.InputSchema.Required {
					required[rq] = true
				}
				pnames := make([]string, 0, len(tool.InputSchema.Properties))
				for pn := range tool.InputSchema.Properties {
					pnames = append(pnames, pn)
				}
				sort.Strings(pnames)
				fmt.Fprint(w, `<div class="tool-params">`)
				for _, pn := range pnames {
					reqTag := ""
					if required[pn] {
						reqTag = `<span class="required">required</span>`
					}
					desc := ""
					if prop, ok := tool.InputSchema.Properties[pn].(map[string]interface{}); ok {
						if d, ok := prop["description"].(string); ok && d != "" {
							desc = " — " + html.EscapeString(d)
						}
					}
					fmt.Fprintf(w, `<span class="param">%s</span>%s%s<br>`, html.EscapeString(pn), reqTag, desc)
				}
				fmt.Fprint(w, `</div>`)
			}
			fmt.Fprint(w, `</div>`)
		}
		fmt.Fprint(w, "</body></html>")
	}
}

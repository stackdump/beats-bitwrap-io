package server

import (
	"html"
	"io"
	"net/http"
	"strings"

	"beats-bitwrap-io/internal/btwsite/api"
)

// contentLicense is the licence of everything the site generates or stores.
const contentLicense = "CC0-1.0"

// licenseHeaders marks the responses that carry generated work (programs, renders, compose answers) with
// their licence and where the privacy notice is, so a client that only sees the bytes still gets the terms.
func (s *Server) licenseHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if strings.HasPrefix(p, "/api/render/") || strings.HasPrefix(p, "/api/programs/") || p == "/api/compose" ||
			p == "/api/device/compose" || strings.HasPrefix(p, "/c/") {
			h := w.Header()
			h.Set("X-Content-License", contentLicense)
			h.Add("Link", "<"+s.cfg.PublicURL+"/privacy>; rel=\"privacy-policy\"")
			h.Add("Link", "<https://creativecommons.org/publicdomain/zero/1.0/>; rel=\"license\"")
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handlePrivacy(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = io.WriteString(w, strings.ReplaceAll(privacyHTML, "{{NOTICE}}", html.EscapeString(api.PublicNotice)))
}

const privacyHTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy and licence</title><link rel="stylesheet" href="/css/btw.css"></head>
<body><main class="pair-page">
<h1>Privacy and licence</h1>
<p><b>{{NOTICE}}</b></p>
<h2>What is public</h2>
<ul>
<li>Every program composed here (from the web page, an assistant over MCP, or a paired phone) is stored by its CID and is readable by anyone who has the CID or the link.</li>
<li>Its share links, its social card and every audio stream or render made from it are public too. Streams are generated on request from the stored program and are not private.</li>
<li>All of it is released under <a href="https://creativecommons.org/publicdomain/zero/1.0/">CC0 1.0</a>: no rights reserved. You waive yours on what you compose; so does everyone else.</li>
<li>A program marked <code>#! visibility: private</code>, or one that uses samples or <code>use restricted</code>, is never stored or shared by the site, and compose will not produce one.</li>
</ul>
<h2>What is not</h2>
<ul>
<li>Your sign-in key or wallet address is your account id. It is kept with your tokens and paired phones and is never shown with a program.</li>
<li>A phone's key never leaves the phone; the site keeps only its public half. Unpair from either side to delete the record.</li>
<li>Access logs hold a keyed hash of the address, not the address.</li>
</ul>
<h2>The model provider</h2>
<p>A compose prompt (and the program being edited) is sent to a third-party language model. Do not put anything private, personal or secret in a prompt.</p>
<p><a href="/">Back to the site</a></p>
</main></body></html>
`

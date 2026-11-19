package server

import (
	"net/http"
	"strings"
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

package server

import (
	"net/http"

	"beats-bitwrap-io/internal/btwsite/api"
	"beats-bitwrap-io/internal/btwsite/btwd"
)

// checkerOwner puts the client address on the request's context (btwd.WithOwner), so that whatever a handler
// asks of the checker (check, fmt, share, open, a card, a render's check, MCP and compose included) is charged to
// that address: at most a few calls in flight and a budget of checker seconds per address, instead of one address
// holding every slot with programs built to be slow. api.ResolveClientIP has already run, so the address is the
// real client's and the proxy headers are gone.
func (s *Server) checkerOwner(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r.WithContext(btwd.WithOwner(r.Context(), api.IPKey(ClientIP(r)))))
	})
}

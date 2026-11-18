package server

import (
	"errors"
	"net/http"

	"beats-bitwrap-io/internal/btwsite/api"
)

// extras holds the optional parts wired in wire(): what Close must stop.
type extras struct {
	closer any
}

// composeGate is the one door to compose: nothing reaches the compose handler without a signed-in user,
// whatever the handler itself does. 401 without credentials in every configuration.
func (s *Server) composeGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := s.requireUser(w, r); !ok {
			return
		}
		next.ServeHTTP(w, r)
	})
}

// mountCompose registers POST /api/compose behind the gate. It refuses to mount at all without an
// Authenticator: compose is never exposed unauthenticated, not even briefly.
func mountCompose(s *Server, mux *http.ServeMux, h http.Handler, authn api.Authenticator) error {
	if authn == nil {
		return errors.New("server: refusing to mount /api/compose without an Authenticator")
	}
	mux.Handle("POST /api/compose", s.composeGate(h))
	return nil
}

// wire mounts compose, the admin routes, MCP, docs and cards.
func (s *Server) wire(mux *http.ServeMux) error {
	notConf := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		api.WriteError(w, api.Errf(http.StatusServiceUnavailable, api.CodeNotConfigured, "compose is not configured on this server"))
	})
	return mountCompose(s, mux, notConf, s.authn)
}

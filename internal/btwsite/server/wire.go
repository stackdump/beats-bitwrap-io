package server

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"

	"beats-bitwrap-io/internal/btwsite/api"
	"beats-bitwrap-io/internal/btwsite/card"
	"beats-bitwrap-io/internal/btwsite/compose"
	"beats-bitwrap-io/internal/btwsite/docs"
	"beats-bitwrap-io/internal/btwsite/ld"
	"beats-bitwrap-io/internal/btwsite/limits"
	"beats-bitwrap-io/internal/btwsite/mcpsrv"
)

// extras is what wire() builds beyond the core routes.
type extras struct {
	closers []func()
	// injectMeta puts the generic share-card tags into the index page (set when the card service is wired).
	injectMeta func(doc []byte, origin, path string) []byte
}

// composeGate is the one door to compose: nothing reaches the compose handler without a signed-in user,
// whatever the handler itself does. 401 without credentials in every configuration, before anything about
// the service (configured or not, switched off or not) is said.
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

// wire mounts compose and its admin routes, MCP, docs and cards.
func (s *Server) wire(mux *http.ServeMux) error {
	cfg := s.cfg

	// compose
	csvc, err := compose.New(compose.Options{
		Checker: s.checker, Store: s, Examples: s.Examples, ExampleText: s.Example,
		DataDir: cfg.DataDir, PublicURL: cfg.PublicURL,
		Model: cfg.Model, APIKey: cfg.GeminiKey,
		Limits: limits.Config{UserHour: cfg.ComposeUserHour, UserDay: cfg.ComposeUserDay, IPDay: cfg.ComposeIPDay,
			DailySpendUSD: cfg.DailySpendUSD, PriceInPerM: cfg.PriceInPerM, PriceOutPerM: cfg.PriceOutPerM, DataDir: cfg.DataDir},
		MaxPromptChars: cfg.MaxPromptChars, MaxProgramBytes: cfg.MaxProgramBytes, MaxRepair: repairRounds(cfg.MaxRepair), MaxRefine: repairRounds(cfg.MaxRefine),
		Thinking: cfg.Thinking, Now: cfg.Now,
	})
	if err != nil {
		return err
	}
	// BTW_COMPOSE_ENABLED / -compose-enabled is the kill switch's starting position (the data dir's compose.off
	// and POST /api/admin/compose move it at run time). The flag was already merged with the environment.
	csvc.Limiter().SetGetenv(func(k string) string {
		if k == "BTW_COMPOSE_ENABLED" {
			if cfg.ComposeEnabled {
				return "1"
			}
			return "0"
		}
		return os.Getenv(k)
	})
	s.composer = csvc
	s.extras.closers = append(s.extras.closers, func() { _ = csvc.Close() })
	if err := mountCompose(s, mux, csvc.Handler(s.authn), s.authn); err != nil {
		return err
	}
	mux.Handle("/api/admin/", csvc.AdminHandler(cfg.AdminToken)) // closed (503) while BTW_ADMIN_TOKEN is empty
	if csvc.Status().Configured {
		s.bgWG.Add(1)
		go func() { // build the system prompt before the first user asks
			defer s.bgWG.Done()
			_ = csvc.Warm(s.bg)
		}()
	}

	// MCP (stateless streamable HTTP)
	mh := mcpsrv.Handler(s, s.authn, cfg.PublicURL,
		mcpsrv.WithClientIP(api.ClientIP), mcpsrv.WithMaxProgramBytes(cfg.MaxProgramBytes), mcpsrv.WithMaxPromptChars(cfg.MaxPromptChars))
	mux.Handle("/mcp", mh)
	mux.Handle("/mcp/", mh)

	// llms.txt, llms-full.txt, /docs/*
	if err := docs.Mount(mux, docs.Options{DocsDir: cfg.DocsDir, Checker: s.checker, Examples: s.Examples, ExampleText: s.Example, PublicURL: cfg.PublicURL}); err != nil {
		return err
	}

	// share cards and /c/ pages
	cs, err := card.New(card.Options{Checker: s.checker, Store: s, Examples: s.Examples, ExampleText: s.Example, PublicURL: cfg.PublicURL,
		CacheDir: filepath.Join(cfg.DataDir, "cards"), WebDir: cfg.WebDir})
	if err != nil {
		return err
	}
	cs.Mount(mux)
	ld.Mount(mux)
	s.extras.injectMeta = card.InjectGeneric
	return nil
}

func repairRounds(n int) int {
	if n <= 0 {
		return -1 // compose: negative = none (zero would mean its default of 3)
	}
	return n
}

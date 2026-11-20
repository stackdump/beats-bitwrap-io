package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
	"beats-bitwrap-io/internal/btwsite/auth"
	"beats-bitwrap-io/internal/btwsite/btwd"
)

// Server is the whole service. It implements api.Backend (what the MCP server is built over).
type Server struct {
	api.Checker // the btwd subprocess (or a fake)

	cfg      Config
	started  time.Time
	checker  api.Checker
	renderer btwd.Renderer
	authn    api.Authenticator
	authSvc  *auth.Service // nil when the Authenticator was injected
	store    *programStore
	examples *exampleSet
	hub      *hub
	pair     *pairing // paired phones (pair.go)
	siteID   string   // the stable identity of this site (site.go)
	rs       *renderService
	log      *accessLog
	composer api.Composer // never nil: a stub says "not configured" when compose is not wired
	extras   extras

	checkIP   *ipLimiter
	putIP     *ipLimiter
	shareAcct *ipLimiter // PUT /api/shares per account (the key is the account id, not an address)
	sessionIP *ipLimiter
	pairIP    *ipLimiter
	claimIP   *ipLimiter
	authIP    map[string]*ipLimiter

	checkMu      sync.Mutex
	checkCache   map[string]*api.CheckReport // by CID: stored programs are immutable
	checkOrder   []string
	closing      chan struct{}
	closeOnce    sync.Once
	cancelBg     context.CancelFunc
	bg           context.Context
	bgWG         sync.WaitGroup
	handler      http.Handler
	warnings     []string
	instrumentsB json.RawMessage
}

var _ api.Backend = (*Server)(nil)

func (s *Server) now() time.Time { return s.cfg.Now() }

// New builds everything and returns the Server; Handler() is its http.Handler.
func New(cfg Config) (*Server, error) {
	def := DefaultConfig()
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.SSEPing <= 0 {
		cfg.SSEPing = 20 * time.Second
	}
	if cfg.Logf == nil {
		cfg.Logf = log.Printf
	}
	if cfg.DataDir == "" {
		return nil, errors.New("server: DataDir is required")
	}
	if cfg.PublicURL == "" {
		cfg.PublicURL = def.PublicURL
	}
	if cfg.MaxProgramBytes == 0 {
		cfg.MaxProgramBytes = def.MaxProgramBytes
	}
	for _, d := range []struct {
		p *int
		v int
	}{{&cfg.RenderConcurrency, def.RenderConcurrency}, {&cfg.RenderMaxBars, def.RenderMaxBars}, {&cfg.RenderCacheMB, def.RenderCacheMB},
		{&cfg.StoreMaxMB, def.StoreMaxMB}, {&cfg.RenderIPHour, def.RenderIPHour}, {&cfg.PutIPHour, def.PutIPHour}, {&cfg.ShareHour, def.ShareHour}, {&cfg.CheckIPMin, def.CheckIPMin}} {
		if *d.p == 0 {
			*d.p = d.v
		}
	}
	if cfg.FFmpeg == "" {
		cfg.FFmpeg = "ffmpeg"
	}
	cfg.PublicURL = strings.TrimRight(cfg.PublicURL, "/")
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return nil, err
	}

	s := &Server{cfg: cfg, started: cfg.Now(), closing: make(chan struct{}), checkCache: map[string]*api.CheckReport{}}

	// the Rust side
	s.checker = cfg.Checker
	if s.checker == nil {
		c, err := btwd.New(cfg.BtwdBin, cfg.BtwdOptions)
		if err != nil {
			return nil, err
		}
		pctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		err = c.Ping(pctx)
		cancel()
		if err != nil {
			return nil, fmt.Errorf("btwd (%s) does not answer `btwd instruments`: %v", c.Bin(), err)
		}
		s.checker = c
		if cfg.Renderer == nil {
			cfg.Renderer = c
		}
	}
	s.Checker = s.checker
	s.renderer = cfg.Renderer
	if s.renderer == nil {
		s.renderer = noRenderer{}
	}
	s.cfg = cfg

	// identity
	logKey := []byte(fmt.Sprintf("btw-log-ip-v1:%d:%d", os.Getpid(), cfg.Now().UnixNano()))
	if cfg.Authenticator != nil {
		s.authn = cfg.Authenticator
	} else {
		secret, err := auth.LoadSecret(cfg.DataDir, cfg.SessionSecret)
		if err != nil {
			return nil, err
		}
		logKey = append([]byte("btw-log-ip-v1:"), secret...)
		svc, err := auth.New(auth.Options{DataDir: cfg.DataDir, Secret: secret, Secure: cfg.secureCookie(), Origin: cfg.PublicURL, AltHosts: altHosts(cfg.AltOrigins),
			Now: cfg.Now, Allow: s.authAllow})
		if err != nil {
			return nil, err
		}
		s.authSvc, s.authn = svc, svc
	}

	// limits
	s.checkIP = newIPLimiter(cfg.CheckIPMin, time.Minute, cfg.Now)
	s.putIP = newIPLimiter(cfg.PutIPHour, time.Hour, cfg.Now)
	s.shareAcct = newIPLimiter(cfg.ShareHour, time.Hour, cfg.Now)
	s.sessionIP = newIPLimiter(120, time.Hour, cfg.Now)
	s.pairIP = newIPLimiter(20, time.Minute, cfg.Now)
	s.claimIP = newIPLimiter(20, time.Minute, cfg.Now)
	s.authIP = map[string]*ipLimiter{
		"challenge": newIPLimiter(30, time.Minute, cfg.Now),
		"login":     newIPLimiter(20, time.Minute, cfg.Now),
		"token":     newIPLimiter(10, time.Minute, cfg.Now),
	}

	// stores
	var err error
	s.store, err = newProgramStore(filepath.Join(cfg.DataDir, "programs"), s.checker, cfg.MaxProgramBytes, int64(cfg.StoreMaxMB)<<20, cfg.Now)
	if err != nil {
		return nil, err
	}
	s.examples, s.warnings, err = loadExamples(cfg.ExamplesDir, s.checker)
	if err != nil {
		return nil, err
	}
	s.siteID, err = loadSite(cfg.DataDir, cfg.SiteID)
	if err != nil {
		return nil, err
	}
	s.hub = newHub(cfg.Now)
	s.pair, err = newPairing(cfg.DataDir, cfg.Now)
	if err != nil {
		return nil, err
	}
	bg, cancel := context.WithCancel(context.Background())
	s.cancelBg, s.bg = cancel, bg
	go s.hub.sweeper(bg)
	s.rs, err = newRenderService(s, bg)
	if err != nil {
		cancel()
		return nil, err
	}
	s.log, err = newAccessLog(filepath.Join(cfg.DataDir, "log"), cfg.Now, logKey)
	if err != nil {
		cancel()
		return nil, err
	}

	// compose, MCP, docs, cards
	s.composer = notConfiguredComposer{}
	mux := http.NewServeMux()
	s.routes(mux)
	if err := s.wire(mux); err != nil {
		cancel()
		return nil, err
	}
	s.handler = s.middleware(mux)
	return s, nil
}

// Handler is the whole site.
func (s *Server) Handler() http.Handler { return s.handler }

// Warnings are non-fatal start-up findings (an example left out, ...), for the log.
func (s *Server) Warnings() []string { return s.warnings }

// Close stops background work: SSE streams end, running renders are killed, the log is flushed. Call it after
// http.Server.Shutdown (or instead, in tests).
func (s *Server) Close() {
	s.closeOnce.Do(func() {
		close(s.closing)
		s.hub.closeAll()
		s.rs.shutdown()
		s.cancelBg()
		s.bgWG.Wait()
		s.log.Close()
		for _, f := range s.extras.closers {
			f()
		}
	})
}

// authAllow is the rate-limit hook of the auth service.
func (s *Server) authAllow(r *http.Request, bucket string) (bool, int) {
	if l := s.authIP[bucket]; l != nil {
		return l.Allow(ClientIP(r))
	}
	return true, 0
}

// ---------- routes ----------

func (s *Server) routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("GET /api/info", s.handleInfo)
	mux.HandleFunc("GET /.well-known/btw-site", s.handleSiteDoc)
	mux.HandleFunc("GET /api/examples", s.handleExamples)
	mux.HandleFunc("GET /examples/{name}", s.handleExampleFile)
	mux.HandleFunc("GET /api/instruments", s.handleInstruments)
	mux.HandleFunc("POST /api/check", s.handleCheck)
	mux.HandleFunc("POST /api/fmt", s.handleFmt)
	mux.HandleFunc("GET /.well-known/assetlinks.json", s.handleAssetLinks)
	mux.HandleFunc("POST /api/qr", s.handleQR)
	mux.HandleFunc("POST /api/share", s.handleShare)
	mux.HandleFunc("POST /api/open", s.handleOpen)
	mux.HandleFunc("PUT /api/programs/{cid}", s.handlePutProgram)
	mux.HandleFunc("GET /api/programs/{cid}", s.handleGetProgram)
	mux.HandleFunc("PUT /api/shares/{cid}", s.handlePutShare)
	mux.HandleFunc("GET /api/render/{cid}", s.handleRender)
	mux.HandleFunc("GET /api/render/{cid}/status", s.handleRenderStatus)
	mux.HandleFunc("POST /api/session", s.handleSessionCreate)
	mux.HandleFunc("GET /api/session/{id}/events", s.handleSessionEvents)
	mux.HandleFunc("POST /api/session/{id}/report", s.handleSessionReport)
	mux.HandleFunc("POST /api/session/{id}/reply", s.handleSessionReply)
	s.pairRoutes(mux)
	if s.authSvc != nil {
		s.authSvc.Mount(mux)
	}
	mux.HandleFunc("/", s.handleStatic) // everything else: the static site, 404 otherwise
}

// ---------- shared helpers ----------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// decodeBody reads a JSON body of at most max bytes into v, answering the error itself.
func decodeBody(w http.ResponseWriter, r *http.Request, max int64, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, max)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			api.WriteError(w, api.Errf(http.StatusRequestEntityTooLarge, api.CodeTooLarge, "request body is over %d bytes", max))
		} else {
			api.WriteError(w, api.Errf(http.StatusBadRequest, api.CodeBadRequest, "the body must be JSON: %v", err))
		}
		return false
	}
	return true
}

// userOrAnon is who the request is from, or nil: a missing or bad credential is just anonymous here (the
// routes that need a user use requireUser).
func (s *Server) userOrAnon(r *http.Request) *api.User {
	u, err := s.authn.UserFrom(r)
	if err != nil {
		u = nil
	}
	if ri := infoOf(r); ri != nil && u != nil {
		ri.user = u.ID
	}
	return u
}

// requireUser is the gate for anything that needs a signed-in caller: 401 with the auth error otherwise.
func (s *Server) requireUser(w http.ResponseWriter, r *http.Request) (*api.User, bool) {
	u, err := s.authn.UserFrom(r)
	if err != nil {
		if _, typed := err.(*api.Error); !typed { // an Authenticator that says it badly is still a 401
			err = api.Errf(http.StatusUnauthorized, api.CodeAuthRequired, "authentication failed")
		}
		api.WriteError(w, err)
		return nil, false
	}
	if u == nil {
		api.WriteError(w, api.Errf(http.StatusUnauthorized, api.CodeAuthRequired, "authentication required: %s", s.AuthHelp()))
		return nil, false
	}
	if ri := infoOf(r); ri != nil {
		ri.user = u.ID
	}
	return u, true
}

// asAPIError turns a checker or store failure into the typed error HTTP answers with.
func (s *Server) asAPIError(err error) error {
	var ae *api.Error
	if errors.As(err, &ae) {
		return ae
	}
	s.cfg.Logf("btwsite: internal error: %v", err)
	return api.Errf(http.StatusBadGateway, "checker_error", "the checker failed; try again")
}

// ---------- api.Backend ----------

func (s *Server) Put(ctx context.Context, text string, meta api.Meta) (*api.Program, *api.CheckReport, error) {
	return s.store.Put(ctx, text, meta)
}

// Get finds a program among the public examples, then in the store. The examples come first: anyone may PUT
// an example's text before it is asked for (its CID is public), and first meta wins in the store, so a stored copy
// must not be able to give an example another name, licence or provenance.
func (s *Server) Get(cid string) (*api.Program, bool) {
	if p, ok := s.examples.byCID[cid]; ok {
		cp := p
		return &cp, true
	}
	return s.store.Get(cid)
}

func (s *Server) Push(u *api.User, sessionID string, ev api.SessionEvent) (int, error) {
	return s.hub.Push(u, sessionID, ev)
}

func (s *Server) State(ctx context.Context, u *api.User, sessionID string) (*api.SessionState, error) {
	return s.hub.State(ctx, u, sessionID)
}

func (s *Server) Sessions(u *api.User) []api.SessionInfo { return s.hub.Sessions(u) }

func (s *Server) Compose(ctx context.Context, u *api.User, ip string, req api.ComposeRequest) (*api.ComposeResult, error) {
	if u == nil {
		return nil, api.Errf(http.StatusUnauthorized, api.CodeAuthRequired, "composing needs a signed-in caller: %s", s.AuthHelp())
	}
	return s.composer.Compose(ctx, u, ip, req)
}

func (s *Server) Status() api.ComposeStatus { return s.composer.Status() }

func (s *Server) Examples() []api.Example { return s.examples.list }

func (s *Server) Example(name string) (string, bool) {
	t, ok := s.examples.text[name]
	return t, ok
}

func (s *Server) PublicURL() string { return s.cfg.PublicURL }

func (s *Server) AuthHelp() string {
	return "sign in at " + s.cfg.PublicURL + " (wallet or browser key), press \"MCP token\", and send it as `Authorization: Bearer btw_…`"
}

// RenderInfo says where the stream is and how long the program is (0 when unknown).
func (s *Server) RenderInfo(cid, format string) (streamURL, statusURL string, seconds float64) {
	if format != "wav" && s.rs.ffmpegOK() {
		format = "opus"
	} else {
		format = "wav" // no ffmpeg with libopus here: the URL must be one that works
	}
	streamURL = fmt.Sprintf("%s/api/render/%s?format=%s&v=%s", s.cfg.PublicURL, cid, format, api.RenderVersion)
	statusURL = fmt.Sprintf("%s/api/render/%s/status", s.cfg.PublicURL, cid)
	if p, ok := s.Get(cid); ok {
		if rep, err := s.programReport(context.Background(), p); err == nil && rep.Seconds != nil {
			seconds = *rep.Seconds
		}
	}
	return
}

// programReport is the check of a stored program, kept by CID (programs are immutable).
func (s *Server) programReport(ctx context.Context, p *api.Program) (*api.CheckReport, error) {
	s.checkMu.Lock()
	rep, ok := s.checkCache[p.CID]
	s.checkMu.Unlock()
	if ok {
		return rep, nil
	}
	rep, err := s.checker.Check(ctx, p.Text)
	if err != nil {
		return nil, err
	}
	s.checkMu.Lock()
	if len(s.checkOrder) >= 256 {
		delete(s.checkCache, s.checkOrder[0])
		s.checkOrder = s.checkOrder[1:]
	}
	s.checkCache[p.CID] = rep
	s.checkOrder = append(s.checkOrder, p.CID)
	s.checkMu.Unlock()
	return rep, nil
}

type noRenderer struct{}

func (noRenderer) StartRender(context.Context, string, btwd.RenderOptions) (*btwd.RenderProc, error) {
	return nil, api.Errf(http.StatusServiceUnavailable, api.CodeNotConfigured, "rendering is not available on this server")
}

// ---------- compose that is not wired ----------

type notConfiguredComposer struct{}

func (notConfiguredComposer) Compose(context.Context, *api.User, string, api.ComposeRequest) (*api.ComposeResult, error) {
	return nil, api.Errf(http.StatusServiceUnavailable, api.CodeNotConfigured, "compose is not configured on this server")
}

func (notConfiguredComposer) Status() api.ComposeStatus {
	return api.ComposeStatus{Reason: "compose is not configured on this server"}
}

// ---------- middleware ----------

func (s *Server) middleware(next http.Handler) http.Handler {
	h := s.recoverer(s.securityHeaders(s.licenseHeaders(s.corsReadOnly(s.checkerOwner(next)))))
	h = s.log.middleware(h)
	return api.ResolveClientIP(h)
}

func (s *Server) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				if v == http.ErrAbortHandler {
					panic(v) // a deliberately aborted stream
				}
				s.cfg.Logf("btwsite: panic serving %s %s: %v\n%s", r.Method, r.URL.Path, v, debug.Stack())
				api.WriteError(w, api.Errf(http.StatusInternalServerError, "internal", "internal error"))
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// CSP (SEC-3): the page's own scripts and wasm (the engine; 'wasm-unsafe-eval' only), same-origin workers and
// worklets, no inline script, no inline style markup (the page uses CSSOM, which CSP does not block), no blob: or
// data: scripts, no framing. The browser smoke run passes under exactly this policy (btwsite/test/smoke.mjs --strict-csp).
const contentSecurityPolicy = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; " +
	"style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; " +
	"font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	hsts := s.cfg.secureCookie()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Content-Security-Policy", contentSecurityPolicy) // a handler may replace it (the share pages)
		h.Set("X-Frame-Options", "DENY")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
		if hsts {
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		next.ServeHTTP(w, r)
	})
}

// publicRead is the set of read-only GETs that may be fetched cross-origin (by other pages, by
// <audio crossorigin>, by MCP clients in a browser). Nothing with a cookie or a write is on it.
func publicRead(path string) bool {
	switch path {
	case "/healthz", "/api/info", "/api/examples", "/api/instruments", "/llms.txt", "/llms-full.txt":
		return true
	}
	for _, p := range []string{"/examples/", "/docs/", "/card/", "/api/programs/", "/api/render/"} {
		if strings.HasPrefix(path, p) {
			return true
		}
	}
	return false
}

func (s *Server) corsReadOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if publicRead(r.URL.Path) && r.Header.Get("Origin") != "" {
			h := w.Header()
			switch r.Method {
			case http.MethodGet, http.MethodHead:
				h.Set("Access-Control-Allow-Origin", "*")
				h.Set("Access-Control-Expose-Headers", "X-Btw-Cid, X-Btw-Seconds, X-Btw-Cache, Content-Length, Content-Range, Accept-Ranges, ETag, Retry-After")
			case http.MethodOptions:
				h.Set("Access-Control-Allow-Origin", "*")
				h.Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
				h.Set("Access-Control-Allow-Headers", "Range, If-None-Match")
				h.Set("Access-Control-Max-Age", "86400")
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// SameAs is the checker's (btwd's `same-as`), when it has one: a fake checker without it answers not_configured.
func (s *Server) SameAs(ctx context.Context, a, b string) (json.RawMessage, error) {
	if sa, ok := s.Checker.(api.SameAser); ok {
		return sa.SameAs(ctx, a, b)
	}
	return nil, api.Errf(503, api.CodeNotConfigured, "this checker cannot compare programs (same_as needs the btwd binary)")
}

package main

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"beats-bitwrap-io/internal/audiorender"
	mcpserver "beats-bitwrap-io/internal/mcp"
	"beats-bitwrap-io/internal/midiout"
	"beats-bitwrap-io/internal/pflow"
	"beats-bitwrap-io/internal/routes"
	"beats-bitwrap-io/internal/sequencer"
	"beats-bitwrap-io/internal/share"
	"beats-bitwrap-io/internal/ws"
)

//go:embed public/*
var publicFS embed.FS

// version is set via -ldflags "-X main.version=..." by the Makefile
// (git describe --tags --always --dirty). Local `go run` without the
// Makefile leaves it at "dev".
var version = "dev"

func main() {
	// MCP stdio subcommand — Claude Code / Claude Desktop wire
	// `./beats-bitwrap-io mcp` as an MCP server that speaks to the
	// HTTP server this binary runs in parallel (when started with
	// -authoring). Keeps the argv shape that petri-note used.
	if len(os.Args) > 1 && os.Args[1] == "mcp" {
		if err := mcpserver.Serve(); err != nil {
			fmt.Fprintf(os.Stderr, "MCP error: %v\n", err)
			os.Exit(1)
		}
		return
	}

	// --- Flags shared across production + authoring modes ---
	addr := flag.String("addr", ":8089", "listen address")
	dir := flag.String("public", "", "serve from disk instead of embedded files")
	dataDir := flag.String("data", "./data", "content-addressed share store directory")
	maxStoreBytes := flag.Int64("max-store-bytes", 256<<20, "hard cap on total share-store bytes on disk")
	putPerMin := flag.Int("put-per-min", 10, "per-IP PUT rate limit (requests per minute)")
	globalPutPerMin := flag.Int("global-put-per-min", 120, "global PUT rate limit across all IPs (0 = disabled)")

	// --- Server-side audio render flags ---
	audioEnabled := flag.Bool("audio-render", false, "Enable /audio/{cid}.webm endpoint (requires headless Chromium on PATH).")
	audioBaseURL := flag.String("audio-base-url", "", "Base URL the headless browser navigates to for renders (e.g. http://127.0.0.1:8089). Defaults to http://127.0.0.1{addr}.")
	audioPublicURL := flag.String("audio-public-url", "", "Public origin baked into rendered .webm metadata (e.g. https://beats.bitwrap.io). Defaults to -audio-base-url.")
	audioMaxBytes := flag.Int64("audio-max-bytes", 4<<30, "LRU cap on the audio cache directory.")
	audioConcurrent := flag.Int("audio-concurrent", 1, "Max simultaneous audio renders (each spawns a headless Chromium tab).")
	audioChromePath := flag.String("audio-chrome", "", "Path to chromium/chrome binary. Empty = chromedp autodetect.")
	audioMaxDuration := flag.Duration("audio-max-duration", 3*time.Minute, "Cap on audio length per render. 0 = unbounded (still subject to -audio-render-timeout).")
	audioRenderTimeout := flag.Duration("audio-render-timeout", 10*time.Minute, "Hard kill timer per render (covers stuck browsers / hung devices). Should comfortably exceed -audio-max-duration.")
	audioAutoEnqueue := flag.Bool("audio-auto-enqueue", true, "Pre-render newly sealed CIDs in the background so listeners hit a warm cache.")

	// --- Authoring-mode flags (ignored when -authoring is false) ---
	authoring := flag.Bool("authoring", false, "Local authoring mode: enables /api/* sequencer routes, /ws, and server-side MIDI output. Production beats.bitwrap.io runs without this flag.")
	midiPort := flag.String("midi", "", "Send MIDI to this output port (substring match, e.g. 'IAC'). Requires -authoring.")
	midiVirtual := flag.Bool("midi-virtual", false, "If -midi is set and no port matches, create a virtual port with that name.")
	midiPerNet := flag.Bool("midi-per-net", false, "Create one virtual MIDI port per net (e.g. 'petri-note-kick'). Requires -authoring.")
	midiPrefix := flag.String("midi-prefix", "petri-note", "Prefix for per-net virtual port names (used with -midi-per-net).")
	midiFanout := flag.String("midi-fanout", "", "Open all existing MIDI output ports with this prefix and round-robin nets across them.")
	midiList := flag.Bool("midi-list", false, "List available MIDI output ports and exit (no server starts).")
	flag.Parse()

	if *midiList {
		ports, err := midiout.ListPorts()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error listing MIDI ports: %v\n", err)
			os.Exit(1)
		}
		if len(ports) == 0 {
			fmt.Println("No MIDI output ports available.")
			return
		}
		fmt.Println("MIDI output ports:")
		for _, p := range ports {
			fmt.Printf("  %s\n", p)
		}
		return
	}

	// --- Static files + share store (both modes) ---
	var staticHandler http.Handler
	var publicSub fs.FS
	if *dir != "" {
		fileHandler := http.FileServer(http.Dir(*dir))
		staticHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
			w.Header().Set("Pragma", "no-cache")
			fileHandler.ServeHTTP(w, r)
		})
		log.Printf("Serving from disk: %s (no-cache dev mode)", *dir)
	} else {
		sub, err := fs.Sub(publicFS, "public")
		if err != nil {
			log.Fatal(err)
		}
		publicSub = sub
		staticHandler = http.FileServer(http.FS(sub))
		log.Printf("Serving embedded files")
	}

	shareStore, err := share.NewStore(*dataDir, *maxStoreBytes, *putPerMin, *globalPutPerMin)
	if err != nil {
		log.Fatalf("share store init: %v", err)
	}
	log.Printf("Share store: %s (cap %d bytes, %d PUT/min/IP, %d PUT/min global)",
		*dataDir, *maxStoreBytes, *putPerMin, *globalPutPerMin)

	share.GoogleAnalyticsID = os.Getenv("GOOGLE_ANALYTICS_ID")
	if share.GoogleAnalyticsID != "" {
		log.Printf("Google Analytics: %s", share.GoogleAnalyticsID)
	}

	decorated := share.DecoratedIndex(shareStore, publicSub, *dir)
	rootHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			decorated.ServeHTTP(w, r)
			return
		}
		staticHandler.ServeHTTP(w, r)
	})

	mux := http.NewServeMux()
	mux.HandleFunc("/version", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte(version))
	})
	mux.Handle("/o/", shareStore)
	mux.HandleFunc("/schema/beats-share", share.HandleBeatsShareSchema)
	svgCard := share.HandleShareCard(shareStore)
	pngCard := share.HandleShareCardPNG(shareStore)
	mux.Handle("/share-card/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".png") {
			pngCard.ServeHTTP(w, r)
			return
		}
		svgCard.ServeHTTP(w, r)
	}))
	mux.Handle("/qr", share.HandleQRCode())

	// --- Server-side audio render (production-safe; not authoring-gated) ---
	if *audioEnabled {
		base := *audioBaseURL
		if base == "" {
			base = "http://127.0.0.1" + *addr
		}
		publicURL := *audioPublicURL
		if publicURL == "" {
			publicURL = base
		}
		// LookupMetadata pulls the share envelope and projects it into
		// Matroska tags. Title falls back to "{Genre} · {seed}" when
		// the payload has no name field (legacy hand-authored shares).
		// Comment is the canonical share URL so a downloaded .webm is
		// self-locating.
		lookupMD := func(cid string) audiorender.Metadata {
			raw, err := shareStore.Lookup(cid)
			if err != nil {
				return audiorender.Metadata{}
			}
			var p struct {
				Genre string `json:"genre"`
				Name  string `json:"name"`
				Seed  int64  `json:"seed"`
			}
			if err := json.Unmarshal(raw, &p); err != nil {
				return audiorender.Metadata{}
			}
			title := p.Name
			if title == "" && p.Genre != "" {
				title = fmt.Sprintf("%s · %d", p.Genre, p.Seed)
			}
			return audiorender.Metadata{
				Title:     title,
				Artist:    "beats.bitwrap.io",
				Album:     "beats.bitwrap.io",
				Genre:     p.Genre,
				Comment:   fmt.Sprintf("%s/?cid=%s", publicURL, cid),
				Date:      time.Now().UTC().Format("2006-01-02"),
				Copyright: "CC BY 4.0 — beats.bitwrap.io",
				License:   "https://creativecommons.org/licenses/by/4.0/",
			}
		}
		ar, err := audiorender.New(audiorender.Config{
			CacheDir:       filepath.Join(*dataDir, "audio"),
			BaseURL:        base,
			MaxBytes:       *audioMaxBytes,
			MaxConcurrent:  *audioConcurrent,
			RenderTimeout:  *audioRenderTimeout,
			MaxDuration:    *audioMaxDuration,
			ChromePath:     *audioChromePath,
			LookupMetadata: lookupMD,
		})
		if err != nil {
			log.Fatalf("audio renderer: %v", err)
		}
		log.Printf("Audio render: ON (cache %s, base %s, cap %d bytes, %d concurrent, max %s/render, kill at %s)",
			filepath.Join(*dataDir, "audio"), base, *audioMaxBytes, *audioConcurrent,
			*audioMaxDuration, *audioRenderTimeout)
		mux.Handle("/audio/", audioHandler(ar, shareStore, staticHandler))
		mux.HandleFunc("/api/audio-status", audioStatusHandler(ar))
		if *audioAutoEnqueue {
			// Auto-enqueue from the seal hook can't know the track length —
			// use the renderer's fallback estimate.
			shareStore.OnSeal(func(cid string) { ar.Enqueue(cid, 0) })
			log.Printf("Audio render: auto-enqueue on PUT /o/{cid} ON")
		}
	}

	// --- Authoring-only wiring ---
	var (
		seq        *sequencer.Sequencer
		midiOut    *midiout.Output
		midiMulti  *midiout.MultiOutput
		midiFanOut *midiout.FanoutOutput
	)
	if *authoring {
		seq = sequencer.New()
		hub := ws.NewHub(seq)
		go hub.Run()
		routes.WireCallbacks(seq, hub)

		midiOut, midiMulti, midiFanOut = setupMIDI(
			seq, *midiPort, *midiVirtual,
			*midiPerNet, *midiPrefix, *midiFanout,
		)

		// Register /api/*, /ws, and (re-)register / via routes.Register.
		// Share routes already on the mux take precedence via longest-
		// prefix match (e.g. /o/, /share-card/, /schema/beats-share, /qr).
		routes.NewServer(seq, hub).RegisterRoutes(mux, rootHandler)

		// /api/project-share + /api/mirror-cid — seal local projects as
		// share-v1 envelopes with raw nets, optionally mirrored to remote
		// stores in the same call. See CLAUDE.md for the agent recipe.
		mux.HandleFunc("/api/project-share", projectShareHandler(seq, shareStore))
		mux.HandleFunc("/api/mirror-cid", mirrorCIDHandler(shareStore))

		// MIDI routing introspection.
		mux.HandleFunc("/api/midi-routing", midiRoutingHandler(midiOut, midiMulti, midiFanOut))
	} else {
		// Production mode: the share routes above + root handler are it.
		mux.Handle("/", rootHandler)
		// Warn if any authoring-mode flag was passed without -authoring.
		if *midiPort != "" || *midiPerNet || *midiFanout != "" {
			log.Printf("WARN: -midi/-midi-per-net/-midi-fanout ignored; pass -authoring to enable.")
		}
	}

	// CORS wrap (unchanged from previous beats-bitwrap-io behavior).
	cors := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == "OPTIONS" {
			return
		}
		mux.ServeHTTP(w, r)
	})

	server := &http.Server{
		Addr:         *addr,
		Handler:      cors,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		if *authoring {
			log.Printf("Authoring mode ON: /api/*, /ws, MIDI flags active")
		}
		log.Printf("Listening on %s", *addr)
		fmt.Printf("beats-bitwrap-io → http://localhost%s\n", *addr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}()
	<-ctx.Done()
	log.Println("Shutting down...")

	if seq != nil {
		seq.Stop()
	}
	for _, closer := range []io.Closer{midiOutCloser(midiOut), midiMultiCloser(midiMulti), midiFanOutCloser(midiFanOut)} {
		if closer == nil {
			continue
		}
		if err := closer.Close(); err != nil {
			log.Printf("MIDI close error: %v", err)
		}
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Printf("Shutdown error: %v", err)
	}
	log.Println("Server stopped")
}

// --- setupMIDI wires the sequencer's fired-transition + playback-
// complete callbacks to whichever MIDI mode the user requested. Exactly
// one of {single, per-net, fanout} may be active; more than one is a
// fatal config. Mirrors petri-note's historical behaviour verbatim.
func setupMIDI(seq *sequencer.Sequencer, port string, virtual, perNet bool, prefix, fanout string) (*midiout.Output, *midiout.MultiOutput, *midiout.FanoutOutput) {
	modes := 0
	if port != "" {
		modes++
	}
	if perNet {
		modes++
	}
	if fanout != "" {
		modes++
	}
	if modes > 1 {
		log.Fatalf("MIDI output: -midi, -midi-per-net, -midi-fanout are mutually exclusive")
	}
	var (
		single *midiout.Output
		multi  *midiout.MultiOutput
		fan    *midiout.FanoutOutput
	)
	if port != "" {
		out, err := midiout.Open(port, virtual)
		if err != nil {
			log.Fatalf("MIDI output: %v", err)
		}
		single = out
		log.Printf("MIDI output: sending to %q (multi-channel)", out.PortName())
		prevFired := seq.OnTransitionFired
		seq.OnTransitionFired = func(netId, transId string, m *pflow.MidiBinding) {
			if prevFired != nil {
				prevFired(netId, transId, m)
			}
			single.Send(m)
		}
		prevComplete := seq.OnPlaybackComplete
		seq.OnPlaybackComplete = func() {
			single.AllNotesOff()
			if prevComplete != nil {
				prevComplete()
			}
		}
	}
	if fanout != "" {
		f, err := midiout.NewFanoutByPrefix(fanout)
		if err != nil {
			log.Fatalf("MIDI output: %v", err)
		}
		fan = f
		log.Printf("MIDI output: fanout across %d ports: %v", len(fan.PortNames()), fan.PortNames())
		prevFired := seq.OnTransitionFired
		seq.OnTransitionFired = func(netId, transId string, m *pflow.MidiBinding) {
			if prevFired != nil {
				prevFired(netId, transId, m)
			}
			fan.Send(netId, m)
		}
		prevSwapped := seq.OnProjectSwapped
		seq.OnProjectSwapped = func(project map[string]interface{}) {
			if prevSwapped != nil {
				prevSwapped(project)
			}
			fan.PreAssign(collectNetIds(project))
		}
		prevComplete := seq.OnPlaybackComplete
		seq.OnPlaybackComplete = func() {
			fan.AllNotesOff()
			if prevComplete != nil {
				prevComplete()
			}
		}
	}
	if perNet {
		m, err := midiout.NewMulti(prefix)
		if err != nil {
			log.Fatalf("MIDI output: %v", err)
		}
		multi = m
		log.Printf("MIDI output: per-net mode, virtual ports prefixed %q-<netId>", prefix)
		prevFired := seq.OnTransitionFired
		seq.OnTransitionFired = func(netId, transId string, m *pflow.MidiBinding) {
			if prevFired != nil {
				prevFired(netId, transId, m)
			}
			multi.Send(netId, m)
		}
		prevComplete := seq.OnPlaybackComplete
		seq.OnPlaybackComplete = func() {
			multi.AllNotesOff()
			if prevComplete != nil {
				prevComplete()
			}
		}
	}
	return single, multi, fan
}

// collectNetIds returns every netId in the project that has a track
// (i.e. actually produces MIDI). Control-only nets without a track
// channel are skipped so fanout doesn't waste a bus slot on them.
func collectNetIds(project map[string]interface{}) []string {
	if project == nil {
		return nil
	}
	nets, _ := project["nets"].(map[string]interface{})
	out := make([]string, 0, len(nets))
	for netId, raw := range nets {
		net, _ := raw.(map[string]interface{})
		if net == nil {
			continue
		}
		if _, hasTrack := net["track"].(map[string]interface{}); !hasTrack {
			continue
		}
		out = append(out, netId)
	}
	return out
}

// --- /api/project-share handler factory ---
func projectShareHandler(seq *sequencer.Sequencer, shareStore *share.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			Project        map[string]any `json:"project"`
			Mirror         []string       `json:"mirror"`
			Structure      string         `json:"structure"`
			ArrangeSeed    *int64         `json:"arrangeSeed"`
			VelocityDeltas map[string]int `json:"velocityDeltas"`
			MaxVariants    int            `json:"maxVariants"`
			FadeIn         []string       `json:"fadeIn"`
			DrumBreak      int            `json:"drumBreak"`
			Sections       []any          `json:"sections"`
			FeelCurve      []any          `json:"feelCurve"`
			MacroCurve     []any          `json:"macroCurve"`
		}
		if r.ContentLength > 0 {
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, "bad body json: "+err.Error(), http.StatusBadRequest)
				return
			}
		}
		project := req.Project
		if project == nil {
			project = seq.GetProject()
			if project == nil {
				http.Error(w, "no project loaded on server", http.StatusBadRequest)
				return
			}
		}
		envelope := buildShareEnvelope(project)
		// Optional arrangement directive — carried in the envelope so the
		// client can re-expand the track deterministically on load.
		if req.Structure != "" && req.Structure != "loop" {
			envelope["structure"] = req.Structure
			if req.ArrangeSeed != nil {
				envelope["arrangeSeed"] = *req.ArrangeSeed
			}
			if len(req.VelocityDeltas) > 0 {
				envelope["velocityDeltas"] = req.VelocityDeltas
			}
			if req.MaxVariants > 0 {
				envelope["maxVariants"] = req.MaxVariants
			}
			if len(req.FadeIn) > 0 {
				envelope["fadeIn"] = req.FadeIn
			}
			if req.DrumBreak > 0 {
				envelope["drumBreak"] = req.DrumBreak
			}
			if len(req.Sections) > 0 {
				envelope["sections"] = req.Sections
			}
			if len(req.FeelCurve) > 0 {
				envelope["feelCurve"] = req.FeelCurve
			}
			if len(req.MacroCurve) > 0 {
				envelope["macroCurve"] = req.MacroCurve
			}
		}
		cid, canonical, err := share.CanonicalCID(envelope)
		if err != nil {
			http.Error(w, "canonicalize: "+err.Error(), http.StatusInternalServerError)
			return
		}
		if err := shareStore.Seal(cid, canonical); err != nil {
			http.Error(w, "seal: "+err.Error(), http.StatusInternalServerError)
			return
		}
		origin := "http://" + r.Host
		if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
			origin = "https://" + r.Host
		}
		mirrors := mirrorCIDToHosts(cid, canonical, req.Mirror)
		backlog := pflow.AnalyzeMacroBacklog(pflow.ParseProject(project))
		backlogReport := make([]map[string]any, 0, len(backlog))
		for _, b := range backlog {
			backlogReport = append(backlogReport, map[string]any{
				"netId":           b.NetID,
				"fireCount":       b.FireCount,
				"drainTicks":      b.DrainTicks,
				"cycleTicks":      b.CycleTicks,
				"ratio":           b.Ratio,
				"overrunPerCycle": b.OverrunPerCycle,
			})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"cid":           cid,
			"shortUrl":      origin + "/?cid=" + cid,
			"bytes":         len(canonical),
			"mirrors":       mirrors,
			"macroBacklog":  backlogReport,
		})
	}
}

// --- /api/mirror-cid handler factory ---
func mirrorCIDHandler(shareStore *share.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			CID   string   `json:"cid"`
			Hosts []string `json:"hosts"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad body json: "+err.Error(), http.StatusBadRequest)
			return
		}
		if req.CID == "" || len(req.Hosts) == 0 {
			http.Error(w, "cid and hosts required", http.StatusBadRequest)
			return
		}
		canonical, err := shareStore.Lookup(req.CID)
		if err != nil {
			http.Error(w, "cid not found locally: "+err.Error(), http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"cid":     req.CID,
			"bytes":   len(canonical),
			"mirrors": mirrorCIDToHosts(req.CID, canonical, req.Hosts),
		})
	}
}

// --- /api/midi-routing handler factory ---
func midiRoutingHandler(single *midiout.Output, multi *midiout.MultiOutput, fan *midiout.FanoutOutput) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		resp := map[string]any{"mode": "none"}
		switch {
		case fan != nil:
			resp["mode"] = "fanout"
			resp["ports"] = fan.PortNames()
			resp["assignments"] = fan.Assignments()
		case multi != nil:
			resp["mode"] = "per-net"
			resp["ports"] = multi.PortNames()
		case single != nil:
			resp["mode"] = "single"
			resp["ports"] = []string{single.PortName()}
		}
		_ = json.NewEncoder(w).Encode(resp)
	}
}

// audioStatusHandler returns Status JSON for ?cid=… — the share modal
// polls this every few seconds while waiting for a render so it can
// distinguish "queued behind N others, ~M seconds wait" from
// "rendering, X% done" without burning a HEAD-per-poll on the audio
// handler. Cheap (no disk I/O beyond a single Stat for the ready case).
func audioStatusHandler(ar *audiorender.Renderer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cid := r.URL.Query().Get("cid")
		st := ar.Status(cid)
		w.Header().Set("Content-Type", "application/json")
		// Status moves second-by-second — no caching.
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(st)
	}
}

// --- /audio/{cid}.webm handler ---
//
// Validates the CID, confirms it exists in the share store (so we never
// render arbitrary input), then asks the renderer for a cached path.
// First request for a CID waits for the realtime render; subsequent
// requests stream the static file with HTTP Range support.
//
// The /audio/ namespace is shared with public/audio/* (tone-engine.js etc).
// Anything that doesn't match /audio/{cid}.webm falls through to the
// static handler so existing module imports keep working.
func audioHandler(ar *audiorender.Renderer, shareStore *share.Store, fallback http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Path: /audio/{cid}.webm — anything else is a static asset.
		name := strings.TrimPrefix(r.URL.Path, "/audio/")
		if !strings.HasSuffix(name, ".webm") {
			fallback.ServeHTTP(w, r)
			return
		}
		cid := strings.TrimSuffix(name, ".webm")
		if !audiorender.ValidCID(cid) {
			fallback.ServeHTTP(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if _, err := shareStore.Lookup(cid); err != nil {
			http.Error(w, "cid not in share store", http.StatusNotFound)
			return
		}
		// POST enqueues a background render and returns 202 Accepted.
		// The share modal uses this when its HEAD probe shows no
		// pre-rendered audio yet. Idempotent — Enqueue is single-flight
		// and a no-op when the cache is already warm. JSON body
		// {"expectedMs": <track-length-ms>} is optional; the modal
		// computes it from the project's tempo + step count and posts
		// it so /api/audio-status returns honest queue-wait projections.
		if r.Method == http.MethodPost {
			var body struct{ ExpectedMs int64 `json:"expectedMs"` }
			_ = json.NewDecoder(r.Body).Decode(&body)
			if !ar.Enqueue(cid, body.ExpectedMs) {
				// Queue is too deep (>30 min projected wait). Tell the
				// caller to back off — single-flight means an in-flight
				// render of the same cid already returns true above,
				// so 503 here is genuinely about queue saturation.
				http.Error(w, "render queue full — try again later", http.StatusServiceUnavailable)
				return
			}
			w.WriteHeader(http.StatusAccepted)
			return
		}
		// HEAD is a cache-only existence probe — must never trigger a
		// render. The welcome card uses it to decide whether to surface
		// "Listen / Download" buttons; if HEAD synchronously rendered,
		// every visitor to a fresh share would block 2+ minutes on a
		// link probe. 200 if cached, 404 otherwise.
		if r.Method == http.MethodHead {
			if path := ar.CachedPath(cid); path != "" {
				if info, err := os.Stat(path); err == nil {
					w.Header().Set("Content-Type", "audio/webm")
					w.Header().Set("Content-Length", fmt.Sprintf("%d", info.Size()))
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
					w.WriteHeader(http.StatusOK)
					return
				}
			}
			http.Error(w, "audio not yet rendered", http.StatusNotFound)
			return
		}
		// A cold render can take minutes; the parent http.Server's
		// WriteTimeout (15s) would otherwise kill the connection long
		// before the file is ready. Clear the deadline for this route.
		if rc := http.NewResponseController(w); rc != nil {
			_ = rc.SetWriteDeadline(time.Time{})
			_ = rc.SetReadDeadline(time.Time{})
		}
		// expectedMs=0 falls back to the renderer's default — the GET
		// path doesn't carry the caller's track-length estimate.
		path, err := ar.Render(r.Context(), cid, 0)
		if err != nil {
			log.Printf("audio render %s: %v", cid, err)
			http.Error(w, "render failed", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "audio/webm")
		// CIDs are immutable, so the rendered bytes for a given CID never
		// change either — let intermediaries cache forever.
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		http.ServeFile(w, r, path)
	})
}

// --- share envelope helpers (formerly in cmd/petri-note/main.go) ---

func buildShareEnvelope(project map[string]any) map[string]any {
	// project["name"] looks like "techno · Velvet Shade" for composer output
	// and "Untitled" (or missing) for hand-authored projects. Split off the
	// genre prefix when present and carry the full name as a separate field.
	name := asStringOr(project["name"], "")
	// "wrapped" tags hand-authored projects (ties into bitwrap — the net
	// is wrapped tokens rather than synthesized from a preset). Keeps the
	// genre field non-empty per schema and distinguishes raw-nets shares
	// from the 19 composer presets (techno/ambient/trance/…).
	genre := "wrapped"
	if idx := strings.Index(name, " · "); idx > 0 {
		genre = name[:idx]
	}
	envelope := map[string]any{
		"@context": "https://beats.bitwrap.io/schema/beats-share.context.jsonld",
		"@type":    "BeatsShare",
		"v":        1,
		"genre":    genre,
		"seed":     0,
		"nets":     project["nets"],
	}
	if name != "" && name != "Untitled" {
		envelope["name"] = name
	}
	if t, ok := project["tempo"].(float64); ok {
		envelope["tempo"] = int(t)
	}
	if s, ok := project["swing"].(float64); ok {
		envelope["swing"] = int(s)
	}
	if h, ok := project["humanize"].(float64); ok {
		envelope["humanize"] = int(h)
	}
	if fx, ok := project["fx"].(map[string]any); ok {
		envelope["fx"] = fx
	}
	if im, ok := project["initialMutes"].([]any); ok {
		envelope["initialMutes"] = im
	}
	return envelope
}

func mirrorCIDToHosts(cid string, canonical []byte, hosts []string) []map[string]any {
	out := make([]map[string]any, 0, len(hosts))
	client := &http.Client{Timeout: 15 * time.Second}
	for _, host := range hosts {
		host = strings.TrimRight(host, "/")
		url := host + "/o/" + cid
		req, err := http.NewRequest(http.MethodPut, url, bytes.NewReader(canonical))
		if err != nil {
			out = append(out, map[string]any{"host": host, "status": 0, "error": err.Error()})
			continue
		}
		req.Header.Set("Content-Type", "application/ld+json")
		resp, err := client.Do(req)
		if err != nil {
			out = append(out, map[string]any{"host": host, "status": 0, "error": err.Error()})
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		rec := map[string]any{"host": host, "status": resp.StatusCode}
		if resp.StatusCode >= 400 {
			rec["error"] = strings.TrimSpace(string(body))
		}
		out = append(out, rec)
	}
	return out
}

func asStringOr(v any, fallback string) string {
	if s, ok := v.(string); ok && s != "" {
		return s
	}
	return fallback
}

// Typed nil-guards for the close loop — io.Closer interface values of
// typed-nil would return non-nil when compared to nil in the interface,
// so coerce to io.Closer only when the concrete pointer is non-nil.
func midiOutCloser(o *midiout.Output) io.Closer {
	if o == nil {
		return nil
	}
	return o
}
func midiMultiCloser(m *midiout.MultiOutput) io.Closer {
	if m == nil {
		return nil
	}
	return m
}
func midiFanOutCloser(f *midiout.FanoutOutput) io.Closer {
	if f == nil {
		return nil
	}
	return f
}

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
	"strconv"
	"strings"
	"syscall"
	"time"

	"beats-bitwrap-io/internal/audiorender"
	"beats-bitwrap-io/internal/generator"
	"beats-bitwrap-io/internal/index"
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
	// Always wire the audio storage layer (cache + uploads + feed) — the
	// only thing -audio-render gates is the server-side render fallback
	// when a GET arrives for a CID that no client has uploaded yet. With
	// it OFF, GETs of un-uploaded CIDs return 404; with it ON they trigger
	// a headless-Chromium render. Uploads work either way.
	{
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
		// Open the SQLite track index. Drives /api/feed + /feed.rss
		// + /api/audio-latest. Lives inside the persisted data dir
		// alongside the share blobs and audio cache.
		idx, err := index.Open(filepath.Join(*dataDir, "index.db"))
		if err != nil {
			log.Fatalf("index open: %v", err)
		}
		log.Printf("Track index: %s", filepath.Join(*dataDir, "index.db"))
		// OnRenderComplete projects the share envelope into the
		// index. Failure is observational; the audio file already
		// exists on disk.
		onRenderComplete := func(cid string) {
			raw, err := shareStore.Lookup(cid)
			if err != nil {
				log.Printf("index: lookup %s: %v", cid, err)
				return
			}
			var bytes int64
			if path := filepath.Join(*dataDir, "audio"); path != "" {
				// Best-effort size — Stat the canonical path the
				// renderer wrote. Errors fall back to 0.
				if info, err := os.Stat(filepath.Join(path,
					fmt.Sprintf("%04d/%02d/%s.webm", time.Now().UTC().Year(),
						int(time.Now().UTC().Month()), cid))); err == nil {
					bytes = info.Size()
				}
			}
			if err := idx.RecordRender(cid, raw, bytes); err != nil {
				log.Printf("index: record %s: %v", cid, err)
			}
		}
		ar, err := audiorender.New(audiorender.Config{
			CacheDir:         filepath.Join(*dataDir, "audio"),
			BaseURL:          base,
			MaxBytes:         *audioMaxBytes,
			MaxConcurrent:    *audioConcurrent,
			RenderTimeout:    *audioRenderTimeout,
			MaxDuration:      *audioMaxDuration,
			ChromePath:       *audioChromePath,
			LookupMetadata:   lookupMD,
			OnRenderComplete: onRenderComplete,
		})
		if err != nil {
			log.Fatalf("audio renderer: %v", err)
		}
		if *audioEnabled {
			log.Printf("Audio render: ON (cache %s, base %s, cap %d bytes, %d concurrent, max %s/render, kill at %s)",
				filepath.Join(*dataDir, "audio"), base, *audioMaxBytes, *audioConcurrent,
				*audioMaxDuration, *audioRenderTimeout)
		} else {
			log.Printf("Audio render: OFF (uploads + cached serving still active at /audio/{cid}.webm)")
		}
		// One-time backfill: any pre-existing renders predate the
		// index. Walk the cache and project them in. Bounded at 30s
		// so a giant cache doesn't stall startup.
		go backfillIndex(idx, shareStore, filepath.Join(*dataDir, "audio"))
		mux.Handle("/audio/", audioHandler(ar, shareStore, staticHandler, *audioEnabled, onRenderComplete))
		mux.HandleFunc("/api/audio-status", audioStatusHandler(ar))
		mux.HandleFunc("/api/audio-latest", func(w http.ResponseWriter, r *http.Request) {
			cid, _ := idx.Latest()
			if cid == "" {
				// Fall back to the renderer's mtime walk if the
				// index hasn't backfilled yet (or is empty).
				cid = ar.LatestCID()
			}
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			_ = json.NewEncoder(w).Encode(map[string]string{"cid": cid})
		})
		mux.HandleFunc("/api/feed", feedHandler(idx))
		mux.HandleFunc("/feed.rss", rssFeedHandler(idx, publicURL))
		// /feed serves the gallery page; /feed.html resolves the same
		// file via the static handler. Explicit route here avoids the
		// catch-all routing /feed → DecoratedIndex (which would 404
		// looking for a CID).
		mux.HandleFunc("/feed", func(w http.ResponseWriter, r *http.Request) {
			r.URL.Path = "/feed.html"
			staticHandler.ServeHTTP(w, r)
		})
		if *audioEnabled && *audioAutoEnqueue {
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
func audioHandler(ar *audiorender.Renderer, shareStore *share.Store, fallback http.Handler, enableServerRender bool, onIngest func(cid string)) http.Handler {
	// httpErrorNoStore writes an error response with explicit no-store
	// caching so browsers and intermediaries don't poison themselves
	// with a transient 404/500 from this route. Without it, a probe
	// during the window between "share sealed" and "render finished"
	// (which is up to 2-3 min on cold renders) gets a 404 that some
	// browsers will then serve from cache for hours, even after the
	// real audio is ready. Audio routes never carry sensitive data, so
	// no-store is purely a freshness guarantee.
	httpErrorNoStore := func(w http.ResponseWriter, msg string, code int) {
		w.Header().Set("Cache-Control", "no-store")
		http.Error(w, msg, code)
	}
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
		if r.Method != http.MethodGet && r.Method != http.MethodHead &&
			r.Method != http.MethodPost && r.Method != http.MethodPut {
			httpErrorNoStore(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if _, err := shareStore.Lookup(cid); err != nil {
			httpErrorNoStore(w, "cid not in share store", http.StatusNotFound)
			return
		}
		// PUT accepts a client-rendered .webm and stores it at the canonical
		// cache path. First-write-wins; subsequent uploads return 200 with
		// {"wrote":false} and leave the existing render untouched. Trust
		// model is "treat as a hint" — clients are unauthenticated and
		// uploads share the share-store rate-limit budget.
		if r.Method == http.MethodPut {
			if ok, reason := shareStore.RateLimitPUT(r); !ok {
				w.Header().Set("Retry-After", "60")
				httpErrorNoStore(w, reason, http.StatusTooManyRequests)
				return
			}
			// Faster-than-realtime check: an honest in-tab render runs for
			// the full track wall-clock. If the upload arrives sooner than
			// the envelope's minimum render duration after seal, the user
			// fabricated the .webm offline rather than recording playback.
			// Reject with 403 and a Retry-After hinting how long they need
			// to actually wait. The share-store mtime is the seal moment;
			// duplicate seals short-circuit before touching disk.
			if sealedAt, err := shareStore.SealedAt(cid); err == nil {
				if envelope, err := shareStore.Lookup(cid); err == nil {
					minMs := share.EstimateMinRenderMs(envelope)
					elapsedMs := time.Since(sealedAt).Milliseconds()
					if elapsedMs < minMs {
						remain := minMs - elapsedMs
						w.Header().Set("Retry-After", fmt.Sprintf("%d", (remain+999)/1000))
						httpErrorNoStore(w,
							fmt.Sprintf("upload arrived faster than realtime: %dms elapsed since seal, need at least %dms", elapsedMs, minMs),
							http.StatusForbidden)
						return
					}
				}
			}
			const maxAudioPutBytes = 5 * 1024 * 1024 // 5 MiB
			r.Body = http.MaxBytesReader(w, r.Body, maxAudioPutBytes+1)
			body, err := io.ReadAll(r.Body)
			if err != nil {
				httpErrorNoStore(w, "audio upload too large or unreadable", http.StatusRequestEntityTooLarge)
				return
			}
			if len(body) == 0 {
				httpErrorNoStore(w, "empty audio body", http.StatusBadRequest)
				return
			}
			_, wrote, err := ar.IngestClientRender(cid, body)
			if err != nil {
				log.Printf("audio ingest %s: %v", cid, err)
				httpErrorNoStore(w, "ingest failed", http.StatusInternalServerError)
				return
			}
			// Mirror the server-render path so the feed / RSS pick up
			// client uploads. onIngest is the same closure as the
			// renderer's OnRenderComplete callback — projects the share
			// envelope into the SQLite index.
			if wrote && onIngest != nil {
				onIngest(cid)
			}
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			status := http.StatusCreated
			if !wrote {
				status = http.StatusOK
			}
			w.WriteHeader(status)
			fmt.Fprintf(w, `{"wrote":%v,"bytes":%d}`, wrote, len(body))
			return
		}
		// With server-side render disabled, GET / POST against an
		// un-uploaded CID has no fallback path — return 404 instead of
		// blocking. Cached files still serve normally.
		if !enableServerRender {
			if r.Method == http.MethodGet {
				if path := ar.CachedPath(cid); path != "" {
					w.Header().Set("Content-Type", "audio/webm")
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
					http.ServeFile(w, r, path)
					return
				}
				httpErrorNoStore(w, "audio not yet uploaded — render in your tab and PUT to this URL", http.StatusNotFound)
				return
			}
			if r.Method == http.MethodPost {
				httpErrorNoStore(w, "server-side render disabled — PUT a client render instead", http.StatusServiceUnavailable)
				return
			}
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
				httpErrorNoStore(w, "render queue full — try again later", http.StatusServiceUnavailable)
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
			httpErrorNoStore(w, "audio not yet rendered", http.StatusNotFound)
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
			httpErrorNoStore(w, "render failed", http.StatusInternalServerError)
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
// feedHandler answers GET /api/feed?genre=&before=<unix-ms>&limit=
// with a JSON array of recent rendered tracks, newest first.
func feedHandler(idx *index.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := index.FeedQuery{
			Genre: r.URL.Query().Get("genre"),
		}
		if v := r.URL.Query().Get("before"); v != "" {
			if n, err := strconv.ParseInt(v, 10, 64); err == nil {
				q.Before = n
			}
		}
		if v := r.URL.Query().Get("limit"); v != "" {
			if n, err := strconv.Atoi(v); err == nil {
				q.Limit = n
			}
		}
		tracks, err := idx.Feed(q)
		if err != nil {
			log.Printf("feed: %v", err)
			http.Error(w, "feed query failed", http.StatusInternalServerError)
			return
		}
		// Backfill display names for rows persisted before the name
		// column was wired up. Names are deterministic from
		// (genre, seed) — same composer that produced the project
		// would emit the same string. Without this, the playlist /
		// feed cards fall back to "techno · -1800543357" (raw seed)
		// instead of "techno · Wired Pulse".
		for i := range tracks {
			if tracks[i].Name == "" {
				tracks[i].Name = generator.NameForSeed(tracks[i].Genre, tracks[i].Seed)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(tracks)
	}
}

// rssFeedHandler answers GET /feed.rss with a podcast-shaped feed
// of the most recent 50 rendered tracks. Each item carries an
// <enclosure> pointing at the .webm so podcast clients pick it up.
// publicURL is the canonical origin baked into item links — same one
// already passed to the renderer for tag comments.
func rssFeedHandler(idx *index.DB, publicURL string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tracks, err := idx.Feed(index.FeedQuery{Limit: 50})
		if err != nil {
			log.Printf("rss: %v", err)
			http.Error(w, "rss query failed", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/rss+xml; charset=utf-8")
		w.Header().Set("Cache-Control", "public, max-age=300")
		fmt.Fprintf(w, `<?xml version="1.0" encoding="UTF-8"?>`+"\n")
		fmt.Fprintf(w, `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">`+"\n")
		fmt.Fprintf(w, `<channel>`+"\n")
		fmt.Fprintf(w, `  <title>beats.bitwrap.io · recent renders</title>`+"\n")
		fmt.Fprintf(w, `  <link>%s/</link>`+"\n", xmlEscape(publicURL))
		fmt.Fprintf(w, `  <atom:link href="%s/feed.rss" rel="self" type="application/rss+xml"/>`+"\n", xmlEscape(publicURL))
		fmt.Fprintf(w, `  <description>Deterministic generative beats. Every track is content-addressed; CC BY 4.0.</description>`+"\n")
		fmt.Fprintf(w, `  <language>en</language>`+"\n")
		fmt.Fprintf(w, `  <copyright>CC BY 4.0 — beats.bitwrap.io</copyright>`+"\n")
		for _, t := range tracks {
			title := t.Name
			if title == "" {
				// Same backfill the JSON feed does — keep RSS titles
				// in sync with the playlist UI.
				title = generator.NameForSeed(t.Genre, t.Seed)
			}
			itemURL := fmt.Sprintf("%s/?cid=%s", publicURL, t.CID)
			audioURL := fmt.Sprintf("%s/audio/%s.webm", publicURL, t.CID)
			pubDate := time.UnixMilli(t.RenderedAt).UTC().Format(time.RFC1123Z)
			fmt.Fprintf(w, `  <item>`+"\n")
			fmt.Fprintf(w, `    <title>%s</title>`+"\n", xmlEscape(title))
			fmt.Fprintf(w, `    <link>%s</link>`+"\n", xmlEscape(itemURL))
			fmt.Fprintf(w, `    <guid isPermaLink="false">%s</guid>`+"\n", xmlEscape(t.CID))
			fmt.Fprintf(w, `    <pubDate>%s</pubDate>`+"\n", pubDate)
			fmt.Fprintf(w, `    <description>%s · %d BPM · seed %d</description>`+"\n",
				xmlEscape(t.Genre), t.Tempo, t.Seed)
			fmt.Fprintf(w, `    <enclosure url="%s" type="audio/webm"/>`+"\n", xmlEscape(audioURL))
			fmt.Fprintf(w, `  </item>`+"\n")
		}
		fmt.Fprintf(w, `</channel></rss>`+"\n")
	}
}

// xmlEscape is the minimum we need for attribute + text content.
func xmlEscape(s string) string {
	r := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		"\"", "&quot;",
		"'", "&#39;",
	)
	return r.Replace(s)
}

// backfillIndex projects every cached .webm into the index on startup.
// Idempotent (RecordRender upserts). Bounded to 30 s so an unexpectedly
// large cache doesn't stall the server's first-request latency.
func backfillIndex(idx *index.DB, store *share.Store, audioDir string) {
	deadline := time.Now().Add(30 * time.Second)
	count := 0
	_ = filepath.Walk(audioDir, func(p string, info os.FileInfo, err error) error {
		if err != nil || info == nil || info.IsDir() {
			return nil
		}
		if !strings.HasSuffix(info.Name(), ".webm") {
			return nil
		}
		if time.Now().After(deadline) {
			return filepath.SkipAll
		}
		cid := strings.TrimSuffix(info.Name(), ".webm")
		raw, err := store.Lookup(cid)
		if err != nil {
			return nil // share blob may have been pruned; skip silently
		}
		// Use file mtime as rendered_at so backfilled rows preserve
		// their original render order — otherwise everything would
		// collapse to "rendered at boot time" and sort alphabetically
		// by CID for visually-equal timestamps.
		renderedAt := info.ModTime().UnixMilli()
		if err := idx.RecordRenderAt(cid, raw, info.Size(), renderedAt); err != nil {
			log.Printf("backfill: record %s: %v", cid, err)
			return nil
		}
		count++
		return nil
	})
	if count > 0 {
		log.Printf("Track index: backfilled %d rendered tracks", count)
	}
}

func midiFanOutCloser(f *midiout.FanoutOutput) io.Closer {
	if f == nil {
		return nil
	}
	return f
}

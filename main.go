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
	"strings"
	"syscall"
	"time"

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
			Project map[string]any `json:"project"`
			Mirror  []string       `json:"mirror"`
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
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"cid":      cid,
			"shortUrl": origin + "/?cid=" + cid,
			"bytes":    len(canonical),
			"mirrors":  mirrors,
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

// --- share envelope helpers (formerly in cmd/petri-note/main.go) ---

func buildShareEnvelope(project map[string]any) map[string]any {
	envelope := map[string]any{
		"@context": "https://beats.bitwrap.io/schema/beats-share.context.jsonld",
		"@type":    "BeatsShare",
		"v":        1,
		"genre":    asStringOr(project["name"], "custom"),
		"seed":     0,
		"nets":     project["nets"],
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

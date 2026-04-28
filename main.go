package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	cryptorand "crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"hash/fnv"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"sort"
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
	audioRenderMode := flag.String("audio-render-mode", "realtime", "Render path: 'realtime' (chromedp + MediaRecorder, 1× wall time, full live fidelity) or 'offline' (Tone.Offline, ~10× faster, fidelity gaps — see public/lib/share/offline-render.js header).")
	audioLoudnormLUFS := flag.Float64("audio-loudnorm-lufs", -16.0, "Integrated-LUFS target for the post-render ffmpeg loudnorm pass. 0 = skip, negative = explicit opt-out. Default −16 matches Spotify/YouTube tier; lifts the un-normalized fleet (~−30 LUFS) to streaming-tier loudness.")
	audioLoudnormTP := flag.Float64("audio-loudnorm-truepeak", -1.0, "True-peak ceiling (dBTP) for the loudnorm pass. Streaming-safe values are −1 to −2.")
	audioLoudnormLRA := flag.Float64("audio-loudnorm-lra", 11.0, "Default loudness range (LU) for loudnorm; per-genre table overrides this. Lower = squashed, higher = preserves dynamics.")
	audioAutoEnqueue := flag.Bool("audio-auto-enqueue", true, "Pre-render newly sealed CIDs in the background so listeners hit a warm cache.")
	rebuildQueueEnabled := flag.Bool("rebuild-queue", false, "Expose /api/rebuild-{mark,queue,clear} so listeners can flag broken renders for an off-host worker to re-render. Adds a ⟳ button on each feed card.")

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

	rebuildSecret, err := loadOrCreateRebuildSecret(filepath.Join(*dataDir, ".rebuild-secret"))
	if err != nil {
		log.Fatalf("rebuild-secret init: %v", err)
	}
	log.Printf("Rebuild secret: %s (X-Rebuild-Secret bypasses first-write-wins on PUT /audio)",
		filepath.Join(*dataDir, ".rebuild-secret"))

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
	mux.HandleFunc("/schema/snapshot-manifest", share.HandleSnapshotManifestSchema)
	mux.HandleFunc("/schema/beats-audio-analysis", share.HandleBeatsAudioAnalysisSchema)
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
		mode := strings.ToLower(strings.TrimSpace(*audioRenderMode))
		if mode != "" && mode != "realtime" && mode != "offline" {
			log.Fatalf("audio renderer: invalid -audio-render-mode %q (want 'realtime' or 'offline')", *audioRenderMode)
		}
		// OnLoudnorm projects the in-band integrated-LUFS measurement
		// from the renderer's loudnorm pass into a partial analysis
		// row. The off-host analyzer worker fills in spectral fields
		// later via PUT /api/analysis/{cid}; the COALESCE-based upsert
		// preserves whichever fields each producer wrote.
		onLoudnorm := func(cid string, m audiorender.LoudnormResult) {
			lufs := m.InputI
			tp := m.InputTP
			a := index.Analysis{
				CID:             cid,
				AnalyzerVersion: "ffmpeg-loudnorm",
				AnalyzedAt:      time.Now().UnixMilli(),
				Source:          "loudnorm",
				LUFS:            &lufs,
				TruePeakDb:      &tp,
			}
			if err := idx.UpsertAnalysis(a); err != nil {
				log.Printf("analysis: upsert %s: %v", cid, err)
			}
		}
		// LookupGenre reads just the genre tag from the share envelope
		// so the renderer can apply per-genre loudnorm targets. Cheap;
		// the same envelope is also fetched by lookupMD a moment later.
		lookupGenre := func(cid string) string {
			raw, err := shareStore.Lookup(cid)
			if err != nil {
				return ""
			}
			var p struct {
				Genre string `json:"genre"`
			}
			if err := json.Unmarshal(raw, &p); err != nil {
				return ""
			}
			return p.Genre
		}
		ar, err := audiorender.New(audiorender.Config{
			CacheDir:           filepath.Join(*dataDir, "audio"),
			BaseURL:            base,
			MaxBytes:           *audioMaxBytes,
			MaxConcurrent:      *audioConcurrent,
			RenderTimeout:      *audioRenderTimeout,
			MaxDuration:        *audioMaxDuration,
			ChromePath:         *audioChromePath,
			LookupMetadata:     lookupMD,
			LookupGenre:        lookupGenre,
			OnRenderComplete:   onRenderComplete,
			OnLoudnorm:         onLoudnorm,
			RenderMode:         mode,
			LoudnormTargetLUFS: *audioLoudnormLUFS,
			LoudnormTruePeakDB: *audioLoudnormTP,
			LoudnormLRA:        *audioLoudnormLRA,
		})
		if err != nil {
			log.Fatalf("audio renderer: %v", err)
		}
		if *audioEnabled {
			log.Printf("Audio render: ON (cache %s, base %s, cap %d bytes, %d concurrent, max %s/render, kill at %s, mode=%s)",
				filepath.Join(*dataDir, "audio"), base, *audioMaxBytes, *audioConcurrent,
				*audioMaxDuration, *audioRenderTimeout, mode)
		} else {
			log.Printf("Audio render: OFF (uploads + cached serving still active at /audio/{cid}.webm)")
		}
		// One-time backfill: any pre-existing renders predate the
		// index. Walk the cache and project them in. Bounded at 30s
		// so a giant cache doesn't stall startup.
		go backfillIndex(idx, shareStore, filepath.Join(*dataDir, "audio"))
		mux.Handle("/audio/", audioHandler(ar, shareStore, staticHandler, *audioEnabled, onRenderComplete, rebuildSecret))
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
		// /api/analysis/{cid} — per-CID audio quality measurements.
		// GET is public; PUT requires X-Rebuild-Secret. The renderer
		// already populates lufs/truePeakDb in-band via the loudnorm
		// pass — the analyzer worker (scripts/analyze-audio.py)
		// PUTs the spectral/band fields after the fact. See
		// public/schema/beats-audio-analysis.schema.json for the
		// envelope shape.
		mux.HandleFunc("/api/analysis/", analysisHandler(idx, rebuildSecret))
		mux.HandleFunc("/feed.rss", rssFeedHandler(idx, publicURL))
		mux.HandleFunc("/api/features", featuresHandler(*rebuildQueueEnabled))
		if *rebuildQueueEnabled {
			mux.HandleFunc("/api/rebuild-mark", rebuildMarkHandler(idx, shareStore))
			mux.HandleFunc("/api/rebuild-queue", rebuildQueueHandler(idx))
			mux.HandleFunc("/api/rebuild-clear", rebuildClearHandler(idx, shareStore))
			log.Printf("Rebuild queue: ON (/api/rebuild-{mark,queue,clear})")
		}
		// /api/archive-missing — every CID that's in the share store but
		// not in the rendered-audio index. Lets an offline worker drive
		// a full-collection archive pass without the listener having to
		// tap ⟳ on each card.
		mux.HandleFunc("/api/archive-missing", archiveMissingHandler(idx, shareStore))
		// /api/archive-delete — authenticated cascade-delete of a CID.
		// Removes the share envelope, cached .webm, index row, and any
		// rebuild_queue entry. Useful for pruning unrenderable shares
		// (broken hand-authored topology, etc.) so they stop showing up
		// in archive sweeps. Requires X-Rebuild-Secret.
		mux.HandleFunc("/api/archive-delete", archiveDeleteHandler(idx, shareStore, ar, rebuildSecret))
		// /api/snapshot — stream a .tar.gz of every envelope in the
		// share store. Authenticated (X-Rebuild-Secret) since the
		// archive is the canonical state of the catalogue. The
		// response is a streaming tarball — pipe to a file:
		//   curl -H "X-Rebuild-Secret: $S" -o snapshot.tgz \
		//        https://beats.bitwrap.io/api/snapshot
		mux.HandleFunc("/api/snapshot", snapshotHandler(shareStore, ar, filepath.Join(*dataDir, "index.db"), rebuildSecret))
		// /api/snapshot-manifest: the JSON-LD manifest (no tarball) so
		// the /archive page can render catalogue state inline.
		mux.HandleFunc("/api/snapshot-manifest", snapshotManifestHandler(shareStore))
		// Persisted snapshots — operator triggers POST /api/snapshot-persist
		// (X-Rebuild-Secret) to capture a moment, optionally with a label
		// to group related captures (?label=experiment-A). Files land in
		// data/snapshots/. The list + RSS endpoints are public so anyone
		// can browse/subscribe to historical backups.
		snapshotDir := filepath.Join(*dataDir, "snapshots")
		mux.HandleFunc("/api/snapshot-persist",
			persistedSnapshotHandler(snapshotDir, shareStore, ar,
				filepath.Join(*dataDir, "index.db"), rebuildSecret))
		mux.HandleFunc("/api/snapshots", snapshotsListHandler(snapshotDir))
		mux.HandleFunc("/api/archive-lookup", archiveLookupHandler(snapshotDir, shareStore))
		mux.HandleFunc("/api/archive-restore", archiveRestoreHandler(snapshotDir, shareStore))
		mux.HandleFunc("/api/snapshot-contents", snapshotContentsHandler(snapshotDir))
		mux.HandleFunc("/archive.rss", archiveRSSHandler(snapshotDir, publicURL))
		// /snapshots/{filename}: static download of a persisted tarball.
		// Long cache — content-addressed by filename (timestamp embedded),
		// so a given URL never changes.
		mux.Handle("/snapshots/", http.StripPrefix("/snapshots/",
			snapshotFileHandler(snapshotDir)))
		// /archive: download page for users who want a recoverable
		// backup. Resolves to public/archive.html via the static handler.
		mux.HandleFunc("/archive", func(w http.ResponseWriter, r *http.Request) {
			r.URL.Path = "/archive.html"
			staticHandler.ServeHTTP(w, r)
		})
		// /feed serves the gallery page; /feed.html resolves the same
		// file via the static handler. Explicit route here avoids the
		// catch-all routing /feed → DecoratedIndex (which would 404
		// looking for a CID).
		mux.HandleFunc("/feed", func(w http.ResponseWriter, r *http.Request) {
			r.URL.Path = "/feed.html"
			staticHandler.ServeHTTP(w, r)
		})
		// /readyz: confirms the DB + share-store are reachable. Used
		// by external monitors (nginx, ~/healthcheck) to distinguish
		// "process up but hung" from "actually serving traffic".
		shareDir := *dataDir
		mux.HandleFunc("/readyz", readyzHandler(idx, shareDir))
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

	// Browsers and crawlers auto-request /favicon.ico even when an
	// explicit <link rel="icon"> points at favicon.svg — serve the
	// SVG with the right Content-Type so they stop logging 404s.
	mux.HandleFunc("/favicon.ico", func(w http.ResponseWriter, r *http.Request) {
		r.URL.Path = "/favicon.svg"
		w.Header().Set("Content-Type", "image/svg+xml")
		staticHandler.ServeHTTP(w, r)
	})

	// /healthz: cheap liveness probe. Always 200; no I/O. Distinct
	// from /readyz (which probes deps and only mounts when the
	// index/audio block ran).
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})

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

	// Panic-recovery middleware. A panic inside any handler — JSON
	// unmarshal of malformed input, slice OOB on a corrupt payload,
	// nil-deref on a half-init dependency — would otherwise propagate
	// up the goroutine and kill the whole server. Recover, log with
	// stack, write a 500 if no bytes were sent yet.
	handler := http.Handler(cors)
	handler = recoverMiddleware(handler)

	server := &http.Server{
		Addr:         *addr,
		Handler:      handler,
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
			// Optional bake-in preferences. macrosDisabled is applied
			// by the frontend when Auto-DJ runs (skips the listed macro
			// ids). autoDj is the engagement override — pass {"run":
			// false} to ensure the listener / renderer never engages.
			MacrosDisabled []string       `json:"macrosDisabled"`
			AutoDj         map[string]any `json:"autoDj"`
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
		if len(req.MacrosDisabled) > 0 {
			envelope["macrosDisabled"] = req.MacrosDisabled
		}
		if len(req.AutoDj) > 0 {
			envelope["autoDj"] = req.AutoDj
		}
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
func audioHandler(ar *audiorender.Renderer, shareStore *share.Store, fallback http.Handler, enableServerRender bool, onIngest func(cid string), rebuildSecret string) http.Handler {
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
			// Authenticated worker uploads (X-Rebuild-Secret header
			// matches data/.rebuild-secret) bypass the rate limit, the
			// faster-than-realtime check, AND first-write-wins so the
			// rebuild-queue worker can replace stuck/broken audio.
			authed := rebuildSecret != "" &&
				constantTimeEq(r.Header.Get("X-Rebuild-Secret"), rebuildSecret)
			if !authed {
				if ok, reason := shareStore.RateLimitPUT(r); !ok {
					w.Header().Set("Retry-After", "60")
					httpErrorNoStore(w, reason, http.StatusTooManyRequests)
					return
				}
				// Faster-than-realtime check — see CLAUDE.md and
				// share/duration.go for the "honest in-tab render"
				// model. Worker uploads skip this because they're
				// trusted by secret.
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
			var wrote bool
			if authed {
				if _, err := ar.OverwriteClientRender(cid, body); err != nil {
					log.Printf("audio overwrite %s: %v", cid, err)
					httpErrorNoStore(w, "overwrite failed", http.StatusInternalServerError)
					return
				}
				wrote = true
				log.Printf("audio: authenticated overwrite %s (%d bytes)", cid, len(body))
			} else {
				_, w2, err := ar.IngestClientRender(cid, body)
				if err != nil {
					log.Printf("audio ingest %s: %v", cid, err)
					httpErrorNoStore(w, "ingest failed", http.StatusInternalServerError)
					return
				}
				wrote = w2
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
	seed := int64(0)
	switch v := project["seed"].(type) {
	case float64:
		seed = int64(v)
	case int64:
		seed = v
	case int:
		seed = int64(v)
	}
	envelope := map[string]any{
		"@context": "https://beats.bitwrap.io/schema/beats-share.context.jsonld",
		"@type":    "BeatsShare",
		"v":        1,
		"genre":    genre,
		"seed":     seed,
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
	// Musical key: rootNote (MIDI) + scaleName drive the share-card KEY
	// label. Composer-generated projects always set both; hand-authored
	// shares may omit them, in which case the card renderer falls back
	// to "—". Bars feeds the BARS field next to KEY.
	switch v := project["rootNote"].(type) {
	case float64:
		envelope["rootNote"] = int(v)
	case int:
		envelope["rootNote"] = v
	case int64:
		envelope["rootNote"] = int(v)
	}
	if s, ok := project["scaleName"].(string); ok && s != "" {
		envelope["scaleName"] = s
	}
	switch v := project["bars"].(type) {
	case float64:
		if int(v) > 0 {
			envelope["bars"] = int(v)
		}
	case int:
		if v > 0 {
			envelope["bars"] = v
		}
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

// analysisHandler answers /api/analysis/{cid}.
//   GET: public; returns the BeatsAudioAnalysis JSON-LD envelope, or
//        404 if no row exists. No-store on the response so refreshes
//        always reflect the latest analyzer pass.
//   PUT: gated by X-Rebuild-Secret. Body is a BeatsAudioAnalysis
//        JSON-LD envelope (analyzer worker output). Upsert merges
//        non-null fields with whatever the renderer's loudnorm pass
//        already wrote — so an analyzer run that omits LUFS keeps
//        the in-band loudnorm measurement.
func analysisHandler(idx *index.DB, rebuildSecret string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cid := strings.TrimPrefix(r.URL.Path, "/api/analysis/")
		if !audiorender.ValidCID(cid) {
			http.Error(w, "invalid cid", http.StatusBadRequest)
			return
		}
		switch r.Method {
		case http.MethodGet:
			a, err := idx.GetAnalysis(cid)
			if err != nil {
				log.Printf("analysis get %s: %v", cid, err)
				http.Error(w, "analysis query failed", http.StatusInternalServerError)
				return
			}
			if a == nil {
				http.Error(w, "no analysis", http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Type", "application/ld+json")
			w.Header().Set("Cache-Control", "no-store")
			env := map[string]any{
				"@context":         "https://beats.bitwrap.io/schema/beats-audio-analysis.context.jsonld",
				"@type":            "BeatsAudioAnalysis",
				"cid":              a.CID,
				"analyzerVersion":  a.AnalyzerVersion,
				"analyzedAt":       a.AnalyzedAt,
				"source":           a.Source,
			}
			addF := func(k string, p *float64) {
				if p != nil {
					env[k] = *p
				}
			}
			addF("durationS", a.DurationS)
			addF("lufs", a.LUFS)
			addF("truePeakDb", a.TruePeakDb)
			addF("peak", a.Peak)
			addF("rms", a.RMS)
			addF("crestDb", a.CrestDb)
			addF("centroidHz", a.CentroidHz)
			addF("rolloff85Hz", a.Rolloff85Hz)
			addF("onsetRate", a.OnsetRate)
			addF("bpm", a.BPM)
			addF("bandSub", a.BandSub)
			addF("bandLow", a.BandLow)
			addF("bandLomid", a.BandLomid)
			addF("bandHimid", a.BandHimid)
			addF("bandHigh", a.BandHigh)
			addF("hpfHz", a.HpfHz)
			_ = json.NewEncoder(w).Encode(env)
		case http.MethodPut:
			if rebuildSecret == "" || !constantTimeEq(r.Header.Get("X-Rebuild-Secret"), rebuildSecret) {
				http.Error(w, "X-Rebuild-Secret required", http.StatusUnauthorized)
				return
			}
			body, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
			if err != nil {
				http.Error(w, "read body", http.StatusBadRequest)
				return
			}
			var env struct {
				CID             string   `json:"cid"`
				AnalyzerVersion string   `json:"analyzerVersion"`
				AnalyzedAt      int64    `json:"analyzedAt"`
				Source          string   `json:"source"`
				DurationS       *float64 `json:"durationS"`
				LUFS            *float64 `json:"lufs"`
				TruePeakDb      *float64 `json:"truePeakDb"`
				Peak            *float64 `json:"peak"`
				RMS             *float64 `json:"rms"`
				CrestDb         *float64 `json:"crestDb"`
				CentroidHz      *float64 `json:"centroidHz"`
				Rolloff85Hz     *float64 `json:"rolloff85Hz"`
				OnsetRate       *float64 `json:"onsetRate"`
				BPM             *float64 `json:"bpm"`
				BandSub         *float64 `json:"bandSub"`
				BandLow         *float64 `json:"bandLow"`
				BandLomid       *float64 `json:"bandLomid"`
				BandHimid       *float64 `json:"bandHimid"`
				BandHigh        *float64 `json:"bandHigh"`
				HpfHz           *float64 `json:"hpfHz"`
			}
			if err := json.Unmarshal(body, &env); err != nil {
				http.Error(w, "bad json", http.StatusBadRequest)
				return
			}
			// Body cid (if set) must match URL cid. Defaults to URL cid.
			if env.CID != "" && env.CID != cid {
				http.Error(w, "cid mismatch", http.StatusBadRequest)
				return
			}
			if env.Source == "" {
				env.Source = "analyzer"
			}
			a := index.Analysis{
				CID:             cid,
				AnalyzerVersion: env.AnalyzerVersion,
				AnalyzedAt:      env.AnalyzedAt,
				Source:          env.Source,
				DurationS:       env.DurationS, LUFS: env.LUFS,
				TruePeakDb: env.TruePeakDb, Peak: env.Peak, RMS: env.RMS,
				CrestDb: env.CrestDb, CentroidHz: env.CentroidHz,
				Rolloff85Hz: env.Rolloff85Hz, OnsetRate: env.OnsetRate,
				BPM: env.BPM, BandSub: env.BandSub, BandLow: env.BandLow,
				BandLomid: env.BandLomid, BandHimid: env.BandHimid,
				BandHigh: env.BandHigh, HpfHz: env.HpfHz,
			}
			if err := idx.UpsertAnalysis(a); err != nil {
				log.Printf("analysis upsert %s: %v", cid, err)
				http.Error(w, "upsert failed", http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "GET or PUT only", http.StatusMethodNotAllowed)
		}
	}
}

// featuresHandler exposes runtime feature flags so the gallery JS can
// decide whether to render optional UI (currently just the rebuild
// queue button). Cheap, no-cache, public.
func featuresHandler(rebuildQueue bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "public, max-age=300")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"rebuildQueue": rebuildQueue,
			"genreColors":  share.GenreColors(),
		})
	}
}

// archiveMissingHandler answers GET /api/archive-missing?limit=N
// with the list of share-store CIDs that have no corresponding row in
// the rendered-audio index. Used by an offline worker
// (scripts/process-rebuild-queue.py --archive) to drive a
// full-collection backfill — the worker reads this list, renders
// each via its local -audio-render server, and PUTs the .webm back
// to /audio/{cid}.webm with X-Rebuild-Secret.
//
// Returns at most `limit` CIDs (default 200, max 2000) to bound the
// response. The order is unspecified; the worker just drains until
// the endpoint reports zero.
func archiveMissingHandler(idx *index.DB, store *share.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := 200
		if v := r.URL.Query().Get("limit"); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				limit = n
			}
		}
		if limit > 2000 {
			limit = 2000
		}
		rendered, err := idx.HasCIDs()
		if err != nil {
			http.Error(w, "index error", http.StatusInternalServerError)
			return
		}
		all := store.AllCIDs()
		missing := make([]string, 0, limit)
		for _, cid := range all {
			if _, ok := rendered[cid]; ok {
				continue
			}
			missing = append(missing, cid)
			if len(missing) >= limit {
				break
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"missing":      missing,
			"totalShares":  len(all),
			"totalAudio":   len(rendered),
			"limit":        limit,
			"truncated":    len(missing) >= limit,
		})
	}
}

// snapshotHandler streams a .tar.gz of the catalogue. Layout:
//   o/{cid}.json       — every share envelope (always included)
//   audio/{cid}.webm   — every cached render (when ?audio=1)
//   index.db           — sqlite track index    (when ?db=1)
// The envelopes are the canonical state; audio + db are derived
// (audio is re-renderable from envelopes; db is rebuildable via
// backfillIndex). Including them just skips reconstruction work on
// restore. Auth via X-Rebuild-Secret.
func snapshotHandler(store *share.Store, ar *audiorender.Renderer, indexPath string, rebuildSecret string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			http.Error(w, "GET or POST only", http.StatusMethodNotAllowed)
			return
		}
		includeAudio := r.URL.Query().Get("audio") == "1"
		includeDB := r.URL.Query().Get("db") == "1"
		// Envelopes-only is the canonical state and small (~hundreds of
		// KB even with thousands of shares), so it's safe to expose
		// publicly as a backup users can keep. Audio + db variants stay
		// gated — multi-MB-to-GB and easily resaturated by repeat hits.
		if includeAudio || includeDB {
			if rebuildSecret == "" || !constantTimeEq(r.Header.Get("X-Rebuild-Secret"), rebuildSecret) {
				http.Error(w, "X-Rebuild-Secret required for audio / db variants", http.StatusUnauthorized)
				return
			}
		}
		createdAt := time.Now().UTC()
		ts := createdAt.Format("20060102-150405")
		w.Header().Set("Content-Type", "application/gzip")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Disposition",
			fmt.Sprintf(`attachment; filename="beats-snapshot-%s.tgz"`, ts))
		_, _ = writeSnapshot(w, store, ar, indexPath, r.Host, createdAt, includeAudio, includeDB)
	}
}

// writeSnapshot streams the .tar.gz body to w and returns the manifest
// describing what was written. Used by both the streaming HTTP handler
// and the persisted-snapshot manager (which writes to a file).
func writeSnapshot(w io.Writer, store *share.Store, ar *audiorender.Renderer,
	indexPath string, host string, createdAt time.Time, includeAudio, includeDB bool,
) (map[string]any, error) {
	gz := gzip.NewWriter(w)
	tw := tar.NewWriter(gz)
	// Snapshot the share-store CID list up-front so the manifest
	// records what *should* be in the tar (the snapshot streamer
	// may skip vanished entries). Cheap — in-memory map iteration.
	cids := store.AllCIDs()
	sort.Strings(cids)
	envCount, envBytes, err := store.Snapshot(tw)
	if err != nil {
		log.Printf("snapshot envelopes: %v (after %d / %d bytes)", err, envCount, envBytes)
	}
	var audioCount int
	var audioBytes int64
	if includeAudio && ar != nil {
		audioCount, audioBytes, err = ar.Snapshot(tw)
		if err != nil {
			log.Printf("snapshot audio: %v (after %d / %d bytes)", err, audioCount, audioBytes)
		}
	}
	dbBytes := int64(0)
	if includeDB && indexPath != "" {
		if info, err := os.Stat(indexPath); err == nil {
			if data, err := os.ReadFile(indexPath); err == nil {
				hdr := &tar.Header{
					Name:    "index.db",
					Mode:    0o644,
					Size:    int64(len(data)),
					ModTime: info.ModTime(),
				}
				if err := tw.WriteHeader(hdr); err == nil {
					if n, err := tw.Write(data); err == nil {
						dbBytes = int64(n)
					}
				}
			}
		}
	}
	// Manifest is appended last — its sizes/counts are only known
	// after streaming. Tar readers can still extract by name in any
	// position (`tar -xzOf snap.tgz manifest.json`).
	manifest := buildSnapshotManifest(host, createdAt, includeAudio, includeDB,
		cids, envCount, envBytes, audioCount, audioBytes, dbBytes)
	manifestBody, _ := json.MarshalIndent(manifest, "", "  ")
	hdr := &tar.Header{
		Name:    "manifest.json",
		Mode:    0o644,
		Size:    int64(len(manifestBody)),
		ModTime: createdAt,
	}
	if err := tw.WriteHeader(hdr); err == nil {
		_, _ = tw.Write(manifestBody)
	}
	_ = tw.Close()
	_ = gz.Close()
	log.Printf("snapshot: %d envelopes (%d B) + %d audio (%d B) + db %d B",
		envCount, envBytes, audioCount, audioBytes, dbBytes)
	return manifest, nil
}

// buildSnapshotManifest is the JSON-LD manifest embedded in every
// snapshot tarball as `manifest.json` and also returned standalone
// from `/api/snapshot-manifest` (so the /archive page can render the
// same data without untarring an archive). The shape is intentionally
// linked-data so consumers can join it with the existing share-v1
// graph (each `cids[]` entry resolves at /o/{cid} as a `BeatsShare`).
func buildSnapshotManifest(host string, createdAt time.Time, includeAudio, includeDB bool,
	cids []string, envCount int, envBytes int64, audioCount int, audioBytes int64, dbBytes int64,
) map[string]any {
	scheme := "https"
	if strings.HasPrefix(host, "localhost") || strings.HasPrefix(host, "127.0.0.1") {
		scheme = "http"
	}
	base := scheme + "://" + host
	return map[string]any{
		"@context":  base + "/schema/snapshot-manifest",
		"@type":     "BeatsSnapshotManifest",
		"version":   1,
		"createdAt": createdAt.Format(time.RFC3339),
		"host":      host,
		"includes": map[string]bool{
			"envelopes": true,
			"audio":     includeAudio,
			"db":        includeDB,
		},
		"envelopes": map[string]any{
			"count": envCount,
			"bytes": envBytes,
			"cids":  cids,
		},
		"audio": map[string]any{
			"count": audioCount,
			"bytes": audioBytes,
		},
		"indexDb": map[string]any{
			"bytes": dbBytes,
		},
		"restore": "scripts/process-rebuild-queue.py --restore <this-file>",
		"docs":    "https://github.com/stackdump/beats-bitwrap-io#archival--restore",
	}
}

// snapshotManifestHandler returns the JSON-LD manifest of "what an
// envelopes-only snapshot taken right now would contain". Cheap — no
// disk I/O beyond what AllCIDs() already keeps in memory. The /archive
// page embeds this inline as a <script type="application/ld+json"> so
// crawlers (and offline backups of the page) get the catalogue's
// canonical state without needing to download the full tarball.
func snapshotManifestHandler(store *share.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cids := store.AllCIDs()
		sort.Strings(cids)
		manifest := buildSnapshotManifest(r.Host, time.Now().UTC(), false, false,
			cids, len(cids), 0, 0, 0, 0)
		w.Header().Set("Content-Type", "application/ld+json")
		w.Header().Set("Cache-Control", "public, max-age=60")
		_ = json.NewEncoder(w).Encode(manifest)
	}
}

// persistedSnapshotHandler accepts POST /api/snapshot-persist?label=<tag>
// with X-Rebuild-Secret. Writes a snapshot tarball + sidecar JSON
// manifest into snapshotDir. The label rides along in the sidecar so
// the /archive page can group related captures (e.g. "experiment-A"
// before/after a series of edits). audio=1 and db=1 are honored
// (operator already authenticated, so the heavier tiers are fair).
func persistedSnapshotHandler(snapshotDir string, store *share.Store, ar *audiorender.Renderer,
	indexPath string, rebuildSecret string,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		if rebuildSecret == "" || !constantTimeEq(r.Header.Get("X-Rebuild-Secret"), rebuildSecret) {
			http.Error(w, "X-Rebuild-Secret required", http.StatusUnauthorized)
			return
		}
		if snapshotDir == "" {
			http.Error(w, "snapshot dir not configured", http.StatusInternalServerError)
			return
		}
		if err := os.MkdirAll(snapshotDir, 0o755); err != nil {
			http.Error(w, "mkdir: "+err.Error(), http.StatusInternalServerError)
			return
		}
		label := strings.TrimSpace(r.URL.Query().Get("label"))
		// Sanitize: keep filenames safe + URL-safe.
		label = sanitizeSnapshotLabel(label)
		includeAudio := r.URL.Query().Get("audio") == "1"
		includeDB := r.URL.Query().Get("db") == "1"
		createdAt := time.Now().UTC()
		ts := createdAt.Format("20060102-150405")
		base := "beats-snapshot-" + ts
		if label != "" {
			base += "-" + label
		}
		tgzPath := filepath.Join(snapshotDir, base+".tgz")
		jsonPath := filepath.Join(snapshotDir, base+".json")
		f, err := os.Create(tgzPath)
		if err != nil {
			http.Error(w, "create: "+err.Error(), http.StatusInternalServerError)
			return
		}
		manifest, err := writeSnapshot(f, store, ar, indexPath, r.Host, createdAt, includeAudio, includeDB)
		_ = f.Close()
		if err != nil {
			_ = os.Remove(tgzPath)
			http.Error(w, "snapshot: "+err.Error(), http.StatusInternalServerError)
			return
		}
		// Sidecar manifest: enriched with label + on-disk size + filename
		// so the listing endpoint stays a single-file read per entry.
		info, _ := os.Stat(tgzPath)
		manifest["label"] = label
		manifest["filename"] = base + ".tgz"
		manifest["sizeBytes"] = func() int64 { if info != nil { return info.Size() }; return 0 }()
		body, _ := json.MarshalIndent(manifest, "", "  ")
		if err := os.WriteFile(jsonPath, body, 0o644); err != nil {
			log.Printf("snapshot sidecar %s: %v", jsonPath, err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(manifest)
	}
}

// snapshotsListHandler answers GET /api/snapshots with the sidecar
// manifests of every persisted snapshot. Cheap (reads only the tiny
// sidecar JSON, never opens the tarball). Public — the same data is
// already in the tarballs which are themselves public via /snapshots/.
func snapshotsListHandler(snapshotDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		out := loadSnapshotSidecars(snapshotDir)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"snapshots": out,
			"count":     len(out),
		})
	}
}

// archiveRSSHandler answers GET /archive.rss with one item per
// persisted snapshot, newest first. Each <enclosure> points at the
// .tgz so RSS clients can fetch the artifact directly.
func archiveRSSHandler(snapshotDir, publicURL string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		entries := loadSnapshotSidecars(snapshotDir)
		w.Header().Set("Content-Type", "application/rss+xml; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		fmt.Fprint(w, `<?xml version="1.0" encoding="UTF-8"?>`+"\n")
		fmt.Fprint(w, `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">`+"\n")
		fmt.Fprint(w, "<channel>\n")
		fmt.Fprintf(w, "  <title>%s · archive snapshots</title>\n", xmlEscape(publicURL))
		fmt.Fprintf(w, "  <link>%s/archive</link>\n", xmlEscape(publicURL))
		fmt.Fprint(w, "  <description>Persisted backups of the beats.bitwrap.io share-store catalogue. Each item is a self-contained .tar.gz of every share envelope (and optionally audio + db) at a moment in time.</description>\n")
		fmt.Fprintf(w, `  <atom:link href="%s/archive.rss" rel="self" type="application/rss+xml"/>`+"\n", xmlEscape(publicURL))
		for _, e := range entries {
			filename, _ := e["filename"].(string)
			label, _ := e["label"].(string)
			createdAt, _ := e["createdAt"].(string)
			sizeBytes := int64(0)
			if v, ok := e["sizeBytes"].(float64); ok {
				sizeBytes = int64(v)
			}
			envCount := 0
			if env, ok := e["envelopes"].(map[string]any); ok {
				if c, ok := env["count"].(float64); ok {
					envCount = int(c)
				}
			}
			title := filename
			if label != "" {
				title = label + " · " + createdAt
			}
			pubDate := ""
			if t, err := time.Parse(time.RFC3339, createdAt); err == nil {
				pubDate = t.Format(time.RFC1123Z)
			}
			url := fmt.Sprintf("%s/snapshots/%s", publicURL, filename)
			desc := fmt.Sprintf("%d envelopes · %s",
				envCount, humanBytes(sizeBytes))
			if label != "" {
				desc = "[" + label + "] " + desc
			}
			fmt.Fprint(w, "  <item>\n")
			fmt.Fprintf(w, "    <title>%s</title>\n", xmlEscape(title))
			fmt.Fprintf(w, "    <link>%s</link>\n", xmlEscape(url))
			fmt.Fprintf(w, "    <guid isPermaLink=\"true\">%s</guid>\n", xmlEscape(url))
			fmt.Fprintf(w, "    <description>%s</description>\n", xmlEscape(desc))
			if pubDate != "" {
				fmt.Fprintf(w, "    <pubDate>%s</pubDate>\n", pubDate)
			}
			fmt.Fprintf(w, "    <enclosure url=\"%s\" length=\"%d\" type=\"application/gzip\"/>\n", xmlEscape(url), sizeBytes)
			fmt.Fprint(w, "  </item>\n")
		}
		fmt.Fprint(w, "</channel>\n</rss>\n")
	}
}

// archiveLookupHandler answers GET /api/archive-lookup?cid=X with the
// list of persisted snapshots that contain CID X. Cheap — scans only
// the small sidecar manifests, never opens a tarball. Returns the
// snapshot filenames newest-first, plus a `liveStore` flag so the
// caller can tell whether the live share store still has it.
func archiveLookupHandler(snapshotDir string, store *share.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cid := r.URL.Query().Get("cid")
		if cid == "" {
			http.Error(w, "cid required", http.StatusBadRequest)
			return
		}
		if !audiorender.ValidCID(cid) {
			http.Error(w, "invalid cid", http.StatusBadRequest)
			return
		}
		_, liveErr := store.Lookup(cid)
		live := liveErr == nil
		var hits []map[string]any
		for _, m := range loadSnapshotSidecars(snapshotDir) {
			env, _ := m["envelopes"].(map[string]any)
			if env == nil {
				continue
			}
			cids, _ := env["cids"].([]any)
			for _, c := range cids {
				if cs, _ := c.(string); cs == cid {
					hits = append(hits, map[string]any{
						"filename":  m["filename"],
						"label":     m["label"],
						"createdAt": m["createdAt"],
					})
					break
				}
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"cid":       cid,
			"live":      live,
			"snapshots": hits,
			"found":     live || len(hits) > 0,
		})
	}
}

// archiveRestoreHandler accepts POST /api/archive-restore?cid=X. Walks
// the persisted snapshots newest-first, opens the first tarball that
// contains o/{cid}.json, and re-seals it into the live share store via
// SealDirect (which re-verifies the CID). Idempotent — if the CID is
// already live, returns 200 with `restored: false`. No auth: the
// snapshots are themselves public, so anyone can already grab the
// envelope and PUT it back through /o/{cid}; this endpoint just saves
// them the round trip.
func archiveRestoreHandler(snapshotDir string, store *share.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		cid := r.URL.Query().Get("cid")
		if cid == "" {
			var body struct {
				CID string `json:"cid"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			cid = body.CID
		}
		if cid == "" {
			http.Error(w, "cid required", http.StatusBadRequest)
			return
		}
		if !audiorender.ValidCID(cid) {
			http.Error(w, "invalid cid", http.StatusBadRequest)
			return
		}
		if _, err := store.Lookup(cid); err == nil {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"cid": cid, "restored": false, "live": true,
			})
			return
		}
		body, source, err := extractEnvelopeFromSnapshots(snapshotDir, cid)
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		if err := store.SealDirect(cid, body); err != nil {
			http.Error(w, "seal: "+err.Error(), http.StatusInternalServerError)
			return
		}
		log.Printf("archive-restore: %s ← %s", cid, source)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"cid": cid, "restored": true, "live": true, "source": source,
		})
	}
}

// extractEnvelopeFromSnapshots walks persisted snapshots newest-first
// and returns the raw envelope bytes for the first one containing
// o/{cid}.json. Returns the source filename for logging.
func extractEnvelopeFromSnapshots(snapshotDir, cid string) ([]byte, string, error) {
	target := "o/" + cid + ".json"
	for _, m := range loadSnapshotSidecars(snapshotDir) {
		filename, _ := m["filename"].(string)
		if filename == "" {
			continue
		}
		// Only open the tarball if the sidecar's CID list actually
		// includes our target — saves opening every archive when the
		// CID isn't here.
		env, _ := m["envelopes"].(map[string]any)
		if env == nil {
			continue
		}
		cids, _ := env["cids"].([]any)
		hit := false
		for _, c := range cids {
			if cs, _ := c.(string); cs == cid {
				hit = true
				break
			}
		}
		if !hit {
			continue
		}
		full := filepath.Join(snapshotDir, filename)
		f, err := os.Open(full)
		if err != nil {
			continue
		}
		gz, err := gzip.NewReader(f)
		if err != nil {
			_ = f.Close()
			continue
		}
		tr := tar.NewReader(gz)
		for {
			hdr, err := tr.Next()
			if err != nil {
				break
			}
			if hdr.Name != target {
				continue
			}
			body, err := io.ReadAll(io.LimitReader(tr, 1<<20))
			_ = gz.Close()
			_ = f.Close()
			if err != nil {
				return nil, "", fmt.Errorf("read envelope: %w", err)
			}
			return body, filename, nil
		}
		_ = gz.Close()
		_ = f.Close()
	}
	return nil, "", fmt.Errorf("cid %s not found in any snapshot", cid)
}

// snapshotContentsHandler answers GET /api/snapshot-contents?file=X
// with a feed-shaped track list ([{cid, name, genre, seed, tempo}, …])
// derived from the envelopes inside the snapshot tarball. Lets the
// /feed page render any snapshot's contents using the same card +
// player UI as the live feed. Public — the underlying tarball is
// already public via /snapshots/{file}.
func snapshotContentsHandler(snapshotDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		file := r.URL.Query().Get("file")
		if file == "" || strings.ContainsAny(file, "/\\") || !strings.HasSuffix(file, ".tgz") {
			http.Error(w, "valid file= required", http.StatusBadRequest)
			return
		}
		full := filepath.Join(snapshotDir, file)
		f, err := os.Open(full)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		gz, err := gzip.NewReader(f)
		if err != nil {
			http.Error(w, "gzip: "+err.Error(), http.StatusInternalServerError)
			return
		}
		defer gz.Close()
		tr := tar.NewReader(gz)
		type track struct {
			CID   string `json:"cid"`
			Name  string `json:"name,omitempty"`
			Genre string `json:"genre,omitempty"`
			Seed  int64  `json:"seed,omitempty"`
			Tempo int    `json:"tempo,omitempty"`
		}
		var out []track
		for {
			hdr, err := tr.Next()
			if err != nil {
				break
			}
			if !strings.HasPrefix(hdr.Name, "o/") || !strings.HasSuffix(hdr.Name, ".json") {
				continue
			}
			cid := strings.TrimSuffix(strings.TrimPrefix(hdr.Name, "o/"), ".json")
			body, err := io.ReadAll(io.LimitReader(tr, 256*1024))
			if err != nil {
				continue
			}
			var p struct {
				Name  string `json:"name"`
				Genre string `json:"genre"`
				Seed  int64  `json:"seed"`
				Tempo int    `json:"tempo"`
			}
			_ = json.Unmarshal(body, &p)
			out = append(out, track{
				CID: cid, Name: p.Name, Genre: p.Genre, Seed: p.Seed, Tempo: p.Tempo,
			})
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "public, max-age=300")
		_ = json.NewEncoder(w).Encode(out)
	}
}

// snapshotFileHandler serves files from snapshotDir. Restricted to
// .tgz and .json (the artifact + sidecar manifest); everything else
// 404s. No directory listing — clients hit /api/snapshots for that.
// Path traversal is blocked by rejecting any name containing "/".
func snapshotFileHandler(snapshotDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Path
		if name == "" || strings.ContainsAny(name, "/\\") {
			http.NotFound(w, r)
			return
		}
		if !strings.HasSuffix(name, ".tgz") && !strings.HasSuffix(name, ".json") {
			http.NotFound(w, r)
			return
		}
		full := filepath.Join(snapshotDir, name)
		info, err := os.Stat(full)
		if err != nil || info.IsDir() {
			http.NotFound(w, r)
			return
		}
		if strings.HasSuffix(name, ".tgz") {
			w.Header().Set("Content-Type", "application/gzip")
			w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
		} else {
			w.Header().Set("Content-Type", "application/ld+json")
		}
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		http.ServeFile(w, r, full)
	}
}

// loadSnapshotSidecars reads every *.json sidecar in snapshotDir,
// parses it as a manifest, and returns them sorted newest-first.
// Skips unreadable / malformed files quietly — operator-grade endpoint,
// no need to surface filesystem dust.
func loadSnapshotSidecars(snapshotDir string) []map[string]any {
	if snapshotDir == "" {
		return nil
	}
	entries, err := os.ReadDir(snapshotDir)
	if err != nil {
		return nil
	}
	out := make([]map[string]any, 0, len(entries))
	for _, ent := range entries {
		name := ent.Name()
		if !strings.HasSuffix(name, ".json") || ent.IsDir() {
			continue
		}
		body, err := os.ReadFile(filepath.Join(snapshotDir, name))
		if err != nil {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal(body, &m); err != nil {
			continue
		}
		// Defensive: ensure filename is set even if sidecar predates
		// that field. Strip .json and append .tgz.
		if _, ok := m["filename"]; !ok {
			m["filename"] = strings.TrimSuffix(name, ".json") + ".tgz"
		}
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool {
		ai, _ := out[i]["createdAt"].(string)
		aj, _ := out[j]["createdAt"].(string)
		return ai > aj
	})
	return out
}

// sanitizeSnapshotLabel keeps only [A-Za-z0-9_-], collapses runs of
// other chars to "-", caps at 32. Result is filename- and URL-safe.
func sanitizeSnapshotLabel(s string) string {
	if s == "" {
		return ""
	}
	var b strings.Builder
	prevDash := false
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || r == '_' || r == '-' {
			b.WriteRune(r)
			prevDash = false
		} else if !prevDash {
			b.WriteRune('-')
			prevDash = true
		}
	}
	out := strings.Trim(b.String(), "-")
	if len(out) > 32 {
		out = out[:32]
	}
	return out
}

func humanBytes(n int64) string {
	switch {
	case n < 1024:
		return fmt.Sprintf("%d B", n)
	case n < 1024*1024:
		return fmt.Sprintf("%.1f KB", float64(n)/1024)
	default:
		return fmt.Sprintf("%.1f MB", float64(n)/1024/1024)
	}
}

// archiveDeleteHandler accepts POST /api/archive-delete {cid} with
// X-Rebuild-Secret. Cascade-removes the CID across every persistence
// layer — share store, audio cache, track index, rebuild queue —
// so it's truly gone (not just hidden). Idempotent: deleting an
// absent CID is a no-op 200.
func archiveDeleteHandler(idx *index.DB, store *share.Store, ar *audiorender.Renderer, rebuildSecret string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost && r.Method != http.MethodDelete {
			http.Error(w, "POST or DELETE only", http.StatusMethodNotAllowed)
			return
		}
		if rebuildSecret == "" || !constantTimeEq(r.Header.Get("X-Rebuild-Secret"), rebuildSecret) {
			http.Error(w, "X-Rebuild-Secret required", http.StatusUnauthorized)
			return
		}
		var req struct {
			CID string `json:"cid"`
		}
		if r.URL.Query().Get("cid") != "" {
			req.CID = r.URL.Query().Get("cid")
		} else {
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, "bad json", http.StatusBadRequest)
				return
			}
		}
		if !audiorender.ValidCID(req.CID) {
			http.Error(w, "invalid cid", http.StatusBadRequest)
			return
		}
		// Order: audio cache → track index → rebuild queue → share store.
		// Share store goes last so a partial failure leaves the canonical
		// envelope intact (recoverable) rather than the audio (which can
		// always be re-rendered).
		audioErr := ar.Delete(req.CID)
		idxErr := idx.DeleteTrack(req.CID)
		_ = idx.DeleteAnalysis(req.CID)
		shareErr := store.Delete(req.CID)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"cid":        req.CID,
			"audioError": errStr(audioErr),
			"indexError": errStr(idxErr),
			"shareError": errStr(shareErr),
			"deleted":    audioErr == nil && idxErr == nil && shareErr == nil,
		})
		if audioErr != nil || idxErr != nil || shareErr != nil {
			log.Printf("archive-delete %s: audio=%v idx=%v share=%v",
				req.CID, audioErr, idxErr, shareErr)
		}
	}
}

func errStr(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// rebuildMarkHandler accepts POST /api/rebuild-mark {cid}. Validates
// the CID exists in the share store, then inserts into the queue.
// Per-IP rate limit (reuses the share-store limiter) is the only
// abuse mitigation — the worker simply ignores duplicates and a
// successful re-render is idempotent on the audio side.
func rebuildMarkHandler(idx *index.DB, store *share.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		if ok, reason := store.RateLimitPUT(r); !ok {
			w.Header().Set("Retry-After", "60")
			http.Error(w, reason, http.StatusTooManyRequests)
			return
		}
		var req struct {
			CID string `json:"cid"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		if !audiorender.ValidCID(req.CID) {
			http.Error(w, "invalid cid", http.StatusBadRequest)
			return
		}
		if _, err := store.Lookup(req.CID); err != nil {
			http.Error(w, "cid not in share store", http.StatusNotFound)
			return
		}
		// Hash the requester IP so per-attribution stats are possible
		// without storing the raw IP. h64(ip) is plenty.
		hash := fnv.New64a()
		hash.Write([]byte(clientIP(r)))
		if err := idx.MarkRebuild(req.CID, fmt.Sprintf("%x", hash.Sum64())); err != nil {
			log.Printf("rebuild-mark %s: %v", req.CID, err)
			http.Error(w, "mark failed", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "cid": req.CID})
	}
}

// rebuildQueueHandler answers GET /api/rebuild-queue?limit= with a JSON
// array of CIDs awaiting re-render, oldest mark first. Off-host workers
// poll this and call /api/rebuild-clear after a successful upload.
func rebuildQueueHandler(idx *index.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := 100
		if v := r.URL.Query().Get("limit"); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				limit = n
			}
		}
		cids, err := idx.RebuildQueue(limit)
		if err != nil {
			log.Printf("rebuild-queue: %v", err)
			http.Error(w, "query failed", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(cids)
	}
}

// rebuildClearHandler accepts POST /api/rebuild-clear {cid} from
// workers after a successful re-render+upload. Rate-limited via the
// share-store limiter so the endpoint can't be spammed; no auth
// otherwise (same trust model as the queue itself — anyone could
// clear, but the cost is one extra worker attempt that is harmlessly
// idempotent).
func rebuildClearHandler(idx *index.DB, store *share.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		if ok, reason := store.RateLimitPUT(r); !ok {
			w.Header().Set("Retry-After", "60")
			http.Error(w, reason, http.StatusTooManyRequests)
			return
		}
		var req struct {
			CID string `json:"cid"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		if err := idx.ClearRebuild(req.CID); err != nil {
			log.Printf("rebuild-clear %s: %v", req.CID, err)
			http.Error(w, "clear failed", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	}
}

// loadOrCreateRebuildSecret reads the rebuild secret from path or
// generates a fresh 32-byte hex string and writes it (mode 0600) on
// first run. The secret authenticates worker uploads to PUT /audio
// — see audioHandler. Operators can read the file and pass it to
// scripts/process-rebuild-queue.py via BEATS_REBUILD_SECRET=$(cat ...).
func loadOrCreateRebuildSecret(path string) (string, error) {
	if b, err := os.ReadFile(path); err == nil {
		s := strings.TrimSpace(string(b))
		if len(s) >= 32 {
			return s, nil
		}
		// Existing file too short — regenerate rather than half-trust.
		log.Printf("rebuild-secret at %s too short (%d bytes); regenerating", path, len(s))
	}
	buf := make([]byte, 32)
	if _, err := cryptorand.Read(buf); err != nil {
		return "", fmt.Errorf("rand read: %w", err)
	}
	secret := hex.EncodeToString(buf)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", fmt.Errorf("mkdir: %w", err)
	}
	if err := os.WriteFile(path, []byte(secret+"\n"), 0o600); err != nil {
		return "", fmt.Errorf("write secret: %w", err)
	}
	return secret, nil
}

// readyzHandler probes the SQLite handle and the share-store directory
// so external monitors can tell "process up but hung" from "serving".
// Returns 503 with a `reason` field on any check failure; 200
// `{"ok":true}` otherwise. Wall-clock budget is small (sub-100ms on
// a healthy host).
func readyzHandler(idx *index.DB, shareDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 500*time.Millisecond)
		defer cancel()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if idx != nil {
			if err := idx.Ping(ctx); err != nil {
				w.WriteHeader(http.StatusServiceUnavailable)
				fmt.Fprintf(w, `{"ok":false,"reason":"db: %s"}`, err)
				return
			}
		}
		if _, err := os.Stat(shareDir); err != nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			fmt.Fprintf(w, `{"ok":false,"reason":"share dir: %s"}`, err)
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}
}

// recoverMiddleware wraps an http.Handler so a panic in any downstream
// handler is caught, logged with stack, and (if no response has been
// written yet) returned as a 500 instead of taking down the process.
// Panics from after the headers were written are unavoidable on the
// wire — the connection just closes — but the server stays up.
func recoverMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rv := recover(); rv != nil {
				log.Printf("panic: %s %s: %v\n%s",
					r.Method, r.URL.Path, rv, debug.Stack())
				// Best-effort 500 — http.ResponseWriter doesn't expose
				// "headers written" reliably, but Write returning an
				// error is fine since we're already in panic-recovery.
				w.WriteHeader(http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// constantTimeEq compares two strings in constant time; safe for
// secret comparison without the timing-attack risk of regular ==.
func constantTimeEq(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// clientIP returns the best-effort source IP from common forwarding
// headers, falling back to the raw RemoteAddr. Used only as input to
// the FNV hash stored in rebuild_queue.marked_by.
func clientIP(r *http.Request) string {
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		if i := strings.IndexByte(v, ','); i >= 0 {
			return strings.TrimSpace(v[:i])
		}
		return strings.TrimSpace(v)
	}
	if v := r.Header.Get("X-Real-IP"); v != "" {
		return strings.TrimSpace(v)
	}
	return r.RemoteAddr
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

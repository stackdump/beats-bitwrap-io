// Package audiorender turns a stored share-CID into a cached audio file
// by playing the page in headless Chromium and capturing its WebAudio
// output via MediaRecorder. The renderer is single-flight per CID, so a
// viral link only triggers one render even under concurrent fetches.
//
// Output is webm/opus — what MediaRecorder produces natively, no
// transcoding required. Cached at {storeDir}/audio/{YYYY}/{MM}/{cid}.webm
// (mirrors the share store's bucketing). Cache is LRU-evicted by access
// time when total bytes exceed the configured cap.
package audiorender

import (
	"archive/tar"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	cdlog "github.com/chromedp/cdproto/log"
	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/chromedp"
)

const (
	// Hard ceiling on a single render. Realistic tracks are 30s-3min;
	// anything past 10 minutes is almost certainly a render that hung.
	defaultRenderTimeout = 10 * time.Minute
	// How often to poll window.__renderDone in chromedp.
	pollInterval = 500 * time.Millisecond
)

var cidPattern = regexp.MustCompile(`^z[1-9A-HJ-NP-Za-km-z]{40,80}$`)

// ValidCID returns true when s looks like a share-store CID. Mirrors the
// pattern in internal/share/seal.go so the audio route can 400 obviously
// bad input before going near the renderer or the store.
func ValidCID(s string) bool { return cidPattern.MatchString(s) }

type Config struct {
	// CacheDir is the on-disk root for rendered audio. Year/month bucketing
	// happens under this. Required.
	CacheDir string
	// BaseURL is the host the headless browser navigates to (e.g.
	// "http://127.0.0.1:8089"). Required — chromedp opens
	// {BaseURL}/?cid={cid}&render=1.
	BaseURL string
	// MaxBytes caps total cache size in bytes. <=0 disables LRU eviction.
	MaxBytes int64
	// MaxConcurrent caps simultaneous renders. <=0 means 1 (renders are
	// CPU + RAM heavy, headless Chromium per render).
	MaxConcurrent int
	// RenderTimeout per CID. <=0 uses the default (10 min). This is the
	// hard kill for the chromedp context — covers stuck browsers,
	// hung audio devices, etc. Make it generously larger than MaxDuration.
	RenderTimeout time.Duration
	// MaxDuration caps the audio length the page is asked to record.
	// 0 = unbounded (still subject to RenderTimeout). Passed to the page
	// as ?maxMs=N so the recorder stops on its own without waiting for
	// the natural end of an arbitrarily-long arranged track.
	MaxDuration time.Duration
	// ChromePath overrides chromedp's exec autodetection. Empty = autodetect.
	ChromePath string
	// LookupMetadata supplies WebM/Matroska tags (title/artist/genre/
	// comment/date) for a given CID. Called once per render after the
	// raw capture lands, before the file is renamed into place. Nil
	// (or returning an empty Metadata) skips the post-process step
	// and the file ships with only the encoder/language tags Chrome
	// auto-writes. Wired in main.go to the share store.
	LookupMetadata func(cid string) Metadata
	// FFmpegPath overrides ffmpeg autodetection. Empty = "ffmpeg" on
	// PATH. Set by main.go from -ffmpeg flag if needed; the prod host
	// has /usr/bin/ffmpeg installed.
	FFmpegPath string
	// OnRenderComplete fires after a render lands on disk (post
	// rename, before LRU eviction). Wired in main.go to upsert the
	// SQLite index row that backs /api/feed and /api/audio-latest.
	// Errors are observational — the audio file is already cached
	// even if the index hiccups.
	OnRenderComplete func(cid string)
}

// Metadata is the set of tags written into the Matroska container
// after capture. Empty fields are skipped — ffmpeg won't write blank
// tags. Title is the user-facing label (composer's auto-name like
// "techno · Crystal Ember", or a hand-authored name); Comment is the
// canonical share URL so a downloaded .webm is self-locating.
// Copyright/License default to CC BY 4.0 (the same license YouTube
// surfaces under its Creative Commons option) so consumers can reuse
// the audio with attribution. Override per-field if a hand-authored
// share ever needs different terms.
type Metadata struct {
	Title     string
	Artist    string
	Album     string
	Genre     string
	Comment   string
	Date      string
	Copyright string
	License   string
}

type Renderer struct {
	cfg Config

	sem chan struct{} // bounds concurrent renders

	mu       sync.Mutex
	inflight map[string]chan struct{} // cid → channel closed when render finishes
	// Queue tracking — drives /api/audio-status. expectedMs is the
	// caller's track-length estimate (~= render wall-clock since the
	// renderer plays in realtime). Used to project wait totals across
	// the queue. If the caller didn't provide one, we fall back to
	// fallbackRenderMs as a placeholder so totals still add up.
	queued  map[string]int64     // cid → expectedMs, currently waiting on the sem
	running map[string]renderRun // cid → start time + expected
}

type renderRun struct {
	StartedAt  time.Time
	ExpectedMs int64
}

// Status mirrors the JSON shape returned by /api/audio-status.
type Status struct {
	State          string `json:"state"`           // ready | rendering | queued | missing
	ExpectedMs     int64  `json:"expectedMs,omitempty"`
	ElapsedMs      int64  `json:"elapsedMs,omitempty"`     // rendering: ms since render start
	QueuePosition  int    `json:"queuePosition,omitempty"` // queued: 1-based position
	WaitMs         int64  `json:"waitMs,omitempty"`        // queued: cumulative wait (renders ahead + current's remaining)
	SizeBytes      int64  `json:"sizeBytes,omitempty"`     // ready: cached file size
}

// fallbackRenderMs is the placeholder render time used when an Enqueue
// caller doesn't provide an expectedMs. Roughly the average track length.
const fallbackRenderMs int64 = 90_000

// maxQueueWaitMs caps the projected cumulative wait of the queue.
// Enqueues that would push the projected wait past this are rejected.
// 30 min is generous enough to absorb a small burst of fresh shares
// (each ~2 min realtime) while keeping the host from being held
// hostage by a long backlog if someone hammers the endpoint.
const maxQueueWaitMs int64 = 30 * 60 * 1000

func New(cfg Config) (*Renderer, error) {
	if cfg.CacheDir == "" {
		return nil, errors.New("audiorender: CacheDir required")
	}
	if cfg.BaseURL == "" {
		return nil, errors.New("audiorender: BaseURL required")
	}
	if cfg.MaxConcurrent <= 0 {
		cfg.MaxConcurrent = 1
	}
	if cfg.RenderTimeout <= 0 {
		cfg.RenderTimeout = defaultRenderTimeout
	}
	if err := os.MkdirAll(cfg.CacheDir, 0o755); err != nil {
		return nil, fmt.Errorf("audiorender: mkdir cache: %w", err)
	}
	return &Renderer{
		cfg:      cfg,
		sem:      make(chan struct{}, cfg.MaxConcurrent),
		inflight: map[string]chan struct{}{},
		queued:   map[string]int64{},
		running:  map[string]renderRun{},
	}, nil
}

// Snapshot streams every cached .webm into the given tar.Writer under
// "audio/{cid}.webm". Caller is responsible for the gzip wrapping.
// Returns (count, totalBytes, error). Files that vanish mid-walk are
// skipped silently — partial parity beats aborting the snapshot.
func (r *Renderer) Snapshot(tw *tar.Writer) (int, int64, error) {
	var (
		count int
		total int64
	)
	err := filepath.Walk(r.cfg.CacheDir, func(p string, info os.FileInfo, err error) error {
		if err != nil || info == nil || info.IsDir() {
			return nil
		}
		if !strings.HasSuffix(info.Name(), ".webm") {
			return nil
		}
		cid := strings.TrimSuffix(info.Name(), ".webm")
		if !ValidCID(cid) {
			return nil
		}
		f, err := os.Open(p)
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return fmt.Errorf("snapshot open %s: %w", cid, err)
		}
		hdr := &tar.Header{
			Name:    "audio/" + cid + ".webm",
			Mode:    0o644,
			Size:    info.Size(),
			ModTime: info.ModTime(),
		}
		if err := tw.WriteHeader(hdr); err != nil {
			f.Close()
			return fmt.Errorf("snapshot tar header %s: %w", cid, err)
		}
		written, err := io.Copy(tw, f)
		f.Close()
		if err != nil {
			return fmt.Errorf("snapshot tar body %s: %w", cid, err)
		}
		count++
		total += written
		return nil
	})
	return count, total, err
}

// Delete removes the cached .webm for cid (in any year/month bucket).
// Idempotent — returns nil if no cached file exists. Caller handles
// auth + cascading index cleanup.
func (r *Renderer) Delete(cid string) error {
	if !ValidCID(cid) {
		return fmt.Errorf("audiorender: invalid cid")
	}
	p := r.findExisting(cid)
	if p == "" {
		return nil
	}
	if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("audiorender: delete %s: %w", cid, err)
	}
	return nil
}

// CachePath returns the on-disk path where {cid}.webm lives (or would
// live). The file may not exist yet — call Stat or Render to check/produce.
func (r *Renderer) CachePath(cid string) string {
	now := time.Now().UTC()
	return filepath.Join(r.cfg.CacheDir,
		fmt.Sprintf("%04d", now.Year()),
		fmt.Sprintf("%02d", int(now.Month())),
		cid+".webm")
}

// CachedPath returns the path to the cached file for cid, or "" if no
// render exists yet. Cache-only — never spawns a render. Lets HEAD
// probes (e.g. the welcome card audio button) check availability
// without kicking off a multi-minute Chromium capture.
func (r *Renderer) CachedPath(cid string) string {
	if !ValidCID(cid) {
		return ""
	}
	return r.findExisting(cid)
}

// LatestCID returns the CID of the most recently rendered (or
// access-touched) audio file, or "" if the cache is empty. Uses
// the same mtime LRU eviction reads — so "latest" reflects recent
// listens too, not just first renders. Drives the footer's
// "latest" link.
func (r *Renderer) LatestCID() string {
	var newest string
	var newestMod int64
	_ = filepath.Walk(r.cfg.CacheDir, func(p string, info os.FileInfo, err error) error {
		if err != nil || info == nil || info.IsDir() {
			return nil
		}
		name := info.Name()
		if !strings.HasSuffix(name, ".webm") {
			return nil
		}
		if mt := info.ModTime().UnixNano(); mt > newestMod {
			newestMod = mt
			newest = strings.TrimSuffix(name, ".webm")
		}
		return nil
	})
	return newest
}

// findExisting walks the cache dir looking for {cid}.webm in any
// year/month bucket. Returns "" if absent. Slower than an in-memory
// index, but the cache is small enough (~10 GiB cap, ~100 KB/file =
// 100k files max) that the walk is fine and avoids restart bookkeeping.
func (r *Renderer) findExisting(cid string) string {
	var found string
	target := cid + ".webm"
	_ = filepath.Walk(r.cfg.CacheDir, func(p string, info os.FileInfo, err error) error {
		if err != nil || info == nil || info.IsDir() {
			return nil
		}
		if info.Name() == target {
			found = p
			return filepath.SkipAll
		}
		return nil
	})
	return found
}

// IngestClientRender stores a pre-rendered .webm blob (typically uploaded
// by the browser after its OfflineAudioContext finishes) at the canonical
// CachePath for cid. First-write-wins: returns (path, false, nil) if a
// render already exists so the original is never silently overwritten;
// returns (path, true, nil) on a successful new write. The caller is
// responsible for size + rate limiting before calling. Triggers eviction
// on the same LRU policy as server-side renders.
func (r *Renderer) IngestClientRender(cid string, body []byte) (path string, wrote bool, err error) {
	if !ValidCID(cid) {
		return "", false, fmt.Errorf("audiorender: invalid cid %q", cid)
	}
	if existing := r.findExisting(cid); existing != "" {
		_ = touchAccessTime(existing)
		return existing, false, nil
	}
	dst := r.CachePath(cid)
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return "", false, fmt.Errorf("audiorender: mkdir bucket: %w", err)
	}
	tmp := dst + ".tmp"
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return "", false, fmt.Errorf("audiorender: write tmp: %w", err)
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return "", false, fmt.Errorf("audiorender: rename: %w", err)
	}
	r.evictIfOverCap()
	return dst, true, nil
}

// OverwriteClientRender writes body unconditionally, replacing any
// existing cached render. Intended for authenticated worker uploads
// (the rebuild-queue path) where the operator explicitly wants to
// replace a broken file. Caller must verify auth before calling.
func (r *Renderer) OverwriteClientRender(cid string, body []byte) (path string, err error) {
	if !ValidCID(cid) {
		return "", fmt.Errorf("audiorender: invalid cid %q", cid)
	}
	dst := r.CachePath(cid)
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return "", fmt.Errorf("audiorender: mkdir bucket: %w", err)
	}
	// Sweep any prior render at a stale path (the bucket is YYYY/MM
	// from write time; a stub written in a different month would not
	// be at dst). findExisting walks the cache, so trust it.
	if old := r.findExisting(cid); old != "" && old != dst {
		_ = os.Remove(old)
	}
	tmp := dst + ".tmp"
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return "", fmt.Errorf("audiorender: write tmp: %w", err)
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("audiorender: rename: %w", err)
	}
	r.evictIfOverCap()
	return dst, nil
}

// Render returns the path to the rendered audio file for cid. On a cache
// hit it's instant; on a miss it spawns headless Chromium, records the
// track, and writes the file before returning. Concurrent calls for the
// same cid coalesce — only one render runs. expectedMs is the caller's
// estimate of render wall-clock (≈ track length); used by Status to
// project queue wait totals. Pass 0 to use the fallback estimate.
func (r *Renderer) Render(ctx context.Context, cid string, expectedMs int64) (string, error) {
	if !ValidCID(cid) {
		return "", fmt.Errorf("audiorender: invalid cid %q", cid)
	}
	if path := r.findExisting(cid); path != "" {
		_ = touchAccessTime(path)
		return path, nil
	}
	if expectedMs <= 0 {
		expectedMs = fallbackRenderMs
	}

	// Single-flight: if another goroutine is rendering the same CID,
	// wait on its channel and then retry the cache lookup.
	r.mu.Lock()
	if ch, ok := r.inflight[cid]; ok {
		r.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			return "", ctx.Err()
		}
		if path := r.findExisting(cid); path != "" {
			return path, nil
		}
		return "", fmt.Errorf("audiorender: peer render of %s failed", cid)
	}
	ch := make(chan struct{})
	r.inflight[cid] = ch
	r.queued[cid] = expectedMs
	r.mu.Unlock()

	defer func() {
		r.mu.Lock()
		delete(r.inflight, cid)
		delete(r.running, cid)
		delete(r.queued, cid)
		r.mu.Unlock()
		close(ch)
	}()

	// Bound concurrent renders.
	select {
	case r.sem <- struct{}{}:
	case <-ctx.Done():
		return "", ctx.Err()
	}
	defer func() { <-r.sem }()
	// Promote queued → running once we hold a sem slot.
	r.mu.Lock()
	delete(r.queued, cid)
	r.running[cid] = renderRun{StartedAt: time.Now(), ExpectedMs: expectedMs}
	r.mu.Unlock()

	path := r.CachePath(cid)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", fmt.Errorf("audiorender: mkdir bucket: %w", err)
	}

	renderCtx, cancel := context.WithTimeout(ctx, r.cfg.RenderTimeout)
	defer cancel()

	data, err := r.captureBlob(renderCtx, cid)
	if err != nil {
		return "", err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return "", fmt.Errorf("audiorender: write tmp: %w", err)
	}
	// Stamp Matroska tags via ffmpeg stream-copy. If LookupMetadata
	// is unset, ffmpeg isn't on PATH, or the call fails, log and
	// proceed with the raw Chromium output rather than failing the
	// whole render — a tagged file is nice-to-have, not load-bearing.
	if r.cfg.LookupMetadata != nil {
		md := r.cfg.LookupMetadata(cid)
		if md != (Metadata{}) {
			tagged := path + ".tagged"
			if err := writeTags(renderCtx, r.cfg.FFmpegPath, tmp, tagged, md); err == nil {
				_ = os.Remove(tmp)
				tmp = tagged
			} else {
				log.Printf("audiorender: tag %s: %v (shipping untagged)", cid, err)
				_ = os.Remove(tagged)
			}
		}
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("audiorender: rename: %w", err)
	}

	if r.cfg.OnRenderComplete != nil {
		r.cfg.OnRenderComplete(cid)
	}

	r.evictIfOverCap()

	return path, nil
}

// writeTags shells out to ffmpeg for a stream-copy tag rewrite. WebM
// is Matroska — same tag namespace, same -metadata flags. Stream copy
// is fast (~50-200 ms for a typical track) since no re-encode happens.
func writeTags(ctx context.Context, ffmpegPath, src, dst string, md Metadata) error {
	bin := ffmpegPath
	if bin == "" {
		bin = "ffmpeg"
	}
	args := []string{"-y", "-loglevel", "error", "-i", src, "-c", "copy", "-f", "webm"}
	add := func(k, v string) {
		if v == "" {
			return
		}
		args = append(args, "-metadata", k+"="+v)
	}
	add("title", md.Title)
	add("artist", md.Artist)
	add("album", md.Album)
	add("genre", md.Genre)
	add("comment", md.Comment)
	add("date", md.Date)
	add("copyright", md.Copyright)
	// Matroska tag spec uses LICENSE (uppercase) as a Track-level
	// tag for the rights URL; ffmpeg's -metadata flag normalises the
	// case in the output container.
	add("LICENSE", md.License)
	args = append(args, dst)
	cmd := exec.CommandContext(ctx, bin, args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("ffmpeg: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (r *Renderer) captureBlob(ctx context.Context, cid string) ([]byte, error) {
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.Flag("headless", "new"),
		chromedp.Flag("autoplay-policy", "no-user-gesture-required"),
		chromedp.Flag("mute-audio", "false"),
		chromedp.Flag("disable-gpu", "true"),
		chromedp.Flag("no-sandbox", "true"),
		chromedp.Flag("disable-dev-shm-usage", "true"),
		// Headless Chromium (even with --headless=new) treats the
		// render target as a backgrounded/occluded tab and throttles
		// setInterval/setTimeout — the sequencer worker fires slow
		// and bunchy, the audio scheduler re-anchors per fire, and
		// the recording captures audible jitter (see
		// scripts/measure-jitter.py against examples/metronome.json).
		// These three flags keep timers running at full rate.
		chromedp.Flag("disable-background-timer-throttling", "true"),
		chromedp.Flag("disable-backgrounding-occluded-windows", "true"),
		chromedp.Flag("disable-renderer-backgrounding", "true"),
	)
	if r.cfg.ChromePath != "" {
		opts = append(opts, chromedp.ExecPath(r.cfg.ChromePath))
	}
	allocCtx, cancelAlloc := chromedp.NewExecAllocator(ctx, opts...)
	defer cancelAlloc()

	browserCtx, cancelBrowser := chromedp.NewContext(allocCtx)
	defer cancelBrowser()

	// Surface page-side console messages + uncaught exceptions to the
	// server log. Indispensable when render-mode.js stalls — without
	// this, a thrown error in the page is invisible.
	chromedp.ListenTarget(browserCtx, func(ev any) {
		switch e := ev.(type) {
		case *runtime.EventConsoleAPICalled:
			parts := make([]string, 0, len(e.Args))
			for _, a := range e.Args {
				parts = append(parts, string(a.Value))
			}
			log.Printf("audiorender[%s] console.%s: %s", cid, e.Type, strings.Join(parts, " "))
		case *runtime.EventExceptionThrown:
			log.Printf("audiorender[%s] exception: %s", cid, e.ExceptionDetails.Error())
		case *cdlog.EventEntryAdded:
			log.Printf("audiorender[%s] log[%s/%s]: %s (%s)", cid,
				e.Entry.Source, e.Entry.Level, e.Entry.Text, e.Entry.URL)
		}
	})

	target := r.cfg.BaseURL + "/?cid=" + url.QueryEscape(cid) + "&render=1"
	if r.cfg.MaxDuration > 0 {
		target += fmt.Sprintf("&maxMs=%d", r.cfg.MaxDuration.Milliseconds())
	}

	if err := chromedp.Run(browserCtx,
		runtime.Enable(),
		cdlog.Enable(),
		chromedp.Navigate(target),
	); err != nil {
		return nil, fmt.Errorf("audiorender: navigate: %w", err)
	}

	// Poll window.__renderDone until set or context expires.
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for {
		var done bool
		if err := chromedp.Run(browserCtx, chromedp.Evaluate(`window.__renderDone === true`, &done)); err != nil {
			return nil, fmt.Errorf("audiorender: poll: %w", err)
		}
		if done {
			break
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}

	var renderErr string
	if err := chromedp.Run(browserCtx, chromedp.Evaluate(`window.__renderError || ""`, &renderErr)); err != nil {
		return nil, fmt.Errorf("audiorender: read error flag: %w", err)
	}
	if renderErr != "" {
		return nil, fmt.Errorf("audiorender: page error: %s", renderErr)
	}

	var b64 string
	if err := chromedp.Run(browserCtx, chromedp.Evaluate(`window.__renderBlob || ""`, &b64)); err != nil {
		return nil, fmt.Errorf("audiorender: read blob: %w", err)
	}
	if b64 == "" {
		return nil, errors.New("audiorender: empty blob")
	}
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, fmt.Errorf("audiorender: decode blob: %w", err)
	}
	if len(data) == 0 {
		return nil, errors.New("audiorender: zero-byte blob")
	}
	return data, nil
}

// Enqueue triggers a background render of cid. Returns immediately.
// Safe to call from any goroutine; single-flight in Render() de-dupes
// if the same cid is enqueued multiple times or also requested via the
// HTTP path. Cache hits are a near-no-op (a cheap walk). expectedMs
// is the caller's track-length estimate; pass 0 to use the fallback.
// Returns false if rejected because the projected queue wait would
// exceed maxQueueWaitMs — callers should surface this to the user
// (POST → 503) or just drop silently (auto-enqueue from PUT).
func (r *Renderer) Enqueue(cid string, expectedMs int64) bool {
	if !ValidCID(cid) {
		return false
	}
	if path := r.findExisting(cid); path != "" {
		return true
	}
	if expectedMs <= 0 {
		expectedMs = fallbackRenderMs
	}
	r.mu.Lock()
	// In-flight already counts — same single-flight as Render. Don't
	// double-count by adding to wait; just allow.
	if _, ok := r.inflight[cid]; !ok {
		projected := expectedMs
		for _, run := range r.running {
			rem := run.ExpectedMs - time.Since(run.StartedAt).Milliseconds()
			if rem < 0 {
				rem = 0
			}
			projected += rem
		}
		for _, q := range r.queued {
			projected += q
		}
		if projected > maxQueueWaitMs {
			r.mu.Unlock()
			return false
		}
	}
	r.mu.Unlock()
	go func() {
		// Background goroutine — a panic here would otherwise take
		// down the whole server (no http handler upstream to recover).
		defer func() {
			if rv := recover(); rv != nil {
				log.Printf("audiorender: panic in prerender %s: %v\n%s",
					cid, rv, debug.Stack())
			}
		}()
		ctx, cancel := context.WithTimeout(context.Background(), r.cfg.RenderTimeout)
		defer cancel()
		if _, err := r.Render(ctx, cid, expectedMs); err != nil {
			log.Printf("audiorender: prerender %s failed: %v", cid, err)
		}
	}()
	return true
}

// Status reports the current state of cid: ready (cached), rendering
// (sem slot held), queued (waiting on a slot), or missing (no record).
// Queue wait time = sum of expectedMs for queued items + remaining time
// on running renders. The caller's view is approximate — render time
// is realtime ≈ track length, which the caller knows up front.
func (r *Renderer) Status(cid string) Status {
	if !ValidCID(cid) {
		return Status{State: "missing"}
	}
	if path := r.findExisting(cid); path != "" {
		st := Status{State: "ready"}
		if info, err := os.Stat(path); err == nil {
			st.SizeBytes = info.Size()
		}
		return st
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if run, ok := r.running[cid]; ok {
		return Status{
			State:      "rendering",
			ExpectedMs: run.ExpectedMs,
			ElapsedMs:  time.Since(run.StartedAt).Milliseconds(),
		}
	}
	if expected, ok := r.queued[cid]; ok {
		// Position in queue (1-based among queued, after currently
		// running renders). Cumulative wait = remaining time on each
		// running render + expectedMs for every queued render that
		// will be picked up before this one. Order among queued items
		// isn't guaranteed (Go's select on a chan-based sem doesn't
		// expose FIFO), so we treat the total as a fair estimate
		// rather than a strict per-CID prediction.
		var waitMs int64
		for _, run := range r.running {
			rem := run.ExpectedMs - time.Since(run.StartedAt).Milliseconds()
			if rem < 0 {
				rem = 0
			}
			waitMs += rem
		}
		position := 1
		for other, otherExpected := range r.queued {
			if other == cid {
				continue
			}
			// Optimistic ordering: assume half the other queued
			// renders go before this one. Without strict FIFO this
			// is the most honest single-number estimate.
			waitMs += otherExpected / 2
			position++
		}
		return Status{
			State:         "queued",
			ExpectedMs:    expected,
			QueuePosition: position,
			WaitMs:        waitMs,
		}
	}
	return Status{State: "missing"}
}

// touchAccessTime bumps the file's mtime so LRU eviction sees recent
// hits as fresh. atime is unreliable (mounts often disable it); mtime
// works everywhere and we control the writes.
func touchAccessTime(path string) error {
	now := time.Now()
	return os.Chtimes(path, now, now)
}

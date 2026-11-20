package server

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
	"beats-bitwrap-io/internal/btwsite/btwd"
)

// Render: GET /api/render/<cid>?format=opus|wav&sr=44100 streams `btwd render` as it renders.
//
//   - A complete render is a file in -data/render named <cid>.<sr>.<fmt>, served with http.ServeContent
//     (Range works, ETag, immutable).
//   - A render in progress is a growing <name>.part file shared by everyone who asks for it meanwhile:
//     the first request starts it, later ones join and read the same file from byte 0, following it.
//   - The btwd child dies when its last follower goes away (or the server stops, or it runs too long).
//   - Limits: -render-concurrency children at once (429 + Retry-After beyond), -render-ip-hour uncached
//     renders per IP, -render-max-bars, -render-cache-mb with LRU eviction.

const renderWallLimit = 10 * time.Minute

type renderKey struct {
	cid    string
	format string // "opus" | "wav"
	sr     int
}

// renderVersion names what `btwd render` makes of a program: bump it when the renderer starts producing different audio for
// the same CID, so cached files (served immutable) are not reused. r2 (2026-11-19): btwd renders control lines (deck and
// master level, ramps, mixer moves, filter / reverb inserts); r1 files (no version in the name) had no section dynamics.
const renderVersion = api.RenderVersion

func (k renderKey) name() string {
	return fmt.Sprintf("%s.%d.%s.%s", k.cid, k.sr, renderVersion, k.format)
}

func (k renderKey) contentType() string {
	if k.format == "wav" {
		return "audio/wav"
	}
	return "audio/ogg; codecs=opus"
}

type cacheEntry struct {
	size     int64
	used     time.Time
	chtimes  time.Time
	seconds  float64
	haveMeta bool
}

type renderMeta struct {
	Seconds float64 `json:"seconds"`
	Bars    int     `json:"bars"`
}

type renderJob struct {
	key         renderKey
	part, final string
	ctx         context.Context
	cancel      context.CancelFunc
	started     time.Time

	ready    chan struct{} // closed when the start event is in (or the start failed)
	startErr error
	seconds  float64
	bars     int
	proc     atomicProc

	mu      sync.Mutex
	written int64
	done    bool
	err     error
	notify  chan struct{}

	followers int // guarded by renderService.mu
}

// atomicProc lets status read a running job's progress.
type atomicProc struct {
	mu sync.Mutex
	p  *btwd.RenderProc
}

func (a *atomicProc) set(p *btwd.RenderProc) { a.mu.Lock(); a.p = p; a.mu.Unlock() }
func (a *atomicProc) progress() float64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.p == nil {
		return 0
	}
	return a.p.Progress()
}

func (j *renderJob) publish(written int64) {
	j.mu.Lock()
	j.written = written
	close(j.notify)
	j.notify = make(chan struct{})
	j.mu.Unlock()
}

func (j *renderJob) snapshot() (written int64, done bool, err error, notify <-chan struct{}) {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.written, j.done, j.err, j.notify
}

// finish marks the job over. swap, if given, runs under the lock (the rename part -> final), so a reader that
// opens the file never sees the name change under it.
func (j *renderJob) finish(err error, swap func() error) {
	j.mu.Lock()
	if err == nil && swap != nil {
		err = swap()
	}
	j.done, j.err = true, err
	close(j.notify)
	j.notify = make(chan struct{})
	j.mu.Unlock()
}

func (j *renderJob) open() (*os.File, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.done && j.err == nil {
		return os.Open(j.final)
	}
	return os.Open(j.part)
}

type renderService struct {
	s       *Server
	dir     string
	capB    int64
	slots   chan struct{}
	ipLimit *ipLimiter
	base    context.Context

	ffOnce sync.Once
	ffPath string
	ffOK_  bool

	mu    sync.Mutex
	jobs  map[renderKey]*renderJob
	cache map[string]*cacheEntry
	total int64
	wg    sync.WaitGroup
}

var reCacheName = regexp.MustCompile(`^(z[1-9A-HJ-NP-Za-km-z]{20,80})\.(\d+)\.` + renderVersion + `\.(wav|opus)$`)

// reStaleRender is a render of another renderer version (an r1 file has none in its name), or its meta: removed at start.
var reStaleRender = regexp.MustCompile(`^(z[1-9A-HJ-NP-Za-km-z]{20,80})\.(\d+)\.(?:r\d+\.)?(wav|opus)(\.meta)?$`)

func newRenderService(s *Server, base context.Context) (*renderService, error) {
	rs := &renderService{s: s, dir: filepath.Join(s.cfg.DataDir, "render"), capB: int64(s.cfg.RenderCacheMB) << 20,
		slots: make(chan struct{}, s.cfg.RenderConcurrency), base: base,
		ipLimit: newIPLimiter(s.cfg.RenderIPHour, time.Hour, s.cfg.Now), jobs: map[renderKey]*renderJob{}, cache: map[string]*cacheEntry{}}
	if err := os.MkdirAll(rs.dir, 0o755); err != nil {
		return nil, err
	}
	ents, err := os.ReadDir(rs.dir)
	if err != nil {
		return nil, err
	}
	for _, e := range ents {
		p := filepath.Join(rs.dir, e.Name())
		switch {
		case strings.HasSuffix(e.Name(), ".part"): // a render the last process never finished
			_ = os.Remove(p)
		case reCacheName.MatchString(e.Name()):
			if info, err := e.Info(); err == nil {
				rs.cache[e.Name()] = &cacheEntry{size: info.Size(), used: info.ModTime(), chtimes: info.ModTime()}
				rs.total += info.Size()
			}
		case reStaleRender.MatchString(e.Name()) && !reCacheName.MatchString(strings.TrimSuffix(e.Name(), ".meta")):
			// made by another renderer version: never served again, so not kept
			_ = os.Remove(p)
		}
	}
	return rs, nil
}

// shutdown waits (briefly) for the render goroutines; the base context is already cancelled by Server.Close.
func (rs *renderService) shutdown() {
	rs.mu.Lock()
	for _, j := range rs.jobs {
		j.cancel()
	}
	rs.mu.Unlock()
	done := make(chan struct{})
	go func() { rs.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
	}
}

// ffmpegOK probes once for an ffmpeg that has libopus.
func (rs *renderService) ffmpegOK() bool {
	rs.ffOnce.Do(func() {
		p, err := exec.LookPath(rs.s.cfg.FFmpeg)
		if err != nil {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, p, "-hide_banner", "-encoders").Output()
		if err == nil && bytes.Contains(out, []byte("libopus")) {
			rs.ffPath, rs.ffOK_ = p, true
		}
	})
	return rs.ffOK_
}

// ---------- cache ----------

// lookupLocked: a complete file for key, if there is one on disk.
func (rs *renderService) lookupLocked(key renderKey) (string, *cacheEntry, bool) {
	name := key.name()
	e, ok := rs.cache[name]
	if !ok {
		return "", nil, false
	}
	p := filepath.Join(rs.dir, name)
	if _, err := os.Stat(p); err != nil { // removed behind our back
		rs.total -= e.size
		delete(rs.cache, name)
		return "", nil, false
	}
	now := rs.s.now()
	e.used = now
	if now.Sub(e.chtimes) > 10*time.Minute {
		e.chtimes = now
		_ = os.Chtimes(p, now, now)
	}
	return p, e, true
}

func (rs *renderService) metaOf(key renderKey, e *cacheEntry) renderMeta {
	rs.mu.Lock()
	if e.haveMeta {
		m := renderMeta{Seconds: e.seconds}
		rs.mu.Unlock()
		return m
	}
	rs.mu.Unlock()
	var m renderMeta
	if b, err := os.ReadFile(filepath.Join(rs.dir, key.name()+".meta")); err == nil {
		_ = json.Unmarshal(b, &m)
	}
	rs.mu.Lock()
	e.seconds, e.haveMeta = m.Seconds, true
	rs.mu.Unlock()
	return m
}

func (rs *renderService) addCache(key renderKey, size int64, m renderMeta) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	name := key.name()
	if old, ok := rs.cache[name]; ok {
		rs.total -= old.size
	}
	now := rs.s.now()
	rs.cache[name] = &cacheEntry{size: size, used: now, chtimes: now, seconds: m.Seconds, haveMeta: true}
	rs.total += size
	for rs.total > rs.capB && len(rs.cache) > 1 {
		var oldest string
		for n, e := range rs.cache {
			if n == name {
				continue
			}
			if oldest == "" || e.used.Before(rs.cache[oldest].used) {
				oldest = n
			}
		}
		if oldest == "" {
			break
		}
		rs.total -= rs.cache[oldest].size
		delete(rs.cache, oldest)
		_ = os.Remove(filepath.Join(rs.dir, oldest))
		_ = os.Remove(filepath.Join(rs.dir, oldest+".meta"))
	}
}

// ---------- jobs ----------

type acquired struct {
	hit    string // path of a complete file
	entry  *cacheEntry
	job    *renderJob
	joined bool
}

// acquire answers one of: a complete file, a running job to follow, or a fresh job it starts. Errors are
// *api.Error (429 rate_limited, 429 busy).
func (rs *renderService) acquire(key renderKey, ip, text string) (acquired, error) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	if p, e, ok := rs.lookupLocked(key); ok {
		return acquired{hit: p, entry: e}, nil
	}
	if j := rs.jobs[key]; j != nil {
		j.followers++
		return acquired{job: j, joined: true}, nil
	}
	if ok, retry := rs.ipLimit.Peek(ip); !ok {
		e := api.Errf(http.StatusTooManyRequests, api.CodeRateLimited, "at most %d new renders per hour per address; this one is cached by the time you retry, or try again in %ds", rs.s.cfg.RenderIPHour, retry)
		e.RetryAfter = retry
		return acquired{}, e
	}
	select {
	case rs.slots <- struct{}{}:
	default:
		e := api.Errf(http.StatusTooManyRequests, api.CodeBusy, "all %d render slots are busy; try again shortly", cap(rs.slots))
		e.RetryAfter = rs.busyRetryLocked()
		return acquired{}, e
	}
	rs.ipLimit.Record(ip)
	ctx, cancel := context.WithTimeout(rs.base, renderWallLimit)
	j := &renderJob{key: key, part: filepath.Join(rs.dir, key.name()+".part"), final: filepath.Join(rs.dir, key.name()),
		ctx: ctx, cancel: cancel, started: rs.s.now(), ready: make(chan struct{}), notify: make(chan struct{}), followers: 1}
	rs.jobs[key] = j
	rs.wg.Add(1)
	go rs.run(j, text)
	return acquired{job: j}, nil
}

// busyRetryLocked: when a slot is likely to free up: the soonest-finishing job's estimate, 2..30 s.
func (rs *renderService) busyRetryLocked() int {
	best := 10.0
	for _, j := range rs.jobs {
		select {
		case <-j.ready:
		default:
			continue
		}
		if left := j.seconds - j.proc.progress(); left > 0 && left < best {
			best = left
		}
	}
	return int(min(30, max(2, best/4+1)))
}

// leave drops one follower; the last one out kills a render that is still going.
func (rs *renderService) leave(j *renderJob) {
	rs.mu.Lock()
	j.followers--
	kill := false
	if j.followers <= 0 {
		_, done, _, _ := j.snapshot()
		if !done {
			kill = true
			if rs.jobs[j.key] == j {
				delete(rs.jobs, j.key) // a new request starts a fresh render, not a dying one
			}
		}
	}
	rs.mu.Unlock()
	if kill {
		j.cancel()
	}
}

func (rs *renderService) removeJob(j *renderJob) {
	rs.mu.Lock()
	if rs.jobs[j.key] == j {
		delete(rs.jobs, j.key)
	}
	rs.mu.Unlock()
}

func wavHeader(sr, ch int) []byte {
	b := make([]byte, 44)
	copy(b[0:], "RIFF")
	binary.LittleEndian.PutUint32(b[4:], 0xFFFFFFFF) // unknown length: a stream
	copy(b[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(b[16:], 16)
	binary.LittleEndian.PutUint16(b[20:], 1)
	binary.LittleEndian.PutUint16(b[22:], uint16(ch))
	binary.LittleEndian.PutUint32(b[24:], uint32(sr))
	binary.LittleEndian.PutUint32(b[28:], uint32(sr*ch*2))
	binary.LittleEndian.PutUint16(b[32:], uint16(ch*2))
	binary.LittleEndian.PutUint16(b[34:], 16)
	copy(b[36:], "data")
	binary.LittleEndian.PutUint32(b[40:], 0xFFFFFFFF)
	return b
}

// run is one render, from btwd start to the finished file (or its removal).
func (rs *renderService) run(j *renderJob, text string) {
	defer rs.wg.Done()
	defer func() { <-rs.slots }()
	defer j.cancel()
	fail := func(err error) {
		_ = os.Remove(j.part)
		rs.removeJob(j)
		j.finish(err, nil)
	}
	proc, err := rs.s.renderer.StartRender(j.ctx, text, btwd.RenderOptions{SampleRate: j.key.sr, MaxBars: rs.s.cfg.RenderMaxBars})
	if err != nil {
		j.startErr = err
		close(j.ready)
		fail(err)
		return
	}
	j.proc.set(proc)
	j.seconds, j.bars = proc.Start.Seconds, proc.Start.Bars
	f, err := os.OpenFile(j.part, os.O_CREATE|os.O_TRUNC|os.O_RDWR, 0o644)
	if err != nil {
		proc.Kill()
		_, _ = io.Copy(io.Discard, proc.PCM)
		_ = proc.Wait()
		j.startErr = err
		close(j.ready)
		fail(err)
		return
	}
	var written int64
	write := func(b []byte) error {
		n, err := f.Write(b)
		written += int64(n)
		if n > 0 {
			j.publish(written)
		}
		return err
	}

	var runErr error
	if j.key.format == "wav" {
		if err := write(wavHeader(proc.Start.SampleRate, proc.Start.Channels)); err != nil {
			runErr = err
		}
		close(j.ready)
		if runErr == nil {
			runErr = pump(proc.PCM, write)
		}
		if runErr != nil {
			proc.Kill()
		}
		if werr := proc.Wait(); runErr == nil {
			runErr = werr
		}
	} else {
		runErr = rs.runOpus(j, proc, write)
	}
	if runErr == nil && j.ctx.Err() != nil {
		runErr = j.ctx.Err()
	}
	if runErr != nil {
		f.Close()
		if errors.Is(runErr, context.Canceled) {
			runErr = errors.New("render cancelled")
		}
		fail(runErr)
		return
	}
	if j.key.format == "wav" && written >= 44 && written-44 < 0xFFFFFFFF-36 { // real sizes for the cached file
		var sz [4]byte
		binary.LittleEndian.PutUint32(sz[:], uint32(written-8))
		_, _ = f.WriteAt(sz[:], 4)
		binary.LittleEndian.PutUint32(sz[:], uint32(written-44))
		_, _ = f.WriteAt(sz[:], 40)
	}
	if err := f.Close(); err != nil {
		fail(err)
		return
	}
	meta := renderMeta{Seconds: j.seconds, Bars: j.bars}
	if mb, err := json.Marshal(meta); err == nil {
		_ = os.WriteFile(j.final+".meta", mb, 0o644)
	}
	j.finish(nil, func() error { return os.Rename(j.part, j.final) })
	if _, done, jerr, _ := j.snapshot(); done && jerr == nil {
		rs.addCache(j.key, written, meta)
	} else {
		_ = os.Remove(j.part)
	}
	rs.removeJob(j)
}

// pump copies r to write until EOF, in whatever pieces arrive (so a chunk is published as soon as btwd
// has flushed it).
func pump(r io.Reader, write func([]byte) error) error {
	buf := make([]byte, 32<<10)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			if werr := write(buf[:n]); werr != nil {
				return werr
			}
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

// runOpus pipes btwd's PCM through ffmpeg into the file.
func (rs *renderService) runOpus(j *renderJob, proc *btwd.RenderProc, write func([]byte) error) error {
	fail := func(err error) error { // before the start was announced: followers get this as the answer
		proc.Kill()
		_, _ = io.Copy(io.Discard, proc.PCM)
		_ = proc.Wait()
		j.startErr = err
		close(j.ready)
		return err
	}
	if !rs.ffmpegOK() {
		return fail(errors.New("ffmpeg with libopus is not available"))
	}
	ff := exec.CommandContext(j.ctx, rs.ffPath, "-hide_banner", "-loglevel", "error", "-nostdin",
		"-f", "s16le", "-ar", strconv.Itoa(proc.Start.SampleRate), "-ac", strconv.Itoa(proc.Start.Channels), "-i", "-",
		"-c:a", "libopus", "-b:a", "96k", "-application", "audio", "-page_duration", "200000", "-flush_packets", "1", "-f", "ogg", "-")
	ff.Env = []string{"LANG=C.UTF-8"}
	ff.WaitDelay = 2 * time.Second
	var stderr bytes.Buffer
	ff.Stderr = &limitWriter{w: &stderr, n: 2048}
	in, err := ff.StdinPipe()
	if err != nil {
		return fail(err)
	}
	out, err := ff.StdoutPipe()
	if err != nil {
		return fail(err)
	}
	if err := ff.Start(); err != nil {
		return fail(fmt.Errorf("ffmpeg: %w", err))
	}
	btwd.Renice(ff.Process.Pid, btwd.DefaultNice)
	close(j.ready)
	copied := make(chan struct{})
	go func() {
		defer close(copied)
		_, _ = io.Copy(in, proc.PCM)
		_ = in.Close()
	}()
	perr := pump(out, write)
	if perr != nil {
		proc.Kill()
		_ = ff.Process.Kill()
	}
	ferr := ff.Wait()
	if ferr != nil {
		proc.Kill()
	}
	werr := proc.Wait()
	<-copied
	switch {
	case perr != nil:
		return perr
	case werr != nil:
		return werr
	case ferr != nil:
		return fmt.Errorf("ffmpeg: %v: %s", ferr, strings.TrimSpace(stderr.String()))
	}
	return nil
}

type limitWriter struct {
	w *bytes.Buffer
	n int
}

func (l *limitWriter) Write(p []byte) (int, error) {
	if room := l.n - l.w.Len(); room > 0 {
		l.w.Write(p[:min(room, len(p))])
	}
	return len(p), nil
}

// ---------- HTTP ----------

func parseRenderParams(r *http.Request, rs *renderService) (renderKey, *api.Error) {
	cid, _, _ := strings.Cut(r.PathValue("cid"), ".") // <cid>.<packed>: the program travels in the URL (fromLink)
	k := renderKey{cid: cid, sr: 44100}
	if !reCID.MatchString(k.cid) {
		return k, api.Errf(http.StatusNotFound, api.CodeNotFound, "no such program")
	}
	q := r.URL.Query()
	switch f := q.Get("format"); f {
	case "wav", "opus":
		k.format = f
	case "":
		k.format = "opus"
		if !rs.ffmpegOK() {
			k.format = "wav"
		}
	default:
		return k, api.Errf(http.StatusBadRequest, api.CodeBadRequest, "format must be opus or wav")
	}
	if v := q.Get("sr"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || (n != 44100 && n != 48000) {
			return k, api.Errf(http.StatusBadRequest, api.CodeBadRequest, "sr must be 44100 or 48000")
		}
		k.sr = n
	}
	return k, nil
}

// renderable resolves cid to a program that may be rendered here.
func (s *Server) renderable(r *http.Request, cid string) (*api.Program, *api.CheckReport, error) {
	p, ok := s.Get(cid)
	if !ok {
		return nil, nil, api.Errf(http.StatusNotFound, api.CodeNotFound, "no program %s here; PUT it to /api/programs/%s first", cid, cid)
	}
	rep, err := s.programReport(r.Context(), p)
	if err != nil {
		return nil, nil, s.asAPIError(err)
	}
	if !rep.OK {
		return nil, nil, api.Errf(http.StatusUnprocessableEntity, api.CodeBadRequest, "that program does not check")
	}
	if rep.Restricted || rep.UsesAssets {
		return nil, nil, api.Errf(http.StatusUnprocessableEntity, api.CodeRestricted, "programs that use restricted sounds or sample/loop assets are not rendered on this site")
	}
	if rep.SongBars > s.cfg.RenderMaxBars {
		return nil, nil, api.Errf(http.StatusUnprocessableEntity, api.CodeTooLarge, "that program is %d bars; this site renders at most %d", rep.SongBars, s.cfg.RenderMaxBars)
	}
	if rep.Seconds != nil && *rep.Seconds > float64(s.cfg.RenderMaxSeconds) {
		return nil, nil, api.Errf(http.StatusUnprocessableEntity, api.CodeTooLarge, "that program is %.0f s long; this site renders at most %d s", *rep.Seconds, s.cfg.RenderMaxSeconds)
	}
	return p, rep, nil
}

func secs(f float64) string { return strconv.FormatFloat(f, 'f', 2, 64) }

func (s *Server) handleRender(w http.ResponseWriter, r *http.Request) {
	rs := s.rs
	key, perr := parseRenderParams(r, rs)
	if perr != nil {
		api.WriteError(w, perr)
		return
	}
	if key.format == "opus" && !rs.ffmpegOK() {
		api.WriteError(w, api.Errf(http.StatusServiceUnavailable, api.CodeNotConfigured, "Ogg Opus needs ffmpeg with libopus on the server, and there is none: ask for format=wav"))
		return
	}
	if _, packed, ok := strings.Cut(r.PathValue("cid"), "."); ok {
		if e := s.fromLink(r, key.cid, packed); e != nil {
			api.WriteError(w, e)
			return
		}
	}
	p, rep, err := s.renderable(r, key.cid)
	if err != nil {
		api.WriteError(w, err)
		return
	}
	h := w.Header()
	h.Set("Content-Type", key.contentType())
	h.Set("X-Btw-Cid", key.cid)
	h.Set("Content-Disposition", fmt.Sprintf("inline; filename=%q", key.cid+"."+key.format))

	if r.Method == http.MethodHead {
		rs.mu.Lock()
		path, e, hit := rs.lookupLocked(key)
		_, running := rs.jobs[key]
		rs.mu.Unlock()
		switch {
		case hit:
			s.serveComplete(w, r, key, path, e, rep)
			return
		case running:
			h.Set("X-Btw-Cache", "joined")
		default:
			h.Set("X-Btw-Cache", "miss")
		}
		if rep.Seconds != nil {
			h.Set("X-Btw-Seconds", secs(*rep.Seconds))
		}
		h.Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)
		return
	}

	acq, err := rs.acquire(key, ClientIP(r), p.Text)
	if err != nil {
		api.WriteError(w, err)
		return
	}
	if acq.hit != "" {
		s.serveComplete(w, r, key, acq.hit, acq.entry, rep)
		return
	}
	job := acq.job
	defer rs.leave(job)
	select {
	case <-job.ready:
	case <-r.Context().Done():
		return
	case <-s.closing:
		return
	}
	if job.startErr != nil {
		api.WriteError(w, s.asAPIError(job.startErr))
		return
	}
	cache := "miss"
	if acq.joined {
		cache = "joined"
	}
	h.Set("X-Btw-Seconds", secs(job.seconds))
	h.Set("X-Btw-Cache", cache)
	h.Set("Cache-Control", "no-cache") // complete copies are immutable; a stream in progress is not yet
	h.Set("X-Accel-Buffering", "no")   // nginx: pass each chunk on as it comes
	s.streamJob(w, r, job)
}

// serveComplete serves a finished render as a file.
func (s *Server) serveComplete(w http.ResponseWriter, r *http.Request, key renderKey, path string, e *cacheEntry, rep *api.CheckReport) {
	f, err := os.Open(path)
	if err != nil {
		api.WriteError(w, api.Errf(http.StatusNotFound, api.CodeNotFound, "that render was just evicted; ask again"))
		return
	}
	defer f.Close()
	h := w.Header()
	seconds := s.rs.metaOf(key, e).Seconds
	if seconds == 0 && rep != nil && rep.Seconds != nil {
		seconds = *rep.Seconds
	}
	if seconds > 0 {
		h.Set("X-Btw-Seconds", secs(seconds))
	}
	h.Set("X-Btw-Cache", "hit")
	h.Set("Cache-Control", "public, max-age=31536000, immutable")
	h.Set("ETag", fmt.Sprintf(`"%s-%d-%s-%s"`, key.cid, key.sr, renderVersion, key.format))
	http.ServeContent(w, r, key.name(), time.Time{}, f) // Range, If-None-Match, HEAD
}

// streamJob writes a growing file to the client as it grows.
func (s *Server) streamJob(w http.ResponseWriter, r *http.Request, job *renderJob) {
	f, err := job.open()
	if err != nil {
		api.WriteError(w, api.Errf(http.StatusInternalServerError, "internal", "render file missing"))
		return
	}
	defer f.Close()
	rc := http.NewResponseController(w)
	w.WriteHeader(http.StatusOK)
	_ = rc.Flush()
	buf := make([]byte, 64<<10)
	var pos int64
	idle := time.NewTimer(time.Minute)
	defer idle.Stop()
	for {
		written, done, jerr, notify := job.snapshot()
		if pos < written {
			n := int(min(int64(len(buf)), written-pos))
			n, err := f.ReadAt(buf[:n], pos)
			if n > 0 {
				_ = rc.SetWriteDeadline(time.Now().Add(20 * time.Second))
				if _, werr := w.Write(buf[:n]); werr != nil {
					return
				}
				_ = rc.Flush()
				pos += int64(n)
				if !idle.Stop() {
					select {
					case <-idle.C:
					default:
					}
				}
				idle.Reset(time.Minute)
			}
			if err != nil && err != io.EOF {
				panic(http.ErrAbortHandler)
			}
			continue
		}
		if done {
			if jerr != nil {
				panic(http.ErrAbortHandler) // the client must see a broken stream, not a short one that looks whole
			}
			return
		}
		select {
		case <-notify:
		case <-r.Context().Done():
			return
		case <-s.closing:
			return
		case <-idle.C:
			panic(http.ErrAbortHandler)
		}
	}
}

// ---------- status ----------

func (s *Server) handleRenderStatus(w http.ResponseWriter, r *http.Request) {
	rs := s.rs
	cid := r.PathValue("cid")
	if !reCID.MatchString(cid) {
		api.WriteError(w, api.Errf(http.StatusNotFound, api.CodeNotFound, "no such program"))
		return
	}
	sr := 44100
	if v, err := strconv.Atoi(r.URL.Query().Get("sr")); err == nil && (v == 44100 || v == 48000) {
		sr = v
	}
	p, ok := s.Get(cid)
	if !ok {
		api.WriteError(w, api.Errf(http.StatusNotFound, api.CodeNotFound, "no program %s here", cid))
		return
	}
	rep, err := s.programReport(r.Context(), p)
	if err != nil {
		api.WriteError(w, s.asAPIError(err))
		return
	}
	type fmtStatus struct {
		State           string  `json:"state"` // none | rendering | ready
		Bytes           int64   `json:"bytes,omitempty"`
		SecondsRendered float64 `json:"seconds_rendered,omitempty"`
		Seconds         float64 `json:"seconds,omitempty"`
		URL             string  `json:"url"`
		Available       bool    `json:"available"`
	}
	formats := map[string]fmtStatus{}
	for _, f := range []string{"opus", "wav"} {
		key := renderKey{cid, f, sr}
		st := fmtStatus{State: "none", URL: fmt.Sprintf("/api/render/%s?format=%s&sr=%d&v=%s", cid, f, sr, renderVersion), Available: f == "wav" || rs.ffmpegOK()}
		rs.mu.Lock()
		_, e, hit := rs.lookupLocked(key)
		job := rs.jobs[key]
		rs.mu.Unlock()
		switch {
		case hit:
			st.State, st.Bytes = "ready", e.size
			st.Seconds = rs.metaOf(key, e).Seconds
		case job != nil:
			st.State = "rendering"
			written, _, _, _ := job.snapshot()
			st.Bytes = written
			select {
			case <-job.ready:
				st.Seconds, st.SecondsRendered = job.seconds, job.proc.progress()
			default:
			}
		}
		formats[f] = st
	}
	w.Header().Set("Cache-Control", "no-store")
	out := map[string]any{"cid": cid, "formats": formats, "max_bars": s.cfg.RenderMaxBars, "max_seconds": s.cfg.RenderMaxSeconds, "bars": rep.SongBars,
		"restricted": rep.Restricted || rep.UsesAssets}
	if rep.Seconds != nil {
		out["seconds"] = *rep.Seconds
	}
	writeJSON(w, http.StatusOK, out)
}

// fromLink makes GET /api/render/<cid>.<packed> work with no program stored: the URL carries the program as a
// self-sealing share link does (<packed> = base64url(deflate(canonical text))). It is opened and checked against the
// CID (a mismatch is refused, as a link is), then stored like an anonymous PUT /api/programs/<cid> (the same per-address
// limit, the same refusals: restricted and asset-using programs are never stored) and rendered as a stored one.
// A program already here needs nothing: the CID names it.
func (s *Server) fromLink(r *http.Request, cid, packed string) error {
	if _, ok := s.Get(cid); ok {
		return nil
	}
	if packed == "" || len(packed) > 3*s.cfg.MaxProgramBytes {
		return api.Errf(http.StatusBadRequest, api.CodeBadRequest, "after <cid>. the URL carries the packed program, as a share link does")
	}
	if ok, retry := s.putIP.Allow(ClientIP(r)); !ok {
		e := api.Errf(http.StatusTooManyRequests, api.CodeRateLimited, "too many new programs from this address; try again later")
		e.RetryAfter = retry
		return e
	}
	rep, err := s.checker.Open(r.Context(), cid+"."+packed)
	if err != nil {
		return s.asAPIError(err)
	}
	if rep != nil && rep.Canonical != "" && (!rep.Verified || rep.CID != cid) {
		return api.Errf(http.StatusUnprocessableEntity, api.CodeCIDMismatch, "the program in the URL is not %s", cid)
	}
	if rep == nil || !rep.OK || rep.Canonical == "" {
		msg := "the program in the URL does not open"
		if rep != nil && rep.Error != "" {
			msg = rep.Error
		}
		return api.Errf(http.StatusUnprocessableEntity, api.CodeBadRequest, "%s", msg)
	}
	if !rep.Verified || rep.CID != cid {
		return api.Errf(http.StatusUnprocessableEntity, api.CodeCIDMismatch, "the program in the URL is %s, not %s", rep.CID, cid)
	}
	if _, _, _, perr := s.store.put(r.Context(), rep.Canonical, api.Meta{}, cid); perr != nil {
		return s.asAPIError(perr)
	}
	return nil
}

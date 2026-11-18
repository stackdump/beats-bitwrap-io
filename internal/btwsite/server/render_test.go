package server

import (
	"encoding/binary"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
)

const wavBytes = 44 + 44100*4*4 // progA: 4 s of 44.1 kHz stereo s16

func firstByte(t *testing.T, resp *http.Response, start time.Time) (time.Duration, []byte) {
	t.Helper()
	buf := make([]byte, 1)
	if _, err := io.ReadFull(resp.Body, buf); err != nil {
		t.Fatalf("first byte: %v", err)
	}
	return time.Since(start), buf
}

func TestRenderWavStreamsThenCaches(t *testing.T) {
	e := newEnv(t, nil, "BTW_FAKE_CHUNK_DELAY_MS=40")
	cid := e.put(progA)

	start := time.Now()
	resp := e.get("/api/render/"+cid+"?format=wav", ip("192.0.2.1"))
	if resp.StatusCode != 200 {
		t.Fatalf("%d %s", resp.StatusCode, readAll(t, resp))
	}
	fb, first := firstByte(t, resp, start)
	if fb > time.Second {
		t.Errorf("first byte took %s", fb)
	}
	t.Logf("first byte (wav, fake renderer): %s", fb)
	rest, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	all := append(first, rest...)
	total := time.Since(start)
	if len(all) != wavBytes {
		t.Fatalf("streamed %d bytes, want %d", len(all), wavBytes)
	}
	if total < 400*time.Millisecond {
		t.Errorf("the render was not streamed over time (finished in %s)", total)
	}
	// the streaming header: RIFF and data sizes 0xFFFFFFFF, PCM 16-bit stereo 44.1k
	if string(all[0:4]) != "RIFF" || binary.LittleEndian.Uint32(all[4:8]) != 0xFFFFFFFF || string(all[8:16]) != "WAVEfmt " ||
		binary.LittleEndian.Uint16(all[20:22]) != 1 || binary.LittleEndian.Uint16(all[22:24]) != 2 || binary.LittleEndian.Uint32(all[24:28]) != 44100 ||
		binary.LittleEndian.Uint16(all[34:36]) != 16 || string(all[36:40]) != "data" || binary.LittleEndian.Uint32(all[40:44]) != 0xFFFFFFFF {
		t.Fatalf("header: % x", all[:44])
	}
	h := resp.Header
	if h.Get("X-Btw-Cid") != cid || h.Get("X-Btw-Cache") != "miss" || h.Get("X-Btw-Seconds") != "4.00" || h.Get("Content-Type") != "audio/wav" ||
		h.Get("X-Accel-Buffering") != "no" || h.Get("Cache-Control") == "public, max-age=31536000, immutable" {
		t.Fatalf("stream headers: %v", h)
	}
	if h.Get("Content-Length") != "" {
		t.Fatal("a stream has no Content-Length")
	}
	if te := resp.TransferEncoding; len(te) == 0 || te[0] != "chunked" {
		t.Fatalf("transfer encoding %v", te)
	}

	// the cache is written by the time the stream ended; the second request is a hit with real sizes
	time.Sleep(100 * time.Millisecond)
	start = time.Now()
	hit := e.get("/api/render/"+cid+"?format=wav", ip("192.0.2.1"))
	body := readAll(t, hit)
	if hit.StatusCode != 200 || hit.Header.Get("X-Btw-Cache") != "hit" || hit.Header.Get("Cache-Control") != "public, max-age=31536000, immutable" ||
		hit.Header.Get("X-Btw-Seconds") != "4.00" || hit.Header.Get("ETag") == "" || hit.Header.Get("Accept-Ranges") != "bytes" {
		t.Fatalf("hit headers: %d %v", hit.StatusCode, hit.Header)
	}
	if time.Since(start) > 300*time.Millisecond || len(body) != wavBytes {
		t.Fatalf("hit: %d bytes in %s", len(body), time.Since(start))
	}
	if binary.LittleEndian.Uint32(body[4:8]) != uint32(wavBytes-8) || binary.LittleEndian.Uint32(body[40:44]) != uint32(wavBytes-44) {
		t.Fatalf("the cached WAV should carry its real sizes: % x", body[:44])
	}
	if string(body[44:]) != string(all[44:]) {
		t.Fatal("cached PCM differs from the streamed PCM")
	}
	if e.renderCalls() != 1 {
		t.Fatalf("btwd render ran %d times", e.renderCalls())
	}
	// Range on a complete file
	r := e.get("/api/render/"+cid+"?format=wav", hdr("Range", "bytes=44-47"))
	if got := readAll(t, r); r.StatusCode != 206 || len(got) != 4 || r.Header.Get("Content-Range") != "bytes 44-47/"+itoa(wavBytes) {
		t.Fatalf("range: %d %q %v", r.StatusCode, got, r.Header)
	}
	if r := e.get("/api/render/"+cid+"?format=wav", hdr("If-None-Match", hit.Header.Get("ETag"))); r.StatusCode != 304 {
		t.Fatalf("etag: %d", r.StatusCode)
	}
	// HEAD of a cached render
	hd := e.do("HEAD", "/api/render/"+cid+"?format=wav", nil)
	hd.Body.Close()
	if hd.StatusCode != 200 || hd.Header.Get("X-Btw-Cache") != "hit" || hd.Header.Get("Content-Length") != itoa(wavBytes) {
		t.Fatalf("HEAD hit: %d %v", hd.StatusCode, hd.Header)
	}
	// still one render after all that
	if e.renderCalls() != 1 {
		t.Fatalf("btwd render ran %d times", e.renderCalls())
	}
	// no part files left behind
	ents, _ := os.ReadDir(filepath.Join(e.cfg.DataDir, "render"))
	for _, en := range ents {
		if strings.HasSuffix(en.Name(), ".part") {
			t.Fatalf("leftover %s", en.Name())
		}
	}
	// restart: the cache is still there
	e2 := e.restart()
	r2 := e2.get("/api/render/" + cid + "?format=wav")
	readAll(t, r2)
	if r2.Header.Get("X-Btw-Cache") != "hit" || r2.Header.Get("X-Btw-Seconds") != "4.00" {
		t.Fatalf("after restart: %v", r2.Header)
	}
}

func itoa(n int) string { return strconv.Itoa(n) }

func fmtInt(n int) string { return strconv.Itoa(n) }

func TestRenderLateJoinersFollowTheSameRender(t *testing.T) {
	e := newEnv(t, nil, "BTW_FAKE_CHUNK_DELAY_MS=80", "BTW_FAKE_SECONDS=4")
	cid := e.put(progA)
	type res struct {
		body  []byte
		cache string
		err   error
	}
	fetch := func(delay time.Duration, a string) res {
		time.Sleep(delay)
		resp := e.get("/api/render/"+cid+"?format=wav", ip(a))
		b, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		return res{b, resp.Header.Get("X-Btw-Cache"), err}
	}
	var wg sync.WaitGroup
	out := make([]res, 3)
	for i, d := range []time.Duration{0, 400 * time.Millisecond, 800 * time.Millisecond} {
		wg.Add(1)
		go func() { defer wg.Done(); out[i] = fetch(d, "192.0.2.1"+fmtInt(i)) }()
	}
	wg.Wait()
	if out[0].cache != "miss" || out[1].cache != "joined" || out[2].cache != "joined" {
		t.Fatalf("caches: %s %s %s", out[0].cache, out[1].cache, out[2].cache)
	}
	for i, r := range out {
		if r.err != nil || len(r.body) != wavBytes {
			t.Fatalf("client %d: %d bytes, %v", i, len(r.body), r.err)
		}
		if string(r.body) != string(out[0].body) {
			t.Fatalf("client %d got different bytes", i)
		}
	}
	if n := e.renderCalls(); n != 1 {
		t.Fatalf("%d btwd render processes for 3 clients", n)
	}
	// only the starter was charged against its hourly allowance
	rs := e.srv.rs
	rs.mu.Lock()
	hits := 0
	for _, v := range rs.ipLimit.hits {
		hits += len(v)
	}
	rs.mu.Unlock()
	if hits != 1 {
		t.Fatalf("%d uncached renders charged", hits)
	}
}

func pidAlive(pid int) bool { return syscall.Kill(pid, 0) == nil }

func waitDead(t *testing.T, pidfile string, within time.Duration) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		b, err := os.ReadFile(pidfile)
		if err == nil && len(b) > 0 {
			var pid int
			for _, c := range string(b) {
				pid = pid*10 + int(c-'0')
			}
			if !pidAlive(pid) {
				return
			}
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("the btwd child is still alive")
}

func TestRenderDisconnectKillsTheChild(t *testing.T) {
	pidfile := filepath.Join(t.TempDir(), "pid")
	e := newEnv(t, nil, "BTW_FAKE_CHUNK_DELAY_MS=100", "BTW_FAKE_SECONDS=60", "BTW_FAKE_PIDFILE="+pidfile)
	cid := e.put(progA)
	resp := e.get("/api/render/" + cid + "?format=wav")
	if _, err := io.ReadFull(resp.Body, make([]byte, 5000)); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(pidfile)
	if len(b) == 0 {
		t.Fatal("the fake did not run")
	}
	resp.Body.Close() // the client goes away
	waitDead(t, pidfile, 3*time.Second)
	// the half render is not cached and leaves no file
	time.Sleep(100 * time.Millisecond)
	ents, _ := os.ReadDir(filepath.Join(e.cfg.DataDir, "render"))
	if len(ents) != 0 {
		t.Fatalf("leftovers: %v", ents)
	}
	// and the slot is free again
	e.srv.rs.mu.Lock()
	n, jobs := len(e.srv.rs.slots), len(e.srv.rs.jobs)
	e.srv.rs.mu.Unlock()
	if n != 0 || jobs != 0 {
		t.Fatalf("slots in use %d, jobs %d", n, jobs)
	}
}

func TestRenderKeepsGoingWhileAnyFollowerRemains(t *testing.T) {
	e := newEnv(t, nil, "BTW_FAKE_CHUNK_DELAY_MS=60", "BTW_FAKE_SECONDS=3")
	cid := e.put(progA)
	first := e.get("/api/render/" + cid + "?format=wav")
	io.ReadFull(first.Body, make([]byte, 1000))
	second := e.get("/api/render/" + cid + "?format=wav")
	if second.Header.Get("X-Btw-Cache") != "joined" {
		t.Fatalf("second: %v", second.Header.Get("X-Btw-Cache"))
	}
	first.Body.Close() // the starter leaves; the joiner must still get the whole thing
	b, err := io.ReadAll(second.Body)
	second.Body.Close()
	if err != nil || len(b) != 44+44100*4*3 {
		t.Fatalf("joiner got %d bytes, %v", len(b), err)
	}
	time.Sleep(100 * time.Millisecond)
	if r := e.get("/api/render/" + cid + "?format=wav"); r.Header.Get("X-Btw-Cache") != "hit" {
		t.Fatalf("not cached afterwards: %v", r.Header)
	} else {
		r.Body.Close()
	}
}

func TestRenderSlotsAndPerIPLimit(t *testing.T) {
	pidfile := filepath.Join(t.TempDir(), "pid")
	e := newEnv(t, func(c *Config) { c.RenderConcurrency = 1; c.RenderIPHour = 2 }, "BTW_FAKE_CHUNK_DELAY_MS=100", "BTW_FAKE_SECONDS=30", "BTW_FAKE_PIDFILE="+pidfile)
	a, b, c := e.put(progA), e.put(progB), e.put(progC)
	long := e.get("/api/render/"+a+"?format=wav", ip("192.0.2.1"))
	io.ReadFull(long.Body, make([]byte, 100))

	// the only slot is taken: another program gets 429 busy with Retry-After, and is not charged to its IP
	r := e.get("/api/render/"+b+"?format=wav", ip("192.0.2.2"))
	if r.Header.Get("Retry-After") == "" {
		t.Fatalf("no Retry-After: %v", r.Header)
	}
	if st, code := errCode(t, r); st != 429 || code != api.CodeBusy {
		t.Fatalf("busy: %d %s", st, code)
	}
	// joining the running one does not need a slot
	j := e.get("/api/render/"+a+"?format=wav", ip("192.0.2.3"))
	if j.StatusCode != 200 || j.Header.Get("X-Btw-Cache") != "joined" {
		t.Fatalf("join while busy: %d %v", j.StatusCode, j.Header)
	}
	j.Body.Close()
	long.Body.Close()
	waitDead(t, pidfile, 3*time.Second)
	time.Sleep(200 * time.Millisecond)

	// per-IP hourly limit on uncached renders: 2 allowed; the starts above for 192.0.2.1 count (1 used)
	e.srv.cfg.Logf("limit phase")
	short := func(cid, who string) *http.Response {
		resp := e.get("/api/render/"+cid+"?format=wav", ip(who))
		return resp
	}
	// fresh env with fast renders for the limit
	e2 := newEnv(t, func(c *Config) { c.RenderIPHour = 2 }, "BTW_FAKE_CHUNK_DELAY_MS=1", "BTW_FAKE_SECONDS=1")
	a, b, c = e2.put(progA), e2.put(progB), e2.put(progC)
	_ = short
	for i, cid := range []string{a, b} {
		resp := e2.get("/api/render/"+cid+"?format=wav", ip("192.0.2.9"))
		if resp.StatusCode != 200 {
			t.Fatalf("render %d: %d", i, resp.StatusCode)
		}
		readAll(t, resp)
	}
	time.Sleep(100 * time.Millisecond)
	r = e2.get("/api/render/"+c+"?format=wav", ip("192.0.2.9"))
	if r.Header.Get("Retry-After") == "" {
		t.Fatalf("no Retry-After: %v", r.Header)
	}
	if st, code := errCode(t, r); st != 429 || code != api.CodeRateLimited {
		t.Fatalf("per-IP limit: %d %s", st, code)
	}
	// cached ones are free
	if r := e2.get("/api/render/"+a+"?format=wav", ip("192.0.2.9")); r.StatusCode != 200 || r.Header.Get("X-Btw-Cache") != "hit" {
		t.Fatalf("cached render for a limited IP: %d %v", r.StatusCode, r.Header)
	} else {
		r.Body.Close()
	}
	// another address is not limited
	if r := e2.get("/api/render/"+c+"?format=wav", ip("192.0.2.10")); r.StatusCode != 200 {
		t.Fatalf("other address: %d", r.StatusCode)
	} else {
		readAll(t, r)
	}
	// the hour passes
	e2.clk.Advance(61 * time.Minute)
	d := e2.put("tempo 80\ndeck A: kick x\nsection a 2 bars\n")
	if r := e2.get("/api/render/"+d+"?format=wav", ip("192.0.2.9")); r.StatusCode != 200 {
		t.Fatalf("after the hour: %d", r.StatusCode)
	} else {
		readAll(t, r)
	}
}

func TestRenderRefusals(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.RenderMaxBars = 3 })
	small := e.put(progA) // 2 bars
	var big api.CheckReport
	bigText := "tempo 120\ndeck A: kick x\nsection a 8 bars\n"
	decode(t, e.post("/api/check", map[string]string{"text": bigText}), &big)
	e.do("PUT", "/api/programs/"+big.CID, strings.NewReader(bigText)).Body.Close()

	if st, code := errCode(t, e.get("/api/render/"+big.CID+"?format=wav")); st != 422 || code != api.CodeTooLarge {
		t.Fatalf("too many bars: %d %s", st, code)
	}
	if st, code := errCode(t, e.get("/api/render/z"+strings.Repeat("2", 40)+"?format=wav")); st != 404 || code != api.CodeNotFound {
		t.Fatalf("unknown program: %d %s", st, code)
	}
	if st, _ := errCode(t, e.get("/api/render/abc?format=wav")); st != 404 {
		t.Fatalf("not a cid: %d", st)
	}
	if st, code := errCode(t, e.get("/api/render/"+small+"?format=mp3")); st != 400 || code != api.CodeBadRequest {
		t.Fatalf("format: %d %s", st, code)
	}
	if st, code := errCode(t, e.get("/api/render/"+small+"?format=wav&sr=22050")); st != 400 || code != api.CodeBadRequest {
		t.Fatalf("sr: %d %s", st, code)
	}
	// an example renders like a stored program
	var ex []api.Example
	decode(t, e.get("/api/examples"), &ex)
	if r := e.get("/api/render/" + ex[1].CID + "?format=wav"); r.StatusCode != 200 {
		t.Fatalf("example render: %d", r.StatusCode)
	} else {
		readAll(t, r)
	}
	// 48k is its own cache entry
	if r := e.get("/api/render/" + small + "?format=wav&sr=48000"); r.StatusCode != 200 {
		t.Fatalf("48k: %d", r.StatusCode)
	} else if b := readAll(t, r); len(b) != 44+48000*4*4 || binary.LittleEndian.Uint32(b[24:28]) != 48000 {
		t.Fatalf("48k wav: %d bytes", len(b))
	}
}

func TestRenderFailureMidStreamAbortsAndIsNotCached(t *testing.T) {
	e := newEnv(t, nil, "BTW_FAKE_CHUNK_DELAY_MS=5", "BTW_FAKE_FAIL_AT_CHUNK=4")
	cid := e.put(progA)
	resp := e.get("/api/render/" + cid + "?format=wav")
	b, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err == nil {
		t.Fatalf("a failed render must end in a broken stream, not a clean EOF (%d bytes)", len(b))
	}
	time.Sleep(100 * time.Millisecond)
	if ents, _ := os.ReadDir(filepath.Join(e.cfg.DataDir, "render")); len(ents) != 0 {
		t.Fatalf("a failed render left %v", ents)
	}
	var st struct {
		Formats map[string]struct{ State string }
	}
	decode(t, e.get("/api/render/"+cid+"/status"), &st)
	if st.Formats["wav"].State != "none" {
		t.Fatalf("status after failure: %+v", st)
	}
}

func TestRenderHeadAndStatus(t *testing.T) {
	e := newEnv(t, nil, "BTW_FAKE_CHUNK_DELAY_MS=50", "BTW_FAKE_SECONDS=3")
	cid := e.put(progA)
	hd := e.do("HEAD", "/api/render/"+cid+"?format=wav", nil)
	hd.Body.Close()
	if hd.StatusCode != 200 || hd.Header.Get("X-Btw-Cache") != "miss" || hd.Header.Get("X-Btw-Cid") != cid || hd.Header.Get("X-Btw-Seconds") != "4.00" {
		t.Fatalf("HEAD: %d %v", hd.StatusCode, hd.Header)
	}
	if e.renderCalls() != 0 {
		t.Fatal("HEAD must not start a render")
	}
	type fs struct {
		State           string
		Bytes           int64
		SecondsRendered float64 `json:"seconds_rendered"`
		Seconds         float64
		URL             string
		Available       bool
	}
	var st struct {
		CID     string
		Formats map[string]fs
		Seconds float64
		Bars    int
	}
	decode(t, e.get("/api/render/"+cid+"/status"), &st)
	if st.CID != cid || st.Formats["wav"].State != "none" || st.Seconds != 4 || st.Bars != 2 || !st.Formats["wav"].Available ||
		!strings.Contains(st.Formats["wav"].URL, "/api/render/"+cid+"?format=wav") {
		t.Fatalf("status: %+v", st)
	}
	resp := e.get("/api/render/" + cid + "?format=wav")
	io.ReadFull(resp.Body, make([]byte, 20000))
	decode(t, e.get("/api/render/"+cid+"/status"), &st)
	if st.Formats["wav"].State != "rendering" || st.Formats["wav"].Bytes < 20000 || st.Formats["wav"].Seconds != 3 {
		t.Fatalf("status while rendering: %+v", st)
	}
	if h := e.do("HEAD", "/api/render/"+cid+"?format=wav", nil); h.Header.Get("X-Btw-Cache") != "joined" {
		t.Fatalf("HEAD during a render: %v", h.Header)
	} else {
		h.Body.Close()
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	time.Sleep(100 * time.Millisecond)
	decode(t, e.get("/api/render/"+cid+"/status"), &st)
	if st.Formats["wav"].State != "ready" || st.Formats["wav"].Bytes != 44+44100*4*3 {
		t.Fatalf("status after: %+v", st)
	}
	if r := e.get("/api/render/zzzzzzzzzzzzzzzzzzzzzzzz/status"); r.StatusCode != 404 {
		t.Fatalf("status of unknown: %d", r.StatusCode)
	}
	// RenderInfo for MCP
	u, s, secs := e.srv.RenderInfo(cid, "wav")
	if u != "https://btw.test/api/render/"+cid+"?format=wav" || s != "https://btw.test/api/render/"+cid+"/status" || secs != 4 {
		t.Fatalf("RenderInfo: %q %q %v", u, s, secs)
	}
}

func TestRenderCacheEvictsLeastRecentlyUsed(t *testing.T) {
	e := newEnv(t, nil, "BTW_FAKE_CHUNK_DELAY_MS=1", "BTW_FAKE_SECONDS=2")
	a, b, c := e.put(progA), e.put(progB), e.put(progC)
	e.srv.rs.capB = 2*(44+44100*4*2) + 1000 // room for two renders
	get := func(cid string) string {
		r := e.get("/api/render/" + cid + "?format=wav")
		readAll(t, r)
		time.Sleep(50 * time.Millisecond)
		return r.Header.Get("X-Btw-Cache")
	}
	get(a)
	e.clk.Advance(time.Second)
	get(b)
	e.clk.Advance(time.Second)
	if get(a) != "hit" { // touch a: now b is the least recently used
		t.Fatal("a should be cached")
	}
	e.clk.Advance(time.Second)
	get(c) // evicts b
	if _, err := os.Stat(filepath.Join(e.cfg.DataDir, "render", b+".44100.wav")); err == nil {
		t.Fatal("b should have been evicted")
	}
	if _, err := os.Stat(filepath.Join(e.cfg.DataDir, "render", a+".44100.wav")); err != nil {
		t.Fatal("a should have been kept")
	}
	if _, err := os.Stat(filepath.Join(e.cfg.DataDir, "render", b+".44100.wav.meta")); err == nil {
		t.Fatal("b's meta should have gone with it")
	}
	e.srv.rs.mu.Lock()
	total := e.srv.rs.total
	e.srv.rs.mu.Unlock()
	if total > e.srv.rs.capB {
		t.Fatalf("cache is %d bytes over a cap of %d", total, e.srv.rs.capB)
	}
	if get(b) != "miss" {
		t.Fatal("an evicted render renders again")
	}
}

func TestRenderStartupRemovesStaleParts(t *testing.T) {
	e := newEnv(t, nil)
	cid := e.put(progA)
	part := filepath.Join(e.cfg.DataDir, "render", cid+".44100.wav.part")
	os.WriteFile(part, []byte("half"), 0o644)
	e2 := e.restart()
	if _, err := os.Stat(part); err == nil {
		t.Fatal("a .part from a dead process should be removed at start")
	}
	_ = e2
}

func TestRenderOpus(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("no ffmpeg")
	}
	e := newEnv(t, nil, "BTW_FAKE_CHUNK_DELAY_MS=60", "BTW_FAKE_SECONDS=4")
	if !e.srv.rs.ffmpegOK() {
		t.Skip("ffmpeg has no libopus")
	}
	cid := e.put(progA)
	start := time.Now()
	resp := e.get("/api/render/" + cid + "?format=opus")
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "audio/ogg; codecs=opus" || resp.Header.Get("X-Btw-Seconds") != "4.00" {
		t.Fatalf("opus: %d %v", resp.StatusCode, resp.Header)
	}
	fb, first := firstByte(t, resp, start)
	t.Logf("first byte (opus through ffmpeg, fake renderer): %s", fb)
	if fb > time.Second {
		t.Errorf("first opus byte took %s", fb)
	}
	rest, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	all := append(first, rest...)
	if len(all) < 4000 || string(all[:4]) != "OggS" || !strings.Contains(string(all[:200]), "OpusHead") {
		t.Fatalf("not Ogg Opus: %d bytes % x", len(all), all[:min(32, len(all))])
	}
	// ffprobe agrees about the duration, when it is around
	time.Sleep(150 * time.Millisecond)
	hit := e.get("/api/render/"+cid+"?format=opus", hdr("Range", "bytes=0-3"))
	if got := readAll(t, hit); hit.StatusCode != 206 || string(got) != "OggS" || hit.Header.Get("X-Btw-Cache") != "hit" {
		t.Fatalf("opus hit: %d %q %v", hit.StatusCode, got, hit.Header)
	}
	full := readAll(t, e.get("/api/render/"+cid+"?format=opus"))
	if string(full) != string(all) {
		t.Fatalf("the cached Ogg differs from what was streamed (%d vs %d bytes)", len(full), len(all))
	}
	if probe, err := exec.LookPath("ffprobe"); err == nil {
		out, _ := exec.Command(probe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", filepath.Join(e.cfg.DataDir, "render", cid+".44100.opus")).Output()
		if d := strings.TrimSpace(string(out)); !strings.HasPrefix(d, "4.") && !strings.HasPrefix(d, "3.9") {
			t.Fatalf("ffprobe says the duration is %q", d)
		}
	}
	// default format is opus when ffmpeg is there
	if r := e.get("/api/render/" + cid); r.Header.Get("Content-Type") != "audio/ogg; codecs=opus" {
		t.Fatalf("default format: %v", r.Header.Get("Content-Type"))
	} else {
		r.Body.Close()
	}
}

func TestRenderOpusWithoutFFmpeg(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.FFmpeg = "/nonexistent/ffmpeg" })
	cid := e.put(progA)
	r := e.get("/api/render/" + cid + "?format=opus")
	if st, code := errCode(t, r); st != 503 || code != api.CodeNotConfigured {
		t.Fatalf("opus without ffmpeg: %d %s", st, code)
	}
	var m struct{ Message string }
	var env struct{ Error api.Error }
	decode(t, e.get("/api/render/"+cid+"?format=opus"), &env)
	if !strings.Contains(env.Error.Message, "ffmpeg") || !strings.Contains(env.Error.Message, "wav") {
		t.Fatalf("the error should say what to do: %q %v", env.Error.Message, m)
	}
	// with no format given, wav is used
	r = e.get("/api/render/" + cid)
	readAll(t, r)
	if r.StatusCode != 200 || r.Header.Get("Content-Type") != "audio/wav" {
		t.Fatalf("default without ffmpeg: %d %v", r.StatusCode, r.Header.Get("Content-Type"))
	}
	var info struct{ Render struct{ Formats []string } }
	decode(t, e.get("/api/info"), &info)
	if len(info.Render.Formats) != 1 || info.Render.Formats[0] != "wav" {
		t.Fatalf("info formats: %v", info.Render.Formats)
	}
}

func TestRenderWithoutABtwdRenderer(t *testing.T) {
	// a checker-only server (no renderer): the route answers cleanly instead of panicking
	e := newEnv(t, func(c *Config) { c.Renderer = noRenderer{} })
	cid := e.put(progA)
	if st, code := errCode(t, e.get("/api/render/"+cid+"?format=wav")); st != 503 || code != api.CodeNotConfigured {
		t.Fatalf("%d %s", st, code)
	}
}

func TestRenderCORSExposesTheHeaders(t *testing.T) {
	e := newEnv(t, nil)
	cid := e.put(progA)
	r := e.get("/api/render/"+cid+"?format=wav", hdr("Origin", "https://other.example"))
	readAll(t, r)
	if r.Header.Get("Access-Control-Allow-Origin") != "*" || !strings.Contains(r.Header.Get("Access-Control-Expose-Headers"), "X-Btw-Seconds") {
		t.Fatalf("%v", r.Header)
	}
}

func TestHandlerLevelAbortIsNotAPanicLog(t *testing.T) {
	// the abort panic must pass through the recoverer and the logger untouched
	e := newEnv(t, nil)
	h := e.srv.Handler()
	defer func() {
		if v := recover(); v != http.ErrAbortHandler {
			t.Fatalf("recovered %v", v)
		}
	}()
	e.srv.handler = h
	mux := http.NewServeMux()
	mux.HandleFunc("/boom", func(w http.ResponseWriter, r *http.Request) { panic(http.ErrAbortHandler) })
	e.srv.middleware(mux).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/boom", nil))
}

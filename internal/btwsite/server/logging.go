package server

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
)

// accessLog writes one JSON line per request to <dir>/access-YYYYMMDD.jsonl:
//
//	{"time":…,"method":…,"path":…,"status":…,"ms":…,"bytes":…,"ip":"<hash>","user":"<id>"}
//
// It never records cookies, tokens, keys, query strings, request bodies or prompt text. The IP is an
// HMAC of the address (so the log cannot be reversed by trying every IPv4 address). Session ids in paths
// are replaced by ":id": an id is a capability.
type accessLog struct {
	dir string
	now func() time.Time
	key []byte

	mu   sync.Mutex
	day  string
	f    *os.File
	w    *bufio.Writer
	stop chan struct{}
}

func newAccessLog(dir string, now func() time.Time, key []byte) (*accessLog, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	l := &accessLog{dir: dir, now: now, key: key, stop: make(chan struct{})}
	go func() { // flush every second so a tail -f is nearly live
		t := time.NewTicker(time.Second)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				l.mu.Lock()
				if l.w != nil {
					_ = l.w.Flush()
				}
				l.mu.Unlock()
			case <-l.stop:
				return
			}
		}
	}()
	return l, nil
}

func (l *accessLog) Close() {
	select {
	case <-l.stop:
		return
	default:
		close(l.stop)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.w != nil {
		_ = l.w.Flush()
		_ = l.f.Close()
		l.w, l.f = nil, nil
	}
}

type logLine struct {
	Time   string `json:"time"`
	Method string `json:"method"`
	Path   string `json:"path"`
	Status int    `json:"status"`
	MS     int64  `json:"ms"`
	Bytes  int64  `json:"bytes"`
	IP     string `json:"ip"`
	User   string `json:"user,omitempty"`
}

func (l *accessLog) hashIP(ip string) string {
	m := hmac.New(sha256.New, l.key)
	m.Write([]byte(api.IPKey(ip)))
	return hex.EncodeToString(m.Sum(nil)[:8])
}

func (l *accessLog) write(line logLine) {
	b, _ := json.Marshal(line)
	l.mu.Lock()
	defer l.mu.Unlock()
	select {
	case <-l.stop:
		return
	default:
	}
	day := l.now().UTC().Format("20060102")
	if l.f == nil || day != l.day {
		if l.w != nil {
			_ = l.w.Flush()
			_ = l.f.Close()
		}
		f, err := os.OpenFile(filepath.Join(l.dir, "access-"+day+".jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o640)
		if err != nil {
			l.f, l.w = nil, nil
			return
		}
		l.f, l.w, l.day = f, bufio.NewWriterSize(f, 16<<10), day
		l.pruneLocked()
	}
	_, _ = l.w.Write(append(b, '\n'))
}

// reqInfo is what a handler can add to its own log line.
type reqInfo struct{ user string }

type ctxKey struct{}

func infoOf(r *http.Request) *reqInfo {
	ri, _ := r.Context().Value(ctxKey{}).(*reqInfo)
	return ri
}

// statusWriter records status and bytes, and passes Flush / deadlines through (http.ResponseController
// finds them through Unwrap).
type statusWriter struct {
	http.ResponseWriter
	status int
	bytes  int64
}

func (w *statusWriter) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	n, err := w.ResponseWriter.Write(b)
	w.bytes += int64(n)
	return n, err
}

func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

var reSessionPath = regexp.MustCompile(`^(/api/session/)[^/]+(/.*)?$`)

func logPath(p string) string {
	if len(p) > 200 {
		p = p[:200]
	}
	return reSessionPath.ReplaceAllString(p, "${1}:id${2}")
}

func (l *accessLog) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := l.now()
		ri := &reqInfo{}
		r = r.WithContext(context.WithValue(r.Context(), ctxKey{}, ri))
		sw := &statusWriter{ResponseWriter: w}
		ip := r.RemoteAddr
		if h, _, err := net.SplitHostPort(ip); err == nil {
			ip = h
		}
		defer func() {
			status := sw.status
			if status == 0 {
				status = http.StatusOK
			}
			if v := recover(); v != nil { // an aborted stream: log it as such, then keep aborting
				l.write(logLine{Time: start.UTC().Format(time.RFC3339), Method: r.Method, Path: logPath(r.URL.Path), Status: status, MS: l.now().Sub(start).Milliseconds(),
					Bytes: sw.bytes, IP: l.hashIP(ip), User: ri.user})
				panic(v)
			}
			l.write(logLine{Time: start.UTC().Format(time.RFC3339), Method: r.Method, Path: logPath(r.URL.Path), Status: status, MS: l.now().Sub(start).Milliseconds(),
				Bytes: sw.bytes, IP: l.hashIP(ip), User: ri.user})
		}()
		next.ServeHTTP(sw, r)
	})
}

// logKeepDays is how long access logs are kept.
const logKeepDays = 30

// pruneLocked removes access logs older than logKeepDays (checked when a new day's file is opened).
func (l *accessLog) pruneLocked() {
	cut := l.now().UTC().AddDate(0, 0, -logKeepDays).Format("20060102")
	files, _ := filepath.Glob(filepath.Join(l.dir, "access-*.jsonl"))
	for _, f := range files {
		day := strings.TrimSuffix(strings.TrimPrefix(filepath.Base(f), "access-"), ".jsonl")
		if len(day) == 8 && day < cut {
			_ = os.Remove(f)
		}
	}
}

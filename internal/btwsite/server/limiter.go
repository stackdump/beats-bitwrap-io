package server

import (
	"net/http"
	"sync"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
)

// ClientIP is the address a request really came from. Every per-IP limit, log line, compose call and MCP
// call uses this one function (it lives in package api so mcpsrv and compose can share it): behind nginx
// RemoteAddr is loopback, so X-Real-IP (else the last X-Forwarded-For entry) is read only then; from any
// other peer those headers are ignored so a direct client cannot spoof them.
func ClientIP(r *http.Request) string { return api.ClientIP(r) }

// ipLimiter is a sliding-window counter per key: at most n events in any window. Keys are IPs (IPv6
// by /64, see api.IPKey).
type ipLimiter struct {
	n      int
	window time.Duration
	now    func() time.Time

	mu    sync.Mutex
	hits  map[string][]time.Time
	calls int
}

const maxLimiterKeys = 200000

func newIPLimiter(n int, window time.Duration, now func() time.Time) *ipLimiter {
	if now == nil {
		now = time.Now
	}
	return &ipLimiter{n: n, window: window, now: now, hits: map[string][]time.Time{}}
}

// Allow records one event for ip and reports whether it is within the limit; when it is not, the event is
// not recorded and retryAfter says (in seconds, at least 1) when the oldest one leaves the window.
func (l *ipLimiter) Allow(ip string) (ok bool, retryAfter int) {
	if l == nil || l.n <= 0 {
		return true, 0
	}
	return l.take(ip, true)
}

// Peek is Allow without recording.
func (l *ipLimiter) Peek(ip string) (ok bool, retryAfter int) {
	if l == nil || l.n <= 0 {
		return true, 0
	}
	return l.take(ip, false)
}

// Record adds an event unconditionally (after a Peek that said yes and the work actually started).
func (l *ipLimiter) Record(ip string) {
	if l == nil || l.n <= 0 {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	key := api.IPKey(ip)
	l.hits[key] = append(l.prune(l.hits[key]), l.now())
}

func (l *ipLimiter) prune(ts []time.Time) []time.Time {
	cut := l.now().Add(-l.window)
	i := 0
	for i < len(ts) && !ts[i].After(cut) {
		i++
	}
	return ts[i:]
}

func (l *ipLimiter) take(ip string, record bool) (bool, int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	key := api.IPKey(ip)
	l.calls++
	if l.calls%2048 == 0 || len(l.hits) > maxLimiterKeys {
		for k, ts := range l.hits {
			if ts = l.prune(ts); len(ts) == 0 {
				delete(l.hits, k)
			} else {
				l.hits[k] = ts
			}
		}
		if len(l.hits) > maxLimiterKeys { // a flood of distinct keys: forget rather than grow without bound
			l.hits = map[string][]time.Time{}
		}
	}
	ts := l.prune(l.hits[key])
	if len(ts) >= l.n {
		l.hits[key] = ts
		wait := int(ts[0].Add(l.window).Sub(l.now()).Seconds()) + 1
		return false, max(wait, 1)
	}
	if record {
		ts = append(ts, l.now())
	}
	if len(ts) == 0 {
		delete(l.hits, key)
	} else {
		l.hits[key] = ts
	}
	return true, 0
}

// limited answers 429 for a refused limiter and reports whether the request may go on.
func limited(w http.ResponseWriter, ok bool, retry int, what string) bool {
	if ok {
		return true
	}
	e := api.Errf(http.StatusTooManyRequests, api.CodeRateLimited, "too many %s requests from your address; try again in %ds", what, retry)
	e.RetryAfter = retry
	api.WriteError(w, e)
	return false
}

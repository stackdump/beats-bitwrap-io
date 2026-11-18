package mcpsrv

import (
	"sync"
	"time"
)

// limiter is a sliding-window counter per key: at most n events in any window. It exists because the
// Backend has no notion of who is asking for the checker-backed read tools (the HTTP routes are limited
// per address by the server; MCP arrives on one route), and an anonymous caller must not be able to
// spawn btwd or fill the program store without bound.
type limiter struct {
	n      int
	window time.Duration
	now    func() time.Time

	mu   sync.Mutex
	hits map[string][]time.Time
}

func newLimiter(n int, window time.Duration, now func() time.Time) *limiter {
	return &limiter{n: n, window: window, now: now, hits: map[string][]time.Time{}}
}

// allow records an event for key and reports whether it fits; when it does not, retry is the seconds
// until the oldest event leaves the window (at least 1).
func (l *limiter) allow(key string) (ok bool, retry int) {
	if l == nil || l.n <= 0 {
		return true, 0
	}
	now := l.now()
	cut := now.Add(-l.window)
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.hits) > 20000 { // sweep keys whose events have all expired
		for k, v := range l.hits {
			if len(v) == 0 || !v[len(v)-1].After(cut) {
				delete(l.hits, k)
			}
		}
	}
	h := l.hits[key]
	i := 0
	for i < len(h) && !h[i].After(cut) {
		i++
	}
	h = h[i:]
	if len(h) >= l.n {
		l.hits[key] = h
		d := h[0].Add(l.window).Sub(now)
		retry = int((d + time.Second - 1) / time.Second)
		if retry < 1 {
			retry = 1
		}
		return false, retry
	}
	l.hits[key] = append(h, now)
	return true, 0
}

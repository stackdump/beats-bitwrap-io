package card

import (
	"context"
	"net/http"
	"sync"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
)

// workLimiter counts, per address and per minute, the requests that made the service work. A fixed window:
// simple, and the burst it allows at a window's edge (twice the limit) costs little.
type workLimiter struct {
	n   int
	now func() time.Time

	mu   sync.Mutex
	hits map[string]*workWindow
}

type workWindow struct {
	start time.Time
	n     int
}

const maxWorkKeys = 100000

func newWorkLimiter(n int, now func() time.Time) *workLimiter {
	return &workLimiter{n: n, now: now, hits: map[string]*workWindow{}}
}

// allow records one unit of work for addr; false (and the seconds to wait) when the window is full.
func (l *workLimiter) allow(addr string) (bool, int) {
	if l == nil || l.n < 0 {
		return true, 0
	}
	now := l.now()
	key := api.IPKey(addr)
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.hits) > maxWorkKeys { // a flood of distinct addresses: forget the expired, then everything
		for k, w := range l.hits {
			if now.Sub(w.start) >= time.Minute {
				delete(l.hits, k)
			}
		}
		if len(l.hits) > maxWorkKeys {
			l.hits = map[string]*workWindow{}
		}
	}
	w := l.hits[key]
	if w == nil || now.Sub(w.start) >= time.Minute {
		w = &workWindow{start: now}
		l.hits[key] = w
	}
	if w.n >= l.n {
		return false, max(1, int(w.start.Add(time.Minute).Sub(now).Seconds())+1)
	}
	w.n++
	return true, 0
}

type addrKey struct{}

// withAddr puts the client address on ctx, for the work limiter.
func withAddr(ctx context.Context, addr string) context.Context {
	return context.WithValue(ctx, addrKey{}, addr)
}

// allowWork charges one unit of work to the request's address: nil, or a 429 *api.Error.
func (s *Service) allowWork(ctx context.Context) error {
	addr, _ := ctx.Value(addrKey{}).(string)
	if addr == "" { // Render and the tests call in with no request behind them
		return nil
	}
	if ok, retry := s.work.allow(addr); !ok {
		e := api.Errf(http.StatusTooManyRequests, api.CodeRateLimited, "too many link previews from your address; try again in %ds", retry)
		e.RetryAfter = retry
		return e
	}
	return nil
}

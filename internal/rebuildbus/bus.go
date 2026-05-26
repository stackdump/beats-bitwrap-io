// Package rebuildbus is a tiny in-process pub/sub for rebuild-queue events.
//
// When a CID is marked for re-render (POST /api/rebuild-mark), Publish fans it
// out to every subscribed SSE client (GET /api/rebuild-events) so an off-host
// render farm learns about the work near-instantly instead of polling.
//
// Delivery is best-effort by design: the durable rebuild_queue in index.db is
// the source of truth, and a worker drains it on (re)connect plus a slow poll
// backstop. So a dropped event (slow/full subscriber) only adds latency, never
// loses work — which lets Publish stay non-blocking.
package rebuildbus

import "sync"

// defaultMaxSubs caps concurrent SSE subscribers so an open (well, secret-
// gated) streaming endpoint can't accumulate unbounded connections.
const defaultMaxSubs = 16

// subBuffer is the per-subscriber channel depth. A burst beyond this drops
// the overflow (worker re-drains the queue on the next event/poll).
const subBuffer = 64

type Bus struct {
	mu   sync.Mutex
	subs map[chan string]struct{}
	max  int
}

func New() *Bus {
	return &Bus{subs: make(map[chan string]struct{}), max: defaultMaxSubs}
}

// Subscribe registers a new listener. It returns a receive-only channel of
// CIDs, an idempotent unsubscribe func the caller must defer, and ok=false if
// the subscriber cap is reached.
func (b *Bus) Subscribe() (<-chan string, func(), bool) {
	ch := make(chan string, subBuffer)
	b.mu.Lock()
	if len(b.subs) >= b.max {
		b.mu.Unlock()
		return nil, nil, false
	}
	b.subs[ch] = struct{}{}
	b.mu.Unlock()

	var once sync.Once
	cancel := func() {
		once.Do(func() {
			b.mu.Lock()
			delete(b.subs, ch)
			b.mu.Unlock()
			// Safe to close after unlock: ch is no longer in subs, so a
			// concurrent Publish (which holds the lock and only iterates
			// subs) can't send on it.
			close(ch)
		})
	}
	return ch, cancel, true
}

// Publish fans cid out to all current subscribers without blocking. Holding
// the lock while sending serializes against Subscribe/cancel so a channel is
// never sent-to after close.
func (b *Bus) Publish(cid string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.subs {
		select {
		case ch <- cid:
		default: // subscriber buffer full — drop; the queue + drain covers it
		}
	}
}

// Count reports the number of active subscribers (for status/metrics).
func (b *Bus) Count() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.subs)
}

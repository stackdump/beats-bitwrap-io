package rebuildbus

import "testing"

func TestPublishDeliversToSubscribers(t *testing.T) {
	b := New()
	ch1, c1, ok := b.Subscribe()
	if !ok {
		t.Fatal("subscribe 1 failed")
	}
	defer c1()
	ch2, c2, ok := b.Subscribe()
	if !ok {
		t.Fatal("subscribe 2 failed")
	}
	defer c2()

	b.Publish("zCID")
	for i, ch := range []<-chan string{ch1, ch2} {
		select {
		case got := <-ch:
			if got != "zCID" {
				t.Errorf("sub %d got %q, want zCID", i, got)
			}
		default:
			t.Errorf("sub %d received nothing", i)
		}
	}
}

func TestUnsubscribeStopsDelivery(t *testing.T) {
	b := New()
	ch, cancel, _ := b.Subscribe()
	cancel()
	if b.Count() != 0 {
		t.Fatalf("Count after cancel = %d, want 0", b.Count())
	}
	b.Publish("zCID") // must not panic (no send on closed ch)
	if _, open := <-ch; open {
		t.Error("channel should be closed and drained")
	}
	cancel() // idempotent — must not panic
}

func TestSubscriberCap(t *testing.T) {
	b := New()
	var cancels []func()
	for i := 0; i < defaultMaxSubs; i++ {
		_, c, ok := b.Subscribe()
		if !ok {
			t.Fatalf("subscribe %d failed under cap", i)
		}
		cancels = append(cancels, c)
	}
	if _, _, ok := b.Subscribe(); ok {
		t.Error("subscribe over cap should fail")
	}
	for _, c := range cancels {
		c()
	}
	if _, _, ok := b.Subscribe(); !ok {
		t.Error("subscribe should succeed after cancels free slots")
	}
}

func TestPublishNonBlockingWhenFull(t *testing.T) {
	b := New()
	_, cancel, _ := b.Subscribe() // never drained
	defer cancel()
	for i := 0; i < subBuffer*2; i++ {
		b.Publish("zCID") // must not block past the buffer
	}
}

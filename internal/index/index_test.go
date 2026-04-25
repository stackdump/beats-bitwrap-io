package index

import (
	"path/filepath"
	"testing"
	"time"
)

func TestRecordRenderRoundTrip(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "i.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	payload := []byte(`{
		"@type": "BeatsShare",
		"v": 1,
		"genre": "techno",
		"name": "Crystal Ember",
		"seed": -1270265324,
		"tempo": 128,
		"swing": 0,
		"humanize": 10,
		"structure": "loop"
	}`)
	if err := db.RecordRender("z4EBG9izZM5u9fRMXLwkr9p6G5EGXfMohNfq7MQgwDESs4tH21G", payload, 1957606); err != nil {
		t.Fatalf("record: %v", err)
	}
	cid, err := db.Latest()
	if err != nil || cid == "" {
		t.Fatalf("latest: cid=%q err=%v", cid, err)
	}
	rows, err := db.Feed(FeedQuery{Genre: "techno"})
	if err != nil {
		t.Fatalf("feed: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("want 1 row, got %d", len(rows))
	}
	got := rows[0]
	if got.CID != cid || got.Name != "Crystal Ember" || got.Tempo != 128 || got.Genre != "techno" {
		t.Fatalf("row mismatch: %+v", got)
	}
	// Genre filter excludes non-matches.
	rows, err = db.Feed(FeedQuery{Genre: "ambient"})
	if err != nil || len(rows) != 0 {
		t.Fatalf("ambient filter: rows=%d err=%v", len(rows), err)
	}
	// Re-record bumps rendered_at.
	first := got.RenderedAt
	if err := db.RecordRender(got.CID, payload, 2000000); err != nil {
		t.Fatalf("re-record: %v", err)
	}
	rows, _ = db.Feed(FeedQuery{})
	if rows[0].RenderedAt < first {
		t.Fatalf("rendered_at didn't advance: was %d, now %d", first, rows[0].RenderedAt)
	}
}

func TestFeedCursorPagination(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "i.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	for i, cid := range []string{"zaaa", "zbbb", "zccc"} {
		payload := []byte(`{"@type":"BeatsShare","v":1,"genre":"techno","seed":` +
			itoa(int64(i)) + `,"tempo":128}`)
		if err := db.RecordRender(cid, payload, 1000); err != nil {
			t.Fatalf("record %s: %v", cid, err)
		}
		// rendered_at is unix-ms; ensure each record gets a distinct
		// timestamp so the cursor pagination has a meaningful order.
		time.Sleep(2 * time.Millisecond)
	}
	page1, _ := db.Feed(FeedQuery{Limit: 2})
	if len(page1) != 2 {
		t.Fatalf("page1: want 2, got %d", len(page1))
	}
	page2, _ := db.Feed(FeedQuery{Limit: 2, Before: page1[1].RenderedAt})
	if len(page2) != 1 {
		t.Fatalf("page2: want 1, got %d", len(page2))
	}
	if page2[0].CID == page1[0].CID || page2[0].CID == page1[1].CID {
		t.Fatalf("page2 CID overlaps page1: %s in %v", page2[0].CID, page1)
	}
}

// itoa avoids the strconv import for a one-liner test helper.
func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

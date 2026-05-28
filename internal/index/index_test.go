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

// TestAudioProvenanceAndSuspect: records browser + renderfarm + untagged
// rows, asserts SuspectAudioCIDs filters by provenance, grace window,
// and includeUnknown.
func TestAudioProvenanceAndSuspect(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "i.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	payload := []byte(`{"@type":"BeatsShare","v":1,"genre":"techno","seed":1,"tempo":124}`)
	mustRecord := func(cid string, at int64) {
		t.Helper()
		if err := db.RecordRenderAt(cid, payload, 1000, at); err != nil {
			t.Fatalf("record %s: %v", cid, err)
		}
	}

	// Layout:
	//   zold-browser    (browser, 1 hour old)        → suspect
	//   znew-browser    (browser, 5 min old)         → grace
	//   zfarm           (renderfarm)                 → canonical
	//   zlegacy         (no provenance set)          → unknown
	now := time.Now().UnixMilli()
	mustRecord("zold-browser", now-60*60*1000)
	mustRecord("znew-browser", now-5*60*1000)
	mustRecord("zfarm", now-30*60*1000)
	mustRecord("zlegacy", now-2*60*60*1000)

	if err := db.RecordAudioProvenance("zold-browser", "browser"); err != nil {
		t.Fatalf("tag zold-browser: %v", err)
	}
	if err := db.RecordAudioProvenance("znew-browser", "browser"); err != nil {
		t.Fatalf("tag znew-browser: %v", err)
	}
	if err := db.RecordAudioProvenance("zfarm", "renderfarm"); err != nil {
		t.Fatalf("tag zfarm: %v", err)
	}
	// zlegacy intentionally untagged.

	// Default: only browser, with a 30 min grace window.
	graceCutoff := now - 30*60*1000
	suspects, err := db.SuspectAudioCIDs(50, graceCutoff, false)
	if err != nil {
		t.Fatalf("suspect: %v", err)
	}
	if got := joinSorted(suspects); got != "zold-browser" {
		t.Fatalf("default suspects = %q, want zold-browser only", got)
	}

	// includeUnknown=true: legacy also surfaces.
	suspects, _ = db.SuspectAudioCIDs(50, graceCutoff, true)
	if got := joinSorted(suspects); got != "zlegacy,zold-browser" {
		t.Fatalf("with-unknown suspects = %q, want zlegacy,zold-browser", got)
	}

	// Grace=0: now znew-browser also surfaces.
	suspects, _ = db.SuspectAudioCIDs(50, now, false)
	if got := joinSorted(suspects); got != "znew-browser,zold-browser" {
		t.Fatalf("no-grace suspects = %q, want both browser rows", got)
	}

	// Limit honored.
	suspects, _ = db.SuspectAudioCIDs(1, now, false)
	if len(suspects) != 1 {
		t.Fatalf("limit=1 returned %d", len(suspects))
	}

	// Re-tag zold-browser as renderfarm: drops off the suspect list.
	if err := db.RecordAudioProvenance("zold-browser", "renderfarm"); err != nil {
		t.Fatalf("retag: %v", err)
	}
	suspects, _ = db.SuspectAudioCIDs(50, graceCutoff, false)
	if len(suspects) != 0 {
		t.Fatalf("after retag, expected empty suspect list; got %v", suspects)
	}
}

// joinSorted returns a stable comma-joined string for assertion.
func joinSorted(ss []string) string {
	cp := append([]string(nil), ss...)
	// tiny sort-3 cheap, avoid sort import for one-liner
	for i := range cp {
		for j := i + 1; j < len(cp); j++ {
			if cp[j] < cp[i] {
				cp[i], cp[j] = cp[j], cp[i]
			}
		}
	}
	out := ""
	for i, s := range cp {
		if i > 0 {
			out += ","
		}
		out += s
	}
	return out
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

package bench

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A real report from the first phone run (docs/perf/2026-10-02-android-8gb.json).
const phone = `{
  "bench": "beats-audio-engine/v1", "genre": "techno", "seed": 42, "structure": "standard", "seconds": 20,
  "at": "2026-10-02T14:37:24.127Z", "label": "my phone",
  "device": {"ua": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36",
             "cores": 8, "memoryGB": 8, "defaultSampleRate": 48000, "model": "Pixel 8", "platform": "Android", "mobile": true},
  "results": [
    {"case": "A", "name": "A · Tone instruments + Tone master", "renderMs": 4703, "xRealtime": 4.25, "peak": 3.723},
    {"case": "F", "name": "F · wave, lean path", "renderMs": 400, "xRealtime": 50.06, "peak": 0.782},
    {"case": "E", "name": "E · wave DSP only", "renderMs": 207, "xRealtime": 96.62, "peak": null}
  ]
}`

func newStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "bench.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func fixedNow() time.Time { return time.Date(2026, 10, 2, 15, 0, 0, 0, time.UTC) }

func post(t *testing.T, h http.Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/bench", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)
	return rec
}

func TestSubmitAndList(t *testing.T) {
	s := newStore(t)
	h := Handler(s, nil, fixedNow)
	rec := post(t, h, phone)
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST = %d %s", rec.Code, rec.Body)
	}
	var created struct {
		OK        bool  `json:"ok"`
		ID        int64 `json:"id"`
		Reference bool  `json:"reference"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &created)
	if !created.OK || created.ID == 0 || !created.Reference {
		t.Fatalf("created = %+v", created)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/bench?reference=1", nil))
	var list struct{ Results []Row }
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil || len(list.Results) != 1 {
		t.Fatalf("GET = %s (%v)", rec.Body, err)
	}
	row := list.Results[0]
	if row.Platform != "android" || row.Model != "Pixel 8" || row.Label != "my phone" ||
		row.X["A"] != 4.25 || row.X["F"] != 50.06 || row.Track != "techno·42·standard" ||
		row.SubmittedAt != "2026-10-02T15:00:00Z" {
		t.Fatalf("row = %+v", row)
	}
	if _, ok := row.X["B"]; ok {
		t.Fatal("absent case B must not appear")
	}
	if rec.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Fatal("GET must allow CORS")
	}
}

func TestRejects(t *testing.T) {
	h := Handler(newStore(t), nil, fixedNow)
	mutate := func(from, to string) string { return strings.Replace(phone, from, to, 1) }
	cases := map[string]string{
		"wrong version":     mutate(`"beats-audio-engine/v1"`, `"beats-audio-engine/v9"`),
		"unknown field":     mutate(`"seconds": 20,`, `"seconds": 20, "evil": 1,`),
		"unknown case":      mutate(`{"case": "E"`, `{"case": "Z"`),
		"duplicate case":    mutate(`{"case": "E"`, `{"case": "A"`),
		"negative x":        mutate(`"xRealtime": 4.25`, `"xRealtime": -1`),
		"no ua":             mutate(`"ua": "Mozilla`, `"x": "Mozilla`),
		"bad timestamp":     mutate(`"2026-10-02T14:37:24.127Z"`, `"yesterday"`),
		"control char":      mutate(`"my phone"`, `"my\u0007phone"`),
		"label too long":    mutate(`"my phone"`, `"`+strings.Repeat("x", 81)+`"`),
		"no result or err":  mutate(`, "xRealtime": 96.62`, ``),
		"huge body":         `{"bench":"` + strings.Repeat("x", MaxBody) + `"}`,
		"not json":          `nope`,
		"seconds too large": mutate(`"seconds": 20`, `"seconds": 9999`),
	}
	for name, body := range cases {
		if rec := post(t, h, body); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: got %d %s", name, rec.Code, rec.Body)
		}
	}
}

func TestRateLimitAndPreflight(t *testing.T) {
	h := Handler(newStore(t), func(*http.Request) (bool, string) { return false, "slow down" }, fixedNow)
	if rec := post(t, h, phone); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("rate-limited POST = %d", rec.Code)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodOptions, "/api/bench", nil))
	if rec.Code != http.StatusNoContent || rec.Header().Get("Access-Control-Allow-Headers") != "Content-Type" {
		t.Fatalf("preflight = %d %v", rec.Code, rec.Header())
	}
}

func TestNonReferenceAndPlatform(t *testing.T) {
	s := newStore(t)
	h := Handler(s, nil, fixedNow)
	cur := strings.Replace(phone, `"genre": "techno", "seed": 42, "structure": "standard",`, `"current": "techno · Jade Pulse",`, 1)
	if rec := post(t, h, cur); rec.Code != http.StatusCreated {
		t.Fatalf("current-track POST = %d %s", rec.Code, rec.Body)
	}
	rows, _ := s.List(10, true)
	if len(rows) != 0 {
		t.Fatal("current-track run must not count as reference")
	}
	rows, _ = s.List(10, false)
	if len(rows) != 1 || rows[0].Track != "current: techno · Jade Pulse" {
		t.Fatalf("rows = %+v", rows)
	}
	if Platform(Device{UA: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"}) != "ios" ||
		Platform(Device{UA: "Mozilla/5.0 (X11; Linux x86_64)"}) != "desktop" {
		t.Fatal("platform buckets")
	}
}

func TestSnapshotBytes(t *testing.T) {
	s := newStore(t)
	h := Handler(s, nil, fixedNow)
	if rec := post(t, h, phone); rec.Code != http.StatusCreated {
		t.Fatalf("POST = %d", rec.Code)
	}
	b, err := s.SnapshotBytes()
	if err != nil || len(b) < 1024 || string(b[:15]) != "SQLite format 3" {
		t.Fatalf("snapshot: %d bytes, err %v", len(b), err)
	}
	// The copy opens and holds the row.
	p := filepath.Join(t.TempDir(), "copy.db")
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatal(err)
	}
	c, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	rows, _ := c.List(10, false)
	if len(rows) != 1 || rows[0].Model != "Pixel 8" {
		t.Fatalf("copy rows = %+v", rows)
	}
}

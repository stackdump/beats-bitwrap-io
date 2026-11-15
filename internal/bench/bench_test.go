package bench

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
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

// The first schema (before the G/H/I djrust cases and engine_version), as
// production's data/bench.db holds it.
const oldSchema = `
CREATE TABLE bench_results (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    submitted_at  INTEGER NOT NULL,
    bench         TEXT NOT NULL,
    track         TEXT NOT NULL,
    reference     INTEGER NOT NULL DEFAULT 0,
    seconds       REAL NOT NULL,
    platform      TEXT NOT NULL DEFAULT '',
    model         TEXT NOT NULL DEFAULT '',
    label         TEXT NOT NULL DEFAULT '',
    ua            TEXT NOT NULL DEFAULT '',
    cores         INTEGER,
    memory_gb     REAL,
    sample_rate   INTEGER,
    x_a REAL, x_b REAL, x_f REAL, x_c REAL, x_d REAL, x_e REAL,
    report        TEXT NOT NULL
);
CREATE INDEX bench_results_ref ON bench_results(reference, submitted_at DESC);
INSERT INTO bench_results (submitted_at, bench, track, reference, seconds, platform, model, label, ua, x_a, x_f, report)
VALUES (1759417044, 'beats-audio-engine/v1', 'techno·42·standard', 1, 20, 'android', 'Pixel 8', 'old row', 'Mozilla/5.0', 4.25, 50.06, '{}');
`

// A djrust report: cases G/H/I plus engineVersion.
var djrust = strings.Replace(phone, `"results": [`, `"engineVersion": "djrust@0.2.0", "results": [
    {"case": "G", "name": "G · djrust alone", "renderMs": 300, "xRealtime": 66.6, "peak": 0.5},
    {"case": "H", "name": "H · djrust alone @ 24 kHz", "renderMs": 160, "xRealtime": 125, "peak": 0.5},
    {"case": "I", "name": "I · djrust DSP only (main thread)", "renderMs": 100, "xRealtime": 200, "peak": null},`, 1)

func columns(t *testing.T, s *Store) map[string]bool {
	t.Helper()
	rows, err := s.db.Query(`PRAGMA table_info(bench_results)`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	have := map[string]bool{}
	for rows.Next() {
		var cid, notnull, pk int
		var name, typ string
		var dflt any
		if err := rows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk); err != nil {
			t.Fatal(err)
		}
		have[name] = true
	}
	return have
}

func TestMigratesOldSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bench.db")
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(oldSchema); err != nil {
		t.Fatal(err)
	}
	raw.Close()

	// Open twice: the migration must be idempotent.
	for i := 0; i < 2; i++ {
		s, err := Open(path)
		if err != nil {
			t.Fatalf("open #%d: %v", i+1, err)
		}
		have := columns(t, s)
		for _, c := range append([]string{"engine_version"}, func() (cs []string) {
			for _, c := range Cases {
				cs = append(cs, column(c))
			}
			return
		}()...) {
			if !have[c] {
				t.Fatalf("open #%d: column %s missing after migration", i+1, c)
			}
		}
		if i == 0 {
			if rec := post(t, Handler(s, nil, fixedNow), djrust); rec.Code != http.StatusCreated {
				t.Fatalf("djrust POST on migrated db = %d %s", rec.Code, rec.Body)
			}
		}
		rows, err := s.List(10, false)
		if err != nil {
			t.Fatal(err)
		}
		if len(rows) != 2 {
			t.Fatalf("open #%d: %d rows", i+1, len(rows))
		}
		newRow, oldRow := rows[0], rows[1]
		if oldRow.Label != "old row" || oldRow.X["A"] != 4.25 || oldRow.X["F"] != 50.06 || len(oldRow.X) != 2 || oldRow.Engine != "" {
			t.Fatalf("old row = %+v", oldRow)
		}
		if newRow.Engine != "djrust@0.2.0" || newRow.X["G"] != 66.6 || newRow.X["H"] != 125 || newRow.X["I"] != 200 || newRow.X["A"] != 4.25 {
			t.Fatalf("new row = %+v", newRow)
		}
		s.Close()
	}
}

func TestFreshSchemaMatchesMigrated(t *testing.T) {
	fresh := columns(t, newStore(t))
	path := filepath.Join(t.TempDir(), "old.db")
	raw, _ := sql.Open("sqlite", path)
	if _, err := raw.Exec(oldSchema); err != nil {
		t.Fatal(err)
	}
	raw.Close()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	migrated := columns(t, s)
	if len(fresh) != len(migrated) {
		t.Fatalf("fresh %v, migrated %v", fresh, migrated)
	}
	for c := range fresh {
		if !migrated[c] {
			t.Fatalf("column %s only in a fresh db", c)
		}
	}
}

func TestDjrustReportAndEngineVersion(t *testing.T) {
	s := newStore(t)
	h := Handler(s, nil, fixedNow)
	if rec := post(t, h, djrust); rec.Code != http.StatusCreated {
		t.Fatalf("POST = %d %s", rec.Code, rec.Body)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/bench", nil))
	if !strings.Contains(rec.Body.String(), `"engineVersion":"djrust@0.2.0"`) || !strings.Contains(rec.Body.String(), `"G":66.6`) {
		t.Fatalf("GET = %s", rec.Body)
	}
	bad := strings.Replace(djrust, `"djrust@0.2.0"`, `"`+strings.Repeat("v", 41)+`"`, 1)
	if rec := post(t, h, bad); rec.Code != http.StatusBadRequest {
		t.Fatalf("long engineVersion = %d", rec.Code)
	}
}

// Every case the page can send must be one the server accepts, or a
// client deployed ahead of the server gets 400s (the server deploys first).
func TestClientCasesSubsetOfServer(t *testing.T) {
	src := readRepoFile(t, "public/wave-engine/bench-core.js")
	known := map[string]bool{}
	for _, c := range Cases {
		known[c] = true
	}
	order := regexp.MustCompile(`export const CASE_ORDER = \[([^\]]*)\]`).FindStringSubmatch(src)
	if order == nil {
		t.Fatal("bench-core.js: CASE_ORDER not found")
	}
	ids := regexp.MustCompile(`'([^']*)'`).FindAllStringSubmatch(order[1], -1)
	body := src[strings.Index(src, "export const CASES = {"):]
	body = body[:strings.Index(body, "\n};")]
	ids = append(ids, regexp.MustCompile(`(?m)^    ([A-Za-z0-9_]+): \{`).FindAllStringSubmatch(body, -1)...)
	if len(ids) < 2 {
		t.Fatalf("bench-core.js: found only %d case ids", len(ids))
	}
	for _, m := range ids {
		if !known[m[1]] {
			t.Errorf("bench-core.js sends case %q, which bench.Cases does not accept", m[1])
		}
	}
}

func readRepoFile(t *testing.T, rel string) string {
	t.Helper()
	root := ""
	if srcdir, ws := os.Getenv("TEST_SRCDIR"), os.Getenv("TEST_WORKSPACE"); srcdir != "" && ws != "" {
		root = filepath.Join(srcdir, ws)
	} else {
		wd, err := os.Getwd()
		if err != nil {
			t.Fatal(err)
		}
		for dir := wd; dir != "/"; dir = filepath.Dir(dir) {
			if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
				root = dir
				break
			}
		}
	}
	b, err := os.ReadFile(filepath.Join(root, rel))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

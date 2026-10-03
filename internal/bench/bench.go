// Package bench stores audio-engine benchmark reports that users submit
// from the studio's "Benchmark this device" modal or the standalone
// public/wave-engine/bench.html.
//
// Submissions are opt-in, anonymous and bounded: a report is validated
// field by field and only the validated fields are stored (never the raw
// body); nothing derived from the requester's IP is kept — rate limiting
// happens in memory before the handler. Results live in their own SQLite
// file (data/bench.db), separate from index.db, which the operator may
// delete to purge the feed.
package bench

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// Version is the only report format accepted (bench-core.js writes it).
const Version = "beats-audio-engine/v1"

// MaxBody caps a submission. A full six-case report is ~1.5 kB.
const MaxBody = 16 << 10

// Cases the bench can report (see public/wave-engine/bench-core.js).
var Cases = []string{"A", "B", "F", "C", "D", "E"}

// Reference track: the fixed run every device can be compared on.
var Reference = struct {
	Genre, Structure string
	Seed             int64
	Seconds          float64
}{"techno", "standard", 42, 20}

const schema = `
CREATE TABLE IF NOT EXISTS bench_results (
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
CREATE INDEX IF NOT EXISTS bench_results_ref ON bench_results(reference, submitted_at DESC);
`

// Report is the submitted JSON (bench-core.js runBench output, plus the
// optional user-entered label).
type Report struct {
	Bench     string   `json:"bench"`
	Genre     string   `json:"genre,omitempty"`
	Seed      *int64   `json:"seed,omitempty"`
	Structure string   `json:"structure,omitempty"`
	Current   string   `json:"current,omitempty"`
	Seconds   float64  `json:"seconds"`
	At        string   `json:"at"`
	Label     string   `json:"label,omitempty"`
	Device    Device   `json:"device"`
	Results   []Result `json:"results"`
}

// Device is what the browser reports about itself. Model / platform come
// from UA client hints where the browser offers them (Chromium).
type Device struct {
	UA                string  `json:"ua"`
	Cores             int     `json:"cores,omitempty"`
	MemoryGB          float64 `json:"memoryGB,omitempty"`
	DefaultSampleRate int     `json:"defaultSampleRate,omitempty"`
	Model             string  `json:"model,omitempty"`
	Platform          string  `json:"platform,omitempty"`
	PlatformVersion   string  `json:"platformVersion,omitempty"`
	Mobile            *bool   `json:"mobile,omitempty"`
}

// Result is one case.
type Result struct {
	Case      string   `json:"case"`
	Name      string   `json:"name"`
	RenderMs  float64  `json:"renderMs,omitempty"`
	XRealtime *float64 `json:"xRealtime,omitempty"`
	Peak      *float64 `json:"peak,omitempty"`
	Error     string   `json:"error,omitempty"`
}

func finite(x float64) bool { return !math.IsNaN(x) && !math.IsInf(x, 0) }

func validText(s string, max int) bool {
	if len(s) > max {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

// Validate checks every field; the first problem is returned.
func Validate(r *Report) error {
	if r.Bench != Version {
		return fmt.Errorf("bench: want %q", Version)
	}
	if !finite(r.Seconds) || r.Seconds < 1 || r.Seconds > 300 {
		return errors.New("seconds out of range")
	}
	if _, err := time.Parse(time.RFC3339, r.At); err != nil {
		return errors.New("at: not RFC3339")
	}
	for _, f := range []struct {
		v   string
		max int
		n   string
	}{
		{r.Genre, 32, "genre"}, {r.Structure, 32, "structure"}, {r.Current, 120, "current"},
		{r.Label, 80, "label"}, {r.Device.UA, 400, "device.ua"}, {r.Device.Model, 80, "device.model"},
		{r.Device.Platform, 40, "device.platform"}, {r.Device.PlatformVersion, 40, "device.platformVersion"},
	} {
		if !validText(f.v, f.max) {
			return fmt.Errorf("%s: too long or contains control characters", f.n)
		}
	}
	if r.Current == "" && r.Genre == "" {
		return errors.New("track: genre or current required")
	}
	if r.Device.UA == "" {
		return errors.New("device.ua required")
	}
	if r.Device.Cores < 0 || r.Device.Cores > 1024 {
		return errors.New("device.cores out of range")
	}
	if !finite(r.Device.MemoryGB) || r.Device.MemoryGB < 0 || r.Device.MemoryGB > 4096 {
		return errors.New("device.memoryGB out of range")
	}
	if r.Device.DefaultSampleRate < 0 || r.Device.DefaultSampleRate > 768000 {
		return errors.New("device.defaultSampleRate out of range")
	}
	if len(r.Results) == 0 || len(r.Results) > len(Cases) {
		return errors.New("results: 1–6 cases")
	}
	seen := map[string]bool{}
	for _, c := range r.Results {
		known := false
		for _, k := range Cases {
			known = known || c.Case == k
		}
		if !known || seen[c.Case] {
			return fmt.Errorf("results: unknown or duplicate case %q", c.Case)
		}
		seen[c.Case] = true
		if !validText(c.Name, 120) || !validText(c.Error, 300) {
			return fmt.Errorf("results[%s]: text too long", c.Case)
		}
		if !finite(c.RenderMs) || c.RenderMs < 0 || c.RenderMs > 3.6e6 {
			return fmt.Errorf("results[%s]: renderMs out of range", c.Case)
		}
		if c.XRealtime != nil && (!finite(*c.XRealtime) || *c.XRealtime <= 0 || *c.XRealtime > 1e5) {
			return fmt.Errorf("results[%s]: xRealtime out of range", c.Case)
		}
		if c.Peak != nil && (!finite(*c.Peak) || *c.Peak < 0 || *c.Peak > 1e3) {
			return fmt.Errorf("results[%s]: peak out of range", c.Case)
		}
		if c.XRealtime == nil && c.Error == "" {
			return fmt.Errorf("results[%s]: xRealtime or error required", c.Case)
		}
	}
	return nil
}

// IsReference reports whether the report ran the fixed reference track.
func IsReference(r *Report) bool {
	return r.Current == "" && r.Genre == Reference.Genre && r.Structure == Reference.Structure &&
		r.Seed != nil && *r.Seed == Reference.Seed && r.Seconds == Reference.Seconds
}

// Platform buckets a device: client-hint platform first, UA second.
func Platform(d Device) string {
	p := strings.ToLower(d.Platform)
	ua := d.UA
	switch {
	case p == "android" || strings.Contains(ua, "Android"):
		return "android"
	case p == "ios" || strings.Contains(ua, "iPhone") || strings.Contains(ua, "iPad"):
		return "ios"
	default:
		return "desktop"
	}
}

// Store is the bench-results database.
type Store struct{ db *sql.DB }

// Open opens (creating if missing) the bench DB at path.
func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("bench: apply schema: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// SnapshotBytes returns a transactionally consistent copy of the database
// (SQLite VACUUM INTO a temp file), for backups. Copying the live file
// with a plain read can capture a torn page or miss the WAL.
func (s *Store) SnapshotBytes() ([]byte, error) {
	dir, err := os.MkdirTemp("", "bench-snapshot-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	out := filepath.Join(dir, "bench.db")
	if _, err := s.db.Exec(`VACUUM INTO ?`, out); err != nil {
		return nil, err
	}
	return os.ReadFile(out)
}

func trackLabel(r *Report) string {
	if r.Current != "" {
		return "current: " + r.Current
	}
	seed := ""
	if r.Seed != nil {
		seed = strconv.FormatInt(*r.Seed, 10)
	}
	return r.Genre + "·" + seed + "·" + r.Structure
}

// Insert stores a validated report. Only the parsed fields are kept: the
// stored `report` column is the re-marshalled struct, not the request body.
func (s *Store) Insert(r *Report, now time.Time) (int64, error) {
	if err := Validate(r); err != nil {
		return 0, err
	}
	x := map[string]any{}
	for _, c := range r.Results {
		if c.XRealtime != nil {
			x[c.Case] = *c.XRealtime
		}
	}
	nz := func(v float64) any {
		if v == 0 {
			return nil
		}
		return v
	}
	canon, err := json.Marshal(r)
	if err != nil {
		return 0, err
	}
	ref := 0
	if IsReference(r) {
		ref = 1
	}
	res, err := s.db.Exec(`INSERT INTO bench_results
		(submitted_at, bench, track, reference, seconds, platform, model, label, ua,
		 cores, memory_gb, sample_rate, x_a, x_b, x_f, x_c, x_d, x_e, report)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		now.Unix(), r.Bench, trackLabel(r), ref, r.Seconds, Platform(r.Device), r.Device.Model, r.Label, r.Device.UA,
		nz(float64(r.Device.Cores)), nz(r.Device.MemoryGB), nz(float64(r.Device.DefaultSampleRate)),
		x["A"], x["B"], x["F"], x["C"], x["D"], x["E"], string(canon))
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// Row is one stored result as served by GET /api/bench.
type Row struct {
	ID          int64              `json:"id"`
	SubmittedAt string             `json:"submittedAt"`
	Track       string             `json:"track"`
	Reference   bool               `json:"reference"`
	Platform    string             `json:"platform"`
	Model       string             `json:"model,omitempty"`
	Label       string             `json:"label,omitempty"`
	UA          string             `json:"ua"`
	Cores       *int               `json:"cores,omitempty"`
	MemoryGB    *float64           `json:"memoryGB,omitempty"`
	X           map[string]float64 `json:"xRealtime"`
}

// List returns the newest results first.
func (s *Store) List(limit int, referenceOnly bool) ([]Row, error) {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	q := `SELECT id, submitted_at, track, reference, platform, model, label, ua, cores, memory_gb,
		x_a, x_b, x_f, x_c, x_d, x_e FROM bench_results`
	if referenceOnly {
		q += ` WHERE reference = 1`
	}
	q += ` ORDER BY submitted_at DESC, id DESC LIMIT ?`
	rows, err := s.db.Query(q, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Row{}
	for rows.Next() {
		var row Row
		var at int64
		var ref int
		var cores sql.NullInt64
		var mem sql.NullFloat64
		xs := make([]sql.NullFloat64, len(Cases))
		dest := []any{&row.ID, &at, &row.Track, &ref, &row.Platform, &row.Model, &row.Label, &row.UA, &cores, &mem}
		for i := range xs {
			dest = append(dest, &xs[i])
		}
		if err := rows.Scan(dest...); err != nil {
			return nil, err
		}
		row.SubmittedAt = time.Unix(at, 0).UTC().Format(time.RFC3339)
		row.Reference = ref == 1
		if cores.Valid {
			c := int(cores.Int64)
			row.Cores = &c
		}
		if mem.Valid {
			m := mem.Float64
			row.MemoryGB = &m
		}
		row.X = map[string]float64{}
		for i, c := range []string{"A", "B", "F", "C", "D", "E"} {
			if xs[i].Valid {
				row.X[c] = xs[i].Float64
			}
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// Handler serves /api/bench:
//
//	POST  submit a report (rate-limited by allow; 16 kB cap) → {ok, id}
//	GET   ?limit=N&reference=1 → newest results first
//	OPTIONS  CORS preflight
//
// CORS is open (no credentials) so the CDN-hosted bench page can submit.
func Handler(s *Store, allow func(*http.Request) (bool, string), now func() time.Time) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Max-Age", "86400")
		switch r.Method {
		case http.MethodOptions:
			w.WriteHeader(http.StatusNoContent)
		case http.MethodGet:
			limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
			rows, err := s.List(limit, r.URL.Query().Get("reference") == "1")
			if err != nil {
				http.Error(w, "list failed", http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "public, max-age=30")
			_ = json.NewEncoder(w).Encode(map[string]any{"results": rows})
		case http.MethodPost:
			if allow != nil {
				if ok, reason := allow(r); !ok {
					w.Header().Set("Retry-After", "60")
					http.Error(w, reason, http.StatusTooManyRequests)
					return
				}
			}
			var rep Report
			dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, MaxBody))
			dec.DisallowUnknownFields()
			if err := dec.Decode(&rep); err != nil {
				http.Error(w, "bad json: "+err.Error(), http.StatusBadRequest)
				return
			}
			id, err := s.Insert(&rep, now())
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "id": id, "reference": IsReference(&rep)})
		default:
			http.Error(w, "GET, POST or OPTIONS", http.StatusMethodNotAllowed)
		}
	}
}

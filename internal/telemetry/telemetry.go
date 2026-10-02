// Package telemetry collects anonymous playback diagnostics from the
// studio (public/lib/perf/telemetry.js) to find out what makes playback
// erratic on phones: taps, focus / visibility changes, page freeze, audio
// context state changes, late notes, worker catch-up, stops and why.
//
// What is stored: a random per-page-load session id (not persisted by the
// browser), coarse device fields (UA, client-hint model, cores, memory),
// and timestamped events relative to page load. Nothing derived from the
// IP address is stored; rate limiting keeps IPs in memory only. Clients
// that send Global Privacy Control / Do Not Track, or opt out, send
// nothing. Data lives in its own SQLite file with a row cap and a 30-day
// retention window.
//
// Public reads are aggregate-only (Summary). Raw sessions need the
// rebuild secret.
package telemetry

import (
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

const (
	Version        = 1
	MaxBody        = 64 << 10
	MaxEvents      = 1000 // per batch
	MaxBatches     = 400  // per session
	MaxRows        = 5_000_000
	Retention      = 30 * 24 * time.Hour
	NearWindowMs   = 2000 // "shortly after" for correlation
	maxDataFields  = 10
	maxStringField = 48
)

// Kinds the client may send. Anything else is rejected.
var Kinds = map[string]bool{
	"tap": true, "vis": true, "focus": true, "blur": true,
	"pagehide": true, "pageshow": true, "freeze": true, "resume": true,
	"ctx": true, "sink": true, "play": true, "stop": true,
	"late": true, "win": true, "catchup": true, "banner": true,
}

// Trigger groups the summary correlates late notes and stops against.
var triggerGroups = map[string][]string{
	"tap":     {"tap"},
	"focus":   {"vis", "focus", "blur", "pagehide", "pageshow", "freeze", "resume"},
	"ctx":     {"ctx", "sink", "banner"},
	"catchup": {"catchup"},
}

var sidPattern = regexp.MustCompile(`^[a-zA-Z0-9-]{8,64}$`)

// Batch is one POST.
type Batch struct {
	V      int     `json:"v"`
	SID    string  `json:"sid"`
	Seq    int     `json:"seq"`
	Engine string  `json:"engine"`
	Device Device  `json:"device"`
	Audio  Audio   `json:"audio"`
	Events []Event `json:"events"`
}

type Device struct {
	UA       string  `json:"ua"`
	Model    string  `json:"model,omitempty"`
	Platform string  `json:"platform,omitempty"`
	Mobile   *bool   `json:"mobile,omitempty"`
	Cores    int     `json:"cores,omitempty"`
	MemoryGB float64 `json:"memoryGB,omitempty"`
}

type Audio struct {
	SampleRate    int     `json:"sampleRate,omitempty"`
	BaseLatency   float64 `json:"baseLatency,omitempty"`
	OutputLatency float64 `json:"outputLatency,omitempty"`
}

// Event is [tMs, kind, data?] on the wire.
type Event struct {
	T    float64
	Kind string
	Data map[string]any
}

func (e *Event) UnmarshalJSON(b []byte) error {
	var raw []json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	if len(raw) < 2 || len(raw) > 3 {
		return errors.New("event: want [t, kind, data?]")
	}
	if err := json.Unmarshal(raw[0], &e.T); err != nil {
		return err
	}
	if err := json.Unmarshal(raw[1], &e.Kind); err != nil {
		return err
	}
	if len(raw) == 3 {
		if err := json.Unmarshal(raw[2], &e.Data); err != nil {
			return err
		}
	}
	return nil
}

func (e Event) MarshalJSON() ([]byte, error) {
	if e.Data == nil {
		return json.Marshal([]any{e.T, e.Kind})
	}
	return json.Marshal([]any{e.T, e.Kind, e.Data})
}

func finite(x float64) bool { return !math.IsNaN(x) && !math.IsInf(x, 0) }

func cleanText(s string, max int) bool {
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

// Validate checks a batch field by field.
func Validate(b *Batch) error {
	if b.V != Version {
		return fmt.Errorf("v: want %d", Version)
	}
	if !sidPattern.MatchString(b.SID) {
		return errors.New("sid: invalid")
	}
	if b.Seq < 0 || b.Seq >= MaxBatches {
		return errors.New("seq out of range")
	}
	if b.Engine != "default" && b.Engine != "wave" {
		return errors.New("engine: default or wave")
	}
	d := b.Device
	if d.UA == "" || !cleanText(d.UA, 400) || !cleanText(d.Model, 80) || !cleanText(d.Platform, 40) {
		return errors.New("device: bad text")
	}
	if d.Cores < 0 || d.Cores > 1024 || !finite(d.MemoryGB) || d.MemoryGB < 0 || d.MemoryGB > 4096 {
		return errors.New("device: out of range")
	}
	a := b.Audio
	if a.SampleRate < 0 || a.SampleRate > 768000 || !finite(a.BaseLatency) || !finite(a.OutputLatency) ||
		a.BaseLatency < 0 || a.BaseLatency > 10 || a.OutputLatency < 0 || a.OutputLatency > 10 {
		return errors.New("audio: out of range")
	}
	if len(b.Events) == 0 || len(b.Events) > MaxEvents {
		return fmt.Errorf("events: 1–%d", MaxEvents)
	}
	for i, e := range b.Events {
		if !finite(e.T) || e.T < 0 || e.T > 48*3600*1000 {
			return fmt.Errorf("events[%d]: t out of range", i)
		}
		if !Kinds[e.Kind] {
			return fmt.Errorf("events[%d]: unknown kind %q", i, e.Kind)
		}
		if len(e.Data) > maxDataFields {
			return fmt.Errorf("events[%d]: too many fields", i)
		}
		for k, v := range e.Data {
			if !cleanText(k, 16) {
				return fmt.Errorf("events[%d]: bad key", i)
			}
			switch x := v.(type) {
			case string:
				if !cleanText(x, maxStringField) {
					return fmt.Errorf("events[%d].%s: bad string", i, k)
				}
			case float64:
				if !finite(x) || math.Abs(x) > 1e9 {
					return fmt.Errorf("events[%d].%s: bad number", i, k)
				}
			case bool, nil:
			default:
				return fmt.Errorf("events[%d].%s: scalars only", i, k)
			}
		}
	}
	return nil
}

// Platform buckets a device (client-hint platform first, UA second).
func Platform(d Device) string {
	p := strings.ToLower(d.Platform)
	switch {
	case p == "android" || strings.Contains(d.UA, "Android"):
		return "android"
	case p == "ios" || strings.Contains(d.UA, "iPhone") || strings.Contains(d.UA, "iPad"):
		return "ios"
	default:
		return "desktop"
	}
}

const schema = `
CREATE TABLE IF NOT EXISTS sessions (
    sid         TEXT PRIMARY KEY,
    first_seen  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    engine      TEXT NOT NULL,
    platform    TEXT NOT NULL,
    model       TEXT NOT NULL DEFAULT '',
    ua          TEXT NOT NULL DEFAULT '',
    mobile      INTEGER,
    cores       INTEGER,
    memory_gb   REAL,
    sample_rate INTEGER,
    base_latency REAL,
    output_latency REAL,
    batches     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_last ON sessions(last_seen);
CREATE TABLE IF NOT EXISTS events (
    sid   TEXT NOT NULL,
    t     REAL NOT NULL,
    kind  TEXT NOT NULL,
    data  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS events_sid ON events(sid, t);
`

// Store is the telemetry database.
type Store struct {
	db        *sql.DB
	mu        sync.Mutex
	lastPurge time.Time
}

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // single writer; SQLite serialises anyway
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("telemetry: apply schema: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

var ErrFull = errors.New("telemetry store full")

// Insert validates and stores a batch.
func (s *Store) Insert(b *Batch, now time.Time) error {
	if err := Validate(b); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if now.Sub(s.lastPurge) > time.Hour {
		s.lastPurge = now
		s.purge(now)
	}
	var rows int64
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM events`).Scan(&rows); err != nil {
		return err
	}
	if rows+int64(len(b.Events)) > MaxRows {
		return ErrFull
	}
	var batches int
	err := s.db.QueryRow(`SELECT batches FROM sessions WHERE sid = ?`, b.SID).Scan(&batches)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if batches >= MaxBatches {
		return errors.New("session batch limit reached")
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var mobile any
	if b.Device.Mobile != nil {
		mobile = 0
		if *b.Device.Mobile {
			mobile = 1
		}
	}
	nz := func(v float64) any {
		if v == 0 {
			return nil
		}
		return v
	}
	if _, err := tx.Exec(`INSERT INTO sessions
		(sid, first_seen, last_seen, engine, platform, model, ua, mobile, cores, memory_gb, sample_rate, base_latency, output_latency, batches)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)
		ON CONFLICT(sid) DO UPDATE SET last_seen = excluded.last_seen, engine = excluded.engine, batches = batches + 1`,
		b.SID, now.Unix(), now.Unix(), b.Engine, Platform(b.Device), b.Device.Model, b.Device.UA, mobile,
		nz(float64(b.Device.Cores)), nz(b.Device.MemoryGB), nz(float64(b.Audio.SampleRate)),
		nz(b.Audio.BaseLatency), nz(b.Audio.OutputLatency)); err != nil {
		return err
	}
	stmt, err := tx.Prepare(`INSERT INTO events (sid, t, kind, data) VALUES (?,?,?,?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, e := range b.Events {
		data := ""
		if len(e.Data) > 0 {
			bs, _ := json.Marshal(e.Data)
			data = string(bs)
		}
		if _, err := stmt.Exec(b.SID, e.T, e.Kind, data); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) purge(now time.Time) {
	cut := now.Add(-Retention).Unix()
	_, _ = s.db.Exec(`DELETE FROM events WHERE sid IN (SELECT sid FROM sessions WHERE last_seen < ?)`, cut)
	_, _ = s.db.Exec(`DELETE FROM sessions WHERE last_seen < ?`, cut)
}

// --- Summary (aggregate only) ------------------------------------------------

// Correlation of an outcome (late notes / stops) with a trigger group.
type Correlation struct {
	Trigger  string  `json:"trigger"`
	Outcomes int     `json:"outcomes"` // outcomes with a trigger ≤ 2 s before
	Total    int     `json:"total"`    // all outcomes
	Share    float64 `json:"share"`    // Outcomes / Total
	Coverage float64 `json:"coverage"` // fraction of play time within 2 s after a trigger
	Lift     float64 `json:"lift"`     // Share / Coverage; > 1 = clusters after the trigger
}

type Group struct {
	Platform    string         `json:"platform"`
	Engine      string         `json:"engine"`
	Sessions    int            `json:"sessions"`
	PlayMinutes float64        `json:"playMinutes"`
	Notes       int            `json:"notes"`
	LateNotes   int            `json:"lateNotes"`
	LatePerMin  float64        `json:"latePerMinute"`
	Stops       map[string]int `json:"stops"`
	Taps        int            `json:"taps"`
	VisHidden   int            `json:"visibilityHidden"`
	CtxChanges  int            `json:"ctxChanges"`
	Catchups    int            `json:"catchups"`
	VizWindows  int            `json:"vizCauseWindows"`
	// Stops because the page went hidden, split by what happened next:
	// returned = the page became visible again in the same session (an
	// interruption the user probably didn't intend — the erratic case);
	// left = it never came back (navigated away / closed). The median
	// hidden duration of returned ones under ~2 s points at a focus / tap /
	// browser-UI blip rather than the user switching apps.
	HiddenReturned int           `json:"hiddenStopsReturned"`
	HiddenLeft     int           `json:"hiddenStopsLeft"`
	HiddenBlipMs   float64       `json:"hiddenReturnedMedianMs"`
	HiddenShort    int           `json:"hiddenReturnedUnder2s"`
	LateAfter      []Correlation `json:"lateAfter"`
	StopAfter      []Correlation `json:"stopAfter"`
}

type ev struct {
	t    float64
	kind string
	data map[string]any
}

type sessionEvents struct {
	platform, engine string
	events           []ev
}

func (s *Store) loadSessions(since time.Time) (map[string]*sessionEvents, error) {
	rows, err := s.db.Query(`SELECT s.sid, s.platform, s.engine, e.t, e.kind, e.data
		FROM sessions s JOIN events e ON e.sid = s.sid WHERE s.last_seen >= ? ORDER BY s.sid, e.t`, since.Unix())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]*sessionEvents{}
	for rows.Next() {
		var sid, platform, engine, kind, data string
		var t float64
		if err := rows.Scan(&sid, &platform, &engine, &t, &kind, &data); err != nil {
			return nil, err
		}
		se := out[sid]
		if se == nil {
			se = &sessionEvents{platform: platform, engine: engine}
			out[sid] = se
		}
		e := ev{t: t, kind: kind}
		if data != "" {
			_ = json.Unmarshal([]byte(data), &e.data)
		}
		se.events = append(se.events, e)
	}
	return out, rows.Err()
}

// playIntervals derives [start, end) intervals from play/stop events; an
// unterminated play ends at the session's last event.
func playIntervals(evs []ev) [][2]float64 {
	var out [][2]float64
	start := -1.0
	for _, e := range evs {
		switch e.kind {
		case "play":
			if start < 0 {
				start = e.t
			}
		case "stop":
			if start >= 0 {
				out = append(out, [2]float64{start, e.t})
				start = -1
			}
		}
	}
	if start >= 0 && len(evs) > 0 && evs[len(evs)-1].t > start {
		out = append(out, [2]float64{start, evs[len(evs)-1].t})
	}
	return out
}

func inPlay(iv [][2]float64, t float64) bool {
	for _, p := range iv {
		if t >= p[0] && t <= p[1] {
			return true
		}
	}
	return false
}

// coveredMs: total time within [trigger, trigger+NearWindowMs) ∩ play.
func coveredMs(iv [][2]float64, triggers []float64) float64 {
	sort.Float64s(triggers)
	var total float64
	for _, p := range iv {
		var curS, curE float64 = -1, -1
		flush := func() {
			if curS >= 0 {
				s, e := math.Max(curS, p[0]), math.Min(curE, p[1])
				if e > s {
					total += e - s
				}
			}
		}
		for _, t := range triggers {
			s, e := t, t+NearWindowMs
			if curS < 0 {
				curS, curE = s, e
			} else if s <= curE {
				curE = math.Max(curE, e)
			} else {
				flush()
				curS, curE = s, e
			}
		}
		flush()
	}
	return total
}

// Summarize aggregates sessions seen since `since`, per platform × engine.
func (s *Store) Summarize(since time.Time) ([]Group, error) {
	sessions, err := s.loadSessions(since)
	if err != nil {
		return nil, err
	}
	type acc struct {
		g      Group
		playMs float64
		hidden []float64
		near   map[string]map[string]int // outcome → trigger → count
		cov    map[string]float64        // trigger → covered ms
	}
	groups := map[string]*acc{}
	for _, se := range sessions {
		key := se.platform + "/" + se.engine
		a := groups[key]
		if a == nil {
			a = &acc{g: Group{Platform: se.platform, Engine: se.engine, Stops: map[string]int{}},
				near: map[string]map[string]int{"late": {}, "stop": {}}, cov: map[string]float64{}}
			groups[key] = a
		}
		a.g.Sessions++
		iv := playIntervals(se.events)
		for _, p := range iv {
			a.playMs += p[1] - p[0]
		}
		trig := map[string][]float64{}
		for name, kinds := range triggerGroups {
			for _, e := range se.events {
				for _, k := range kinds {
					if e.kind == k {
						trig[name] = append(trig[name], e.t)
					}
				}
			}
			a.cov[name] += coveredMs(iv, append([]float64(nil), trig[name]...))
		}
		nearAny := func(t float64, name string) bool {
			for _, x := range trig[name] {
				if x <= t && t-x <= NearWindowMs {
					return true
				}
			}
			return false
		}
		for _, e := range se.events {
			switch e.kind {
			case "tap":
				a.g.Taps++
			case "vis":
				if e.data["s"] == "hidden" {
					a.g.VisHidden++
				}
			case "ctx", "sink":
				a.g.CtxChanges++
			case "catchup":
				a.g.Catchups++
			case "win":
				if n, ok := e.data["n"].(float64); ok {
					a.g.Notes += int(n)
				}
				if e.data["c"] == "visualization" {
					a.g.VizWindows++
				}
			case "late":
				if !inPlay(iv, e.t) {
					continue
				}
				a.g.LateNotes++
				for name := range triggerGroups {
					// A tap that *is* the cause shows up before the late
					// note; exclude the note's own trigger kind if equal.
					if nearAny(e.t, name) {
						a.near["late"][name]++
					}
				}
			case "stop":
				reason, _ := e.data["r"].(string)
				if reason == "" {
					reason = "unknown"
				}
				a.g.Stops[reason]++
				if reason == "hidden" {
					back := -1.0
					for _, f := range se.events {
						if f.t > e.t && f.kind == "vis" && f.data["s"] == "visible" {
							back = f.t
							break
						}
					}
					if back >= 0 {
						a.g.HiddenReturned++
						a.hidden = append(a.hidden, back-e.t)
						if back-e.t < NearWindowMs {
							a.g.HiddenShort++
						}
					} else {
						a.g.HiddenLeft++
					}
				}
				for name := range triggerGroups {
					if name == "tap" && reason == "user" {
						continue // a user stop is a tap by definition
					}
					if nearAny(e.t, name) {
						a.near["stop"][name]++
					}
				}
			}
		}
	}
	names := make([]string, 0, len(triggerGroups))
	for n := range triggerGroups {
		names = append(names, n)
	}
	sort.Strings(names)
	out := make([]Group, 0, len(groups))
	for _, a := range groups {
		a.g.PlayMinutes = math.Round(a.playMs/600) / 100
		if n := len(a.hidden); n > 0 {
			sort.Float64s(a.hidden)
			a.g.HiddenBlipMs = math.Round(a.hidden[n/2])
		}
		if a.playMs > 0 {
			a.g.LatePerMin = math.Round(float64(a.g.LateNotes)/(a.playMs/60000)*100) / 100
		}
		stopTotal := 0
		for r, n := range a.g.Stops {
			if r != "user" {
				stopTotal += n
			}
		}
		for _, n := range names {
			cov := 0.0
			if a.playMs > 0 {
				cov = a.cov[n] / a.playMs
			}
			mk := func(near, total int) Correlation {
				c := Correlation{Trigger: n, Outcomes: near, Total: total, Coverage: round3(cov)}
				if total > 0 {
					c.Share = round3(float64(near) / float64(total))
					if cov > 0 {
						c.Lift = round3(c.Share / cov)
					}
				}
				return c
			}
			a.g.LateAfter = append(a.g.LateAfter, mk(a.near["late"][n], a.g.LateNotes))
			a.g.StopAfter = append(a.g.StopAfter, mk(a.near["stop"][n], stopTotal))
		}
		out = append(out, a.g)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Platform != out[j].Platform {
			return out[i].Platform < out[j].Platform
		}
		return out[i].Engine < out[j].Engine
	})
	return out, nil
}

func round3(x float64) float64 { return math.Round(x*1000) / 1000 }

// RawSession returns a session's events (secret-gated by the handler).
func (s *Store) RawSession(sid string) (map[string]any, error) {
	if !sidPattern.MatchString(sid) {
		return nil, errors.New("bad sid")
	}
	row := s.db.QueryRow(`SELECT first_seen, last_seen, engine, platform, model, ua, batches FROM sessions WHERE sid = ?`, sid)
	var first, last int64
	var engine, platform, model, ua string
	var batches int
	if err := row.Scan(&first, &last, &engine, &platform, &model, &ua, &batches); err != nil {
		return nil, err
	}
	rows, err := s.db.Query(`SELECT t, kind, data FROM events WHERE sid = ? ORDER BY t`, sid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var events []Event
	for rows.Next() {
		var e Event
		var data string
		if err := rows.Scan(&e.T, &e.Kind, &data); err != nil {
			return nil, err
		}
		if data != "" {
			_ = json.Unmarshal([]byte(data), &e.Data)
		}
		events = append(events, e)
	}
	return map[string]any{"sid": sid, "firstSeen": time.Unix(first, 0).UTC(), "lastSeen": time.Unix(last, 0).UTC(),
		"engine": engine, "platform": platform, "model": model, "ua": ua, "batches": batches, "events": events}, rows.Err()
}

// RecentSessions lists recent session ids with headline counts (secret-gated).
func (s *Store) RecentSessions(limit int) ([]map[string]any, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	rows, err := s.db.Query(`SELECT s.sid, s.last_seen, s.platform, s.engine, s.model,
		(SELECT COUNT(*) FROM events e WHERE e.sid = s.sid AND e.kind = 'late'),
		(SELECT COUNT(*) FROM events e WHERE e.sid = s.sid AND e.kind = 'stop')
		FROM sessions s ORDER BY s.last_seen DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var sid, platform, engine, model string
		var last int64
		var late, stops int
		if err := rows.Scan(&sid, &last, &platform, &engine, &model, &late, &stops); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"sid": sid, "lastSeen": time.Unix(last, 0).UTC(), "platform": platform,
			"engine": engine, "model": model, "late": late, "stops": stops})
	}
	return out, rows.Err()
}

// --- HTTP ------------------------------------------------------------------

// Limiter: per-IP token buckets held in memory only (IPs never stored).
type Limiter struct {
	mu     sync.Mutex
	perIP  map[string]int
	global int
	window time.Time
	PerMin int
	Global int
}

func NewLimiter(perMin, global int) *Limiter {
	return &Limiter{perIP: map[string]int{}, PerMin: perMin, Global: global}
}

func (l *Limiter) Allow(ip string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.window) >= time.Minute {
		l.window = now
		l.perIP = map[string]int{}
		l.global = 0
	}
	if l.perIP[ip] >= l.PerMin || l.global >= l.Global {
		return false
	}
	l.perIP[ip]++
	l.global++
	return true
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.IndexByte(xff, ','); i >= 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	if v := r.Header.Get("X-Real-IP"); v != "" {
		return v
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// Handler serves /api/telemetry (POST a batch) and
// /api/telemetry/summary?days=N (GET, public, aggregate-only),
// /api/telemetry/sessions and /api/telemetry/session/{sid} (GET,
// X-Rebuild-Secret).
func Handler(s *Store, lim *Limiter, secret string, now func() time.Time) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/api/telemetry")
		switch {
		case path == "" || path == "/":
			if r.Method != http.MethodPost {
				http.Error(w, "POST only", http.StatusMethodNotAllowed)
				return
			}
			if lim != nil && !lim.Allow(clientIP(r), now()) {
				w.Header().Set("Retry-After", "60")
				http.Error(w, "rate limited", http.StatusTooManyRequests)
				return
			}
			var b Batch
			dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, MaxBody))
			dec.DisallowUnknownFields()
			if err := dec.Decode(&b); err != nil {
				http.Error(w, "bad json: "+err.Error(), http.StatusBadRequest)
				return
			}
			if err := s.Insert(&b, now()); err != nil {
				if errors.Is(err, ErrFull) {
					http.Error(w, err.Error(), http.StatusInsufficientStorage)
					return
				}
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		case path == "/summary":
			days, _ := strconv.Atoi(r.URL.Query().Get("days"))
			if days <= 0 || days > 30 {
				days = 7
			}
			groups, err := s.Summarize(now().Add(-time.Duration(days) * 24 * time.Hour))
			if err != nil {
				http.Error(w, "summary failed", http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "public, max-age=60")
			_ = json.NewEncoder(w).Encode(map[string]any{"days": days, "nearWindowMs": NearWindowMs, "groups": groups})
		case path == "/sessions" || strings.HasPrefix(path, "/session/"):
			if secret == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Rebuild-Secret")), []byte(secret)) != 1 {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			var v any
			var err error
			if path == "/sessions" {
				limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
				v, err = s.RecentSessions(limit)
			} else {
				v, err = s.RawSession(strings.TrimPrefix(path, "/session/"))
			}
			if err != nil {
				http.Error(w, err.Error(), http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(v)
		default:
			http.NotFound(w, r)
		}
	}
}

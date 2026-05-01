// Package index is the SQLite projection of audio-rendered tracks.
// One row per CID that has a successful .webm in the audio cache.
// The canonical bytes still live on disk in the share store; this is
// just a queryable index for "feed" and "latest" surfaces.
package index

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schemaSQL string

// DB wraps the SQLite connection for the tracks index.
type DB struct{ sql *sql.DB }

// Open opens (and creates if missing) the index DB at path.
func Open(path string) (*DB, error) {
	s, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	if _, err := s.Exec(schemaSQL); err != nil {
		s.Close()
		return nil, fmt.Errorf("index: apply schema: %w", err)
	}
	// Idempotent ALTER-TABLE migrations for columns added after the
	// initial schema. SQLite's CREATE TABLE IF NOT EXISTS doesn't add
	// columns to a pre-existing table, so each new column needs an
	// explicit add. Failures swallowed — "duplicate column" is normal
	// on every startup after the first.
	for _, alter := range []string{
		`ALTER TABLE tracks ADD COLUMN source         TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE tracks ADD COLUMN signer_type    TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE tracks ADD COLUMN signer_address TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE tracks ADD COLUMN content_type   TEXT NOT NULL DEFAULT 'BeatsShare'`,
	} {
		_, _ = s.Exec(alter)
	}
	return &DB{sql: s}, nil
}

func (d *DB) Close() error { return d.sql.Close() }

// Ping verifies the SQLite connection is reachable. Used by /readyz.
func (d *DB) Ping(ctx context.Context) error { return d.sql.PingContext(ctx) }

// payload mirrors the indexed fields of share.sharePayload. Duplicated
// rather than imported to keep the package decoupled — the schema is
// the contract, not the Go type.
type payload struct {
	Genre     string `json:"genre"`
	Name      string `json:"name,omitempty"`
	Seed      int64  `json:"seed"`
	Tempo     int    `json:"tempo"`
	Swing     int    `json:"swing"`
	Humanize  int    `json:"humanize"`
	RootNote  *int   `json:"rootNote,omitempty"`
	ScaleName string `json:"scaleName,omitempty"`
	Bars      int    `json:"bars,omitempty"`
	Structure string `json:"structure,omitempty"`
	Source    string `json:"source,omitempty"`
	Signer    *struct {
		Type    string `json:"type"`
		Address string `json:"address"`
	} `json:"signer,omitempty"`
}

// RecordRender upserts the index row for cid using the current time
// as rendered_at. Re-renders bump rendered_at and bytes so re-listened
// tracks resurface in the feed. Bad payload bytes are reported as an
// error; callers should log and continue (the audio file itself is
// already on disk).
func (d *DB) RecordRender(cid string, payloadBytes []byte, bytes int64) error {
	return d.RecordRenderAt(cid, payloadBytes, bytes, time.Now().UnixMilli())
}

// RecordRenderAt is the explicit-timestamp variant. The backfill path
// passes the file's mtime so reconstructed rows preserve the original
// render order rather than collapsing to "all rendered at boot time".
func (d *DB) RecordRenderAt(cid string, payloadBytes []byte, bytes, renderedAt int64) error {
	var p payload
	if err := json.Unmarshal(payloadBytes, &p); err != nil {
		return fmt.Errorf("index: parse payload: %w", err)
	}
	signerType, signerAddress := "", ""
	if p.Signer != nil {
		signerType = p.Signer.Type
		signerAddress = p.Signer.Address
	}
	_, err := d.sql.Exec(
		`INSERT INTO tracks
		    (cid, genre, name, seed, tempo, swing, humanize,
		     root_note, scale_name, bars, structure, rendered_at, bytes,
		     source, signer_type, signer_address)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(cid) DO UPDATE SET
		    rendered_at    = excluded.rendered_at,
		    bytes          = excluded.bytes,
		    source         = excluded.source,
		    signer_type    = excluded.signer_type,
		    signer_address = excluded.signer_address`,
		cid, p.Genre, p.Name, p.Seed, p.Tempo, p.Swing, p.Humanize,
		nullableInt(p.RootNote), p.ScaleName, p.Bars, p.Structure, renderedAt, bytes,
		p.Source, signerType, signerAddress,
	)
	if err != nil {
		return fmt.Errorf("index: insert: %w", err)
	}
	return nil
}

// Latest returns the CID with the most-recent rendered_at, or "" if
// the index is empty. Replaces the mtime walk in audiorender.LatestCID.
func (d *DB) Latest() (string, error) {
	var cid string
	err := d.sql.QueryRow(
		`SELECT cid FROM tracks ORDER BY rendered_at DESC LIMIT 1`,
	).Scan(&cid)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("index: latest: %w", err)
	}
	return cid, nil
}

// FeedQuery describes a single page request against the tracks index.
type FeedQuery struct {
	Genre  string // "" matches all
	Signer string // signer_address, "" matches all. Sentinel values:
	//   "official" → matches source='official'
	//   "signed"   → matches any non-empty signer_address
	//   "anonymous"→ matches rows with both source='' AND signer=''
	Before int64 // unix ms cursor; 0 = newest
	Limit  int   // clamped to [1, 100]; 0 → 20
}

// Track is the JSON shape returned to feed clients.
type Track struct {
	CID           string `json:"cid"`
	Name          string `json:"name,omitempty"`
	Genre         string `json:"genre,omitempty"`
	Tempo         int    `json:"tempo,omitempty"`
	Seed          int64  `json:"seed"`
	Structure     string `json:"structure,omitempty"`
	RenderedAt    int64  `json:"renderedAt"`
	Source        string `json:"source,omitempty"`
	SignerType    string `json:"signerType,omitempty"`
	SignerAddress string `json:"signerAddress,omitempty"`
}

// DeleteTrack removes the row for cid from the rendered-track index
// and any pending rebuild_queue row. Idempotent. Caller handles auth
// and the on-disk cleanup of the .webm cache.
func (d *DB) DeleteTrack(cid string) error {
	if _, err := d.sql.Exec(`DELETE FROM tracks WHERE cid = ?`, cid); err != nil {
		return fmt.Errorf("index: delete track: %w", err)
	}
	if _, err := d.sql.Exec(`DELETE FROM rebuild_queue WHERE cid = ?`, cid); err != nil {
		return fmt.Errorf("index: delete rebuild_queue row: %w", err)
	}
	return nil
}

// HasCIDs returns a set of every rendered-track CID currently in the
// index. Used by the archive endpoint to compute the share-store
// minus rendered-audio diff. The index is small (~one row per render,
// tens of MB even at 100k tracks) so an in-memory map is fine.
func (d *DB) HasCIDs() (map[string]struct{}, error) {
	rows, err := d.sql.Query(`SELECT cid FROM tracks`)
	if err != nil {
		return nil, fmt.Errorf("index: hascids query: %w", err)
	}
	defer rows.Close()
	out := map[string]struct{}{}
	for rows.Next() {
		var cid string
		if err := rows.Scan(&cid); err != nil {
			return nil, fmt.Errorf("index: hascids scan: %w", err)
		}
		out[cid] = struct{}{}
	}
	return out, rows.Err()
}

// Feed returns a page of tracks sorted by rendered_at DESC, optionally
// filtered by genre and bounded above by the Before cursor (exclusive).
func (d *DB) Feed(q FeedQuery) ([]Track, error) {
	limit := q.Limit
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	args := []any{}
	where := "WHERE 1=1"
	if q.Genre != "" {
		where += " AND genre = ?"
		args = append(args, q.Genre)
	}
	switch q.Signer {
	case "":
		// no filter
	case "official":
		where += " AND source = 'official'"
	case "signed":
		where += " AND signer_address != ''"
	case "anonymous":
		where += " AND signer_address = '' AND source = ''"
	default:
		// Literal address match — case-insensitive comparison so eth
		// addresses round-trip regardless of checksumming style.
		where += " AND lower(signer_address) = lower(?)"
		args = append(args, q.Signer)
	}
	if q.Before > 0 {
		where += " AND rendered_at < ?"
		args = append(args, q.Before)
	}
	args = append(args, limit)
	rows, err := d.sql.Query(
		`SELECT cid, name, genre, tempo, seed, structure, rendered_at,
		        source, signer_type, signer_address
		   FROM tracks `+where+`
		   ORDER BY rendered_at DESC
		   LIMIT ?`,
		args...,
	)
	if err != nil {
		return nil, fmt.Errorf("index: feed query: %w", err)
	}
	defer rows.Close()
	out := []Track{}
	for rows.Next() {
		var t Track
		if err := rows.Scan(
			&t.CID, &t.Name, &t.Genre, &t.Tempo, &t.Seed, &t.Structure, &t.RenderedAt,
			&t.Source, &t.SignerType, &t.SignerAddress,
		); err != nil {
			return nil, fmt.Errorf("index: feed scan: %w", err)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// nullableInt converts a *int to a nullable int for INSERT — sqlite
// driver writes NULL for nil-pointer args via sql.NullInt64.
func nullableInt(p *int) any {
	if p == nil {
		return nil
	}
	return int64(*p)
}

// MarkRebuild adds cid to the rebuild queue (no-op if already present).
// markedBy is a free-form attribution tag (currently the requester's IP
// hash so per-IP rate limiting can be approximated without storing PII).
func (d *DB) MarkRebuild(cid, markedBy string) error {
	_, err := d.sql.Exec(
		`INSERT INTO rebuild_queue (cid, marked_at, marked_by)
		 VALUES (?, ?, ?)
		 ON CONFLICT(cid) DO NOTHING`,
		cid, time.Now().UnixMilli(), markedBy,
	)
	if err != nil {
		return fmt.Errorf("index: mark rebuild: %w", err)
	}
	return nil
}

// RebuildQueue returns up to limit pending CIDs in marked_at order.
// Workers should claim by calling ClearRebuild after a successful
// re-render+upload — there's no two-phase claim, so two workers running
// concurrently can race on the same CID (acceptable: prod's audio
// PUT is idempotent within the seal window).
func (d *DB) RebuildQueue(limit int) ([]string, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := d.sql.Query(
		`SELECT cid FROM rebuild_queue ORDER BY marked_at LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("index: rebuild queue: %w", err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var cid string
		if err := rows.Scan(&cid); err != nil {
			return nil, err
		}
		out = append(out, cid)
	}
	return out, rows.Err()
}

// ClearRebuild removes a CID from the rebuild queue. Workers call this
// after a successful re-render+upload.
func (d *DB) ClearRebuild(cid string) error {
	_, err := d.sql.Exec(`DELETE FROM rebuild_queue WHERE cid = ?`, cid)
	if err != nil {
		return fmt.Errorf("index: clear rebuild: %w", err)
	}
	return nil
}

// IsMarkedForRebuild returns true if cid is currently in the queue.
func (d *DB) IsMarkedForRebuild(cid string) (bool, error) {
	var n int
	err := d.sql.QueryRow(
		`SELECT 1 FROM rebuild_queue WHERE cid = ?`, cid).Scan(&n)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}

// MarkComposition adds cid to the composition_queue (no-op if already
// present). markedBy is a free-form attribution tag — the seal-on-PUT
// auto-enqueue path passes the requester's IP hash. Mirrors MarkRebuild
// for the .webm rebuild flow.
func (d *DB) MarkComposition(cid, markedBy string) error {
	_, err := d.sql.Exec(
		`INSERT INTO composition_queue (cid, marked_at, marked_by)
		 VALUES (?, ?, ?)
		 ON CONFLICT(cid) DO NOTHING`,
		cid, time.Now().UnixMilli(), markedBy,
	)
	if err != nil {
		return fmt.Errorf("index: mark composition: %w", err)
	}
	return nil
}

// CompositionQueue returns up to limit pending CIDs in marked_at order.
// Workers clear via ClearComposition after a successful render. Same
// no-claim model as RebuildQueue; concurrent worker races settle on
// the master uploads (OverwriteMaster is idempotent within a CID+ext).
func (d *DB) CompositionQueue(limit int) ([]string, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := d.sql.Query(
		`SELECT cid FROM composition_queue ORDER BY marked_at LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("index: composition queue: %w", err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var cid string
		if err := rows.Scan(&cid); err != nil {
			return nil, err
		}
		out = append(out, cid)
	}
	return out, rows.Err()
}

// ClearComposition removes a CID from the composition_queue. Workers
// call this after a successful render+upload.
func (d *DB) ClearComposition(cid string) error {
	_, err := d.sql.Exec(`DELETE FROM composition_queue WHERE cid = ?`, cid)
	if err != nil {
		return fmt.Errorf("index: clear composition: %w", err)
	}
	return nil
}

// IsMarkedForComposition returns true if cid is currently in the
// composition queue.
func (d *DB) IsMarkedForComposition(cid string) (bool, error) {
	var n int
	err := d.sql.QueryRow(
		`SELECT 1 FROM composition_queue WHERE cid = ?`, cid).Scan(&n)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}

// Analysis is the JSON-LD-shaped audio analysis row for a CID.
// Mirrors public/schema/beats-audio-analysis.schema.json — every
// optional float is a *float64 so omitted measurements distinguish
// from "measured as zero". Also mirrors the JS Tone.js default 44.1k
// sample rate the analyzer assumes.
type Analysis struct {
	CID             string   `json:"cid"`
	AnalyzerVersion string   `json:"analyzerVersion,omitempty"`
	AnalyzedAt      int64    `json:"analyzedAt"`
	Source          string   `json:"source,omitempty"`
	DurationS       *float64 `json:"durationS,omitempty"`
	LUFS            *float64 `json:"lufs,omitempty"`
	TruePeakDb      *float64 `json:"truePeakDb,omitempty"`
	Peak            *float64 `json:"peak,omitempty"`
	RMS             *float64 `json:"rms,omitempty"`
	CrestDb         *float64 `json:"crestDb,omitempty"`
	CentroidHz      *float64 `json:"centroidHz,omitempty"`
	Rolloff85Hz     *float64 `json:"rolloff85Hz,omitempty"`
	OnsetRate       *float64 `json:"onsetRate,omitempty"`
	BPM             *float64 `json:"bpm,omitempty"`
	BandSub         *float64 `json:"bandSub,omitempty"`
	BandLow         *float64 `json:"bandLow,omitempty"`
	BandLomid       *float64 `json:"bandLomid,omitempty"`
	BandHimid       *float64 `json:"bandHimid,omitempty"`
	BandHigh        *float64 `json:"bandHigh,omitempty"`
	HpfHz           *float64 `json:"hpfHz,omitempty"`
}

// UpsertAnalysis writes a row, overwriting any prior. The renderer
// calls this with source='loudnorm' (lufs only); the off-host
// analyzer worker calls it with source='analyzer' (full spectral)
// or source='merged' (preserving the loudnorm LUFS while filling in
// spectral fields). Caller controls merge semantics.
func (d *DB) UpsertAnalysis(a Analysis) error {
	if a.AnalyzedAt == 0 {
		a.AnalyzedAt = time.Now().UnixMilli()
	}
	_, err := d.sql.Exec(
		`INSERT INTO track_analysis
		   (cid, analyzer_version, analyzed_at, source,
		    duration_s, lufs, true_peak_db, peak, rms, crest_db,
		    centroid_hz, rolloff85_hz, onset_rate, bpm,
		    band_sub, band_low, band_lomid, band_himid, band_high, hpf_hz)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(cid) DO UPDATE SET
		   analyzer_version = excluded.analyzer_version,
		   analyzed_at      = excluded.analyzed_at,
		   source           = excluded.source,
		   duration_s       = COALESCE(excluded.duration_s,   track_analysis.duration_s),
		   lufs             = COALESCE(excluded.lufs,         track_analysis.lufs),
		   true_peak_db     = COALESCE(excluded.true_peak_db, track_analysis.true_peak_db),
		   peak             = COALESCE(excluded.peak,         track_analysis.peak),
		   rms              = COALESCE(excluded.rms,          track_analysis.rms),
		   crest_db         = COALESCE(excluded.crest_db,     track_analysis.crest_db),
		   centroid_hz      = COALESCE(excluded.centroid_hz,  track_analysis.centroid_hz),
		   rolloff85_hz     = COALESCE(excluded.rolloff85_hz, track_analysis.rolloff85_hz),
		   onset_rate       = COALESCE(excluded.onset_rate,   track_analysis.onset_rate),
		   bpm              = COALESCE(excluded.bpm,          track_analysis.bpm),
		   band_sub         = COALESCE(excluded.band_sub,     track_analysis.band_sub),
		   band_low         = COALESCE(excluded.band_low,     track_analysis.band_low),
		   band_lomid       = COALESCE(excluded.band_lomid,   track_analysis.band_lomid),
		   band_himid       = COALESCE(excluded.band_himid,   track_analysis.band_himid),
		   band_high        = COALESCE(excluded.band_high,    track_analysis.band_high),
		   hpf_hz           = COALESCE(excluded.hpf_hz,       track_analysis.hpf_hz)`,
		a.CID, a.AnalyzerVersion, a.AnalyzedAt, a.Source,
		nullableFloat(a.DurationS), nullableFloat(a.LUFS),
		nullableFloat(a.TruePeakDb), nullableFloat(a.Peak),
		nullableFloat(a.RMS), nullableFloat(a.CrestDb),
		nullableFloat(a.CentroidHz), nullableFloat(a.Rolloff85Hz),
		nullableFloat(a.OnsetRate), nullableFloat(a.BPM),
		nullableFloat(a.BandSub), nullableFloat(a.BandLow),
		nullableFloat(a.BandLomid), nullableFloat(a.BandHimid),
		nullableFloat(a.BandHigh), nullableFloat(a.HpfHz),
	)
	if err != nil {
		return fmt.Errorf("index: upsert analysis: %w", err)
	}
	return nil
}

// GetAnalysis loads the row for cid, or returns (nil, nil) if absent.
func (d *DB) GetAnalysis(cid string) (*Analysis, error) {
	var a Analysis
	a.CID = cid
	var (
		durS, lufs, tpDb, peak, rms, crest, cent, roll, onset, bpm sql.NullFloat64
		bSub, bLow, bLomid, bHimid, bHigh, hpf                     sql.NullFloat64
	)
	err := d.sql.QueryRow(
		`SELECT analyzer_version, analyzed_at, source,
		        duration_s, lufs, true_peak_db, peak, rms, crest_db,
		        centroid_hz, rolloff85_hz, onset_rate, bpm,
		        band_sub, band_low, band_lomid, band_himid, band_high, hpf_hz
		   FROM track_analysis WHERE cid = ?`, cid,
	).Scan(
		&a.AnalyzerVersion, &a.AnalyzedAt, &a.Source,
		&durS, &lufs, &tpDb, &peak, &rms, &crest,
		&cent, &roll, &onset, &bpm,
		&bSub, &bLow, &bLomid, &bHimid, &bHigh, &hpf,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("index: get analysis: %w", err)
	}
	a.DurationS = nullToPtr(durS)
	a.LUFS = nullToPtr(lufs)
	a.TruePeakDb = nullToPtr(tpDb)
	a.Peak = nullToPtr(peak)
	a.RMS = nullToPtr(rms)
	a.CrestDb = nullToPtr(crest)
	a.CentroidHz = nullToPtr(cent)
	a.Rolloff85Hz = nullToPtr(roll)
	a.OnsetRate = nullToPtr(onset)
	a.BPM = nullToPtr(bpm)
	a.BandSub = nullToPtr(bSub)
	a.BandLow = nullToPtr(bLow)
	a.BandLomid = nullToPtr(bLomid)
	a.BandHimid = nullToPtr(bHimid)
	a.BandHigh = nullToPtr(bHigh)
	a.HpfHz = nullToPtr(hpf)
	return &a, nil
}

// DeleteAnalysis removes the analysis row for cid. Idempotent; called
// from the cascade in /api/archive-delete.
func (d *DB) DeleteAnalysis(cid string) error {
	_, err := d.sql.Exec(`DELETE FROM track_analysis WHERE cid = ?`, cid)
	if err != nil {
		return fmt.Errorf("index: delete analysis: %w", err)
	}
	return nil
}

func nullableFloat(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}

func nullToPtr(n sql.NullFloat64) *float64 {
	if !n.Valid {
		return nil
	}
	v := n.Float64
	return &v
}

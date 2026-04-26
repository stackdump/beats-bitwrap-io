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
	_, err := d.sql.Exec(
		`INSERT INTO tracks
		    (cid, genre, name, seed, tempo, swing, humanize,
		     root_note, scale_name, bars, structure, rendered_at, bytes)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(cid) DO UPDATE SET
		    rendered_at = excluded.rendered_at,
		    bytes       = excluded.bytes`,
		cid, p.Genre, p.Name, p.Seed, p.Tempo, p.Swing, p.Humanize,
		nullableInt(p.RootNote), p.ScaleName, p.Bars, p.Structure, renderedAt, bytes,
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
	Before int64  // unix ms cursor; 0 = newest
	Limit  int    // clamped to [1, 100]; 0 → 20
}

// Track is the JSON shape returned to feed clients.
type Track struct {
	CID        string `json:"cid"`
	Name       string `json:"name,omitempty"`
	Genre      string `json:"genre,omitempty"`
	Tempo      int    `json:"tempo,omitempty"`
	Seed       int64  `json:"seed"`
	Structure  string `json:"structure,omitempty"`
	RenderedAt int64  `json:"renderedAt"`
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
	if q.Before > 0 {
		where += " AND rendered_at < ?"
		args = append(args, q.Before)
	}
	args = append(args, limit)
	rows, err := d.sql.Query(
		`SELECT cid, name, genre, tempo, seed, structure, rendered_at
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

package audiorender

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// IngredientOpts captures every per-track operation that turns a
// BeatsShare ingredient render into a distinct cached variant. Two
// ingredient render requests with byte-identical IngredientOpts share
// a cache slot; any difference produces a separate `{cid}-{hash}.webm`.
//
// Field naming + JSON tag order are stable — the hash is derived from
// canonical JSON, so renaming or reordering would invalidate every
// existing variant on disk. Keep additions append-only.
type IngredientOpts struct {
	SoloRoles []string `json:"soloRoles,omitempty"`
	Mute      []string `json:"mute,omitempty"`
	Transpose int      `json:"transpose,omitempty"`
	TempoMatch string  `json:"tempoMatch,omitempty"`
	SourceBPM int      `json:"sourceBpm,omitempty"`
	MasterBPM int      `json:"masterBpm,omitempty"`
}

// IsZero reports whether every field is at the zero value, in which
// case the bare-CID cache path is used (no -hash suffix). Lets the
// hot path stay cheap for compositions whose tracks don't use any
// per-track ops.
func (o IngredientOpts) IsZero() bool {
	return len(o.SoloRoles) == 0 && len(o.Mute) == 0 &&
		o.Transpose == 0 && o.TempoMatch == "" &&
		o.SourceBPM == 0 && o.MasterBPM == 0
}

// HashIngredientOpts returns a 12-char hex prefix of SHA-256 over
// canonicalized opts. Order of soloRoles / mute is normalised so
// `["drums","bass"]` and `["bass","drums"]` collide on the same cache
// entry. Empty opts (zero value) returns "" so callers fall back to
// the bare-CID path. 12 chars = 48 bits ≈ collision-free across any
// realistic cache size.
func HashIngredientOpts(o IngredientOpts) string {
	// Normalise first: "none" carries no information, so a track with
	// all-defaults still hashes to "" (bare-CID path) regardless of
	// whether the author wrote tempoMatch="none" explicitly.
	if strings.EqualFold(o.TempoMatch, "none") {
		o.TempoMatch = ""
	}
	if len(o.SoloRoles) > 0 {
		o.SoloRoles = sortedCopy(o.SoloRoles)
	}
	if len(o.Mute) > 0 {
		o.Mute = sortedCopy(o.Mute)
	}
	if o.IsZero() {
		return ""
	}
	body, _ := json.Marshal(o)
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:6])
}

// sortedCopy returns a sorted copy of in (does not mutate). Used by
// HashIngredientOpts so reordering soloRoles / mute in the source
// envelope doesn't change the cache key.
func sortedCopy(in []string) []string {
	out := make([]string, len(in))
	copy(out, in)
	sort.Strings(out)
	return out
}

// evictIfOverCap walks the cache dir and deletes the oldest-mtime files
// until total bytes <= MaxBytes. No-op when MaxBytes <= 0.
func (r *Renderer) evictIfOverCap() {
	if r.cfg.MaxBytes <= 0 {
		return
	}
	type entry struct {
		path string
		size int64
		mod  int64
	}
	var entries []entry
	var total int64
	_ = filepath.Walk(r.cfg.CacheDir, func(p string, info os.FileInfo, err error) error {
		if err != nil || info == nil || info.IsDir() {
			return nil
		}
		if filepath.Ext(p) != ".webm" {
			return nil
		}
		entries = append(entries, entry{p, info.Size(), info.ModTime().UnixNano()})
		total += info.Size()
		return nil
	})
	if total <= r.cfg.MaxBytes {
		return
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].mod < entries[j].mod })
	for _, e := range entries {
		if total <= r.cfg.MaxBytes {
			return
		}
		if err := os.Remove(e.path); err == nil {
			total -= e.size
		}
	}
}

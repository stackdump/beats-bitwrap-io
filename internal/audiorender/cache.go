package audiorender

import (
	"os"
	"path/filepath"
	"sort"
)

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

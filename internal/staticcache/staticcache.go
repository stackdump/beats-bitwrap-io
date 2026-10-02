// Package staticcache sets caching headers on the embedded public/ files so
// a deploy reaches browsers immediately.
//
// The embedded FS has no modification times, so http.FileServer sends no
// Last-Modified, no ETag and no Cache-Control. Browsers then may reuse a
// stale copy without asking — observed on Chrome Android, where a restored
// tab ran pre-deploy code (old worker, no new modules) without a single
// request reaching the server. With this wrapper:
//
//   - documents (*.html, directory indexes, and anything that isn't a file
//     in the FS, e.g. /feed rewritten to feed.html) get Cache-Control:
//     no-store, so a restored or revisited tab fetches the page fresh;
//   - every other file gets Cache-Control: no-cache plus a strong ETag
//     (sha256 of its bytes, computed once per path), so browsers revalidate
//     on every use and unchanged files cost a 304, not a download.
package staticcache

import (
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"sync"
)

type handler struct {
	fsys  fs.FS
	next  http.Handler
	etags sync.Map // path → `"<hash>"` or "" for non-files
}

// Wrap returns next with caching headers for files served from fsys.
func Wrap(fsys fs.FS, next http.Handler) http.Handler {
	return &handler{fsys: fsys, next: next}
}

func (h *handler) etag(name string) string {
	if v, ok := h.etags.Load(name); ok {
		return v.(string)
	}
	tag := ""
	if b, err := fs.ReadFile(h.fsys, name); err == nil {
		sum := sha256.Sum256(b)
		tag = `"` + hex.EncodeToString(sum[:12]) + `"`
	}
	h.etags.Store(name, tag)
	return tag
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p := path.Clean("/" + r.URL.Path)
	name := strings.TrimPrefix(p, "/")
	if name == "" || strings.HasSuffix(r.URL.Path, "/") {
		name = path.Join(name, "index.html")
	}
	tag := ""
	if st, err := fs.Stat(h.fsys, name); err == nil && st.IsDir() {
		name = path.Join(name, "index.html")
	}
	if !strings.HasSuffix(name, ".html") {
		tag = h.etag(name)
	}
	if tag == "" {
		// A document, or not a plain file (FileServer will 404 or a route
		// rewrote the path): never let it be reused stale.
		w.Header().Set("Cache-Control", "no-store")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("ETag", tag) // FileServer answers If-None-Match with 304
	}
	h.next.ServeHTTP(w, r)
}

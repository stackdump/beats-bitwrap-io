package main

// In-memory ephemeral store for counterMelody note payloads.
// The Go side of render-insert builds a list of (tick, note, velocity)
// events from the source share's pflow simulator, POSTs them here
// (gated by X-Rebuild-Secret), and gets back an opaque ID. chromedp
// then navigates to /?insert=counterMelody&notesId={id} where the
// page-side insert-render.js fetches the notes and runs Tone.Offline.
//
// Entries TTL out after 5 minutes — long enough for chromedp to
// spawn + load the page + run the offline render, short enough that
// a leak doesn't pile up on the host. Caller's POST hash is the ID,
// so re-POSTing the same notes doesn't multiply storage.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"sync"
	"time"
)

const insertNotesTTL = 5 * time.Minute

type insertNotesStore struct {
	mu      sync.Mutex
	entries map[string]*insertNotesEntry
}

type insertNotesEntry struct {
	body      []byte
	expiresAt time.Time
}

var globalInsertNotes = &insertNotesStore{entries: map[string]*insertNotesEntry{}}

// gc walks the map and drops expired entries. Cheap; called at the
// top of every PUT and GET so the map can't grow unboundedly.
func (s *insertNotesStore) gc() {
	now := time.Now()
	for id, e := range s.entries {
		if now.After(e.expiresAt) {
			delete(s.entries, id)
		}
	}
}

func insertNotesHandler(rebuildSecret string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		// Two shapes:
		//   POST /api/insert-notes        — stash, returns {id}
		//   GET  /api/insert-notes/{id}   — retrieve
		switch {
		case r.Method == http.MethodPost && (path == "/api/insert-notes" || path == "/api/insert-notes/"):
			if !constantTimeEq(r.Header.Get("X-Rebuild-Secret"), rebuildSecret) {
				http.Error(w, "X-Rebuild-Secret required", http.StatusForbidden)
				return
			}
			body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4*1024*1024))
			if err != nil {
				http.Error(w, "body too large or unreadable", http.StatusRequestEntityTooLarge)
				return
			}
			sum := sha256.Sum256(body)
			id := hex.EncodeToString(sum[:8])
			globalInsertNotes.mu.Lock()
			globalInsertNotes.gc()
			globalInsertNotes.entries[id] = &insertNotesEntry{
				body:      body,
				expiresAt: time.Now().Add(insertNotesTTL),
			}
			globalInsertNotes.mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]string{"id": id})
			return
		case r.Method == http.MethodGet:
			id := path[len("/api/insert-notes/"):]
			if id == "" {
				http.Error(w, "missing id", http.StatusBadRequest)
				return
			}
			globalInsertNotes.mu.Lock()
			globalInsertNotes.gc()
			e := globalInsertNotes.entries[id]
			globalInsertNotes.mu.Unlock()
			if e == nil {
				http.Error(w, "not found or expired", http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write(e.body)
			return
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
}

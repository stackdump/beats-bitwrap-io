package main

// /set/{cid}.jsonld — a BeatsComposition described as a set, in BeatScript's JSON-LD terms.
//
// BeatScript is the authority for the vocabulary (internal/beatscript); this is the one place beats applies it to
// a set. The composition envelope at /c/{cid} is untouched (its CID hashes those bytes); this is a second, derived
// view of it, the way /composition-card/ is. Tracks come out in order, each as the CID it resolves to.

import (
	"encoding/json"
	"net/http"
	"strings"

	"beats-bitwrap-io/internal/beatscript"
	"beats-bitwrap-io/internal/share"
)

func setDescriptionHandler(compositionStore *share.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cid := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/set/"), ".jsonld")
		if !compositionCardCIDPattern.MatchString(cid) {
			http.Error(w, "invalid cid", http.StatusBadRequest)
			return
		}
		body, err := compositionStore.Lookup(cid)
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		var env struct {
			Title  string `json:"title"`
			Tempo  int    `json:"tempo"`
			Tracks []struct {
				Source struct {
					CID string `json:"cid"`
				} `json:"source"`
			} `json:"tracks"`
		}
		if err := json.Unmarshal(body, &env); err != nil {
			http.Error(w, "unreadable composition", http.StatusInternalServerError)
			return
		}
		origin := requestOrigin(r)
		tracks := make([]beatscript.Track, 0, len(env.Tracks))
		for _, t := range env.Tracks {
			if t.Source.CID != "" {
				tracks = append(tracks, beatscript.Track{URL: origin + "/?cid=" + t.Source.CID, CID: t.Source.CID})
			}
		}
		node := beatscript.SetNode(origin+"/c/"+cid, env.Title, env.Tempo, tracks)
		out, err := json.Marshal(node)
		if err != nil {
			http.Error(w, "render error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/ld+json")
		w.Header().Set("Cache-Control", "public, max-age=300")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		_, _ = w.Write(out)
	}
}

// beatscriptDescriptorHandler serves /schema/beatscript: what beats adopts from BeatScript and what it proposes.
func beatscriptDescriptorHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/ld+json")
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	_, _ = w.Write(beatscript.Descriptor())
}

// requestOrigin is scheme://host as the client saw it (nginx terminates TLS and sets X-Forwarded-*).
func requestOrigin(r *http.Request) string {
	scheme := "https"
	if r.TLS == nil && r.Header.Get("X-Forwarded-Proto") != "https" {
		scheme = "http"
	}
	host := r.Host
	if xfh := r.Header.Get("X-Forwarded-Host"); xfh != "" {
		host = xfh
	}
	return scheme + "://" + host
}

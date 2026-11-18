// Package ld publishes the JSON-LD @context of btw programs and builds the document of a program for the
// /c/<cid> pages. The convention is pflow.xyz's (https://pflow.xyz/schema): a stable URL for the context,
// served as application/ld+json with CORS, a Link: rel="describedby" header to the ontology, and a version in
// the path so a change to the vocabulary is a new URL, never an edit in place.
//
// The terms are those of `btw jsonld` in the engine repo (crates/djlive/src/linked.rs, `context()`); the
// engine's test compares its context to btw-context-v1.jsonld, so the two cannot drift apart unseen.
package ld

import (
	_ "embed"
	"encoding/json"
	"net/http"
	"strconv"

	"beats-bitwrap-io/internal/btwsite/api"
)

//go:embed btw-context-v1.jsonld
var contextV1 []byte

// ContextV1 is the bytes served at /context/v1.jsonld.
func ContextV1() []byte { return contextV1 }

// Paths of the context. The versioned one is immutable; the unversioned one is the latest version.
const (
	PathV1     = "/context/v1.jsonld"
	PathLatest = "/context.jsonld"
)

// ContextURL is the @context a document names, on the site at origin.
func ContextURL(origin string) string { return origin + PathV1 }

const ontologyLink = `<https://ontology.bitwrap.io/ns.ttl>; rel="describedby"; type="text/turtle"`

// Mount registers the context routes on mux.
func Mount(mux *http.ServeMux) {
	mux.HandleFunc("GET "+PathV1, func(w http.ResponseWriter, r *http.Request) { serve(w, r, "public, max-age=31536000, immutable") })
	mux.HandleFunc("GET "+PathLatest, func(w http.ResponseWriter, r *http.Request) { serve(w, r, "public, max-age=300") })
	mux.HandleFunc("GET /context", func(w http.ResponseWriter, r *http.Request) { serve(w, r, "public, max-age=300") })
	mux.HandleFunc("OPTIONS "+PathV1, preflight)
	mux.HandleFunc("OPTIONS "+PathLatest, preflight)
}

func preflight(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	h.Set("Access-Control-Allow-Headers", "Content-Type")
	w.WriteHeader(http.StatusNoContent)
}

func serve(w http.ResponseWriter, r *http.Request, cache string) {
	h := w.Header()
	h.Set("Content-Type", "application/ld+json; charset=utf-8")
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Cache-Control", cache)
	h.Set("Link", ontologyLink)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("ETag", `"btw-context-v1"`)
	if r.Header.Get("If-None-Match") == `"btw-context-v1"` {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	h.Set("Content-Length", strconv.Itoa(len(contextV1)))
	if r.Method != http.MethodHead {
		_, _ = w.Write(contextV1)
	}
}

// DescribedBy is the Link header value that points a program's page at its JSON-LD document.
func DescribedBy(docURL string) string {
	return "<" + docURL + `>; rel="describedby"; type="application/ld+json"`
}

// Program is the facts a program's document is made from (what `btwd check` and the store know).
type Program struct {
	CID, Name, Key, License string
	Author                  string
	Tempo                   *float64
	Sections                []api.Section
}

// Document is the program as linked data, the shape of `btw jsonld`: its CID as @id on the share link,
// type djrust:Program. Genre, tags and Euclidean rhythms need the engine's ontology and are not here.
func Document(origin string, p Program) map[string]any {
	d := map[string]any{
		"@context": ContextURL(origin),
		"@id":      "https://beats.bitwrap.io/p#" + p.CID,
		"@type":    "djrust:Program",
		"cid":      p.CID,
	}
	if p.Name != "" {
		d["name"] = p.Name
	}
	if p.Key != "" {
		d["key"] = p.Key
	}
	if p.Tempo != nil {
		d["tempo"] = *p.Tempo
	}
	if len(p.Sections) > 0 {
		var secs []any
		for _, s := range p.Sections {
			secs = append(secs, map[string]any{"@type": "djrust:Section", "name": s.Name, "start": s.Start, "bars": s.Bars})
		}
		d["sections"] = secs
	}
	if p.License != "" {
		d["licenseId"] = p.License
		if p.License == "CC0-1.0" {
			d["license"] = "https://creativecommons.org/publicdomain/zero/1.0/"
		}
	}
	if p.Author != "" {
		d["author"] = p.Author
	}
	return d
}

// Marshal is the document as indented JSON.
func Marshal(d map[string]any) []byte {
	b, _ := json.MarshalIndent(d, "", "  ")
	return b
}

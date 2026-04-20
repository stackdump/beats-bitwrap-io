package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
)

//go:embed public/*
var publicFS embed.FS

func main() {
	addr := flag.String("addr", ":8089", "listen address")
	dir := flag.String("public", "", "serve from disk instead of embedded files")
	dataDir := flag.String("data", "./data", "content-addressed share store directory")
	maxStoreBytes := flag.Int64("max-store-bytes", 256<<20, "hard cap on total share-store bytes on disk")
	putPerMin := flag.Int("put-per-min", 10, "per-IP PUT rate limit (requests per minute)")
	globalPutPerMin := flag.Int("global-put-per-min", 120, "global PUT rate limit across all IPs (0 = disabled)")
	flag.Parse()

	var handler http.Handler
	if *dir != "" {
		handler = http.FileServer(http.Dir(*dir))
		log.Printf("Serving from disk: %s", *dir)
	} else {
		sub, err := fs.Sub(publicFS, "public")
		if err != nil {
			log.Fatal(err)
		}
		handler = http.FileServer(http.FS(sub))
		log.Printf("Serving embedded files")
	}

	store, err := newShareStore(*dataDir, *maxStoreBytes, *putPerMin, *globalPutPerMin)
	if err != nil {
		log.Fatalf("share store init: %v", err)
	}
	log.Printf("Share store: %s (cap %d bytes, %d PUT/min/IP, %d PUT/min global)",
		*dataDir, *maxStoreBytes, *putPerMin, *globalPutPerMin)

	mux := http.NewServeMux()
	mux.Handle("/o/", store)
	mux.HandleFunc("/schema/beats-share", handleBeatsShareSchema)
	mux.Handle("/", handler)

	// Wrap with CORS headers for cross-origin consumption (CDN, data-backend="ws")
	cors := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, PUT, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == "OPTIONS" {
			return
		}
		mux.ServeHTTP(w, r)
	})

	log.Printf("Listening on %s", *addr)
	fmt.Printf("beats.bitwrap.io → http://localhost%s\n", *addr)
	log.Fatal(http.ListenAndServe(*addr, cors))
}

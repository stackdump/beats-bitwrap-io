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

	// Wrap with CORS headers for cross-origin consumption (CDN, data-backend="ws")
	cors := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == "OPTIONS" {
			return
		}
		handler.ServeHTTP(w, r)
	})

	log.Printf("Listening on %s", *addr)
	fmt.Printf("beats.bitwrap.io → http://localhost%s\n", *addr)
	log.Fatal(http.ListenAndServe(*addr, cors))
}

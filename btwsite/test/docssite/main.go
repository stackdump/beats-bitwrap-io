// docssite is the smoke test's server for the HTML docs: the real docs package (Mount, so the real renderer and
// routes) plus btwsite/web as the static site, under the site's strict CSP, on 127.0.0.1:PORT. It is a test
// harness, not the service: no compose, no auth, the fake checker.
//
//	go run ./btwsite/test/docssite -port 18199 [-web btwsite/web] [-docs btwsite/testdata/docs]
package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"

	"beats-bitwrap-io/internal/btwsite/docs"
	"beats-bitwrap-io/internal/btwsite/fakecheck"
)

const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

func main() {
	port := flag.Int("port", 18199, "port")
	web := flag.String("web", "btwsite/web", "static site")
	dd := flag.String("docs", "btwsite/testdata/docs", "dir with BTW.md and cheatsheet.md")
	flag.Parse()
	mux := http.NewServeMux()
	if err := docs.Mount(mux, docs.Options{DocsDir: *dd, Checker: fakecheck.Checker{}, PublicURL: fmt.Sprintf("http://127.0.0.1:%d", *port)}); err != nil {
		log.Fatal(err)
	}
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("ok")) })
	mux.Handle("/", http.FileServer(http.Dir(*web)))
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", csp)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		mux.ServeHTTP(w, r)
	})
	log.Fatal(http.ListenAndServe(fmt.Sprintf("127.0.0.1:%d", *port), h))
}

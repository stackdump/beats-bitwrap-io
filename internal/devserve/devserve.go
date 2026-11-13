// Package devserve holds the local dev server's extras: HTTPS, so the studio opened from
// another device on the LAN is a secure context (browsers give AudioWorklet, which the djrust
// engine runs in, only to https pages and localhost), and a local djrust npm build served on the
// studio's own origin, so the ?djrust= override needs no second server, CORS or second
// certificate.
//
// Production does not use either: nginx terminates TLS there and the engine is the pinned CDN
// copy (public/djrust/version.js).
package devserve

import (
	"crypto/tls"
	"errors"
	"net/http"
	"os"
	"path/filepath"
)

// PkgPrefix is where a local djrust build is served: open the studio with ?djrust=/djrust-pkg/.
const PkgPrefix = "/djrust-pkg/"

// PkgHandler serves a djrust/npm/build.sh output directory (npm/pkg) under PkgPrefix, never
// cached, with application/wasm for the module (WebAssembly.compileStreaming needs it).
func PkgHandler(dir string) http.Handler {
	files := http.StripPrefix(PkgPrefix, http.FileServer(http.Dir(dir)))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if filepath.Ext(r.URL.Path) == ".wasm" {
			w.Header().Set("Content-Type", "application/wasm")
		}
		files.ServeHTTP(w, r)
	})
}

// CheckPkg reports whether dir looks like a djrust npm build (its glue and module are there).
func CheckPkg(dir string) error {
	for _, f := range []string{"djrust.js", "djrust_bg.wasm"} {
		if _, err := os.Stat(filepath.Join(dir, f)); err != nil {
			return errors.New(dir + " is not a djrust npm build (no " + f + "; run djrust/npm/build.sh)")
		}
	}
	return nil
}

// TLSConfig loads a certificate and key (both, or neither: nil, nil for plain http).
func TLSConfig(certFile, keyFile string) (*tls.Config, error) {
	if certFile == "" && keyFile == "" {
		return nil, nil
	}
	if certFile == "" || keyFile == "" {
		return nil, errors.New("-tls-cert and -tls-key go together")
	}
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, err
	}
	return &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}, nil
}

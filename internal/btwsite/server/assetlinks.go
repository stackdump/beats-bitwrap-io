package server

// GET /.well-known/assetlinks.json: Android App Links verification. Android 12+ opens a link in the app only
// when the host serves this file naming the app's package and signing-key fingerprints; otherwise the browser
// gets it. The file is the operator's (-assetlinks-file / BTW_ASSETLINKS_FILE), read on each request so a key
// can be added without a restart; with no file configured the path is a 404 as before.
// See btwsite/deploy/ASSETLINKS.md and btwsite/deploy/assetlinks.example.json.

import (
	"encoding/json"
	"net/http"
	"os"

	"beats-bitwrap-io/internal/btwsite/api"
)

func (s *Server) handleAssetLinks(w http.ResponseWriter, r *http.Request) {
	if s.cfg.AssetLinksFile == "" {
		s.notFound(w, r)
		return
	}
	b, err := os.ReadFile(s.cfg.AssetLinksFile)
	if err != nil || !json.Valid(b) {
		s.cfg.Logf("assetlinks: %s unreadable or not JSON: %v", s.cfg.AssetLinksFile, err)
		api.WriteError(w, api.Errf(http.StatusInternalServerError, "internal", "the asset links file is not available"))
		return
	}
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8") // JSON and never a redirect: the verifier does not follow one
	h.Set("Cache-Control", "no-cache")
	_, _ = w.Write(b)
}

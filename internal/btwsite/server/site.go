package server

// The site's identity, apart from its address.
//
// A site is named by a stable random id (<data>/site.json), not by the host it happens to be served from.
// What a phone signs (btw-pair/2) is that id, so the same data directory served from another origin keeps
// every pairing valid: a move is "copy data/, start the new server with -public-url, tell the old one
// -moved-to". The host is only where the site is reached, and a server may answer for several of them
// during a move (-alt-origins), which is also how pairings made under btw-pair/1 (host-bound) keep working.
//
//	GET /.well-known/btw-site   {proto, site_id, origin, origins, moved_to?}
//
// is how a client learns the id before signing, and how it confirms that a new origin it was told about
// is the same site (same id) and not just a name someone put in a notice.

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
)

func nowRFC3339() string { return time.Now().UTC().Format(time.RFC3339) }

// siteProto names the discovery document.
const siteProto = "btw-site/1"

type siteFile struct {
	ID      string `json:"site_id"`
	Created string `json:"created"`
}

// loadSite reads <data>/site.json, making it (with a fresh random id) the first time. override, when set
// (-site-id), wins and is written, so a new box can be told the id of the one it replaces.
func loadSite(dataDir, override string) (string, error) {
	path := filepath.Join(dataDir, "site.json")
	if override != "" {
		if !validSiteID(override) {
			return "", errors.New("-site-id must be 16..64 characters of A-Z a-z 0-9 - _")
		}
	}
	b, err := os.ReadFile(path)
	if err == nil {
		var f siteFile
		if err := json.Unmarshal(b, &f); err != nil || !validSiteID(f.ID) {
			return "", fmt.Errorf("%s is not a valid site file", path)
		}
		if override != "" && override != f.ID {
			return "", fmt.Errorf("-site-id %q differs from %s (%q): a site keeps one id for good", override, path, f.ID)
		}
		return f.ID, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	id := override
	if id == "" {
		raw := make([]byte, 16)
		if _, err := rand.Read(raw); err != nil {
			return "", err
		}
		id = base64.RawURLEncoding.EncodeToString(raw)
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return "", err
	}
	out, _ := json.MarshalIndent(siteFile{ID: id, Created: nowRFC3339()}, "", "  ")
	if err := os.WriteFile(path+".tmp", out, 0o644); err != nil {
		return "", err
	}
	return id, os.Rename(path+".tmp", path)
}

func validSiteID(s string) bool {
	if len(s) < 16 || len(s) > 64 {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}

// hostOf is the lower-cased host[:port] of an origin URL, "" when it is not one.
func hostOf(origin string) string {
	u, err := url.Parse(strings.TrimSpace(origin))
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return ""
	}
	return strings.ToLower(u.Host)
}

// parseOrigins splits a comma list of origins, trimmed of slashes, dropping empties.
func parseOrigins(list string) []string {
	var out []string
	for _, p := range strings.Split(list, ",") {
		p = strings.TrimRight(strings.TrimSpace(p), "/")
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// publicHost is the primary host (-public-url).
func (s *Server) publicHost() string {
	if h := hostOf(s.cfg.PublicURL); h != "" {
		return h
	}
	return "localhost"
}

// acceptedHosts are the hosts this site answers for: the primary one first, then -alt-origins.
func (s *Server) acceptedHosts() []string {
	hosts := []string{s.publicHost()}
	for _, o := range parseOrigins(s.cfg.AltOrigins) {
		if h := hostOf(o); h != "" && h != hosts[0] {
			hosts = append(hosts, h)
		}
	}
	return hosts
}

// knownHost says whether a request's Origin host is one of this site's.
func (s *Server) knownHost(h string) bool {
	h = strings.ToLower(h)
	for _, a := range s.acceptedHosts() {
		if a == h {
			return true
		}
	}
	return false
}

// siteDoc is /.well-known/btw-site, also embedded (as "site") in /api/info.
func (s *Server) siteDoc() map[string]any {
	origins := []string{s.cfg.PublicURL}
	origins = append(origins, parseOrigins(s.cfg.AltOrigins)...)
	d := map[string]any{
		"proto":   siteProto,
		"site_id": s.siteID,
		"origin":  s.cfg.PublicURL,
		"origins": origins,
		"pair":    []string{pairProto2, pairProto},
		"license": contentLicense,
		"privacy": s.cfg.PublicURL + "/privacy",
	}
	if m := strings.TrimRight(s.cfg.MovedTo, "/"); m != "" {
		d["moved_to"] = m
	}
	return d
}

func (s *Server) handleSiteDoc(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Access-Control-Allow-Origin", "*") // a public fact, read by the page at a new origin to confirm a move
	writeJSON(w, http.StatusOK, s.siteDoc())
}

// movedEvent is sent on a phone's stream after the hello while -moved-to is set: where the site is now.
// The phone checks the new origin's /.well-known/btw-site names the same site_id before it follows.
func (s *Server) movedEvent() *api.SessionEvent {
	m := strings.TrimRight(s.cfg.MovedTo, "/")
	if m == "" {
		return nil
	}
	extra, _ := json.Marshal(map[string]any{"moved_to": m, "site_id": s.siteID, "from": s.cfg.PublicURL})
	return &api.SessionEvent{Type: "moved", Extra: extra}
}

// altHosts are the hosts of -alt-origins.
func altHosts(list string) []string {
	var out []string
	for _, o := range parseOrigins(list) {
		if h := hostOf(o); h != "" {
			out = append(out, h)
		}
	}
	return out
}

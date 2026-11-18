package server

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
)

// version is set by -ldflags "-X beats-bitwrap-io/internal/btwsite/server.Version=…"; empty = "dev".
var Version = ""

const maxCheckBody = 128 << 10 // check / fmt / share / open

func (s *Server) version() string {
	if s.cfg.Version != "" {
		return s.cfg.Version
	}
	if Version != "" {
		return Version
	}
	return "dev"
}

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "name": "btw", "version": s.version()})
}

func (s *Server) handleInfo(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-cache")
	cs := s.composer.Status()
	ff := s.rs.ffmpegOK()
	defFmt := "opus"
	formats := []string{"opus", "wav"}
	if !ff {
		defFmt, formats = "wav", []string{"wav"}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"name":       "btw",
		"version":    s.version(),
		"public_url": s.cfg.PublicURL,
		"model":      cs.Model,
		"compose": map[string]any{
			"enabled": cs.Enabled, "configured": cs.Configured, "reason": cs.Reason,
			"limits": map[string]any{
				"user_per_hour": cs.UserHour, "user_per_day": cs.UserDay, "ip_per_day": cs.IPDay,
				"daily_cap_usd": cs.DailyCapUSD, "max_prompt_chars": s.cfg.MaxPromptChars, "max_program_bytes": s.cfg.MaxProgramBytes,
			},
		},
		"render": map[string]any{
			"formats": formats, "default_format": defFmt, "sample_rates": []int{44100, 48000},
			"max_bars": s.cfg.RenderMaxBars, "concurrency": s.cfg.RenderConcurrency, "ip_per_hour": s.cfg.RenderIPHour,
		},
		"auth":     map[string]any{"kinds": []string{"eth", "ed25519"}, "cookie": "btw_session", "token_prefix": "btw_"},
		"limits":   map[string]any{"max_check_bytes": maxCheckBody, "max_program_bytes": s.cfg.MaxProgramBytes, "check_per_minute": s.cfg.CheckIPMin, "put_per_hour": s.cfg.PutIPHour},
		"examples": len(s.examples.list),
		"mcp":      "/mcp",
	})
}

func (s *Server) handleExamples(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-cache")
	list := s.examples.list
	if list == nil {
		list = []api.Example{}
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleExampleFile(w http.ResponseWriter, r *http.Request) {
	name, ok := strings.CutSuffix(r.PathValue("name"), ".btw")
	text, found := s.examples.text[name]
	if !ok || !found {
		api.WriteError(w, api.Errf(http.StatusNotFound, api.CodeNotFound, "no example named %q", r.PathValue("name")))
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = io.WriteString(w, text)
}

func (s *Server) handleInstruments(w http.ResponseWriter, r *http.Request) {
	if ok, retry := s.checkIP.Allow(ClientIP(r)); !limited(w, ok, retry, "check") {
		return
	}
	raw, err := s.checker.Instruments(r.Context())
	if err != nil {
		api.WriteError(w, s.asAPIError(err))
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	_, _ = w.Write(raw)
}

type textBody struct {
	Text string `json:"text"`
	URL  string `json:"url"`
}

// checkBody applies the per-IP limit and reads {"text":…}.
func (s *Server) checkBody(w http.ResponseWriter, r *http.Request) (textBody, bool) {
	var b textBody
	if ok, retry := s.checkIP.Allow(ClientIP(r)); !limited(w, ok, retry, "check") {
		return b, false
	}
	if !decodeBody(w, r, maxCheckBody, &b) {
		return b, false
	}
	return b, true
}

func (s *Server) handleCheck(w http.ResponseWriter, r *http.Request) {
	b, ok := s.checkBody(w, r)
	if !ok {
		return
	}
	rep, err := s.checker.Check(r.Context(), b.Text)
	if err != nil {
		api.WriteError(w, s.asAPIError(err))
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

func (s *Server) handleFmt(w http.ResponseWriter, r *http.Request) {
	b, ok := s.checkBody(w, r)
	if !ok {
		return
	}
	rep, err := s.checker.Fmt(r.Context(), b.Text)
	if err != nil {
		api.WriteError(w, s.asAPIError(err))
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

// shareReply is a ShareReport plus, for a program that does not check, why.
type shareReply struct {
	api.ShareReport
	Diagnostics []api.Diagnostic `json:"diagnostics,omitempty"`
	Error       string           `json:"error,omitempty"`
}

func (s *Server) handleShare(w http.ResponseWriter, r *http.Request) {
	b, ok := s.checkBody(w, r)
	if !ok {
		return
	}
	rep, err := s.checker.Share(r.Context(), b.Text)
	if err != nil {
		api.WriteError(w, s.asAPIError(err))
		return
	}
	out := shareReply{ShareReport: *s.fixShare(rep)}
	if !rep.OK {
		out.Error = "the program does not check; fix its errors first"
		if cr, err := s.checker.Check(r.Context(), b.Text); err == nil {
			out.Diagnostics = cr.Diagnostics
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// fixShare makes the links this site's own: url = <origin>/#<CID>.<packed>, social_url = <origin>/c/<CID>.<packed>
// (the sealed part moved into the path, without ~notes), whatever origin the checker built them with.
func (s *Server) fixShare(rep *api.ShareReport) *api.ShareReport {
	out := *rep
	if i := strings.Index(rep.URL, "#"); i >= 0 {
		frag := rep.URL[i+1:]
		sealed, _, _ := strings.Cut(frag, "~")
		out.URL = s.cfg.PublicURL + "/#" + frag
		out.SocialURL = s.cfg.PublicURL + "/c/" + sealed
	}
	return &out
}

func (s *Server) handleOpen(w http.ResponseWriter, r *http.Request) {
	b, ok := s.checkBody(w, r)
	if !ok {
		return
	}
	arg := b.URL
	if arg == "" {
		arg = b.Text
	}
	if strings.TrimSpace(arg) == "" {
		api.WriteError(w, api.Errf(http.StatusBadRequest, api.CodeBadRequest, `give {"url": "<link, fragment or CID>"}`))
		return
	}
	rep, err := s.checker.Open(r.Context(), arg)
	if err != nil {
		api.WriteError(w, s.asAPIError(err))
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

// ---------- programs ----------

func (s *Server) handlePutProgram(w http.ResponseWriter, r *http.Request) {
	cid := r.PathValue("cid")
	if !reCID.MatchString(cid) {
		api.WriteError(w, api.Errf(http.StatusBadRequest, api.CodeBadRequest, "%q is not a CID", cid))
		return
	}
	// the limit is on distinct work: refused before the body is even read
	if ok, retry := s.putIP.Allow(ClientIP(r)); !limited(w, ok, retry, "upload") {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, int64(s.cfg.MaxProgramBytes)+1)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		api.WriteError(w, api.Errf(http.StatusRequestEntityTooLarge, api.CodeTooLarge, "program is over %d bytes", s.cfg.MaxProgramBytes))
		return
	}
	if strings.Contains(strings.ToLower(r.Header.Get("Content-Type")), "json") {
		api.WriteError(w, api.Errf(http.StatusUnsupportedMediaType, api.CodeBadRequest, "send the program text itself as the body (Content-Type: text/plain), not JSON"))
		return
	}
	p, rep, created, perr := s.store.put(r.Context(), string(body), api.Meta{}, cid)
	if perr != nil {
		api.WriteError(w, s.asAPIError(perr))
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(w, status, map[string]any{"cid": p.CID, "created": created, "meta": p.Meta, "warnings": rep.Warnings})
}

func (s *Server) handleGetProgram(w http.ResponseWriter, r *http.Request) {
	raw := r.PathValue("cid")
	cid, asText := strings.CutSuffix(raw, ".btw")
	if !reCID.MatchString(cid) {
		api.WriteError(w, api.Errf(http.StatusNotFound, api.CodeNotFound, "no such program"))
		return
	}
	p, ok := s.Get(cid)
	if !ok {
		api.WriteError(w, api.Errf(http.StatusNotFound, api.CodeNotFound, "no program %s here; PUT it first", cid))
		return
	}
	h := w.Header()
	h.Set("Cache-Control", "public, max-age=31536000, immutable") // content-addressed
	h.Set("ETag", `"`+cid+`"`)
	if r.Header.Get("If-None-Match") == h.Get("ETag") {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	if asText {
		h.Set("Content-Type", "text/plain; charset=utf-8")
		h.Set("Content-Disposition", fmt.Sprintf("inline; filename=%q", cid+".btw"))
		_, _ = io.WriteString(w, btwFile(p))
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// ---------- static ----------

type etagEntry struct {
	size  int64
	mtime time.Time
	tag   string
}

var etags sync.Map // path -> etagEntry

func fileETag(p string, info os.FileInfo) (string, error) {
	if v, ok := etags.Load(p); ok {
		e := v.(etagEntry)
		if e.size == info.Size() && e.mtime.Equal(info.ModTime()) {
			return e.tag, nil
		}
	}
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	tag := `"` + hex.EncodeToString(h.Sum(nil)[:12]) + `"`
	etags.Store(p, etagEntry{info.Size(), info.ModTime(), tag})
	return tag, nil
}

func init() {
	for ext, typ := range map[string]string{".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".wasm": "application/wasm",
		".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".btw": "text/plain; charset=utf-8",
		".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".html": "text/html; charset=utf-8", ".webmanifest": "application/manifest+json"} {
		_ = mime.AddExtensionType(ext, typ)
	}
}

// handleStatic serves -web: no-cache + a content ETag (a deploy reaches browsers at once, an unchanged
// file is a 304), "/" and "/p" are the page, anything dotted or outside the directory is a 404.
func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		api.WriteError(w, api.Errf(http.StatusMethodNotAllowed, "method_not_allowed", "%s is not allowed here", r.Method))
		return
	}
	p := path.Clean("/" + r.URL.Path)
	if p == "/" || p == "/p" {
		p = "/index.html"
	}
	for _, seg := range strings.Split(p, "/") {
		if strings.HasPrefix(seg, ".") {
			s.notFound(w, r)
			return
		}
	}
	root, err := filepath.Abs(s.cfg.WebDir)
	if err != nil {
		s.notFound(w, r)
		return
	}
	full := filepath.Join(root, filepath.FromSlash(p))
	info, err := os.Stat(full)
	if err == nil && info.IsDir() {
		full = filepath.Join(full, "index.html")
		info, err = os.Stat(full)
	}
	if err != nil || info.IsDir() || !strings.HasPrefix(full, root+string(filepath.Separator)) {
		s.notFound(w, r)
		return
	}
	tag, err := fileETag(full, info)
	if err != nil {
		s.notFound(w, r)
		return
	}
	f, err := os.Open(full)
	if err != nil {
		s.notFound(w, r)
		return
	}
	defer f.Close()
	h := w.Header()
	h.Set("ETag", tag)
	h.Set("Cache-Control", "no-cache")
	if ct := mime.TypeByExtension(filepath.Ext(full)); ct != "" {
		h.Set("Content-Type", ct)
	}
	http.ServeContent(w, r, info.Name(), time.Time{}, f) // honours If-None-Match and Range; no Last-Modified
}

func (s *Server) notFound(w http.ResponseWriter, r *http.Request) {
	api.WriteError(w, api.Errf(http.StatusNotFound, api.CodeNotFound, "not found"))
}

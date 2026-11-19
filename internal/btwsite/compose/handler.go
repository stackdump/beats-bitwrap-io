package compose

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
)

// flexString reads a JSON string, or a number as its digits ("length":64 and "length":"64" are the same).
type flexString string

func (f *flexString) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if bytes.Equal(b, []byte("null")) {
		return nil
	}
	if len(b) > 0 && b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		*f = flexString(s)
		return nil
	}
	var n json.Number
	if err := json.Unmarshal(b, &n); err != nil {
		return errors.New("length must be a string or a number")
	}
	*f = flexString(n.String())
	return nil
}

type composeBody struct {
	Prompt  string     `json:"prompt"`
	Genre   string     `json:"genre"`
	BPM     float64    `json:"bpm"`
	Key     string     `json:"key"`
	Length  flexString `json:"length"`
	BaseCID string     `json:"base_cid"`
	Current string     `json:"current"`
}

// composeResponse is api.ComposeResult with forkedFrom as null (not "") when there is no parent.
type composeResponse struct {
	api.ComposeResult
	ForkedFrom *string `json:"forkedFrom"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, err error) {
	w.Header().Set("Cache-Control", "no-store")
	api.WriteError(w, err)
}

// Handler is POST /api/compose. Authentication is the first thing it does, for every method and every
// path through it: a request with no user is a 401 and nothing else about the service (configuration, kill
// switch, limits) is revealed to it.
func (s *Service) Handler(a api.Authenticator) http.Handler {
	// every character may be a \uXXXX escape, of the prompt and of the current program
	maxBody := int64(s.opt.MaxPromptChars)*6 + int64(s.opt.MaxProgramBytes)*6 + 4096
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var u *api.User
		var err error
		if a != nil {
			u, err = a.UserFrom(r)
		}
		if err != nil || u == nil || u.ID == "" {
			writeErr(w, api.Errf(http.StatusUnauthorized, api.CodeAuthRequired, "sign in to compose"))
			return
		}
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeErr(w, &api.Error{Status: http.StatusMethodNotAllowed, Code: api.CodeBadRequest, Message: "use POST"})
			return
		}
		if !isJSON(r) {
			writeErr(w, &api.Error{Status: http.StatusUnsupportedMediaType, Code: api.CodeBadRequest, Message: "send the body as JSON with Content-Type: application/json"})
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxBody)
		dec := json.NewDecoder(r.Body)
		dec.DisallowUnknownFields()
		var body composeBody
		if err := dec.Decode(&body); err != nil {
			var mb *http.MaxBytesError
			if errors.As(err, &mb) {
				writeErr(w, api.Errf(http.StatusRequestEntityTooLarge, api.CodeTooLarge, "the request body is over %d bytes", maxBody))
				return
			}
			if errors.Is(err, io.EOF) {
				writeErr(w, api.Errf(400, api.CodeBadRequest, `send a JSON body like {"prompt":"dark techno 128"}`))
				return
			}
			writeErr(w, api.Errf(400, api.CodeBadRequest, "the body is not the JSON compose expects: %s", jsonErrWords(err)))
			return
		}
		if _, err := dec.Token(); !errors.Is(err, io.EOF) {
			var mb *http.MaxBytesError
			if errors.As(err, &mb) {
				writeErr(w, api.Errf(http.StatusRequestEntityTooLarge, api.CodeTooLarge, "the request body is over %d bytes", maxBody))
				return
			}
			writeErr(w, api.Errf(400, api.CodeBadRequest, "the body must be one JSON object"))
			return
		}
		// A compose with repairs takes a while; the server's own write timeout (beats' is 15 s) must not cut it.
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(5 * time.Minute))
		res, err := s.Compose(r.Context(), u, api.ClientIP(r), api.ComposeRequest{
			Prompt: body.Prompt, Genre: body.Genre, BPM: body.BPM, Key: body.Key, Length: string(body.Length), BaseCID: body.BaseCID,
			Current: body.Current,
		})
		if err != nil {
			writeErr(w, err)
			return
		}
		out := composeResponse{ComposeResult: *res}
		if res.ForkedFrom != "" {
			f := res.ForkedFrom
			out.ForkedFrom = &f
		}
		if out.Attempts == nil {
			out.Attempts = []api.Attempt{}
		}
		writeJSON(w, http.StatusOK, out)
	})
}

// isJSON: a body that is not declared JSON is not read at all (a cross-site form post cannot declare it).
func isJSON(r *http.Request) bool {
	mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	return err == nil && mt == "application/json"
}

// jsonErrWords is a decoding error in words that do not echo the body back.
func jsonErrWords(err error) string {
	var ute *json.UnmarshalTypeError
	if errors.As(err, &ute) {
		return "field " + strconv.Quote(ute.Field) + " has the wrong type"
	}
	var se *json.SyntaxError
	if errors.As(err, &se) {
		return "syntax error at byte " + strconv.FormatInt(se.Offset, 10)
	}
	if msg := err.Error(); strings.HasPrefix(msg, "json: unknown field") {
		return msg[len("json: "):]
	}
	return "invalid JSON"
}

// ---------- admin ----------

// AdminHandler serves POST /api/admin/compose {"enabled":bool} (the kill switch) and GET /api/admin/stats,
// both behind Authorization: Bearer <adminToken>. With no token configured the endpoints are closed.
func (s *Service) AdminHandler(adminToken string) http.Handler {
	want := sha256.Sum256([]byte(adminToken))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if adminToken == "" {
			writeErr(w, api.Errf(http.StatusServiceUnavailable, api.CodeNotConfigured, "the admin endpoints are closed: BTW_ADMIN_TOKEN is not set"))
			return
		}
		tok := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") || tok == "" {
			w.Header().Set("WWW-Authenticate", `Bearer realm="btw admin"`)
			writeErr(w, api.Errf(http.StatusUnauthorized, api.CodeAuthRequired, "admin token required"))
			return
		}
		got := sha256.Sum256([]byte(tok))
		if subtle.ConstantTimeCompare(got[:], want[:]) != 1 {
			w.Header().Set("WWW-Authenticate", `Bearer realm="btw admin"`)
			writeErr(w, api.Errf(http.StatusUnauthorized, api.CodeAuthRequired, "admin token required"))
			return
		}
		switch strings.TrimSuffix(r.URL.Path, "/") {
		case "/api/admin/compose":
			s.adminCompose(w, r)
		case "/api/admin/stats":
			s.adminStats(w, r)
		default:
			writeErr(w, api.Errf(http.StatusNotFound, api.CodeNotFound, "no such admin endpoint"))
		}
	})
}

func (s *Service) killJSON() map[string]any {
	k := s.lim.Kill()
	return map[string]any{"enabled": !k.Disabled, "disabled_by_env": k.Env, "disabled_by_file": k.File}
}

func (s *Service) adminCompose(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeErr(w, &api.Error{Status: http.StatusMethodNotAllowed, Code: api.CodeBadRequest, Message: "use POST"})
		return
	}
	if !isJSON(r) {
		writeErr(w, &api.Error{Status: http.StatusUnsupportedMediaType, Code: api.CodeBadRequest, Message: "send the body as JSON with Content-Type: application/json"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var body struct {
		Enabled *bool `json:"enabled"`
	}
	if err := dec.Decode(&body); err != nil || body.Enabled == nil {
		writeErr(w, api.Errf(400, api.CodeBadRequest, `send {"enabled":true} or {"enabled":false}`))
		return
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		writeErr(w, api.Errf(400, api.CodeBadRequest, "the body must be one JSON object"))
		return
	}
	if err := s.lim.SetEnabled(*body.Enabled); err != nil {
		writeErr(w, api.Errf(500, "internal", "could not change the switch: %s", s.red.Redact(err.Error())))
		return
	}
	s.logf("compose: switched %s through the admin endpoint", map[bool]string{true: "on", false: "off"}[*body.Enabled])
	out := s.killJSON()
	out["status"] = s.Status()
	writeJSON(w, http.StatusOK, out)
}

func (s *Service) adminStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeErr(w, &api.Error{Status: http.StatusMethodNotAllowed, Code: api.CodeBadRequest, Message: "use GET"})
		return
	}
	s.pc.mu.Lock()
	ex := append([]string(nil), s.pc.names...)
	s.pc.mu.Unlock()
	out := s.killJSON()
	out["status"] = s.Status()
	out["limits"] = s.lim.Stats()
	out["model"] = s.modelName
	out["thinking"] = s.think
	out["max_output_tokens"] = s.opt.MaxOutputTokens
	out["max_repair"] = s.opt.MaxRepair
	out["prompt_examples"] = ex
	writeJSON(w, http.StatusOK, out)
}

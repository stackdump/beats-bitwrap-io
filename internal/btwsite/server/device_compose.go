package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
)

// POST /api/device/compose: a paired phone asks compose for a program (btwsite/PAIRING.md "Compose from the
// phone"). The request is signed like every device request (btw-pair/1 request, the body's hash included), and
// compose runs as the pairing owner: the owner's per-user limits, the per-address limit, the kill switch and the
// daily spend cap are the web route's own, counted against the same account. No new credential.
//
// Body: {prompt, genre?, key?, length?, bpm?, base_cid?, current?}; current is the program in the phone's editor,
// sent with every prompt after the first ("change this"). Answer: the web route's JSON (program, cid, check,
// attempts, share_url, render_url, ...), one body, not a stream (the web route does not stream either).

type deviceComposeBody struct {
	Prompt  string          `json:"prompt"`
	Genre   string          `json:"genre,omitempty"`
	Key     string          `json:"key,omitempty"`
	Length  json.RawMessage `json:"length,omitempty"` // "short" | "medium" | "long" | a number of bars
	BPM     float64         `json:"bpm,omitempty"`
	BaseCID string          `json:"base_cid,omitempty"`
	Current string          `json:"current,omitempty"`
}

// jsonWords is a decode error in a few plain words, never the body itself.
func jsonWords(err error) string {
	msg := err.Error()
	if i := strings.Index(msg, "unknown field"); i >= 0 {
		return clipWords(msg[i:], 80)
	}
	var se *json.SyntaxError
	if errors.As(err, &se) {
		return "the body is not valid JSON"
	}
	var te *json.UnmarshalTypeError
	if errors.As(err, &te) {
		return "a field has the wrong type: " + clipWords(te.Field, 40)
	}
	return "the body is not valid JSON"
}

func clipWords(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func ownerUser(id string) *api.User {
	switch {
	case strings.HasPrefix(id, "eip155:"):
		return &api.User{ID: id, Kind: "eth", Address: strings.TrimPrefix(id, "eip155:"), Via: "device"}
	case strings.HasPrefix(id, "ed25519:"):
		return &api.User{ID: id, Kind: "ed25519", Address: strings.TrimPrefix(id, "ed25519:"), Via: "device"}
	}
	return &api.User{ID: id, Via: "device"}
}

func lengthArg(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return "", true
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s, true
	}
	var n json.Number
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if dec.Decode(&n) == nil {
		return n.String(), true
	}
	return "", false
}

func (s *Server) handleDeviceCompose(w http.ResponseWriter, r *http.Request) {
	// every character may be a \uXXXX escape, of the prompt and of the current program
	prompt, program := int64(s.cfg.MaxPromptChars), int64(s.cfg.MaxProgramBytes)
	if prompt <= 0 {
		prompt = 800
	}
	if program <= 0 {
		program = 16384
	}
	maxBody := prompt*6 + program*6 + 4096
	d, body, ok := s.deviceFrom(w, r, maxBody)
	if !ok {
		return
	}
	var b deviceComposeBody
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&b); err != nil {
		// name the problem (an unknown field says "unknown field"): a client that sent an optional field this
		// site does not know can tell, and ask again without it
		api.WriteError(w, api.Errf(http.StatusBadRequest, api.CodeBadRequest, `send a JSON body like {"prompt":"dark techno 128"}: %s`, jsonWords(err)))
		return
	}
	if strings.TrimSpace(b.Prompt) == "" {
		api.WriteError(w, api.Errf(http.StatusBadRequest, api.CodeBadRequest, `send a JSON body like {"prompt":"dark techno 128"}`))
		return
	}
	length, ok := lengthArg(b.Length)
	if !ok {
		api.WriteError(w, api.Errf(http.StatusBadRequest, api.CodeBadRequest, "length is short, medium, long or a number of bars"))
		return
	}
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(5 * time.Minute))
	res, err := s.composer.Compose(r.Context(), ownerUser(d.Owner), api.ClientIP(r), api.ComposeRequest{
		Prompt: b.Prompt, Genre: b.Genre, BPM: b.BPM, Key: b.Key, Length: length, BaseCID: b.BaseCID,
		Current: b.Current,
	})
	if err != nil {
		var ae *api.Error
		if !errors.As(err, &ae) {
			ae = api.Errf(http.StatusInternalServerError, "internal", "%v", err)
		}
		api.WriteError(w, ae)
		return
	}
	if res.Attempts == nil {
		res.Attempts = []api.Attempt{}
	}
	writeJSON(w, http.StatusOK, res)
}

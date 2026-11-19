package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"beats-bitwrap-io/internal/btwsite/api"
)

// PUT /api/shares/<cid>: the CID-only share link's write side (btwsite/DESIGN.md "Short links").
//
// A self-sealing link carries the program; a short link (<site>/p/<CID>, beats.bitwrap.io/p/<CID>) carries only
// the CID, so the canonical text and its rights are kept here, in the one programs store (-data/programs/<cid>.json,
// the store PUT /api/programs fills; there is no second one). Opening a short link fetches it (the public
// GET /api/programs/<cid>), recompiles the text, recomputes the CID and refuses a mismatch, like a sealed link.
//
// Unlike PUT /api/programs/<cid> (anonymous, per address, no rights), a share is a signed-in write: a cookie or a
// btw_ bearer token (the account's), or a paired phone's `Authorization: BtwDevice` signature (it acts as the account
// that paired it). It is counted per account and per address. Only public programs are stored: `#! visibility:` anything
// but public, restricted sounds and sample/loop assets are refused with 422 restricted, and stay inline-only.
//
// Body (JSON): {"text", "license"?, "forked_from"?, "credits"?, "name"?, "visibility"?}. First write wins, as in the
// store: a program already there keeps its first rights, and the answer says what they are.

var (
	reLicense = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.+-]{0,39}$`)
)

type shareBody struct {
	Text       string   `json:"text"`
	License    string   `json:"license,omitempty"`
	Visibility string   `json:"visibility,omitempty"`
	ForkedFrom string   `json:"forked_from,omitempty"`
	Credits    []string `json:"credits,omitempty"`
	Name       string   `json:"name,omitempty"`
}

// cleanLine trims s and refuses control characters; ok is false for an empty or too long line.
func cleanLine(s string, max int) (string, bool) {
	s = strings.TrimSpace(s)
	if s == "" || utf8.RuneCountInString(s) > max || !utf8.ValidString(s) {
		return "", false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return "", false
		}
	}
	return s, true
}

// rights validates a share body's rights into the store's Meta.
func (b *shareBody) rights() (api.Meta, *api.Error) {
	m := api.Meta{License: "CC0-1.0", Visibility: "public", Source: "share"}
	if v := strings.TrimSpace(b.Visibility); v != "" && v != "public" {
		return m, api.Errf(http.StatusUnprocessableEntity, api.CodeRestricted, "only public programs are stored; a private or restricted program stays in its inline link")
	}
	if l := strings.TrimSpace(b.License); l != "" {
		if !reLicense.MatchString(l) {
			return m, api.Errf(http.StatusBadRequest, api.CodeBadRequest, "license is a short SPDX-style id such as CC0-1.0 or CC-BY-4.0")
		}
		m.License = l
	}
	if f := strings.TrimSpace(b.ForkedFrom); f != "" {
		if !reCID.MatchString(f) {
			return m, api.Errf(http.StatusBadRequest, api.CodeBadRequest, "forked_from must be a CID (it starts with z)")
		}
		m.ForkedFrom = f
	}
	if len(b.Credits) > api.MaxCredits {
		return m, api.Errf(http.StatusBadRequest, api.CodeBadRequest, "at most %d credits", api.MaxCredits)
	}
	for _, c := range b.Credits {
		c2, ok := cleanLine(c, api.MaxCreditChars)
		if !ok {
			return m, api.Errf(http.StatusBadRequest, api.CodeBadRequest, "each credit is one line of 1 to %d characters", api.MaxCreditChars)
		}
		m.Credits = append(m.Credits, c2)
	}
	if n := strings.TrimSpace(b.Name); n != "" {
		n2, ok := cleanLine(n, 80)
		if !ok {
			return m, api.Errf(http.StatusBadRequest, api.CodeBadRequest, "name is one line of at most 80 characters")
		}
		m.Name = n2
	}
	return m, nil
}

// shareWriter authenticates a share write and reads its body: a paired phone (BtwDevice signature, the body's hash
// signed) or a signed-in user (cookie or btw_ token). owner is the account either way.
func (s *Server) shareWriter(w http.ResponseWriter, r *http.Request, maxBody int64) (owner string, body []byte, ok bool) {
	if strings.HasPrefix(r.Header.Get("Authorization"), "BtwDevice ") {
		d, b, ok := s.deviceFrom(w, r, maxBody)
		if !ok {
			return "", nil, false
		}
		return d.Owner, b, true
	}
	u, ok := s.requireUser(w, r)
	if !ok {
		return "", nil, false
	}
	b, err := readBody(w, r, maxBody)
	if err != nil {
		return "", nil, false
	}
	return u.ID, b, true
}

func readBody(w http.ResponseWriter, r *http.Request, max int64) ([]byte, error) {
	var buf bytes.Buffer
	r.Body = http.MaxBytesReader(w, r.Body, max)
	if _, err := buf.ReadFrom(r.Body); err != nil {
		api.WriteError(w, api.Errf(http.StatusRequestEntityTooLarge, api.CodeTooLarge, "request body is over %d bytes", max))
		return nil, err
	}
	return buf.Bytes(), nil
}

func (s *Server) handlePutShare(w http.ResponseWriter, r *http.Request) {
	cid := r.PathValue("cid")
	if !reCID.MatchString(cid) {
		api.WriteError(w, api.Errf(http.StatusBadRequest, api.CodeBadRequest, "%q is not a CID", cid))
		return
	}
	owner, body, ok := s.shareWriter(w, r, int64(s.cfg.MaxProgramBytes)*6+8192)
	if !ok {
		return
	}
	// the limits are on distinct work and come before any of it: per account, then per address
	if ok, retry := s.shareAcct.Allow(owner); !ok {
		e := api.Errf(http.StatusTooManyRequests, api.CodeRateLimited, "this account has shared too many programs this hour; try again in %ds", retry)
		e.RetryAfter = retry
		api.WriteError(w, e)
		return
	}
	if ok, retry := s.putIP.Allow(ClientIP(r)); !limited(w, ok, retry, "upload") {
		return
	}
	var b shareBody
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&b); err != nil || strings.TrimSpace(b.Text) == "" {
		api.WriteError(w, api.Errf(http.StatusBadRequest, api.CodeBadRequest, `send JSON like {"text": "<the program>", "license": "CC0-1.0", "forked_from": "<CID>", "credits": ["…"]}`))
		return
	}
	meta, e := b.rights()
	if e != nil {
		api.WriteError(w, e)
		return
	}
	p, rep, created, err := s.store.put(r.Context(), b.Text, meta, cid)
	if err != nil {
		api.WriteError(w, s.asAPIError(err))
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	l := api.ShortLinksOf(s.cfg.PublicURL, p.CID)
	writeJSON(w, status, map[string]any{
		"cid": p.CID, "created": created, "meta": p.Meta, "warnings": rep.Warnings,
		"short_url": l.URL, "short_social_url": l.SocialURL, "short_beats_url": l.BeatsURL,
		"fetch_url": s.cfg.PublicURL + "/api/programs/" + p.CID,
	})
}

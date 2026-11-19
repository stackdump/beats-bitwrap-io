package server

// POST /api/qr draws a QR code for one of this site's own share links, so the page's Share panel can show
// a code a phone's camera scans (the BeatScript app claims <public_url>/p and opens the program with no network).
// It is not a general QR service: only <public_url>/p#<CID>.<packed> and <public_url>/p/<CID> are drawn.
// The drawing is the same encoder the pairing QR uses (github.com/skip2/go-qrcode), here as an SVG so it
// stays crisp at any size. No sign-in; limited per IP like check.

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	qrcode "github.com/skip2/go-qrcode"

	"beats-bitwrap-io/internal/btwsite/api"
)

// maxQRLink caps the link a code is drawn for. A QR code at the lowest error correction holds 2953 bytes at
// most, and a phone camera reads a code past ~1300 characters only with difficulty; the page chooses what to
// show (see qr-model.js), this is the server's ceiling.
const maxQRLink = 2000

const maxQRBody = 4 << 10

var (
	// <CID>.<base64url packed>, the fragment of a self-sealing link: URL-safe base64 and the dot, nothing else.
	qrFragRE = regexp.MustCompile(`^[A-Za-z0-9_-]{8,128}\.[A-Za-z0-9_-]+$`)
	// the CID alone (a short link): no dot.
	qrCIDRE = regexp.MustCompile(`^[A-Za-z0-9]{8,128}$`)
)

// qrLinkOK reports whether link is one of this site's own share forms.
func qrLinkOK(public, link string) bool {
	if len(link) > maxQRLink {
		return false
	}
	if rest, ok := strings.CutPrefix(link, public+"/p#"); ok {
		return qrFragRE.MatchString(rest)
	}
	if rest, ok := strings.CutPrefix(link, public+"/p/"); ok {
		return qrCIDRE.MatchString(rest)
	}
	return false
}

// qrSVG draws a code as a single path of black runs on white; the bitmap carries the 4-module quiet zone.
func qrSVG(q *qrcode.QRCode) string {
	bm := q.Bitmap()
	n := len(bm)
	var b strings.Builder
	fmt.Fprintf(&b, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" shape-rendering="crispEdges"><rect width="%d" height="%d" fill="#fff"/><path fill="#000" d="`, n, n, n, n)
	for y, row := range bm {
		for x := 0; x < len(row); {
			if !row[x] {
				x++
				continue
			}
			x0 := x
			for x < len(row) && row[x] {
				x++
			}
			fmt.Fprintf(&b, "M%d %dh%dv1h-%dz", x0, y, x-x0, x-x0)
		}
	}
	b.WriteString(`"/></svg>`)
	return b.String()
}

func (s *Server) handleQR(w http.ResponseWriter, r *http.Request) {
	if ok, retry := s.checkIP.Allow(ClientIP(r)); !limited(w, ok, retry, "qr") {
		return
	}
	var b struct {
		Text string `json:"text"`
	}
	if !decodeBody(w, r, maxQRBody, &b) {
		return
	}
	if !qrLinkOK(s.cfg.PublicURL, b.Text) {
		api.WriteError(w, api.Errf(http.StatusBadRequest, api.CodeBadRequest,
			"a QR code is drawn only for this site's own share links (%s/p#<CID>.<packed> or %s/p/<CID>), at most %d characters", s.cfg.PublicURL, s.cfg.PublicURL, maxQRLink))
		return
	}
	q, err := qrcode.New(b.Text, qrcode.Low)
	if err != nil {
		api.WriteError(w, api.Errf(http.StatusBadRequest, api.CodeBadRequest, "could not draw the QR code: %v", err))
		return
	}
	svg := qrSVG(q)
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{
		"qr":      "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(svg)),
		"url":     b.Text,
		"modules": len(q.Bitmap()) - 8, // without the quiet zone
	})
}

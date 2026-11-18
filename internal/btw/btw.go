// Package btw reads btw links: the bitwrap language's self-sealing share links,
//
//	https://beats.bitwrap.io/p#<CID>.<base64url(deflate(canonical text))>[.<sig>][~<notes>]
//
// (docs/BTW.md in djrust-vevr-se). A link carries a program's canonical text and the CID of it, so
// whoever opens it can check the text is the program the CID names. This package decodes a link and
// recomputes the CID the same way the language does: the share CID (dag-json / sha2-256 / base58btc,
// the JS and Rust canonicalizers: sorted keys, JSON.stringify strings) of
// {"format":1,"text":<text>,"type":"djrust.live"}. It does not use internal/share.CanonicalCID: that
// one HTML-escapes < > & in strings (baked into every existing share-envelope CID), and a btw
// program is full of the angle brackets of `<a b>`, so the two would not agree on it.
//
// It does not parse btw: a text that is not in canonical form (the language's own printer makes it,
// the sender's `share` encodes exactly that) cannot be proved here, and says so (Canonical false when
// the recomputed CID is not the link's). Compiling and playing a program is djrust's, not this
// package's: the browser's wasm engine does not read btw yet.
package btw

import (
	"bytes"
	"compress/flate"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"math/big"
	"strings"
	"unicode/utf8"
)

// MaxText bounds what a link may inflate to.
const MaxText = 1 << 20

// Link is what a link says.
type Link struct {
	CID   string   `json:"cid"`
	Text  string   `json:"program,omitempty"`
	Sig   string   `json:"sig,omitempty"`
	Notes []string `json:"notes_unverified,omitempty"`
}

// Result is a link opened: what it says, and whether it checks out.
type Result struct {
	Link
	// ComputedCID is the CID of the text as the link carries it.
	ComputedCID string `json:"computed_cid,omitempty"`
	// Verified: the text's CID is the link's. The text then is exactly the program the CID names.
	Verified bool     `json:"verified"`
	Warnings []string `json:"warnings,omitempty"`
	Chars    int      `json:"chars"`
}

func unpack(s string) (string, error) {
	s = strings.TrimRight(s, "=")
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return "", fmt.Errorf("not base64url: %w", err)
	}
	r := flate.NewReader(bytes.NewReader(raw))
	defer r.Close()
	out, err := io.ReadAll(io.LimitReader(r, MaxText+1))
	if err != nil {
		return "", fmt.Errorf("does not inflate: %w", err)
	}
	if len(out) > MaxText {
		return "", errors.New("inflates to more than 1 MiB")
	}
	return string(out), nil
}

// Pack is the inverse of unpack (for tests and tools): deflate then base64url.
func Pack(text string) string {
	var b bytes.Buffer
	w, _ := flate.NewWriter(&b, flate.BestCompression)
	_, _ = w.Write([]byte(text))
	_ = w.Close()
	return base64.RawURLEncoding.EncodeToString(b.Bytes())
}

// jsString is JSON.stringify for a string: quotes, backslash and control characters escaped, nothing
// else (no HTML escaping, U+2028 / U+2029 left alone).
func jsString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for i := 0; i < len(s); {
		r, n := utf8.DecodeRuneInString(s[i:])
		switch {
		case r == utf8.RuneError && n == 1:
			b.WriteString(`\ufffd`)
		case r == '"':
			b.WriteString(`\"`)
		case r == '\\':
			b.WriteString(`\\`)
		case r == '\b':
			b.WriteString(`\b`)
		case r == '\f':
			b.WriteString(`\f`)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\r':
			b.WriteString(`\r`)
		case r == '\t':
			b.WriteString(`\t`)
		case r < 0x20:
			fmt.Fprintf(&b, `\u%04x`, r)
		default:
			b.WriteString(s[i : i+n])
		}
		i += n
	}
	b.WriteByte('"')
	return b.String()
}

const base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

func base58(in []byte) string {
	num := new(big.Int).SetBytes(in)
	zero, base, mod := big.NewInt(0), big.NewInt(58), new(big.Int)
	var out []byte
	for num.Cmp(zero) > 0 {
		num.DivMod(num, base, mod)
		out = append([]byte{base58Alphabet[mod.Int64()]}, out...)
	}
	for i := 0; i < len(in) && in[i] == 0; i++ {
		out = append([]byte{'1'}, out...)
	}
	return string(out)
}

// ProgramCID is the CID of canonical program text: SHA-256 of the canonical JSON, as a CIDv1
// (dag-json, sha2-256), base58btc with the z prefix.
func ProgramCID(text string) (string, error) {
	doc := `{"format":1,"text":` + jsString(text) + `,"type":"djrust.live"}`
	h := sha256.Sum256([]byte(doc))
	buf := append([]byte{0x01, 0xa9, 0x02, 0x12, 0x20}, h[:]...)
	return "z" + base58(buf), nil
}

// Parse reads a link, its fragment, `CID.text`, or a bare CID.
func Parse(s string) (Link, error) {
	s = strings.TrimSpace(s)
	frag := s
	if i := strings.Index(s, "#"); i >= 0 {
		frag = s[i+1:]
	}
	sealed, notes, hasNotes := strings.Cut(frag, "~")
	parts := strings.Split(sealed, ".")
	cid := parts[0]
	if cid == "" || strings.Trim(cid, "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz") != "" {
		return Link{}, errors.New("not a btw link or CID (https://beats.bitwrap.io/p#<CID>.<text>)")
	}
	l := Link{CID: cid}
	if len(parts) > 1 && parts[1] != "" {
		t, err := unpack(parts[1])
		if err != nil {
			return Link{}, fmt.Errorf("the link's text %w", err)
		}
		l.Text = t
	}
	if len(parts) > 2 {
		l.Sig = parts[2]
	}
	if hasNotes {
		n, err := unpack(notes)
		if err != nil {
			return Link{}, fmt.Errorf("the link's notes %w", err)
		}
		for _, line := range strings.Split(n, "\n") {
			if line != "" {
				l.Notes = append(l.Notes, line)
			}
		}
	}
	return l, nil
}

// Open decodes a link and checks the text against its CID.
func Open(s string) (Result, error) {
	l, err := Parse(s)
	if err != nil {
		return Result{}, err
	}
	r := Result{Link: l, Chars: len(s)}
	if l.Text == "" {
		r.Warnings = append(r.Warnings, "a CID with no text in it: there is no program to check (look it up in the sender's storage)")
		return r, nil
	}
	c, err := ProgramCID(l.Text)
	if err != nil {
		return Result{}, err
	}
	r.ComputedCID = c
	r.Verified = c == l.CID
	if !r.Verified {
		r.Warnings = append(r.Warnings, fmt.Sprintf("REFUSED: the link says %s but its text is %s. Do not play it.", l.CID, c))
	}
	if l.Sig != "" {
		r.Warnings = append(r.Warnings, "the link carries a signature over the CID: it is the author's wallet's to check, and is not checked here")
	}
	if len(l.Notes) > 0 {
		r.Warnings = append(r.Warnings, "the notes came along unsealed: they are not covered by the CID")
	}
	return r, nil
}

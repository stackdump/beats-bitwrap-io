package compose

import (
	"context"
	"fmt"
	"regexp"
	"strings"
)

// Message is one turn of the conversation sent to the model.
type Message struct {
	Role string // "user" | "model"
	Text string
}

// Usage is what one model call used. Out is candidates + thinking tokens: that is what is billed as output.
type Usage struct {
	In       int
	Out      int
	Thoughts int // the part of Out that was thinking
}

// Model is the text model compose talks to: the Gemini client, or the recorded-fixture FakeModel.
//
// Generate returns the reply text (without any thinking), what the call used, and an error. Usage is
// filled in whenever the service said what was spent, also on an error (a cut-off reply still cost money).
// An error from a model is a *ModelError.
type Model interface {
	Generate(ctx context.Context, system string, messages []Message) (text string, usage Usage, err error)
}

// Kinds of ModelError.
const (
	KindUpstream    = "upstream"     // the service answered with an HTTP error
	KindRateLimited = "rate_limited" // HTTP 429 from the service
	KindAuth        = "auth"         // 401 / 403: the key was refused (our configuration, not the user's problem)
	KindTransport   = "transport"    // no answer: network error, timeout, cancelled
	KindBlocked     = "blocked"      // the prompt or the reply was refused (promptFeedback.blockReason, finishReason SAFETY ...)
	KindMaxTokens   = "max_tokens"   // the reply was cut off at the output limit (thinking counts against it)
	KindBadResponse = "bad_response" // not the JSON we expect, or no candidate at all
)

// ModelError is a failure of one model call. Message is safe to log: it has been through the redactor.
type ModelError struct {
	Kind       string
	Status     int    // upstream HTTP status, 0 when there was none
	Code       string // upstream error status word ("INVALID_ARGUMENT"), when it gave one
	Message    string
	RetryAfter int // seconds, for KindRateLimited
	// Aborted: the request had been sent and we stopped waiting for the answer (the caller hung up, or our own
	// timeout fired), or the answer began and broke off. The service may well have finished the call, and it
	// bills what it generated, so the spend cap must not treat this as a call that cost nothing.
	Aborted bool
}

func (e *ModelError) Error() string {
	var b strings.Builder
	b.WriteString("model: ")
	b.WriteString(e.Kind)
	if e.Status != 0 {
		fmt.Fprintf(&b, " (HTTP %d", e.Status)
		if e.Code != "" {
			b.WriteString(" " + e.Code)
		}
		b.WriteString(")")
	}
	if e.Message != "" {
		b.WriteString(": " + e.Message)
	}
	return b.String()
}

// ---------- redaction ----------

// googleKey is the shape of a Google API key. It is scrubbed from every error text and log field even when
// it is not the key this process was given, because the error body can echo request parts back.
var googleKey = regexp.MustCompile(`AIza[0-9A-Za-z_\-]{20,}`)
var keyParam = regexp.MustCompile(`(?i)([?&]key=)[^&\s"']+`)

// Redactor removes secrets from text before it goes in an error, a log line or a response.
type Redactor struct{ secrets []string }

// NewRedactor knows the given secrets (empty ones are ignored).
func NewRedactor(secrets ...string) *Redactor {
	r := &Redactor{}
	for _, s := range secrets {
		s = strings.TrimSpace(s)
		if len(s) >= 6 {
			r.secrets = append(r.secrets, s)
		}
	}
	return r
}

const redacted = "[redacted]"

// Redact scrubs s.
func (r *Redactor) Redact(s string) string {
	if r != nil {
		for _, k := range r.secrets {
			s = strings.ReplaceAll(s, k, redacted)
			if esc := urlEscape(k); esc != k {
				s = strings.ReplaceAll(s, esc, redacted)
			}
		}
	}
	s = keyParam.ReplaceAllString(s, "${1}"+redacted)
	return googleKey.ReplaceAllString(s, redacted)
}

func urlEscape(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.' || c == '~' {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// clip shortens s to at most n runes, with an ellipsis.
func clip(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

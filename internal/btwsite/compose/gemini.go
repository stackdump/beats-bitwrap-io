package compose

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// DefaultModel is the Gemini model compose uses unless told otherwise (a config value: BTW_MODEL).
const DefaultModel = "gemini-3.8-flash"

// DefaultEndpoint is Google's Generative Language API.
const DefaultEndpoint = "https://generativelanguage.googleapis.com"

// DefaultMaxOutputTokens is generous on purpose: thinking tokens count against maxOutputTokens, so a
// program of ~6k tokens needs the room on top of whatever the model thinks first.
const DefaultMaxOutputTokens = 16384

// DefaultThinking is the thinkingLevel sent (BTW_THINKING). MINIMAL, LOW, MEDIUM and HIGH are accepted.
const DefaultThinking = "LOW"

var thinkingLevels = map[string]bool{"MINIMAL": true, "LOW": true, "MEDIUM": true, "HIGH": true}

// NormalizeThinking upper-cases and validates a thinking level ("" = the default).
func NormalizeThinking(s string) (string, error) {
	s = strings.ToUpper(strings.TrimSpace(s))
	if s == "" {
		return DefaultThinking, nil
	}
	if !thinkingLevels[s] {
		return "", fmt.Errorf("thinking level %q is not one of MINIMAL, LOW, MEDIUM, HIGH", s)
	}
	return s, nil
}

// GeminiOptions configures the Gemini client.
type GeminiOptions struct {
	APIKey          string
	Model           string
	Endpoint        string // "" = Google; tests point at an httptest server
	MaxOutputTokens int
	Thinking        string
	Timeout         time.Duration // per call; default 90 s
	RetryDelay      time.Duration // wait before the one retry of a 500/502/503/504 (nothing is billed for those); default 800 ms, negative = no retry
	HTTPClient      *http.Client
	Redactor        *Redactor // scrubs the key (and key-shaped strings) out of every error text
}

// Gemini is the Model that calls generateContent. It holds the key and never lets it out: the key goes in
// a request header only, and every error text is redacted.
type Gemini struct {
	key      string
	model    string
	endpoint string
	maxOut   int
	think    string
	timeout  time.Duration
	retry    time.Duration
	hc       *http.Client
	red      *Redactor
}

var modelID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

// NewGemini validates the options and makes the client. It does not call the network.
func NewGemini(o GeminiOptions) (*Gemini, error) {
	if strings.TrimSpace(o.APIKey) == "" {
		return nil, errors.New("gemini: no API key")
	}
	m := strings.TrimPrefix(strings.TrimSpace(o.Model), "models/")
	if m == "" {
		m = DefaultModel
	}
	if !modelID.MatchString(m) {
		return nil, fmt.Errorf("gemini: model id %q is not a plain id like %s", m, DefaultModel)
	}
	ep := strings.TrimRight(strings.TrimSpace(o.Endpoint), "/")
	if ep == "" {
		ep = DefaultEndpoint
	}
	if u, err := url.Parse(ep); err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return nil, errors.New("gemini: endpoint must be an http(s) URL")
	}
	th, err := NormalizeThinking(o.Thinking)
	if err != nil {
		return nil, fmt.Errorf("gemini: %w", err)
	}
	g := &Gemini{key: strings.TrimSpace(o.APIKey), model: m, endpoint: ep, maxOut: o.MaxOutputTokens, think: th, timeout: o.Timeout, hc: o.HTTPClient, red: o.Redactor}
	if g.maxOut <= 0 {
		g.maxOut = DefaultMaxOutputTokens
	}
	if g.timeout <= 0 {
		g.timeout = 90 * time.Second
	}
	g.retry = o.RetryDelay
	if g.retry == 0 {
		g.retry = 800 * time.Millisecond
	}
	if g.red == nil {
		g.red = NewRedactor(g.key)
	}
	if g.hc == nil {
		g.hc = &http.Client{
			// The key header must never follow a redirect to somewhere else.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		}
	}
	return g, nil
}

// ModelName is the model id in use.
func (g *Gemini) ModelName() string { return g.model }

// ---------- wire shapes ----------

type gPart struct {
	Text    string `json:"text,omitempty"`
	Thought bool   `json:"thought,omitempty"`
}
type gContent struct {
	Role  string  `json:"role,omitempty"`
	Parts []gPart `json:"parts"`
}
type gRequest struct {
	SystemInstruction *gContent  `json:"systemInstruction,omitempty"`
	Contents          []gContent `json:"contents"`
	GenerationConfig  struct {
		MaxOutputTokens int `json:"maxOutputTokens"`
		ThinkingConfig  struct {
			ThinkingLevel string `json:"thinkingLevel"`
		} `json:"thinkingConfig"`
	} `json:"generationConfig"`
}

// gResponse reads only what compose needs; unknown fields (serviceTier, promptTokensDetails, modelVersion,
// responseId ...) are ignored on purpose.
type gResponse struct {
	Candidates []struct {
		Content      gContent `json:"content"`
		FinishReason string   `json:"finishReason"`
	} `json:"candidates"`
	PromptFeedback struct {
		BlockReason string `json:"blockReason"`
	} `json:"promptFeedback"`
	UsageMetadata struct {
		PromptTokenCount     int `json:"promptTokenCount"`
		CandidatesTokenCount int `json:"candidatesTokenCount"`
		ThoughtsTokenCount   int `json:"thoughtsTokenCount"`
		TotalTokenCount      int `json:"totalTokenCount"`
	} `json:"usageMetadata"`
}

type gError struct {
	Error struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
		Status  string `json:"status"`
	} `json:"error"`
}

// Generate implements Model.
func (g *Gemini) Generate(ctx context.Context, system string, messages []Message) (string, Usage, error) {
	var rq gRequest
	if system != "" {
		rq.SystemInstruction = &gContent{Parts: []gPart{{Text: system}}}
	}
	for _, m := range messages {
		role := "user"
		if m.Role == "model" {
			role = "model"
		}
		rq.Contents = append(rq.Contents, gContent{Role: role, Parts: []gPart{{Text: m.Text}}})
	}
	rq.GenerationConfig.MaxOutputTokens = g.maxOut
	rq.GenerationConfig.ThinkingConfig.ThinkingLevel = g.think
	body, err := json.Marshal(rq)
	if err != nil {
		return "", Usage{}, &ModelError{Kind: KindBadResponse, Message: "could not encode the request"}
	}

	ctx, cancel := context.WithTimeout(ctx, g.timeout)
	defer cancel()
	u := g.endpoint + "/v1beta/models/" + g.model + ":generateContent"

	var resp *http.Response
	var raw []byte
	for try := 0; ; try++ {
		var me *ModelError
		resp, raw, me = g.post(ctx, u, body)
		if me != nil {
			return "", Usage{}, me
		}
		// A busy service (500, 502, 503, 504) is tried once more: those calls are not billed.
		if try == 0 && g.retry > 0 && retryable(resp.StatusCode) {
			select {
			case <-time.After(g.retry):
				continue
			case <-ctx.Done():
			}
		}
		break
	}

	if resp.StatusCode/100 != 2 {
		return "", Usage{}, g.httpError(resp, raw)
	}
	var out gResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", Usage{}, &ModelError{Kind: KindBadResponse, Status: resp.StatusCode, Message: "the reply was not JSON of the expected shape"}
	}
	um := out.UsageMetadata
	use := Usage{In: um.PromptTokenCount, Thoughts: um.ThoughtsTokenCount, Out: um.CandidatesTokenCount + um.ThoughtsTokenCount}
	// totalTokenCount = prompt + candidates + thoughts (+ other categories we do not model): never bill less than it says.
	if um.TotalTokenCount-um.PromptTokenCount > use.Out {
		use.Out = um.TotalTokenCount - um.PromptTokenCount
	}

	if len(out.Candidates) == 0 {
		if br := out.PromptFeedback.BlockReason; br != "" {
			return "", use, &ModelError{Kind: KindBlocked, Status: resp.StatusCode, Message: "the model declined the prompt (blockReason " + sanitizeWord(br) + ")"}
		}
		return "", use, &ModelError{Kind: KindBadResponse, Status: resp.StatusCode, Message: "the reply had no candidate"}
	}
	c := out.Candidates[0]
	var sb strings.Builder
	for _, p := range c.Content.Parts {
		if p.Thought {
			continue
		}
		sb.WriteString(p.Text)
	}
	text := sb.String()
	switch fr := c.FinishReason; fr {
	case "", "STOP", "FINISH_REASON_UNSPECIFIED":
		return text, use, nil
	case "MAX_TOKENS":
		return text, use, &ModelError{Kind: KindMaxTokens, Status: resp.StatusCode,
			Message: "the reply was cut off at the output limit (" + strconv.Itoa(g.maxOut) + " tokens, thinking included)"}
	default:
		return "", use, &ModelError{Kind: KindBlocked, Status: resp.StatusCode, Message: "the model stopped without an answer (finishReason " + sanitizeWord(fr) + ")"}
	}
}

func retryable(status int) bool {
	return status == http.StatusInternalServerError || status == http.StatusBadGateway ||
		status == http.StatusServiceUnavailable || status == http.StatusGatewayTimeout
}

// post sends one request and reads the whole answer (capped at 4 MiB).
func (g *Gemini) post(ctx context.Context, u string, body []byte) (*http.Response, []byte, *ModelError) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(body))
	if err != nil {
		return nil, nil, &ModelError{Kind: KindTransport, Message: g.red.Redact(err.Error())}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-goog-api-key", g.key)
	req.Header.Set("Accept", "application/json")

	resp, err := g.hc.Do(req)
	if err != nil {
		msg := "the model service did not answer"
		switch {
		case errors.Is(ctx.Err(), context.DeadlineExceeded):
			msg = "the model service timed out"
		case errors.Is(ctx.Err(), context.Canceled):
			msg = "the request was cancelled"
		}
		return nil, nil, &ModelError{Kind: KindTransport, Message: msg + ": " + clip(g.red.Redact(err.Error()), 160)}
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, nil, &ModelError{Kind: KindTransport, Message: "reading the reply failed: " + clip(g.red.Redact(err.Error()), 160)}
	}
	return resp, raw, nil
}

func (g *Gemini) httpError(resp *http.Response, raw []byte) *ModelError {
	me := &ModelError{Kind: KindUpstream, Status: resp.StatusCode}
	var ge gError
	if json.Unmarshal(raw, &ge) == nil {
		me.Code = sanitizeWord(ge.Error.Status)
		me.Message = clip(g.red.Redact(ge.Error.Message), 200)
	}
	switch resp.StatusCode {
	case http.StatusTooManyRequests:
		me.Kind = KindRateLimited
		me.RetryAfter = 30
		if n, err := strconv.Atoi(strings.TrimSpace(resp.Header.Get("Retry-After"))); err == nil && n > 0 && n <= 3600 {
			me.RetryAfter = n
		}
	case http.StatusUnauthorized, http.StatusForbidden:
		me.Kind = KindAuth
	}
	return me
}

var wordOnly = regexp.MustCompile(`[^A-Za-z0-9_]`)

// sanitizeWord keeps an enum-like word from the service (blockReason, finishReason, error status) and
// nothing else: it goes in error texts, so it must not carry a payload.
func sanitizeWord(s string) string {
	s = wordOnly.ReplaceAllString(s, "")
	if len(s) > 40 {
		s = s[:40]
	}
	return s
}

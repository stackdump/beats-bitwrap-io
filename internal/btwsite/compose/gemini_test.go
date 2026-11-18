package compose

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
)

const testKey = "AIzaSyD-TESTKEY_abcdefghijklmnopqrstuv12"

// realShape is a generateContent answer as the live service sends it (thought parts, usageMetadata with
// thoughtsTokenCount and the extra fields we do not read: serviceTier, promptTokensDetails, modelVersion ...).
func realShape(parts string, finish string, prompt, cand, thoughts int) string {
	total := prompt + cand + thoughts
	b, _ := json.Marshal(map[string]any{"total": total})
	_ = b
	return `{
 "candidates": [{"content": {"role": "model", "parts": [` + parts + `]}, "finishReason": "` + finish + `", "index": 0}],
 "usageMetadata": {"promptTokenCount": ` + itoa(prompt) + `, "candidatesTokenCount": ` + itoa(cand) + `, "totalTokenCount": ` + itoa(total) + `,
   "thoughtsTokenCount": ` + itoa(thoughts) + `,
   "promptTokensDetails": [{"modality": "TEXT", "tokenCount": ` + itoa(prompt) + `}], "serviceTier": "standard"},
 "modelVersion": "gemini-3.8-flash", "responseId": "abc123", "someFutureField": {"x": [1,2,3]}
}`
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

type captured struct {
	mu     sync.Mutex
	path   string
	method string
	hdr    http.Header
	body   map[string]any
	raw    string
}

func (c *captured) get() (string, string, http.Header, map[string]any, string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.path, c.method, c.hdr, c.body, c.raw
}

func geminiServer(t *testing.T, cap *captured, status int, body string, hdr map[string]string) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		cap.mu.Lock()
		cap.path, cap.method, cap.hdr, cap.raw = r.URL.Path, r.Method, r.Header.Clone(), string(raw)
		_ = json.Unmarshal(raw, &cap.body)
		cap.mu.Unlock()
		for k, v := range hdr {
			w.Header().Set(k, v)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func newGemini(t *testing.T, srv *httptest.Server, mut func(*GeminiOptions)) *Gemini {
	o := GeminiOptions{APIKey: testKey, Model: "gemini-3.8-flash", Endpoint: srv.URL}
	if mut != nil {
		mut(&o)
	}
	g, err := NewGemini(o)
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func TestGeminiRequestShapeAndRealResponse(t *testing.T) {
	var cap captured
	parts := `{"text": "**Planning** the track…", "thought": true}, {"text": "tempo 128\nkey am\n"}, {"thought": true, "text": "more thinking"}, {"text": "deck A: kick x ~ x ~\n"}`
	srv := geminiServer(t, &cap, 200, realShape(parts, "STOP", 11, 20, 58), nil)
	g := newGemini(t, srv, nil)

	text, use, err := g.Generate(context.Background(), "SYSTEM TEXT", []Message{
		{Role: "user", Text: "first"}, {Role: "model", Text: "answer"}, {Role: "user", Text: "repair"}})
	if err != nil {
		t.Fatal(err)
	}
	if text != "tempo 128\nkey am\ndeck A: kick x ~ x ~\n" {
		t.Errorf("text = %q (thought parts must be skipped, the others joined)", text)
	}
	// output = candidates + thoughts: what is billed as output
	if use.In != 11 || use.Out != 78 || use.Thoughts != 58 {
		t.Errorf("usage = %+v", use)
	}

	path, method, hdr, body, _ := cap.get()
	if path != "/v1beta/models/gemini-3.8-flash:generateContent" || method != "POST" {
		t.Errorf("%s %s", method, path)
	}
	if hdr.Get("x-goog-api-key") != testKey || hdr.Get("Content-Type") != "application/json" {
		t.Errorf("headers: %v", hdr)
	}
	if hdr.Get("Authorization") != "" {
		t.Error("the key must go in x-goog-api-key only")
	}
	si := body["systemInstruction"].(map[string]any)["parts"].([]any)[0].(map[string]any)["text"]
	if si != "SYSTEM TEXT" {
		t.Errorf("systemInstruction = %v", body["systemInstruction"])
	}
	cs := body["contents"].([]any)
	if len(cs) != 3 {
		t.Fatalf("contents = %v", cs)
	}
	for i, want := range []struct{ role, text string }{{"user", "first"}, {"model", "answer"}, {"user", "repair"}} {
		c := cs[i].(map[string]any)
		if c["role"] != want.role || c["parts"].([]any)[0].(map[string]any)["text"] != want.text {
			t.Errorf("contents[%d] = %v", i, c)
		}
	}
	gc := body["generationConfig"].(map[string]any)
	if gc["maxOutputTokens"].(float64) != DefaultMaxOutputTokens || gc["thinkingConfig"].(map[string]any)["thinkingLevel"] != "LOW" {
		t.Errorf("generationConfig = %v", gc)
	}
	for _, banned := range []string{"temperature", "topP", "topK"} {
		if _, ok := gc[banned]; ok {
			t.Errorf("%s is ignored on this model and must not be sent", banned)
		}
	}
	if _, ok := body["key"]; ok {
		t.Error("key in the body")
	}
}

func TestGeminiThinkingLevelAndOutputBudgetAreConfig(t *testing.T) {
	var cap captured
	srv := geminiServer(t, &cap, 200, realShape(`{"text":"ok"}`, "STOP", 1, 1, 0), nil)
	g := newGemini(t, srv, func(o *GeminiOptions) {
		o.Thinking = "high"
		o.MaxOutputTokens = 4096
		o.Model = "models/gemini-9-flash"
	})
	if _, _, err := g.Generate(context.Background(), "", []Message{{Role: "user", Text: "x"}}); err != nil {
		t.Fatal(err)
	}
	path, _, _, body, _ := cap.get()
	gc := body["generationConfig"].(map[string]any)
	if gc["thinkingConfig"].(map[string]any)["thinkingLevel"] != "HIGH" || gc["maxOutputTokens"].(float64) != 4096 || path != "/v1beta/models/gemini-9-flash:generateContent" {
		t.Errorf("%s %v", path, gc)
	}
	if _, ok := body["systemInstruction"]; ok {
		t.Error("an empty system prompt should not be sent")
	}
	for _, lv := range []string{"MINIMAL", "low", "Medium", "HIGH", ""} {
		if _, err := NormalizeThinking(lv); err != nil {
			t.Errorf("%q: %v", lv, err)
		}
	}
	if _, err := NormalizeThinking("max"); err == nil {
		t.Error("max accepted")
	}
	for _, bad := range []GeminiOptions{
		{APIKey: ""}, {APIKey: "k", Model: "../x"}, {APIKey: "k", Model: "a b"}, {APIKey: "k", Endpoint: "ftp://x"}, {APIKey: "k", Thinking: "wild"},
	} {
		if _, err := NewGemini(bad); err == nil {
			t.Errorf("accepted %+v", bad)
		}
	}
}

func TestGeminiMaxTokensIsAnErrorWithUsage(t *testing.T) {
	var cap captured
	srv := geminiServer(t, &cap, 200, realShape(`{"text":"tempo 128\nkey a","thought":false}`, "MAX_TOKENS", 900, 12, 15000), nil)
	g := newGemini(t, srv, nil)
	text, use, err := g.Generate(context.Background(), "s", []Message{{Role: "user", Text: "x"}})
	me, ok := err.(*ModelError)
	if !ok || me.Kind != KindMaxTokens {
		t.Fatalf("err = %v", err)
	}
	if text != "tempo 128\nkey a" || use.In != 900 || use.Out != 15012 {
		t.Errorf("text %q usage %+v: a cut-off reply still cost money", text, use)
	}
	// and empty (all budget spent thinking)
	srv2 := geminiServer(t, &cap, 200, `{"candidates":[{"finishReason":"MAX_TOKENS","content":{"role":"model"}}],"usageMetadata":{"promptTokenCount":50,"thoughtsTokenCount":16000,"totalTokenCount":16050}}`, nil)
	text, use, err = newGemini(t, srv2, nil).Generate(context.Background(), "s", []Message{{Role: "user", Text: "x"}})
	if me, ok := err.(*ModelError); !ok || me.Kind != KindMaxTokens || text != "" || use.Out != 16000 {
		t.Fatalf("%v %q %+v", err, text, use)
	}
}

func TestGeminiBlockedPrompt(t *testing.T) {
	var cap captured
	srv := geminiServer(t, &cap, 200, `{"promptFeedback":{"blockReason":"SAFETY","safetyRatings":[{"category":"HARM_CATEGORY_DANGEROUS_CONTENT","probability":"HIGH"}]},"usageMetadata":{"promptTokenCount":33,"totalTokenCount":33}}`, nil)
	_, use, err := newGemini(t, srv, nil).Generate(context.Background(), "s", []Message{{Role: "user", Text: "x"}})
	me, ok := err.(*ModelError)
	if !ok || me.Kind != KindBlocked || !strings.Contains(me.Message, "SAFETY") || use.In != 33 {
		t.Fatalf("%v %+v", err, use)
	}
	// a reply stopped for a safety reason
	srv2 := geminiServer(t, &cap, 200, realShape(`{"text":"partial"}`, "SAFETY", 5, 1, 0), nil)
	text, _, err := newGemini(t, srv2, nil).Generate(context.Background(), "s", []Message{{Role: "user", Text: "x"}})
	if me, ok := err.(*ModelError); !ok || me.Kind != KindBlocked || text != "" {
		t.Fatalf("%v %q", err, text)
	}
	// no candidates and no block reason
	srv3 := geminiServer(t, &cap, 200, `{"usageMetadata":{"promptTokenCount":3}}`, nil)
	if _, _, err := newGemini(t, srv3, nil).Generate(context.Background(), "s", []Message{{Role: "user", Text: "x"}}); err == nil || err.(*ModelError).Kind != KindBadResponse {
		t.Fatalf("%v", err)
	}
	srv4 := geminiServer(t, &cap, 200, `<html>not json</html>`, nil)
	if _, _, err := newGemini(t, srv4, nil).Generate(context.Background(), "s", []Message{{Role: "user", Text: "x"}}); err == nil || err.(*ModelError).Kind != KindBadResponse {
		t.Fatalf("%v", err)
	}
}

func TestGeminiHTTPErrors(t *testing.T) {
	var cap captured
	cases := []struct {
		status int
		hdr    map[string]string
		body   string
		kind   string
		retry  int
	}{
		{429, map[string]string{"Retry-After": "17"}, `{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}`, KindRateLimited, 17},
		{429, nil, `{"error":{"code":429,"message":"quota","status":"RESOURCE_EXHAUSTED"}}`, KindRateLimited, 30},
		{400, nil, `{"error":{"code":400,"message":"API key not valid. Please pass a valid API key. key=` + testKey + `","status":"INVALID_ARGUMENT"}}`, KindUpstream, 0},
		{403, nil, `{"error":{"code":403,"message":"PERMISSION_DENIED for ` + testKey + `","status":"PERMISSION_DENIED"}}`, KindAuth, 0},
		{503, nil, `{"error":{"code":503,"message":"The model is overloaded.","status":"UNAVAILABLE"}}`, KindUpstream, 0},
		{500, nil, `internal error: <html>` + testKey, KindUpstream, 0},
	}
	for _, c := range cases {
		srv := geminiServer(t, &cap, c.status, c.body, c.hdr)
		_, use, err := newGemini(t, srv, func(o *GeminiOptions) { o.RetryDelay = -1 }).Generate(context.Background(), "s", []Message{{Role: "user", Text: "x"}})
		me, ok := err.(*ModelError)
		if !ok {
			t.Fatalf("%d: %v", c.status, err)
		}
		if me.Kind != c.kind || me.Status != c.status || me.RetryAfter != c.retry || use != (Usage{}) {
			t.Errorf("%d: %+v use %+v", c.status, me, use)
		}
		if strings.Contains(me.Error(), testKey) || strings.Contains(me.Message, "TESTKEY") {
			t.Errorf("%d: the key is in the error: %s", c.status, me.Error())
		}
	}
	// the error text is useful without the key
	srv := geminiServer(t, &cap, 400, cases[2].body, nil)
	_, _, err := newGemini(t, srv, nil).Generate(context.Background(), "s", []Message{{Role: "user", Text: "x"}})
	if e := err.Error(); !strings.Contains(e, "HTTP 400") || !strings.Contains(e, "INVALID_ARGUMENT") || !strings.Contains(e, "[redacted]") {
		t.Errorf("%s", e)
	}
}

func TestGeminiTransportFailuresDoNotLeakTheKey(t *testing.T) {
	// nothing listening
	g, err := NewGemini(GeminiOptions{APIKey: testKey, Endpoint: "http://127.0.0.1:1"})
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = g.Generate(context.Background(), "s", []Message{{Role: "user", Text: "x"}})
	me, ok := err.(*ModelError)
	if !ok || me.Kind != KindTransport || strings.Contains(me.Error(), testKey) {
		t.Fatalf("%v", err)
	}
	// slow server, short timeout
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { time.Sleep(300 * time.Millisecond) }))
	defer slow.Close()
	g, _ = NewGemini(GeminiOptions{APIKey: testKey, Endpoint: slow.URL, Timeout: 40 * time.Millisecond})
	start := time.Now()
	_, _, err = g.Generate(context.Background(), "s", []Message{{Role: "user", Text: "x"}})
	if me, ok := err.(*ModelError); !ok || me.Kind != KindTransport || !strings.Contains(me.Message, "timed out") || time.Since(start) > 250*time.Millisecond {
		t.Fatalf("%v after %v", err, time.Since(start))
	}
	// a cancelled context
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err = g.Generate(ctx, "s", []Message{{Role: "user", Text: "x"}}); err == nil {
		t.Fatal("no error for a cancelled context")
	}
}

func TestGeminiDoesNotFollowRedirectsWithTheKey(t *testing.T) {
	var other captured
	target := geminiServer(t, &other, 200, realShape(`{"text":"x"}`, "STOP", 1, 1, 0), nil)
	redir := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/stolen", http.StatusTemporaryRedirect)
	}))
	defer redir.Close()
	g := newGemini(t, redir, nil)
	_, _, err := g.Generate(context.Background(), "s", []Message{{Role: "user", Text: "x"}})
	if err == nil {
		t.Fatal("a redirect was followed")
	}
	if _, _, hdr, _, _ := other.get(); hdr != nil {
		t.Fatalf("the redirect target received a request with headers %v", hdr)
	}
}

func TestRedactor(t *testing.T) {
	r := NewRedactor(testKey, "short", "ab+c/de=12")
	for in, want := range map[string]string{
		"the key " + testKey + " end":              "the key [redacted] end",
		"url ?key=abcdef&x=1":                      "url ?key=[redacted]&x=1",
		"an AIzaSyA1234567890abcdefghijklmn other": "an [redacted] other",
		"form-encoded ab%2Bc%2Fde%3D12 end":        "form-encoded [redacted] end",
		"raw ab+c/de=12 end":                       "raw [redacted] end",
		"nothing here":                             "nothing here",
	} {
		if got := r.Redact(in); got != want {
			t.Errorf("Redact(%q) = %q, want %q", in, got, want)
		}
	}
	var nilR *Redactor
	if nilR.Redact("AIzaSyA1234567890abcdefghijklmn") != "[redacted]" {
		t.Error("a nil redactor still scrubs key-shaped strings")
	}
}

// ---------- the Service over a Gemini that answers like the real one ----------

func TestServiceOverRealShapedGemini(t *testing.T) {
	good := "tempo 128\nkey am\ndeck A: kick x ~ x ~\n"
	bad := "tempo 128\nkey am\ndeck Z: kick x ~ x ~\n"
	var mu sync.Mutex
	var bodies []map[string]any
	n := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		mu.Lock()
		bodies = append(bodies, m)
		n++
		i := n
		mu.Unlock()
		reply, thoughts := bad, 200
		if i > 1 {
			reply, thoughts = good, 120
		}
		txt, _ := json.Marshal(reply)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, realShape(`{"text":"thinking...","thought":true},{"text":`+string(txt)+`}`, "STOP", 3000+i*100, 40, thoughts))
	}))
	defer srv.Close()
	r := newRig(t, rigOpts{noFake: true, mutate: func(o *Options) {
		o.APIKey, o.Endpoint, o.Model, o.Thinking, o.MaxOutputTokens = testKey, srv.URL, "gemini-3.8-flash", "medium", 8000
	}})
	m := mustOK(t, r.post("u1", jbody("dark techno")))
	if m["model"] != "gemini-3.8-flash" || m["composedBy"] != "gemini-3.8-flash" {
		t.Errorf("%v %v", m["model"], m["composedBy"])
	}
	at := m["attempts"].([]any)
	if len(at) != 2 {
		t.Fatalf("%v", at)
	}
	// thinking tokens are billed as output: attempt 1 = 40 + 200, attempt 2 = 40 + 120
	if a := at[0].(map[string]any); a["tokens_in"].(float64) != 3100 || a["tokens_out"].(float64) != 240 {
		t.Errorf("attempt 1: %v", a)
	}
	want := (3100+3200)*1.5/1e6 + (240+160)*7.5/1e6
	if got := m["cost_usd"].(float64); got < want-1e-9 || got > want+1e-9 {
		t.Errorf("cost = %v want %v", got, want)
	}
	// the second request carries the whole conversation, and the thinking level and budget the config asked for
	c := bodies[1]["contents"].([]any)
	if len(c) != 3 || c[1].(map[string]any)["role"] != "model" || !strings.Contains(c[2].(map[string]any)["parts"].([]any)[0].(map[string]any)["text"].(string), "unknown statement") {
		t.Errorf("contents = %v", c)
	}
	gc := bodies[1]["generationConfig"].(map[string]any)
	if gc["thinkingConfig"].(map[string]any)["thinkingLevel"] != "MEDIUM" || gc["maxOutputTokens"].(float64) != 8000 {
		t.Errorf("%v", gc)
	}
	sys := bodies[0]["systemInstruction"].(map[string]any)["parts"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(sys, "btw cheat-sheet (fake)") {
		t.Error("system prompt not sent")
	}
	_ = api.CodeBadRequest
}

func TestGeminiRetriesABusyServiceOnce(t *testing.T) {
	var mu sync.Mutex
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits++
		n := hits
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if n == 1 {
			w.WriteHeader(503)
			_, _ = io.WriteString(w, `{"error":{"code":503,"message":"The model is overloaded.","status":"UNAVAILABLE"}}`)
			return
		}
		_, _ = io.WriteString(w, realShape(`{"text":"tempo 100\n"}`, "STOP", 5, 2, 10))
	}))
	defer srv.Close()
	g := newGemini(t, srv, func(o *GeminiOptions) { o.RetryDelay = time.Millisecond })
	text, use, err := g.Generate(context.Background(), "s", []Message{{Role: "user", Text: "x"}})
	if err != nil || text != "tempo 100\n" || use.Out != 12 || hits != 2 {
		t.Fatalf("%q %+v %v after %d requests", text, use, err, hits)
	}

	// twice busy: the error stands, after exactly two requests
	var n2 int
	always := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		n2++
		mu.Unlock()
		w.WriteHeader(503)
	}))
	defer always.Close()
	g = newGemini(t, always, func(o *GeminiOptions) { o.RetryDelay = time.Millisecond })
	if _, _, err := g.Generate(context.Background(), "s", []Message{{Role: "user", Text: "x"}}); err == nil || err.(*ModelError).Status != 503 || n2 != 2 {
		t.Fatalf("%v after %d requests", err, n2)
	}
	// a rate limit and a bad request are not retried
	for _, st := range []int{429, 400, 403} {
		var n3 int
		s3 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			mu.Lock()
			n3++
			mu.Unlock()
			w.WriteHeader(st)
		}))
		g = newGemini(t, s3, func(o *GeminiOptions) { o.RetryDelay = time.Millisecond })
		_, _, _ = g.Generate(context.Background(), "s", []Message{{Role: "user", Text: "x"}})
		s3.Close()
		if n3 != 1 {
			t.Errorf("status %d was retried (%d requests)", st, n3)
		}
	}
	// a cancelled context during the wait ends it at once
	ctx, cancel := context.WithCancel(context.Background())
	g = newGemini(t, always, func(o *GeminiOptions) { o.RetryDelay = time.Hour })
	go func() { time.Sleep(30 * time.Millisecond); cancel() }()
	start := time.Now()
	_, _, err = g.Generate(ctx, "s", []Message{{Role: "user", Text: "x"}})
	if err == nil || time.Since(start) > 2*time.Second {
		t.Fatalf("%v after %v", err, time.Since(start))
	}
}

package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
	"beats-bitwrap-io/internal/btwsite/limits"
)

func TestComposeGood(t *testing.T) {
	r := newRig(t, rigOpts{})
	w := r.post("eip155:0xabc", jbody("dark techno 128 with an acid line"))
	m := mustOK(t, w)

	for _, k := range []string{"program", "text", "cid", "check", "attempts", "model", "forkedFrom", "license", "composedBy", "header", "render_url", "share_url", "cost_usd", "usage"} {
		if _, ok := m[k]; !ok {
			t.Errorf("response has no %q: %s", k, w.Body.String())
		}
	}
	if v, present := m["forkedFrom"]; !present || v != nil {
		t.Errorf("forkedFrom = %v, want null", v)
	}
	if m["license"] != "CC0-1.0" || m["composedBy"] != "fake-model" || m["model"] != "fake" {
		t.Errorf("provenance: %v %v %v", m["license"], m["composedBy"], m["model"])
	}
	cid := m["cid"].(string)
	if cid == "" || m["render_url"] != "/api/render/"+cid+"?format=opus" {
		t.Errorf("render_url = %v", m["render_url"])
	}
	if !strings.HasPrefix(m["share_url"].(string), "https://btw.example.test/#"+cid) {
		t.Errorf("share_url = %v", m["share_url"])
	}
	hdr := fmt.Sprint(m["header"])
	if !strings.Contains(hdr, "#! license: CC0-1.0") || !strings.Contains(hdr, "#! composed-by: fake-model") || strings.Contains(hdr, "forked-from") {
		t.Errorf("header = %v", hdr)
	}
	at := m["attempts"].([]any)
	if len(at) != 1 || at[0].(map[string]any)["ok"] != true || at[0].(map[string]any)["n"].(float64) != 1 {
		t.Errorf("attempts = %v", at)
	}
	// the fixture says 2310 in, 640 out (210 of them thinking): $1.50 and $7.50 per million
	use := m["usage"].(map[string]any)
	if use["in"].(float64) != 2310 || use["out"].(float64) != 640 {
		t.Errorf("usage = %v", use)
	}
	want := 2310*1.5/1e6 + 640*7.5/1e6
	if got := m["cost_usd"].(float64); got < want-1e-9 || got > want+1e-9 {
		t.Errorf("cost = %v want %v", got, want)
	}
	if got := r.svc.Limiter().Spent(); got < want-1e-9 || got > want+1e-9 {
		t.Errorf("recorded spend = %v", got)
	}

	// stored once, with the provenance, as canonical text
	if len(r.store.puts) != 1 {
		t.Fatalf("puts = %d", len(r.store.puts))
	}
	p := r.store.puts[0]
	if p.CID != cid || p.Meta.License != "CC0-1.0" || p.Meta.ComposedBy != "fake-model" || p.Meta.ForkedFrom != "" ||
		len(p.Meta.PromptSHA) != 64 || p.Meta.Source != "compose" || p.Meta.Visibility != "public" || p.Meta.Created == "" {
		t.Errorf("stored meta = %+v", p.Meta)
	}
	if strings.Contains(p.Text, "#") {
		t.Errorf("stored text is not canonical: %q", p.Text)
	}
	if m["program"] != p.Text {
		t.Errorf("program is not the stored canonical text")
	}

	// the log: one line, with a hash and the first 80 characters, and no raw IP
	logs := allFiles(t, filepath.Join(r.dir, "log"))
	if strings.Count(logs, `"outcome":"ok"`) != 1 {
		t.Fatalf("log: %s", logs)
	}
	for _, must := range []string{`"user":"eip155:0xabc"`, `"prompt_chars":33`, `"prompt_head":"dark techno 128 with an acid line"`, `"model":"fake"`, `"attempts":1`, `"tokens_in":2310`, `"tokens_out":640`, cid} {
		if !strings.Contains(logs, must) {
			t.Errorf("log lacks %s: %s", must, logs)
		}
	}
	if strings.Contains(logs, "192.0.2.1") {
		t.Error("raw IP in the log")
	}
	if strings.Contains(logs, "tempo 128") {
		t.Error("program text in the log")
	}
}

func TestComposeWithHints(t *testing.T) {
	r := newRig(t, rigOpts{})
	body := `{"prompt":"driving","genre":"trance","bpm":138,"key":"F#m","length":64}`
	mustOK(t, r.post("u1", body))
	um := r.fake.Calls()[0].Messages[0].Text
	for _, must := range []string{"driving", "genre: trance", "tempo: 138 BPM", `key f#m`, "about 64 bars", "under 16384 bytes"} {
		if !strings.Contains(um, must) {
			t.Errorf("user message lacks %q:\n%s", must, um)
		}
	}
	mustOK(t, r.post("u1", `{"prompt":"x","length":"short"}`))
	if um := r.fake.Calls()[1].Messages[0].Text; !strings.Contains(um, "short: about 16 to 24 bars") {
		t.Errorf("%s", um)
	}
}

func TestSystemPromptShape(t *testing.T) {
	r := newRig(t, rigOpts{})
	mustOK(t, r.post("u1", jbody("anything")))
	sys := r.fake.Calls()[0].System
	for _, must := range []string{
		"Reply with ONLY the btw program", "no code fences", `Start with the "tempo" line and the "key" line`, "16 steps",
		`"section NAME N bars`, `"arrange"`, "Keep within the requested length",
		"GRAMMAR AND CHEAT-SHEET", "btw cheat-sheet (fake)", // Checker.Cheatsheet()
		"INSTRUMENTS", "voices: wobble-lead, detuned-saw", "kits: drums-808, drums-909", // Checker.Instruments(), compact
		"EXAMPLES", "--- example: short ---", "--- example: song ---", "--- example: ramp ---",
	} {
		if !strings.Contains(sys, must) {
			t.Errorf("system prompt lacks %q", must)
		}
	}
	if strings.Contains(sys, "#!") && strings.Contains(sys[strings.Index(sys, "EXAMPLES"):], "#! name") {
		t.Error("example header lines (#!) must not be shown to the model")
	}
	if !strings.Contains(sys[strings.Index(sys, "EXAMPLES"):], "filter lp 300 -> 2800 over 8 bars") {
		t.Error("the ramp example is missing")
	}
}

func TestRepairSendsDiagnosticsBack(t *testing.T) {
	r := newRig(t, rigOpts{})
	w := r.post("u1", jbody("make it fake-repair please"))
	m := mustOK(t, w)
	at := m["attempts"].([]any)
	if len(at) != 2 {
		t.Fatalf("attempts = %d: %v", len(at), at)
	}
	a1, a2 := at[0].(map[string]any), at[1].(map[string]any)
	if a1["ok"] != false || a1["errors"].(float64) != 1 || a2["ok"] != true {
		t.Errorf("attempts: %v", at)
	}
	d := a1["diagnostics"].([]any)[0].(map[string]any)
	render := d["render"].(string)
	if !strings.Contains(render, "unknown statement") {
		t.Fatalf("diagnostic render = %q", render)
	}

	calls := r.fake.Calls()
	if len(calls) != 2 {
		t.Fatalf("model calls = %d", len(calls))
	}
	msgs := calls[1].Messages
	if len(msgs) != 3 || msgs[0].Role != "user" || msgs[1].Role != "model" || msgs[2].Role != "user" {
		t.Fatalf("second request roles: %+v", msgs)
	}
	if !strings.Contains(msgs[1].Text, "deck Z:") {
		t.Errorf("the model is told what it wrote: %q", msgs[1].Text)
	}
	rep := msgs[2].Text
	for _, must := range []string{render, "line 14, col 1", "help: decks are A and B", "1 error", "complete corrected program only"} {
		if !strings.Contains(rep, must) {
			t.Errorf("repair message lacks %q:\n%s", must, rep)
		}
	}
	// both attempts were paid for
	if got := m["usage"].(map[string]any); got["in"].(float64) != 2310+2890 || got["out"].(float64) != 650+640 {
		t.Errorf("usage = %v", got)
	}
	if got := fmt.Sprint(m["program"]); strings.Contains(got, "deck Z") {
		t.Errorf("the failed attempt leaked into the result: %s", got)
	}
}

func TestUnrepairableIsACleanFourTwentyTwo(t *testing.T) {
	r := newRig(t, rigOpts{})
	w := r.post("u1", jbody("fake-unrepairable"))
	if w.Code != 422 {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	e := decodeErr(t, w)
	if e.Error.Code != api.CodeUnrepairable {
		t.Fatalf("%+v", e)
	}
	var det struct {
		Diagnostics []api.Diagnostic `json:"diagnostics"`
		Attempts    []api.Attempt    `json:"attempts"`
		LastText    string           `json:"last_text"`
		Cost        float64          `json:"cost_usd"`
	}
	if err := json.Unmarshal(e.Error.Details, &det); err != nil {
		t.Fatal(err)
	}
	if len(det.Attempts) != 4 { // the first try and three repair rounds
		t.Fatalf("attempts = %d", len(det.Attempts))
	}
	for i, a := range det.Attempts {
		if a.OK || a.Errors != 1 || a.N != i+1 || len(a.Diagnostics) != 1 {
			t.Errorf("attempt %d: %+v", i, a)
		}
	}
	if len(det.Diagnostics) != 1 || !strings.Contains(det.Diagnostics[0].Render, "unknown statement") || !strings.Contains(det.LastText, "deck Z") || det.Cost <= 0 {
		t.Errorf("details: %+v", det)
	}
	if n := len(r.fake.Calls()); n != 4 {
		t.Errorf("model calls = %d", n)
	}
	if len(r.store.puts) != 0 {
		t.Error("an unrepairable program must not be stored")
	}
	if r.svc.Limiter().Spent() <= 0 {
		t.Error("the four attempts cost money and must be recorded")
	}
	if !strings.Contains(allFiles(t, filepath.Join(r.dir, "log")), `"outcome":"unrepairable"`) {
		t.Error("outcome not logged")
	}

	// MaxRepair is configurable, and 0 repair rounds is one attempt
	r2 := newRig(t, rigOpts{mutate: func(o *Options) { o.MaxRepair = -1 }})
	w = r2.post("u1", jbody("fake-repair"))
	if w.Code != 422 || len(r2.fake.Calls()) != 1 {
		t.Fatalf("no-repair: %d, calls %d", w.Code, len(r2.fake.Calls()))
	}
	r3 := newRig(t, rigOpts{mutate: func(o *Options) { o.MaxRepair = 1 }})
	if w = r3.post("u1", jbody("fake-unrepairable")); w.Code != 422 || len(r3.fake.Calls()) != 2 {
		t.Fatalf("one repair: %d, calls %d", w.Code, len(r3.fake.Calls()))
	}
}

func TestWarningsDoNotFailAProgram(t *testing.T) {
	m := &scriptModel{steps: []scriptStep{{text: "tempo 120\nkey am\n# WARN\ndeck A: kick x ~ x ~\n", use: Usage{In: 100, Out: 50}}}}
	r := newRig(t, rigOpts{mutate: func(o *Options) { o.FakeModel = m }})
	res := mustOK(t, r.post("u1", jbody("x")))
	at := res["attempts"].([]any)
	if len(at) != 1 || at[0].(map[string]any)["ok"] != true {
		t.Fatalf("%v", at)
	}
	if d := at[0].(map[string]any)["diagnostics"]; d == nil {
		t.Error("a warning should be reported in the attempt")
	}
}

func TestModelErrorsAreCleanBadGateways(t *testing.T) {
	r := newRig(t, rigOpts{})
	for _, tc := range []struct{ prompt, wantMsg string }{
		{"fake-error", "model service returned an error (HTTP 503)"},
		{"fake-blocked", "declined"},
	} {
		w := r.post("u1", jbody(tc.prompt))
		if w.Code != 502 {
			t.Fatalf("%s: status %d: %s", tc.prompt, w.Code, w.Body.String())
		}
		e := decodeErr(t, w)
		if e.Error.Code != api.CodeModelError || !strings.Contains(e.Error.Message, tc.wantMsg) {
			t.Errorf("%s: %+v", tc.prompt, e)
		}
		if strings.Contains(w.Body.String(), "overloaded") {
			t.Errorf("upstream words reached the user: %s", w.Body.String())
		}
	}
	// the blocked prompt still costs its few tokens
	if r.svc.Limiter().Spent() <= 0 {
		t.Error("blocked call not recorded")
	}
}

func TestMaxTokensIsAFailedAttemptTheModelIsToldAbout(t *testing.T) {
	r := newRig(t, rigOpts{})
	m := mustOK(t, r.post("u1", jbody("fake-max-tokens")))
	at := m["attempts"].([]any)
	if len(at) != 2 || at[0].(map[string]any)["ok"] != false || at[1].(map[string]any)["ok"] != true {
		t.Fatalf("%v", at)
	}
	d := at[0].(map[string]any)["diagnostics"].([]any)[0].(map[string]any)
	if !strings.Contains(d["message"].(string), "cut off") {
		t.Errorf("%v", d)
	}
	rep := r.fake.Calls()[1].Messages[2].Text
	if !strings.Contains(rep, "cut off") || !strings.Contains(rep, "shorter program") {
		t.Errorf("the model is not told to be shorter: %s", rep)
	}
	if msg := r.fake.Calls()[1].Messages[1].Text; strings.Contains(msg, "let kk") {
		t.Errorf("the truncated text should not be sent back: %q", msg)
	}
	// thinking tokens are output tokens: 16384 of them were billed
	if got := m["usage"].(map[string]any)["out"].(float64); got != 16384+640 {
		t.Errorf("out = %v", got)
	}
	// every round cut off: a clean 422
	sm := &scriptModel{steps: []scriptStep{{text: "tempo 1", use: Usage{In: 10, Out: 100}, err: &ModelError{Kind: KindMaxTokens, Message: "cut"}}}}
	r2 := newRig(t, rigOpts{mutate: func(o *Options) { o.FakeModel = sm }})
	if w := r2.post("u1", jbody("x")); w.Code != 422 || decodeErr(t, w).Error.Code != api.CodeUnrepairable {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
}

func TestOversizeOutputIsAFailedAttempt(t *testing.T) {
	r := newRig(t, rigOpts{})
	m := mustOK(t, r.post("u1", jbody("fake-oversize")))
	at := m["attempts"].([]any)
	if len(at) != 2 || at[0].(map[string]any)["ok"] != false {
		t.Fatalf("%v", at)
	}
	d := at[0].(map[string]any)["diagnostics"].([]any)[0].(map[string]any)["message"].(string)
	if !strings.Contains(d, "bytes; the limit is 16384") {
		t.Errorf("%q", d)
	}
	if msg := r.fake.Calls()[1].Messages[1].Text; len(msg) > 200 {
		t.Errorf("a 20 KB reply should not be sent back whole (%d bytes)", len(msg))
	}
}

func TestEmptyAndRestrictedOutputsAreFailedAttempts(t *testing.T) {
	good := "tempo 120\nkey am\ndeck A: kick x ~ x ~\n"
	sm := &scriptModel{steps: []scriptStep{
		{text: "   \n", use: Usage{In: 5, Out: 1}},
		{text: "tempo 120\nkey am\nuse restricted\ndeck A: kick x ~ x ~\n", use: Usage{In: 5, Out: 1}},
		{text: "tempo 120\nkey am\nsample kick.wav\n", use: Usage{In: 5, Out: 1}},
		{text: good, use: Usage{In: 5, Out: 1}},
	}}
	r := newRig(t, rigOpts{mutate: func(o *Options) { o.FakeModel = sm }})
	m := mustOK(t, r.post("u1", jbody("x")))
	if at := m["attempts"].([]any); len(at) != 4 {
		t.Fatalf("%v", at)
	}
	if !strings.Contains(sm.calls[1].Messages[2].Text, "no program") ||
		!strings.Contains(sm.calls[2].Messages[len(sm.calls[2].Messages)-1].Text, "restricted") {
		t.Errorf("the model was not told: %+v", sm.calls[2].Messages)
	}
	if len(r.store.puts) != 1 || strings.Contains(r.store.puts[0].Text, "restricted") {
		t.Errorf("puts: %+v", r.store.puts)
	}
}

func TestFencedAndChattyRepliesAreCleaned(t *testing.T) {
	sm := &scriptModel{steps: []scriptStep{{text: "Here is your track:\n\n```btw\ntempo 120\nkey am\ndeck A: kick x ~ x ~\n```\n\nThis has a four-on-the-floor kick. Enjoy!\n", use: Usage{In: 5, Out: 5}}}}
	r := newRig(t, rigOpts{mutate: func(o *Options) { o.FakeModel = sm }})
	m := mustOK(t, r.post("u1", jbody("x")))
	if m["text"] != "tempo 120\nkey am\ndeck A: kick x ~ x ~\n" {
		t.Errorf("text = %q", m["text"])
	}
}

// ---------- auth ----------

func TestAuthRequiredOnEveryPath(t *testing.T) {
	type cfg struct {
		name string
		rig  func(t *testing.T) *rig
	}
	flagOn := func(t *testing.T) *rig {
		r := newRig(t, rigOpts{})
		if err := r.svc.Limiter().SetEnabled(false); err != nil {
			t.Fatal(err)
		}
		return r
	}
	cfgs := []cfg{
		{"fake model", func(t *testing.T) *rig { return newRig(t, rigOpts{}) }},
		{"not configured", func(t *testing.T) *rig { return newRig(t, rigOpts{noFake: true}) }},
		{"kill switch (flag file), fake model", flagOn},
		{"kill switch (flag file), not configured", func(t *testing.T) *rig {
			r := newRig(t, rigOpts{noFake: true})
			_ = r.svc.Limiter().SetEnabled(false)
			return r
		}},
		{"kill switch (env), fake model", func(t *testing.T) *rig { t.Setenv(limits.EnvEnabled, "0"); return newRig(t, rigOpts{}) }},
		{"spend cap hit", func(t *testing.T) *rig {
			return newRig(t, rigOpts{mutate: func(o *Options) { o.Limits.DailySpendUSD = 1e-9 }})
		}},
		{"rate limited user", func(t *testing.T) *rig {
			r := newRig(t, rigOpts{mutate: func(o *Options) { o.Limits.UserHour = 1 }})
			mustOK(t, r.post("u1", jbody("x")))
			return r
		}},
	}
	bodies := []string{"", "{", jbody("dark techno"), jbody(""), `{"prompt":"x","bogus":1}`, jbody(strings.Repeat("x", 5000)), `{"prompt":"x","base_cid":"zNotThere1234567890123456"}`}
	for _, c := range cfgs {
		c := c
		t.Run(c.name, func(t *testing.T) {
			r := c.rig(t)
			before := len(r.chkChecks())
			for _, creds := range []string{"none", "bad credential"} {
				for _, method := range []string{"POST", "GET", "PUT", "DELETE", "OPTIONS", "HEAD"} {
					for _, b := range bodies {
						req := httptest.NewRequest(method, "/api/compose", strings.NewReader(b))
						if creds == "bad credential" {
							req.Header.Set("X-Test-Bad", "1")
						}
						w := httptest.NewRecorder()
						r.svc.Handler(testAuth{}).ServeHTTP(w, req)
						if w.Code != 401 {
							t.Fatalf("%s %s body %.30q: status %d: %s", creds, method, b, w.Code, w.Body.String())
						}
						if method != "HEAD" {
							if e := decodeErr(t, w); e.Error.Code != api.CodeAuthRequired {
								t.Fatalf("code %q", e.Error.Code)
							}
						}
					}
				}
			}
			// an Authenticator that is missing altogether is no user either
			w := httptest.NewRecorder()
			r.svc.Handler(nil).ServeHTTP(w, httptest.NewRequest("POST", "/api/compose", strings.NewReader(jbody("x"))))
			if w.Code != 401 {
				t.Fatalf("nil authenticator: %d", w.Code)
			}
			// and the service method itself refuses a nil user
			if _, err := r.svc.Compose(context.Background(), nil, "203.0.113.1", api.ComposeRequest{Prompt: "x"}); err == nil || err.(*api.Error).Code != api.CodeAuthRequired {
				t.Fatalf("Compose(nil user): %v", err)
			}
			if _, err := r.svc.Compose(context.Background(), &api.User{}, "203.0.113.1", api.ComposeRequest{Prompt: "x"}); err == nil || err.(*api.Error).Code != api.CodeAuthRequired {
				t.Fatalf("Compose(empty user): %v", err)
			}
			if r.fake != nil && len(r.fake.Calls()) > 1 {
				t.Fatalf("the model was called %d times by anonymous requests", len(r.fake.Calls()))
			}
			if len(r.chkChecks()) != before {
				t.Fatal("the checker was used for an anonymous request")
			}
		})
	}
}

func (r *rig) chkChecks() []string { return r.chk.Checked() }

func TestMethodNotAllowedForSignedInUsers(t *testing.T) {
	r := newRig(t, rigOpts{})
	req := httptest.NewRequest("GET", "/api/compose", nil)
	req.Header.Set("X-Test-User", "u1")
	w := httptest.NewRecorder()
	r.svc.Handler(testAuth{}).ServeHTTP(w, req)
	if w.Code != 405 || w.Header().Get("Allow") != "POST" {
		t.Fatalf("%d %v", w.Code, w.Header())
	}
}

// ---------- validation ----------

func TestValidation(t *testing.T) {
	r := newRig(t, rigOpts{mutate: func(o *Options) { o.MaxPromptChars = 50 }})
	for _, tc := range []struct {
		name, body string
		status     int
		code       string
	}{
		{"no prompt", `{}`, 400, api.CodeBadRequest},
		{"blank prompt", `{"prompt":"   "}`, 400, api.CodeBadRequest},
		{"too long", jbody(strings.Repeat("é", 51)), 413, api.CodePromptTooLong},
		{"unknown field", `{"prompt":"x","temperature":2}`, 400, api.CodeBadRequest},
		{"trailing data", `{"prompt":"x"} {"prompt":"y"}`, 400, api.CodeBadRequest},
		{"not json", `prompt=x`, 400, api.CodeBadRequest},
		{"empty body", ``, 400, api.CodeBadRequest},
		{"wrong type", `{"prompt":5}`, 400, api.CodeBadRequest},
		{"huge body", `{"prompt":"` + strings.Repeat("a", 20000) + `"}`, 413, api.CodeTooLarge},
		{"bpm low", `{"prompt":"x","bpm":10}`, 400, api.CodeBadRequest},
		{"bpm high", `{"prompt":"x","bpm":999}`, 400, api.CodeBadRequest},
		{"bad key", `{"prompt":"x","key":"h#"}`, 400, api.CodeBadRequest},
		{"bad length", `{"prompt":"x","length":"huge"}`, 400, api.CodeBadRequest},
		{"length range", `{"prompt":"x","length":500}`, 400, api.CodeBadRequest},
		{"bad genre", `{"prompt":"x","genre":"<script>"}`, 400, api.CodeBadRequest},
		{"bad base", `{"prompt":"x","base_cid":"not a cid"}`, 400, api.CodeBadRequest},
	} {
		w := r.post("u1", tc.body)
		if w.Code != tc.status {
			t.Errorf("%s: status %d: %s", tc.name, w.Code, w.Body.String())
			continue
		}
		if e := decodeErr(t, w); e.Error.Code != tc.code {
			t.Errorf("%s: code %q", tc.name, e.Error.Code)
		}
	}
	// exactly at the limit, with multibyte characters counted as characters; a number for length is fine
	mustOK(t, r.post("u1", jbody(strings.Repeat("é", 50))))
	mustOK(t, r.post("u1", `{"prompt":"x","length":64,"bpm":128.5,"key":"d:dorian","genre":"drum & bass"}`))
	// invalid requests never reach the model, the limits or the spend
	if n := len(r.fake.Calls()); n != 2 {
		t.Errorf("model calls = %d, want 2", n)
	}
	// no quota is spent on a bad request
	r2 := newRig(t, rigOpts{mutate: func(o *Options) { o.Limits.UserHour = 1 }})
	for i := 0; i < 5; i++ {
		r2.post("u1", `{}`)
	}
	mustOK(t, r2.post("u1", jbody("x")))
}

// ---------- rate limits ----------

func TestRateLimitRetryAfterAndWindowReset(t *testing.T) {
	r := newRig(t, rigOpts{mutate: func(o *Options) { o.Limits.UserHour = 2; o.Limits.UserDay = 3 }})
	mustOK(t, r.post("u1", jbody("one")))
	r.clock.Add(10 * time.Minute)
	mustOK(t, r.post("u1", jbody("two")))
	r.clock.Add(10 * time.Minute)
	w := r.post("u1", jbody("three"))
	if w.Code != 429 {
		t.Fatalf("%d: %s", w.Code, w.Body.String())
	}
	e := decodeErr(t, w)
	if e.Error.Code != api.CodeRateLimited || e.Error.RetryAfter != 40*60 {
		t.Fatalf("%+v", e.Error)
	}
	if got := w.Header().Get("Retry-After"); got != "2400" {
		t.Fatalf("Retry-After header = %q", got)
	}
	// another user is not held back
	mustOK(t, r.post("u2", jbody("other")))
	// a refused request used no model and cost nothing
	if n := len(r.fake.Calls()); n != 3 {
		t.Errorf("model calls = %d", n)
	}
	// the window passes (the first call leaves the hour 40 minutes on)
	r.clock.Add(40 * time.Minute)
	mustOK(t, r.post("u1", jbody("three")))
	// the day window (3): used up now, resets 24h after the first call
	r.clock.Add(2 * time.Hour)
	w = r.post("u1", jbody("four"))
	if w.Code != 429 || !strings.Contains(decodeErr(t, w).Error.Message, "daily") {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	r.clock.Add(22 * time.Hour)
	mustOK(t, r.post("u1", jbody("four")))
	if !strings.Contains(allFiles(t, filepath.Join(r.dir, "log")), `"outcome":"rate_limited"`) {
		t.Error("rate_limited outcome not logged")
	}
}

func TestPerIPDayLimit(t *testing.T) {
	r := newRig(t, rigOpts{mutate: func(o *Options) { o.Limits.IPDay = 2 }})
	h := r.svc.Handler(testAuth{})
	post := func(user, ip string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/api/compose", strings.NewReader(jbody("x")))
		req.RemoteAddr = "127.0.0.1:5555" // the reverse proxy: the client is in X-Real-IP
		req.Header.Set("X-Real-IP", ip)
		req.Header.Set("X-Test-User", user)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		return w
	}
	mustOK(t, post("a", "198.51.100.1"))
	mustOK(t, post("b", "198.51.100.1"))
	w := post("c", "198.51.100.1")
	if w.Code != 429 || w.Header().Get("Retry-After") == "" || !strings.Contains(decodeErr(t, w).Error.Message, "per-address") {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	mustOK(t, post("c", "198.51.100.2"))
	r.clock.Add(24*time.Hour + time.Minute)
	mustOK(t, post("c", "198.51.100.1"))
	// the log holds a hash of the address, the same for the same address, and never the address
	logs := allFiles(t, filepath.Join(r.dir, "log"))
	if strings.Contains(logs, "198.51.100") {
		t.Error("raw IP in the log")
	}
	if strings.Count(logs, r.svc.Limiter().HashIP("198.51.100.1")) != 4 {
		t.Errorf("ip hash occurrences: %s", logs)
	}
}

// ---------- spend ----------

func TestSpendCapHitPersistedAndResetAtUTCMidnight(t *testing.T) {
	clock := newTestClock("2026-11-17T23:30:00Z")
	dir := t.TempDir()
	mut := func(o *Options) { o.Limits.DailySpendUSD = 0.02 }
	r := newRig(t, rigOpts{clock: clock, dir: dir, mutate: mut, skipClose: true})
	mustOK(t, r.post("u1", jbody("one")))
	mustOK(t, r.post("u1", jbody("two")))
	w := r.post("u1", jbody("three"))
	if w.Code != 503 {
		t.Fatalf("%d: %s", w.Code, w.Body.String())
	}
	e := decodeErr(t, w)
	if e.Error.Code != api.CodeSpendCap || e.Error.RetryAfter != 30*60 || w.Header().Get("Retry-After") != "1800" {
		t.Fatalf("%+v %v", e.Error, w.Header())
	}
	if n := len(r.fake.Calls()); n != 2 {
		t.Fatalf("the model must not be called past the cap: %d calls", n)
	}
	st := r.svc.Status()
	if !strings.Contains(st.Reason, "used up") || st.SpentUSD < 0.016 || st.DailyCapUSD != 0.02 {
		t.Errorf("status: %+v", st)
	}
	// the cap is not spent on a refused request's quota
	r.svc.Close()

	// a restart (a new Service over the same data dir) still knows
	r2 := newRig(t, rigOpts{clock: clock, dir: dir, mutate: mut})
	if w := r2.post("u1", jbody("after restart")); w.Code != 503 || decodeErr(t, w).Error.Code != api.CodeSpendCap {
		t.Fatalf("after restart: %d %s", w.Code, w.Body.String())
	}
	if got := r2.svc.Status().SpentUSD; got < 0.016 {
		t.Fatalf("spend not restored: %v", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "spend", "2026-11-17.json")); err != nil {
		t.Fatal(err)
	}
	// UTC midnight resets it
	clock.Add(31 * time.Minute)
	mustOK(t, r2.post("u1", jbody("next day")))
	if got := r2.svc.Status().SpentUSD; got > 0.01 {
		t.Fatalf("spend on the new day = %v", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "spend", "2026-11-18.json")); err != nil {
		t.Fatal(err)
	}
}

func TestSpendIsReservedBeforeTheCallSoConcurrentRequestsCannotOvershoot(t *testing.T) {
	fm, _ := DefaultFakeModel()
	gm := &gateModel{inner: fm, entered: make(chan struct{}, 32), release: make(chan struct{})}
	// cap 0.02, a worst case of about 0.009 per call: two calls fit in flight, a third does not
	r := newRig(t, rigOpts{mutate: func(o *Options) { o.FakeModel = gm; o.Limits.DailySpendUSD = 0.02 }})
	const n = 8
	codes := make(chan int, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes <- r.post(fmt.Sprintf("u%d", i), jbody("x")).Code
		}(i)
	}
	// two get in; the other six are refused at once, while those two are still waiting on the model
	for i := 0; i < 2; i++ {
		select {
		case <-gm.entered:
		case <-time.After(5 * time.Second):
			t.Fatal("two calls should have reached the model")
		}
	}
	refused := 0
	for refused < n-2 {
		select {
		case c := <-codes:
			if c != 503 {
				t.Fatalf("code %d while two calls are in flight", c)
			}
			refused++
		case <-time.After(5 * time.Second):
			t.Fatalf("only %d requests were refused", refused)
		}
	}
	close(gm.release)
	wg.Wait()
	close(codes)
	ok := 0
	for c := range codes {
		if c == 200 {
			ok++
		}
	}
	if ok != 2 {
		t.Fatalf("%d requests succeeded, want 2", ok)
	}
	if st := r.svc.Limiter().Stats(); st.ReservedUSD != 0 || st.SpentUSD > 0.02 {
		t.Fatalf("%+v", st)
	}
}

// ---------- kill switch and admin ----------

func TestKillSwitchEnvFileAndAdminEndpoint(t *testing.T) {
	r := newRig(t, rigOpts{})
	mustOK(t, r.post("u1", jbody("works")))

	// the flag file, written by hand, is seen on the very next request
	flag := filepath.Join(r.dir, limits.FlagFile)
	if err := os.WriteFile(flag, []byte("off"), 0o600); err != nil {
		t.Fatal(err)
	}
	w := r.post("u1", jbody("blocked"))
	if w.Code != 503 || decodeErr(t, w).Error.Code != api.CodeDisabled {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	st := r.svc.Status()
	if st.Enabled || !strings.Contains(st.Reason, limits.FlagFile) || !strings.Contains(st.Reason, "enabled") {
		t.Errorf("status: %+v", st)
	}
	if err := os.Remove(flag); err != nil {
		t.Fatal(err)
	}
	mustOK(t, r.post("u1", jbody("works again")))

	// the environment
	t.Setenv(limits.EnvEnabled, "0")
	w = r.post("u1", jbody("env"))
	if w.Code != 503 || decodeErr(t, w).Error.Code != api.CodeDisabled || !strings.Contains(r.svc.Status().Reason, limits.EnvEnabled) {
		t.Fatalf("%d %s %s", w.Code, w.Body.String(), r.svc.Status().Reason)
	}
	t.Setenv(limits.EnvEnabled, "1")
	mustOK(t, r.post("u1", jbody("env cleared")))

	// the admin endpoint
	admin := r.svc.AdminHandler("s3cret-admin")
	do := func(method, path, tok, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		if tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		w := httptest.NewRecorder()
		admin.ServeHTTP(w, req)
		return w
	}
	for _, tok := range []string{"", "wrong", "s3cret-admin-x", "s3cret"} {
		for _, p := range []string{"/api/admin/compose", "/api/admin/stats", "/api/admin/other"} {
			if w := do("POST", p, tok, `{"enabled":false}`); w.Code != 401 {
				t.Fatalf("token %q on %s: %d", tok, p, w.Code)
			}
		}
	}
	if !r.svc.Status().Enabled {
		t.Fatal("an unauthorised request switched compose off")
	}
	req := httptest.NewRequest("POST", "/api/admin/compose", strings.NewReader(`{"enabled":false}`))
	req.Header.Set("Authorization", "s3cret-admin") // not a Bearer header
	if w := httptest.NewRecorder(); func() int { admin.ServeHTTP(w, req); return w.Code }() != 401 {
		t.Fatal("a bare Authorization header was accepted")
	}

	w = do("POST", "/api/admin/compose", "s3cret-admin", `{"enabled":false}`)
	if w.Code != 200 {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	var kill map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &kill)
	if kill["enabled"] != false || kill["disabled_by_file"] != true {
		t.Fatalf("%v", kill)
	}
	if w := r.post("u1", jbody("after admin off")); w.Code != 503 {
		t.Fatalf("admin kill did not stop compose: %d", w.Code)
	}
	// it is a file, so it survives a restart
	r2 := newRig(t, rigOpts{dir: r.dir, clock: r.clock})
	if w := r2.post("u1", jbody("after restart")); w.Code != 503 {
		t.Fatalf("kill switch lost on restart: %d", w.Code)
	}
	w = do("POST", "/api/admin/compose", "s3cret-admin", `{"enabled":true}`)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	mustOK(t, r.post("u1", jbody("back")))

	// bad bodies and methods
	for _, b := range []string{``, `{}`, `{"enabled":"yes"}`, `{"enabled":true,"x":1}`, `{"enabled":true}{"enabled":false}`} {
		if w := do("POST", "/api/admin/compose", "s3cret-admin", b); w.Code != 400 {
			t.Errorf("body %q: %d", b, w.Code)
		}
	}
	if w := do("GET", "/api/admin/compose", "s3cret-admin", ""); w.Code != 405 {
		t.Errorf("GET compose: %d", w.Code)
	}
	if w := do("GET", "/api/admin/nope", "s3cret-admin", ""); w.Code != 404 {
		t.Errorf("unknown: %d", w.Code)
	}

	// the environment cannot be undone from here, and the answer says so
	t.Setenv(limits.EnvEnabled, "0")
	w = do("POST", "/api/admin/compose", "s3cret-admin", `{"enabled":true}`)
	_ = json.Unmarshal(w.Body.Bytes(), &kill)
	if kill["enabled"] != false || kill["disabled_by_env"] != true {
		t.Fatalf("%v", kill)
	}
	t.Setenv(limits.EnvEnabled, "")

	// stats
	w = do("GET", "/api/admin/stats", "s3cret-admin", "")
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var stats struct {
		Enabled bool `json:"enabled"`
		Status  struct {
			Configured bool   `json:"configured"`
			Model      string `json:"model"`
		} `json:"status"`
		Limits struct {
			Requests int            `json:"requests"`
			Outcomes map[string]int `json:"outcomes"`
			Spent    float64        `json:"spent_usd"`
		} `json:"limits"`
		Examples []string `json:"prompt_examples"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &stats); err != nil {
		t.Fatal(err)
	}
	if !stats.Enabled || !stats.Status.Configured || stats.Limits.Outcomes["ok"] < 3 || stats.Limits.Outcomes["disabled"] < 2 || stats.Limits.Spent <= 0 || len(stats.Examples) < 2 {
		t.Fatalf("stats: %s", w.Body.String())
	}

	// no token configured: the endpoints are closed, whatever is sent
	closed := r.svc.AdminHandler("")
	for _, tok := range []string{"", "anything"} {
		req := httptest.NewRequest("POST", "/api/admin/compose", strings.NewReader(`{"enabled":false}`))
		if tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		w := httptest.NewRecorder()
		closed.ServeHTTP(w, req)
		if w.Code != 503 || !r.svc.Status().Enabled {
			t.Fatalf("empty admin token: %d", w.Code)
		}
	}
}

func TestNotConfigured(t *testing.T) {
	r := newRig(t, rigOpts{noFake: true})
	st := r.svc.Status()
	if st.Configured || !st.Enabled || !strings.Contains(st.Reason, "GEMINI_API_KEY") || !strings.Contains(st.Reason, "restart") {
		t.Fatalf("%+v", st)
	}
	w := r.post("u1", jbody("hello"))
	if w.Code != 503 || decodeErr(t, w).Error.Code != api.CodeNotConfigured {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	// validation comes first, and no quota is spent
	if w := r.post("u1", `{}`); w.Code != 400 {
		t.Fatalf("%d", w.Code)
	}
	if st := r.svc.Limiter().Stats(); st.UsersTracked != 0 {
		t.Errorf("quota spent on an unconfigured service: %+v", st)
	}
	// a key makes it configured (Gemini client built, nothing called)
	r2 := newRig(t, rigOpts{noFake: true, mutate: func(o *Options) { o.APIKey = "AIzaSyTESTKEYTESTKEYTESTKEYTESTKEY12345"; o.Model = "gemini-3.8-flash" }})
	if st := r2.svc.Status(); !st.Configured || st.Model != "gemini-3.8-flash" || st.Reason != "" {
		t.Fatalf("%+v", st)
	}
	// "fake" as the model name selects the recorded fixtures with no key
	r3 := newRig(t, rigOpts{noFake: true, mutate: func(o *Options) { o.Model = "fake" }})
	if st := r3.svc.Status(); !st.Configured || st.Model != "fake" {
		t.Fatalf("%+v", st)
	}
	mustOK(t, r3.post("u1", jbody("hello")))
	// bad options are errors at New, not surprises later
	if _, err := New(Options{Checker: &spyChecker{}, Thinking: "ULTRA"}); err == nil {
		t.Error("thinking level ULTRA accepted")
	}
	if _, err := New(Options{}); err == nil {
		t.Error("no checker accepted")
	}
	if _, err := New(Options{Checker: &spyChecker{}, APIKey: "k-key-key-key", Model: "a b/../c"}); err == nil {
		t.Error("bad model id accepted")
	}
}

// ---------- fork ----------

func TestBaseCIDForkRecordsForkedFrom(t *testing.T) {
	r := newRig(t, rigOpts{})
	first := mustOK(t, r.post("u1", jbody("first")))
	baseCID := first["cid"].(string)
	baseText := first["program"].(string)

	w := r.post("u1", fmt.Sprintf(`{"prompt":"add a snare roll","base_cid":%q}`, baseCID))
	m := mustOK(t, w)
	if m["forkedFrom"] != baseCID {
		t.Fatalf("forkedFrom = %v", m["forkedFrom"])
	}
	hdr := fmt.Sprint(m["header"])
	if !strings.Contains(hdr, "#! forked-from: "+baseCID) {
		t.Errorf("header = %v", hdr)
	}
	p := r.store.puts[len(r.store.puts)-1]
	if p.Meta.ForkedFrom != baseCID {
		t.Errorf("stored meta = %+v", p.Meta)
	}
	um := r.fake.Calls()[1].Messages[0].Text
	if !strings.Contains(um, "program to modify") || !strings.Contains(um, strings.TrimSpace(baseText)) || !strings.Contains(um, "Requested change: add a snare roll") {
		t.Errorf("the edit request does not carry the base program:\n%s", um)
	}
	if strings.Contains(um, "Write a btw program for this request") {
		t.Error("an edit is not a fresh request")
	}

	// an example is a base too, by CID
	exCID := r.ex.list[0].CID
	m = mustOK(t, r.post("u1", fmt.Sprintf(`{"prompt":"faster","base_cid":%q}`, exCID)))
	if m["forkedFrom"] != exCID {
		t.Fatalf("%v", m["forkedFrom"])
	}
}

func TestBaseCIDRefusesUnknownRestrictedPrivateAndNonCC0(t *testing.T) {
	ex := goodExamples()
	ex.add("restricted-ex", "CC0-1.0", "tempo 100\nkey am\nuse restricted\ndeck A: kick x ~ x ~\n")
	ex.add("ccby-ex", "CC-BY-4.0", "tempo 101\nkey am\ndeck A: kick x ~ x ~\n")
	r := newRig(t, rigOpts{examples: ex})

	mk := func(text string, meta api.Meta) string {
		rep, _ := r.chk.Check(context.Background(), text)
		cid := rep.CID
		if cid == "" { // restricted texts still have a fake CID when ok
			t.Fatalf("no cid for %q", text)
		}
		r.store.insert(cid, rep.Canonical, meta)
		return cid
	}
	restricted := mk("tempo 90\nkey am\nuse restricted\ndeck A: kick x ~ x ~\n", api.Meta{License: "CC0-1.0", Visibility: "public"})
	private := mk("tempo 91\nkey am\ndeck A: kick x ~ x ~\n", api.Meta{License: "CC0-1.0", Visibility: "private"})
	ccby := mk("tempo 92\nkey am\ndeck A: kick x ~ x ~\n", api.Meta{License: "CC-BY-4.0", Visibility: "public"})
	assets := mk("tempo 93\nkey am\nsample kick.wav\ndeck A: kick x ~ x ~\n", api.Meta{License: "CC0-1.0", Visibility: "public"})
	exRestricted := ex.list[3].CID
	exCCBY := ex.list[4].CID

	for name, cid := range map[string]string{"unknown": "zUnknownUnknownUnknownUnknown1", "restricted": restricted, "private": private,
		"cc-by": ccby, "assets": assets, "restricted example": exRestricted, "non-CC0 example": exCCBY} {
		w := r.post("u1", fmt.Sprintf(`{"prompt":"edit","base_cid":%q}`, cid))
		if w.Code != 400 || decodeErr(t, w).Error.Code != api.CodeBadRequest {
			t.Errorf("%s: %d %s", name, w.Code, w.Body.String())
		}
	}
	if len(r.fake.Calls()) != 0 {
		t.Error("the model was called with a base that must be refused")
	}
	// the refused request spent no quota and no money
	if st := r.svc.Limiter().Stats(); st.SpentUSD != 0 || st.UsersTracked != 0 {
		t.Errorf("%+v", st)
	}
}

// ---------- provenance header ----------

func TestHeaderNeverInTheCheckedOrCanonicalText(t *testing.T) {
	own := "#! composed-by: some-other-composer\n# my own comment\ntempo 120\nkey am\ndeck A: kick x ~ x ~\n"
	sm := &scriptModel{steps: []scriptStep{{text: own, use: Usage{In: 10, Out: 10}}}}
	r := newRig(t, rigOpts{mutate: func(o *Options) { o.FakeModel = sm }})
	m := mustOK(t, r.post("u1", jbody("x")))

	// what the checker was given as the model's program is the model's text: no header of ours in it
	sawOwn := false
	for _, c := range r.chk.Checked() {
		if c == own {
			sawOwn = true
		}
		for _, h := range []string{"#! composed-by: fake", "#! forked-from"} {
			if strings.Contains(c, h) {
				t.Errorf("the checker was given %q", c)
			}
		}
	}
	if !sawOwn {
		t.Errorf("the model's text was not what was checked: %q", r.chk.Checked())
	}
	// the model's own composed-by comment is kept in text, as it is, and is not in the canonical form
	if !strings.Contains(m["text"].(string), "#! composed-by: some-other-composer") {
		t.Errorf("own comment dropped: %q", m["text"])
	}
	if strings.Contains(m["program"].(string), "#") || strings.Contains(m["program"].(string), "composed-by") {
		t.Errorf("canonical text has comments: %q", m["program"])
	}
	// our header is returned beside the program, with our provenance, not the model's claim
	hdr := m["header"].([]any)
	if len(hdr) != 2 || hdr[0] != "#! license: CC0-1.0" || hdr[1] != "#! composed-by: fake-model" {
		t.Errorf("header = %v", hdr)
	}
	if strings.Contains(m["text"].(string), "#! license") {
		t.Error("our header was inserted into the text")
	}
	// the CID is of the canonical text: the same with and without the header and comments
	bare, _ := r.chk.Check(context.Background(), "tempo 120\nkey am\ndeck A: kick x ~ x ~\n")
	withHdr, _ := r.chk.Check(context.Background(), strings.Join([]string{"#! license: CC0-1.0", "#! composed-by: x"}, "\n")+"\n"+own)
	if m["cid"] != bare.CID || bare.CID != withHdr.CID {
		t.Errorf("cids: %v %v %v", m["cid"], bare.CID, withHdr.CID)
	}
}

// ---------- the key never leaks ----------

// echoServer is a Gemini that fails in the ways Google does, echoing parts of the request, key included.
func echoServer(t *testing.T, status int) (*httptest.Server, *int) {
	var n int
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		n++
		mu.Unlock()
		key := r.Header.Get("x-goog-api-key")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{
			"code": status, "status": "INVALID_ARGUMENT",
			"message": "API key not valid. Please pass a valid API key. (key=" + key + ") request: " + r.URL.String() + "?key=" + key,
		}})
	}))
	t.Cleanup(srv.Close)
	return srv, &n
}

func TestAPIKeyNeverAppearsInResponsesLogsOrErrors(t *testing.T) {
	const key = "AIzaSyD-TESTKEY_abcdefghijklmnopqrstuv12"
	for _, status := range []int{400, 401, 403, 429, 500, 503} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			srv, calls := echoServer(t, status)
			var logbuf strings.Builder
			r := newRig(t, rigOpts{noFake: true, mutate: func(o *Options) {
				o.APIKey, o.Endpoint, o.Model = key, srv.URL, "gemini-3.8-flash"
				o.Logger = newLogger(&logbuf)
			}})
			// the user even pastes the key into the prompt
			w := r.post("u1", jbody(key+" dark techno"))
			if w.Code != 502 {
				t.Fatalf("status %d: %s", w.Code, w.Body.String())
			}
			if *calls != 1 {
				t.Fatalf("calls = %d", *calls)
			}
			if e := decodeErr(t, w); e.Error.Code != api.CodeModelError {
				t.Fatalf("%+v", e)
			}
			if status == 429 && w.Header().Get("Retry-After") == "" {
				t.Error("an upstream 429 should tell the user when to come back")
			}
			everything := w.Body.String() + fmt.Sprint(w.Header()) + allFiles(t, r.dir) + logbuf.String()
			if strings.Contains(everything, key) || strings.Contains(everything, "TESTKEY") {
				t.Fatalf("the key leaked:\n%s", everything)
			}
			// the failure is logged, redacted, with the upstream status
			logs := allFiles(t, filepath.Join(r.dir, "log"))
			if !strings.Contains(logs, `"outcome":"model_error"`) || !strings.Contains(logs, fmt.Sprintf("HTTP %d", status)) {
				t.Errorf("log: %s", logs)
			}
			if !strings.Contains(logs, "[redacted]") {
				t.Errorf("the key in the prompt head was not redacted: %s", logs)
			}
			// a failed call costs nothing recorded as spend beyond the input estimate
			if sp := r.svc.Limiter().Spent(); sp != 0 {
				t.Errorf("spend = %v after an HTTP error", sp)
			}
		})
	}
}

func TestStatusAndAdminNeverExposeTheKey(t *testing.T) {
	const key = "AIzaSyD-TESTKEY_abcdefghijklmnopqrstuv12"
	r := newRig(t, rigOpts{noFake: true, mutate: func(o *Options) { o.APIKey = key }})
	b, _ := json.Marshal(r.svc.Status())
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/admin/stats", nil)
	req.Header.Set("Authorization", "Bearer tok")
	r.svc.AdminHandler("tok").ServeHTTP(w, req)
	if strings.Contains(string(b)+w.Body.String(), key) || strings.Contains(string(b)+w.Body.String(), "TESTKEY") {
		t.Fatal("the key is in the status")
	}
}

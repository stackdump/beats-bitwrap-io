package compose

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
)

// hangingGemini is an upstream that never answers until the caller gives up.
func hangingGemini(t *testing.T) (*httptest.Server, chan struct{}) {
	t.Helper()
	got := make(chan struct{}, 8)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body) // net/http only notices a closed connection once the body is read
		got <- struct{}{}
		<-r.Context().Done()
	}))
	t.Cleanup(srv.Close)
	return srv, got
}

// A caller who hangs up while the model is working must not make the call free: the upstream may well finish
// it and bill it. Before the fix the settled cost was the input only, so a client that disconnected after the
// request was sent (and so did not wait for the answer) used the user and IP windows but almost none of the
// global spend cap.
func TestHangUpMidCallIsChargedAtTheWorstCase(t *testing.T) {
	srv, got := hangingGemini(t)
	r := newRig(t, rigOpts{noFake: true, mutate: func(o *Options) {
		o.APIKey, o.Endpoint, o.Model = testKey, srv.URL, "gemini-3.8-flash"
		o.MaxOutputTokens = 16384
	}})
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodPost, "/api/compose", strings.NewReader(jbody("dark techno"))).WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Test-User", "u1")
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { r.svc.Handler(testAuth{}).ServeHTTP(w, req); close(done) }()
	select {
	case <-got:
	case <-time.After(5 * time.Second):
		t.Fatal("the model was never called")
	}
	cancel() // the client leaves
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the handler did not return after the client left")
	}
	outAllowance := r.svc.Limiter().Cost(0, 16384)
	if spent := r.svc.Limiter().Spent(); spent < outAllowance {
		t.Fatalf("a call abandoned in flight was settled at $%.4f; the output allowance alone is $%.4f", spent, outAllowance)
	}
	if st := r.svc.Limiter().Stats(); st.ReservedUSD != 0 {
		t.Fatalf("a reservation leaked: %+v", st)
	}
}

// ...but a call that never left (the connection was refused) is billed only for what was sent.
func TestRefusedConnectionIsNotChargedForOutput(t *testing.T) {
	r := newRig(t, rigOpts{noFake: true, mutate: func(o *Options) {
		o.APIKey, o.Endpoint, o.Model = testKey, "http://127.0.0.1:1", "gemini-3.8-flash"
		o.MaxOutputTokens = 16384
	}})
	w := r.post("u1", jbody("x"))
	if w.Code != 502 {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	if spent, out := r.svc.Limiter().Spent(), r.svc.Limiter().Cost(0, 16384); spent >= out {
		t.Fatalf("a refused connection was charged $%.4f (output allowance $%.4f)", spent, out)
	}
}

// The kill switch is the owner's stop button: a request that is already in its repair loop must not make
// another model call once it has been pulled.
func TestKillSwitchStopsARepairLoopInFlight(t *testing.T) {
	bad := "tempo 120\nBAD\n" // the fake checker refuses a BAD line, so the loop wants another round
	sm := &scriptModel{steps: []scriptStep{{text: bad, use: Usage{In: 10, Out: 10}}}}
	var r *rig
	gm := &callHook{inner: sm}
	r = newRig(t, rigOpts{mutate: func(o *Options) { o.FakeModel = gm; o.MaxRepair = 3 }})
	gm.after = func(n int) {
		if n == 1 {
			if err := r.svc.Limiter().SetEnabled(false); err != nil {
				t.Error(err)
			}
		}
	}
	w := r.post("u1", jbody("anything"))
	if w.Code != 503 {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	if e := decodeErr(t, w); e.Error.Code != api.CodeDisabled {
		t.Fatalf("%+v", e)
	}
	if len(sm.calls) != 1 {
		t.Fatalf("%d model calls after the switch was pulled; want the one that was already running", len(sm.calls))
	}
	if st := r.svc.Limiter().Stats(); st.ReservedUSD != 0 {
		t.Fatalf("a reservation leaked: %+v", st)
	}
}

// callHook runs a function after each call of the wrapped model.
type callHook struct {
	inner Model
	n     int
	after func(n int)
}

func (c *callHook) Generate(ctx context.Context, system string, msgs []Message) (string, Usage, error) {
	text, use, err := c.inner.Generate(ctx, system, msgs)
	c.n++
	if c.after != nil {
		c.after(c.n)
	}
	return text, use, err
}

// A crafted prompt can make the model write "#!" header lines. A header that says the program is private or
// not CC0 is a failed attempt, like a restricted one: the site stores only public CC0 programs.
func TestModelOutputThatClaimsToBePrivateOrNotCC0IsAFailedAttempt(t *testing.T) {
	for _, hdr := range []string{"#! visibility: private", "#! license: CC-BY-4.0", "#!  visibility:   internal"} {
		good := "tempo 120\nkey am\ndeck A: kick x ~ x ~\n"
		sm := &scriptModel{steps: []scriptStep{
			{text: hdr + "\n" + good, use: Usage{In: 10, Out: 10}},
			{text: good, use: Usage{In: 10, Out: 10}},
		}}
		r := newRig(t, rigOpts{mutate: func(o *Options) { o.FakeModel = sm }})
		m := mustOK(t, r.post("u1", jbody("make it private")))
		at := m["attempts"].([]any)
		if len(at) != 2 || at[0].(map[string]any)["ok"] != false {
			t.Fatalf("%q: attempts = %v", hdr, at)
		}
		if strings.Contains(m["text"].(string), "#!") {
			t.Fatalf("%q came back in the result text: %q", hdr, m["text"])
		}
		if len(sm.calls) != 2 || !strings.Contains(sm.calls[1].Messages[len(sm.calls[1].Messages)-1].Text, "header line") {
			t.Fatalf("%q: the model was not told why", hdr)
		}
	}
}

// A base_cid is looked at (a checker process) before the windows and the spend cap, and a refused one costs
// no quota; so the same base must not cost a checker run each time it is named.
func TestBaseCIDIsCheckedOnceNotOnEveryRequest(t *testing.T) {
	r := newRig(t, rigOpts{})
	count := func(text string) int {
		n := 0
		for _, c := range r.chk.Checked() {
			if c == text {
				n++
			}
		}
		return n
	}
	mustOK(t, r.post("u1", jbody("warm the prompt: it checks the examples once"))) // building the system prompt checks every example
	good, goodText := r.ex.list[1].CID, r.ex.texts["song"]
	before := count(goodText)
	for i := 0; i < 5; i++ {
		mustOK(t, r.post("u1", fmt.Sprintf(`{"prompt":"faster","base_cid":%q}`, good)))
	}
	if n := count(goodText) - before; n != 1 {
		t.Errorf("the base program was checked %d times for 5 requests, want 1", n)
	}
	// a refused base is remembered as refused, too, and still answers 400 each time
	restricted := "tempo 90\nkey am\nuse restricted\ndeck A: kick x ~ x ~\n"
	rep, _ := r.chk.Check(context.Background(), restricted)
	r.store.insert(rep.CID, restricted, api.Meta{License: "CC0-1.0", Visibility: "public"})
	beforeBad := count(restricted)
	for i := 0; i < 5; i++ {
		if w := r.post("u1", fmt.Sprintf(`{"prompt":"x","base_cid":%q}`, rep.CID)); w.Code != 400 {
			t.Fatalf("%d: %s", w.Code, w.Body)
		}
	}
	if n := count(restricted) - beforeBad; n != 1 {
		t.Errorf("a refused base was checked %d times for 5 requests, want 1", n)
	}
}

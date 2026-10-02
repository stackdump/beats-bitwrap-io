package telemetry

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "telemetry.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

var t0 = time.Date(2026, 10, 2, 20, 0, 0, 0, time.UTC)

func batch(sid string, seq int, events string) string {
	return fmt.Sprintf(`{"v":1,"sid":%q,"seq":%d,"engine":"default",
		"device":{"ua":"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)","cores":6,"memoryGB":4,"mobile":true},
		"audio":{"sampleRate":48000,"baseLatency":0.02},
		"events":[%s]}`, sid, seq, events)
}

func post(t *testing.T, h http.Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/telemetry", strings.NewReader(body)))
	return rec
}

func TestRejects(t *testing.T) {
	h := Handler(newStore(t), nil, "", func() time.Time { return t0 })
	ok := batch("sess-0001", 0, `[0,"play"],[100,"tap",{"on":"canvas"}]`)
	if rec := post(t, h, ok); rec.Code != http.StatusNoContent {
		t.Fatalf("valid batch = %d %s", rec.Code, rec.Body)
	}
	bad := map[string]string{
		"unknown kind":  batch("sess-0002", 0, `[0,"keylog",{"k":"a"}]`),
		"nested data":   batch("sess-0003", 0, `[0,"tap",{"on":{"x":1}}]`),
		"long string":   batch("sess-0004", 0, `[0,"tap",{"on":"`+strings.Repeat("x", 60)+`"}]`),
		"negative t":    batch("sess-0005", 0, `[-5,"tap"]`),
		"bad sid":       batch("x", 0, `[0,"tap"]`),
		"no events":     batch("sess-0006", 0, ``),
		"bad engine":    strings.Replace(batch("sess-0007", 0, `[0,"tap"]`), `"default"`, `"tone"`, 1),
		"unknown field": strings.Replace(batch("sess-0008", 0, `[0,"tap"]`), `"seq"`, `"ip":"1.2.3.4","seq"`, 1),
		"control char":  batch("sess-0009", 0, `[0,"tap",{"on":"a\u0001b"}]`),
		"wrong version": strings.Replace(batch("sess-0010", 0, `[0,"tap"]`), `"v":1`, `"v":2`, 1),
	}
	for name, body := range bad {
		if rec := post(t, h, body); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: got %d %s", name, rec.Code, rec.Body)
		}
	}
}

// Late notes that follow taps must show a high tap lift and no focus lift;
// stops right after the page went hidden must be attributed to focus.
func TestSummaryCorrelation(t *testing.T) {
	s := newStore(t)
	h := Handler(s, nil, "", func() time.Time { return t0 })
	var ev []string
	ev = append(ev, `[0,"play"]`)
	// 60 s of play; a tap every 10 s, each followed 300 ms later by a late note.
	for i := 1; i <= 5; i++ {
		tap := float64(i * 10000)
		ev = append(ev, fmt.Sprintf(`[%g,"tap",{"on":"canvas"}]`, tap), fmt.Sprintf(`[%g,"late",{"m":-12}]`, tap+300))
	}
	ev = append(ev, `[55000,"late",{"m":-3}]`) // one unrelated late note
	ev = append(ev, `[60000,"win",{"n":400,"c":"none"}]`)
	ev = append(ev, `[60000,"vis",{"s":"hidden"}]`, `[60050,"stop",{"r":"hidden"}]`)
	ev = append(ev, `[60900,"vis",{"s":"visible"}]`) // back after 850 ms: a blip
	if rec := post(t, h, batch("sess-corr", 0, strings.Join(ev, ","))); rec.Code != http.StatusNoContent {
		t.Fatalf("post = %d %s", rec.Code, rec.Body)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/telemetry/summary", nil))
	var out struct{ Groups []Group }
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || len(out.Groups) != 1 {
		t.Fatalf("summary = %s", rec.Body)
	}
	g := out.Groups[0]
	if g.Platform != "ios" || g.LateNotes != 6 || g.Taps != 5 || g.Notes != 400 || g.Stops["hidden"] != 1 || g.VisHidden != 1 {
		t.Fatalf("group = %+v", g)
	}
	byTrig := func(cs []Correlation, name string) Correlation {
		for _, c := range cs {
			if c.Trigger == name {
				return c
			}
		}
		t.Fatalf("no %s", name)
		return Correlation{}
	}
	tap := byTrig(g.LateAfter, "tap")
	// 5 of 6 late notes within 2 s of a tap; taps cover 5×2 s of 60 s play.
	if tap.Outcomes != 5 || math.Abs(tap.Coverage-10.0/60.05) > 0.01 || tap.Lift < 4.5 {
		t.Fatalf("tap correlation = %+v", tap)
	}
	if f := byTrig(g.LateAfter, "focus"); f.Outcomes != 0 {
		t.Fatalf("focus wrongly blamed for late notes: %+v", f)
	}
	if st := byTrig(g.StopAfter, "focus"); st.Outcomes != 1 || st.Total != 1 {
		t.Fatalf("stop-after-hidden not attributed: %+v", st)
	}
	if g.HiddenReturned != 1 || g.HiddenLeft != 0 || g.HiddenShort != 1 || g.HiddenBlipMs != 850 {
		t.Fatalf("hidden split = returned %d left %d short %d median %v", g.HiddenReturned, g.HiddenLeft, g.HiddenShort, g.HiddenBlipMs)
	}
	if math.Abs(g.PlayMinutes-1.0) > 0.01 {
		t.Fatalf("play minutes = %v", g.PlayMinutes)
	}
}

func TestRawIsSecretGated(t *testing.T) {
	s := newStore(t)
	h := Handler(s, nil, "s3cret", func() time.Time { return t0 })
	post(t, h, batch("sess-raw1", 0, `[0,"play"],[5,"tap",{"on":"play"}]`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/telemetry/session/sess-raw1", nil))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("raw without secret = %d", rec.Code)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/telemetry/session/sess-raw1", nil)
	req.Header.Set("X-Rebuild-Secret", "s3cret")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"tap"`) {
		t.Fatalf("raw with secret = %d %s", rec.Code, rec.Body)
	}
	// Disabled when no secret is configured.
	h2 := Handler(s, nil, "", func() time.Time { return t0 })
	req = httptest.NewRequest(http.MethodGet, "/api/telemetry/sessions", nil)
	req.Header.Set("X-Rebuild-Secret", "")
	rec = httptest.NewRecorder()
	h2.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("raw with empty secret config = %d", rec.Code)
	}
}

func TestLimitsAndRetention(t *testing.T) {
	s := newStore(t)
	lim := NewLimiter(2, 100)
	now := t0
	h := Handler(s, lim, "", func() time.Time { return now })
	for i := 0; i < 2; i++ {
		if rec := post(t, h, batch("sess-lim1", i, `[0,"tap"]`)); rec.Code != http.StatusNoContent {
			t.Fatalf("batch %d = %d", i, rec.Code)
		}
	}
	if rec := post(t, h, batch("sess-lim1", 2, `[0,"tap"]`)); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("third batch in a minute = %d", rec.Code)
	}
	// 31 days later: the next insert purges the old session.
	now = t0.Add(31 * 24 * time.Hour)
	if rec := post(t, h, batch("sess-new1", 0, `[0,"tap"]`)); rec.Code != http.StatusNoContent {
		t.Fatalf("post after a month = %d", rec.Code)
	}
	var n int
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM sessions`).Scan(&n)
	if n != 1 {
		t.Fatalf("sessions after retention purge = %d, want 1", n)
	}
}

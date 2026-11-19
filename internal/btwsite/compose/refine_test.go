package compose

import (
	"context"
	"strings"
	"testing"
)

const warnProg = "tempo 120\nkey am\n# WARN\ndeck A: kick x ~ x ~\n"
const cleanProg = "tempo 120\nkey am\ndeck A: kick x ~ x ~ | hihat x x x x\n"

func attempts(t *testing.T, m map[string]any) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, a := range m["attempts"].([]any) {
		out = append(out, a.(map[string]any))
	}
	return out
}

// A passing program with warnings gets one refine round; a cleaner reply replaces it.
func TestRefineClearsWarnings(t *testing.T) {
	m := &scriptModel{steps: []scriptStep{
		{text: warnProg, use: Usage{In: 100, Out: 50}},
		{text: cleanProg, use: Usage{In: 200, Out: 60}},
	}}
	r := newRig(t, rigOpts{mutate: func(o *Options) { o.FakeModel = m }})
	res := mustOK(t, r.post("u1", jbody("x")))
	at := attempts(t, res)
	if len(at) != 2 || at[0]["ok"] != true || at[1]["ok"] != true || at[1]["refine"] != true {
		t.Fatalf("attempts: %v", at)
	}
	if !strings.Contains(res["text"].(string), "hihat") || strings.Contains(res["text"].(string), "WARN") {
		t.Errorf("the refined program should be the result: %q", res["text"])
	}
	if len(m.calls) != 2 {
		t.Fatalf("model calls = %d", len(m.calls))
	}
	msgs := m.calls[1].Messages
	if len(msgs) != 3 || msgs[1].Role != "model" || !strings.Contains(msgs[1].Text, "WARN") {
		t.Fatalf("refine request: %+v", msgs)
	}
	for _, must := range []string{"passes, but the checker has 1 warning", "a warning", "keeping the music the same"} {
		if !strings.Contains(msgs[2].Text, must) {
			t.Errorf("refine message lacks %q:\n%s", must, msgs[2].Text)
		}
	}
	if u := res["usage"].(map[string]any); u["in"].(float64) != 300 || u["out"].(float64) != 110 {
		t.Errorf("both calls are paid for: %v", u)
	}
	if len(r.store.puts) != 1 {
		t.Errorf("stored %d programs, want only the result", len(r.store.puts))
	}
}

// A refine reply that is no better (or broken) never replaces the passing program.
func TestRefineNeverMakesItWorse(t *testing.T) {
	for name, reply := range map[string]string{
		"same warnings": warnProg,
		"broken":        "tempo 120\nkey am\ndeck Z: kick x\n",
		"empty":         "",
	} {
		t.Run(name, func(t *testing.T) {
			m := &scriptModel{steps: []scriptStep{{text: warnProg, use: Usage{In: 100, Out: 50}}, {text: reply, use: Usage{In: 1, Out: 1}}}}
			r := newRig(t, rigOpts{mutate: func(o *Options) { o.FakeModel = m }})
			res := mustOK(t, r.post("u1", jbody("x")))
			at := attempts(t, res)
			if len(at) != 2 || at[1]["refine"] != true || at[1]["ok"] != false {
				t.Fatalf("attempts: %v", at)
			}
			if !strings.Contains(res["text"].(string), "WARN") {
				t.Errorf("the first program should be kept: %q", res["text"])
			}
		})
	}
}

// No warnings, no refine call; MaxRefine -1 turns refining off.
func TestRefineOnlyWhenWarned(t *testing.T) {
	m := &scriptModel{steps: []scriptStep{{text: cleanProg}}}
	r := newRig(t, rigOpts{mutate: func(o *Options) { o.FakeModel = m }})
	mustOK(t, r.post("u1", jbody("x")))
	if len(m.calls) != 1 {
		t.Errorf("a clean program made %d model calls", len(m.calls))
	}
	m2 := &scriptModel{steps: []scriptStep{{text: warnProg}, {text: cleanProg}}}
	r2 := newRig(t, rigOpts{mutate: func(o *Options) { o.FakeModel = m2; o.MaxRefine = -1 }})
	mustOK(t, r2.post("u1", jbody("x")))
	if len(m2.calls) != 1 {
		t.Errorf("MaxRefine -1 made %d model calls", len(m2.calls))
	}
}

// killAfterFirst pulls the kill switch once the first call has been answered.
type killAfterFirst struct {
	inner *scriptModel
	svc   **Service
}

func (k *killAfterFirst) Generate(ctx context.Context, system string, msgs []Message) (string, Usage, error) {
	text, use, err := k.inner.Generate(ctx, system, msgs)
	_ = (*k.svc).Limiter().SetEnabled(false)
	return text, use, err
}

// The kill switch stops a refine round from starting; the passing program is still the result.
func TestRefineRespectsKillSwitch(t *testing.T) {
	m := &scriptModel{steps: []scriptStep{{text: warnProg}, {text: cleanProg}}}
	var svc *Service
	r := newRig(t, rigOpts{mutate: func(o *Options) { o.FakeModel = &killAfterFirst{inner: m, svc: &svc} }})
	svc = r.svc
	res := mustOK(t, r.post("u1", jbody("x")))
	if len(m.calls) != 1 || !strings.Contains(res["text"].(string), "WARN") {
		t.Errorf("calls %d, text %q", len(m.calls), res["text"])
	}
}

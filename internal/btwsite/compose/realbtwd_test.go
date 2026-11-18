package compose

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"beats-bitwrap-io/internal/btwsite/api"
	"beats-bitwrap-io/internal/btwsite/btwd"
)

// With BTWD_BIN set, the fixtures and the whole pipeline run against the real checker (the fake model still
// stands in for Gemini). Skipped otherwise.
func realChecker(t *testing.T) api.Checker {
	bin := os.Getenv("BTWD_BIN")
	if bin == "" {
		t.Skip("set BTWD_BIN to run against the real btwd")
	}
	c, err := btwd.New(bin, btwd.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestFixturesAndPipelineAgainstRealBtwd(t *testing.T) {
	chk := realChecker(t)
	ctx := context.Background()
	fm, err := LoadFakeModel(testdataDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"good", "repair", "unrepairable", "max_tokens", "oversize"} {
		var fx *Fixture
		for i := range fm.fixtures {
			if fm.fixtures[i].Name == name {
				fx = &fm.fixtures[i]
			}
		}
		for i, st := range fx.Steps {
			if st.Finish == "MAX_TOKENS" {
				continue
			}
			rep, err := chk.Check(ctx, st.Text)
			if err != nil {
				t.Fatal(err)
			}
			wantOK := name == "good" || (name == "repair" && i == 1) || (name == "max_tokens" && i == 1) || (name == "oversize")
			if rep.OK != wantOK || (rep.OK && (rep.Warnings != 0 || rep.Restricted || rep.UsesAssets)) {
				t.Errorf("%s step %d: ok=%v warnings=%d (want ok=%v): %+v", name, i, rep.OK, rep.Warnings, wantOK, rep.Diagnostics)
			}
		}
	}

	// the examples the tests use pass the real checker without warnings
	ex := goodExamples()
	for name, text := range ex.texts {
		if rep, err := chk.Check(ctx, text); err != nil || !rep.OK || rep.Warnings != 0 {
			t.Errorf("example %s: %v %+v", name, err, rep)
		}
	}

	// the whole pipeline: real cheat-sheet, real instrument list, real diagnostics in the repair turn
	dir := t.TempDir()
	r := newRig(t, rigOpts{dir: dir, mutate: func(o *Options) { o.Checker = chk; o.Store = newMemStore(chk) }})
	m := mustOK(t, r.post("u1", jbody("dark techno 128 fake-repair")))
	calls := r.fake.Calls()
	sys := calls[0].System
	t.Logf("system prompt: %d bytes (~%d tokens), user turn %d bytes", len(sys), estimateTokens(sys, nil), len(calls[0].Messages[0].Text))
	for _, must := range []string{"GRAMMAR AND CHEAT-SHEET", "INSTRUMENTS", "voices:", "EXAMPLES", "--- example: short ---"} {
		if !strings.Contains(sys, must) {
			t.Errorf("system prompt lacks %q", must)
		}
	}
	rep := calls[1].Messages[2].Text
	for _, must := range []string{"line 14, col 8", "expected a deck, `A` or `B`, found `Z`", "= expected:"} {
		if !strings.Contains(rep, must) {
			t.Errorf("repair message lacks %q:\n%s", must, rep)
		}
	}
	if m["cid"] == "" || m["cid"] == nil || len(m["attempts"].([]any)) != 2 {
		t.Fatalf("%v", m)
	}
	t.Logf("repair turn:\n%s", rep)
	if got := m["share_url"].(string); !strings.HasPrefix(got, "https://btw.example.test/#"+m["cid"].(string)+".") {
		t.Errorf("share_url = %q", got)
	}
}

// The repository's own examples (btwsite/examples, written by hand, CC0) are what compose shows the model.
// If one stops qualifying (an error, a warning, an asset) it silently drops out of the prompt, so say so here.
func TestRepositoryExamplesQualifyForThePrompt(t *testing.T) {
	chk := realChecker(t)
	dir := filepath.Join("..", "..", "..", "btwsite", "examples")
	exs, texts := loadExamplesDir(t, chk, dir)
	if len(exs) == 0 {
		t.Skip("no examples in " + dir)
	}
	var cands []exampleCand
	for _, e := range exs {
		rep, _ := chk.Check(context.Background(), texts[e.Name])
		why := VetPublicProgram(texts[e.Name], rep, true)
		if e.License != "CC0-1.0" {
			why = "listed license " + e.License
		}
		if why != "" {
			t.Errorf("example %s does not qualify for the compose prompt: %s", e.Name, why)
			continue
		}
		shown := stripHeader(texts[e.Name])
		cands = append(cands, exampleCand{name: e.Name, text: shown, bytes: len(shown), sections: len(rep.Sections), ramp: rampRe.MatchString(shown)})
	}
	got := pickExamples(cands, 9000)
	var names []string
	for _, e := range got {
		names = append(names, e.name)
	}
	t.Logf("%d of %d examples qualify; the prompt gets %v", len(cands), len(exs), names)
	if len(got) < 2 {
		t.Errorf("only %d examples would be shown to the model", len(got))
	}
}

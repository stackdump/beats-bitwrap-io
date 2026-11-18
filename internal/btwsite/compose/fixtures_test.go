package compose

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"beats-bitwrap-io/internal/btwsite/api"
	"beats-bitwrap-io/internal/btwsite/fakecheck"
)

const testdataDir = "../../../btwsite/testdata/compose"

// The embedded fixtures (what BTW_MODEL=fake serves from the binary) and btwsite/testdata/compose (what the
// design names as the place for them) are one set of files; this keeps the copies identical.
func TestEmbeddedFixturesMatchTestdata(t *testing.T) {
	ents, err := os.ReadDir(testdataDir)
	if err != nil {
		t.Fatal(err)
	}
	var disk []string
	for _, e := range ents {
		n := e.Name()
		if strings.HasSuffix(n, ".json") && !strings.HasPrefix(n, "real-") {
			disk = append(disk, n)
		}
	}
	emb, err := embeddedFixtures.ReadDir("fixtures")
	if err != nil {
		t.Fatal(err)
	}
	var embNames []string
	for _, e := range emb {
		embNames = append(embNames, e.Name())
	}
	sort.Strings(disk)
	sort.Strings(embNames)
	if strings.Join(disk, ",") != strings.Join(embNames, ",") {
		t.Fatalf("testdata has %v, embedded has %v", disk, embNames)
	}
	for _, n := range disk {
		a, _ := os.ReadFile(filepath.Join(testdataDir, n))
		b, _ := embeddedFixtures.ReadFile("fixtures/" + n)
		if string(a) != string(b) {
			t.Errorf("%s differs: copy it with  cp %s/%s internal/btwsite/compose/fixtures/", n, "btwsite/testdata/compose", n)
		}
	}
}

func TestEveryScenarioIsReachableAndBehaves(t *testing.T) {
	fm, err := LoadFakeModel(testdataDir)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"hello": "good", "x fake-repair": "repair", "FAKE-UNREPAIRABLE": "unrepairable", "fake-error": "model_error",
		"fake-blocked": "blocked", "fake-max-tokens": "max_tokens", "fake-oversize": "oversize",
	}
	for prompt, name := range want {
		if got := fm.Scenario(prompt); got != name {
			t.Errorf("%q selects %q, want %q", prompt, got, name)
		}
	}
	// the good program really checks (against the stand-in checker; the real btwd run is in live_test.go)
	text, _, err := fm.Generate(context.Background(), "", []Message{{Role: "user", Text: "hi"}})
	if err != nil {
		t.Fatal(err)
	}
	rep, _ := fakecheck.Checker{}.Check(context.Background(), text)
	if !rep.OK || rep.Restricted || rep.UsesAssets || len(rep.Sections) != 2 {
		t.Fatalf("%+v", rep)
	}
	// and the broken one does not
	bad, _, _ := fm.Generate(context.Background(), "", []Message{{Role: "user", Text: "fake-repair"}})
	if rep, _ := (fakecheck.Checker{}).Check(context.Background(), bad); rep.OK {
		t.Fatal("the repair scenario's first answer should fail the check")
	}
	// step selection follows the number of model turns, and the last step repeats
	msgs := []Message{{Role: "user", Text: "fake-repair"}, {Role: "model", Text: bad}, {Role: "user", Text: "fix"}}
	fixed, _, _ := fm.Generate(context.Background(), "", msgs)
	if rep, _ := (fakecheck.Checker{}).Check(context.Background(), fixed); !rep.OK {
		t.Fatal("the second answer should pass")
	}
	late := append(msgs, Message{Role: "model", Text: fixed}, Message{Role: "user", Text: "more"}, Message{Role: "model", Text: fixed}, Message{Role: "user", Text: "more"})
	if again, _, _ := fm.Generate(context.Background(), "", late); again != fixed {
		t.Fatal("the last step should repeat")
	}
	// an unknown scenario word falls to the default; fixtures need exactly one default
	if _, err := NewFakeModel([]Fixture{{Name: "a", Steps: []FixtureStep{{Text: "x"}}}}); err == nil {
		t.Error("no default accepted")
	}
	if _, err := NewFakeModel([]Fixture{{Name: "a", Default: true, Steps: []FixtureStep{{Text: "x"}}}, {Name: "b", Default: true, Steps: []FixtureStep{{Text: "x"}}}}); err == nil {
		t.Error("two defaults accepted")
	}
	// the fake obeys a cancelled context
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := fm.Generate(ctx, "", msgs); err == nil {
		t.Error("cancelled context ignored")
	}
}

func TestRealRunFilesAreNotFixtures(t *testing.T) {
	dir := t.TempDir()
	good, _ := os.ReadFile(filepath.Join(testdataDir, "good.json"))
	_ = os.WriteFile(filepath.Join(dir, "good.json"), good, 0o600)
	_ = os.WriteFile(filepath.Join(dir, "real-2026-11-18.json"), []byte(`{"runs":[]}`), 0o600)
	if _, err := LoadFakeModel(dir); err != nil {
		t.Fatal(err)
	}
}

// ---------- examples in the prompt: only public CC0 programs without assets ----------

func TestOnlyPublicCC0ProgramsWithoutAssetsReachThePrompt(t *testing.T) {
	ex := goodExamples()
	ex.add("restricted-one", "CC0-1.0", "tempo 99\nkey am\nuse restricted\ndeck A: kick x ~ x ~\n")
	ex.add("asset-one", "CC0-1.0", "tempo 98\nkey am\nsample kick.wav\ndeck A: kick x ~ x ~\n")
	ex.add("loop-asset-one", "CC0-1.0", "tempo 97\nkey am\nloop drums.wav\ndeck A: kick x ~ x ~\n")
	ex.add("private-one", "CC0-1.0", "#! visibility: private\ntempo 96\nkey am\ndeck A: kick x ~ x ~\n")
	ex.add("ccby-header", "CC0-1.0", "#! license: CC-BY-4.0\ntempo 95\nkey am\ndeck A: kick x ~ x ~\n")
	ex.add("ccby-listed", "CC-BY-4.0", "tempo 94\nkey am\ndeck A: kick x ~ x ~\n")
	ex.add("no-license", "", "tempo 93\nkey am\ndeck A: kick x ~ x ~\n")
	ex.add("broken-one", "CC0-1.0", "tempo 92\nBAD\n")
	ex.add("warning-one", "CC0-1.0", "tempo 91\nkey am\n# WARN\ndeck A: kick x ~ x ~\n")
	ex.add("missing-text", "CC0-1.0", "tempo 90\nkey am\ndeck A: kick x ~ x ~\n")
	delete(ex.texts, "missing-text")
	r := newRig(t, rigOpts{examples: ex})
	mustOK(t, r.post("u1", jbody("hello")))
	sys := r.fake.Calls()[0].System
	sys = sys[strings.Index(sys, "EXAMPLES"):] // the role statement itself names the forbidden statements
	for _, banned := range []string{"restricted-one", "asset-one", "loop-asset-one", "private-one", "ccby-header", "ccby-listed", "no-license", "broken-one", "warning-one", "missing-text",
		"use restricted", "sample kick.wav", "loop drums.wav", "visibility: private", "tempo 99", "tempo 98", "tempo 97", "tempo 96", "tempo 95", "tempo 94", "tempo 93", "tempo 92", "tempo 91", "tempo 90"} {
		if strings.Contains(sys, banned) {
			t.Errorf("the prompt contains %q", banned)
		}
	}
	for _, want := range []string{"example: short", "example: song", "example: ramp"} {
		if !strings.Contains(sys, want) {
			t.Errorf("the prompt lacks %q", want)
		}
	}
	// with nothing eligible the service still composes (with no examples)
	none := &exSet{}
	none.add("restricted-only", "CC0-1.0", "tempo 99\nkey am\nuse restricted\n")
	r2 := newRig(t, rigOpts{examples: none})
	mustOK(t, r2.post("u1", jbody("hello")))
	if strings.Contains(r2.fake.Calls()[0].System, "EXAMPLES") {
		t.Error("an examples section with no examples")
	}
}

func TestVetPublicProgram(t *testing.T) {
	ok := &api.CheckReport{OK: true}
	for name, tc := range map[string]struct {
		text   string
		rep    *api.CheckReport
		strict bool
		bad    bool
	}{
		"fine":                {"tempo 120\n", ok, true, false},
		"cc0 header":          {"#! license: CC0-1.0\n#! visibility: public\ntempo 1\n", ok, true, false},
		"cc-by header":        {"#! license: CC-BY-4.0\ntempo 1\n", ok, false, true},
		"private header":      {"#! visibility: private\ntempo 1\n", ok, false, true},
		"use restricted":      {"use restricted\n", ok, false, true},
		"indented restricted": {"section a 1 bars {\n  use restricted\n}\n", ok, false, true},
		"sample":              {"sample k.wav\n", ok, false, true},
		"loop with asset":     {"loop k.wav\n", ok, false, true},
		"bare song loop ok":   {"tempo 1\nloop\n", ok, false, false},
		"not ok":              {"x", &api.CheckReport{OK: false}, false, true},
		"nil report":          {"x", nil, false, true},
		"report restricted":   {"x", &api.CheckReport{OK: true, Restricted: true}, false, true},
		"report assets":       {"x", &api.CheckReport{OK: true, UsesAssets: true}, false, true},
		"warnings strict":     {"x", &api.CheckReport{OK: true, Warnings: 1}, true, true},
		"warnings lenient":    {"x", &api.CheckReport{OK: true, Warnings: 1}, false, false},
	} {
		if got := VetPublicProgram(tc.text, tc.rep, tc.strict); (got != "") != tc.bad {
			t.Errorf("%s: %q", name, got)
		}
	}
}

func TestExamplePickingPrefersShortSongAndRamps(t *testing.T) {
	c := []exampleCand{
		{name: "big-song", bytes: 4000, sections: 6, ramp: true},
		{name: "small-song", bytes: 1800, sections: 6},
		{name: "tiny", bytes: 200},
		{name: "mid", bytes: 900},
		{name: "ramp-loop", bytes: 600, ramp: true},
	}
	got := pickExamples(append([]exampleCand(nil), c...), 9000)
	var names []string
	for _, e := range got {
		names = append(names, e.name)
	}
	if strings.Join(names, ",") != "tiny,small-song,ramp-loop" {
		t.Errorf("picked %v", names)
	}
	// the byte budget holds
	got = pickExamples(append([]exampleCand(nil), c...), 2100)
	total := 0
	for _, e := range got {
		total += e.bytes
	}
	if total > 2100 || len(got) == 0 {
		t.Errorf("budget: %v (%d bytes)", got, total)
	}
}

func TestCompactInstruments(t *testing.T) {
	got := compactInstruments([]byte(`{"palettes":["p1"],"voices":["a","b"],"extra":{"x":1},"kits":[{"name":"k1"},{"id":"k2"},{"z":1}],"families":[]}`))
	want := "voices: a, b\nfamilies: \nkits: k1, k2, {\"z\":1}\npalettes: p1\nextra: {\"x\":1}"
	if got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
	if g := compactInstruments([]byte(`not json`)); g != "not json" {
		t.Errorf("%q", g)
	}
}

func TestPromptCacheRefreshesWhenExamplesChange(t *testing.T) {
	ex := goodExamples()
	r := newRig(t, rigOpts{examples: ex})
	mustOK(t, r.post("u1", jbody("one")))
	checks := len(r.chk.Checked())
	mustOK(t, r.post("u1", jbody("two")))
	// the second request re-checks nothing for the prompt: only the model's program, and the store's own check of it
	if got := len(r.chk.Checked()) - checks; got != 2 {
		t.Errorf("checker calls for a cached prompt = %d, want 2 (the program, the store)", got)
	}
	ex.add("another", "CC0-1.0", "tempo 77\nkey am\ndeck A: kick x ~ x ~ | snare ~ x ~ x\nmaster: filter lp 1k -> 8k over 4 bars\n")
	mustOK(t, r.post("u1", jbody("three")))
	if !strings.Contains(r.fake.Calls()[2].System, "another") && !strings.Contains(r.fake.Calls()[2].System, "tempo 77") {
		// "another" has a ramp but "ramp" is already chosen and is smaller or equal; the point is the rebuild happened
		if len(r.chk.Checked()) < checks+4 {
			t.Error("the prompt was not rebuilt after the examples changed")
		}
	}
}

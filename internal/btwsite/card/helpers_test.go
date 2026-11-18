package card

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"

	"beats-bitwrap-io/internal/btwsite/api"
	"beats-bitwrap-io/internal/btwsite/btwd"
	"beats-bitwrap-io/internal/btwsite/fakecheck"
)

// repoRoot finds the worktree root (go.mod).
func repoRoot(t testing.TB) string {
	t.Helper()
	d, _ := os.Getwd()
	for {
		if _, err := os.Stat(filepath.Join(d, "go.mod")); err == nil {
			return d
		}
		p := filepath.Dir(d)
		if p == d {
			t.Fatal("no go.mod above the test directory")
		}
		d = p
	}
}

// testChecker is the real btwd when BTWD_BIN is set, else the fake. kind keys the golden file.
func testChecker(t testing.TB) (c api.Checker, kind string) {
	t.Helper()
	if bin := os.Getenv("BTWD_BIN"); bin != "" {
		cl, err := btwd.New(bin, btwd.Options{})
		if err != nil {
			t.Fatalf("BTWD_BIN: %v", err)
		}
		return cl, "real"
	}
	return fakecheck.Checker{}, "fake"
}

type exampleSet struct {
	list  []api.Example
	texts map[string]string
}

func (e *exampleSet) Examples() []api.Example { return e.list }
func (e *exampleSet) Text(name string) (string, bool) {
	t, ok := e.texts[name]
	return t, ok
}

// loadExamples reads btwsite/examples/*.btw (G3's directory) and fills the CIDs through c.
func loadExamples(t testing.TB, c api.Checker) *exampleSet {
	t.Helper()
	dir := filepath.Join(repoRoot(t), "btwsite", "examples")
	files, _ := filepath.Glob(filepath.Join(dir, "*.btw"))
	if len(files) == 0 {
		t.Skipf("no examples in %s", dir)
	}
	sort.Strings(files)
	es := &exampleSet{texts: map[string]string{}}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		name := strings.TrimSuffix(filepath.Base(f), ".btw")
		rep, err := c.Check(context.Background(), string(b))
		if err != nil || !rep.OK {
			t.Fatalf("example %s does not check: %v %+v", name, err, rep)
		}
		ex := api.Example{Name: name, Title: name, CID: rep.CID, License: "CC0-1.0"}
		if rep.Tempo != nil {
			ex.BPM = *rep.Tempo
		}
		ex.Bars = rep.SongBars
		es.list = append(es.list, ex)
		es.texts[name] = string(b)
	}
	// descriptions from index.json when present
	if b, err := os.ReadFile(filepath.Join(dir, "index.json")); err == nil {
		var idx []struct{ Name, Description string }
		if json.Unmarshal(b, &idx) == nil {
			for _, i := range idx {
				for k := range es.list {
					if es.list[k].Name == i.Name {
						es.list[k].Description = i.Description
					}
				}
			}
		}
	}
	return es
}

func newTestService(t testing.TB, o Options) (*Service, *exampleSet, string) {
	t.Helper()
	if o.Checker == nil {
		var kind string
		o.Checker, kind = testChecker(t)
		_ = kind
	}
	es := loadExamples(t, o.Checker)
	if o.Examples == nil {
		o.Examples, o.ExampleText = es.Examples, es.Text
	}
	if o.PublicURL == "" {
		o.PublicURL = "https://btw.bitwrap.io"
	}
	if o.CacheDir == "" {
		o.CacheDir = t.TempDir()
	}
	s, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	_, kind := testChecker(t)
	return s, es, kind
}

var _ = runtime.GOARCH

// TestDumpCards writes every example's cards (both variants) and the generic ones to $BTW_CARD_DUMP, for looking at.
func TestDumpCards(t *testing.T) {
	dir := os.Getenv("BTW_CARD_DUMP")
	if dir == "" {
		t.Skip("set BTW_CARD_DUMP=<dir> to dump the cards")
	}
	_ = os.MkdirAll(dir, 0o755)
	s, es, kind := newTestService(t, Options{})
	for _, ex := range es.list {
		for _, v := range []Variant{Wide, Square} {
			b, err := s.Render(es.texts[ex.Name], v)
			if err != nil {
				t.Fatalf("%s %v: %v", ex.Name, v, err)
			}
			name := ex.Name + "." + kind + "." + v.String() + ".png"
			if err := os.WriteFile(filepath.Join(dir, name), b, 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	for _, v := range []Variant{Wide, Square} {
		b, err := s.Generic(v)
		if err != nil {
			t.Fatal(err)
		}
		_ = os.WriteFile(filepath.Join(dir, "default."+v.String()+".png"), b, 0o644)
	}
}

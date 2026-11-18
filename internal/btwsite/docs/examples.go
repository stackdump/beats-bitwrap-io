package docs

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"beats-bitwrap-io/internal/btwsite/api"
)

// indexEntry is one element of btwsite/examples/index.json.
type indexEntry struct {
	Name        string   `json:"name"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	BPM         float64  `json:"bpm"`
	Bars        int      `json:"bars"`
	License     string   `json:"license"`
	Tags        []string `json:"tags"`
}

var reExampleName = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

// ExampleSet is the loaded examples: the list (with CIDs filled in), the program texts and the tags.
type ExampleSet struct {
	list  []api.Example
	texts map[string]string
	tags  map[string][]string
}

// List is the examples in index.json order (a copy).
func (e *ExampleSet) List() []api.Example { return append([]api.Example(nil), e.list...) }

// Text is the program text of one example: the file as written, `#!` header lines and comments included.
func (e *ExampleSet) Text(name string) (string, bool) { t, ok := e.texts[name]; return t, ok }

// Tags are the index.json tags of an example.
func (e *ExampleSet) Tags(name string) []string { return append([]string(nil), e.tags[name]...) }

// LoadExamples reads dir/index.json and dir/<name>.btw and fills each example's CID (and, when the program
// says them, its tempo and length) from c. It is the loader the server uses. An example that does not
// check, or that uses samples or `use restricted`, is an error: only public, CC0 programs are examples.
func LoadExamples(dir string, c api.Checker) ([]api.Example, error) {
	set, err := LoadExampleSet(dir, c)
	if err != nil {
		return nil, err
	}
	return set.List(), nil
}

// LoadExampleSet is LoadExamples that also keeps the texts, for Backend.Example and /examples/<name>.btw.
func LoadExampleSet(dir string, c api.Checker) (*ExampleSet, error) {
	raw, err := os.ReadFile(filepath.Join(dir, "index.json"))
	if err != nil {
		return nil, fmt.Errorf("examples: %w", err)
	}
	var idx []indexEntry
	if err := json.Unmarshal(raw, &idx); err != nil {
		return nil, fmt.Errorf("examples: index.json: %w", err)
	}
	set := &ExampleSet{texts: map[string]string{}, tags: map[string][]string{}}
	for _, ie := range idx {
		if !reExampleName.MatchString(ie.Name) {
			return nil, fmt.Errorf("examples: index.json: %q is not a usable example name", ie.Name)
		}
		if _, dup := set.texts[ie.Name]; dup {
			return nil, fmt.Errorf("examples: index.json: %q is listed twice", ie.Name)
		}
		b, err := os.ReadFile(filepath.Join(dir, ie.Name+".btw"))
		if err != nil {
			return nil, fmt.Errorf("examples: %w", err)
		}
		text := string(b)
		if !utf8.ValidString(text) || len(text) > 64<<10 {
			return nil, fmt.Errorf("examples: %s.btw is not UTF-8 text under 64 KiB", ie.Name)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		rep, err := c.Check(ctx, text)
		cancel()
		if err != nil {
			return nil, fmt.Errorf("examples: checking %s: %w", ie.Name, err)
		}
		if !rep.OK {
			msg := "does not check"
			for _, d := range rep.Diagnostics {
				if d.Severity == "error" {
					msg = fmt.Sprintf("%d:%d %s", d.Line, d.Col, d.Message)
					break
				}
			}
			return nil, fmt.Errorf("examples: %s does not check: %s", ie.Name, msg)
		}
		if rep.Restricted || rep.UsesAssets {
			return nil, fmt.Errorf("examples: %s uses samples or `use restricted`: examples are public programs", ie.Name)
		}
		ex := api.Example{Name: ie.Name, Title: ie.Title, Description: ie.Description, CID: rep.CID,
			BPM: ie.BPM, Bars: ie.Bars, License: ie.License}
		if ex.Title == "" {
			ex.Title = ie.Name
		}
		if ex.License == "" {
			ex.License = "CC0-1.0"
		}
		if rep.Tempo != nil && *rep.Tempo > 0 { // the program is the truth, the index is a hint
			ex.BPM = *rep.Tempo
		}
		if rep.SongBars > 0 {
			ex.Bars = rep.SongBars
		}
		set.list = append(set.list, ex)
		set.texts[ie.Name] = text
		set.tags[ie.Name] = ie.Tags
	}
	return set, nil
}

// MountExamples registers GET /api/examples (the list as JSON) and GET /examples/<name>.btw (the program as
// written, text/plain). Mount does not call it: the server package owns these routes and may use this or
// its own; registering both on one mux would panic.
func MountExamples(mux *http.ServeMux, list func() []api.Example, text func(name string) (string, bool)) {
	mux.HandleFunc("GET /api/examples", func(w http.ResponseWriter, r *http.Request) {
		ex := list()
		if ex == nil {
			ex = []api.Example{}
		}
		b, _ := json.Marshal(ex)
		w.Header().Set("Access-Control-Allow-Origin", "*")
		writeBody(w, r, "application/json; charset=utf-8", b)
	})
	mux.HandleFunc("GET /examples/{file}", func(w http.ResponseWriter, r *http.Request) {
		name, ok := strings.CutSuffix(r.PathValue("file"), ".btw")
		if !ok || !reExampleName.MatchString(name) {
			http.NotFound(w, r)
			return
		}
		t, found := text(name)
		if !found {
			http.NotFound(w, r)
			return
		}
		writeBody(w, r, "text/plain; charset=utf-8", []byte(t))
	})
}

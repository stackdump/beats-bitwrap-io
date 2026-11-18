package server

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
)

// exampleSet is the public CC0 examples of btwsite/examples: the list for /api/examples and compose, the raw
// texts for /examples/<name>.btw, and the CID index so an example renders and opens like a stored program.
type exampleSet struct {
	list   []api.Example
	text   map[string]string      // name -> text as in the file
	byCID  map[string]api.Program // cid -> canonical program (for Get, render and cards)
	byName map[string]api.Example
}

type exampleIndexEntry struct {
	Name        string  `json:"name"`
	Title       string  `json:"title"`
	Description string  `json:"description"`
	BPM         float64 `json:"bpm"`
	Bars        int     `json:"bars"`
	License     string  `json:"license"`
}

// loadExamples reads dir: every *.btw, with title/description/license from index.json when it is there.
// A program that does not check, or is restricted or uses assets, is left out (and named in warnings):
// the examples are shipped to a public site and put in prompts, so none of those may get in.
func loadExamples(dir string, c api.Checker) (*exampleSet, []string, error) {
	set := &exampleSet{text: map[string]string{}, byCID: map[string]api.Program{}, byName: map[string]api.Example{}}
	if dir == "" {
		return set, nil, nil
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return set, []string{"examples directory " + dir + " does not exist"}, nil
		}
		return nil, nil, err
	}
	idx := map[string]exampleIndexEntry{}
	var order []string
	if b, err := os.ReadFile(filepath.Join(dir, "index.json")); err == nil {
		var entries []exampleIndexEntry
		if err := json.Unmarshal(b, &entries); err != nil {
			return nil, nil, fmt.Errorf("%s/index.json: %v", dir, err)
		}
		for _, e := range entries {
			idx[e.Name] = e
			order = append(order, e.Name)
		}
	}
	var names []string
	for _, e := range ents {
		if n, ok := strings.CutSuffix(e.Name(), ".btw"); ok && !e.IsDir() && validName(n) {
			names = append(names, n)
		}
	}
	sort.Strings(names)
	// index order first, then the rest alphabetically
	seen := map[string]bool{}
	var all []string
	for _, n := range order {
		for _, have := range names {
			if have == n && !seen[n] {
				seen[n] = true
				all = append(all, n)
			}
		}
	}
	for _, n := range names {
		if !seen[n] {
			all = append(all, n)
		}
	}
	var warns []string
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	for _, n := range all {
		b, err := os.ReadFile(filepath.Join(dir, n+".btw"))
		if err != nil {
			return nil, nil, err
		}
		rep, err := c.Check(ctx, string(b))
		if err != nil {
			return nil, nil, fmt.Errorf("example %s: %v", n, err)
		}
		switch {
		case !rep.OK:
			warns = append(warns, fmt.Sprintf("example %s does not check (%d errors): left out", n, rep.Errors))
			continue
		case rep.Restricted || rep.UsesAssets:
			warns = append(warns, fmt.Sprintf("example %s is restricted or uses assets: left out", n))
			continue
		}
		ie := idx[n]
		ex := api.Example{Name: n, Title: ie.Title, Description: ie.Description, CID: rep.CID, BPM: ie.BPM, Bars: ie.Bars, License: ie.License}
		if ex.Title == "" {
			ex.Title = n
		}
		if ex.License == "" {
			ex.License = "CC0-1.0"
		}
		if ex.BPM == 0 && rep.Tempo != nil {
			ex.BPM = *rep.Tempo
		}
		if ex.Bars == 0 {
			ex.Bars = rep.SongBars
		}
		set.list = append(set.list, ex)
		set.text[n] = string(b)
		set.byName[n] = ex
		set.byCID[rep.CID] = api.Program{CID: rep.CID, Text: rep.Canonical,
			Meta: api.Meta{License: ex.License, Visibility: "public", Name: n, Source: "example"}}
	}
	return set, warns, nil
}

func validName(n string) bool {
	if n == "" || len(n) > 80 {
		return false
	}
	for _, r := range n {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.') {
			return false
		}
	}
	return !strings.HasPrefix(n, ".")
}

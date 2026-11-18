package server

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
	"beats-bitwrap-io/internal/btwsite/docs"
)

// exampleSet is the public CC0 examples of btwsite/examples: the list for /api/examples and compose, the raw
// texts for /examples/<name>.btw, and the CID index so an example renders and opens like a stored program.
type exampleSet struct {
	list   []api.Example
	text   map[string]string      // name -> text as in the file
	byCID  map[string]api.Program // cid -> canonical program (for Get, render and cards)
	byName map[string]api.Example
}

// loadExamples is docs.LoadExampleSet (index.json is the registry; an example that does not check, or is
// restricted or uses assets, is an error: examples are public programs and go into prompts), plus the canonical
// program of each so an example opens, renders and has a card like a stored one. A missing directory is an
// empty list and a warning (a dev checkout without examples still runs).
func loadExamples(dir string, c api.Checker) (*exampleSet, []string, error) {
	set := &exampleSet{text: map[string]string{}, byCID: map[string]api.Program{}, byName: map[string]api.Example{}}
	if dir == "" {
		return set, nil, nil
	}
	loaded, err := docs.LoadExampleSet(dir, c)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return set, []string{"no examples: " + err.Error()}, nil
		}
		return nil, nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	for _, ex := range loaded.List() {
		text, _ := loaded.Text(ex.Name)
		rep, err := c.Check(ctx, text)
		if err != nil {
			return nil, nil, fmt.Errorf("example %s: %v", ex.Name, err)
		}
		set.list = append(set.list, ex)
		set.text[ex.Name] = text
		set.byName[ex.Name] = ex
		set.byCID[ex.CID] = api.Program{CID: ex.CID, Text: rep.Canonical,
			Meta: api.Meta{License: ex.License, Visibility: "public", Name: ex.Name, Source: "example"}}
	}
	return set, nil, nil
}

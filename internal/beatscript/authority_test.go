package beatscript

import (
	"bufio"
	"encoding/json"
	"os"
	"sort"
	"strings"
	"testing"

	"beats-bitwrap-io/internal/generator"
)

// lock is beatscript-authority.lock, parsed.
type lock struct {
	one   map[string]string // key -> rest of line
	terms map[string]bool   // "iri <IRI>" / "ctx <key>"
}

func readLock(t *testing.T) lock {
	t.Helper()
	f, err := os.Open("../../beatscript-authority.lock")
	if err != nil {
		t.Fatalf("the pin is missing: %v (scripts/beatscript-authority.sh sync)", err)
	}
	defer f.Close()
	l := lock{one: map[string]string{}, terms: map[string]bool{}}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, rest, _ := strings.Cut(line, " ")
		if key == "term" {
			f := strings.Fields(rest)
			l.terms[f[0]+" "+f[1]] = true
			continue
		}
		l.one[key] = rest
	}
	return l
}

// The constants beats' code carries are the release the lock pins: drift between the two is a failure, not a surprise.
func TestAuthorityConstantsAreThePinnedRelease(t *testing.T) {
	l := readLock(t)
	for name, c := range map[string][2]string{
		"ontology-version":   {AuthorityOntologyVersion, l.one["ontology-version"]},
		"ontology-namespace": {OntologyNamespace, l.one["ontology-namespace"]},
		"context-url":        {ContextURL, l.one["context-url"]},
		"grammar-url":        {GrammarURL, l.one["grammar-url"]},
	} {
		if c[0] != c[1] {
			t.Errorf("%s: the code says %q, beatscript-authority.lock pins %q", name, c[0], c[1])
		}
	}
	if OntologyBase+"ns#" != OntologyNamespace {
		t.Errorf("OntologyBase %q and OntologyNamespace %q disagree", OntologyBase, OntologyNamespace)
	}
	if v := l.one["ontology-version-iri"]; v != OntologyBase+AuthorityOntologyVersion {
		t.Errorf("ontology-version-iri %q is not %s%s", v, OntologyBase, AuthorityOntologyVersion)
	}
}

// Every name beats points at is one the lock resolved against the authority.
func TestUsedTermsAreAllPinned(t *testing.T) {
	l := readLock(t)
	iris, keys := UsedTerms()
	if len(iris) == 0 || len(keys) == 0 {
		t.Fatal("used-terms.txt is empty")
	}
	for _, i := range iris {
		if !l.terms["iri "+i] {
			t.Errorf("used-terms.txt refers to %s, which the lock does not resolve (scripts/beatscript-authority.sh sync)", i)
		}
	}
	for _, k := range keys {
		if !l.terms["ctx "+k] {
			t.Errorf("used-terms.txt refers to context key %q, which the lock does not resolve", k)
		}
	}
	// and the other way: a lock term nothing refers to is a stale pin
	have := map[string]bool{}
	for _, i := range iris {
		have["iri "+i] = true
	}
	for _, k := range keys {
		have["ctx "+k] = true
	}
	var extra []string
	for k := range l.terms {
		if !have[k] {
			extra = append(extra, k)
		}
	}
	sort.Strings(extra)
	if len(extra) > 0 {
		t.Errorf("the lock pins terms that used-terms.txt does not refer to: %v", extra)
	}
}

// A genre beats can compose has the authority's IRI, or this test names it: a new beats genre is a decision (add it
// upstream, or leave it a plain word and say so in docs/BEATSCRIPT-ADOPTION.md), never a silent gap.
func TestEveryBeatsGenreIsKnownToTheAuthority(t *testing.T) {
	for g := range generator.Genres {
		if GenreIRI(g) == "" {
			t.Errorf("beats genre %q has no BeatScript ontology IRI in used-terms.txt: sync it, or propose it upstream (docs/BEATSCRIPT-ADOPTION.md)", g)
		}
	}
	if got := GenreIRI("Techno"); got != OntologyBase+"genre/techno" {
		t.Errorf("GenreIRI(Techno) = %q", got)
	}
	if GenreIRI("polka") != "" {
		t.Error("an unknown genre must stay a plain word")
	}
}

// What the code can emit uses only the pinned context's keys.
func TestSetNodeUsesPinnedContextTerms(t *testing.T) {
	_, keys := UsedTerms()
	ok := map[string]bool{"@context": true, "@type": true, "@id": true}
	for _, k := range keys {
		ok[k] = true
	}
	n := SetNode("https://beats.bitwrap.io/c/zSET", "my set", 124, []Track{{URL: "https://beats.bitwrap.io/?cid=zA", CID: "zA"}, {URL: "https://beats.bitwrap.io/?cid=zB", CID: "zB"}})
	for k := range n {
		if !ok[k] {
			t.Errorf("SetNode emits %q, which is not a pinned context term", k)
		}
	}
	for _, it := range n["isBasedOn"].([]any) {
		for k := range it.(map[string]any) {
			if !ok[k] && k != "@type" && k != "@id" {
				t.Errorf("an isBasedOn item emits %q, which is not a pinned context term", k)
			}
		}
	}
	if n["@context"].([]any)[0] != ContextURL {
		t.Error("the set's @context must name the pinned BeatScript context first")
	}
	// it is JSON the authority's processors can read
	if _, err := json.Marshal(n); err != nil {
		t.Fatal(err)
	}
}

// The served descriptor says what the lock says.
func TestDescriptorNamesThePinnedRelease(t *testing.T) {
	var d map[string]any
	if err := json.Unmarshal(Descriptor(), &d); err != nil {
		t.Fatal(err)
	}
	s := string(Descriptor())
	for _, want := range []string{ContextURL, GrammarURL, `"version": "` + AuthorityOntologyVersion + `"`, "P1", "P2", "P3"} {
		if !strings.Contains(s, want) {
			t.Errorf("adoption.jsonld does not mention %s", want)
		}
	}
}

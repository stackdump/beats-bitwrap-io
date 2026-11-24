// Package beatscript is how beats.bitwrap.io adopts BeatScript's language descriptor.
//
// BeatScript (beatscript.app, github.com/stackdump/beatscript) is the AUTHORITY for the language and its
// vocabulary; beats is an ADOPTER. Nothing in this package defines a term. It points at the authority's
// namespace and context, says which release it was built against (the Authority* constants, held equal to
// beatscript-authority.lock by authority_test.go), and lists the few terms it refers to (used-terms.txt).
//
// What beats says with them (docs/BEATSCRIPT-ADOPTION.md has the full mapping and the upstream proposals):
//   - a track's genre is the authority's genre IRI (GenreIRI), beside the plain word it always had;
//   - a set (a BeatsComposition: tracks in order) is a schema.org MusicComposition that is based on its tracks
//     with BeatScript's context terms (SetNode), the way a BeatScript program is based on what it resolves;
//   - a playlist and the radio have no linked-data term in the authority yet, so beats invents none: it says
//     "proposal" in the descriptor (Descriptor) and in the doc.
//
// Share and composition CIDs hash the envelope, not these nodes, so nothing here moves one.
package beatscript

import (
	_ "embed"
	"sort"
	"strconv"
	"strings"
)

// The authority release this build adopts. authority_test.go fails if any of these differs from
// beatscript-authority.lock, and `scripts/beatscript-authority.sh check` fails if the lock differs from the
// authority. Change them with `scripts/beatscript-authority.sh sync`, never by hand.
const (
	AuthorityOntologyVersion = "0.4.0"
	OntologyNamespace        = "https://beatscript.app/ontology/ns#"
	OntologyBase             = "https://beatscript.app/ontology/"
	ContextURL               = "https://beatscript.app/context/beatscript-v1.jsonld"
	GrammarURL               = "https://beatscript.app/grammar.ebnf"
	// DescriptorPath is where beats serves its adoption descriptor.
	DescriptorPath = "/schema/beatscript"
)

//go:embed used-terms.txt
var usedTermsText string

//go:embed adoption.jsonld
var descriptorBytes []byte

// Descriptor is beats' adoption record as served at DescriptorPath (application/ld+json).
func Descriptor() []byte { return descriptorBytes }

// UsedTerms returns the references in used-terms.txt, ontology IRIs and context keys separately, sorted.
func UsedTerms() (iris, ctxKeys []string) {
	for _, line := range strings.Split(usedTermsText, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		kind, val, _ := strings.Cut(line, " ")
		switch kind {
		case "iri":
			iris = append(iris, val)
		case "ctx":
			ctxKeys = append(ctxKeys, val)
		}
	}
	sort.Strings(iris)
	sort.Strings(ctxKeys)
	return
}

// GenreIRI is the authority's IRI for a beats genre (`techno`), when the authority has the genre. The check is
// against used-terms.txt, which the lock pins, so a genre the authority lacks yields "" and stays a plain word.
func GenreIRI(genre string) string {
	iri := OntologyBase + "genre/" + strings.ToLower(strings.TrimSpace(genre))
	iris, _ := UsedTerms()
	i := sort.SearchStrings(iris, iri)
	if i < len(iris) && iris[i] == iri {
		return iri
	}
	return ""
}

// Track is one entry of a set: the track's share URL and the CID it resolves to.
type Track struct {
	URL string
	CID string
}

// SetNode describes a set (a BeatsComposition) with the authority's context terms. @id is the set's own URL on
// beats (the authority has no IRI to mint for something it did not store). The tracks are `isBasedOn` items
// naming the CID each resolves to: the shape the authority's own program JSON-LD uses for what a program is built
// from (djlive progld.rs: {"@type":"CreativeWork","name",resolves,derivation}). `derivation` is the authority's free
// string for how; beats says "set-track" and proposes the word upstream (P4).
func SetNode(setURL, name string, tempo int, tracks []Track) map[string]any {
	items := make([]any, 0, len(tracks))
	for i, t := range tracks {
		item := map[string]any{
			"@type":      "CreativeWork",
			"@id":        t.URL,
			"name":       trackLabel(i),
			"resolves":   t.CID,
			"derivation": "set-track",
		}
		items = append(items, item)
	}
	node := map[string]any{
		"@context":  []any{ContextURL, "https://schema.org"},
		"@type":     "MusicComposition",
		"@id":       setURL,
		"isBasedOn": items,
	}
	if name != "" {
		node["name"] = name
	}
	if tempo > 0 {
		node["tempo"] = tempo
	}
	return node
}

func trackLabel(i int) string { return "track " + strconv.Itoa(i+1) }

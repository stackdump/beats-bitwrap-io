package share

import (
	"encoding/json"
	"testing"
)

// The projection says the genre in the BeatScript ontology's IRI beside the plain word; the payload (and so the CID)
// is not involved.
func TestProjectionCarriesTheAuthoritysGenreIRI(t *testing.T) {
	s, err := buildProjectionJSONLD("https://beats.bitwrap.io/?cid=zX", "zX", "Techno", "", "d")
	if err != nil {
		t.Fatal(err)
	}
	var n struct {
		Genre []string `json:"genre"`
	}
	if err := json.Unmarshal([]byte(s), &n); err != nil {
		t.Fatal(err)
	}
	if len(n.Genre) != 2 || n.Genre[0] != "Techno" || n.Genre[1] != "https://beatscript.app/ontology/genre/techno" {
		t.Errorf("genre = %v", n.Genre)
	}
	// a genre the authority does not have stays one plain word
	s, _ = buildProjectionJSONLD("u", "zX", "Polka", "", "d")
	var m struct {
		Genre string `json:"genre"`
	}
	if err := json.Unmarshal([]byte(s), &m); err != nil || m.Genre != "Polka" {
		t.Errorf("unknown genre: %s (%v)", s, err)
	}
}

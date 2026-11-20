package mcpsrv_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"beats-bitwrap-io/internal/btwsite/api"
	"beats-bitwrap-io/internal/btwsite/btwd"
)

// check's same_as without a comparer: the argument is read and a CID is looked up before anything runs, and a
// checker that cannot compare says so rather than answering a check without the comparison.
func TestCheckSameAsArgument(t *testing.T) {
	e := newEnv(t)
	// an unknown CID is not_found, and says to pass the text
	r := e.call("", "check", map[string]any{"text": goodProgram, "same_as": "z" + strings.Repeat("2", 30)})
	if body := r.errBody(t); body["code"] != "not_found" || !strings.Contains(r.Text, "text") {
		t.Fatalf("unknown CID: %s", r.Text)
	}
	// an empty one is a bad request
	if c := e.call("", "check", map[string]any{"text": goodProgram, "same_as": "  "}).errBody(t)["code"]; c != "bad_request" {
		t.Fatalf("empty same_as: %v", c)
	}
	// the fake checker cannot compare: not_configured, not a silent plain check
	if c := e.call("", "check", map[string]any{"text": goodProgram, "same_as": goodProgram}).errBody(t)["code"]; c != "not_configured" {
		t.Fatalf("no comparer: %v", c)
	}
	// without same_as, check is what it was
	if r := e.call("", "check", map[string]any{"text": goodProgram}); r.IsError || strings.Contains(r.Text, "same_as") {
		t.Fatalf("plain check: %s", r.Text)
	}
}

// With BTWD_BIN set: same_as against the real checker. trance-138 against itself by its example CID, against
// a renamed section (same, reported), and against a one-note change (different, naming the section).
func TestCheckSameAsWithTheRealBtwd(t *testing.T) {
	bin := os.Getenv("BTWD_BIN")
	if bin == "" {
		t.Skip("BTWD_BIN is not set")
	}
	real, err := btwd.New(bin, btwd.Options{})
	if err != nil {
		t.Fatal(err)
	}
	b := newBackend()
	b.Checker = real
	e := newEnvWith(t, b)
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "btwsite", "examples", "trance-138.btw"))
	if err != nil {
		t.Fatal(err)
	}
	song := string(raw)

	type cmp struct {
		OK       bool   `json:"ok"`
		Same     bool   `json:"same"`
		TextSame bool   `json:"text_same"`
		Basis    string `json:"basis"`
		Why      string `json:"why"`
		Diffs    []struct {
			Section  string `json:"section"`
			Deck     string `json:"deck"`
			StartBar int    `json:"start_bar"`
			ACID     string `json:"a_cid"`
			BCID     string `json:"b_cid"`
		} `json:"diffs"`
		Renamed []struct {
			A, B string
		} `json:"renamed"`
	}
	call := func(text, other string) (map[string]any, cmp) {
		t.Helper()
		r := e.call("", "check", map[string]any{"text": text, "same_as": other})
		if r.IsError {
			t.Fatalf("check same_as: %s", r.Text)
		}
		var whole struct {
			SameAs cmp `json:"same_as"`
		}
		if err := json.Unmarshal([]byte(r.Text), &whole); err != nil {
			t.Fatalf("%v: %.300s", err, r.Text)
		}
		return r.body(t), whole.SameAs
	}

	// by CID: a stored program is looked up, and the report is still the check of text
	rep, err := real.Check(t.Context(), song)
	if err != nil {
		t.Fatal(err)
	}
	b.store[rep.CID] = &api.Program{CID: rep.CID, Text: song}
	body, c := call(song, rep.CID)
	if body["cid"] != rep.CID || body["ok"] != true || !c.OK || !c.Same || !c.TextSame || c.Basis != "sections" {
		t.Fatalf("against itself by CID: %+v", c)
	}
	// and by a short link to it
	if _, c := call(song, "https://btw.bitwrap.io/p/"+rep.CID); !c.Same {
		t.Fatalf("by short link: %+v", c)
	}

	// a renamed section is the same song, and says so
	renamed := strings.NewReplacer("section drop 24 bars", "section peak 24 bars", "arrange intro breakdown drop outro", "arrange intro breakdown peak outro").Replace(song)
	if _, c := call(song, renamed); !c.Same || c.TextSame || len(c.Renamed) != 1 || c.Renamed[0].A != "drop" || c.Renamed[0].B != "peak" {
		t.Fatalf("renamed: %+v", c)
	}

	// one note out of the breakdown's snare roll: a different song, and the diff names breakdown deck A
	one := strings.Replace(song, "let r1 = x x x x x x x x x x x x x x x x", "let r1 = x x x x x x x x x x x x x x x ~", 1)
	if one == song {
		t.Fatal("the edit did nothing")
	}
	_, c = call(song, one)
	if c.Same || len(c.Diffs) != 1 || c.Diffs[0].Section != "breakdown" || c.Diffs[0].Deck != "A" || c.Diffs[0].StartBar != 16 || !strings.Contains(c.Why, "breakdown") {
		t.Fatalf("one note: %+v", c)
	}
}

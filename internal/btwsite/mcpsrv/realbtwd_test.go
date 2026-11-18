package mcpsrv_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"beats-bitwrap-io/internal/btwsite/btwd"
)

// With BTWD_BIN set, the read tools run against the real Rust checker (through G1's btwd.Client): the
// example programs check clean with the CIDs pinned in testdata, errors have a real line:col and help,
// and a share link opens verified.
func TestReadToolsWithTheRealBtwd(t *testing.T) {
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
	root := filepath.Join("..", "..", "..", "btwsite")

	raw, err := os.ReadFile(filepath.Join(root, "testdata", "docs", "example-cids.json"))
	if err != nil {
		t.Fatal(err)
	}
	var pinned map[string]string
	if err := json.Unmarshal(raw, &pinned); err != nil {
		t.Fatal(err)
	}
	for name, cid := range pinned {
		text, err := os.ReadFile(filepath.Join(root, "examples", name+".btw"))
		if err != nil {
			t.Fatal(err)
		}
		r := e.call("", "check", map[string]any{"text": string(text)})
		body := r.body(t)
		if r.IsError || body["ok"] != true || body["cid"] != cid || body["restricted"] != false || body["uses_assets"] != false {
			t.Errorf("check(%s) = %.300s", name, r.Text)
		}
	}

	// an error from the real parser: line, column, help, a caret form
	r := e.call("", "check", map[string]any{"text": "tempo 126\ndeck A: kick | snare ~ x\n"})
	body := r.body(t)
	d := body["diagnostics"].([]any)[0].(map[string]any)
	if body["ok"] != false || d["line"] != float64(2) || d["col"].(float64) < 1 || d["help"] == "" || !strings.Contains(d["render"].(string), "2") {
		t.Fatalf("check(bad) = %s", r.Text)
	}

	// fmt, share, open
	first, _ := os.ReadFile(filepath.Join(root, "examples", "first-beat.btw"))
	f := e.call("", "fmt", map[string]any{"text": string(first)}).body(t)
	if f["ok"] != true || f["cid"] != pinned["first-beat"] || !strings.HasPrefix(f["canonical"].(string), "tempo 124\n") {
		t.Fatalf("fmt = %v", f)
	}
	sh := e.call("", "share", map[string]any{"text": string(first)})
	sb := sh.body(t)
	url, _ := sb["url"].(string)
	if sh.IsError || sb["cid"] != pinned["first-beat"] || !strings.Contains(url, "#"+pinned["first-beat"]+".") {
		t.Fatalf("share = %s", sh.Text)
	}
	op := e.call("", "open", map[string]any{"url": url})
	ob := op.body(t)
	if op.IsError || ob["verified"] != true || ob["cid"] != pinned["first-beat"] || ob["canonical"] != f["canonical"] {
		t.Fatalf("open = %s", op.Text)
	}
	// a forged link: the same fragment with another CID in front
	forged := strings.Replace(url, "#"+pinned["first-beat"], "#"+pinned["acid-line"], 1)
	if r := e.call("", "open", map[string]any{"url": forged}); !r.IsError {
		t.Errorf("a forged link opened: %s", r.Text)
	} else if c := r.errBody(t)["code"]; c != "cid_mismatch" && c != "bad_request" {
		t.Errorf("forged link code = %v", c)
	}
	// the instruments of the engine
	in := e.call("", "instruments", nil).body(t)
	if len(in["voices"].([]any)) < 20 {
		t.Errorf("instruments = %.200s", e.call("", "instruments", nil).Text)
	}
	// a restricted program is refused by share and eval whatever the fake hub says
	priv := "tempo 120\nuse restricted\ndeck A: kick x ~ x ~\n"
	if c := e.call("", "share", map[string]any{"text": priv}).errBody(t)["code"]; c != "restricted" {
		t.Errorf("share(restricted) code = %v", c)
	}
	if c := e.call("btw_alice", "eval", map[string]any{"text": priv}).errBody(t)["code"]; c != "restricted" {
		t.Errorf("eval(restricted) code = %v", c)
	}
}

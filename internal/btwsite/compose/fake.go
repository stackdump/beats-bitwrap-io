package compose

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// The recorded-fixture model: what BTW_MODEL=fake (and every compose test that needs no network) talks to.
//
// A fixture is one scenario, a JSON file (btwsite/testdata/compose/*.json, embedded copy in fixtures/, a
// test keeps the two identical):
//
//	{"name":"repair","description":"…","match":["fake-repair"],"default":false,
//	 "steps":[{"text":"…a program with a mistake…"},{"text":"…the fix…","usage":{"in":2400,"out":300,"thoughts":80}}]}
//
// The scenario is chosen by the first user message of the conversation: the first fixture (by name) with
// a `match` word in it, else the one marked `default`. Step i answers the (i+1)th call of a conversation
// (the number of "model" turns already in the messages), and the last step answers every later call, so
// the fake holds no state between requests and is safe under concurrency.
//
// A step is a reply text, or one of: "finish":"MAX_TOKENS" (a cut-off reply, text is the partial text),
// "block":"SAFETY" (the prompt was refused), "error":{status,kind,message} (the service failed).
// "pad_to_bytes" pads the text with comment lines up to that size (an oversize reply without a huge file).
type Fixture struct {
	Name        string        `json:"name"`
	Description string        `json:"description,omitempty"`
	Match       []string      `json:"match,omitempty"`
	Default     bool          `json:"default,omitempty"`
	Steps       []FixtureStep `json:"steps"`
}

// FixtureStep is one scripted reply.
type FixtureStep struct {
	Text       string `json:"text,omitempty"`
	PadToBytes int    `json:"pad_to_bytes,omitempty"`
	Finish     string `json:"finish,omitempty"`
	Block      string `json:"block,omitempty"`
	Usage      *struct {
		In       int `json:"in"`
		Out      int `json:"out"`
		Thoughts int `json:"thoughts,omitempty"`
	} `json:"usage,omitempty"`
	Error *struct {
		Status     int    `json:"status,omitempty"`
		Kind       string `json:"kind,omitempty"`
		Code       string `json:"code,omitempty"`
		Message    string `json:"message,omitempty"`
		RetryAfter int    `json:"retry_after,omitempty"`
	} `json:"error,omitempty"`
}

// FakeCall is what the model was asked, for tests that check what reached it.
type FakeCall struct {
	System   string
	Messages []Message
}

// FakeModel replays fixtures. It implements Model.
type FakeModel struct {
	fixtures []Fixture
	mu       sync.Mutex
	calls    []FakeCall
}

// NewFakeModel makes a fake from fixtures (sorted by name; at least one must be the default).
func NewFakeModel(fx []Fixture) (*FakeModel, error) {
	fx = append([]Fixture(nil), fx...)
	sort.Slice(fx, func(i, j int) bool { return fx[i].Name < fx[j].Name })
	def := 0
	for _, f := range fx {
		if f.Name == "" || len(f.Steps) == 0 {
			return nil, fmt.Errorf("fake model: fixture %q needs a name and at least one step", f.Name)
		}
		if f.Default {
			def++
		}
	}
	if def != 1 {
		return nil, fmt.Errorf("fake model: exactly one fixture must be the default, found %d", def)
	}
	return &FakeModel{fixtures: fx}, nil
}

// LoadFakeModel reads every *.json in dir except real-*.json (recorded live runs, a different shape).
func LoadFakeModel(dir string) (*FakeModel, error) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var fx []Fixture
	for _, e := range ents {
		n := e.Name()
		if e.IsDir() || !strings.HasSuffix(n, ".json") || strings.HasPrefix(n, "real-") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, n))
		if err != nil {
			return nil, err
		}
		f, err := parseFixture(n, b)
		if err != nil {
			return nil, err
		}
		fx = append(fx, f)
	}
	return NewFakeModel(fx)
}

//go:embed fixtures/*.json
var embeddedFixtures embed.FS

// DefaultFakeModel is the fake over the fixtures compiled into the binary.
func DefaultFakeModel() (*FakeModel, error) {
	ents, err := embeddedFixtures.ReadDir("fixtures")
	if err != nil {
		return nil, err
	}
	var fx []Fixture
	for _, e := range ents {
		b, err := embeddedFixtures.ReadFile("fixtures/" + e.Name())
		if err != nil {
			return nil, err
		}
		f, err := parseFixture(e.Name(), b)
		if err != nil {
			return nil, err
		}
		fx = append(fx, f)
	}
	return NewFakeModel(fx)
}

func parseFixture(file string, b []byte) (Fixture, error) {
	var f Fixture
	if err := json.Unmarshal(b, &f); err != nil {
		return f, fmt.Errorf("fake model: %s: %w", file, err)
	}
	return f, nil
}

// Calls returns what the model has been asked, oldest first (the last 200 calls).
func (f *FakeModel) Calls() []FakeCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]FakeCall(nil), f.calls...)
}

// Scenario names the fixture a first user message selects.
func (f *FakeModel) Scenario(firstUser string) string { return f.pick(firstUser).Name }

func (f *FakeModel) pick(firstUser string) *Fixture {
	low := strings.ToLower(firstUser)
	var def *Fixture
	for i := range f.fixtures {
		fx := &f.fixtures[i]
		if fx.Default {
			def = fx
		}
		for _, m := range fx.Match {
			if m != "" && strings.Contains(low, strings.ToLower(m)) {
				return fx
			}
		}
	}
	return def
}

// Generate implements Model.
func (f *FakeModel) Generate(ctx context.Context, system string, messages []Message) (string, Usage, error) {
	if err := ctx.Err(); err != nil {
		return "", Usage{}, &ModelError{Kind: KindTransport, Message: "the request was cancelled"}
	}
	first, turns, inChars := "", 0, len(system)
	for _, m := range messages {
		inChars += len(m.Text)
		if m.Role == "model" {
			turns++
		} else if first == "" {
			first = m.Text
		}
	}
	f.mu.Lock()
	f.calls = append(f.calls, FakeCall{System: system, Messages: append([]Message(nil), messages...)})
	if len(f.calls) > 200 {
		f.calls = f.calls[len(f.calls)-200:]
	}
	f.mu.Unlock()

	fx := f.pick(first)
	st := fx.Steps[len(fx.Steps)-1]
	if turns < len(fx.Steps) {
		st = fx.Steps[turns]
	}
	text := st.Text
	if st.PadToBytes > len(text) {
		var b strings.Builder
		b.WriteString(text)
		if !strings.HasSuffix(text, "\n") {
			b.WriteByte('\n')
		}
		for b.Len() < st.PadToBytes {
			b.WriteString("# padding to make this reply longer than a program may be\n")
		}
		text = b.String()
	}
	use := Usage{In: inChars / 3, Out: len(text) / 3}
	if st.Usage != nil {
		use = Usage{In: st.Usage.In, Out: st.Usage.Out, Thoughts: st.Usage.Thoughts}
	}
	switch {
	case st.Error != nil:
		e := st.Error
		kind := e.Kind
		if kind == "" {
			kind = KindUpstream
		}
		return "", Usage{}, &ModelError{Kind: kind, Status: e.Status, Code: e.Code, Message: e.Message, RetryAfter: e.RetryAfter}
	case st.Block != "":
		return "", use, &ModelError{Kind: KindBlocked, Message: "the model declined the prompt (blockReason " + sanitizeWord(st.Block) + ")"}
	case st.Finish == "MAX_TOKENS":
		return text, use, &ModelError{Kind: KindMaxTokens, Message: "the reply was cut off at the output limit"}
	}
	return text, use, nil
}

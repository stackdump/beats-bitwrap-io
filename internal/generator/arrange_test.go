package generator

import (
	"encoding/json"
	"fmt"
	"testing"

	"beats-bitwrap-io/internal/pflow"
)

// fixtureProject builds a tiny 2-net hand-authored project — a kick and a
// bass ring, both 8 steps — useful as a stable arrange() input. Each net
// carries track.group so the clone-preserves-group test has something to
// assert on.
func fixtureProject(t *testing.T) *pflow.Project {
	t.Helper()
	raw := map[string]any{
		"name":  "fixture",
		"tempo": 120.0,
		"nets": map[string]any{
			"kick": map[string]any{
				"role":  "music",
				"track": map[string]any{"channel": 1, "group": "drums"},
				"places": map[string]any{
					"p0": map[string]any{"initial": []any{float64(1)}},
					"p1": map[string]any{}, "p2": map[string]any{}, "p3": map[string]any{},
					"p4": map[string]any{}, "p5": map[string]any{}, "p6": map[string]any{}, "p7": map[string]any{},
				},
				"transitions": map[string]any{
					"t0": map[string]any{"midi": map[string]any{"note": 36, "velocity": 110, "duration": 80}},
					"t1": map[string]any{},
					"t2": map[string]any{"midi": map[string]any{"note": 36, "velocity": 100, "duration": 80}},
					"t3": map[string]any{},
					"t4": map[string]any{"midi": map[string]any{"note": 36, "velocity": 110, "duration": 80}},
					"t5": map[string]any{},
					"t6": map[string]any{"midi": map[string]any{"note": 36, "velocity": 100, "duration": 80}},
					"t7": map[string]any{},
				},
				"arcs": ringArcs(8, "p", "t"),
			},
			"bass": map[string]any{
				"role":  "music",
				"track": map[string]any{"channel": 2, "group": "bass"},
				"places": map[string]any{
					"b0": map[string]any{"initial": []any{float64(1)}},
					"b1": map[string]any{}, "b2": map[string]any{}, "b3": map[string]any{},
					"b4": map[string]any{}, "b5": map[string]any{}, "b6": map[string]any{}, "b7": map[string]any{},
				},
				"transitions": map[string]any{
					"bt0": map[string]any{"midi": map[string]any{"note": 40, "velocity": 100, "duration": 150}},
					"bt1": map[string]any{},
					"bt2": map[string]any{"midi": map[string]any{"note": 40, "velocity": 90, "duration": 120}},
					"bt3": map[string]any{"midi": map[string]any{"note": 43, "velocity": 95, "duration": 120}},
					"bt4": map[string]any{"midi": map[string]any{"note": 40, "velocity": 100, "duration": 150}},
					"bt5": map[string]any{},
					"bt6": map[string]any{"midi": map[string]any{"note": 47, "velocity": 90, "duration": 120}},
					"bt7": map[string]any{"midi": map[string]any{"note": 43, "velocity": 90, "duration": 120}},
				},
				"arcs": ringArcs(8, "b", "bt"),
			},
		},
	}
	return pflow.ParseProject(raw)
}

func ringArcs(n int, placePrefix, transPrefix string) []any {
	out := []any{}
	for i := 0; i < n; i++ {
		next := (i + 1) % n
		out = append(out,
			map[string]any{"source": fmt.Sprintf("%s%d", placePrefix, i), "target": fmt.Sprintf("%s%d", transPrefix, i)},
			map[string]any{"source": fmt.Sprintf("%s%d", transPrefix, i), "target": fmt.Sprintf("%s%d", placePrefix, next)},
		)
	}
	return out
}

// TestArrangeSeeded_Deterministic: three runs with the same seed must
// produce byte-identical output. Regression test for the map-iteration
// order fix (sortedMusicNetIDs).
func TestArrangeSeeded_Deterministic(t *testing.T) {
	hashes := make([][]byte, 3)
	for i := range 3 {
		proj := fixtureProject(t)
		ArrangeSeeded(proj, "wrapped", "extended", 42)
		b, err := json.Marshal(proj.ToJSON())
		if err != nil {
			t.Fatal(err)
		}
		hashes[i] = b
	}
	for i := 1; i < len(hashes); i++ {
		if string(hashes[0]) != string(hashes[i]) {
			t.Fatalf("ArrangeSeeded non-deterministic: run 0 (%d bytes) != run %d (%d bytes)",
				len(hashes[0]), i, len(hashes[i]))
		}
	}
}

// TestArrange_ClonePreservesGroup: the variant expander deep-copies via
// cloneBundle; the clone must keep the source's track.group so the
// mixer sections still line up post-arrange.
func TestArrange_ClonePreservesGroup(t *testing.T) {
	proj := fixtureProject(t)
	ArrangeSeeded(proj, "wrapped", "standard", 7)

	expectedGroup := map[string]string{"kick": "drums", "bass": "bass"}
	for id, nb := range proj.Nets {
		if nb.Role == "control" {
			continue
		}
		// Strip variant suffix (kick-0, bass-1, …) to recover the role.
		role := id
		for i := len(id) - 1; i > 0; i-- {
			if id[i] == '-' {
				role = id[:i]
				break
			}
		}
		want, known := expectedGroup[role]
		if !known {
			continue
		}
		if nb.Track.Group != want {
			t.Errorf("net %q (role %q) group = %q, want %q", id, role, nb.Track.Group, want)
		}
	}
}

// TestInjectFeelCurve: given a template with known section boundaries,
// the injected feel-curve net must fire set-feel at the correct ticks
// with the correct macroParams.
func TestInjectFeelCurve(t *testing.T) {
	proj := &pflow.Project{Nets: map[string]*pflow.NetBundle{}}
	tmpl := &SongTemplate{Sections: []Section{
		{Name: "intro", Steps: 64},
		{Name: "drop", Steps: 128},
		{Name: "outro", Steps: 64},
	}}
	curve := []FeelPoint{
		{Section: "intro", X: 0.1, Y: 0.2},
		{Section: "drop", X: 0.9, Y: 0.3},
		{Section: "outro", X: 0.5, Y: 0.8},
	}
	injectFeelCurve(proj, tmpl, curve)

	nb, ok := proj.Nets["feel-curve"]
	if !ok {
		t.Fatal("feel-curve net not created")
	}
	if nb.Role != "control" {
		t.Errorf("feel-curve role = %q, want control", nb.Role)
	}

	// Expected ticks: intro starts at 0, drop at 64, outro at 64+128 = 192.
	wantAt := map[int][2]float64{
		0:   {0.1, 0.2},
		64:  {0.9, 0.3},
		192: {0.5, 0.8},
	}
	found := map[int]bool{}
	for tid, cb := range nb.ControlBindings {
		if cb.Action != "set-feel" {
			t.Errorf("control %q action = %q, want set-feel", tid, cb.Action)
			continue
		}
		// tid is "ftN"; strip prefix.
		var tick int
		fmt.Sscanf(tid, "ft%d", &tick)
		want, ok := wantAt[tick]
		if !ok {
			t.Errorf("unexpected set-feel at tick %d", tick)
			continue
		}
		x, _ := cb.MacroParams["x"].(float64)
		y, _ := cb.MacroParams["y"].(float64)
		if x != want[0] || y != want[1] {
			t.Errorf("tick %d: got (x=%v, y=%v), want (x=%v, y=%v)", tick, x, y, want[0], want[1])
		}
		found[tick] = true
	}
	for tick := range wantAt {
		if !found[tick] {
			t.Errorf("no set-feel binding at tick %d", tick)
		}
	}
}

// TestInjectMacroCurve: schedules fire-macro at named sections. Assert
// the resulting macro-curve net has the right control bindings at the
// computed tick offsets, carrying the right macro id and bars.
func TestInjectMacroCurve(t *testing.T) {
	proj := &pflow.Project{Nets: map[string]*pflow.NetBundle{}}
	tmpl := &SongTemplate{Sections: []Section{
		{Name: "intro", Steps: 64},
		{Name: "drop", Steps: 128},
		{Name: "outro", Steps: 64},
	}}
	curve := []MacroPoint{
		{Section: "intro", Macro: "reverb-wash", Bars: 2},
		{Section: "drop", Macro: "beat-repeat", Bars: 1},
	}
	injectMacroCurve(proj, tmpl, curve)

	nb, ok := proj.Nets["macro-curve"]
	if !ok {
		t.Fatal("macro-curve net not created")
	}
	if nb.Role != "control" {
		t.Errorf("macro-curve role = %q, want control", nb.Role)
	}

	wantAt := map[int]MacroPoint{
		0:  {Macro: "reverb-wash", Bars: 2},
		64: {Macro: "beat-repeat", Bars: 1},
	}
	found := map[int]bool{}
	for tid, cb := range nb.ControlBindings {
		if cb.Action != "fire-macro" {
			t.Errorf("control %q action = %q, want fire-macro", tid, cb.Action)
			continue
		}
		var tick int
		fmt.Sscanf(tid, "mt%d", &tick)
		want, ok := wantAt[tick]
		if !ok {
			t.Errorf("unexpected fire-macro at tick %d", tick)
			continue
		}
		if cb.Macro != want.Macro {
			t.Errorf("tick %d: macro=%q, want %q", tick, cb.Macro, want.Macro)
		}
		if cb.MacroBars != want.Bars {
			t.Errorf("tick %d: bars=%v, want %v", tick, cb.MacroBars, want.Bars)
		}
		found[tick] = true
	}
	for tick := range wantAt {
		if !found[tick] {
			t.Errorf("no fire-macro binding at tick %d", tick)
		}
	}
}

// TestCapVariantLetters: MaxVariants=2 must rewrite any phrase letter
// beyond A/B back to A, leaving A/B untouched.
func TestCapVariantLetters(t *testing.T) {
	tmpl := &SongTemplate{Sections: []Section{
		{
			Name: "verse",
			Phrases: map[string][]string{
				"kick": {"A", "B", "C", "D"},
				"bass": {"A", "A", "B", "C"},
			},
		},
	}}
	capVariantLetters(tmpl, 2)

	got := tmpl.Sections[0].Phrases
	if want := []string{"A", "B", "A", "A"}; !eqSlice(got["kick"], want) {
		t.Errorf("kick phrases = %v, want %v", got["kick"], want)
	}
	if want := []string{"A", "A", "B", "A"}; !eqSlice(got["bass"], want) {
		t.Errorf("bass phrases = %v, want %v", got["bass"], want)
	}
}

func eqSlice(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

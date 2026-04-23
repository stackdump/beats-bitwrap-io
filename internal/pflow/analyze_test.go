package pflow

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// Loading the shipped macro-orchestrated.json should come back clean:
// the conductor's drain time matches its cycle length.
func TestAnalyzeMacroBacklog_ShippedExampleIsBalanced(t *testing.T) {
	path := filepath.Join("..", "..", "examples", "macro-orchestrated.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	proj := ParseProject(raw)
	warnings := AnalyzeMacroBacklog(proj)
	if len(warnings) > 0 {
		t.Errorf("expected shipped example to be backlog-free; got warnings:")
		for _, w := range warnings {
			t.Errorf("  %s", w)
		}
	}
}

// 16-step conductor with 9 fires (the prior shape of macro-orchestrated)
// must trip the analyzer.
func TestAnalyzeMacroBacklog_DenseControlTrips(t *testing.T) {
	raw := map[string]any{
		"nets": map[string]any{
			"conductor": map[string]any{
				"role":   "control",
				"places": buildPlaces(16),
				"transitions": map[string]any{
					"ct0":  map[string]any{"control": map[string]any{"action": "fire-macro", "macro": "reverb-wash", "macroBars": float64(2)}},
					"ct1":  map[string]any{},
					"ct2":  map[string]any{},
					"ct3":  map[string]any{"control": map[string]any{"action": "fire-macro", "macro": "ping-pong", "macroBars": float64(2)}},
					"ct4":  map[string]any{},
					"ct5":  map[string]any{"control": map[string]any{"action": "fire-macro", "macro": "sweep-lp", "macroBars": float64(4)}},
					"ct6":  map[string]any{},
					"ct7":  map[string]any{"control": map[string]any{"action": "fire-macro", "macro": "beat-repeat", "macroBars": float64(1)}},
					"ct8":  map[string]any{"control": map[string]any{"action": "fire-macro", "macro": "riser", "macroBars": float64(4)}},
					"ct9":  map[string]any{},
					"ct10": map[string]any{},
					"ct11": map[string]any{"control": map[string]any{"action": "fire-macro", "macro": "delay-throw", "macroBars": float64(1)}},
					"ct12": map[string]any{"control": map[string]any{"action": "fire-macro", "macro": "octave-up", "macroBars": float64(1)}},
					"ct13": map[string]any{},
					"ct14": map[string]any{"control": map[string]any{"action": "fire-macro", "macro": "sweep-hp", "macroBars": float64(2)}},
					"ct15": map[string]any{"control": map[string]any{"action": "fire-macro", "macro": "drop", "macroBars": float64(1)}},
				},
				"arcs": buildRingArcs(16, "c", "ct"),
			},
		},
	}
	proj := ParseProject(raw)
	warnings := AnalyzeMacroBacklog(proj)
	if len(warnings) != 1 {
		t.Fatalf("expected 1 warning, got %d", len(warnings))
	}
	w := warnings[0]
	if w.NetID != "conductor" {
		t.Errorf("netID = %q, want conductor", w.NetID)
	}
	if w.FireCount != 9 {
		t.Errorf("fireCount = %d, want 9", w.FireCount)
	}
	// 2+2+4+1+4+1+1+2+1 = 18 bars × 16 ticks = 288 drain ticks, 16-step cycle
	if w.DrainTicks != 288 {
		t.Errorf("drainTicks = %d, want 288", w.DrainTicks)
	}
	if w.CycleTicks != 16 {
		t.Errorf("cycleTicks = %d, want 16", w.CycleTicks)
	}
	if w.Ratio < 17.9 || w.Ratio > 18.1 {
		t.Errorf("ratio = %.2f, want ~18.0", w.Ratio)
	}
}

// Music nets without fire-macro bindings must not be flagged.
func TestAnalyzeMacroBacklog_MusicNetIgnored(t *testing.T) {
	raw := map[string]any{
		"nets": map[string]any{
			"kick": map[string]any{
				"role":        "music",
				"places":      buildPlaces(4),
				"transitions": map[string]any{"kt0": map[string]any{}, "kt1": map[string]any{}, "kt2": map[string]any{}, "kt3": map[string]any{}},
				"arcs":        buildRingArcs(4, "p", "kt"),
			},
		},
	}
	proj := ParseProject(raw)
	if w := AnalyzeMacroBacklog(proj); len(w) != 0 {
		t.Errorf("music net should be ignored; got %d warnings", len(w))
	}
}

func buildPlaces(n int) map[string]any {
	out := map[string]any{}
	for i := 0; i < n; i++ {
		p := map[string]any{}
		if i == 0 {
			p["initial"] = []any{float64(1)}
		}
		out[fmt.Sprintf("c%d", i)] = p
	}
	return out
}

func buildRingArcs(n int, placePrefix, transPrefix string) []any {
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

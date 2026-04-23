package generator

import (
	"testing"
)

func TestBjorklund(t *testing.T) {
	tests := []struct {
		k, n int
		want string
	}{
		{3, 8, "10010010"},          // tresillo
		{4, 16, "1000100010001000"}, // four-on-the-floor
		{5, 8, "10110110"},          // cinquillo
		{2, 8, "10001000"},
		{0, 8, "00000000"},
		{8, 8, "11111111"},
		{5, 16, "1001001001001000"},
	}

	for _, tt := range tests {
		t.Run("", func(t *testing.T) {
			got := bjorklund(tt.k, tt.n)
			s := ""
			for _, v := range got {
				if v == 1 {
					s += "1"
				} else {
					s += "0"
				}
			}
			if s != tt.want {
				t.Errorf("bjorklund(%d,%d) = %s, want %s", tt.k, tt.n, s, tt.want)
			}
		})
	}
}

func TestEuclidean(t *testing.T) {
	params := DefaultParams()
	params.Channel = 10

	result := Euclidean(3, 8, 0, 36, params)
	net := result.Bundle.Net

	// Should have 8 places and 8 transitions
	if len(net.Places) != 8 {
		t.Errorf("expected 8 places, got %d", len(net.Places))
	}
	if len(net.Transitions) != 8 {
		t.Errorf("expected 8 transitions, got %d", len(net.Transitions))
	}

	// Should have 3 MIDI bindings (3 hits)
	midiCount := 0
	for range result.Bundle.Bindings {
		midiCount++
	}
	if midiCount != 3 {
		t.Errorf("expected 3 MIDI bindings, got %d", midiCount)
	}

	// Token should circulate: each step fires exactly 1 transition
	// (collect enabled first, then fire — same as sequencer)
	bundle := result.Bundle
	fired := 0
	for i := 0; i < 8; i++ {
		var enabled []string
		for tLabel := range net.Transitions {
			if bundle.IsEnabled(tLabel) {
				enabled = append(enabled, tLabel)
			}
		}
		if len(enabled) != 1 {
			t.Errorf("step %d: expected 1 enabled, got %d", i, len(enabled))
		}
		for _, tLabel := range enabled {
			bundle.Fire(tLabel)
			fired++
		}
	}
	if fired != 8 {
		t.Errorf("expected 8 firings in one cycle, got %d", fired)
	}
}

func TestCompose(t *testing.T) {
	proj := Compose("techno", nil)

	if proj.Name == "" {
		t.Error("expected non-empty project name")
	}
	if len(proj.Nets) < 4 {
		t.Errorf("expected at least 4 nets (kick,snare,hihat,bass), got %d", len(proj.Nets))
	}

	// Verify all nets can be serialized to JSON
	json := proj.ToJSON()
	if json == nil {
		t.Error("expected non-nil JSON output")
	}

	nets := json["nets"].(map[string]interface{})
	for name, netData := range nets {
		netMap := netData.(map[string]interface{})
		places := netMap["places"].(map[string]interface{})
		if len(places) == 0 {
			t.Errorf("net %s has no places", name)
		}
	}
}

func TestComposeWithStructureVariants(t *testing.T) {
	overrides := map[string]interface{}{
		"structure": "standard",
		"seed":      float64(42),
	}
	proj := Compose("edm", overrides)

	// Should have slot-indexed variant nets (kick-0, kick-1, ...) instead of plain kick
	// Snare is excluded from variants — it stays as a single base net
	for _, role := range []string{"kick", "hihat", "bass", "melody"} {
		if _, ok := proj.Nets[role]; ok {
			t.Errorf("base net %q should have been replaced by slot variants", role)
		}

		// Find all slot nets for this role
		slotCount := 0
		for netId, nb := range proj.Nets {
			if nb.RiffGroup == role && nb.Role != "control" {
				slotCount++
				_ = netId
			}
		}
		if slotCount < 2 {
			t.Errorf("expected at least 2 slot nets for %q, got %d", role, slotCount)
		}

		// Check riffGroup is set on first slot
		if nb, ok := proj.Nets[role+"-0"]; ok {
			if nb.RiffGroup != role {
				t.Errorf("net %q: riffGroup = %q, want %q", role+"-0", nb.RiffGroup, role)
			}
		} else {
			t.Errorf("expected slot net %q", role+"-0")
		}
	}

	// Snare should remain as a single base net (no variants)
	if _, ok := proj.Nets["snare"]; !ok {
		t.Error("snare should remain as a single base net, not expanded into variants")
	}

	// Should have one control net per role (not per variant)
	if _, ok := proj.Nets["struct-kick"]; !ok {
		t.Error("expected struct-kick control net")
	}

	// Structure sections should have phrases
	if len(proj.Structure) == 0 {
		t.Fatal("expected structure sections")
	}
	for _, sec := range proj.Structure {
		if sec.Phrases == nil {
			t.Errorf("section %q should have phrases", sec.Name)
		}
	}

	// JSON round-trip should preserve riffGroup
	j := proj.ToJSON()
	nets := j["nets"].(map[string]interface{})
	kick0 := nets["kick-0"].(map[string]interface{})
	if rg, ok := kick0["riffGroup"].(string); !ok || rg != "kick" {
		t.Errorf("kick-0 riffGroup in JSON: got %v, want 'kick'", kick0["riffGroup"])
	}

	t.Logf("Total nets: %d", len(proj.Nets))
	for id, nb := range proj.Nets {
		if nb.Role != "control" {
			t.Logf("  music: %s (riffGroup=%s)", id, nb.RiffGroup)
		}
	}
}

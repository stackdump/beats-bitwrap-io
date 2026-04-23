package pflow

import (
	"encoding/json"
	"testing"
)

// Round-trip a project with fire-macro control bindings (both legacy
// {action,targetNet} and new {macro,macroBars,macroParams} shapes) and
// verify nothing is lost. Exercises the additive schema extension
// introduced alongside macro scheduling.
func TestControlBinding_FireMacro_RoundTrip(t *testing.T) {
	input := map[string]any{
		"name":  "macro-schedule-fixture",
		"tempo": 128.0,
		"nets": map[string]any{
			"conductor": map[string]any{
				"role":  "control",
				"track": map[string]any{"channel": 1},
				"places": map[string]any{
					"p0": map[string]any{"initial": []any{1.0}, "x": 0.0, "y": 0.0},
				},
				"transitions": map[string]any{
					// Legacy shape — frontend has always supported this.
					"t_legacy": map[string]any{
						"x": 10.0, "y": 0.0,
						"control": map[string]any{
							"action":    "fire-macro",
							"targetNet": "sweep-lp",
						},
					},
					// New shape — scheduled macro with duration + overrides.
					"t_typed": map[string]any{
						"x": 20.0, "y": 0.0,
						"control": map[string]any{
							"action":      "fire-macro",
							"macro":       "reverb-wash",
							"macroBars":   4.5,
							"macroParams": map[string]any{"depth": 0.85, "lfoHz": 2.0},
						},
					},
				},
				"arcs": []any{},
			},
		},
	}

	proj := ParseProject(input)
	nb := proj.Nets["conductor"]
	if nb == nil {
		t.Fatal("conductor net missing after parse")
	}

	legacy := nb.ControlBindings["t_legacy"]
	if legacy == nil || legacy.Action != "fire-macro" || legacy.TargetNet != "sweep-lp" {
		t.Fatalf("legacy binding lost: %+v", legacy)
	}
	if legacy.Macro != "" || legacy.MacroBars != 0 || legacy.MacroParams != nil {
		t.Errorf("legacy binding leaked new fields: %+v", legacy)
	}

	typed := nb.ControlBindings["t_typed"]
	if typed == nil || typed.Action != "fire-macro" {
		t.Fatalf("typed binding missing/action wrong: %+v", typed)
	}
	if typed.Macro != "reverb-wash" {
		t.Errorf("macro = %q, want reverb-wash", typed.Macro)
	}
	if typed.MacroBars != 4.5 {
		t.Errorf("macroBars = %v, want 4.5", typed.MacroBars)
	}
	if d, _ := typed.MacroParams["depth"].(float64); d != 0.85 {
		t.Errorf("macroParams.depth = %v, want 0.85", typed.MacroParams["depth"])
	}

	// Serialize back and confirm the JSON carries both shapes.
	out := proj.ToJSON()
	raw, err := json.Marshal(out)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}

	trans := decoded["nets"].(map[string]any)["conductor"].(map[string]any)["transitions"].(map[string]any)

	legacyOut := trans["t_legacy"].(map[string]any)["control"].(map[string]any)
	if legacyOut["action"] != "fire-macro" || legacyOut["targetNet"] != "sweep-lp" {
		t.Errorf("legacy round-trip lost fields: %+v", legacyOut)
	}
	if _, has := legacyOut["macro"]; has {
		t.Errorf("legacy binding spuriously serialized macro field: %+v", legacyOut)
	}

	typedOut := trans["t_typed"].(map[string]any)["control"].(map[string]any)
	if typedOut["macro"] != "reverb-wash" {
		t.Errorf("typed macro lost: %+v", typedOut)
	}
	if mb, _ := typedOut["macroBars"].(float64); mb != 4.5 {
		t.Errorf("macroBars = %v, want 4.5", typedOut["macroBars"])
	}
	if mp, ok := typedOut["macroParams"].(map[string]any); !ok || mp["depth"] != 0.85 {
		t.Errorf("macroParams lost: %+v", typedOut["macroParams"])
	}
}

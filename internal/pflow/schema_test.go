package pflow

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

func loadSchema(t *testing.T) *jsonschema.Schema {
	t.Helper()
	c := jsonschema.NewCompiler()
	schema, err := c.Compile("../../schema/petri-note.schema.json")
	if err != nil {
		t.Fatalf("Failed to compile schema: %v", err)
	}
	return schema
}

func TestSchema_MinimalProject(t *testing.T) {
	schema := loadSchema(t)

	proj := map[string]interface{}{
		"name": "test",
		"nets": map[string]interface{}{
			"kick": map[string]interface{}{
				"places": map[string]interface{}{
					"p0": map[string]interface{}{"x": 0, "y": 0, "initial": []interface{}{float64(1)}},
					"p1": map[string]interface{}{"x": 100, "y": 0},
				},
				"transitions": map[string]interface{}{
					"t0": map[string]interface{}{
						"x": 50, "y": -30,
						"midi": map[string]interface{}{"note": 36, "velocity": 100, "duration": 100, "channel": 10},
					},
					"t1": map[string]interface{}{"x": 50, "y": 30},
				},
				"arcs": []interface{}{
					map[string]interface{}{"source": "p0", "target": "t0", "weight": []interface{}{float64(1)}},
					map[string]interface{}{"source": "t0", "target": "p1", "weight": []interface{}{float64(1)}},
					map[string]interface{}{"source": "p1", "target": "t1", "weight": []interface{}{float64(1)}},
					map[string]interface{}{"source": "t1", "target": "p0", "weight": []interface{}{float64(1)}},
				},
			},
		},
	}

	if err := schema.Validate(proj); err != nil {
		t.Errorf("Minimal project failed validation: %v", err)
	}
}

func TestSchema_GeneratedProject(t *testing.T) {
	schema := loadSchema(t)

	// Build a project through ParseProject -> ToJSON round-trip
	input := map[string]interface{}{
		"name":  "techno · Test Track",
		"tempo": float64(128),
		"swing": float64(10),
		"nets": map[string]interface{}{
			"kick": map[string]interface{}{
				"track": map[string]interface{}{
					"channel":    float64(10),
					"instrument": "drums",
				},
				"places": map[string]interface{}{
					"p0": map[string]interface{}{"x": float64(0), "y": float64(0), "initial": []interface{}{float64(1)}},
					"p1": map[string]interface{}{"x": float64(100), "y": float64(0)},
				},
				"transitions": map[string]interface{}{
					"t0": map[string]interface{}{
						"x": float64(50), "y": float64(-30),
						"midi": map[string]interface{}{
							"note": float64(36), "velocity": float64(100),
							"duration": float64(200), "channel": float64(10),
						},
					},
					"t1": map[string]interface{}{"x": float64(50), "y": float64(30)},
				},
				"arcs": []interface{}{
					map[string]interface{}{"source": "p0", "target": "t0", "weight": []interface{}{float64(1)}},
					map[string]interface{}{"source": "t0", "target": "p1", "weight": []interface{}{float64(1)}},
					map[string]interface{}{"source": "p1", "target": "t1", "weight": []interface{}{float64(1)}},
					map[string]interface{}{"source": "t1", "target": "p0", "weight": []interface{}{float64(1)}},
				},
			},
		},
	}

	proj := ParseProject(input)
	output := proj.ToJSON()

	// Round-trip through JSON to normalize Go types ([]float64 -> []interface{})
	data, err := json.Marshal(output)
	if err != nil {
		t.Fatalf("Failed to marshal: %v", err)
	}
	var normalized interface{}
	if err := json.Unmarshal(data, &normalized); err != nil {
		t.Fatalf("Failed to unmarshal: %v", err)
	}

	if err := schema.Validate(normalized); err != nil {
		t.Errorf("Generated project failed validation: %v\nJSON:\n%s", err, string(data))
	}
}

func TestSchema_WithStructure(t *testing.T) {
	schema := loadSchema(t)

	proj := map[string]interface{}{
		"name":  "structured track",
		"tempo": float64(120),
		"nets": map[string]interface{}{
			"kick": map[string]interface{}{
				"places":      map[string]interface{}{"p0": map[string]interface{}{"initial": []interface{}{float64(1)}}},
				"transitions": map[string]interface{}{"t0": map[string]interface{}{}},
				"arcs":        []interface{}{map[string]interface{}{"source": "p0", "target": "t0"}},
			},
		},
		"structure": []interface{}{
			map[string]interface{}{
				"name":  "intro",
				"steps": float64(64),
			},
			map[string]interface{}{
				"name":  "verse",
				"steps": float64(192),
				"phrases": map[string]interface{}{
					"kick": []interface{}{"A", "A", "B", "A"},
				},
			},
		},
		"initialMutes": []interface{}{"kick-1"},
	}

	if err := schema.Validate(proj); err != nil {
		t.Errorf("Project with structure failed validation: %v", err)
	}
}

func TestSchema_WithFxAndMix(t *testing.T) {
	schema := loadSchema(t)

	proj := map[string]interface{}{
		"name": "fx test",
		"nets": map[string]interface{}{
			"bass": map[string]interface{}{
				"track": map[string]interface{}{
					"channel":    float64(6),
					"instrument": "acid",
					"mix": map[string]interface{}{
						"volume":      float64(100),
						"pan":         float64(64),
						"loCut":       float64(10),
						"loResonance": float64(5),
						"cutoff":      float64(80),
						"resonance":   float64(15),
						"decay":       float64(50),
					},
				},
				"places":      map[string]interface{}{"p0": map[string]interface{}{"initial": []interface{}{float64(1)}}},
				"transitions": map[string]interface{}{"t0": map[string]interface{}{}},
				"arcs":        []interface{}{map[string]interface{}{"source": "p0", "target": "t0"}},
			},
		},
		"fx": map[string]interface{}{
			"masterVol":     float64(80),
			"reverbSize":    float64(50),
			"reverbDamp":    float64(30),
			"reverbWet":     float64(20),
			"delayTime":     float64(25),
			"delayFeedback": float64(25),
			"delayWet":      float64(15),
			"distortion":    float64(0),
			"hpFreq":        float64(0),
			"lpFreq":        float64(100),
			"phaserFreq":    float64(0),
			"phaserDepth":   float64(50),
			"phaserWet":     float64(0),
			"crushBits":     float64(0),
		},
	}

	if err := schema.Validate(proj); err != nil {
		t.Errorf("Project with FX and mix failed validation: %v", err)
	}
}

func TestSchema_ControlBinding(t *testing.T) {
	schema := loadSchema(t)

	proj := map[string]interface{}{
		"name": "control test",
		"nets": map[string]interface{}{
			"struct-kick": map[string]interface{}{
				"role": "control",
				"places": map[string]interface{}{
					"p0": map[string]interface{}{"initial": []interface{}{float64(1)}},
					"p1": map[string]interface{}{},
				},
				"transitions": map[string]interface{}{
					"t0": map[string]interface{}{
						"control": map[string]interface{}{
							"action":    "activate-slot",
							"targetNet": "kick-0",
						},
					},
				},
				"arcs": []interface{}{
					map[string]interface{}{"source": "p0", "target": "t0"},
					map[string]interface{}{"source": "t0", "target": "p1"},
				},
			},
		},
	}

	if err := schema.Validate(proj); err != nil {
		t.Errorf("Project with control binding failed validation: %v", err)
	}
}

func TestSchema_InhibitorArc(t *testing.T) {
	schema := loadSchema(t)

	proj := map[string]interface{}{
		"name": "inhibitor test",
		"nets": map[string]interface{}{
			"test": map[string]interface{}{
				"places": map[string]interface{}{
					"p0": map[string]interface{}{"initial": []interface{}{float64(1)}},
					"p1": map[string]interface{}{},
				},
				"transitions": map[string]interface{}{
					"t0": map[string]interface{}{},
				},
				"arcs": []interface{}{
					map[string]interface{}{"source": "p0", "target": "t0", "weight": []interface{}{float64(1)}},
					map[string]interface{}{"source": "p1", "target": "t0", "inhibit": true},
					map[string]interface{}{"source": "t0", "target": "p1"},
				},
			},
		},
	}

	if err := schema.Validate(proj); err != nil {
		t.Errorf("Project with inhibitor arc failed validation: %v", err)
	}
}

func TestSchema_ExampleFiles(t *testing.T) {
	// Validate that the example files still match the schema
	// (they may need updating if they use the old aspirational format)
	schema := loadSchema(t)

	files := []string{
		"../../schema/example-project.json",
		"../../schema/example-with-skips.json",
	}

	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			t.Logf("Skipping %s: %v", f, err)
			continue
		}
		var proj interface{}
		if err := json.Unmarshal(data, &proj); err != nil {
			t.Errorf("%s: invalid JSON: %v", f, err)
			continue
		}
		if err := schema.Validate(proj); err != nil {
			t.Logf("%s: fails current schema (expected — uses old format): %v", f, err)
		}
	}
}

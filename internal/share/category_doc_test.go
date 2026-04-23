package share

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// TestCategoryDiagramInSync guards docs/control-category.svg (and its companion
// markdown index) against drift from the real source catalogs. When you add a
// macro, instrument, control action, or genre, re-run `make docs` after
// updating the SVG counts; this test fails until they match.
func TestCategoryDiagramInSync(t *testing.T) {
	root := repoRoot(t)

	got := struct {
		Instruments    int
		Oneshots       int
		Macros         int
		ControlActions int
		Genres         int
	}{
		Instruments:    countInstrumentConfigs(t, filepath.Join(root, "public/audio/tone-engine.js")),
		Oneshots:       countOneshots(t, filepath.Join(root, "public/lib/audio/oneshots.js")),
		Macros:         countMacros(t, filepath.Join(root, "public/lib/macros/catalog.js")),
		ControlActions: countControlActions(t, filepath.Join(root, "internal/share/beats-share.schema.json")),
		Genres:         countGenres(t, filepath.Join(root, "public/lib/ui/build.js")),
	}

	svgPath := filepath.Join(root, "docs/control-category.svg")
	svg := readFile(t, svgPath)

	// Footer must state the right totals.
	footer := fmt.Sprintf("%d instruments · %d macros · %d control actions · %d genres",
		got.Instruments, got.Macros, got.ControlActions, got.Genres)
	if !strings.Contains(svg, footer) {
		t.Errorf("docs/control-category.svg footer is stale.\n  want substring: %q\n  got counts from source: instruments=%d oneshots=%d macros=%d control=%d genres=%d\n  fix: update the footer <text> near the end of control-category.svg, then `make docs`.",
			footer, got.Instruments, got.Oneshots, got.Macros, got.ControlActions, got.Genres)
	}

	// One-shot count in the Instruments cluster.
	oneshotLabel := fmt.Sprintf("one-shots (%d)", got.Oneshots)
	if !strings.Contains(svg, oneshotLabel) {
		t.Errorf("control-category.svg: expected %q pill in the Instruments cluster", oneshotLabel)
	}
}

func repoRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	// Walk up until we find go.mod.
	for dir := wd; dir != "/"; dir = filepath.Dir(dir) {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
	}
	t.Fatal("could not locate repo root (no go.mod found walking up)")
	return ""
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

// countInstrumentConfigs counts top-level keys in the `INSTRUMENT_CONFIGS = {
// ... };` object literal, matching the `    'name': {` pattern used in the
// file (4-space indent, single-quoted string key).
func countInstrumentConfigs(t *testing.T, path string) int {
	body := readFile(t, path)
	start := strings.Index(body, "const INSTRUMENT_CONFIGS = {")
	if start < 0 {
		t.Fatalf("INSTRUMENT_CONFIGS not found in %s", path)
	}
	end := strings.Index(body[start:], "\n};")
	if end < 0 {
		t.Fatalf("closing \\n}; not found for INSTRUMENT_CONFIGS in %s", path)
	}
	block := body[start : start+end]
	re := regexp.MustCompile(`(?m)^    '[a-z][a-z0-9-]*':\s*\{`)
	return len(re.FindAllString(block, -1))
}

// countOneshots counts `{ id: 'name', ...}` entries inside ONESHOT_INSTRUMENTS.
func countOneshots(t *testing.T, path string) int {
	body := readFile(t, path)
	start := strings.Index(body, "ONESHOT_INSTRUMENTS = [")
	if start < 0 {
		t.Fatalf("ONESHOT_INSTRUMENTS not found in %s", path)
	}
	end := strings.Index(body[start:], "\n];")
	if end < 0 {
		t.Fatalf("closing \\n]; not found for ONESHOT_INSTRUMENTS in %s", path)
	}
	block := body[start : start+end]
	re := regexp.MustCompile(`\{\s*id:\s*'[a-z0-9-]+'`)
	return len(re.FindAllString(block, -1))
}

// countMacros counts entries in the MACROS array (identified by `id:` keys on
// object literals). Uses a conservative marker: every MACROS entry has both
// `id:` and `group:` on adjacent lines.
func countMacros(t *testing.T, path string) int {
	body := readFile(t, path)
	start := strings.Index(body, "MACROS = [")
	if start < 0 {
		t.Fatalf("MACROS = [ not found in %s", path)
	}
	end := strings.Index(body[start:], "\n];")
	if end < 0 {
		t.Fatalf("closing \\n]; not found for MACROS in %s", path)
	}
	block := body[start : start+end]
	re := regexp.MustCompile(`group:\s*'[A-Za-z-]+'`)
	return len(re.FindAllString(block, -1))
}

// countControlActions reads the schema's control.action enum and returns its
// length — this is the authoritative list the server validates incoming
// payloads against.
func countControlActions(t *testing.T, path string) int {
	body := readFile(t, path)
	// Cheap JSON parse — just pull out the enum list.
	var schema map[string]any
	if err := json.Unmarshal([]byte(body), &schema); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	actions := findEnumAtPath(schema, "control.action")
	if actions == 0 {
		t.Fatalf("could not locate control.action enum in %s", path)
	}
	return actions
}

// findEnumAtPath walks the schema looking for `control` properties that have
// an `action` with an `enum` array, returning the enum length.
func findEnumAtPath(node any, _ string) int {
	m, ok := node.(map[string]any)
	if !ok {
		if arr, ok := node.([]any); ok {
			for _, v := range arr {
				if n := findEnumAtPath(v, ""); n > 0 {
					return n
				}
			}
		}
		return 0
	}
	if ctrl, ok := m["control"].(map[string]any); ok {
		if props, ok := ctrl["properties"].(map[string]any); ok {
			if action, ok := props["action"].(map[string]any); ok {
				if enum, ok := action["enum"].([]any); ok {
					return len(enum)
				}
			}
		}
	}
	for _, v := range m {
		if n := findEnumAtPath(v, ""); n > 0 {
			return n
		}
	}
	return 0
}

// countGenres counts the <option value="..."> entries in the genre <select>
// inside build.js. The markup uses a `pn-genre-select` class on its select.
func countGenres(t *testing.T, path string) int {
	body := readFile(t, path)
	idx := strings.Index(body, "pn-genre-select")
	if idx < 0 {
		t.Fatalf("pn-genre-select not found in %s", path)
	}
	end := strings.Index(body[idx:], "</select>")
	if end < 0 {
		t.Fatalf("</select> not found after pn-genre-select in %s", path)
	}
	block := body[idx : idx+end]
	re := regexp.MustCompile(`<option\s+value="[a-z]+"`)
	return len(re.FindAllString(block, -1))
}

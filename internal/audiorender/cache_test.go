package audiorender

import (
	"strings"
	"testing"
)

func TestHashIngredientOpts_ZeroValueIsEmpty(t *testing.T) {
	if got := HashIngredientOpts(IngredientOpts{}); got != "" {
		t.Fatalf("zero opts → %q, want empty (bare-CID path)", got)
	}
}

func TestHashIngredientOpts_TempoMatchNoneCollapses(t *testing.T) {
	// "none" is the explicit no-op; should hash identically to omitted.
	if got := HashIngredientOpts(IngredientOpts{TempoMatch: "none"}); got != "" {
		t.Fatalf("tempoMatch=none → %q, want empty (no-op)", got)
	}
}

func TestHashIngredientOpts_OrderInvariant(t *testing.T) {
	a := IngredientOpts{SoloRoles: []string{"drums", "bass"}, Mute: []string{"pad", "lead"}}
	b := IngredientOpts{SoloRoles: []string{"bass", "drums"}, Mute: []string{"lead", "pad"}}
	hA, hB := HashIngredientOpts(a), HashIngredientOpts(b)
	if hA == "" || hA != hB {
		t.Fatalf("ordering should not change hash; got %q vs %q", hA, hB)
	}
}

func TestHashIngredientOpts_DifferentInputsDiffer(t *testing.T) {
	cases := []IngredientOpts{
		{SoloRoles: []string{"drums"}},
		{SoloRoles: []string{"bass"}},
		{Mute: []string{"drums"}},
		{Transpose: 7},
		{Transpose: -7},
		{TempoMatch: "stretch"},
		{TempoMatch: "repitch"},
		{SourceBPM: 120, MasterBPM: 124},
		{SourceBPM: 120, MasterBPM: 128},
	}
	seen := map[string]int{}
	for i, c := range cases {
		h := HashIngredientOpts(c)
		if h == "" {
			t.Fatalf("case %d: opts %#v hashed to empty", i, c)
		}
		if prev, ok := seen[h]; ok {
			t.Fatalf("hash collision: case %d (%#v) and case %d (%#v) both → %q",
				i, c, prev, cases[prev], h)
		}
		seen[h] = i
	}
}

func TestHashIngredientOpts_HashShape(t *testing.T) {
	h := HashIngredientOpts(IngredientOpts{SoloRoles: []string{"drums"}})
	if len(h) != 12 {
		t.Fatalf("expected 12-char hex, got %d (%q)", len(h), h)
	}
	for _, r := range h {
		if !strings.ContainsRune("0123456789abcdef", r) {
			t.Fatalf("non-hex char in hash: %q", h)
		}
	}
}

func TestCachePathFor_IsZeroFallsBackToBare(t *testing.T) {
	r := &Renderer{}
	r.cfg.CacheDir = "/tmp/test-cache"
	cid := "z" + strings.Repeat("a", 50)
	bare := r.CachePathFor(cid, "")
	if !strings.HasSuffix(bare, cid+".webm") {
		t.Fatalf("empty optsHash should produce bare-CID path; got %s", bare)
	}
	v := r.CachePathFor(cid, "abc123")
	if !strings.HasSuffix(v, cid+"-abc123.webm") {
		t.Fatalf("variant path should embed optsHash; got %s", v)
	}
}

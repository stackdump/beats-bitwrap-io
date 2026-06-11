package generator

import "testing"

func TestComposeCohesionV2Stamped(t *testing.T) {
	proj := Compose("techno", map[string]interface{}{
		"seed":     float64(42),
		"cohesion": "v2",
	})
	if proj == nil {
		t.Fatalf("Compose returned nil")
	}
	if proj.Cohesion != "v2" {
		t.Fatalf("expected proj.Cohesion=v2, got %q", proj.Cohesion)
	}
	// v2 melody should be the motif net — slice 2 motifs are 64 steps
	// (4 bars: question + answer over the chord cycle).
	melody := proj.Nets["melody"]
	if melody == nil {
		t.Fatalf("v2 should produce a melody net")
	}
	if got := len(melody.Net.Places); got != 64 {
		t.Fatalf("v2 melody should be a 64-step motif ring; got %d places", got)
	}
	// Slice 2: a harmony pad must exist and voice the chord cycle.
	harmony := proj.Nets["harmony"]
	if harmony == nil {
		t.Fatalf("v2 should produce a harmony pad net")
	}
	if got := len(harmony.Bindings); got != 12 {
		t.Fatalf("harmony pad should voice 4 chords x 3 tones = 12 bindings; got %d", got)
	}
}

func TestComposeCohesionDefaultsToV2(t *testing.T) {
	// Absent param → DefaultCohesion ("v2") for supported genres.
	proj := Compose("techno", map[string]interface{}{
		"seed": float64(42),
	})
	if proj.Cohesion != "v2" {
		t.Fatalf("expected default proj.Cohesion=v2; got %q", proj.Cohesion)
	}
}

func TestComposeCohesionExplicitV1RestoresLegacy(t *testing.T) {
	proj := Compose("techno", map[string]interface{}{
		"seed":     float64(42),
		"cohesion": "v1",
	})
	if proj.Cohesion != "" {
		t.Fatalf("explicit v1 should produce legacy output (no Cohesion stamp); got %q", proj.Cohesion)
	}
	// Legacy melody is a Markov ring, not the 64-step motif.
	if melody := proj.Nets["melody"]; melody != nil {
		if got := len(melody.Net.Places); got == 64 {
			t.Fatalf("explicit v1 should not produce the 64-step motif ring")
		}
	}
	if proj.Nets["harmony"] != nil {
		t.Fatalf("explicit v1 should not produce the chord pad")
	}
}

func TestComposeCohesionServerDefaultConfig(t *testing.T) {
	// Server-wide config: DefaultCohesion="v1" flips the default back to
	// legacy while explicit params still win.
	saved := DefaultCohesion
	defer func() { DefaultCohesion = saved }()

	DefaultCohesion = "v1"
	proj := Compose("techno", map[string]interface{}{"seed": float64(42)})
	if proj.Cohesion != "" {
		t.Fatalf("DefaultCohesion=v1: absent param should produce legacy; got %q", proj.Cohesion)
	}
	proj = Compose("techno", map[string]interface{}{"seed": float64(42), "cohesion": "v2"})
	if proj.Cohesion != "v2" {
		t.Fatalf("explicit v2 should override server default; got %q", proj.Cohesion)
	}
}

func TestComposeCohesionV2BassIsLockedToKick(t *testing.T) {
	proj := Compose("techno", map[string]interface{}{
		"seed":     float64(42),
		"cohesion": "v2",
	})
	kick := proj.Nets["kick"]
	bass := proj.Nets["bass"]
	if kick == nil || bass == nil {
		t.Fatalf("kick and bass should both be present")
	}
	// Techno default groove is FourOnFloor — the bass repeats the kick's
	// bar pattern across the 4-bar chord cycle, so bass hits = 4x kick
	// hits (slice 2 extended the bass ring to walk the chord roots).
	kickHits := len(kick.Bindings)
	bassHits := len(bass.Bindings)
	if bassHits != 4*kickHits {
		t.Fatalf("FourOnFloor x 4-bar cycle: bass hits should be 4x kick (kick=%d bass=%d)",
			kickHits, bassHits)
	}
	// Slice 2: bass must follow the chord roots — collect distinct
	// pitches; techno's i-VII-i-VII prog has 2 distinct roots.
	pitches := map[int]bool{}
	for _, b := range bass.Bindings {
		pitches[b.Note] = true
	}
	if len(pitches) < 2 {
		t.Fatalf("bass should walk chord roots (>=2 distinct pitches); got %d", len(pitches))
	}
}

func TestComposeCohesionV2DropsKickInBreakdown(t *testing.T) {
	// Walk seeds until the random blueprint pick includes a breakdown
	// (2 of the 3 standard EDM blueprints do). Bounded loop; if none of
	// the first 50 seeds hit, the blueprint table is broken.
	var proj *struct{ idx int }
	_ = proj
	for s := int64(1); s < 50; s++ {
		p := Compose("techno", map[string]interface{}{
			"seed":      float64(s),
			"cohesion":  "v2",
			"structure": "standard",
		})
		if p == nil {
			continue
		}
		hasBreakdown := false
		for _, sec := range p.Structure {
			if sec.Name == "breakdown" {
				hasBreakdown = true
				break
			}
		}
		if !hasBreakdown {
			continue
		}
		// Found one. struct-kick should have a mute-track binding
		// firing somewhere in the track (the breakdown boundary).
		ctrl := p.Nets["struct-kick"]
		if ctrl == nil {
			t.Fatalf("seed %d: expected struct-kick control net", s)
		}
		hasMute := false
		for _, b := range ctrl.ControlBindings {
			if b.Action == "mute-track" {
				hasMute = true
				break
			}
		}
		if !hasMute {
			t.Fatalf("seed %d: breakdown blueprint should produce a mute-track binding on struct-kick", s)
		}
		return
	}
	t.Fatalf("no seed in [1,50) produced a blueprint with a breakdown section")
}

func TestComposeCohesionV2IgnoredForUnsupportedGenre(t *testing.T) {
	// All 19 preset genres now support v2 (they all have chord progs).
	// An unknown genre name isn't in the Genres map, so cohesion is not
	// supported and Compose falls through to the techno-fallback preset
	// WITHOUT a v2 stamp (cohesionGenreSupported keys on the requested
	// name, which doesn't exist).
	proj := Compose("not-a-real-genre", map[string]interface{}{
		"seed":     float64(42),
		"cohesion": "v2",
	})
	if proj.Cohesion != "" {
		t.Fatalf("expected proj.Cohesion=\"\" for unknown genre; got %q", proj.Cohesion)
	}
}

func TestComposeCohesionV2AllPresetGenres(t *testing.T) {
	// Every preset genre supports v2 now (harmonic engine + role coverage
	// via explicit tables or synthesizeRoles). Each should stamp v2 and
	// produce a harmony pad.
	for g := range Genres {
		proj := Compose(g, map[string]interface{}{
			"seed":     float64(7),
			"structure": "standard",
			"cohesion": "v2",
		})
		if proj.Cohesion != "v2" {
			t.Errorf("%s: expected v2 stamp, got %q", g, proj.Cohesion)
		}
		if proj.Nets["harmony"] == nil {
			t.Errorf("%s: expected harmony pad", g)
		}
	}
}

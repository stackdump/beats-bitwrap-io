package generator

import (
	"math/rand"
	"testing"
)

func TestFourOnFloorBassMatchesKick(t *testing.T) {
	// Standard techno 4-on-floor kick: 4 hits across 16 steps at positions 0,4,8,12.
	kickMask := []bool{
		true, false, false, false,
		true, false, false, false,
		true, false, false, false,
		true, false, false, false,
	}
	out := GrooveLock(kickMask, GrooveFourOnFloor, nil)
	for i := range kickMask {
		if out[i] != kickMask[i] {
			t.Fatalf("GrooveFourOnFloor step %d: got %v want %v", i, out[i], kickMask[i])
		}
	}
}

func TestSidechainedBassIsKickComplement(t *testing.T) {
	kickMask := []bool{
		true, false, false, false,
		true, false, false, false,
		true, false, false, false,
		true, false, false, false,
	}
	out := GrooveLock(kickMask, GrooveSidechained, nil)
	for i, k := range kickMask {
		if out[i] == k {
			t.Fatalf("GrooveSidechained step %d: bass should be complement of kick (kick=%v got bass=%v)",
				i, k, out[i])
		}
	}
}

func TestOffbeatBassFiresStepBeforeKick(t *testing.T) {
	kickMask := []bool{
		true, false, false, false,
		true, false, false, false,
		true, false, false, false,
		true, false, false, false,
	}
	out := GrooveLock(kickMask, GrooveOffbeat, nil)
	// One step before each kick: 15, 3, 7, 11
	expected := []int{3, 7, 11, 15}
	for _, idx := range expected {
		if !out[idx] {
			t.Fatalf("GrooveOffbeat expected hit at step %d", idx)
		}
	}
}

func TestGrooveLockDeterministicForBreakbeat(t *testing.T) {
	kickMask := KickHitMask(Genres["techno"])
	a := GrooveLock(kickMask, GrooveBreakbeat, rand.New(rand.NewSource(42)))
	b := GrooveLock(kickMask, GrooveBreakbeat, rand.New(rand.NewSource(42)))
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("GrooveBreakbeat not deterministic for same seed at step %d", i)
		}
	}
}

func TestKickHitMaskTechno(t *testing.T) {
	mask := KickHitMask(Genres["techno"])
	if len(mask) != 16 {
		t.Fatalf("expected 16-step mask, got %d", len(mask))
	}
	hits := 0
	for _, b := range mask {
		if b {
			hits++
		}
	}
	if hits != 4 {
		t.Fatalf("techno kick should have 4 hits; got %d", hits)
	}
}

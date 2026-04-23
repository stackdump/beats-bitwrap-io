package generator

import (
	"slices"
	"testing"

	"beats-bitwrap-io/internal/pflow"
)

func TestAddStingerTracks_AppendsFourMutedHitSlots(t *testing.T) {
	proj := &pflow.Project{Nets: make(map[string]*pflow.NetBundle)}
	AddStingerTracks(proj, 42)
	for _, spec := range StingerSpecs {
		nb, ok := proj.Nets[spec.ID]
		if !ok {
			t.Fatalf("%s missing from proj.Nets", spec.ID)
		}
		if nb.Track.Channel != spec.Channel {
			t.Errorf("%s channel = %d, want %d", spec.ID, nb.Track.Channel, spec.Channel)
		}
		if nb.Track.Instrument != spec.DefaultInstrument {
			t.Errorf("%s instrument = %q, want %q", spec.ID, nb.Track.Instrument, spec.DefaultInstrument)
		}
		if len(nb.Track.InstrumentSet) == 0 || nb.Track.InstrumentSet[0] != "unbound" {
			t.Errorf("%s instrumentSet should start with 'unbound', got %v", spec.ID, nb.Track.InstrumentSet)
		}
		if !slices.Contains(proj.InitialMutes, spec.ID) {
			t.Errorf("%s not listed in InitialMutes: %v", spec.ID, proj.InitialMutes)
		}
	}
}

func TestAddStingerTracks_PreservesExistingSlot(t *testing.T) {
	existing := &pflow.NetBundle{Track: pflow.Track{Channel: 99, Instrument: "user-supplied"}}
	proj := &pflow.Project{
		Nets: map[string]*pflow.NetBundle{"hit1": existing},
	}
	AddStingerTracks(proj, 0)
	if proj.Nets["hit1"] != existing {
		t.Fatal("hit1 was clobbered by AddStingerTracks")
	}
	if proj.Nets["hit1"].Track.Instrument != "user-supplied" {
		t.Errorf("hit1 instrument changed to %q", proj.Nets["hit1"].Track.Instrument)
	}
	// The other three should still have been added.
	for _, id := range []string{"hit2", "hit3", "hit4"} {
		if _, ok := proj.Nets[id]; !ok {
			t.Errorf("%s not added", id)
		}
	}
}

func TestCompose_IncludesStingers(t *testing.T) {
	proj := Compose("techno", map[string]any{"seed": float64(1)})
	for _, id := range []string{"hit1", "hit2", "hit3", "hit4"} {
		if _, ok := proj.Nets[id]; !ok {
			t.Errorf("Compose(techno) missing %s net", id)
		}
		if !slices.Contains(proj.InitialMutes, id) {
			t.Errorf("Compose(techno) should mute %s by default", id)
		}
	}
}

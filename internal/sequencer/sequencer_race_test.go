package sequencer

import (
	"sync"
	"testing"

	"beats-bitwrap-io/internal/generator"
	"beats-bitwrap-io/internal/pflow"
)

// TestRaceConcurrentTickAndMute exercises concurrent tick + mute/unmute
// to verify no data races on shared mute maps.
func TestRaceConcurrentTickAndMute(t *testing.T) {
	seq := New()
	proj := generator.Compose("techno", nil)
	seq.LoadPflowProject(proj)

	// Collect net IDs
	var netIds []string
	for id := range proj.Nets {
		netIds = append(netIds, id)
	}

	// Wire callbacks that read mute state (simulating hub broadcast)
	seq.OnMuteChanged = func(nets map[string]bool, notes map[string]map[int]bool) {
		// Read maps to trigger race detector if passed unsafely
		for _, v := range nets {
			_ = v
		}
		for _, m := range notes {
			for _, b := range m {
				_ = b
			}
		}
	}
	seq.OnTransitionFired = func(netId, transId string, midi *pflow.MidiBinding) {}
	seq.OnStateChange = func(state map[string]map[string]float64, tick uint64) {
		for _, ns := range state {
			for _, v := range ns {
				_ = v
			}
		}
	}

	var wg sync.WaitGroup
	const iterations = 500

	// Goroutine 1: tick the sequencer
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < iterations; i++ {
			seq.tick()
		}
	}()

	// Goroutine 2: toggle mutes
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < iterations; i++ {
			id := netIds[i%len(netIds)]
			seq.SetMuted(id, i%2 == 0)
		}
	}()

	// Goroutine 3: read mute state
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < iterations; i++ {
			nets, notes := seq.GetMuteState()
			_ = nets
			_ = notes
		}
	}()

	// Goroutine 4: read project JSON
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < iterations; i++ {
			p := seq.GetProject()
			_ = p
		}
	}()

	wg.Wait()
}

// TestRaceConcurrentPlayStop exercises concurrent play/stop/tick.
func TestRaceConcurrentPlayStop(t *testing.T) {
	seq := New()
	proj := generator.Compose("edm", nil)
	seq.LoadPflowProject(proj)

	seq.OnTransitionFired = func(netId, transId string, midi *pflow.MidiBinding) {}
	seq.OnStateChange = func(state map[string]map[string]float64, tick uint64) {}

	var wg sync.WaitGroup
	const iterations = 200

	// Goroutine 1: play/stop cycles
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < iterations; i++ {
			seq.Play()
			seq.Stop()
		}
	}()

	// Goroutine 2: set tempo while playing
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < iterations; i++ {
			seq.SetTempo(float64(80 + i%140))
		}
	}()

	// Goroutine 3: read project
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < iterations; i++ {
			seq.GetProject()
		}
	}()

	wg.Wait()
}

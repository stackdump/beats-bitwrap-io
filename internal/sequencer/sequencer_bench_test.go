package sequencer

import (
	"testing"

	"beats-bitwrap-io/internal/generator"
	"beats-bitwrap-io/internal/pflow"
)

// setupSequencer creates a sequencer loaded with a generated project.
func setupSequencer(genre string) *Sequencer {
	seq := New()
	proj := generator.Compose(genre, nil)
	seq.LoadPflowProject(proj)
	return seq
}

// BenchmarkTick measures the core tick loop with a techno project.
func BenchmarkTick(b *testing.B) {
	seq := setupSequencer("techno")
	seq.mu.Lock()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		seq.mu.Unlock()
		seq.tick()
		seq.mu.Lock()
	}
	seq.mu.Unlock()
}

// BenchmarkTickEDM uses a larger EDM project with more nets.
func BenchmarkTickEDM(b *testing.B) {
	seq := setupSequencer("edm")
	seq.mu.Lock()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		seq.mu.Unlock()
		seq.tick()
		seq.mu.Lock()
	}
	seq.mu.Unlock()
}

// BenchmarkTickWithBroadcast measures tick including state broadcast.
// Forces broadcast every tick by setting tickCount to a multiple of 6.
func BenchmarkTickWithBroadcast(b *testing.B) {
	seq := setupSequencer("techno")
	broadcastCount := 0
	seq.OnStateChange = func(state map[string]map[string]float64, tick uint64) {
		broadcastCount++
	}
	seq.mu.Lock()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		seq.tickCount = 5 // next tick will be 6, triggering broadcast
		seq.mu.Unlock()
		seq.tick()
		seq.mu.Lock()
	}
	seq.mu.Unlock()
}

// BenchmarkIsEnabled benchmarks transition enablement checks across all nets.
func BenchmarkIsEnabled(b *testing.B) {
	seq := setupSequencer("techno")
	seq.mu.RLock()
	proj := seq.project
	seq.mu.RUnlock()

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		for _, bundle := range proj.Nets {
			for transLabel := range bundle.Net.Transitions {
				bundle.IsEnabled(transLabel)
			}
		}
	}
}

// BenchmarkResolveConflicts benchmarks conflict resolution with a Markov-style net.
func BenchmarkResolveConflicts(b *testing.B) {
	seq := setupSequencer("jazz")
	seq.mu.RLock()
	proj := seq.project
	seq.mu.RUnlock()

	// Find a net with multiple enabled transitions to test conflict resolution
	var testBundle *pflow.NetBundle
	var enabled []string
	for _, bundle := range proj.Nets {
		var en []string
		for tLabel := range bundle.Net.Transitions {
			if bundle.IsEnabled(tLabel) {
				en = append(en, tLabel)
			}
		}
		if len(en) > 1 {
			testBundle = bundle
			enabled = en
			break
		}
	}

	if testBundle == nil {
		b.Skip("no net with multiple enabled transitions found")
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		seq.resolveConflicts(testBundle, enabled)
	}
}

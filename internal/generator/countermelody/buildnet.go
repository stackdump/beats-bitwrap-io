package countermelody

import (
	"fmt"

	"beats-bitwrap-io/internal/pflow"

	"github.com/pflow-xyz/go-pflow/petri"
)

// NetOpts configures BuildMusicNet. The arrange-layer caller allocates
// the channel and picks an instrument; BuildMusicNet materializes the
// ring of places + transitions with MIDI bindings on note-onset ticks.
type NetOpts struct {
	TotalTicks      int
	Channel         int
	Instrument      string
	Group           string  // mixer bucket; defaults to "harmony"
	DefaultVelocity int     // track.defaultVelocity; defaults to 90
	MsPerTick       float64 // 60000 / tempoBPM / PPQ; required for MIDI duration in ms
}

// BuildMusicNet materializes a music net from a note list. Topology
// mirrors injectFeelCurve / MarkovMelody: a ring of TotalTicks places
// + transitions, initial token at p0, arcs p_i → t_i and t_i → p_{(i+1) mod N}.
// Note-onset transitions carry a MidiBinding; the rest are silent
// advancers. Returns nil when TotalTicks <= 0.
func BuildMusicNet(notes []NoteEvent, opts NetOpts) *pflow.NetBundle {
	totalTicks := opts.TotalTicks
	if totalTicks <= 0 {
		return nil
	}
	group := opts.Group
	if group == "" {
		group = "harmony"
	}
	defaultVel := opts.DefaultVelocity
	if defaultVel <= 0 {
		defaultVel = 90
	}

	net := petri.NewPetriNet()
	bindings := make(map[string]*pflow.MidiBinding)

	for i := 0; i < totalTicks; i++ {
		var initial any
		if i == 0 {
			initial = []float64{1}
		}
		net.AddPlace(fmt.Sprintf("p%d", i), initial, nil, 0, 0, nil)
		net.AddTransition(fmt.Sprintf("t%d", i), "", 0, 0, nil)
		net.AddArc(fmt.Sprintf("p%d", i), fmt.Sprintf("t%d", i), []float64{1}, false)
		next := (i + 1) % totalTicks
		net.AddArc(fmt.Sprintf("t%d", i), fmt.Sprintf("p%d", next), []float64{1}, false)
	}

	for _, n := range notes {
		if n.StartTick < 0 || n.StartTick >= totalTicks {
			continue
		}
		durMs := int(float64(n.Duration) * opts.MsPerTick)
		if durMs < 1 {
			durMs = 1
		}
		bindings[fmt.Sprintf("t%d", n.StartTick)] = &pflow.MidiBinding{
			Note:     n.Note,
			Channel:  opts.Channel,
			Velocity: n.Velocity,
			Duration: durMs,
		}
	}

	track := pflow.Track{
		Channel:         opts.Channel,
		DefaultVelocity: defaultVel,
		Instrument:      opts.Instrument,
		Group:           group,
	}
	nb := pflow.NewNetBundle(net, track, bindings)
	nb.Role = "music"
	return nb
}

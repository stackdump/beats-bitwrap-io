package pflow

import (
	"fmt"
	"sort"
)

// ticksPerBar matches sequencer.DefaultPPQ * 4 (4/4 at PPQ=4). Kept here
// as a constant so analysis doesn't pull the sequencer package.
const ticksPerBar = 16

// MacroBacklogWarning describes one control net whose fire-macro bindings
// produce macros faster than the serial runtime can drain them.
type MacroBacklogWarning struct {
	NetID           string  // control net that's overproducing
	CycleTicks      int     // ticks per full token cycle of the net
	FireCount       int     // number of fire-macro transitions in the cycle
	DrainTicks      int     // sum of (macroBars or 1) × 16 across those fires
	OverrunPerCycle int     // DrainTicks - CycleTicks (positive = backlog growth)
	Ratio           float64 // DrainTicks / CycleTicks
}

func (w MacroBacklogWarning) String() string {
	return fmt.Sprintf("%s: %d fire-macro / cycle, drain=%dt cycle=%dt ratio=%.2fx (+%dt/cycle)",
		w.NetID, w.FireCount, w.DrainTicks, w.CycleTicks, w.Ratio, w.OverrunPerCycle)
}

// AnalyzeMacroBacklog inspects every control net in the project and flags
// the ones where the macros fired per token cycle take longer to drain
// than the cycle itself. Since macros run on a serial queue, a ratio > 1.0
// means the backlog grows unbounded as playback continues.
//
// Assumes:
//   - each control net is a simple cycle (one token, cycle_ticks = number
//     of transitions — which is how the sequencer fires them: one per tick);
//   - macroBars=0 on a fire-macro binding defaults to 1 bar (matches the
//     frontend's buildMacroRestoreNet default).
func AnalyzeMacroBacklog(p *Project) []MacroBacklogWarning {
	if p == nil {
		return nil
	}
	var out []MacroBacklogWarning
	netIDs := make([]string, 0, len(p.Nets))
	for id := range p.Nets {
		netIDs = append(netIDs, id)
	}
	sort.Strings(netIDs)

	for _, id := range netIDs {
		nb := p.Nets[id]
		if nb == nil || nb.Role != "control" {
			continue
		}
		cycleTicks := len(nb.Net.Transitions)
		if cycleTicks == 0 {
			continue
		}
		drainTicks := 0
		fireCount := 0
		for _, cb := range nb.ControlBindings {
			if cb == nil || cb.Action != "fire-macro" {
				continue
			}
			bars := cb.MacroBars
			if bars <= 0 {
				bars = 1
			}
			drainTicks += int(bars * ticksPerBar)
			fireCount++
		}
		if fireCount == 0 {
			continue
		}
		if drainTicks > cycleTicks {
			out = append(out, MacroBacklogWarning{
				NetID:           id,
				CycleTicks:      cycleTicks,
				FireCount:       fireCount,
				DrainTicks:      drainTicks,
				OverrunPerCycle: drainTicks - cycleTicks,
				Ratio:           float64(drainTicks) / float64(cycleTicks),
			})
		}
	}
	return out
}

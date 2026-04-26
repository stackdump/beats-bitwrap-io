package generator

import (
	"sort"
	"testing"

	"beats-bitwrap-io/internal/pflow"
)

// TestArrange_NoBoundaryBlast asserts that no tick has more than the
// permitted number of simultaneous unmute / activate-slot firings across
// all control nets in the arranged project. The drum-break stagger fix
// + roleControlNet/linearControlNet stagger should keep section
// boundaries from re-entering as a "blast" hit.
//
// The threshold is intentionally lenient (≤2 simultaneous unmute events)
// — perfect zero is unattainable when 10+ control nets share a boundary
// inside a 12-tick window. Catching regressions back to the original
// 5–7 simultaneous unmutes is the goal.
func TestArrange_NoBoundaryBlast(t *testing.T) {
	cases := []struct {
		genre, structure string
		seed             int64
		drumBreak        int
		fadeIn           []string
	}{
		{"techno", "standard", 42, 0, nil},
		{"trance", "extended", 7, 16, []string{"pad", "harmony"}},
		{"house", "drop", 3, 0, nil},
		{"dnb", "build", 11, 16, nil},
		{"synthwave", "ab", 5, 0, []string{"pad"}},
		{"edm", "jam", 42, 16, []string{"pad"}},
		{"ambient", "minimal", 42, 16, nil},
	}

	const maxSimultaneousUnmutes = 2 // tolerated cap; regressions push this above 2

	for _, tc := range cases {
		t.Run(tc.genre+"_"+tc.structure, func(t *testing.T) {
			proj := Compose(tc.genre, map[string]interface{}{"seed": tc.seed})
			opts := ArrangeOpts{
				Seed:      tc.seed,
				DrumBreak: tc.drumBreak,
				FadeIn:    tc.fadeIn,
			}
			ArrangeWithOpts(proj, tc.genre, tc.structure, opts)

			worst, worstTick, sample := scanBlasts(proj, 4096)
			if worst > maxSimultaneousUnmutes {
				t.Fatalf("boundary blast: %d simultaneous unmutes at tick %d (allowed ≤ %d)\n%s",
					worst, worstTick, maxSimultaneousUnmutes, sample)
			}
		})
	}
}

// scanBlasts walks each control net's ring/chain step-by-step and
// records every unmute-track / activate-slot / unmute-note firing per
// global tick. Returns the worst simultaneous count, its tick, and a
// short sample listing the offending firings.
func scanBlasts(proj *pflow.Project, horizon int) (int, int, string) {
	type fire struct {
		netID, tID, action, target string
	}
	byTick := make(map[int][]fire)

	for netID, nb := range proj.Nets {
		if nb == nil || nb.Role != "control" {
			continue
		}
		for _, f := range simulateControlNet(nb, horizon) {
			byTick[f.tick] = append(byTick[f.tick], fire{netID, f.tID, f.action, f.targetNet})
		}
	}

	worst, worstTick := 0, 0
	for tick, fs := range byTick {
		count := 0
		for _, f := range fs {
			if isUnmuteAction(f.action) {
				count++
			}
		}
		if count > worst {
			worst = count
			worstTick = tick
		}
	}

	sample := ""
	if worst > 0 {
		fs := byTick[worstTick]
		sort.Slice(fs, func(i, j int) bool { return fs[i].netID < fs[j].netID })
		for _, f := range fs {
			if isUnmuteAction(f.action) {
				sample += "  " + f.netID + "/" + f.tID + " " + f.action + " → " + f.target + "\n"
			}
		}
	}
	return worst, worstTick, sample
}

func isUnmuteAction(a string) bool {
	return a == "unmute-track" || a == "unmute-note" || a == "activate-slot"
}

type ctrlFire struct {
	tick                   int
	tID, action, targetNet string
}

// simulateControlNet runs a control net forward, firing one enabled
// transition per tick (sorted t0, t1, t2…), and returns the list of
// transitions that carried a control binding when they fired.
func simulateControlNet(nb *pflow.NetBundle, horizon int) []ctrlFire {
	if nb == nil || nb.Net == nil {
		return nil
	}
	type arc struct {
		place string
		w     int
	}
	inputs := make(map[string][]arc)
	outputs := make(map[string][]arc)
	transitions := make(map[string]bool)
	places := make(map[string]bool)
	for _, p := range nb.Net.Places {
		places[p.Label] = true
	}
	for _, tr := range nb.Net.Transitions {
		transitions[tr.Label] = true
	}
	for _, a := range nb.Net.Arcs {
		w := 0
		for _, v := range a.Weight {
			w += int(v)
		}
		if w < 1 {
			w = 1
		}
		if places[a.Source] && transitions[a.Target] {
			inputs[a.Target] = append(inputs[a.Target], arc{a.Source, w})
		} else if transitions[a.Source] && places[a.Target] {
			outputs[a.Source] = append(outputs[a.Source], arc{a.Target, w})
		}
	}

	marking := make(map[string]int)
	for _, p := range nb.Net.Places {
		if len(p.Initial) > 0 {
			tot := 0
			for _, v := range p.Initial {
				tot += int(v)
			}
			marking[p.Label] = tot
		}
	}

	tIDs := make([]string, 0, len(transitions))
	for tID := range transitions {
		tIDs = append(tIDs, tID)
	}
	sort.Slice(tIDs, func(i, j int) bool {
		if len(tIDs[i]) != len(tIDs[j]) {
			return len(tIDs[i]) < len(tIDs[j])
		}
		return tIDs[i] < tIDs[j]
	})

	var fires []ctrlFire
	for tick := 0; tick < horizon; tick++ {
		chosen := ""
		for _, tID := range tIDs {
			ok := true
			for _, in := range inputs[tID] {
				if marking[in.place] < in.w {
					ok = false
					break
				}
			}
			if ok {
				chosen = tID
				break
			}
		}
		if chosen == "" {
			break
		}
		for _, in := range inputs[chosen] {
			marking[in.place] -= in.w
		}
		for _, out := range outputs[chosen] {
			marking[out.place] += out.w
		}
		if cb, ok := nb.ControlBindings[chosen]; ok && cb != nil {
			fires = append(fires, ctrlFire{tick, chosen, cb.Action, cb.TargetNet})
		}
	}
	return fires
}


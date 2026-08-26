package pflow

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
)

// CID computes a content-addressed identifier for a project.
// Deterministic: same project structure always produces the same CID.
// Compatible with go-pflow's CID approach (SHA256 of normalized JSON).
func (p *Project) CID() string {
	data, err := p.CanonicalJSON()
	if err != nil {
		return ""
	}
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

// CanonicalJSON returns the exact bytes the CID hashes: the normalized,
// deterministically ordered model JSON. Exported so the Go↔JS parity
// harness (tools/parity) can byte-compare this path against the JS
// implementation (public/lib/pflow.js::canonicalProjectJSON).
func (p *Project) CanonicalJSON() ([]byte, error) {
	return json.Marshal(p.normalizeForCID())
}

// normalizeForCID creates a deterministically ordered representation.
// Sorts nets by ID, places/transitions by label, arcs by source+target.
func (p *Project) normalizeForCID() map[string]interface{} {
	result := map[string]interface{}{
		"name":  p.Name,
		"tempo": p.Tempo,
	}
	if p.Swing > 0 {
		result["swing"] = p.Swing
	}
	if p.Humanize > 0 {
		result["humanize"] = p.Humanize
	}

	// Sort net IDs for deterministic ordering
	netIDs := make([]string, 0, len(p.Nets))
	for id := range p.Nets {
		netIDs = append(netIDs, id)
	}
	sort.Strings(netIDs)

	nets := make(map[string]interface{}, len(p.Nets))
	for _, id := range netIDs {
		bundle := p.Nets[id]
		nets[id] = normalizeBundle(bundle)
	}
	result["nets"] = nets

	return result
}

func normalizeBundle(b *NetBundle) map[string]interface{} {
	n := make(map[string]interface{})

	if b.Role != "" && b.Role != "music" {
		n["role"] = b.Role
	}
	if b.RiffGroup != "" {
		n["riffGroup"] = b.RiffGroup
	}

	// Sort places
	placeIDs := make([]string, 0, len(b.Net.Places))
	for id := range b.Net.Places {
		placeIDs = append(placeIDs, id)
	}
	sort.Strings(placeIDs)

	places := make(map[string]interface{})
	for _, id := range placeIDs {
		p := b.Net.Places[id]
		place := map[string]interface{}{
			"initial": p.Initial,
		}
		places[id] = place
	}
	n["places"] = places

	// Sort transitions
	transIDs := make([]string, 0, len(b.Net.Transitions))
	for id := range b.Net.Transitions {
		transIDs = append(transIDs, id)
	}
	sort.Strings(transIDs)

	transitions := make(map[string]interface{})
	for _, id := range transIDs {
		t := make(map[string]interface{})
		if midi, ok := b.Bindings[id]; ok {
			m := map[string]interface{}{
				"note":     midi.Note,
				"velocity": midi.Velocity,
				"channel":  midi.Channel,
			}
			// Canonical-form rule (duration.go): hash durationSteps when
			// present, else the legacy ms — so every pre-steps model
			// keeps its CID unchanged.
			if midi.DurationSteps > 0 {
				m["durationSteps"] = midi.DurationSteps
			} else {
				m["duration"] = midi.Duration
			}
			t["midi"] = m
		}
		if ctrl, ok := b.ControlBindings[id]; ok {
			c := map[string]interface{}{"action": ctrl.Action}
			if ctrl.TargetNet != "" {
				c["targetNet"] = ctrl.TargetNet
			}
			t["control"] = c
		}
		transitions[id] = t
	}
	n["transitions"] = transitions

	// Sort arcs by source+target
	type arcKey struct {
		source, target string
		weight         []float64
		inhibit        bool
	}
	arcs := make([]arcKey, len(b.Net.Arcs))
	for i, a := range b.Net.Arcs {
		arcs[i] = arcKey{source: a.Source, target: a.Target, weight: a.Weight[:], inhibit: a.InhibitTransition}
	}
	sort.Slice(arcs, func(i, j int) bool {
		if arcs[i].source != arcs[j].source {
			return arcs[i].source < arcs[j].source
		}
		return arcs[i].target < arcs[j].target
	})

	arcList := make([]map[string]interface{}, len(arcs))
	for i, a := range arcs {
		arc := map[string]interface{}{
			"source": a.source,
			"target": a.target,
			"weight": a.weight,
		}
		if a.inhibit {
			arc["inhibit"] = true
		}
		arcList[i] = arc
	}
	n["arcs"] = arcList

	return n
}

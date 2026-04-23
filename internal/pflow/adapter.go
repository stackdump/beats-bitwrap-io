// Package pflow adapts go-pflow Petri nets for use in petri-note.
// MIDI bindings are kept separate from the net structure since go-pflow
// transitions have no concept of MIDI.
package pflow

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"github.com/pflow-xyz/go-pflow/petri"
)

// MidiBinding defines note parameters for a transition.
type MidiBinding struct {
	Note     int `json:"note"`
	Channel  int `json:"channel"`
	Velocity int `json:"velocity"`
	Duration int `json:"duration"` // ms
}

// Track holds MIDI channel settings for a net.
type Track struct {
	Channel         int      `json:"channel"`
	DefaultVelocity int      `json:"defaultVelocity"`
	Instrument      string   `json:"instrument,omitempty"`
	InstrumentSet   []string `json:"instrumentSet,omitempty"`
}

// ControlBinding defines a control action for a transition.
//
// Action verbs: mute-track, unmute-track, toggle-track, mute-note,
// unmute-note, toggle-note, activate-slot, stop-transport, fire-macro.
//
// When Action == "fire-macro", Macro names the frontend macro to run
// (looked up in public/lib/macros/catalog.js on the client — the server
// stays pass-through, never validates the ID) and MacroBars sets the
// auto-release duration. MacroParams is free-form per-macro overrides
// (e.g. {"depth": 0.8, "lfoHz": 2}) that the frontend merges onto the
// macro's default payload.
type ControlBinding struct {
	Action      string         `json:"action"`
	TargetNet   string         `json:"targetNet,omitempty"`
	TargetNote  int            `json:"targetNote,omitempty"`
	Macro       string         `json:"macro,omitempty"`
	MacroBars   float64        `json:"macroBars,omitempty"`
	MacroParams map[string]any `json:"macroParams,omitempty"`
}

// FiringResult holds the result of a transition firing.
type FiringResult struct {
	Midi    *MidiBinding
	Control *ControlBinding
}

// cachedArc holds a pointer to an arc with its precomputed weight sum.
type cachedArc struct {
	*petri.Arc
	weightSum float64
}

// NetBundle pairs a go-pflow PetriNet with its musical metadata.
type NetBundle struct {
	Net             *petri.PetriNet
	Track           Track
	Role            string                     // "music" or "control"
	RiffGroup       string                     // groups variant nets (e.g., "kick" for kick-A, kick-B)
	RiffVariant     string                     // tension letter (A/B/C) for display grouping
	Bindings        map[string]*MidiBinding    // transitionLabel -> binding
	ControlBindings map[string]*ControlBinding // transitionLabel -> control binding
	State           map[string]float64         // placeLabel -> tokens (mutable runtime state)

	// Precomputed arc indices for O(1) lookup in hot path
	inputArcs  map[string][]cachedArc // transitionLabel -> input arcs
	outputArcs map[string][]cachedArc // transitionLabel -> output arcs

	fireResult FiringResult // reusable result to avoid allocation per Fire call
}

// Connection represents an inter-net signal/token route.
type Connection struct {
	FromNet        string `json:"fromNet"`
	FromPlace      string `json:"fromPlace,omitempty"`
	FromTransition string `json:"fromTransition,omitempty"`
	ToNet          string `json:"toNet"`
	ToPlace        string `json:"toPlace,omitempty"`
	ToTransition   string `json:"toTransition,omitempty"`
	Type           string `json:"type"` // "signal", "token", "sync"
}

// Project is the top-level model: multiple nets with connections.
// StructureSection describes a section of a structured song.
type StructureSection struct {
	Name    string              `json:"name"`
	Steps   int                 `json:"steps"`
	Phrases map[string][]string `json:"phrases,omitempty"` // role -> variant sequence
}

type Project struct {
	Name         string
	Tempo        float64
	Swing        float64 // 0-100 swing percentage
	Humanize     float64 // 0-100 humanize amount
	Nets         map[string]*NetBundle
	Connections  []Connection
	InitialMutes []string           // Net IDs that should start muted (for fade-in)
	Structure    []StructureSection // Song structure sections (nil for loop mode)
	// FX holds master-bus FX settings (reverb, delay, phaser, etc.) as a
	// free-form map. The server doesn't interpret the values; they're
	// carried here so load-modify-seal round-trips preserve whatever the
	// frontend authored. Keys match FxSettings in petri-note.schema.json.
	FX map[string]any
}

// NewNetBundle creates a NetBundle from a go-pflow PetriNet.
func NewNetBundle(net *petri.PetriNet, track Track, bindings map[string]*MidiBinding) *NetBundle {
	state := net.SetState(nil) // initialize from net's initial markings
	nb := &NetBundle{
		Net:      net,
		Track:    track,
		Bindings: bindings,
		State:    state,
	}
	nb.buildArcIndex()
	return nb
}

// buildArcIndex precomputes input/output arc lookups and caches weight sums.
func (nb *NetBundle) buildArcIndex() {
	nb.inputArcs = make(map[string][]cachedArc)
	nb.outputArcs = make(map[string][]cachedArc)
	for _, arc := range nb.Net.Arcs {
		ca := cachedArc{Arc: arc, weightSum: arc.GetWeightSum()}
		nb.inputArcs[arc.Target] = append(nb.inputArcs[arc.Target], ca)
		nb.outputArcs[arc.Source] = append(nb.outputArcs[arc.Source], ca)
	}
}

// ResetState resets the runtime state to initial markings.
func (nb *NetBundle) ResetState() {
	nb.State = nb.Net.SetState(nil)
}

// IsEnabled checks if a transition can fire given the current state.
func (nb *NetBundle) IsEnabled(transLabel string) bool {
	for _, ca := range nb.inputArcs[transLabel] {
		tokens := nb.State[ca.Source]
		if ca.InhibitTransition {
			if tokens >= ca.weightSum {
				return false
			}
		} else {
			if tokens < ca.weightSum {
				return false
			}
		}
	}
	return true
}

// Fire executes a transition: consumes input tokens, produces output tokens.
// Returns a pointer to an internal FiringResult — valid only until the next Fire call.
func (nb *NetBundle) Fire(transLabel string) *FiringResult {
	// Consume inputs
	for _, ca := range nb.inputArcs[transLabel] {
		if !ca.InhibitTransition {
			nb.State[ca.Source] -= ca.weightSum
			if nb.State[ca.Source] < 0 {
				nb.State[ca.Source] = 0
			}
		}
	}
	// Produce outputs
	for _, ca := range nb.outputArcs[transLabel] {
		nb.State[ca.Target] += ca.weightSum
	}
	nb.fireResult.Midi = nb.Bindings[transLabel]
	nb.fireResult.Control = nil
	if nb.ControlBindings != nil {
		nb.fireResult.Control = nb.ControlBindings[transLabel]
	}
	return &nb.fireResult
}

// GetInputArcs returns precomputed input arcs for use by resolveConflicts.
func (nb *NetBundle) GetInputArcs(transLabel string) []cachedArc {
	return nb.inputArcs[transLabel]
}

// ParseProject converts a raw JSON map (from WebSocket) into a Project.
func ParseProject(data map[string]interface{}) *Project {
	proj := &Project{
		Name:     getString(data, "name", "Untitled"),
		Tempo:    getFloat(data, "tempo", 120),
		Swing:    getFloat(data, "swing", 0),
		Humanize: getFloat(data, "humanize", 0),
		Nets:     make(map[string]*NetBundle),
	}

	nets, ok := data["nets"].(map[string]interface{})
	if !ok {
		return proj
	}

	for netId, netData := range nets {
		netMap, ok := netData.(map[string]interface{})
		if !ok {
			continue
		}
		proj.Nets[netId] = parseNetBundle(netMap)
	}

	// Parse structure sections
	if sections, ok := data["structure"].([]interface{}); ok {
		for _, s := range sections {
			if sm, ok := s.(map[string]interface{}); ok {
				ss := StructureSection{
					Name:  getString(sm, "name", ""),
					Steps: int(getFloat(sm, "steps", 0)),
				}
				if phrases, ok := sm["phrases"].(map[string]interface{}); ok {
					ss.Phrases = make(map[string][]string)
					for role, arr := range phrases {
						if varr, ok := arr.([]interface{}); ok {
							for _, v := range varr {
								if vs, ok := v.(string); ok {
									ss.Phrases[role] = append(ss.Phrases[role], vs)
								}
							}
						}
					}
				}
				proj.Structure = append(proj.Structure, ss)
			}
		}
	}

	// Parse initial mutes
	if mutes, ok := data["initialMutes"].([]interface{}); ok {
		for _, m := range mutes {
			if s, ok := m.(string); ok {
				proj.InitialMutes = append(proj.InitialMutes, s)
			}
		}
	}

	// Pass-through FX — we don't interpret the values, just preserve them
	// across load/share/save round-trips so the browser re-applies the
	// same reverb/delay/phaser/etc. state authored on the other side.
	if fx, ok := data["fx"].(map[string]interface{}); ok {
		proj.FX = fx
	}

	return proj
}

func parseNetBundle(data map[string]interface{}) *NetBundle {
	net := petri.NewPetriNet()
	bindings := make(map[string]*MidiBinding)
	controlBindings := make(map[string]*ControlBinding)
	track := Track{Channel: 1, DefaultVelocity: 100}
	role := getString(data, "role", "music")

	// Parse track
	if t, ok := data["track"].(map[string]interface{}); ok {
		track.Channel = getInt(t, "channel", 1)
		track.DefaultVelocity = getInt(t, "defaultVelocity", 100)
		track.Instrument = getString(t, "instrument", "")
		if arr, ok := t["instrumentSet"].([]interface{}); ok {
			for _, v := range arr {
				if s, ok := v.(string); ok {
					track.InstrumentSet = append(track.InstrumentSet, s)
				}
			}
		}
	}

	// Parse places
	if places, ok := data["places"].(map[string]interface{}); ok {
		for id, pData := range places {
			pm, ok := pData.(map[string]interface{})
			if !ok {
				continue
			}
			initial := getFloatArray(pm, "initial", []float64{0})
			var initVal interface{} = initial
			net.AddPlace(id, initVal, nil,
				getFloat(pm, "x", 0), getFloat(pm, "y", 0), nil)
		}
	}

	// Parse transitions
	if transitions, ok := data["transitions"].(map[string]interface{}); ok {
		for id, tData := range transitions {
			tm, ok := tData.(map[string]interface{})
			if !ok {
				continue
			}
			net.AddTransition(id, "",
				getFloat(tm, "x", 0), getFloat(tm, "y", 0), nil)

			// MIDI binding
			if midi, ok := tm["midi"].(map[string]interface{}); ok {
				bindings[id] = &MidiBinding{
					Note:     getInt(midi, "note", 60),
					Channel:  getInt(midi, "channel", track.Channel),
					Velocity: getInt(midi, "velocity", track.DefaultVelocity),
					Duration: getInt(midi, "duration", 100),
				}
			}

			// Control binding
			if ctrl, ok := tm["control"].(map[string]interface{}); ok {
				cb := &ControlBinding{
					Action:     getString(ctrl, "action", "toggle-track"),
					TargetNet:  getString(ctrl, "targetNet", ""),
					TargetNote: getInt(ctrl, "targetNote", 0),
					Macro:      getString(ctrl, "macro", ""),
					MacroBars:  getFloat(ctrl, "macroBars", 0),
				}
				if mp, ok := ctrl["macroParams"].(map[string]interface{}); ok {
					cb.MacroParams = mp
				}
				controlBindings[id] = cb
			}
		}
	}

	// Parse arcs
	if arcs, ok := data["arcs"].([]interface{}); ok {
		for _, aData := range arcs {
			am, ok := aData.(map[string]interface{})
			if !ok {
				continue
			}
			weight := getFloatArray(am, "weight", []float64{1})
			net.AddArc(
				getString(am, "source", ""),
				getString(am, "target", ""),
				weight,
				getBool(am, "inhibit", false),
			)
		}
	}

	nb := NewNetBundle(net, track, bindings)
	nb.Role = role
	nb.RiffGroup = getString(data, "riffGroup", "")
	nb.RiffVariant = getString(data, "riffVariant", "")
	nb.ControlBindings = controlBindings
	return nb
}

// ToJSON converts a Project back to the JSON format the frontend expects.
func (p *Project) ToJSON() map[string]interface{} {
	result := map[string]interface{}{
		"name":  p.Name,
		"tempo": p.Tempo,
		"nets":  make(map[string]interface{}),
	}

	if p.Swing > 0 {
		result["swing"] = p.Swing
	}
	if p.Humanize > 0 {
		result["humanize"] = p.Humanize
	}

	nets := result["nets"].(map[string]interface{})
	for netId, bundle := range p.Nets {
		nets[netId] = bundleToJSON(bundle)
	}

	if len(p.InitialMutes) > 0 {
		result["initialMutes"] = p.InitialMutes
	}

	if len(p.FX) > 0 {
		result["fx"] = p.FX
	}

	if len(p.Structure) > 0 {
		sections := make([]map[string]interface{}, len(p.Structure))
		for i, sec := range p.Structure {
			s := map[string]interface{}{
				"name":  sec.Name,
				"steps": sec.Steps,
			}
			if len(sec.Phrases) > 0 {
				s["phrases"] = sec.Phrases
			}
			sections[i] = s
		}
		result["structure"] = sections
	}

	return result
}

// ToJSONLD wraps the project in a schema.org MusicComposition JSON-LD document.
func (p *Project) ToJSONLD(baseURL string) map[string]interface{} {
	proj := p.ToJSON()

	// Content-address the project for a stable @id
	projBytes, _ := json.Marshal(proj)
	hash := sha256.Sum256(projBytes)
	cid := hex.EncodeToString(hash[:16])

	// Extract track info for schema.org
	tracks := []map[string]interface{}{}
	if nets, ok := proj["nets"].(map[string]interface{}); ok {
		for name, netData := range nets {
			netMap, ok := netData.(map[string]interface{})
			if !ok {
				continue
			}
			track := map[string]interface{}{
				"@type": "MusicRecording",
				"name":  name,
			}
			if t, ok := netMap["track"].(map[string]interface{}); ok {
				if inst, ok := t["instrument"].(string); ok {
					track["instrument"] = inst
				}
			}
			if rg, ok := netMap["riffGroup"].(string); ok {
				track["isPartOf"] = rg
			}
			tracks = append(tracks, track)
		}
	}

	ld := map[string]interface{}{
		"@context": map[string]interface{}{
			"@vocab":    "https://schema.org/",
			"petriNote": "https://petri-note.dev/schema/v1#",
		},
		"@type":       "MusicComposition",
		"@id":         fmt.Sprintf("%s/api/song/%s.jsonld", baseURL, cid),
		"name":        p.Name,
		"dateCreated": time.Now().UTC().Format(time.RFC3339),
		"creator": map[string]interface{}{
			"@type": "SoftwareApplication",
			"name":  "petri-note",
			"url":   baseURL,
		},
		"musicalTempo": map[string]interface{}{
			"@type":    "QuantitativeValue",
			"value":    p.Tempo,
			"unitText": "BPM",
		},
		"track":              tracks,
		"petriNote:project":  proj,
		"petriNote:swing":    p.Swing,
		"petriNote:humanize": p.Humanize,
		"encodingFormat":     "application/ld+json",
	}

	if len(p.Structure) > 0 {
		sections := []string{}
		for _, sec := range p.Structure {
			sections = append(sections, sec.Name)
		}
		ld["petriNote:structure"] = sections
	}

	return ld
}

// BundleToJSON converts a NetBundle to a JSON-serializable map.
func BundleToJSON(nb *NetBundle) map[string]interface{} {
	return bundleToJSON(nb)
}

// ParseBundle parses a JSON map into a NetBundle.
func ParseBundle(data map[string]interface{}) *NetBundle {
	return parseNetBundle(data)
}

func bundleToJSON(nb *NetBundle) map[string]interface{} {
	trackMap := map[string]interface{}{
		"channel":         nb.Track.Channel,
		"defaultVelocity": nb.Track.DefaultVelocity,
	}
	if nb.Track.Instrument != "" {
		trackMap["instrument"] = nb.Track.Instrument
	}
	if len(nb.Track.InstrumentSet) > 0 {
		trackMap["instrumentSet"] = nb.Track.InstrumentSet
	}
	result := map[string]interface{}{
		"track": trackMap,
	}
	if nb.Role != "" && nb.Role != "music" {
		result["role"] = nb.Role
	}
	if nb.RiffGroup != "" {
		result["riffGroup"] = nb.RiffGroup
	}
	if nb.RiffVariant != "" {
		result["riffVariant"] = nb.RiffVariant
	}

	// Places
	places := make(map[string]interface{})
	for label, place := range nb.Net.Places {
		p := map[string]interface{}{
			"x":       place.X,
			"y":       place.Y,
			"initial": place.Initial,
		}
		if place.LabelText != nil {
			p["label"] = *place.LabelText
		}
		places[label] = p
	}
	result["places"] = places

	// Transitions
	transitions := make(map[string]interface{})
	for label, trans := range nb.Net.Transitions {
		t := map[string]interface{}{
			"x": trans.X,
			"y": trans.Y,
		}
		if trans.LabelText != nil {
			t["label"] = *trans.LabelText
		}
		if midi, ok := nb.Bindings[label]; ok {
			t["midi"] = map[string]interface{}{
				"note":     midi.Note,
				"channel":  midi.Channel,
				"velocity": midi.Velocity,
				"duration": midi.Duration,
			}
		}
		if ctrl, ok := nb.ControlBindings[label]; ok {
			cm := map[string]interface{}{
				"action":    ctrl.Action,
				"targetNet": ctrl.TargetNet,
			}
			if ctrl.TargetNote > 0 {
				cm["targetNote"] = ctrl.TargetNote
			}
			if ctrl.Macro != "" {
				cm["macro"] = ctrl.Macro
			}
			if ctrl.MacroBars > 0 {
				cm["macroBars"] = ctrl.MacroBars
			}
			if len(ctrl.MacroParams) > 0 {
				cm["macroParams"] = ctrl.MacroParams
			}
			t["control"] = cm
		}
		transitions[label] = t
	}
	result["transitions"] = transitions

	// Arcs
	arcs := make([]interface{}, 0, len(nb.Net.Arcs))
	for _, arc := range nb.Net.Arcs {
		a := map[string]interface{}{
			"source": arc.Source,
			"target": arc.Target,
			"weight": arc.Weight,
		}
		if arc.InhibitTransition {
			a["inhibit"] = true
		}
		arcs = append(arcs, a)
	}
	result["arcs"] = arcs

	return result
}

// JSON parsing helpers
func getString(m map[string]interface{}, key, def string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return def
}

func getFloat(m map[string]interface{}, key string, def float64) float64 {
	switch v := m[key].(type) {
	case float64:
		return v
	case int:
		return float64(v)
	}
	return def
}

func getInt(m map[string]interface{}, key string, def int) int {
	switch v := m[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	}
	return def
}

func getBool(m map[string]interface{}, key string, def bool) bool {
	if v, ok := m[key].(bool); ok {
		return v
	}
	return def
}

func getFloatArray(m map[string]interface{}, key string, def []float64) []float64 {
	raw, ok := m[key]
	if !ok {
		return def
	}
	switch arr := raw.(type) {
	case []interface{}:
		result := make([]float64, len(arr))
		for i, v := range arr {
			switch val := v.(type) {
			case float64:
				result[i] = val
			case int:
				result[i] = float64(val)
			}
		}
		return result
	case []float64:
		// ToJSON emits []float64 directly; accept it so in-process
		// ToJSON→ParseProject round-trips don't lose initial markings.
		out := make([]float64, len(arr))
		copy(out, arr)
		return out
	}
	return def
}

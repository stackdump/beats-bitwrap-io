package ws

import "beats-bitwrap-io/internal/pflow"

// BaseMessage for type detection
type BaseMessage struct {
	Type string `json:"type"`
}

// === Client -> Server Messages ===

// TransportMessage controls playback
type TransportMessage struct {
	Type   string `json:"type"`   // "transport"
	Action string `json:"action"` // "play", "stop", "pause"
}

// TempoMessage changes tempo
type TempoMessage struct {
	Type string  `json:"type"` // "tempo"
	BPM  float64 `json:"bpm"`
}

// ProjectLoadMessage loads a project
type ProjectLoadMessage struct {
	Type    string                 `json:"type"` // "project-load"
	Project map[string]interface{} `json:"project"`
}

// TransitionFireMessage manually fires a transition
type TransitionFireMessage struct {
	Type         string `json:"type"` // "transition-fire"
	NetId        string `json:"netId"`
	TransitionId string `json:"transitionId"`
}

// GenerateMessage requests auto-generation of a track
type GenerateMessage struct {
	Type   string                 `json:"type"` // "generate"
	Genre  string                 `json:"genre"`
	Params map[string]interface{} `json:"params,omitempty"`
}

// EditMessage for editing operations
type EditMessage struct {
	Type    string                 `json:"type"` // "edit"
	NetId   string                 `json:"netId"`
	Op      string                 `json:"op"`
	Payload map[string]interface{} `json:"payload"`
}

// === Server -> Client Messages ===

// TransitionFiredMessage notifies of transition firing
type TransitionFiredMessage struct {
	Type         string             `json:"type"` // "transition-fired"
	NetId        string             `json:"netId"`
	TransitionId string             `json:"transitionId"`
	Midi         *pflow.MidiBinding `json:"midi,omitempty"`
}

// StateSyncMessage synchronizes state
type StateSyncMessage struct {
	Type  string                        `json:"type"` // "state-sync"
	State map[string]map[string]float64 `json:"state"`
	Tick  uint64                        `json:"tick"`
}

// TempoChangedMessage notifies of tempo change
type TempoChangedMessage struct {
	Type  string  `json:"type"` // "tempo-changed"
	Tempo float64 `json:"tempo"`
}

// ProjectSyncMessage sends full project to client (after generation)
type ProjectSyncMessage struct {
	Type    string                 `json:"type"` // "project-sync"
	Project map[string]interface{} `json:"project"`
}

// ShuffleInstrumentsMessage requests instrument shuffle
type ShuffleInstrumentsMessage struct {
	Type string `json:"type"` // "shuffle-instruments"
	Seed int64  `json:"seed,omitempty"`
}

// InstrumentsChangedMessage notifies of instrument changes
type InstrumentsChangedMessage struct {
	Type        string            `json:"type"`        // "instruments-changed"
	Instruments map[string]string `json:"instruments"` // netId -> instrument name
}

// MuteMessage sets mute state for a net (client -> server)
type MuteMessage struct {
	Type  string `json:"type"` // "mute"
	NetId string `json:"netId"`
	Muted bool   `json:"muted"`
}

// InstrumentChangeMessage changes a net's bound instrument (client -> server).
// When RiffGroup is set it takes precedence over NetId and the change is
// fanned out to every net sharing that group — matching the dropdown
// behavior in public/lib/ui/mixer.js. The server broadcasts the resolved
// netId -> instrument map back via InstrumentsChangedMessage.
type InstrumentChangeMessage struct {
	Type       string `json:"type"` // "instrument-change"
	NetId      string `json:"netId,omitempty"`
	Instrument string `json:"instrument"`
	RiffGroup  string `json:"riffGroup,omitempty"`
}

// MuteGroupMessage sets mute state for a riff group (client -> server)
type MuteGroupMessage struct {
	Type      string `json:"type"` // "mute-group"
	RiffGroup string `json:"riffGroup"`
	Muted     bool   `json:"muted"`
}

// ControlFiredMessage notifies of control event firing (server -> client)
type ControlFiredMessage struct {
	Type         string                `json:"type"` // "control-fired"
	NetId        string                `json:"netId"`
	TransitionId string                `json:"transitionId"`
	Control      *pflow.ControlBinding `json:"control"`
}

// MuteStateMessage sends current mute state to clients (server -> client)
type MuteStateMessage struct {
	Type       string                  `json:"type"` // "mute-state"
	MutedNets  map[string]bool         `json:"mutedNets"`
	MutedNotes map[string]map[int]bool `json:"mutedNotes"`
}

// PlaybackCompleteMessage notifies clients that structured playback has ended
type PlaybackCompleteMessage struct {
	Type string `json:"type"` // "playback-complete"
}

// SeekMessage requests seeking to a specific tick position
type SeekMessage struct {
	Type string `json:"type"` // "seek"
	Tick uint64 `json:"tick"`
}

// CropMessage trims the project to a tick range (client -> server)
type CropMessage struct {
	Type      string `json:"type"` // "crop"
	StartTick int64  `json:"startTick"`
	EndTick   int64  `json:"endTick"`
}

// LoopMessage sets loop start/end tick positions (client -> server)
type LoopMessage struct {
	Type      string `json:"type"`      // "loop"
	StartTick int64  `json:"startTick"` // -1 to disable
	EndTick   int64  `json:"endTick"`   // -1 to disable
}

// LoopChangedMessage notifies clients of loop state (server -> client)
type LoopChangedMessage struct {
	Type      string `json:"type"` // "loop-changed"
	StartTick int64  `json:"startTick"`
	EndTick   int64  `json:"endTick"`
}

// ArrangeMessage wraps the current project with song structure (client -> server)
type ArrangeMessage struct {
	Type      string `json:"type"`      // "arrange"
	Genre     string `json:"genre"`     // genre family for structure selection
	Structure string `json:"structure"` // "minimal", "standard", "extended"
}

// DeterministicLoopMessage toggles deterministic loop mode (client -> server)
type DeterministicLoopMessage struct {
	Type    string `json:"type"` // "deterministic-loop"
	Enabled bool   `json:"enabled"`
}

// GeneratePreviewMessage requests generation without loading (client -> server)
type GeneratePreviewMessage struct {
	Type   string                 `json:"type"` // "generate-preview"
	Genre  string                 `json:"genre"`
	Params map[string]interface{} `json:"params,omitempty"`
}

// PreviewReadyMessage sends a pre-generated project to the client (server -> client)
type PreviewReadyMessage struct {
	Type    string                 `json:"type"` // "preview-ready"
	Project map[string]interface{} `json:"project"`
}

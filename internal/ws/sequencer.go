package ws

// SequencerControl defines the sequencer operations used by the WebSocket hub.
// Decouples the hub from the concrete sequencer implementation for testability.
type SequencerControl interface {
	Play()
	Stop()
	Pause()
	IsPlaying() bool
	SetTempo(bpm float64)
	LoadProject(data map[string]interface{})
	FireTransition(netId, transitionId string)
	SetMuted(netId string, muted bool)
	SetGroupMuted(riffGroup string, muted bool)
	SetInstrument(netId, riffGroup, instrument string) map[string]string
	Seek(targetTick uint64)
	SetLoop(startTick, endTick int64)
	GetLoop() (int64, int64)
	SetDeterministicLoop(enabled bool)
	CropProject(startTick, endTick int64) map[string]interface{}
}

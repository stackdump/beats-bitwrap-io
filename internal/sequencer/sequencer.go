package sequencer

import (
	"context"
	"math/rand"
	"sync"
	"time"

	"beats-bitwrap-io/internal/generator"
	"beats-bitwrap-io/internal/pflow"
)

const (
	DefaultTempo = 120
	DefaultPPQ   = 4 // 4 ticks per beat = 16th notes
	MinBPM       = 20
	MaxBPM       = 300
)

// Sequencer orchestrates multiple nets with timing.
// It is the single authority for net execution — the frontend
// only renders and plays audio from server-sent events.
type Sequencer struct {
	project *pflow.Project
	playing bool
	tempo   float64 // BPM
	ppq     int     // Pulses per quarter note

	// Mute state
	mutedNets   map[string]bool         // netId -> muted
	mutedNotes  map[string]map[int]bool // netId -> note -> muted
	mutedGroups map[string]bool         // riffGroup -> user-muted (prevents activate-slot override)

	cancel context.CancelFunc
	mu     sync.RWMutex

	tickCount     uint64
	stopRequested bool

	// Loop markers (tick positions, -1 = disabled)
	loopStart int64
	loopEnd   int64

	// Deterministic loop: when true, conflict resolution uses a seeded PRNG
	// and loop wraps reset to initial state so loops repeat exactly.
	deterministicLoop bool

	// Pending project for bar-quantized swap (applied at next bar boundary)
	pendingProject *pflow.Project

	// Reusable buffers to reduce allocations in the tick hot path
	enabledBuf     []string
	placeConsumers map[string][]string
	blocked        map[string]bool
	stateBuf       map[string]map[string]float64

	// Callbacks
	OnTransitionFired  func(netId, transitionId string, midi *pflow.MidiBinding)
	OnStateChange      func(state map[string]map[string]float64, tick uint64)
	OnControlEvent     func(netId, transitionId string, ctrl *pflow.ControlBinding)
	OnMuteChanged      func(mutedNets map[string]bool, mutedNotes map[string]map[int]bool)
	OnPlaybackComplete func()
	OnProjectSwapped   func(project map[string]interface{})
}

// New creates a new Sequencer.
func New() *Sequencer {
	return &Sequencer{
		tempo:          DefaultTempo,
		ppq:            DefaultPPQ,
		mutedNets:      make(map[string]bool),
		mutedNotes:     make(map[string]map[int]bool),
		mutedGroups:    make(map[string]bool),
		enabledBuf:     make([]string, 0, 16),
		placeConsumers: make(map[string][]string),
		blocked:        make(map[string]bool),
		loopStart:      -1,
		loopEnd:        -1,
	}
}

// LoadProject loads a project from JSON data.
func (s *Sequencer) LoadProject(data map[string]interface{}) {
	s.mu.Lock()
	s.project = pflow.ParseProject(data)
	s.tempo = s.project.Tempo
	s.stateBuf = nil // invalidate reusable state buffer
	s.mutedGroups = make(map[string]bool)
	// Seed mutedNets from initialMutes so later /api/mute calls are
	// incremental edits, not full replacements. Without this the server
	// broadcasts a near-empty mute map on the first /api/mute and the
	// client's initial mute state (variant slots, stingers) gets wiped.
	s.mutedNets = make(map[string]bool)
	s.mutedNotes = make(map[string]map[int]bool)
	for _, id := range s.project.InitialMutes {
		s.mutedNets[id] = true
	}
	swapped := s.OnProjectSwapped
	projJSON := s.project.ToJSON()
	s.mu.Unlock()

	if swapped != nil {
		swapped(projJSON)
	}
}

// LoadPflowProject loads a pre-built pflow.Project directly (used by generators).
func (s *Sequencer) LoadPflowProject(proj *pflow.Project) {
	s.mu.Lock()
	s.project = proj
	s.tempo = proj.Tempo
	s.mutedGroups = make(map[string]bool)
	s.stateBuf = nil // invalidate reusable state buffer
	swapped := s.OnProjectSwapped
	projJSON := proj.ToJSON()
	s.mu.Unlock()

	if swapped != nil {
		swapped(projJSON)
	}
}

// QueueProject queues a project for seamless swap at the next bar boundary.
// If the sequencer is not playing, the project is loaded immediately.
func (s *Sequencer) QueueProject(proj *pflow.Project) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.playing {
		// Not playing — load immediately
		s.project = proj
		s.tempo = proj.Tempo
		s.stateBuf = nil
		s.mutedGroups = make(map[string]bool)
		if s.OnProjectSwapped != nil {
			s.OnProjectSwapped(proj.ToJSON())
		}
		return
	}
	s.pendingProject = proj
}

// GetProject returns the current project as JSON for the frontend.
func (s *Sequencer) GetProject() map[string]interface{} {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.project == nil {
		return nil
	}
	return s.project.ToJSON()
}

// Play starts the sequencer.
func (s *Sequencer) Play() {
	s.mu.Lock()
	if s.playing {
		s.mu.Unlock()
		return
	}
	s.playing = true

	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	s.mu.Unlock()

	go s.run(ctx)
}

// Stop stops the sequencer and resets state.
func (s *Sequencer) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
	s.playing = false
	s.stopRequested = false
	s.tickCount = 0
	s.loopStart = -1
	s.loopEnd = -1

	// Reset mute state
	s.mutedNets = make(map[string]bool)
	s.mutedNotes = make(map[string]map[int]bool)

	if s.project != nil {
		for _, bundle := range s.project.Nets {
			bundle.ResetState()
		}
	}
}

// Pause pauses without resetting.
func (s *Sequencer) Pause() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
	s.playing = false
}

// IsPlaying returns whether the sequencer is currently running.
func (s *Sequencer) IsPlaying() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.playing
}

// Seek jumps to a specific tick position by resetting state and fast-forwarding.
// The sequencer must be playing or paused. It silently replays ticks (no MIDI output)
// up to the target tick, then resumes normal playback.
func (s *Sequencer) Seek(targetTick uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.project == nil {
		return
	}

	s.fastForwardTo(targetTick)

	// Broadcast the new state
	if s.OnStateChange != nil {
		s.broadcastState()
	}
	if s.OnMuteChanged != nil {
		s.OnMuteChanged(s.mutedNets, s.mutedNotes)
	}
}

// fastForwardTo resets state and silently replays ticks up to targetTick.
// Must be called with s.mu held.
func (s *Sequencer) fastForwardTo(targetTick uint64) {
	for _, bundle := range s.project.Nets {
		bundle.ResetState()
	}
	s.tickCount = 0
	s.mutedNets = make(map[string]bool)
	s.mutedNotes = make(map[string]map[int]bool)
	s.stopRequested = false

	// Fast-forward: run ticks silently (apply control events but skip MIDI)
	savedOnFired := s.OnTransitionFired
	s.OnTransitionFired = nil
	for s.tickCount < targetTick {
		s.tickCount++
		for netId, bundle := range s.project.Nets {
			enabled := s.enabledBuf[:0]
			for transLabel := range bundle.Net.Transitions {
				if bundle.IsEnabled(transLabel) {
					enabled = append(enabled, transLabel)
				}
			}
			s.enabledBuf = enabled
			if len(enabled) > 1 {
				enabled = s.resolveConflicts(bundle, enabled)
			}
			for _, transLabel := range enabled {
				result := bundle.Fire(transLabel)
				if result.Control != nil {
					s.applyControl(netId, transLabel, result.Control)
				}
			}
		}
	}
	s.OnTransitionFired = savedOnFired
}

// SetLoop sets the loop start/end tick positions. Use -1 to disable.
func (s *Sequencer) SetLoop(startTick, endTick int64) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if startTick >= 0 && endTick >= 0 && startTick >= endTick {
		// Invalid: start must be before end
		s.loopStart = -1
		s.loopEnd = -1
		return
	}
	s.loopStart = startTick
	s.loopEnd = endTick
}

// GetLoop returns the current loop start/end tick positions.
func (s *Sequencer) GetLoop() (int64, int64) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.loopStart, s.loopEnd
}

// CropProject trims the project's structure to only include ticks within [startTick, endTick).
// Returns the cropped project JSON, or nil if no structure or invalid range.
func (s *Sequencer) CropProject(startTick, endTick int64) map[string]interface{} {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.project == nil || len(s.project.Structure) == 0 || startTick >= endTick {
		return nil
	}

	// Find which sections fall within [startTick, endTick)
	var cropped []pflow.StructureSection
	tick := int64(0)
	for _, sec := range s.project.Structure {
		secEnd := tick + int64(sec.Steps)
		if secEnd <= startTick {
			tick = secEnd
			continue
		}
		if tick >= endTick {
			break
		}
		// Section overlaps — possibly truncate
		cropStart := int64(0)
		if startTick > tick {
			cropStart = startTick - tick
		}
		cropEnd := int64(sec.Steps)
		if endTick < secEnd {
			cropEnd = endTick - tick
		}
		steps := int(cropEnd - cropStart)
		if steps > 0 {
			cropped = append(cropped, pflow.StructureSection{
				Name:    sec.Name,
				Steps:   steps,
				Phrases: sec.Phrases,
			})
		}
		tick = secEnd
	}

	if len(cropped) == 0 {
		return nil
	}

	// Remove old struct-* control nets
	for netId := range s.project.Nets {
		if len(netId) > 7 && netId[:7] == "struct-" {
			delete(s.project.Nets, netId)
		}
	}

	// Build new template from cropped sections
	sections := make([]generator.Section, len(cropped))
	for i, cs := range cropped {
		sections[i] = generator.Section{
			Name:    cs.Name,
			Steps:   cs.Steps,
			Active:  make(map[string]bool),
			Phrases: cs.Phrases,
		}
		// All music nets are active in cropped sections
		for netId, nb := range s.project.Nets {
			if nb.Role != "control" {
				sections[i].Active[netId] = true
			}
		}
	}

	template := &generator.SongTemplate{
		Name:     "cropped",
		Sections: sections,
	}

	// Collect music net IDs
	var musicNets []string
	for netId, nb := range s.project.Nets {
		if nb.Role != "control" {
			musicNets = append(musicNets, netId)
		}
	}

	// Build SlotMap from existing nets (variants are already expanded)
	template.SlotMap = make(map[string][][]int)
	roleSlots := make(map[string]map[string]int) // role -> netId -> slotIdx
	for _, netId := range musicNets {
		nb := s.project.Nets[netId]
		if nb.RiffGroup != "" {
			if roleSlots[nb.RiffGroup] == nil {
				roleSlots[nb.RiffGroup] = make(map[string]int)
			}
			idx := generator.ExtractSlotIndex(netId, nb.RiffGroup)
			roleSlots[nb.RiffGroup][netId] = idx
		}
	}
	for role, slots := range roleSlots {
		maxSlot := 0
		for _, idx := range slots {
			if idx > maxSlot {
				maxSlot = idx
			}
		}
		// Build slotMap: [sectionIdx][phraseIdx] -> slot index
		var slotMap [][]int
		for _, sec := range template.Sections {
			phrases := sec.Phrases[role]
			if phrases == nil {
				phrases = []string{"A"}
			}
			phraseSlots := make([]int, len(phrases))
			for pi, p := range phrases {
				phraseSlots[pi] = int(p[0]-'A') % (maxSlot + 1)
			}
			slotMap = append(slotMap, phraseSlots)
		}
		template.SlotMap[role] = slotMap
	}

	initialMutes := generator.SongStructure(s.project, template, musicNets)
	s.project.InitialMutes = initialMutes

	// Reset sequencer state
	s.loopStart = -1
	s.loopEnd = -1
	s.tickCount = 0
	s.stopRequested = false
	s.mutedNets = make(map[string]bool)
	s.mutedNotes = make(map[string]map[int]bool)
	s.mutedGroups = make(map[string]bool)
	s.stateBuf = nil

	// Apply initial mutes
	for _, netId := range initialMutes {
		s.mutedNets[netId] = true
	}

	// Reset net states
	for _, bundle := range s.project.Nets {
		bundle.ResetState()
	}

	return s.project.ToJSON()
}

// SetTempo changes the tempo.
func (s *Sequencer) SetTempo(bpm float64) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if bpm < MinBPM {
		bpm = MinBPM
	} else if bpm > MaxBPM {
		bpm = MaxBPM
	}
	s.tempo = bpm
	if s.project != nil {
		s.project.Tempo = bpm
	}
}

// ShuffleInstruments picks random instruments from each net's instrument set.
func (s *Sequencer) ShuffleInstruments(seed int64) map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.project == nil {
		return nil
	}
	return generator.ShuffleInstruments(s.project, seed)
}

// SetInitialMutes sets mute state for multiple nets at once (used for fade-in).
func (s *Sequencer) SetInitialMutes(netIds []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, netId := range netIds {
		s.mutedNets[netId] = true
	}
	if s.OnMuteChanged != nil {
		s.OnMuteChanged(s.copyMuteState())
	}
}

// SetMuted sets the mute state for a net.
func (s *Sequencer) SetMuted(netId string, muted bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.mutedNets[netId] = muted
	if s.OnMuteChanged != nil {
		s.OnMuteChanged(s.copyMuteState())
	}
}

// SetInstrument swaps the track.instrument on one net, or on every net
// in a riff group when riffGroup is non-empty (matching the fan-out in
// public/lib/ui/mixer.js when the mixer dropdown has data-riff-group).
// Returns the resolved map {netId -> instrument} so the caller can
// broadcast exactly what changed. Unknown netIds / empty groups return
// an empty map — the caller decides whether that's an error.
func (s *Sequencer) SetInstrument(netId, riffGroup, instrument string) map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	changed := map[string]string{}
	if s.project == nil {
		return changed
	}
	if riffGroup != "" {
		for id, nb := range s.project.Nets {
			if nb.RiffGroup == riffGroup {
				nb.Track.Instrument = instrument
				changed[id] = instrument
			}
		}
		return changed
	}
	if nb, ok := s.project.Nets[netId]; ok {
		nb.Track.Instrument = instrument
		changed[netId] = instrument
	}
	return changed
}

// SetGroupMuted mutes or unmutes a riff group. When muting, all slots in the
// group are muted and the group is flagged so activate-slot won't override.
// When unmuting, the flag is cleared and the next activate-slot will restore playback.
func (s *Sequencer) SetGroupMuted(riffGroup string, muted bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.project == nil {
		return
	}

	s.mutedGroups[riffGroup] = muted

	if muted {
		// Mute all nets in the group
		for netId, nb := range s.project.Nets {
			if nb.RiffGroup == riffGroup {
				s.mutedNets[netId] = true
			}
		}
	} else {
		// Unmute: find the slot that should be active.
		// Look for the slot whose control net most recently activated it.
		// Since all are muted, we let activate-slot handle it on next tick.
		// But for immediate response, find and unmute slot-0 as a fallback.
		activeSlot := ""
		for netId, nb := range s.project.Nets {
			if nb.RiffGroup == riffGroup {
				if activeSlot == "" {
					activeSlot = netId
				}
			}
		}
		if activeSlot != "" {
			s.mutedNets[activeSlot] = false
		}
	}

	if s.OnMuteChanged != nil {
		s.OnMuteChanged(s.copyMuteState())
	}
}

// GetMuteState returns the current mute state.
func (s *Sequencer) GetMuteState() (map[string]bool, map[string]map[int]bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.copyMuteState()
}

// FireTransition manually fires a transition.
func (s *Sequencer) FireTransition(netId, transitionId string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.project == nil {
		return
	}
	bundle, ok := s.project.Nets[netId]
	if !ok {
		return
	}
	result := bundle.Fire(transitionId)
	if result.Control != nil {
		s.applyControl(netId, transitionId, result.Control)
	}
	if result.Midi != nil && s.OnTransitionFired != nil {
		if !s.mutedNets[netId] {
			s.OnTransitionFired(netId, transitionId, result.Midi)
		}
	}
}

// run is the main sequencer loop.
func (s *Sequencer) run(ctx context.Context) {
	tickInterval := s.tickInterval()
	ticker := time.NewTicker(tickInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.tick()

			// Check if a stop-transport control was fired
			s.mu.RLock()
			shouldStop := s.stopRequested
			s.mu.RUnlock()
			if shouldStop {
				s.Stop()
				if s.OnPlaybackComplete != nil {
					s.OnPlaybackComplete()
				}
				return
			}

			newInterval := s.tickInterval()
			if newInterval != tickInterval {
				tickInterval = newInterval
				ticker.Reset(tickInterval)
			}
		}
	}
}

func (s *Sequencer) tickInterval() time.Duration {
	s.mu.RLock()
	tempo := s.tempo
	ppq := s.ppq
	s.mu.RUnlock()

	beatDuration := time.Minute / time.Duration(tempo)
	return beatDuration / time.Duration(ppq)
}

func (s *Sequencer) tick() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.project == nil {
		return
	}

	s.tickCount++

	// Loop wrap: when reaching loop end, seek back to loop start
	if s.loopEnd > 0 && s.loopStart >= 0 && int64(s.tickCount) >= s.loopEnd {
		if s.deterministicLoop {
			// Reset to initial state and fast-forward silently for exact repeats
			for _, bundle := range s.project.Nets {
				bundle.ResetState()
			}
		}
		s.fastForwardTo(uint64(s.loopStart))
		s.broadcastState()
		return
	}

	// Bar-boundary project swap (16 ticks = 1 bar at PPQ=4, 4/4 time)
	if s.pendingProject != nil && s.tickCount%16 == 0 {
		s.project = s.pendingProject
		s.tempo = s.pendingProject.Tempo
		s.tickCount = 0
		s.stateBuf = nil
		s.mutedNets = make(map[string]bool)
		s.mutedNotes = make(map[string]map[int]bool)
		s.mutedGroups = make(map[string]bool)
		if len(s.pendingProject.InitialMutes) > 0 {
			for _, netId := range s.pendingProject.InitialMutes {
				s.mutedNets[netId] = true
			}
		}
		if s.OnProjectSwapped != nil {
			s.OnProjectSwapped(s.project.ToJSON())
		}
		if s.OnMuteChanged != nil {
			s.OnMuteChanged(s.copyMuteState())
		}
		s.pendingProject = nil
		// Broadcast state immediately so frontend syncs
		s.broadcastState()
		return // skip this tick — new project starts fresh on next
	}

	for netId, bundle := range s.project.Nets {
		// Collect enabled transitions, reusing buffer to avoid allocation
		enabled := s.enabledBuf[:0]
		for transLabel := range bundle.Net.Transitions {
			if bundle.IsEnabled(transLabel) {
				enabled = append(enabled, transLabel)
			}
		}
		s.enabledBuf = enabled // save grown backing array

		// Resolve conflicts: if multiple transitions consume from the same
		// place, only one can fire. Group by input place and pick one per group.
		if len(enabled) > 1 {
			enabled = s.resolveConflicts(bundle, enabled)
		}

		for _, transLabel := range enabled {
			result := bundle.Fire(transLabel)

			// Apply control events regardless of mute state
			if result.Control != nil {
				s.applyControl(netId, transLabel, result.Control)
			}

			// Only broadcast MIDI if net is not muted
			if result.Midi != nil && s.OnTransitionFired != nil && !s.mutedNets[netId] {
				// Check note-level mute
				if noteMap, ok := s.mutedNotes[netId]; ok && noteMap[result.Midi.Note] {
					continue
				}
				s.OnTransitionFired(netId, transLabel, result.Midi)
			}
		}
	}

	// Throttle state broadcasts to every 6 ticks (~4 per beat)
	if s.tickCount%6 == 0 {
		s.broadcastState()
	}
}

// applyControl processes a control event (mute/unmute/toggle).
func (s *Sequencer) applyControl(netId, transId string, ctrl *pflow.ControlBinding) {
	switch ctrl.Action {
	case "mute-track":
		s.mutedNets[ctrl.TargetNet] = true
	case "unmute-track":
		s.mutedNets[ctrl.TargetNet] = false
	case "toggle-track":
		s.mutedNets[ctrl.TargetNet] = !s.mutedNets[ctrl.TargetNet]
	case "mute-note":
		if s.mutedNotes[ctrl.TargetNet] == nil {
			s.mutedNotes[ctrl.TargetNet] = make(map[int]bool)
		}
		s.mutedNotes[ctrl.TargetNet][ctrl.TargetNote] = true
	case "unmute-note":
		if s.mutedNotes[ctrl.TargetNet] != nil {
			s.mutedNotes[ctrl.TargetNet][ctrl.TargetNote] = false
		}
	case "toggle-note":
		if s.mutedNotes[ctrl.TargetNet] == nil {
			s.mutedNotes[ctrl.TargetNet] = make(map[int]bool)
		}
		s.mutedNotes[ctrl.TargetNet][ctrl.TargetNote] = !s.mutedNotes[ctrl.TargetNet][ctrl.TargetNote]
	case "activate-slot":
		// Mute all other nets in the same riff group, unmute the target
		// But respect user's manual group mute — don't unmute if group is muted
		if targetBundle, ok := s.project.Nets[ctrl.TargetNet]; ok && targetBundle.RiffGroup != "" {
			for netId, nb := range s.project.Nets {
				if nb.RiffGroup == targetBundle.RiffGroup && netId != ctrl.TargetNet {
					s.mutedNets[netId] = true
				}
			}
			if !s.mutedGroups[targetBundle.RiffGroup] {
				s.mutedNets[ctrl.TargetNet] = false
			}
		}
	case "stop-transport":
		s.stopRequested = true
	case "fire-macro":
		// Pass-through. The server doesn't know the macro catalog
		// (that lives in the frontend's macros/catalog.js); it just
		// forwards the ControlBinding via OnControlEvent → the hub
		// broadcasts control-fired, and the frontend's macro runtime
		// picks up {macro, macroBars, macroParams} and applies it.
	}

	if s.OnControlEvent != nil {
		s.OnControlEvent(netId, transId, ctrl)
	}
	if s.OnMuteChanged != nil {
		s.OnMuteChanged(s.copyMuteState())
	}
}

// copyMuteState returns deep copies of the mute maps, safe for async use.
// Must be called while s.mu is held.
func (s *Sequencer) copyMuteState() (map[string]bool, map[string]map[int]bool) {
	nets := make(map[string]bool, len(s.mutedNets))
	for k, v := range s.mutedNets {
		nets[k] = v
	}
	notes := make(map[string]map[int]bool, len(s.mutedNotes))
	for k, v := range s.mutedNotes {
		m := make(map[int]bool, len(v))
		for n, b := range v {
			m[n] = b
		}
		notes[k] = m
	}
	return nets, notes
}

// resolveConflicts ensures that if multiple enabled transitions share an
// input place, only one of them fires. This prevents token multiplication
// in Markov-style nets where a place has multiple outgoing transitions.
// Uses preallocated maps on the Sequencer to avoid per-tick allocations.
func (s *Sequencer) resolveConflicts(bundle *pflow.NetBundle, enabled []string) []string {
	// Clear reusable maps
	for k := range s.placeConsumers {
		delete(s.placeConsumers, k)
	}
	for k := range s.blocked {
		delete(s.blocked, k)
	}

	// Map each input place to the transitions that consume from it
	for _, tLabel := range enabled {
		for _, ca := range bundle.GetInputArcs(tLabel) {
			if !ca.InhibitTransition {
				s.placeConsumers[ca.Source] = append(s.placeConsumers[ca.Source], tLabel)
			}
		}
	}

	// For places with multiple consumers, pick one (random or deterministic)
	for place, consumers := range s.placeConsumers {
		if len(consumers) <= 1 {
			continue
		}
		// Pick one winner, block the rest
		var idx int
		if s.deterministicLoop {
			idx = int(deterministicRand(s.tickCount, strHash(place)) % uint64(len(consumers)))
		} else {
			idx = rand.Intn(len(consumers))
		}
		winner := consumers[idx]
		for _, t := range consumers {
			if t != winner {
				s.blocked[t] = true
			}
		}
	}

	if len(s.blocked) == 0 {
		return enabled
	}

	// Clear the placeConsumers slices for reuse (reset length, keep capacity)
	for k := range s.placeConsumers {
		s.placeConsumers[k] = s.placeConsumers[k][:0]
	}

	result := make([]string, 0, len(enabled))
	for _, t := range enabled {
		if !s.blocked[t] {
			result = append(result, t)
		}
	}
	return result
}

func (s *Sequencer) broadcastState() {
	if s.OnStateChange == nil || s.project == nil {
		return
	}

	// Lazily initialize or rebuild the reusable state buffer when project changes
	if s.stateBuf == nil || len(s.stateBuf) != len(s.project.Nets) {
		s.stateBuf = make(map[string]map[string]float64, len(s.project.Nets))
		for netId, bundle := range s.project.Nets {
			s.stateBuf[netId] = make(map[string]float64, len(bundle.Net.Places))
		}
	}

	for netId, bundle := range s.project.Nets {
		netState := s.stateBuf[netId]
		for placeLabel := range bundle.Net.Places {
			netState[placeLabel] = bundle.State[placeLabel]
		}
	}
	s.OnStateChange(s.stateBuf, s.tickCount)
}

// SetDeterministicLoop enables or disables deterministic loop mode.
// When enabled, conflict resolution is seeded and loop wraps reset to initial state.
func (s *Sequencer) SetDeterministicLoop(enabled bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deterministicLoop = enabled
}

// deterministicRand returns a deterministic pseudo-random value from tick and salt.
// Uses Mulberry32 hash — matches the JS worker implementation.
func deterministicRand(tick uint64, salt uint64) uint64 {
	s := uint32(tick+salt) + 0x6D2B79F5
	t := s ^ (s >> 15)
	t = t * (1 | s)
	t = t + (t^(t>>7))*(61|t) ^ t
	return uint64((t ^ (t >> 14)))
}

// strHash computes a simple string hash matching the JS worker's strHash.
func strHash(s string) uint64 {
	var h uint32
	for i := 0; i < len(s); i++ {
		h = h*31 + uint32(s[i])
	}
	return uint64(h)
}

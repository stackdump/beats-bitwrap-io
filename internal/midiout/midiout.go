// Package midiout sends sequencer MIDI events to a system MIDI output port.
// It's used in headless mode so petri-note can drive an external DAW (e.g.,
// via the macOS IAC driver) without a browser frontend.
package midiout

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"beats-bitwrap-io/internal/pflow"

	"gitlab.com/gomidi/midi/v2"
	"gitlab.com/gomidi/midi/v2/drivers"
	_ "gitlab.com/gomidi/midi/v2/drivers/rtmididrv"
)

// Output wraps a MIDI output port.
type Output struct {
	port     drivers.Out
	send     func(midi.Message) error
	portName string

	mu         sync.Mutex
	activeOff  map[int]map[uint8]*time.Timer // channel (1-16) -> note -> pending note-off
	sendBuffer [3]byte
}

// ListPorts returns available MIDI output port names.
func ListPorts() ([]string, error) {
	outs := midi.GetOutPorts()
	names := make([]string, 0, len(outs))
	for _, o := range outs {
		names = append(names, o.String())
	}
	return names, nil
}

// Open opens a MIDI output port by name (case-insensitive substring match).
// If no match is found and createVirtual is true, attempts to create a virtual port.
func Open(name string, createVirtual bool) (*Output, error) {
	if name == "" {
		return nil, fmt.Errorf("midiout: port name required")
	}

	ports := midi.GetOutPorts()
	var matched drivers.Out
	lower := strings.ToLower(name)
	for _, p := range ports {
		if strings.Contains(strings.ToLower(p.String()), lower) {
			matched = p
			break
		}
	}

	if matched == nil {
		if !createVirtual {
			available := make([]string, 0, len(ports))
			for _, p := range ports {
				available = append(available, p.String())
			}
			return nil, fmt.Errorf("midiout: no port matches %q. Available: %s",
				name, strings.Join(available, ", "))
		}
		drv, ok := drivers.Get().(driverWithVirtual)
		if !ok {
			return nil, fmt.Errorf("midiout: driver does not support virtual ports")
		}
		vout, err := drv.OpenVirtualOut(name)
		if err != nil {
			return nil, fmt.Errorf("midiout: create virtual port %q: %w", name, err)
		}
		matched = vout
	} else {
		if err := matched.Open(); err != nil {
			return nil, fmt.Errorf("midiout: open %q: %w", matched.String(), err)
		}
	}

	send, err := midi.SendTo(matched)
	if err != nil {
		matched.Close()
		return nil, fmt.Errorf("midiout: sender for %q: %w", matched.String(), err)
	}

	return &Output{
		port:      matched,
		send:      send,
		portName:  matched.String(),
		activeOff: make(map[int]map[uint8]*time.Timer),
	}, nil
}

// driverWithVirtual lets us call OpenVirtualOut when supported (rtmidi, alsa, coremidi).
type driverWithVirtual interface {
	OpenVirtualOut(name string) (drivers.Out, error)
}

// PortName returns the name of the currently-open port.
func (o *Output) PortName() string { return o.portName }

// Send plays a note: sends Note On, schedules Note Off after binding.Duration ms.
// Channel in the binding is 1-16 (petri-note schema); converted to 0-15 on the wire.
func (o *Output) Send(binding *pflow.MidiBinding) {
	if binding == nil || o == nil {
		return
	}
	ch := binding.Channel
	if ch < 1 {
		ch = 1
	} else if ch > 16 {
		ch = 16
	}
	wire := uint8(ch - 1)
	note := uint8(binding.Note & 0x7F)
	vel := binding.Velocity
	if vel < 1 {
		vel = 1
	} else if vel > 127 {
		vel = 127
	}

	o.mu.Lock()
	// If an earlier note-off is still pending for this (channel, note), fire it now
	// so the new Note On doesn't get cut short by the stale timer.
	if chMap, ok := o.activeOff[ch]; ok {
		if t, ok := chMap[note]; ok {
			t.Stop()
			_ = o.send(midi.NoteOff(wire, note))
			delete(chMap, note)
		}
	}
	_ = o.send(midi.NoteOn(wire, note, uint8(vel)))

	duration := binding.Duration
	if duration <= 0 {
		duration = 50
	}
	if o.activeOff[ch] == nil {
		o.activeOff[ch] = make(map[uint8]*time.Timer)
	}
	chMap := o.activeOff[ch]
	timer := time.AfterFunc(time.Duration(duration)*time.Millisecond, func() {
		o.mu.Lock()
		defer o.mu.Unlock()
		if chMap[note] != nil {
			_ = o.send(midi.NoteOff(wire, note))
			delete(chMap, note)
		}
	})
	chMap[note] = timer
	o.mu.Unlock()
}

// AllNotesOff sends Note Off for every pending note and clears timers.
func (o *Output) AllNotesOff() {
	if o == nil {
		return
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	for ch, chMap := range o.activeOff {
		wire := uint8(ch - 1)
		for note, t := range chMap {
			t.Stop()
			_ = o.send(midi.NoteOff(wire, note))
			delete(chMap, note)
		}
	}
}

// Close sends Note Off for any pending notes and closes the port.
func (o *Output) Close() error {
	if o == nil {
		return nil
	}
	o.AllNotesOff()
	if o.port != nil {
		return o.port.Close()
	}
	return nil
}

// FanoutOutput opens a fixed list of existing MIDI output ports and routes
// each firing to the port matching its MIDI channel. This matches the
// browser frontend's model: channels (not netIds) identify instruments, so
// all drum nets (channel 10) share a drum bus, bass (channel 6) has its own
// bus, melody (channel 4) its own, arp (channel 5) its own. Channels are
// sorted ascending and pinned to ports in that order for deterministic
// assignment across restarts; PreAssign is called by the server whenever a
// project is loaded. The binding's channel is preserved on the wire so
// in-DAW channel filters still work (e.g. LMMS drum-kit on ch 10).
type FanoutOutput struct {
	ports []*Output

	mu    sync.Mutex
	byNet map[string]int // netId -> port index
	next  int            // next port slot for lazy (unknown-netId) assignment
}

// NewFanout opens the given port names (substring match, case-insensitive)
// and returns a FanoutOutput that rotates nets across them.
func NewFanout(portNames []string) (*FanoutOutput, error) {
	if len(portNames) == 0 {
		return nil, fmt.Errorf("midiout: fanout requires at least one port")
	}
	outs := make([]*Output, 0, len(portNames))
	for _, name := range portNames {
		o, err := Open(strings.TrimSpace(name), false)
		if err != nil {
			for _, opened := range outs {
				opened.Close()
			}
			return nil, err
		}
		outs = append(outs, o)
	}
	return &FanoutOutput{
		ports: outs,
		byNet: make(map[string]int),
	}, nil
}

// netPriority returns a sort key for musical role ordering. Lower sorts first.
// Drums (kick/snare/hihat/etc.) take the first busses, then bass, melody, arp,
// pads, anything else alphabetically.
func netPriority(netId string) int {
	n := strings.ToLower(netId)
	order := []struct {
		key  string
		prio int
	}{
		{"kick", 0}, {"snare", 10}, {"hihat", 20}, {"hat", 20},
		{"clap", 30}, {"crash", 40}, {"ride", 45}, {"cymbal", 50},
		{"tom", 60}, {"perc", 70}, {"shaker", 75}, {"drum", 80},
		{"sub", 100}, {"bass", 110},
		{"melody", 200}, {"lead", 210},
		{"arp", 300}, {"pluck", 310},
		{"pad", 400}, {"string", 410}, {"chord", 420},
	}
	for _, o := range order {
		if strings.Contains(n, o.key) {
			return o.prio
		}
	}
	return 1000
}

// PreAssign pins the given netIds to ports in musical-priority order (drums
// first, then bass, then melody/arp/pads, then others alphabetical). Called
// whenever a project is loaded so assignments don't depend on fire order.
func (f *FanoutOutput) PreAssign(netIds []string) {
	if f == nil || len(netIds) == 0 {
		return
	}
	seen := make(map[string]bool, len(netIds))
	unique := make([]string, 0, len(netIds))
	for _, id := range netIds {
		if !seen[id] {
			seen[id] = true
			unique = append(unique, id)
		}
	}
	sort.SliceStable(unique, func(i, j int) bool {
		pi, pj := netPriority(unique[i]), netPriority(unique[j])
		if pi != pj {
			return pi < pj
		}
		return unique[i] < unique[j]
	})

	f.mu.Lock()
	defer f.mu.Unlock()
	f.byNet = make(map[string]int, len(unique))
	f.next = 0
	for _, id := range unique {
		f.byNet[id] = f.next % len(f.ports)
		f.next++
	}
}

// NewFanoutByPrefix enumerates available output ports whose names start with
// prefix (case-insensitive) and opens them as a fanout. Ports are sorted by
// name so assignment order is deterministic.
func NewFanoutByPrefix(prefix string) (*FanoutOutput, error) {
	prefix = strings.ToLower(prefix)
	available := midi.GetOutPorts()
	var matched []string
	for _, p := range available {
		if strings.HasPrefix(strings.ToLower(p.String()), prefix) {
			matched = append(matched, p.String())
		}
	}
	if len(matched) == 0 {
		return nil, fmt.Errorf("midiout: no ports start with %q", prefix)
	}
	// Sort so "Bus 1" < "Bus 2" etc.
	for i := 0; i < len(matched); i++ {
		for j := i + 1; j < len(matched); j++ {
			if matched[j] < matched[i] {
				matched[i], matched[j] = matched[j], matched[i]
			}
		}
	}
	return NewFanout(matched)
}

// Send routes binding to the port assigned for netId. NetIds not pinned by
// PreAssign get lazy round-robin assignment on first fire.
func (f *FanoutOutput) Send(netId string, binding *pflow.MidiBinding) {
	if f == nil || binding == nil {
		return
	}
	f.mu.Lock()
	idx, ok := f.byNet[netId]
	if !ok {
		idx = f.next % len(f.ports)
		f.byNet[netId] = idx
		f.next++
	}
	f.mu.Unlock()
	f.ports[idx].Send(binding)
}

// Assignments returns a netId → port name map for introspection.
func (f *FanoutOutput) Assignments() map[string]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make(map[string]string, len(f.byNet))
	for netId, idx := range f.byNet {
		out[netId] = f.ports[idx].portName
	}
	return out
}

// PortNames returns all open port names in fanout order.
func (f *FanoutOutput) PortNames() []string {
	names := make([]string, len(f.ports))
	for i, o := range f.ports {
		names[i] = o.portName
	}
	return names
}

// AllNotesOff flushes pending notes on every port.
func (f *FanoutOutput) AllNotesOff() {
	if f == nil {
		return
	}
	for _, o := range f.ports {
		o.AllNotesOff()
	}
}

// Close closes every open port.
func (f *FanoutOutput) Close() error {
	if f == nil {
		return nil
	}
	var firstErr error
	for _, o := range f.ports {
		if err := o.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// MultiOutput routes per-net MIDI to a dedicated virtual port per netId.
// Ports are created lazily on the first event for each net. The port is
// named "<prefix>-<netId>" and all notes are sent on channel 1 — the port
// identifies the track, so the binding's channel field is ignored.
type MultiOutput struct {
	prefix string
	drv    driverWithVirtual

	mu    sync.Mutex
	ports map[string]*Output
}

// NewMulti creates a MultiOutput. prefix is used to name virtual ports
// (e.g. prefix "petri-note" produces "petri-note-kick", "petri-note-bass").
func NewMulti(prefix string) (*MultiOutput, error) {
	if prefix == "" {
		prefix = "petri-note"
	}
	drv, ok := drivers.Get().(driverWithVirtual)
	if !ok {
		return nil, fmt.Errorf("midiout: driver does not support virtual ports")
	}
	return &MultiOutput{
		prefix: prefix,
		drv:    drv,
		ports:  make(map[string]*Output),
	}, nil
}

// Send routes the binding to the virtual port for netId, creating it on first use.
// The binding's channel is overridden to 1 (wire 0).
func (m *MultiOutput) Send(netId string, binding *pflow.MidiBinding) {
	if m == nil || binding == nil || netId == "" {
		return
	}
	out, err := m.portFor(netId)
	if err != nil {
		return
	}
	// Copy binding with channel pinned to 1 — one instrument per port.
	b := *binding
	b.Channel = 1
	out.Send(&b)
}

// portFor returns the Output for a netId, opening it lazily.
func (m *MultiOutput) portFor(netId string) (*Output, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if out, ok := m.ports[netId]; ok {
		return out, nil
	}
	name := m.prefix + "-" + netId
	vout, err := m.drv.OpenVirtualOut(name)
	if err != nil {
		return nil, fmt.Errorf("midiout: create virtual port %q: %w", name, err)
	}
	send, err := midi.SendTo(vout)
	if err != nil {
		vout.Close()
		return nil, fmt.Errorf("midiout: sender for %q: %w", name, err)
	}
	out := &Output{
		port:      vout,
		send:      send,
		portName:  vout.String(),
		activeOff: make(map[int]map[uint8]*time.Timer),
	}
	m.ports[netId] = out
	return out, nil
}

// PortNames returns the names of currently-open per-net ports.
func (m *MultiOutput) PortNames() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	names := make([]string, 0, len(m.ports))
	for _, o := range m.ports {
		names = append(names, o.portName)
	}
	return names
}

// AllNotesOff flushes pending notes on every open port.
func (m *MultiOutput) AllNotesOff() {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, o := range m.ports {
		o.AllNotesOff()
	}
}

// Close closes every open port.
func (m *MultiOutput) Close() error {
	if m == nil {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var firstErr error
	for _, o := range m.ports {
		if err := o.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	m.ports = nil
	return firstErr
}

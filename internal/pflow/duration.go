package pflow

import "math"

// Beat-relative note durations.
//
// Historically MidiBinding.Duration carried a fixed millisecond sustain,
// baked at the genre's nominal BPM — tempo-blind: override the tempo at
// playback and every sustain plays wrong (the bossa walking-bass dotted
// quarter is the canonical example). DurationSteps is the beat-relative
// encoding: a duration in SIXTEENTH steps (1 step = 1/4 beat), resolved
// to milliseconds against the LIVE tempo at playback:
//
//	ms = steps * (60000 / bpm) / 4
//
// Canonical-form rule (mirrored exactly in public/lib/pflow.js — Go and
// JS must serialize and hash the same form):
//
//   - durationSteps present (> 0): it is canonical. Serialization
//     (bundleToJSON) and CID hashing (normalizeBundle) carry
//     durationSteps and omit the legacy ms duration; playback resolves
//     against the live BPM.
//   - durationSteps absent: the legacy `duration` (ms) stays canonical
//     for that model — serialized bytes, CID and playback of every
//     existing saved/shared model are unchanged.
//
// New authoring (Compose / ArrangeWithOpts and their JS ports) stamps
// DurationSteps from the authored ms at the model's authored tempo:
// steps = round(ms * bpm * 4 / 60000).

// DurationStepsFromMs converts an authored millisecond duration to
// sixteenth steps at the authoring tempo. Returns at least 1 for any
// positive ms so a stamped note never collapses to zero sustain; returns
// 0 for a non-positive ms or bpm (nothing to stamp).
// Mirrors durationStepsFromMs in public/lib/pflow.js.
func DurationStepsFromMs(ms int, bpm float64) int {
	if ms <= 0 || bpm <= 0 {
		return 0
	}
	steps := int(math.Round(float64(ms) * bpm * 4.0 / 60000.0))
	if steps < 1 {
		steps = 1
	}
	return steps
}

// ResolveDurationMs returns the playback sustain in milliseconds for a
// binding at the given live tempo: beat-relative bindings resolve
// steps -> ms against bpm; legacy bindings return their fixed ms.
// Mirrors resolveDurationMs in public/lib/pflow.js.
func ResolveDurationMs(m *MidiBinding, bpm float64) int {
	if m == nil {
		return 0
	}
	if m.DurationSteps > 0 && bpm > 0 {
		return int(math.Round(float64(m.DurationSteps) * 60000.0 / (bpm * 4.0)))
	}
	return m.Duration
}

// ResolvedBinding returns a binding whose Duration is resolved to
// milliseconds at the given live tempo, for ms-only consumers (hardware
// MIDI note-off timers). Legacy bindings are returned as-is; stamped
// bindings come back as a copy so the project's canonical binding is
// never mutated.
func ResolvedBinding(m *MidiBinding, bpm float64) *MidiBinding {
	if m == nil || m.DurationSteps <= 0 {
		return m
	}
	c := *m
	c.Duration = ResolveDurationMs(m, bpm)
	return &c
}

// StampDurationSteps converts every legacy ms binding in the project to
// the beat-relative encoding, using the project's authored tempo.
// Idempotent: bindings already carrying DurationSteps are left alone.
// Called at the end of generator.Compose and generator.ArrangeWithOpts
// (and their JS ports, in lockstep) so new authoring emits durationSteps.
func StampDurationSteps(p *Project) {
	if p == nil {
		return
	}
	bpm := p.Tempo
	if bpm <= 0 {
		bpm = 120
	}
	for _, nb := range p.Nets {
		if nb == nil {
			continue
		}
		for _, b := range nb.Bindings {
			if b == nil || b.DurationSteps != 0 || b.Duration <= 0 {
				continue
			}
			b.DurationSteps = DurationStepsFromMs(b.Duration, bpm)
		}
	}
}

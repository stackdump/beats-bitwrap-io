# petri-note JSON-LD Schema

A schema for music projects using Petri nets as a sequencing paradigm.

## Hierarchy

```
Project
├── tempo, swing, metadata
├── tokenColors[]
├── midiOutputs[]
└── scenes{}
    └── Scene
        ├── label, color, duration, launch
        ├── connections[] (inter-net)
        └── nets{}
            └── Net (PetriNet)
                ├── track (channel, program, volume, pan)
                ├── places{}
                ├── transitions{}
                └── arcs[]
```

## Core Concepts

### Project
The top-level container for a music composition.

| Property | Type | Description |
|----------|------|-------------|
| `@context` | string | Always `"https://petri-note.dev/schema/v1"` |
| `@type` | string | Always `"PetriNoteProject"` |
| `name` | string | Project name |
| `tempo` | number | Global tempo in BPM (20-300) |
| `swing` | number | Swing percentage (0-100) |
| `scenes` | object | Map of scene ID → Scene |
| `activeScene` | string | Currently playing scene ID |
| `sceneOrder` | string[] | Arrangement order |

### Scene
Groups related nets for arrangement (like Ableton Live scenes).

| Property | Type | Description |
|----------|------|-------------|
| `@type` | string | `"Scene"` |
| `label` | string | Display name |
| `color` | string | Hex color (e.g., `"#e94560"`) |
| `nets` | object | Map of net ID → Net |
| `connections` | array | Inter-net connections |
| `launch` | string | `"immediate"`, `"quantized"`, or `"next-bar"` |
| `duration` | number | Auto-advance after N beats (null = manual) |

### Net (PetriNet)
A single Petri net representing one instrument/track pattern.

| Property | Type | Description |
|----------|------|-------------|
| `@type` | string | `"PetriNet"` |
| `label` | string | Track name |
| `track` | object | MIDI output settings |
| `places` | object | Map of place ID → Place |
| `transitions` | object | Map of transition ID → Transition |
| `arcs` | array | Arc definitions |

#### Track Settings
```json
{
  "channel": 1,        // MIDI channel 1-16
  "program": 0,        // Program/patch number
  "bank": 0,           // Bank select
  "volume": 100,       // CC7 value
  "pan": 64,           // CC10 value (64 = center)
  "mute": false,
  "solo": false
}
```

### Place
A location that holds tokens (represents state/readiness).

| Property | Type | Description |
|----------|------|-------------|
| `@type` | string | `"Place"` |
| `label` | string | Display name |
| `initial` | number[] | Initial token count per color |
| `capacity` | number[] | Max tokens (null = unlimited) |
| `x`, `y` | number | Visual position |

### Transition
An event that fires when enabled, triggering MIDI output.

| Property | Type | Description |
|----------|------|-------------|
| `@type` | string | `"Transition"` |
| `label` | string | Display name |
| `x`, `y` | number | Visual position |
| `rate` | number | Firing rate for ODE simulation |
| `priority` | number | Higher = fires first |
| `silent` | boolean | If true, fires but sends no MIDI (rest/skip) |
| `midi` | array | MIDI events to send on fire (empty = silent) |
| `guard` | string | Guard expression (future) |

**Silent Transitions (Rests/Skips):**
A transition with `"silent": true` or `"midi": []` consumes tokens and advances the pattern but produces no sound. This is how you create rests in rhythmic patterns.

### Arc
Connects places and transitions.

| Property | Type | Description |
|----------|------|-------------|
| `@type` | string | `"Arc"` |
| `source` | string | Source node ID |
| `target` | string | Target node ID |
| `weight` | number[] | Tokens consumed/produced |
| `inhibitor` | boolean | Blocks when source ≥ weight |
| `reset` | boolean | Consumes all tokens |

**Arc Types:**
- **Normal**: Place→Transition consumes tokens; Transition→Place produces tokens
- **Inhibitor**: Blocks transition when source place has ≥ weight tokens
- **Reset**: Consumes all tokens regardless of weight

### Connection
Links between nets for signal/token passing.

| Property | Type | Description |
|----------|------|-------------|
| `@type` | string | `"Connection"` |
| `from` | object | `{net, place?, transition?}` |
| `to` | object | `{net, place?, transition?}` |
| `type` | string | `"signal"`, `"token"`, or `"sync"` |
| `weight` | number[] | Token weight for `"token"` type |

**Connection Types:**
- **signal**: Firing `from.transition` triggers `to.transition`
- **token**: Tokens flow from `from.place` to `to.place`
- **sync**: Both transitions must fire together

---

## MIDI Events

Transitions can send multiple MIDI events on fire:

### MidiNote
```json
{
  "@type": "MidiNote",
  "note": 60,          // MIDI note number (60 = C4)
  "velocity": 100,     // 0-127
  "duration": 100,     // milliseconds
  "channel": 1         // overrides track default
}
```

### MidiCC (Control Change)
```json
{
  "@type": "MidiCC",
  "controller": 1,     // CC number (1 = mod wheel)
  "value": 64,         // 0-127
  "channel": 1
}
```

Common CC numbers:
- 1: Modulation wheel
- 7: Volume
- 10: Pan
- 11: Expression
- 64: Sustain pedal
- 74: Filter cutoff (MPE)

### MidiProgramChange
```json
{
  "@type": "MidiProgramChange",
  "program": 0,        // 0-127
  "bank": 0,           // optional bank select
  "channel": 1
}
```

### MidiPitchBend
```json
{
  "@type": "MidiPitchBend",
  "value": 0,          // -8192 to 8191 (0 = center)
  "channel": 1
}
```

### MidiAftertouch
```json
{
  "@type": "MidiAftertouch",
  "pressure": 64,      // 0-127
  "note": 60,          // optional (poly aftertouch)
  "channel": 1
}
```

---

## Example: Simple Drum Pattern

```json
{
  "@context": "https://petri-note.dev/schema/v1",
  "@type": "PetriNoteProject",
  "name": "Simple Beat",
  "tempo": 120,
  "scenes": {
    "main": {
      "@type": "Scene",
      "label": "Main",
      "nets": {
        "kick": {
          "@type": "PetriNet",
          "track": { "channel": 10 },
          "places": {
            "ready": { "initial": [1], "x": 100, "y": 100 }
          },
          "transitions": {
            "hit": {
              "x": 100, "y": 200,
              "midi": [{ "@type": "MidiNote", "note": 36, "velocity": 100 }]
            }
          },
          "arcs": [
            { "source": "ready", "target": "hit" },
            { "source": "hit", "target": "ready" }
          ]
        }
      },
      "connections": []
    }
  }
}
```

This creates a simple kick drum that continuously fires (token loops from `ready` → `hit` → `ready`).

---

## Patterns with Skips (Rests)

### Example: Kick on 1 and 3, Skip on 2 and 4

```
Token flow:  [1] → KICK → [2] → skip → [3] → KICK → [4] → skip → [1] ...

Visual:
    ┌─────────────────────────────────────────────────────┐
    │                                                     │
    ▼                                                     │
  (beat-1)──►[KICK]──►(beat-2)──►[ — ]──►(beat-3)──►[KICK]──►(beat-4)──►[ — ]─┘
     ●
```

JSON representation:
```json
{
  "places": {
    "beat-1": { "initial": [1] },
    "beat-2": { "initial": [0] },
    "beat-3": { "initial": [0] },
    "beat-4": { "initial": [0] }
  },
  "transitions": {
    "kick-1": { "midi": [{ "@type": "MidiNote", "note": 36 }] },
    "skip-2": { "silent": true },
    "kick-3": { "midi": [{ "@type": "MidiNote", "note": 36 }] },
    "skip-4": { "silent": true }
  },
  "arcs": [
    { "source": "beat-1", "target": "kick-1" },
    { "source": "kick-1", "target": "beat-2" },
    { "source": "beat-2", "target": "skip-2" },
    { "source": "skip-2", "target": "beat-3" },
    { "source": "beat-3", "target": "kick-3" },
    { "source": "kick-3", "target": "beat-4" },
    { "source": "beat-4", "target": "skip-4" },
    { "source": "skip-4", "target": "beat-1" }
  ]
}
```

Result: `KICK - - KICK - - KICK - - KICK - -` (kick on beats 1 and 3)

### Example: Snare Backbeat (2 and 4)

```
    ┌─────────────────────────────────────────────────────┐
    │                                                     │
    ▼                                                     │
  (step-1)──►[ — ]──►(step-2)──►[SNARE]──►(step-3)──►[ — ]──►(step-4)──►[SNARE]─┘
     ●
```

Result: `- SNARE - SNARE` (snare on beats 2 and 4)

---

## Petri Net Semantics

### Enabling Rule
A transition is **enabled** when:
1. All input places have ≥ weight tokens
2. No inhibitor arc's source has ≥ weight tokens
3. Guard expression (if any) evaluates to true

### Firing Rule
When a transition fires:
1. Consume `weight` tokens from each input place
2. Produce `weight` tokens to each output place
3. Send all bound MIDI events
4. Signal connected transitions (if any)

### Token Flow = Rhythm
The arrangement of places, transitions, and arcs determines the rhythmic pattern:

```
[1] ──→ [T] ──→ [0] ──→ [T] ──→ ...
 ↑                              │
 └──────────────────────────────┘
```

A token circulating through places creates a repeating pattern. The **rate** of firing depends on token availability and transition rates.

---

## Files

- `petri-note.schema.json` - JSON Schema definition
- `example-project.json` - Complete example project
- `README.md` - This documentation

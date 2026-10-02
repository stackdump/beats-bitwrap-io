# Wave engine — Step 0 notes

What the existing code does today, written before changing anything. Line
references are to `main` at `b7704ba`.

## The net data structure (`public/lib/pflow.js`, 668 lines)

`NetBundle` is one Petri net plus its musical binding:

| field | shape | meaning |
|---|---|---|
| `places` | `{label: {initial:[float], x, y}}` | `initial` is summed to one scalar token count (`resetState`) |
| `transitions` | `{label: {x, y}}` | geometry only |
| `arcs` | `[{source, target, weight:[float], inhibit}]` | weight is summed to a scalar too |
| `bindings` | `{transLabel: {note, channel, velocity, duration, durationSteps}}` | MIDI fired when the transition fires |
| `controlBindings` | `{transLabel: {action, targetNet, targetNote, macro…}}` | control action fired instead of / beside a note |
| `track` | `{channel, instrument, group, generator, ringSize, beats, rotation, …}` | mixer + regeneration recipe |
| `role` | `'music'` \| `'control'` | |
| `state` | `{placeLabel: float}` | **the marking**, mutable |

There is no explicit incidence matrix. `buildArcIndex()` precomputes
`inputArcs[t]` / `outputArcs[t]` (each arc carries `weightSum`), which is the
incidence matrix stored column-wise: `C[p][t] = Σ out(t→p) − Σ in(p→t)`,
inhibitor arcs excluded. `isEnabled(t)` checks every input arc (inhibitor:
`tokens < w`; normal: `tokens ≥ w`); `fire(t)` subtracts inputs, adds outputs
and returns `{midi, control}`.

A project is `{tempo, swing, humanize, nets:{id: NetBundle}, initialMutes,
structure}`; `parseProject` / `projectToJSON` round-trip it.

## How the clock drives firing (`public/sequencer-worker.js`, 812 lines)

- `setInterval(tick, 60000 / (bpm · 4))` — PPQ is fixed at 4, so one tick is a
  sixteenth note and 16 ticks are a bar.
- Each tick (`_advanceOneTick`): `tickCount++`, then for every net **in
  `Object.entries(project.nets)` order**: collect enabled transitions (label
  order), `resolveConflicts` (one winner per contested input place — seeded
  `deterministicRand(tickCount, strHash(place))` when `deterministicLoop`,
  `Math.random()` otherwise), fire each survivor once, apply control actions
  immediately (so a mute fired by an earlier net in the same tick affects later
  nets), post `transition-fired` for un-muted MIDI.
- So with a single-token ring the token at `p_i` means **`t_i` fires on the
  next tick**; after `k` ticks the token sits on `p_(k mod n)` and the
  transition that fired at tick `k` was `t_((k−1) mod n)`.
- Bar boundaries (`tickCount % 16 == 0`) are where queued projects and
  per-track pattern edits are swapped in.
- Extras that are *not* in the net: loop wrap / seek replay everything from tick
  0 silently (`fastForwardTo`), mobile catch-up advances state silently, and
  when `deterministicLoop` is off `driftMidi` jitters velocity / drops ghost
  notes per loop iteration and `applyPhaseDrift` occasionally shifts a token.
- `state-sync` (the marking) is posted every 6 ticks; that is what the canvas
  and the Stage visualizers (mandala / corona / sonar / petal) read.

## The binding layer (where fires become sound)

worker `transition-fired` → `lib/backend/index.js::onRemoteTransitionFired`
(visual pulse, particles, Stage pulse, humanize, hit-pad transpose, live
transpose, then schedules on an AudioContext-clock grid anchored at the first
`playbackTicks`) → `petri-note.js::_playNote` →
`lib/backend/audio-io.js::playNote` (mute checks, per-channel routing to Web
MIDI or audio) → `audio/tone-engine.js::playNote` → a `Tone.PolySynth` per
channel, or for channels 10–15 the `_synthDrumKit` which dispatches by MIDI
note: 36/35 kick (MembraneSynth + click), 38/40 snare (bandpassed noise +
membrane body), 39 clap (3-burst pink noise), 42–46 closed hat, 49/57 open hat.
Kit variants differ only in decay/octave constants.

## How instruments / rings are built per genre

`lib/generator/composer.js::compose(genre, {seed, structure, …})`:

- **Drums** — `euclidean(k, n, rotation, note)` from the genre's
  `kick/snare/hihat: [k, n, rot, note]`: `n` places in a cycle, one token on
  `p0`, `n` transitions `p_i → t_i → p_(i+1)`, MIDI bindings only on the
  Bjorklund hit positions with `accentVelocity` (downbeat accents, deterministic
  ±5 jitter). Hi-hat uses `ghostNoteHihat` when `ghostNotes > 0`: the same ring
  with seeded low-velocity (30–49) ghost bindings on some rest steps.
  `polyrhythm` changes the hat ring length (dnb: 6) — rings of different `n`
  are exactly the Z_a × Z_b picture.
- **Bass / melody / harmony** (cohesion v2, the default): 64-place rings
  (4 bars) whose bindings carry chord-root bass, the phrase-grammar motif and a
  strummed chord pad. v1: `markovMelody` / `walkingBassLine` /
  `callResponseMelody`, also 64-place rings.
- **Arp** (edm/synthwave/trance): `euclideanMelodic`, a 16-ring with a binding
  on every step cycling a 5-note scale slice.
- **Stingers** `hit1…hit4`: 16-rings, 4 quarter-note hits, initially muted.
- **Structure** (`structure: 'standard'` etc.): every role is cloned into riff
  variants (`bass-0…bass-8`, …) and *control nets* — linear chains whose
  transitions carry `mute-track` / `unmute-track` / `activate-slot` at section
  boundaries — switch which variant is audible. Drum-fill nets, feel-curve and
  macro-curve control nets are added the same way.

## Where Euclid and Markov enter

- Euclid: at compose time (`bjorklund`) — it decides *which places carry
  weight*.
- Markov: also at compose time (`markov.js`, `theme.js` motif grammar) — it
  decides *which pitch each transition binds*.
- **Neither runs at play time.** Verified by probing `compose()` for techno,
  ambient and jazz seed 42 and techno+standard: every music net is a single
  cycle with exactly one token, no branching place, no inhibitor arc. The
  runtime "choice points" are only (a) control nets switching mutes/slots at
  section boundaries, (b) `resolveConflicts`, which never triggers on these
  rings, and (c) the non-deterministic drift path described above.

## How (genre, seed, structure) determines everything

`compose` seeds one mulberry32 `rng` from `seed` (drums use an FNV hash of the
genre name instead); every choice — chord progression, motif, instrument per
role, variants, fills, stingers — is drawn from it in a fixed order, and the Go
port (`internal/generator`) is held byte-identical. With `seed` given, the only
wall-clock inputs left are `Date.now()` defaults when no seed is passed
(`compose`, `shuffleInstruments`, `arrange.js`'s default). Playback is then
deterministic **iff** `deterministicLoop` is on; the default worker drift path
uses `Math.random()` for conflicts (moot on rings) and loop-iteration-seeded
drift.

## Consequences for the wave engine

1. Each music net is literally Z_n with one token. The ring's gate is
   `g(t) = Σ_p w_p · pulse(t − p·tick)` with `w_p` = velocity bound to `t_p`.
2. Control nets are what break periodicity; they are applied as switches of
   the ring weights at tick boundaries (a muted ring contributes no new pulses;
   tails already sounding decay naturally).
3. The executor needed in the audio thread is small: enabled-check, the
   deterministic conflict rule, fire, and the mute/slot/stop control actions.
   Macros (`fire-macro`), `set-feel`, loop/seek and drift live in the worker and
   main thread and are out of scope for the first cut.

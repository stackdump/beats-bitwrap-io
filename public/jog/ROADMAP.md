# Jog lab roadmap

Written 2026-09-20, the day before a Hercules DJControl Inpulse 200 MK3
arrives. Everything in `public/jog/` so far was built and tested against a
*simulation* of that controller, whose MIDI map is borrowed from Mixxx's
mapping for the original Inpulse 200. This roadmap is what happens once the
real thing is on the desk.

Same rule as the repo roadmap: every item cites the evidence it came from, and
**if the evidence no longer reproduces, delete the item rather than doing it.**
Several items below exist only because of an unverified assumption; Phase 0
will kill some of them. That is the point of Phase 0.

Related: `README.md` here (runbook, file map, verification table), the repo
`ROADMAP.md` (unattended-operation work; nothing here outranks its Phase 0).

## Constraints this works inside

- **The studio's determinism is not negotiable.** Same genre + seed = same
  track, same CID. A jog wheel is a *performance* input, like macros and the
  APC mini: it changes what you hear live and never what a share reproduces.
  Jog bindings stay out of the share payload, as CC/pad bindings already do
  (repo `CLAUDE.md`, "What belongs in a share payload").
- **No npm, no bundler.** The lab is vanilla ES modules and stays that way.
- **The profile is data; the adapter is device-agnostic.** A second controller
  is a second profile file, not a second adapter.
- **`main` is production.** `public/` is `go:embed`ded and a push deploys.
  Lab work that is not ready to serve lives on a branch.

---

## Phase 0 — Hardware day (an hour, mostly measuring)

The runbook is README "Hardware day". The roadmap items are its *outputs*.

### 0.1 Run the calibration and keep the capture

`calibrate.html` → eight steps → **Download capture** → **Save override** →
`demo.html?midi=real`.

Done when: a `jog-capture-*.json` exists and
`node public/jog/analyze-capture.mjs <file>` prints the assumed-vs-measured
table from it.

Evidence: every `[UNVERIFIED]` tag in `inpulse-200-mk3.js`.

### 0.2 Commit the capture as a fixture

Put it at `public/jog/fixtures/inpulse-200-mk3.capture.json` and add a node
test that runs `learn.js` over it and asserts the profile file agrees with it.
From then on the profile cannot silently drift from what the hardware sent, and
the demo's **replay capture** reproduces real-hand input with no hardware
attached — including in the headless e2e.

Evidence: today the only test of the profile is a simulator built *from* the
profile, which is circular. `jog.test.mjs` "learner confirms the guess" proves
the learner, not the guess.

### 0.3 Fold measurements into the profile, flip the tags

Edit `inpulse-200-mk3.js`: real values, `[UNVERIFIED]` → `[MEASURED 2026-09-2x]`,
real port name in `name` and a tight `match`. Then **Clear override** — the
override is a bridge for the first hour, not a place for truth to live.

### 0.4 Decision gates — read these off the calibration table

Each row decides whether later work exists at all.

| Measured | If it matches the guess | If it does not |
|---|---|---|
| Relative `twos`, ±1 per message | nothing to do | `offset64`: set `encoding`, done. **`absolute`**: the adapter needs a delta-from-last decode with wraparound — new item, blocks Phase 1. |
| Touch is a note, CC switches `0A`/`09` by touch | nothing to do | Same CC both ways (wizard warns): delete the "untouched scratch = bend" fallback's comment and rely on the touch note alone; adapter already behaves. |
| 248 ticks/rev | nothing to do | Use the measured count. If cw and ccw disagree by >6% twice, the encoder drops ticks at speed — note the speed, see 1.3. |
| `maxMagnitude` 1 | delete the "firmware coalesces" checkbox and the sim's coalescing branch | keep both; set the measured max |
| Vinyl button changes nothing | nothing to do | firmware owns vinyl mode: add a `vinylCC` to the profile and surface its state in the adapter |
| No wake-up needed | delete the wake-up button | send `B0 7F 7F` on connect in real mode; record it in the profile as `init` |
| Peak rate / timestamps | record the numbers in the README table | if Chrome visibly batches (many messages, one timestamp, gaps ≫ 1 ms), that is fine for scrub-by-position — write it down and move on |

### 0.5 The eyeball checks the wizard cannot automate

Touch-then-turn vs turn-then-touch ordering; whether a palm on the *edge*
fires the touch sensor; how hard a flick has to be before release-then-coast
produces bend ticks. Thirty seconds each in the raw log. Record findings in the
README verification table (rows 6, 7, 9, 12).

---

## Phase 1 — Make it feel right (a day, by ear)

Nothing here can be done without hands on the wheel, which is why none of it
was attempted in simulation.

### 1.1 Tune the scrub chase

`scrub-worklet.js` follows the hand with a 35 ms position chase + 4 ms rate
smoothing, chosen from arithmetic (overdamped, ζ ≈ 1.1) and a mouse. Tune by
ear on: slow drag (should be continuous, not granular — at 10 ticks/s the rate
currently pulses per tick), baby scratch (should not smear), hold-still (dead
silent). If one constant cannot do both ends, make the chase adaptive: long
tau at low tick rate, short at high. Mixxx's alpha-beta filter (α = 1/8,
β = α/32) is the known-good reference if the simple chase will not settle.

Done when: the slider has a value you stop touching, and it is the default.

### 1.2 Release behaviour: motor spin-up and the flick

Release currently eases to 1× over ~45 ms. Real decks take longer and DJs
expect a throw to carry. Decide by ear whether release should (a) snap to 1×
as now, or (b) inherit the platter's velocity and converge. If (b), the bend
ticks a coasting wheel emits after release are the input — they already reach
`nudge()`; `bendDepth`/`bendTauSec` in `jog-adapter.js` are the knobs.

### 1.3 High-speed integrity

Spin hard ten times through one marked revolution. If net ticks at speed fall
short of the slow-turn count, the encoder or the USB path is dropping. Position
scrubbing then under-travels on backspins. Mitigation lives in the adapter
(scale by measured loss above a rate threshold) only if the loss is consistent;
otherwise document it and live with it — it is a £100 controller.

### 1.4 Correct the simulator to match

Feed measured `coastTauSec`, touch ordering and rate ceiling back into
`jog-sim.js` so the mock stays a faithful stand-in for days the controller is
not plugged in. The capture fixture (0.2) is the arbiter.

---

## Phase 2 — Into the studio (the real work; branch `jog-input`)

The lab proves the adapter; the studio is a different clock. Read these before
estimating.

### 2.1 Make MIDI input channel-aware first

`lib/backend/audio-io.js::handleMidiMessage` destructures
`[status, data1, data2]`, masks the type, and **discards the channel**; it
also ignores note-off and velocity-0 note-on. The Inpulse puts the mixer on
channel 1, deck A on 2, deck B on 3, and shift layers on 5/6 — with the *same*
note and CC numbers reused across them. Plugged into today's studio, deck A's
touch (note 8) and deck B's touch are one pad, and any pad binding on note 8
fires every time a hand lands on a platter.

Worse for CCs: the hover-bind path treats CC values as absolute 0–127. A
relative jog CC bound that way slams its slider between 1 and 127 on every
tick.

So, before any jog feature: a profile-matched input gets first refusal on its
own messages (`parseJogMessage` returns non-null → consumed, never reaches
pad/CC learn), and bindings gain an optional channel. `apc-mini-mk2.js` is the
precedent for a device-specific layer in `lib/backend/`.

Done when: with the Inpulse connected, touching and turning either platter
changes nothing in the studio unless jog mode is on, and the MIDI Monitor still
shows the raw bytes.

### 2.2 Jog as transport control (cheap, no audio work)

Map the adapter's clock interface onto the worker protocol:

| Adapter | Worker | Note |
|---|---|---|
| `freeze()` | `transport: pause` | |
| `release()` | `seek` to landing tick, then `transport: play` | |
| `scrubBy(s)` | accumulate; **no message per tick** | see below |
| `nudge(r)` | `tempo` | throttle ≤ 10 Hz: every `tempo` message calls `restartTimer()` |

`seek` is `fastForwardTo()`: reset every net and replay from tick 0 with MIDI
suppressed. Correct, and O(target tick) — fine once on release, ruinous at the
hundreds-per-second a jog emits. The lab's ring nets step backwards by
un-firing; the studio's nets cannot in general (conflict resolution picks a
winner at random from a seeded stream, control nets mute/unmute, macro nets are
injected and pruned), so there is no cheap reverse. Scrub therefore moves a
*display* playhead while frozen and commits one `seek` on release.

This alone gives: platter as a needle-drop / cue control, outer ring as tempo
nudge for beat-matching against another source. Useful without 2.3.

Done when: `make test-e2e` has a jog case driven by the capture fixture —
freeze, scrub back two bars, release, assert the worker's tick and marking
equal a fresh `seek` to that tick.

### 2.3 Audible scratch (expensive; decide after living with 2.2)

Live-triggered Tone voices can be paused and re-timed but not played
backwards, so an audible scratch needs rendered audio under the needle, as in
the lab. Options, cheapest first:

1. **Scratch the cached `.webm`.** Feed-card audio already exists per CID.
   Decode to an `AudioBuffer`, hand it to `scrub-worklet.js`, crossfade from
   live synths to the buffer on touch and back on release. Cost: it is the
   *canonical* render, not the listener's live mix — macros, mutes and FX
   tweaks made this session vanish while the hand is down. Probably acceptable:
   a scratch is a second or two.
2. **Render the current bar window on touch.** `lib/share/offline-render.js`
   (`renderToBlobOffline`) already instantiates an offline ToneEngine with the
   live FX state and runs 5–15× realtime. Rendering ±2 bars around the playhead
   is sub-second on a fast machine but not instant — so render *ahead*,
   continuously, while jog mode is armed. Its header lists known fidelity gaps;
   realtime is still canonical for prod renders. Read that header first.
3. **Rolling capture of the live output.** A ring buffer of the last N seconds
   off the master bus: backspin works with zero render cost and perfect
   fidelity; scrubbing *forward* past "now" has nothing to play. Combine with 1
   or 2 for the forward half, or accept that scratching is mostly backwards.

Recommendation: 3 for backwards + 1 for forwards. Neither needs a new render
path. Do not start until 2.2 has been used for a week — the transport mapping
may turn out to be the feature.

Guard-rail: the oscillator-leak fix (periodic voice recycle) and the 256-voice
ceiling both assume the engine keeps running; pausing the worker while synth
tails ring out is already exercised by `transport: pause`, but crossfading a
second source onto the master bus is new. `make test-audio` must stay green.

### 2.4 Two decks

The controller has two platters and a crossfader; the studio has one project.
Not a jog problem — it is "load a second share and mix" — and it is the feature
the hardware actually implies. Out of scope here; write it up in the repo
roadmap if 2.2 makes you want it. The Auto-DJ's pre-rendered next track is the
nearest existing seam.

---

## Phase 3 — The rest of the controller (opportunistic)

The Inpulse has ~60 other controls. Most map onto things the studio already
exposes, through the existing preset mechanism rather than new code:

- `lib/backend/midi-presets.js` ships with `PRESETS = []` and a comment saying
  to add entries "only when a layout is verified against real hardware AND the
  user wants a one-click setup". After Phase 0 both are true. Pads → macros,
  EQ/filter knobs → FX sliders, tempo fader → BPM. Needs 2.1's channel support
  first or deck A and deck B knobs collide.
- LED feedback: Mixxx's script drives Inpulse LEDs with note-ons on the same
  channels (`0x91 0x03 0x7F` lights Vinyl). `apc-mini-mk2.js` already does LED
  sync for its device; same shape. Verify LED notes with the MIDI Monitor
  before writing any.
- The built-in audio interface (master + headphone cue) is a USB audio device,
  not MIDI; Web Audio's `setSinkId` could route a cue bus to it. Only matters
  after 2.4.

---

## Housekeeping

- **Decide where the lab lives before committing.** Under `public/` it ships
  in the binary and is served at `/jog/` in production (unlinked, `noindex`).
  If that is unwanted, move tests, fixtures, `cdp.mjs` and the e2e scripts to
  `tools/jog/` and leave only the runtime modules in `public/`. The studio will
  import `inpulse-200-mk3.js`, `jog-adapter.js` and `scrub-worklet.js` from
  Phase 2 on, so those three belong in `public/lib/backend/` eventually.
- **Wire the node tests into `make test`** once committed; add
  `//public/jog:jog_test` via `tools/nodejs_test.bzl` so `bazel test //...`
  covers it, as `//scripts:cohesion_parity_test` does.
- **`sw.js` precaches a fixed asset list.** `/jog/*` is not in it, which is
  correct for a lab; revisit only if jog modules become studio imports.
- **Delete what Phase 0 disproves.** The wake-up button, the coalesce
  checkbox, the `offset64` branch — each is a hedge against not knowing. Once
  known, the hedge is dead code.

## Not doing

- **Emulating Serato/Mixxx feature-for-feature.** Slip mode, beat-jump, loop
  roll on the jog: the studio has macros for the musical equivalents.
- **Making scratches reproducible in a share.** A recorded performance is a
  different artifact (an event log over a CID) — interesting, and entirely
  separate from an input adapter.
- **Supporting controllers nobody here owns.** The profile format makes a
  second device cheap; write it when the device exists.

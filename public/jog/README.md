# Jog lab

A simulated Hercules DJControl Inpulse 200 MK3 jog wheel, delivered as Web
MIDI-shaped `midimessage` events, mapped onto a Petri-net clock, with a Tone.js
demo you can scratch. Exists to settle the adapter design before the hardware
is bought. Not linked from the studio.

```bash
make dev                      # then http://localhost:8089/jog/demo.html
# or, with no Go server:
(cd public && python3 -m http.server 8765)   # http://127.0.0.1:8765/jog/demo.html

node --test public/jog/jog.test.mjs          # message stream, adapter, reversible net
node public/jog/e2e.cdp.mjs                  # headless Chrome: real mouse drags, asserts audio + marking
node public/jog/e2e-calibrate.cdp.mjs        # headless rehearsal of the hardware-day wizard (needs the :8765 server)
```

## Hardware day

1. Plug in. Confirm the OS sees it before blaming the browser:
   `amidi -l` (expect a `hw:X,0,0` line naming the controller) and
   `aseqdump -p "<client name>"` — touch the platter, bytes should scroll.
   Class-compliant USB MIDI needs no driver on Linux (`snd-usb-audio`).
   **Close `aseqdump` before opening Chrome's page if the port shows up busy.**
2. `make dev`, open **http://localhost:8089/jog/calibrate.html** in Chrome and
   allow the MIDI permission. (Web MIDI needs https or `localhost` — a LAN IP
   will not work.) The input list shows the real port name; hot-plug updates it.
3. Walk the eight steps (~5 min). Each one prints what it measured and warns
   when reality disagrees with the guess. Silent controller → "Send wake-up".
4. **Download capture** first (it is the only record of raw bytes), then
   **Save as profile override**.
5. Open `demo.html?midi=real`, press Play, scratch. The source line should read
   `calibrated (…)`. Tune "scrub smoothing" by ear.
6. Afterwards, fold the measurements into `inpulse-200-mk3.js` (flip the
   `[UNVERIFIED]` tags), Clear override, and keep the capture:
   `node public/jog/analyze-capture.mjs jog-capture-….json` re-runs the analysis
   offline, and demo.html's **replay capture** plays real-hardware input back
   through the mock with original timing — a regression fixture for free.

valoper note: `/dev/snd/seq` is `root:audio` and `myork` is not in `audio`;
access comes from the logind ACL granted to whoever is logged in **at the
desktop**. Chrome in the desktop session works; over ssh/ttyd `amidi` will say
permission denied (`sudo usermod -aG audio myork` + re-login if that matters).

Rehearse the wizard with no hardware: `calibrate.html?midi=mock`.

## Pieces

| File | Role |
|---|---|
| `inpulse-200-mk3.js` | **Device profile.** Every number the hardware decides, each tagged `[MIXXX]` or `[UNVERIFIED]`, plus `parseJogMessage()`. The only file to edit when the real values are known. |
| `mock-midi.js` | `requestMockMIDIAccess()` → `MIDIAccess`/`MIDIInput`/`MIDIMessageEvent` look-alikes. `e.data` is a `Uint8Array`, `e.timeStamp` is on the `performance.now()` timeline, both `onmidimessage` and `addEventListener` work. |
| `jog-sim.js` | The "hardware": encoder tick accumulation, 1 ms USB-frame timestamps, touch-selects-CC, flick inertia. No DOM. |
| `jog-wheel-ui.js` | SVG wheel. Pointer → sim; the drawn rotation comes back **from the message stream**, so you see what the consumer was told. |
| `jog-adapter.js` | MIDI → `clock.freeze() / scrubBy(seconds) / release() / nudge(ratio)`. Knows no audio and no Petri nets. |
| `scrub-worklet.js` | The turntable: signed variable-rate buffer reader in the audio thread. |
| `petri-clock.js` | Token-ring nets (Euclidean via the studio's own `bjorklund`) and a clock that steps **both directions** by un-firing. |
| `demo.js` / `demo.html` | Wiring. Loads the saved override; can replay a capture. |
| `learn.js` | Profile-agnostic analysis of captured messages + the calibration script. Pure; tested by recovering a simulated device that differs from the guess in every field. |
| `calibrate.js` / `calibrate.html` | The hardware-day wizard (real input by default, `?midi=mock` to rehearse). |
| `replay.js`, `analyze-capture.mjs` | Replay a saved capture into the mock; re-analyse one under node. |
| `cdp.mjs`, `e2e*.cdp.mjs` | Dependency-free headless Chrome checks. |

## Swapping in the real controller

Open `demo.html?midi=real`. That flips the one expression in `demo.js`:

```js
const access = await (useReal
    ? navigator.requestMIDIAccess()
    : requestMockMIDIAccess({ inputs: [profile] }));
```

Everything downstream is unchanged. In real mode the page logs **every**
message from **every** input raw, and the on-screen wheel follows the real
platter — which is the tool for the checklist below.

## What the simulator models, and why

- **One message per encoder tick, value always `01` or `7F`.** So MIDI rate is
  proportional to wheel speed — nothing at rest, ~70/s on a slow drag,
  ~250–500/s on a normal scratch, 1000+/s on a hard spin. There is no fixed
  report rate to emulate. At 248 ticks/rev one tick is 1.45° and 7.3 ms of
  audio at 33⅓.
- **Timestamps are interpolated across each pointer sample, then quantized up
  to 1 ms**, with bursts sharing a timestamp — what USB full-speed framing
  does. Delivery to the handler is still lumpy (it waits for the event loop),
  exactly as with the real API. **Consumers must use `e.timeStamp`, never
  `performance.now()`**, and better still not depend on timing at all — hence:
- **The adapter scrubs by position, not speed.** Out-and-back returns to the
  same sample and the same marking regardless of delivery jitter. Converting
  position error to an audible rate happens per-sample in the worklet
  ("scrub smoothing" slider = the chase time constant).
- **Touch selects the CC.** Platter touched → `0A`; ring only → `09`.
- **Flick.** Release mid-swing: touch-off first, then the coasting wheel emits
  *bend* ticks until friction stops it. Real DJ software sees the same thing.

## Verify when the hardware arrives

`calibrate.html` measures rows 1–5, 7 (partly), 8, 10, 11 automatically; the rest are eyeball checks in its raw log.

| # | Uncertain | Assumed | How to check |
|---|---|---|---|
| 1 | **The whole map applies to the MK3 at all.** Source is Mixxx's mapping for the *original* Inpulse 200; MK3 is different firmware. | same as original | Touch/turn deck A and compare bytes to `91 08 7F`, `B1 0A 01`, `B1 09 01`. |
| 2 | Web MIDI port name | `/inpulse\s*200/i` | "Source:" line lists real names. If nothing matches, the page listens to all inputs. |
| 3 | Touch release form | `91 08 00` (note-on, vel 0) | Lift finger. `81 08 00` instead? set `releaseAsNoteOff`. Adapter already accepts both (checkbox exercises it). |
| 4 | Ticks per revolution | 248 (Mixxx's number; may be tuned by feel) | Mark the platter, turn exactly once while touching, count `0A` lines. Changes scrub distance per turn. |
| 5 | Value magnitude | always ±1 | Spin hard; look for `02`, `7E`… The decoder handles it; "firmware coalesces" checkbox simulates it. |
| 6 | Peak message rate / any firmware cap per USB frame | uncapped, 1 ms frames | "MIDI rate (peak)" readout during a hard spin. If Chrome drops or batches, position-scrubbing still holds. |
| 7 | Touch sensitivity, debounce, and ordering | note-on strictly before first `0A`; instant | Turn-then-touch and touch-then-turn; look for `0A` before the note-on or `09`→`0A` switching mid-motion. Adapter treats untouched `0A` as bend. |
| 8 | Does the **Vinyl** button change what the wheel sends? | no — Mixxx handles it host-side | Toggle Vinyl, touch + turn, see whether CC stays `0A`. |
| 9 | Needs a wake-up message to start reporting? Mixxx sends `B0 7F 7F` at init. | not required for jog | If the wheel is silent until Hercules/Mixxx software has run, send that via a `MIDIOutput`. |
| 10 | Free-spin decay | τ = 0.45 s | Feel only; `coastTauSec`. |
| 11 | Shift layer on +3 channels | `94`/`B4` | Hold SHIFT, turn. |
| 12 | Linux: port appears via ALSA `snd-usb-audio` without a vendor driver | yes (class-compliant) | `aconnect -l` / `amidi -l` on valoper. |

## Carrying this into the studio

The adapter's clock interface maps onto the worker protocol, with two caveats
worth knowing before wiring it:

| Adapter call | Worker message | Caveat |
|---|---|---|
| `freeze()` | `{type:'transport', action:'pause'}` | — |
| `release()` | `{type:'transport', action:'play'}` | — |
| `scrubBy(s)` | `{type:'seek', tick}` | `seek` **replays from tick 0**. Fine per bar, far too heavy per jog tick (hundreds/s). Accumulate and seek on release, or throttle to ~10 Hz. The ring nets here step backwards by un-firing; the studio's nets include conflict resolution and control nets, which are not reversible that way. |
| `nudge(r)` | `{type:'tempo', bpm}` | Each tempo message calls `restartTimer()`. Throttle. |

**Audible scratching needs rendered audio.** Live-triggered synth voices can be
frozen and re-timed but not played backwards. This demo renders the net's loop
with `Tone.Offline` and plays it from the worklet; in the studio the analogue
is `lib/share/offline-render.js` (or the cached `.webm`) feeding the same
worklet while the worker is paused, then a `seek` to the landing tick on
release. Jog bindings would sit beside the APC mini integration in
`lib/backend/`, and like other CC/pad bindings stay out of share payloads.

# Lane-view animation: trail on the wrong side

Branch `val/run-4e80be68`. Videos in `docs/animation/` (10 s of the lane, techno / seed 42, headless Chrome; `-slow` is 0.25x):

| | real time | slowed |
|---|---|---|
| before | `lane-before.mp4` | `lane-before-slow.mp4` |
| after (default timing) | `lane-after.mp4` | `lane-after-slow.mp4` |
| after, `?vizclock=1` (audio clock) | `lane-after-clock.mp4` | `lane-after-clock-slow.mp4` |

Recorded with `scripts/record-lane-video.mjs` (raw CDP, `captureScreenshot` loop clipped to the dot band, ffmpeg). Not Playwright: it is not installed on valoper or gir, and the repo's other browser tests use raw CDP too.

## What is on screen

The "scrolling lane" is the rolling-dots timeline drawn on the net canvas by `vizDrawTimeline` (`public/lib/backend/audio-io.js`), called from `renderFrame` (`lib/ui/canvas.js`) from the viz rAF loop (capped at 30 fps).

- **Which way time flows:** right to left. A fired note is pushed to `el._vizHistory` and drawn at `x = w - (age / window) * w`. Age 0 is `x = w`, the right edge. Older notes are further left.
- **Where the playhead is:** the right edge of the canvas. There is no drawn playhead line; "now" is `x = w`. (The DOM `.pn-timeline-playhead` in `renderTimeline`/`updatePlayhead` is the separate structure bar, not this lane.)
- **How the trail is computed:** `streakLen = min(20, w / windowMs * 120)`, drawn as `fillRect(x - streakLen, 27, streakLen, 6)` with a gradient that is transparent at `x - streakLen` and opaque at `x`.

## The bug

The dot moves toward smaller x, and the streak is drawn at `x - streakLen .. x`, which is toward smaller x too. So the trail is on the leading edge, bright at the dot and fading out ahead of it in the direction of travel. A trail should fade out behind the dot, toward where it came from (the playhead, larger x). The before video shows exactly this: every streak is on the dot's left while the dots move left.

This is a plain sign error, **not** a regression from the Tone.js → djwasm switch. `git log -S` puts the `x - streakLen` code in the original commit (8db6126, 2026-03-23) and it moved unchanged in the extraction commit 6bb1076 (2026-04-19). The only later edits to `vizDrawTimeline` are the 30 fps cap (980fdf7) and the non-finite-tempo guard (5bef98d). It was less noticeable before because slow, sparse dots hid it; denser cohesion-v2 tracks and the 2 s lane make it obvious.

## Timebase (found by reading the code; not measured)

The dot position also has a timing problem, separate from the trail side, and it is the likelier source of "the music feels faster than the dots":

1. **Wrong clock.** `vizSpawnParticle` stamps `Date.now()` when the `transition-fired` message *arrives on the main thread*. djwasm already reports the audio-clock time at which the note sounds (`wave-tick.t`, passed as `audioT` into `onRemoteTransitionFired`), but the lane ignores it. So each dot carries the main-thread message jitter (ticks are batched per worklet message and handled on a busy thread), and the speaker output latency is never accounted for. With Tone.js the same `Date.now()` was already used, so djwasm didn't create this, but it also never fixed it.
2. **Window depends on retained history.** `windowMs = max(2000, min(240/bpm*1000, now - firstDot.time + 500))`. `_vizHistory` is capped at 200 entries. On a dense track more than 200 notes land inside the window, the oldest are dropped by count, `elapsed` shrinks, the window shrinks, and every dot's speed `w / windowMs` changes. Dots visibly speed up and rescale. A tempo change rescales all dots at once for the same reason.
3. **The comment is wrong.** The code comment says "4 bars = 8 s at 120 bpm", but `240/bpm` is one bar, so the window is about 2 s at 120 bpm and above (the 2 s floor). That is why dots cross the lane quickly.

I did not measure the message-arrival jitter in the headless run; headless Chrome does not reproduce real-device main-thread load. Treat item 1 as a design fault with an unmeasured magnitude.

## Fix

- `public/lib/viz/timeline-math.js`: pure functions for the geometry (`dotX`, `trailSpan`, `layoutDots`, `windowSec`). Time flows toward -x, and `trailSpan` extends *against* the motion. `vizDrawTimeline` now draws from it. **The trail-side fix is unconditional**, in both timebases.
- **`?vizclock=1` (flag, off by default):** dots are positioned from the audio clock: `age = (ctx.currentTime - outputLatency) - audioT`, a fixed window (`windowSec(tempo)`), no dependence on how many events are retained, and a note whose `audioT` is still in the future is held back instead of drawn. Default timing is the legacy `Date.now()` path, unchanged except for the trail side, so the clock change can be judged on its own before it becomes the default.
- `scripts/test-timeline-math.mjs` (`make test-timeline-math`, also in `make test`) checks that the dot moves right to left, that the trail sits on the opposite side to the motion at several ages, that the opaque end is at the dot, that future and expired notes are not drawn, and that scroll speed does not depend on how many events exist.

## Design choice: plain JS, not a Rust crate

Matt's instruction was to pick plain canvas JS if it fixes the bug cleanly and the timeline math is small, and to choose Rust only if the math would be shared with the booth or the Android app, or there is another concrete win.

- The bug is a sign error plus a timebase source. The whole fix is about 50 lines of pure arithmetic, now unit-tested in Node.
- The timebase already comes from djwasm: `audioT` is the worklet's own clock, so JS doesn't re-derive it, it only subtracts it from `AudioContext.currentTime`. A Rust crate would receive the same two numbers.
- Nothing in this repo shares this math with another consumer. djandroid nests the *djrust* engine, not beats' canvas; beats-btw-dj is Swift. If the booth or Android app later needs the same lane, `timeline-math.js` is dependency-free and the contract (events with a time, a now, a window, a width) is small enough to port then, with this test as the spec.
- A separate wasm module would add a build step (wasm-bindgen on gir), a second artifact to load and pin by SRI, and a JS↔wasm call on every 30 fps frame, for no behaviour the JS version lacks.

So only the JS option is prototyped. **Revisit** if a second consumer appears.

## Not done

- Not made the default: `?vizclock=1` needs a look on a real device before it replaces `Date.now()`.
- The 200-event cap in `vizSpawnParticle` still exists; under `vizclock` it no longer changes speed, but a very dense track can still drop visible dots.
- No deploy is staged.

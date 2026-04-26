# TODO

The big work is shipped. This file tracks nice-to-haves and things
worth revisiting after live play-testing.

## Feel mapping tuning

After 3–4 live sessions, revisit `FEEL_MAP` in `public/lib/feel/axes.js`.
Notes from the last pass:

- Compress active mapping range to 20–100 so a nudge off center is
  immediately audible (currently 0–50 is a slow ramp).
- Verify the damp curve on Space × Energy
  (`30 + (1 - e/100) * norm * 50`) — may be too subtle.
- Consider a "reset to 50" button inside the Feel modal to snap-center
  without reverting to last-saved state.
- Confirm trait overrides set by Groove (`swing`, `humanize`) are
  actually consumed by the generator.

Trigger: when an axis feels flat during live play, re-tune just that
entry. Don't pre-optimize.

## Remote conductor (WS backend)

The element already accepts `data-backend="ws"` and
`lib/backend/index.js::handleWsMessage` speaks the full message
protocol. The paired Go server lives in a separate repo. No work
here until that repo is ready to connect.

## CLI producer

The share-v1 schema is stable enough that a `beats-cli compose --genre
techno --seed 42 > out.json` tool would fit on one page. Motivation:
piping LLM output directly into a share URL without opening a
browser. Out of scope for this repo — belongs in a sibling tool.

## Polyphony exhaustion on arranged tracks

When a share carries `"structure": "extended"` (wrapped or composer),
`Arrange()` clones each music net into A/B/C variants on the same
channel. Long-tail instruments (pad, held reese, etc.) with multiple
variants playing concurrently can still exceed the PolySynth voice
budget. `public/audio/tone-engine.js:1604` now bumps `maxPolyphony` to
**256** (shipped); `playNote()` itself doesn't do voice stealing so
notes still drop when 256 simultaneous onsets pile up.

- [x] **Bump ceiling.** 64 → 256 in `tone-engine.js:1604` + `:1655`.
- [ ] **Voice stealing in `playNote()`**. Track `(note, releaseTime)`
      per channel; when at capacity, cancel the oldest release and
      retrigger. ~30 LOC.
- [ ] **Arrangement-aware release on mute**. When a `mute-track`
      control fires, cancel in-flight notes on that channel.
      Addresses root cause; muted tracks also get real silence.

Documented in CLAUDE.md under "Arrange-on-load and the polyphony ceiling".

## Further arrange vocab

- **Repeat-aware feelCurve / macroCurve**. Today `injectFeelCurve` /
  `injectMacroCurve` key off `tmpl.sections[].name` and record only
  the first occurrence of each. A 9-section blueprint with `drop`
  repeated snaps the feel only at the first `drop`. Add a
  `sectionIndex` optional field to let authors target a specific
  occurrence.
- **Per-variant velocity envelopes** beyond the current flat delta —
  e.g. `velocityShape: "rise"` for buildup-style ramps.
- **`silence` directive** — inject a full mute across all music nets
  for N bars at a named section (complementary to drumBreak).

## Audio upload auth + competitive rendering market

The `/audio/{cid}.webm` PUT endpoint is currently first-write-wins
with only the share-store rate limit gating it: anyone can claim a
CID's audio slot before a real renderer gets there, and once claimed
the bytes are sticky (we just hit this with the 110-byte stub race
during the 2026-04-26 feed seed — recovery required SSH-deleting the
broken files server-side before a fresh PUT was accepted).

Near-term: gate PUT /audio with a signed-token / shared-secret header
so only authorised renderers (the local worker, a future rebuild-queue
worker pool) can write, plus an admin override to overwrite bad bytes
without SSH.

Long-term ambition: turn this into a **competitive submission +
reward delegation** market. A CID is a content-addressed contract for
"give me audio of this track"; multiple renderers can submit candidate
.webms (with bond / signature), listeners vote on which they prefer
(the existing EIP-191 vote infra is a starting point), and the winning
renderer earns delegation rewards. Different renderers can offer
*augmented* variants — mastered for headphones, lo-fi tape sim,
binaural spatial mix, stem separation — addressed under the same CID
via a variant qualifier (e.g. `/audio/{cid}.webm?v=mastered`). The CID
stays canonical; the audio surface becomes a marketplace.

Pre-work before this is worth designing in detail:
- per-renderer identity (DID / wallet address)
- variant addressing scheme + canonical-URL discovery
- dispute / replacement protocol (slashing for fraud or silence)
- listener vote → reward distribution path

## Stinger-group custom IDs in the Beats tab

`build.js` filters Fire pads by the MACROS-catalog IDs (`hit1..hit4`).
Hand-authored shares that declare stinger-group tracks with bespoke
names (e.g. `airhorn-slot`) get the Beats tab visible but no Fire
pads. Surface such tracks as extra pads keyed off the actual net ID
rather than the macro catalog.

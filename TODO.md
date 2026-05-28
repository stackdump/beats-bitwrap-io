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
- **Rejected: voice stealing in `playNote()` + arrangement-aware
  release on `mute-track`.** Both were considered as root-cause fixes;
  the 256 ceiling proved sufficient in practice and was chosen instead.
  Don't re-pitch unless listener-audible drops resurface at the current
  ceiling.

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

## Audio upload divergence — shipped + remaining

The near-term ask in the original TODO entry — gating canonical writes
behind a shared-secret + an admin override for bad bytes — landed in
several pieces:

- [x] **`X-Rebuild-Secret` on PUT /audio** bypasses rate-limit,
  faster-than-realtime, AND first-write-wins. Lets the rebuild-queue
  worker overwrite stuck audio without SSH (resolved the 2026-04-26
  stub-race recovery path).
- [x] **`audio_provenance` column on `tracks`** (`browser` /
  `renderfarm` / `''`). Tagged at every PUT — browser uploads vs
  authenticated worker writes are now distinguishable.
- [x] **`GET /api/audio-suspect`** returns browser-uploaded CIDs older
  than a configurable grace window.
- [x] **`scripts/process-rebuild-queue.py --converge`** worker mode
  polls the suspect endpoint and re-renders, so the feed eventually
  converges to canonical render-farm output regardless of who
  originally uploaded.
- [x] **Master-vol compensation on the browser-record branch**
  (`client-render.js`). Browser-uploaded `.webm`s now match the share's
  authored `fx.master-vol` instead of the user's live slider position,
  so most browser uploads are byte-comparable to render-farm output
  before the converge sweep ever runs. Speaker monitor unaffected.

### Still open at this layer

- **Per-channel mixer vol divergence.** The master-vol compensation
  fix only covers the master. Per-channel vols (kick/bass/lead/etc.)
  still capture the user's live state in browser uploads — the
  converge sweep is the backstop. Same gain-node mechanism would
  generalize: hook each `.pn-mixer-vol` slider, insert per-channel
  compensation on the recording branch. Defer until the converge
  sweep's suspect-count metrics show it actually matters.
- **Other FX state divergence** (reverb wet, delay feedback, filter
  cutoffs). Same story — converge sweep is the backstop. Lower
  priority; users rarely tweak send-effect wetness mid-listen.
- **Metrics / observability.** No dashboard for suspect-count, converge
  cadence, or worker liveness. Today you query
  `sqlite3 index.db 'SELECT audio_provenance, COUNT(*) FROM tracks
  GROUP BY 1'` by hand. A `/api/audio-stats` endpoint would be a small
  addition once the converge sweep is in production long enough to
  produce interesting numbers.

### Long-term ambition: competitive rendering market

Original vision retained: turn `/audio/{cid}.webm` into a content-
addressed marketplace where multiple renderers submit candidate
`.webms` (with bond / signature), listeners vote on which they prefer
(the existing EIP-191 vote infra is a starting point), and the winning
renderer earns delegation rewards. Different renderers can offer
*augmented* variants — mastered for headphones, lo-fi tape sim,
binaural spatial mix, stem separation — addressed under the same CID
via a variant qualifier (e.g. `/audio/{cid}.webm?v=mastered`). The CID
stays canonical; the audio surface becomes a marketplace.

The provenance plumbing above is a foundation: `audio_provenance`
generalizes to a per-renderer identity column, the suspect endpoint
generalizes to a candidate-listing endpoint. Pre-work before designing
in detail:

- per-renderer identity (DID / wallet address) — replaces the binary
  `browser`/`renderfarm` tag with a richer source field
- variant addressing scheme + canonical-URL discovery
- dispute / replacement protocol (slashing for fraud or silence)
- listener vote → reward distribution path

## Stinger-group custom IDs in the Beats tab

`build.js` filters Fire pads by the MACROS-catalog IDs (`hit1..hit4`).
Hand-authored shares that declare stinger-group tracks with bespoke
names (e.g. `airhorn-slot`) get the Beats tab visible but no Fire
pads. Surface such tracks as extra pads keyed off the actual net ID
rather than the macro catalog.

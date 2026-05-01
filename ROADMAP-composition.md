# BeatsComposition roadmap

## Status snapshot

| PR | Title | Status |
|---|---|---|
| PR-1 | Envelope + render pipeline (`/c/{cid}`, `/audio-master/`, fan-out) | ✅ shipped |
| PR-2 | Per-track ops (soloRoles/mute/transposeSemis/tempoMatch/gain + variant cache) | ✅ shipped |
| PR-3 | Master FX chain (highpass/compress/eq/limiter/stereoWiden + 4 presets) | ✅ shipped |
| PR-4.1 | Generative inserts: riser | ✅ shipped |
| PR-4.2 | Generative inserts: drone / impact / texture | ✅ shipped |
| PR-4.3 | counterMelody insert (answer mode) | ✅ shipped |
| PR-4.3.1 | counterMelody harmony + shadow modes | ✅ shipped |
| PR-4.3.2 | counterMelody Tone.js OfflineAudioContext synth (timbre fidelity) | 🔜 |
| PR-5.1 | Minimal Compose page (form-based) | ✅ shipped |
| PR-5.2 | Compose page bar-grid timeline visualisation | ✅ shipped |
| PR-5.3 | Compose page drag-drop interactivity + client-side preview | 🔜 |
| PR-6 | Feed surface for compositions (cards / RSS / `?type=` filter) | ✅ shipped |
| PR-7.1 | Composition cover art (`/composition-card/{cid}.svg`) | ✅ shipped |
| PR-7.2 | "→ Compose" link on share cards (`/compose.html?seed=…`) | ✅ shipped |
| PR-7.3 | Compositions of compositions (recursive ingredients) | 🔜 |
| PR-7.4 | Stems output (per-soloRoles group emitted alongside master) | 🔜 |
| PR-7.5 | Live composition mode (WS-driven re-render on edit) | 🔜 |

This file sequences the deferred work. Each PR is sized to land + verify independently. Schema fields are additive — old envelopes always render; new envelopes degrade gracefully on older worker binaries by ignoring unknown fields.

---

## PR-2 · Per-track operations

**Goal:** make each `tracks[i]` more than a whole-mix slice. Solo specific roles, mute others, transpose, tempo-match against the composition's master tempo.

**Envelope additions (per track):**
```jsonc
"tracks": [{
  "source":         { "cid": "z…" },
  "in": 0, "len": 16,
  "soloRoles":      ["drums", "bass"],     // if set, only these play
  "mute":           ["pad", "lead"],       // mute these (after soloRoles)
  "transposeSemis": -2,                    // ± 24
  "tempoMatch":     "stretch",             // stretch | repitch | none (default)
  "gain":           -3.0                   // dB; per-track trim before bus
}]
```

**Pipeline changes:**
- `soloRoles` / `mute`: ingredient is no longer rendered as a whole `.webm`. Worker re-renders the ingredient with `?solo=drums,bass` / `?mute=pad,lead` query — page-side wires this into the existing `applyHitState` / mixer-section toggle so chromedp captures only the requested layers. Cache key becomes `(cid, soloRoles, mute)` so a second composition with different solos doesn't collide. Keys hash into the existing `data/audio/{YYYY/MM}/{cid}-{hash}.webm` namespace.
- `transposeSemis`: ffmpeg `rubberband=pitch=2^(n/12)` on the worker-side WAV before placement. Lossless; integrates into the existing decode → assemble step.
- `tempoMatch=stretch`: ffmpeg `atempo=master_bpm/source_bpm` (chained when ratio outside [0.5, 2.0]). Source BPM read from the share envelope's `tempo` field. `repitch` uses `asetrate` instead (changes pitch as side effect).
- `gain`: `volume=NdB` filter, applied before `adelay`.

**Files:**
- `public/schema/beats-composition.schema.json` + embedded copy: add fields under `CompositionTrack`.
- `internal/audiorender/composition.go::assembleTimeline`: thread per-track filter chain (existing chain becomes `volume → atempo → rubberband → atrim → afade → adelay`).
- `composition_cli.go`: parse new fields into `CompositionTrackSpec`.
- `scripts/process-composition-queue.py`: pass `?solo=…&mute=…` on the ingredient render GET.
- Page side: `public/lib/share/url.js::shareFromPayload` already reads URL params — extend to honour `solo` / `mute` query params during the boot path's mixer setup, before the recorder starts.
- Tests: extend `composition_test.go` with synthetic ingredients at known BPMs to verify tempo-match and transpose are sample-accurate within ε.

**Acceptance:** A composition with three techno ingredients all stretched to 124 BPM and pitched into the same key yields a master without the harmonic/rhythmic clash you hear today.

---

## PR-3 · Master FX chain

**Goal:** replace the single `loudnorm` step with a configurable mastering chain. Bring the output from "demo loud" to "release-grade."

**Envelope additions:**
```jsonc
"master": {
  "lufs": -14, "lra": 8,
  "format": ["wav","flac","mp3","webm"],
  "chain": [
    { "type": "highpass", "freq": 30 },
    { "type": "compress",  "threshold": -12, "ratio": 2, "attack": 10, "release": 100, "makeup": 2 },
    { "type": "eq",        "tilt": -1.5, "presence": 1.0 },
    { "type": "limiter",   "ceiling": -1.0 },
    { "type": "stereoWiden", "amount": 0.2 }
  ]
}
```

**Pipeline changes:**
- Each chain step compiles to one ffmpeg filter. Order is significant. `loudnorm` becomes the implicit final step *after* the chain (the chain shapes timbre, loudnorm rides level).
- Curated presets: `master.preset: "club" | "broadcast" | "ambient" | "lofi"` expands to a default chain. Author-supplied `chain` overrides the preset.
- Per-genre defaults from `internal/audiorender/mastering.go::MasteringFor` already exist for LUFS/LRA — extend to suggest a preset.

**Files:**
- `public/schema/beats-composition.schema.json` + embedded copy: add `Master.chain` array of step variants (oneOf per type).
- `internal/audiorender/composition.go`: new `applyMasterChain(ctx, ffmpegPath, src, dst, steps) error` that builds a single ffmpeg invocation `-af "f1,f2,..,fN"`. Replace the current `loudnormToWav` call with `applyMasterChain` followed by `loudnormToWav`.
- New helper `internal/audiorender/master_presets.go` for the preset → chain mapping.
- Tests: integration test that compares loudnorm-only output vs preset="club" output via ffprobe `loudnorm` measurement and dynamic range.

**Acceptance:** Same composition with `master.preset="club"` is measurably tighter (LRA ≤ 7) and louder true-peak-safe than the loudnorm-only baseline.

---

## PR-4 · Generative inserts

**Goal:** non-sample ingredients. Composition steps that *generate* their audio at render time instead of referencing a CID. Counter-melody, transitions/risers, sustained texture, drone — all the layers from the earlier "what plays on top" discussion.

**Envelope additions** (a `tracks[i].source` can now have `generate` instead of `cid`):
```jsonc
{ "source": { "generate": { "type": "counterMelody", "of": "trackA", "mode": "answer", "density": 0.5 } } }
{ "source": { "generate": { "type": "riser",         "len": 4, "shape": "white-noise" } } }
{ "source": { "generate": { "type": "texture",       "kind": "vinyl-crackle", "level": 0.2 } } }
{ "source": { "generate": { "type": "drone",         "key": "Am", "octaves": [2,3] } } }
{ "source": { "generate": { "type": "impact",        "preset": "sub-boom" } } }
```

**Pipeline changes:**
- Add `tracks[i].id` (string) to the schema so other tracks can reference siblings (`of: "trackA"`).
- New module `internal/generator/inserts/` with one file per insert type. Each implements `Render(rng *rand.Rand, ctx context.Context, ingredientWavs map[string]string, spec InsertSpec) (string, error)` returning a path to a generated WAV.
- The worker, when it sees `source.generate`, calls a new CLI subcommand `beats-bitwrap-io render-insert --type … --out file.wav` (mirrors `render-composition`). Keeps the Go pipeline authoritative.
- For **counterMelody**: read source-track's `.webm`, decode to MIDI events via the share envelope's transition bindings (no audio analysis needed — the envelope is the source of truth), generate a complementary line in the *opposite* of the source's rhythm mask, render via Tone.js OfflineAudioContext (`public/lib/share/offline-render.js`) seeded by `arrangeSeed`, save WAV. Worker uploads the rendered insert as just another ingredient.
- For **riser / impact / drone / texture**: pure Go DSP — additive synthesis and noise filters are simpler than Tone.js for these short-utility sounds. Optionally cache rendered inserts under `data/inserts/{spec-hash}.wav` since `(type, params)` → WAV is deterministic.

**Files:**
- `public/schema/beats-composition.schema.json` + embedded copy: `Source` becomes `oneOf({cid}, {generate})`. Add `$defs/InsertSpec` with `type` discriminator.
- `internal/generator/inserts/counter_melody.go`, `riser.go`, `texture.go`, `drone.go`, `impact.go` — one file each.
- `composition_cli.go`: extend to handle `generate` sources (call into the insert renderer first, then pass the resulting WAV as an ingredient to `RenderComposition`).
- `scripts/process-composition-queue.py`: detect `generate` sources, skip the chromedp render path for those.
- Tests: each insert type has a fixture-based test (deterministic seed → byte-identical output across runs).

**Acceptance:** A composition with one CID ingredient + one `counterMelody` insert + one `riser` insert at the section boundary plays back with a coherent answering line and a recognisable build into the drop.

---

## PR-5 · Compose UI panel

**Goal:** in-browser composer. Drop existing CIDs onto a timeline, set in/len/fades visually, preview the master, seal + render.

**UX shape:**
- New panel toggle in `<petri-note>`: `🎚 Compose` (alongside FX / Macros / Beats / Auto-DJ / Arrange / MIDI / Note).
- Panel shows: a horizontal timeline (bars), N lanes, drag-to-place, search-existing-CIDs picker, fade handles on each clip.
- "Preview" button: client-side OfflineAudioContext + Tone.js renders the timeline locally without round-tripping to the worker — same WAV the Go assembler would produce, modulo loudnorm. Lets the author iterate without burning render budget.
- "Seal" button: canonicalise + CID + PUT `/c/{cid}` + show the worker's status (poll `/api/composition-status/{cid}`).
- "Listen" button (after master lands): `<audio src="/audio-master/{cid}.webm">` inline player.

**Pipeline changes:**
- Reuse `public/lib/share/codec.js` canonicalisation for the CID compute — content-type-agnostic.
- New `public/lib/share/composition.js`: build / parse composition envelope, compute CID, PUT, poll status. Mirrors the existing share-helpers shape.
- Client-side preview: extend `public/lib/share/offline-render.js` to accept an envelope + ingredient `.webm` URLs, perform the timeline assembly with `OfflineAudioContext.startRendering`, decode WebM via `decodeAudioData`, slice with `AudioBufferSourceNode.start(when, offset, duration)`, mix-down, encode to WAV via the existing helper. Slower than ffmpeg but client-side and good enough for preview.

**Files:**
- `public/petri-note.js`: add Compose panel button + delegate to module.
- `public/lib/ui/compose-panel.js` (NEW): panel DOM, drag/drop logic, fade handles.
- `public/lib/share/composition.js` (NEW): codec for `BeatsComposition` envelopes.
- `public/lib/share/offline-render.js`: extend with `renderComposition(envelope, ingredients) → Blob`.
- `public/index.html`: register the new module.

**Acceptance:** From a fresh tab, an author can drop three feed CIDs onto a timeline, preview the mix in <10 s, seal it, watch the worker render, and play the published master. No JSON editing required.

---

## PR-6 · Feed surface for compositions

**Goal:** make compositions first-class in `/feed` and `/feed.rss` — visible, listenable, shareable, archivable.

**Pipeline changes:**
- Index: `tracks.content_type` already exists (PR-1 migration); start populating it for compositions on master upload. New worker call: `POST /api/index-record-composition {cid}` after the WebM master lands.
- Feed JSON `/api/feed`: pass `?type=BeatsComposition|BeatsShare|all` filter. Default = `all`. Add a `contentType` field per row.
- Feed UI cards: compositions render with a different chrome (gradient marker, "🎚 Composition" label) and link to `/?cid={cid}` which loads the composition's envelope, fetches each ingredient envelope alongside, and shows the timeline read-only.
- RSS enclosures: composition rows enclose `audio-master/{cid}.webm` instead of `audio/{cid}.webm`.
- Archive snapshots: `Snapshot` already streams every envelope from each `Store`. Multi-store snapshots concatenate `o/` and `c/` subtrees in the same tarball. Verify and document.
- Auto-restore: composition CIDs auto-restore from snapshots like shares do.

**Files:**
- `internal/index/index.go`: extend `RecordRender` to accept `contentType`. Add `RecordComposition` helper.
- `internal/routes/feed.go` (or wherever): plumb `?type=` filter; add `contentType` to row JSON.
- `public/lib/feed/cards.js`: composition card variant.
- `main.go::snapshotHandler` + `archiveRestoreHandler`: extend to handle both stores in one snapshot/restore round.
- Tests: `feed_test.go` ensures filtering works and composition rows surface correctly.

**Acceptance:** A composition appears in the feed within 30 s of the master landing. RSS feed includes an `<enclosure>` pointing at the `audio-master/{cid}.webm`. `/archive` snapshot tarball contains both `o/` and `c/` envelopes.

---

## PR-7+ · Forward-looking

Things to keep in mind but not commit to yet:

- **Composition of compositions.** Once stable, allow `tracks[i].source.cid` to point at a `BeatsComposition` (not just `BeatsShare`). Worker resolves recursively. Caps recursion depth at 3 to keep render cost bounded.
- **Stems output.** When per-track ops (`soloRoles`) land, emit per-section stems alongside the master so authors can remix without re-rendering: `audio-master/{cid}-stem-drums.webm`, etc.
- **Cover art generation.** Deterministic image from `(composition CID, ingredient palette)` with the section timeline visualised as a waveform-shaped graphic. ID3 / Matroska tag the masters with it so DSPs surface artwork.
- **Sharing chains as compositions.** The "remix" button on a feed card pre-fills the Compose panel with the share + 8 bars on the timeline; one click ships a composition that builds on the original. Provenance tracked via `parents` on the composition envelope (mirror the `BeatsShare.parents` field).
- **Live composition mode.** WebSocket-driven re-rendering as the author edits — server keeps a hot ffmpeg process alive per session, re-emits the master on each timeline change. Latency-sensitive; only worth doing if the Compose UI gets enough use.
- **Lyrics / vocals.** Explicitly excluded from this roadmap (per the earlier "leave out lyrics and vocals" decision). If revisited, slots in as a new insert type (`source.generate.type: "vocal"`) referencing a Suno/Udio API call or a local TTS pipeline. Determinism + content-addressing implications need their own design pass.

---

## Open questions

- **Tempo-match fidelity.** Rubberband is high-quality but expensive. For a 6-track 3-min composition, stretching 6 ingredients can add 30-60 s to a render. Worth it? Or should we restrict tempo-match to drum stems only (since melodic stretching is more audibly compromised)?
- **CID stability across schema additions.** Adding new optional fields to the envelope is safe (defaults omitted from canonical bytes), but schema-validated *new required fields* would break old envelopes. Lock down a schema-evolution policy alongside PR-2.
- **Render queue prioritisation.** Today FIFO is fine. If composition renders start eclipsing share renders (compositions always cost N×share render time), introduce per-type weighting in `internal/audiorender/Renderer.Enqueue`.

---

## Sequencing

```
PR-1 ✅ shipped (plumbing + smoke E2E)
PR-2  · per-track ops          ── unblocks meaningful musical results
PR-3  · master FX chain        ── parallel with PR-2
PR-4  · generative inserts     ── depends on PR-2 (track.id)
PR-5  · Compose UI panel       ── depends on PR-2 + PR-4
PR-6  · feed surface           ── depends on PR-5 for listening UX
PR-7+ · forward-looking        ── after PR-6 lands
```

PR-2 and PR-3 are independent; ship in either order. PR-4 leans on PR-2's track-id refactor. PR-5 is the public-facing milestone — the moment a non-developer can compose. PR-6 is what makes compositions discoverable beyond hand-shared URLs.

# beats.bitwrap.io roadmap

Written 2026-09-19 from an audit of the code, the live site and the
production data directory. The feature work is largely shipped —
`ROADMAP-composition.md` is ✅ through PR-7.4 and `TODO.md` opens with "the
big work is shipped". What is left is mostly the gap between *shipped* and
*holds up unattended*, so this roadmap is ordered by that, not by novelty.

Every item cites the evidence it came from. If the evidence no longer
reproduces, delete the item rather than doing it.

Related documents: `ROADMAP-composition.md` (the composition layer, two rows
still open), `TODO.md` (nice-to-haves; see [Housekeeping](#housekeeping) for
what in it is stale).

## Guiding constraints

These are settled and the roadmap works inside them:

- **No ML, anywhere.** Not at playback, not at authoring. Generation is
  rule-based and seeded; provenance is the product.
- **No npm, no bundler, no framework.** Vanilla ES modules and one custom
  element.
- **CIDs never change retroactively.** Anything that alters canonical bytes
  is a new envelope version, not a fix.
- **Go and JS produce identical output.** A claim of parity that no test
  checks is a hope — see Phase 2.
- **`tone-engine.js` stays one file; voice stealing stays rejected.** Both
  were decided; don't re-pitch without new listener-audible evidence.

---

## Phase 0 — Broken today

Small, and each one is a fault in production right now.

### 0.1 The rebuild worker is not running

The render server on the farm host is up (`:18090` answers), but no
`process-rebuild-queue.py` process exists beside it. On production:

- `rebuild_queue` holds **10 rows, all `claimed_at = 0`**, marked
  2026-08-07 — six weeks unclaimed. Every listener who pressed ⟳ got nothing.
- `/api/archive-missing` lists **21 shares with no audio**.
- `tracks.audio_provenance`: 14 `renderfarm`, 1 `browser`, **58 empty** of 73.

- [ ] Restart the worker (`--subscribe --converge`), confirm the queue drains.
- [ ] Make the worker a supervised unit of its own, not a pane that can
      vanish while the unit that spawned it still reports `active (exited)`.
- [ ] One pass with `--converge-include-unknown` to settle the 58 untagged rows.

### 0.2 Nobody can tell when 0.1 happens again

This is the "Metrics / observability" item from `TODO.md`, promoted: it
stopped being a nice-to-have when the queue sat for six weeks unnoticed.

- [ ] Export on `/metrics`: `rebuild_queue_depth`,
      `rebuild_queue_oldest_age_seconds`, `tracks_by_audio_provenance{…}`,
      `shares_missing_audio`, `worker_last_seen_seconds` (stamp it on any
      authenticated PUT or SSE connect).
- [ ] Alert on oldest-age > 1 h. Queue depth alone is the wrong signal — a
      busy healthy farm and a dead one both show depth > 0.
- [ ] `/health` returns 404 while `/healthz` and `/readyz` exist. Alias it;
      every sibling app answers `/health`.

### 0.3 Static assets ship uncompressed and uncacheable

Measured against the live site: `petri-note.css` transfers **89,983 B** with
`Accept-Encoding: gzip` or `br` — identical to the raw size — and carries no
`Cache-Control`, `ETag` or `Last-Modified`. Same for `petri-note.js`
(82,812 B) and the ~60 modules it imports, each an uncompressed,
unconditional request on every visit. `/` itself *is* compressed
(5,530 → 2,306 B), so this is a `gzip_types` omission in the vhost, not a
missing module.

- [ ] nginx: `gzip_types` for `text/css application/javascript
      application/json image/svg+xml`.
- [ ] Serve embedded assets with an `ETag` derived from the build (the binary
      already knows its `git describe`) so revalidation is a 304.
- [ ] `<link rel="modulepreload">` for the boot-critical modules to flatten
      the import waterfall — the no-bundler answer to a 60-request cold load.

### 0.4 Commit or drop the go-pflow bump

`go.mod` sits uncommitted at go-pflow v0.27.0 → v0.31.0. `go build ./...` and
`go test ./...` are green against it. Run the two parity targets, then commit
— remembering that a push to `main` is a deploy.

---

## Phase 1 — Hardening the public surface

Production is a public, unauthenticated write surface with one rate limiter
applied at five call sites. Ordered by how cheap the abuse is.

### 1.1 `POST /api/archive-restore` is an unmetered decompression oracle

`main.go:2465`. No auth (by design — snapshots are public), but also no rate
limit and no body limit, and each call for an unknown CID walks every
snapshot sidecar and gunzips tarballs newest-first
(`extractEnvelopeFromSnapshots`, `main.go:2514`). Production holds 24
snapshot files, 876 MB. A loop of random valid-looking CIDs is sustained
CPU + disk read for the price of a curl.

- [ ] Build a `cid → snapshot` index once at startup and on
      `snapshot-persist` (the sidecars already list contents). Lookup and
      restore become O(1) map hits; a miss costs nothing.
- [ ] Put it behind the existing limiter; `MaxBytesReader` on the body.
- [ ] Same index serves `/api/archive-lookup`, which re-reads every sidecar
      per request today (`main.go:2673`).

### 1.2 One middleware instead of per-handler limits

Body limits are re-implemented handler by handler (`MaxBytesReader` ×4,
`LimitReader` ×5) and some handlers have none. `RateLimitPUT` covers five
routes; the CPU-bound public ones — `/share-card/`, `/composition-card/`,
`/qr` — have no limit at all.

- [ ] A default `http.MaxBytesHandler` on the mux; handlers opt *up*.
- [ ] Rate-limit classes (`write`, `render`, `read`) applied at registration,
      so a new route is limited unless it says otherwise.
- [ ] The limiter's GC only runs on the new-bucket branch once the map
      exceeds 512 entries (`internal/share/seal.go:341`); sweep on a ticker.

### 1.3 Deploy handler

`internal/deploy/deploy.go` gets the webhook path right (HMAC with
`hmac.Equal`, `git verify-commit` before merge, fails closed). The manual
path does not:

- [ ] `checkDeployAuth` (`:88`) compares the token with `==`. Use
      `subtle.ConstantTimeCompare`, as the rebuild-secret path already does.
- [ ] Stop accepting the secret as `?token=` — query strings land in access
      logs. Header only.
- [ ] Each valid push spawns an unguarded goroutine (`:132`); two pushes in
      quick succession run two `make build`s in one tree. Add a mutex and
      coalesce.
- [ ] `scheduleRestart` calls `os.Exit(0)` after 2 s with no drain. Use
      `http.Server.Shutdown`, and refuse to restart mid-render.
- [ ] The package has no tests. HMAC accept/reject, ref gating and the auth
      check are all pure functions — cover them.

### 1.4 SQLite opened with no pragmas

`internal/index/index.go:27` is a bare `sql.Open("sqlite", path)`: rollback
journal, no `busy_timeout`, default pool. Four writers share it (audio PUT
tagging, rebuild-mark, composition-mark, startup backfill) — the textbook
`SQLITE_BUSY` setup, currently saved only by low traffic.

- [ ] `_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)` and
      `SetMaxOpenConns(1)` for the writer.
- [ ] Replace the five error-swallowing `ALTER TABLE`s (`:39-46`) with a
      `PRAGMA user_version` ladder, so a migration that really failed is
      distinguishable from "column already exists".
- [ ] Once WAL is on, note in CLAUDE.md that backups use `.backup`, never `cp`.

### 1.5 Security headers and escaping

The live site sends no `Content-Security-Policy`, `X-Content-Type-Options`,
`Referrer-Policy` or HSTS. Separately, `innerHTML` is used in 14 files and
share envelopes carry user-supplied strings (`name`) that reach feed cards
and the welcome card.

- [ ] Audit every `innerHTML` site that interpolates envelope data; route
      them through one `escapeHtml` helper. `feed.html` first — it renders
      other people's payloads.
- [ ] Then ship a CSP (`script-src 'self' unpkg.com googletagmanager.com`).
      In that order: the CSP is the backstop, the escaping is the fix.
- [ ] Rebuild-secret scope: one shared secret gates read (snapshot), write
      (audio overwrite) and destroy (`archive-delete`). Split destroy onto its
      own secret at minimum.

---

## Phase 2 — Make the parity claim true

CLAUDE.md says `arrange.js` has "byte-identical Go parity". Nothing checks
it. Of ~15 duplicated Go↔JS surfaces, **two** have a cross-language guard:

| Surface | Guard |
|---|---|
| `pflow/adapter.go` ↔ `lib/pflow.js` | ✅ live diff, `//tools/parity:model_cid_parity_test` |
| `share/canonical.go` ↔ `share/codec.js` | ✅ `TestCanonicalJSONRoundTrip` |
| `theme.go` ↔ `theme.js` | ⚠️ one pinned vector: techno, seed 42 |
| `composer`, `arrange`, `structure`, `theory`, `variety`, `markov`, `euclidean`, `threering`, `groove`, `riffs`, `shuffle`, `countermelody` | ❌ none |

`arrange.js` is the one that matters most: production has no `/api/arrange`,
so every `structure: extended` share is reconstituted by 899 lines of JS that
have never been diffed against the 1,066 lines of Go they port. The
ecosystem has already paid for this exact failure once — a vendored module
sat 57 lines behind for months and "nothing failed, because nothing
compared".

- [ ] **Parity matrix.** Extend `tools/parity` from one model fixture to the
      whole pipeline: for each of 19 genres × N seeds × each `structure`
      value, both languages run compose → arrange → canonical JSON → sha256,
      and the harness diffs the hashes. It is the existing live-diff design
      with a bigger input table, not a new mechanism.
- [ ] Include a `counterMelody` case — the only directive that synthesizes a
      music net, guarded Go-side only.
- [ ] `groove.go` is 135 lines, `groove.js` 67. Expect the matrix to fail
      here first; find out whether that is drift or legitimate asymmetry.
- [ ] `energy.go`, `generator.go` and `stingers.go` have no JS counterpart.
      Confirm they are authoring-only; if they touch composed output, client
      reconstitution cannot match.
- [ ] Wire it into `make test` and `bazel test //...` so CI enforces it.
- [ ] `lib/pflow.js` is a hand port tracking go-pflow, which has moved
      v0.22 → v0.31 with one fixture standing guard. Record the go-pflow
      version it was last reviewed against in its header, and fail the parity
      target when `go.mod` moves past it.

When the matrix is green, the CLAUDE.md sentence is true. Until then, soften
it.

---

## Phase 3 — Long sessions and offline

### 3.1 Teardown

`disconnectedCallback` (`petri-note.js:362`) terminates the worker and
closes the socket. It leaves behind the two `document`-level key listeners
(`:959`, `:963`), three timers (`_voiceRecycleTimer`, `_apcTimer`,
`_deviceTimer`), and the entire Tone graph — `toneEngine.dispose()` exists
(`tone-engine.js:2630`) and has no caller outside the test hooks.

- [ ] Full teardown in `disconnectedCallback`. Verify with the existing CDP
      heap-sampling harness: mount/unmount ×50, node count flat.

### 3.2 Is the voice-recycle workaround still needed?

`recycleVoices` on an interval (`lib/backend/index.js:96`) was the fix for a
**Tone v14** PolySynth oscillator leak. Tone has since gone to 15.1.22.

- [ ] Re-run the 60-minute profile with recycling disabled. If v15 fixed the
      leak, delete the workaround; if not, note that in the comment so nobody
      repeats the experiment.

### 3.3 The PWA does not work offline

`sw.js` pre-caches 7 files. The app is ~60 modules plus `tone-engine.js`,
none of them listed, and Tone.js is cross-origin and skipped — so a cold
offline load cannot boot, despite the manifest advertising an installable
app. Meanwhile the fetch handler caches *every* same-origin response with no
status check and no cap: error pages get cached, and every `.webm` a listener
streams is stored forever.

- [ ] Generate the precache list at build time from `git ls-files public/`,
      versioned by the build hash — not a hand-kept array.
- [ ] Vendor Tone.js into `public/vendor/` (as `qrcode.js` already is). This
      also removes a third-party CDN from the critical path of a site whose
      premise is reproducibility.
- [ ] Cache only `r.ok` responses; never cache `/audio/*` or `/api/*`.
- [ ] Then the self-contained share URL (`?cid=…&z=…`) really does play
      offline, which is what CLAUDE.md already says of it.

### 3.4 Storage and network robustness

- [ ] ~20 unguarded `localStorage` calls (`macros/runtime.js`, `ui/dialogs.js`,
      `ui/mixer.js`, `ui/build.js`, `petri-note.js:1739`) throw in private
      mode and on quota. One `lib/storage.js` with try/catch, a key registry
      and a version field; migrate the 15 `pn-*` keys onto it.
- [ ] `feed.html:1579` writes playlist state on every `timeupdate` (~4 Hz).
      Throttle to once per 5 s and on `pause`/`pagehide`.
- [ ] A shared `fetchJSON` (checks `res.ok`, `AbortSignal.timeout`, one error
      shape). `compose/main.js:28,374,394` and `share/insert-render.js:57`
      currently check nothing.

---

## Phase 4 — Accessibility and mobile

The weakest part of the frontend, and the cheapest to improve because it is
mostly attributes.

- `tabindex` appears **zero** times in `public/`. `role=` appears three
  times. None of the eight overlays is `role="dialog"`, focus-trapped, or
  restores focus on close.
- `build.js` — 1,679 lines constructing the whole studio — has 17 `aria-*`
  attributes.
- Panels and Fire pads are reachable by single-letter shortcut but not by
  Tab.
- 5 media queries in 3,966 lines of CSS. Hover-scroll, the primary way to
  nudge a control, has no touch equivalent.

- [ ] One `openDialog(el)` helper: `role="dialog"`, `aria-modal`, focus trap,
      Escape, focus restore. It replaces nine separate Escape handlers.
- [ ] Real `<button>`s for panel toggles and pads; `aria-pressed` for state.
- [ ] Sliders that are not native inputs: `role="slider"` plus
      `aria-valuenow/min/max`.
- [ ] `prefers-reduced-motion` for the canvas glow and the Stage visualiser.
- [ ] A touch equivalent for hover-scroll (drag on the value, or steppers).
- [ ] A phone-width pass on the mixer.
- [ ] Add an accessibility audit of `/` and `/feed` to `make test-e2e`, with
      a floor score, so this does not regress silently.

---

## Phase 5 — Structure

Do these when next working in the area, not as a campaign. CLAUDE.md's rule
applies: extraction passes change no behaviour and round-trip a share to
prove it.

- [ ] **`main.go` is 3,454 lines with no tests**, holding all ~35 production
      handlers — feed, RSS, audio, snapshot, archive, rebuild, composition.
      `internal/routes/` exists but only ever received the authoring routes.
      Move one handler family at a time into `internal/routes/<family>.go`,
      adding an `httptest` table as each lands. Start with archive/snapshot:
      Phase 1.1 rewrites it anyway.
- [ ] **`feed.html` is 3,231 lines of inline HTML, CSS and JS** — the only
      page that never got the `lib/` extraction the studio did. Extract to
      `lib/feed/*`; `ROADMAP-composition.md` already refers to a
      `lib/feed/cards.js` that does not exist.
- [ ] Two majors of one library in `go.mod`: `jsonschema/v5` and `/v6`.
      Retire v5.
- [ ] `internal/ws` (755 lines) and `internal/midiout` (481) have no tests.
      Low urgency — neither runs in production — but `ws` has an uncapped
      client map to fix before it ever does.
- [ ] CI is Bazel-only, and Bazel builds with the `purego` tag, so the asm
      crypto path that `make build` ships is never tested. Add a plain
      `go test ./...` job. Add `gofmt -l` while there.

---

## Phase 6 — Features

Deliberately last. None of this is worth more than Phases 0–2.

**From `TODO.md`, still open and still wanted:**

- [ ] `sectionIndex` on `feelCurve` / `macroCurve` entries, so a repeated
      `drop` can be targeted by occurrence.
- [ ] `velocityShape: "rise"` per-variant envelopes; a `silence` directive.
- [ ] Beats-tab Fire pads for stinger tracks with custom net IDs.
      `build.js:431` still filters on the catalog's `hit1..hit4`; key off
      `track.group === 'stinger'` instead.
- [ ] Per-channel mixer-volume compensation on browser recordings — **only**
      if the Phase 0.2 metrics show browser uploads are common. Today it is
      1 of 73.

**From `ROADMAP-composition.md`:**

- [ ] PR-2.1 `srcOffset` on composition tracks.
- [ ] Answer its open question on render-queue priority. The queue is FIFO
      with a 30-minute admission cap (`audiorender/renderer.go:199`); a
      listener's ⟳ should outrank a bulk seed.
- [ ] PR-7.5 live composition mode stays deferred.

**Arrangement quality** — from listening, not from the code:

- [ ] Arranged tracks run 12–15 sections, which reads as restless. Lengthen
      per-section bar counts *before* adding section vocabulary; real songs
      dwell.
- [ ] Extend cohesion v2 (harmonic motion, phrase-grammar motifs, walking
      and bossa bass) to further genres. It is validated — extend it, don't
      rework it, and keep the Go↔JS motif fixture in lockstep (Phase 2 makes
      that automatic).

**Parked:** the competitive rendering market (`TODO.md`). Its stated
pre-work — per-renderer identity in place of the binary
`browser`/`renderfarm` tag — is worth doing on its own once a second renderer
exists. Not before.

---

## Housekeeping

Documentation that has drifted from the code, found during the audit:

- [ ] `TODO.md` § *Feel mapping tuning* describes a `FEEL_MAP` in
      `lib/feel/axes.js` that no longer exists — the file was rewritten to a
      two-axis `CORNERS` model. Delete the section, and the stale comment at
      `lib/ui/controllers.js:6`.
- [ ] `TODO.md` § *CLI producer* and § *Remote conductor* are declared out of
      scope for this repo. Move them out or drop them.
- [ ] CLAUDE.md: go-pflow "v0.22.0" (pinned v0.27.0, v0.31.0 pending);
      "Requires Go 1.22+" (`go.mod` says 1.26); `petri-note.js` "~1.4k lines"
      twice (it is 1,764).
- [ ] `ROADMAP-composition.md` PR-6 cites `internal/routes/feed.go` and
      `public/lib/feed/cards.js`. Neither exists; the feed is
      `main.go:1812` and inline in `feed.html`.
- [ ] Snapshot retention: 24 files, 876 MB, the oldest a 286 MB
      pre-purge tarball from April. Decide a policy (keep labelled
      milestones, prune the rest) and confirm an off-box copy first.
- [ ] CI's nested `working-directory: beats-bitwrap-io` checkout is, by its
      own comment, vestigial since the go-pflow sibling checkout went away.

## Sequencing

```
Phase 0  ──►  Phase 1.1, 1.4  ──►  Phase 2  ──►  everything else, opportunistically
(days)        (the two that can        (the one that
               take the box down)       protects every
                                        future change)
```

Phase 0 is an afternoon and fixes things listeners can see. 1.1 and 1.4 are
the two items that could cause an outage rather than a blemish. Phase 2 is
the highest-leverage engineering item in the document: once the matrix
exists, every later generator change — all of Phase 6 — is checked for free.

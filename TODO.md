# TODO

## Feel mapping review (FEEL_MAP in public/petri-note.js)

After live play-testing, revisit:

- **Chop > 85 auto-arms Beat Repeat** — not just biases the pool. Would give the top 15% of Chop a distinct gesture instead of stacking the same macros faster.
- **Groove > 70 turns on modal-interchange** — adds harmonic color to match the rhythmic shift.
- **Energy × Space cross-wire** — small `master-pitch` down at high Space + low Energy for a dubby feel, without adding a fifth axis.
- **Stall curve** — compress the active mapping range to 20–100 so a nudge off center is immediately audible (currently 0–50 is a slow ramp into meaningful effect).
- **Reset-to-50 button inside the Feel modal** — snap-center without reverting to last-saved state.
- **Verify damp curve** on Space × Energy (currently `30 + (1 - e/100) * norm * 50`) — may be too subtle; try widening the multiplier.
- Check that trait overrides set by Groove (`swing`, `humanize`) are actually consumed by the generator — these may need a schema pass before they ship.

Reassessment trigger: after 3-4 live sessions, note which axis feels flat or one-dimensional and re-tune just that entry.

---

## Real JSON-LD schema for `BeatsShare` (host at beats.bitwrap.io)

The share-URL payload currently declares:

```json
{
  "@context": "https://beats.bitwrap.io/schema/petri-note.schema.json",
  "@type": "BeatsShare",
  ...
}
```

…but **neither is real**. The `@context` URL resolves to a JSON-Schema (Draft-07) describing the *project* shape, not a JSON-LD context, and `BeatsShare` is not defined anywhere. Host a proper schema for it — both a JSON-LD `@context` AND a JSON-Schema (envelope validator).

### Goals

1. Serve a canonical JSON-LD context + JSON-Schema at `https://beats.bitwrap.io/schema/...`.
2. Replace the hand-rolled `validateSharePayload()` in `seal.go` with schema-driven validation (single source of truth for client + server + docs).
3. Make the `@context` URL dereferenceable — future tooling (`jsonld.js`, URDNA2015, RDF converters) should Just Work.
4. Content negotiation following the `pflow-xyz` pattern (JSON-LD for machines, HTML for browsers) — see `~/Workspace/pflow-xyz` and root `CLAUDE.md` for the nginx `/schema` proxy requirement.

### Concrete work

**1. Design the schema files** — two documents, same directory:

- `public/schema/beats-share.context.jsonld` — the JSON-LD `@context`. Maps every payload term to an IRI under `https://beats.bitwrap.io/schema/vocab#`:
  - `BeatsShare` → `vocab:BeatsShare`
  - `genre`, `seed`, `tempo`, `swing`, `humanize`, `structure`, `traits`, `tracks`, `fx`, `feel`, `autoDj`, `macrosDisabled`, `initialMutes` → each to `vocab:<term>`
  - Numeric terms get `"@type": "xsd:integer"` where appropriate so canonicalization round-trips cleanly.
- `public/schema/beats-share.schema.json` — JSON-Schema (Draft-2020-12). Top-level `BeatsShare` envelope with required `@type`, `v`, `genre`, `seed`; bounded ranges for `tempo` (20–300), `swing`/`humanize` (0–100); `$defs` for `TrackOverride`, `FxState`, `FeelState`, `AutoDjState`; `additionalProperties: false` at top level so unknown fields are rejected (matches current server behavior).

Both files reference the same vocab so they stay in sync.

**2. Host them with content negotiation** — add a handler in `main.go` for `/schema/beats-share`:

- `Accept: application/ld+json` → serve `beats-share.context.jsonld`
- `Accept: application/schema+json` or `application/json` → serve `beats-share.schema.json`
- `Accept: text/html` → serve a small rendered HTML term glossary

Same pattern pflow-xyz uses. When deploying, add to nginx:

```
location = /schema/beats-share { proxy_pass http://127.0.0.1:8089; }
```

Direct static paths (`/schema/beats-share.context.jsonld`, `/schema/beats-share.schema.json`) can be served from `public/schema/` via the existing file server.

**3. Update client payload** — in `public/petri-note.js` `_buildSharePayload()`:

```js
'@context': 'https://beats.bitwrap.io/schema/beats-share.context.jsonld',
'@type': 'BeatsShare',
```

Keep `v: 1`. Changing `@context` does change the CID (different bytes → different hash), but that's fine — new address space for the v1 schema URL. Old `?cid=...` links in the wild still resolve from the store because the server doesn't care about the context URL, only the CID<->bytes binding.

**4. Replace `validateSharePayload()` with JSON-Schema validation**:

- Pick a Go library — `github.com/santhosh-tekuri/jsonschema/v5` is the cleanest option (pure Go, Draft 2020-12, small).
- Embed `beats-share.schema.json` via `//go:embed`, compile once at startup, validate each PUT.
- Delete `validateSharePayload()` and `allowedSharePayloadKeys`.
- Update `seal_test.go` so error-message substrings match what the library emits.

**5. Keep `public/schema/petri-note.schema.json` as-is** — it describes the *project* shape (nets/places/transitions) and is referenced from `track`-level sub-schemas inside `beats-share.schema.json`. Don't conflate — a share payload is an envelope *around* a project recipe.

### Acceptance

- `curl -H 'Accept: application/ld+json' https://beats.bitwrap.io/schema/beats-share` returns the JSON-LD context.
- `curl -H 'Accept: application/schema+json' https://beats.bitwrap.io/schema/beats-share` returns the JSON-Schema.
- A `BeatsShare` payload canonicalizes via URDNA2015 (`jsonld.js` + hosted context) without errors.
- `go test ./...` passes against the schema-driven validator with the same cases currently in `seal_test.go`.
- Share button still produces a short `?cid=z…` URL; round-trip still reproduces the track in a fresh tab.

### Out of scope

- RDF canonicalization (URDNA2015) server-side — we still sort-keys-canonicalize for CID; switching would invalidate every existing CID. Revisit only if we ever need CID parity with a Go-side URDNA2015 backend.
- Signing/attestation of share payloads.
- Legacy `?p=` / `?g=&s=&t=` URLs stay supported as-is.

### Relevant files

- `seal.go` — `validateSharePayload()` to replace
- `seal_test.go` — test cases to adapt
- `main.go` — add `/schema/beats-share` handler
- `public/petri-note.js` — `_buildSharePayload()` `@context` URL
- `public/schema/petri-note.schema.json` — existing project schema, referenced by the new share schema
- `~/Workspace/pflow-xyz` and `~/Workspace/CLAUDE.md` (deployment section) — reference implementation for `/schema` content negotiation and nginx proxy

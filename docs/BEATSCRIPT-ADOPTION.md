# beats.bitwrap.io adopts BeatScript's descriptor

**Decision (Matt, 2026-11-23):** BeatScript (beatscript.app, github.com/stackdump/beatscript) is the **authority** for the
language and its vocabulary. beats.bitwrap.io is an **adopter**: it points at the authority's terms, pins the release it
was built against, fails its own tests when it drifts from the pin, and mints no BeatScript term of its own. Where beats
has a concept the authority lacks, it is listed under [Proposals](#upstream-proposals), not invented here.

beats is also a **test bed for a third party adopting BeatScript**, and it will be phased out, so this is deliberately
thin: no UI work, one small Go package, one lock, one script. The part worth keeping is [Adopter findings](#adopter-findings):
everything an outside implementer would trip on, each with a concrete fix for BeatScript.

## What beats adopts

| beats says | with | where |
|---|---|---|
| a track's genre (`/?cid=` pages, the schema.org `MusicRecording` projection) | the authority's genre IRI, `https://beatscript.app/ontology/genre/<slug>`, beside the plain word | `internal/share/share_page.go` `genreProjection` |
| a set (a `BeatsComposition`, tracks in order) | `GET /set/<cid>.jsonld`: a schema.org `MusicComposition` in the BeatScript context (`https://beatscript.app/context/beatscript-v1.jsonld`) that is `isBasedOn` its tracks, each `{name, resolves: <CID>, derivation}`, the shape the authority's own program JSON-LD uses (`djlive/src/progld.rs`) | `set_description.go`, `internal/beatscript` `SetNode` |
| what beats adopts and what it proposes | `GET /schema/beatscript` (JSON-LD) | `internal/beatscript/adoption.jsonld` |
| a playlist | nothing yet: the authority's playlist is an account's list over `/api/playlists` with no linked-data term. Proposal P2 | |
| the radio (Auto-DJ, the feed) | nothing yet: the authority's radio is the `station` program (position N is always the same track); its up-next is the MCP `queue` tool, a tab's state. Proposal P3 | |

The track page's **payload** (the canonical share envelope) and the composition envelope are untouched. Their CIDs hash
those bytes, and `scripts/cid-freeze.sh` still passes: the genre IRI is in the projection node, which is a view, and the
set description is a second URL over the same stored envelope. No existing CID or URL moved.

What the authority's grammar says about the three (for the next implementer, from `crates/djlive/grammar.ebnf`,
`docs/BEATSCRIPT.md` "Sets" and "Radio: stations", `docs/beatscript/radio.md`):

- **set**: `set { play NAME|CID [until WHEN] · play gen@V GENRE seed=N · next seed=+N|~ · mix N bars with TRANSITION[, tempo A -> B] }`
  is itself a program (its own CID) whose canonical text pins each track by CID.
- **station**: `station { from gen@V GENRE seed=N · next seed=+N|~ · forms NAME... }` is an endless program of programs:
  position N is always the same track (the same text, the same CID), the walk is the seed rule.
- **playlist**: an account's list, changed in place (`/api/playlists*`), explicitly *no source* for a program ("A playlist
  is no source; a set, pinned by CID, is" — `BEATSCRIPT.md`).
- **queue**: the MCP `queue` tool, an "up next" list on one browser tab.
- **record**: the MCP `record` tool sets up a demo recording of a program (full-screen code, follow-scroll) and `record`
  is also a control-registry verb. There is no "record program" kind (see finding F10).

## The pin, and the check that fails on drift

```
beatscript-authority.lock          the pin: release, source commit, sha256 of the four authority files, every term beats names
internal/beatscript/used-terms.txt  what beats refers to (IRIs, context keys): the only list; names, not definitions
internal/beatscript/authority.go    the constants the code carries (version, namespace, context URL, grammar URL)
scripts/beatscript-authority.sh     check | verify [DIR] | status | sync [DIR]
```

Nothing of the authority is copied: the lock holds hashes, names and one word of kind per term. Three levels of check,
each stronger and slower (the CDN lock pattern, `pflow-js.lock`):

1. `check` (offline, `make check-beatscript-authority`, part of `make test`): the constants equal the lock; every name in
   `used-terms.txt` is in the lock and the lock has nothing `used-terms.txt` does not name; every genre beats can compose
   has an authority IRI (a new beats genre is a decision, not a silent gap); `SetNode` emits only pinned context terms.
2. `verify [DIR]` (a beatscript checkout): the four files' bytes, every term and the commit match the lock.
3. `status` (network): the lock against what beatscript.app serves. The context is immutable and must match; the ontology
   and grammar may lag, and the script says so, failing only if a term beats refers to is not served.

`sync [DIR]` re-pins to a checkout's **committed** files (it refuses uncommitted changes) and re-resolves every name; it
refuses if the authority no longer has one. Re-pinning is a deliberate act: say why in the commit.

Pinned now: ontology **0.4.0** at beatscript `e246780`. **beatscript.app serves 0.3.0** and an older grammar (finding F2);
every term beats refers to is served there too (`status` says so).

## Upstream proposals

Concepts beats has, or needs to describe, that BeatScript has no term for. beats will adopt them when they exist; it does not
fork them.

| | proposal | beats' use |
|---|---|---|
| **P1** | `bw:Set` (subclass of `bw:Program`, since a set *is* a program with a CID), with `bw:hasTrack` as an ordered list of CIDs, `bw:mix` (transition, bars, tempo ramp) and a context entry `Set` | `GET /set/<cid>.jsonld` is typed `MusicComposition` only because there is nothing better |
| **P2** | `bw:Playlist` (an ordered, mutable list of CIDs; `schema:MusicPlaylist` as a superclass), with its `/api/playlists` JSON schema published and a JSON-LD form of it | beats' feed playlist is browser state; it could be exported as one |
| **P3** | `bw:Station` (a program holding a `station` block; `bw:position`, `bw:seedStep`, `bw:forms`) and `bw:Queue` as an up-next list, distinct from the existing `ns:Queue` (a DJ concept inherited from bitwrap) | beats' Auto-DJ is a seeded walk; a station program would make it addressable |
| **P4** | a closed, documented set of `derivation` values (today a free string in `progld.rs`: `renamed`, `expanded`, borrow and generator-call kinds) plus `set-track` and `playlist-item` | `SetNode` writes `set-track` |
| **P5** | a way to say "this CID is not a BeatScript program": `resolves` today means a CID the BeatScript store resolves; a beats share CID (a different hashed document) cannot be told apart. Either `resolvesAt` (the URL that dereferences it) or a `cidType` | `SetNode` uses `resolves` with a beats CID and the beats URL as `@id` |
| **P6** | beats' own *concepts* with no BeatScript counterpart: **Petri-net envelope** (a track is a bundle of nets, not text: `BeatsShare.tracks/mix/fx/feel`), **auto-DJ** (the macro scheduler), **master** (`lufs`, formats of a rendered composition). Propose only if BeatScript wants nets as a track form; otherwise they stay beats' own `vocab#` terms | `https://beats.bitwrap.io/schema/vocab#` stays as is |

## Adopter findings

Every friction point hit while adopting, with the fix proposed for BeatScript. Roughly in the order met.

**F1. There is no index of the descriptor.** The language descriptor is four files in three places in the repository
(`crates/beatscript-serve/ontology/release/{manifest.json,ns.nt}`, `docs/beatscript-context-v1.jsonld` (a second identical
copy under `src/public/`), `crates/djlive/grammar.ebnf`), served at four unrelated URLs. Nothing says "these four are the
descriptor, at this release". Only reading `public.rs` and `ontology/README.md` showed which. *Fix:* publish
`https://beatscript.app/descriptor.json`: ontology `{version, version_iri, sha256}`, context `{url, sha256}`, grammar
`{url, version, sha256}`, `source_commit`, docs. Generate it in the release build; link it from `llms.txt`.

**F2. The deployed site lags `main`, and the live commit is unknowable.** beatscript.app serves ontology 0.3.0 and a grammar
three commits behind; the repository's `main` is 0.4.0 (and its newest commit is a revert). An adopter pinning "the
authority" cannot tell whether to pin git or live. beats pins git and reports the lag. *Fix:* put `source_commit` and the
build time in `descriptor.json` and in an `X-Beatscript-Commit` header; have `deploy/live-checks.sh` fail when the live
descriptor is not `main`'s, or say which is the authority (this adoption assumes git).

**F3. The grammar has no version.** `grammar.ebnf` is served mutable at `/grammar.ebnf`; the ontology has a `versionIRI`,
the context is versioned by file name, the language has `#! beatscript 2`, but the *grammar* of that language has nothing
to pin except its hash. *Fix:* a version comment in the file's first line, an immutable `/grammar/<version>.ebnf`, and the
ontology release recording which grammar version it was generated from.

**F4. Two namespaces for one vocabulary, and one is not defined anywhere.** The context's `@vocab` is
`https://beatscript.app/schema#` (`bs:`), while the ontology is `https://beatscript.app/ontology/ns#` (`bw:`). Every
context term an adopter uses (`resolves`, `derivation`, `tempo`, `genre`) maps to `bs:…`, and the ontology contains **zero**
`schema#` triples (counted in `ns.nt`): the terms a program is *described* with cannot be looked up in the SPARQL
endpoint, the ontology MCP, or `ns.ttl`. The `bw:` prefix is declared in the context and no term uses it. *Fix:* define the
`bs:` terms in the ontology (class and property, with comments), or serve `/schema#` as RDF; and have the context map
`genre`/`scale` straight to `bw:` terms or say why not.

**F5. No class for a set, a station, a playlist or a queue.** The ontology has `concept/grammar-set` and
`concept/grammar-station`, which are SKOS concepts defined as "the set production of BeatScript's grammar": a *piece of the
grammar*, not a kind of thing a document can be typed as. `ns:Queue` exists but is a bitwrap-era DJ concept, not the MCP
`queue` tool. The context has `Program` and `Section` only. So "describe sets, playlists and the radio with BeatScript's
terms" has nothing to say for playlists and radio and only a workaround for sets. *Fix:* P1–P3 above, with context entries.

**F6. `derivation` is free text.** It appears in `isBasedOn` items (`renamed`, `expanded`, …) with no enumeration in the
context, docs/SCHEMA.md or the ontology; the values are knowable only from `refs.rs` and `progld.rs`. *Fix:* P4.

**F7. No rule for an adopter's own `@id`s.** A format-1 block's `@id` is a bare CID, format 2's is
`https://beatscript.app/p/<cid>`. Nothing says what a third party names *its own* resource (beats uses its own URL), nor how
to link a beats object to the BeatScript program it came from (`sameAs`? `isBasedOn`? `resolves`?). *Fix:* a short
"Describing your own works" section in docs/SCHEMA.md with the rule and one example.

**F8. `/context/v1.jsonld` is the wrong context.** It is the *legacy* `djrust:` context (frozen for BeatScript 1 programs),
and it is the first URL one guesses; the current one is `/context/beatscript-v1.jsonld`, found only in `public.rs` and
`progld.rs`. `/context` and `/context.jsonld` serve the current one. *Fix:* name the legacy one `/context/legacy-v1.jsonld`
(keep `/context/v1.jsonld` byte-for-byte as is, it is immutable) and put the current URL in `llms.txt`'s Schema line and in
`descriptor.json`.

**F9. The context's `genre` cannot take a word.** `"genre": {"@id": "bs:genre", "@type": "@id"}` expands the string
`techno` to a *relative IRI*. beats keeps genres as words, so it cannot put its genre under the BeatScript context: it keeps
schema.org's `genre` (Text or URL) and writes the IRI beside the word. *Fix:* document that `genre` takes an ontology IRI
only, and add `genreName` (a string), or accept both.

**F10. "set program / record program" has no single definition.** A set is a program (`set { }`). `record` is an MCP tool
(a demo-recording setup) and a control verb; there is no "record program". An adopter looking for how BeatScript describes
"recording" finds a video helper. *Fix:* a glossary on `/docs` listing each noun (program, set, station, playlist, queue,
record) with *what it is*, *whether it has a CID*, and *where it is defined*.

**F11. The playlist contract lives in an adopter's unmerged branch.** `docs/RUST-SERVER.md` in beatscript says playlists
are specified in beats-bitwrap-io's branch `docs/rust-server-playlists` (§10). The authority's playlist descriptor is
therefore in the adopter's repo, on a branch. *Fix:* move §10 into beatscript as `docs/PLAYLISTS.md`, publish it at
`/docs/playlists.md`, and publish the request/response JSON Schema.

**F12. No machine-readable list of terms.** To check "does term X exist at release V" an adopter downloads 2 MB of
N-Triples (`ns.nt`) and greps; the SPARQL endpoint and MCP exist but are not pinnable. *Fix:* a small
`/ontology/release/terms.json` (`iri`, `kind`, `since`, `deprecated`) in the release, so a lock can pin and check names
without parsing RDF. (beats' `scripts/beatscript_authority.py` parses N-Triples line by line for this.)

**F13. A deprecation/`since` story is missing.** Terms carry `ns:status "stable"` for bitwrap-derived ones but nothing says
when a term appeared, so "all terms beats uses exist at 0.3.0 *and* 0.4.0" had to be proved by hash. *Fix:* `ns:since`
on every term, set by the release build.

**F14. beats' CIDs are not BeatScript CIDs.** A beats share CID is the hash of a share envelope, not of
`{format, text, type:"beatscript"}`; `resolves` and `/p/<cid>` mean the latter. Nothing in the vocabulary lets an adopter
say "this CID names a work in *my* store". *Fix:* P5.

**F15. Descriptor tests that an adopter can reuse do not exist.** beatscript has `ontology::tests::fork_integrity` and a
vocabulary drift test for itself; an adopter wanting "my output only uses pinned terms" writes it from scratch (as
`internal/beatscript/authority_test.go` does). *Fix:* ship a conformance helper: `tools/ontology/check-terms.py` taking a
JSON-LD file and a release and printing the terms that are not defined, so an adopter's CI is one line.

## Extending this

- A new beats genre: `TestEveryBeatsGenreIsKnownToTheAuthority` names it. Either the authority has it (add `iri …/genre/<slug>`
  to `used-terms.txt`, `scripts/beatscript-authority.sh sync`) or it is proposed upstream and stays a plain word until then.
- A new term beats refers to: add it to `used-terms.txt` first, then `sync`; the sync refuses a name the authority lacks.
- A new authority release: `git -C ../beatscript pull`, `scripts/beatscript-authority.sh sync`, `make test`, commit with the reason.

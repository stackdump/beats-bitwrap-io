# feed-corpus

52 share-v1 envelopes copied byte for byte from the public envelope snapshot
`GET https://beats.bitwrap.io/api/snapshot` (envelopes only, no secret), taken 2026-11-14.
Each file is named `<cid>.json`, and its bytes are the store's canonical bytes.

The selection rule:
- every envelope in the snapshot that has no raw `nets`, which is 34 files. These are
  genre/seed shares and studio shares with `fx`, `tracks`, `feel`, `autoDj`,
  `macrosDisabled`, `traits` and `cohesion` overrides;
- one raw-`nets` envelope per genre, picked as the lowest CID. That is 18 files, mostly
  `structure: extended` with an `arrangeSeed`.

They are public data. An envelope that is later archive-deleted from the live store keeps
its copy here.

Two things use these files:
- `scripts/cid-freeze.sh` recomputes each CID with `public/lib/share/codec.js` and checks it
  equals the filename.
- `scripts/djrust-golden.mjs` lowers each envelope to a project (`lowerEnvelope`) and
  freezes what djwasm 0.2.0 renders from it.

Do not edit, reformat or add files here by hand. A changed byte changes the CID, and
cid-freeze then fails, by design.

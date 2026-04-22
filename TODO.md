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

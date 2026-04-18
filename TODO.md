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

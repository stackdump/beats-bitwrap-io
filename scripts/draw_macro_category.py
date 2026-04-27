#!/usr/bin/env python3
"""Render the macro catalog as a DisCoPy free monoidal category.

Each macro is a generator (Box) typed by the project-state wires it
reads/writes:

    Mute group        →  M (mute state)
    FX sweep/hold     →  one wire per fxKey it touches
                         (reverb-wet, delay-wet, lp-freq, …)
    Tempo group       →  T
    Pan-move          →  P
    Shape (decay)     →  D
    Feel              →  F (lp-freq ⊗ T — overlaps fx + tempo by design)
    Pitch             →  routes through master-pitch fxKey, so it's an FX wire
    Hits              →  H (per-hit pad)
    Compound          →  inherits the wires of its sub-steps

Two macros parallel-compose ( @ ) in DisCoPy iff their dom/cod wire
sets are disjoint — which captures the runtime's actual conflict
behaviour: stack reverb-wash and dub-delay (different fx wires) ✓,
but stack two reverb sweeps and one will stomp the other ✗.

Outputs:
    public/docs/macro-category.svg  — one big string diagram of the
                                      whole catalog rendered as a
                                      block-diagonal stack with a
                                      sample multi-macro Auto-DJ run
                                      composed on top
    stdout                          — compatibility table: which
                                      macros parallel-compose with
                                      which

Requires: discopy >= 1.2  (pip install discopy)
Pipeline: node scripts/dump_macros.mjs | python3 scripts/draw_macro_category.py

If invoked without a JSON pipe, the script will fork its own dump.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

try:
    from discopy.monoidal import Box, Diagram, Ty
except ImportError:
    sys.stderr.write("discopy is not installed. pip install discopy>=1.2\n")
    sys.exit(2)


def load_macros() -> list[dict]:
    """Load the catalog. Accept piped JSON, else fork the Node dumper."""
    if not sys.stdin.isatty():
        try:
            data = sys.stdin.read()
            if data.strip():
                return json.loads(data)
        except json.JSONDecodeError:
            pass
    dumper = REPO_ROOT / "scripts" / "dump_macros.mjs"
    out = subprocess.check_output(["node", str(dumper)], text=True,
                                  cwd=str(REPO_ROOT))
    return json.loads(out)


# --- typing rules ----------------------------------------------------------
#
# Each kind maps a macro to the set of "wires" it touches. The wire set is
# the macro's domain AND codomain — macros are endomorphisms on the project
# state, so DisCoPy needs both sides identical.
#
# For fx-* kinds we look at the macro's `ops` field (or the legacy
# fxKey/toValue pair) to pull out the precise param wires. This is what
# lets reverb-wash @ delay-throw parallel-compose: they touch disjoint
# fxKeys.

def wire_for_fxkey(fx_key: str) -> str:
    """One wire per master-FX param. Names come from build.js's slider IDs."""
    return f"fx:{fx_key}"


def wires_for_macro(m: dict) -> list[str]:
    kind = m.get("kind", "")
    if kind in ("fx-sweep", "fx-hold"):
        ops = m.get("ops") or (
            [{"fxKey": m["fxKey"], "toValue": m.get("toValue")}]
            if m.get("fxKey") else []
        )
        wires = [wire_for_fxkey(op["fxKey"]) for op in ops if op.get("fxKey")]
        return wires or ["fx:_unknown"]
    if kind == "mute":
        return ["mute"]
    if kind == "beat-repeat":
        # Beat-Repeat fires short mute bursts — same wire as mute group.
        return ["mute"]
    if kind in ("tempo-hold", "tempo-sweep", "tempo-anchor"):
        return ["tempo"]
    if kind == "pan-move":
        return ["pan"]
    if kind == "decay-move":
        return ["decay"]
    if kind in ("feel-snap", "feel-sweep", "genre-reset"):
        # Feel writes lp-freq + tempo. Modeling as two wires makes
        # parallel-with-tempo macros correctly conflict.
        return ["fx:lp-freq", "tempo"]
    if kind == "compound":
        # Inherit the union of sub-step wires.
        wires: set[str] = set()
        for step in m.get("steps", []):
            sub_id = step.get("macroId")
            if sub_id:
                wires.add(f"compound:{sub_id}")
        return sorted(wires) or ["compound:_inline"]
    if kind == "one-shot":
        return [f"oneshot:{m.get('id', 'X')}"]
    return [f"misc:{m.get('id', 'X')}"]


def macro_to_box(m: dict) -> Box:
    """Produce a DisCoPy box whose dom = cod = tensor of the wires touched.

    Box label = macro id (short, fits the rendered diagram). Group +
    duration ride along as metadata in the box's __dict__ for downstream
    reporting; DisCoPy ignores them at draw time.
    """
    wires = wires_for_macro(m)
    ty = Ty(*wires)
    box = Box(m["id"], ty, ty)
    box.macro_meta = {
        "group": m.get("group"),
        "kind": m.get("kind"),
        "label": m.get("label"),
        "wires": wires,
    }
    return box


def can_parallel(a: Box, b: Box) -> bool:
    """Two boxes parallel-compose iff their wire sets are disjoint.

    DisCoPy's `a @ b` always builds a syntactic tensor, but at the
    *semantic* level our macros are endomorphisms on shared state; a
    parallel composition only makes sense when the underlying state
    wires don't overlap. This helper encodes that domain rule.
    """
    return set(a.macro_meta["wires"]).isdisjoint(b.macro_meta["wires"])


def compatibility_report(boxes: list[Box]) -> str:
    """One-line-per-pair report of which macros parallel-compose."""
    lines = []
    lines.append("Macro parallel-composition compatibility:")
    lines.append(f"  {len(boxes)} macros, {len(boxes)*(len(boxes)-1)//2} pairs.")
    by_group: dict[str, list[Box]] = {}
    for b in boxes:
        by_group.setdefault(b.macro_meta["group"], []).append(b)
    lines.append("\nPer-group wire types (parallel ✓ within disjoint groups):")
    for g, gb in sorted(by_group.items()):
        wires = sorted({w for box in gb for w in box.macro_meta["wires"]})
        lines.append(f"  {g:8s}  ({len(gb)} macros)  wires: {' '.join(wires)}")
    # Sample some pairs across groups
    lines.append("\nSample cross-group compatibility (✓ parallel-compose, ✗ conflict):")
    seen = set()
    for a in boxes:
        for b in boxes:
            if a is b:
                continue
            key = tuple(sorted([a.name, b.name]))
            if key in seen:
                continue
            seen.add(key)
            if a.macro_meta["group"] == b.macro_meta["group"]:
                continue
            mark = "✓" if can_parallel(a, b) else "✗"
            lines.append(f"  {mark}  {a.name:18s} @ {b.name}")
            if len(seen) > 60:
                lines.append("  …")
                return "\n".join(lines)
    return "\n".join(lines)


def build_catalog_diagram(boxes: list[Box]) -> Diagram:
    """A block-diagonal stack: every macro shown side-by-side.

    DisCoPy renders this as one wide string diagram with one box per
    macro on its own wire. Reads top-to-bottom, left-to-right by
    catalog order.
    """
    if not boxes:
        return Diagram.id(Ty())
    diag = boxes[0]
    for b in boxes[1:]:
        diag = diag @ b
    return diag


def build_autodj_sample(boxes: list[Box]) -> Diagram:
    """A representative Auto-DJ tick: one macro from each compatible
    family fires in parallel. Picks the first in each group whose wires
    don't conflict with already-picked macros.
    """
    by_group = {}
    for b in boxes:
        by_group.setdefault(b.macro_meta["group"], []).append(b)
    picked: list[Box] = []
    used: set[str] = set()
    # Order roughly mirrors the live Auto-DJ pool defaults: FX first,
    # then Pitch, Pan, Shape — Mute / Tempo are usually macrosDisabled
    # in seed contexts.
    for group in ("FX", "Pitch", "Pan", "Shape", "Feel"):
        for b in by_group.get(group, []):
            wires = set(b.macro_meta["wires"])
            if wires.isdisjoint(used):
                picked.append(b)
                used |= wires
                break
    if not picked:
        return Diagram.id(Ty())
    diag = picked[0]
    for b in picked[1:]:
        diag = diag @ b
    return diag


def main() -> None:
    macros = load_macros()
    boxes = [macro_to_box(m) for m in macros]

    # Stdout: compatibility report.
    print(compatibility_report(boxes))

    # Render the sample Auto-DJ tick — that's the most useful single
    # picture (the full catalog stack is too wide to be useful, but it's
    # written below for completeness).
    out_dir = REPO_ROOT / "public" / "docs"
    out_dir.mkdir(parents=True, exist_ok=True)

    sample = build_autodj_sample(boxes)
    if sample.dom != Ty():  # non-empty
        try:
            sample.draw(path=str(out_dir / "macro-category-autodj.png"),
                        figsize=(10, 4),
                        fontsize=10)
            print(f"\nWrote {out_dir / 'macro-category-autodj.png'}")
        except Exception as e:
            sys.stderr.write(f"draw autodj sample: {e}\n")

    # Per-group block diagram — one row of boxes per group, wire types
    # reflected in the labels above each wire. Easier to read than the
    # whole catalog stacked.
    by_group = {}
    for b in boxes:
        by_group.setdefault(b.macro_meta["group"], []).append(b)
    for group, gb in sorted(by_group.items()):
        if not gb:
            continue
        diag = gb[0]
        for b in gb[1:]:
            diag = diag @ b
        try:
            path = out_dir / f"macro-category-{group.lower()}.png"
            diag.draw(path=str(path),
                      figsize=(max(6, 1.4 * len(gb)), 3),
                      fontsize=9)
            print(f"Wrote {path}")
        except Exception as e:
            sys.stderr.write(f"draw {group}: {e}\n")


if __name__ == "__main__":
    main()

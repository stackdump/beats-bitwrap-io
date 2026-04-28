#!/usr/bin/env python3
"""Render the macro catalog as an *endomorphism hub*.

Companion to scripts/draw_macro_category.py. Where that script renders
macros as boxes in a free monoidal category (DisCoPy, typed wires), this
one collapses the picture to a single object — `Beat` — with every
macro drawn as a labeled loop `Beat → Beat`. Reads less like a proof and
more like "what does this thing do to the song".

Layout: Beat sits at the center. Groups (FX, Mute, Tempo, Pan, Shape,
Pitch, Feel, One-Shot) each occupy a wedge around it. Each macro inside
a wedge is a curved arrow returning to Beat, labeled with its id. Color
maps to the wire family, so visual clusters match runtime conflict
classes (everything pink touches `mute`, everything teal touches
`tempo`, etc.).

Pipeline mirrors draw_macro_category.py:
    node scripts/dump_macros.mjs | python3 scripts/draw_beat_hub.py

Outputs:
    public/docs/beat-hub.png       — the full hub
    public/docs/beat-hub-{group}.png — one PNG per group (zoomed)
"""
from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path

import matplotlib.pyplot as plt
from matplotlib.patches import Circle, FancyArrowPatch

REPO_ROOT = Path(__file__).resolve().parent.parent


# Reuse the wire-derivation logic from draw_macro_category.py — copied
# rather than imported so this script stays standalone (the sibling has
# a hard discopy dependency we don't need here).
def wires_for_macro(m: dict) -> list[str]:
    kind = m.get("kind", "")
    if kind in ("fx-sweep", "fx-hold"):
        ops = m.get("ops") or (
            [{"fxKey": m["fxKey"], "toValue": m.get("toValue")}]
            if m.get("fxKey") else []
        )
        wires = [f"fx:{op['fxKey']}" for op in ops if op.get("fxKey")]
        return wires or ["fx:_unknown"]
    if kind == "mute" or kind == "beat-repeat":
        return ["mute"]
    if kind in ("tempo-hold", "tempo-sweep", "tempo-anchor"):
        return ["tempo"]
    if kind == "pan-move":
        return ["pan"]
    if kind == "decay-move":
        return ["decay"]
    if kind in ("feel-snap", "feel-sweep", "genre-reset"):
        return ["fx:lp-freq", "tempo"]
    if kind == "compound":
        wires = set()
        for step in m.get("steps", []):
            sub_id = step.get("macroId")
            if sub_id:
                wires.add(f"compound:{sub_id}")
        return sorted(wires) or ["compound:_inline"]
    if kind == "one-shot":
        return [f"oneshot:{m.get('id', 'X')}"]
    return [f"misc:{m.get('id', 'X')}"]


def load_macros() -> list[dict]:
    if not sys.stdin.isatty():
        data = sys.stdin.read()
        if data.strip():
            return json.loads(data)
    out = subprocess.check_output(
        ["node", str(REPO_ROOT / "scripts" / "dump_macros.mjs")],
        text=True, cwd=str(REPO_ROOT))
    return json.loads(out)


# Group order: outer wedges in the order they appear clockwise from
# 12 o'clock. Chosen so chemically-related families sit adjacent (FX
# next to Feel because Feel writes an FX wire; Mute next to Tempo
# because both are silencing-type disruptors).
GROUP_ORDER = ["FX", "Feel", "Pitch", "Pan", "Shape", "Mute",
               "Tempo", "One-Shot"]

GROUP_COLOR = {
    "FX":       "#ec4899",  # pink
    "Feel":     "#a855f7",  # purple
    "Pitch":    "#f59e0b",  # amber
    "Pan":      "#10b981",  # emerald
    "Shape":    "#06b6d4",  # cyan
    "Mute":     "#ef4444",  # red
    "Tempo":    "#3b82f6",  # blue
    "One-Shot": "#eab308",  # yellow
}


def draw_hub(macros: list[dict], path: Path, *, only_group: str | None = None,
             title: str | None = None) -> None:
    by_group: dict[str, list[dict]] = {}
    for m in macros:
        by_group.setdefault(m.get("group", "?"), []).append(m)

    if only_group:
        groups = [only_group]
    else:
        groups = [g for g in GROUP_ORDER if by_group.get(g)]

    fig, ax = plt.subplots(figsize=(16, 16) if not only_group else (10, 10))
    ax.set_aspect("equal")
    ax.set_facecolor("#0a0f1e")
    fig.patch.set_facecolor("#0a0f1e")
    ax.axis("off")

    R_HUB = 1.0      # radius of the central Beat circle
    R_RING = 6.0     # where macro labels sit
    R_LABEL_GROUP = 7.4  # group title sits outside the macro ring

    # Central Beat hub
    ax.add_patch(Circle((0, 0), R_HUB, facecolor="#0b1020",
                        edgecolor="#e2e8f0", linewidth=2.5, zorder=5))
    ax.text(0, 0, "Beat", ha="center", va="center",
            color="#f8fafc", fontsize=18, fontweight="bold", zorder=6)
    ax.text(0, -0.35, "(track state)", ha="center", va="center",
            color="#94a3b8", fontsize=9, zorder=6)

    # Wedge widths are proportional to macro count so the busy
    # families (FX has 13, Mute has 7) don't get the same arc as
    # singleton wedges. A small floor keeps tiny groups visible.
    sizes = {g: max(len(by_group.get(g, [])), 1) for g in groups}
    total = sum(sizes.values())
    starts: dict[str, float] = {}
    ends: dict[str, float] = {}
    cursor = -math.pi / 2  # 12 o'clock
    for g in groups:
        span = 2 * math.pi * sizes[g] / total
        starts[g] = cursor
        ends[g] = cursor + span
        cursor += span

    for gi, group in enumerate(groups):
        gmacros = by_group.get(group, [])
        if not gmacros:
            continue

        if only_group:
            wedge_start = 0.0
            wedge_end = 2 * math.pi
        else:
            wedge_start = starts[group]
            wedge_end = ends[group]

        # Group label (outer ring)
        mid = (wedge_start + wedge_end) / 2
        if not only_group:
            ax.text(R_LABEL_GROUP * math.cos(mid),
                    R_LABEL_GROUP * math.sin(mid),
                    group, ha="center", va="center",
                    color=GROUP_COLOR.get(group, "#e2e8f0"),
                    fontsize=14, fontweight="bold")

        n = len(gmacros)
        # Spread macros across the wedge with a small inset on either
        # end so they don't visually run into the next group.
        pad = (wedge_end - wedge_start) * (0.05 if n > 1 else 0)
        for i, m in enumerate(gmacros):
            t = (i + 0.5) / max(n, 1)
            angle = wedge_start + pad + t * (wedge_end - wedge_start - 2 * pad)
            # Alternating radii: dense wedges (FX, Mute) get visual
            # breathing room because consecutive labels sit at
            # different distances from Beat.
            r_label = R_RING + (0.55 if i % 2 == 0 else -0.55)
            x = r_label * math.cos(angle)
            y = r_label * math.sin(angle)

            # Endomorphism arrow: from a point on the hub edge, curve
            # out to the macro's seat, then label there. We draw a
            # bidirectional curve to read as "Beat → macro action →
            # Beat", which is the endomorphism.
            color = GROUP_COLOR.get(group, "#94a3b8")
            hub_x, hub_y = R_HUB * math.cos(angle), R_HUB * math.sin(angle)
            seat_x, seat_y = (r_label - 0.6) * math.cos(angle), \
                             (r_label - 0.6) * math.sin(angle)

            # Outbound arc
            ax.add_patch(FancyArrowPatch(
                (hub_x, hub_y), (seat_x, seat_y),
                connectionstyle="arc3,rad=0.22",
                arrowstyle="-|>", mutation_scale=10,
                color=color, alpha=0.85, linewidth=1.1, zorder=2))
            # Return arc — slightly different curvature so the pair
            # reads as a loop, not a straight there-and-back.
            ax.add_patch(FancyArrowPatch(
                (seat_x, seat_y), (hub_x, hub_y),
                connectionstyle="arc3,rad=0.22",
                arrowstyle="-|>", mutation_scale=10,
                color=color, alpha=0.45, linewidth=0.9, zorder=2))

            # Macro id label at the seat.
            label = m["id"]
            wires = wires_for_macro(m)
            wire_str = " ⊗ ".join(w.replace("fx:", "").replace("oneshot:", "")
                                  for w in wires)
            # Two-line label: id (bold) + wire types (dim).
            ax.text(x, y + 0.05, label,
                    ha="center", va="bottom",
                    color="#f8fafc", fontsize=8.5, fontweight="bold",
                    zorder=4)
            ax.text(x, y - 0.05, wire_str,
                    ha="center", va="top",
                    color="#94a3b8", fontsize=6.5, zorder=4)

    # Title
    title_text = title or "Beat as endomorphism hub · macros loop on a single object"
    ax.text(0, R_LABEL_GROUP + 0.7, title_text,
            ha="center", va="bottom",
            color="#e2e8f0", fontsize=13, fontweight="600")

    lim = R_LABEL_GROUP + 1.2
    ax.set_xlim(-lim, lim)
    ax.set_ylim(-lim, lim)
    fig.tight_layout()
    fig.savefig(str(path), dpi=140, facecolor=fig.get_facecolor())
    plt.close(fig)
    print(f"Wrote {path}")


def main() -> None:
    macros = load_macros()

    out_dir = REPO_ROOT / "public" / "docs"
    out_dir.mkdir(parents=True, exist_ok=True)

    draw_hub(macros, out_dir / "beat-hub.png")

    # Per-group close-ups — same hub picture, single wedge expanded
    # to the full ring. Useful for digging into a family.
    by_group = {}
    for m in macros:
        by_group.setdefault(m.get("group", "?"), []).append(m)
    for group in by_group:
        if not group:
            continue
        slug = group.lower().replace(" ", "-")
        draw_hub(macros, out_dir / f"beat-hub-{slug}.png",
                 only_group=group,
                 title=f"{group} family · endomorphism close-up")


if __name__ == "__main__":
    main()

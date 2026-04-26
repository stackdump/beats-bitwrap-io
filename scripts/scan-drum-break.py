#!/usr/bin/env python3
"""Scan an arranged project for drum-break-style mass-mute → mass-unmute
patterns. The arrange overlay's DrumBreak emits one ring control net per
non-drum target, all sharing the same mutePos and unmutePos — so when the
break ends, every melodic/harmonic target unmutes on the *exact* same tick.
That co-incident unmute can read as a "blast" against any sustained voice
whose envelope retriggers.

Usage:
  ./scripts/scan-drum-break.py path/to/arranged-project.json
  ./scripts/scan-drum-break.py --fetch http://localhost:8080
  ./scripts/scan-drum-break.py --fetch http://localhost:8080 --bpm 120

Reports, per simultaneous-unmute tick:
  - tick + wall-clock time
  - which targets unmute together
  - the matching mass-mute tick (if any) and the gap between them
  - whether the source net IDs match the `break-*` naming the Go arranger uses
"""
import argparse, json, pathlib, urllib.request
from collections import defaultdict

# Reuse the simulator from find-blasts.py.
from importlib.util import spec_from_file_location, module_from_spec
_here = pathlib.Path(__file__).parent
_spec = spec_from_file_location("find_blasts", _here / "find-blasts.py")
_fb = module_from_spec(_spec); _spec.loader.exec_module(_fb)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("payload", nargs="?")
    ap.add_argument("--fetch", help="Authoring server URL — GET /api/project")
    ap.add_argument("--bpm", type=float, default=120.0)
    ap.add_argument("--ppq", type=int, default=4)
    ap.add_argument("--max-ticks", type=int, default=4096)
    ap.add_argument("--threshold", type=int, default=2)
    args = ap.parse_args()
    if not args.payload and not args.fetch:
        ap.error("provide a payload path or --fetch URL")

    proj = _fb.load_project(args.payload, args.fetch)
    bpm = float(proj.get("tempo") or args.bpm)

    mutes_by_tick = defaultdict(list)   # tick -> [(net_id, target)]
    unmutes_by_tick = defaultdict(list)
    for net_id, net in proj["nets"].items():
        if (net.get("role") or "").lower() != "control":
            continue
        for tick, tid, binding in _fb.simulate_control_net(net, args.max_ticks):
            action = binding.get("action") or ""
            target = binding.get("targetNet") or binding.get("target") or ""
            if action in {"unmute-track", "unmute-note", "activate-slot"}:
                unmutes_by_tick[tick].append((net_id, target))
            elif action in {"mute-track", "mute-note"}:
                mutes_by_tick[tick].append((net_id, target))

    # Find mass-unmute ticks.
    mass_unmute_ticks = [t for t, lst in unmutes_by_tick.items() if len(lst) >= args.threshold]
    mass_mute_ticks = [t for t, lst in mutes_by_tick.items() if len(lst) >= args.threshold]

    print(f"# Drum-break scan (BPM={bpm}, PPQ={args.ppq}, horizon={args.max_ticks})")
    if not mass_unmute_ticks:
        print("No mass-unmute ticks found — drum-break overlay is probably absent or already staggered.")
        return

    for ut in sorted(mass_unmute_ticks):
        targets = sorted({t for _, t in unmutes_by_tick[ut]})
        ctrl_ids = sorted({n for n, _ in unmutes_by_tick[ut]})
        looks_like_break = all(c.startswith("break-") for c in ctrl_ids)
        prior_mutes = [m for m in mass_mute_ticks if m < ut]
        paired = max(prior_mutes) if prior_mutes else None

        time_str = _fb.tick_to_time(ut, bpm, args.ppq)
        tag = "DRUM-BREAK END" if looks_like_break else "MASS UNMUTE"
        print(f"\n[{tag}] tick {ut} ({time_str}) — {len(targets)} targets unmute simultaneously:")
        for tgt in targets:
            print(f"   ↑ {tgt}")
        if paired is not None:
            gap = ut - paired
            gap_sec = gap * 60.0 / (bpm * args.ppq)
            print(f"   paired mass-mute @ tick {paired} ({_fb.tick_to_time(paired, bpm, args.ppq)}) — break length: {gap} ticks ({gap_sec:.2f}s)")
        print(f"   source nets: {', '.join(ctrl_ids)}")

    print(f"\n{len(mass_unmute_ticks)} mass-unmute tick(s); {len(mass_mute_ticks)} mass-mute tick(s).")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Find "blast" moments — ticks where multiple control nets simultaneously
fire unmute-track, unmute-note, or activate-slot actions, which can produce
an audible "all instruments at once" hit.

Usage:
  ./scripts/find-blasts.py path/to/project.json
  ./scripts/find-blasts.py --fetch http://localhost:8080
  ./scripts/find-blasts.py --fetch http://localhost:8080 --bpm 120
  ./scripts/find-blasts.py path/to/share-envelope.json --max-ticks 4096
  ./scripts/find-blasts.py --expand http://localhost:8080 --genre techno --seed 42 \\
      --size 256 --structure standard --drum-break 16 --fade-in pad,harmony

Inputs accepted:
  - A runtime project JSON (top-level `nets` map: id → {role, places, transitions, arcs}).
  - A share-v1 envelope with raw `nets` (same shape, just nested under the envelope).
  - A live authoring server: --fetch http://host:port  (calls /api/project).
  - --expand http://host:port: POSTs /api/generate then /api/arrange with the
    requested genre/seed/structure, then GETs /api/project. Lets you scan a
    (genre, seed) envelope without first sealing or opening the UI.

The script simulates each control net's token flow tick-by-tick, records
the tick of every control firing, then aggregates by tick to find collisions.

Limitations:
  - Cannot expand `(genre, seed)` into a project — feed it an already-arranged
    project (use --fetch on a server running with -authoring after /api/generate).
  - Drum-break control nets are rings: simulator runs --max-ticks ticks (default
    enough to cover a typical 1024-step arrangement at PPQ=4).
"""
import argparse, json, pathlib, sys, urllib.request
from collections import defaultdict

UNMUTE_ACTIONS = {"unmute-track", "unmute-note", "activate-slot"}
MUTE_ACTIONS = {"mute-track", "mute-note", "toggle-track", "toggle-note"}


def load_project(arg, fetch_url):
    if fetch_url:
        url = fetch_url.rstrip("/") + "/api/project"
        with urllib.request.urlopen(url) as r:
            doc = json.loads(r.read())
    else:
        doc = json.loads(pathlib.Path(arg).read_text())
    # Share envelopes wrap the runtime shape; runtime shape has top-level `nets`.
    if "nets" in doc and isinstance(doc["nets"], dict):
        return doc
    raise SystemExit(f"no `nets` map found in {arg or fetch_url}")


def expand_envelope(host, genre, seed, size, structure, drum_break, fade_in, arrange_seed):
    """POST /api/generate + /api/arrange to materialize a (genre, seed) envelope
    on a running authoring server, then return the resulting project."""
    base = host.rstrip("/")

    def _post(path, body):
        req = urllib.request.Request(
            base + path,
            data=json.dumps(body).encode(),
            headers={"content-type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req) as r:
            r.read()

    _post("/api/generate", {"genre": genre, "seed": seed, "size": size})
    arrange_body = {"structure": structure}
    if drum_break:
        arrange_body["drumBreak"] = drum_break
    if fade_in:
        arrange_body["fadeIn"] = fade_in
    if arrange_seed is not None:
        arrange_body["arrangeSeed"] = arrange_seed
    _post("/api/arrange", arrange_body)
    return load_project(None, base)


def initial_marking(net):
    marking = {}
    for pid, p in (net.get("places") or {}).items():
        init = p.get("initial") if isinstance(p, dict) else None
        if isinstance(init, list):
            tokens = sum(int(x) for x in init if isinstance(x, (int, float)))
        elif isinstance(init, (int, float)):
            tokens = int(init)
        else:
            tokens = 0
        marking[pid] = tokens
    return marking


def index_arcs(net):
    """Return inputs[tid] -> [(pid, weight)], outputs[tid] -> [(pid, weight)]."""
    inputs = defaultdict(list)
    outputs = defaultdict(list)
    transitions = set((net.get("transitions") or {}).keys())
    places = set((net.get("places") or {}).keys())
    for arc in net.get("arcs") or []:
        s, t = arc.get("source"), arc.get("target")
        w = arc.get("weight", 1)
        if isinstance(w, list):
            w = sum(int(x) for x in w if isinstance(x, (int, float))) or 1
        else:
            w = int(w) if isinstance(w, (int, float)) else 1
        if s in places and t in transitions:
            inputs[t].append((s, w))
        elif s in transitions and t in places:
            outputs[s].append((t, w))
    return inputs, outputs


def simulate_control_net(net, max_ticks):
    """Yield (tick, tid, binding) for each firing.

    Control nets in this codebase are chains or rings: at most one transition
    is enabled per step. We fire one transition per tick (deterministic by
    sorted tid), then advance. A tick where nothing is enabled still counts —
    the wall clock advances regardless.
    """
    inputs, outputs = index_arcs(net)
    transitions = net.get("transitions") or {}
    marking = initial_marking(net)
    fired = []

    def enabled(tid):
        for pid, w in inputs.get(tid, []):
            if marking.get(pid, 0) < w:
                return False
        return True

    for tick in range(max_ticks):
        # Pick deterministic candidate. Prefer numeric-suffix order so t0,t1,t2…
        candidates = sorted(transitions.keys(), key=lambda t: (len(t), t))
        chosen = None
        for tid in candidates:
            if enabled(tid):
                chosen = tid
                break
        if chosen is None:
            break
        for pid, w in inputs.get(chosen, []):
            marking[pid] -= w
        for pid, w in outputs.get(chosen, []):
            marking[pid] = marking.get(pid, 0) + w
        binding = (transitions[chosen] or {}).get("control")
        if binding:
            fired.append((tick, chosen, binding))
    return fired


def tick_to_time(tick, bpm, ppq=4):
    seconds = tick * 60.0 / (bpm * ppq)
    return f"{int(seconds // 60):d}:{seconds % 60:05.2f}"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("payload", nargs="?", help="Path to project or share-envelope JSON")
    ap.add_argument("--fetch", help="Authoring server URL — GET /api/project")
    ap.add_argument("--expand", help="Authoring server URL — POST generate+arrange then GET /api/project")
    ap.add_argument("--genre", default="techno", help="Genre for --expand (default techno)")
    ap.add_argument("--seed", type=int, default=42, help="Seed for --expand (default 42)")
    ap.add_argument("--size", type=int, default=256, help="Composer size for --expand (default 256)")
    ap.add_argument("--structure", default="standard", help="Structure blueprint for --expand")
    ap.add_argument("--drum-break", type=int, default=0, help="Drum-break bars for --expand")
    ap.add_argument("--fade-in", default="", help="Comma-separated roles to fade in")
    ap.add_argument("--arrange-seed", type=int, help="Optional arrangeSeed for --expand")
    ap.add_argument("--bpm", type=float, default=120.0, help="BPM for tick→time conversion (default 120)")
    ap.add_argument("--ppq", type=int, default=4, help="Pulses per quarter (default 4)")
    ap.add_argument("--max-ticks", type=int, default=4096, help="Simulation horizon (default 4096)")
    ap.add_argument("--threshold", type=int, default=2, help="Min simultaneous unmutes to flag (default 2)")
    ap.add_argument("--show-all", action="store_true", help="List every control firing, not just collisions")
    args = ap.parse_args()

    if not args.payload and not args.fetch and not args.expand:
        ap.error("provide a payload path, --fetch URL, or --expand URL")

    if args.expand:
        fade_in = [s.strip() for s in args.fade_in.split(",") if s.strip()]
        proj = expand_envelope(
            args.expand, args.genre, args.seed, args.size,
            args.structure, args.drum_break, fade_in, args.arrange_seed,
        )
    else:
        proj = load_project(args.payload, args.fetch)
    bpm = float(proj.get("tempo") or args.bpm)

    by_tick = defaultdict(list)  # tick -> [(net_id, action, target)]
    for net_id, net in proj["nets"].items():
        if (net.get("role") or "").lower() != "control":
            continue
        for tick, tid, binding in simulate_control_net(net, args.max_ticks):
            action = binding.get("action") or ""
            target = binding.get("targetNet") or binding.get("target") or ""
            by_tick[tick].append((net_id, tid, action, target, binding))

    if args.show_all:
        print(f"# All control firings (BPM={bpm}, PPQ={args.ppq})")
        for tick in sorted(by_tick):
            for entry in by_tick[tick]:
                net_id, tid, action, target, _ = entry
                print(f"{tick:>5} {tick_to_time(tick, bpm, args.ppq):>8}  {net_id}/{tid:<6} {action:<14} {target}")
        return

    print(f"# Blast scan — flagging ticks with >= {args.threshold} simultaneous {sorted(UNMUTE_ACTIONS)} firings")
    print(f"# BPM={bpm}, PPQ={args.ppq}, horizon={args.max_ticks} ticks ({tick_to_time(args.max_ticks, bpm, args.ppq)})")
    flagged = 0
    for tick in sorted(by_tick):
        unmutes = [e for e in by_tick[tick] if e[2] in UNMUTE_ACTIONS]
        if len(unmutes) >= args.threshold:
            flagged += 1
            print(f"\nBLAST @ tick {tick} ({tick_to_time(tick, bpm, args.ppq)}) — {len(unmutes)} simultaneous unmutes:")
            for net_id, tid, action, target, _ in unmutes:
                print(f"  {net_id}/{tid:<8} {action:<14} → {target}")
            others = [e for e in by_tick[tick] if e[2] not in UNMUTE_ACTIONS]
            for net_id, tid, action, target, _ in others:
                print(f"  (also) {net_id}/{tid:<8} {action:<14} → {target}")
    if not flagged:
        print("\nNo blasts detected within horizon.")
    else:
        print(f"\n{flagged} blast tick(s) flagged.")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Measure inter-onset-interval jitter in a rendered .webm.

Decodes via ffmpeg, runs a transient detector (envelope + threshold +
refractory), reports IOI mean/stddev, cumulative drift vs ideal grid,
and a histogram of IOI deltas.

  ./scripts/measure-jitter.py /tmp/metronome.webm
  ./scripts/measure-jitter.py /tmp/metronome.webm --bpm 120 --subdivision quarter
  ./scripts/measure-jitter.py /tmp/metronome.webm --bpm 140 --subdivision eighth

Designed for clean drum metronomes (sharp transients). Won't work on
tracks with reverb tails or melodic content — use a pure metronome
diagnostic envelope (see examples/metronome.json).
"""
import argparse, pathlib, subprocess, sys
import numpy as np

SUBDIV = {"whole": 0.25, "half": 0.5, "quarter": 1.0, "eighth": 2.0, "sixteenth": 4.0}

def decode_pcm(path: pathlib.Path, sr: int) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path),
         "-f", "f32le", "-ac", "1", "-ar", str(sr), "pipe:1"],
        capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32)

def detect_onsets(x: np.ndarray, sr: int, refractory_ms: int, threshold_frac: float) -> list[float]:
    env = np.abs(x)
    win = max(1, sr // 200)  # 5 ms moving avg
    env = np.convolve(env, np.ones(win, dtype=np.float32) / win, mode="same")
    thresh = threshold_frac * float(np.max(env))
    refractory = int(refractory_ms * sr / 1000)
    onsets = []
    i, N = 0, len(env)
    while i < N:
        if env[i] > thresh:
            fwd = min(N, i + sr * 30 // 1000)  # peak within 30 ms
            peak = i + int(np.argmax(env[i:fwd]))
            onsets.append(peak / sr)
            i = peak + refractory
        else:
            i += 1
    return onsets

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("audio", type=pathlib.Path)
    ap.add_argument("--bpm", type=float, default=120.0)
    ap.add_argument("--subdivision", choices=list(SUBDIV), default="quarter",
                    help="Hits per beat (default: quarter = 1/beat)")
    ap.add_argument("--sr", type=int, default=48000)
    ap.add_argument("--threshold", type=float, default=0.30,
                    help="Onset threshold as fraction of peak envelope (default 0.30)")
    ap.add_argument("--refractory-ms", type=int, default=0,
                    help="Min ms between onsets. Default = half the ideal IOI.")
    args = ap.parse_args()

    if not args.audio.exists():
        print(f"no such file: {args.audio}", file=sys.stderr)
        return 1

    ideal = 60_000.0 / args.bpm / SUBDIV[args.subdivision]
    refractory = args.refractory_ms or max(20, int(ideal * 0.4))

    x = decode_pcm(args.audio, args.sr)
    print(f"file:     {args.audio}")
    print(f"samples:  {len(x)}  duration: {len(x)/args.sr:.3f}s  peak: {np.max(np.abs(x)):.3f}")
    onsets = detect_onsets(x, args.sr, refractory, args.threshold)
    print(f"onsets:   {len(onsets)}  (refractory {refractory} ms, threshold {args.threshold:.2f}*peak)")
    if len(onsets) < 2:
        print("insufficient onsets — try lowering --threshold", file=sys.stderr)
        return 2

    ioi = np.diff(onsets) * 1000.0
    print(f"\nideal IOI: {ideal:.3f} ms  ({args.bpm} BPM, {args.subdivision})")
    print(f"IOI mean:  {ioi.mean():.3f} ms   stddev: {ioi.std():.3f} ms")
    print(f"IOI min:   {ioi.min():.3f} ms   max: {ioi.max():.3f} ms")
    print(f"|IOI - ideal| mean: {np.mean(np.abs(ioi - ideal)):.3f} ms   max: {np.max(np.abs(ioi - ideal)):.3f} ms")

    n = np.arange(len(onsets))
    expected = onsets[0] + n * (ideal / 1000.0)
    drift = (np.array(onsets) - expected) * 1000.0
    print(f"cumulative drift  mean: {drift.mean():.3f} ms   stddev: {drift.std():.3f} ms")
    print(f"cumulative drift   min: {drift.min():.3f} ms    max: {drift.max():.3f} ms")
    if abs(drift[-1]) > 50:
        rate = drift[-1] / onsets[-1]
        print(f"** end-to-end drift rate: {rate:+.2f} ms/sec — engine is "
              f"{'slow' if rate < 0 else 'fast'} relative to wall clock")

    worst = np.argsort(np.abs(ioi - ideal))[-10:][::-1]
    print(f"\nworst 10 IOIs (vs ideal {ideal:.1f} ms):")
    print("  idx   IOI(ms)   delta(ms)  at(s)")
    for idx in worst:
        print(f"  {idx:4d}  {ioi[idx]:8.3f}  {ioi[idx]-ideal:+8.3f}  {onsets[idx+1]:7.3f}")

    bins = [-200, -50, -20, -10, -5, -2, -1, 1, 2, 5, 10, 20, 50, 200]
    hist, edges = np.histogram(ioi - ideal, bins=bins)
    print("\nIOI delta histogram (ms):")
    bar_unit = max(1, int(max(hist) / 80))
    for c, lo, hi in zip(hist, edges[:-1], edges[1:]):
        print(f"  [{lo:+6.1f}, {hi:+6.1f}): {'#' * (c // bar_unit)} {c}")
    return 0

if __name__ == "__main__":
    sys.exit(main())

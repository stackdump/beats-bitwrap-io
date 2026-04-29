#!/usr/bin/env python3
"""Headless macro-audio verification.

Per-test pipeline (parallelizable across N workers):
  1. Launch a Chromium tab via Playwright.
  2. Load the studio with ?test=1 (installs the capture hook) and a
     fixed seed/genre so output is reproducible across runs.
  3. Press play, start the capture tap on Tone.Destination.
  4. After PRE seconds, fire the macro under test.
  5. Capture for DURING seconds (the macro window), then more for POST
     (back-to-baseline window).
  6. Stop, pull PCM samples back into Python via base64-encoded
     Float32Array.
  7. Slice into pre / during / post windows and analyze:
       - sweep-lp, sweep-hp, riser etc.: spectral centroid shift
       - cut, drop, breakdown: RMS drop
     Compare windows — confirm the macro had AND lost effect.

Each test runs in its own browser context so workers don't interfere.
Capture is realtime (Tone.Transport drives the audio clock), so an
N-second clip costs N seconds wall-time per worker. Eight workers in
parallel ≈ 8x throughput.

Local server requirements:
  ./beats-bitwrap-io -authoring -addr :18090 -data /tmp/beats-test-data \\
      -public public

(authoring isn't strictly required for capture — the test hook works on
the public studio too — but having a local instance makes the harness
self-contained.)

Usage:
  pip install playwright numpy scipy
  playwright install chromium
  ./scripts/test-macro-audio.py
  ./scripts/test-macro-audio.py --workers 4 --host http://localhost:18090
  ./scripts/test-macro-audio.py --macros sweep-lp cut breakdown
  ./scripts/test-macro-audio.py --keep-failed-audio  # write .wav on fail
"""
import argparse
import base64
import concurrent.futures
import json
import sys
import time
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from playwright.sync_api import sync_playwright


# Each spec describes one macro-vs-baseline contrast: how long pre/during/post
# windows are, the macro id, and which assertion to apply. Keep windows in
# whole bars at 120 BPM so the analysis lines up with Auto-DJ-able cadences.

@dataclass
class MacroSpec:
    macro_id: str
    pre_s: float       # seconds before fire (baseline)
    during_s: float    # seconds capturing the active window
    post_s: float      # seconds after duration ends (recovery)
    # Macro's own duration (in bars). Default tile setting if None.
    bars: int | None
    assertion: str     # "centroid-down", "centroid-up", "rms-down"
    # Min relative change that counts as "took effect" (e.g. centroid
    # must drop by 25% during the window vs the pre window).
    min_delta: float
    # Recovery tolerance — post window must be within this fraction of
    # the pre window's metric.
    recovery_tol: float = 0.35


SPECS = {
    # Default sweep-lp duration is 4 bars ≈ 8s at 120 BPM. We use 2 bars
    # to keep the test under 10 seconds total.
    "sweep-lp": MacroSpec(
        macro_id="sweep-lp", pre_s=3.0, during_s=4.0, post_s=4.0,
        bars=2, assertion="centroid-down", min_delta=0.20,
    ),
    "sweep-hp": MacroSpec(
        macro_id="sweep-hp", pre_s=3.0, during_s=4.0, post_s=4.0,
        bars=2, assertion="centroid-up", min_delta=0.15,
    ),
    "cut": MacroSpec(
        # cut's native unit is *tick* (16th notes), so `bars` here
        # is really "tick count". 32 ticks = 2 bars at 120 BPM.
        macro_id="cut", pre_s=3.0, during_s=3.0, post_s=3.0,
        bars=32, assertion="rms-down", min_delta=0.50,
    ),
    "breakdown": MacroSpec(
        # breakdown only mutes drums; non-drum content keeps playing,
        # so RMS drops modestly (~20%). Drop threshold accordingly.
        macro_id="breakdown", pre_s=3.0, during_s=4.0, post_s=4.0,
        bars=2, assertion="rms-down", min_delta=0.15,
    ),
    "riser": MacroSpec(
        # Sweeps lp-freq up (and crush, in some configs). Centroid
        # rises strongly mid-window. Default duration 4 bars; use 2
        # to keep the test under 10 s.
        macro_id="riser", pre_s=3.0, during_s=4.0, post_s=4.0,
        bars=2, assertion="centroid-up", min_delta=0.20,
    ),
    # NOTE: reverb-wash and the tempo-* macros are intentionally not in
    # the default suite. Reverb-wash extends tails without shifting the
    # spectral centroid much (effect <5% in steady-state); tempo macros
    # change rate, not amplitude or spectrum-per-window. Their
    # assertions need different metrics (e.g. tempo-aware onset
    # detection, RT60 measurement) — left for future work.
}

DEFAULT_MACROS = ["sweep-lp", "sweep-hp", "cut", "breakdown", "riser"]


# ---------- analysis helpers ----------

def rms(x: np.ndarray) -> float:
    if len(x) == 0:
        return 0.0
    return float(np.sqrt(np.mean(x.astype(np.float64) ** 2)))


def spectral_centroid(x: np.ndarray, sr: int) -> float:
    """Mean centroid over 50%-overlap Hann windows. Returns Hz."""
    if len(x) < 1024:
        return 0.0
    n = 2048
    hop = n // 2
    win = np.hanning(n).astype(np.float32)
    freqs = np.fft.rfftfreq(n, 1 / sr)
    cents = []
    for start in range(0, len(x) - n, hop):
        frame = x[start:start + n] * win
        spec = np.abs(np.fft.rfft(frame))
        s = spec.sum()
        if s < 1e-6:
            continue
        cents.append(float((freqs * spec).sum() / s))
    if not cents:
        return 0.0
    return float(np.mean(cents))


def write_wav(path: Path, samples: np.ndarray, sr: int) -> None:
    samples = np.clip(samples, -1.0, 1.0)
    pcm = (samples * 32767.0).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


# ---------- per-test runner (one browser tab) ----------

def run_one(spec: MacroSpec, host: str, headed: bool, debug_dir: Path | None,
            keep_audio: bool) -> dict:
    total_s = spec.pre_s + spec.during_s + spec.post_s
    out = {"macro_id": spec.macro_id, "passed": False, "reason": ""}
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=not headed,
            # Autoplay flags so AudioContext starts without a user click.
            args=[
                "--autoplay-policy=no-user-gesture-required",
                "--no-sandbox",
            ],
        )
        ctx = browser.new_context()
        # Suppress dialogs / console noise per page.
        page = ctx.new_page()
        try:
            # Deterministic boot: techno + seed=42 has a known-good full
            # mix (drums + bass + melody) so spectral analysis has signal
            # across the band. ?test=1 installs the capture hook.
            page.goto(f"{host}/?test=1&genre=techno&seed=42", wait_until="domcontentloaded")
            page.wait_for_function("!!document.querySelector('petri-note')?._project", timeout=15_000)
            page.wait_for_function("window.__pnTestHooksLoaded === true", timeout=10_000)

            # Start playback, then capture. Press the in-page play button
            # so AudioContext gets the user-gesture-equivalent unlock
            # (the autoplay policy flag should make this redundant, but
            # belt and suspenders).
            page.evaluate("""
                () => {
                    const el = document.querySelector('petri-note');
                    el.querySelector('.pn-play')?.click();
                }
            """)
            # Let Tone start, then a beat to settle.
            page.wait_for_timeout(800)
            # capture-start is async (worklet module load).
            page.evaluate("async () => { await window.__pnTestCaptureStart(); }")

            # Pre window
            page.wait_for_timeout(int(spec.pre_s * 1000))

            # Fire the macro. Optional bars override.
            opts = {}
            if spec.bars is not None:
                opts["duration"] = spec.bars
            page.evaluate(
                """([id, opts]) => {
                    const el = document.querySelector('petri-note');
                    el._fireMacro(id, opts);
                }""",
                [spec.macro_id, opts],
            )

            # During + post windows
            page.wait_for_timeout(int((spec.during_s + spec.post_s) * 1000))

            payload = page.evaluate("async () => await window.__pnTestCaptureStop()")
            sr = int(payload["sampleRate"])
            mono = np.frombuffer(base64.b64decode(payload["data"]), dtype=np.float32)

            # Slice. Anchor to capture-start (t=0) — that's when
            # __pnTestCaptureStart was called. Pre is [0, pre_s); during
            # starts at pre_s; post starts at pre_s + during_s.
            i_pre_end = int(spec.pre_s * sr)
            i_dur_end = int((spec.pre_s + spec.during_s) * sr)
            i_pos_end = int((spec.pre_s + spec.during_s + spec.post_s) * sr)
            pre = mono[:i_pre_end]
            during = mono[i_pre_end:i_dur_end]
            post = mono[i_dur_end:i_pos_end]

            # Trim onset transients off "during" — the macro takes ~50 ms
            # to ramp in and ~50 ms to release. Skip 100 ms each side.
            trim = int(0.1 * sr)
            during = during[trim:-trim] if len(during) > 2 * trim else during
            # Same on "post" — let the release tail settle.
            post = post[trim:] if len(post) > trim else post

            metrics = {}
            if spec.assertion in ("centroid-down", "centroid-up"):
                metrics["pre"] = spectral_centroid(pre, sr)
                metrics["during"] = spectral_centroid(during, sr)
                metrics["post"] = spectral_centroid(post, sr)
                metric_name = "centroid_hz"
            elif spec.assertion == "rms-down":
                metrics["pre"] = rms(pre)
                metrics["during"] = rms(during)
                metrics["post"] = rms(post)
                metric_name = "rms"
            else:
                raise RuntimeError(f"unknown assertion {spec.assertion}")

            out["metrics"] = {**metrics, "metric": metric_name}

            pre_v = metrics["pre"]
            dur_v = metrics["during"]
            post_v = metrics["post"]
            if pre_v <= 1e-9:
                out["reason"] = f"pre window has no signal ({pre_v:.6f})"
                _maybe_dump(spec, mono, sr, debug_dir, keep_audio, out)
                return out

            # Effect direction
            if spec.assertion == "centroid-down" or spec.assertion == "rms-down":
                delta = (pre_v - dur_v) / pre_v
            else:  # centroid-up
                delta = (dur_v - pre_v) / pre_v

            recovery = abs(post_v - pre_v) / pre_v

            out["delta"] = float(delta)
            out["recovery"] = float(recovery)

            if delta < spec.min_delta:
                out["reason"] = (
                    f"effect too small: {metric_name} pre={pre_v:.3f} during={dur_v:.3f} "
                    f"delta={delta:.2%} < required {spec.min_delta:.0%}"
                )
                _maybe_dump(spec, mono, sr, debug_dir, keep_audio, out)
                return out

            if recovery > spec.recovery_tol:
                out["reason"] = (
                    f"didn't recover: {metric_name} pre={pre_v:.3f} post={post_v:.3f} "
                    f"|Δ|={recovery:.2%} > tol {spec.recovery_tol:.0%}"
                )
                _maybe_dump(spec, mono, sr, debug_dir, keep_audio, out)
                return out

            out["passed"] = True
            out["reason"] = (
                f"OK · {metric_name} pre={pre_v:.3f} during={dur_v:.3f} "
                f"post={post_v:.3f} delta={delta:.2%} recovery={recovery:.2%}"
            )
            return out
        except Exception as e:
            out["reason"] = f"runtime error: {e}"
            return out
        finally:
            ctx.close()
            browser.close()


def _maybe_dump(spec, mono, sr, debug_dir, keep_audio, out):
    if not (keep_audio and debug_dir):
        return
    try:
        debug_dir.mkdir(parents=True, exist_ok=True)
        path = debug_dir / f"{spec.macro_id}-fail.wav"
        write_wav(path, mono, sr)
        out["debug_wav"] = str(path)
    except Exception as e:
        out["debug_wav_error"] = str(e)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="http://localhost:18090",
                    help="Studio URL (default: http://localhost:18090)")
    ap.add_argument("--workers", type=int, default=4,
                    help="Parallel browser tabs (default: 4)")
    ap.add_argument("--macros", nargs="+", default=DEFAULT_MACROS,
                    help=f"Subset of macros to test. Available: {', '.join(SPECS)}")
    ap.add_argument("--headed", action="store_true",
                    help="Run with a visible browser (debug)")
    ap.add_argument("--keep-failed-audio", action="store_true",
                    help="Write failing clips as .wav under ./test-out/")
    ap.add_argument("--debug-dir", default="./test-out",
                    help="Where to write debug .wavs (default: ./test-out)")
    args = ap.parse_args()

    unknown = [m for m in args.macros if m not in SPECS]
    if unknown:
        print(f"unknown macros: {unknown}", file=sys.stderr)
        sys.exit(2)

    debug_dir = Path(args.debug_dir).resolve() if args.keep_failed_audio else None
    specs = [SPECS[m] for m in args.macros]

    started = time.time()
    print(f"running {len(specs)} macro test(s) with {args.workers} workers against {args.host}")

    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {
            pool.submit(run_one, s, args.host, args.headed, debug_dir, args.keep_failed_audio): s
            for s in specs
        }
        for fut in concurrent.futures.as_completed(futures):
            res = fut.result()
            results.append(res)
            tag = "PASS" if res["passed"] else "FAIL"
            print(f"  [{tag}] {res['macro_id']}: {res['reason']}")

    elapsed = time.time() - started
    n_pass = sum(1 for r in results if r["passed"])
    print(f"\n{n_pass}/{len(results)} passed in {elapsed:.1f}s")
    if n_pass != len(results):
        sys.exit(1)


if __name__ == "__main__":
    main()

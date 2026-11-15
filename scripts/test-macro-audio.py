#!/usr/bin/env python3
"""Headless macro-audio verification on the djrust engine (make test-audio).

Per-test pipeline (parallelizable across N workers):
  1. Launch a Chromium tab via Playwright.
  2. Load the studio with ?test=1 (installs public/lib/test-hooks.js) and
     generate a fixed track through the studio's own generate message (the
     page boots a random techno seed and ignores ?genre= / ?seed=): techno/42,
     or trap/42 for drop, whose non-drum parts carry the sustained floor.
  3. Press play, start the capture: an AudioWorklet tap on the audio host's
     master (the djrust worklet after master volume), lossless f32. There is
     no Tone.Recorder and no encoder in between.
  4. After PRE seconds, mark the capture frame and fire the macro through the
     page (el._fireMacro), in one evaluate.
  5. Wait for the engine to report the macro restored (macro-restored), then
     capture POST more seconds, stop, and pull the PCM back as a base64
     Float32Array together with the marks and the engine's events, each
     stamped with the capture frame it arrived at.
  6. Slice into pre / during / post windows and analyze:
       - cut, breakdown: RMS drop
       - drop: drop of the sustained floor between hits (10th percentile of
         10 ms RMS frames): drop mutes everything but the drums, and the
         drums carry most of a mix's RMS, so RMS barely moves
       - half-time: onset rate drop (the net runs at half rate)
       - sweep-lp, sweep-hp, riser: spectral centroid shift
     The during window runs from the first wave-tick whose macroMask is set
     (the effect is on) to macro-restored, so it follows the engine's real
     duration whatever the tempo does. Confirm the macro had AND lost effect,
     and that the engine ran it exactly once (one macro-fired, source page,
     result 0) and restored it, for the duration asked: the macro-fired →
     macro-restored span (capture frames) is the requested length (32 ticks
     for cut, bars x 16 otherwise) at the tempo it was fired at, within
     SPAN_TOL_TICKS of it. That is wall time, not engine ticks: a tempo macro
     is held for its length at the tempo it started from (half-time for 1 bar
     is 8 engine ticks at half rate, as the page's own tempoHold was), and
     mute macros keep the tempo, so for them it is the tick count too. The
     during window must also cover at least DURING_FLOOR of that length. A
     metric over an empty or near-empty window fails rather than reading 0.

Each test runs in its own browser so workers don't interfere. Capture is
realtime, so an N-second clip costs N seconds of wall time per worker.

Default macros: cut, breakdown, drop, half-time (net macros, which djwasm
0.3.0 runs). sweep-lp, sweep-hp and riser are master macros: they need djwasm
0.4.0 (MASTER_MACROS) and fail on an engine without them (the page hides
their tiles and _fireMacro does nothing).

Local server:
  ./beats-bitwrap-io -addr :18097 -data /tmp/beats-test-audio-data -public public

Usage (make test-audio does all of this; PYTHON= selects the interpreter):
  python3 -m venv /tmp/pw && /tmp/pw/bin/pip install playwright numpy
  ./scripts/test-macro-audio.py --host http://localhost:18097 --workers 4
  ./scripts/test-macro-audio.py --macros cut half-time
  ./scripts/test-macro-audio.py --keep-failed-audio  # write .wav on fail

Playwright's bundled Chromium is used when it is installed; otherwise the
system Chrome (channel "chrome"). --channel forces one.
"""
import argparse
import base64
import concurrent.futures
import dataclasses
import json
import sys
import time
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass
class MacroSpec:
    macro_id: str
    pre_s: float       # seconds of baseline before the fire
    post_s: float      # seconds after macro-restored (recovery)
    max_s: float       # give up waiting for macro-restored after this long
    # The macro's own duration, in its own unit (ticks for cut, bars otherwise).
    # None = the tile's default.
    duration: int | None
    assertion: str     # "rms-down", "floor-down", "onset-rate-down", "centroid-down", "centroid-up"
    # Min relative change that counts as "took effect".
    min_delta: float
    # Recovery tolerance: the post window must be within this fraction of the
    # pre window's metric.
    recovery_tol: float = 0.35
    # Seconds trimmed off each end of the during window (note tails, the port
    # latency of the events that bound it), and skipped before post starts.
    trim_s: float = 0.15
    settle_s: float = 0.4
    # The track, genre:seed (a loop: every role plays throughout), with a full
    # mix (drums + bass + melody) so the metric has signal.
    track: str = "techno:42"


SPECS = {
    "cut": MacroSpec(
        # cut's unit is the tick: 32 ticks = 2 bars. Mutes everything.
        macro_id="cut", pre_s=3.0, post_s=3.0, max_s=8.0,
        duration=32, assertion="rms-down", min_delta=0.50,
    ),
    "breakdown": MacroSpec(
        # Mutes the drums; the rest keeps playing, so RMS drops modestly.
        macro_id="breakdown", pre_s=3.0, post_s=3.0, max_s=8.0,
        duration=2, assertion="rms-down", min_delta=0.15,
    ),
    "drop": MacroSpec(
        # Mutes everything but the drums. Measured on the floor between hits
        # (engine render, trap/42: -76%, recovers within 2%).
        macro_id="drop", pre_s=3.0, post_s=3.0, max_s=8.0,
        duration=2, assertion="floor-down", min_delta=0.40,
        track="trap:42",
    ),
    "half-time": MacroSpec(
        # Halves the tempo for 1 bar (16 ticks at half rate, ~3.75 s at 128
        # bpm): every event comes half as often.
        macro_id="half-time", pre_s=4.0, post_s=4.0, max_s=10.0,
        duration=1, assertion="onset-rate-down", min_delta=0.25,
    ),
    # Master macros: need djwasm 0.4.0 (MASTER_MACROS). Not in the default set.
    "sweep-lp": MacroSpec(
        macro_id="sweep-lp", pre_s=3.0, post_s=4.0, max_s=8.0,
        duration=2, assertion="centroid-down", min_delta=0.20,
    ),
    "sweep-hp": MacroSpec(
        macro_id="sweep-hp", pre_s=3.0, post_s=4.0, max_s=8.0,
        duration=2, assertion="centroid-up", min_delta=0.15,
    ),
    "riser": MacroSpec(
        macro_id="riser", pre_s=3.0, post_s=4.0, max_s=8.0,
        duration=2, assertion="centroid-up", min_delta=0.20,
    ),
}

DEFAULT_MACROS = ["cut", "breakdown", "drop", "half-time"]

# The engine must hold a macro for the length asked: fired → restored, within this many ticks
# (at the fire's tempo) plus EVENT_JITTER_S of port latency on the two events.
SPAN_TOL_TICKS = 2
EVENT_JITTER_S = 0.05
# The during window (trimmed) must cover at least this fraction of the requested length.
DURING_FLOOR = 0.5
CATALOG_TICK_UNIT = {"cut"}  # macros whose duration is in ticks (catalog.js durationUnit 'tick')


def expected_ticks(spec: "MacroSpec") -> int | None:
    if spec.duration is None:
        return None
    return spec.duration if spec.macro_id in CATALOG_TICK_UNIT else spec.duration * 16


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


def floor_level(x: np.ndarray, sr: int) -> float:
    """The sustained level between hits: 10th percentile of 10 ms RMS frames
    (5 ms hop)."""
    n, hop = max(1, sr // 100), max(1, sr // 200)
    if len(x) < 4 * n:
        return 0.0
    frames = np.lib.stride_tricks.sliding_window_view(x.astype(np.float64), n)[::hop]
    return float(np.percentile(np.sqrt((frames ** 2).mean(axis=1)), 10))


def onsets(x: np.ndarray, sr: int) -> np.ndarray:
    """Onset times (s): peaks of the log-magnitude spectral flux.

    1024-point Hann frames, hop 256 (5.3 ms at 48 kHz). A frame is an onset
    when its flux is the maximum within +-40 ms and exceeds the local mean
    over +-150 ms by half the window's 10-90 percentile flux spread.
    """
    n, hop = 1024, 256
    if len(x) < 4 * n:
        return np.zeros(0)
    frames = np.lib.stride_tricks.sliding_window_view(x.astype(np.float64), n)[::hop]
    mag = np.abs(np.fft.rfft(frames * np.hanning(n), axis=1))
    flux = np.maximum(0.0, np.diff(np.log1p(1000.0 * mag), axis=0)).sum(axis=1)
    if flux.max() <= 1e-9:
        return np.zeros(0)
    spread = np.percentile(flux, 90) - np.percentile(flux, 10)
    near = max(1, int(0.040 * sr / hop))
    wide = max(near + 1, int(0.150 * sr / hop))
    local = np.convolve(flux, np.ones(2 * wide + 1) / (2 * wide + 1), mode="same")
    out = []
    for i in range(len(flux)):
        lo, hi = max(0, i - near), min(len(flux), i + near + 1)
        if flux[i] > 0 and flux[i] == flux[lo:hi].max() and flux[i] > local[i] + 0.5 * spread:
            if not out or i - out[-1] > near:
                out.append(i)
    return (np.array(out) + 1) * hop / sr


def onset_rate(x: np.ndarray, sr: int) -> float:
    """Onsets per second."""
    dur = len(x) / sr
    if dur <= 0.5:
        return 0.0
    return float(len(onsets(x, sr)) / dur)


# assertion → (metric name, fn(x, sr), direction of the expected change)
METRICS = {
    "rms-down": ("rms", lambda x, sr: rms(x), -1),
    "floor-down": ("floor_rms", floor_level, -1),
    "onset-rate-down": ("onsets_per_s", onset_rate, -1),
    "centroid-down": ("centroid_hz", spectral_centroid, -1),
    "centroid-up": ("centroid_hz", spectral_centroid, +1),
}


def write_wav(path: Path, samples: np.ndarray, sr: int) -> None:
    samples = np.clip(samples, -1.0, 1.0)
    pcm = (samples * 32767.0).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def windows(spec: MacroSpec, sr: int, fire: int, events: list,
            bpm: float | None = None) -> tuple[dict, str | None]:
    """Frame bounds of pre / during / post from the fire mark and the engine's
    events. → (bounds, problem): problem says what the engine did not report
    (or that it held the macro for another length than asked)."""
    mine = [e for e in events if e.get("frame", -1) >= fire - sr // 10]
    fired = [e for e in mine if e["type"] == "macro-fired" and e.get("id") == spec.macro_id]
    restored = [e for e in mine if e["type"] == "macro-restored" and e.get("id") == spec.macro_id]
    on = [e for e in mine if e["type"] == "mask" and e.get("mask", 0) != 0]
    problem = None
    if len(fired) != 1 or fired[0].get("source") != "page" or fired[0].get("result") != 0:
        problem = f"the engine did not run it exactly once (macro-fired: {fired})"
    elif not restored:
        problem = "the engine never reported macro-restored"
    else:
        want = expected_ticks(spec)
        if want is not None:
            if not bpm or bpm <= 0:
                problem = "no tempo at the fire: cannot check how long the engine held it"
            else:
                tick_s = 60.0 / (bpm * 4)
                held_s = (restored[0]["frame"] - fired[0]["frame"]) / sr
                want_s = want * tick_s
                if abs(held_s - want_s) > SPAN_TOL_TICKS * tick_s + EVENT_JITTER_S:
                    problem = (f"the engine held it {held_s:.2f} s (ticks {fired[0].get('tick')} → "
                               f"{restored[0].get('tick')}), not the {want} ticks asked at {bpm:g} bpm "
                               f"({want_s:.2f} s, tolerance {SPAN_TOL_TICKS} ticks)")
    start = on[0]["frame"] if on else fire
    end = restored[0]["frame"] if restored else fire + int(spec.max_s * sr)
    trim, settle = int(spec.trim_s * sr), int(spec.settle_s * sr)
    b = {
        "pre": (max(0, fire - int(spec.pre_s * sr)), fire),
        "during": (start + trim, max(start + trim, end - trim)),
        "post": (end + settle, end + settle + int(spec.post_s * sr)),
    }
    return b, problem


def analyze(spec: MacroSpec, mono: np.ndarray, sr: int, fire: int, events: list,
            bpm: float | None = None) -> dict:
    """Pure analysis of one capture → {macro_id, passed, reason, metrics, ...}.
    bpm: the page's tempo at the fire (sets the during window's floor)."""
    out = {"macro_id": spec.macro_id, "passed": False, "reason": ""}
    b, problem = windows(spec, sr, fire, events, bpm)
    out["windows_s"] = {k: [round(v[0] / sr, 3), round(v[1] / sr, 3)] for k, v in b.items()}
    if b["post"][1] > len(mono):
        out["reason"] = f"capture too short: {len(mono) / sr:.2f} s, the post window ends at {b['post'][1] / sr:.2f} s"
        return out
    # Every window must hold signal to measure: an empty slice reads 0, which an
    # "X went down" assertion would take for a 100% effect.
    for k, (lo, hi) in b.items():
        if hi - lo < sr // 20:
            out["reason"] = f"the {k} window is empty or too short to measure ({(hi - lo) / sr:.3f} s)"
            return out
    want = expected_ticks(spec)
    if want is not None:
        if not bpm or bpm <= 0:
            out["reason"] = "no tempo at the fire: cannot check the during window's length"
            return out
        floor_s = DURING_FLOOR * want * 60.0 / (bpm * 4)
        got_s = (b["during"][1] - b["during"][0]) / sr
        if got_s < floor_s:
            out["reason"] = (f"during window {got_s:.2f} s is shorter than {DURING_FLOOR:.0%} of the "
                             f"{want} ticks asked at {bpm:g} bpm ({floor_s:.2f} s)")
            return out
    name, fn, sign = METRICS[spec.assertion]
    m = {k: fn(mono[lo:hi], sr) for k, (lo, hi) in b.items()}
    out["metrics"] = {**m, "metric": name}
    pre_v, dur_v, post_v = m["pre"], m["during"], m["post"]
    if pre_v <= 1e-9:
        out["reason"] = f"pre window has no signal ({pre_v:.6f})"
        return out
    delta = (dur_v - pre_v) / pre_v if sign > 0 else (pre_v - dur_v) / pre_v
    recovery = abs(post_v - pre_v) / pre_v
    out["delta"], out["recovery"] = float(delta), float(recovery)
    if problem:
        out["reason"] = f"{problem}; {name} pre={pre_v:.3f} during={dur_v:.3f} post={post_v:.3f}"
        return out
    if delta < spec.min_delta:
        out["reason"] = (f"effect too small: {name} pre={pre_v:.3f} during={dur_v:.3f} "
                         f"delta={delta:.2%} < required {spec.min_delta:.0%}")
        return out
    if recovery > spec.recovery_tol:
        out["reason"] = (f"didn't recover: {name} pre={pre_v:.3f} post={post_v:.3f} "
                         f"|d|={recovery:.2%} > tol {spec.recovery_tol:.0%}")
        return out
    dur_s = out["windows_s"]["during"][1] - out["windows_s"]["during"][0]
    out["passed"] = True
    out["reason"] = (f"OK · {name} pre={pre_v:.3f} during={dur_v:.3f} post={post_v:.3f} "
                     f"delta={delta:.2%} recovery={recovery:.2%} (during window {dur_s:.2f} s)")
    return out


# ---------- per-test runner (one browser) ----------

def launch(pw, headed: bool, channel: str | None):
    args = ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"]
    if channel:
        return pw.chromium.launch(headless=not headed, channel=channel, args=args)
    try:
        return pw.chromium.launch(headless=not headed, args=args)
    except Exception:
        # No bundled Chromium for this Playwright version: use the system Chrome.
        return pw.chromium.launch(headless=not headed, channel="chrome", args=args)


def run_one(spec: MacroSpec, host: str, headed: bool, channel: str | None,
            debug_dir: Path | None, keep_audio: bool, dump_dir: Path | None = None) -> dict:
    from playwright.sync_api import sync_playwright
    out = {"macro_id": spec.macro_id, "passed": False, "reason": ""}
    with sync_playwright() as pw:
        browser = launch(pw, headed, channel)
        ctx = browser.new_context()
        page = ctx.new_page()
        step = "open the studio"
        try:
            # ?test=1 installs the capture hooks.
            page.goto(f"{host}/?test=1", wait_until="domcontentloaded")
            page.wait_for_function("!!document.querySelector('petri-note')?._project", timeout=15_000)
            step = "load the test hooks (?test=1)"
            page.wait_for_function("window.__pnTestHooksLoaded === true", timeout=10_000)
            # Let the boot path (generate -> project-sync) settle first: a Play pressed while it
            # is still running can be undone on the page while the engine keeps playing.
            page.wait_for_timeout(2000)
            step = f"generate {spec.track}"
            genre, seed = spec.track.split(":")
            page.evaluate(
                """([genre, seed]) => {
                    const el = document.querySelector('petri-note');
                    window.__pnTrackBefore = el._project;
                    const params = { seed };
                    el._currentGen = { genre, params: { ...params } };
                    el._sendWs({ type: 'generate', genre, params });
                }""", [genre, int(seed)])
            page.wait_for_function(
                "(g) => { const el = document.querySelector('petri-note'); return el._project !== window.__pnTrackBefore && el._waveProject && String(el._project.name || '').startsWith(g); }",
                arg=genre, timeout=15_000)
            page.wait_for_timeout(1500)
            step = "play (ticks reach the page)"
            # A generate can start playback by itself; only press Play when it has not.
            page.evaluate("() => { const el = document.querySelector('petri-note'); if (!el._playing) el.querySelector('.pn-play')?.click(); }")
            # The engine must exist (and play) before the capture hooks onto it.
            page.wait_for_function(
                "(() => { const el = document.querySelector('petri-note'); return el._playing && el._tick > 4; })()",
                timeout=15_000)
            step = "start the capture"
            page.evaluate("async () => { await document.querySelector('petri-note')._wave; await window.__pnTestCaptureStart(); }")
            step = "fire and capture"
            page.wait_for_timeout(int(spec.pre_s * 1000) + 200)

            opts = {"duration": spec.duration} if spec.duration is not None else {}
            fired_at = page.evaluate(
                """([id, opts]) => {
                    const el = document.querySelector('petri-note');
                    const f = window.__pnTestMark('fire');
                    const bpm = el._tempo;
                    el._fireMacro(id, opts);
                    return { frame: f, bpm };
                }""",
                [spec.macro_id, opts],
            )
            fire, bpm = fired_at["frame"], fired_at["bpm"]
            # Wait for the engine to restore it (or give up), then the post window.
            deadline = time.time() + spec.max_s
            while time.time() < deadline:
                if page.evaluate("(id) => window.__pnTestEvents().some(e => e.type === 'macro-restored' && e.id === id)",
                                 spec.macro_id):
                    break
                page.wait_for_timeout(100)
            page.wait_for_timeout(int((spec.settle_s + spec.post_s) * 1000) + 300)

            payload = page.evaluate("async () => await window.__pnTestCaptureStop()")
            sr = int(payload["sampleRate"])
            mono = np.frombuffer(base64.b64decode(payload["data"]), dtype=np.float32)
            events = payload.get("events") or []
            if dump_dir:
                dump_dir.mkdir(parents=True, exist_ok=True)
                mono.tofile(dump_dir / f"{spec.macro_id}.f32")
                (dump_dir / f"{spec.macro_id}.json").write_text(json.dumps(
                    {"track": spec.track, "sampleRate": sr, "fire": int(fire), "events": events}))
            out = analyze(spec, mono, sr, int(fire), events, float(bpm) if bpm else None)
            out["events"] = [{k: e.get(k) for k in ("type", "id", "source", "result", "mask", "bpm") if e.get(k) is not None}
                             for e in events][:12]
            if not out["passed"]:
                _maybe_dump(spec, mono, sr, debug_dir, keep_audio, out)
            return out
        except Exception as e:
            out["reason"] = f"runtime error ({step}): {e}"
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
    ap.add_argument("--host", default="http://localhost:18097",
                    help="Studio URL (default: http://localhost:18097)")
    ap.add_argument("--workers", type=int, default=4,
                    help="Parallel browsers (default: 4)")
    ap.add_argument("--macros", nargs="+", default=DEFAULT_MACROS,
                    help=f"Subset of macros to test. Available: {', '.join(SPECS)}")
    ap.add_argument("--headed", action="store_true",
                    help="Run with a visible browser (debug)")
    ap.add_argument("--channel", default=None,
                    help="Playwright browser channel (e.g. chrome); default: bundled Chromium, else chrome")
    ap.add_argument("--track", default=None,
                    help="genre:seed for every selected macro (e.g. house:7), instead of each spec's")
    ap.add_argument("--dump-dir", default=None,
                    help="Write every capture as <macro>.f32 (mono f32) + <macro>.json (fire frame, events)")
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
    if args.track:
        if ":" not in args.track:
            print("--track is genre:seed", file=sys.stderr)
            sys.exit(2)
        specs = [dataclasses.replace(s, track=args.track) for s in specs]
    dump_dir = Path(args.dump_dir).resolve() if args.dump_dir else None

    started = time.time()
    print(f"running {len(specs)} macro test(s) with {args.workers} workers against {args.host}")

    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {
            pool.submit(run_one, s, args.host, args.headed, args.channel, debug_dir, args.keep_failed_audio, dump_dir): s
            for s in specs
        }
        for fut in concurrent.futures.as_completed(futures):
            res = fut.result()
            results.append(res)
            tag = "PASS" if res["passed"] else "FAIL"
            print(f"  [{tag}] {res['macro_id']}: {res['reason']}")
            if not res["passed"] and res.get("events") is not None:
                print(f"         events: {res['events']}")

    elapsed = time.time() - started
    n_pass = sum(1 for r in results if r["passed"])
    print(f"\n{n_pass}/{len(results)} passed in {elapsed:.1f}s")
    if n_pass != len(results):
        sys.exit(1)


if __name__ == "__main__":
    main()

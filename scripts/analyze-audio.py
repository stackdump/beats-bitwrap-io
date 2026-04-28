#!/usr/bin/env python3
"""Audio quality analyzer for beats-bitwrap-io renders.

Decodes each .webm via ffmpeg → mono float32 @ 44.1k, applies a 30 Hz
4th-order Butterworth HPF before band-ratio computation (so DC + sub
rumble doesn't dominate the bass-band bin), and emits a
BeatsAudioAnalysis JSON-LD envelope per file. See
public/schema/beats-audio-analysis.schema.json for the contract.

Pipeline:

    prod data/audio/YYYY/MM/{cid}.webm
        │  scp (or PUT /audio/{cid}.webm + GET back)
        ▼
    local .webm
        │  ffmpeg → mono 44.1k float32
        ▼
    librosa + pyloudnorm + scipy
        │  BeatsAudioAnalysis JSON-LD per CID
        ▼
    stdout (one envelope per line) + optional PUT /api/analysis/{cid}

Outputs:
  - per-track JSON-LD envelope (one object per line) on stdout
  - per-genre means markdown table on stderr (when ≥1 file per genre)
  - optional: PUT each envelope to {host}/api/analysis/{cid} when
    --upload is set (requires --secret or BEATS_REBUILD_SECRET)

The means table is the read-it-by-eye summary. Per-track JSON is what
the API stores and what the schema validates.

Required deps (one-time):
  pip install librosa pyloudnorm numpy scipy

Usage:
  python3 scripts/analyze-audio.py /tmp/beats-analysis/*/*.webm
  python3 scripts/analyze-audio.py --upload \\
      --host https://beats.bitwrap.io \\
      --secret "$(ssh pflow.dev cat ~/Workspace/beats-bitwrap-io/data/.rebuild-secret)" \\
      /tmp/beats-analysis/*/*.webm

Layout convention: when files are pulled into
{root}/{genre}/{cid}.webm, the genre is read from the parent dir.
Useful for reading the means table broken down by genre. With a flat
input layout the means table collapses into one row.
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
from collections import defaultdict

import numpy as np
from scipy.signal import butter, filtfilt
import librosa
import pyloudnorm as pyln


SR = 44100
HPF_HZ = 30.0
BANDS = [(20, 80), (80, 250), (250, 2000), (2000, 6000), (6000, 16000)]
BAND_LABELS = ["sub", "low", "lomid", "himid", "high"]
ANALYZER_VERSION = "analyze-audio.py@1"
SCHEMA_CONTEXT = "https://beats.bitwrap.io/schema/beats-audio-analysis.context.jsonld"


def decode(path):
    """Decode any ffmpeg-readable file to mono float32 @ 44.1k."""
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path,
         "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"],
        capture_output=True, check=True,
    )
    return np.frombuffer(proc.stdout, dtype=np.float32).copy()


def hpf(y, fs=SR, cutoff=HPF_HZ, order=4):
    b, a = butter(order, cutoff / (fs / 2), btype="hp")
    return filtfilt(b, a, y).astype(np.float32)


def band_ratios(y, fs=SR):
    n = len(y)
    n_fft = 1 << (n - 1).bit_length() if n < (1 << 20) else (1 << 20)
    spec = np.abs(np.fft.rfft(y[:n_fft], n=n_fft)) ** 2
    freqs = np.fft.rfftfreq(n_fft, d=1.0 / fs)
    total = spec.sum()
    if total <= 0:
        return [0.0] * len(BANDS)
    out = []
    for lo, hi in BANDS:
        mask = (freqs >= lo) & (freqs < hi)
        out.append(float(spec[mask].sum() / total))
    return out


def analyze(path):
    """Returns a BeatsAudioAnalysis envelope dict (sans @context/@type)."""
    cid = os.path.splitext(os.path.basename(path))[0]
    genre = os.path.basename(os.path.dirname(path))
    y = decode(path)
    dur = len(y) / SR
    meter = pyln.Meter(SR)
    try:
        lufs = float(meter.integrated_loudness(y.astype(np.float64)))
    except Exception:
        lufs = float("nan")
    peak = float(np.max(np.abs(y))) if len(y) else 0.0
    rms = float(np.sqrt(np.mean(y * y))) if len(y) else 0.0
    crest_db = (20 * np.log10(peak / rms)) if rms > 0 else float("nan")
    centroid = float(librosa.feature.spectral_centroid(y=y, sr=SR).mean())
    rolloff = float(librosa.feature.spectral_rolloff(y=y, sr=SR, roll_percent=0.85).mean())
    onsets = librosa.onset.onset_detect(y=y, sr=SR, units="time")
    onset_rate = float(len(onsets) / dur) if dur > 0 else 0.0
    try:
        bpm, _ = librosa.beat.beat_track(y=y, sr=SR)
        bpm = float(np.atleast_1d(bpm).flat[0])
    except Exception:
        bpm = float("nan")
    bands = band_ratios(hpf(y))

    def maybe(v):
        return None if (v is None or (isinstance(v, float) and (v != v))) else round(float(v), 4)

    return {
        # carried alongside the envelope but not part of the schema —
        # used by the means table only:
        "_genre": genre,
        # canonical fields:
        "cid": cid,
        "analyzerVersion": ANALYZER_VERSION,
        "analyzedAt": int(time.time() * 1000),
        "source": "analyzer",
        "durationS": round(dur, 2),
        "lufs": round(lufs, 2) if not np.isnan(lufs) else None,
        "peak": maybe(peak),
        "rms": maybe(rms),
        "crestDb": round(crest_db, 2) if not np.isnan(crest_db) else None,
        "centroidHz": round(centroid, 1),
        "rolloff85Hz": round(rolloff, 1),
        "onsetRate": round(onset_rate, 3),
        "bpm": round(bpm, 1) if not np.isnan(bpm) else None,
        **{f"band{lbl[:1].upper() + lbl[1:]}": round(v, 4) for lbl, v in zip(BAND_LABELS, bands)},
        "hpfHz": HPF_HZ,
    }


def envelope(record):
    out = {
        "@context": SCHEMA_CONTEXT,
        "@type": "BeatsAudioAnalysis",
    }
    for k, v in record.items():
        if k.startswith("_") or v is None:
            continue
        out[k] = v
    return out


def upload(host, secret, env):
    cid = env["cid"]
    body = json.dumps(env).encode("utf-8")
    req = urllib.request.Request(
        f"{host.rstrip('/')}/api/analysis/{cid}",
        data=body,
        method="PUT",
        headers={
            "Content-Type": "application/ld+json",
            "X-Rebuild-Secret": secret,
        },
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.status


def print_means(rows):
    by_genre = defaultdict(list)
    for r in rows:
        by_genre[r.get("_genre") or "(all)"].append(r)
    keys = ["durationS", "lufs", "crestDb", "centroidHz", "rolloff85Hz",
            "onsetRate", "bpm", "bandSub", "bandLow", "bandLomid",
            "bandHimid", "bandHigh"]
    print("| genre | n | dur | LUFS | crest | centroid | rolloff85 | onset/s | BPM | sub | low | lomid | himid | high |", file=sys.stderr)
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|", file=sys.stderr)
    for genre in sorted(by_genre):
        rs = by_genre[genre]
        means = {}
        for k in keys:
            vs = [r[k] for r in rs if r.get(k) is not None]
            means[k] = (sum(vs) / len(vs)) if vs else None

        def fmt(v, p=2):
            return "—" if v is None else (f"{v:.{p}f}" if isinstance(v, float) else f"{v}")

        print(
            f"| {genre} | {len(rs)} | {fmt(means['durationS'],0)}s | "
            f"{fmt(means['lufs'],1)} | {fmt(means['crestDb'],1)} | "
            f"{fmt(means['centroidHz'],0)} Hz | {fmt(means['rolloff85Hz'],0)} Hz | "
            f"{fmt(means['onsetRate'],2)} | {fmt(means['bpm'],0)} | "
            f"{fmt(means['bandSub'],3)} | {fmt(means['bandLow'],3)} | "
            f"{fmt(means['bandLomid'],3)} | {fmt(means['bandHimid'],3)} | "
            f"{fmt(means['bandHigh'],3)} |",
            file=sys.stderr,
        )


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="+", help="Audio files to analyze (.webm, .wav, anything ffmpeg can decode)")
    ap.add_argument("--upload", action="store_true",
                    help="PUT each envelope to {host}/api/analysis/{cid}")
    ap.add_argument("--host", default=os.environ.get("BEATS_HOST", "https://beats.bitwrap.io"),
                    help="Base URL when --upload is set")
    ap.add_argument("--secret", default=os.environ.get("BEATS_REBUILD_SECRET", ""),
                    help="X-Rebuild-Secret for upload (or BEATS_REBUILD_SECRET env)")
    args = ap.parse_args()

    if args.upload and not args.secret:
        ap.error("--upload requires --secret or BEATS_REBUILD_SECRET")

    rows = []
    for p in args.paths:
        try:
            r = analyze(p)
        except Exception as e:
            print(json.dumps({"path": p, "error": str(e)}))
            continue
        rows.append(r)
        env = envelope(r)
        print(json.dumps(env))
        if args.upload:
            try:
                upload(args.host, args.secret, env)
            except Exception as e:
                print(f"upload {r['cid']}: {e}", file=sys.stderr)
    if rows:
        print_means(rows)


if __name__ == "__main__":
    main()

#!/usr/bin/env bash
#
# Headless macro->audio verification, dependency-bootstrapped.
#
# This is the on-demand runner for the suite behind `make test-audio`. The
# audio tests are browser/realtime-bound (each Chromium tab plays the track
# at 1x wall time and captures Tone.js PCM), so they are deliberately NOT
# wired into CI — run this before a deploy, or after touching macros / the
# tone engine / the generator.
#
# What it does:
#   1. Installs the Python deps (playwright + numpy; scipy is documented in
#      the script's header but not actually imported).
#   2. Installs the Chromium browser Playwright drives.
#   3. Runs `make test-audio`, which builds the Go binary, boots a local
#      authoring server, and runs scripts/test-macro-audio.py across N
#      parallel tabs.
#
# Requires: go (with go-pflow checked out as ../go-pflow, per the go.mod
# replace), python3 + pip, and on a fresh box the Chromium system libs
# (re-run with WITH_DEPS=1 to let Playwright apt-install them; needs sudo).
#
# Usage:
#   scripts/run-audio-tests.sh              # 4 workers (default)
#   scripts/run-audio-tests.sh 8            # 8 workers
#   WITH_DEPS=1 scripts/run-audio-tests.sh  # also apt-install Chromium libs
#   TEST_AUDIO_ARGS="--macros sweep-lp cut" scripts/run-audio-tests.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."

WORKERS="${1:-4}"

echo "==> Installing Python deps (playwright, numpy)"
pip install --quiet --upgrade playwright numpy

echo "==> Installing Chromium for Playwright"
if [ "${WITH_DEPS:-0}" = "1" ]; then
  playwright install --with-deps chromium
else
  playwright install chromium
fi

echo "==> Running macro-audio suite ($WORKERS workers)"
exec make test-audio TEST_AUDIO_WORKERS="$WORKERS"

#!/usr/bin/env bash
#
# beatscript-authority.sh — the pin of beats.bitwrap.io to the BeatScript authority, and the check that it has not drifted.
#
#   scripts/beatscript-authority.sh check          offline: the code and used-terms.txt agree with beatscript-authority.lock
#   scripts/beatscript-authority.sh verify [DIR]   the lock against a beatscript checkout (default $BEATSCRIPT or ../beatscript)
#   scripts/beatscript-authority.sh status         the lock against what https://beatscript.app serves now (needs the network)
#   scripts/beatscript-authority.sh sync [DIR]     re-pin to a checkout's committed files (a deliberate act: say why in the commit)
#
# `make check-beatscript-authority` runs `check` and is part of `make test`. Why and how: docs/BEATSCRIPT-ADOPTION.md.
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-check}" in
  check) go test -count=1 ./internal/beatscript/ ;;
  verify|status|sync) exec python3 scripts/beatscript_authority.py "$@" ;;
  *) sed -n '3,9p' "$0"; exit 2 ;;
esac

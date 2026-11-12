#!/usr/bin/env bash
# Build the djrust engine as WebAssembly into public/djrust/djwasm.wasm.
#
#   scripts/build-djrust-wasm.sh            build, copy, write public/djrust/djrust.lock
#   scripts/build-djrust-wasm.sh --check    verify the .wasm on disk is the one the lock names
#
# Needs a checkout of the (private) djrust-vevr-se repo: $DJRUST_DIR, default ../djrust-vevr-se,
# and Rust with the wasm32-unknown-unknown target. The .wasm is NOT committed (it is built from a
# private engine; see docs/MIGRATION-djrust-wasm.md, "Licence and visibility"); the lock is, and
# records which djrust commit and which bytes the flag path was tested against.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
out="$here/public/djrust/djwasm.wasm"
lock="$here/public/djrust/djrust.lock"

if [ "${1:-}" = "--check" ]; then
  [ -f "$out" ] || { echo "no $out (run scripts/build-djrust-wasm.sh)"; exit 1; }
  [ -f "$lock" ] || { echo "no $lock"; exit 1; }
  want="$(sed -n 's/^sha256 //p' "$lock")"
  have="$(sha256sum "$out" | cut -d' ' -f1)"
  [ "$want" = "$have" ] && { echo "djwasm.wasm matches the lock ($(sed -n 's/^djrust //p' "$lock"))"; exit 0; }
  echo "djwasm.wasm ($have) is not the build the lock names ($want); rebuild, or accept the new lock"; exit 1
fi

djrust="${DJRUST_DIR:-$here/../djrust-vevr-se}"
[ -x "$djrust/tools/build-wasm.sh" ] || { echo "no $djrust/tools/build-wasm.sh: set DJRUST_DIR to a djrust-vevr-se checkout" >&2; exit 1; }
mkdir -p "$(dirname "$out")"
read -r commit sha bytes _ <<<"$("$djrust/tools/build-wasm.sh" "$out")"
printf 'djrust %s\nsha256 %s\nbytes %s\n' "$commit" "$sha" "$bytes" > "$lock"
echo "wrote $out ($bytes bytes, djrust $commit) and $lock"

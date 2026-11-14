#!/usr/bin/env bash
# Build the djwasm package from a djrust checkout ($DJRUST_DIR, default ../djrust; public, MIT,
# github.com/stackdump/djrust) and copy its djwasm.wasm to public/djrust/djwasm.wasm for local
# tests and offline dev. Production never builds Rust: the page fetches the pinned version from
# jsDelivr (public/djrust/pin.js).
#
#   scripts/build-djrust-wasm.sh          build + copy the .wasm (does not change the pin)
#   scripts/build-djrust-wasm.sh --pin    also re-pin to this build (pin.js + vendored glue);
#                                         publish that version (make djrust-publish) before deploy
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
djrust="${DJRUST_DIR:-$here/../djrust}"
[ -x "$djrust/cabi/build.sh" ] || { echo "no $djrust/cabi/build.sh: clone github.com/stackdump/djrust there or set DJRUST_DIR" >&2; exit 1; }
"$djrust/cabi/build.sh" >/dev/null
cp "$djrust/cabi/pkg/djwasm.wasm" "$here/public/djrust/djwasm.wasm"
echo "wrote public/djrust/djwasm.wasm ($(sha256sum "$here/public/djrust/djwasm.wasm" | cut -c1-12), djrust $(git -C "$djrust" rev-parse --short HEAD))"
if [ "${1:-}" = "--pin" ]; then node "$here/scripts/djrust-pin.mjs" pin "$djrust/cabi/pkg"; fi
node "$here/scripts/djrust-pin.mjs" check

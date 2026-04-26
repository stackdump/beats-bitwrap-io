#!/usr/bin/env bash
# Block-download the .webm render of a sealed CID. The server's GET
# /audio/{cid}.webm handler clears the WriteTimeout and waits for the
# headless render to finish (single-flight, so it coalesces with any
# in-flight render kicked off by OnSeal or POST). On a cold cid this
# can take 1-3 minutes — that's a feature, not a hang.
#
#   ./scripts/fetch-render.sh <cid> [host] [out-path]
#
#   ./scripts/fetch-render.sh z4EBG... https://beats.bitwrap.io
#   ./scripts/fetch-render.sh z4EBG... http://localhost:18090 /tmp/x.webm
set -euo pipefail
cid="${1:?usage: $0 <cid> [host] [out-path]}"
host="${2:-https://beats.bitwrap.io}"
out="${3:-/tmp/${cid}.webm}"
host="${host%/}"

curl -fsSL --max-time 600 \
  --retry 3 --retry-delay 5 --retry-all-errors \
  -o "$out" \
  -w "HTTP %{http_code}  bytes=%{size_download}  total=%{time_total}s\n" \
  "$host/audio/$cid.webm"
echo "saved: $out"

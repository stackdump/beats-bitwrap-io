#!/usr/bin/env bash
# Fails when the btw site's web page names a production host outside a comment or the mock. The host belongs in
# btwserve's -public-url, not in code: see btwsite/deploy/MIGRATION.md. (The Go server this also checked is retired.)
set -euo pipefail
cd "$(dirname "$0")/.."
bad=$(git grep -nE 'btw\.bitwrap\.io|beatscript\.app' -- 'btwsite/web/js/*.js' 'btwsite/web/index.html' \
  ':!*_test.go' | grep -vE '^[^:]+:[0-9]+:\s*(//|\*|/\*)' | grep -vE 'btwsite/web/js/wasm-mock.js' || true)
if [ -n "$bad" ]; then echo "host literal in code (use PublicURL):"; echo "$bad"; exit 1; fi
echo "no host literals"

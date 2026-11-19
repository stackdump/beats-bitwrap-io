#!/usr/bin/env bash
# Fails when a Go file of the btw site (or its web page) names a production host outside a test, a comment
# or the one default. The host belongs in -public-url, not in code: see btwsite/deploy/MIGRATION.md.
set -euo pipefail
cd "$(dirname "$0")/.."
bad=$(git grep -nE 'btw\.bitwrap\.io|beatscript\.app' -- 'internal/btwsite/**/*.go' 'btwsite/web/js/*.js' 'btwsite/web/index.html' \
  ':!*_test.go' | grep -vE '^[^:]+:[0-9]+:\s*(//|\*|/\*)' | grep -vE 'internal/btwsite/server/config.go.*PublicURL: |internal/btwsite/fakecheck/|internal/btwsite/docs/docs.go:.*ReplaceAll|btwsite/web/js/wasm-mock.js' || true)
if [ -n "$bad" ]; then echo "host literal in code (use PublicURL):"; echo "$bad"; exit 1; fi
echo "no host literals"

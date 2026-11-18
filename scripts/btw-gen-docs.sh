#!/usr/bin/env bash
# Generate btwsite/web/docs/BTW.md and btwsite/web/docs/cheatsheet.md for btw.bitwrap.io.
#
# Both come from the PRIVATE, UNLICENSED stackdump/djrust-vevr-se, and this repo is public, so they are in
# .gitignore (btwsite/DESIGN.md "Public repo"): run this before a deploy (the deploy script copies the result
# to the host) and never `git add -f` its output.
#
#   scripts/btw-gen-docs.sh                         copy docs/BTW.md; keep the cheatsheet.md that is there
#   BTWD_BIN=/path/to/btwd scripts/btw-gen-docs.sh  also write cheatsheet.md from `btwd cheatsheet`
#   BTWD_BIN=/path/to/btwd scripts/btw-gen-docs.sh --check
#                                                   change nothing; exit 1 if cheatsheet.md or BTW.md is stale
#
# Environment:
#   DJRUST_DIR  the djrust worktree with docs/BTW.md   (default ~/Workspace/.val-worktrees/djrust-vevr-se/btw-web)
#   OUT_DIR     where the files go                      (default btwsite/web/docs next to this script's repo root)
#   BTWD_BIN    the btwd binary; without it cheatsheet.md is not regenerated. If no cheatsheet.md exists at
#               all the server answers /docs/cheatsheet.md from its live btwd instead, so nothing is broken
#               by running without it.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
src=${DJRUST_DIR:-$HOME/Workspace/.val-worktrees/djrust-vevr-se/btw-web}
out=${OUT_DIR:-$root/btwsite/web/docs}
check=0
[ "${1:-}" = "--check" ] && check=1

md="$src/docs/BTW.md"
if [ ! -f "$md" ]; then
  echo "btw-gen-docs: $md not found (set DJRUST_DIR to the djrust worktree)" >&2
  exit 1
fi

stale=0
mkdir -p "$out"

# BTW.md: a verbatim copy
if [ "$check" = 1 ]; then
  cmp -s "$md" "$out/BTW.md" || { echo "btw-gen-docs: $out/BTW.md differs from $md" >&2; stale=1; }
else
  cp "$md" "$out/BTW.md.tmp" && mv "$out/BTW.md.tmp" "$out/BTW.md"
  echo "btw-gen-docs: BTW.md copied from $md ($(wc -c < "$out/BTW.md" | tr -d ' ') bytes)"
fi

# cheatsheet.md: the output of `btwd cheatsheet`, the same text the compose system prompt uses
if [ -n "${BTWD_BIN:-}" ]; then
  if [ ! -x "$BTWD_BIN" ]; then
    echo "btw-gen-docs: BTWD_BIN=$BTWD_BIN is not an executable" >&2
    exit 1
  fi
  fresh=$(mktemp "${TMPDIR:-/tmp}/btw-cheatsheet.XXXXXX")
  trap 'rm -f "$fresh"' EXIT
  "$BTWD_BIN" cheatsheet > "$fresh"
  if [ ! -s "$fresh" ]; then
    echo "btw-gen-docs: '$BTWD_BIN cheatsheet' printed nothing" >&2
    exit 1
  fi
  if [ "$check" = 1 ]; then
    cmp -s "$fresh" "$out/cheatsheet.md" || { echo "btw-gen-docs: $out/cheatsheet.md differs from a fresh '$BTWD_BIN cheatsheet'" >&2; stale=1; }
  else
    cp "$fresh" "$out/cheatsheet.md.tmp" && mv "$out/cheatsheet.md.tmp" "$out/cheatsheet.md"
    echo "btw-gen-docs: cheatsheet.md written by '$BTWD_BIN cheatsheet' ($(wc -c < "$out/cheatsheet.md" | tr -d ' ') bytes)"
  fi
elif [ -f "$out/cheatsheet.md" ]; then
  echo "btw-gen-docs: BTWD_BIN not set; kept the existing cheatsheet.md (set it to regenerate)"
else
  echo "btw-gen-docs: warning: BTWD_BIN not set and there is no cheatsheet.md; the server will answer /docs/cheatsheet.md from btwd itself" >&2
fi

exit "$stale"

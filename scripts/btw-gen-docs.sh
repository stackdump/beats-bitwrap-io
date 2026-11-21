#!/usr/bin/env bash
# Generate btwsite/web/docs/BTW.md, arrange.md and cheatsheet.md for btw.bitwrap.io.
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
#   DJRUST_DIR  the engine checkout with docs/BTW.md   (required)
#   OUT_DIR     where the files go                      (default btwsite/web/docs next to this script's repo root)
#   BTWD_BIN    the btwd binary; without it cheatsheet.md is not regenerated. If no cheatsheet.md exists at
#               all the server answers /docs/cheatsheet.md from its live btwd instead, so nothing is broken
#               by running without it.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
src=${DJRUST_DIR:?set DJRUST_DIR to the engine checkout that holds docs/BTW.md}
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

# BTW.md: the copy this site serves publicly, with local paths and private repo names removed (redact below)
redact() {
  sed -E -e 's#~/Workspace/[^ `)"]*#<local path>#g' -e 's#/Users/[^ `)"]*#<local path>#g' -e 's#/home/[A-Za-z0-9_]+/[^ `)"]*#<local path>#g' "$1"
}
if [ "$check" = 1 ]; then
  redact "$md" | cmp -s - "$out/BTW.md" || { echo "btw-gen-docs: $out/BTW.md differs from $md" >&2; stale=1; }
else
  redact "$md" > "$out/BTW.md.tmp" && mv "$out/BTW.md.tmp" "$out/BTW.md"
  echo "btw-gen-docs: BTW.md copied (paths redacted) from $md ($(wc -c < "$out/BTW.md" | tr -d ' ') bytes)"
fi

# arrange.md: the arrange-mutations page (/docs/arrange), redacted as BTW.md is
amd="$src/docs/ARRANGE.md"
if [ -f "$amd" ]; then
  if [ "$check" = 1 ]; then
    redact "$amd" | cmp -s - "$out/arrange.md" || { echo "btw-gen-docs: $out/arrange.md differs from $amd" >&2; stale=1; }
  else
    redact "$amd" > "$out/arrange.md.tmp" && mv "$out/arrange.md.tmp" "$out/arrange.md"
    echo "btw-gen-docs: arrange.md copied (paths redacted) from $amd"
  fi
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

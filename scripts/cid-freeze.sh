#!/usr/bin/env bash
#
# cid-freeze.sh — mechanical proof that no share or model CID can have moved.
#
#   scripts/cid-freeze.sh                     # against CID_FREEZE_BASE (default dde7b7b, djrust-only)
#   CID_FREEZE_BASE=<commit> scripts/cid-freeze.sh
#   make cid-freeze                           # part of make test
#
# 1. The files that decide a CID are byte-identical to the base commit, in the working tree,
#    with no new untracked files among them. These are the share collector, codec and applier,
#    the schemas, the Go seal and its embedded schema, and the generator (it decides model
#    bytes).
# 2. The canonicalisation section of public/lib/pflow.js equals the base's. That section runs
#    from "// --- Parse a net bundle from JSON ---" to EOF: parse, projectToJSON, durationSteps
#    and the model CID. It must also equal the hash recorded below. The rest of pflow.js (layout,
#    NetBundle runtime) may change.
# 3. Every examples/*.json recomputes, through public/lib/share/codec.js, to the CID recorded
#    below. Every scripts/fixtures/feed-corpus/<cid>.json recomputes to its own filename.
#
# Without git or the base commit (a shallow clone), parts 1-2 print SKIP and part 3 still runs.
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${CID_FREEZE_BASE:-dde7b7b}"
PFLOW_MARK='^// --- Parse a net bundle from JSON ---'
PFLOW_SECTION_SHA256='94f4cf9ee3bb07b33d091bb5f1c534c7ac779f6cb91aca314e14b2171490204c'
FROZEN=(
    public/lib/share/collect.js
    public/lib/share/codec.js
    public/lib/share/apply.js
    public/schema
    internal/share/seal.go
    internal/share/beats-share.schema.json
    public/lib/generator
)
fail=0
say() { printf '%s\n' "$*"; }

section() { awk -v m="$PFLOW_MARK" '$0 ~ m {p=1} p'; }

if git rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null 2>&1; then
    if git diff --quiet "$BASE" -- "${FROZEN[@]}"; then
        say "ok   CID-deciding files unchanged since $BASE (${#FROZEN[@]} paths)"
    else
        say "FAIL CID-deciding files differ from $BASE:"
        git diff --stat "$BASE" -- "${FROZEN[@]}" | sed 's/^/       /'
        fail=1
    fi
    untracked=$(git ls-files --others --exclude-standard -- "${FROZEN[@]}")
    if [ -n "$untracked" ]; then
        say "FAIL new untracked files among the CID-deciding paths:"; printf '       %s\n' $untracked; fail=1
    fi
    base_sec=$(git show "$BASE:public/lib/pflow.js" | section | sha256sum | awk '{print $1}')
    cur_sec=$(section < public/lib/pflow.js | sha256sum | awk '{print $1}')
    if [ "$cur_sec" = "$base_sec" ] && [ "$cur_sec" = "$PFLOW_SECTION_SHA256" ]; then
        say "ok   pflow.js canonicalisation section unchanged (sha256 ${cur_sec:0:16}…)"
    else
        say "FAIL pflow.js canonicalisation section: now $cur_sec, base $base_sec, recorded $PFLOW_SECTION_SHA256"
        fail=1
    fi
else
    say "SKIP git diff: base commit $BASE not available (shallow clone?); the CID recomputation below still runs"
    cur_sec=$(section < public/lib/pflow.js | sha256sum | awk '{print $1}')
    if [ "$cur_sec" = "$PFLOW_SECTION_SHA256" ]; then say "ok   pflow.js canonicalisation section = recorded hash"
    else say "FAIL pflow.js canonicalisation section: now $cur_sec, recorded $PFLOW_SECTION_SHA256"; fail=1; fi
fi

NODE_OPTIONS="${NODE_OPTIONS:-} --no-warnings" node --input-type=module - <<'EOF' || fail=1
import { readFileSync, readdirSync, existsSync } from 'node:fs';
const { computeCidForJsonLd } = await import(process.cwd() + '/public/lib/share/codec.js');
// examples/*.json → the share CID each one seals to (recorded 2026-11-14 at dde7b7b).
const EXAMPLES = {
    'hand-authored.json': 'z4EBG9j1ovJJjQRQq4V6AMMMrtSiNZBeKRqv5SNqpmzcHJdftBp',
    'macro-orchestrated.json': 'z4EBG9jFFa2K2X8RiVsZ1Goww8E1E7V79J3UmYx74Hz3xhvgQWi',
    'metronome.json': 'z4EBG9jC8AHvSdK3CdTNpM1LLq5WaoBnpyVsqngMNeLzR6ivtSw',
    'minimal.json': 'z4EBG9j8XKkZpcLnf7MXvvoqCyY5SkMVW5Z8cN6Pv9obuV8ffdx',
    'overrides.json': 'z4EBG9izcnekB5M2TZACtgQwjNe8Mi93J25qR3PQMoDoZZ8AHEt',
    'phantom-aqueduct.json': 'z4EBG9jB8umb25MjqZ5xA549aevTWWfMC2o6Zr8deNynUCAbpjs',
    'voltage-rush.json': 'z4EBG9j9LkApwGZjAWQPYYSsWyYjNetnJyWmCtRacepRLvKRFH6',
};
let bad = 0;
const have = readdirSync('examples').filter((f) => f.endsWith('.json')).sort();
for (const f of have) {
    const want = EXAMPLES[f];
    const got = await computeCidForJsonLd(JSON.parse(readFileSync(`examples/${f}`, 'utf8')));
    if (!want) { console.log(`FAIL examples/${f}: no recorded CID (got ${got}); add it to scripts/cid-freeze.sh`); bad++; }
    else if (got !== want) { console.log(`FAIL examples/${f}: CID ${got} != recorded ${want}`); bad++; }
}
for (const f of Object.keys(EXAMPLES)) if (!have.includes(f)) { console.log(`FAIL examples/${f}: recorded but missing`); bad++; }
if (!bad) console.log(`ok   ${have.length} examples/*.json recompute to their recorded share CIDs`);
const dir = 'scripts/fixtures/feed-corpus';
const feed = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
let fbad = 0;
for (const f of feed) {
    const got = await computeCidForJsonLd(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')));
    if (`${got}.json` !== f) { console.log(`FAIL ${dir}/${f}: recomputes to ${got}`); fbad++; }
}
if (!feed.length) { console.log(`FAIL ${dir}: no envelopes`); fbad++; }
else if (!fbad) console.log(`ok   ${feed.length} feed-corpus envelopes recompute to their filenames`);
process.exit(bad + fbad ? 1 : 0);
EOF

if [ "$fail" -ne 0 ]; then say ""; say "cid-freeze FAILED"; exit 1; fi
say "cid-freeze: all checks passed"

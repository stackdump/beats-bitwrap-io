#!/usr/bin/env node
//
// Live Go↔JS model-CID parity diff (go-pflow ROADMAP Phase 3).
//
// Unlike the cohesion parity test (both sides asserted against one pinned
// fixture), this runs BOTH live producers on the same input and diffs
// their output byte-for-byte:
//
//   Go: tools/parity/main.go — pflow.ParseProject → Project.CanonicalJSON
//       → Project.CID (internal/pflow/cid.go)
//   JS: public/lib/pflow.js  — parseProject → canonicalProjectJSON
//       → sha256
//
// The fixture (model.json) carries legacy ms-duration bindings,
// beat-relative durationSteps bindings, and one binding with both (steps
// must win) — so the durationSteps canonical-form rule is inside the
// diffed surface. Any divergence in parse defaults, normalization,
// canonical JSON bytes or the hash fails this test.
//
// Usage:
//   GO_MODEL_CID=<path-to-go-binary> node tools/parity/model-cid-parity.mjs
//   bazel test //tools/parity:model_cid_parity_test   (stages the go_binary)

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseProject, canonicalProjectJSON } from '../../public/lib/pflow.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const modelPath = path.join(here, 'model.json');

// --- JS side (live, in-process) ---
const data = JSON.parse(readFileSync(modelPath, 'utf8'));
const canon = canonicalProjectJSON(parseProject(data));
const cid = createHash('sha256').update(canon, 'utf8').digest('hex');
const jsOut = `${canon}\ncid:${cid}\n`;

// --- Go side (live, staged binary) ---
// Under Bazel the go_binary sits in the runfiles tree next to this
// script's package; outside Bazel the Makefile passes GO_MODEL_CID.
const candidates = [
    process.env.GO_MODEL_CID,
    path.join(here, 'parity_', 'parity'),   // bazel runfiles (go_binary //tools/parity:parity)
    'tools/parity/parity_/parity',          // runfiles-root relative fallback
].filter(Boolean);
const bin = candidates.find(p => existsSync(p));
if (!bin) {
    console.error('go parity binary not found; tried:\n  ' + candidates.join('\n  '));
    console.error('outside bazel: make test-model-parity (builds it via `go build ./tools/parity`)');
    process.exit(1);
}
const res = spawnSync(bin, [modelPath], { encoding: 'utf8' });
if (res.status !== 0) {
    console.error(`go producer failed (${res.status}):\n${res.stderr}`);
    process.exit(1);
}
const goOut = res.stdout;

// --- Byte-for-byte diff ---
if (goOut !== jsOut) {
    const goLines = goOut.split('\n');
    const jsLines = jsOut.split('\n');
    console.error('model-CID parity FAILED — live Go and live JS disagree:');
    for (let i = 0; i < Math.max(goLines.length, jsLines.length); i++) {
        if (goLines[i] !== jsLines[i]) {
            console.error(`line ${i + 1}:\n  go: ${goLines[i]}\n  js: ${jsLines[i]}`);
        }
    }
    process.exit(1);
}

console.log(`ok  model-CID parity: live Go and live JS agree byte-for-byte (cid:${cid})`);

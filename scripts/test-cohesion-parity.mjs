#!/usr/bin/env node
//
// Cohesion v2 — JS↔Go motif parity check.
//
// Runs the browser-side buildTrackTheme() against the same pinned fixture
// that internal/generator/theme_parity_test.go::TestPinnedMotifVectorTechnoSeed42
// asserts on the Go side. Both must produce byte-identical
// (degrees, mask, contour) for the same (genre, seed) or shared
// `cohesion: "v2"` envelopes will play different motifs depending on whether
// the listener hits a Go-composed audio (authoring server) or a JS-composed
// audio (prod static-host playback).
//
// Usage:
//   node scripts/test-cohesion-parity.mjs
//   make test-cohesion-parity         # via Makefile target

import { buildTrackTheme } from '../public/lib/generator/theme.js';
import { compose } from '../public/lib/generator/composer.js';

const expected = {
    degrees: [
        0, -1, -1, 0, 0, -1, -1, -1, 0, -1, -1, 0, 0, -1, -1, -1,
        1, -1, -1, -1, 1, -1, 0, 0, 1, -1, -1, 0, 1, 1, -1, -1,
        0, -1, -1, -1, 0, -1, -1, -1, 0, -1, 2, 0, 0, -1, -1, 0,
        1, 0, -1, 2, 3, -1, -1, -1, 3, -1, 5, -1, 6, 0, -1, -1,
    ],
    mask: [
        true, false, false, true, true, false, false, false, true, false, false, true, true, false, false, false,
        true, false, false, false, true, false, true, true, true, false, false, true, true, true, false, false,
        true, false, false, false, true, false, false, false, true, false, true, true, true, false, false, true,
        true, true, false, true, true, false, false, false, true, false, true, false, true, true, false, false,
    ],
    contour: 0,
};

const got = buildTrackTheme('techno', 42).motif;

function eq(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

let pass = true;
if (!eq(got.degrees, expected.degrees)) {
    pass = false;
    console.error(`degrees drift:\n got: ${JSON.stringify(got.degrees)}\nwant: ${JSON.stringify(expected.degrees)}`);
}
if (!eq(got.mask, expected.mask)) {
    pass = false;
    console.error(`mask drift:\n got: ${JSON.stringify(got.mask)}\nwant: ${JSON.stringify(expected.mask)}`);
}
if (got.contour !== expected.contour) {
    pass = false;
    console.error(`contour drift: got=${got.contour} want=${expected.contour}`);
}

if (!pass) {
    console.error(`\nIf this drift was intentional, regenerate the fixture in BOTH places:`);
    console.error(`  internal/generator/theme_parity_test.go::pinnedTechno42Motif`);
    console.error(`  scripts/test-cohesion-parity.mjs::expected`);
    process.exit(1);
}

console.log('ok  cohesion v2 motif parity (techno seed=42): JS matches Go fixture');

// --- Compose parity: JS-side v2 must produce a parallel project shape to
// Go-side v2 for the same inputs. We can't byte-compare because the JS
// composer rolls in some extra naming and the Go binary isn't available
// here as a library, but we CAN structurally pin the things that matter
// for the cohesion contract: cohesion flag, feel-curve presence, motif-
// length melody slots, and groove-locked bass slot hit count.
const proj = compose('techno', { seed: 7, cohesion: 'v2', structure: 'standard' });
const checks = [
    ['cohesion = "v2"',         proj.cohesion === 'v2'],
    ['feel-curve net present',  'feel-curve' in proj.nets],
    ['cohesion flag round-trip', proj.cohesion === 'v2'],
];
// Default-on contract: no cohesion param → v2 for supported genres,
// explicit 'v1' → legacy (no stamp, no pad).
const projDefault = compose('techno', { seed: 7 });
checks.push(['default (absent param) = v2', projDefault.cohesion === 'v2']);
const projV1 = compose('techno', { seed: 7, cohesion: 'v1' });
checks.push(['explicit v1 = legacy (no stamp)', !projV1.cohesion]);
checks.push(['explicit v1 has no chord pad', !projV1.nets.harmony]);
const melodySlots = Object.keys(proj.nets).filter(k => k.startsWith('melody-'));
checks.push(['melody slots > 0', melodySlots.length > 0]);
for (const k of melodySlots) {
    const p = Object.keys(proj.nets[k].places).length;
    // Slice 2: each melody slot is a 4-bar motif (64) or augmented (128).
    if (p !== 64 && p !== 128) {
        checks.push([`${k} place count is motif-shaped (got ${p}, want 64/128)`, false]);
    }
}
const bassSlots = Object.keys(proj.nets).filter(k => k.startsWith('bass-'));
checks.push(['bass slots > 0', bassSlots.length > 0]);
for (const k of bassSlots) {
    const hits = Object.values(proj.nets[k].bindings).filter(Boolean).length;
    // Slice 2: FourOnFloor bar mask (4 hits) x 4-bar chord cycle = 16.
    if (hits !== 16) {
        checks.push([`${k} hit count locks to kick x cycle (got ${hits} want 16)`, false]);
    }
    // Bass walks chord roots — techno i-VII-i-VII has 2 distinct pitches.
    const pitches = new Set(Object.values(proj.nets[k].bindings).map(b => b.note));
    if (pitches.size < 2) {
        checks.push([`${k} walks chord roots (got ${pitches.size} distinct pitches)`, false]);
    }
}
// Slice 2: harmony pad present, 12 bindings (4 chords x 3 tones).
checks.push(['harmony pad present', 'harmony' in proj.nets ||
    Object.keys(proj.nets).some(k => k === 'harmony')]);
if (proj.nets.harmony) {
    const padBindings = Object.values(proj.nets.harmony.bindings).filter(Boolean).length;
    checks.push([`harmony pad voices 12 notes (got ${padBindings})`, padBindings === 12]);
}

let composeFail = false;
for (const [label, ok] of checks) {
    if (!ok) {
        composeFail = true;
        console.error('FAIL ' + label);
    }
}
if (composeFail) {
    console.error('\nJS compose() produced a project that does not match the cohesion v2 contract.');
    process.exit(1);
}
console.log('ok  cohesion v2 compose parity (techno seed=7): JS contract holds');

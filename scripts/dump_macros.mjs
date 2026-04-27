#!/usr/bin/env node
// Imports the catalog as ES modules and prints a JSON dump of MACROS
// (with the `targets` function dropped — Python doesn't need to know
// which net IDs each macro picks at runtime, only the static shape).
// Run from repo root: node scripts/dump_macros.mjs > /tmp/macros.json
//
// The Python diagram script (draw_macro_category.py) consumes this.

import { MACROS } from '../public/lib/macros/catalog.js';

const out = MACROS.map(m => {
    const copy = { ...m };
    // Functions don't survive JSON; strip them.
    if (typeof copy.targets === 'function') copy.targets = '<runtime>';
    return copy;
});
process.stdout.write(JSON.stringify(out, null, 2) + '\n');

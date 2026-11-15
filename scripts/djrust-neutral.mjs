#!/usr/bin/env node
//
// djrust-neutral.mjs — the golden corpus again, with every new control the module exposes sent
// at its neutral value. It must reproduce scripts/djrust-golden.json exactly. This catches a
// control whose default is not idle.
//
//   node scripts/djrust-neutral.mjs [--wasm P] [--only RE] [--rate SR] [--skip-missing]
//   node scripts/djrust-neutral.mjs --perturb [--only RE]   # self-test: a 1e-4 tempo nudge MUST fail
//   make test-djrust-neutral
//
// Exports are feature-detected by name, so the pass grows with each release, and a control the
// module lacks is skipped and listed. djwasm 0.2.0 has none of them. On 0.2.0 this pass is the
// golden check plus calls to read-only probes that do not exist.
//
// The neutral set follows the plan's abi_changes (0.3.0 / 0.4.0 / 0.5.0):
//   init      djw_init_with(sr, DJW_GROOVE) in place of djw_init, then djw_set_groove(0, 0)
//   stopped   djw_seek(0) before play (the current tick, while stopped); djw_set_loop(-1, -1)
//   always    djw_set_transpose(0); djw_set_net_transpose(<first net>, 0);
//             djw_set_voice(ch, k, NaN) for k = 0..15 on every channel, then djw_reset_voice(ch);
//             djw_fx(k, <beats fx default>) for k = 0..13, then djw_fx_reset();
//             djw_set_control_macros(1) with djw_set_macro_disabled(id, 1) for every catalog id
//             (and every fire-macro id the project's control nets name);
//             djw_panic() with nothing running; djw_fire_macro('bogus', -1) must return < 0
//   reads     djw_frame, djw_macro_mask, djw_tempo, djw_event_count every quantum, and
//             djw_events whenever the count is > 0
// "always" runs after load (before play) and again at quantum 200, while playing.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveModule, readGolden, corpus, renderCase, STREAMS, GOLDEN_PATH, missingModule } from './djrust-golden.mjs';
import { MACROS } from '../public/lib/macros/catalog.js';

const DJW_GROOVE = 1;
// MasterFxKey order then AuxFxKey order (abi_changes djw_fx), at beats' factory defaults
// (lib/ui/build.js fxDefaults).
const FX_KEYS = ['hp-freq', 'lp-freq', 'phaser-freq', 'phaser-depth', 'phaser-wet', 'crush-bits', 'distortion', 'master-pitch',
    'reverb-size', 'reverb-damp', 'reverb-wet', 'delay-time', 'delay-feedback', 'delay-wet'];
const FX_DEFAULTS = {
    'reverb-size': 50, 'reverb-damp': 30, 'reverb-wet': 20, 'delay-time': 25, 'delay-feedback': 25, 'delay-wet': 15,
    'distortion': 0, 'hp-freq': 0, 'lp-freq': 100, 'phaser-freq': 0, 'phaser-depth': 50, 'phaser-wet': 0,
    'crush-bits': 0, 'master-pitch': 0,
};
const VOICE_KEYS = 16;
const MID_QUANTUM = 200;

const CONTROLS = ['djw_init_with', 'djw_set_groove', 'djw_seek', 'djw_set_loop', 'djw_set_transpose', 'djw_set_net_transpose',
    'djw_set_voice', 'djw_reset_voice', 'djw_fx', 'djw_fx_reset', 'djw_set_control_macros', 'djw_set_macro_disabled',
    'djw_panic', 'djw_fire_macro'];
const READS = ['djw_frame', 'djw_macro_mask', 'djw_tempo', 'djw_event_count', 'djw_events'];

/** Pass `text` to an export taking (ptr, len, ...rest), as loader.js _withText does. */
function withText(dj, text, fn) {
    return dj._withText(text, fn);
}

function macroIds(dj, projectText) {
    const ids = new Set(MACROS.map((m) => m.id));
    if (dj.x.djw_keys) {
        try {
            if (dj.x.djw_keys() > 0) {
                const k = JSON.parse(dj._out());
                for (const id of k.macros || k.macroIds || []) ids.add(typeof id === 'string' ? id : id.id);
            }
        } catch { /* a module without the table still gets the catalog ids */ }
    }
    const proj = JSON.parse(projectText);
    for (const net of Object.values(proj.nets || {})) {
        for (const t of Object.values(net.transitions || {})) {
            const c = t.control;
            if (c && c.action === 'fire-macro') for (const k of ['macro', 'macroId', 'targetNet']) if (c[k]) ids.add(c[k]);
        }
    }
    return [...ids];
}

function makeHooks(sr, built, used, { perturb }) {
    const proj = JSON.parse(built.text);
    const netIds = Object.keys(proj.nets || {});
    const channels = [...new Set(Object.values(proj.nets || {}).map((n) => n.track && n.track.channel).filter((c) => Number.isInteger(c)))];
    const has = (dj, name) => typeof dj.x[name] === 'function';
    const call = (dj, name, ...args) => { used.add(name); return dj.x[name](...args); };

    const always = (dj) => {
        if (has(dj, 'djw_set_transpose')) call(dj, 'djw_set_transpose', 0);
        if (has(dj, 'djw_set_net_transpose') && netIds.length) {
            used.add('djw_set_net_transpose');
            withText(dj, netIds[0], (p, n) => dj.x.djw_set_net_transpose(p, n, 0));
        }
        if (has(dj, 'djw_set_voice')) for (const ch of channels) for (let k = 0; k < VOICE_KEYS; k++) call(dj, 'djw_set_voice', ch, k, NaN);
        if (has(dj, 'djw_reset_voice')) for (const ch of channels) call(dj, 'djw_reset_voice', ch);
        if (has(dj, 'djw_fx')) FX_KEYS.forEach((k, i) => call(dj, 'djw_fx', i, FX_DEFAULTS[k]));
        if (has(dj, 'djw_fx_reset')) call(dj, 'djw_fx_reset');
        if (has(dj, 'djw_set_control_macros')) {
            if (has(dj, 'djw_set_macro_disabled')) {
                used.add('djw_set_macro_disabled');
                for (const id of macroIds(dj, built.text)) withText(dj, id, (p, n) => dj.x.djw_set_macro_disabled(p, n, 1));
            }
            call(dj, 'djw_set_control_macros', 1);
        }
        if (has(dj, 'djw_panic')) call(dj, 'djw_panic');
        if (has(dj, 'djw_fire_macro')) {
            used.add('djw_fire_macro');
            const rc = withText(dj, 'bogus', (p, n) => dj.x.djw_fire_macro(p, n, -1));
            if (!(rc < 0)) throw new Error(`djw_fire_macro('bogus') returned ${rc}, expected an error code`);
        }
        if (has(dj, 'djw_set_groove')) call(dj, 'djw_set_groove', 0, 0);
        if (has(dj, 'djw_set_loop')) call(dj, 'djw_set_loop', -1, -1);
    };

    return {
        afterInit(dj) {
            if (has(dj, 'djw_init_with')) {
                used.add('djw_init_with');
                if (typeof dj.initWith === 'function') dj.initWith(sr, DJW_GROOVE);
                else {
                    const n = dj.x.djw_init_with(sr, DJW_GROOVE);
                    if (n < 0) throw new Error(`djw_init_with ${n}`);
                    dj.maxBlock = n; dj._buf = null; // the loader's cached block views
                }
            }
        },
        afterLoad(dj) {
            always(dj);
        },
        beforePlay(dj) {
            if (has(dj, 'djw_seek')) call(dj, 'djw_seek', 0);
            if (has(dj, 'djw_set_loop')) call(dj, 'djw_set_loop', -1, -1);
        },
        atQuantum(dj, q) {
            if (q === MID_QUANTUM) {
                always(dj);
                if (perturb) dj.setTempo(dj.tempo * 1.0001);
            }
            // Read probes (not counted as controls): djw_tempo is ABI-1, the rest arrive in 0.3.0.
            for (const r of ['djw_frame', 'djw_macro_mask', 'djw_tempo']) if (has(dj, r)) dj.x[r]();
            if (has(dj, 'djw_event_count') && dj.x.djw_event_count() > 0 && has(dj, 'djw_events')) dj.x.djw_events();
        },
    };
}

async function main(argv) {
    const a = {};
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--wasm') a.wasm = argv[++i];
        else if (k === '--only') a.only = new RegExp(argv[++i]);
        else if (k === '--rate') a.rate = Number(argv[++i]);
        else if (k === '--skip-missing') a.skipMissing = true;
        else if (k === '--perturb') a.perturb = true;
        else { console.error(`unknown argument ${k}`); return 2; }
    }
    const mod = await resolveModule(a.wasm || process.env.DJRUST_WASM);
    if (!mod) return missingModule('djrust-neutral', a.wasm, a.skipMissing);
    const golden = readGolden();
    const exportsHave = new Set(Object.keys(new WebAssembly.Instance(mod.module, {}).exports));
    const present = CONTROLS.filter((n) => exportsHave.has(n));
    const absent = CONTROLS.filter((n) => !exportsHave.has(n));
    const reads = READS.filter((n) => exportsHave.has(n));
    console.log(`djrust-neutral: ${mod.wasmPath} (sha256 ${mod.sha256.slice(0, 16)}…) against ${GOLDEN_PATH.replace(/.*\/scripts\//, 'scripts/')}`);
    console.log(`     neutral controls present: ${present.length ? present.join(' ') : '(none)'}`);
    console.log(`     absent (skipped):         ${absent.length ? absent.join(' ') : '(none)'}`);
    console.log(`     read probes present:      ${reads.length ? reads.join(' ') : '(none)'}`);
    if (a.perturb) console.log('     --perturb: tempo × 1.0001 at quantum 200 — every case that plays past it MUST fail');

    const t0 = Date.now();
    const used = new Set();
    let n = 0, bad = 0;
    const fails = [];
    for (const c of await corpus()) {
        if (a.only && !a.only.test(c.id)) continue;
        const built = c.build();
        for (const sr of c.rates) {
            if (a.rate && sr !== a.rate) continue;
            const key = `${c.id}@${sr}`;
            const want = golden.cases[key];
            if (!want) { fails.push(`${key}: not in the golden`); bad++; continue; }
            let got;
            try {
                got = renderCase(mod, c, sr, { built, hooks: makeHooks(sr, built, used, a) });
            } catch (err) {
                fails.push(`${key}: ${err.message}`); bad++; continue;
            }
            n++;
            const diff = STREAMS.filter((s) => got[s] !== want[s]);
            if (diff.length) { fails.push(`${key}: ${diff.join(', ')} differ`); bad++; }
        }
    }
    for (const f of fails.slice(0, 30)) console.log(`${a.perturb ? 'diff' : 'FAIL'} ${f}`);
    if (fails.length > 30) console.log(`     … ${fails.length - 30} more`);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (a.perturb) {
        const ok = bad === n && n > 0;
        console.log(ok ? `ok   the perturbation was caught on all ${n} renders — ${secs} s`
            : `FAIL the perturbation was caught on ${bad} of ${n} renders: the comparison cannot fail where it should`);
        return ok ? 0 : 1;
    }
    console.log(bad
        ? `\n${bad} of ${n} renders differ from djwasm@${golden.module.version} with every control neutral — ${secs} s`
        : `ok   ${n} renders with ${used.size} neutral control(s) sent reproduce djwasm@${golden.module.version} — ${secs} s`);
    return bad ? 1 : 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2)).then((rc) => process.exit(rc), (err) => { console.error(err); process.exit(1); });

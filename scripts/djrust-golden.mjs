#!/usr/bin/env node
//
// djrust-golden.mjs — the frozen djwasm 0.2.0 baseline, and the gate that holds every later
// module to it.
//
//   node scripts/djrust-golden.mjs make  [--wasm P] [--force]   # write scripts/djrust-golden.json
//   node scripts/djrust-golden.mjs check [--wasm P] [--only RE] [--rate SR] [--skip-missing]
//   node scripts/djrust-golden.mjs props [--wasm P]             # re-measure the properties only
//   node scripts/djrust-golden.mjs list                         # the corpus, one case per line
//   node scripts/djrust-golden.mjs note <key> <json>            # record a measured property
//   make test-djrust-golden                                     # = check --skip-missing
//
// The module comes from --wasm, else $DJRUST_WASM, else public/djrust/djwasm.wasm. Each of
// those may be a .wasm file or a package directory (djrust cabi/pkg: djwasm.wasm + loader.js +
// worklet.js). For a directory, that package's own loader.js and worklet.js are used. `make`
// refuses a module whose sha256 is not public/djrust/pin.js's, unless --force is given.
//
// Every case runs only the ABI-1 call sequence that 0.2.0 has: init(sr), load(json),
// setMute/setTempo, play(), and then process(128) on every quantum. A live script
// (djrust-script.mjs) adds load/tempo/mute/transport messages at fixed quanta. Neither ever
// calls a feature export. So a newer module that renders the same bytes on this sequence has
// not changed the default path.
//
// Per case and sample rate, the file stores the sha256 of these streams:
//   audio    interleaved little-endian f32, L R L R ..., every frame rendered;
//   ticks    the int32 LE return value of every process() call (ticks begun in that block);
//   report   the raw out-buffer bytes of djw_report() + "\n", for every block that ticked;
//   marking  the same for djw_marking();
//   muted    the same for djw_muted().
// It also stores `project`, the sha256 of the project JSON text given to load(). When only
// `project` differs, the corpus lowering moved, not the engine.

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { endianness } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, basename, resolve } from 'node:path';

import { compose } from '../public/lib/generator/composer.js?v=6';
import { arrangeWithOpts } from '../public/lib/generator/arrange.js';
import { projectToJSON } from '../public/lib/pflow.js';
import { shareFromPayload } from '../public/lib/share/url.js';
import { computeCidForJsonLd } from '../public/lib/share/codec.js';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, '..');
export const GOLDEN_PATH = join(here, 'djrust-golden.json');
export const FEED_DIR = join(here, 'fixtures', 'feed-corpus');
export const EXAMPLES_DIR = join(ROOT, 'examples');
export const PINNED_WASM = join(ROOT, 'public', 'djrust', 'djwasm.wasm');
export const BLOCK = 128;
export const RATES = [48000, 44100];
// Case lengths in seconds. Chosen so a full check runs in about a minute on valoper. An
// arrangement case runs longer so its first control fires (intro → buildup) are inside.
export const SECONDS = { default: { 48000: 12, 44100: 8 }, arrangement: { 48000: 20, 44100: 8 } };
export const SCHEMA = 'beats-djrust-golden/1';

export const GENRES = ['ambient', 'blues', 'bossa', 'country', 'dnb', 'dubstep', 'edm', 'funk', 'garage', 'house',
    'jazz', 'lofi', 'metal', 'reggae', 'speedcore', 'synthwave', 'techno', 'trance', 'trap'];

if (endianness() !== 'LE') throw new Error('djrust-golden: the hashes are of little-endian f32; this host is big-endian');

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

// --- the module ------------------------------------------------------------------------------

/**
 * Resolve the module to test: `arg` (a .wasm path or a package dir), else $DJRUST_WASM, else
 * the pinned local copy. Returns null when there is no such file.
 * → {wasmPath, glueDir, bytes, sha256, loader (the loader.js namespace), module, workletPath}
 */
export async function resolveModule(arg = process.env.DJRUST_WASM) {
    let wasmPath = PINNED_WASM, glueDir = join(ROOT, 'public', 'djrust');
    if (arg) {
        const p = resolve(arg);
        if (existsSync(p) && statSync(p).isDirectory()) {
            wasmPath = join(p, 'djwasm.wasm');
            if (existsSync(join(p, 'loader.js'))) glueDir = p;
        } else wasmPath = p;
    }
    if (!existsSync(wasmPath)) return null;
    const bytes = readFileSync(wasmPath);
    const loader = await import(pathToFileURL(join(glueDir, 'loader.js')).href);
    return {
        wasmPath, glueDir, bytes, sha256: sha256(bytes), loader,
        module: new WebAssembly.Module(bytes),
        workletPath: join(glueDir, 'worklet.js'),
    };
}

/**
 * What a gate does when it finds no module. `--skip-missing` may skip only the default (the
 * pinned public/djrust/djwasm.wasm, git-ignored, so absent on a fresh checkout): a module named
 * by `--wasm` or $DJRUST_WASM that is not there is a typo or a moved package, and passing on it
 * would report a gate green that rendered nothing. Prints why and returns the exit code: 0 skip,
 * 2 error.
 */
export function missingModule(tag, arg, skipMissing) {
    const named = arg || process.env.DJRUST_WASM || '';
    const where = named || PINNED_WASM;
    if (skipMissing && !named) {
        console.log(`${tag}: SKIP, no module at ${where} (make djrust-wasm, or DJRUST_WASM=<path>)`);
        return 0;
    }
    console.error(`${tag}: FAIL, no module at ${where}${named ? ' (named by ' + (arg && arg !== process.env.DJRUST_WASM ? '--wasm' : 'DJRUST_WASM') + '; --skip-missing skips only the default)' : ''}`);
    return 2;
}

export async function pinnedSha() {
    const pin = (await import(pathToFileURL(join(ROOT, 'public', 'djrust', 'pin.js')).href)).default;
    return pin;
}

/** A fresh engine on its own instance (its own linear memory), initialised at `sr`. */
export function newEngine(mod, sr) {
    const dj = mod.loader.instantiateSync(mod.module);
    dj.init(sr);
    return dj;
}

/** The out buffer's raw bytes (valid until the next call that writes it). */
function outBytes(dj) {
    const x = dj.x;
    return new Uint8Array(x.memory.buffer, x.djw_out_ptr(), x.djw_out_len());
}

/** Apply one worklet-protocol message the way public/djrust/worklet.js apply() does. */
export function applyMsg(dj, msg) {
    switch (msg.type) {
    case 'load': dj.load(msg.json !== undefined ? msg.json : msg.project); break;
    case 'transport':
        if (msg.action === 'play') dj.play();
        else if (msg.action === 'pause') dj.pause();
        else dj.stop();
        break;
    case 'tempo': dj.setTempo(msg.bpm); break;
    case 'mute': dj.setMute(msg.netId, msg.muted); break;
    default: throw new Error(`djrust-golden: no ABI-1 message ${msg.type}`);
    }
}

// --- the corpus ------------------------------------------------------------------------------

const textOf = (proj) => JSON.stringify(proj);

/** compose(genre, params) → the project JSON object, as the studio's generate does. */
export function composeProject(genre, seed, structure, extra = {}) {
    const params = { seed, ...extra };
    if (structure && structure !== 'loop') params.structure = structure;
    return projectToJSON(compose(genre, params));
}

/**
 * Lower a share-v1 envelope to {text, tempo?, mutes[]} in Node. It follows the studio's boot
 * path (petri-note.js share branch, backend/index.js overlay, lib/share/apply.js track
 * overrides), but it is NOT the browser's project byte for byte: it is a fixed, deterministic
 * function of the envelope, and that is what the golden freezes. Fx, feel, autoDj,
 * macrosDisabled, swing and humanize do not reach 0.2.0 (MIGRATION §12), so they are not
 * applied here.
 */
export function lowerEnvelope(env, cid) {
    const share = shareFromPayload(env, cid);
    const ov = share.overrides || {};
    let proj;
    if (share.nets) {
        proj = {
            name: share.name || `share-${String(cid || '').slice(0, 12)}`,
            tempo: ov.tempo ?? 120,
            swing: ov.swing ?? 0,
            humanize: ov.humanize ?? 0,
            nets: share.nets,
        };
        if (ov.initialMutes) proj.initialMutes = ov.initialMutes;
        if (ov.fx) proj.fx = ov.fx;
        if (share.structure && share.structure !== 'loop') {
            arrangeWithOpts(proj, share.genre || 'wrapped', share.structure, {
                seed: share.arrangeSeed ?? 0,
                velocityDeltas: share.velocityDeltas || undefined,
                maxVariants: share.maxVariants || 0,
                fadeIn: share.fadeIn || undefined,
                drumBreak: share.drumBreak || 0,
                sections: share.sections || undefined,
                feelCurve: share.feelCurve || undefined,
                macroCurve: share.macroCurve || undefined,
            });
        }
    } else {
        proj = projectToJSON(compose(share.genre, share.params));
        if (share.fadeIn || share.drumBreak || share.feelCurve || share.counterMelody) {
            arrangeWithOpts(proj, share.genre || 'wrapped', '', {
                overlayOnly: true,
                fadeIn: share.fadeIn || undefined,
                drumBreak: share.drumBreak || undefined,
                feelCurve: share.feelCurve || undefined,
                counterMelody: share.counterMelody || undefined,
            });
        }
        if (ov.tracks) {
            for (const [ch, t] of Object.entries(ov.tracks)) {
                const chNum = parseInt(ch, 10);
                for (const net of Object.values(proj.nets)) {
                    if (net.role === 'control' || !net.track || net.track.channel !== chNum) continue;
                    if (t.mix) net.track.mix = { ...(net.track.mix || {}), ...t.mix };
                    if (t.instrument) net.track.instrument = t.instrument;
                    if (t.instrumentSet) net.track.instrumentSet = t.instrumentSet;
                }
            }
        }
    }
    const nets = proj.nets || {};
    const mutes = (share.nets ? [] : (ov.initialMutes || [])).filter((id) => nets[id]);
    return { text: textOf(proj), tempo: typeof ov.tempo === 'number' ? ov.tempo : undefined, mutes };
}

export function feedFiles() {
    return existsSync(FEED_DIR) ? readdirSync(FEED_DIR).filter((f) => f.endsWith('.json')).sort() : [];
}
export function exampleFiles() {
    return readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith('.json')).sort();
}

/**
 * The corpus: [{id, kind, rates, seconds, build() → {text, tempo?, mutes?, steps?}}].
 * `steps` (live scripts) are [{q, msg}] in worklet-message form, applied before quantum q.
 */
export async function corpus() {
    const cases = [];
    const add = (id, kind, build, extra = {}) => cases.push({ id, kind, build, rates: RATES, seconds: SECONDS.default, ...extra });
    for (const genre of GENRES) for (const seed of [42, 7]) for (const structure of ['loop', 'standard']) {
        add(`gen:${genre}:${seed}:${structure}`, 'generated', () => ({ text: textOf(composeProject(genre, seed, structure)) }));
    }
    add('gen:dnb:3:drop', 'generated', () => ({ text: textOf(composeProject('dnb', 3, 'drop')) }));
    add('gen:metal:9:build', 'generated', () => ({ text: textOf(composeProject('metal', 9, 'build')) }));
    add('arr:techno:42:curves', 'arrangement', () => {
        const p = composeProject('techno', 42, 'standard');
        arrangeWithOpts(p, 'techno', '', {
            overlayOnly: true,
            feelCurve: [{ section: 'intro', x: 0.2, y: 0.3 }, { section: 'buildup', x: 0.7, y: 0.6 }, { section: 'drop', x: 0.9, y: 0.9 }],
            macroCurve: [{ section: 'buildup', macro: 'riser', bars: 4 }, { section: 'drop', macro: 'beat-repeat', bars: 1 }],
        });
        return { text: textOf(p) };
    }, { seconds: SECONDS.arrangement });
    add('arr:house:9:fade-break', 'arrangement', () => {
        const p = composeProject('house', 9, 'standard');
        arrangeWithOpts(p, 'house', '', { overlayOnly: true, fadeIn: ['bass', 'melody'], drumBreak: 4 });
        return { text: textOf(p) };
    }, { seconds: SECONDS.arrangement });
    for (const f of exampleFiles()) {
        const env = JSON.parse(readFileSync(join(EXAMPLES_DIR, f), 'utf8'));
        const cid = await computeCidForJsonLd(env);
        add(`ex:${basename(f, '.json')}`, 'example', () => lowerEnvelope(env, cid), { cid });
    }
    for (const f of feedFiles()) {
        const cid = basename(f, '.json');
        const env = JSON.parse(readFileSync(join(FEED_DIR, f), 'utf8'));
        add(`feed:${cid}`, 'feed', () => lowerEnvelope(env, cid), { cid, genre: env.genre });
    }
    const { SCRIPT_NAMES, buildScript } = await import('./djrust-script.mjs');
    for (const name of SCRIPT_NAMES) {
        const s = buildScript(name);
        add(`script:${name}`, 'script', () => ({ text: s.text, steps: s.steps }),
            { rates: [s.sr], seconds: { [s.sr]: s.blocks * BLOCK / s.sr }, blocks: s.blocks });
    }
    return cases;
}

export const caseFrames = (c, sr) => c.blocks ? c.blocks * BLOCK : Math.round(c.seconds[sr] * sr / BLOCK) * BLOCK;

// --- rendering -------------------------------------------------------------------------------

/**
 * Render one case at `sr` through `mod`, `block` frames per process() call (128 unless the
 * block-size property is being measured). `hooks` are for djrust-neutral.mjs:
 *   afterInit(dj), afterLoad(dj), beforePlay(dj), atQuantum(dj, q) (before process; q counts
 *   128-frame quanta and is only called when block is 128).
 * `built` reuses an already-lowered case. → {audio, ticks, report, marking, muted, project,
 * frames, nTicks, peak}
 */
export function renderCase(mod, c, sr, { block = BLOCK, hooks = {}, built = null, streams = true } = {}) {
    const b = built || c.build();
    const dj = newEngine(mod, sr);
    const x = dj.x;
    if (hooks.afterInit) hooks.afterInit(dj);
    dj.load(b.text);
    if (hooks.afterLoad) hooks.afterLoad(dj);
    for (const id of b.mutes || []) dj.setMute(id, true);
    if (b.tempo) dj.setTempo(b.tempo);
    if (hooks.beforePlay) hooks.beforePlay(dj);
    dj.play();

    const frames = caseFrames(c, sr);
    const H = { audio: createHash('sha256'), ticks: createHash('sha256'), report: createHash('sha256'),
        marking: createHash('sha256'), muted: createHash('sha256') };
    const nl = new Uint8Array([10]);
    const inter = new Float32Array(2 * Math.max(block, BLOCK));
    const tickBuf = Buffer.alloc(4);
    const steps = (b.steps || []).slice().sort((a, b2) => a.q - b2.q);
    let si = 0, nTicks = 0, peak = 0;
    for (let done = 0; done < frames;) {
        const n = Math.min(block, frames - done);
        if (done % BLOCK === 0) {
            const q = done / BLOCK;
            while (si < steps.length && steps[si].q <= q) applyMsg(dj, steps[si++].msg);
            if (hooks.atQuantum && block === BLOCK) hooks.atQuantum(dj, q);
        }
        const t = dj.process(n);
        const [l, r] = dj.blocks(n);
        for (let i = 0; i < n; i++) {
            inter[2 * i] = l[i]; inter[2 * i + 1] = r[i];
            const a = Math.abs(l[i]); if (a > peak) peak = a;
        }
        H.audio.update(new Uint8Array(inter.buffer, 0, 8 * n));
        if (streams) {
            tickBuf.writeInt32LE(t, 0);
            H.ticks.update(tickBuf);
            if (t > 0) {
                nTicks += t;
                const rn = x.djw_report();
                if (rn < 0) throw new Error(`djw_report ${rn}`);
                if (rn > 0) { H.report.update(outBytes(dj)); H.report.update(nl); }
                if (x.djw_marking() < 0) throw new Error('djw_marking');
                H.marking.update(outBytes(dj)); H.marking.update(nl);
                if (x.djw_muted() < 0) throw new Error('djw_muted');
                H.muted.update(outBytes(dj)); H.muted.update(nl);
            }
        }
        done += n;
    }
    const out = { audio: H.audio.digest('hex'), project: sha256(b.text), frames, peak: Math.round(peak * 1e6) / 1e6 };
    if (streams) Object.assign(out, { ticks: H.ticks.digest('hex'), report: H.report.digest('hex'),
        marking: H.marking.digest('hex'), muted: H.muted.digest('hex'), nTicks });
    return out;
}

export const STREAMS = ['audio', 'ticks', 'report', 'marking', 'muted'];

// --- properties (measured once at make, re-measured by `props`) ------------------------------

/** Audio sha at block sizes 128 / 37 / 4096 on a few cases; equal or not is the property. */
export async function measureBlockSize(mod, cases) {
    const ids = ['gen:techno:42:loop', 'gen:techno:42:standard', 'gen:jazz:7:loop', 'gen:dnb:3:drop', 'arr:techno:42:curves'];
    const out = { sizes: [128, 37, 4096], cases: {}, equal: true };
    for (const id of ids) {
        const c = cases.find((k) => k.id === id);
        if (!c) continue;
        const built = c.build();
        for (const sr of RATES) {
            const row = {};
            for (const block of out.sizes) row[block] = renderCase(mod, c, sr, { block, built, streams: false }).audio;
            const eq = row[37] === row[128] && row[4096] === row[128];
            out.cases[`${id}@${sr}`] = { equal: eq, ...row };
            if (!eq) out.equal = false;
        }
    }
    out.verdict = out.equal
        ? 'block-size independent on every measured case: 128, 37 and 4096 give one sha'
        : 'NOT block-size independent: every renderer is pinned at 128 frames and the tri-render asserts it';
    return out;
}

/** Reading report/marking/muted every tick does not change the audio (the readers are pure). */
function measureReadsNeutral(mod, cases) {
    const c = cases.find((k) => k.id === 'gen:techno:42:standard');
    const built = c.build();
    const a = renderCase(mod, c, 48000, { built, streams: true }).audio;
    const b = renderCase(mod, c, 48000, { built, streams: false }).audio;
    return { equal: a === b, note: 'djw_report/djw_marking/djw_muted on every ticked block vs never: audio sha' };
}

// --- CLI -------------------------------------------------------------------------------------

function parseArgs(argv) {
    const a = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--wasm') a.wasm = argv[++i];
        else if (k === '--only') a.only = new RegExp(argv[++i]);
        else if (k === '--rate') a.rate = Number(argv[++i]);
        else if (k === '--force') a.force = true;
        else if (k === '--skip-missing') a.skipMissing = true;
        else if (k === '--quiet') a.quiet = true;
        else a._.push(k);
    }
    return a;
}

async function loadOrExit(a) {
    const mod = await resolveModule(a.wasm || process.env.DJRUST_WASM);
    if (!mod) process.exit(missingModule('djrust-golden', a.wasm, a.skipMissing));
    return mod;
}

export function readGolden() {
    return JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
}

function writeGolden(g) {
    writeFileSync(GOLDEN_PATH, JSON.stringify(g, null, 1) + '\n');
}

async function cmdMake(a) {
    const mod = await loadOrExit(a);
    const pin = await pinnedSha();
    if (mod.sha256 !== pin.sha256 && !a.force) {
        console.error(`djrust-golden make: ${mod.wasmPath} is sha256 ${mod.sha256}, not the pinned djwasm@${pin.version} ` +
            `(${pin.sha256}). The golden is made from the pin only (--force to override).`);
        process.exit(1);
    }
    const t0 = Date.now();
    const cases = await corpus();
    const info = newEngine(mod, 48000).info();
    const golden = {
        schema: SCHEMA,
        about: 'What djwasm 0.2.0 renders on the ABI-1 call sequence. Every later module must reproduce these hashes ' +
            '(scripts/djrust-golden.mjs check). Made once from the pinned module; never regenerate it to make a check pass.',
        module: { package: pin.package, version: pin.version, sha256: mod.sha256, bytes: mod.bytes.length, info },
        made: new Date().toISOString().slice(0, 10),
        format: {
            audio: 'sha256 of interleaved little-endian f32 L,R per frame over every frame rendered',
            ticks: 'sha256 of the int32 LE return of every process() call',
            report: 'sha256 of the raw djw_report() out bytes + "\\n", per block that ticked',
            marking: 'sha256 of the raw djw_marking() out bytes + "\\n", per block that ticked',
            muted: 'sha256 of the raw djw_muted() out bytes + "\\n", per block that ticked',
            project: 'sha256 of the project JSON text passed to load() (corpus lowering, not engine output)',
        },
        callSequence: 'newInstance; init(sr); load(json); setMute(id,true) per lowered mute; setTempo(override) if any; play(); ' +
            'then per 128-frame quantum q: apply script messages with step.q <= q (worklet apply() semantics), process(128)',
        settings: { block: BLOCK, rates: RATES, seconds: SECONDS, scripts: 'djrust-script.mjs SCRIPTS, 48 kHz' },
        properties: {},
        cases: {},
    };
    let n = 0;
    for (const c of cases) {
        const built = c.build();
        for (const sr of c.rates) {
            const r = renderCase(mod, c, sr, { built });
            golden.cases[`${c.id}@${sr}`] = { kind: c.kind, ...(c.cid ? { cid: c.cid } : {}), ...r };
            n++;
        }
        if (!a.quiet && n % 40 === 0) console.log(`  ${n} renders, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    }
    golden.properties.blockSize = await measureBlockSize(mod, cases);
    golden.properties.readsNeutral = measureReadsNeutral(mod, cases);
    const sc = await import('./djrust-script.mjs');
    golden.properties.scripts = await sc.measureScriptProperties(mod);
    golden.properties.triRender = { status: 'not yet measured: run make test-djrust-browser, then record it with `note triRender`' };
    golden.corpus = { cases: cases.length, renders: n, seconds: Math.round((Date.now() - t0) / 1000),
        kinds: cases.reduce((m, c) => (m[c.kind] = (m[c.kind] || 0) + 1, m), {}) };
    writeGolden(golden);
    console.log(`wrote ${GOLDEN_PATH}: ${n} renders of ${cases.length} cases in ${golden.corpus.seconds} s`);
    console.log(`block size: ${golden.properties.blockSize.verdict}`);
    console.log(`scripts: ${JSON.stringify(golden.properties.scripts.summary)}`);
}

async function cmdCheck(a) {
    const mod = await loadOrExit(a);
    if (!existsSync(GOLDEN_PATH)) { console.error(`no ${GOLDEN_PATH}: node scripts/djrust-golden.mjs make`); process.exit(2); }
    const golden = readGolden();
    const t0 = Date.now();
    const cases = await corpus();
    const known = new Set(Object.keys(golden.cases));
    let n = 0, bad = 0, lowering = 0;
    const fails = [];
    console.log(`djrust-golden check: ${mod.wasmPath} (sha256 ${mod.sha256.slice(0, 16)}…, ${mod.bytes.length} B) ` +
        `against djwasm@${golden.module.version} (${golden.module.sha256.slice(0, 16)}…)`);
    for (const c of cases) {
        if (a.only && !a.only.test(c.id)) continue;
        const rates = c.rates.filter((sr) => !a.rate || sr === a.rate);
        if (!rates.length) continue;
        const built = c.build();
        for (const sr of rates) {
            const key = `${c.id}@${sr}`;
            const want = golden.cases[key];
            known.delete(key);
            if (!want) { fails.push(`${key}: not in the golden (corpus grew; the golden is frozen)`); bad++; continue; }
            const got = renderCase(mod, c, sr, { built });
            n++;
            const diff = STREAMS.filter((s) => got[s] !== want[s]);
            if (got.project !== want.project) {
                lowering++;
                fails.push(`${key}: the corpus lowering changed (project sha ${got.project.slice(0, 12)} != ${want.project.slice(0, 12)}); ` +
                    `not an engine result${diff.length ? ', streams ' + diff.join(',') + ' differ too' : ''}`);
                bad++;
            } else if (diff.length) {
                fails.push(`${key}: ${diff.join(', ')} differ (peak ${got.peak} vs ${want.peak}, ticks ${got.nTicks} vs ${want.nTicks})`);
                bad++;
            }
        }
    }
    if (!a.only && !a.rate) for (const k of known) { fails.push(`${k}: in the golden but not in the corpus (fixture removed?)`); bad++; }
    for (const f of fails.slice(0, 40)) console.log(`FAIL ${f}`);
    if (fails.length > 40) console.log(`     … ${fails.length - 40} more`);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(bad
        ? `\n${bad} of ${n} renders differ from djwasm@${golden.module.version}${lowering ? ` (${lowering} are corpus-lowering changes)` : ''} — ${secs} s`
        : `ok   ${n} renders bit-identical to djwasm@${golden.module.version} on audio, ticks, report, marking and muted — ${secs} s`);
    process.exit(bad ? 1 : 0);
}

async function cmdProps(a) {
    const mod = await loadOrExit(a);
    const cases = await corpus();
    const bs = await measureBlockSize(mod, cases);
    console.log(JSON.stringify(bs, null, 1));
    console.log(JSON.stringify(measureReadsNeutral(mod, cases)));
    const sc = await import('./djrust-script.mjs');
    console.log(JSON.stringify((await sc.measureScriptProperties(mod)).summary));
}

async function cmdList() {
    for (const c of await corpus()) console.log(`${c.id}\t${c.kind}\t${c.rates.join(',')}`);
}

function cmdNote(a) {
    const [, key, json] = a._;
    if (!key || !json) { console.error('usage: djrust-golden.mjs note <key> <json>'); process.exit(2); }
    const g = readGolden();
    g.properties[key] = JSON.parse(json);
    writeGolden(g);
    console.log(`recorded properties.${key}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    // No top-level await: djrust-script.mjs imports this module back, and a module still in
    // top-level-await evaluation would deadlock that import.
    const a = parseArgs(process.argv.slice(2));
    const cmd = a._[0] || 'check';
    const run = { make: cmdMake, check: cmdCheck, props: cmdProps, list: cmdList, note: cmdNote }[cmd];
    if (!run) { console.error(`unknown command ${cmd}`); process.exit(2); }
    Promise.resolve(run(a)).catch((err) => { console.error(err); process.exit(1); });
}

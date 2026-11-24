#!/usr/bin/env node
//
// The four genres only djwasm composes (acid, deephouse, electro, italo: djrust's
// data/genres-native.json), held to what the page promises. Plain `node`, no npm.
//
//   node scripts/test-native-genres.mjs          # or: make test-native-genres
//   DJRUST_WASM=/path/to/djwasm.wasm node scripts/test-native-genres.mjs
//
// 1. Picker: every native genre is an option of .pn-genre-select, none shadows a JS genre, and the
//    feed's genre list carries it.
// 2. Compose: composeNativeDoc (what the sequencer worker calls) returns a project that parseProject
//    reads, whose tempo is the genre's, for several seeds and structures; the same seed twice is
//    the same bytes, another seed is another track.
// 3. Not silent: each genre is rendered through the engine, every seed, loop and arranged; the
//    master must carry sound in every bar window it plays, and every music net on its own (the
//    project cut down to that one net) must be heard. A silent genre, or a lane that composes
//    but never sounds, fails.
// 4. Existing genres are untouched: the JS composer still owns its 19, and an unknown name is not
//    mistaken for a native one.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { instantiate } from '../public/djrust/loader.js';
import { parseProject } from '../public/lib/pflow.js';
import { Genres } from '../public/lib/generator/composer.js?v=6';
import { NATIVE_GENRES, NATIVE_GENRE_TRAITS, NATIVE_GENRE_COLORS, NATIVE_GENRE_FEEL, isNativeGenre }
    from '../public/lib/genres/native-genres.js';
import { composeNativeDoc } from '../public/lib/genres/native.js';

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = process.env.DJRUST_WASM || join(here, '..', 'public', 'djrust', 'djwasm.wasm');
if (!existsSync(wasmPath)) {
    console.error(`no ${wasmPath}\nbuild it first: make djrust-wasm`);
    process.exit(2);
}
const wasmBytes = readFileSync(wasmPath);

let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) failures++;
};

const SR = 48000, BLOCK = 128;
const rms = (l, r) => {
    let s = 0;
    for (let i = 0; i < l.length; i++) s += l[i] * l[i] + r[i] * r[i];
    return Math.sqrt(s / (2 * l.length));
};

/** Play a project document for `seconds` through a fresh engine; rms per ~half-second window. */
async function renderWindows(doc, seconds) {
    const dj = await instantiate(wasmBytes);
    dj.init(SR);
    dj.load(doc);
    dj.play();
    const win = Math.floor(SR / 2), total = Math.floor(seconds * SR), out = [];
    let l = new Float32Array(win), r = new Float32Array(win), o = 0, peak = 0;
    for (let done = 0; done < total; done += BLOCK) {
        dj.process(BLOCK);
        const [bl, br] = dj.blocks(BLOCK);
        for (let i = 0; i < BLOCK; i++) {
            l[o + i] = bl[i]; r[o + i] = br[i];
            peak = Math.max(peak, Math.abs(bl[i]), Math.abs(br[i]));
        }
        o += BLOCK;
        if (o + BLOCK > win) { out.push(rms(l.subarray(0, o), r.subarray(0, o))); o = 0; }
    }
    return { windows: out, peak };
}

// --- 1. the picker -----------------------------------------------------------------------------
{
    const build = readFileSync(join(here, '..', 'public', 'lib', 'ui', 'build.js'), 'utf8');
    const sel = build.slice(build.indexOf('<select class="pn-genre-select">'));
    const options = [...sel.slice(0, sel.indexOf('</select>')).matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
    const feed = readFileSync(join(here, '..', 'public', 'feed.html'), 'utf8');
    const feedList = feed.slice(feed.indexOf('const GENRES = ['), feed.indexOf('];', feed.indexOf('const GENRES = [')));
    for (const g of NATIVE_GENRES) {
        check(`picker: ${g} is offered`, options.includes(g), `${options.length} options`);
        check(`feed: ${g} is a filter`, feedList.includes(`'${g}'`));
    }
    check('picker: every option is a JS genre or a native one',
        options.every((o) => Genres[o] || isNativeGenre(o)), options.filter((o) => !Genres[o] && !isNativeGenre(o)).join(','));
    check('picker: no JS genre was dropped', Object.keys(Genres).every((g) => options.includes(g)));
    check('native genres do not shadow a JS genre', NATIVE_GENRES.every((g) => !Genres[g]));
    check('an unknown name is not native', !isNativeGenre('no-such-genre') && !isNativeGenre('techno'));
    check('every native genre has traits, a colour and a feel position',
        NATIVE_GENRES.every((g) => NATIVE_GENRE_TRAITS[g]?.bpm > 0 && /^#[0-9a-f]{6}$/.test(NATIVE_GENRE_COLORS[g])
            && NATIVE_GENRE_FEEL[g]?.length === 2));
}

// --- 2. compose --------------------------------------------------------------------------------
const docs = {};
for (const genre of NATIVE_GENRES) {
    for (const structure of ['', 'standard']) {
        for (const seed of [1, 42]) {
            const tag = `${genre}/${seed}/${structure || 'loop'}`;
            const params = { seed }; if (structure) params.structure = structure;
            const doc = await composeNativeDoc(genre, params, wasmBytes);
            docs[tag] = doc;
            let proj = null, err = '';
            try { proj = parseProject(doc); } catch (e) { err = String(e.message || e); }
            const nets = proj ? Object.keys(proj.nets).length : 0;
            check(`compose ${tag}: parses, ${nets} nets, tempo ${doc.tempo}`,
                !!proj && nets >= 4 && doc.tempo === NATIVE_GENRE_TRAITS[genre].bpm, err);
        }
    }
    const a = JSON.stringify(await composeNativeDoc(genre, { seed: 7 }, wasmBytes));
    const b = JSON.stringify(await composeNativeDoc(genre, { seed: 7 }, wasmBytes));
    const c = JSON.stringify(await composeNativeDoc(genre, { seed: 8 }, wasmBytes));
    check(`compose ${genre}: same seed, same bytes; another seed, another track`, a === b && a !== c);
}

// --- 3. not silent -----------------------------------------------------------------------------
const FLOOR = 1e-3;          // rms of the master (about -60 dBFS): a heard bar is far above it
for (const genre of NATIVE_GENRES) {
    for (const structure of ['', 'standard']) {
        const tag = `${genre}/1/${structure || 'loop'}`;
        const doc = docs[tag];
        const { windows, peak } = await renderWindows(doc, structure ? 12 : 8);
        const silent = windows.filter((w) => w < FLOOR).length;
        const loud = Math.max(...windows);
        check(`audio ${tag}: master is heard (${windows.length} half-second windows, loudest rms ${loud.toFixed(3)}, peak ${peak.toFixed(2)})`,
            loud > 0.01 && peak < 4 && (structure ? silent < windows.length : silent === 0),
            silent ? `${silent} silent windows` : '');
    }
    // every music net alone
    const doc = docs[`${genre}/1/loop`];
    const music = Object.entries(doc.nets).filter(([, n]) => n.role !== 'control');
    const quiet = [];
    for (const [id, net] of music) {
        const solo = { ...doc, nets: { [id]: net } };
        delete solo.initialMutes;
        const { windows } = await renderWindows(solo, 6);
        if (!(Math.max(...windows) > FLOOR)) quiet.push(`${id}(${net.track?.instrument || '?'})`);
    }
    check(`audio ${genre}: all ${music.length} music nets sound on their own`, quiet.length === 0, quiet.join(', '));
}

// --- 4. the rest is as it was ------------------------------------------------------------------
check('JS genres unchanged: still 19', Object.keys(Genres).length === 19, Object.keys(Genres).length);

console.log(failures ? `\n${failures} FAILED` : '\nall ok');
process.exit(failures ? 1 : 0);

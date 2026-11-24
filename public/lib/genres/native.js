// Native genres: djrust's own, beyond beats' JS catalogue (djrust data/genres-native.json).
//
// beats' JS composer (composer.js) knows 19 genres; djwasm's Rust composer knows those 19 byte for
// byte and four more of its own, which have no JS counterpart: they are not in tables.json, and the
// Rust side gives each one musicality rules beats' code does not carry (`like`, native bass
// figures). Porting them to JS would fork the generator, so a native genre is composed by the
// engine itself: djwasm's `compose` returns the same project document shape the JS composer's
// projectToJSON does, and parseProject reads it back.
//
// Used by the sequencer worker's `generate` / `generate-preview` (the only place a picked genre
// becomes a project) and by scripts/test-native-genres.mjs under Node.
//
// The facts the page shows beside the picker (tempo, traits, colour) are plain data in
// native-genres.js, held to the engine by scripts/test-native-genres.mjs.

import { instantiate } from '../../djrust/loader.js';
import PIN from '../../djrust/pin.js';
import { wasmTries } from '../../djrust/sources.js';

export { NATIVE_GENRES, isNativeGenre } from './native-genres.js';

let djPromise = null;

/** The djwasm module, instantiated once per worker (or Node process, from `bytes`). */
export function nativeEngine(bytes) {
    if (!djPromise) {
        djPromise = (async () => {
            if (bytes) return instantiate(bytes);
            const localUrl = new URL('../../djrust/djwasm.wasm', import.meta.url).href;
            let lastErr;
            for (const t of wasmTries(PIN, localUrl)) {
                try {
                    const res = await fetch(t.url, t.init);
                    if (!res.ok) throw new Error(`${t.url}: HTTP ${res.status}`);
                    return await instantiate(await res.arrayBuffer());
                } catch (e) { lastErr = e; }
            }
            throw lastErr || new Error('djwasm: no source');
        })();
        djPromise.catch(() => { djPromise = null; });
    }
    return djPromise;
}

/**
 * The compose spec for djwasm from the page's generate params: seed (random when the page sent
 * none, as the JS composer does), structure and cohesion; trait overrides ride along by name.
 */
export function nativeSpec(genre, params = {}) {
    const spec = { ...params, genre };
    if (typeof spec.seed !== 'number') spec.seed = Date.now();
    if (!spec.structure) delete spec.structure;
    if (!spec.cohesion) delete spec.cohesion;
    return spec;
}

/** Compose a native genre in the engine → the project document (what projectToJSON gives). */
export async function composeNativeDoc(genre, params = {}, bytes) {
    const dj = await nativeEngine(bytes);
    const r = dj.compose(nativeSpec(genre, params), { raw: true });
    return JSON.parse(r.docText);
}

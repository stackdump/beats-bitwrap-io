// djrust-glue-hook.mjs — run a beats test script against another djwasm package's JS glue.
//
//   DJRUST_GLUE=/path/to/djrust/cabi/pkg node --import ./scripts/djrust-glue-hook.mjs scripts/test-djrust-wasm.mjs
//
// Every import of public/djrust/loader.js or public/djrust/worklet.js (with or without a query
// string) resolves to the same-named file in $DJRUST_GLUE instead. The served, pinned
// public/djrust/ files are not touched: this is how a candidate package's glue is held to the
// existing tests (make test-djrust's JS oracle, its worklet section) before it is re-pinned.
// Pair it with DJRUST_WASM=$DJRUST_GLUE/djwasm.wasm so module and glue come from one build.
// Without DJRUST_GLUE it changes nothing.

import { register } from 'node:module';

if (process.env.DJRUST_GLUE) {
    register(new URL(import.meta.url), { data: { glue: process.env.DJRUST_GLUE } });
}

let glueDir = null;

export function initialize(data) {
    glueDir = data && data.glue;
}

export async function resolve(specifier, context, next) {
    const r = await next(specifier, context);
    if (!glueDir) return r;
    const m = /\/public\/djrust\/(loader|worklet)\.js(\?.*)?$/.exec(r.url);
    if (!m) return r;
    const { pathToFileURL } = await import('node:url');
    const { join } = await import('node:path');
    return { ...r, url: pathToFileURL(join(glueDir, `${m[1]}.js`)).href, shortCircuit: true };
}

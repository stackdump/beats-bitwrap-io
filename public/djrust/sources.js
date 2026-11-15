// Where to fetch djwasm.wasm from, in order, as `fetch` tries. One place for the page engine
// (node.js) and the scope kernel worker. `localUrl` is the file beside this one, resolved by the
// caller from its own location.
//   pin.source "bundled": the committed file, with the pin's SRI (same-origin fetch honours it).
//   pin.source "cdn":     jsDelivr at the pinned version with SRI, then the local file without
//                         (a dev build may differ from the pin; wave.js reports the source).
export function wasmTries(PIN, localUrl, override) {
    if (override) return [{ url: override, init: { cache: 'no-cache' }, source: 'override' }];
    const bundled = { url: localUrl, init: { integrity: PIN.integrity, cache: 'no-cache' }, source: `bundled djwasm@${PIN.version}` };
    const cdn = { url: PIN.url, init: { integrity: PIN.integrity, mode: 'cors', credentials: 'omit' }, source: `cdn djwasm@${PIN.version}` };
    if (PIN.source === 'cdn') return [cdn, { url: localUrl, init: { cache: 'no-cache' }, source: 'local' }];
    return [bundled];
}

// The djwasm module ?engine=djrust loads: an exact npm version on jsDelivr, fetched with this
// SRI hash (a changed file refuses to load). Written by `node scripts/djrust-pin.mjs pin`; held by
// `make check-djrust-pin` (offline) and `make djrust-verify-cdn` (online). Never a range or latest.
export default {
    "package": "djwasm",
    "version": "0.3.0",
    "url": "https://cdn.jsdelivr.net/npm/djwasm@0.3.0/djwasm.wasm",
    "integrity": "sha384-U3nH5yAOeyhbHB8fmraLQk+IUEh8xYX2Calt0ir87UydofPP88W9bKr7zI5dLXX5",
    "sha256": "6c4f006f12e8cd579d2c2c0e1037b96422d5d1ae0d81fb0f2fa645b2d5c3cef6",
    "bytes": 901807,
    "glue": {
        "loader.js": "e8bc8964d3c3ef6f8f94cc7f17975d97566c2b630b4e5c62ade678fb08baa29c",
        "worklet.js": "c8610a036f2e500ad9cea87ec3a2a9781e803d6deb9576e943e288d5ac4b60f0"
    }
};

// The djwasm module ?engine=djrust loads, pinned by hash. `source` says where from:
//   "bundled": public/djrust/djwasm.wasm, committed and served with the site;
//   "cdn":     the exact npm version on jsDelivr (url below), with the local file as fallback.
// Either way the fetch carries `integrity` (SRI), so a changed file refuses to load.
// Written by `node scripts/djrust-pin.mjs pin|use`; held by `make check-djrust-pin` (offline)
// and `make djrust-verify-cdn` (online). Never a range or latest.
export default {
    "package": "djwasm",
    "version": "0.3.0",
    "source": "bundled",
    "url": "https://cdn.jsdelivr.net/npm/djwasm@0.3.0/djwasm.wasm",
    "integrity": "sha384-XugD4tTbMr4FU8/NqG1zdCZf7FZM9HDG5BoxC7WZKm1lTaZ0TE6hIq37ymWZ4gKt",
    "sha256": "afaeb01d78cfa13693450aafa1bb10c6a406cf37a58af287c71a716a5d4839da",
    "bytes": 902599,
    "glue": {
        "loader.js": "e8bc8964d3c3ef6f8f94cc7f17975d97566c2b630b4e5c62ade678fb08baa29c",
        "worklet.js": "c8610a036f2e500ad9cea87ec3a2a9781e803d6deb9576e943e288d5ac4b60f0"
    }
};

// The djwasm module ?engine=djrust loads: an exact npm version on jsDelivr, fetched with this
// SRI hash (a changed file refuses to load). Written by `node scripts/djrust-pin.mjs pin`; held by
// `make check-djrust-pin` (offline) and `make djrust-verify-cdn` (online). Never a range or latest.
export default {
    "package": "djwasm",
    "version": "0.2.0",
    "url": "https://cdn.jsdelivr.net/npm/djwasm@0.2.0/djwasm.wasm",
    "integrity": "sha384-6SPciOYrcKGwLtnKHxqda9NzqXu+q+Ztxte104iTQefEW9gD/RClnUWEtp20cM9r",
    "sha256": "cfcd9cf4a1b51f186bb93e893406adfdd7ca712b09a10303da8a73ce29b30bca",
    "bytes": 854162,
    "glue": {
        "loader.js": "3eb8661614570170895c3d92028c4bd62b188e731f789c385a2d8813801698da",
        "worklet.js": "602abe9dd67134e4735b7f9670605c57c335addfc591719695e1480d1822ff3a"
    }
};

// The djwasm module ?engine=djrust loads, pinned by hash. `source` says where from:
//   "bundled": public/djrust/djwasm.wasm, committed and served with the site;
//   "cdn":     the exact npm version on jsDelivr (url below), with the local file as fallback.
// Either way the fetch carries `integrity` (SRI), so a changed file refuses to load.
// Written by `node scripts/djrust-pin.mjs pin|use`; held by `make check-djrust-pin` (offline)
// and `make djrust-verify-cdn` (online). Never a range or latest.
export default {
    "package": "djwasm",
    "version": "0.3.2",
    "source": "bundled",
    "url": "https://cdn.jsdelivr.net/npm/djwasm@0.3.2/djwasm.wasm",
    "integrity": "sha384-7xKJUMiW+GZTfeUd4B/ksWo9y1ZNCtufdwQXweF+uSPX5lrU5iFiobC/kAotGz/w",
    "sha256": "870b93589bfdd183827965cbcf14ec15ef438107e3e1fa561c7edce76fabcd18",
    "bytes": 912909,
    "glue": {
        "loader.js": "a3a67179bb48461ebf9f8709f1b6585a5d7b843e400313842b5e71968c674feb",
        "worklet.js": "91ce916d5a2f954b11f01af022be272cb5a99c175c8741573adb20bc2f565a0a"
    }
};

# Third-party code in this directory

## qrcode.js

Bundled QR-code renderer used by the share-card SVG so the QR pixmap
can render without a network round-trip. License: see `qrcode.LICENSE`
(MIT).

## webamp/

Vendored UMD bundle of [captbaritone/webamp](https://github.com/captbaritone/webamp)
v2.2.0 — a near-pixel-perfect Winamp 2.9 clone. Loaded on demand
when the user clicks "webamp" on the feed page. License: see
`webamp/webamp.LICENSE` (MIT). To refresh:

```bash
curl -sL https://unpkg.com/webamp@2.2.0/built/webamp.bundle.min.js \
  -o public/vendor/webamp/webamp.bundle.min.js
```

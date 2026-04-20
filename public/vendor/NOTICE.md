# Third-party code in this directory

## qrcode.js

- Source: <https://github.com/davidshimjs/qrcodejs>
- License: MIT (see `qrcode.LICENSE`)
- Author: davidshimjs — 2012
- Original QR algorithm: Copyright (c) 2009 Kazuhiko Arase
  (<http://www.d-project.com/>, MIT)
- Retrieved from: <https://github.com/davidshimjs/qrcodejs/blob/master/qrcode.js>
- File: `qrcode.js` — vendored verbatim, no modifications.

Used to render QR codes in the in-app share card (see
`public/lib/share/card.js`). The library attaches `QRCode` to the
global scope and requires a DOM to render into; we use it from a
detached `<div>` with `useSVG: true` and extract the resulting
`<svg>` element.

"QR Code" is a registered trademark of DENSO WAVE INCORPORATED.

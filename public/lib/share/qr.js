// QR renderer for the welcome card. Uses the vendored
// davidshimjs/qrcodejs library (see public/vendor/NOTICE.md),
// driven off a detached <div> with useSVG:true, then the produced
// <svg> is extracted as a string and spliced into the card SVG.
//
// Dual-impl pair: the Go server-rendered social card uses
// github.com/skip2/go-qrcode. Both encode the same URL with the
// same error-correction level so scanning either yields the same
// content; exact matrices match whenever both libraries pick the
// same auto-selected mask pattern (they should, since the lost-
// point scoring is part of the QR spec).

// Render a QR as an SVG <g> that can be inlined into another SVG.
// Returns an empty string if the library hasn't loaded — callers
// should just skip the QR rather than breaking the card.
export function renderQrGroup(text, { size = 200, ecl = 'M', color = '#000', bg = '#fff' } = {}) {
    if (typeof QRCode === 'undefined' || !text) return '';
    const correctLevel = (QRCode.CorrectLevel || {})[ecl] ?? QRCode.CorrectLevel.M;
    const host = document.createElement('div');
    // qrcode.js requires a non-empty `text` at construction time.
    // width/height don't matter — we read the matrix, not the
    // drawn result, so we can work off the 40 default pixel size.
    try {
        new QRCode(host, { text, width: size, height: size, correctLevel, useSVG: true });
    } catch (err) {
        console.warn('QR render failed:', err);
        return '';
    }
    const svg = host.querySelector('svg');
    if (!svg) return '';
    // qrcode.js emits one <rect> per module plus background. Rebuild
    // as a tight <g> so we can position it at an arbitrary origin
    // inside the outer card SVG without depending on its viewBox.
    const rects = svg.querySelectorAll('rect');
    if (!rects.length) return '';
    // Each rect has width/height = 1 module. Count modules on a row
    // to derive the module size vs. our target `size`.
    const first = rects[0];
    const moduleSize = Number(first.getAttribute('width')) || 1;
    const totalModules = Math.round(Number(svg.getAttribute('width')) / moduleSize);
    const scale = size / (totalModules * moduleSize);
    const parts = [`<rect width="${size}" height="${size}" fill="${bg}"/>`];
    for (const r of rects) {
        const fill = r.getAttribute('fill');
        // qrcode.js draws background rects as #ffffff and dark as
        // #000000. Skip background rects (we already drew one).
        if (!fill || fill === '#ffffff' || fill.toLowerCase() === bg.toLowerCase()) continue;
        const x = Number(r.getAttribute('x')) * scale;
        const y = Number(r.getAttribute('y')) * scale;
        const w = Number(r.getAttribute('width')) * scale;
        const h = Number(r.getAttribute('height')) * scale;
        parts.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${(w + 0.2).toFixed(2)}" height="${(h + 0.2).toFixed(2)}" fill="${color}"/>`);
    }
    return parts.join('');
}

// Build the short URL to encode into the QR. Shape:
//   https://<host>/?cid=<cid>                    (no title)
//   https://<host>/?cid=<cid>&title=<percent>    (with title)
// Falls back to location.href when cid isn't available (unsealed).
export function shortShareUrl({ cid = '', title = '' } = {}) {
    if (!cid) return location.href;
    const base = `${location.origin}${location.pathname}?cid=${cid}`;
    return title ? `${base}&title=${encodeURIComponent(title)}` : base;
}

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
    // davidshimjs/qrcodejs emits one <rect id="template"> of size 1×1
    // and then one <use href="#template" x="col" y="row"> per dark
    // module. Read the module count from the svg viewBox
    // ("0 0 <n> <n>") and emit one tight dark-rect per use.
    const vb = (svg.getAttribute('viewBox') || '').split(/\s+/);
    const totalModules = Math.round(Number(vb[2]));
    if (!totalModules || !isFinite(totalModules)) return '';
    const uses = svg.querySelectorAll('use');
    if (!uses.length) return '';
    const scale = size / totalModules;
    const parts = [`<rect width="${size}" height="${size}" fill="${bg}"/>`];
    for (const u of uses) {
        const col = Number(u.getAttribute('x')) || 0;
        const row = Number(u.getAttribute('y')) || 0;
        const x = col * scale;
        const y = row * scale;
        // +0.2 avoids sub-pixel seams between adjacent modules when the
        // SVG is rasterised by the browser.
        parts.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${(scale + 0.2).toFixed(2)}" height="${(scale + 0.2).toFixed(2)}" fill="${color}"/>`);
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

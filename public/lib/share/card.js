// Client-side share-card renderer. Mirrors the Go template in
// `share_page.go` so the welcome overlay can show a preview before
// the payload has ever been sealed to a CID. Dual implementation is
// intentional: the server card is what link unfurlers fetch (no JS),
// the client card is what the user sees in-app (no round trip).
//
// Visual parity with the Go renderer is the goal; the ring-dot
// pattern uses a simpler PRNG than Go's fnv+math/rand so individual
// dots may differ, but the composition is identical.

const GENRE_COLORS = {
    techno: '#e94560', house: '#f5a623', jazz: '#9b59b6', ambient: '#4a90d9',
    dnb: '#2ecc71', edm: '#00d2ff', speedcore: '#ff2a2a', dubstep: '#8b00ff',
    trance: '#ffaa00', lofi: '#d4a574', trap: '#ff6b6b', synthwave: '#ff00aa',
    reggae: '#2ecc71', country: '#d4a574', metal: '#555555', garage: '#00aaff',
    blues: '#4a90d9', bossa: '#f5a623', funk: '#e94560',
};

function colorForGenre(g) { return GENRE_COLORS[g] || '#4a90d9'; }

function svgEscape(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]
    ));
}

// mulberry32 — same PRNG family the generator uses. Deterministic
// per seed, fine for a visual fingerprint.
function seededRand(seed) {
    let a = (seed | 0) + 0x9e3779b9;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function ringDotsForSeed(seed, n = 16) {
    const rand = seededRand(seed);
    const cx = 1000, cy = 315, radius = 220;
    const dots = [];
    for (let i = 0; i < n; i++) {
        const theta = (2 * Math.PI * i) / n - Math.PI / 2;
        const on = rand() < 0.45;
        dots.push({
            x: cx + radius * Math.cos(theta),
            y: cy + radius * Math.sin(theta),
            r: on ? 17 : 11,
            on,
        });
    }
    return dots;
}

// Render the 1200x630 SVG as a string. `title` and `cid` are
// optional projection fields — card still renders without them.
export function renderShareCardSvg(opts) {
    const {
        genre = 'techno', seed = 0, tempo = 120,
        swing = 0, humanize = 0, title = '', cid = '',
    } = opts || {};
    const color = colorForGenre(genre);
    const genreUpper = genre.toUpperCase();
    const hasTitle = !!title;
    const dots = ringDotsForSeed(Number(seed) || 0);
    const dotSvg = dots.map((d) => (
        d.on
            ? `<circle cx="${d.x.toFixed(1)}" cy="${d.y.toFixed(1)}" r="${d.r.toFixed(1)}" fill="${color}"/>`
            : `<circle cx="${d.x.toFixed(1)}" cy="${d.y.toFixed(1)}" r="${d.r.toFixed(1)}" fill="none" stroke="${color}" stroke-width="2" opacity="0.5"/>`
    )).join('\n    ');

    const leftPanel = hasTitle
        ? `<text x="70" y="120" font-size="60" font-weight="800" fill="#eee" letter-spacing="-1.5">${svgEscape(title)}</text>
    <text x="70" y="170" font-size="28" font-weight="700" fill="${color}" letter-spacing="2">${svgEscape(genreUpper)}</text>
    <text x="70" y="205" font-size="18" fill="#999" letter-spacing="4">BEATS · BITWRAP · IO</text>`
        : `<text x="70" y="140" font-size="72" font-weight="800" fill="${color}" letter-spacing="-2">${svgEscape(genreUpper)}</text>
    <text x="70" y="200" font-size="22" fill="#999" letter-spacing="4">BEATS · BITWRAP · IO</text>`;

    const cidText = cid
        ? `<text x="70" y="610" font-family="ui-monospace, monospace" font-size="18" fill="#777">${svgEscape(cid)}</text>`
        : `<text x="70" y="610" font-family="ui-monospace, monospace" font-size="18" fill="#555">unsealed · share to mint a CID</text>`;

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="100%" preserveAspectRatio="xMidYMid meet">
  <defs>
    <linearGradient id="pn-card-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0d0d0d"/>
      <stop offset="1" stop-color="#1a1a2e"/>
    </linearGradient>
    <radialGradient id="pn-card-glow" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="${color}" stop-opacity="0.35"/>
      <stop offset="1" stop-color="${color}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#pn-card-bg)"/>
  <circle cx="1000" cy="315" r="280" fill="url(#pn-card-glow)"/>
  <g font-family="system-ui, -apple-system, sans-serif" fill="#eee">
    ${leftPanel}
    <g font-family="ui-monospace, SFMono-Regular, monospace">
      <text x="70" y="290" font-size="28" fill="#888">TEMPO</text>
      <text x="70" y="340" font-size="56" font-weight="700" fill="#eee">${tempo}<tspan font-size="28" fill="#888"> BPM</tspan></text>
      <text x="70" y="410" font-size="18" fill="#888">SEED</text>
      <text x="70" y="440" font-size="28" fill="#ccc">${seed}</text>
      <text x="340" y="410" font-size="18" fill="#888">SWING · HUMANIZE</text>
      <text x="340" y="440" font-size="28" fill="#ccc">${swing} · ${humanize}</text>
    </g>
  </g>
  <g stroke="${color}" stroke-width="2" fill="none" opacity="0.4">
    <circle cx="1000" cy="315" r="220"/>
  </g>
  <g>
    ${dotSvg}
  </g>
  <rect x="0" y="570" width="1200" height="60" fill="#000" opacity="0.4"/>
  ${cidText}
  <text x="1130" y="610" font-family="system-ui, sans-serif" font-size="18" fill="#888" text-anchor="end">open in a browser to play →</text>
</svg>`;
}

// Convenience: pull fields out of the element's current state and
// render. Keeps callers from reaching into internal shape.
export function renderCurrentCard(el, title = '') {
    const project = el._project || {};
    const genre = el.querySelector('.pn-genre')?.value || project.genre || 'techno';
    const seed = el._currentGen?.params?.seed ?? project.seed ?? 0;
    const tempo = project.tempo || el._tempo || 120;
    const swing = el._swing ?? project.swing ?? 0;
    const humanize = el._humanize ?? project.humanize ?? 0;
    return renderShareCardSvg({ genre, seed, tempo, swing, humanize, title });
}

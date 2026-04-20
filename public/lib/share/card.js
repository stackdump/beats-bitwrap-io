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

// Seed-driven variant: rotate the genre color's hue in HSL so each
// track gets a visually distinct tint while still reading as the
// genre. Keeps saturation/lightness intact so the card palette
// stays coherent. Rotation range ±30° — enough to see the
// difference between two seeds in the same genre, not so much that
// techno stops feeling red.
function variantColor(baseHex, seed) {
    const [h, s, l] = hexToHsl(baseHex);
    const rand = seededRand(seed || 0);
    const shift = (rand() * 60) - 30; // -30..+30 degrees
    const hue = ((h + shift) % 360 + 360) % 360;
    return hslToHex(hue, s, l);
}

function hexToHsl(hex) {
    const m = hex.replace('#', '');
    const r = parseInt(m.slice(0, 2), 16) / 255;
    const g = parseInt(m.slice(2, 4), 16) / 255;
    const b = parseInt(m.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h * 60, s, l];
}

function hslToHex(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = h / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r = 0, g = 0, b = 0;
    if (hp < 1) [r, g, b] = [c, x, 0];
    else if (hp < 2) [r, g, b] = [x, c, 0];
    else if (hp < 3) [r, g, b] = [0, c, x];
    else if (hp < 4) [r, g, b] = [0, x, c];
    else if (hp < 5) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    const m = l - c / 2;
    const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
    return '#' + to(r) + to(g) + to(b);
}

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
// `qr` is an optional inline `<g>` containing rect modules (see
// lib/share/qr.js:renderQrGroup); when supplied it's placed in the
// centre of the ring.
// Note names for rendering rootNote → "C" / "F#" etc. on the card.
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Short display labels for scale names stashed on the project.
// Keep this list in sync with any new scales added in theory.js.
const SCALE_SHORT = {
    Major: 'MAJ', Minor: 'MIN', Pentatonic: 'PENT', MinPentatonic: 'MIN PENT',
    Blues: 'BLUES', Dorian: 'DOR', Mixolydian: 'MIX', Phrygian: 'PHR',
    HarmonicMin: 'H MIN',
};

// Structure + bars label. A plain "1" for loop mode reads as useless
// noise (every loop track would show it), so show "LOOP". Song-mode
// tracks include the template name so viewers can tell standard apart
// from extended: "STANDARD 60" / "EXTENDED 96".
export function barLabel(bars, structureMode) {
    const mode = (structureMode || '').trim().toUpperCase();
    if (!Number.isFinite(bars) || bars <= 1) return mode || 'LOOP';
    return mode ? `${mode} ${Math.round(bars)}` : String(Math.round(bars));
}

export function keyLabel(rootNote, scaleName) {
    if (rootNote == null || rootNote < 0 || !Number.isFinite(rootNote)) return '';
    const note = NOTE_NAMES[((rootNote % 12) + 12) % 12];
    const tag = SCALE_SHORT[scaleName] || (scaleName || '').toUpperCase();
    return tag ? `${note} ${tag}` : note;
}

export function renderShareCardSvg(opts) {
    const {
        genre = 'techno', seed = 0, tempo = 120,
        title = '', cid = '', qr = '',
        rootNote = null, scaleName = '', bars = 0,
        structureMode = '',
    } = opts || {};
    const color = variantColor(colorForGenre(genre), Number(seed) || 0);
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
      <text x="340" y="410" font-size="18" fill="#888">KEY · MODE</text>
      <text x="340" y="440" font-size="28" fill="#ccc">${svgEscape(keyLabel(rootNote, scaleName) || '—')} · ${svgEscape(barLabel(bars, structureMode))}</text>
    </g>
  </g>
  <g stroke="${color}" stroke-width="2" fill="none" opacity="0.4">
    <circle cx="1000" cy="315" r="220"/>
  </g>
  <g>
    ${dotSvg}
  </g>
  ${qr ? `<g transform="translate(900,215)">${qr}</g>` : ''}
  <rect x="0" y="570" width="1200" height="60" fill="#000" opacity="0.4"/>
  ${cidText}
  <text x="1130" y="610" font-family="system-ui, sans-serif" font-size="18" fill="#888" text-anchor="end">open in a browser to play →</text>
</svg>`;
}

// Convenience: pull fields out of the element's current state and
// render. Keeps callers from reaching into internal shape.
import { renderQrGroup, shortShareUrl } from './qr.js';

export function renderCurrentCard(el, title = '') {
    const project = el._project || {};
    const genre = el.querySelector('.pn-genre')?.value || project.genre || 'techno';
    const seed = el._currentGen?.params?.seed ?? project.seed ?? 0;
    const tempo = project.tempo || el._tempo || 120;
    const rootNote = project.rootNote ?? null;
    const scaleName = project.scaleName || '';
    let bars = project.bars;
    if (bars == null) {
        const structureArr = Array.isArray(project.structure) ? project.structure : [];
        const totalSteps = structureArr.reduce((s, sec) => s + (sec?.steps || 0), 0);
        bars = Math.max(0, Math.round(totalSteps / 16));
    }
    const cid = new URLSearchParams(location.search).get('cid') || '';
    const qr = renderQrGroup(shortShareUrl({ cid, title }), {
        size: 200,
        ecl: 'M',
        color: '#0d0d0d',
        bg: '#ffffff',
    });
    const structureMode = el._currentGen?.params?.structure
        || el.querySelector('.pn-structure-select')?.value
        || '';
    return renderShareCardSvg({ genre, seed, tempo, rootNote, scaleName, bars, structureMode, title, cid, qr });
}

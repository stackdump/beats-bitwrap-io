// Work out a jog-wheel profile from captured messages, assuming NOTHING from
// inpulse-200-mk3.js — that file is the hypothesis, this is the measurement.
// A capture is [{ t: ms, d: [status, data1, data2] }, ...]. Pure functions, so
// a capture saved from real hardware can be re-analysed under node later.

const hex = (n) => '0x' + n.toString(16).toUpperCase().padStart(2, '0');

function tally(items, keyFn) {
    const m = new Map();
    for (const it of items) {
        const k = keyFn(it);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(it);
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
}

const isNote = (m) => (m.d[0] & 0xF0) === 0x90 || (m.d[0] & 0xF0) === 0x80;
const isCC = (m) => (m.d[0] & 0xF0) === 0xB0;
const isDown = (m) => (m.d[0] & 0xF0) === 0x90 && m.d[2] > 0;

// The touch sensor: the note (channel + number) pressed and released most.
export function detectTouch(capture) {
    const groups = tally(capture.filter(isNote), (m) => `${m.d[0] & 0x0F}:${m.d[1]}`);
    if (!groups.length) return null;
    const [key, msgs] = groups[0];
    const [channel, note] = key.split(':').map(Number);
    const downs = msgs.filter(isDown);
    const ups = msgs.filter((m) => !isDown(m));
    return {
        channel,
        note,
        onVelocity: downs[0]?.d[2] ?? null,
        releaseAsNoteOff: ups.length ? ups.every((m) => (m.d[0] & 0xF0) === 0x80) : null,
        presses: downs.length,
        releases: ups.length,
        otherNotes: groups.slice(1).map(([k, v]) => `${k} ×${v.length}`),
        // CCs that arrived between a press and its release with the wheel
        // supposedly still: a twitchy encoder or a too-sensitive surface.
        strayCCs: capture.filter(isCC).length,
    };
}

// Name the relative encoding from the values seen. Rotation in ONE direction
// is enough: two's complement sits near 0x01 or 0x7F, offset-64 hugs 0x40.
export function detectEncoding(values) {
    const near = (v, c, w) => Math.abs(v - c) <= w;
    const twos = values.filter((v) => (v >= 0x01 && v <= 0x1F) || (v >= 0x61 && v <= 0x7F)).length;
    const off = values.filter((v) => near(v, 0x40, 0x1F) && v !== 0x40).length;
    // A long monotone run means an absolute position counter, which nothing
    // here supports — say so rather than mis-decode it.
    let mono = 0;
    for (let i = 1; i < values.length; i++) {
        const d = (values[i] - values[i - 1] + 128) % 128;
        if (d === 1 || d === 127) mono++;
    }
    if (values.length > 16 && mono / (values.length - 1) > 0.9) return 'absolute';
    return off > twos ? 'offset64' : 'twos';
}

function decode(v, encoding) {
    return encoding === 'offset64' ? v - 0x40 : (v < 0x40 ? v : v - 0x80);
}

// The rotation stream: the (channel, CC) carrying the most messages.
export function detectRotation(capture) {
    const groups = tally(capture.filter(isCC), (m) => `${m.d[0] & 0x0F}:${m.d[1]}`);
    if (!groups.length) return null;
    const [key, msgs] = groups[0];
    const [channel, cc] = key.split(':').map(Number);
    const values = msgs.map((m) => m.d[2]);
    const encoding = detectEncoding(values);
    const ticks = encoding === 'absolute' ? [] : values.map((v) => decode(v, encoding));
    const sum = ticks.reduce((a, b) => a + b, 0);
    return {
        channel,
        cc,
        encoding,
        messages: msgs.length,
        netTicks: sum,
        direction: Math.sign(sum),
        reversals: ticks.filter((t) => Math.sign(t) === -Math.sign(sum)).length,
        maxMagnitude: ticks.reduce((a, t) => Math.max(a, Math.abs(t)), 0),
        distinctValues: [...new Set(values)].sort((a, b) => a - b).map(hex),
        otherCCs: groups.slice(1).map(([k, v]) => `${k} ×${v.length}`),
        touchedDuring: capture.some(isDown),
        ...timing(msgs),
    };
}

// Delivery statistics: how fast, how bursty, how coarse the timestamps are.
export function timing(msgs) {
    if (msgs.length < 2) return { peakPerSec: msgs.length, maxPerTimestamp: 1, timestampStepMs: null };
    let peak = 0;
    for (let i = 0, j = 0; i < msgs.length; i++) {
        while (msgs[i].t - msgs[j].t > 1000) j++;
        peak = Math.max(peak, i - j + 1);
    }
    const perStamp = tally(msgs, (m) => m.t);
    const gaps = [];
    for (let i = 1; i < msgs.length; i++) if (msgs[i].t > msgs[i - 1].t) gaps.push(msgs[i].t - msgs[i - 1].t);
    gaps.sort((a, b) => a - b);
    return {
        peakPerSec: peak,
        maxPerTimestamp: perStamp[0][1].length,
        // Smallest positive gap ~ the clock the timestamps are quantized to.
        timestampStepMs: gaps.length ? Number(gaps[0].toFixed(3)) : null,
    };
}

// Free-spin decay: after the last touch release, fit tick rate ~ exp(-t/tau).
export function detectCoast(capture) {
    let lastUp = -1;
    capture.forEach((m, i) => { if (isNote(m) && !isDown(m)) lastUp = i; });
    if (lastUp < 0) return null;
    const tail = capture.slice(lastUp + 1).filter(isCC);
    if (tail.length < 20) return { ticks: tail.length, tauSec: null };
    const t0 = tail[0].t;
    // log-linear regression on the rate in 50 ms bins
    const bins = new Map();
    for (const m of tail) bins.set(Math.floor((m.t - t0) / 50), (bins.get(Math.floor((m.t - t0) / 50)) || 0) + 1);
    const pts = [...bins.entries()].filter(([, n]) => n >= 2).map(([b, n]) => [b * 0.05, Math.log(n)]);
    if (pts.length < 3) return { ticks: tail.length, tauSec: null };
    const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const slope = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
    return { ticks: tail.length, durationSec: (tail.at(-1).t - t0) / 1000, tauSec: slope < 0 ? Number((-1 / slope).toFixed(2)) : null };
}

// --- the calibration script ---------------------------------------------------
// Each step: what to do with your hands, how to read the capture, and which
// profile fields the reading settles. `analyze` gets this step's capture plus
// the results of earlier steps.

export const STEPS = [
    {
        id: 'touch',
        title: 'Touch',
        ask: 'Deck A (left). WITHOUT turning it, touch the top of the platter and lift off — three times.',
        analyze: (cap) => detectTouch(cap),
        settle: (r) => r && { decks: { A: r.channel }, touch: { note: r.note, onVelocity: r.onVelocity, releaseAsNoteOff: !!r.releaseAsNoteOff } },
        warn: (r) => [
            !r && 'No note messages at all. Try "Send wake-up", or the touch surface may not be a note on this firmware.',
            r && r.presses !== 3 && `Saw ${r.presses} presses, expected 3 — bouncy sensor, or an extra touch.`,
            r && r.strayCCs > 0 && `${r.strayCCs} CC messages arrived with the wheel supposedly still.`,
            r && r.otherNotes.length && `Other notes seen: ${r.otherNotes.join(', ')}`,
        ],
    },
    {
        id: 'scratch-cw',
        title: 'One turn clockwise, touching',
        ask: 'Put a mark (tape, or use the logo) at 12 o\'clock. Finger on TOP of the platter, turn exactly ONE revolution CLOCKWISE, slowly, then lift off.',
        analyze: (cap) => detectRotation(cap),
        settle: (r) => r && r.encoding !== 'absolute' && { scratchCC: r.cc, encoding: r.encoding, ticksPerRev: Math.abs(r.netTicks), _cwSign: r.direction },
        warn: (r) => [
            !r && 'No CC messages. If the wheel sends something other than CC (pitch bend 0xEn?), read the raw log.',
            r && r.encoding === 'absolute' && 'Values look like an ABSOLUTE counter, not relative ticks. The adapter needs a new decode path — save the capture.',
            r && !r.touchedDuring && 'No touch note during this step — did the surface register?',
            r && r.direction < 0 && 'Clockwise decoded as NEGATIVE. Encoding guess may be inverted; compare with the next step.',
            r && r.reversals > 2 && `${r.reversals} ticks in the opposite direction — hand wobble or encoder noise.`,
            r && r.otherCCs.length && `Other CCs seen: ${r.otherCCs.join(', ')}`,
        ],
    },
    {
        id: 'scratch-ccw',
        title: 'One turn counter-clockwise, touching',
        ask: 'Same again, exactly ONE revolution COUNTER-CLOCKWISE, touching the top.',
        analyze: (cap) => detectRotation(cap),
        settle: (r, prior) => {
            const cw = prior['scratch-cw'];
            if (!r || !cw || r.encoding === 'absolute') return null;
            return { ticksPerRev: Math.round((Math.abs(cw.netTicks) + Math.abs(r.netTicks)) / 2) };
        },
        warn: (r, prior) => {
            const cw = prior['scratch-cw'];
            return [
                r && cw && r.direction === cw.direction && 'Both directions decoded with the SAME sign — encoding is not what was guessed.',
                r && cw && r.cc !== cw.cc && `Counter-clockwise used CC ${hex(r.cc)} but clockwise used ${hex(cw.cc)} — direction may be split across two CCs.`,
                r && cw && Math.abs(Math.abs(r.netTicks) - Math.abs(cw.netTicks)) > 0.06 * Math.abs(cw.netTicks) &&
                    `Turn counts differ: ${Math.abs(cw.netTicks)} vs ${Math.abs(r.netTicks)}. Repeat both for a trustworthy ticks/rev.`,
            ];
        },
    },
    {
        id: 'bend',
        title: 'Outer ring',
        ask: 'Do NOT touch the top. Turn the wheel by its OUTER EDGE about one revolution clockwise.',
        analyze: (cap) => detectRotation(cap),
        settle: (r) => r && { bendCC: r.cc },
        warn: (r, prior) => [
            r && r.touchedDuring && 'A touch note fired — the edge is triggering the touch sensor (or a finger strayed).',
            r && prior['scratch-cw'] && r.cc === prior['scratch-cw'].cc && 'Same CC as touched rotation: the firmware does NOT switch CC by touch. The adapter must then use the touch note alone to tell scratch from bend (it already tolerates this).',
        ],
    },
    {
        id: 'spin',
        title: 'Hard spin + flick',
        ask: 'Touch the top, spin it as HARD as you can, and let go so it free-spins to a stop by itself.',
        analyze: (cap) => ({ rotation: detectRotation(cap), coast: detectCoast(cap), allCC: timing(cap.filter(isCC)) }),
        settle: (r) => r.rotation && {
            maxMagnitude: Math.max(1, r.rotation.maxMagnitude),
            ...(r.coast?.tauSec ? { coastTauSec: r.coast.tauSec } : {}),
        },
        warn: (r) => [
            r.rotation && r.rotation.maxMagnitude > 1 && `Firmware DOES coalesce: magnitudes up to ${r.rotation.maxMagnitude}.`,
            r.rotation && `Peak ${r.allCC.peakPerSec} msg/s, up to ${r.allCC.maxPerTimestamp} sharing one timestamp, timestamp step ${r.allCC.timestampStepMs} ms.`,
            r.coast && !r.coast.tauSec && 'Not enough free-spin ticks after release to fit a decay — the wheel may be heavily damped.',
        ],
    },
    {
        id: 'shift',
        title: 'Shift layer',
        ask: 'Hold SHIFT. Touch the top of deck A and turn a little. Release everything.',
        analyze: (cap) => ({ touch: detectTouch(cap), rotation: detectRotation(cap) }),
        settle: (r, prior) => {
            const base = prior.touch?.channel;
            const ch = r.touch?.channel ?? r.rotation?.channel;
            return base != null && ch != null && ch !== base ? { shiftChannelOffset: ch - base } : null;
        },
        warn: (r, prior) => [
            (r.touch?.channel ?? r.rotation?.channel) === prior.touch?.channel && 'Same channel as unshifted — SHIFT does not move the jog to another channel on this firmware.',
        ],
    },
    {
        id: 'vinyl',
        title: 'Vinyl button',
        ask: 'Press the VINYL button once to toggle it. Touch the top and turn a little. Then press VINYL again to restore it.',
        analyze: (cap) => detectRotation(cap),
        settle: () => null,
        warn: (r, prior) => [
            r && prior['scratch-cw'] && r.cc !== prior['scratch-cw'].cc
                ? `With Vinyl toggled, touched rotation moved to CC ${hex(r.cc)} — the firmware handles vinyl mode itself.`
                : 'Vinyl does not change the wheel\'s messages (host-side feature, as assumed).',
        ],
    },
    {
        id: 'deck-b',
        title: 'Deck B',
        ask: 'Deck B (right): touch the top and turn a little.',
        analyze: (cap) => ({ touch: detectTouch(cap), rotation: detectRotation(cap) }),
        settle: (r) => (r.touch ? { decks: { B: r.touch.channel } } : null),
        warn: () => [],
    },
];

// Fold every step's settled fields into one override object.
export function buildOverride(results, portName) {
    const out = {};
    for (const step of STEPS) {
        const r = results[step.id];
        if (r === undefined) continue;
        const s = step.settle(r, results);
        if (!s) continue;
        for (const [k, v] of Object.entries(s)) {
            if (k.startsWith('_')) continue;
            out[k] = v && typeof v === 'object' ? { ...out[k], ...v } : v;
        }
    }
    if (portName) {
        out.name = portName;
        out.match = portName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return out;
}

// Field-by-field comparison against the built-in guess.
export function diffProfile(assumed, override) {
    const rows = [];
    const walk = (a, o, prefix) => {
        for (const [k, v] of Object.entries(o)) {
            if (k === 'match' || k === 'name') continue;
            if (v && typeof v === 'object') { walk(a?.[k] || {}, v, `${prefix}${k}.`); continue; }
            rows.push({ field: prefix + k, assumed: a?.[k], measured: v, same: a?.[k] === v });
        }
    };
    walk(assumed, override, '');
    return rows;
}

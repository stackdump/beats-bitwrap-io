/**
 * engine-calls.js: what a btw program's control lines mean to the browser engine.
 *
 * `BtwRun.service()` hands the page `{"op":"call","noun":"inserts","params":{...}}` for every control line that
 * fires: the same calls the desktop makes on its control-language registry. The desktop has the whole registry
 * (insert chains, moves, loops, auto-DJ, ...); the browser engine is djrust's public wasm facade (`Dj`), which has
 * a deck strip, a master FX unit and a few live ops. `mapCall` says what each call becomes there, as a list of
 * worklet ops, or why it is ignored. Pure (no audio, no DOM) so it is tested in Node.
 *
 * HONOURED
 *   mixer     {deck A|B, volume | gain | filter | low | mid | high | mute}  the deck strip, same 0..1 knobs
 *             {crossfader}  {master}                                        the mixer
 *   deck      {action: play | stop | pause, deck}                             the deck's transport
 *   inserts   target Master, effect filter    sweep knob -> both decks' master FX units' lp-freq / hp-freq (cutoff
 *                                             mapped across the two scales; the same cutoff, not the same filter)
 *             target Master, effect reverb    mix -> each deck strip's reverb wet (the master has no reverb here)
 *             target Master, effect crush     mix -> both decks' master FX crushers (crush-bits)
 *             target A | B, effect filter     sweep knob -> the deck strip's filter knob (cutoff mapped across the scales)
 *             target A | B, effect reverb     mix -> that strip's reverb wet
 *   vocoder   {action: set (or none) | swap | add | remove, instance?, carrier?, modulator?, mix, on, insert, ...}
 *             the engine's own vocoder (djrust `live_op("vocoder", ..)`): `carrier=A modulator=B` are decks (also
 *             `deck:A`, `synth`, `voice:robot-choir`), `insert=true` puts the result on the carrier's strip (its fader
 *             and the crossfader), else it plays on its own strip; a ramp (`mix=0 -> 1 over 8 bars`) is one `set` a pass
 *   moves     {action: arm, kind: vocoder_handoff, deck}  the vocoder's carrier and modulator swapped on the next
 *             phrase line (8 bars) of `deck`, as the desktop's move does
 *   (and `sound` commands, which are not calls: kit:NAME -> setKit, anything else -> setRoleVoice)
 *   A `sing` line is not a call here: on this host it is a part of its deck's net (djlive sing.rs, "In the nets"),
 *   so it is sung through the deck like any part and stops with the net.
 * IGNORED, with one console note per kind (and `check` warns about each where the program is written)
 *   inserts delay, filter resonance, crush on a deck, delay time; the Wheel target
 *   vocal (a `sing` line that is timed or performed, `do vocal ...`), vocoder status / list / select / cycle_* / preset_*,
 *   moves (filter_exit, echo_out, loop_roll, bass_swap, phrase_sync), loopsets, queue, autodj, td3,
 *   wheel, `deck load|sync`, mixer pfl / aux / headphone_*, and any other noun
 * The desktop's offline render ignores control lines altogether; the stream the server renders does the same.
 */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const DECKS = ['A', 'B'];

/** The insert sweep knob's corners (mirror of djrust `fx::insert::sweep_corners`): {lp, hp} in Hz, or null. */
export function sweepCorners(v) {
    v = clamp01(v);
    const DEAD = 0.02;
    if (v < 0.5 - DEAD) {
        const t = (0.5 - DEAD - v) / (0.5 - DEAD);
        return { lp: 20000 * Math.pow(60 / 20000, t), hp: null };
    }
    if (v > 0.5 + DEAD) {
        const t = (v - 0.5 - DEAD) / (0.5 - DEAD);
        return { lp: null, hp: 20 * Math.pow(8000 / 20, t) };
    }
    return { lp: null, hp: null };
}

/** The deck strip's filter knob for a corner (inverse of djrust `fx::strip::filter_corners`). */
export function stripFilterKnob({ lp, hp }) {
    if (lp != null) {
        const t = Math.log(Math.max(200, Math.min(20000, lp)) / 20000) / Math.log(200 / 20000);
        return clamp01(0.45 - t * 0.45);
    }
    if (hp != null) {
        const t = Math.log(Math.max(20, Math.min(5000, hp)) / 20) / Math.log(5000 / 20);
        return clamp01(0.55 + t * 0.45);
    }
    return 0.5;
}

/** Master FX sliders (0..100, whole) for the corners (inverse of `MasterChain::lp_freq` / `hp_freq`). */
export function masterFilterSliders({ lp, hp }) {
    const slide = (hz, base, span) => Math.round(Math.max(0, Math.min(100, (100 * Math.log(hz / base)) / Math.log(span))));
    return {
        lp: lp != null ? slide(lp, 100, 200) : 100, // lp-freq 100 = open (20 kHz)
        hp: hp != null ? slide(hp, 20, 250) : 0, //    hp-freq 0 = open (20 Hz)
    };
}

/**
 * The master FX unit's slider `key` at `slider` (its own 0..100 units), as ops. Two things the engine's `masterFx` action
 * needs that are easy to get wrong (test/parity found both): its `value` is a POSITION, 0..1 of the slider's travel
 * (djrust `MasterFxKey::slider_value`), so a whole slider value above 1 was the end stop (a low-pass always open, a
 * high-pass or a crush always at the top); and the unit is the deck's own (beats' per-project master chain), so the
 * program's master is both decks' units set alike.
 */
const masterFx = (key, slider) => DECKS.map((deck) => ({ type: 'perform', deck, json: JSON.stringify({ op: 'masterFx', key, value: Math.round(slider) / 100 }) }));
const param = (deck, name, value) => ({ type: 'param', deck, name, value });
/** A djrust live op (`Dj.live_op(method, params)`): the params as canonical-ish JSON (keys sorted, so a ramp's unchanged pass dedupes). */
const live = (method, params) => ({ type: 'live', method, params: JSON.stringify(Object.fromEntries(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1)))) });
const decksOf = (target) => (target === 'Master' ? DECKS : DECKS.includes(target) ? [target] : []);

/**
 * One registry call as worklet ops. Returns `{ops: [...]}` or `{ops: [], ignored: 'why'}`.
 * Ops: {type:'param', deck, name, value} | {type:'crossfader', value} | {type:'perform', deck, json} |
 *      {type:'play', deck, on} | {type:'live', method, params, phrase?: {deck, bars}} (a djrust live op, at once or on
 *      the next phrase line of `deck`).
 */
export function mapCall(noun, params) {
    const p = params && typeof params === 'object' ? params : {};
    const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
    const ops = [];
    const skipped = [];
    switch (noun) {
    case 'mixer': {
        const deck = p.deck;
        if (p.crossfader !== undefined && Number.isFinite(num(p.crossfader))) ops.push({ type: 'crossfader', value: clamp01(num(p.crossfader)) });
        if (p.master !== undefined && Number.isFinite(num(p.master))) {
            ops.push({ type: 'perform', deck: 'A', json: JSON.stringify({ op: 'master', value: clamp01(num(p.master)) }) });
        }
        const strip = { volume: 'volume', gain: 'gain', filter: 'filter', low: 'eqLow', mid: 'eqMid', high: 'eqHigh' };
        if (DECKS.includes(deck)) {
            for (const [k, name] of Object.entries(strip)) {
                if (p[k] !== undefined && Number.isFinite(num(p[k]))) ops.push(param(deck, name, clamp01(num(p[k]))));
            }
            if (p.mute !== undefined) ops.push(param(deck, 'mute', p.mute === true || p.mute === 'true' || p.mute === 1 ? 1 : 0));
        } else if (deck !== undefined && Object.keys(strip).concat(['mute']).some((k) => p[k] !== undefined)) {
            skipped.push(`mixer deck ${deck}`);
        }
        for (const k of ['pfl', 'aux', 'headphone_mix', 'headphone_level']) if (p[k] !== undefined) skipped.push(`mixer ${k}`);
        break;
    }
    case 'deck': {
        const deck = p.deck;
        if (!DECKS.includes(deck)) { skipped.push('deck without A or B'); break; }
        if (p.action === 'play') ops.push({ type: 'play', deck, on: true });
        else if (p.action === 'stop' || p.action === 'pause') ops.push({ type: 'play', deck, on: false });
        else skipped.push(`deck ${p.action}`);
        break;
    }
    case 'inserts': {
        const target = p.target;
        const decks = decksOf(target);
        const effect = p.effect || (typeof p.param === 'string' ? p.param.split('.')[0] : undefined);
        if (!decks.length) { skipped.push(`inserts on ${target}`); break; }
        const on = p.action === 'on' ? p.on !== false : undefined;
        const value = num(p.value);
        if (effect === 'filter') {
            if (p.action === 'on') {
                if (on === false) {
                    // switched off: open
                    if (target === 'Master') ops.push(...masterFx('lp-freq', 100), ...masterFx('hp-freq', 0));
                    else ops.push(param(target, 'filter', 0.5));
                }
                // switched on: the sweep value that follows sets it
            } else if (p.param === 'filter.sweep' && Number.isFinite(value)) {
                const corners = sweepCorners(value);
                if (target === 'Master') {
                    const s = masterFilterSliders(corners);
                    ops.push(...masterFx('lp-freq', s.lp), ...masterFx('hp-freq', s.hp));
                } else {
                    ops.push(param(target, 'filter', stripFilterKnob(corners)));
                }
            } else {
                skipped.push(`inserts ${p.param || 'filter'}`);
            }
        } else if (effect === 'reverb') {
            if (p.action === 'on' && on === false) for (const d of decks) ops.push(param(d, 'reverbWet', 0));
            else if (p.param === 'reverb.mix' && Number.isFinite(value)) for (const d of decks) ops.push(param(d, 'reverbWet', clamp01(value)));
            else if (p.action !== 'on') skipped.push(`inserts ${p.param || 'reverb'}`);
        } else if (effect === 'crush' && target === 'Master') {
            if (p.action === 'on' && on === false) ops.push(...masterFx('crush-bits', 0));
            else if (p.param === 'crush.mix' && Number.isFinite(value)) ops.push(...masterFx('crush-bits', clamp01(value) * 100));
            else if (p.action !== 'on') skipped.push(`inserts ${p.param || 'crush'}`);
        } else if (p.action === 'on' && on === false) {
            // switching an effect we do not have off is a no-op
        } else {
            skipped.push(`inserts ${effect || p.param || '?'}${target && target !== 'Master' ? ` on ${target}` : ''}`);
        }
        break;
    }
    case 'vocoder': {
        const action = p.action || 'set';
        const rest = {};
        for (const [k, v] of Object.entries(p)) if (k !== 'action') rest[k] = v;
        if (action === 'set' || action === 'on') {
            if (action === 'on' && rest.on === undefined) rest.on = true;
            if (Object.keys(rest).length) ops.push(live('vocoder', rest));
        } else if (action === 'swap') ops.push(live('vocoder', { ...rest, swap: true }));
        else if (action === 'add') ops.push(live('vocoder', { instance: rest.instance ?? 1, on: rest.on ?? true }));
        else if (action === 'remove') ops.push(live('vocoder', { instance: rest.instance ?? 1, remove: true }));
        else skipped.push(`vocoder ${action}`);
        break;
    }
    case 'moves': {
        if (p.action === 'arm' && p.kind === 'vocoder_handoff') {
            ops.push({ ...live('vocoder', { swap: true }), phrase: { deck: DECKS.includes(p.deck) ? p.deck : 'A', bars: 8 } });
        } else skipped.push('moves');
        break;
    }
    default:
        skipped.push(noun);
    }
    return skipped.length ? { ops, ignored: skipped.join(', ') } : { ops };
}

/**
 * A `sound` command ({deck, role, option}) as a worklet op: `kit:NAME` is a drum kit, anything else the role's voice
 * (`synth:reese`, `inst:NAME`, a voice name).
 */
export function mapSound(deck, role, option) {
    const kit = typeof option === 'string' && option.startsWith('kit:') ? option.slice(4) : null;
    const json = kit !== null ? { op: 'setKit', deck, kit } : { op: 'setRoleVoice', deck, role, voice: option };
    return { type: 'perform', deck, json: JSON.stringify(json) };
}

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
 *   inserts   target Master, effect filter    sweep knob -> the master FX unit's lp-freq / hp-freq (cutoff mapped
 *                                             across the two scales; the same cutoff, not the same filter)
 *             target Master, effect reverb    mix -> each deck strip's reverb wet (the master has no reverb here)
 *             target Master, effect crush     mix -> the master FX crusher (crush-bits)
 *             target A | B, effect filter     sweep knob -> the deck strip's filter knob (cutoff mapped across the scales)
 *             target A | B, effect reverb     mix -> that strip's reverb wet
 *   (and `sound` commands, which are not calls: kit:NAME -> setKit, anything else -> setRoleVoice)
 * IGNORED, with one console note per kind
 *   inserts delay, filter resonance, crush on a deck, delay time; the Wheel target
 *   moves (filter_exit, echo_out, loop_roll, bass_swap, phrase_sync, vocoder_handoff), loopsets, queue, autodj, td3,
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

const masterFx = (key, value) => ({ type: 'perform', deck: 'A', json: JSON.stringify({ op: 'masterFx', key, value }) });
const param = (deck, name, value) => ({ type: 'param', deck, name, value });
const decksOf = (target) => (target === 'Master' ? DECKS : DECKS.includes(target) ? [target] : []);

/**
 * One registry call as worklet ops. Returns `{ops: [...]}` or `{ops: [], ignored: 'why'}`.
 * Ops: {type:'param', deck, name, value} | {type:'crossfader', value} | {type:'perform', deck, json} |
 *      {type:'play', deck, on}.
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
                    if (target === 'Master') ops.push(masterFx('lp-freq', 100), masterFx('hp-freq', 0));
                    else ops.push(param(target, 'filter', 0.5));
                }
                // switched on: the sweep value that follows sets it
            } else if (p.param === 'filter.sweep' && Number.isFinite(value)) {
                const corners = sweepCorners(value);
                if (target === 'Master') {
                    const s = masterFilterSliders(corners);
                    ops.push(masterFx('lp-freq', s.lp), masterFx('hp-freq', s.hp));
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
            if (p.action === 'on' && on === false) ops.push(masterFx('crush-bits', 0));
            else if (p.param === 'crush.mix' && Number.isFinite(value)) ops.push(masterFx('crush-bits', Math.round(clamp01(value) * 100)));
            else if (p.action !== 'on') skipped.push(`inserts ${p.param || 'crush'}`);
        } else if (p.action === 'on' && on === false) {
            // switching an effect we do not have off is a no-op
        } else {
            skipped.push(`inserts ${effect || p.param || '?'}${target && target !== 'Master' ? ` on ${target}` : ''}`);
        }
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

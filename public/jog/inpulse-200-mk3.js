// Device profile for the Hercules DJControl Inpulse 200 MK3 jog wheels.
//
// Everything the simulator emits and the adapter parses comes from this one
// object, so correcting it against real hardware is an edit here and nowhere
// else. Provenance of each value:
//
//   [MIXXX]      taken from Mixxx's community mapping for the ORIGINAL
//                Inpulse 200 (Hercules_DJControl_Inpulse_200.midi.xml +
//                -script.js). Hercules has kept this jog layout stable across
//                the Inpulse 200/300/500, but the MK3 is a different firmware
//                and has NOT been checked.
//   [UNVERIFIED] an educated guess. Verify with the MIDI Monitor modal (or
//                ?midi=real on this page) when the controller arrives.
//
// The checklist in README.md walks through each UNVERIFIED item.

export const INPULSE_200_MK3 = {
    // [UNVERIFIED] Port name as Web MIDI reports it. The match regex is
    // deliberately loose; tighten once the real string is known.
    name: 'DJControl Inpulse 200 Mk3',
    manufacturer: 'Hercules',
    match: /inpulse\s*200/i,

    // [MIXXX] Deck A speaks on MIDI channel 2 (status nibble 1), deck B on
    // channel 3 (nibble 2). Channel 1 (nibble 0) is the mixer section.
    decks: { A: 1, B: 2 },
    // [MIXXX] Holding SHIFT moves the same controls up three channels
    // (0x91 -> 0x94, 0xB1 -> 0xB4).
    shiftChannelOffset: 3,

    // [MIXXX] Capacitive top surface: note 0x08, velocity 0x7F on touch.
    // [UNVERIFIED] Release form. Hercules firmware conventionally sends
    // note-on with velocity 0 (0x9n 08 00) rather than a true note-off
    // (0x8n 08 00). The adapter accepts both; the simulator emits whichever
    // this flag says.
    touch: { note: 0x08, onVelocity: 0x7F, releaseAsNoteOff: false },

    // [MIXXX] The firmware picks the CC by touch state: rotating with the top
    // touched sends 0x0A (scratch), rotating by the outer ring sends 0x09
    // (pitch bend / nudge). It is not a pitch-bend (0xEn) message.
    scratchCC: 0x0A,
    bendCC: 0x09,

    // [MIXXX] Relative encoding, 7-bit two's complement: 0x01 = one tick
    // clockwise, 0x7F = one tick counter-clockwise. Mixxx's script notes the
    // controller "always sends either 0x1 or 0x7F" — i.e. ONE MESSAGE PER
    // ENCODER TICK, so message rate is proportional to wheel speed rather
    // than being a fixed poll rate.
    // [UNVERIFIED] Whether the MK3 ever coalesces fast motion into a larger
    // magnitude (0x02, 0x7E ...). decodeRelative() handles it either way; set
    // maxMagnitude > 1 to make the simulator coalesce per USB frame.
    maxMagnitude: 1,
    // 'twos'     0x01 = +1, 0x7F = -1  (7-bit two's complement)  <- assumed
    // 'offset64' 0x41 = +1, 0x3F = -1  (centred on 0x40; common on other
    //            vendors' jog wheels, listed so calibration can name it)
    encoding: 'twos',

    // [MIXXX] 248 is what Mixxx passes to scratchEnable() as intervals per
    // revolution. [UNVERIFIED] It may be a tuned-by-feel number rather than
    // the true encoder count: rotate the real wheel exactly once and count.
    ticksPerRev: 248,

    // Convention, not hardware: one platter revolution = one turn of a
    // 33 1/3 rpm record = 1.8 s of audio at 1x.
    platterRpm: 33 + 1 / 3,

    // USB full-speed class-compliant MIDI is serviced once per 1 ms frame;
    // several 4-byte events can share a frame. So timestamps are quantized to
    // 1 ms and bursts share a timestamp. [UNVERIFIED] Whether the firmware
    // imposes its own lower cap on events per frame.
    usbFrameMs: 1,

    // [UNVERIFIED] Free-spin decay of the platter after a flick (seconds for
    // speed to fall to 1/e). Pure feel; the 200-class wheels are small and
    // light, so this is short.
    coastTauSec: 0.45,
};

// Relative CC value <-> signed tick count.
export function decodeRelative(value, encoding = 'twos') {
    if (encoding === 'offset64') return value - 0x40;
    return value < 0x40 ? value : value - 0x80;
}

export function encodeRelative(ticks, encoding = 'twos') {
    if (encoding === 'offset64') return (0x40 + ticks) & 0x7F;
    return ticks & 0x7F;
}

// A calibration run (calibrate.html) saves what it measured here; every page
// in the lab layers it over the built-in guess.
export const OVERRIDE_KEY = 'jog-profile-override';

export function withOverride(profile, storage = globalThis.localStorage) {
    let saved = null;
    try { saved = JSON.parse(storage?.getItem(OVERRIDE_KEY) || 'null'); } catch { /* corrupt: ignore */ }
    if (!saved) return { profile, overridden: [] };
    const merged = { ...profile, ...saved, touch: { ...profile.touch, ...saved.touch }, decks: { ...profile.decks, ...saved.decks } };
    if (saved.match) merged.match = new RegExp(saved.match, 'i');
    return { profile: merged, overridden: Object.keys(saved) };
}

// Parse a raw MIDI message against a profile. Returns null for anything that
// is not a jog message, otherwise one of:
//   { kind: 'touch',   deck, shift, down }
//   { kind: 'scratch', deck, shift, ticks }
//   { kind: 'bend',    deck, shift, ticks }
export function parseJogMessage(profile, data) {
    if (!data || data.length < 3) return null;
    const type = data[0] & 0xF0;
    const channel = data[0] & 0x0F;
    let deck = null;
    let shift = false;
    for (const [name, ch] of Object.entries(profile.decks)) {
        if (channel === ch) { deck = name; break; }
        if (channel === ch + profile.shiftChannelOffset) { deck = name; shift = true; break; }
    }
    if (!deck) return null;

    if ((type === 0x90 || type === 0x80) && data[1] === profile.touch.note) {
        return { kind: 'touch', deck, shift, down: type === 0x90 && data[2] > 0 };
    }
    if (type === 0xB0 && (data[1] === profile.scratchCC || data[1] === profile.bendCC)) {
        const ticks = decodeRelative(data[2], profile.encoding);
        if (ticks === 0) return null;
        return { kind: data[1] === profile.scratchCC ? 'scratch' : 'bend', deck, shift, ticks };
    }
    return null;
}

// Seconds of 1x audio that one encoder tick represents.
export function secondsPerTick(profile) {
    return 60 / profile.platterRpm / profile.ticksPerRev;
}

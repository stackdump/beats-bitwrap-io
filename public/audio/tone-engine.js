/**
 * tone-engine.js - Tone.js integration for petri-note
 *
 * Provides sampled instruments and synthesizers driven by MIDI events.
 * Uses send-effects buses (reverb, delay, compressor) for CPU efficiency.
 */

/**
 * Build an effect chain from an array of effect configs.
 * Each config is { type: 'filter'|'chorus'|'delay'|'compressor'|..., ...params }.
 * Returns the head node (connect your synth to it).
 */
function _buildEffectChain(effectConfigs, destination) {
    if (!effectConfigs || effectConfigs.length === 0) return destination;

    const nodes = [];
    for (const cfg of effectConfigs) {
        let node;
        switch (cfg.type) {
            case 'filter':
                node = new Tone.Filter(cfg.frequency || 2000, cfg.filterType || 'lowpass', cfg.rolloff || -12);
                break;
            case 'chorus':
                node = new Tone.Chorus(cfg.frequency || 4, cfg.delayTime || 2.5, cfg.depth || 0.5);
                node.start();
                break;
            case 'delay':
                node = new Tone.FeedbackDelay(cfg.delayTime || '8n', cfg.feedback || 0.3);
                if (cfg.wet !== undefined) node.wet.value = cfg.wet;
                break;
            case 'compressor':
                node = new Tone.Compressor(cfg.threshold || -24, cfg.ratio || 4);
                break;
            case 'distortion':
                node = new Tone.Distortion(cfg.amount || 0.4);
                break;
            case 'phaser':
                node = new Tone.Phaser({ frequency: cfg.frequency || 2, octaves: cfg.octaves || 3, baseFrequency: cfg.baseFrequency || 1000 });
                break;
            case 'vibrato':
                node = new Tone.Vibrato(cfg.frequency || 5, cfg.depth || 0.1);
                break;
            case 'autoFilter':
                node = new Tone.AutoFilter({ frequency: cfg.frequency || 4, baseFrequency: cfg.baseFrequency || 100, octaves: cfg.octaves || 4 });
                node.start();
                break;
            case 'tremolo':
                node = new Tone.Tremolo(cfg.frequency || 4, cfg.depth || 0.6);
                node.start();
                break;
            case 'pingPongDelay':
                node = new Tone.PingPongDelay(cfg.delayTime || '8n', cfg.feedback || 0.25);
                if (cfg.wet !== undefined) node.wet.value = cfg.wet;
                break;
            default:
                continue;
        }
        nodes.push(node);
    }

    // Chain: last node -> destination, each node -> next
    for (let i = nodes.length - 1; i >= 0; i--) {
        const next = i === nodes.length - 1 ? destination : nodes[i + 1];
        nodes[i].connect(next);
    }
    return nodes.length > 0 ? nodes[0] : destination;
}

/**
 * Synthesized drum kit factory - layered for richer sound.
 * Returns an object with triggerAttackRelease + dispose matching synth interface.
 */
function _synthDrumKit(destination, opts) {
    // Per-voice LP/HP filter pairs for independent mixer control
    const voiceFilters = {};
    for (const role of ['kick', 'snare', 'hihat', 'clap']) {
        const lp = new Tone.Filter({ frequency: 20000, type: 'lowpass', rolloff: -12, Q: 1 });
        const hp = new Tone.Filter({ frequency: 20, type: 'highpass', rolloff: -12, Q: 1 });
        hp.connect(lp);
        lp.connect(destination);
        voiceFilters[role] = { lpFilter: lp, hpFilter: hp };
    }

    // Layered kick: membrane body + short click transient
    const kickDest = voiceFilters.kick.hpFilter;
    const kickBody = new Tone.MembraneSynth({
        pitchDecay: 0.05, octaves: opts.kickOctaves,
        oscillator: { type: 'sine' },
        envelope: { attack: 0.003, decay: opts.kickDecay, sustain: 0, release: 0.1 }
    }).connect(kickDest);

    const kickClick = new Tone.Synth({
        oscillator: { type: 'triangle' },
        envelope: { attack: 0.001, decay: 0.02, sustain: 0, release: 0.01 }
    }).connect(kickDest);
    kickClick.volume.value = -12;

    // Snare: noise + body through bandpass
    const snareDest = voiceFilters.snare.hpFilter;
    const snareFilter = new Tone.Filter(3000, 'bandpass', -12).connect(snareDest);
    const snareNoise = new Tone.NoiseSynth({
        noise: { type: 'white' },
        envelope: { attack: 0.001, decay: opts.snareDecay, sustain: 0, release: 0.1 }
    }).connect(snareFilter);

    const snareBody = new Tone.MembraneSynth({
        pitchDecay: 0.01, octaves: 2,
        oscillator: { type: 'sine' },
        envelope: { attack: 0.001, decay: 0.08, sustain: 0, release: 0.05 }
    }).connect(snareDest);
    snareBody.volume.value = -8;

    // Hihat: filtered noise (more reliable than MetalSynth for rapid retriggers)
    const hihatDest = voiceFilters.hihat.hpFilter;
    const hihatFilter = new Tone.Filter(8000, 'bandpass', -12).connect(hihatDest);
    const hihat = new Tone.NoiseSynth({
        noise: { type: 'white' },
        envelope: { attack: 0.001, decay: opts.hihatDecay, sustain: 0, release: 0.01 }
    }).connect(hihatFilter);
    hihat.volume.value = opts.hihatVol + 4;

    // Clap: multi-burst noise for realism
    const clapDest = voiceFilters.clap.hpFilter;
    const clapFilter = new Tone.Filter(2500, 'bandpass', -12).connect(clapDest);
    const clap = new Tone.NoiseSynth({
        noise: { type: 'pink' },
        envelope: { attack: 0.001, decay: 0.15, sustain: 0, release: 0.1 }
    }).connect(clapFilter);

    return {
        _voiceFilters: voiceFilters,
        triggerAttackRelease: (note, duration, time, velocity) => {
            const midiNote = typeof note === 'string' ? Tone.Frequency(note).toMidi() : note;
            const vel = velocity || 0.8;
            if (midiNote === 36 || midiNote === 35) {
                kickBody.triggerAttackRelease('C1', '8n', time, vel);
                kickClick.triggerAttackRelease('C5', '64n', time, vel * 0.6);
            } else if (midiNote === 38 || midiNote === 40) {
                snareNoise.triggerAttackRelease('8n', time, vel);
                snareBody.triggerAttackRelease('E2', '16n', time, vel * 0.7);
            } else if (midiNote === 39) {
                // Multi-burst clap: stagger 3 hits
                clap.triggerAttackRelease('32n', time, vel * 0.5);
                clap.triggerAttackRelease('32n', time + 0.01, vel * 0.6);
                clap.triggerAttackRelease('16n', time + 0.02, vel);
            } else if (midiNote >= 42 && midiNote <= 46) {
                hihat.triggerAttackRelease('32n', time, vel);
            } else if (midiNote === 49 || midiNote === 57) {
                hihat.triggerAttackRelease('8n', time, vel);
            } else {
                kickBody.triggerAttackRelease('C1', '8n', time, vel);
                kickClick.triggerAttackRelease('C5', '64n', time, vel * 0.6);
            }
        },
        dispose: () => {
            kickBody.dispose(); kickClick.dispose();
            snareNoise.dispose(); snareBody.dispose(); snareFilter.dispose();
            hihat.dispose(); hihatFilter.dispose();
            clap.dispose(); clapFilter.dispose();
            for (const vf of Object.values(voiceFilters)) {
                vf.lpFilter.dispose();
                vf.hpFilter.dispose();
            }
        }
    };
}

// Gain normalization (dB) per instrument to equalize perceived loudness.
// 0 = reference level. Positive = boost quiet instruments, negative = cut loud ones.
// Auto-leveled to ~0.5 peak target. Transient instruments (drums, bells) hand-tuned.
const INSTRUMENT_GAIN = {
    // Keys
    'piano': 13, 'electric-piano': 10, 'organ': -5, 'clavinet': 11, 'harpsichord': 8,
    // Bass
    'bass': -2, 'sub-bass': -2, 'acid': 6, 'reese': 1, '808-bass': 3, 'wobble-bass': -2, 'rubber-bass': 4,
    // Leads
    'lead': -5, 'square-lead': -5, 'pwm-lead': -7, 'supersaw': -2, 'hoover': 4,
    'detuned-saw': 0, 'distorted-lead': -1, 'scream-lead': 0, 'rave-stab': 8,
    'sync-lead': -6, 'tape-lead': -2, 'talkbox': -3,
    // Pads
    'pad': -1, 'warm-pad': 3, 'strings': -1, 'dark-pad': 2, 'glass-pad': 7, 'choir': 7,
    // Bells / Percussion (hand-tuned — analyser can't measure transients reliably)
    'fm-bell': 8, 'marimba': 10, 'vibes': 0, 'kalimba': 10, 'steel-drum': 0, 'music-box': 10,
    'metallic': 4, 'noise-hit': 4,
    // Pluck / Guitar
    'pluck': 8, 'bright-pluck': 2, 'muted-pluck': 12, 'acoustic-guitar': 10,
    'electric-guitar': 4, 'distorted-guitar': 1, 'sitar': 3,
    // Brass / Wind
    'brass': -3, 'trumpet': -6, 'flute': -4, 'sax': 0,
    // Drums (hand-tuned)
    'drums': 0, 'drums-808': 6, 'drums-breakbeat': 0, 'drums-cr78': 6,
    'drums-v8': 6, 'drums-lofi': 0,
    // DuoSynth
    'duo-lead': -10, 'duo-bass': 0,
    // AMSynth
    'am-bell': 8, 'am-pad': 10,
    // EDM
    'big-saw': 2, 'edm-stab': -4, 'trance-lead': -5, 'edm-pluck': 6,
    'drop-bass': 3, 'chiptune': 1, 'rave-organ': 3, 'laser': -2,
    'wobble-lead': -3, 'screech': -1, 'fm-bass': 5,
    // Misc
    'sine': 5
};

const INSTRUMENT_CONFIGS = {
    // === Keys (all synthesized - no external samples) ===

    'piano': {
        type: 'synth', synth: 'PolySynth',
        options: {
            options: {
                oscillator: { type: 'triangle' },
                envelope: { attack: 0.005, decay: 0.3, sustain: 0.2, release: 0.8 }
            }
        }
    },

    'electric-piano': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.PolySynth(Tone.Synth, {
                oscillator: { type: 'fmsine', modulationIndex: 3 },
                envelope: { attack: 0.01, decay: 0.2, sustain: 0.3, release: 0.5 }
            });
            // Tremolo + chorus for Rhodes-like warmth
            const tremolo = new Tone.Tremolo(3.5, 0.3).connect(dest);
            tremolo.start();
            const chorus = new Tone.Chorus(2, 1.5, 0.4).connect(tremolo);
            chorus.start();
            return synth.connect(chorus);
        }
    },

    // === Bass Synths ===

    'bass': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.MonoSynth({
                oscillator: { type: 'square' },
                envelope: { attack: 0.01, decay: 0.2, sustain: 0.4, release: 0.3 },
                filterEnvelope: { attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.2, baseFrequency: 200, octaves: 2.5 }
            });
            // Lowpass + compressor for tight bass
            const comp = new Tone.Compressor(-20, 6);
            comp.connect(dest);
            const filter = new Tone.Filter(800, 'lowpass').connect(comp);
            return synth.connect(filter);
        }
    },

    'sub-bass': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.MonoSynth({
                oscillator: { type: 'sine' },
                envelope: { attack: 0.005, decay: 0.3, sustain: 0.6, release: 0.4 },
                filterEnvelope: { attack: 0.005, decay: 0.1, sustain: 0.8, release: 0.3, baseFrequency: 80, octaves: 1.5 }
            });
            const comp = new Tone.Compressor(-18, 5);
            comp.connect(dest);
            return synth.connect(comp);
        }
    },

    'acid': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.MonoSynth({
                oscillator: { type: 'sawtooth' },
                envelope: { attack: 0.005, decay: 0.15, sustain: 0.2, release: 0.1 },
                filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 0.1, release: 0.1, baseFrequency: 300, octaves: 4 }
            });
            const comp = new Tone.Compressor(-22, 5);
            comp.connect(dest);
            return synth.connect(comp);
        }
    },

    'reese': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.MonoSynth({
                oscillator: { type: 'sawtooth' },
                envelope: { attack: 0.02, decay: 0.5, sustain: 0.7, release: 0.5 },
                filterEnvelope: { attack: 0.05, decay: 0.3, sustain: 0.4, release: 0.3, baseFrequency: 150, octaves: 3 }
            });
            const comp = new Tone.Compressor(-20, 5);
            comp.connect(dest);
            const chorus = new Tone.Chorus(0.5, 3.5, 0.7).connect(comp);
            chorus.start();
            return synth.connect(chorus);
        }
    },

    // === Lead Synths ===

    'lead': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.Synth({
                oscillator: { type: 'sawtooth' },
                envelope: { attack: 0.01, decay: 0.1, sustain: 0.8, release: 0.4 }
            });
            // Ping-pong delay for leads
            const delay = new Tone.PingPongDelay('8n', 0.2);
            delay.wet.value = 0.25;
            delay.connect(dest);
            return synth.connect(delay);
        }
    },

    'square-lead': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.Synth({
                oscillator: { type: 'square' },
                envelope: { attack: 0.005, decay: 0.15, sustain: 0.7, release: 0.3 }
            });
            const delay = new Tone.PingPongDelay('8n', 0.15);
            delay.wet.value = 0.2;
            delay.connect(dest);
            return synth.connect(delay);
        }
    },

    'pwm-lead': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.Synth({
                oscillator: { type: 'pwm', modulationFrequency: 0.5 },
                envelope: { attack: 0.02, decay: 0.2, sustain: 0.6, release: 0.5 }
            });
            const delay = new Tone.PingPongDelay('8n', 0.18);
            delay.wet.value = 0.22;
            delay.connect(dest);
            return synth.connect(delay);
        }
    },

    'supersaw': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.PolySynth(Tone.Synth, {
                oscillator: { type: 'sawtooth' },
                envelope: { attack: 0.01, decay: 0.3, sustain: 0.6, release: 0.5 }
            });
            const delay = new Tone.PingPongDelay('8n', 0.15);
            delay.wet.value = 0.2;
            delay.connect(dest);
            const chorus = new Tone.Chorus(4, 2.5, 0.5).connect(delay);
            chorus.start();
            return synth.connect(chorus);
        }
    },

    'hoover': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.MonoSynth({
                oscillator: { type: 'sawtooth' },
                envelope: { attack: 0.05, decay: 0.4, sustain: 0.5, release: 0.6 },
                filterEnvelope: { attack: 0.02, decay: 0.3, sustain: 0.3, release: 0.4, baseFrequency: 400, octaves: 3 }
            });
            const chorus = new Tone.Chorus(3, 3.5, 0.7).connect(dest);
            chorus.start();
            return synth.connect(chorus);
        }
    },

    'detuned-saw': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.PolySynth(Tone.Synth, {
                oscillator: { type: 'sawtooth' },
                envelope: { attack: 0.005, decay: 0.2, sustain: 0.7, release: 0.3 }
            });
            const chorus = new Tone.Chorus(6, 5.0, 0.9).connect(dest);
            chorus.start();
            return synth.connect(chorus);
        }
    },

    'wobble-bass': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.MonoSynth({
                oscillator: { type: 'sawtooth' },
                envelope: { attack: 0.01, decay: 0.4, sustain: 0.6, release: 0.3 },
                filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 0.3, release: 0.2, baseFrequency: 100, octaves: 4 }
            });
            const comp = new Tone.Compressor(-20, 5);
            comp.connect(dest);
            const autoFilter = new Tone.AutoFilter({ frequency: 4, baseFrequency: 100, octaves: 4 }).connect(comp);
            autoFilter.start();
            return synth.connect(autoFilter);
        }
    },

    'distorted-lead': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.MonoSynth({
                oscillator: { type: 'square' },
                envelope: { attack: 0.005, decay: 0.1, sustain: 0.8, release: 0.2 },
                filterEnvelope: { attack: 0.005, decay: 0.15, sustain: 0.5, release: 0.2, baseFrequency: 600, octaves: 3 }
            });
            const dist = new Tone.Distortion(0.6).connect(dest);
            return synth.connect(dist);
        }
    },

    'scream-lead': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.MonoSynth({
                oscillator: { type: 'sawtooth' },
                envelope: { attack: 0.003, decay: 0.05, sustain: 0.9, release: 0.1 },
                filterEnvelope: { attack: 0.001, decay: 0.1, sustain: 0.7, release: 0.1, baseFrequency: 1000, octaves: 3 }
            });
            const dist = new Tone.Distortion(0.8).connect(dest);
            const phaser = new Tone.Phaser({ frequency: 2, octaves: 3, baseFrequency: 1000 }).connect(dist);
            return synth.connect(phaser);
        }
    },

    'rave-stab': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.PolySynth(Tone.Synth, {
                oscillator: { type: 'sawtooth' },
                envelope: { attack: 0.003, decay: 0.08, sustain: 0.1, release: 0.05 }
            });
            const filter = new Tone.Filter(5000, 'bandpass', -12).connect(dest);
            return synth.connect(filter);
        }
    },

    // === Pads (long envelopes + chorus) ===

    'pad': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.PolySynth(Tone.Synth, {
                oscillator: { type: 'sine' },
                envelope: { attack: 0.6, decay: 0.4, sustain: 0.8, release: 2.0 }
            });
            const chorus = new Tone.Chorus(1.5, 2.0, 0.5).connect(dest);
            chorus.start();
            return synth.connect(chorus);
        }
    },

    'warm-pad': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.PolySynth(Tone.Synth, {
                oscillator: { type: 'triangle' },
                envelope: { attack: 0.8, decay: 0.5, sustain: 0.9, release: 2.5 }
            });
            const chorus = new Tone.Chorus(2, 1.5, 0.8).connect(dest);
            chorus.start();
            return synth.connect(chorus);
        }
    },

    'strings': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.PolySynth(Tone.Synth, {
                oscillator: { type: 'sawtooth' },
                envelope: { attack: 0.5, decay: 0.3, sustain: 0.85, release: 1.5 }
            });
            const chorus = new Tone.Chorus(3, 2.0, 0.6).connect(dest);
            chorus.start();
            const filter = new Tone.Filter(3000, 'lowpass').connect(chorus);
            return synth.connect(filter);
        }
    },

    'dark-pad': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.PolySynth(Tone.Synth, {
                oscillator: { type: 'square' },
                envelope: { attack: 1.0, decay: 0.5, sustain: 0.6, release: 3.0 }
            });
            const chorus = new Tone.Chorus(1, 2.5, 0.6).connect(dest);
            chorus.start();
            const filter = new Tone.Filter(800, 'lowpass').connect(chorus);
            return synth.connect(filter);
        }
    },

    // === Keys / Bells ===

    'fm-bell': {
        type: 'synth', synth: 'FMSynth',
        options: {
            harmonicity: 3.01,
            modulationIndex: 14,
            oscillator: { type: 'sine' },
            envelope: { attack: 0.003, decay: 1.2, sustain: 0, release: 0.5 },
            modulation: { type: 'square' },
            modulationEnvelope: { attack: 0.002, decay: 0.8, sustain: 0, release: 0.5 }
        }
    },

    'marimba': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.FMSynth({
                harmonicity: 5.1, modulationIndex: 2,
                oscillator: { type: 'sine' },
                envelope: { attack: 0.003, decay: 0.6, sustain: 0.05, release: 0.3 },
                modulation: { type: 'triangle' },
                modulationEnvelope: { attack: 0.001, decay: 0.4, sustain: 0, release: 0.2 }
            });
            const comp = new Tone.Compressor(-20, 6).connect(dest);
            return synth.connect(comp);
        }
    },

    'vibes': {
        type: 'synth', synth: 'FMSynth',
        options: {
            harmonicity: 2.01,
            modulationIndex: 4,
            oscillator: { type: 'sine' },
            envelope: { attack: 0.003, decay: 1.8, sustain: 0.1, release: 1.0 },
            modulation: { type: 'sine' },
            modulationEnvelope: { attack: 0.001, decay: 1.0, sustain: 0.1, release: 0.8 }
        }
    },

    'organ': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.PolySynth(Tone.Synth, {
                oscillator: { type: 'sine', partialCount: 6, partials: [1, 0.5, 0.25, 0.125, 0.06, 0.03] },
                envelope: { attack: 0.01, decay: 0.1, sustain: 1.0, release: 0.1 }
            });
            const vibrato = new Tone.Vibrato(5, 0.1).connect(dest);
            return synth.connect(vibrato);
        }
    },

    'clavinet': {
        type: 'synth', synth: 'Synth',
        options: {
            oscillator: { type: 'pulse', width: 0.4 },
            envelope: { attack: 0.003, decay: 0.2, sustain: 0.1, release: 0.1 }
        }
    },

    // === Pluck / Guitar ===

    'pluck': {
        type: 'synth', synth: 'PluckSynth',
        options: { attackNoise: 1, dampening: 4000, resonance: 0.9 }
    },

    'bright-pluck': {
        type: 'synth', synth: 'PluckSynth',
        options: { attackNoise: 2, dampening: 8000, resonance: 0.95 }
    },

    'muted-pluck': {
        type: 'synth', synth: 'PluckSynth',
        options: { attackNoise: 0.5, dampening: 2000, resonance: 0.7 }
    },

    // === Metallic / Noise ===

    'metallic': {
        type: 'custom',
        create: (dest) => {
            // FMSynth with inharmonic ratios to emulate metallic percussion
            // (MetalSynth.connect() is broken in Tone.js v14)
            const synth = new Tone.FMSynth({
                harmonicity: 5.1,
                modulationIndex: 16,
                oscillator: { type: 'square' },
                envelope: { attack: 0.003, decay: 0.4, sustain: 0, release: 0.2 },
                modulation: { type: 'square' },
                modulationEnvelope: { attack: 0.003, decay: 0.3, sustain: 0, release: 0.2 }
            });
            const filter = new Tone.Filter(4000, 'bandpass', -12).connect(dest);
            return synth.connect(filter);
        }
    },

    'noise-hit': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.NoiseSynth({
                noise: { type: 'white' },
                envelope: { attack: 0.003, decay: 0.2, sustain: 0.05, release: 0.1 }
            });
            const comp = new Tone.Compressor(-18, 6).connect(dest);
            synth.connect(comp);
            return {
                triggerAttackRelease: (note, duration, time, velocity) => {
                    synth.triggerAttackRelease(duration, time, velocity);
                },
                dispose: () => { synth.dispose(); comp.dispose(); }
            };
        }
    },

    // === Drums (all synthesized - layered for richer sound) ===

    'drums': {
        type: 'custom',
        create: (dest) => _synthDrumKit(dest, {
            kickDecay: 0.3, kickOctaves: 6,
            snareDecay: 0.15, hihatDecay: 0.05, hihatVol: -10
        })
    },

    'drums-breakbeat': {
        type: 'custom',
        create: (dest) => _synthDrumKit(dest, {
            kickDecay: 0.2, kickOctaves: 4,
            snareDecay: 0.2, hihatDecay: 0.08, hihatVol: -8
        })
    },

    'drums-cr78': {
        type: 'custom',
        create: (dest) => _synthDrumKit(dest, {
            kickDecay: 0.25, kickOctaves: 3,
            snareDecay: 0.12, hihatDecay: 0.04, hihatVol: -12
        })
    },

    'drums-v8': {
        type: 'custom',
        create: (dest) => _synthDrumKit(dest, {
            kickDecay: 0.35, kickOctaves: 8,
            snareDecay: 0.18, hihatDecay: 0.06, hihatVol: -6
        })
    },

    // === 808 / Trap ===

    '808-bass': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.MonoSynth({
                oscillator: { type: 'sine' },
                envelope: { attack: 0.001, decay: 0.8, sustain: 0.3, release: 0.6 },
                filterEnvelope: { attack: 0.001, decay: 0.5, sustain: 0.2, release: 0.4, baseFrequency: 60, octaves: 2 }
            });
            const dist = new Tone.Distortion(0.15).connect(dest);
            const comp = new Tone.Compressor(-18, 6).connect(dist);
            return synth.connect(comp);
        }
    },

    'drums-808': {
        type: 'custom',
        create: (dest) => _synthDrumKit(dest, {
            kickDecay: 0.6, kickOctaves: 8,
            snareDecay: 0.2, hihatDecay: 0.04, hihatVol: -8
        })
    },

    'drums-lofi': {
        type: 'custom',
        create: (dest) => {
            const filter = new Tone.Filter(3000, 'lowpass').connect(dest);
            const crusher = new Tone.BitCrusher(8).connect(filter);
            return _synthDrumKit(crusher, {
                kickDecay: 0.25, kickOctaves: 4,
                snareDecay: 0.15, hihatDecay: 0.05, hihatVol: -10
            });
        }
    },

    // === Brass / Wind ===

    'brass': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.MonoSynth({
                oscillator: { type: 'sawtooth' },
                envelope: { attack: 0.08, decay: 0.2, sustain: 0.7, release: 0.3 },
                filterEnvelope: { attack: 0.06, decay: 0.2, sustain: 0.5, release: 0.2, baseFrequency: 300, octaves: 3 }
            });
            const chorus = new Tone.Chorus(2, 1.5, 0.3).connect(dest);
            chorus.start();
            return synth.connect(chorus);
        }
    },

    'trumpet': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.MonoSynth({
                oscillator: { type: 'sawtooth' },
                envelope: { attack: 0.04, decay: 0.15, sustain: 0.8, release: 0.2 },
                filterEnvelope: { attack: 0.03, decay: 0.15, sustain: 0.6, release: 0.2, baseFrequency: 500, octaves: 2.5 }
            });
            const vibrato = new Tone.Vibrato(5, 0.08).connect(dest);
            return synth.connect(vibrato);
        }
    },

    'flute': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.Synth({
                oscillator: { type: 'sine' },
                envelope: { attack: 0.08, decay: 0.1, sustain: 0.85, release: 0.3 }
            });
            const vibrato = new Tone.Vibrato(5.5, 0.12).connect(dest);
            const filter = new Tone.Filter(4000, 'lowpass').connect(vibrato);
            return synth.connect(filter);
        }
    },

    'sax': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.MonoSynth({
                oscillator: { type: 'square' },
                envelope: { attack: 0.05, decay: 0.2, sustain: 0.7, release: 0.3 },
                filterEnvelope: { attack: 0.03, decay: 0.2, sustain: 0.5, release: 0.2, baseFrequency: 400, octaves: 3 }
            });
            const vibrato = new Tone.Vibrato(5, 0.1).connect(dest);
            const dist = new Tone.Distortion(0.08).connect(vibrato);
            return synth.connect(dist);
        }
    },

    // === Choir / Vox ===

    'choir': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.PolySynth(Tone.FMSynth, {
                harmonicity: 2,
                modulationIndex: 1.5,
                oscillator: { type: 'sine' },
                envelope: { attack: 0.5, decay: 0.3, sustain: 0.9, release: 1.5 },
                modulation: { type: 'sine' },
                modulationEnvelope: { attack: 0.3, decay: 0.2, sustain: 0.8, release: 1.0 }
            });
            const vibrato = new Tone.Vibrato(4.5, 0.15).connect(dest);
            const chorus = new Tone.Chorus(1.5, 2.0, 0.6).connect(vibrato);
            chorus.start();
            return synth.connect(chorus);
        }
    },

    // === World / Ethnic ===

    'sitar': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.PluckSynth({
                attackNoise: 3, dampening: 3000, resonance: 0.98
            });
            const vibrato = new Tone.Vibrato(6, 0.2).connect(dest);
            return synth.connect(vibrato);
        }
    },

    'kalimba': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.FMSynth({
                harmonicity: 8, modulationIndex: 2,
                oscillator: { type: 'sine' },
                envelope: { attack: 0.001, decay: 0.8, sustain: 0.05, release: 0.4 },
                modulation: { type: 'square' },
                modulationEnvelope: { attack: 0.001, decay: 0.5, sustain: 0, release: 0.3 }
            });
            const comp = new Tone.Compressor(-20, 6).connect(dest);
            return synth.connect(comp);
        }
    },

    'steel-drum': {
        type: 'synth', synth: 'FMSynth',
        options: {
            harmonicity: 3.5,
            modulationIndex: 8,
            oscillator: { type: 'sine' },
            envelope: { attack: 0.001, decay: 0.8, sustain: 0.05, release: 0.5 },
            modulation: { type: 'sine' },
            modulationEnvelope: { attack: 0.001, decay: 0.5, sustain: 0, release: 0.4 }
        }
    },

    'music-box': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.FMSynth({
                harmonicity: 6, modulationIndex: 20,
                oscillator: { type: 'sine' },
                envelope: { attack: 0.001, decay: 0.6, sustain: 0.05, release: 0.3 },
                modulation: { type: 'square' },
                modulationEnvelope: { attack: 0.001, decay: 0.3, sustain: 0, release: 0.2 }
            });
            const comp = new Tone.Compressor(-20, 6).connect(dest);
            return synth.connect(comp);
        }
    },

    // === More Keys ===

    'harpsichord': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.PluckSynth({
                attackNoise: 4, dampening: 1500, resonance: 0.85
            });
            const filter = new Tone.Filter(6000, 'lowpass').connect(dest);
            return synth.connect(filter);
        }
    },

    // === Guitars ===

    'acoustic-guitar': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.PluckSynth({
                attackNoise: 2, dampening: 3000, resonance: 0.96
            });
            const filter = new Tone.Filter(4000, 'lowpass').connect(dest);
            return synth.connect(filter);
        }
    },

    'electric-guitar': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.PluckSynth({
                attackNoise: 3, dampening: 5000, resonance: 0.98
            });
            const dist = new Tone.Distortion(0.3).connect(dest);
            const filter = new Tone.Filter(6000, 'lowpass').connect(dist);
            return synth.connect(filter);
        }
    },

    'distorted-guitar': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.PluckSynth({
                attackNoise: 4, dampening: 6000, resonance: 0.99
            });
            const dist = new Tone.Distortion(0.8).connect(dest);
            const filter = new Tone.Filter(5000, 'lowpass').connect(dist);
            return synth.connect(filter);
        }
    },

    // === More Pads ===

    'glass-pad': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.PolySynth(Tone.Synth, {
                oscillator: { type: 'sine' },
                envelope: { attack: 1.0, decay: 0.5, sustain: 0.7, release: 3.0 }
            });
            const delay = new Tone.PingPongDelay('4n', 0.3);
            delay.wet.value = 0.35;
            delay.connect(dest);
            const chorus = new Tone.Chorus(0.8, 3.0, 0.7).connect(delay);
            chorus.start();
            return synth.connect(chorus);
        }
    },

    // === More Leads / FX ===

    'tape-lead': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.Synth({
                oscillator: { type: 'sawtooth' },
                envelope: { attack: 0.01, decay: 0.15, sustain: 0.7, release: 0.3 }
            });
            const crusher = new Tone.BitCrusher(6).connect(dest);
            const filter = new Tone.Filter(3000, 'lowpass').connect(crusher);
            return synth.connect(filter);
        }
    },

    'sync-lead': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.MonoSynth({
                oscillator: { type: 'pulse', width: 0.3 },
                envelope: { attack: 0.003, decay: 0.1, sustain: 0.8, release: 0.2 },
                filterEnvelope: { attack: 0.003, decay: 0.1, sustain: 0.4, release: 0.2, baseFrequency: 800, octaves: 3 }
            });
            const phaser = new Tone.Phaser({ frequency: 3, octaves: 2, baseFrequency: 800 }).connect(dest);
            return synth.connect(phaser);
        }
    },

    'rubber-bass': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.MonoSynth({
                oscillator: { type: 'fmsawtooth', modulationIndex: 5 },
                envelope: { attack: 0.01, decay: 0.3, sustain: 0.5, release: 0.3 },
                filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 0.3, release: 0.2, baseFrequency: 150, octaves: 3.5 }
            });
            const comp = new Tone.Compressor(-20, 5).connect(dest);
            const phaser = new Tone.Phaser({ frequency: 1.5, octaves: 2, baseFrequency: 300 }).connect(comp);
            return synth.connect(phaser);
        }
    },

    'talkbox': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.MonoSynth({
                oscillator: { type: 'sawtooth' },
                envelope: { attack: 0.01, decay: 0.3, sustain: 0.6, release: 0.3 },
                filterEnvelope: { attack: 0.01, decay: 0.3, sustain: 0.4, release: 0.3, baseFrequency: 200, octaves: 4 }
            });
            const autoFilter = new Tone.AutoFilter({ frequency: 2, baseFrequency: 200, octaves: 5 }).connect(dest);
            autoFilter.start();
            return synth.connect(autoFilter);
        }
    },

    // === DuoSynth instruments ===

    'duo-lead': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.DuoSynth({
                vibratoAmount: 0.2, vibratoRate: 5,
                harmonicity: 1.005,
                voice0: {
                    oscillator: { type: 'sawtooth' },
                    envelope: { attack: 0.01, decay: 0.2, sustain: 0.7, release: 0.4 },
                    filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 0.5, release: 0.3, baseFrequency: 400, octaves: 3 }
                },
                voice1: {
                    oscillator: { type: 'square' },
                    envelope: { attack: 0.02, decay: 0.25, sustain: 0.6, release: 0.5 },
                    filterEnvelope: { attack: 0.02, decay: 0.15, sustain: 0.4, release: 0.3, baseFrequency: 600, octaves: 2 }
                }
            });
            const delay = new Tone.PingPongDelay('8n', 0.2);
            delay.wet.value = 0.2;
            delay.connect(dest);
            return synth.connect(delay);
        }
    },

    'duo-bass': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.DuoSynth({
                vibratoAmount: 0, vibratoRate: 0,
                harmonicity: 1.5,
                voice0: {
                    oscillator: { type: 'sawtooth' },
                    envelope: { attack: 0.005, decay: 0.3, sustain: 0.4, release: 0.2 },
                    filterEnvelope: { attack: 0.005, decay: 0.2, sustain: 0.3, release: 0.2, baseFrequency: 100, octaves: 3 }
                },
                voice1: {
                    oscillator: { type: 'square' },
                    envelope: { attack: 0.005, decay: 0.25, sustain: 0.5, release: 0.3 },
                    filterEnvelope: { attack: 0.005, decay: 0.15, sustain: 0.4, release: 0.2, baseFrequency: 80, octaves: 2.5 }
                }
            });
            const comp = new Tone.Compressor(-18, 5).connect(dest);
            return synth.connect(comp);
        }
    },

    // === AMSynth instruments ===

    'am-bell': {
        type: 'synth', synth: 'AMSynth',
        options: {
            harmonicity: 2.5,
            oscillator: { type: 'sine' },
            envelope: { attack: 0.003, decay: 1.5, sustain: 0, release: 0.8 },
            modulation: { type: 'square' },
            modulationEnvelope: { attack: 0.002, decay: 1.0, sustain: 0, release: 0.5 }
        }
    },

    'am-pad': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.PolySynth(Tone.AMSynth, {
                harmonicity: 2,
                oscillator: { type: 'sine' },
                envelope: { attack: 0.8, decay: 0.4, sustain: 0.8, release: 2.0 },
                modulation: { type: 'triangle' },
                modulationEnvelope: { attack: 0.5, decay: 0.3, sustain: 0.7, release: 1.5 }
            });
            const chorus = new Tone.Chorus(1.5, 2.5, 0.6).connect(dest);
            chorus.start();
            return synth.connect(chorus);
        }
    },

    // === EDM Big Riffs / Stabs ===

    'big-saw': {
        type: 'custom',
        create: (dest) => {
            // Triple-detuned supersaw for massive EDM leads
            const synth = new Tone.PolySynth(Tone.Synth, {
                oscillator: { type: 'sawtooth' },
                envelope: { attack: 0.005, decay: 0.4, sustain: 0.7, release: 0.6 }
            });
            const chorus = new Tone.Chorus(6, 5.0, 0.9).connect(dest);
            chorus.start();
            const chorus2 = new Tone.Chorus(2, 3.0, 0.7).connect(chorus);
            chorus2.start();
            return synth.connect(chorus2);
        }
    },

    'edm-stab': {
        type: 'custom',
        create: (dest) => {
            // Short punchy chord stab
            const synth = new Tone.PolySynth(Tone.Synth, {
                oscillator: { type: 'sawtooth' },
                envelope: { attack: 0.001, decay: 0.12, sustain: 0.05, release: 0.08 }
            });
            const filter = new Tone.Filter(6000, 'lowpass', -12).connect(dest);
            const dist = new Tone.Distortion(0.2).connect(filter);
            return synth.connect(dist);
        }
    },

    'trance-lead': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.MonoSynth({
                oscillator: { type: 'sawtooth' },
                envelope: { attack: 0.005, decay: 0.15, sustain: 0.8, release: 0.4 },
                filterEnvelope: { attack: 0.005, decay: 0.2, sustain: 0.6, release: 0.3, baseFrequency: 500, octaves: 3.5 }
            });
            const delay = new Tone.PingPongDelay('8n', 0.25);
            delay.wet.value = 0.3;
            delay.connect(dest);
            const chorus = new Tone.Chorus(3, 2.0, 0.4).connect(delay);
            chorus.start();
            return synth.connect(chorus);
        }
    },

    'edm-pluck': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.Synth({
                oscillator: { type: 'sawtooth' },
                envelope: { attack: 0.001, decay: 0.15, sustain: 0, release: 0.1 }
            });
            const filter = new Tone.Filter(8000, 'lowpass').connect(dest);
            const delay = new Tone.PingPongDelay('16n', 0.15);
            delay.wet.value = 0.3;
            delay.connect(filter);
            return synth.connect(delay);
        }
    },

    'drop-bass': {
        type: 'custom',
        create: (dest) => {
            // Heavy reese-style bass for EDM drops
            const synth = new Tone.MonoSynth({
                oscillator: { type: 'sawtooth' },
                envelope: { attack: 0.003, decay: 0.5, sustain: 0.6, release: 0.3 },
                filterEnvelope: { attack: 0.003, decay: 0.3, sustain: 0.3, release: 0.2, baseFrequency: 60, octaves: 4 }
            });
            const dist = new Tone.Distortion(0.3).connect(dest);
            const comp = new Tone.Compressor(-16, 6).connect(dist);
            const chorus = new Tone.Chorus(0.3, 4.0, 0.8).connect(comp);
            chorus.start();
            return synth.connect(chorus);
        }
    },

    'chiptune': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.Synth({
                oscillator: { type: 'square' },
                envelope: { attack: 0.001, decay: 0.08, sustain: 0.4, release: 0.05 }
            });
            const crusher = new Tone.BitCrusher(4).connect(dest);
            return synth.connect(crusher);
        }
    },

    'rave-organ': {
        type: 'custom',
        create: (dest) => {
            // Classic rave organ stab
            const synth = new Tone.PolySynth(Tone.Synth, {
                oscillator: { type: 'sine', partialCount: 4, partials: [1, 0.6, 0.3, 0.15] },
                envelope: { attack: 0.003, decay: 0.1, sustain: 0.6, release: 0.08 }
            });
            const dist = new Tone.Distortion(0.15).connect(dest);
            return synth.connect(dist);
        }
    },

    'laser': {
        type: 'custom',
        create: (dest) => {
            // Pitch-dropping laser zap
            const synth = new Tone.Synth({
                oscillator: { type: 'sawtooth' },
                envelope: { attack: 0.001, decay: 0.3, sustain: 0, release: 0.05 }
            });
            const filter = new Tone.Filter(10000, 'lowpass', -24).connect(dest);
            return synth.connect(filter);
        }
    },

    'wobble-lead': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.MonoSynth({
                oscillator: { type: 'sawtooth' },
                envelope: { attack: 0.01, decay: 0.3, sustain: 0.7, release: 0.3 },
                filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 0.5, release: 0.2, baseFrequency: 300, octaves: 3 }
            });
            const autoFilter = new Tone.AutoFilter({ frequency: 6, baseFrequency: 200, octaves: 4 }).connect(dest);
            autoFilter.start();
            return synth.connect(autoFilter);
        }
    },

    'screech': {
        type: 'custom',
        create: (dest) => {
            // High-pitched aggressive lead
            const synth = new Tone.MonoSynth({
                oscillator: { type: 'sawtooth' },
                envelope: { attack: 0.001, decay: 0.05, sustain: 0.95, release: 0.05 },
                filterEnvelope: { attack: 0.001, decay: 0.05, sustain: 0.8, release: 0.05, baseFrequency: 2000, octaves: 3 }
            });
            const dist = new Tone.Distortion(0.9).connect(dest);
            const phaser = new Tone.Phaser({ frequency: 4, octaves: 3, baseFrequency: 2000 }).connect(dist);
            return synth.connect(phaser);
        }
    },

    'fm-bass': {
        type: 'custom',
        create: (dest) => {
            const synth = new Tone.FMSynth({
                harmonicity: 0.5,
                modulationIndex: 10,
                oscillator: { type: 'sine' },
                envelope: { attack: 0.005, decay: 0.5, sustain: 0.4, release: 0.3 },
                modulation: { type: 'square' },
                modulationEnvelope: { attack: 0.003, decay: 0.4, sustain: 0.3, release: 0.2 }
            });
            const comp = new Tone.Compressor(-24, 8).connect(dest);
            return synth.connect(comp);
        }
    },

    // Simple fallback
    'sine': {
        type: 'synth', synth: 'Synth',
        options: {
            oscillator: { type: 'sine' },
            envelope: { attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.3 }
        }
    }
};

/**
 * ToneEngine - Main audio engine class
 * Uses send-effects buses: shared reverb, delay, and master compressor.
 */
class ToneEngine {
    constructor() {
        this._started = false;
        this._instruments = new Map();
        this._channelConfigs = new Map();
        this._channelStrips = new Map(); // channel -> { volume, panner }
        this._sustainedNotes = new Map(); // channel -> Set of note names
        this._masterVolume = null;
        this._channelSinks = new Map(); // channel -> { streamDest, audioEl, deviceId }
        this._channelFx = new Map(); // channel -> { reverb, delay, delaySend }
        this._reverb = null;
        this._delay = null;
        this._distortion = null;
        this._lpFilter = null;
        this._hpFilter = null;
        this._masterComp = null;
        this._loading = new Set();
        this._lastNoteTime = 0; // ensures strictly increasing times for Tone.js
    }

    // Call synchronously inside a user gesture to unlock Chrome AudioContext
    resumeContext() {
        Tone.start();
        if (Tone.context.state !== 'running') {
            Tone.context.resume();
        }
    }

    isContextRunning() {
        return Tone.context.state === 'running';
    }

    async init() {
        if (this._started) return;
        if (this._initPromise) return this._initPromise;

        this._initPromise = (async () => {
            await Tone.start();

            // Master chain: volume -> HP -> phaser -> LP -> crusher -> distortion -> compressor -> dest
            this._masterComp = new Tone.Compressor(-12, 3).toDestination();
            this._distortion = new Tone.Distortion({ distortion: 0, wet: 0 }).connect(this._masterComp);
            this._crusher = new Tone.BitCrusher({ bits: 16, wet: 0 }).connect(this._distortion);
            this._lpFilter = new Tone.Filter({ frequency: 20000, type: 'lowpass', rolloff: -12 }).connect(this._crusher);
            this._phaser = new Tone.Phaser({ frequency: 1, octaves: 3, baseFrequency: 350, wet: 0 }).connect(this._lpFilter);
            this._hpFilter = new Tone.Filter({ frequency: 20, type: 'highpass', rolloff: -12 }).connect(this._phaser);
            this._masterVolume = new Tone.Volume(0).connect(this._hpFilter);

            // Send effects buses
            this._reverb = new Tone.Freeverb({
                roomSize: 0.5,
                dampening: 3000,
                wet: 0.2
            }).connect(this._masterVolume);
            this._reverbDampValue = 3000; // track without re-setting

            this._delay = new Tone.FeedbackDelay({
                delayTime: 0.25,
                feedback: 0.25,
                wet: 0.15
            }).connect(this._masterVolume);

            this._started = true;
        })();
        return this._initPromise;
    }

    get isReady() {
        return this._started;
    }

    async listOutputDevices() {
        if (!navigator.mediaDevices?.enumerateDevices) return [];
        let devices = await navigator.mediaDevices.enumerateDevices();
        let outputs = devices.filter(d => d.kind === 'audiooutput');
        // Chrome hides non-default outputs and labels until mic permission is granted.
        const needsPermission = !this._micPermissionRequested &&
            (outputs.length <= 1 || outputs.some(d => !d.label));
        if (needsPermission) {
            this._micPermissionRequested = true;
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                stream.getTracks().forEach(t => t.stop());
                devices = await navigator.mediaDevices.enumerateDevices();
                outputs = devices.filter(d => d.kind === 'audiooutput');
            } catch (err) {
                console.warn('Mic permission denied — output device list limited:', err);
            }
        }
        return outputs;
    }

    async setOutputDevice(deviceId) {
        await this.init();
        const raw = Tone.context.rawContext;

        // Preferred path: AudioContext.setSinkId (Chrome 110+)
        if (typeof raw.setSinkId === 'function') {
            await raw.setSinkId(deviceId || '');
            if (this._masterSink) {
                try { this._masterComp.disconnect(); } catch {}
                this._masterSink.audioEl.srcObject = null;
                this._masterSink.audioEl.remove();
                this._masterSink = null;
                this._masterComp.toDestination();
            }
            this._masterSinkId = deviceId || '';
            return;
        }

        // Fallback: master MediaStreamDestination + <audio> with setSinkId
        if (typeof HTMLAudioElement.prototype.setSinkId !== 'function') {
            throw new Error('Neither AudioContext.setSinkId nor HTMLAudioElement.setSinkId is supported');
        }
        if (!deviceId) {
            if (this._masterSink) {
                try { this._masterComp.disconnect(); } catch {}
                this._masterSink.audioEl.srcObject = null;
                this._masterSink.audioEl.remove();
                this._masterSink = null;
                this._masterComp.toDestination();
            }
            this._masterSinkId = '';
            return;
        }

        if (!this._masterSink) {
            const streamDest = raw.createMediaStreamDestination();
            const audioEl = document.createElement('audio');
            audioEl.autoplay = true;
            audioEl.srcObject = streamDest.stream;
            audioEl.style.display = 'none';
            document.body.appendChild(audioEl);
            try { this._masterComp.disconnect(); } catch {}
            this._masterComp.connect(streamDest);
            this._masterSink = { streamDest, audioEl };
        }
        await this._masterSink.audioEl.setSinkId(deviceId);
        this._masterSinkId = deviceId;
    }

    getOutputDeviceId() {
        if (this._masterSinkId) return this._masterSinkId;
        const raw = Tone.context.rawContext;
        return typeof raw.sinkId === 'string' ? raw.sinkId : '';
    }

    async setChannelOutputDevice(channel, deviceId) {
        await this.init();
        const strip = this._getChannelStrip(channel);
        const existing = this._channelSinks.get(channel);

        if (!deviceId || deviceId === 'master') {
            if (existing) {
                try { strip.panner.disconnect(existing.streamDest); } catch {}
                existing.audioEl.srcObject = null;
                existing.audioEl.remove();
                this._channelSinks.delete(channel);
                this._teardownChannelFx(channel, strip);
                strip.panner.connect(this._reverb);
                strip.panner.connect(strip.delaySend);
            }
            return;
        }

        const raw = Tone.context.rawContext;
        if (typeof HTMLAudioElement.prototype.setSinkId !== 'function') {
            throw new Error('HTMLAudioElement.setSinkId not supported');
        }

        let sink = existing;
        if (!sink) {
            const streamDest = raw.createMediaStreamDestination();
            const audioEl = document.createElement('audio');
            audioEl.autoplay = true;
            audioEl.srcObject = streamDest.stream;
            audioEl.style.display = 'none';
            document.body.appendChild(audioEl);
            sink = { streamDest, audioEl, deviceId: '' };
            this._channelSinks.set(channel, sink);

            try { strip.panner.disconnect(this._reverb); } catch {}
            try { strip.panner.disconnect(strip.delaySend); } catch {}
            this._buildChannelFx(channel, strip, streamDest);
        }

        await sink.audioEl.setSinkId(deviceId);
        sink.deviceId = deviceId;
    }

    _buildChannelFx(channel, strip, streamDest) {
        if (this._channelFx.has(channel)) return;
        // Per-channel master chain mirrors the global master chain so every FX
        // panel slider affects channels routed to a secondary output device.
        const comp = new Tone.Compressor(-12, 3).connect(streamDest);
        const distortion = new Tone.Distortion({
            distortion: this._distortion.distortion,
            wet: this._distortion.wet.value,
        }).connect(comp);
        const crusher = new Tone.BitCrusher({
            bits: this._crusher.bits.value,
            wet: this._crusher.wet.value,
        }).connect(distortion);
        const lpFilter = new Tone.Filter({
            frequency: this._lpFilter.frequency.value,
            type: 'lowpass',
            rolloff: -12,
        }).connect(crusher);
        const phaser = new Tone.Phaser({
            frequency: this._phaser.frequency.value,
            octaves: this._phaser.octaves,
            baseFrequency: 350,
            wet: this._phaser.wet.value,
        }).connect(lpFilter);
        const hpFilter = new Tone.Filter({
            frequency: this._hpFilter.frequency.value,
            type: 'highpass',
            rolloff: -12,
        }).connect(phaser);
        const masterVol = new Tone.Volume(this._masterVolume.volume.value).connect(hpFilter);

        const reverb = new Tone.Freeverb({
            roomSize: this._reverb.roomSize.value,
            dampening: this._reverbDampValue,
            wet: this._reverb.wet.value,
        }).connect(masterVol);
        const delay = new Tone.FeedbackDelay({
            delayTime: this._delay.delayTime.value,
            feedback: this._delay.feedback.value,
            wet: this._delay.wet.value,
        }).connect(masterVol);
        const delaySend = new Tone.Volume(-12).connect(delay);

        strip.panner.connect(reverb);
        strip.panner.connect(delaySend);

        this._channelFx.set(channel, {
            reverb, delay, delaySend,
            masterVol, hpFilter, phaser, lpFilter, crusher, distortion, comp,
        });
    }

    _teardownChannelFx(channel, strip) {
        const fx = this._channelFx.get(channel);
        if (!fx) return;
        try { strip.panner.disconnect(fx.reverb); } catch {}
        try { strip.panner.disconnect(fx.delaySend); } catch {}
        fx.delaySend.dispose();
        fx.delay.dispose();
        fx.reverb.dispose();
        fx.masterVol.dispose();
        fx.hpFilter.dispose();
        fx.phaser.dispose();
        fx.lpFilter.dispose();
        fx.crusher.dispose();
        fx.distortion.dispose();
        fx.comp.dispose();
        this._channelFx.delete(channel);
    }

    getChannelOutputDevice(channel) {
        const sink = this._channelSinks.get(channel);
        return sink ? sink.deviceId : '';
    }

    _getChannelStrip(channel) {
        if (this._channelStrips.has(channel)) return this._channelStrips.get(channel);
        // Channel strips: synth -> hpFilter -> lpFilter -> volume -> panner -> reverb -> master
        const panner = new Tone.Panner(0).connect(this._reverb);
        const lpFilter = new Tone.Filter({ frequency: 20000, type: 'lowpass', rolloff: -12, Q: 1 }).connect(panner);
        const hpFilter = new Tone.Filter({ frequency: 20, type: 'highpass', rolloff: -12, Q: 1 }).connect(lpFilter);
        const volume = new Tone.Volume(0).connect(hpFilter);
        // Also send to delay bus at reduced level
        const delaySend = new Tone.Volume(-12).connect(this._delay);
        panner.connect(delaySend);
        const strip = { volume, filter: lpFilter, hpFilter, panner, delaySend, accent: 0, decay: 1.0 };
        this._channelStrips.set(channel, strip);
        return strip;
    }

    setMasterVolume(db) {
        if (!this._masterVolume) return;
        const v = Math.max(-60, Math.min(0, db));
        this._masterVolume.volume.value = v;
        for (const fx of this._channelFx.values()) fx.masterVol.volume.value = v;
    }

    async loadInstrument(channel, instrumentName) {
        if (!this._started) {
            await this.init();
        }

        const config = INSTRUMENT_CONFIGS[instrumentName];
        if (!config) {
            console.warn(`Unknown instrument: ${instrumentName}, using sine`);
            return this.loadInstrument(channel, 'sine');
        }

        const loadKey = `${channel}-${instrumentName}`;
        if (this._loading.has(loadKey)) return;

        // Skip if this instrument is already loaded on this channel
        const existing = this._channelConfigs.get(channel);
        if (existing && existing.name === instrumentName) return;

        this._loading.add(loadKey);

        const oldInst = this._instruments.get(channel);
        if (oldInst) {
            oldInst.dispose();
        }
        this._drumVoiceFilters?.delete(channel);
        // Dispose old normalization gain node
        const oldGain = this._instrumentGains?.get(channel);
        if (oldGain) {
            oldGain.dispose();
        }

        let instrument;
        const strip = this._getChannelStrip(channel);
        // Insert a gain normalization node between instrument and strip volume
        const gainDb = INSTRUMENT_GAIN[instrumentName] || 0;
        const normGain = new Tone.Gain(Tone.dbToGain(gainDb)).connect(strip.volume);
        if (!this._instrumentGains) this._instrumentGains = new Map();
        this._instrumentGains.set(channel, normGain);
        const dest = normGain;

        try {
            switch (config.type) {
                case 'sampler':
                    instrument = await this._createSampler(config, dest);
                    break;
                case 'synth':
                    instrument = this._createSynth(config, dest);
                    break;
                case 'players':
                    instrument = await this._createPlayers(config, dest);
                    break;
                case 'custom':
                    instrument = config.create(dest);
                    if (instrument._voiceFilters) {
                        if (!this._drumVoiceFilters) this._drumVoiceFilters = new Map();
                        const roleMap = new Map();
                        for (const [role, filters] of Object.entries(instrument._voiceFilters)) {
                            roleMap.set(role, filters);
                        }
                        this._drumVoiceFilters.set(channel, roleMap);
                    }
                    break;
                default:
                    instrument = new Tone.Synth().connect(dest);
            }

            // Raise PolySynth ceiling — voice stealing in playNote() handles the real cap
            if (instrument.maxPolyphony !== undefined) {
                instrument.maxPolyphony = 64;
            }
            this._instruments.set(channel, instrument);
            this._channelConfigs.set(channel, { name: instrumentName, config });

        } catch (err) {
            console.error(`Failed to load ${instrumentName}:`, err);
            instrument = new Tone.Synth().connect(dest);
            this._instruments.set(channel, instrument);
        }

        this._loading.delete(loadKey);
    }

    async _createSampler(config, dest) {
        return new Promise((resolve) => {
            const sampler = new Tone.Sampler({
                urls: config.samples,
                baseUrl: config.baseUrl,
                onload: () => resolve(sampler),
                ...config.options
            }).connect(dest);
        });
    }

    _createSynth(config, dest) {
        let synth;
        switch (config.synth) {
            case 'MonoSynth':
                synth = new Tone.MonoSynth(config.options);
                break;
            case 'PolySynth':
                synth = new Tone.PolySynth(Tone.Synth, config.options?.options || config.options);
                break;
            case 'PluckSynth':
                synth = new Tone.PluckSynth(config.options);
                break;
            case 'FMSynth':
                synth = new Tone.FMSynth(config.options);
                break;
            case 'AMSynth':
                synth = new Tone.AMSynth(config.options);
                break;
            case 'MetalSynth':
                synth = new Tone.MetalSynth(config.options);
                break;
            case 'NoiseSynth':
                synth = new Tone.NoiseSynth(config.options);
                break;
            case 'Synth':
            default:
                synth = new Tone.Synth(config.options);
        }
        return synth.connect(dest);
    }

    async _createPlayers(config, dest) {
        const players = {};
        const loadPromises = [];

        for (const [note, file] of Object.entries(config.samples)) {
            const url = config.baseUrl + file;
            const player = new Tone.Player(url).connect(dest);
            players[note] = player;
            loadPromises.push(Tone.loaded());
        }

        await Promise.all(loadPromises);

        return {
            triggerAttackRelease: (note, duration, time, velocity) => {
                const midiNote = typeof note === 'string' ? Tone.Frequency(note).toMidi() : note;
                const player = players[midiNote];
                if (player) {
                    player.volume.value = Tone.gainToDb(velocity);
                    player.start(time);
                }
            },
            dispose: () => {
                Object.values(players).forEach(p => p.dispose());
            },
            _players: players
        };
    }

    playNote(midi) {
        if (!this._started) return;

        const channel = midi.channel || 1;
        const instrument = this._instruments.get(channel);

        if (!instrument) {
            this.loadInstrument(channel, channel === 10 ? 'drums' : 'piano');
            return;
        }

        // Apply per-channel accent and decay
        const strip = this._channelStrips.get(channel);
        let velocity = (midi.velocity || 100) / 127;
        let duration = midi.duration ? midi.duration / 1000 : 0.1;

        if (strip) {
            // Accent: boost velocity + briefly open filter for brightness
            if (strip.accent > 0) {
                velocity = Math.min(1, velocity * (1 + strip.accent));
                // Sweep filter up proportional to accent, then decay back
                if (strip.filter) {
                    const baseFreq = strip.filter.frequency.value;
                    const boost = Math.min(18000, baseFreq + (12000 - baseFreq) * strip.accent * velocity);
                    const now = Tone.now();
                    strip.filter.frequency.cancelScheduledValues(now);
                    strip.filter.frequency.linearRampToValueAtTime(boost, now + 0.01);
                    strip.filter.frequency.linearRampToValueAtTime(baseFreq, now + 0.25);
                }
            }
            // Decay scales note duration (0.05x to 3x)
            duration *= strip.decay;
        }

        try {
            // Ensure strictly increasing time for Tone.js (multiple notes per frame)
            const now = Tone.now();
            const t = now <= this._lastNoteTime ? this._lastNoteTime + 0.001 : now;
            this._lastNoteTime = t;

            const config = this._channelConfigs.get(channel);
            if (config && config.config.type === 'custom') {
                instrument.triggerAttackRelease(midi.note, duration, t, velocity);
            } else if (config && (config.config.synth === 'NoiseSynth')) {
                instrument.triggerAttackRelease(duration, t, velocity);
            } else if (config && (config.config.synth === 'MetalSynth')) {
                instrument.triggerAttackRelease(duration, t, velocity);
            } else {
                const note = Tone.Frequency(midi.note, 'midi').toNote();
                instrument.triggerAttackRelease(note, duration, t, velocity);
            }
        } catch (err) {
            console.warn('Note play error:', err);
        }
    }

    noteOn(channel, note, velocity) {
        if (!this._started) return;

        const instrument = this._instruments.get(channel);
        if (!instrument) return;

        const noteName = Tone.Frequency(note, 'midi').toNote();
        const vel = (velocity || 100) / 127;

        if (instrument.triggerAttack) {
            instrument.triggerAttack(noteName, undefined, vel);
        }
    }

    noteOff(channel, note) {
        if (!this._started) return;

        const instrument = this._instruments.get(channel);
        if (!instrument) return;

        const noteName = Tone.Frequency(note, 'midi').toNote();

        const held = this._sustainedNotes.get(channel);
        if (held) {
            held.add(noteName);
            return;
        }

        if (instrument.triggerRelease) {
            instrument.triggerRelease(noteName);
        }
    }

    controlChange(channel, controller, value) {
        const strip = this._channelStrips.get(channel);
        switch (controller) {
            case 7: // Volume — CC value 0-127 mapped to -60..0 dB
                if (strip) {
                    const db = value === 0 ? -60 : (value / 127) * 60 - 60;
                    strip.volume.volume.cancelScheduledValues(Tone.now());
                    strip.volume.volume.setValueAtTime(db, Tone.now());
                }
                break;
            case 10: // Pan — CC value 0-127 mapped to -1..1
                if (strip) {
                    strip.panner.pan.cancelScheduledValues(Tone.now());
                    strip.panner.pan.setValueAtTime((value / 127) * 2 - 1, Tone.now());
                }
                break;
            case 64: { // Sustain pedal — >=64 on, <64 off
                const instrument = this._instruments.get(channel);
                if (!instrument) break;
                if (value >= 64) {
                    if (!this._sustainedNotes.has(channel)) {
                        this._sustainedNotes.set(channel, new Set());
                    }
                } else {
                    const held = this._sustainedNotes.get(channel);
                    if (held && instrument.triggerRelease) {
                        for (const note of held) {
                            instrument.triggerRelease(note);
                        }
                    }
                    this._sustainedNotes.delete(channel);
                }
                break;
            }
        }
    }

    programChange(channel, program) {
        const gmToInstrument = {
            0: 'piano',
            1: 'piano',
            4: 'electric-piano',
            5: 'electric-piano',
            16: 'organ',
            19: 'organ',
            25: 'pluck',
            26: 'bright-pluck',
            33: 'bass',
            38: 'acid',
            39: 'sub-bass',
            48: 'strings',
            52: 'strings',
            80: 'square-lead',
            81: 'lead',
            84: 'pwm-lead',
            88: 'pad',
            89: 'warm-pad',
            95: 'dark-pad',
            98: 'fm-bell',
            104: 'marimba',
            112: 'metallic',
        };

        const instrumentName = gmToInstrument[program] || 'sine';
        this.loadInstrument(channel, instrumentName);
    }

    panic() {
        // Briefly mute master to silence lingering notes without release/attack timing conflicts
        if (this._masterVolume) {
            const now = Tone.now();
            const restore = this._masterVolume.volume.value; // preserve user's level
            this._masterVolume.volume.cancelScheduledValues(now);
            this._masterVolume.volume.setValueAtTime(-Infinity, now);
            this._masterVolume.volume.setValueAtTime(restore, now + 0.03);
        }
    }

    getAvailableInstruments() {
        return Object.keys(INSTRUMENT_CONFIGS);
    }

    getChannelInstrument(channel) {
        const config = this._channelConfigs.get(channel);
        return config?.name || null;
    }

    // === Effects controls ===

    // --- Per-channel tone controls ---

    setChannelCutoff(channel, freq) {
        const strip = this._channelStrips.get(channel);
        if (strip?.filter) {
            const f = Math.max(100, Math.min(20000, freq));
            strip.filter.frequency.cancelScheduledValues(Tone.now());
            strip.filter.frequency.setValueAtTime(f, Tone.now());
        }
    }

    setChannelResonance(channel, q) {
        const strip = this._channelStrips.get(channel);
        if (strip?.filter) {
            const v = Math.max(0.5, Math.min(50, q));
            strip.filter.Q.cancelScheduledValues(Tone.now());
            strip.filter.Q.setValueAtTime(v, Tone.now());
        }
    }

    setChannelLoCut(channel, freq) {
        const strip = this._channelStrips.get(channel);
        if (strip?.hpFilter) {
            const f = Math.max(20, Math.min(5000, freq));
            strip.hpFilter.frequency.cancelScheduledValues(Tone.now());
            strip.hpFilter.frequency.setValueAtTime(f, Tone.now());
        }
    }

    setChannelLoResonance(channel, q) {
        const strip = this._channelStrips.get(channel);
        if (strip?.hpFilter) {
            const v = Math.max(0.5, Math.min(50, q));
            strip.hpFilter.Q.cancelScheduledValues(Tone.now());
            strip.hpFilter.Q.setValueAtTime(v, Tone.now());
        }
    }

    // --- Per-voice drum filter controls ---

    hasDrumVoiceFilters(channel) {
        return this._drumVoiceFilters?.has(channel) || false;
    }

    setDrumVoiceCutoff(channel, role, freq) {
        const vf = this._drumVoiceFilters?.get(channel)?.get(role);
        if (vf?.lpFilter) {
            const f = Math.max(100, Math.min(20000, freq));
            vf.lpFilter.frequency.cancelScheduledValues(Tone.now());
            vf.lpFilter.frequency.setValueAtTime(f, Tone.now());
        }
    }

    setDrumVoiceResonance(channel, role, q) {
        const vf = this._drumVoiceFilters?.get(channel)?.get(role);
        if (vf?.lpFilter) {
            const v = Math.max(0.5, Math.min(50, q));
            vf.lpFilter.Q.cancelScheduledValues(Tone.now());
            vf.lpFilter.Q.setValueAtTime(v, Tone.now());
        }
    }

    setDrumVoiceLoCut(channel, role, freq) {
        const vf = this._drumVoiceFilters?.get(channel)?.get(role);
        if (vf?.hpFilter) {
            const f = Math.max(20, Math.min(5000, freq));
            vf.hpFilter.frequency.cancelScheduledValues(Tone.now());
            vf.hpFilter.frequency.setValueAtTime(f, Tone.now());
        }
    }

    setDrumVoiceLoResonance(channel, role, q) {
        const vf = this._drumVoiceFilters?.get(channel)?.get(role);
        if (vf?.hpFilter) {
            const v = Math.max(0.5, Math.min(50, q));
            vf.hpFilter.Q.cancelScheduledValues(Tone.now());
            vf.hpFilter.Q.setValueAtTime(v, Tone.now());
        }
    }

    setChannelDecay(channel, value) {
        const strip = this._channelStrips.get(channel);
        if (strip) {
            strip.decay = Math.max(0.05, Math.min(3.0, value));
        }
    }

    setChannelAccent(channel, amount) {
        const strip = this._channelStrips.get(channel);
        if (strip) {
            strip.accent = Math.max(0, Math.min(1, amount));
        }
    }

    setReverbSize(value) {
        if (!this._reverb) return;
        const v = Math.max(0, Math.min(1, value));
        this._reverb.roomSize.rampTo(v, 0.05);
        for (const fx of this._channelFx.values()) fx.reverb.roomSize.rampTo(v, 0.05);
    }

    setReverbDampening(value) {
        // Freeverb's dampening setter creates new IIR filters which are unstable
        // during playback. Instead, recreate the reverb only when stopped.
        if (!this._reverb) return;
        const v = Math.max(200, Math.min(10000, value));
        this._reverbDampValue = v;
    }

    setReverbWet(value) {
        if (!this._reverb) return;
        const v = Math.max(0, Math.min(1, value));
        this._reverb.wet.rampTo(v, 0.05);
        for (const fx of this._channelFx.values()) fx.reverb.wet.rampTo(v, 0.05);
    }

    setDelayTime(value) {
        if (!this._delay) return;
        const v = Math.max(0.01, Math.min(1, value));
        this._delay.delayTime.rampTo(v, 0.05);
        for (const fx of this._channelFx.values()) fx.delay.delayTime.rampTo(v, 0.05);
    }

    setDelayFeedback(value) {
        if (!this._delay) return;
        const v = Math.max(0, Math.min(0.9, value));
        this._delay.feedback.rampTo(v, 0.05);
        for (const fx of this._channelFx.values()) fx.delay.feedback.rampTo(v, 0.05);
    }

    setDelayWet(value) {
        if (!this._delay) return;
        const v = Math.max(0, Math.min(1, value));
        this._delay.wet.rampTo(v, 0.05);
        for (const fx of this._channelFx.values()) fx.delay.wet.rampTo(v, 0.05);
    }

    setDistortion(amount) {
        if (!this._distortion) return;
        const a = Math.max(0, Math.min(1, amount));
        const wet = a > 0 ? 1 : 0;
        this._distortion.distortion = a;
        this._distortion.wet.rampTo(wet, 0.05);
        for (const fx of this._channelFx.values()) {
            fx.distortion.distortion = a;
            fx.distortion.wet.rampTo(wet, 0.05);
        }
    }

    setLowpassFreq(freq) {
        if (!this._lpFilter) return;
        const f = Math.max(100, Math.min(20000, freq));
        this._lpFilter.frequency.cancelScheduledValues(Tone.now());
        this._lpFilter.frequency.rampTo(f, 0.1);
        for (const fx of this._channelFx.values()) {
            fx.lpFilter.frequency.cancelScheduledValues(Tone.now());
            fx.lpFilter.frequency.rampTo(f, 0.1);
        }
    }

    setHighpassFreq(freq) {
        if (!this._hpFilter) return;
        const f = Math.max(20, Math.min(5000, freq));
        this._hpFilter.frequency.cancelScheduledValues(Tone.now());
        this._hpFilter.frequency.rampTo(f, 0.1);
        for (const fx of this._channelFx.values()) {
            fx.hpFilter.frequency.cancelScheduledValues(Tone.now());
            fx.hpFilter.frequency.rampTo(f, 0.1);
        }
    }

    setPhaserFreq(rate) {
        if (!this._phaser) return;
        const r = Math.max(0.1, Math.min(10, rate));
        this._phaser.frequency.rampTo(r, 0.1);
        for (const fx of this._channelFx.values()) fx.phaser.frequency.rampTo(r, 0.1);
    }

    setPhaserDepth(depth) {
        if (!this._phaser) return;
        const oct = Math.max(0.5, depth * 6);
        this._phaser.octaves = oct;
        for (const fx of this._channelFx.values()) fx.phaser.octaves = oct;
    }

    setPhaserWet(value) {
        if (!this._phaser) return;
        const v = Math.max(0, Math.min(1, value));
        this._phaser.wet.rampTo(v, 0.05);
        for (const fx of this._channelFx.values()) fx.phaser.wet.rampTo(v, 0.05);
    }

    setCrush(amount) {
        if (!this._crusher) return;
        const wet = amount <= 0 ? 0 : 1;
        const bits = amount <= 0 ? this._crusher.bits.value : Math.max(1, Math.round(16 - amount * 15));
        this._crusher.wet.rampTo(wet, 0.05);
        if (amount > 0) this._crusher.bits.value = bits;
        for (const fx of this._channelFx.values()) {
            fx.crusher.wet.rampTo(wet, 0.05);
            if (amount > 0) fx.crusher.bits.value = bits;
        }
    }

    dispose() {
        for (const instrument of this._instruments.values()) {
            instrument.dispose();
        }
        this._instruments.clear();
        if (this._drumVoiceFilters) {
            this._drumVoiceFilters.clear();
        }
        for (const fx of this._channelFx.values()) {
            fx.delaySend.dispose();
            fx.delay.dispose();
            fx.reverb.dispose();
        }
        this._channelFx.clear();
        for (const strip of this._channelStrips.values()) {
            strip.volume.dispose();
            strip.filter?.dispose();
            strip.hpFilter?.dispose();
            strip.panner.dispose();
            strip.delaySend?.dispose();
        }
        this._channelStrips.clear();
        this._sustainedNotes.clear();
        this._delay?.dispose();
        this._reverb?.dispose();
        this._distortion?.dispose();
        this._lpFilter?.dispose();
        this._hpFilter?.dispose();
        this._masterComp?.dispose();
        this._masterVolume?.dispose();
        this._started = false;
    }
}

const toneEngine = new ToneEngine();

export { toneEngine, ToneEngine, INSTRUMENT_CONFIGS, INSTRUMENT_GAIN };

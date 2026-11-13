// The studio's audio engine, live half, in an AudioWorklet: djrust. The studio's sequencer
// Worker still composes; this thread plays the project it composed on deck A and reports what it
// played, so the tracks view, mixer and scope draw from the audio being computed.
//
// Loaded through a small bootstrap module (lib/backend/djrust.js) that imports polyfill.js, the
// pinned djrust glue from the CDN and this file, then calls define(djrust): a worklet cannot
// import() a URL chosen at run time, the bootstrap can name it.
//
// In:  load {text, prepared?, after?} · play {on} · stop · seek {tick} · mute {netId, muted} ·
//      tempo {bpm} · perform {action} · macro {id, bars} · aux {params} · voice {channel, tweak}
//      (`after`: commands run right after the load lands: the studio's FX and mixer voices)
// Out: ready · loaded {answer, ms, inline} · events {ev, at, frames, sr} · ended · error
const BUDGET = 64 << 10; // bytes of a prepared track installed per quantum (~0.3 ms of wasm)
const TICK_EVERY = 4;    // housekeeping every 4 quanta (~10 ms at 48 kHz); render_offline matches
const MARKING_EVERY = 5; // ring marking every 5th event read (~50 ms)
// What the studio needs of the engine (djrust's `beats` facade, 0.2.0 and later).
const FACADE = ['load_share', 'events', 'set_net_muted', 'set_tempo', 'relocate', 'perform',
    'fire_macro', 'set_voice', 'live_op'];

export function define(djrust) {
    class DjrustProcessor extends AudioWorkletProcessor {
        constructor(options) {
            super();
            this.dj = null;
            this.n = 0;
            this.frames = 0;
            this.installing = null;
            this.pendingTempo = null;
            try {
                const missing = FACADE.filter(f => typeof djrust.Dj?.prototype?.[f] !== 'function');
                if (missing.length) throw new Error(`djrust ${djrust.engine_version?.() || '0.1.0'} has no ${missing.join(', ')}: ` +
                    'it predates the beats facade (a newer djrust is needed)');
                djrust.initSync({ module: options.processorOptions.module });
                this.dj = new djrust.Dj(sampleRate);
                this.dj.set_crossfader(0);
                this.port.postMessage({ t: 'ready', sampleRate,
                    version: typeof djrust.engine_version === 'function' ? djrust.engine_version() : null });
            } catch (e) {
                this.port.postMessage({ t: 'error', error: String((e && e.stack) || e) });
            }
            this.port.onmessage = (ev) => this.onCmd(ev.data);
        }

        onCmd(m) {
            const dj = this.dj;
            if (!dj) return;
            try {
                switch (m.t) {
                case 'load':
                    if (m.prepared) {
                        try {
                            dj.begin_install('A', m.prepared);
                            this.installing = { m, t0: Date.now() };
                            break;
                        } catch (e) { /* unfit / bad bytes: load inline below */ }
                    }
                    this.inline(m);
                    break;
                case 'play': dj.set_playing('A', !!m.on); if (!m.on) this.stopping = true; break;
                case 'stop': dj.set_playing('A', false); dj.relocate('A', 0); this.stopping = true; break;
                case 'seek': dj.relocate('A', Math.max(0, m.tick | 0)); break;
                case 'mute': dj.set_net_muted('A', m.netId, !!m.muted); break;
                case 'tempo': dj.set_tempo('A', +m.bpm); break;
                case 'perform': this.answer(m, dj.perform('A', JSON.stringify(m.action))); break;
                case 'macro': this.answer(m, dj.fire_macro('A', m.id, +m.bars || 0)); break;
                case 'aux': dj.live_op('aux', JSON.stringify({ deck: 'A', ...m.params })); break;
                case 'voice': dj.set_voice('A', +m.channel, JSON.stringify(m.tweak)); break;
                }
            } catch (e) {
                this.port.postMessage({ t: 'error', error: `${m.t}: ${String((e && e.message) || e)}` });
            }
        }

        /** An op that did not run says why (a macro on the wrong kind of deck, say). */
        answer(m, a) {
            if (a && a !== 'done') this.port.postMessage({ t: 'error', error: `${m.t} ${m.id || m.action?.op || ''}: ${a}` });
        }

        inline(m) {
            const dj = this.dj;
            this.installing = null;
            dj.cancel_install('A');
            const t0 = Date.now();
            const answer = dj.load_share('A', m.text);
            this.afterLoad(m);
            this.port.postMessage({ t: 'loaded', answer, ms: Date.now() - t0, inline: true, serial: m.serial });
        }

        /** A freshly loaded project starts with the studio's mutes and tempo. */
        afterLoad(m) {
            const dj = this.dj;
            for (const id of m.muted || []) dj.set_net_muted('A', id, true);
            if (m.bpm) dj.set_tempo('A', +m.bpm);
            for (const c of m.after || []) this.onCmd(c);
            if (m.playing) dj.set_playing('A', true);
        }

        /** The song stopped by itself (its structure net's stop-transport): tell the studio. */
        checkEnded() {
            let playing = false;
            try { playing = JSON.parse(this.dj.state('A')).playing; } catch { return; }
            if (this.wasPlaying && !playing && !this.stopping) this.port.postMessage({ t: 'ended' });
            this.wasPlaying = playing;
            this.stopping = false;
        }

        process(_in, outputs) {
            const dj = this.dj;
            const out = outputs[0];
            if (!dj || !out || out.length < 2) return true;
            const at = currentTime; // the audio time this block starts at
            dj.render(out[0], out[1]);
            this.frames += out[0].length;
            this.n++;
            if (dj.installing()) {
                const r = dj.install_step(BUDGET);
                if (r !== undefined) {
                    const x = JSON.parse(r);
                    const job = this.installing;
                    this.installing = null;
                    if (job && x.deck === 'A') {
                        if (x.error) this.inline(job.m);
                        else {
                            this.afterLoad(job.m);
                            this.port.postMessage({ t: 'loaded', answer: x.answer, ms: Date.now() - job.t0,
                                steps: x.steps, kb: x.kb, inline: false, serial: job.m.serial });
                        }
                    }
                }
            }
            if (this.n % TICK_EVERY === 0) {
                dj.tick();
                const marking = (this.n / TICK_EVERY) % MARKING_EVERY === 0;
                const ev = dj.events('A', marking);
                // a read with no fire and no mute / marking change says nothing new
                const quiet = ev.startsWith('{"fires":[]') && !ev.includes('"muted"') && !ev.includes('"marking"');
                if (!quiet) this.port.postMessage({ t: 'events', ev, at, frames: this.frames, sr: sampleRate });
                if ((this.n / TICK_EVERY) % 25 === 0) this.checkEnded();
            }
            return true;
        }
    }
    registerProcessor('djrust-engine', DjrustProcessor);
}

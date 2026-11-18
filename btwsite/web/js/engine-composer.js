/**
 * engine-composer.js: a module Worker that prepares tracks for the audio engine.
 *
 * Compiling a btw program's nets into something playable (the net, its lanes, the measurements) takes tens of
 * milliseconds to a second or more. The audio thread must not stop for that, so a second instance of the engine
 * (`DjComposer`, from the same wasm module) does it here, encodes the result as bytes, and the worklet takes the
 * bytes in a few KB per render quantum (engine-worklet.js, `install`).
 *
 *   page -> worker   {type:'init', module, sampleRate}
 *                    {type:'prepare', id, deck, text}        text: the raw-nets share envelope, as JSON
 *   worker -> page   {type:'ready'}   {type:'error', message}                       (init)
 *                    {type:'prepared', id, deck, bytes, ms}  bytes transferred
 *                    {type:'prepare-failed', id, deck, error}
 */

import * as glue from '../wasm/btw.js';

let composer = null;

self.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'init') {
        try {
            glue.initSync({ module: m.module });
            composer = new glue.DjComposer(m.sampleRate);
            self.postMessage({ type: 'ready' });
        } catch (err) {
            self.postMessage({ type: 'error', message: String((err && err.message) || err) });
        }
    } else if (m.type === 'prepare') {
        const t0 = performance.now();
        try {
            const bytes = composer.prepare_share(m.deck, m.text, '[]');
            self.postMessage({ type: 'prepared', id: m.id, deck: m.deck, bytes, ms: performance.now() - t0 }, [bytes.buffer]);
        } catch (err) {
            self.postMessage({ type: 'prepare-failed', id: m.id, deck: m.deck, error: String((err && err.message) || err) });
        }
    }
};

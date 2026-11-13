// The djrust composer Worker (`?engine=djrust`): a second wasm instance that compiles the
// studio's project into the bytes the worklet installs a few kB per quantum, so the audio thread
// never compiles a net. Without it the worklet loads inline (and stalls for the compile).
// In: init {glue, module, sampleRate} · prepare {id, text}   Out: ready · prepared {id, bytes} · failed {id, error}
let composer = null;
self.onmessage = async (ev) => {
    const m = ev.data;
    try {
        if (m.t === 'init') {
            const djrust = await import(m.glue);
            djrust.initSync({ module: m.module });
            if (typeof djrust.DjComposer?.prototype?.prepare_share !== 'function') throw new Error('no prepare_share');
            composer = new djrust.DjComposer(m.sampleRate);
            self.postMessage({ t: 'ready' });
        } else if (m.t === 'prepare') {
            const t0 = performance.now();
            const bytes = composer.prepare_share('A', m.text, '[]');
            self.postMessage({ t: 'prepared', id: m.id, bytes, ms: performance.now() - t0 }, [bytes.buffer]);
        }
    } catch (e) {
        self.postMessage({ t: m.t === 'init' ? 'error' : 'failed', id: m.id, error: String((e && e.message) || e) });
    }
};

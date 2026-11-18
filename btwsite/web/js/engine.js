/**
 * engine.js: the in-browser sound for btw programs (btwsite/DESIGN.md, "Engine in the browser").
 *
 *   import { createEngine } from './js/engine.js';
 *   const engine = await createEngine({ context, destination });      // after a user gesture started `context`
 *   const run = new BtwRun();                                         // the page owns the runtime and the clock loop
 *   run.eval(text);
 *   setInterval(() => {
 *     engine.apply(JSON.parse(run.service(JSON.stringify(engine.grid()))));   // grid() is null while nothing plays
 *     light(run.marks());
 *   }, 25);
 *
 * The page owns the `BtwRun`, the loop and the markers; the engine owns the sound. `apply` takes the commands
 * `BtwRun.service()` / `stop()` return (parsed):
 *
 *   {op:'load_net', deck, envelope}   a raw-nets share envelope. Prepared in a Worker (a second instance of the engine, so
 *                                     the audio thread never compiles), installed in the worklet a few KB per render
 *                                     quantum, and landed on the next bar (at once when the deck is stopped).
 *   {op:'play', deck, on}             waits for the loads that came with it (see ORDER); a deck that comes in or goes out while
 *                                     another plays does so on the next bar line, not at once (the runtime asks a bar early)
 *   {op:'sound', deck, role, option}  kit:NAME -> setKit, else setRoleVoice
 *   {op:'call', noun, params}         the registry call: engine-calls.js says which are honoured and which are ignored
 *
 * ORDER. On the desktop `load_net` is synchronous, so `load A, play A, load B, play B` starts both decks together.
 * Here a load takes a while, so: commands for one deck run in order; a `play` waits until every load issued in the same
 * `apply` call has landed (so the two decks start together, not a compile apart); the installs of one `apply` batch
 * start together once all are prepared (so a section's decks land on the same bar line); a newer load for a deck
 * replaces an older one that has not started installing. A load that fails is reported (`on('error')`) and the commands
 * after it run anyway.
 *
 * The clock. `grid()` is `{deck, beat, bpm, playing:{A,B}}`: the beat of the first deck that plays, counted from the
 * downbeat of its net, advanced against the audio clock between the worklet's reports (every ~25 ms) and shifted back by the
 * output latency, so markers light when the sound is heard. It never runs past the next bar line on its own: the
 * runtime counts bars by what it is told, and a bar line is only told when the worklet has seen it.
 *
 * `wasmUrl` replaces where btw_bg.wasm is fetched from (default ../wasm/btw_bg.wasm beside this file); `module` is an
 * already compiled WebAssembly.Module of it, which skips the fetch and the compile. The glue the worklet and the Worker
 * import is always ../wasm/btw.js.
 */

import { mapCall, mapSound } from './engine-calls.js';

const DECKS = ['A', 'B'];
const READY_TIMEOUT_MS = 20000;
const STEP_TIMEOUT_MS = 30000;
const MAX_EXTRAPOLATE_S = 0.25;

/** Whether an item is finished with (it will not install or land anything more). */
const TERMINAL = new Set(['done', 'dropped', 'failed', 'superseded']);

export async function createEngine({ context, destination, wasmUrl, module: compiled, composer = 'worker', installBudget } = {}) {
    if (!context) throw new Error('createEngine: a context is needed');
    if (!context.audioWorklet) throw new Error('createEngine: this browser has no AudioWorklet');
    const base = new URL('../wasm/', import.meta.url);
    const href = wasmUrl ? new URL(wasmUrl, globalThis.location ? globalThis.location.href : base) : new URL('btw_bg.wasm', base);

    // 1. the module: fetched and compiled once, shared with the worklet and the Worker
    let bytes = null;
    const fetchBytes = async () => {
        const res = await fetch(href);
        if (!res.ok) throw new Error(`createEngine: ${href}: HTTP ${res.status}`);
        return res.arrayBuffer();
    };
    let module = compiled; // a WebAssembly.Module the page already has (the page's own BtwRun module) saves a fetch and a compile
    if (!module) {
        bytes = await fetchBytes();
        module = await WebAssembly.compile(bytes);
    }

    // 2. the audio node
    await context.audioWorklet.addModule(new URL('./engine-worklet.js', import.meta.url));
    const options = { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { installBudget } };
    let node;
    let viaMessage = false;
    try {
        node = new AudioWorkletNode(context, 'btw-engine', { ...options, processorOptions: { ...options.processorOptions, module } });
    } catch {
        // a browser that will not clone a Module into a worklet gets the bytes in a message and compiles there
        node = new AudioWorkletNode(context, 'btw-engine', options);
        viaMessage = true;
    }
    const gain = context.createGain();
    node.connect(gain);
    gain.connect(destination || context.destination);

    const listeners = new Map();
    const emit = (type, detail) => { for (const fn of listeners.get(type) || []) { try { fn(detail); } catch (e) { console.error(e); } } };

    const stats = { loads: 0, prepareMs: [], installMs: [], installQuanta: [], inline: 0 };
    const keep = (a, v) => { a.push(v); if (a.length > 200) a.shift(); }; // the last 200 of each
    let grid = null; // the worklet's last report: {t, frame, decks, at: performance.now()}
    let disposed = false;
    let readyInfo = null;
    const installs = new Map(); // id -> item
    const prepares = new Map(); // id -> item
    let nextId = 1;

    // ---- the worklet's messages
    let resolveReady, rejectReady;
    const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
    const readyTimer = setTimeout(() => rejectReady(new Error('createEngine: the worklet did not start')), READY_TIMEOUT_MS);
    node.port.onmessage = (e) => {
        const m = e.data;
        switch (m.type) {
        case 'ready': clearTimeout(readyTimer); readyInfo = m; resolveReady(m); break;
        case 'grid': grid = { t: m.t, frame: m.frame, decks: m.decks, at: performance.now() }; break;
        case 'installed': case 'install-failed': {
            const item = installs.get(m.id);
            if (!item) break;
            installs.delete(m.id);
            if (m.type === 'installed') {
                item.installMs = performance.now() - item.installAt;
                keep(stats.installMs, item.installMs);
                keep(stats.installQuanta, m.quanta);
                if (m.inline) stats.inline++;
                finish(item, 'done');
                emit('installed', { deck: item.deck, prepareMs: item.prepareMs, installMs: item.installMs, kb: m.kb, quanta: m.quanta, inline: !!m.inline });
            } else {
                finish(item, 'failed');
                emit('error', { message: `load on deck ${item.deck}: ${m.error}` });
            }
            break;
        }
        case 'warn': emit('warn', { message: m.message }); break;
        case 'error':
            clearTimeout(readyTimer);
            rejectReady(new Error(m.message));
            emit('error', { message: m.message, fatal: true });
            break;
        }
    };
    if (viaMessage) node.port.postMessage({ type: 'wasm', bytes: (bytes || (await fetchBytes())).slice(0) });

    // ---- the composer: a Worker, else this thread, else the audio thread
    const comp = await makeComposer(composer, module, context.sampleRate, (m) => onComposerMessage(m));

    function onComposerMessage(m) {
        const item = prepares.get(m.id);
        if (!item) return;
        prepares.delete(m.id);
        if (m.type === 'prepared') {
            item.prepareMs = m.ms;
            keep(stats.prepareMs, m.ms);
            item.bytes = m.bytes;
            if (item.state === 'preparing') { item.state = 'prepared'; advance(item.batch); }
        } else if (item.state === 'preparing') {
            finish(item, 'failed');
            emit('error', { message: `compiling the net for deck ${item.deck}: ${m.error}` });
        }
    }

    // ---- the per-deck queues
    const queues = { A: [], B: [] };

    function finish(item, state) {
        clearTimeout(item.timer);
        item.state = state;
        item.bytes = null;
        advance(item.batch);
        pump();
    }

    /** Start the installs of a batch once every load of it that is still alive has been prepared. */
    function advance(batch) {
        const live = batch.loads.filter((l) => !TERMINAL.has(l.state));
        if (!live.length || live.some((l) => l.state !== 'prepared')) return;
        let repump = false;
        for (const item of live) {
            item.state = 'installing';
            item.installAt = performance.now();
            const id = nextId++;
            item.installId = id;
            installs.set(id, item);
            // an older install of this deck the worklet will drop as this one begins
            for (const [oid, other] of installs) {
                if (other !== item && other.deck === item.deck && other.state === 'installing') {
                    installs.delete(oid);
                    clearTimeout(other.timer);
                    other.state = 'superseded';
                    repump = true;
                }
            }
            if (item.inlineText !== undefined) {
                node.port.postMessage({ type: 'load_share', id, deck: item.deck, text: item.inlineText });
            } else {
                node.port.postMessage({ type: 'install', id, deck: item.deck, bytes: item.bytes }, [item.bytes.buffer]);
            }
            item.bytes = null;
            armTimer(item);
        }
        if (repump) pump();
    }

    function armTimer(item) {
        clearTimeout(item.timer);
        item.timer = setTimeout(() => {
            if (!TERMINAL.has(item.state)) {
                if (item.installId) installs.delete(item.installId);
                prepares.delete(item.prepareId);
                finish(item, 'failed');
                emit('error', { message: `load on deck ${item.deck} did not finish in ${STEP_TIMEOUT_MS / 1000} s` });
            }
        }, STEP_TIMEOUT_MS);
    }

    function startPrepare(item) {
        item.state = 'preparing';
        const id = nextId++;
        item.prepareId = id;
        prepares.set(id, item);
        armTimer(item);
        stats.loads++;
        const text = JSON.stringify(item.envelope);
        item.envelope = null;
        if (comp.kind === 'inline') {
            // no composer: the worklet compiles it itself, on the audio thread (it will glitch)
            item.inlineText = text;
            item.state = 'prepared';
            prepares.delete(id);
            advance(item.batch);
        } else {
            comp.prepare(id, item.deck, text);
        }
    }

    function pump() {
        let moved = true;
        while (moved) {
            moved = false;
            for (const deck of DECKS) {
                const q = queues[deck];
                while (q.length) {
                    const it = q[0];
                    if (it.kind === 'load') {
                        if (TERMINAL.has(it.state)) { q.shift(); moved = true; continue; }
                        if (it.state === 'queued') { startPrepare(it); moved = true; }
                        break; // blocked until it lands
                    }
                    // a play waits for the loads that came with it, on either deck (so the decks start together), but not for a load of its own deck that was asked for after it
                    if (it.kind === 'play' && it.batch.loads.some((l) => !TERMINAL.has(l.state) && !(l.deck === it.deck && l.seq > it.seq))) break;
                    q.shift();
                    moved = true;
                    run(it);
                }
            }
        }
    }

    function run(it) {
        if (disposed) return;
        if (it.kind === 'play') {
            // A deck that comes in or goes out while another plays does so on a bar line, not the moment the runtime asks: the
            // runtime hands over the next section's decks a bar ahead ("it lands on the next bar"). Starting or stopping every deck
            // at once (the first start, the end of the program) is not quantized.
            const others = DECKS.filter((d) => d !== it.deck && grid && grid.decks[d] && grid.decks[d].playing);
            let atBar = false;
            if (it.on) {
                atBar = others.length > 0 && !it.batch.startedNow;
                if (!atBar) it.batch.startedNow = true;
            } else {
                atBar = others.some((d) => !it.batch.stops.has(d));
            }
            node.port.postMessage({ type: 'play', deck: it.deck, on: it.on, atBar });
        }
        else if (it.kind === 'sound') post(mapSound(it.deck, it.role, it.option), false);
    }

    const noted = new Set();
    const lastSent = new Map();
    function post(op, dedupe) {
        if (disposed) return;
        // a knob that has not moved is not sent again (a ramp calls on every pass)
        if (dedupe) {
            let key = `${op.type}:${op.deck || ''}:${op.name || ''}`;
            let val = String(op.value);
            if (op.type === 'perform') { const j = JSON.parse(op.json); key += `:${j.op}:${j.key || ''}`; val = op.json; }
            if (lastSent.get(key) === val) return;
            lastSent.set(key, val);
        }
        node.port.postMessage(op);
    }

    function call(noun, params) {
        const r = mapCall(noun, params);
        for (const op of r.ops) post(op, true);
        if (r.ignored && !noted.has(r.ignored)) {
            noted.add(r.ignored);
            console.info(`btw engine: ignoring ${r.ignored} (the in-browser engine does not have it; see js/engine-calls.js)`);
            emit('ignored', { what: r.ignored });
        }
    }

    const engine = {
        ready: ready.then(() => engine),
        node,
        /** What the worklet said about itself: {version}. */
        get info() { return readyInfo; },
        stats,
        composer: comp.kind,

        /** The commands `BtwRun.service()` / `stop()` return, parsed. */
        apply(commands) {
            if (disposed || !Array.isArray(commands) || !commands.length) return;
            const batch = { loads: [], stops: new Set(), startedNow: false };
            const dropped = [];
            let seq = 0;
            for (const c of commands) {
                seq++;
                if (c.op === 'call') { call(c.noun, c.params); continue; }
                const deck = c.deck;
                if (!queues[deck]) continue;
                if (c.op === 'load_net') {
                    // the newest load wins: an older one that has not begun to install is dropped
                    for (const old of queues[deck]) {
                        if (old.kind === 'load' && (old.state === 'queued' || old.state === 'preparing' || old.state === 'prepared')) {
                            if (old.prepareId) prepares.delete(old.prepareId);
                            old.state = 'dropped';
                            clearTimeout(old.timer);
                            old.envelope = null;
                            old.bytes = null;
                            if (!dropped.includes(old.batch)) dropped.push(old.batch);
                        }
                    }
                    const item = { kind: 'load', deck, envelope: c.envelope, batch, state: 'queued', seq };
                    batch.loads.push(item);
                    queues[deck].push(item);
                } else if (c.op === 'play') {
                    if (!c.on) batch.stops.add(deck);
                    queues[deck].push({ kind: 'play', deck, on: !!c.on, batch, seq });
                } else if (c.op === 'sound') {
                    queues[deck].push({ kind: 'sound', deck, role: c.role, option: c.option, batch });
                }
            }
            // a batch that lost a load may now be waiting only for the ones left
            for (const b of dropped) advance(b);
            pump();
        },

        /** Where the clock is: {deck, beat, bpm, playing:{A,B}} for the first deck that plays, else null. */
        grid() {
            if (!grid) return null;
            const d = DECKS.find((k) => grid.decks[k] && grid.decks[k].playing);
            if (!d) return null;
            const g = grid.decks[d];
            let beat = g.beat;
            if (g.bpm > 0) {
                const dt = Math.max(0, Math.min(MAX_EXTRAPOLATE_S, heardTime() - grid.t));
                beat += (dt * g.bpm) / 60;
                // not past the next bar line: that is for the worklet to say
                const line = (Math.floor(g.beat / 4 + 1e-9) + 1) * 4;
                if (beat >= line) beat = line - 1e-3;
            }
            const playing = {};
            for (const k of DECKS) playing[k] = !!(grid.decks[k] && grid.decks[k].playing);
            return { deck: d, beat, bpm: g.bpm, playing };
        },

        /** The raw state of both decks at the worklet's last report (for a display): {A:{loaded,playing,beat,bpm,bar,section}, B} | null. */
        decks() { return grid ? grid.decks : null; },

        /** Resolves when nothing is loading: every queued load has landed (or failed). */
        idle() {
            return new Promise((resolve) => {
                const check = () => {
                    if (disposed || DECKS.every((d) => queues[d].length === 0)) resolve();
                    else setTimeout(check, 20);
                };
                check();
            });
        },

        /** Loads and commands still waiting. */
        get pending() { return DECKS.reduce((n, d) => n + queues[d].length, 0); },

        setLevel(v) {
            const x = Math.max(0, Math.min(1, Number(v)));
            if (Number.isFinite(x)) gain.gain.setTargetAtTime(x, context.currentTime, 0.015);
        },

        on(type, fn) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(fn);
            return () => listeners.get(type).delete(fn);
        },

        dispose() {
            if (disposed) return;
            disposed = true;
            clearTimeout(readyTimer);
            for (const d of DECKS) for (const it of queues[d]) { clearTimeout(it.timer); it.state = 'dropped'; }
            DECKS.forEach((d) => { queues[d].length = 0; });
            try { node.port.postMessage({ type: 'dispose' }); } catch { /* gone */ }
            try { node.disconnect(); gain.disconnect(); } catch { /* gone */ }
            comp.dispose();
        },
    };

    /** The context time of the sound that is coming out of the speakers now. */
    function heardTime() {
        try {
            if (context.getOutputTimestamp) {
                const ts = context.getOutputTimestamp();
                if (ts.contextTime > 0 && ts.performanceTime > 0) {
                    const t = ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
                    if (Math.abs(t - context.currentTime) < 1) return t;
                }
            }
        } catch { /* fall through */ }
        return context.currentTime - (context.outputLatency || 0) - (context.baseLatency || 0);
    }

    await ready;
    return engine;
}

/** The thing that turns an envelope into bytes the worklet can install. */
async function makeComposer(kind, module, sampleRate, onMessage) {
    if (kind === 'worker' && typeof Worker !== 'undefined') {
        try {
            const w = new Worker(new URL('./engine-composer.js', import.meta.url), { type: 'module' });
            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('composer worker did not start')), READY_TIMEOUT_MS);
                w.onmessage = (e) => { if (e.data.type === 'ready') { clearTimeout(t); resolve(); } else if (e.data.type === 'error') { clearTimeout(t); reject(new Error(e.data.message)); } };
                w.onerror = (e) => { clearTimeout(t); reject(new Error(e.message || 'composer worker failed')); };
                w.postMessage({ type: 'init', module, sampleRate });
            });
            w.onmessage = (e) => onMessage(e.data);
            return {
                kind: 'worker',
                prepare: (id, deck, text) => w.postMessage({ type: 'prepare', id, deck, text }),
                dispose: () => w.terminate(),
            };
        } catch (err) {
            console.warn('btw engine: no composer worker, compiling on the page thread:', err && err.message);
        }
    }
    if (kind !== 'inline') {
        try {
            // the page thread: blocks it for the length of a compile, but never the audio
            const glue = await import('../wasm/btw.js');
            glue.initSync({ module });
            const c = new glue.DjComposer(sampleRate);
            return {
                kind: 'main',
                prepare: (id, deck, text) => {
                    setTimeout(() => {
                        const t0 = performance.now();
                        try {
                            const bytes = c.prepare_share(deck, text, '[]');
                            onMessage({ type: 'prepared', id, deck, bytes, ms: performance.now() - t0 });
                        } catch (err) {
                            onMessage({ type: 'prepare-failed', id, deck, error: String((err && err.message) || err) });
                        }
                    }, 0);
                },
                dispose: () => { try { c.free(); } catch { /* gone */ } },
            };
        } catch (err) {
            console.warn('btw engine: no composer on the page thread either; compiling on the audio thread:', err && err.message);
        }
    }
    return { kind: 'inline', prepare() { throw new Error('inline'); }, dispose() {} };
}

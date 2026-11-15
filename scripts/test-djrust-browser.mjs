#!/usr/bin/env node
//
// Browser test for ?engine=djrust — headless Chrome over raw CDP (no npm, same approach as
// test-wave-browser.mjs).
//
//   make djrust-wasm
//   ./beats-bitwrap-io -addr :18095 -public public -data /tmp/djrust-data &
//   node scripts/test-djrust-browser.mjs [http://localhost:18095]
//
// Asserts, in a real browser:
//  - the studio (no engine parameter: djrust is the only engine) loads the wasm module into the
//    worklet and plays techno/42: the module says ready, ticks reach the page, the marking reaches
//    the canvas state, the output is not silent, and Tone.js is not on the page at all;
//  - the same module rendered in an OfflineAudioContext gives the bytes Node gives for the same
//    project (one engine, one answer, whatever runs it);
//  - when the module cannot be fetched there is no engine to fall back to: the page says why
//    (banner + el._djrustError) and nothing plays;
//  - a browser that will not clone a Module into a worklet still plays (bytes path);
//  - the features that depended on Tone are hidden (lib/ui/engine-gaps.js), master volume and
//    mutes still reach the engine;
//  - the legacy ?engine=djrust / ?engine=wave links still open the djrust studio;
//  - TRI-RENDER: each live script (djrust-script.mjs) gives one sha256 four ways, Node direct,
//    Node worklet, Chrome OfflineAudioContext and a live AudioContext through
//    scripts/fixtures/capture-worklet.js, every render quantum is 128 frames, and the offline
//    render on the nominal schedule equals scripts/djrust-golden.json. DJRUST_WASM selects the
//    module for all four (the page gets its bytes; the glue is the served public/djrust/).
//
// djwasm 0.3.0 page wiring (plan step 3; docs/MIGRATION-djrust-wasm.md §12):
//  - ENGINE GAPS, feature-detected: on the served module a macro tile is shown exactly when the
//    engine runs its group (NET_MACROS / MASTER_MACROS / AUX_MACROS); on djwasm 0.2.0 (the
//    hash-checked reference, .djrust-ref/, served to the page by a throwaway CORS server through
//    ?djrust-wasm=) every macro tile, the Macros and Auto-DJ buttons are hidden and _fireMacro
//    sends nothing — the pre-0.3.0 assertion, kept for the module it describes;
//  - PAGE FIRE: el._fireMacro('cut') posts one {type:'fire-macro'} to the worklet, nothing to the
//    worker, and one macro-fired (source page, result 0) comes back, then macro-restored;
//  - DOUBLE-FIRE GUARD: a control net firing cut and drop every 32 ticks, played live: exactly one
//    macro-fired (source control) per engine-reported control fire, same id and tick, and the
//    page posts no fire-macro of its own (backend/index.js control-fired is UI-only for ids the
//    engine ran);
//  - OFFLINE MACROS (R-16): a macroCurve arrangement (cut at the intro, solo-drums at the
//    buildup) rendered by renderProjectOffline(project, {controlMacros: true, macrosDisabled})
//    has the sha the Node script render (test-djwasm-030 renderDirect, same options) has; with
//    every catalog id disabled it is djwasm 0.2.0's render of the same project, and the golden
//    arr:techno:42:curves@48000 rendered that way is the golden.
//  - BEATS PADS: a visible Fire pad does something on the served engine: clicking hit1 unmutes its
//    stinger (one {type:'mute', muted:false} to the worklet) and never asks the engine to fire it;
//  - STOP MID MACRO: stopping while the engine runs breakdown leaves no macro mute on the page
//    (el._mutedNets, el._project.initialMutes, which a share carries), and while it runs those
//    mutes are not in initialMutes; stopping during half-time puts el._tempo and the BPM box back
//    to the project tempo, so the next nudge commits project tempo + 1;
//  - FARM BOOT (the render-farm freeze on the page's real boot path): every feed-corpus envelope
//    booted as the farm boots it. ?render=offline: the worklet's processorOptions keys are only
//    module / mutes / play / project / quiet / tempo (no groove flags, swing, humanize or control
//    macros). ?render=1 (the realtime farm records the live engine): the live engine is made with
//    no init flags, and no fire-macro, groove or release-macro reaches the worklet (a panic with
//    nothing in effect is a no-op in the engine and is allowed), nor a generate,
//    generate-preview or project-queue the worker, during the render or when Auto-DJ is ticked
//    across a 2-bar cadence and a 32-bar regen boundary afterwards. FARM_ONLY=<regex> narrows it.
// The page contract these assume: el._wave resolves to the worklet handle (post, onmessage);
// renderProjectOffline takes controlMacros / macrosDisabled and passes them as processorOptions.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { instantiate, FEATURE } from '../public/djrust/loader.js';

const HOST = process.argv[2] || 'http://localhost:18095';
const PORT = Number(process.env.CDP_PORT) || 9342; // CDP; the Makefile passes CDP_PORT
const CHROME = process.env.CHROME || 'google-chrome';
const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = join(here, '..', 'public', 'djrust', 'djwasm.wasm');
if (!existsSync(wasmPath)) { console.error('no public/djrust/djwasm.wasm: make djrust-wasm'); process.exit(2); }

let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) failures++;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', `--user-data-dir=/tmp/djrust-browser-profile-${PORT}`, 'about:blank',
], { stdio: 'ignore' });

async function cdpTarget() {
    for (let i = 0; i < 50; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
            const page = list.find(t => t.type === 'page');
            if (page) return page.webSocketDebuggerUrl;
        } catch {}
        await sleep(200);
    }
    throw new Error('chrome did not come up');
}

function connect(url) {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const logs = [];
    ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        else if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map(a => a.value ?? a.description).join(' '));
        else if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + m.params.exceptionDetails.exception?.description);
    };
    const send = (method, params = {}) => new Promise((res) => {
        const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
    });
    const evaluate = async (expr) => {
        const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || 'eval failed');
        return r.result?.result?.value;
    };
    return new Promise(res => { ws.onopen = () => res({ send, evaluate, logs, close: () => ws.close() }); });
}

/** Open the studio with `query`, press play, listen for 4 s, report what happened. */
async function run(cdp, query) {
    await cdp.send('Page.navigate', { url: `${HOST}/?${query}` });
    for (let i = 0; i < 100; i++) {
        await sleep(200);
        const ok = await cdp.evaluate(`(() => { const el = document.querySelector('petri-note'); return !!(el && el._project && Object.keys(el._project.nets||{}).length); })()`).catch(() => false);
        if (ok) break;
    }
    await sleep(2000); // let the boot path (generate → project-sync) settle
    await cdp.evaluate(`(async () => {
        const el = document.querySelector('petri-note');
        await el._ensureToneStarted();
        if (!el._playing) el._togglePlay();
    })()`);
    await sleep(4000);
    return cdp.evaluate(`(async () => {
        const el = document.querySelector('petri-note');
        const toneRequested = performance.getEntriesByType('resource').some(e => /tone@|tone-engine\.js|Tone\.js/.test(e.name));
        const out = { tick: el._tick, tone: typeof window.Tone !== 'undefined' || toneRequested, playing: el._playing, wave: !!el._wave,
            banner: el.querySelector('.pn-engine-error')?.textContent || null,
            engine: el._engineName || null, info: el._djrustInfo || null, err: el._djrustError || null,
            source: el._djrustSource || null };
        const w = el._wave ? await el._wave.catch(() => null) : null;
        if (w) {
            out.viaModule = w.viaModule;
            const { audioHost } = await import('/audio/host.js');
            const ctx = audioHost.getContext();
            const an = ctx.createAnalyser(); an.fftSize = 2048;
            w.node.connect(an);
            let peak = 0;
            for (let k = 0; k < 20; k++) {
                await new Promise(r => setTimeout(r, 50));
                const buf = new Float32Array(an.fftSize); an.getFloatTimeDomainData(buf);
                for (const x of buf) peak = Math.max(peak, Math.abs(x));
            }
            out.peak = peak;
            out.ctxState = ctx.state;
        }
        const net = el._project.nets.kick || Object.values(el._project.nets)[0];
        out.markingSeen = Object.values(net.places).some(p => Array.isArray(p.tokens));
        out.project = el._waveProject ? JSON.stringify(el._waveProject) : null;
        return out;
    })()`);
}

// --- TRI-RENDER ----------------------------------------------------------------------------
//
// Each script is a project plus [{q, msg}]: worklet messages applied before quantum q
// (djrust-script.mjs). The 0.2.0 worklet has no frame-stamped messages, so the browser
// renderers land them by suspending the context:
//   offline  octx.suspend(q·128/sr), post the step's messages and the SENTINEL (a bad load,
//            which the worklet answers with {type:'error', op:'load'}; port order makes that
//            an ack), resume. The tap's frame count while suspended proves the quantum.
//   live     a real AudioContext, engine → capture tap → destination, both made while
//            suspended. Near each step it suspends, reads the tap's frame count F, posts the
//            messages + SENTINEL, waits for the ack and resumes. The messages land at quantum
//            F/128 rather than the nominal q, because a live context cannot stop on a chosen
//            frame. So the live run fixes the schedule, and Node direct, Node worklet and
//            offline then render that same schedule.
// All four renders must give one sha. The offline render on the nominal schedule must equal
// the golden's script hash.
async function triRender(cdp) {
    const { SCRIPT_NAMES, buildScript, withSchedule, renderScriptDirect, renderScriptWorklet, SENTINEL } = await import('./djrust-script.mjs');
    const { resolveModule, readGolden } = await import('./djrust-golden.mjs');
    const mod = await resolveModule(process.env.DJRUST_WASM);
    if (!mod) { check('tri-render: module', false, 'no module'); return; }
    let golden = null;
    try { golden = readGolden(); } catch { /* no golden yet: equality with it is skipped */ }
    const capture = readFileSync(join(here, 'fixtures', 'capture-worklet.js'), 'utf8');
    await cdp.send('Page.navigate', { url: `${HOST}/djrust/pin.js` });
    await sleep(500);
    await cdp.evaluate(`(() => {
        const bin = atob(${JSON.stringify(mod.bytes.toString('base64'))});
        const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const tapUrl = URL.createObjectURL(new Blob([${JSON.stringify(capture)}], { type: 'text/javascript' }));
        const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
        const SENT = ${JSON.stringify(SENTINEL)};
        const wait = (port, pred, ms, what) => new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('timeout: ' + what)), ms);
            port.__waiters.push((m) => { if (pred(m)) { clearTimeout(t); res(m); return true; } return false; });
        });
        const listen = (node) => { node.port.__waiters = []; node.port.onmessage = (e) => {
            const w = node.port.__waiters; for (let i = 0; i < w.length; i++) if (w[i](e.data)) { w.splice(i, 1); break; }
            if (node.__onmsg) node.__onmsg(e.data); }; };
        const groups = (steps) => { const g = new Map(); for (const st of steps) { if (!g.has(st.q)) g.set(st.q, []); g.get(st.q).push(st.msg); }
            return [...g.entries()].sort((a, b) => a[0] - b[0]); };
        async function nodes(ctx, s, collect) {
            await ctx.audioWorklet.addModule('/djrust/worklet.js');
            await ctx.audioWorklet.addModule(tapUrl);
            const module = await WebAssembly.compile(bytes);
            const eng = new AudioWorkletNode(ctx, 'djrust-engine', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
                processorOptions: { module, json: s.text, play: true, quiet: true } });
            listen(eng);
            const r = await wait(eng.port, (m) => m.type === 'ready' || m.type === 'error', 10000, 'engine ready');
            if (r.type !== 'ready') throw new Error('engine: ' + r.message);
            const frames = s.blocks * 128;
            const tap = new AudioWorkletNode(ctx, 'djrust-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
                channelCount: 2, channelCountMode: 'explicit', processorOptions: { frames, collect } });
            listen(tap);
            const chunks = []; let done = null;
            const doneP = new Promise((r2) => (done = r2));
            tap.__onmsg = (m) => { if (m.type === 'chunk') chunks.push(m); else if (m.type === 'done') done(m); };
            await wait(tap.port, (m) => m.type === 'hello', 10000, 'tap hello');
            eng.connect(tap);
            tap.connect(ctx.destination);
            return { eng, tap, frames, chunks, doneP };
        }
        const where = async (tap) => { const p = wait(tap.port, (m) => m.type === 'where', 5000, 'where'); tap.port.postMessage({ type: 'where' }); return (await p).frames; };
        async function apply(eng, msgs) {
            const ack = wait(eng.port, (m) => m.type === 'error' && m.op === 'load', 5000, 'sentinel ack');
            for (const m of msgs) eng.port.postMessage(m);
            eng.port.postMessage(SENT);
            await ack;
        }
        window.__tri = {
            async offline(s) {
                const octx = new OfflineAudioContext(2, s.blocks * 128, s.sr);
                const n = await nodes(octx, s, false);
                n.eng.connect(octx.destination);
                const landed = [];
                for (const [q, msgs] of groups(s.steps)) {
                    // A hair past the boundary so float rounding cannot land a quantum early.
                    octx.suspend((q * 128 + 0.5) / s.sr).then(async () => {
                        landed.push({ q, at: (await where(n.tap)) / 128 });
                        await apply(n.eng, msgs);
                        octx.resume();
                    });
                }
                const buf = await octx.startRendering();
                const L = buf.getChannelData(0), R = buf.getChannelData(1);
                const inter = new Float32Array(2 * L.length);
                for (let i = 0; i < L.length; i++) { inter[2 * i] = L[i]; inter[2 * i + 1] = R[i]; }
                const d = await n.doneP;
                return { sha: hex(await crypto.subtle.digest('SHA-256', inter)), quanta: d.quanta, landed };
            },
            async live(s) {
                const ctx = new AudioContext({ sampleRate: s.sr });
                await ctx.suspend();
                const n = await nodes(ctx, s, true);
                await ctx.resume();
                const actual = [];
                for (const [q, msgs] of groups(s.steps)) {
                    const lead = 24; // quanta (64 ms at 48 kHz): stop just before the nominal step
                    for (;;) { const f = await where(n.tap); if (f >= Math.max(0, q - lead) * 128) break; await new Promise((r) => setTimeout(r, 5)); }
                    await ctx.suspend();
                    const F = await where(n.tap);
                    if (F % 128) throw new Error('suspended off a quantum boundary: ' + F);
                    await apply(n.eng, msgs);
                    for (const _ of msgs) actual.push(F / 128);
                    await ctx.resume();
                }
                const d = await n.doneP;
                await ctx.close();
                const inter = new Float32Array(2 * n.frames);
                for (const c of n.chunks) inter.set(c.data, 2 * c.offset);
                return { sha: hex(await crypto.subtle.digest('SHA-256', inter)), quanta: d.quanta, actual, sampleRate: ctx.sampleRate };
            },
        };
        return true;
    })()`);

    const summary = {};
    for (const name of SCRIPT_NAMES) {
        const nominal = buildScript(name);
        let live, off, offNominal;
        try {
            live = await cdp.evaluate(`window.__tri.live(${JSON.stringify(nominal)})`);
            off = null; offNominal = null;
        } catch (err) {
            check(`tri-render ${name}: live AudioContext render`, false, err.message); continue;
        }
        const sched = withSchedule(nominal, live.actual);
        const direct = renderScriptDirect(mod, sched).audio;
        const worklet = (await renderScriptWorklet(mod, sched)).audio;
        try {
            off = await cdp.evaluate(`window.__tri.offline(${JSON.stringify(sched)})`);
            offNominal = await cdp.evaluate(`window.__tri.offline(${JSON.stringify(nominal)})`);
        } catch (err) {
            check(`tri-render ${name}: OfflineAudioContext render`, false, err.message); continue;
        }
        const only128 = (qz) => Object.keys(qz).length === 1 && qz[128] > 0;
        const landedOk = (o, s) => o.landed.length === new Set(s.steps.map((x) => x.q)).size && o.landed.every((l) => l.at === l.q);
        check(`tri-render ${name}: every render quantum is 128 frames (offline and live)`,
            only128(off.quanta) && only128(offNominal.quanta) && only128(live.quanta),
            JSON.stringify({ offline: off.quanta, live: live.quanta }));
        check(`tri-render ${name}: the offline suspends landed on the scheduled quanta`, landedOk(off, sched) && landedOk(offNominal, nominal),
            JSON.stringify(offNominal.landed));
        const four = [direct, worklet, off.sha, live.sha];
        const equal = four.every((x) => x === direct);
        check(`tri-render ${name}: Node direct = Node worklet = OfflineAudioContext = live AudioContext`, equal,
            `live schedule ${JSON.stringify(live.actual)} (nominal ${JSON.stringify(nominal.steps.map((x) => x.q))}); ` +
            `direct ${direct.slice(0, 12)} worklet ${worklet.slice(0, 12)} offline ${off.sha.slice(0, 12)} live ${live.sha.slice(0, 12)}`);
        const want = golden && golden.cases[`script:${name}@${nominal.sr}`];
        if (want) check(`tri-render ${name}: offline on the nominal schedule = the golden (djwasm@${golden.module.version})`,
            offNominal.sha === want.audio, `${offNominal.sha.slice(0, 12)} vs ${want.audio.slice(0, 12)}`);
        summary[name] = { equal, sha: direct, liveSchedule: live.actual, nominal: nominal.steps.map((x) => x.q),
            offlineNominalEqualsGolden: !!want && offNominal.sha === want.audio, quanta: { offline: off.quanta, live: live.quanta } };
    }
    console.log(`tri-render summary: ${JSON.stringify({ module: mod.sha256, scripts: summary })}`);
}

// --- djwasm 0.3.0 page wiring ---------------------------------------------------------------

/** The served module's feature bits and key tables (the page plays these bytes). */
async function servedEngine() {
    const dj = await instantiate(readFileSync(wasmPath));
    return { features: dj.features, keys: dj.keys() };
}

/** Macro-panel tile ids the engine runs: the rule lib/ui/engine-gaps.js must follow. */
function runnableTiles(eng) {
    const k = eng.keys;
    const out = new Set();
    if (!k) return out;
    if (eng.features & FEATURE.NET_MACROS) for (const id of k.macros.net) out.add(id);
    if (eng.features & FEATURE.MASTER_MACROS) for (const id of k.macros.master) out.add(id);
    if (eng.features & FEATURE.AUX_MACROS) for (const id of k.macros.aux) out.add(id);
    return out;
}

/**
 * Page-side probe: open the Macros panel and report which tiles are visible, then fire `fireId`
 * through el._fireMacro while counting what reaches the worklet (handle.post) and the worker
 * (el._sendWs), and collect the engine's replies for `waitMs`.
 */
const PAGE_MACRO_PROBE = (fireId, opts, waitMs) => `(async () => {
    const el = document.querySelector('petri-note');
    const vis = (n) => !!n && (n.checkVisibility ? n.checkVisibility({ visibilityProperty: true }) : n.getClientRects().length > 0);
    const btn = el.querySelector('.pn-macros-btn');
    if (btn && !el._showMacros) btn.click();
    await new Promise(r => setTimeout(r, 200));
    const tiles = {};
    for (const b of el.querySelectorAll('.pn-macros-panel .pn-macro-btn[data-macro]')) tiles[b.dataset.macro] = vis(b);
    const out = { tiles, macrosBtn: vis(btn), autodjBtn: vis(el.querySelector('.pn-autodj-btn')) };
    const w = el._wave ? await el._wave : null;
    const posts = [], worker = [], events = [], masks = [];
    const origPost = w && w.post, origMsg = w && w.onmessage, origSend = el._sendWs;
    if (w) {
        w.post = (m) => { if (m && /macro|panic/.test(m.type)) posts.push(m); return origPost.call(w, m); };
        w.onmessage = (m) => {
            if (m && /^macro-|^engine-tempo/.test(m.type)) events.push(m);
            if (m && m.type === 'wave-tick' && typeof m.macroMask === 'number') masks.push(m.macroMask);
            return origMsg && origMsg(m);
        };
    }
    el._sendWs = (m) => { if (m && m.type === 'fire-macro') worker.push(m); return origSend.call(el, m); };
    try {
        el._fireMacro(${JSON.stringify(fireId)}, ${JSON.stringify(opts)});
        await new Promise(r => setTimeout(r, ${waitMs}));
    } finally {
        el._sendWs = origSend;
        if (w) { w.post = origPost; w.onmessage = origMsg; }
    }
    Object.assign(out, { posts, worker, events, maxMask: masks.reduce((a, b) => Math.max(a, b), 0),
        lastMask: masks.length ? masks[masks.length - 1] : null, runningMark: !!el._runningMacro });
    return out;
})()`;

/** Throwaway CORS server for the hash-checked djwasm 0.2.0 reference (it is never under public/). */
async function serveRef() {
    const { REF_WASM, refStatus } = await import('./djrust-ref.mjs');
    const st = refStatus();
    if (!st.ok) return { why: st.why };
    const bytes = readFileSync(REF_WASM);
    const srv = createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (req.url.startsWith('/djwasm.wasm')) { res.writeHead(200, { 'Content-Type': 'application/wasm' }); res.end(bytes); }
        else { res.writeHead(404); res.end(); }
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${srv.address().port}/djwasm.wasm`, close: () => srv.close() };
}

/** ENGINE GAPS (feature-detected) and PAGE FIRE on the playing default page, then the page on 0.2.0. */
async function engineGapsAndPageFire(cdp) {
    const eng = await servedEngine();
    const want = runnableTiles(eng);
    const p = await cdp.evaluate(PAGE_MACRO_PROBE('cut', { duration: 8 }, 2500));
    const ids = Object.keys(p.tiles);
    const wrong = ids.filter((id) => p.tiles[id] !== want.has(id));
    check(`gaps: a macro tile is shown exactly when the engine runs it (features 0x${eng.features.toString(16)}: ${want.size} runnable, ${ids.length} tiles)`,
        ids.length > 0 && wrong.length === 0,
        wrong.length ? `wrong: ${wrong.map((id) => `${id}=${p.tiles[id] ? 'shown' : 'hidden'}`).join(' ')}` : '');
    check('gaps: the Macros and Auto-DJ buttons are shown exactly when the engine runs macros',
        want.size === 0 ? (!p.macrosBtn && !p.autodjBtn) : (p.macrosBtn && p.autodjBtn), JSON.stringify({ macros: p.macrosBtn, autodj: p.autodjBtn }));
    if (!(eng.features & FEATURE.NET_MACROS)) {
        check('page fire: the served module runs net macros (NET_MACROS)', false, `features ${eng.features}`);
    } else {
        const cutBit = eng.keys.maskBits.net + eng.keys.macros.net.indexOf('cut');
        const fires = p.posts.filter((m) => m.type === 'fire-macro');
        const fired = p.events.filter((e) => e.type === 'macro-fired' && e.id === 'cut');
        const restored = p.events.filter((e) => e.type === 'macro-restored' && e.id === 'cut');
        check('page fire: el._fireMacro(cut, 8 ticks) posts exactly one fire-macro to the worklet and nothing to the worker',
            fires.length === 1 && fires[0].id === 'cut' && Number(fires[0].duration) === 8 && p.worker.length === 0,
            JSON.stringify({ worklet: p.posts, worker: p.worker }));
        check('page fire: exactly one macro-fired comes back (source page, result 0), then one macro-restored',
            fired.length === 1 && fired[0].source === 'page' && fired[0].result === 0 && restored.length === 1, JSON.stringify(p.events));
        check('page fire: the wave-tick macroMask carries the cut bit while it runs and is clear after',
            (p.maxMask & (2 ** cutBit)) !== 0 && p.lastMask === 0, `max ${p.maxMask} last ${p.lastMask} cut bit ${cutBit}`);
    }

    // The same page on djwasm 0.2.0: it runs no macro, so every tile is hidden and nothing is sent.
    const ref = await serveRef();
    if (!ref.url) { check('gaps on 0.2.0: the djwasm 0.2.0 reference is present (make djrust-ref)', false, ref.why); return; }
    try {
        const r = await run(cdp, `djrust-wasm=${encodeURIComponent(ref.url)}&genre=techno&seed=42`);
        check('gaps on 0.2.0: the page plays the djwasm 0.2.0 reference', r.engine === 'djrust' && r.source === 'override' && r.tick > 8,
            JSON.stringify({ engine: r.engine, source: r.source, tick: r.tick, err: r.err }));
        const q = await cdp.evaluate(PAGE_MACRO_PROBE('cut', {}, 800));
        const shown = Object.keys(q.tiles).filter((id) => q.tiles[id]);
        check('gaps on 0.2.0: every macro tile and the Macros / Auto-DJ buttons are hidden',
            Object.keys(q.tiles).length > 0 && shown.length === 0 && !q.macrosBtn && !q.autodjBtn,
            JSON.stringify({ shown, macros: q.macrosBtn, autodj: q.autodjBtn }));
        check('gaps on 0.2.0: firing a macro does nothing (no worklet or worker message, nothing marked running)',
            q.posts.length === 0 && q.worker.length === 0 && !q.runningMark, JSON.stringify({ worklet: q.posts, worker: q.worker }));
    } finally {
        // Leave a page without ?djrust-wasm= (offline-render.js reads the override off the URL).
        await cdp.send('Page.navigate', { url: `${HOST}/djrust/pin.js` });
        await sleep(500);
        ref.close();
    }
}

/** BEATS PADS: a visible Fire pad acts on the served engine (page-side stinger unmute). */
async function beatsPads(cdp) {
    await run(cdp, 'genre=techno&seed=42');
    const r = await cdp.evaluate(`(async () => {
        const el = document.querySelector('petri-note');
        const vis = (n) => !!n && (n.checkVisibility ? n.checkVisibility({ visibilityProperty: true }) : n.getClientRects().length > 0);
        const btn = el.querySelector('.pn-oneshots-btn');
        if (!vis(btn)) return { btn: false };
        if (!el._showOneShots) btn.click();
        await new Promise(r => setTimeout(r, 200));
        const pad = el.querySelector('.pn-os-fire[data-macro="hit1"]');
        const w = await el._wave;
        const posts = [];
        const orig = w.post;
        w.post = (m) => { if (m && /mute|macro/.test(m.type)) posts.push(m); return orig.call(w, m); };
        const wasMuted = el._mutedNets.has('hit1');
        try { pad.click(); await new Promise(r => setTimeout(r, 400)); } finally { w.post = orig; }
        return { btn: true, pad: vis(pad), wasMuted, posts, nowMuted: el._mutedNets.has('hit1') };
    })()`);
    if (!r.btn) { check('beats pads: the Beats button is shown on techno/42 (it has stinger nets)', false); return; }
    const unmute = r.posts.filter((m) => m.type === 'mute' && m.netId === 'hit1' && m.muted === false);
    check('beats pads: a visible Fire pad (hit1) unmutes its stinger in the engine and fires nothing there',
        r.pad && r.wasMuted && unmute.length >= 1 && !r.posts.some((m) => m.type === 'fire-macro') && !r.nowMuted,
        JSON.stringify(r));
}

/** STOP MID MACRO: the page's mutes and tempo after a stop while the engine holds a macro. */
async function stopMidMacro(cdp) {
    for (const [id, opts] of [['breakdown', { duration: 8 }], ['half-time', { duration: 8 }]]) {
        await run(cdp, 'genre=techno&seed=42');
        const r = await cdp.evaluate(`(async () => {
            const el = document.querySelector('petri-note');
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const before = [...el._mutedNets].sort();
            const tempo0 = el._project.tempo;
            el._fireMacro(${JSON.stringify(id)}, ${JSON.stringify(opts)});
            await sleep(900);
            const during = { muted: [...el._mutedNets].sort(), initial: [...(el._project.initialMutes || [])].sort(), tempo: el._tempo };
            el._togglePlay();
            await sleep(1500);
            const after = { playing: el._playing, muted: [...el._mutedNets].sort(), initial: [...(el._project.initialMutes || [])].sort(),
                tempo: el._tempo, box: Number(el.querySelector('.pn-tempo input')?.value) };
            el._setTempo(el._tempo + 1);
            return { before, tempo0, during, after, nudged: el._project.tempo };
        })()`);
        const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
        if (id === 'breakdown') {
            const took = r.during.muted.filter((n) => !r.before.includes(n));
            check('stop mid macro: breakdown muted tracks while it ran, and they are not in initialMutes meanwhile',
                took.length > 0 && !took.some((n) => r.during.initial.includes(n)), JSON.stringify({ took, during: r.during }));
            check('stop mid macro: after a stop no breakdown mute is left on the page (mixer, initialMutes)',
                !r.after.playing && same(r.after.muted, r.before) && !took.some((n) => r.after.initial.includes(n)), JSON.stringify(r));
        } else {
            check('stop mid macro: half-time moved the tempo, and a stop puts el._tempo and the BPM box back',
                r.during.tempo !== r.tempo0 && r.after.tempo === r.tempo0 && r.after.box === r.tempo0 && r.nudged === r.tempo0 + 1,
                JSON.stringify(r));
        }
    }
}

/** ?cid=…&z=… for a share-v1 envelope (lib/share/codec.js shape: base64url of the gzipped JSON). */
function inlineShareQuery(cid, bytes) {
    return `cid=${cid}&z=${gzipSync(bytes).toString('base64url')}`;
}

// Installed before any page script on every farm-boot navigation: records the djrust worklet's
// processorOptions keys and what the page posts to it and to the sequencer worker.
const FARM_HOOK = `(() => {
    const farm = window.__farm = { engines: [], posts: [], worker: [] };
    const AWN = window.AudioWorkletNode;
    if (!AWN) return;
    window.AudioWorkletNode = class extends AWN {
        constructor(ctx, name, o) {
            super(ctx, name, o);
            if (name !== 'djrust-engine') return;
            const po = (o && o.processorOptions) || {};
            farm.engines.push({ offline: typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext,
                keys: Object.keys(po).sort(), flags: po.flags ?? null });
            const port = this.port, pm = port.postMessage.bind(port);
            port.postMessage = (m, t) => { if (m && m.type) farm.posts.push(m.type === 'load' || m.type === 'wasm' ? { type: m.type } : m); return pm(m, t); };
        }
    };
    const wp = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (m, t) { if (m && m.type) farm.worker.push(m.type); return wp.call(this, m, t); };
    // The boot is over when render-mode.js publishes __renderInfo.started (the share has been
    // generated or loaded): worker messages from then on are the render's own.
    let info;
    Object.defineProperty(window, '__renderInfo', { configurable: true,
        get: () => info,
        set: (v) => { info = v; if (v && v.started && farm.workerMark === undefined) farm.workerMark = farm.worker.length; } });
})();`;

const OFFLINE_KEYS = new Set(['module', 'mutes', 'play', 'project', 'quiet', 'tempo']);
// A panic is not on the list: the stop / project-sync paths post one, and with no macro in effect
// the engine touches nothing (djrust studio.rs panic: `if self.runner.macro_active()`).
const BAD_POSTS = new Set(['fire-macro', 'groove', 'release-macro']);
const BAD_WORKER = new Set(['generate', 'generate-preview', 'project-queue', 'fire-macro']);

async function farmPage(cdp, query) {
    await cdp.send('Page.navigate', { url: `${HOST}/?${query}` });
    for (let i = 0; i < 300; i++) {
        await sleep(100);
        const done = await cdp.evaluate('window.__renderDone === true').catch(() => false);
        if (done) break;
    }
    return cdp.evaluate(`(() => ({ done: window.__renderDone === true, err: window.__renderError || null,
        mode: window.__renderInfo && window.__renderInfo.mode, farm: window.__farm || null }))()`);
}

/** FARM BOOT: each feed envelope booted exactly as the farm boots it (see the header). */
async function farmBoot(cdp) {
    const dir = join(here, 'fixtures', 'feed-corpus');
    const only = process.env.FARM_ONLY ? new RegExp(process.env.FARM_ONLY) : null;
    const files = readdirSync(dir).filter((f) => f.endsWith('.json') && (!only || only.test(f))).sort();
    const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: FARM_HOOK }).then((r) => r.result);
    const offBad = [], liveBad = [];
    let n = 0;
    const t0 = Date.now();
    try {
        for (const f of files) {
            const cid = f.slice(0, -5);
            const q = inlineShareQuery(cid, readFileSync(join(dir, f)));
            // ?render=offline: the processorOptions the bake makes the engine with.
            const o = await farmPage(cdp, `${q}&render=offline&maxMs=400`);
            const eng = o.farm?.engines.filter((e) => e.offline) || [];
            const keys = eng.map((e) => e.keys.join(','));
            const okOff = o.done && !o.err && o.mode === 'offline' && eng.length === 1
                && eng[0].keys.every((k) => OFFLINE_KEYS.has(k)) && ['play', 'project', 'quiet', 'tempo'].every((k) => eng[0].keys.includes(k));
            if (!okOff) offBad.push(`${cid.slice(0, 14)} ${JSON.stringify({ done: o.done, err: o.err, mode: o.mode, keys })}`);
            // ?render=1: the live engine the realtime farm records; then tick Auto-DJ across a cadence
            // and a regen boundary as playback would.
            const r = await farmPage(cdp, `${q}&render=1&maxMs=600`);
            const after = await cdp.evaluate(`(async () => {
                const el = document.querySelector('petri-note');
                el._autoDjTick?.(32 * 16 - 20, 32 * 16 + 2);
                await new Promise(r => setTimeout(r, 300));
                return { posts: window.__farm.posts, worker: window.__farm.worker, workerMark: window.__farm.workerMark,
                    autodj: !!el.querySelector('.pn-autodj-enable')?.checked };
            })()`).catch((e) => ({ error: e.message }));
            const live = r.farm?.engines.filter((e) => !e.offline) || [];
            const badPosts = (after.posts || []).filter((m) => BAD_POSTS.has(m.type)).map((m) => m.type + (m.id ? `:${m.id}` : ''));
            // From the render's start on (the boot itself sends the share's generate).
            const mark = Number.isInteger(after.workerMark) ? after.workerMark : 0;
            const badWorker = (after.worker || []).slice(mark).filter((t) => BAD_WORKER.has(t));
            const okLive = r.done && !r.err && r.mode === 'realtime' && !after.error && live.length >= 1
                && live.every((e) => !e.flags) && badPosts.length === 0 && badWorker.length === 0;
            if (!okLive) liveBad.push(`${cid.slice(0, 14)} ${JSON.stringify({ done: r.done, err: r.err, mode: r.mode, flags: live.map((e) => e.flags), badPosts, badWorker, autodj: after.autodj, error: after.error })}`);
            n++;
        }
    } finally {
        await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    check(`farm boot (?render=offline): every feed envelope (${n}) bakes with only module/mutes/play/project/quiet/tempo — ${secs} s`,
        n > 0 && offBad.length === 0, offBad.slice(0, 6).join(' | '));
    check(`farm boot (?render=1): every feed envelope (${n}) records a live engine with no init flags, no fire-macro/groove/release-macro and no Auto-DJ regen`,
        n > 0 && liveBad.length === 0, liveBad.slice(0, 6).join(' | '));
}

/** techno/42 loop plus a control net 'pulse-ctl' that fires cut (2 ticks) at 8 and drop (1 bar) at 20 of every 32 ticks. */
async function pulseProject() {
    const { composeProject } = await import('./djrust-golden.mjs');
    const p = composeProject('techno', 42, 'loop');
    const N = 32, places = {}, transitions = {}, arcs = [];
    for (let i = 0; i < N; i++) {
        places[`pp${i}`] = { initial: [i === 0 ? 1 : 0], x: 40 * i, y: 0 };
        transitions[`pt${i}`] = { x: 40 * i + 20, y: 40 };
        arcs.push({ source: `pp${i}`, target: `pt${i}`, weight: [1], inhibit: false });
        arcs.push({ source: `pt${i}`, target: `pp${(i + 1) % N}`, weight: [1], inhibit: false });
    }
    transitions.pt8.control = { action: 'fire-macro', macro: 'cut', macroBars: 2 };
    transitions.pt20.control = { action: 'fire-macro', macro: 'drop', macroBars: 1 };
    p.nets['pulse-ctl'] = { role: 'control', track: { channel: 1, defaultVelocity: 100, instrument: '', instrumentSet: [] }, places, transitions, arcs };
    return p;
}

/**
 * DOUBLE-FIRE GUARD. With control macros on, the engine dispatches a control net's fire-macro
 * itself; the page still sees the control in the wave-tick and must not fire it again. The
 * taps go on before the engine's first message (see the comment at Play).
 */
async function doubleFireGuard(cdp) {
    const project = await pulseProject();
    await cdp.send('Page.navigate', { url: `${HOST}/?genre=techno&seed=42` });
    for (let i = 0; i < 100; i++) {
        await sleep(200);
        if (await cdp.evaluate(`!!document.querySelector('petri-note')?._project?.nets?.kick`).catch(() => false)) break;
    }
    await sleep(1500);
    const r = await cdp.evaluate(`(async () => {
        const el = document.querySelector('petri-note');
        el._sendWs({ type: 'project-load', project: ${JSON.stringify(project)} });
        for (let i = 0; i < 50 && !el._waveProject?.nets?.['pulse-ctl']; i++) await new Promise(r => setTimeout(r, 100));
        if (!el._waveProject?.nets?.['pulse-ctl']) return { error: 'the pulse project never reached the engine handle (no project-sync)' };
        // The worker can answer a project-load with more than one project-sync; one landing after
        // Play is a swap at the bar (the tick restarts). Let them settle first.
        await new Promise(r => setTimeout(r, 1500));
        await el._ensureToneStarted();
        // Play sets el._wave synchronously; the taps go on in the continuation of awaiting it,
        // before any worklet message can be delivered (those are tasks; the first fire is at tick 8).
        if (!el._playing) el._togglePlay();
        const w = await el._wave;
        const controls = [], events = [], posts = [], worker = [], masks = [];
        const origPost = w.post, origMsg = w.onmessage, origSend = el._sendWs;
        w.post = (m) => { if (m && /macro|panic/.test(m.type)) posts.push(m); return origPost.call(w, m); };
        w.onmessage = (m) => {
            if (m && m.type === 'wave-tick') {
                for (const [netId, , c] of m.controls || []) {
                    if (c && c.action === 'fire-macro') controls.push({ netId, id: c.macro || c.macroId || c.targetNet, tick: m.tick });
                }
                if (typeof m.macroMask === 'number') masks.push(m.macroMask);
            } else if (m && /^macro-/.test(m.type)) events.push({ type: m.type, id: m.id, source: m.source, result: m.result, tick: m.tick });
            return origMsg && origMsg(m);
        };
        el._sendWs = (m) => { if (m && m.type === 'fire-macro') worker.push(m); return origSend.call(el, m); };
        try {
            await new Promise(r => setTimeout(r, 9000));
            if (el._playing) el._togglePlay();
            await new Promise(r => setTimeout(r, 300));
        } finally { w.post = origPost; w.onmessage = origMsg; el._sendWs = origSend; }
        return { controls, events, posts, worker, maxMask: masks.reduce((a, b) => Math.max(a, b), 0), tick: el._tick };
    })()`);
    if (r.error) { check('double-fire guard: setup', false, r.error); return; }
    const key = (x) => `${x.id}@${x.tick}`;
    const ctl = r.controls.map(key).sort();
    const firedCtl = r.events.filter((e) => e.type === 'macro-fired' && e.source === 'control');
    const firedPage = r.events.filter((e) => e.type === 'macro-fired' && e.source !== 'control');
    const ids = new Set(r.controls.map((c) => c.id));
    check('double-fire guard: the control net fired cut and drop several times', ctl.length >= 4 && ids.has('cut') && ids.has('drop'),
        `${ctl.length} control fires: ${ctl.join(' ')}`);
    check('double-fire guard: exactly one macro-fired (source control, result 0) per control fire, same id and tick',
        JSON.stringify(firedCtl.map(key).sort()) === JSON.stringify(ctl) && firedCtl.every((e) => e.result === 0),
        `controls ${ctl.join(' ')} | macro-fired ${firedCtl.map((e) => `${key(e)}:${e.result}`).sort().join(' ')}`);
    check('double-fire guard: the page fires none of them again (no page macro-fired, no fire-macro to the worklet or worker)',
        firedPage.length === 0 && r.posts.filter((m) => m.type === 'fire-macro').length === 0 && r.worker.length === 0,
        JSON.stringify({ page: firedPage, worklet: r.posts, worker: r.worker }));
    check('double-fire guard: the engine held the macros (macroMask non-zero while they ran)', r.maxMask > 0, `max mask ${r.maxMask}`);
}

/** The macroCurve arrangement for the offline checks: cut at the intro (tick 1), solo-drums at the buildup (tick 65). */
async function macroCurveProject() {
    const { composeProject } = await import('./djrust-golden.mjs');
    const { arrangeWithOpts } = await import('../public/lib/generator/arrange.js');
    const p = composeProject('techno', 42, 'standard');
    arrangeWithOpts(p, 'techno', '', { overlayOnly: true,
        macroCurve: [{ section: 'intro', macro: 'cut', bars: 4 }, { section: 'buildup', macro: 'solo-drums', bars: 2 }] });
    return p;
}

/** renderProjectOffline in the page → sha256 of the interleaved f32 L,R (what djrust-golden hashes). */
const OFFLINE_SHA = (text, opts) => `(async () => {
    const { renderProjectOffline } = await import('/lib/share/offline-render.js');
    const { buffer } = await renderProjectOffline(JSON.parse(${JSON.stringify(text)}), ${JSON.stringify(opts)});
    const L = buffer.getChannelData(0), R = buffer.getChannelData(1);
    const inter = new Float32Array(2 * L.length);
    for (let i = 0; i < L.length; i++) { inter[2 * i] = L[i]; inter[2 * i + 1] = R[i]; }
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', inter));
    return { sha: Array.from(h, b => b.toString(16).padStart(2, '0')).join(''), frames: L.length };
})()`;

/** OFFLINE MACROS (R-16): control macros and macrosDisabled in renderProjectOffline. */
async function offlineMacros(cdp) {
    const T = await import('./test-djwasm-030.mjs');
    const { renderCase, readGolden } = await import('./djrust-golden.mjs');
    const { REF_WASM, refStatus } = await import('./djrust-ref.mjs');
    const mod = await T.loadPackage(join(here, '..', 'public', 'djrust'));
    const text = JSON.stringify(await macroCurveProject());
    const SR = 48000, SECONDS = 12, blocks = SECONDS * SR / 128;
    const node = (options) => T.renderDirect(mod, { name: 'offline-macros', sr: SR, blocks, text, options, steps: [] }, { collectEvents: true });
    const off = node({});
    const none = node({ controlMacros: true, macrosDisabled: [] });
    const solo = node({ controlMacros: true, macrosDisabled: ['solo-drums'] });
    const all = node({ controlMacros: true, macrosDisabled: T.CATALOG_IDS });
    const ev = (r) => r.events.map((e) => `${e.k}:${e.id}@${e.tick}`).join(' ');
    // The Node oracle discriminates: the fire moves the audio, and a disabled id is honoured.
    check('offline macros (Node): cut fires, solo-drums is skipped when disabled, all disabled = control macros off',
        solo.audio !== off.audio && solo.audio !== none.audio && all.audio === off.audio
        && /fired:cut@1\b/.test(ev(solo)) && /skipped:solo-drums@65\b/.test(ev(solo)) && /fired:solo-drums@65\b/.test(ev(none)),
        `disabled [solo-drums]: ${ev(solo)} | none disabled: ${ev(none)}`);
    // djwasm 0.2.0 ignores fire-macro, so it is the exact oracle for "every id disabled".
    const st = refStatus();
    let ref020 = null;
    if (st.ok) {
        const refMod = await T.withGlue(REF_WASM, dirname(REF_WASM));
        ref020 = renderCase(refMod, { id: 'offline-macros', blocks, seconds: {}, build: () => ({ text, steps: [] }) }, SR, { streams: false }).audio;
    }
    check('offline macros (Node): djwasm 0.2.0 renders the project as the 0.3.0 engine does with control macros off',
        ref020 === off.audio, ref020 ? `${ref020.slice(0, 12)} vs ${off.audio.slice(0, 12)}` : st.why);

    await cdp.send('Page.navigate', { url: `${HOST}/djrust/pin.js` });
    await sleep(500);
    const base = { durationSec: SECONDS, sampleRate: SR, controlMacros: true };
    let pSolo, pAll, pCurves;
    try {
        pSolo = await cdp.evaluate(OFFLINE_SHA(text, { ...base, macrosDisabled: ['solo-drums'] }));
        pAll = await cdp.evaluate(OFFLINE_SHA(text, { ...base, macrosDisabled: T.CATALOG_IDS }));
    } catch (err) { check('offline macros: renderProjectOffline in the page', false, err.message); return; }
    check('offline macros: a macroCurve share with macrosDisabled renders offline = the Node script render (12 s, 48 kHz)',
        pSolo.sha === solo.audio,
        `page ${pSolo.sha.slice(0, 16)} node ${solo.audio.slice(0, 16)} (node with control macros off ${off.audio.slice(0, 16)}), ${pSolo.frames} frames`);
    check('offline macros: with every macro disabled the offline render = djwasm 0.2.0\'s render',
        pAll.sha === off.audio && (ref020 === null || pAll.sha === ref020), `page ${pAll.sha.slice(0, 16)} 0.2.0 ${(ref020 || off.audio).slice(0, 16)}`);
    const golden = readGolden();
    const want = golden.cases['arr:techno:42:curves@48000'];
    const curves = JSON.stringify(T.curvesProject());
    try {
        pCurves = await cdp.evaluate(OFFLINE_SHA(curves, { durationSec: want.frames / SR, sampleRate: SR, controlMacros: true, macrosDisabled: T.CATALOG_IDS }));
    } catch (err) { check('offline macros: renderProjectOffline of the golden curves case', false, err.message); return; }
    check(`offline macros: golden arr:techno:42:curves with every macro disabled renders offline = the golden (djwasm@${golden.module.version})`,
        pCurves.sha === want.audio && pCurves.frames === want.frames, `${pCurves.sha.slice(0, 12)} vs ${want.audio.slice(0, 12)}, ${pCurves.frames} frames`);
}

try {
    const cdp = await connect(await cdpTarget());
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    // --- djrust, live (the default page) ---
    const d = await run(cdp, 'genre=techno&seed=42');
    check('djrust: the module is running in the worklet (engine name + module info)',
        d.engine === 'djrust' && d.info && d.info.abi === 1, JSON.stringify({ engine: d.engine, info: d.info, err: d.err, viaModule: d.viaModule }));
    // Before the pinned version is on npm the CDN 404s and the local build plays; after, the CDN.
    check('djrust: the module came from the pinned CDN version or the local build',
        /^cdn djwasm@\d+\.\d+\.\d+$|^local$/.test(d.source || ''), d.source);
    check('djrust: transport playing, ticks reach the page', d.playing && d.tick > 8, `tick ${d.tick}, ctx ${d.ctxState}`);
    check('djrust: marking reaches the canvas state', d.markingSeen);
    check('djrust: worklet output is not silent', d.peak > 0.01, `peak ${d.peak?.toFixed(3)}`);
    check('djrust: Tone.js is not loaded or requested', d.tone === false);
    check('djrust: no console errors from the engine', !cdp.logs.some(l => /djrust|djwasm|EXC/.test(l) && /error|EXC|unavailable/i.test(l)),
        cdp.logs.filter(l => /djrust|djwasm|EXC/.test(l)).slice(0, 3).join(' | '));

    // --- what is switched off, and what still reaches the engine ---
    const gaps = await cdp.evaluate(`(async () => {
        const el = document.querySelector('petri-note');
        const shown = (sel) => { const n = el.querySelector(sel); return !!n && getComputedStyle(n).display !== 'none'; };
        const out = {
            macros: shown('.pn-macros-btn'), autodj: shown('.pn-autodj-btn'), bypass: shown('.pn-fx-bypass'),
            reverb: shown('.pn-effects-panel .pn-fx-group:nth-child(2)'), masterVol: shown('.pn-effects-panel .pn-fx-group:first-child'),
            strip: shown('.pn-mixer-slider-group'),
        };
        const w = await el._wave;
        const { audioHost } = await import('/audio/host.js');
        const ctx = audioHost.getContext();
        const an = ctx.createAnalyser(); an.fftSize = 2048; audioHost.output.connect(an);
        const rms = async () => { let s = 0, n = 0; for (let k = 0; k < 16; k++) {
            await new Promise(r => setTimeout(r, 50)); const b = new Float32Array(an.fftSize); an.getFloatTimeDomainData(b);
            for (const x of b) { s += x * x; n++; } } return Math.sqrt(s / n); };
        out.before = await rms();
        // Master volume is the host gain.
        const vol = el.querySelector('.pn-fx-slider[data-fx="master-vol"]');
        vol.value = 5; vol.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 300));
        out.quiet = await rms();
        vol.value = 80; vol.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 300));
        // Mute every music net through the studio's own path.
        const music = Object.entries(el._project.nets).filter(([, n]) => n.role !== 'control').map(([id]) => id);
        for (const id of music) el._sendWs({ type: 'mute', netId: id, muted: true });
        await new Promise(r => setTimeout(r, 600));
        out.muted = await rms();
        for (const id of music) el._sendWs({ type: 'mute', netId: id, muted: false });
        return out;
    })()`);
    // Macros and Auto-DJ are feature-detected since djwasm 0.3.0 (engineGapsAndPageFire below);
    // master FX and the channel strip stay hidden until the engine has FX / VOICE.
    const served = await servedEngine();
    const fxHidden = !(served.features & FEATURE.FX), stripHidden = !(served.features & FEATURE.VOICE);
    check(`gaps: FX bypass and reverb are ${fxHidden ? 'hidden' : 'shown'}, the channel strip ${stripHidden ? 'hidden' : 'shown'} (features 0x${served.features.toString(16)}); master volume is shown`,
        gaps.bypass === !fxHidden && gaps.reverb === !fxHidden && gaps.strip === !stripHidden && gaps.masterVol, JSON.stringify(gaps));
    check('engine: master volume reaches the output', gaps.before > 0.005 && gaps.quiet < gaps.before * 0.1,
        `rms ${gaps.before?.toFixed(4)} → ${gaps.quiet?.toFixed(4)}`);
    check('engine: muting every music net silences the output', gaps.muted < gaps.before * 0.25,
        `rms ${gaps.before?.toFixed(4)} → ${gaps.muted?.toFixed(4)}`);

    // --- djwasm 0.3.0: macro tiles by feature, a page fire, and the same page on 0.2.0 ---
    await engineGapsAndPageFire(cdp);
    await beatsPads(cdp);
    await stopMidMacro(cdp);

    // --- the browser renders what Node renders ---
    if (d.project) {
        const seconds = 5, sr = 48000;
        const page = await cdp.evaluate(`(async () => {
            const { createDjrustEngine } = await import('/djrust/node.js');
            const project = ${JSON.stringify(d.project)};
            const octx = new OfflineAudioContext(2, ${sr * seconds}, ${sr});
            const dj = await createDjrustEngine(octx, null, { processorOptions: { project: JSON.parse(project), play: true, quiet: true } });
            const buf = await octx.startRendering();
            const l = buf.getChannelData(0), r = buf.getChannelData(1);
            const all = new Uint8Array(l.byteLength + r.byteLength);
            all.set(new Uint8Array(l.buffer, l.byteOffset, l.byteLength), 0);
            all.set(new Uint8Array(r.buffer, r.byteOffset, r.byteLength), l.byteLength);
            const h = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
            let peak = 0; for (const x of l) peak = Math.max(peak, Math.abs(x));
            return { sha: Array.from(h, b => b.toString(16).padStart(2, '0')).join(''), peak, viaModule: dj.viaModule, info: dj.info };
        })()`);
        const dj = await instantiate(readFileSync(wasmPath));
        dj.init(sr); dj.load(d.project); dj.play();
        const hash = createHash('sha256'), rights = [];
        const lefts = [];
        for (let b = 0; b < sr * seconds / 128; b++) {
            dj.process(128);
            const [l, r] = dj.blocks(128);
            lefts.push(l.slice()); rights.push(r.slice());
        }
        const cat = (parts) => { const o = new Float32Array(parts.length * 128); parts.forEach((p, i) => o.set(p, i * 128)); return o; };
        const L = cat(lefts), R = cat(rights);
        hash.update(Buffer.from(L.buffer)); hash.update(Buffer.from(R.buffer));
        check('offline: a Module in processorOptions is ready before the first quantum (the render is not silent)', page.peak > 0.05 && page.viaModule, `peak ${page.peak?.toFixed(3)}, viaModule ${page.viaModule}`);
        const nodeSha = hash.digest('hex');
        check('offline: the browser renders the same bytes Node renders (5 s, 48 kHz, stereo)', page.sha === nodeSha, `browser ${page.sha?.slice(0, 16)}`);

        // R-12: renderProjectOffline (the function renderToBlobOffline now delegates to) renders the
        // same bytes as the direct createDjrustEngine path above, i.e. the same Node sha.
        const viaRpo = await cdp.evaluate(`(async () => {
            const { renderProjectOffline } = await import('/lib/share/offline-render.js');
            const { buffer } = await renderProjectOffline(JSON.parse(${JSON.stringify(d.project)}), { durationSec: ${seconds}, sampleRate: ${sr} });
            const l = buffer.getChannelData(0), r = buffer.getChannelData(1);
            const all = new Uint8Array(l.byteLength + r.byteLength);
            all.set(new Uint8Array(l.buffer, l.byteOffset, l.byteLength), 0);
            all.set(new Uint8Array(r.buffer, r.byteOffset, r.byteLength), l.byteLength);
            const h = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
            return { sha: Array.from(h, b => b.toString(16).padStart(2, '0')).join(''), frames: l.length };
        })()`);
        check('offline: renderProjectOffline renders the same bytes as Node (the renderToBlobOffline refactor is byte-identical)',
            viaRpo.sha === nodeSha, `browser ${viaRpo.sha?.slice(0, 16)} node ${nodeSha.slice(0, 16)} frames ${viaRpo.frames}`);
    } else {
        check('offline: project available from the page', false, 'el._waveProject was empty');
    }

    // --- R-12 insert render: renderNotesOffline twice = one WAV sha = the Node loader's f32 ---
    {
        const { chordPayload, renderInsertNode } = await import('./test-insert-render.mjs');
        const { buildInsertProject } = await import('../public/lib/share/insert-render.js');
        const { resolveModule } = await import('./djrust-golden.mjs');
        const payload = chordPayload();
        const want = (await renderInsertNode(await resolveModule(wasmPath), buildInsertProject(payload, 'counterMelody'))).f32;
        const ins = await cdp.evaluate(`(async () => {
            const m = await import('/lib/share/insert-render.js');
            const { audioBufferToWavBlob } = await import('/lib/share/offline-render.js');
            const hex = (buf) => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
            const sha = async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes));
            const planar = (b) => { const l = b.getChannelData(0), r = b.getChannelData(1);
                const all = new Uint8Array(l.byteLength + r.byteLength);
                all.set(new Uint8Array(l.buffer, l.byteOffset, l.byteLength), 0);
                all.set(new Uint8Array(r.buffer, r.byteOffset, r.byteLength), l.byteLength); return all; };
            const s = m.buildInsertProject(${JSON.stringify(payload)}, 'counterMelody');
            const a = await m.renderNotesOffline(s);
            const b = await m.renderNotesOffline(s);
            return {
                wavA: await sha(await audioBufferToWavBlob(a).arrayBuffer()),
                wavB: await sha(await audioBufferToWavBlob(b).arrayBuffer()),
                f32: await sha(planar(a)), layers: s.layers,
            };
        })()`);
        check('insert: two renderNotesOffline renders give one WAV sha256', !!ins.wavA && ins.wavA === ins.wavB,
            `${ins.wavA?.slice(0, 16)} / ${ins.wavB?.slice(0, 16)}`);
        check('insert: the browser insert render = the Node loader render of the same project (f32)', ins.f32 === want,
            `browser ${ins.f32?.slice(0, 16)} node ${want.slice(0, 16)}, ${ins.layers} layers`);
    }

    // --- no module: no engine, and the page says so ---
    cdp.logs.length = 0;
    const f = await run(cdp, 'djrust-wasm=/no-such-module.wasm&genre=techno&seed=42');
    check('no module: no engine starts, the reason is recorded and shown',
        f.engine === null && /404/.test(f.err || '') && /404/.test(f.banner || ''), JSON.stringify({ engine: f.engine, err: f.err, banner: f.banner }));
    check('no module: Tone.js is not a fallback', f.tone === false);

    // --- a browser that will not clone a Module into a worklet: the bytes go in a message ---
    const inj = await cdp.send('Page.addScriptToEvaluateOnNewDocument',
        { source: 'WebAssembly.compile = () => Promise.reject(new Error("compile disabled by the test"));' });
    const b = await run(cdp, 'genre=techno&seed=42');
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: inj.result.identifier });
    check('bytes path: with no Module to hand over, the worklet compiles the bytes it is sent and plays',
        b.engine === 'djrust' && b.viaModule === false && b.tick > 8 && b.peak > 0.01 && b.tone === false,
        JSON.stringify({ engine: b.engine, viaModule: b.viaModule, tick: b.tick, peak: b.peak?.toFixed(3), err: b.err }));

    // --- legacy links ---
    for (const q of ['engine=djrust', 'engine=wave']) {
        const l = await run(cdp, `${q}&genre=techno&seed=42`);
        check(`legacy: ?${q} opens the djrust studio`, l.engine === 'djrust' && l.tick > 8 && l.peak > 0.01 && l.tone === false,
            JSON.stringify({ engine: l.engine, tick: l.tick, err: l.err }));
    }

    // --- djwasm 0.3.0: control fires are not fired twice; macros in offline renders (R-16) ---
    await doubleFireGuard(cdp);
    await offlineMacros(cdp);

    // --- TRI-RENDER: one sha256 per live script, four ways (see triRender above) ---
    await triRender(cdp);

    // --- FARM BOOT: the feed corpus on the page's real boot path, as the render farm boots it ---
    await farmBoot(cdp);

    cdp.close();
} catch (err) {
    console.error(err);
    failures++;
} finally {
    chrome.kill();
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);

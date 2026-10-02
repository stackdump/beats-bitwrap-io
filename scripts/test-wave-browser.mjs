#!/usr/bin/env node
//
// Browser smoke test for ?engine=wave — headless Chrome over raw CDP (no
// npm, same approach as test-e2e-controls.mjs).
//
//   ./beats-bitwrap-io -addr :18093 -public public -data /tmp/wave-data &
//   node scripts/test-wave-browser.mjs [http://localhost:18093]
//
// Asserts: the worklet loads and plays; ticks reach the page (el._tick
// advances, the marking reaches the canvas state); the worklet output is
// not silent; Tone.js plays no notes; and the default engine (no flag)
// still plays through Tone.

import { spawn } from 'node:child_process';

const HOST = process.argv[2] || 'http://localhost:18093';
const PORT = 9341;
const CHROME = process.env.CHROME || 'google-chrome';

let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) failures++;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', '--user-data-dir=/tmp/wave-browser-profile', 'about:blank',
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
        else if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map(a => a.value).join(' '));
        else if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + m.params.exceptionDetails.exception?.description);
    };
    const send = (method, params = {}) => new Promise((res) => {
        const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
    });
    const evaluate = async (expr) => {
        const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
        return r.result?.result?.value;
    };
    return new Promise(res => { ws.onopen = () => res({ send, evaluate, logs, close: () => ws.close() }); });
}

async function run(cdp, query) {
    await cdp.send('Page.navigate', { url: `${HOST}/?${query}` });
    for (let i = 0; i < 100; i++) {
        await sleep(200);
        const ok = await cdp.evaluate(`(() => { const el = document.querySelector('petri-note'); return !!(el && el._project && Object.keys(el._project.nets||{}).length); })()`).catch(() => false);
        if (ok) break;
    }
    await sleep(2000); // let the boot path (generate → project-sync) settle
    // Count Tone notes from here on, then press play.
    await cdp.evaluate(`(async () => {
        const el = document.querySelector('petri-note');
        const { toneEngine } = await import('/audio/tone-engine.js');
        window.__toneNotes = 0;
        const orig = toneEngine.playNote.bind(toneEngine);
        toneEngine.playNote = (...a) => { window.__toneNotes++; return orig(...a); };
        await el._ensureToneStarted();
        if (!el._playing) el._togglePlay();
    })()`);
    await sleep(4000);
    return cdp.evaluate(`(async () => {
        const el = document.querySelector('petri-note');
        const out = { tick: el._tick, toneNotes: window.__toneNotes, playing: el._playing, wave: !!el._wave };
        if (el._wave) {
            const w = await el._wave;
            const ctx = window.Tone.getContext().rawContext;
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
        const { toneEngine } = await import('/audio/tone-engine.js');
        out.lean = !!toneEngine._waveGain;
        out.latency = window.Tone.getContext().rawContext.baseLatency;
        out.mobileSink = !!toneEngine._masterSink;
        out.audioElPlaying = toneEngine._masterSink ? !toneEngine._masterSink.audioEl.paused : null;
        if (toneEngine._waveGain) {
            toneEngine.setMasterVolume(-6);
            out.gainAfterVol = +toneEngine._waveGain.gain.value.toFixed(3);
        }
        const net = el._project.nets.kick || Object.values(el._project.nets)[0];
        out.markingSeen = Object.values(net.places).some(p => Array.isArray(p.tokens));
        return out;
    })()`);
}

try {
    const cdp = await connect(await cdpTarget());
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    const w = await run(cdp, 'engine=wave&genre=techno&seed=42');
    check('wave: worklet created and transport playing', w.wave && w.playing, JSON.stringify({ ctx: w.ctxState }));
    check('wave: ticks reach the page (el._tick advances)', w.tick > 8, `tick ${w.tick}`);
    check('wave: marking reaches the canvas state', w.markingSeen);
    check('wave: worklet output is not silent', w.peak > 0.01, `peak ${w.peak?.toFixed(3)}`);
    check('wave: Tone.js plays no notes', w.toneNotes === 0, `${w.toneNotes} Tone notes`);

    check('wave: lean output path (Tone master chain bypassed)', w.lean);
    check('wave: master volume reaches the lean path', w.gainAfterVol === 0.501, `gain ${w.gainAfterVol} for -6 dB`);

    // Phone: iPhone UA → 'playback' latency hint and the <audio>-element sink
    // that keeps iOS playing through screen lock.
    await cdp.send('Emulation.setUserAgentOverride', { userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
    const m = await run(cdp, 'engine=wave&genre=techno&seed=42');
    check('wave/mobile: plays through the <audio> sink', m.wave && m.playing && m.lean && m.mobileSink && m.tick > 8,
        JSON.stringify({ tick: m.tick, audioElPlaying: m.audioElPlaying, baseLatency: m.latency, desktopBaseLatency: w.latency }));
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: '' });

    const d = await run(cdp, 'genre=techno&seed=42');
    check('default engine: unchanged, still plays through Tone', !d.wave && d.toneNotes > 0 && d.tick > 8,
        `tick ${d.tick}, ${d.toneNotes} Tone notes`);

    const errs = cdp.logs.filter(l => /EXC|wave engine|Error/i.test(l));
    if (errs.length) console.log('page errors:\n  ' + errs.slice(0, 10).join('\n  '));
    cdp.close();
} catch (err) {
    console.log('FAIL harness — ' + err.message);
    failures++;
} finally {
    chrome.kill();
}
process.exit(failures ? 1 : 0);

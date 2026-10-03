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
// The in-app bench section submits a result; only do that against a local
// server, never against production (it would land in the public table).
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(HOST);
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

    // Live perf monitor: synthetic visual cost must be blamed on the
    // visualization and stepped down; removing it must recover; equally
    // heavy non-visual work must be reported as 'other' with the visuals
    // left alone; the 'full' preference must disable stepping down.
    const pm = await cdp.evaluate(`(async () => {
        const el = document.querySelector('petri-note');
        const mon = await import('/lib/perf/monitor.js');
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const waitFor = async (pred, ms) => { for (let t = 0; t < ms; t += 100) { if (pred()) return true; await sleep(100); } return false; };
        localStorage.removeItem('pn-viz-quality');
        el._perfConfig = { windowMs: 500, downAfter: 2, upAfter: 3, silent: true };
        if (el._playing) el._togglePlay();
        el._perf = null;
        el._togglePlay();
        await sleep(1500);
        const causes = () => el._perf.history.map(w => w.cause[0]).join('');
        el._perfTestVizBurnMs = 60;   // well above the noise on a busy host
        const steppedDown = await waitFor(() => el._perf.level >= 1, 12000);
        const vizCauses = causes();
        el._perfTestVizBurnMs = 0;
        const nr = el._perf.history.length;
        const recovered = await waitFor(() => el._perf.level === 0, 12000);
        const recoverWindows = el._perf.history.slice(nr).map(w => w.cause[0] + w.level + '/' + w.fps + 'fps/p95 ' + w.p95FrameMs + '/drop ' + w.dropped + '/blk ' + w.blockingMsPerS + '/late ' + w.late).join(' | ');
        const n0 = el._perf.history.length;
        const burner = setInterval(() => { const e = performance.now() + 70; while (performance.now() < e) {} }, 100);
        await sleep(3000);
        clearInterval(burner);
        // Skip the first window: it can straddle the switch from the
        // previous phase.
        const otherCauses = el._perf.history.slice(n0 + 1).map(w => w.cause[0]).join('');
        const levelAfterOther = el._perf.level;
        mon.setVizPreference(el, 'full');
        el._perfTestVizBurnMs = 40;
        await sleep(3000);
        el._perfTestVizBurnMs = 0;
        const levelWithFull = el._perf.level;
        mon.setVizPreference(el, 'auto');
        localStorage.removeItem('pn-viz-quality');
        const report = mon.perfReport(el);
        el._togglePlay();
        return { steppedDown, vizCauses, recovered, recoverWindows, otherCauses, levelAfterOther, levelWithFull,
            verdict: mon.perfVerdict(report) };
    })()`);
    check('perf monitor: visual cost is blamed on the visualization and stepped down',
        pm.steppedDown && pm.vizCauses.includes('v'), `causes ${pm.vizCauses}`);
    check('perf monitor: visuals recover once the cost is gone', pm.recovered, pm.recovered ? '' : pm.recoverWindows);
    check('perf monitor: non-visual jank is "other" and leaves visuals alone',
        /o/.test(pm.otherCauses) && !/v/.test(pm.otherCauses) && pm.levelAfterOther === 0, `causes ${pm.otherCauses}`);
    check('perf monitor: "full" preference disables stepping down', pm.levelWithFull === 0);
    console.log('     verdict: ' + pm.verdict);

    // Telemetry (local only — it writes to the server): real taps and a page
    // freeze/resume must reach /api/telemetry/summary; ?telemetry=0 must
    // not create a collector.
    if (LOCAL) {
        await cdp.evaluate(`(async () => {
            const el = document.querySelector('petri-note');
            if (!el._playing) el._togglePlay();
            return 1;
        })()`);
        await sleep(1500);
        for (let i = 0; i < 3; i++) {
            for (const type of ['mousePressed', 'mouseReleased']) {
                await cdp.send('Input.dispatchMouseEvent', { type, x: 400, y: 500, button: 'left', clickCount: 1 });
            }
            await sleep(400);
        }
        await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
        await sleep(300);
        await cdp.send('Page.setWebLifecycleState', { state: 'active' });
        await sleep(2500);
        const tel = await cdp.evaluate(`(async () => {
            const el = document.querySelector('petri-note');
            if (!el._telemetry) return { error: 'no collector' };
            const sid = el._telemetry.sid;
            const kinds = el._telemetry.buf.map(e => e[1]);
            if (el._playing) el._togglePlay();           // stop → flush
            await el._telemetry.flush(false);             // anything left (freeze may have stopped play already)
            await new Promise(r => setTimeout(r, 800));
            const sum = await (await fetch('/api/telemetry/summary')).json();
            return { sid, kinds, groups: sum.groups };
        })()`);
        const g = (tel.groups || []).find(x => x.platform === 'desktop' && x.engine === 'default');
        check('telemetry: taps and play/stop reach the server summary',
            !!g && g.taps >= 3 && g.playMinutes > 0 && (g.stops?.user || 0) >= 1,
            g ? `sessions ${g.sessions}, taps ${g.taps}, play ${g.playMinutes} min, stops ${JSON.stringify(g.stops)}` : JSON.stringify(tel).slice(0, 300));
        // Raw session (secret-gated): the local server's secret is on disk.
        let rawKinds = null;
        try {
            const { readFileSync } = await import('node:fs');
            const secret = readFileSync(process.env.WAVE_DATA_DIR ? process.env.WAVE_DATA_DIR + '/.rebuild-secret' : '/tmp/wave-data/.rebuild-secret', 'utf8').trim();
            const raw = await (await fetch(`${HOST}/api/telemetry/session/${tel.sid}`, { headers: { 'X-Rebuild-Secret': secret } })).json();
            rawKinds = [...new Set(raw.events.map(e => e[1]))];
        } catch (err) { rawKinds = ['error: ' + err.message]; }
        check('telemetry: raw session has the freeze/resume and visibility events',
            ['tap', 'freeze', 'resume', 'vis', 'play', 'stop', 'win'].every(k => rawKinds.includes(k)), rawKinds.join(','));
        const off = await run(cdp, 'genre=techno&seed=42&telemetry=0');
        const offCollector = await cdp.evaluate(`!!document.querySelector('petri-note')._telemetry`);
        check('telemetry: ?telemetry=0 collects nothing', off.playing && !offCollector);
    }

    // Stop-on-hidden grace period: a brief hidden blip keeps playing (and
    // logs a blip); staying hidden past the grace period still stops.
    {
        await run(cdp, 'genre=techno&seed=42&telemetry=1');
        const vis = await cdp.evaluate(`(async () => {
            const el = document.querySelector('petri-note');
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            let state = 'visible';
            Object.defineProperty(document, 'visibilityState', { get: () => state, configurable: true });
            Object.defineProperty(document, 'hidden', { get: () => state === 'hidden', configurable: true });
            const flip = (s) => { state = s; document.dispatchEvent(new Event('visibilitychange')); };
            if (!el._playing) el._togglePlay();
            await sleep(500);
            flip('hidden'); await sleep(400); flip('visible');
            await sleep(2000);
            const afterBlip = el._playing;
            const blips = (el._telemetry?.buf || []).filter(e => e[1] === 'blip').map(e => e[2].ms);
            flip('hidden'); await sleep(2200);
            const afterLong = el._playing;
            flip('visible');
            return { afterBlip, blips, afterLong };
        })()`);
        check('hidden blip (400 ms) keeps playing and logs a blip', vis.afterBlip === true && vis.blips.length === 1,
            `blips ${JSON.stringify(vis.blips)}`);
        check('hidden past the grace period still stops', vis.afterLong === false);
    }

    // (The service worker is unregistered on localhost by index.html, so
    // it is tested directly in scripts/test-sw.mjs.)

    // Welcome card on a phone: a backdrop tap dismisses and stays; the
    // explicit "Open in player" button still goes to the player.
    {
        await cdp.send('Emulation.setUserAgentOverride', { userAgent:
            'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36' });
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        await cdp.send('Page.navigate', { url: `${HOST}/?genre=techno&seed=42&telemetry=0` });
        await sleep(5000);
        const wc = await cdp.evaluate(`(async () => {
            sessionStorage.removeItem('pn-welcome-mobile-seen');
            const el = document.querySelector('petri-note');
            const { showWelcomeCard } = await import('/lib/ui/dialogs.js');
            showWelcomeCard(el);
            const ov = document.querySelector('.pn-welcome-overlay');
            if (!ov) return { error: 'no welcome card' };
            const label = ov.querySelector('.pn-welcome-start').textContent;
            ov.querySelector('.pn-welcome-card').click();
            await new Promise(r => setTimeout(r, 500));
            return { label, path: location.pathname, open: !!document.querySelector('.pn-welcome-overlay') };
        })()`);
        check('welcome card (phone): tapping the card dismisses and stays on the studio',
            wc.label === 'Open in player' && wc.path === '/' && wc.open === false, JSON.stringify(wc));
        const wc2 = await cdp.evaluate(`(async () => {
            sessionStorage.removeItem('pn-welcome-mobile-seen');
            const el = document.querySelector('petri-note');
            const { showWelcomeCard } = await import('/lib/ui/dialogs.js');
            showWelcomeCard(el);
            document.querySelector('.pn-welcome-overlay .pn-welcome-start').click();
            return 1;
        })()`).catch(() => 1);
        await sleep(2500);
        const pathAfter = await cdp.evaluate('location.pathname');
        check('welcome card (phone): "Open in player" still opens the player', pathAfter === '/feed', pathAfter);
        await cdp.send('Emulation.setUserAgentOverride', { userAgent: '' });
        await cdp.send('Emulation.clearDeviceMetricsOverride');
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        // Back to the studio for the sections below.
        await run(cdp, 'genre=techno&seed=42&telemetry=0');
        await cdp.evaluate(`(() => { const el = document.querySelector('petri-note'); if (el._playing) el._togglePlay(); return 1; })()`);
    }

    // In-app benchmark: Help → "Benchmark this device", a quick run of the
    // reference track and of the current track, then playback must still
    // work (the bench swaps Tone's global context and must restore it).
    if (LOCAL) {
        await cdp.evaluate(`localStorage.removeItem('pn-bench-history')`);
        const b = await cdp.evaluate(`(async () => {
            const el = document.querySelector('petri-note');
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            el.querySelector('.pn-help-btn').click();
            await sleep(200);
            el.querySelector('.pn-bench-open').click();
            for (let i = 0; i < 50 && !el.querySelector('.pn-bench-overlay'); i++) await sleep(100);
            const ov = el.querySelector('.pn-bench-overlay');
            if (!ov) return { error: 'modal did not open' };
            ov.querySelector('.pn-bench-quick').checked = true;
            const runAndWait = async (which) => {
                ov.querySelector('.pn-bench-run[data-which="' + which + '"]').click();
                for (let i = 0; i < 1200; i++) {
                    await sleep(100);
                    const st = ov.querySelector('.pn-bench-status').textContent;
                    if (st === 'done' || st.startsWith('bench failed')) return { st, report: el._benchLastReport() };
                }
                return { st: 'timeout' };
            };
            const ref = await runAndWait('reference');
            const cur = await runAndWait('current');
            const history = JSON.parse(localStorage.getItem('pn-bench-history') || '[]');
            // Submit the current-track report with a label.
            ov.querySelector('.pn-bench-label').value = 'ci-headless';
            ov.querySelector('.pn-bench-submit').click();
            for (let i = 0; i < 50 && !/^Submitted #/.test(ov.querySelector('.pn-bench-submit').textContent); i++) await sleep(100);
            const submitted = ov.querySelector('.pn-bench-submit').textContent;
            const listed = await (await fetch('/api/bench')).json();
            ov.querySelector('.pn-help-close').click();
            // Playback after the bench, on the default engine.
            const { toneEngine } = await import('/audio/tone-engine.js');
            let notes = 0;
            const orig = toneEngine.playNote.bind(toneEngine);
            toneEngine.playNote = (...a) => { notes++; return orig(...a); };
            const t0 = el._tick;
            if (!el._playing) el._togglePlay();
            await sleep(3000);
            return {
                ref: ref.st, cur: cur.st,
                refX: (ref.report?.results || []).map(r => r.case + ':' + (r.xRealtime ?? r.error)),
                curTrack: cur.report?.current, curX: (cur.report?.results || []).map(r => r.case + ':' + (r.xRealtime ?? r.error)),
                submitted, listedLabel: listed.results[0]?.label, listedF: listed.results[0]?.xRealtime?.F,
                history: history.length, notesAfter: notes, ticksAfter: el._tick - t0, playing: el._playing,
            };
        })()`);
        check('bench modal: reference run completes with default + wave cases',
            b.ref === 'done' && b.refX?.length === 2 && b.refX.every(x => /:\d/.test(x)), JSON.stringify(b.refX || b));
        check('bench modal: current-track run completes', b.cur === 'done' && !!b.curTrack, `${b.curTrack} ${JSON.stringify(b.curX)}`);
        check('bench modal: runs recorded in history', b.history === 2, `${b.history} entries`);
        check('bench modal: submit stores the report on the server', /^Submitted #\d+/.test(b.submitted || '') && b.listedLabel === 'ci-headless' && b.listedF > 0,
            `${b.submitted}, listed label ${b.listedLabel}, wave ${b.listedF}×`);
        check('bench modal: playback still works afterwards (Tone context restored)', b.playing && b.notesAfter > 0,
            `${b.notesAfter} Tone notes in 3 s`);
    } else {
        console.log('skip bench modal checks (non-local host: would write to the public results table)');
    }

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
